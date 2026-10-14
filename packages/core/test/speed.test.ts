import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  REVERSE_NUDGE,
  applyOperation,
  assertSourceRange,
  clipSpeed,
  describeChanges,
  diffProjects,
  findProblems,
  formatChange,
  isFreeze,
  isReversed,
  mapSourceRangeToTimeline,
  mapWordsToTimeline,
  resolveAudioSegments,
  resolveFrame,
  segmentSourceTime,
  segmentTimelineTime,
  sourceRangeToLocal,
  sourceSpan,
  sourceTimeAt,
  summarizeProject,
  type Project,
  type VideoClip,
} from '../src';
import { baseProject, clip, run, spans } from './helpers';

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

/** V1: clip_1 (0–10 s, source 0–10) and clip_2 (10–15 s), A1: clip_3 music, plus text clip_4. */
function setup() {
  const { project, ctx } = baseProject();
  const r = run(
    project,
    [
      { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', start: 0, duration: 10 },
      {
        type: 'add_clip',
        assetId: 'asset_v',
        trackId: 'track_1',
        start: 10,
        sourceStart: 12,
        duration: 5,
      },
      { type: 'add_clip', assetId: 'asset_a', start: 0, duration: 10 },
      { type: 'add_text', text: 'Hi', start: 0 },
    ],
    ctx,
  );
  return { p: r.project, ctx };
}

const sourceAt = (p: Project, t: number, id: string) =>
  resolveFrame(p, t).layers.find((l) => l.clipId === id)?.sourceTime;

describe('clip speed helpers', () => {
  it('derive speed, direction and source spans', () => {
    const { p, ctx } = setup();
    const text = clip(p, 'clip_4');
    expect(clipSpeed(text)).toBe(1);
    expect(isReversed(text)).toBe(false);
    expect(sourceSpan(text)).toBe(text.duration);

    const sped = run(p, [{ type: 'set_speed', clipId: 'clip_1', speed: 2, reverse: true }], ctx);
    const c = clip<VideoClip>(sped.project, 'clip_1');
    expect(clipSpeed(c)).toBe(2);
    expect(isReversed(c)).toBe(true);
    expect(sourceSpan(c)).toBe(10);
    expect(sourceTimeAt(c, 0)).toBe(10);
    expect(sourceTimeAt(c, 5)).toBe(0);
    expect(sourceRangeToLocal(c, 2, 4)).toEqual([3, 4]);
    expect(sourceRangeToLocal(c, 15, 18)).toBeUndefined();

    const fwd = { ...c, reverse: false };
    expect(sourceTimeAt(fwd, 1)).toBe(2);
    expect(sourceRangeToLocal(fwd, 2, 4)).toEqual([1, 2]);

    const frozen = { ...c, freeze: true };
    expect(isFreeze(frozen)).toBe(true);
    expect(clipSpeed(frozen)).toBe(0);
    expect(isReversed(frozen)).toBe(false);
    expect(sourceSpan(frozen)).toBe(0);
    expect(sourceTimeAt(frozen, 3)).toBe(0);
    expect(sourceRangeToLocal(frozen, 0, 5)).toBeUndefined();
  });

  it('reports source range problems in timeline terms', () => {
    const { p } = setup();
    const c = clip<VideoClip>(p, 'clip_1');
    const asset = p.assets[0]!;
    const frozen = { ...c, freeze: true };
    const e = expectError(
      () => assertSourceRange(frozen, asset, -1, 0),
      'OUT_OF_RANGE',
      /cannot start before/,
    );
    expect(e.hint).toMatch(/Extend the start by at most 0s/);
    const e2 = expectError(() => assertSourceRange(c, asset, 5, 30, 2), 'OUT_OF_RANGE');
    expect(e2.hint).toMatch(/at most 7.5s at speed 2/);
  });
});

describe('set_speed', () => {
  it('changes the duration and keeps the source window', () => {
    const { p, ctx } = setup();
    const r = applyOperation(p, { type: 'set_speed', clipId: 'clip_1', speed: 2 }, ctx);
    const c = clip<VideoClip>(r.project, 'clip_1');
    expect(c).toMatchObject({ duration: 5, sourceStart: 0, speed: 2 });
    expect(r.summary).toMatch(/speed 2×, forward, now 0s–5s/);
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 5],
      ['clip_2', 10, 15],
    ]);

    // Back to normal speed removes the field.
    const back = applyOperation(r.project, { type: 'set_speed', clipId: 'clip_1', speed: 1 }, ctx);
    expect(clip<VideoClip>(back.project, 'clip_1').speed).toBeUndefined();
    expect(clip(back.project, 'clip_1').duration).toBe(10);
  });

  it('refuses to grow into a neighbor unless rippling', () => {
    const { p, ctx } = setup();
    const e = expectError(
      () => applyOperation(p, { type: 'set_speed', clipId: 'clip_1', speed: 0.5 }, ctx),
      'OVERLAP',
      /overlap clip_2/,
    );
    expect(e.hint).toMatch(/ripple: true/);
    const r = applyOperation(
      p,
      { type: 'set_speed', clipId: 'clip_1', speed: 0.5, ripple: true },
      ctx,
    );
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 20],
      ['clip_2', 20, 25],
    ]);
    expect(r.summary).toMatch(/\(ripple\)/);
    expect(r.affectedIds).toEqual(['clip_1', 'clip_2']);
    const faster = applyOperation(
      p,
      { type: 'set_speed', clipId: 'clip_1', speed: 4, ripple: true },
      ctx,
    );
    expect(spans(faster.project, 0)).toEqual([
      ['clip_1', 0, 2.5],
      ['clip_2', 2.5, 7.5],
    ]);
  });

  it('keeps the duration on request when the asset has enough material', () => {
    const { p, ctx } = setup();
    const r = applyOperation(
      p,
      { type: 'set_speed', clipId: 'clip_1', speed: 2, keepDuration: true },
      ctx,
    );
    expect(clip<VideoClip>(r.project, 'clip_1')).toMatchObject({ duration: 10, speed: 2 });
    expect(sourceAt(r.project, 9, 'clip_1')).toBe(18);
    const e = expectError(
      () =>
        applyOperation(
          p,
          { type: 'set_speed', clipId: 'clip_1', speed: 4, keepDuration: true },
          ctx,
        ),
      'OUT_OF_RANGE',
      /only 20s long/,
    );
    expect(e.hint).toMatch(/at most 5s at speed 4/);
  });

  it('reverses and un-reverses clips', () => {
    const { p, ctx } = setup();
    const r = applyOperation(p, { type: 'set_speed', clipId: 'clip_3', reverse: true }, ctx);
    expect(clip(r.project, 'clip_3')).toMatchObject({ reverse: true, duration: 10 });
    expect(r.summary).toMatch(/speed 1×, reversed/);
    const f = applyOperation(
      r.project,
      { type: 'set_speed', clipId: 'clip_3', reverse: false },
      ctx,
    );
    expect('reverse' in clip(f.project, 'clip_3')).toBe(false);
  });

  it('scales keyframes with the duration', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        {
          type: 'set_clip_props',
          clipId: 'clip_1',
          props: {
            keyframes: {
              opacity: [
                { time: 0, value: 0 },
                { time: 10, value: 1 },
              ],
            },
          },
        },
        { type: 'set_speed', clipId: 'clip_1', speed: 2 },
      ],
      ctx,
    );
    expect(clip<VideoClip>(r.project, 'clip_1').keyframes!.opacity!.map((k) => k.time)).toEqual([
      0, 5,
    ]);
  });

  it('rejects clips without source timing and invalid calls', () => {
    const { p, ctx } = setup();
    const e = expectError(
      () => applyOperation(p, { type: 'set_speed', clipId: 'clip_4', speed: 2 }, ctx),
      'INVALID_ARGUMENT',
      /only apply to video and audio clips, not text/,
    );
    expect(e.hint).toMatch(/trim_clip/);
    const img = run(
      p,
      [{ type: 'add_clip', assetId: 'asset_i', start: 30, id: 'img' }],
      ctx,
    ).project;
    expectError(
      () => applyOperation(img, { type: 'set_speed', clipId: 'img', speed: 2 }, ctx),
      'INVALID_ARGUMENT',
      /not image/,
    );
    expectError(
      () => applyOperation(p, { type: 'set_speed', clipId: 'clip_1' }, ctx),
      'INVALID_OPERATION',
      /speed and\/or reverse/,
    );
    expectError(
      () => applyOperation(p, { type: 'set_speed', clipId: 'clip_1', speed: 20 }, ctx),
      'INVALID_OPERATION',
    );
    const frozen = applyOperation(p, { type: 'freeze_frame', clipId: 'clip_1', time: 2 }, ctx);
    expectError(
      () => applyOperation(frozen.project, { type: 'set_speed', clipId: 'clip_5', speed: 2 }, ctx),
      'INVALID_ARGUMENT',
      /freeze frame/,
    );
  });
});

describe('set_clip_props speed / reverse', () => {
  it('applies to video and audio, not to images', () => {
    const { p, ctx } = setup();
    const r = applyOperation(
      p,
      { type: 'set_clip_props', clipId: 'clip_3', props: { speed: 2, reverse: true } },
      ctx,
    );
    expect(clip(r.project, 'clip_3')).toMatchObject({ speed: 2, reverse: true, duration: 5 });
    const img = run(
      p,
      [{ type: 'add_clip', assetId: 'asset_i', start: 30, id: 'img' }],
      ctx,
    ).project;
    const e = expectError(
      () =>
        applyOperation(img, { type: 'set_clip_props', clipId: 'img', props: { speed: 2 } }, ctx),
      'INVALID_ARGUMENT',
      /"speed" does not apply to image/,
    );
    expect(e.hint).toMatch(/Settable on image clips/);
    // add_clip can set the speed right away.
    const added = applyOperation(
      p,
      {
        type: 'add_clip',
        assetId: 'asset_v',
        start: 40,
        duration: 4,
        props: { speed: 0.5 },
        id: 'slow',
      },
      ctx,
    );
    expect(clip(added.project, 'slow')).toMatchObject({ duration: 8, speed: 0.5 });
  });
});

describe('split and trim with speed', () => {
  it('splits reversed clips from the end of the source window', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', reverse: true },
        { type: 'split_clip', clipId: 'clip_1', time: 4 },
      ],
      ctx,
    );
    expect(clip(r.project, 'clip_1')).toMatchObject({ sourceStart: 6, duration: 4 });
    expect(clip(r.project, 'clip_5')).toMatchObject({ sourceStart: 0, duration: 6, start: 4 });
    // The picture does not jump at the cut.
    expect(sourceAt(r.project, 3.9, 'clip_1')).toBeCloseTo(6.1, 3);
    expect(sourceAt(r.project, 4.1, 'clip_5')).toBeCloseTo(5.9, 3);
  });

  it('splits sped-up clips in source time', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2 },
        { type: 'split_clip', clipId: 'clip_1', time: 2 },
      ],
      ctx,
    );
    expect(clip(r.project, 'clip_5')).toMatchObject({ sourceStart: 4, duration: 3 });
  });

  it('keeps speed, reverse and freeze frames in assembled reels', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2, reverse: true },
        { type: 'freeze_frame', clipId: 'clip_2', time: 11, duration: 1, newClipId: 'hold' },
        {
          type: 'assemble_ranges',
          ranges: [
            { start: 1, end: 3 },
            { start: 11, end: 12 },
          ],
          mode: 'replace',
        },
      ],
      ctx,
    ).project;
    const clips = r.tracks[0]!.clips as VideoClip[];
    // clip_1 (0–5, source 0–10 reversed at 2×): timeline 1–3 is source 4–8.
    expect(clips[0]).toMatchObject({
      start: 0,
      duration: 2,
      speed: 2,
      reverse: true,
      sourceStart: 4,
    });
    expect(clips[1]).toMatchObject({ start: 2, duration: 1, freeze: true, sourceStart: 13 });
  });

  it('checks trims against the asset at the clip speed', () => {
    const { p, ctx } = setup();
    const fast = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_2', speed: 2 },
        { type: 'trim_clip', clipId: 'clip_2', end: 14 },
      ],
      ctx,
    ).project;
    expect(clip(fast, 'clip_2')).toMatchObject({ duration: 4, sourceStart: 12 });
    expectError(
      () => applyOperation(fast, { type: 'trim_clip', clipId: 'clip_2', end: 16 }, ctx),
      'OUT_OF_RANGE',
      /only 20s long/,
    );
    // Reversed: extending the end needs source before the in-point.
    const rev = run(p, [{ type: 'set_speed', clipId: 'clip_3', reverse: true }], ctx).project;
    const e = expectError(
      () => applyOperation(rev, { type: 'trim_clip', clipId: 'clip_3', start: 0, end: 12 }, ctx),
      'OUT_OF_RANGE',
      /cannot start before/,
    );
    expect(e.hint).toMatch(/Extend the end by at most 0s/);
  });
});

describe('resolver', () => {
  it('maps timeline to source time with speed and reverse', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2 },
        { type: 'set_speed', clipId: 'clip_2', reverse: true },
      ],
      ctx,
    ).project;
    expect(sourceAt(r, 3, 'clip_1')).toBe(6);
    // clip_2 stays at 10–15 (source 12–17) and runs backwards.
    expect(sourceAt(r, 10, 'clip_2')).toBeCloseTo(17 - REVERSE_NUDGE, 6);
    expect(sourceAt(r, 14, 'clip_2')).toBeCloseTo(13 - REVERSE_NUDGE, 6);
  });

  it('carries speed and direction in audio segments', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2 },
        { type: 'set_speed', clipId: 'clip_3', speed: 0.5, reverse: true },
      ],
      ctx,
    ).project;
    const segs = resolveAudioSegments(r);
    const v = segs.find((s) => s.clipId === 'clip_1')!;
    expect(v).toMatchObject({
      timelineStart: 0,
      timelineEnd: 5,
      sourceStart: 0,
      sourceEnd: 10,
      speed: 2,
      reverse: false,
    });
    expect(segmentSourceTime(v, 2)).toBe(4);
    expect(segmentTimelineTime(v, 4)).toBe(2);
    const a = segs.find((s) => s.clipId === 'clip_3')!;
    expect(a).toMatchObject({
      timelineStart: 0,
      timelineEnd: 20,
      sourceStart: 0,
      sourceEnd: 10,
      speed: 0.5,
      reverse: true,
    });
    expect(segmentSourceTime(a, 4)).toBe(8);
    expect(segmentTimelineTime(a, 8)).toBe(4);
  });

  it('limits crossfade handles of reversed clips to the asset', () => {
    const { project, ctx } = baseProject();
    const r = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', start: 0, duration: 5 },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          trackId: 'track_1',
          start: 5,
          sourceStart: 15,
          duration: 5,
        },
        { type: 'set_speed', clipId: 'clip_2', reverse: true },
        { type: 'set_speed', clipId: 'clip_1', reverse: true },
        {
          type: 'set_transition',
          clipId: 'clip_2',
          transition: { type: 'crossfade', duration: 2 },
        },
      ],
      ctx,
    ).project;
    const [s1, s2] = resolveAudioSegments(r);
    // clip_1 (source 0–5 reversed) can extend 1 s past its end into source 0 → none left.
    expect(s1).toMatchObject({ timelineStart: 0, timelineEnd: 5, sourceStart: 0, sourceEnd: 5 });
    // clip_2 (source 15–20 reversed) pre-rolls but cannot read past 20 s.
    expect(s2).toMatchObject({ timelineStart: 5, timelineEnd: 10, sourceStart: 15, sourceEnd: 20 });
  });
});

describe('freeze_frame', () => {
  it('splits the clip, inserts a silent hold and ripples the track', () => {
    const { p, ctx } = setup();
    const r = applyOperation(p, { type: 'freeze_frame', clipId: 'clip_1', time: 4 }, ctx);
    expect(spans(r.project, 0)).toEqual([
      ['clip_1', 0, 4],
      ['clip_5', 4, 6],
      ['clip_6', 6, 12],
      ['clip_2', 12, 17],
    ]);
    expect(clip<VideoClip>(r.project, 'clip_5')).toMatchObject({
      freeze: true,
      sourceStart: 4,
      name: 'Freeze frame',
    });
    expect(clip(r.project, 'clip_6')).toMatchObject({ sourceStart: 4 });
    expect(r.createdIds).toEqual(['clip_5', 'clip_6']);
    expect(r.summary).toMatch(/Inserted freeze frame clip_5 \(source 4s of clip clip_1\)/);
    expect(sourceAt(r.project, 4.5, 'clip_5')).toBe(4);
    expect(sourceAt(r.project, 5.9, 'clip_5')).toBe(4);
    expect(resolveAudioSegments(r.project).map((s) => s.clipId)).not.toContain('clip_5');
    // A freeze can be lengthened freely: it uses no source span.
    const long = applyOperation(
      r.project,
      { type: 'trim_clip', clipId: 'clip_5', end: 40, ripple: true },
      ctx,
    );
    expect(clip(long.project, 'clip_5').duration).toBe(36);
  });

  it('holds the first frame when frozen at the clip start, and honors keyframes', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        {
          type: 'set_clip_props',
          clipId: 'clip_2',
          props: {
            keyframes: {
              x: [
                { time: 0, value: 0 },
                { time: 5, value: 100 },
              ],
            },
          },
        },
        { type: 'freeze_frame', clipId: 'clip_2', time: 10, duration: 1, newClipId: 'hold' },
      ],
      ctx,
    ).project;
    expect(spans(r, 0)).toEqual([
      ['clip_1', 0, 10],
      ['hold', 10, 11],
      ['clip_2', 11, 16],
    ]);
    expect(clip<VideoClip>(r, 'hold')).toMatchObject({ sourceStart: 12, transform: { x: 0 } });
    const mid = run(p, [{ type: 'freeze_frame', clipId: 'clip_1', time: 5 }], ctx).project;
    expect(clip<VideoClip>(mid, 'clip_5').transform.x).toBe(0);
  });

  it('freezes the frame on screen in reversed clips', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', reverse: true },
        { type: 'freeze_frame', clipId: 'clip_1', time: 2 },
      ],
      ctx,
    ).project;
    expect(clip<VideoClip>(r, 'clip_5').sourceStart).toBeCloseTo(8 - REVERSE_NUDGE, 6);
  });

  it('rejects non-video clips, freeze frames and times outside the clip', () => {
    const { p, ctx } = setup();
    expectError(
      () => applyOperation(p, { type: 'freeze_frame', clipId: 'clip_3', time: 1 }, ctx),
      'INVALID_ARGUMENT',
      /need a video clip, not audio/,
    );
    const e = expectError(
      () => applyOperation(p, { type: 'freeze_frame', clipId: 'clip_1', time: 10 }, ctx),
      'OUT_OF_RANGE',
      /not inside clip clip_1/,
    );
    expect(e.hint).toMatch(/clip start/);
    expectError(
      () => applyOperation(p, { type: 'freeze_frame', clipId: 'clip_2', time: 9 }, ctx),
      'OUT_OF_RANGE',
    );
    const r = applyOperation(p, { type: 'freeze_frame', clipId: 'clip_1', time: 1 }, ctx).project;
    expectError(
      () => applyOperation(r, { type: 'freeze_frame', clipId: 'clip_5', time: 2 }, ctx),
      'INVALID_ARGUMENT',
      /already a freeze frame/,
    );
  });
});

describe('validation, summaries and mappings', () => {
  it('validates source spans at speed and freeze frames', () => {
    const { p, ctx } = setup();
    const r = run(p, [{ type: 'set_speed', clipId: 'clip_2', speed: 1.5 }], ctx).project;
    expect(findProblems(r)).toEqual([]);
    const broken = structuredClone(r);
    const c2 = broken.tracks[0]!.clips[1] as VideoClip;
    c2.speed = 4; // 12 + 3.333 × 4 > 20
    expect(findProblems(broken).join()).toMatch(/source range 12s–25.333s exceeds/);
    const frozen = run(p, [{ type: 'freeze_frame', clipId: 'clip_1', time: 1 }], ctx).project;
    const bad = structuredClone(frozen);
    (bad.tracks[0]!.clips[1] as VideoClip).sourceStart = 20;
    expect(findProblems(bad).join()).toMatch(/freeze frame at 20s is not inside asset/);
  });

  it('reports speed, reverse and freeze frames in proposal diffs', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2, reverse: true },
        { type: 'freeze_frame', clipId: 'clip_2', time: 11, newClipId: 'hold' },
      ],
      ctx,
    ).project;
    const changes = diffProjects(p, r);
    expect(changes.map(formatChange)).toEqual(
      expect.arrayContaining([
        'Changed video clip "interview.mp4" on V1 (duration, reverse, speed)',
        'Added video clip "Freeze frame" on V1',
      ]),
    );
    expect(describeChanges(changes)).toMatch(/clips? added/);
  });

  it('summarizes speed, reverse and freeze frames', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2, reverse: true },
        { type: 'freeze_frame', clipId: 'clip_2', time: 11 },
      ],
      ctx,
    ).project;
    const clips = summarizeProject(r).tracks[0]!.clips;
    expect(clips[0]).toMatchObject({ speed: 2, reverse: true, source: [0, 10] });
    expect(clips.find((c) => c.id === 'clip_5')).toMatchObject({ freeze: true, source: [13, 13] });
    expect(clips.find((c) => c.id === 'clip_2')).not.toHaveProperty('speed');
  });

  it('maps source material onto sped-up and reversed clips', () => {
    const { p, ctx } = setup();
    const r = run(
      p,
      [
        { type: 'set_speed', clipId: 'clip_1', speed: 2 },
        { type: 'set_speed', clipId: 'clip_2', reverse: true },
      ],
      ctx,
    ).project;
    expect(mapSourceRangeToTimeline(r, 'asset_v', { start: 2, end: 4 })).toEqual([
      { clipId: 'clip_1', start: 1, end: 2 },
    ]);
    expect(mapSourceRangeToTimeline(r, 'asset_v', { start: 13, end: 14 })).toEqual([
      { clipId: 'clip_2', start: 13, end: 14 },
    ]);
    const words = new Map([
      [
        'asset_v',
        [
          { text: 'one', start: 2, end: 3 },
          { text: 'two', start: 13, end: 13.5 },
        ],
      ],
    ]);
    // Reversed speech is skipped; the 2× clip shows its word at half the time.
    expect(mapWordsToTimeline(r, words)).toEqual([{ text: 'one', start: 1, end: 1.5 }]);
    const frozen = run(p, [{ type: 'freeze_frame', clipId: 'clip_1', time: 2.5 }], ctx).project;
    expect(mapWordsToTimeline(frozen, words).map((w) => w.text)).toEqual(['one', 'two']);
  });
});
