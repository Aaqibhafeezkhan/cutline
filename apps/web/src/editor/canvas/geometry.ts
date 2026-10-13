// Pure geometry for direct manipulation in the preview: coordinate mapping
// (display ↔ canvas ↔ project), hit testing with rotation, snapping and the
// clip props a drag produces. No DOM, no React: unit tested.
import type { ClipPropsPatch, Keyframe, Project, Track, VisualClip } from '@cutline/core';
import type { LayerBounds } from '@cutline/engine/pure';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in display (CSS) pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Oriented box in project pixels (origin top-left, rotation in radians clockwise). */
export interface Box {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

/** Scale limits of `transform.scale` (see TransformSchema). */
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 20;

/** Clip types that can be moved/scaled on the canvas (captions are laid out by their track). */
export const EDITABLE_TYPES: ReadonlySet<LayerBounds['type']> = new Set([
  'video',
  'image',
  'text',
  'shape',
]);

/** Where `object-fit: contain` draws content of size `content` inside a box of size `box`. */
export function containRect(box: Size, content: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const s = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * s;
  const height = content.height * s;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** Display point (relative to the box `rect` lives in) → project pixels. */
export function displayToProject(p: Point, rect: Rect, project: Size): Point {
  const k = project.width / rect.width;
  return { x: (p.x - rect.left) * k, y: (p.y - rect.top) * k };
}

/** Display pixels per project pixel. */
export function displayScale(rect: Rect, project: Size): number {
  return rect.width / project.width;
}

/** Engine bounds (canvas pixels) → box in project pixels. */
export function boundsToBox(b: LayerBounds, canvas: Size, project: Size): Box {
  const k = project.width / canvas.width;
  return {
    cx: b.centerX * k,
    cy: b.centerY * k,
    width: b.width * k,
    height: b.height * k,
    rotation: b.rotation,
  };
}

/** `p` in the box's own (unrotated, centered) coordinates. */
export function toBoxLocal(box: Box, p: Point): Point {
  const dx = p.x - box.cx;
  const dy = p.y - box.cy;
  const cos = Math.cos(-box.rotation);
  const sin = Math.sin(-box.rotation);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** Whether `p` lies inside the (rotated) box, grown by `pad` on every side. */
export function boxContains(box: Box, p: Point, pad = 0): boolean {
  const l = toBoxLocal(box, p);
  return Math.abs(l.x) <= box.width / 2 + pad && Math.abs(l.y) <= box.height / 2 + pad;
}

/** Corners clockwise from top-left (in the box's unrotated sense). */
export function boxCorners(box: Box): [Point, Point, Point, Point] {
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  const w = box.width / 2;
  const h = box.height / 2;
  const at = (x: number, y: number): Point => ({
    x: box.cx + x * cos - y * sin,
    y: box.cy + x * sin + y * cos,
  });
  return [at(-w, -h), at(w, -h), at(w, h), at(-w, h)];
}

/** Axis-aligned bounding box of a (rotated) box. */
export function boxExtent(box: Box) {
  const pts = boxCorners(box);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

export interface HitCandidate {
  clipId: string;
  box: Box;
}

/** Top-most candidate under `p`; candidates are ordered bottom → top. */
export function hitTest(candidates: readonly HitCandidate[], p: Point, pad = 0): string | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (boxContains(c.box, p, pad)) return c.clipId;
  }
  return null;
}

/** Layers that can be picked on the canvas: editable types on visible, unlocked tracks. */
export function pickableLayers(
  layers: readonly LayerBounds[],
  tracks: readonly Pick<Track, 'id' | 'locked' | 'hidden'>[],
): LayerBounds[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return layers.filter((l) => {
    const track = byId.get(l.trackId);
    return EDITABLE_TYPES.has(l.type) && !!track && !track.locked && !track.hidden;
  });
}

/** Keeps only the dominant axis of a drag (Shift constraint). */
export function constrainAxis(dx: number, dy: number): Point {
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** Guide lines to draw, in project pixels: vertical lines at x, horizontal lines at y. */
  guides: { x: number[]; y: number[] };
}

/** Snaps the nearest of `edges` to the nearest of `targets` within `threshold`. */
function snapAxis(edges: number[], targets: number[], threshold: number) {
  let best: { shift: number; target: number } | null = null;
  for (const e of edges) {
    for (const t of targets) {
      const shift = t - e;
      if (Math.abs(shift) <= threshold && (!best || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, target: t };
      }
    }
  }
  return best;
}

/**
 * Snaps a box moved by (dx, dy) to the frame's center lines and edges. Its
 * center and the edges of its axis-aligned extent are tested; `lock` keeps
 * an axis untouched (e.g. the axis removed by the Shift constraint).
 */
export function snapMove(
  box: Box,
  dx: number,
  dy: number,
  frame: Size,
  threshold: number,
  lock: { x?: boolean; y?: boolean } = {},
): SnapResult {
  const moved = { ...box, cx: box.cx + dx, cy: box.cy + dy };
  const ext = boxExtent(moved);
  const guides: SnapResult['guides'] = { x: [], y: [] };
  let sx = dx;
  let sy = dy;
  if (!lock.x) {
    const s = snapAxis(
      [moved.cx, ext.left, ext.right],
      [frame.width / 2, 0, frame.width],
      threshold,
    );
    if (s) {
      sx += s.shift;
      guides.x.push(s.target);
    }
  }
  if (!lock.y) {
    const s = snapAxis(
      [moved.cy, ext.top, ext.bottom],
      [frame.height / 2, 0, frame.height],
      threshold,
    );
    if (s) {
      sy += s.shift;
      guides.y.push(s.target);
    }
  }
  return { dx: sx, dy: sy, guides };
}

/** Uniform scale factor of a corner drag around `center`: ratio of the pointer distances. */
export function cornerScaleFactor(center: Point, from: Point, to: Point): number {
  const d0 = Math.hypot(from.x - center.x, from.y - center.y);
  const d1 = Math.hypot(to.x - center.x, to.y - center.y);
  return d0 < 1e-6 ? 1 : d1 / d0;
}

/** Clamps `factor` so every value × factor stays within the scale limits. */
export function clampScaleFactor(factor: number, values: readonly number[]): number {
  if (!(factor > 0) || values.length === 0) return 1;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return Math.min(Math.max(factor, MIN_SCALE / min), MAX_SCALE / max);
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function shiftKeyframes(list: readonly Keyframe[] | undefined, delta: number) {
  return list?.map((k) => ({ ...k, value: round(k.value + delta, 2) }));
}

/**
 * Props that move a clip by (dx, dy) project pixels. The static position is
 * rounded to whole pixels; x/y keyframes shift by the same amount so animated
 * clips keep their motion path.
 */
export function moveProps(clip: VisualClip, dx: number, dy: number): ClipPropsPatch {
  const x = Math.round(clip.transform.x + dx);
  const y = Math.round(clip.transform.y + dy);
  const props: ClipPropsPatch = { transform: { x, y } };
  const kx = shiftKeyframes(clip.keyframes?.x, x - clip.transform.x);
  const ky = shiftKeyframes(clip.keyframes?.y, y - clip.transform.y);
  if (kx || ky) props.keyframes = { ...(kx && { x: kx }), ...(ky && { y: ky }) };
  return props;
}

/** Props that scale a clip by `factor` (scale keyframes are multiplied too). */
export function scaleProps(clip: VisualClip, factor: number): ClipPropsPatch {
  const values = [clip.transform.scale, ...(clip.keyframes?.scale?.map((k) => k.value) ?? [])];
  const f = clampScaleFactor(factor, values);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, round(clip.transform.scale * f, 3)));
  const props: ClipPropsPatch = { transform: { scale } };
  const ks = clip.keyframes?.scale;
  if (ks) {
    props.keyframes = {
      scale: ks.map((k) => ({
        ...k,
        value: Math.min(MAX_SCALE, Math.max(MIN_SCALE, round(k.value * f, 3))),
      })),
    };
  }
  return props;
}

/** The visual clip `id` and its track, or null. */
export function findVisualClip(
  project: Project,
  id: string,
): { clip: VisualClip; track: Track } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) {
      return clip.type === 'audio' || clip.type === 'caption' ? null : { clip, track };
    }
  }
  return null;
}
