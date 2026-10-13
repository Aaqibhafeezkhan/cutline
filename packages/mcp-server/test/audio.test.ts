import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  applyOperations,
  computeEnvelope,
  createProject,
  dbToGain,
  gainAt,
  resolveAudioSegments,
  sequentialContext,
  type AudioClip,
  type Project,
} from '@cutline/core';
import { parseEbur128 } from '../src/media/ffmpeg';
import { pickDuckingTracks } from '../src/media/mixing';
import { startServer, type RunningServer } from '../src/server';
import { StaticTranscriber } from '../src/media/transcribe';
import { FFMPEG, FFPROBE, FIXTURES, fixture, hasFfmpeg, hasFixtures, tempDir } from './helpers';

const EBUR128 = `[Parsed_ebur128_0 @ 0x1] t: 2.9  TARGET:-23 LUFS    M: -21.7 S:-21.7 I: -21.7 LUFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -21.7 LUFS
    Threshold: -31.7 LUFS

  True peak:
    Peak:      -18.1 dBFS
`;

describe('loudness parsing', () => {
  it('reads integrated loudness and true peak from the ebur128 summary', () => {
    expect(parseEbur128(EBUR128)).toEqual({ integrated: -21.7, truePeak: -18.1 });
    expect(parseEbur128('Summary:\n  I:         -inf LUFS\n')).toEqual({
      integrated: -70,
      truePeak: null,
    });
    expect(() => parseEbur128('nothing')).toThrow(/integrated loudness/);
  });
});

function tracksProject(names: Array<[string, 'video' | 'audio', string]>): Project {
  const ctx = sequentialContext();
  let project = createProject({ name: 'Pick' }, ctx);
  const ops: unknown[] = [];
  names.forEach(([trackName, kind, assetName], i) => {
    const assetId = `asset_${i}`;
    ops.push(
      {
        type: 'add_asset',
        asset: {
          id: assetId,
          name: assetName,
          kind,
          src: `assets/${assetId}`,
          mimeType: kind === 'audio' ? 'audio/wav' : 'video/mp4',
          duration: 10,
          hasVideo: kind === 'video',
          hasAudio: true,
        },
      },
      { type: 'add_track', kind, name: trackName, id: `t${i}` },
      { type: 'add_clip', assetId, trackId: `t${i}`, start: 0 },
    );
  });
  project = applyOperations(project, ops, ctx).project;
  return project;
}

describe('picking tracks for ducking', () => {
  it('finds the music by name, by being the only audio track, or by elimination', () => {
    const named = tracksProject([
      ['Voice', 'audio', 'vo.wav'],
      ['Background', 'audio', 'song.mp3'],
    ]);
    expect(pickDuckingTracks(named).music.id).toBe('t1');
    expect(pickDuckingTracks(named).voices.map((t) => t.id)).toEqual(['t0']);

    const videoAndAudio = tracksProject([
      ['Camera', 'video', 'talk.mp4'],
      ['A', 'audio', 'x.wav'],
    ]);
    expect(pickDuckingTracks(videoAndAudio).music.id).toBe('t1');

    const twoAudio = tracksProject([
      ['A', 'audio', 'x.wav'],
      ['B', 'audio', 'y.wav'],
    ]);
    expect(() => pickDuckingTracks(twoAudio)).toThrow(/Could not tell which track holds the music/);
    expect(pickDuckingTracks(twoAudio, undefined, 't0').music.id).toBe('t1');
    expect(pickDuckingTracks(twoAudio, 't0').voices.map((t) => t.id)).toEqual(['t1']);
    expect(() => pickDuckingTracks(twoAudio, 't0', 't0')).toThrow(/no speech track besides/);

    const twoMusic = tracksProject([
      ['Music 1', 'audio', 'x.wav'],
      ['Music 2', 'audio', 'y.wav'],
    ]);
    expect(() => pickDuckingTracks(twoMusic)).toThrow(/Several tracks look like music/);

    const lonely = tracksProject([['Music', 'audio', 'x.wav']]);
    expect(() => pickDuckingTracks(lonely)).toThrow(/no speech track besides/);
  });
});

let server: RunningServer;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & {
    structuredContent?: Record<string, unknown>;
  };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r.structuredContent!;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** RMS in dBFS of PCM samples between two times. */
function rmsDb(samples: Float32Array, rate: number, from: number, to: number): number {
  const env = computeEnvelope(
    samples.subarray(Math.round(from * rate), Math.round(to * rate)),
    rate,
    to - from,
  );
  return 20 * Math.log10(env.rms[0]!);
}

describe.runIf(hasFfmpeg && hasFixtures)('duck_music and normalize_loudness (ffmpeg)', () => {
  let projectId: string;
  let toneClip: string;
  let musicTrack: string;

  beforeAll(async () => {
    const dataDir = await tempDir();
    server = await startServer(
      {
        port: 0,
        dataDir,
        mediaRoots: [FIXTURES, dataDir],
        ffmpegPath: FFMPEG,
        ffprobePath: FFPROBE,
      },
      { transcriber: new StaticTranscriber([{ text: 'Hi', start: 0.1, end: 0.5 }]) },
    );
    client = new Client({ name: 'audio-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it('ducks the tone under the beeps and both renderers follow the envelope', async () => {
    projectId = String(
      (await tool('create_project', { name: 'Ducking', width: 320, height: 180 })).projectId,
    );
    const beeps = (await tool('add_asset', { path: fixture('beeps-12s.mp4') })).asset as {
      id: string;
    };
    const tone = (await tool('add_asset', { path: fixture('tone-3s.wav') })).asset as {
      id: string;
    };
    await tool('add_clip', { assetId: beeps.id });
    toneClip = String((await tool('add_clip', { assetId: tone.id, start: 0 })).clipId);

    const ducked = await tool('duck_music', {});
    expect(ducked.source).toBe('silence');
    expect(ducked.speechRanges).toBe(4);
    expect(ducked.voiceTrackIds).toHaveLength(1);
    musicTrack = String(ducked.musicTrackId);
    const first = (ducked.firstRanges as Array<{ start: number; end: number }>)[0]!;
    expect(first.start).toBeCloseTo(0, 1);
    expect(first.end).toBeCloseTo(2, 1);
    expect(String(ducked.summary)).toMatch(/Ducked 1 clip\(s\) on track A1 by -12 dB/);

    // Re-running replaces (same envelope, not doubled).
    await tool('duck_music', { musicTrackId: musicTrack, amountDb: -12 });
    const { project } = await server.services.docs.get(projectId);
    const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === toneClip) as AudioClip;
    expect(clip.duck?.amountDb).toBe(-12);
    expect(clip.duck?.ranges).toHaveLength(2);
    const seg = resolveAudioSegments(project).find((s) => s.clipId === toneClip)!;
    expect(gainAt(seg.gain, 1)).toBeCloseTo(dbToGain(-12), 2);
    expect(gainAt(seg.gain, 2.6)).toBeCloseTo(1, 2);

    // Server renderer: render the music alone and compare levels.
    const musicOnly: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t, muted: t.id !== musicTrack })),
    };
    const out = join(await tempDir(), 'duck.mp4');
    await server.services.renderer.render(musicOnly, out, { quality: 'preview' });
    const pcm = await server.services.ffmpeg.decodePcm(out, 16000);
    const down = rmsDb(pcm, 16000, 0.5, 1.5);
    const up = rmsDb(pcm, 16000, 2.45, 2.8);
    expect(up - down).toBeGreaterThan(10);
    expect(up - down).toBeLessThan(14);

    // One undo step removes the ducking again.
    await tool('undo');
    await tool('undo');
    const undone = (await server.services.docs.get(projectId)).project;
    const plain = undone.tracks.flatMap((t) => t.clips).find((c) => c.id === toneClip) as AudioClip;
    expect(plain.duck).toBeUndefined();

    const bad = await call('duck_music', { voiceTrackId: musicTrack, musicTrackId: musicTrack });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/no speech track besides/);

    const rest = await post(`/api/projects/${projectId}/audio/duck`, { musicTrackId: musicTrack });
    expect(rest.status).toBe(200);
    expect(String(rest.body.summary)).toMatch(/Ducked 1 clip/);
  }, 120_000);

  it('uses a cached transcript when one exists', async () => {
    await tool('get_transcript', {});
    const ducked = await tool('duck_music', {});
    expect(ducked.source).toBe('transcript');
    expect(ducked.speechRanges).toBe(1);
    const silence = await tool('duck_music', { source: 'silence', thresholdDb: -40 });
    expect(silence.source).toBe('silence');
  }, 60_000);

  it('normalizes clip loudness to a target with true-peak and volume limits', async () => {
    const r = await tool('normalize_loudness', { clipIds: [toneClip] });
    const [c] = r.clips as Array<Record<string, number | string>>;
    expect(c!.measuredLufs as number).toBeCloseTo(-21.7, 0);
    expect(c!.resultLufs as number).toBeCloseTo(-14, 1);
    expect(c!.volume as number).toBeCloseTo(10 ** (7.7 / 20), 1);
    expect(c!.limitedBy).toBeUndefined();
    expect(String(r.summary)).toMatch(/Normalized 1 clip\(s\) to -14 LUFS/);

    const loud = await tool('normalize_loudness', { clipIds: [toneClip], target: -5 });
    expect((loud.clips as Array<{ limitedBy?: string; volume: number }>)[0]).toMatchObject({
      limitedBy: 'maxVolume',
      volume: 4,
    });
    expect(String(loud.summary)).toMatch(/stayed below the target/);
    const peak = await tool('normalize_loudness', {
      clipIds: [toneClip],
      target: -5,
      truePeak: -8,
    });
    const pc = (peak.clips as Array<{ limitedBy?: string; gainDb: number }>)[0]!;
    expect(pc.limitedBy).toBe('truePeak');
    expect(pc.gainDb).toBeCloseTo(10.1, 0);

    const all = await tool('normalize_loudness', { trackId: musicTrack });
    expect((all.clips as unknown[]).length).toBe(1);
    const everything = await tool('normalize_loudness', {});
    expect((everything.clips as unknown[]).length).toBe(2);

    const both = await call('normalize_loudness', { clipIds: [toneClip], trackId: musicTrack });
    expect(both.isError).toBe(true);
    const rest = await post(`/api/projects/${projectId}/audio/normalize`, { clipIds: [toneClip] });
    expect(rest.status).toBe(200);
    expect(String(rest.body.summary)).toMatch(/Normalized 1 clip/);
    const empty = await post(`/api/projects/${projectId}/audio/normalize`, { trackId: 'track_x' });
    expect(empty.status).toBe(404);
  }, 120_000);
});
