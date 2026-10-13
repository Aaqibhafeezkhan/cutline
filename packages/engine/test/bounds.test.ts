import { describe, expect, it } from 'vitest';
import { orientedBounds } from '../src/pure';

describe('orientedBounds', () => {
  it('keeps a centered rect at the node position and applies the scale', () => {
    const b = orientedBounds({ x: -50, y: -20, width: 100, height: 40 }, { x: 300, y: 200 }, 2, 0);
    expect(b).toEqual({ centerX: 300, centerY: 200, width: 200, height: 80, rotation: 0 });
  });

  it('rotates an off-center rect clockwise around the node origin', () => {
    // Content centered 10 px right of the origin; rotating 90° clockwise moves it 10 px down.
    const b = orientedBounds(
      { x: 0, y: -5, width: 20, height: 10 },
      { x: 100, y: 100 },
      1,
      Math.PI / 2,
    );
    expect(b.centerX).toBeCloseTo(100);
    expect(b.centerY).toBeCloseTo(110);
    expect(b.width).toBe(20);
    expect(b.height).toBe(10);
    expect(b.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('scales the center offset and uses the absolute size for mirrored nodes', () => {
    const b = orientedBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0 }, -2, 0);
    expect(b).toMatchObject({ centerX: -10, centerY: -10, width: 20, height: 20 });
  });
});
