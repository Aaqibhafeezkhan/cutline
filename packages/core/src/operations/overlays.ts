import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { findTrack, overlappingClips } from '../queries';
import {
  CaptionClipSchema,
  CaptionStyleSchema,
  ShapeClipSchema,
  TextClipSchema,
  type Project,
  type Track,
} from '../schema';
import { formatRange, roundTime } from '../time';
import { createTrack } from './clips';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';
import { assertAccepts, assertEditable, emptyLog, placeClip, sortTrack } from './track-edit';

/** Overlay clips (text, shapes) go on video tracks that hold nothing else. */
function isOverlayTrack(t: Track): boolean {
  return (
    t.kind === 'video' && !t.locked && t.clips.every((c) => c.type === 'text' || c.type === 'shape')
  );
}

/**
 * The explicit track, or the lowest overlay track that is above every video
 * track with something visible during [start, end), or a new track on top.
 * So an overlay always lands above what it overlaps (e.g. text over its box).
 */
function overlayTrack(
  draft: Project,
  trackId: string | undefined,
  type: 'text' | 'shape',
  start: number,
  end: number,
  ctx: OpContext,
  created: string[],
): Track {
  if (trackId) {
    const track = findTrack(draft, trackId);
    assertAccepts(track, type);
    assertEditable(track);
    return track;
  }
  let above = 0;
  draft.tracks.forEach((t, i) => {
    if (t.kind === 'video' && overlappingClips(t, start, end).length > 0) above = i + 1;
  });
  const fit = draft.tracks.find((t, i) => i >= above && isOverlayTrack(t));
  if (fit) return fit;
  const track = createTrack(draft, 'video', ctx);
  created.push(track.id);
  return track;
}

export function addText(draft: Project, op: OpOf<'add_text'>, ctx: OpContext): OpOutcome {
  const created: string[] = [];
  const start = roundTime(op.start);
  const end = start + op.duration;
  const track = overlayTrack(draft, op.trackId, 'text', start, end, ctx, created);
  const id = op.id ?? ctx.newId('clip');
  const clip = TextClipSchema.parse({
    type: 'text',
    id,
    start,
    duration: op.duration,
    text: op.text,
    style: op.style ?? {},
    transform: op.transform ?? {},
  });
  const log = emptyLog();
  log.created.push(id, ...created);
  placeClip(track, clip, op.mode, ctx, log);
  const preview = op.text.length > 40 ? `${op.text.slice(0, 40)}…` : op.text;
  return outcome(
    `Added text "${preview}" (${id}) at ${formatRange(start, end)} on track ${track.name}.`,
    log,
  );
}

export function addShape(draft: Project, op: OpOf<'add_shape'>, ctx: OpContext): OpOutcome {
  const created: string[] = [];
  const start = roundTime(op.start);
  const end = start + op.duration;
  const track = overlayTrack(draft, op.trackId, 'shape', start, end, ctx, created);
  const id = op.id ?? ctx.newId('clip');
  const clip = ShapeClipSchema.parse({
    type: 'shape',
    id,
    start,
    duration: op.duration,
    shape: op.shape,
    width: op.width,
    height: op.height,
    fill: op.fill,
    strokeColor: op.strokeColor,
    strokeWidth: op.strokeWidth,
    cornerRadius: op.cornerRadius,
    transform: op.transform ?? {},
  });
  const log = emptyLog();
  log.created.push(id, ...created);
  placeClip(track, clip, op.mode, ctx, log);
  return outcome(
    `Added ${clip.shape} ${clip.width}×${clip.height} (${id}) at ${formatRange(start, end)} on track ${track.name}.`,
    log,
  );
}
export function addCaptions(draft: Project, op: OpOf<'add_captions'>, ctx: OpContext): OpOutcome {
  const log = emptyLog();
  let track: Track | undefined;
  if (op.trackId) {
    track = findTrack(draft, op.trackId);
    if (track.kind !== 'caption') {
      throw new CutlineError('INVALID_ARGUMENT', `Track ${track.name} is not a caption track.`, {
        hint: 'Omit trackId to use (or create) a caption track.',
      });
    }
  } else {
    track = draft.tracks.find((t) => t.kind === 'caption' && !t.locked);
  }
  if (!track) {
    track = createTrack(draft, 'caption', ctx);
    track.captionStyle = CaptionStyleSchema.parse({});
    log.created.push(track.id);
  }
  assertEditable(track);
  if (op.style) {
    track.captionStyle = CaptionStyleSchema.parse({ ...track.captionStyle, ...op.style });
  }
  if (op.replace) {
    log.removed.push(...track.clips.map((c) => c.id));
    track.clips = [];
  }

  // Sort and make cues non-overlapping: a cue ends where the next one starts.
  const cues = [...op.cues].sort((a, b) => a.start - b.start);
  const clips = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    const start = roundTime(cue.start);
    const end = roundTime(next ? Math.min(cue.end, next.start) : cue.end);
    if (end - start <= 1e-3) continue;
    clips.push(
      CaptionClipSchema.parse({
        type: 'caption',
        id: ctx.newId('clip'),
        start,
        duration: roundTime(end - start),
        text: cue.text,
        words: cue.words?.map((w) => ({
          text: w.text,
          start: roundTime(Math.max(0, w.start - start)),
          end: roundTime(Math.max(0, Math.min(end, w.end) - start)),
        })),
      }),
    );
  }
  for (const clip of clips) {
    placeClip(track, clip, 'overwrite', ctx, log);
    log.created.push(clip.id);
  }
  sortTrack(track);
  const span = clips.length
    ? ` spanning ${formatRange(clips[0]!.start, clips[clips.length - 1]!.start + clips[clips.length - 1]!.duration)}`
    : '';
  return outcome(`Added ${clips.length} caption(s) on track ${track.name}${span}.`, log, [
    track.id,
  ]);
}
