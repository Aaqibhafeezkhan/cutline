import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  applyJsonPatch,
  applyOperation,
  approxEqual,
  assertValid,
  createHistory,
  createProject,
  defaultContext,
  describeHistory,
  ease,
  evaluateKeyframes,
  findAsset,
  findProblems,
  findTrack,
  formatRange,
  fromPointer,
  getSchemaVersion,
  invertRanges,
  isCutlineError,
  mergeRanges,
  migrateProject,
  MIGRATIONS,
  randomId,
  recordHistory,
  redo,
  roundTime,
  round3,
  sequentialContext,
  sliceKeyframes,
  sliceAllKeyframes,
  sliceWords,
  toPointer,
  undo,
  animatedValue,
  type HistoryEntry,
  type Project,
} from '../src';
import { baseProject, run } from './helpers';

describe('time and ids', () => {
  it('rounds and formats', () => {
    expect(roundTime(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(roundTime(-0.0000001), 0)).toBe(true);
    expect(approxEqual(1, 1 + 1e-7)).toBe(true);
    expect(formatRange(1.23456, 2)).toBe('1.235s–2s');
    expect(round3(1.23456)).toBe(1.235);
  });

  it('generates ids', () => {
    expect(randomId('clip')).toMatch(/^clip_[0-9a-z]{8}$/);
    expect(defaultContext.newId('asset')).toMatch(/^asset_/);
    expect(new Date(defaultContext.now()).getTime()).not.toBeNaN();
    const ctx = sequentialContext();
    expect([ctx.newId('clip'), ctx.newId('clip'), ctx.newId('track')]).toEqual([
      'clip_1',
      'clip_2',
      'track_1',
    ]);
    expect(ctx.now()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('serializes errors', () => {
    const e = new CutlineError('NOT_FOUND', 'Missing.', {
      hint: 'Look again.',
      details: { id: 1 },
    });
    expect(e.toJSON()).toEqual({
      code: 'NOT_FOUND',
      message: 'Missing.',
      hint: 'Look again.',
      details: { id: 1 },
    });
    expect(e.describe()).toBe('Missing. Hint: Look again.');
    const bare = new CutlineError('INVARIANT', 'Broken.');
    expect(bare.toJSON()).toEqual({ code: 'INVARIANT', message: 'Broken.' });
    expect(bare.describe()).toBe('Broken.');
    expect(isCutlineError(bare)).toBe(true);
    expect(isCutlineError(new Error('x'))).toBe(false);
  });

  it('merges and inverts ranges', () => {
    expect(
      mergeRanges([
        { start: 3, end: 4 },
        { start: 0, end: 1 },
        { start: 0.5, end: 2 },
      ]),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
    expect(
      invertRanges(
        [
          { start: 1, end: 2 },
          { start: 3, end: 12 },
        ],
        0,
        10,
      ),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
    expect(
      invertRanges(
        [
          { start: -2, end: -1 },
          { start: 0, end: 1 },
        ],
        0,
        5,
      ),
    ).toEqual([{ start: 1, end: 5 }]);
    expect(invertRanges([], 0, 1)).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('keyframes', () => {
  const kf = [
    { time: 0, value: 0, easing: 'linear' as const },
    { time: 2, value: 10, easing: 'hold' as const },
    { time: 4, value: 20, easing: 'linear' as const },
  ];

  it('eases', () => {
    expect(ease('easeIn', 0.5)).toBe(0.25);
    expect(ease('easeOut', 0.5)).toBe(0.75);
    expect(ease('easeInOut', 0.25)).toBe(0.125);
    expect(ease('easeInOut', 0.75)).toBe(0.875);
    expect(ease('hold', 0.9)).toBe(0);
  });

  it('evaluates', () => {
    expect(evaluateKeyframes(kf, -1)).toBe(0);
    expect(evaluateKeyframes(kf, 1)).toBe(5);
    expect(evaluateKeyframes(kf, 3)).toBe(10);
    expect(evaluateKeyframes(kf, 9)).toBe(20);
    expect(
      evaluateKeyframes(
        [
          { time: 1, value: 1, easing: 'linear' },
          { time: 1, value: 5, easing: 'linear' },
        ],
        1.5,
      ),
    ).toBe(5);
    expect(() => evaluateKeyframes([], 0)).toThrow(RangeError);
    expect(animatedValue(undefined, 'x', 7, 0)).toBe(7);
    expect(animatedValue({ x: [] }, 'x', 7, 0)).toBe(7);
    expect(animatedValue({ x: kf }, 'x', 7, 1)).toBe(5);
  });

  it('slices with boundary keyframes', () => {
    expect(sliceKeyframes([], 0, 1)).toEqual([]);
    expect(sliceKeyframes(kf, 1, 3)).toEqual([
      { time: 0, value: 5, easing: 'linear' },
      { time: 1, value: 10, easing: 'hold' },
      { time: 2, value: 10, easing: 'linear' },
    ]);
    expect(sliceKeyframes(kf, -1, 5).map((k) => k.time)).toEqual([1, 3, 5]);
    // boundary coinciding with an existing keyframe is deduplicated
    expect(sliceKeyframes(kf, 2, 4).map((k) => k.time)).toEqual([0, 2]);
    expect(sliceAllKeyframes(undefined, 0, 1)).toBeUndefined();
    expect(sliceAllKeyframes({ x: [] }, 0, 1)).toBeUndefined();
    expect(sliceAllKeyframes({ x: kf }, 0, 1)?.x).toHaveLength(2);
  });

  it('slices words', () => {
    const words = [
      { text: 'a', start: 0, end: 1 },
      { text: 'b', start: 1, end: 2 },
      { text: 'c', start: 2, end: 3 },
    ];
    expect(sliceWords(undefined, 0, 1)).toBeUndefined();
    expect(sliceWords(words, 1.5, 3)).toEqual([
      { text: 'b', start: 0, end: 0.5 },
      { text: 'c', start: 0.5, end: 1.5 },
    ]);
  });
});

describe('JSON patch', () => {
  it('round-trips pointers with escaping', () => {
    expect(toPointer(['a/b', 'c~d', 0])).toBe('/a~1b/c~0d/0');
    expect(fromPointer('/a~1b/c~0d/0')).toEqual(['a/b', 'c~d', 0]);
    expect(fromPointer('')).toEqual([]);
    expect(() => fromPointer('x')).toThrow(/Invalid JSON pointer/);
  });

  it('applies forward and inverse patches', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(project, { type: 'add_clip', assetId: 'asset_v' }, ctx);
    expect(r.patches.every((p) => p.path.startsWith('/'))).toBe(true);
    expect(applyJsonPatch(project, r.patches)).toEqual(r.project);
    expect(applyJsonPatch(r.project, r.inversePatches)).toEqual(project);
    expect(applyJsonPatch(project, [])).toBe(project);
    const withT = applyOperation(
      r.project,
      { type: 'set_transition', clipId: 'clip_1', transition: { type: 'crossfade', duration: 1 } },
      ctx,
    );
    const removal = applyOperation(
      withT.project,
      { type: 'set_transition', clipId: 'clip_1', transition: null },
      ctx,
    );
    expect(removal.patches.some((p) => p.op === 'remove' && !('value' in p))).toBe(true);
    expect(applyJsonPatch(withT.project, removal.patches)).toEqual(removal.project);
  });
});

describe('history', () => {
  const entry = (
    label: string,
    project: Project,
    next: Project,
    patches: ReturnType<typeof applyOperation>,
  ): HistoryEntry => {
    void project;
    void next;
    return {
      id: label,
      label,
      origin: { kind: 'agent', name: 'Claude' },
      at: 'now',
      affectedIds: patches.affectedIds,
      patches: patches.patches,
      inversePatches: patches.inversePatches,
    };
  };

  it('undoes and redoes', () => {
    const { project, ctx } = baseProject();
    let h = createHistory(2);
    expect(describeHistory(h)).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    });
    expect(() => undo(project, h)).toThrow(/nothing to undo/);
    expect(() => redo(project, h)).toThrow(/nothing to redo/);

    const r1 = applyOperation(project, { type: 'add_clip', assetId: 'asset_v' }, ctx);
    h = recordHistory(h, entry('one', project, r1.project, r1));
    const r2 = applyOperation(r1.project, { type: 'add_clip', assetId: 'asset_a' }, ctx);
    h = recordHistory(h, entry('two', r1.project, r2.project, r2));
    const r3 = applyOperation(r2.project, { type: 'add_clip', assetId: 'asset_i' }, ctx);
    h = recordHistory(h, entry('three', r2.project, r3.project, r3));
    expect(h.past.map((e) => e.label)).toEqual(['two', 'three']);

    const u = undo(r3.project, h);
    expect(u.project).toEqual(r2.project);
    expect(u.patches).toBe(r3.inversePatches);
    expect(describeHistory(u.history)).toMatchObject({
      canUndo: true,
      canRedo: true,
      undoLabel: 'two',
      redoLabel: 'three',
    });
    const rd = redo(u.project, u.history);
    expect(rd.project).toEqual(r3.project);
    expect(rd.history.future).toHaveLength(0);
  });
});

describe('migrations', () => {
  it('migrates v0 millisecond documents', () => {
    const v0 = {
      id: 'p',
      name: 'Old',
      createdAt: 'x',
      updatedAt: 'x',
      assets: [
        {
          id: 'a',
          name: 'a',
          kind: 'video',
          src: 'a',
          mimeType: 'video/mp4',
          durationMs: 5000,
          hasVideo: true,
          hasAudio: false,
          createdAt: 'x',
        },
      ],
      tracks: [
        {
          id: 't',
          kind: 'video',
          name: 'V1',
          clips: [
            {
              type: 'video',
              id: 'c',
              assetId: 'a',
              startMs: 1000,
              durationMs: 2000,
              sourceStartMs: 500,
            },
          ],
        },
        { id: 't2', kind: 'audio', name: 'A1' },
      ],
    };
    const p = migrateProject(v0);
    expect(p.schemaVersion).toBe(1);
    expect(p.tracks[0]!.clips[0]).toMatchObject({ start: 1, duration: 2, sourceStart: 0.5 });
    expect(p.assets[0]!.duration).toBe(5);
  });

  it('skips junk entries while migrating', () => {
    const out = MIGRATIONS[0]!.migrate({ assets: ['junk'], tracks: ['junk', { clips: [7] }] });
    expect(out).toEqual({ assets: ['junk'], tracks: ['junk', { clips: [7] }], schemaVersion: 1 });
  });

  it('handles odd inputs', () => {
    expect(() => migrateProject('x')).toThrow(/must be a JSON object/);
    expect(() => migrateProject({ schemaVersion: 99 })).toThrow(/newer/);
    expect(() => migrateProject({ schemaVersion: -1 })).toThrow(/Invalid schemaVersion/);
    expect(() => migrateProject({ schemaVersion: 0 }, [])).toThrow(/No migration/);
    expect(getSchemaVersion({})).toBe(0);
    const current = createProject({ name: 'Now' });
    expect(migrateProject(current)).toEqual(current);
    // v0 without tracks/assets arrays
    expect(() =>
      migrateProject({ id: 'p', name: 'x', createdAt: 'x', updatedAt: 'x' }),
    ).not.toThrow();
  });
});

describe('validation and queries', () => {
  it('detects broken invariants', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_a', start: 0, duration: 2 },
        { type: 'add_clip', assetId: 'asset_i', start: 4, duration: 2 },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'x' }] },
      ],
      ctx,
    ).project;
    expect(findProblems(p)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(p)) as Project;
    const [v, a] = broken.tracks;
    v!.clips.push({ ...v!.clips[0]!, id: 'dup' });
    v!.clips.push({ ...v!.clips[0]! });
    v!.clips.push({ ...a!.clips[0]!, id: 'wrongtype' });
    v!.captionStyle = broken.tracks[2]!.captionStyle;
    a!.clips[0] = { ...a!.clips[0]!, assetId: 'ghost' } as never;
    a!.clips.push({
      ...(p.tracks[1]!.clips[0] as object),
      id: 'noaudio',
      start: 5,
      assetId: 'asset_i',
    } as never);
    broken.assets[0] = { ...broken.assets[0]!, duration: 1, hasVideo: false };
    broken.assets.push({ ...broken.assets[2]!, id: 'asset_nodur', kind: 'video', duration: null });
    v!.clips.push({ ...v!.clips[0]!, id: 'nodur', start: 50, assetId: 'asset_nodur' } as never);
    v!.clips.push({
      type: 'image',
      id: 'imgvid',
      start: 60,
      duration: 1,
      assetId: 'asset_v',
    } as never);
    broken.assets.push({ ...broken.assets[1]!, id: 'asset_mute', hasAudio: false });
    a!.clips.push({
      ...(p.tracks[1]!.clips[0] as object),
      id: 'mute',
      start: 70,
      assetId: 'asset_mute',
    } as never);
    v!.clips[0]!.start = -1;
    const problems = findProblems(broken).join('\n');
    expect(problems).toMatch(/schema: tracks.0.clips.0.start/);
    expect(problems).toMatch(/duplicate id clip_1/);
    expect(problems).toMatch(/overlaps or is out of order/);
    expect(problems).toMatch(/audio clips are not allowed on video tracks/);
    expect(problems).toMatch(/captionStyle is only allowed/);
    expect(problems).toMatch(/unknown asset ghost/);
    expect(problems).toMatch(/exceeds asset duration/);
    expect(problems).toMatch(/has no video/);
    expect(problems).toMatch(/asset_nodur has no duration/);
    expect(problems).toMatch(/image clips need an image asset/);
    expect(problems).toMatch(/asset_mute has no audio/);
    expect(() => assertValid(broken)).toThrow(CutlineError);
  });

  it('finds things with helpful errors', () => {
    const { project } = baseProject();
    expect(findTrack(project, 'track_1').name).toBe('V1');
    expect(() => findTrack(project, 'x')).toThrow(/Track "x" not found/);
    expect(findAsset(project, 'asset_v').name).toBe('interview.mp4');
    try {
      findAsset(project, 'x');
    } catch (e) {
      expect((e as CutlineError).hint).toMatch(/asset_v \(interview.mp4\)/);
    }
    const many = {
      ...project,
      assets: Array.from({ length: 15 }, (_, i) => ({ ...project.assets[0]!, id: `a${i}` })),
    };
    try {
      findAsset(many, 'x');
    } catch (e) {
      expect((e as CutlineError).hint).toMatch(/15 total/);
    }
    const none = { ...project, assets: [] };
    try {
      findAsset(none, 'x');
    } catch (e) {
      expect((e as CutlineError).hint).toMatch(/\(none\)/);
    }
  });
});
