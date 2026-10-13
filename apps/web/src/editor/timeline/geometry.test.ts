import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, sequentialContext } from '@cutline/core';
import { displayTracks, rulerLabel, snap, snapBlock, snapPoints, tickStep } from './geometry';

function project() {
  const ctx = sequentialContext();
  const base = createProject({ name: 'g' }, ctx);
  return applyOperations(
    base,
    [
      { type: 'add_track', kind: 'caption' },
      { type: 'add_track', kind: 'video' },
      {
        type: 'add_asset',
        asset: {
          id: 'img',
          name: 'i',
          kind: 'image',
          src: 'i',
          mimeType: 'image/png',
          duration: null,
          hasVideo: true,
          hasAudio: false,
        },
      },
      { type: 'add_clip', assetId: 'img', trackId: 'track_1', start: 1, duration: 2, id: 'a' },
      { type: 'add_clip', assetId: 'img', trackId: 'track_1', start: 5, duration: 1, id: 'b' },
    ],
    ctx,
  ).project;
}

describe('timeline geometry', () => {
  it('orders tracks like an NLE: top visual layer first, audio last', () => {
    expect(displayTracks(project()).map((t) => t.name)).toEqual(['C1', 'V2', 'V1', 'A1']);
  });

  it('collects snap points and snaps within the threshold', () => {
    const points = snapPoints(project(), ['b'], 4.2);
    expect(points.sort((x, y) => x - y)).toEqual([0, 1, 3, 4.2]);
    expect(snap(3.05, points, 0.1)).toEqual({ time: 3, snapped: true });
    expect(snap(3.5, points, 0.1)).toEqual({ time: 3.5, snapped: false });
    expect(snap(3, points, 0.1)).toEqual({ time: 3, snapped: true });
  });

  it('snaps a moving block by whichever edge is closer', () => {
    const points = [0, 10];
    expect(snapBlock(0.05, 2, points, 0.1)).toBe(0);
    expect(snapBlock(7.95, 2, points, 0.1)).toBe(8);
    expect(snapBlock(5, 2, points, 0.1)).toBe(5);
    expect(snapBlock(0.08, 9.95, points, 0.1)).toBeCloseTo(0.05);
  });

  it('chooses readable ruler steps and labels', () => {
    expect(tickStep(60)).toBe(2);
    expect(tickStep(800)).toBe(0.1);
    expect(tickStep(0.01)).toBe(1200);
    expect(rulerLabel(4, 2)).toBe('4s');
    expect(rulerLabel(75, 5)).toBe('1:15');
    expect(rulerLabel(1.25, 0.25)).toBe('1.25s');
    expect(rulerLabel(61.5, 0.5)).toBe('1:01.5');
  });
});
