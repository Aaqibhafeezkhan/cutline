import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  createProject,
  sequentialContext,
  type AudioSegment,
  type Transform,
} from '@cutline/core';
import {
  applyColorMatrix,
  captionCenterY,
  captionTokens,
  clipSamples,
  colorMatrix,
  exportPlan,
  layoutWords,
  mixChunk,
  parseColor,
  placeMedia,
  placeText,
  segmentsInWindow,
  shapeMetrics,
  sourceWindow,
} from '../src/pure';

const T: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

describe('layout', () => {
  it('fits media inside the frame (contain) and applies transforms', () => {
    const p = placeMedia({ width: 1920, height: 1080 }, { width: 640, height: 480 }, T);
    expect(p).toMatchObject({ centerX: 960, centerY: 540, width: 1440, height: 1080 });
    const moved = placeMedia(
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
      { x: 100, y: -50, scale: 0.5, rotation: 90, opacity: 0.3 },
      0.5,
    );
    expect(moved).toMatchObject({
      centerX: 530,
      centerY: 245,
      width: 480,
      height: 270,
      alpha: 0.3,
    });
    expect(moved.rotation).toBeCloseTo(Math.PI / 2);
    expect(placeText({ width: 100, height: 100 }, { ...T, x: 10, scale: 2 }, 2)).toMatchObject({
      centerX: 120,
      centerY: 100,
      scale: 2,
    });
  });

  it('positions captions', () => {
    const style = { margin: 0.1, position: 'bottom' as const };
    expect(captionCenterY(1000, style, 100)).toBe(850);
    expect(captionCenterY(1000, { ...style, position: 'top' }, 100)).toBe(150);
    expect(captionCenterY(1000, { ...style, position: 'middle' }, 100)).toBe(500);
  });

  it('parses colors', () => {
    expect(parseColor('#ff8000')).toEqual({ color: 0xff8000, alpha: 1 });
    expect(parseColor('#00000080').alpha).toBeCloseTo(0.502, 2);
  });
});

describe('color matrix', () => {
  it('is identity without effects and matches eq semantics', () => {
    expect(applyColorMatrix(colorMatrix({}), [0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6]);
    const bright = applyColorMatrix(colorMatrix({ brightness: 0.1 }), [0.2, 0.4, 0.6]);
    expect(bright.map((v) => +v.toFixed(3))).toEqual([0.3, 0.5, 0.7]);
    const gray = applyColorMatrix(colorMatrix({ saturation: -1 }), [1, 0, 0]);
    expect(gray[0]).toBeCloseTo(0.2126);
    expect(gray[1]).toBeCloseTo(0.2126);
    const contrast = applyColorMatrix(colorMatrix({ contrast: 1 }), [0.75, 0.5, 0.25]);
    expect(contrast).toEqual([1, 0.5, 0]);
  });
});

describe('caption layout', () => {
  it('wraps greedily', () => {
    const measure = (t: string) => t.length * 10;
    const lines = layoutWords(['hello', 'big', 'world'], measure, 100);
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([['hello', 'big'], ['world']]);
    expect(lines[0]!.words[1]).toMatchObject({ x: 60, width: 30, index: 1 });
    expect(lines[0]!.width).toBe(90);
    expect(layoutWords([], measure, 100)).toEqual([]);
    expect(layoutWords(['enormousword'], measure, 50)[0]!.width).toBe(120);
  });

  it('tokenizes and detects word timing alignment', () => {
    expect(captionTokens(' a  b ', [{ text: 'a' }, { text: 'b' }])).toEqual({
      tokens: ['a', 'b'],
      timed: true,
    });
    expect(captionTokens('a b', [{ text: 'a' }]).timed).toBe(false);
    expect(captionTokens('a b', undefined).timed).toBe(false);
  });
});

describe('audio mixing', () => {
  const seg = (over: Partial<AudioSegment> = {}): AudioSegment => {
    const s = {
      clipId: 'c',
      trackId: 't',
      assetId: 'a',
      timelineStart: 1,
      timelineEnd: 3,
      sourceStart: 10,
      speed: 1,
      reverse: false,
      gain: [{ time: 1, gain: 1 }],
      ...over,
    };
    return {
      sourceEnd: s.sourceStart + (s.timelineEnd - s.timelineStart) * s.speed,
      ...s,
    };
  };

  it('plays segments faster and backwards', () => {
    const ramp = {
      channels: [new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])],
      sampleRate: 8,
      timestamp: 0,
    };
    // 2×: 8 source samples in 0.5 s of timeline → every second sample at 8 Hz output.
    const fast = [new Float32Array(4)];
    mixChunk(
      fast,
      0,
      8,
      seg({ timelineStart: 0, timelineEnd: 0.5, sourceStart: 0, speed: 2 }),
      ramp,
    );
    expect(Array.from(fast[0]!)).toEqual([0, 2, 4, 6]);
    // Reversed: timeline 0 plays source 1 s (the end), walking back.
    const back = [new Float32Array(8)];
    mixChunk(
      back,
      0,
      8,
      seg({ timelineStart: 0, timelineEnd: 1, sourceStart: 0, reverse: true }),
      ramp,
    );
    expect(Array.from(back[0]!)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    // A later chunk (source 1–2 s) fills the first half of a 2 s reversed segment.
    const two = [new Float32Array(16)];
    const s2 = seg({ timelineStart: 0, timelineEnd: 2, sourceStart: 0, reverse: true });
    mixChunk(two, 0, 8, s2, { ...ramp, timestamp: 1 });
    mixChunk(two, 0, 8, s2, ramp);
    expect(Array.from(two[0]!)).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(
      sourceWindow(seg({ timelineStart: 0, timelineEnd: 2, sourceStart: 0, reverse: true }), 0, 1),
    ).toEqual({ from: 1, to: 2 });
  });

  it('places source samples at the right timeline position with gain', () => {
    const out = [new Float32Array(400), new Float32Array(400)];
    // 1 kHz output covering timeline [0, 0.4) ... use segment starting at 0.1
    const s = seg({
      timelineStart: 0.1,
      timelineEnd: 0.3,
      sourceStart: 5,
      gain: [{ time: 0, gain: 0.5 }],
    });
    const chunk = { channels: [new Float32Array(1000).fill(1)], sampleRate: 1000, timestamp: 4.9 };
    mixChunk(out, 0, 1000, s, chunk);
    expect(out[0]![99]).toBe(0);
    expect(out[0]![100]).toBeCloseTo(0.5);
    expect(out[1]![299]).toBeCloseTo(0.5); // mono duplicated
    expect(out[0]![300]).toBe(0);
  });

  it('resamples linearly and skips silent gain and empty input', () => {
    const out = [new Float32Array(4)];
    const ramp = {
      channels: [new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])],
      sampleRate: 8,
      timestamp: 0,
    };
    mixChunk(out, 0, 4, seg({ timelineStart: 0, timelineEnd: 1, sourceStart: 0 }), ramp);
    expect(Array.from(out[0]!)).toEqual([0, 2, 4, 6]);
    const silent = [new Float32Array(4)];
    mixChunk(
      silent,
      0,
      4,
      seg({ timelineStart: 0, timelineEnd: 1, sourceStart: 0, gain: [{ time: 0, gain: 0 }] }),
      ramp,
    );
    expect(Array.from(silent[0]!)).toEqual([0, 0, 0, 0]);
    mixChunk([], 0, 4, seg(), ramp);
    mixChunk(silent, 0, 4, seg(), { channels: [new Float32Array(0)], sampleRate: 8, timestamp: 0 });
    mixChunk(silent, 10, 4, seg(), ramp); // no overlap
    expect(Array.from(silent[0]!)).toEqual([0, 0, 0, 0]);
    // fractional positions interpolate and the last sample repeats
    const half = [new Float32Array(3)];
    mixChunk(half, 0, 2, seg({ timelineStart: 0, timelineEnd: 1.5, sourceStart: 0 }), {
      channels: [new Float32Array([0, 1, 2])],
      sampleRate: 1,
      timestamp: 0,
    });
    expect(Array.from(half[0]!)).toEqual([0, 0.5, 1]);
  });

  it('clips and windows', () => {
    const ch = [new Float32Array([2, -3, 0.5])];
    clipSamples(ch);
    expect(Array.from(ch[0]!)).toEqual([1, -1, 0.5]);
    const segs = [seg(), seg({ timelineStart: 5, timelineEnd: 6 })];
    expect(segmentsInWindow(segs, 2, 4)).toHaveLength(1);
    expect(sourceWindow(seg(), 0, 2)).toEqual({ from: 10, to: 11 });
  });
});

describe('export plan', () => {
  it('derives even sizes, ranges and frame counts', () => {
    const ctx = sequentialContext();
    let p = createProject({ name: 'x', settings: { width: 1280, height: 720, fps: 25 } }, ctx);
    p = applyOperations(
      p,
      [
        {
          type: 'add_asset',
          asset: {
            id: 'i',
            name: 'i',
            kind: 'image',
            src: 'i',
            mimeType: 'image/png',
            duration: null,
            hasVideo: true,
            hasAudio: false,
          },
        },
        { type: 'add_clip', assetId: 'i', duration: 4 },
      ],
      ctx,
    ).project;
    expect(exportPlan(p)).toMatchObject({
      width: 1280,
      height: 720,
      fps: 25,
      start: 0,
      end: 4,
      totalFrames: 100,
      container: 'mp4',
    });
    expect(exportPlan(p, { width: 641 })).toMatchObject({ width: 642, height: 360 });
    expect(
      exportPlan(p, { range: { start: 1, end: 9 }, fps: 10, container: 'webm' }),
    ).toMatchObject({
      start: 1,
      end: 4,
      totalFrames: 30,
      container: 'webm',
    });
  });
});

describe('shape metrics', () => {
  it('scales to canvas pixels and clamps radius and stroke', () => {
    const shape = {
      kind: 'rectangle' as const,
      width: 200,
      height: 100,
      fill: '#fff',
      strokeColor: '#000',
      strokeWidth: 400,
      cornerRadius: 80,
    };
    expect(shapeMetrics(shape, 0.5)).toEqual({ w: 100, h: 50, r: 25, stroke: 25 });
    expect(shapeMetrics({ ...shape, strokeWidth: 4, cornerRadius: 10 }, 1)).toEqual({
      w: 200,
      h: 100,
      r: 10,
      stroke: 4,
    });
  });
});
