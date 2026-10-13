import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  createProject,
  sequentialContext,
  type ShapeClip,
  type VisualClip,
} from '@cutline/core';
import type { LayerBounds } from '@cutline/engine/pure';
import {
  boundsToBox,
  boxContains,
  boxCorners,
  boxExtent,
  clampScaleFactor,
  constrainAxis,
  containRect,
  cornerScaleFactor,
  displayScale,
  displayToProject,
  findVisualClip,
  hitTest,
  moveProps,
  pickableLayers,
  scaleProps,
  snapMove,
  type Box,
} from './geometry';

const FRAME = { width: 1920, height: 1080 };

function layer(clipId: string, type: LayerBounds['type'], trackId = 't'): LayerBounds {
  return { clipId, trackId, type, centerX: 0, centerY: 0, width: 1, height: 1, rotation: 0 };
}

describe('coordinate mapping', () => {
  it('letterboxes like object-fit: contain', () => {
    expect(containRect({ width: 1000, height: 1000 }, { width: 1280, height: 720 })).toEqual({
      left: 0,
      top: 218.75,
      width: 1000,
      height: 562.5,
    });
    expect(containRect({ width: 1000, height: 300 }, { width: 1280, height: 720 })).toMatchObject({
      top: 0,
      height: 300,
      left: (1000 - 1280 * (300 / 720)) / 2,
    });
    expect(containRect({ width: 0, height: 300 }, FRAME)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });

  it('maps display points into project pixels and back', () => {
    const rect = containRect({ width: 960, height: 700 }, FRAME); // 960×540 at top 80
    expect(displayToProject({ x: 480, y: 350 }, rect, FRAME)).toEqual({ x: 960, y: 540 });
    expect(displayToProject({ x: 0, y: 80 }, rect, FRAME)).toEqual({ x: 0, y: 0 });
    expect(displayScale(rect, FRAME)).toBe(0.5);
  });

  it('converts engine bounds from canvas pixels to project pixels', () => {
    const b: LayerBounds = {
      ...layer('a', 'text'),
      centerX: 640,
      centerY: 360,
      width: 100,
      height: 50,
      rotation: 0.5,
    };
    expect(boundsToBox(b, { width: 1280, height: 720 }, FRAME)).toEqual({
      cx: 960,
      cy: 540,
      width: 150,
      height: 75,
      rotation: 0.5,
    });
  });
});

describe('hit testing', () => {
  const box: Box = { cx: 100, cy: 100, width: 200, height: 20, rotation: Math.PI / 2 };

  it('respects rotation', () => {
    // Rotated by 90° the wide box becomes tall.
    expect(boxContains(box, { x: 100, y: 190 })).toBe(true);
    expect(boxContains(box, { x: 190, y: 100 })).toBe(false);
    expect(boxContains(box, { x: 115, y: 100 })).toBe(false);
    expect(boxContains(box, { x: 115, y: 100 }, 6)).toBe(true);
  });

  it('computes rotated corners and the axis-aligned extent', () => {
    const [tl, tr] = boxCorners(box);
    expect(tl.x).toBeCloseTo(110);
    expect(tl.y).toBeCloseTo(0);
    expect(tr.x).toBeCloseTo(110);
    expect(tr.y).toBeCloseTo(200);
    const ext = boxExtent(box);
    expect(ext.left).toBeCloseTo(90);
    expect(ext.right).toBeCloseTo(110);
    expect(ext.top).toBeCloseTo(0);
    expect(ext.bottom).toBeCloseTo(200);
  });

  it('picks the top-most layer under the pointer', () => {
    const bottom = {
      clipId: 'bottom',
      box: { cx: 50, cy: 50, width: 100, height: 100, rotation: 0 },
    };
    const top = { clipId: 'top', box: { cx: 80, cy: 80, width: 20, height: 20, rotation: 0 } };
    expect(hitTest([bottom, top], { x: 80, y: 80 })).toBe('top');
    expect(hitTest([bottom, top], { x: 20, y: 20 })).toBe('bottom');
    expect(hitTest([bottom, top], { x: 500, y: 20 })).toBeNull();
  });

  it('only offers editable layers on unlocked, visible tracks', () => {
    const layers = [
      layer('v', 'video', 'a'),
      layer('c', 'caption', 'a'),
      layer('locked', 'text', 'b'),
      layer('orphan', 'shape', 'gone'),
      layer('s', 'shape', 'a'),
    ];
    const tracks = [
      { id: 'a', locked: false, hidden: false },
      { id: 'b', locked: true, hidden: false },
    ];
    expect(pickableLayers(layers, tracks).map((l) => l.clipId)).toEqual(['v', 's']);
  });
});

describe('dragging', () => {
  const box: Box = { cx: 300, cy: 300, width: 200, height: 100, rotation: 0 };

  it('constrains to the dominant axis', () => {
    expect(constrainAxis(10, -3)).toEqual({ x: 10, y: 0 });
    expect(constrainAxis(2, -30)).toEqual({ x: 0, y: -30 });
  });

  it('snaps the center to the frame center lines', () => {
    const r = snapMove(box, 657, 237, FRAME, 5);
    expect(r).toEqual({ dx: 660, dy: 240, guides: { x: [960], y: [540] } });
  });

  it('snaps edges to the frame edges and leaves far moves alone', () => {
    // left edge 200 + dx(-197) = 3 → 0
    expect(snapMove(box, -197, 100, FRAME, 5)).toEqual({
      dx: -200,
      dy: 100,
      guides: { x: [0], y: [] },
    });
    // bottom edge 350 + 728 = 1078 → 1080
    expect(snapMove(box, 100, 728, FRAME, 5)).toEqual({
      dx: 100,
      dy: 730,
      guides: { x: [], y: [1080] },
    });
  });

  it('can lock an axis out of snapping', () => {
    expect(snapMove(box, 657, 237, FRAME, 5, { y: true })).toEqual({
      dx: 660,
      dy: 237,
      guides: { x: [960], y: [] },
    });
    expect(snapMove(box, 657, 237, FRAME, 5, { x: true }).dx).toBe(657);
  });

  it('derives uniform scale from corner drags', () => {
    expect(cornerScaleFactor({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 })).toBe(2);
    expect(cornerScaleFactor({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 })).toBe(1);
    expect(clampScaleFactor(100, [1, 2])).toBe(10);
    expect(clampScaleFactor(0.0001, [1, 2])).toBe(0.01);
    expect(clampScaleFactor(0, [1])).toBe(1);
    expect(clampScaleFactor(2, [])).toBe(1);
  });
});

describe('drag props', () => {
  function project() {
    const ctx = sequentialContext();
    return applyOperations(
      createProject({ name: 'g' }, ctx),
      [
        { type: 'add_shape', start: 0, duration: 5, id: 's' },
        {
          type: 'set_clip_props',
          clipId: 's',
          props: {
            transform: { x: 10, y: -20, scale: 1.5 },
            keyframes: {
              x: [
                { time: 0, value: 0 },
                { time: 1, value: 100 },
              ],
              scale: [{ time: 0, value: 2 }],
            },
          },
        },
        { type: 'add_text', text: 'Hi', start: 0, duration: 5, id: 'txt' },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'cap' }] },
      ],
      ctx,
    ).project;
  }

  it('finds visual clips only', () => {
    const p = project();
    expect(findVisualClip(p, 's')?.clip.type).toBe('shape');
    const caption = p.tracks.flatMap((t) => t.clips).find((c) => c.type === 'caption')!;
    expect(findVisualClip(p, caption.id)).toBeNull();
    expect(findVisualClip(p, 'nope')).toBeNull();
  });

  it('moves static values and shifts position keyframes', () => {
    const clip = findVisualClip(project(), 's')!.clip as ShapeClip;
    expect(moveProps(clip, 5.4, 0.6)).toEqual({
      transform: { x: 15, y: -19 },
      keyframes: {
        x: [
          { time: 0, value: 5, easing: 'linear' },
          { time: 1, value: 105, easing: 'linear' },
        ],
      },
    });
    const text = findVisualClip(project(), 'txt')!.clip as VisualClip;
    expect(moveProps(text, -1, 10)).toEqual({ transform: { x: -1, y: 10 } });
  });

  it('scales static values and scale keyframes within the limits', () => {
    const clip = findVisualClip(project(), 's')!.clip;
    expect(scaleProps(clip, 2)).toEqual({
      transform: { scale: 3 },
      keyframes: { scale: [{ time: 0, value: 4, easing: 'linear' }] },
    });
    // 20 / max(1.5, 2) = 10 at most
    expect(scaleProps(clip, 50).transform?.scale).toBe(15);
    const text = findVisualClip(project(), 'txt')!.clip;
    expect(scaleProps(text, 0.5)).toEqual({ transform: { scale: 0.5 } });
  });
});
