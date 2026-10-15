import { sliceClip } from '../clipmath';
import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { sortMarkers } from '../markers';
import { overlappingClips, previousAdjacent, projectDuration } from '../queries';
import { MarkerSchema, type AudioClip, type Clip, type Project } from '../schema';
import { EPSILON, formatRange, formatTime, roundTime } from '../time';
import { outcome, type OpOutcome } from './outcome';
import { maxTransitionDuration } from './props';
import type { OpOf } from './schemas';
import { assertEditable, emptyLog, sortTrack } from './track-edit';

/** Copy of `clip` restricted to the timeline window [from, to), placed at `at`. */
function excerpt(clip: Clip, from: number, to: number, at: number, id: string): Clip {
  const localFrom = Math.max(0, from - clip.start);
  const localTo = Math.min(clip.duration, to - clip.start);
  const part = sliceClip(clip, localFrom, localTo);
  part.id = id;
  part.start = roundTime(at + clip.start + localFrom - from);
  if (localFrom > EPSILON) {
    if ('fadeIn' in part) part.fadeIn = 0;
    if ('transitionIn' in part) delete part.transitionIn;
    if ('animationIn' in part) delete part.animationIn;
  }
  if (localTo < clip.duration - EPSILON) {
    if ('fadeOut' in part) part.fadeOut = 0;
    if ('animationOut' in part) delete part.animationOut;
  }
  return part;
}

/**
 * Lays timeline ranges back-to-back (a highlight reel): every track keeps
 * what it shows inside each range (video, audio, overlays, captions), cut to
 * the range. "append" adds the reel after the current end, "replace" turns
 * the timeline into the reel. Labelled ranges become chapter markers.
 */
export function assembleRanges(
  draft: Project,
  op: OpOf<'assemble_ranges'>,
  ctx: OpContext,
): OpOutcome {
  const duration = projectDuration(draft);
  for (const r of op.ranges) {
    if (r.end > duration + 1e-3) {
      throw new CutlineError(
        'OUT_OF_RANGE',
        `Range ${formatRange(r.start, r.end)} reaches past the end of the ${formatTime(duration)} timeline.`,
        { hint: `Use ranges within 0–${formatTime(duration)} (timeline seconds).` },
      );
    }
  }
  for (const track of draft.tracks) if (track.clips.length) assertEditable(track);

  const log = emptyLog();
  const replace = op.mode === 'replace';
  let cursor = replace ? 0 : roundTime(duration);
  const reelStart = cursor;
  const segmentStarts: number[] = [];
  const parts = new Map<string, Clip[]>(draft.tracks.map((t) => [t.id, []]));
  for (const r of op.ranges) {
    segmentStarts.push(cursor);
    for (const track of draft.tracks) {
      for (const clip of overlappingClips(track, r.start, r.end)) {
        const part = excerpt(clip, r.start, r.end, cursor, ctx.newId('clip'));
        parts.get(track.id)!.push(part);
        log.created.push(part.id);
      }
    }
    cursor = roundTime(cursor + r.end - r.start);
  }

  for (const track of draft.tracks) {
    if (replace) {
      log.removed.push(...track.clips.map((c) => c.id));
      track.clips = [];
    }
    track.clips.push(...parts.get(track.id)!);
    sortTrack(track);
  }

  if (op.fadeBetween > 0) {
    for (const at of segmentStarts.slice(1)) {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (Math.abs(clip.start - at) > 1e-3) continue;
          const prev = previousAdjacent(track, clip);
          if (!prev) continue;
          if (clip.type === 'video' || clip.type === 'image') {
            const fit = maxTransitionDuration(track, clip);
            clip.transitionIn = {
              type: 'crossfade',
              duration: roundTime(Math.min(op.fadeBetween, fit)),
            };
          } else if (clip.type === 'audio') {
            // Audio tracks only hold audio clips, so the neighbour is one too.
            const half = op.fadeBetween / 2;
            clip.fadeIn = roundTime(Math.min(half, clip.duration));
            (prev as AudioClip).fadeOut = roundTime(Math.min(half, prev.duration));
          }
        }
      }
    }
  }

  if (replace && draft.markers) {
    log.removed.push(...draft.markers.map((m) => m.id));
    delete draft.markers;
  }
  const chapters = op.ranges.flatMap((r, i) =>
    r.label
      ? [
          MarkerSchema.parse({
            id: ctx.newId('marker'),
            time: segmentStarts[i],
            label: r.label,
            kind: 'chapter',
          }),
        ]
      : [],
  );
  if (chapters.length) {
    draft.markers = [...(draft.markers ?? []), ...chapters];
    sortMarkers(draft.markers);
    log.created.push(...chapters.map((m) => m.id));
  }

  return outcome(
    `${replace ? 'Replaced the timeline with' : 'Appended'} a ${formatTime(roundTime(cursor - reelStart))} reel of ${op.ranges.length} range(s) at ${formatRange(reelStart, cursor)}.`,
    log,
  );
}
