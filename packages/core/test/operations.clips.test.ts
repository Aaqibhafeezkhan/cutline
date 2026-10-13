import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  applyOperation,
  sequentialContext,
  type AudioClip,
  type ImageClip,
  type VideoClip,
} from '../src';
import { NOW, baseProject, clip, run, spans } from './helpers';

function expectError(fn: () => unknown, code: string, message?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CutlineError);
    expect((e as CutlineError).code).toBe(code);
    if (message) expect((e as CutlineError).message).toMatch(message);
    return e as CutlineError;
  }
  throw new Error(`expected ${code} error`);
}

describe('add_clip', () => {
  it('appends the full asset to the first matching track by default', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(project, { type: 'add_clip', assetId: 'asset_v' }, ctx);
    const c = clip<VideoClip>(r.project, 'clip_1');
    expect(c).toMatchObject({ type: 'video', start: 0, duration: 20, sourceStart: 0, volume: 1 });
    expect(r.project.tracks[0]!.clips).toHaveLength(1);
    expect(r.affectedIds).toEqual(['clip_1']);
    expect(r.createdIds).toEqual(['clip_1']);
    expect(r.summary).toMatch(/Added video clip clip_1/);
    expect(r.patches.length).toBeGreaterThan(0);
    expect(r.project.updatedAt).toBe(NOW);

    const r2 = applyOperation(
      r.project,
      { type: 'add_clip', assetId: 'asset_v', sourceStart: 5, duration: 3 },
      ctx,
    );
    expect(clip(r2.project, 'clip_2')).toMatchObject({ start: 20, duration: 3, sourceStart: 5 });
  });

  it('infers audio and image clip types and default image duration', () => {
    const { project, ctx } = baseProject();
    const r = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_a' },
        { type: 'add_clip', assetId: 'asset_i', start: 2 },
      ],
      ctx,
    );
    expect(clip<AudioClip>(r.project, 'clip_1')).toMatchObject({ type: 'audio', duration: 30 });
    expect(r.project.tracks[1]!.clips[0]!.id).toBe('clip_1');
    expect(clip<ImageClip>(r.project, 'clip_2')).toMatchObject({
      type: 'image',
      start: 2,
      duration: 5,
    });
  });

  it('places only the audio of a video with clipType audio', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'add_clip', assetId: 'asset_v', clipType: 'audio' },
      ctx,
    );
    expect(r.project.tracks[1]!.clips[0]).toMatchObject({ type: 'audio', assetId: 'asset_v' });
  });

  it('creates a new track when no existing one has room', () => {
    const { project, ctx } = baseProject();
    const r = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0 },
        { type: 'add_clip', assetId: 'asset_i', start: 1 },
      ],
      ctx,
    );
    expect(r.project.tracks).toHaveLength(3);
    expect(r.project.tracks[2]).toMatchObject({ kind: 'video', name: 'V2' });
    expect(r.createdIds).toContain(r.project.tracks[2]!.id);
  });

  it('creates a track when there is no track of the kind at all', () => {
    const ctx = sequentialContext(NOW);
    const { project } = baseProject(ctx);
    const noAudio = run(project, [{ type: 'remove_track', trackId: 'track_2' }], ctx).project;
    const r = applyOperation(noAudio, { type: 'add_clip', assetId: 'asset_a' }, ctx);
    expect(r.project.tracks.find((t) => t.kind === 'audio')?.name).toBe('A1');
  });

  it('respects an explicit track and applies initial props', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      {
        type: 'add_clip',
        assetId: 'asset_v',
        trackId: 'track_1',
        start: 1,
        duration: 2,
        props: { volume: 0.5 },
      },
      ctx,
    );
    expect(clip<VideoClip>(r.project, 'clip_1')).toMatchObject({
      start: 1,
      duration: 2,
      volume: 0.5,
    });
  });

  it('validates asset/clip type combinations', () => {
    const { project, ctx } = baseProject();
    expectError(
      () =>
        applyOperation(project, { type: 'add_clip', assetId: 'asset_a', clipType: 'video' }, ctx),
      'INVALID_ARGUMENT',
      /no video/,
    );
    expectError(
      () =>
        applyOperation(project, { type: 'add_clip', assetId: 'asset_i', clipType: 'audio' }, ctx),
      'INVALID_ARGUMENT',
      /no audio/,
    );
    const e = expectError(
      () =>
        applyOperation(project, { type: 'add_clip', assetId: 'asset_v', clipType: 'image' }, ctx),
      'INVALID_ARGUMENT',
      /not an image/,
    );
    expect(e.hint).toMatch(/video/);
    const e2 = expectError(
      () =>
        applyOperation(project, { type: 'add_clip', assetId: 'asset_a', clipType: 'image' }, ctx),
      'INVALID_ARGUMENT',
    );
    expect(e2.hint).toMatch(/audio/);
    expectError(
      () =>
        applyOperation(project, { type: 'add_clip', assetId: 'asset_v', trackId: 'track_2' }, ctx),
      'INVALID_ARGUMENT',
      /cannot hold video/,
    );
    expectError(
      () => applyOperation(project, { type: 'add_clip', assetId: 'nope' }, ctx),
      'NOT_FOUND',
    );
  });

  it('rejects source ranges outside the asset', () => {
    const { project, ctx } = baseProject();
    expectError(
      () => applyOperation(project, { type: 'add_clip', assetId: 'asset_v', sourceStart: 20 }, ctx),
      'OUT_OF_RANGE',
      /beyond the end/,
    );
    const e = expectError(
      () =>
        applyOperation(
          project,
          { type: 'add_clip', assetId: 'asset_v', sourceStart: 15, duration: 10 },
          ctx,
        ),
      'OUT_OF_RANGE',
    );
    expect(e.hint).toMatch(/at most 5s/);
  });

  it('handles collisions according to mode', () => {
    const { project, ctx } = baseProject();
    const base = run(
      project,
      [{ type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', start: 0, duration: 10 }],
      ctx,
    ).project;
    const e = expectError(
      () =>
        applyOperation(
          base,
          { type: 'add_clip', assetId: 'asset_i', trackId: 'track_1', start: 4, duration: 2 },
          ctx,
        ),
      'OVERLAP',
    );
    expect(e.hint).toMatch(/start ≥ 10s/);
    expect(e.details).toMatchObject({ collisions: ['clip_1'], nextFreeStart: 10 });

    const over = applyOperation(
      base,
      {
        type: 'add_clip',
        assetId: 'asset_i',
        trackId: 'track_1',
        start: 4,
        duration: 2,
        mode: 'overwrite',
        id: 'img',
      },
      ctx,
    );
    const overClips = over.project.tracks[0]!.clips;
    expect(overClips.map((c) => [c.type, c.start, c.start + c.duration])).toEqual([
      ['video', 0, 4],
      ['image', 4, 6],
      ['video', 6, 10],
    ]);
    expect((overClips[2] as VideoClip).sourceStart).toBe(6);
    expect(overClips[1]!.id).toBe('img');

    const ins = applyOperation(
      base,
      {
        type: 'add_clip',
        assetId: 'asset_i',
        trackId: 'track_1',
        start: 4,
        duration: 2,
        mode: 'insert',
      },
      ctx,
    );
    expect(
      ins.project.tracks[0]!.clips.map((c) => [c.type, c.start, c.start + c.duration]),
    ).toEqual([
      ['video', 0, 4],
      ['image', 4, 6],
      ['video', 6, 12],
    ]);
  });

  it('inserts at a cut without splitting', () => {
    const { project, ctx } = baseProject();
    const base = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 2, duration: 2 },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      base,
      {
        type: 'add_clip',
        assetId: 'asset_i',
        trackId: 'track_1',
        start: 2,
        duration: 1,
        mode: 'insert',
      },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 2],
      ['clip_3', 2, 3],
      ['clip_2', 3, 5],
    ]);
  });

  it('refuses locked tracks', () => {
    const { project, ctx } = baseProject();
    const locked = run(
      project,
      [{ type: 'update_track', trackId: 'track_1', locked: true }],
      ctx,
    ).project;
    const e = expectError(
      () =>
        applyOperation(locked, { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1' }, ctx),
      'LOCKED',
    );
    expect(e.hint).toMatch(/locked: false/);
    // Auto-placement skips the locked track and creates a new one.
    const r = applyOperation(locked, { type: 'add_clip', assetId: 'asset_v' }, ctx);
    expect(r.project.tracks[2]!.clips[0]!.id).toBe('clip_1');
  });
});

describe('split_clip', () => {
  it('splits into two clips with correct source ranges and fades', () => {
    const { project, ctx } = baseProject();
    const base = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 2,
          duration: 10,
          sourceStart: 1,
          props: { fadeIn: 1, fadeOut: 2 },
        },
      ],
      ctx,
    ).project;
    const r = applyOperation(base, { type: 'split_clip', clipId: 'clip_1', time: 6 }, ctx);
    const left = clip<VideoClip>(r.project, 'clip_1');
    const right = clip<VideoClip>(r.project, 'clip_2');
    expect(left).toMatchObject({ start: 2, duration: 4, sourceStart: 1, fadeIn: 1, fadeOut: 0 });
    expect(right).toMatchObject({ start: 6, duration: 6, sourceStart: 5, fadeIn: 0, fadeOut: 2 });
    expect(r.createdIds).toEqual(['clip_2']);
    expect(r.affectedIds.sort()).toEqual(['clip_1', 'clip_2']);
  });

  it('uses a given id and rejects cuts at the edges', () => {
    const { project, ctx } = baseProject();
    const base = run(project, [{ type: 'add_clip', assetId: 'asset_v', duration: 4 }], ctx).project;
    const r = applyOperation(
      base,
      { type: 'split_clip', clipId: 'clip_1', time: 1, newClipId: 'right' },
      ctx,
    );
    expect(clip(r.project, 'right').start).toBe(1);
    const e = expectError(
      () => applyOperation(base, { type: 'split_clip', clipId: 'clip_1', time: 4 }, ctx),
      'OUT_OF_RANGE',
    );
    expect(e.message).toMatch(/strictly inside/);
  });
});

describe('trim_clip', () => {
  const setup = () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 5, sourceStart: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 5, duration: 5, sourceStart: 10 },
        { type: 'add_clip', assetId: 'asset_v', start: 12, duration: 3 },
      ],
      ctx,
    ).project;
    return { p, ctx };
  };

  it('moves the in-point when trimming the start', () => {
    const { p, ctx } = setup();
    const r = applyOperation(p, { type: 'trim_clip', clipId: 'clip_2', start: 6 }, ctx);
    expect(clip<VideoClip>(r.project, 'clip_2')).toMatchObject({
      start: 6,
      duration: 4,
      sourceStart: 11,
    });
    const ext = applyOperation(r.project, { type: 'trim_clip', clipId: 'clip_2', start: 5.5 }, ctx);
    expect(clip<VideoClip>(ext.project, 'clip_2')).toMatchObject({ start: 5.5, sourceStart: 10.5 });
  });

  it('trims the end and checks bounds', () => {
    const { p, ctx } = setup();
    const r = applyOperation(p, { type: 'trim_clip', clipId: 'clip_2', end: 11 }, ctx);
    expect(clip(r.project, 'clip_2').duration).toBe(6);
    expectError(
      () => applyOperation(p, { type: 'trim_clip', clipId: 'clip_2', end: 13 }, ctx),
      'OVERLAP',
      /overlap clip_3/,
    );
    expectError(
      () => applyOperation(p, { type: 'trim_clip', clipId: 'clip_1', start: -0 + 5 }, ctx),
      'OUT_OF_RANGE',
      /leave nothing/,
    );
    expectError(
      () => applyOperation(p, { type: 'trim_clip', clipId: 'clip_3', start: 11 }, ctx),
      'OUT_OF_RANGE',
      /cannot start before/,
    );
    expectError(
      () => applyOperation(p, { type: 'trim_clip', clipId: 'clip_3', end: 40 }, ctx),
      'OUT_OF_RANGE',
      /only 20s long/,
    );
  });

  it('ripples later clips', () => {
    const { p, ctx } = setup();
    const r = applyOperation(
      p,
      { type: 'trim_clip', clipId: 'clip_1', start: 1, ripple: true },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 4],
      ['clip_2', 4, 9],
      ['clip_3', 11, 14],
    ]);
    expect(clip<VideoClip>(r.project, 'clip_1').sourceStart).toBe(3);
    const grow = applyOperation(
      p,
      { type: 'trim_clip', clipId: 'clip_2', end: 12, ripple: true },
      ctx,
    );
    expect(spans(grow.project, 0)).toEqual([
      ['clip_1', 0, 5],
      ['clip_2', 5, 12],
      ['clip_3', 14, 17],
    ]);
    expect(grow.summary).toMatch(/ripple/);
  });

  it('extends images freely', () => {
    const { project, ctx } = baseProject();
    const p = run(project, [{ type: 'add_clip', assetId: 'asset_i', start: 3 }], ctx).project;
    const r = applyOperation(p, { type: 'trim_clip', clipId: 'clip_1', start: 0, end: 100 }, ctx);
    expect(clip(r.project, 'clip_1')).toMatchObject({ start: 0, duration: 100 });
  });
});

describe('move_clip', () => {
  it('moves within and across tracks', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_track', kind: 'video' },
      ],
      ctx,
    ).project;
    const r = applyOperation(p, { type: 'move_clip', clipId: 'clip_1', start: 3 }, ctx);
    expect(clip(r.project, 'clip_1').start).toBe(3);
    expect(r.summary).toBe('Moved clip clip_1 to 3s.');
    const r2 = applyOperation(
      p,
      { type: 'move_clip', clipId: 'clip_1', start: 1, trackId: 'track_3' },
      ctx,
    );
    expect(r2.project.tracks[0]!.clips).toHaveLength(0);
    expect(r2.project.tracks[2]!.clips[0]).toMatchObject({ id: 'clip_1', start: 1 });
    expect(r2.summary).toMatch(/on track V2/);
  });

  it('rejects incompatible tracks and collisions; supports overwrite', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4 },
        { type: 'add_clip', assetId: 'asset_v', start: 4, duration: 4 },
      ],
      ctx,
    ).project;
    expectError(
      () =>
        applyOperation(
          p,
          { type: 'move_clip', clipId: 'clip_1', start: 0, trackId: 'track_2' },
          ctx,
        ),
      'INVALID_ARGUMENT',
    );
    expectError(
      () => applyOperation(p, { type: 'move_clip', clipId: 'clip_1', start: 2 }, ctx),
      'OVERLAP',
    );
    const r = applyOperation(
      p,
      { type: 'move_clip', clipId: 'clip_1', start: 2, mode: 'overwrite' },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 2, 6],
      ['clip_2', 6, 8],
    ]);
  });
});

describe('delete_clips', () => {
  it('deletes with and without ripple', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 2, duration: 3 },
        { type: 'add_clip', assetId: 'asset_v', start: 5, duration: 1 },
        { type: 'add_clip', assetId: 'asset_v', start: 8, duration: 1 },
      ],
      ctx,
    ).project;
    const plain = applyOperation(p, { type: 'delete_clips', clipIds: ['clip_2'] }, ctx);
    expect(spans(plain.project, 0).map((s) => s[0])).toEqual(['clip_1', 'clip_3', 'clip_4']);
    expect(plain.removedIds).toEqual(['clip_2']);
    const ripple = applyOperation(
      p,
      { type: 'delete_clips', clipIds: ['clip_2', 'clip_3', 'clip_2'], ripple: true },
      ctx,
    );
    expect(spans(ripple.project, 0)).toEqual([
      ['clip_1', 0, 2],
      ['clip_4', 4, 5],
    ]);
    expect(ripple.summary).toMatch(/closed the gaps/);
  });
});

describe('delete_range', () => {
  it('cuts ranges across all tracks and closes gaps', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 10 },
        { type: 'add_clip', assetId: 'asset_a', start: 0, duration: 10 },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      {
        type: 'delete_range',
        ranges: [
          { start: 6, end: 7 },
          { start: 2, end: 3 },
          { start: 2.5, end: 3.5 },
        ],
      },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 2],
      ['clip_5', 2, 4.5],
      ['clip_3', 4.5, 7.5],
    ]);
    expect(clip<VideoClip>(r.project, 'clip_5').sourceStart).toBe(3.5);
    expect(clip<VideoClip>(r.project, 'clip_3').sourceStart).toBe(7);
    expect(spans(r.project, 1).map((s) => s.slice(1))).toEqual([
      [0, 2],
      [2, 4.5],
      [4.5, 7.5],
    ]);
    expect(r.summary).toMatch(/Removed 2 range\(s\) totalling 2.5s from 2 track\(s\)/);
    expect(r.summary).toMatch(/Timeline is now 7.5s/);
  });

  it('removes clips fully inside, trims edges, and can skip ripple', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 2, duration: 2 },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 4,
          duration: 2,
          props: { fadeIn: 1, transitionIn: { type: 'crossfade', duration: 1 } },
        },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      {
        type: 'delete_range',
        ranges: [{ start: 1, end: 5 }],
        ripple: false,
        trackIds: ['track_1'],
      },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 1],
      ['clip_3', 5, 6],
    ]);
    const trimmed = clip<VideoClip>(r.project, 'clip_3');
    expect(trimmed.fadeIn).toBe(0);
    expect(trimmed.transitionIn).toBeUndefined();
    expect(r.removedIds).toEqual(['clip_2']);
  });

  it('skips locked tracks and reports them; explicit locked track errors', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4 },
        { type: 'update_track', trackId: 'track_2', locked: true },
      ],
      ctx,
    ).project;
    const r = applyOperation(p, { type: 'delete_range', ranges: [{ start: 1, end: 2 }] }, ctx);
    expect(r.summary).toMatch(/Locked tracks skipped: A1/);
    expectError(
      () =>
        applyOperation(
          p,
          { type: 'delete_range', ranges: [{ start: 1, end: 2 }], trackIds: ['track_2'] },
          ctx,
        ),
      'LOCKED',
    );
  });
});

describe('set_clip_props', () => {
  it('merges transform, effects, keyframes and style', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 4 },
        { type: 'add_text', text: 'Hi', start: 0 },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      {
        type: 'set_clip_props',
        clipId: 'clip_1',
        props: {
          name: 'Intro',
          transform: { x: 10 },
          effects: { brightness: 0.2, blur: 3 },
          keyframes: {
            opacity: [
              { time: 2, value: 0 },
              { time: 0, value: 1 },
            ],
          },
        },
      },
      ctx,
    );
    const c = clip<VideoClip>(r.project, 'clip_1');
    expect(c.name).toBe('Intro');
    expect(c.transform).toMatchObject({ x: 10, y: 0, scale: 1 });
    expect(c.effects).toEqual({ brightness: 0.2, blur: 3 });
    expect(c.keyframes?.opacity?.map((k) => k.time)).toEqual([0, 2]);
    expect(r.summary).toBe('Updated name, transform, effects, keyframes on clip clip_1.');

    const r2 = applyOperation(
      r.project,
      {
        type: 'set_clip_props',
        clipId: 'clip_1',
        props: { effects: { blur: null }, keyframes: { opacity: [] } },
      },
      ctx,
    );
    const c2 = clip<VideoClip>(r2.project, 'clip_1');
    expect(c2.effects).toEqual({ brightness: 0.2 });
    expect(c2.keyframes).toBeUndefined();

    const r3 = applyOperation(
      p,
      {
        type: 'set_clip_props',
        clipId: 'clip_2',
        props: { text: 'Bye', style: { color: '#ff0000' } },
      },
      ctx,
    );
    expect(clip(r3.project, 'clip_2')).toMatchObject({
      text: 'Bye',
      style: { color: '#ff0000', fontSize: 72 },
    });
  });

  it('rejects properties that do not apply', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_a' },
        { type: 'add_clip', assetId: 'asset_i' },
      ],
      ctx,
    ).project;
    const e = expectError(
      () =>
        applyOperation(
          p,
          { type: 'set_clip_props', clipId: 'clip_1', props: { transform: { x: 1 } } },
          ctx,
        ),
      'INVALID_ARGUMENT',
    );
    expect(e.hint).toMatch(
      /Settable on audio clips: name, keyframes, fadeIn, fadeOut, volume, muted/,
    );
    expectError(
      () =>
        applyOperation(
          p,
          {
            type: 'set_clip_props',
            clipId: 'clip_1',
            props: { keyframes: { x: [{ time: 0, value: 1 }] } },
          },
          ctx,
        ),
      'INVALID_ARGUMENT',
      /keyframes.x/,
    );
    expectError(
      () =>
        applyOperation(
          p,
          {
            type: 'set_clip_props',
            clipId: 'clip_2',
            props: { keyframes: { volume: [{ time: 0, value: 1 }] } },
          },
          ctx,
        ),
      'INVALID_ARGUMENT',
      /keyframes.volume/,
    );
    const ok = applyOperation(
      p,
      {
        type: 'set_clip_props',
        clipId: 'clip_1',
        props: { keyframes: { volume: [{ time: 0, value: 0.5 }] }, muted: true },
      },
      ctx,
    );
    expect(clip<AudioClip>(ok.project, 'clip_1').keyframes?.volume).toHaveLength(1);
  });

  it('validates the resulting clip', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [{ type: 'add_captions', cues: [{ start: 0, end: 1, text: 'a' }] }],
      ctx,
    ).project;
    const id = p.tracks[2]!.clips[0]!.id;
    expectError(
      () =>
        applyOperation(
          p,
          {
            type: 'set_clip_props',
            clipId: id,
            props: { words: [{ text: 'a', start: -1, end: 1 }] },
          },
          ctx,
        ),
      'INVALID_OPERATION',
    );
    const r = applyOperation(
      p,
      { type: 'set_clip_props', clipId: id, props: { words: [{ text: 'a', start: 0, end: 1 }] } },
      ctx,
    );
    expect(clip(r.project, id)).toMatchObject({ words: [{ text: 'a' }] });
  });
});

describe('set_transition', () => {
  it('adds, limits and removes transitions', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_v', start: 2, duration: 4 },
        { type: 'add_clip', assetId: 'asset_a' },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      { type: 'set_transition', clipId: 'clip_2', transition: { type: 'crossfade', duration: 1 } },
      ctx,
    );
    expect(clip<VideoClip>(r.project, 'clip_2').transitionIn).toEqual({
      type: 'crossfade',
      duration: 1,
    });
    expect(r.summary).toMatch(/1s crossfade into clip clip_2/);
    const e = expectError(
      () =>
        applyOperation(
          p,
          {
            type: 'set_transition',
            clipId: 'clip_2',
            transition: { type: 'dipToBlack', duration: 5 },
          },
          ctx,
        ),
      'OUT_OF_RANGE',
    );
    expect(e.hint).toMatch(/at most 4s/);
    expectError(
      () =>
        applyOperation(
          p,
          {
            type: 'set_transition',
            clipId: 'clip_1',
            transition: { type: 'crossfade', duration: 3 },
          },
          ctx,
        ),
      'OUT_OF_RANGE',
    );
    const removed = applyOperation(
      r.project,
      { type: 'set_transition', clipId: 'clip_2', transition: null },
      ctx,
    );
    expect(clip<VideoClip>(removed.project, 'clip_2').transitionIn).toBeUndefined();
    const e2 = expectError(
      () => applyOperation(p, { type: 'set_transition', clipId: 'clip_3', transition: null }, ctx),
      'INVALID_ARGUMENT',
    );
    expect(e2.hint).toMatch(/fadeIn/);
  });
});

describe('set_volume', () => {
  it('sets clip and track volume', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_a' },
        { type: 'add_clip', assetId: 'asset_i' },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      { type: 'set_volume', clipId: 'clip_1', volume: 0.3, muted: false, fadeIn: 1, fadeOut: 2 },
      ctx,
    );
    expect(clip<AudioClip>(r.project, 'clip_1')).toMatchObject({
      volume: 0.3,
      fadeIn: 1,
      fadeOut: 2,
    });
    expect(r.summary).toBe('Clip clip_1: volume 0.3, unmuted, fade in 1s, fade out 2s.');
    expect(
      applyOperation(p, { type: 'set_volume', clipId: 'clip_1', muted: true }, ctx).summary,
    ).toMatch(/muted/);
    expect(
      applyOperation(p, { type: 'set_volume', clipId: 'clip_2', fadeIn: 1 }, ctx).summary,
    ).toMatch(/fade in/);
    expect(applyOperation(p, { type: 'set_volume', clipId: 'clip_1' }, ctx).summary).toMatch(
      /unchanged/,
    );
    const t = applyOperation(
      p,
      { type: 'set_volume', trackId: 'track_2', volume: 0.5, muted: true },
      ctx,
    );
    expect(t.project.tracks[1]).toMatchObject({ volume: 0.5, muted: true });
    expect(t.summary).toMatch(/\(muted\)/);
    expect(applyOperation(p, { type: 'set_volume', trackId: 'track_2' }, ctx).summary).toBe(
      'Track A1: volume 1.',
    );
    expectError(
      () => applyOperation(p, { type: 'set_volume', trackId: 'track_2', fadeIn: 1 }, ctx),
      'INVALID_ARGUMENT',
    );
    expectError(
      () => applyOperation(p, { type: 'set_volume', clipId: 'clip_2', volume: 1 }, ctx),
      'INVALID_ARGUMENT',
    );
    expectError(
      () => applyOperation(p, { type: 'set_volume', volume: 1 }, ctx),
      'INVALID_OPERATION',
    );
  });
});
