import type { VisualLayer } from '@cutline/core';

/**
 * Where a layer ended up on the canvas in the last rendered frame: an oriented
 * rectangle in canvas pixels. UIs use it for hit testing and selection boxes.
 */
export interface LayerBounds {
  clipId: string;
  trackId: string;
  type: VisualLayer['type'];
  /** Center in canvas pixels. */
  centerX: number;
  centerY: number;
  /** Size in canvas pixels before rotation (scale already applied). */
  width: number;
  height: number;
  /** Radians, clockwise (canvas y points down). */
  rotation: number;
}

export type OrientedRect = Pick<
  LayerBounds,
  'centerX' | 'centerY' | 'width' | 'height' | 'rotation'
>;

/** Axis-aligned rectangle in a node's local coordinates. */
export interface LocalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounds of a node whose content occupies `local` (its own coordinates), placed
 * at `position` with a uniform `scale` and a clockwise `rotation` in radians
 * (the same order PixiJS applies: scale, rotate, translate).
 */
export function orientedBounds(
  local: LocalRect,
  position: { x: number; y: number },
  scale: number,
  rotation: number,
): OrientedRect {
  const lx = (local.x + local.width / 2) * scale;
  const ly = (local.y + local.height / 2) * scale;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    centerX: position.x + lx * cos - ly * sin,
    centerY: position.y + lx * sin + ly * cos,
    width: local.width * Math.abs(scale),
    height: local.height * Math.abs(scale),
    rotation,
  };
}
