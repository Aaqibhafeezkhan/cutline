import { describe, expect, it } from 'vitest';
import type { CutlineError } from '../src';
import {
  MIGRATIONS,
  applyOperation,
  createProject,
  invertRanges,
  isAudibleClip,
  isVisualClip,
  mapSourceRangeToTimeline,
  resolveFrame,
  sequentialContext,
  timelineEnvelope,
  type CaptionClip,
  type Clip,
  type Project,
  type VideoClip,
} from '../src';
import { baseProject, clip, run, spans } from './helpers';

describe('edge cases', () => {
  it('classifies clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v' },
        { type: 'add_clip', assetId: 'asset_a' },
      ],
      ctx,
    ).project;
    const v = clip(p, 'clip_1');
    const a = clip(p, 'clip_2');
    expect([isVisualClip(v), isAudibleClip(v), isVisualClip(a), isAudibleClip(a)]).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it('creates projects without default tracks', () => {
    expect(
      createProject({ name: 'Empty', defaultTracks: false }, sequentialContext()).tracks,
    ).toEqual([]);
  });

  it('migrates clips without optional ms fields', () => {
    const out = MIGRATIONS[0]!.migrate({
      tracks: [{ clips: [{ startMs: 1000, durationMs: 1000 }] }],
    });
    expect(out).toMatchObject({ tracks: [{ clips: [{ start: 1, duration: 1 }] }] });
  });

  it('stops inverting at ranges past the end', () => {
    expect(
      invertRanges(
        [
          { start: 1, end: 2 },
          { start: 8, end: 9 },
        ],
        0,
        5,
      ),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 5 },
    ]);
  });

  it('splits captions with words', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_captions',
          cues: [
            {
              start: 0,
              end: 2,
              text: 'one two',
              words: [
                { text: 'one', start: 0, end: 0.8 },
                { text: 'two', start: 1.2, end: 2 },
              ],
            },
          ],
        },
      ],
      ctx,
    ).project;
    const id = p.tracks[2]!.clips[0]!.id;
    const r = applyOperation(p, { type: 'split_clip', clipId: id, time: 1 }, ctx);
    const [left, right] = r.project.tracks[2]!.clips as CaptionClip[];
    expect(left!.words).toEqual([{ text: 'one', start: 0, end: 0.8 }]);
    expect(right!.words).toEqual([{ text: 'two', start: 0.2, end: 1 }]);
  });

  it('splits animated clips with a transition', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 0,
          duration: 4,
          props: {
            transitionIn: { type: 'crossfade', duration: 1 },
            keyframes: {
              x: [
                { time: 0, value: 0 },
                { time: 4, value: 400 },
              ],
            },
          },
        },
      ],
      ctx,
    ).project;
    const r = applyOperation(p, { type: 'split_clip', clipId: 'clip_1', time: 1 }, ctx);
    const left = clip<VideoClip>(r.project, 'clip_1');
    const right = clip<VideoClip>(r.project, 'clip_2');
    expect(left.transitionIn).toBeDefined();
    expect(right.transitionIn).toBeUndefined();
    expect(left.keyframes?.x?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [1, 100],
    ]);
    expect(right.keyframes?.x?.map((k) => [k.time, k.value])).toEqual([
      [0, 100],
      [3, 400],
    ]);
    expect(resolveFrame(r.project, 2).layers[0]!.transform.x).toBeCloseTo(200);
  });

  it('trims caption clips from the left during range deletion', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [{ type: 'add_captions', cues: [{ start: 1, end: 4, text: 'x' }] }],
      ctx,
    ).project;
    const r = applyOperation(p, { type: 'delete_range', ranges: [{ start: 0, end: 2 }] }, ctx);
    expect(spans(r.project, 2).map((s) => [s[1], s[2]])).toEqual([[0, 2]]);
  });

  it('ripple-trims without a duration change', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4 },
        { type: 'add_clip', assetId: 'asset_v', start: 4, duration: 4 },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      { type: 'trim_clip', clipId: 'clip_1', start: 1, end: 5, ripple: true },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 4],
      ['clip_2', 4, 8],
    ]);
    expect(clip<VideoClip>(r.project, 'clip_1').sourceStart).toBe(1);
  });

  it('reports the next free slot past several clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 1 },
        { type: 'add_clip', assetId: 'asset_v', start: 3, duration: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 10, duration: 2 },
      ],
      ctx,
    ).project;
    try {
      applyOperation(
        p,
        { type: 'add_clip', assetId: 'asset_i', trackId: 'track_1', start: 4, duration: 1 },
        ctx,
      );
      throw new Error('expected overlap');
    } catch (e) {
      expect((e as CutlineError).details).toMatchObject({ nextFreeStart: 5 });
    }
  });

  it('handles explicit undefined and null props', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 2,
          duration: 2,
          props: { transitionIn: { type: 'crossfade', duration: 1 } },
        },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      {
        type: 'set_clip_props',
        clipId: 'clip_2',
        props: { name: undefined, effects: { blur: undefined, contrast: 0.1 }, transitionIn: null },
      },
      ctx,
    );
    const c = clip<VideoClip>(r.project, 'clip_2');
    expect(c.transitionIn).toBeUndefined();
    expect(c.effects).toEqual({ contrast: 0.1 });
    expect(
      applyOperation(p, { type: 'set_clip_props', clipId: 'clip_1', props: {} }, ctx).summary,
    ).toBe('Updated nothing on clip clip_1.');
  });

  it('creates new video tracks below caption tracks', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 2 },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'cap' }] },
        { type: 'add_text', text: 'Title', start: 0 },
      ],
      ctx,
    ).project;
    expect(p.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'video', 'caption']);
  });

  it('adds tracks below caption tracks by default', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_track', kind: 'caption', name: 'Subs' },
        { type: 'add_track', kind: 'video', name: 'Top video' },
        { type: 'add_track', kind: 'caption', name: 'Subs 2' },
      ],
      ctx,
    ).project;
    expect(p.tracks.map((t) => t.name)).toEqual(['V1', 'A1', 'Top video', 'Subs', 'Subs 2']);
  });

  it('updates caption track styles', () => {
    const { project, ctx } = baseProject();
    const p = run(project, [{ type: 'add_track', kind: 'caption', id: 'subs' }], ctx).project;
    const r = applyOperation(
      p,
      { type: 'update_track', trackId: 'subs', captionStyle: { position: 'top', fontSize: 20 } },
      ctx,
    );
    expect(r.project.tracks[2]!.captionStyle).toMatchObject({
      position: 'top',
      fontSize: 20,
      color: '#ffffff',
    });
    expect(r.summary).toMatch(/caption style/);
  });

  it('resolves frames even if an asset is missing (partially loaded documents)', () => {
    const { project, ctx } = baseProject();
    const p = run(project, [{ type: 'add_clip', assetId: 'asset_v', duration: 2 }], ctx).project;
    const orphan = { ...p, assets: [] } as Project;
    expect(resolveFrame(orphan, 1).layers[0]!.sourceTime).toBe(1);
  });

  it('skips windows outside a segment and ranges a clip does not cover', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [{ type: 'add_clip', assetId: 'asset_v', start: 1.07, duration: 1 }],
      ctx,
    ).project;
    const env = { windowSec: 0.01, rms: new Array<number>(2000).fill(0.5), peak: [] };
    const tl = timelineEnvelope(p, new Map([['asset_v', env]]), 0.1);
    expect(tl.rms[10]).toBe(0);
    expect(tl.rms[11]).toBeGreaterThan(0);
    expect(mapSourceRangeToTimeline(p, 'asset_v', { start: 5, end: 6 })).toEqual([]);
    const other: Clip[] = p.tracks[0]!.clips;
    expect(other).toHaveLength(1);
  });
});
