import { sliceDuck } from './ducking';
import { CutlineError } from './errors';
import { sliceAllKeyframes } from './keyframes';
import type { Asset, Clip, Word } from './schema';
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
    next.sourceStart = roundTime(next.sourceStart + from);
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

/** Checks that a media clip's source window fits inside its asset. */
export function assertSourceRange(
  clip: Clip,
  asset: Asset | undefined,
  sourceStart: number,
  duration: number,
): void {
  if (!hasSource(clip) || !asset || asset.duration === null) return;
  if (sourceStart < -EPSILON) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Clip ${clip.id} cannot start before the beginning of asset "${asset.name}" (only ${formatTime(clip.sourceStart)} of source is available before its in-point).`,
      { hint: `Extend the start by at most ${formatTime(clip.sourceStart)}.` },
    );
  }
  if (sourceStart + duration > asset.duration + 1e-3) {
    const available = Math.max(0, asset.duration - sourceStart);
    throw new CutlineError(
      'OUT_OF_RANGE',
      `Clip ${clip.id} would need source ${formatRange(sourceStart, sourceStart + duration)}, but asset "${asset.name}" is only ${formatTime(asset.duration)} long.`,
      { hint: `Use a duration of at most ${formatTime(available)} from that in-point.` },
    );
  }
}
