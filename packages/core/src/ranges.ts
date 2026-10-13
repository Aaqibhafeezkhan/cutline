import { EPSILON } from './time';

export interface TimeRange {
  start: number;
  end: number;
}

/** Sorts ranges and merges overlapping or touching ones. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPSILON) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Parts of [start, end) not covered by `ranges` (which must be merged). */
export function invertRanges(
  ranges: readonly TimeRange[],
  start: number,
  end: number,
): TimeRange[] {
  const out: TimeRange[] = [];
  let cursor = start;
  for (const r of ranges) {
    if (r.end <= cursor) continue;
    if (r.start >= end) break;
    if (r.start > cursor) out.push({ start: cursor, end: Math.min(r.start, end) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out;
}
