import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  createProject,
  sequentialContext,
  type OperationInput,
  type Project,
} from '@cutline/core';
import { beatCutOperations, planBeatCuts, type BeatCutClip } from '../src/media/beat-cuts';
import {
  BEAT_SAMPLE_RATE,
  beatsInClip,
  detectBeats,
  estimatePeriod,
  fft,
} from '../src/media/beats';

const SR = BEAT_SAMPLE_RATE;

/** Synthetic click track: decaying 1 kHz bursts every 60/bpm seconds from `offset`. */
function clickTrack(bpm: number, seconds: number, offset = 0.25, accentEvery = 0): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * SR));
  const interval = 60 / bpm;
  for (let k = 0, t = offset; t < seconds; k++, t = offset + k * interval) {
    const start = Math.round(t * SR);
    const gain = accentEvery && k % accentEvery === 0 ? 0.9 : 0.4;
    for (let i = 0; i < 0.03 * SR && start + i < pcm.length; i++) {
      pcm[start + i] = gain * Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / (0.006 * SR));
    }
  }
  return pcm;
}

function expectOnGrid(beats: number[], bpm: number, offset: number, seconds: number) {
  const interval = 60 / bpm;
  const expected = Math.floor((seconds - offset) / interval) + 1;
  expect(beats.length).toBeGreaterThanOrEqual(expected - 2);
  for (const b of beats) {
    const k = Math.round((b - offset) / interval);
    expect(Math.abs(b - (offset + k * interval))).toBeLessThanOrEqual(0.02);
  }
}

describe('fft', () => {
  it('finds the bin of a pure tone', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    expect(Math.hypot(re[5]!, im[5]!)).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[4]!, im[4]!)).toBeLessThan(1e-9);
  });
});

describe('detectBeats', () => {
  it('tracks a 120 BPM click track', () => {
    const r = detectBeats(clickTrack(120, 12), SR);
    expect(Math.abs(r.bpm - 120)).toBeLessThanOrEqual(1);
    expectOnGrid(r.beats, 120, 0.25, 12);
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.duration).toBeCloseTo(12, 2);
  });

  it('tracks 90 and 150 BPM and other start offsets', () => {
    const slow = detectBeats(clickTrack(90, 15, 0.6), SR);
    expect(Math.abs(slow.bpm - 90)).toBeLessThanOrEqual(1);
    expectOnGrid(slow.beats, 90, 0.6, 15);
    const fast = detectBeats(clickTrack(150, 10, 0.1), SR);
    expect(Math.abs(fast.bpm - 150)).toBeLessThanOrEqual(1);
    expectOnGrid(fast.beats, 150, 0.1, 10);
  });

  it('finds downbeats when every fourth click is accented', () => {
    const r = detectBeats(clickTrack(120, 12, 0.25, 4), SR);
    expect(r.downbeats).toBeDefined();
    for (const d of r.downbeats!) {
      const k = Math.round((d - 0.25) / 0.5);
      expect(Math.abs(k % 4)).toBe(0);
    }
  });

  it('honours the BPM range', () => {
    const r = detectBeats(clickTrack(120, 12), SR, { minBpm: 50, maxBpm: 70 });
    expect(Math.abs(r.bpm - 60)).toBeLessThanOrEqual(1);
  });

  it('returns no beats for silence or very short audio', () => {
    expect(detectBeats(new Float32Array(SR * 5), SR)).toEqual({
      bpm: 0,
      confidence: 0,
      beats: [],
      duration: 5,
    });
    expect(detectBeats(new Float32Array(100), SR).beats).toEqual([]);
    expect(estimatePeriod(new Float64Array(10), 0.01, 60, 200)).toBeNull();
  });

  it('maps beats into a clip window on the timeline', () => {
    expect(
      beatsInClip([0.5, 1, 1.5, 2, 2.5], { start: 10, duration: 1.2, sourceStart: 1 }),
    ).toEqual([10, 10.5, 11]);
  });
});

describe('planBeatCuts', () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const clip = (id: string, start: number, duration: number, maxDuration = Infinity) => ({
    id,
    start,
    duration,
    maxDuration,
  });

  it('lays clips back-to-back on every Nth beat and extends the grid', () => {
    const plan = planBeatCuts([clip('a', 0, 3), clip('b', 3, 1), clip('c', 4, 2)], beats, 4);
    expect(plan).toEqual([
      { clipId: 'a', start: 0, end: 2, beats: 4 },
      { clipId: 'b', start: 2, end: 4, beats: 4 },
      { clipId: 'c', start: 4, end: 6, beats: 4 },
    ]);
  });

  it('uses fewer beats when a clip runs out of media', () => {
    const plan = planBeatCuts([clip('a', 0.01, 1, 1.2), clip('b', 2, 1)], beats, 4);
    expect(plan[0]).toEqual({ clipId: 'a', start: 0.01, end: 1, beats: 2 });
    expect(plan[1]).toEqual({ clipId: 'b', start: 1, end: 3, beats: 4 });
  });

  it('starts on the next beat when the first clip is off-grid or after the music', () => {
    expect(planBeatCuts([clip('a', 0.7, 1)], beats, 1)[0]!.end).toBe(1.5);
    expect(planBeatCuts([clip('a', 10.2, 1)], beats, 2)[0]).toEqual({
      clipId: 'a',
      start: 10.2,
      end: 11.5,
      beats: 2,
    });
  });

  it('explains what to do when a clip is too short for one beat', () => {
    expect(() => planBeatCuts([clip('a', 0, 0.2, 0.2)], beats, 1)).toThrow(/only 0.2s of media/);
    expect(() => planBeatCuts([], beats, 1)).toThrow(/No clips/);
    expect(() => planBeatCuts([clip('a', 0, 1)], [1], 1)).toThrow(/Not enough beats/);
  });

  it('produces one conflict-free batch of existing operations', () => {
    const ctx = sequentialContext();
    let project: Project = createProject({ name: 'Beat cut' }, ctx);
    const track = project.tracks.find((t) => t.kind === 'video')!.id;
    const add = (start: number, duration: number): OperationInput => ({
      type: 'add_text',
      text: `t${start}`,
      trackId: track,
      start,
      duration,
    });
    project = applyOperations(project, [add(0, 3), add(3, 1), add(4, 0.4)], ctx).project;
    const clips: BeatCutClip[] = project.tracks
      .find((t) => t.id === track)!
      .clips.map((c) => ({
        id: c.id,
        start: c.start,
        duration: c.duration,
        maxDuration: Infinity,
      }));
    const plan = planBeatCuts(clips, beats, 2);
    const ops = beatCutOperations(clips, plan, 4.4);
    const result = applyOperations(project, ops, ctx).project;
    const laid = result.tracks
      .find((t) => t.id === track)!
      .clips.map((c) => [c.start, c.start + c.duration]);
    expect(laid).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });
});
