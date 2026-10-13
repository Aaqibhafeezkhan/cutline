import { assertSourceRange, cloneClip, sliceClip, splitClip } from '../clipmath';
import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import {
  findAsset,
  findClip,
  findTrack,
  nextTrackName,
  overlappingClips,
  projectDuration,
  trackEnd,
} from '../queries';
import {
  ClipSchema,
  TrackSchema,
  clipEnd,
  hasSource,
  isVisualClip,
  type Animation,
  type Clip,
  type Project,
  type Track,
  type TrackKind,
} from '../schema';
import { EPSILON, formatRange, formatTime, roundTime } from '../time';
import { mergeRanges } from '../ranges';
import { outcome, type OpOutcome } from './outcome';
import { applyAnimations, applyPropsPatch, assertTransitionFits } from './props';
import type { OpOf } from './schemas';
import {
  assertAccepts,
  assertEditable,
  carveRange,
  emptyLog,
  placeClip,
  shiftClips,
  sortTrack,
} from './track-edit';

export function createTrack(draft: Project, kind: TrackKind, ctx: OpContext): Track {
  const track = TrackSchema.parse({
    id: ctx.newId('track'),
    kind,
    name: nextTrackName(draft, kind),
  });
  // Keep captions on top: new non-caption tracks go below the first caption track.
  const firstCaption = draft.tracks.findIndex((t) => t.kind === 'caption');
  const index = kind === 'caption' || firstCaption < 0 ? draft.tracks.length : firstCaption;
  draft.tracks.splice(index, 0, track);
  return draft.tracks[index]!;
}

function pickTrack(
  draft: Project,
  kind: TrackKind,
  start: number | undefined,
  duration: number,
  ctx: OpContext,
  created: string[],
): Track {
  const candidates = draft.tracks.filter((t) => t.kind === kind && !t.locked);
  const fit =
    start === undefined
      ? candidates[0]
      : candidates.find((t) => overlappingClips(t, start, start + duration).length === 0);
  if (fit) return fit;
  const track = createTrack(draft, kind, ctx);
  created.push(track.id);
  return track;
}

export function addClip(draft: Project, op: OpOf<'add_clip'>, ctx: OpContext): OpOutcome {
  const asset = findAsset(draft, op.assetId);
  const clipType =
    op.clipType ?? (asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video');
  if (clipType === 'video' && !asset.hasVideo) {
    throw new CutlineError('INVALID_ARGUMENT', `Asset "${asset.name}" has no video stream.`, {
      hint: 'Use clipType "audio" for audio-only media.',
    });
  }
  if (clipType === 'audio' && !asset.hasAudio) {
    throw new CutlineError('INVALID_ARGUMENT', `Asset "${asset.name}" has no audio stream.`);
  }
  if (clipType === 'image' && asset.kind !== 'image') {
    throw new CutlineError('INVALID_ARGUMENT', `Asset "${asset.name}" is not an image.`, {
      hint: `Use clipType "${asset.hasVideo ? 'video' : 'audio'}".`,
    });
  }
  const available = asset.duration === null ? Infinity : asset.duration - op.sourceStart;
  const duration = roundTime(op.duration ?? (asset.duration === null ? 5 : available));
  if (duration <= EPSILON) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `sourceStart ${formatTime(op.sourceStart)} is at or beyond the end of "${asset.name}" (${formatTime(asset.duration!)}).`,
    );
  }

  const created: string[] = [];
  const kind: TrackKind = clipType === 'audio' ? 'audio' : 'video';
  let track: Track;
  if (op.trackId) {
    track = findTrack(draft, op.trackId);
    assertAccepts(track, clipType);
    assertEditable(track);
  } else {
    track = pickTrack(draft, kind, op.start, duration, ctx, created);
  }
  const id = op.id ?? ctx.newId('clip');
  const start = roundTime(op.start ?? trackEnd(track));
  const clip = ClipSchema.parse({
    type: clipType,
    id,
    start,
    duration,
    assetId: asset.id,
    ...(clipType === 'image' ? {} : { sourceStart: op.sourceStart }),
  });
  assertSourceRange(clip, asset, op.sourceStart, duration);
  const log = emptyLog();
  log.created.push(id, ...created);
  placeClip(track, clip, op.mode, ctx, log);
  if (op.props) {
    const placed = track.clips.find((c) => c.id === id)!;
    applyPropsPatch(track, placed, op.props);
  }
  return outcome(
    `Added ${clipType} clip ${id} ("${asset.name}") at ${formatRange(start, start + duration)} on track ${track.name}.`,
    log,
  );
}

export function splitClipOp(draft: Project, op: OpOf<'split_clip'>, ctx: OpContext): OpOutcome {
  const { track, clip, index } = findClip(draft, op.clipId);
  assertEditable(track);
  const rightId = op.newClipId ?? ctx.newId('clip');
  const [left, right] = splitClip(clip, op.time - clip.start, rightId);
  track.clips.splice(index, 1, left, right);
  return outcome(`Split clip ${clip.id} at ${formatTime(op.time)}; the right part is ${rightId}.`, {
    modified: [clip.id],
    created: [rightId],
  });
}

export function trimClip(draft: Project, op: OpOf<'trim_clip'>): OpOutcome {
  const { track, clip, index } = findClip(draft, op.clipId);
  assertEditable(track);
  const oldEnd = clipEnd(clip);
  const newStart = op.start ?? clip.start;
  const newEnd = op.end ?? oldEnd;
  if (newEnd - newStart <= EPSILON) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Trimming clip ${clip.id} to ${formatRange(newStart, newEnd)} would leave nothing.`,
      { hint: 'Use delete_clip to remove a clip entirely.' },
    );
  }
  const from = newStart - clip.start;
  const to = newEnd - clip.start;
  if (hasSource(clip)) {
    const asset = draft.assets.find((a) => a.id === clip.assetId);
    assertSourceRange(clip, asset, clip.sourceStart + from, to - from);
  }
  const trimmed = sliceClip(clip, from, to);
  const log = emptyLog();
  log.modified.push(clip.id);
  if (op.ripple) {
    trimmed.start = clip.start;
    shiftClips(track, oldEnd, to - from - clip.duration, log);
  } else {
    const collisions = overlappingClips(track, trimmed.start, clipEnd(trimmed), clip.id);
    if (collisions.length > 0) {
      throw new CutlineError(
        'OVERLAP',
        `Trimming clip ${clip.id} to ${formatRange(newStart, newEnd)} would overlap ${collisions.map((c) => c.id).join(', ')}.`,
        { hint: 'Trim less, move the neighbor first, or pass ripple: true.' },
      );
    }
  }
  track.clips[index] = trimmed;
  sortTrack(track);
  return outcome(
    `Trimmed clip ${clip.id} to ${formatRange(trimmed.start, clipEnd(trimmed))}${op.ripple ? ' (ripple)' : ''}.`,
    log,
  );
}

export function moveClip(draft: Project, op: OpOf<'move_clip'>, ctx: OpContext): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  const target = op.trackId ? findTrack(draft, op.trackId) : track;
  assertEditable(target);
  assertAccepts(target, clip.type);
  const moved = cloneClip(clip);
  moved.start = roundTime(op.start);
  track.clips = track.clips.filter((c) => c.id !== clip.id);
  const log = emptyLog();
  log.modified.push(clip.id);
  placeClip(target, moved, op.mode, ctx, log);
  const where = target.id === track.id ? '' : ` on track ${target.name}`;
  return outcome(`Moved clip ${clip.id} to ${formatTime(op.start)}${where}.`, log);
}

export function deleteClips(draft: Project, op: OpOf<'delete_clips'>): OpOutcome {
  const locs = [...new Set(op.clipIds)].map((id) => findClip(draft, id));
  for (const loc of locs) assertEditable(loc.track);
  const log = emptyLog();
  const byTrack = new Map<Track, Clip[]>();
  for (const { track, clip } of locs) {
    byTrack.set(track, [...(byTrack.get(track) ?? []), clip]);
    log.removed.push(clip.id);
  }
  for (const [track, clips] of byTrack) {
    const ids = new Set(clips.map((c) => c.id));
    track.clips = track.clips.filter((c) => !ids.has(c.id));
    if (op.ripple) {
      for (const c of [...clips].sort((a, b) => b.start - a.start)) {
        shiftClips(track, clipEnd(c), -c.duration, log);
      }
    }
  }
  return outcome(`Deleted ${locs.length} clip(s)${op.ripple ? ' and closed the gaps' : ''}.`, log);
}

export function deleteRange(draft: Project, op: OpOf<'delete_range'>, ctx: OpContext): OpOutcome {
  const tracks = op.trackIds
    ? op.trackIds.map((id) => {
        const t = findTrack(draft, id);
        assertEditable(t);
        return t;
      })
    : draft.tracks.filter((t) => !t.locked);
  const ranges = mergeRanges(op.ranges);
  const log = emptyLog();
  let total = 0;
  for (const r of [...ranges].reverse()) {
    total += r.end - r.start;
    for (const track of tracks) {
      carveRange(track, r.start, r.end, ctx, log);
      if (op.ripple) shiftClips(track, r.end, -(r.end - r.start), log);
    }
  }
  const skipped = draft.tracks.filter((t) => t.locked).map((t) => t.name);
  const note =
    skipped.length && !op.trackIds ? ` Locked tracks skipped: ${skipped.join(', ')}.` : '';
  return outcome(
    `Removed ${ranges.length} range(s) totalling ${formatTime(total)} from ${tracks.length} track(s)${op.ripple ? ' and closed the gaps' : ''}. Timeline is now ${formatTime(projectDuration(draft))}.${note}`,
    log,
  );
}

export function setClipProps(draft: Project, op: OpOf<'set_clip_props'>): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  const changed = applyPropsPatch(track, clip, op.props);
  return outcome(`Updated ${changed.join(', ') || 'nothing'} on clip ${clip.id}.`, {
    modified: [clip.id],
  });
}

export function setTransition(draft: Project, op: OpOf<'set_transition'>): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'text') {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Transitions only apply to visual clips, not ${clip.type}.`,
      {
        hint: 'For audio use fadeIn/fadeOut via set_audio_volume.',
      },
    );
  }
  if (op.transition === null) {
    delete clip.transitionIn;
    return outcome(`Removed the transition into clip ${clip.id}.`, { modified: [clip.id] });
  }
  assertTransitionFits(track, clip, op.transition.duration);
  clip.transitionIn = op.transition;
  return outcome(
    `Added a ${formatTime(op.transition.duration)} ${op.transition.type} into clip ${clip.id}.`,
    { modified: [clip.id] },
  );
}

export function setAnimation(draft: Project, op: OpOf<'set_animation'>): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  if (!isVisualClip(clip)) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Animations only apply to visual clips (video, image, text, shape), not ${clip.type}.`,
      { hint: 'Pick a clip on a video track; for audio use fadeIn/fadeOut via set_audio_volume.' },
    );
  }
  applyAnimations(clip, op.in, op.out);
  const describe = (edge: string, a: Animation | null | undefined) =>
    a === undefined
      ? undefined
      : a === null
        ? `removed the ${edge} animation`
        : `${edge} ${a.preset} ${formatTime(a.duration)}`;
  const parts = [describe('in', op.in), describe('out', op.out)].filter(Boolean);
  return outcome(`Clip ${clip.id}: ${parts.join(', ')}.`, { modified: [clip.id] });
}

export function setVolume(draft: Project, op: OpOf<'set_volume'>): OpOutcome {
  if (op.trackId !== undefined) {
    const track = findTrack(draft, op.trackId);
    if (op.fadeIn !== undefined || op.fadeOut !== undefined) {
      throw new CutlineError('INVALID_ARGUMENT', 'fadeIn/fadeOut apply to clips, not tracks.', {
        hint: 'Pass a clipId to fade a clip.',
      });
    }
    if (op.volume !== undefined) track.volume = op.volume;
    if (op.muted !== undefined) track.muted = op.muted;
    return outcome(
      `Track ${track.name}: volume ${track.volume}${track.muted ? ' (muted)' : ''}.`,
      {},
      [track.id],
    );
  }
  const { track, clip } = findClip(draft, op.clipId!);
  assertEditable(track);
  applyPropsPatch(track, clip, {
    ...(op.volume !== undefined && { volume: op.volume }),
    ...(op.muted !== undefined && { muted: op.muted }),
    ...(op.fadeIn !== undefined && { fadeIn: op.fadeIn }),
    ...(op.fadeOut !== undefined && { fadeOut: op.fadeOut }),
  });
  const parts = [
    op.volume !== undefined && `volume ${op.volume}`,
    op.muted !== undefined && (op.muted ? 'muted' : 'unmuted'),
    op.fadeIn !== undefined && `fade in ${formatTime(op.fadeIn)}`,
    op.fadeOut !== undefined && `fade out ${formatTime(op.fadeOut)}`,
  ].filter(Boolean);
  return outcome(`Clip ${clip.id}: ${parts.join(', ') || 'unchanged'}.`, { modified: [clip.id] });
}
