import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  applyOperation,
  applyOperations,
  parseOperation,
  type CaptionClip,
} from '../src';
import { baseProject, clip, run, spans, videoAsset } from './helpers';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as CutlineError).code;
  }
  return 'NO_ERROR';
}

describe('project and assets', () => {
  it('updates name and settings', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'update_project', name: 'Final', settings: { width: 1280, height: 720 } },
      ctx,
    );
    expect(r.project.name).toBe('Final');
    expect(r.project.settings).toMatchObject({ width: 1280, height: 720, fps: 30 });
    expect(r.summary).toBe('Project renamed to "Final", settings 1280×720 @ 30 fps.');
    expect(applyOperation(project, { type: 'update_project' }, ctx).summary).toBe(
      'Project unchanged.',
    );
  });

  it('adds assets with generated ids and rejects duplicates', () => {
    const { project, ctx } = baseProject();
    const asset = { ...videoAsset(), id: undefined, name: 'b.mp4' };
    const r = applyOperation(project, { type: 'add_asset', asset }, ctx);
    expect(r.project.assets[3]).toMatchObject({
      id: 'asset_1',
      name: 'b.mp4',
      createdAt: ctx.now(),
    });
    expect(r.summary).toBe('Added video asset "b.mp4" (asset_1, 20s).');
    expect(
      applyOperation(
        project,
        { type: 'add_asset', asset: { ...asset, id: 'img', kind: 'image', duration: null } },
        ctx,
      ).summary,
    ).toMatch(/still image/);
    expect(
      code(() => applyOperation(project, { type: 'add_asset', asset: videoAsset() }, ctx)),
    ).toBe('INVALID_ARGUMENT');
  });

  it('removes assets only when unused unless removeClips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v' },
        { type: 'add_text', text: 'x', start: 0 },
      ],
      ctx,
    ).project;
    expect(code(() => applyOperation(p, { type: 'remove_asset', assetId: 'asset_v' }, ctx))).toBe(
      'IN_USE',
    );
    const r = applyOperation(
      p,
      { type: 'remove_asset', assetId: 'asset_v', removeClips: true },
      ctx,
    );
    expect(r.project.assets.map((a) => a.id)).toEqual(['asset_a', 'asset_i']);
    expect(r.project.tracks[0]!.clips).toHaveLength(0);
    expect(r.removedIds).toEqual(['asset_v', 'clip_1']);
    expect(applyOperation(p, { type: 'remove_asset', assetId: 'asset_a' }, ctx).summary).toBe(
      'Removed asset "music.wav".',
    );
    const locked = run(
      p,
      [{ type: 'update_track', trackId: 'track_1', locked: true }],
      ctx,
    ).project;
    expect(
      code(() =>
        applyOperation(
          locked,
          { type: 'remove_asset', assetId: 'asset_v', removeClips: true },
          ctx,
        ),
      ),
    ).toBe('LOCKED');
  });
});

describe('tracks', () => {
  it('adds tracks at positions with unique names', () => {
    const { project, ctx } = baseProject();
    const r = run(
      project,
      [
        { type: 'add_track', kind: 'video', index: 0 },
        { type: 'add_track', kind: 'caption', name: 'Subs', id: 'subs' },
      ],
      ctx,
    );
    expect(r.project.tracks.map((t) => t.name)).toEqual(['V2', 'V1', 'A1', 'Subs']);
    expect(r.project.tracks[3]!.captionStyle).toMatchObject({ position: 'bottom' });
    expect(
      code(() => applyOperation(r.project, { type: 'add_track', kind: 'audio', id: 'subs' }, ctx)),
    ).toBe('INVALID_ARGUMENT');
  });

  it('updates, moves and removes tracks', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      {
        type: 'update_track',
        trackId: 'track_1',
        name: 'Main',
        muted: true,
        hidden: true,
        locked: false,
        volume: 2,
      },
      ctx,
    );
    expect(r.project.tracks[0]).toMatchObject({
      name: 'Main',
      muted: true,
      hidden: true,
      volume: 2,
    });
    expect(r.summary).toBe(
      'Updated track Main: name=Main, muted=true, hidden=true, locked=false, volume=2.',
    );
    expect(
      applyOperation(project, { type: 'update_track', trackId: 'track_1' }, ctx).summary,
    ).toMatch(/no changes/);
    expect(
      code(() =>
        applyOperation(
          project,
          { type: 'update_track', trackId: 'track_1', captionStyle: { fontSize: 10 } },
          ctx,
        ),
      ),
    ).toBe('INVALID_ARGUMENT');

    const moved = applyOperation(
      project,
      { type: 'move_track', trackId: 'track_1', index: 5 },
      ctx,
    );
    expect(moved.project.tracks.map((t) => t.id)).toEqual(['track_2', 'track_1']);
    expect(moved.summary).toMatch(/position 1/);

    const withClip = run(project, [{ type: 'add_clip', assetId: 'asset_v' }], ctx).project;
    const removed = applyOperation(withClip, { type: 'remove_track', trackId: 'track_1' }, ctx);
    expect(removed.removedIds).toEqual(['track_1', 'clip_1']);
    const locked = run(
      project,
      [{ type: 'update_track', trackId: 'track_1', locked: true }],
      ctx,
    ).project;
    expect(
      code(() => applyOperation(locked, { type: 'remove_track', trackId: 'track_1' }, ctx)),
    ).toBe('LOCKED');
    expect(
      code(() => applyOperation(project, { type: 'remove_track', trackId: 'nope' }, ctx)),
    ).toBe('NOT_FOUND');
  });
});

describe('add_text', () => {
  it('puts text on a text-only track on top, creating one if needed', () => {
    const { project, ctx } = baseProject();
    const p = run(project, [{ type: 'add_clip', assetId: 'asset_v' }], ctx).project;
    const r = applyOperation(
      p,
      {
        type: 'add_text',
        text: 'A very long title that will be shortened in the summary',
        start: 1,
        style: { fontSize: 40 },
        transform: { y: 300 },
      },
      ctx,
    );
    expect(r.project.tracks).toHaveLength(3);
    expect(r.project.tracks[2]!.clips[0]).toMatchObject({
      type: 'text',
      start: 1,
      duration: 3,
      style: { fontSize: 40 },
      transform: { y: 300 },
    });
    expect(r.summary).toMatch(/…/);
    const r2 = applyOperation(
      r.project,
      { type: 'add_text', text: 'Second', start: 5, duration: 1 },
      ctx,
    );
    expect(r2.project.tracks).toHaveLength(3);
    expect(spans(r2.project, 2).map((s) => s[1])).toEqual([1, 5]);
  });

  it('honours an explicit track', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'add_text', text: 'x', start: 0, trackId: 'track_1' },
      ctx,
    );
    expect(r.project.tracks[0]!.clips[0]!.type).toBe('text');
    expect(
      code(() =>
        applyOperation(project, { type: 'add_text', text: 'x', start: 0, trackId: 'track_2' }, ctx),
      ),
    ).toBe('INVALID_ARGUMENT');
  });
});

describe('add_captions', () => {
  it('creates a caption track, sorts and de-overlaps cues, stores relative words', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      {
        type: 'add_captions',
        cues: [
          { start: 3, end: 5, text: 'second' },
          { start: 0, end: 3.5, text: 'first', words: [{ text: 'first', start: 0.5, end: 3.4 }] },
          { start: 5, end: 5.0005, text: 'tiny' },
        ],
        style: { fontSize: 30 },
      },
      ctx,
    );
    const track = r.project.tracks[2]!;
    expect(track).toMatchObject({
      kind: 'caption',
      name: 'C1',
      captionStyle: { fontSize: 30, position: 'bottom' },
    });
    expect(spans(r.project, 2).map((s) => [s[1], s[2]])).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect((track.clips[0] as CaptionClip).words).toEqual([{ text: 'first', start: 0.5, end: 3 }]);
    expect(r.summary).toBe('Added 2 caption(s) on track C1 spanning 0s–5s.');

    const replaced = applyOperation(
      r.project,
      { type: 'add_captions', cues: [{ start: 1, end: 2, text: 'only' }] },
      ctx,
    );
    expect(replaced.project.tracks[2]!.clips.map((c) => (c as CaptionClip).text)).toEqual(['only']);
    expect(replaced.removedIds).toHaveLength(2);

    const appended = applyOperation(
      r.project,
      {
        type: 'add_captions',
        cues: [{ start: 4, end: 6, text: 'more' }],
        replace: false,
        trackId: track.id,
      },
      ctx,
    );
    expect(spans(appended.project, 2).map((s) => [s[1], s[2]])).toEqual([
      [0, 3],
      [3, 4],
      [4, 6],
    ]);
  });

  it('reports empty results and rejects non-caption tracks', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'add_captions', cues: [{ start: 1, end: 1.0001, text: 'x' }] },
      ctx,
    );
    expect(r.summary).toBe('Added 0 caption(s) on track C1.');
    expect(
      code(() =>
        applyOperation(
          project,
          { type: 'add_captions', trackId: 'track_1', cues: [{ start: 0, end: 1, text: 'x' }] },
          ctx,
        ),
      ),
    ).toBe('INVALID_ARGUMENT');
    const locked = run(
      r.project,
      [{ type: 'update_track', trackId: r.project.tracks[2]!.id, locked: true }],
      ctx,
    ).project;
    const r2 = applyOperation(
      locked,
      { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'x' }] },
      ctx,
    );
    expect(r2.project.tracks.filter((t) => t.kind === 'caption')).toHaveLength(2);
  });
});

describe('apply / parse', () => {
  it('is atomic: a failing op leaves the project untouched', () => {
    const { project, ctx } = baseProject();
    expect(() =>
      applyOperations(
        project,
        [
          { type: 'add_clip', assetId: 'asset_v' },
          { type: 'split_clip', clipId: 'nope', time: 1 },
        ],
        ctx,
      ),
    ).toThrow(CutlineError);
    expect(project.tracks[0]!.clips).toHaveLength(0);
    expect(code(() => applyOperations(project, [], ctx))).toBe('INVALID_ARGUMENT');
  });

  it('reports created/affected/removed ids across a batch', () => {
    const { project, ctx } = baseProject();
    const r = applyOperations(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 4 },
        { type: 'split_clip', clipId: 'clip_1', time: 2 },
        { type: 'delete_clips', clipIds: ['clip_2'] },
      ],
      ctx,
    );
    expect(r.createdIds).toEqual(['clip_1']);
    expect(r.removedIds).toEqual(['clip_2']);
    expect(r.affectedIds).toEqual(['clip_1']);
    expect(r.operations).toHaveLength(3);
  });

  it('gives actionable parse errors', () => {
    const err = (() => {
      try {
        parseOperation({ type: 'split_clip', clipId: 'c' });
      } catch (e) {
        return e as CutlineError;
      }
      throw new Error('expected error');
    })();
    expect(err.code).toBe('INVALID_OPERATION');
    expect(err.message).toMatch(/Invalid operation split_clip/);
    expect(err.message).toMatch(/time/);
    expect(err.hint).toMatch(/Valid operation types: update_project/);
    expect(() => parseOperation(null)).toThrow(/missing type/);
    expect(code(() => parseOperation({ type: 'trim_clip', clipId: 'c' }))).toBe(
      'INVALID_OPERATION',
    );
    expect(
      code(() => parseOperation({ type: 'delete_range', ranges: [{ start: 2, end: 1 }] })),
    ).toBe('INVALID_OPERATION');
    expect(
      code(() => parseOperation({ type: 'add_captions', cues: [{ start: 2, end: 1, text: 'x' }] })),
    ).toBe('INVALID_OPERATION');
  });

  it('works with caption clip lookups', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'add_captions', cues: [{ start: 0, end: 2, text: 'hello world' }] },
      ctx,
    );
    const id = r.project.tracks[2]!.clips[0]!.id;
    const split = applyOperation(r.project, { type: 'split_clip', clipId: id, time: 1 }, ctx);
    expect(clip<CaptionClip>(split.project, id).text).toBe('hello world');
  });
});
