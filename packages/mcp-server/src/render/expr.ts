import { ease, type Keyframe } from '@cutline/core';

export interface Point {
  t: number;
  v: number;
}

/** Compact decimal for ffmpeg expressions. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Piecewise-linear function of `t` as an ffmpeg expression (constant before
 * the first and after the last point). Commas are safe inside single quotes.
 */
export function piecewise(points: readonly Point[], variable = 't'): string {
  if (points.length === 0) return '1';
  const last = points[points.length - 1]!;
  let expr = num(last.v);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const span = b.t - a.t;
    const seg =
      span > 1e-9 && a.v !== b.v
        ? `(${num(a.v)}+(${num(b.v - a.v)})*(${variable}-${num(a.t)})/${num(span)})`
        : num(a.v);
    expr = `if(lt(${variable},${num(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${variable},${num(points[0]!.t)}),${num(points[0]!.v)},${expr})`;
}

/** Keyframes (clip-local) → linear points in output time, sampling eased segments. */
export function keyframePoints(
  keyframes: readonly Keyframe[],
  shift: number,
  map = (v: number) => v,
): Point[] {
  const out: Point[] = [];
  keyframes.forEach((k, i) => {
    out.push({ t: k.time + shift, v: map(k.value) });
    const next = keyframes[i + 1];
    if (!next || k.easing === 'linear') return;
    if (k.easing === 'hold') {
      out.push({ t: next.time + shift - 1e-4, v: map(k.value) });
      return;
    }
    for (let s = 1; s < 8; s++) {
      const p = s / 8;
      out.push({
        t: k.time + (next.time - k.time) * p + shift,
        v: map(k.value + (next.value - k.value) * ease(k.easing, p)),
      });
    }
  });
  return out;
}

/** Multiplies two piecewise-linear functions approximately (samples at the union of breakpoints). */
export function multiply(a: readonly Point[], b: readonly Point[]): Point[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const times = [...new Set([...a, ...b].map((p) => p.t))].sort((x, y) => x - y);
  return times.map((t) => ({ t, v: evaluate(a, t) * evaluate(b, t) }));
}

/** Adds two piecewise-linear functions (samples at the union of breakpoints); empty = 0. */
export function add(a: readonly Point[], b: readonly Point[]): Point[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const times = [...new Set([...a, ...b].map((p) => p.t))].sort((x, y) => x - y);
  return times.map((t) => ({ t, v: evaluate(a, t) + evaluate(b, t) }));
}

/** True if the function has the same value everywhere (or no points). */
export function isConstant(points: readonly Point[]): boolean {
  return points.every((p) => p.v === points[0]!.v);
}

export function evaluate(points: readonly Point[], t: number): number {
  const first = points[0];
  if (!first) return 1;
  if (t <= first.t) return first.v;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t <= b.t) return b.t - a.t <= 1e-12 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1]!.v;
}
