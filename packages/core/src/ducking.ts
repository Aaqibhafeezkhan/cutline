import type { TimeRange } from './ranges';
import type { Ducking } from './schema';
import { roundTime } from './time';

/** Decibels → linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Sorts ranges and merges those that overlap or are at most `gap` apart, so
 * the ramps of neighbouring ranges never overlap (the music stays down during
 * short pauses instead of pumping).
 */
export function mergeDuckRanges(ranges: readonly TimeRange[], gap: number): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** 0 = not ducked, 1 = fully ducked; linear ramps of `attack`/`release` seconds. */
function duckWeight(r: TimeRange, attack: number, release: number, t: number): number {
  if (t < r.start) return Math.max(0, 1 - (r.start - t) / attack);
  if (t > r.end) return Math.max(0, 1 - (t - r.end) / release);
  return 1;
}

/** Gain multiplier (amountDb..1) of a ducking config at clip-local time `t`. */
export function duckGain(duck: Ducking | undefined, t: number): number {
  if (!duck) return 1;
  let weight = 0;
  for (const r of duck.ranges)
    weight = Math.max(weight, duckWeight(r, duck.attack, duck.release, t));
  return 1 - (1 - dbToGain(duck.amountDb)) * weight;
}

/** Clip-local times where the ducking envelope bends (for piecewise-linear gain). */
export function duckBreakpoints(duck: Ducking | undefined): number[] {
  if (!duck) return [];
  return duck.ranges.flatMap((r) => [r.start - duck.attack, r.start, r.end, r.end + duck.release]);
}

/**
 * Ducking of the clip-local window [from, to], re-based so `from` becomes 0.
 * Ranges whose ramps do not reach into the window are dropped; undefined if
 * nothing is left.
 */
export function sliceDuck(
  duck: Ducking | undefined,
  from: number,
  to: number,
): Ducking | undefined {
  if (!duck) return undefined;
  const ranges = duck.ranges
    .filter((r) => r.end + duck.release > from && r.start - duck.attack < to)
    .map((r) => ({ start: roundTime(r.start - from), end: roundTime(r.end - from) }));
  return ranges.length > 0 ? { ...duck, ranges } : undefined;
}
