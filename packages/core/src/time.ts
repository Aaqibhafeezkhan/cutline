/** Times are seconds. All stored times are rounded to microseconds to avoid float drift. */
export const EPSILON = 1e-6;

export function roundTime(t: number): number {
  const r = Math.round(t * 1e6) / 1e6;
  return r === 0 ? 0 : r; // normalize -0
}

/** Rounds to milliseconds for compact human/LLM-facing output. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function approxEqual(a: number, b: number, eps = EPSILON): boolean {
  return Math.abs(a - b) <= eps;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Compact seconds for human/LLM-readable messages: 12.5 → "12.5s". */
export function formatTime(t: number): string {
  return `${Number(t.toFixed(3))}s`;
}

export function formatRange(start: number, end: number): string {
  return `${formatTime(start)}–${formatTime(end)}`;
}
