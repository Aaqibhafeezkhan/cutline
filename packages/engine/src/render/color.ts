import type { Effects } from '@cutline/core';

type Tuple<T, N extends number, R extends T[] = []> = R['length'] extends N
  ? R
  : Tuple<T, N, [T, ...R]>;

/** 5×4 RGBA color matrix (rows R, G, B, A; columns r, g, b, a, offset in 0..1). */
export type ColorMatrix = Tuple<number, 20>;

// prettier-ignore
const IDENTITY: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

// Rec. 709 luma weights.
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

export function hasColorEffects(effects: Effects): boolean {
  return Boolean(effects.brightness || effects.contrast || effects.saturation);
}

/**
 * Builds the matrix for brightness (additive), contrast (scale around 0.5)
 * and saturation (lerp from luma). Semantics match the ffmpeg `eq` filter
 * mapping used by the server renderer: brightness b, contrast 1+c, saturation 1+s.
 */
export function colorMatrix(effects: Effects): ColorMatrix {
  if (!hasColorEffects(effects)) return [...IDENTITY];
  const b = effects.brightness ?? 0;
  const c = 1 + (effects.contrast ?? 0);
  const s = 1 + (effects.saturation ?? 0);
  const sr = (1 - s) * LR;
  const sg = (1 - s) * LG;
  const sb = (1 - s) * LB;
  // saturation, then contrast, then brightness
  const o = 0.5 * (1 - c) + b;
  // prettier-ignore
  return [
    c * (sr + s), c * sg,       c * sb,       0, o,
    c * sr,       c * (sg + s), c * sb,       0, o,
    c * sr,       c * sg,       c * (sb + s), 0, o,
    0,            0,            0,            1, 0,
  ];
}

/** Applies a color matrix to an RGB triple in 0..1 (used in tests and canvas fallbacks). */
export function applyColorMatrix(
  m: ColorMatrix,
  rgb: [number, number, number],
): [number, number, number] {
  const [r, g, b] = rgb;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(m[0] * r + m[1] * g + m[2] * b + m[4]),
    clamp(m[5] * r + m[6] * g + m[7] * b + m[9]),
    clamp(m[10] * r + m[11] * g + m[12] * b + m[14]),
  ];
}
