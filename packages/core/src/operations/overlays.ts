import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { findTrack, overlappingClips } from '../queries';
import {
  CaptionClipSchema,
  CaptionStyleSchema,
  TextClipSchema,
  type Project,
  type Track,
} from '../schema';
import { formatRange, roundTime } from '../time';
import { createTrack } from './clips';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';
import { assertAccepts, assertEditable, emptyLog, placeClip, sortTrack } from './track-edit';

function textTrackFor(
  draft: Project,
  start: number,
  end: number,
  ctx: OpContext,
  created: string[],
): Track {
  // Prefer the top-most unlocked video track that only holds text and has room.
  const candidates = draft.tracks
    .filter((t) => t.kind === 'video' && !t.locked && t.clips.every((c) => c.type === 'text'))
    .reverse();
  const fit = candidates.find((t) => overlappingClips(t, start, end).length === 0);
  if (fit) return fit;
  const track = createTrack(draft, 'video', ctx);
  created.push(track.id);
  return track;
}

export function addText(draft: Project, op: OpOf<'add_text'>, ctx: OpContext): OpOutcome {
  const created: string[] = [];
  const start = roundTime(op.start);
  const end = start + op.duration;
  let track: Track;
  if (op.trackId) {
    track = findTrack(draft, op.trackId);
    assertAccepts(track, 'text');
    assertEditable(track);
  } else {
    track = textTrackFor(draft, start, end, ctx, created);
  }
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
