import { describe, expect, it } from 'vitest';
import type { CutlineError } from '../src';
import {
  applyOperation,
  chapterList,
  chaptersInRange,
  ffmetadataChapters,
  findProblems,
  formatTimestamp,
  groupIntoBlocks,
  loudnessPeaks,
  mainTrack,
  summarizeProject,
  timeAfterRemoval,
  youtubeChapterText,
  youtubeChapterWarnings,
  type AudioClip,
  type CaptionClip,
  type Marker,
  type OperationInput,
  type Project,
  type TextClip,
  type VideoClip,
} from '../src';
import { baseProject, clip, run } from './helpers';

function errorOf(fn: () => unknown): CutlineError {
  try {
    fn();
  } catch (err) {
    return err as CutlineError;
  }
  throw new Error('expected an error');
}

/** V1: v1 0–20, v2 20–40 · A1: a1 0–30. */
function timeline() {
  const { project, ctx } = baseProject();
  const p = run(
    project,
    [
      { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', start: 0, id: 'v1' },
      { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', start: 20, id: 'v2' },
      { type: 'add_clip', assetId: 'asset_a', trackId: 'track_2', start: 0, id: 'a1' },
    ],
    ctx,
  ).project;
  return { project: p, ctx };
}

function apply(project: Project, op: OperationInput, ctx: ReturnType<typeof timeline>['ctx']) {
  return applyOperation(project, op, ctx);
}

const pick = (p: Project) =>
  (p.markers ?? []).map((m) => [m.id, m.time, m.end ?? null] as [string, number, number | null]);

describe('markers operations', () => {
  it('adds markers in time order with defaults, ids and spans', () => {
    const { project, ctx } = timeline();
    const r = apply(
      project,
      {
        type: 'add_markers',
        markers: [
          { time: 12, label: 'Later' },
          { time: 3, kind: 'highlight', end: 8, color: '#ff0000', label: 'Best bit' },
          { time: 5, kind: 'chapter', label: 'Intro', id: 'm_intro' },
          { time: 12, id: 'a_same' },
        ],
      },
      ctx,
    );
    expect(r.project.markers).toEqual([
      { id: 'marker_2', time: 3, end: 8, kind: 'highlight', label: 'Best bit', color: '#ff0000' },
      { id: 'm_intro', time: 5, kind: 'chapter', label: 'Intro' },
      { id: 'a_same', time: 12, kind: 'note', label: '' },
      { id: 'marker_1', time: 12, kind: 'note', label: 'Later' },
    ]);
    expect(r.createdIds).toEqual(['marker_1', 'marker_2', 'm_intro', 'a_same']);
    expect(r.summary).toBe('Added 4 note/highlight/chapter marker(s).');
    expect(chapterList(r.project)).toEqual([{ time: 5, title: 'Intro' }]);

    expect(
      errorOf(() => apply(project, { type: 'add_markers', markers: [{ time: 5, end: 4 }] }, ctx))
        .code,
    ).toBe('INVALID_OPERATION');
  });

  it('updates and validates a marker', () => {
    const { project, ctx } = timeline();
    const p = apply(
      project,
      {
        type: 'add_markers',
        markers: [
          { time: 2, label: 'a' },
          { time: 9, label: 'b' },
        ],
      },
      ctx,
    ).project;
    const r = apply(
      p,
      {
        type: 'update_marker',
        markerId: 'marker_1',
        time: 10,
        label: 'Moved',
        kind: 'highlight',
        end: 14,
        color: '#00ff00',
      },
      ctx,
    );
    expect(r.project.markers).toEqual([
      { id: 'marker_2', time: 9, kind: 'note', label: 'b' },
      { id: 'marker_1', time: 10, end: 14, kind: 'highlight', label: 'Moved', color: '#00ff00' },
    ]);
    expect(r.summary).toBe('Updated marker marker_1 ("Moved").');
    const cleared = apply(
      r.project,
      { type: 'update_marker', markerId: 'marker_1', end: null, color: null },
      ctx,
    ).project;
    expect(cleared.markers![1]).toEqual({
      id: 'marker_1',
      time: 10,
      kind: 'highlight',
      label: 'Moved',
    });
    // No-op update keeps everything.
    expect(
      apply(cleared, { type: 'update_marker', markerId: 'marker_2' }, ctx).project.markers,
    ).toEqual(cleared.markers);

    const bad = errorOf(() =>
      apply(r.project, { type: 'update_marker', markerId: 'marker_1', end: 5 }, ctx),
    );
    expect(bad.code).toBe('INVALID_ARGUMENT');
    expect(bad.hint).toMatch(/end: null/);

    const missing = errorOf(() => apply(p, { type: 'update_marker', markerId: 'nope' }, ctx));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.hint).toMatch(/marker_1 \(note "a"\)/);
    const none = errorOf(() => apply(project, { type: 'update_marker', markerId: 'nope' }, ctx));
    expect(none.hint).toBe('The project has no markers.');
  });

  it('removes markers by id or kind and drops the empty list', () => {
    const { project, ctx } = timeline();
    const p = apply(
      project,
      {
        type: 'add_markers',
        markers: [
          { time: 1, kind: 'highlight', end: 2 },
          { time: 3, kind: 'highlight', end: 4 },
          { time: 5 },
        ],
      },
      ctx,
    ).project;
    const byKind = apply(p, { type: 'remove_markers', kind: 'highlight' }, ctx);
    expect(pick(byKind.project)).toEqual([['marker_3', 5, null]]);
    expect(byKind.removedIds).toEqual(['marker_1', 'marker_2']);
    const all = apply(byKind.project, { type: 'remove_markers', markerIds: ['marker_3'] }, ctx);
    expect(all.project.markers).toBeUndefined();
    expect(all.summary).toBe('Removed 1 marker(s).');
    // Removing a kind from a project without markers is a no-op.
    expect(
      apply(project, { type: 'remove_markers', kind: 'note' }, ctx).project.markers,
    ).toBeUndefined();
    expect(errorOf(() => apply(p, { type: 'remove_markers', markerIds: ['x'] }, ctx)).code).toBe(
      'NOT_FOUND',
    );
    expect(
      errorOf(() =>
        apply(p, { type: 'remove_markers', markerIds: ['marker_1'], kind: 'note' }, ctx),
      ).code,
    ).toBe('INVALID_OPERATION');
  });
});

describe('set_chapters', () => {
  const chapters = [
    { time: 0, title: 'Intro' },
    { time: 12, title: 'Main part' },
    { time: 25, title: 'Outro' },
  ];

  it('replaces chapter markers and keeps other markers', () => {
    const { project, ctx } = timeline();
    const p = apply(
      project,
      {
        type: 'add_markers',
        markers: [
          { time: 1, kind: 'chapter', label: 'Old' },
          { time: 7, label: 'note' },
        ],
      },
      ctx,
    ).project;
    const r = apply(p, { type: 'set_chapters', chapters }, ctx);
    expect(chapterList(r.project)).toEqual([
      { time: 0, title: 'Intro' },
      { time: 12, title: 'Main part' },
      { time: 25, title: 'Outro' },
    ]);
    expect(r.project.markers!.find((m) => m.kind === 'note')!.label).toBe('note');
    expect(r.removedIds).toEqual(['marker_1']);
    expect(r.summary).toBe('Set 3 chapter(s): 00:00 Intro, 00:12 Main part, 00:25 Outro.');

    const cleared = apply(r.project, { type: 'set_chapters', chapters: [] }, ctx);
    expect(cleared.summary).toBe('Removed all chapters.');
    expect(chapterList(cleared.project)).toEqual([]);
    const empty = apply(project, { type: 'set_chapters', chapters: [] }, ctx);
    expect(empty.project.markers).toBeUndefined();
  });

  it('enforces YouTube rules with actionable hints', () => {
    const { project, ctx } = timeline();
    const fail = (list: Array<{ time: number; title: string }>, youtube = true) =>
      errorOf(() => apply(project, { type: 'set_chapters', chapters: list, youtube }, ctx));

    const unsorted = fail([chapters[0]!, chapters[2]!, chapters[1]!]);
    expect(unsorted.message).toMatch(/does not come after "Outro"/);
    expect(unsorted.hint).toMatch(/Sort chapters/);
    const late = fail([
      { time: 0, title: 'A' },
      { time: 40, title: 'B' },
    ]);
    expect(late.code).toBe('OUT_OF_RANGE');
    const first = fail([{ time: 2, title: 'A' }, ...chapters.slice(1)]);
    expect(first.hint).toMatch(/time: 0, title: "Intro"/);
    expect(fail(chapters.slice(0, 2)).message).toMatch(/at least 3 chapters/);
    const short = fail([chapters[0]!, { time: 5, title: 'Short' }, chapters[2]!]);
    expect(short.message).toMatch(/"Intro" \(00:00\) is only 5s long/);
    expect(short.hint).toMatch(/Move "Short" to 10s or later/);
    const lastShort = fail([...chapters, { time: 35, title: 'End' }]);
    expect(lastShort.hint).toMatch(/Start the last chapter by 30s/);

    // youtube: false only needs increasing times inside the timeline.
    const loose = apply(
      project,
      {
        type: 'set_chapters',
        chapters: [
          { time: 5, title: 'A' },
          { time: 7, title: 'B' },
        ],
        youtube: false,
      },
      ctx,
    );
    expect(chapterList(loose.project)).toHaveLength(2);

    const { project: empty, ctx: c2 } = baseProject();
    expect(
      errorOf(() => applyOperation(empty, { type: 'set_chapters', chapters }, c2)).message,
    ).toMatch(/timeline is empty/);
  });
});

describe('markers follow ripple edits', () => {
  function marked() {
    const { project, ctx } = timeline();
    const p = apply(
      project,
      {
        type: 'add_markers',
        markers: [
          { time: 2, id: 'a' },
          { time: 7, id: 'b' },
          { time: 12, id: 'c' },
          { time: 6, end: 8, kind: 'highlight', id: 'gone' },
          { time: 8, end: 14, kind: 'highlight', id: 'tail' },
          { time: 3, end: 12, kind: 'highlight', id: 'around' },
        ],
      },
      ctx,
    ).project;
    return { project: p, ctx };
  }

  it('delete_range on the whole timeline moves, snaps, shrinks and drops markers', () => {
    const { project, ctx } = marked();
    const r = apply(project, { type: 'delete_range', ranges: [{ start: 5, end: 10 }] }, ctx);
    expect(pick(r.project)).toEqual([
      ['a', 2, null],
      ['around', 3, 7],
      ['b', 5, null],
      ['tail', 5, 9],
      ['c', 7, null],
    ]);
    expect(r.removedIds).toContain('gone');
  });

  it('leaves markers alone for track-limited or non-ripple deletes', () => {
    const { project, ctx } = marked();
    const limited = apply(
      project,
      { type: 'delete_range', ranges: [{ start: 5, end: 10 }], trackIds: ['track_1'] },
      ctx,
    );
    expect(limited.project.markers).toEqual(project.markers);
    const lift = apply(
      project,
      { type: 'delete_range', ranges: [{ start: 5, end: 10 }], ripple: false },
      ctx,
    );
    expect(lift.project.markers).toEqual(project.markers);
    // Without markers nothing breaks.
    const { project: plain, ctx: c2 } = timeline();
    expect(
      applyOperation(plain, { type: 'delete_range', ranges: [{ start: 1, end: 2 }] }, c2).project
        .markers,
    ).toBeUndefined();
  });

  it('ripple trims on the main track move markers with the content', () => {
    const { project, ctx } = marked();
    // Cut the end of v1 (15–20): markers after 20 would move; ours are before.
    const endCut = apply(project, { type: 'trim_clip', clipId: 'v1', end: 10, ripple: true }, ctx);
    expect(pick(endCut.project)).toEqual([
      ['a', 2, null],
      ['around', 3, 10],
      ['gone', 6, 8],
      ['b', 7, null],
      ['tail', 8, 10],
      ['c', 10, null],
    ]);
    // Cut the start of v1 (0–4): everything moves 4 s left, a snaps to 0.
    const startCut = apply(
      project,
      { type: 'trim_clip', clipId: 'v1', start: 4, ripple: true },
      ctx,
    );
    expect(pick(startCut.project)).toEqual([
      ['a', 0, null],
      ['around', 0, 8],
      ['gone', 2, 4],
      ['b', 3, null],
      ['tail', 4, 10],
      ['c', 8, null],
    ]);
  });

  it('ripple trims that extend a clip push markers right', () => {
    const { project, ctx } = baseProject();
    // v1 shows source 4–14 at 5–15.
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          trackId: 'track_1',
          start: 5,
          sourceStart: 4,
          duration: 10,
          id: 'v1',
        },
        {
          type: 'add_markers',
          markers: [
            { time: 8, id: 'in' },
            { time: 15, id: 'edge' },
            { time: 17, id: 'after' },
            { time: 6, end: 9, kind: 'highlight', id: 'early' },
            { time: 6, end: 16, kind: 'highlight', id: 'span' },
          ],
        },
      ],
      ctx,
    ).project;
    const longer = applyOperation(
      p,
      { type: 'trim_clip', clipId: 'v1', end: 17, ripple: true },
      ctx,
    );
    expect(pick(longer.project)).toEqual([
      ['early', 6, 9],
      ['span', 6, 18],
      ['in', 8, null],
      ['edge', 17, null],
      ['after', 19, null],
    ]);
    // Extending the start keeps the clip in place, so its content (and markers) move right.
    const left = applyOperation(
      p,
      { type: 'trim_clip', clipId: 'v1', start: 3, ripple: true },
      ctx,
    );
    expect(pick(left.project)).toEqual([
      ['early', 8, 11],
      ['span', 8, 18],
      ['in', 10, null],
      ['edge', 17, null],
      ['after', 19, null],
    ]);
  });

  it('ignores ripple edits on other tracks and handles ripple deletes of clips', () => {
    const { project, ctx } = marked();
    const audio = apply(project, { type: 'trim_clip', clipId: 'a1', end: 20, ripple: true }, ctx);
    expect(audio.project.markers).toEqual(project.markers);
    const audioDelete = apply(
      project,
      { type: 'delete_clips', clipIds: ['a1'], ripple: true },
      ctx,
    );
    expect(audioDelete.project.markers).toEqual(project.markers);
    const del = apply(project, { type: 'delete_clips', clipIds: ['v1'], ripple: true }, ctx);
    expect(pick(del.project)).toEqual([
      ['a', 0, null],
      ['b', 0, null],
      ['c', 0, null],
    ]);
    expect(del.removedIds).toEqual(expect.arrayContaining(['v1', 'gone', 'tail', 'around']));
  });
});

describe('marker helpers', () => {
  it('maps times through a removal', () => {
    expect(timeAfterRemoval(2, 5, 10)).toBe(2);
    expect(timeAfterRemoval(7, 5, 10)).toBe(5);
    expect(timeAfterRemoval(12, 5, 10)).toBe(7);
  });

  it('finds the main track', () => {
    const { project } = timeline();
    expect(mainTrack(project)!.id).toBe('track_1');
    expect(mainTrack({ ...project, tracks: project.tracks.slice(1) })!.id).toBe('track_2');
    expect(mainTrack({ ...project, tracks: [] })).toBeUndefined();
  });

  it('formats YouTube chapter text and warnings', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(65.9)).toBe('01:05');
    expect(formatTimestamp(3725, true)).toBe('1:02:05');
    expect(formatTimestamp(3725)).toBe('62:05');
    const list = [
      { time: 0, title: 'Intro' },
      { time: 15, title: 'Main' },
    ];
    expect(youtubeChapterText(list, 60)).toBe('00:00 Intro\n00:15 Main');
    expect(youtubeChapterText(list, 4000)).toBe('0:00:00 Intro\n0:00:15 Main');
    expect(youtubeChapterWarnings([], 60)).toEqual(['There are no chapters.']);
    expect(youtubeChapterWarnings([{ time: 5, title: 'A' }, ...list.slice(1)], 20)).toEqual([
      'The first chapter starts at 00:05; YouTube needs one at 00:00.',
      'YouTube needs at least 3 chapters; there are 2.',
      'Chapter "Main" (00:15) is 5s long; YouTube needs at least 10s.',
    ]);
    expect(
      youtubeChapterWarnings(
        [
          { time: 0, title: 'A' },
          { time: 10, title: 'B' },
          { time: 20, title: 'C' },
        ],
        30,
      ),
    ).toEqual([]);
    expect(
      youtubeChapterWarnings(
        [
          { time: 0, title: 'A' },
          { time: 30, title: 'B' },
          { time: 40, title: 'C' },
        ],
        35,
      ),
    ).toContain('Chapter "C" (00:40) is 0s long; YouTube needs at least 10s.');
  });

  it('re-times chapters for an exported range', () => {
    const list = [
      { time: 0, title: 'A' },
      { time: 10, title: 'B' },
      { time: 20, title: 'C' },
      { time: 30, title: 'D' },
    ];
    expect(chaptersInRange(list, 12, 25)).toEqual([
      { time: 0, title: 'B' },
      { time: 8, title: 'C' },
    ]);
    expect(chaptersInRange(list, 0, 40)).toEqual(list);
  });

  it('writes ffmetadata chapters', () => {
    const list = [
      { time: 0, title: 'Intro; = #1' },
      { time: 12.5, title: 'Main' },
      { time: 60, title: 'Beyond the end' },
    ];
    expect(ffmetadataChapters(list, 30, 'My\\video')).toBe(
      [
        ';FFMETADATA1',
        'title=My\\\\video',
        '',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=12500',
        'title=Intro\\; \\= \\#1',
        '',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=12500',
        'END=30000',
        'title=Main',
        '',
      ].join('\n'),
    );
    expect(ffmetadataChapters([], 10)).toBe(';FFMETADATA1\n');
  });

  it('validates markers and lists them in the summary', () => {
    const { project } = timeline();
    const markers: Marker[] = [
      { id: 'm1', time: 0, label: 'Intro', kind: 'chapter' },
      { id: 'm1', time: 5, label: 'dup', kind: 'note' },
      { id: 'm2', time: 9, end: 9, label: 'bad', kind: 'highlight' },
    ];
    expect(findProblems({ ...project, markers })).toEqual([
      'duplicate id m1 (marker)',
      'marker m2: end must be after time',
    ]);
    const s = summarizeProject({ ...project, markers: [markers[0]!, { ...markers[2]!, end: 12 }] });
    expect(s.chapters).toEqual([{ time: 0, title: 'Intro' }]);
    expect(s.markers).toEqual([{ id: 'm2', kind: 'highlight', time: 9, end: 12, label: 'bad' }]);
    const plain = summarizeProject({ ...project, markers: [{ ...markers[1]!, id: 'n' }] });
    expect(plain.chapters).toBeUndefined();
    expect(plain.markers).toEqual([{ id: 'n', kind: 'note', time: 5, label: 'dup' }]);
  });
});

describe('outline helpers', () => {
  it('groups sentences into blocks at natural breaks', () => {
    const s = (start: number, end: number, text: string) => ({ start, end, text });
    expect(groupIntoBlocks([])).toEqual([]);
    const blocks = groupIntoBlocks(
      [
        s(25, 30, 'and then more'),
        s(0, 12, 'Hello there'),
        s(12, 22, 'we start.'),
        s(30, 50, 'a long one'),
        s(50, 61, 'pause after'),
        s(63, 75, 'scene cut'),
        s(75, 85, 'cut here'),
        s(85, 95, 'running on'),
        s(95, 150, 'too long to fit'),
      ],
      { breaks: [85.1] },
    );
    expect(blocks).toEqual([
      { start: 0, end: 22, text: 'Hello there we start.' },
      { start: 25, end: 61, text: 'and then more a long one pause after' },
      { start: 63, end: 85, text: 'scene cut cut here' },
      { start: 85, end: 95, text: 'running on' },
      { start: 95, end: 150, text: 'too long to fit' },
    ]);
  });

  it('picks loudness peaks above the average', () => {
    const b = (start: number, rmsDb: number) => ({
      start,
      end: start + 1,
      peakDb: rmsDb + 6,
      rmsDb,
    });
    const summary = {
      duration: 5,
      peakDb: -1,
      rmsDb: -20,
      buckets: [b(0, -30), b(1, -10), b(2, -16), b(3, -5), b(4, -18)],
      loudest: [],
      quietest: [],
    };
    expect(loudnessPeaks(summary).map((x) => x.start)).toEqual([1, 2, 3]);
    expect(loudnessPeaks(summary, 1).map((x) => x.start)).toEqual([3]);
  });
});

describe('assemble_ranges (highlight reels)', () => {
  /** V1 v1 0–20 + v2 20–40, V2 text 3–9 (fades/animations), C1 caption 4–8, A1 a1 0–30. */
  function rich() {
    const { project, ctx } = timeline();
    const p = run(
      project,
      [
        {
          type: 'add_text',
          text: 'Lower third',
          start: 3,
          duration: 6,
          id: 't1',
        },
        {
          type: 'set_clip_props',
          clipId: 't1',
          props: {
            fadeIn: 0.5,
            fadeOut: 0.5,
            animationIn: { preset: 'fade', duration: 0.5 },
            animationOut: { preset: 'fade', duration: 0.5 },
          },
        },
        {
          type: 'add_captions',
          cues: [
            {
              start: 4,
              end: 8,
              text: 'hello world',
              words: [
                { text: 'hello', start: 4, end: 5 },
                { text: 'world', start: 6, end: 7.5 },
              ],
            },
          ],
        },
        { type: 'add_markers', markers: [{ time: 1, label: 'old' }] },
        { type: 'set_transition', clipId: 'v2', transition: { type: 'crossfade', duration: 1 } },
      ],
      ctx,
    ).project;
    return { project: p, ctx };
  }

  it('appends ranges back-to-back with overlays, captions and chapter labels', () => {
    const { project, ctx } = rich();
    const r = apply(
      project,
      {
        type: 'assemble_ranges',
        ranges: [
          { start: 5, end: 7, label: 'Hook' },
          { start: 25, end: 28 },
        ],
      },
      ctx,
    );
    const p = r.project;
    const v1 = p.tracks.find((t) => t.id === 'track_1')!.clips;
    expect(v1.map((c) => [c.start, c.duration])).toEqual([
      [0, 20],
      [20, 20],
      [40, 2],
      [42, 3],
    ]);
    expect((v1[2] as VideoClip).sourceStart).toBe(5);
    expect((v1[3] as VideoClip).sourceStart).toBe(5);
    const text = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'text') as TextClip[];
    expect(text[1]).toMatchObject({ start: 40, duration: 2, fadeIn: 0, fadeOut: 0 });
    expect(text[1]!.animationIn).toBeUndefined();
    expect(text[1]!.animationOut).toBeUndefined();
    const caption = p.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.type === 'caption') as CaptionClip[];
    expect(caption[1]).toMatchObject({ start: 40, duration: 2 });
    expect(caption[1]!.words).toEqual([{ text: 'world', start: 1, end: 2 }]);
    // v2's crossfade does not survive the cut in its middle.
    expect((v1[3] as VideoClip).transitionIn).toBeUndefined();
    const audio = p.tracks.find((t) => t.id === 'track_2')!.clips;
    expect(audio.slice(1).map((c) => [c.start, c.duration])).toEqual([
      [40, 2],
      [42, 3],
    ]);
    expect(chapterList(p)).toEqual([{ time: 40, title: 'Hook' }]);
    expect(pick(p)[0]).toEqual(['marker_1', 1, null]);
    expect(r.summary).toBe('Appended a 5s reel of 2 range(s) at 40s–45s.');
  });

  it('replaces the timeline, keeps whole clips intact and crossfades between ranges', () => {
    const { project, ctx } = rich();
    const r = apply(
      project,
      {
        type: 'assemble_ranges',
        mode: 'replace',
        ranges: [
          { start: 2, end: 10, label: 'One' },
          { start: 30, end: 35, label: 'Two' },
          { start: 12, end: 14 },
        ],
        fadeBetween: 1,
      },
      ctx,
    );
    const p = r.project;
    expect(p.markers!.map((m) => [m.time, m.label])).toEqual([
      [0, 'One'],
      [8, 'Two'],
    ]);
    expect(r.removedIds).toContain('v1');
    const v1 = p.tracks.find((t) => t.id === 'track_1')!.clips as VideoClip[];
    expect(v1.map((c) => [c.start, c.duration, c.transitionIn?.duration ?? null])).toEqual([
      [0, 8, null],
      [8, 5, 1],
      [13, 2, 1],
    ]);
    // The text sits fully inside range one and keeps its fades and animations.
    const text = p.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text') as TextClip;
    expect(text).toMatchObject({ start: 1, duration: 6, fadeIn: 0.5, fadeOut: 0.5 });
    expect(text.animationIn).toBeDefined();
    // Audio only exists up to 30 s: ranges one and three, which are not adjacent.
    const audio = p.tracks.find((t) => t.id === 'track_2')!.clips as AudioClip[];
    expect(audio.map((c) => [c.start, c.duration, c.fadeIn, c.fadeOut])).toEqual([
      [0, 8, 0, 0],
      [13, 2, 0, 0],
    ]);
    expect(r.summary).toBe('Replaced the timeline with a 15s reel of 3 range(s) at 0s–15s.');
  });

  it('fades audio between adjacent ranges and skips caption neighbours', () => {
    const { project, ctx } = rich();
    const p = apply(
      project,
      {
        type: 'assemble_ranges',
        mode: 'replace',
        ranges: [
          { start: 4, end: 6 },
          { start: 6, end: 8 },
          { start: 20, end: 21 },
        ],
        fadeBetween: 0.4,
      },
      ctx,
    ).project;
    const audio = p.tracks.find((t) => t.id === 'track_2')!.clips as AudioClip[];
    expect(audio.map((c) => [c.start, c.fadeIn, c.fadeOut])).toEqual([
      [0, 0, 0.2],
      [2, 0.2, 0.2],
      [4, 0.2, 0],
    ]);
    const caption = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'caption');
    expect(caption.map((c) => c.start)).toEqual([0, 2]);
    expect(p.markers).toBeUndefined();
  });

  it('rejects ranges past the end and locked tracks', () => {
    const { project, ctx } = timeline();
    const late = errorOf(() =>
      apply(project, { type: 'assemble_ranges', ranges: [{ start: 30, end: 50 }] }, ctx),
    );
    expect(late.code).toBe('OUT_OF_RANGE');
    expect(late.hint).toMatch(/0–40s/);
    const locked = apply(
      project,
      { type: 'update_track', trackId: 'track_2', locked: true },
      ctx,
    ).project;
    expect(
      errorOf(() => apply(locked, { type: 'assemble_ranges', ranges: [{ start: 0, end: 5 }] }, ctx))
        .code,
    ).toBe('LOCKED');
    // Locked but empty tracks do not matter.
    const { project: p2, ctx: c2 } = timeline();
    const withEmpty = run(
      p2,
      [
        { type: 'add_track', kind: 'video', id: 'empty' },
        { type: 'update_track', trackId: 'empty', locked: true },
      ],
      c2,
    ).project;
    expect(
      applyOperation(withEmpty, { type: 'assemble_ranges', ranges: [{ start: 0, end: 5 }] }, c2)
        .createdIds.length,
    ).toBeGreaterThan(0);
  });

  it('keeps the clip ids of the original timeline in append mode', () => {
    const { project, ctx } = timeline();
    const p = apply(
      project,
      { type: 'assemble_ranges', ranges: [{ start: 0, end: 3 }] },
      ctx,
    ).project;
    expect(clip(p, 'v1').start).toBe(0);
    expect(p.markers).toBeUndefined();
    const replaced = apply(
      project,
      { type: 'assemble_ranges', mode: 'replace', ranges: [{ start: 0, end: 3 }] },
      ctx,
    ).project;
    expect(replaced.markers).toBeUndefined();
    expect(replaced.tracks[0]!.clips).toHaveLength(1);
  });
});
