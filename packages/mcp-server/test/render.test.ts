import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, sequentialContext, type Project } from '@cutline/core';
import { Ffmpeg } from '../src/media/ffmpeg';
import { probeFile } from '../src/media/probe';
import { buildRenderGraph, wrapText } from '../src/render/graph';
import { num, piecewise } from '../src/render/expr';
import { Renderer } from '../src/render/renderer';
import { LocalBlobStore } from '../src/storage/local';
import { FFMPEG, FFPROBE, ffprobe, fixture, hasFfmpeg, hasFixtures, tempDir } from './helpers';

const ffmpeg = new Ffmpeg(FFMPEG, FFPROBE);

async function fixtureProject(): Promise<{ project: Project; blobs: LocalBlobStore }> {
  const dir = await tempDir();
  const blobs = new LocalBlobStore(dir);
  const ctx = sequentialContext();
  let project = createProject({ name: 'Render', settings: { width: 640, height: 360 } }, ctx);
  const ops: unknown[] = [];
  for (const [id, file] of [
    ['test', 'testsrc-5s.mp4'],
    ['beeps', 'beeps-12s.mp4'],
    ['still', 'still.png'],
  ] as const) {
    const key = `assets/${id}/${file}`;
    await blobs.putFile(key, fixture(file));
    const p = await probeFile(fixture(file), ffmpeg);
    ops.push({ type: 'add_asset', asset: { id, name: file, src: key, ...p } });
  }
  project = applyOperations(
    project,
    [
      ...ops,
      { type: 'add_clip', assetId: 'test', start: 0, duration: 3, id: 'a' },
      { type: 'add_clip', assetId: 'beeps', start: 3, duration: 3, sourceStart: 1, id: 'b' },
      { type: 'set_transition', clipId: 'b', transition: { type: 'crossfade', duration: 1 } },
      {
        type: 'add_clip',
        assetId: 'still',
        start: 1,
        duration: 4,
        props: {
          transform: { x: 200, y: -100, scale: 0.3, rotation: 10 },
          effects: { saturation: -1, blur: 2 },
          fadeIn: 0.5,
          keyframes: {
            x: [
              { time: 0, value: 200 },
              { time: 4, value: 100, easing: 'easeInOut' },
            ],
          },
        },
      },
      {
        type: 'add_text',
        text: 'Hello Cutline',
        start: 0.5,
        duration: 4,
        style: { backgroundColor: '#00000099' },
      },
      { type: 'add_captions', cues: [{ start: 0, end: 3, text: 'Server rendered captions' }] },
      { type: 'set_volume', clipId: 'a', volume: 0.5, fadeOut: 0.5 },
      {
        type: 'add_shape',
        start: 0,
        duration: 4,
        width: 360,
        height: 70,
        cornerRadius: 24,
        fill: '#2563ebcc',
        strokeWidth: 4,
        strokeColor: '#ffffff',
        transform: { y: 120 },
      },
      {
        type: 'add_shape',
        shape: 'ellipse',
        start: 0,
        duration: 6,
        width: 80,
        height: 80,
        fill: null,
        strokeWidth: 6,
        strokeColor: '#facc15',
        transform: { x: -220, y: -100 },
      },
    ],
    ctx,
  ).project;
  return { project, blobs };
}

describe('expressions', () => {
  it('formats numbers and piecewise functions', () => {
    expect(num(1.5)).toBe('1.5');
    expect(num(-0.0000001)).toBe('0');
    expect(num(Infinity)).toBe('0');
    expect(piecewise([])).toBe('1');
    expect(piecewise([{ t: 1, v: 2 }])).toBe('if(lt(t,1),2,2)');
    expect(
      piecewise([
        { t: 0, v: 0 },
        { t: 2, v: 1 },
      ]),
    ).toBe('if(lt(t,0),0,if(lt(t,2),(0+(1)*(t-0)/2),1))');
  });

  it('wraps long text', () => {
    expect(wrapText('one two three four five six', 20, 160)).toBe('one two three\nfour five six');
  });
});

describe.runIf(hasFfmpeg && hasFixtures)('server renderer (ffmpeg)', () => {
  it('probes fixtures', async () => {
    const v = await probeFile(fixture('testsrc-5s.mp4'), ffmpeg);
    expect(v).toMatchObject({
      kind: 'video',
      width: 640,
      height: 360,
      hasAudio: true,
      hasVideo: true,
    });
    expect(v.duration).toBeCloseTo(5, 1);
    expect(v.fps).toBeCloseTo(30, 0);
    const a = await probeFile(fixture('tone-3s.wav'), ffmpeg);
    expect(a).toMatchObject({ kind: 'audio', hasVideo: false, hasAudio: true });
    const i = await probeFile(fixture('still.png'), ffmpeg);
    expect(i).toMatchObject({ kind: 'image', width: 640, height: 360, duration: null });
  });

  it('builds a graph and renders an MP4 with audio', async () => {
    const { project, blobs } = await fixtureProject();
    const graph = buildRenderGraph(project, new Map(), {
      start: 0,
      end: 6,
      width: 640,
      height: 360,
      fps: 30,
      includeAudio: true,
      textFile: () => 'x.txt',
    });
    expect(graph.warnings).toContain('missing media for clip a');

    const out = join(await tempDir(), 'out.mp4');
    const progress: number[] = [];
    const result = await new Renderer(ffmpeg, blobs).render(project, out, {
      quality: 'preview',
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({ width: 640, height: 360, fps: 30 });
    expect(result.duration).toBeCloseTo(6);
    const info = ffprobe(out);
    expect(info.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(Number(info.format.duration)).toBeCloseTo(6, 0);
    expect(progress.length).toBeGreaterThan(0);
  }, 120_000);

  it('renders timeline frames as JPEG', async () => {
    const { project, blobs } = await fixtureProject();
    const frames = await new Renderer(ffmpeg, blobs).frames(project, [0.2, 3.2], 320);
    expect(frames).toHaveLength(2);
    if (process.env.CUTLINE_TEST_ARTIFACTS) {
      frames.forEach((f, i) =>
        writeFileSync(join(process.env.CUTLINE_TEST_ARTIFACTS!, `frame-${i}.jpg`), f),
      );
    }
    for (const f of frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1]).toBe(0xd8);
      expect(f.length).toBeGreaterThan(2000);
    }
  }, 60_000);
});
