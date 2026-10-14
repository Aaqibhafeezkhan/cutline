import { clipSpeed, isFreeze, isReversed, sourceTimeAt } from '../clipmath';
import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { animatedValue } from '../keyframes';
import { findClip } from '../queries';
import { REVERSE_NUDGE } from '../resolve';
import { ClipSchema, clipEnd, type Project, type Transform } from '../schema';
import { formatRange, formatTime, roundTime } from '../time';
import { outcome, type OpOutcome } from './outcome';
import { applySpeedChange } from './props';
import type { OpOf } from './schemas';
import { assertEditable, emptyLog, placeClip } from './track-edit';

export function setSpeed(draft: Project, op: OpOf<'set_speed'>): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  const asset = 'assetId' in clip ? draft.assets.find((a) => a.id === clip.assetId) : undefined;
  const log = emptyLog();
  log.modified.push(clip.id);
  applySpeedChange(track, clip, op, asset, log);
  const parts = [`speed ${clipSpeed(clip)}×`, isReversed(clip) ? 'reversed' : 'forward'];
  return outcome(
    `Clip ${clip.id}: ${parts.join(', ')}, now ${formatRange(clip.start, clipEnd(clip))}${op.ripple ? ' (ripple)' : ''}.`,
    log,
  );
}

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

/**
 * Splits a video clip at `time` and inserts a silent hold of the frame shown
 * there; the rest of the clip and everything after it on the track move later.
 */
export function freezeFrame(draft: Project, op: OpOf<'freeze_frame'>, ctx: OpContext): OpOutcome {
  const { track, clip } = findClip(draft, op.clipId);
  assertEditable(track);
  if (clip.type !== 'video') {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Freeze frames need a video clip, not ${clip.type} (clip ${clip.id}).`,
      { hint: 'Pick a clip on a video track that shows footage.' },
    );
  }
  if (isFreeze(clip)) {
    throw new CutlineError('INVALID_ARGUMENT', `Clip ${clip.id} is already a freeze frame.`, {
      hint: 'Lengthen it with trim_clip instead.',
    });
  }
  const local = op.time - clip.start;
  if (local < 0 || local >= clip.duration) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `${formatTime(op.time)} is not inside clip ${clip.id} (${formatRange(clip.start, clipEnd(clip))}).`,
      { hint: 'Pick a time from the clip start up to (not including) its end.' },
    );
  }
  // The frame on screen at `time`, exactly as the resolver shows it.
  const nudge = isReversed(clip) ? REVERSE_NUDGE : 0;
  const frame = roundTime(Math.max(clip.sourceStart, sourceTimeAt(clip, local) - nudge));
  const transform = { ...clip.transform } as Transform;
  for (const key of TRANSFORM_KEYS) {
    transform[key] = animatedValue(clip.keyframes, key, clip.transform[key], local);
  }
  const id = op.newClipId ?? ctx.newId('clip');
  const hold = ClipSchema.parse({
    type: 'video',
    id,
    name: 'Freeze frame',
    start: roundTime(op.time),
    duration: op.duration,
    assetId: clip.assetId,
    sourceStart: frame,
    freeze: true,
    transform,
    effects: clip.effects,
  });
  const log = emptyLog();
  log.created.push(id);
  placeClip(track, hold, 'insert', ctx, log);
  return outcome(
    `Inserted freeze frame ${id} (source ${formatTime(frame)} of clip ${clip.id}) at ${formatRange(hold.start, clipEnd(hold))}; later clips on track ${track.name} moved ${formatTime(op.duration)} later.`,
    log,
  );
}
