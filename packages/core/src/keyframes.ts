import type { AnimatableProperty, Easing, Keyframe, Keyframes } from './schema';
import { ANIMATABLE_PROPERTIES } from './schema';
import { EPSILON, roundTime } from './time';

export function ease(easing: Easing, p: number): number {
  switch (easing) {
    case 'linear':
      return p;
    case 'easeIn':
      return p * p;
    case 'easeOut':
      return 1 - (1 - p) * (1 - p);
    case 'easeInOut':
      return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
    case 'hold':
      return 0;
  }
}

/** Value of a keyframed property at clip-local time `t`. Keyframes must be sorted by time. */
export function evaluateKeyframes(keyframes: readonly Keyframe[], t: number): number {
  const first = keyframes[0];
  if (!first) throw new RangeError('evaluateKeyframes needs at least one keyframe');
  if (t <= first.time) return first.value;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (t < b.time) {
      // Sorted keyframes and t >= a.time guarantee b.time > a.time here.
      const p = (t - a.time) / (b.time - a.time);
      return a.value + (b.value - a.value) * ease(a.easing, p);
    }
  }
  return keyframes[keyframes.length - 1]!.value;
}

export function sortKeyframes(keyframes: readonly Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.time - b.time);
}

/**
 * Re-bases keyframes onto the clip-local window [from, to]: keyframes inside
 * the window are shifted by -from, and boundary keyframes are inserted where
 * the window cuts through an animation so the motion is preserved.
 * `from` may be negative (the clip was extended at its start).
 */
export function sliceKeyframes(
  keyframes: readonly Keyframe[],
  from: number,
  to: number,
): Keyframe[] {
  if (keyframes.length === 0) return [];
  const sorted = sortKeyframes(keyframes);
  const out: Keyframe[] = [];
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (from > first.time + EPSILON) {
    const boundary = sorted.filter((k) => k.time <= from).pop()!;
    out.push({ time: 0, value: evaluateKeyframes(sorted, from), easing: boundary.easing });
  }
  for (const k of sorted) {
    if (k.time >= from - EPSILON && k.time <= to + EPSILON) {
      out.push({ ...k, time: roundTime(Math.max(0, k.time - from)) });
    }
  }
  if (to < last.time - EPSILON) {
    out.push({
      time: roundTime(to - from),
      value: evaluateKeyframes(sorted, to),
      easing: 'linear',
    });
  }
  return dedupeByTime(out);
}

function dedupeByTime(keyframes: Keyframe[]): Keyframe[] {
  const out: Keyframe[] = [];
  for (const k of keyframes) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.time - k.time) <= EPSILON) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

export function sliceAllKeyframes(
  keyframes: Keyframes | undefined,
  from: number,
  to: number,
): Keyframes | undefined {
  if (!keyframes) return undefined;
  const out: Keyframes = {};
  let any = false;
  for (const prop of ANIMATABLE_PROPERTIES) {
    const list = keyframes[prop];
    if (list && list.length > 0) {
      out[prop] = sliceKeyframes(list, from, to);
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Static value, overridden by keyframes when the property is animated. */
export function animatedValue(
  keyframes: Keyframes | undefined,
  prop: AnimatableProperty,
  base: number,
  localTime: number,
): number {
  const list = keyframes?.[prop];
  return list && list.length > 0 ? evaluateKeyframes(list, localTime) : base;
}
