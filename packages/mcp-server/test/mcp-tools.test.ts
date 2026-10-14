import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config';
import { createMcpServer } from '../src/mcp/server';
import { StaticTranscriber } from '../src/media/transcribe';
import { createServices, type Services } from '../src/services';
import { spawnSync } from 'node:child_process';
import { FFMPEG, FFPROBE, FIXTURES, fixture, hasFfmpeg, hasFixtures, tempDir } from './helpers';

type Result = CallToolResult & { structuredContent?: Record<string, unknown> };

let services: Services;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

async function okCall(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent!;
}

beforeAll(async () => {
  const dataDir = await tempDir();
  const config = loadConfig({
    dataDir,
    mediaRoots: [FIXTURES, dataDir],
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    publicUrl: 'http://localhost:5173',
  });
  services = createServices(config, {
    transcriber: new StaticTranscriber([
      { text: 'Hello', start: 0.2, end: 0.6 },
      { text: 'world.', start: 0.7, end: 1.2 },
      { text: 'Um,', start: 1.4, end: 1.7 },
      { text: 'Second', start: 3.2, end: 3.6 },
      { text: 'part', start: 3.7, end: 4.1 },
    ]),
  });
  const server = createMcpServer(services, { id: 'test-session' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'claude-test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await services.docs.flush();
});

describe('tool catalogue', () => {
  it('exposes the documented tools with descriptions and strict schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_asset',
        'add_captions',
        'add_clip',
        'add_shape',
        'add_template',
        'add_text_overlay',
        'add_transition',
        'animate_clip',
        'apply_operations',
        'create_highlight_reel',
        'create_project',
        'cut_to_beats',
        'delete_clip',
        'delete_range',
        'delete_words',
        'detect_beats',
        'detect_scenes',
        'detect_silence',
        'duck_music',
        'export_chapters',
        'export_video',
        'get_chapters_input',
        'get_frames',
        'get_project',
        'get_transcript',
        'get_waveform_summary',
        'mark_highlights',
        'move_clip',
        'normalize_loudness',
        'redo',
        'remove_filler_words',
        'render_preview',
        'set_audio_volume',
        'set_brand_kit',
        'set_chapters',
        'set_clip_property',
        'split_clip',
        'trim_clip',
        'undo',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const instructions = client.getInstructions();
    expect(instructions).toMatch(/detect_silence, then delete_range/);
  });
});

describe('editing via MCP', () => {
  it('lists nothing before a project exists', async () => {
    const r = await okCall('get_project');
    expect(r.summary).toMatch(/no projects yet/);
  });

  it('creates a project and edits it', async () => {
    const created = await okCall('create_project', { name: 'MCP test', width: 1280, height: 720 });
    expect(created.editorUrl).toBe(`http://localhost:5173/p/${String(created.projectId)}`);

    const text = await okCall('add_text_overlay', { text: 'Title', start: 0, duration: 2 });
    expect(text.clipId).toMatch(/^clip_/);
    const moved = await okCall('move_clip', { clipId: text.clipId, start: 1 });
    expect(moved.duration).toBe(3);
    await okCall('trim_clip', { clipId: text.clipId, end: 2.5 });
    const split = await okCall('split_clip', { clipId: text.clipId, time: 2 });
    expect(split.newClipId).toMatch(/^clip_/);
    await okCall('set_clip_property', {
      clipId: split.newClipId,
      props: { transform: { y: 200 }, fadeIn: 0.2 },
    });
    const animated = await okCall('animate_clip', {
      clipId: text.clipId,
      in: 'slide-up',
      out: 'pop',
      duration: 0.3,
      outDuration: 0.2,
    });
    expect(animated.summary).toBe(`Clip ${String(text.clipId)}: in slide-up 0.3s, out pop 0.2s.`);
    const removedAnim = await okCall('animate_clip', { clipId: text.clipId, out: 'none' });
    expect(removedAnim.summary).toMatch(/removed the out animation/);
    const tooLong = await call('animate_clip', { clipId: text.clipId, in: 'fade', duration: 5 });
    expect(JSON.stringify(tooLong.content)).toMatch(
      /does not fit.*Hint: Use a duration of at most/,
    );
    const nothing = await call('animate_clip', { clipId: text.clipId });
    expect(nothing.isError).toBe(true);
    await okCall('add_transition', { clipId: split.newClipId, type: 'crossfade', duration: 0.5 });
    await okCall('add_transition', { clipId: split.newClipId, type: 'none' });
    const del = await okCall('delete_clip', { clipIds: [split.newClipId] });
    expect(del.removedIds).toEqual([split.newClipId]);

    const shape = await okCall('add_shape', {
      shape: 'ellipse',
      start: 0,
      width: 120,
      height: 120,
      fill: null,
      strokeWidth: 8,
    });
    expect(shape.clipId).toMatch(/^clip_/);
    expect(String(shape.summary)).toMatch(/Added ellipse 120×120/);
    const bad = await call('add_shape', { start: 0, width: -5 });
    expect(bad.isError).toBe(true);

    const lower = await okCall('add_template', {
      template: 'lower-third',
      text: 'Ada Lovelace',
      subtitle: 'Mathematician',
      start: 0,
    });
    expect(lower.clipIds).toHaveLength(3);
    expect(String(lower.summary)).toMatch(/Added a lower third \(3 clips\)/);

    const undone = await okCall('undo');
    expect(undone.summary).toMatch(/^Undid/);
    const redone = await okCall('redo');
    expect(redone.summary).toMatch(/^Redid/);

    const batch = await okCall('apply_operations', {
      operations: [
        { type: 'add_track', kind: 'audio', name: 'Music' },
        { type: 'update_project', name: 'Renamed' },
      ],
      label: 'Setup',
    });
    expect(batch.summary).toMatch(/Added audio track Music/);

    const project = await okCall('get_project');
    const summary = project.project as { name: string; tracks: Array<{ name: string }> };
    expect(summary.name).toBe('Renamed');
    expect(summary.tracks.map((t) => t.name)).toContain('Music');
    const full = await okCall('get_project', { full: true });
    expect((full.project as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it('sets a brand kit that templates, text and shapes pick up', async () => {
    await okCall('create_project', { name: 'Brand test', width: 1280, height: 720 });
    await okCall('apply_operations', {
      operations: [
        {
          type: 'add_asset',
          asset: {
            id: 'asset_logo',
            name: 'logo.png',
            kind: 'image',
            src: 'assets/asset_logo/logo.png',
            mimeType: 'image/png',
            duration: null,
            width: 400,
            height: 200,
            hasVideo: true,
            hasAudio: false,
          },
        },
      ],
    });
    const badLogo = await call('set_brand_kit', { logoAssetId: 'asset_nope' });
    expect(badLogo.isError).toBe(true);
    expect(JSON.stringify(badLogo.content)).toMatch(/Asset \\"asset_nope\\" not found/);

    const kit = await okCall('set_brand_kit', {
      colors: { primary: '#0f172a', accent: '#f59e0b', text: '#f8fafc' },
      fontFamily: 'Georgia, serif',
      headingFontFamily: 'Impact',
      logoAssetId: 'asset_logo',
      logoPosition: 'top-left',
    });
    expect(kit.brand).toMatchObject({ colors: { primary: '#0f172a' }, logoAssetId: 'asset_logo' });

    const text = await okCall('add_text_overlay', { text: 'Branded', start: 0 });
    await okCall('add_shape', { start: 0 });
    const banner = await okCall('add_template', { template: 'banner', text: 'News', start: 0 });
    expect(banner.clipIds).toHaveLength(2);
    const logo = await okCall('add_template', { template: 'logo', start: 0 });
    expect(String(logo.summary)).toMatch(/Added logo "logo\.png" .* top-left/);
    const noText = await call('add_template', { template: 'title', start: 0 });
    expect(JSON.stringify(noText.content)).toMatch(/needs text.*Hint: Pass text/);

    const { project } = await okCall('get_project', { full: true });
    const doc = project as {
      tracks: Array<{ clips: Array<Record<string, unknown>> }>;
    };
    const clips = doc.tracks.flatMap((t) => t.clips);
    const branded = clips.find((c) => c.id === text.clipId) as { style: Record<string, string> };
    expect(branded.style).toMatchObject({ fontFamily: 'Georgia, serif', color: '#f8fafc' });
    expect(clips.filter((c) => c.type === 'shape').map((c) => c.fill)).toEqual([
      '#0f172a',
      '#0f172a',
    ]);
    expect(clips.some((c) => c.type === 'image' && c.assetId === 'asset_logo')).toBe(true);

    const summary = (await okCall('get_project')).project as { brand?: { logo: string } };
    expect(summary.brand?.logo).toBe('asset_logo (logo.png)');
    const cleared = await okCall('set_brand_kit', { reset: true });
    expect(cleared.brand).toBeNull();
  });

  it('returns actionable errors', async () => {
    const r = await call('split_clip', { clipId: 'clip_nope', time: 1 });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/Error NOT_FOUND: Clip "clip_nope" not found\. Hint: Existing clips:/);
    const v = await call('add_asset', { path: '/definitely/not/here.mp4' });
    expect(v.isError).toBe(true);
    const bad = await call('set_audio_volume', { volume: 1 });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/exactly one of clipId or trackId/);
    const noMusic = await call('detect_beats');
    expect(JSON.stringify(noMusic.content)).toMatch(/no clip on an audio track.*Hint: Pass clipId/);
    const narrow = await call('cut_to_beats', { minBpm: 100, maxBpm: 120 });
    expect(JSON.stringify(narrow.content)).toMatch(/too narrow/);
  });
});

describe.runIf(hasFfmpeg && hasFixtures)('media tools via MCP (ffmpeg)', () => {
  let projectId: string;

  it('imports media and removes silences', async () => {
    projectId = String(
      (await okCall('create_project', { name: 'Silence test', width: 640, height: 360 })).projectId,
    );
    const asset = (await okCall('add_asset', { path: fixture('beeps-12s.mp4') })).asset as {
      id: string;
      duration: number;
    };
    expect(asset.duration).toBeCloseTo(12, 0);
    const clip = await okCall('add_clip', { assetId: asset.id });
    expect(clip.duration).toBeCloseTo(12, 0);

    const silence = await okCall('detect_silence', { minDuration: 0.5, padding: 0.15 });
    const ranges = silence.ranges as Array<{ start: number; end: number }>;
    expect(ranges).toHaveLength(4);
    expect(ranges[0]!.start).toBeCloseTo(2.15, 1);
    expect(ranges[0]!.end).toBeCloseTo(2.85, 1);

    const assetSilence = await okCall('detect_silence', { assetId: asset.id });
    expect((assetSilence.timeline as unknown[]).length).toBe(4);

    const cut = await okCall('delete_range', { ranges });
    expect(cut.duration as number).toBeCloseTo(12 - Number(silence.totalSilence), 1);

    const again = await okCall('detect_silence', { minDuration: 0.5, padding: 0.15 });
    expect(again.ranges).toHaveLength(0);

    const wave = await okCall('get_waveform_summary', { buckets: 8 });
    expect((wave.buckets as unknown[]).length).toBe(8);
    expect(wave.peakDb as number).toBeGreaterThan(-12);
  }, 60_000);

  it('transcribes and adds captions from the transcript', async () => {
    const transcript = await okCall('get_transcript', { format: 'words' });
    expect(transcript.text).toMatch(/Hello world\./);
    const captions = await okCall('add_captions', { fromTranscript: true });
    expect(captions.cueCount).toBeGreaterThan(0);
    const assetTranscript = await okCall('get_transcript', {
      assetId: (await services.docs.get(projectId)).project.assets[0]!.id,
      format: 'text',
    });
    expect(assetTranscript.segments).toBeUndefined();
  });

  it('removes filler words from the transcript in one undo step', async () => {
    const before = (await okCall('get_project')).project as { duration: number };
    const preview = await okCall('remove_filler_words', { dryRun: true });
    expect(preview.found).toEqual([{ text: 'Um,', start: 1.4, end: 1.7, kind: 'filler' }]);
    expect(preview.ranges).toEqual([{ start: 1.35, end: 1.75 }]);
    expect(preview.removedDuration).toBe(0.4);
    expect(preview.version).toBeUndefined();
    expect(String(preview.summary)).toMatch(
      /^Would remove 1 filler word\(s\), 0\.4s.*"Um," at 1\.4s/,
    );

    const custom = await okCall('remove_filler_words', { fillers: ['hello'], dryRun: true });
    expect((custom.found as Array<{ text: string }>).map((f) => f.text)).toEqual(['Hello']);

    const cut = await okCall('remove_filler_words', {});
    expect(cut.dryRun).toBe(false);
    expect(cut.duration as number).toBeCloseTo(before.duration - 0.4, 3);
    expect(String(cut.summary)).toMatch(/^Removed 1 filler word\(s\)/);

    const none = await okCall('remove_filler_words', { dryRun: true });
    expect(none.found).toEqual([]);
    expect(String(none.summary)).toMatch(/No filler words found/);

    const undone = await okCall('undo');
    expect(undone.summary).toMatch(/Remove 1 filler word/);
    await okCall('redo');

    const bad = await call('remove_filler_words', { padding: 2 });
    expect(bad.isError).toBe(true);
  });

  it('deletes words by phrase or index in one undo step', async () => {
    const before = (await okCall('get_project')).project as { duration: number };
    // Timeline words now: Hello, world., Second, part (the filler is gone).
    const words = (await okCall('get_transcript', { format: 'words' })).words as Array<{
      text: string;
      start: number;
      end: number;
    }>;
    expect(words.map((x) => x.text)).toEqual(['Hello', 'world.', 'Second', 'part']);
    const preview = await okCall('delete_words', { text: 'second PART', dryRun: true });
    const removed = preview.removed as Array<{ start: number; end: number; text: string }>;
    expect(removed).toMatchObject([{ start: 2, end: 3, text: 'Second part' }]);
    const ranges = preview.ranges as Array<{ start: number; end: number }>;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBeCloseTo(words[2]!.start - 0.05, 3);
    expect(ranges[0]!.end).toBeCloseTo(words[3]!.end + 0.05, 3);
    expect(preview.version).toBeUndefined();
    expect(String(preview.summary)).toMatch(/^Would remove "Second part"/);

    const cut = await okCall('delete_words', { wordIndexes: { start: 0, end: 0 }, padding: 0 });
    expect(cut.duration as number).toBeCloseTo(
      before.duration - (words[0]!.end - words[0]!.start),
      3,
    );
    expect(String(cut.summary)).toMatch(/^Removed "Hello"/);
    const undone = await okCall('undo');
    expect(undone.summary).toMatch(/Delete 1 word/);

    const all = await okCall('delete_words', { text: 'world', all: true, dryRun: true });
    expect(all.removed).toHaveLength(1);

    const missing = await call('delete_words', { text: 'not said' });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/get_transcript/);
    const second = await call('delete_words', { text: 'hello', occurrence: 2 });
    expect(JSON.stringify(second.content)).toMatch(/occurs 1 time/);
    const both = await call('delete_words', { text: 'hello', wordIndexes: { start: 0, end: 0 } });
    expect(both.isError).toBe(true);
    const outOfRange = await call('delete_words', { wordIndexes: { start: 0, end: 99 } });
    expect(JSON.stringify(outOfRange.content)).toMatch(/0 <= start <= end <= 3/);
  });

  it('looks at frames and scenes', async () => {
    const frames = await call('get_frames', { count: 2, width: 160 });
    expect(frames.isError).toBeFalsy();
    const images = frames.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);

    const scenesProject = String((await okCall('create_project', { name: 'Scenes' })).projectId);
    const asset = (await okCall('add_asset', { path: fixture('scenes-6s.mp4') })).asset as {
      id: string;
    };
    await okCall('add_clip', { assetId: asset.id });
    const scenes = await okCall('detect_scenes', { projectId: scenesProject });
    const times = (scenes.scenes as Array<{ time: number }>).map((s) => s.time);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(2, 0);
    expect(times[1]).toBeCloseTo(4, 0);
    const assetScenes = await okCall('detect_scenes', {
      projectId: scenesProject,
      assetId: asset.id,
    });
    expect(assetScenes.scenes).toHaveLength(2);
    const assetFrames = await call('get_frames', {
      projectId: scenesProject,
      assetId: asset.id,
      times: [1, 3],
      width: 64,
    });
    expect(assetFrames.content.filter((c) => c.type === 'image')).toHaveLength(2);
  }, 60_000);

  it('detects beats and cuts footage to them in one undo step', async () => {
    const beatProject = String((await okCall('create_project', { name: 'Beats' })).projectId);
    const add = async (name: string) =>
      ((await okCall('add_asset', { path: fixture(name) })).asset as { id: string }).id;
    const music = await okCall('add_clip', {
      assetId: await add('clicks-120bpm-8s.wav'),
      start: 0,
    });
    const footage: string[] = [];
    for (const name of ['testsrc-5s.mp4', 'scenes-6s.mp4', 'still.png']) {
      footage.push(String((await okCall('add_clip', { assetId: await add(name) })).clipId));
    }

    const beats = await call('detect_beats', { clipId: music.clipId });
    const data = beats.structuredContent!;
    expect(Math.abs(Number(data.bpm) - 120)).toBeLessThanOrEqual(1);
    const timeline = data.timelineBeats as number[];
    expect(timeline.length).toBeGreaterThanOrEqual(14);
    expect(timeline[0]).toBeCloseTo(0.25, 1);
    expect((beats.content[0] as { text: string }).text).toMatch(/1(19|20)(\.\d+)? BPM.*4 more/s);
    const assetBeats = await okCall('detect_beats', {
      assetId: (await services.docs.get(beatProject)).project.assets[0]!.id,
    });
    expect(assetBeats.timelineBeats).toBeUndefined();

    const cut = await okCall('cut_to_beats', { musicClipId: music.clipId, everyNBeats: 2 });
    const cuts = cut.cuts as Array<{ clipId: string; start: number; end: number }>;
    expect(cuts.map((c) => c.clipId)).toEqual(footage);
    for (const c of cuts) {
      expect(timeline.some((b) => Math.abs(b - c.end) < 0.001)).toBe(true);
    }
    const { project, history } = await services.docs.get(beatProject);
    const placed = project.tracks.flatMap((t) => t.clips).filter((c) => footage.includes(c.id));
    expect(placed.map((c) => c.start)).toEqual(cuts.map((c) => c.start));
    expect(history.undoLabel).toMatch(/to the beat/);
    const last = await okCall('cut_to_beats', { clipIds: [footage[2]], everyNBeats: 8 });
    expect((last.cuts as Array<{ beats: number }>)[0]!.beats).toBe(8);
    const blocked = await call('cut_to_beats', { clipIds: [footage[0]], everyNBeats: 8 });
    expect(JSON.stringify(blocked.content)).toMatch(/OVERLAP.*Hint/);
  }, 60_000);
});

describe.runIf(hasFfmpeg && hasFixtures)('chapters and highlight reels via MCP (ffmpeg)', () => {
  it('outlines the timeline, sets and exports chapters, marks highlights and builds reels', async () => {
    const empty = String((await okCall('create_project', { name: 'Empty' })).projectId);
    const nothing = await call('get_chapters_input', { projectId: empty });
    expect(JSON.stringify(nothing.content)).toMatch(/timeline is empty/);

    const projectId = String(
      (await okCall('create_project', { name: 'Talk', width: 640, height: 360 })).projectId,
    );
    const asset = (await okCall('add_asset', { path: fixture('beeps-12s.mp4') })).asset as {
      id: string;
    };
    for (let i = 0; i < 3; i++) await okCall('add_clip', { assetId: asset.id });
    await okCall('add_text_overlay', { text: 'Hook', start: 1, duration: 2 });

    const outline = await okCall('get_chapters_input', { projectId, minBlock: 5 });
    expect(outline.duration).toBe(36);
    const blocks = outline.blocks as Array<{ start: number; end: number; text: string }>;
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]!.text).toMatch(/Hello world\./);
    expect((outline.silences as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(outline.scenes)).toBe(true);
    expect(outline.next).toMatch(/set_chapters/);

    const bad = await call('set_chapters', {
      projectId,
      chapters: [
        { time: 0, title: 'Intro' },
        { time: 5, title: 'Too soon' },
        { time: 24, title: 'End' },
      ],
    });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(
      /at least 10s.*Hint: Move "Too soon"/,
    );

    const noChapters = await call('export_chapters', { projectId });
    expect(JSON.stringify(noChapters.content)).toMatch(/no chapters.*set_chapters/);

    const set = await okCall('set_chapters', {
      projectId,
      chapters: [
        { time: 0, title: 'Intro' },
        { time: 12, title: 'Middle' },
        { time: 24, title: 'End' },
      ],
    });
    expect(set.youtube).toBe('00:00 Intro\n00:12 Middle\n00:24 End');
    const yt = await okCall('export_chapters', { projectId });
    expect(yt.text).toBe('00:00 Intro\n00:12 Middle\n00:24 End');
    expect(yt.warnings).toBeUndefined();
    const meta = await okCall('export_chapters', { projectId, format: 'ffmetadata' });
    expect(meta.text).toMatch(/^;FFMETADATA1\ntitle=Talk\n\n\[CHAPTER\]/);
    const json = await okCall('export_chapters', { projectId, format: 'json' });
    expect(JSON.parse(String(json.text))).toEqual([
      { start: 0, end: 12, title: 'Intro' },
      { start: 12, end: 24, title: 'Middle' },
      { start: 24, end: 36, title: 'End' },
    ]);
    const summary = (await okCall('get_project', { projectId })).project as {
      chapters: unknown[];
    };
    expect(summary.chapters).toHaveLength(3);

    const noRanges = await call('create_highlight_reel', { projectId });
    expect(JSON.stringify(noRanges.content)).toMatch(/mark_highlights/);

    await okCall('mark_highlights', { projectId, ranges: [{ start: 20, end: 22 }] });
    const marked = await okCall('mark_highlights', {
      projectId,
      ranges: [
        { start: 0.5, end: 3.5, label: 'Hello' },
        { start: 12.2, end: 14 },
      ],
      color: '#ffcc00',
    });
    expect(marked.highlights).toEqual([
      { start: 0.5, end: 3.5, label: 'Hello' },
      { start: 12.2, end: 14 },
    ]);
    expect(String((await okCall('get_chapters_input', { projectId })).summary)).toMatch(/Outline/);

    const appended = await okCall('create_highlight_reel', {
      projectId,
      target: 'append',
      ranges: [{ start: 0.5, end: 3.5 }],
    });
    expect(appended.duration).toBe(39);
    await okCall('undo', { projectId });

    const reel = await okCall('create_highlight_reel', {
      projectId,
      aspect: '9:16',
      fadeBetween: 0.5,
      title: 'Talk shorts',
    });
    expect(reel.sourceProjectId).toBe(projectId);
    expect(reel.duration).toBe(4.8);
    expect(reel.settings).toEqual({ width: 360, height: 640 });
    expect(reel.chapters).toEqual([{ time: 0, title: 'Hello' }]);
    const reelDoc = (await services.docs.get(String(reel.projectId))).project;
    expect(reelDoc.name).toBe('Talk shorts');
    expect(reelDoc.tracks.flatMap((t) => t.clips).some((c) => c.type === 'text')).toBe(true);
    const square = await okCall('create_highlight_reel', {
      projectId,
      ranges: [{ start: 2, end: 4 }],
      aspect: '1:1',
    });
    expect(square.settings).toEqual({ width: 640, height: 640 });
    const wide = await okCall('create_highlight_reel', {
      projectId: String(reel.projectId),
      ranges: [{ start: 0, end: 1 }],
      aspect: '16:9',
    });
    expect(wide.settings).toEqual({ width: 640, height: 360 });

    // Exported MP4s carry the chapter markers.
    const exported = await okCall('export_video', { projectId, quality: 'draft', width: 320 });
    const probe = spawnSync(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_chapters', String(exported.path)],
      { encoding: 'utf8', windowsHide: true },
    );
    const chapters = (
      JSON.parse(probe.stdout) as {
        chapters: Array<{ start_time: string; tags: { title: string } }>;
      }
    ).chapters;
    expect(chapters.map((c) => [Math.round(Number(c.start_time)), c.tags.title])).toEqual([
      [0, 'Intro'],
      [12, 'Middle'],
      [24, 'End'],
    ]);
  }, 120_000);
});
