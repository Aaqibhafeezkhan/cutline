import { describe, expect, it } from 'vitest';
import { gainAt, resolveAudioSegments, resolveFrame, transitionFactor, type Project } from '../src';
import { baseProject, run } from './helpers';

function twoClips(type: 'crossfade' | 'dipToBlack', fades = {}) {
  const { project, ctx } = baseProject();
  return run(
    project,
    [
      {
        type: 'add_clip',
        assetId: 'asset_v',
        start: 0,
        duration: 4,
        sourceStart: 2,
        id: 'a',
        props: fades,
      },
      { type: 'add_clip', assetId: 'asset_v', start: 4, duration: 4, sourceStart: 10, id: 'b' },
      { type: 'set_transition', clipId: 'b', transition: { type, duration: 2 } },
    ],
    ctx,
  ).project;
}

const layerIds = (p: Project, t: number) => resolveFrame(p, t).layers.map((l) => l.clipId);
const opacity = (p: Project, t: number, id: string) =>
  resolveFrame(p, t).layers.find((l) => l.clipId === id)?.transform.opacity;

describe('resolveFrame', () => {
  it('describes basic layers', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 1,
          duration: 4,
          sourceStart: 3,
          props: { transform: { x: 5 }, effects: { blur: 2 } },
        },
        {
          type: 'add_clip',
          assetId: 'asset_i',
          start: 0,
          duration: 10,
          trackId: 'track_1',
          mode: 'overwrite',
        },
        { type: 'add_text', text: 'Hello', start: 2 },
        { type: 'add_clip', assetId: 'asset_a' },
      ],
      ctx,
    ).project;
    const frame = resolveFrame(p, 2.5);
    expect(frame).toMatchObject({ width: 1920, height: 1080, background: '#000000' });
    expect(frame.layers.map((l) => l.type)).toEqual(['image', 'text']);
    const p2 = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 1,
          duration: 4,
          sourceStart: 3,
          props: { transform: { x: 5 } },
        },
      ],
      ctx,
    ).project;
    const video = resolveFrame(p2, 2).layers[0]!;
    expect(video).toMatchObject({
      type: 'video',
      assetId: 'asset_v',
      sourceTime: 4,
      localTime: 1,
      transform: { x: 5, opacity: 1 },
    });
    expect(resolveFrame(p2, 5).layers).toHaveLength(0);
  });

  it('skips hidden tracks and audio clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 2 },
        { type: 'update_track', trackId: 'track_1', hidden: true },
      ],
      ctx,
    ).project;
    expect(resolveFrame(p, 1).layers).toHaveLength(0);
    const audioOnVideoTrack = {
      ...project,
      tracks: [
        {
          ...project.tracks[0]!,
          clips: [
            {
              type: 'audio',
              id: 'x',
              start: 0,
              duration: 1,
              assetId: 'asset_a',
              sourceStart: 0,
              volume: 1,
              muted: false,
              fadeIn: 0,
              fadeOut: 0,
            },
          ],
        },
      ],
    } as Project;
    expect(resolveFrame(audioOnVideoTrack, 0.5).layers).toHaveLength(0);
  });

  it('applies keyframes and fades', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_i',
          start: 0,
          duration: 10,
          props: {
            fadeIn: 2,
            fadeOut: 2,
            keyframes: {
              scale: [
                { time: 0, value: 1 },
                { time: 10, value: 2 },
              ],
            },
          },
        },
      ],
      ctx,
    ).project;
    const l = resolveFrame(p, 1).layers[0]!;
    expect(l.transform.opacity).toBeCloseTo(0.5);
    expect(l.transform.scale).toBeCloseTo(1.1);
    expect(resolveFrame(p, 9.5).layers[0]!.transform.opacity).toBeCloseTo(0.25);
  });

  it('crossfades centered on the cut using handles', () => {
    const p = twoClips('crossfade');
    expect(layerIds(p, 2.9)).toEqual(['a']);
    expect(layerIds(p, 3.5)).toEqual(['a', 'b']);
    expect(opacity(p, 3.5, 'a')).toBe(1);
    expect(opacity(p, 3.5, 'b')).toBeCloseTo(0.25);
    expect(opacity(p, 4.5, 'b')).toBeCloseTo(0.75);
    const pre = resolveFrame(p, 3.5).layers[1]!;
    expect(pre.sourceTime).toBeCloseTo(9.5);
    const post = resolveFrame(p, 4.5).layers[0]!;
    expect(post.clipId).toBe('a');
    expect(post.sourceTime).toBeCloseTo(6.5);
    expect(layerIds(p, 5.1)).toEqual(['b']);
  });

  it('dips to black', () => {
    const p = twoClips('dipToBlack');
    expect(opacity(p, 3.5, 'a')).toBeCloseTo(0.5);
    expect(layerIds(p, 3.5)).toEqual(['a']);
    expect(layerIds(p, 4.5)).toEqual(['b']);
    expect(opacity(p, 4.5, 'b')).toBeCloseTo(0.5);
  });

  it('fades in from transparent without a predecessor', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 1, duration: 4, id: 'c' },
        { type: 'set_transition', clipId: 'c', transition: { type: 'crossfade', duration: 2 } },
      ],
      ctx,
    ).project;
    expect(opacity(p, 2, 'c')).toBeCloseTo(0.5);
    expect(opacity(p, 4, 'c')).toBe(1);
  });

  it('describes captions with the active word', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_captions',
          cues: [
            {
              start: 1,
              end: 3,
              text: 'hi there',
              words: [
                { text: 'hi', start: 1, end: 1.5 },
                { text: 'there', start: 1.6, end: 3 },
              ],
            },
          ],
        },
      ],
      ctx,
    ).project;
    const caption = resolveFrame(p, 2).layers[0]!;
    expect(caption).toMatchObject({
      type: 'caption',
      text: 'hi there',
      activeWord: 1,
      captionStyle: { position: 'bottom' },
    });
    expect(resolveFrame(p, 0.5).layers).toHaveLength(0);
    const noStyle = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        captionStyle: undefined,
        clips: t.clips.map((c) => ({ ...c, words: undefined })),
      })),
    } as Project;
    expect(resolveFrame(noStyle, 2).layers[0]).toMatchObject({
      words: [],
      activeWord: -1,
      captionStyle: { fontSize: 48 },
    });
  });

  it('transitionFactor handles non-visual clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [{ type: 'add_clip', assetId: 'asset_a', start: 1, duration: 2 }],
      ctx,
    ).project;
    const track = p.tracks[1]!;
    expect(transitionFactor(track, track.clips[0]!, 1.5)).toBe(1);
    expect(transitionFactor(track, track.clips[0]!, 3.5)).toBe(0);
  });
});

describe('audio', () => {
  it('interpolates gain envelopes', () => {
    expect(gainAt([], 1)).toBe(0);
    const pts = [
      { time: 1, gain: 0 },
      { time: 3, gain: 1 },
      { time: 3, gain: 0.5 },
    ];
    expect(gainAt(pts, 0)).toBe(0);
    expect(gainAt(pts, 2)).toBe(0.5);
    expect(gainAt(pts, 3)).toBe(1);
    expect(gainAt(pts, 5)).toBe(0.5);
  });

  it('builds segments with volume, track gain, fades and mutes', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 0,
          duration: 4,
          props: { volume: 0.5, fadeIn: 1 },
        },
        { type: 'add_clip', assetId: 'asset_a', start: 2, duration: 4, sourceStart: 1 },
        { type: 'add_clip', assetId: 'asset_i', start: 10 },
        { type: 'set_volume', trackId: 'track_2', volume: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 20, duration: 1, props: { muted: true } },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'x' }] },
      ],
      ctx,
    ).project;
    const segs = resolveAudioSegments(p);
    expect(segs.map((s) => s.clipId)).toEqual(['clip_1', 'clip_2']);
    const [v, a] = segs;
    expect(v).toMatchObject({ timelineStart: 0, timelineEnd: 4, sourceStart: 0 });
    expect(gainAt(v!.gain, 0.5)).toBeCloseTo(0.25);
    expect(gainAt(v!.gain, 2)).toBeCloseTo(0.5);
    expect(a).toMatchObject({ timelineStart: 2, timelineEnd: 6, sourceStart: 1 });
    expect(gainAt(a!.gain, 3)).toBe(2);
    const muted = run(p, [{ type: 'update_track', trackId: 'track_2', muted: true }], ctx).project;
    expect(resolveAudioSegments(muted).map((s) => s.clipId)).toEqual(['clip_1']);
  });

  it('crossfades audio with the video transition', () => {
    const p = twoClips('crossfade');
    const [a, b] = resolveAudioSegments(p);
    expect(a).toMatchObject({ clipId: 'a', timelineStart: 0, timelineEnd: 5 });
    expect(b).toMatchObject({ clipId: 'b', timelineStart: 3, sourceStart: 9 });
    expect(gainAt(a!.gain, 3.5)).toBeCloseTo(0.75);
    expect(gainAt(b!.gain, 3.5)).toBeCloseTo(0.25);
    expect(gainAt(a!.gain, 4.5)).toBeCloseTo(0.25);
  });

  it('dips audio and respects asset bounds when pre-rolling', () => {
    const dip = twoClips('dipToBlack');
    const [a, b] = resolveAudioSegments(dip);
    expect(a!.timelineEnd).toBe(4);
    expect(gainAt(a!.gain, 3.5)).toBeCloseTo(0.5);
    expect(gainAt(b!.gain, 4.5)).toBeCloseTo(0.5);

    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4, sourceStart: 16, id: 'a' },
        { type: 'add_clip', assetId: 'asset_v', start: 4, duration: 4, sourceStart: 0, id: 'b' },
        { type: 'set_transition', clipId: 'b', transition: { type: 'crossfade', duration: 2 } },
      ],
      ctx,
    ).project;
    const [sa, sb] = resolveAudioSegments(p);
    expect(sa!.timelineEnd).toBe(4); // asset ends at source 20
    expect(sb!.timelineStart).toBe(4); // cannot pre-roll before source 0
  });

  it('samples eased and held volume keyframes', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_a',
          start: 0,
          duration: 10,
          props: {
            keyframes: {
              volume: [
                { time: 0, value: 0, easing: 'easeIn' },
                { time: 4, value: 1, easing: 'hold' },
                { time: 6, value: 0.2, easing: 'linear' },
              ],
            },
          },
        },
      ],
      ctx,
    ).project;
    const [s] = resolveAudioSegments(p);
    expect(gainAt(s!.gain, 2)).toBeCloseTo(0.25, 1);
    expect(gainAt(s!.gain, 5)).toBeCloseTo(1);
    expect(gainAt(s!.gain, 8)).toBeCloseTo(0.2);
  });

  it('ignores clips whose asset lacks audio', () => {
    const { project, ctx } = baseProject();
    const p = run(project, [{ type: 'update_project', name: 'x' }], ctx).project;
    const silent = { ...p, assets: p.assets.map((a) => ({ ...a, hasAudio: false })) } as Project;
    const withClip = {
      ...silent,
      tracks: [
        {
          ...silent.tracks[0]!,
          clips: [
            {
              type: 'video',
              id: 'v',
              start: 0,
              duration: 1,
              assetId: 'asset_v',
              sourceStart: 0,
              volume: 1,
              muted: false,
              fadeIn: 0,
              fadeOut: 0,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              effects: {},
            },
          ],
        },
      ],
    } as Project;
    expect(resolveAudioSegments(withClip)).toEqual([]);
  });
});
