import { sliceDuck } from './ducking';
import { CutlineError } from './errors';
import { sliceAllKeyframes } from './keyframes';
import type { Asset, AudioClip, Clip, VideoClip, Word } from './schema';
import { clipEnd, hasSource } from './schema';
import { EPSILON, formatRange, formatTime, roundTime } from './time';

export function sliceWords(words: readonly Word[] | undefined, from: number, to: number) {
  if (!words) return undefined;
  return words
    .filter((w) => w.end > from + EPSILON && w.start < to - EPSILON)
    .map((w) => ({
      text: w.text,
      start: roundTime(Math.max(0, w.start - from)),
      end: roundTime(Math.min(to, w.end) - from),
    }));
}

export function cloneClip<C extends Clip>(clip: C): C {
  return JSON.parse(JSON.stringify(clip)) as C;
}

/**
 * Returns a copy of `clip` restricted to the clip-local window [from, to].
 * `from < 0` extends the clip to the left (uses source handle for media).
 * The caller is responsible for range checks against the asset.
 */
export function sliceClip<C extends Clip>(clip: C, from: number, to: number): C {
  // Deep copy: `clip` may be an Immer draft, and the halves of a split must not share objects.
  const next = cloneClip(clip) as Clip;
  next.start = roundTime(clip.start + from);
  next.duration = roundTime(to - from);
  if (hasSource(next)) {
    // Reversed clips play their source backwards, so the kept window is
    // measured from the clip end; freeze frames (speed 0) keep their frame.
    const offset = isReversed(next) ? clip.duration - to : from;
    next.sourceStart = roundTime(next.sourceStart + offset * clipSpeed(next));
    const duck = sliceDuck(next.duck, from, to);
    if (duck) next.duck = duck;
    else delete next.duck;
  }
  if (next.type !== 'caption') {
    const kf = sliceAllKeyframes(next.keyframes, from, to);
    if (kf) next.keyframes = kf;
    else delete next.keyframes;
  } else if (next.words) {
    next.words = sliceWords(next.words, from, to)!;
  }
  return next as C;
}

/** Splits at clip-local time `local`, returning [left, right]. */
export function splitClip<C extends Clip>(clip: C, local: number, rightId: string): [C, C] {
  if (local <= EPSILON || local >= clip.duration - EPSILON) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Cannot split clip ${clip.id} at ${formatTime(clip.start + local)}: the time must be strictly inside the clip (${formatRange(clip.start, clipEnd(clip))}).`,
      { hint: 'Pick a time between the clip start and end.' },
    );
  }
  const left = sliceClip(clip, 0, local);
  const right = sliceClip(clip, local, clip.duration);
  right.id = rightId;
  if ('fadeOut' in left) left.fadeOut = 0;
  if ('fadeIn' in right) right.fadeIn = 0;
  if ('transitionIn' in right) delete right.transitionIn;
  // Entrance stays with the left part, exit with the right part.
  if ('animationOut' in left) delete left.animationOut;
  if ('animationIn' in right) delete right.animationIn;
  return [left, right];
}

// ---------------------------------------------------------------------------
// Speed, reverse and freeze frames
// ---------------------------------------------------------------------------

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;

/** True for freeze-frame clips (a held source frame, silent). */
export function isFreeze(clip: Clip): boolean {
  return clip.type === 'video' && clip.freeze === true;
}

/**
 * Source seconds per timeline second: 1 = normal, 2 = twice as fast,
 * 0 for freeze frames. Clips without a source report 1.
 */
export function clipSpeed(clip: Clip): number {
  if (!hasSource(clip)) return 1;
  if (isFreeze(clip)) return 0;
  return clip.speed ?? 1;
}

/** True when a media clip plays its source backwards (never for freeze frames). */
export function isReversed(clip: Clip): boolean {
  return hasSource(clip) && clip.reverse === true && !isFreeze(clip);
}

/** Source seconds consumed by `duration` timeline seconds of the clip. */
export function sourceSpan(clip: Clip, duration: number = clip.duration): number {
  return duration * clipSpeed(clip);
}

/**
 * Source time played at clip-local time `local` (may lie outside [0, duration]
 * for transition handles). Forward: sourceStart + local × speed; reversed:
 * counted back from the end of the source window.
 */
export function sourceTimeAt(clip: VideoClip | AudioClip, local: number): number {
  const speed = clipSpeed(clip);
  return isReversed(clip)
    ? clip.sourceStart + (clip.duration - local) * speed
    : clip.sourceStart + local * speed;
}

/**
 * Clip-local range in which the source range [from, to) of the clip's asset
 * plays, or undefined when it is not used (or the clip is a freeze frame).
 */
export function sourceRangeToLocal(
  clip: VideoClip | AudioClip,
  from: number,
  to: number,
): [number, number] | undefined {
  const speed = clipSpeed(clip);
  if (speed === 0) return undefined;
  const s = Math.max(from, clip.sourceStart);
  const e = Math.min(to, clip.sourceStart + sourceSpan(clip));
  if (e - s <= EPSILON) return undefined;
  const a = (s - clip.sourceStart) / speed;
  const b = (e - clip.sourceStart) / speed;
  return isReversed(clip) ? [clip.duration - b, clip.duration - a] : [a, b];
}

/**
 * Checks that a media clip's source window fits inside its asset.
 * `span` is in source seconds; `speed` converts hints back to timeline time.
 */
export function assertSourceRange(
  clip: Clip,
  asset: Asset | undefined,
  sourceStart: number,
  span: number,
  speed: number = clipSpeed(clip),
): void {
  if (!hasSource(clip) || !asset || asset.duration === null) return;
  const rate = speed || 1;
  if (sourceStart < -EPSILON) {
    const edge = isReversed(clip) ? 'end' : 'start';
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Clip ${clip.id} cannot start before the beginning of asset "${asset.name}" (only ${formatTime(clip.sourceStart)} of source is available before its in-point).`,
      { hint: `Extend the ${edge} by at most ${formatTime(clip.sourceStart / rate)}.` },
    );
  }
  if (sourceStart + span > asset.duration + 1e-3) {
    const available = Math.max(0, asset.duration - sourceStart);
    const atSpeed = rate === 1 ? '' : ` at speed ${rate}`;
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Clip ${clip.id} would need source ${formatRange(sourceStart, sourceStart + span)}, but asset "${asset.name}" is only ${formatTime(asset.duration)} long.`,
      {
        hint: `Use a duration of at most ${formatTime(available / rate)}${atSpeed} from that in-point.`,
      },
    );
  }
}
