import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, sequentialContext } from '@cutline/core';
import {
  beatPoints,
  displayTracks,
  rulerLabel,
  snap,
  snapBlock,
  snapPoints,
  tickStep,
} from './geometry';

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

  it('turns known beat grids into timeline snap points', () => {
    const ctx = sequentialContext();
    const p = applyOperations(
      project(),
      [
        {
          type: 'add_asset',
          asset: {
            id: 'mus',
            name: 'm',
            kind: 'audio',
            src: 'm',
            mimeType: 'audio/wav',
            duration: 10,
            hasVideo: false,
            hasAudio: true,
          },
        },
        { type: 'add_clip', assetId: 'mus', start: 2, sourceStart: 1, duration: 3, id: 'm' },
      ],
      ctx,
    ).project;
    const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
    const grids = { mus: { beats }, img: { beats } };
    expect(beatPoints(p, grids, [])).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
    expect(beatPoints(p, grids, ['m'])).toEqual([]);
    expect(beatPoints(p, {}, [])).toEqual([]);
    expect(snapPoints(p, ['m', 'a', 'b'], 0, [2.5])).toContain(2.5);
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
