import type { ShapeGeometry } from '@cutline/core';

/** Shape size, corner radius and stroke in canvas pixels (radius clamped to half the short side). */
export function shapeMetrics(shape: ShapeGeometry, renderScale: number) {
  const w = shape.width * renderScale;
  const h = shape.height * renderScale;
  return {
    w,
    h,
    r: Math.min(shape.cornerRadius * renderScale, w / 2, h / 2),
    stroke: Math.min(shape.strokeWidth * renderScale, w / 2, h / 2),
  };
}
