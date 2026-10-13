import { describe, expect, it } from 'vitest';
import {
  dbToGain,
  duckBreakpoints,
  duckGain,
  gainAt,
  mergeDuckRanges,
  resolveAudioSegments,
  sliceDuck,
  summarizeProject,
  type AudioClip,
  type Ducking,
  type Project,
} from '../src';
import { baseProject, clip, run } from './helpers';

const DUCK: Ducking = {
  ranges: [{ start: 2, end: 4 }],
  amountDb: -12,
  attack: 0.5,
  release: 1,
};
const LOW = dbToGain(-12);

describe('ducking helpers', () => {
  it('converts decibels to linear gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
  });

  it('merges ranges whose ramps would overlap and drops empty ones', () => {
    expect(
      mergeDuckRanges(
        [
          { start: 5, end: 6 },
          { start: 1, end: 2 },
          { start: 2.5, end: 3 },
          { start: 7, end: 7 },
        ],
        0.5,
      ),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(
      mergeDuckRanges(
        [
          { start: 1, end: 4 },
          { start: 2, end: 3 },
        ],
        0,
      ),
    ).toEqual([{ start: 1, end: 4 }]);
  });

  it('computes a ramped gain envelope', () => {
    expect(duckGain(undefined, 3)).toBe(1);
    expect(duckGain(DUCK, 0)).toBe(1);
    expect(duckGain(DUCK, 1.75)).toBeCloseTo(1 - (1 - LOW) / 2);
    expect(duckGain(DUCK, 3)).toBeCloseTo(LOW);
    expect(duckGain(DUCK, 4.5)).toBeCloseTo(1 - (1 - LOW) / 2);
    expect(duckGain(DUCK, 6)).toBe(1);
    expect(duckBreakpoints(undefined)).toEqual([]);
    expect(duckBreakpoints(DUCK)).toEqual([1.5, 2, 4, 5]);
  });

  it('slices and re-bases ducking to a window', () => {
    expect(sliceDuck(undefined, 0, 1)).toBeUndefined();
    expect(sliceDuck(DUCK, 0, 1.4)).toBeUndefined();
    expect(sliceDuck(DUCK, 5, 9)).toBeUndefined();
    expect(sliceDuck(DUCK, 3, 9)?.ranges).toEqual([{ start: -1, end: 1 }]);
    expect(sliceDuck(DUCK, 0, 1.6)?.ranges).toEqual([{ start: 2, end: 4 }]);
  });
});

function musicProject(): { project: Project; ctx: ReturnType<typeof baseProject>['ctx'] } {
  const { project, ctx } = baseProject();
  const p = run(
    project,
    [
      {
        type: 'add_clip',
        assetId: 'asset_a',
        trackId: 'track_2',
        start: 0,
        duration: 10,
        id: 'm1',
      },
      {
        type: 'add_clip',
        assetId: 'asset_a',
        trackId: 'track_2',
        start: 10,
        duration: 10,
        sourceStart: 10,
        id: 'm2',
      },
    ],
    ctx,
  ).project;
  return { project: p, ctx };
}

describe('duck_audio', () => {
  it('stores clip-relative ducking that the resolver turns into a gain envelope', () => {
    const { project, ctx } = musicProject();
    const r = run(
      project,
      [
        {
          type: 'duck_audio',
          trackId: 'track_2',
          ranges: [
            { start: 2, end: 4 },
            { start: 4.2, end: 5 },
            { start: 12, end: 13 },
          ],
        },
      ],
      ctx,
    );
    expect(r.summary).toBe(
      'Ducked 2 clip(s) on track A1 by -12 dB during 2 range(s) (attack 0.15s, release 0.4s).',
    );
    expect(r.affectedIds).toEqual(expect.arrayContaining(['m1', 'm2', 'track_2']));
    const m1 = clip<AudioClip>(r.project, 'm1');
    expect(m1.duck).toEqual({
      amountDb: -12,
      attack: 0.15,
      release: 0.4,
      ranges: [{ start: 2, end: 5 }],
    });
    expect(clip<AudioClip>(r.project, 'm2').duck?.ranges).toEqual([{ start: 2, end: 3 }]);

    const seg = resolveAudioSegments(r.project).find((s) => s.clipId === 'm1')!;
    const low = dbToGain(-12);
    expect(gainAt(seg.gain, 1)).toBeCloseTo(1);
    expect(gainAt(seg.gain, 1.925)).toBeCloseTo(1 - (1 - low) / 2);
    expect(gainAt(seg.gain, 3)).toBeCloseTo(low);
    expect(gainAt(seg.gain, 5.2)).toBeCloseTo(1 - (1 - low) / 2);
    expect(gainAt(seg.gain, 6)).toBeCloseTo(1);
    expect(seg.gain.map((p) => p.time)).toEqual(expect.arrayContaining([1.85, 2, 5, 5.4]));
    expect(summarizeProject(r.project).tracks[1]!.clips[0]!.ducked).toBe('-12 dB in 1 range(s)');
  });

  it('replaces earlier ducking instead of stacking, and [] removes it', () => {
    const { project, ctx } = musicProject();
    const once = run(
      project,
      [{ type: 'duck_audio', trackId: 'track_2', ranges: [{ start: 1, end: 2 }], amountDb: -6 }],
      ctx,
    ).project;
    const twice = run(
      once,
      [{ type: 'duck_audio', trackId: 'track_2', ranges: [{ start: 15, end: 16 }], attack: 0.2 }],
      ctx,
    );
    expect(clip<AudioClip>(twice.project, 'm1').duck).toBeUndefined();
    expect(clip<AudioClip>(twice.project, 'm2').duck).toEqual({
      amountDb: -12,
      attack: 0.2,
      release: 0.4,
      ranges: [{ start: 5, end: 6 }],
    });
    expect(twice.affectedIds).toEqual(expect.arrayContaining(['m1', 'm2']));
    const cleared = run(
      twice.project,
      [{ type: 'duck_audio', trackId: 'track_2', ranges: [] }],
      ctx,
    );
    expect(cleared.summary).toBe('Removed ducking from 1 clip(s) on track A1.');
    expect(clip<AudioClip>(cleared.project, 'm2').duck).toBeUndefined();
  });

  it('follows splits and ripple cuts of the ducked clip', () => {
    const { project, ctx } = musicProject();
    const ducked = run(
      project,
      [{ type: 'duck_audio', trackId: 'track_2', ranges: [{ start: 2, end: 3 }] }],
      ctx,
    ).project;
    const split = run(
      ducked,
      [{ type: 'split_clip', clipId: 'm1', time: 6, newClipId: 'm1b' }],
      ctx,
    ).project;
    expect(clip<AudioClip>(split, 'm1').duck?.ranges).toEqual([{ start: 2, end: 3 }]);
    expect(clip<AudioClip>(split, 'm1b').duck).toBeUndefined();
    const cut = run(
      ducked,
      [{ type: 'delete_range', ranges: [{ start: 0, end: 1 }] }],
      ctx,
    ).project;
    const first = cut.tracks[1]!.clips[0] as AudioClip;
    expect(first.duck?.ranges).toEqual([{ start: 1, end: 2 }]);
  });

  it('explains when the track has nothing to duck', () => {
    const { project, ctx } = baseProject();
    expect(() =>
      run(
        project,
        [{ type: 'duck_audio', trackId: 'track_2', ranges: [{ start: 0, end: 1 }] }],
        ctx,
      ),
    ).toThrow(/no audio or video clips to duck/);
  });
});
