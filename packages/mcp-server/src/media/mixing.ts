import {
  CutlineError,
  detectSilences,
  findClip,
  findTrack,
  invertRanges,
  isAudibleClip,
  mapWordsToTimeline,
  projectDuration,
  round3,
  timelineEnvelope,
  type Project,
  type TimeRange,
  type Track,
  type VideoClip,
  type AudioClip,
  type Word,
} from '@cutline/core';
import type { Services } from '../services';

// ---------------------------------------------------------------------------
// Ducking: music gets quieter while someone speaks
// ---------------------------------------------------------------------------

const MUSIC_NAME = /music|musik|song|bgm|soundtrack|score|instrumental|backing|beat/i;

export interface DuckOptions {
  musicTrackId?: string;
  voiceTrackId?: string;
  amountDb?: number;
  attack?: number;
  release?: number;
  /** Where speech comes from: cached transcript if available (auto), loudness, or a transcript. */
  source?: 'auto' | 'silence' | 'transcript';
  /** Voice level counted as silence, dBFS (default -40). */
  thresholdDb?: number;
}

export interface DuckPlan {
  operation: {
    type: 'duck_audio';
    trackId: string;
    ranges: TimeRange[];
    amountDb?: number;
    attack?: number;
    release?: number;
  };
  music: Track;
  voices: Track[];
  ranges: TimeRange[];
  source: 'silence' | 'transcript';
}

function hasAudibleMaterial(project: Project, track: Track): boolean {
  return (
    track.kind !== 'caption' &&
    !track.muted &&
    track.clips.some(
      (c) =>
        isAudibleClip(c) &&
        !c.muted &&
        project.assets.some((a) => a.id === c.assetId && a.hasAudio),
    )
  );
}

function looksLikeMusic(project: Project, track: Track): boolean {
  if (MUSIC_NAME.test(track.name)) return true;
  return track.clips.some(
    (c) =>
      isAudibleClip(c) &&
      MUSIC_NAME.test(project.assets.find((a) => a.id === c.assetId)?.name ?? ''),
  );
}

const describeTracks = (tracks: readonly Track[]) =>
  tracks.map((t) => `${t.name} (${t.id}, ${t.kind})`).join(', ') || 'none';

/**
 * Picks the music track (to duck) and the voice tracks (speech source).
 * Music: the given track, else the one audible track named like music, else
 * the only audio track next to other audible tracks. Voice: the given track,
 * else every other audible track.
 */
export function pickDuckingTracks(
  project: Project,
  musicTrackId?: string,
  voiceTrackId?: string,
): { music: Track; voices: Track[] } {
  const audible = project.tracks.filter((t) => hasAudibleMaterial(project, t));
  const voiceGiven = voiceTrackId ? findTrack(project, voiceTrackId) : undefined;
  let music: Track | undefined;
  if (musicTrackId) {
    music = findTrack(project, musicTrackId);
  } else {
    const pool = audible.filter((t) => t.id !== voiceTrackId);
    const named = pool.filter((t) => looksLikeMusic(project, t));
    const audioOnly = pool.filter((t) => t.kind === 'audio');
    if (named.length === 1) music = named[0];
    else if (named.length === 0 && voiceGiven && pool.length === 1) music = pool[0];
    else if (named.length === 0 && audioOnly.length === 1 && audible.length > 1)
      music = audioOnly[0];
    if (!music) {
      throw new CutlineError(
        'INVALID_ARGUMENT',
        named.length > 1
          ? `Several tracks look like music: ${describeTracks(named)}.`
          : `Could not tell which track holds the music. Audible tracks: ${describeTracks(audible)}.`,
        {
          hint: 'Pass musicTrackId (the track to make quieter) and, if needed, voiceTrackId (the track with speech).',
        },
      );
    }
  }
  const voices = voiceGiven ? [voiceGiven] : audible.filter((t) => t.id !== music.id);
  if (voices.length === 0 || voices.some((v) => v.id === music.id)) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `There is no speech track besides the music track ${music.name} (${music.id}).`,
      {
        hint: `Add the voice-over or video with speech first, or pass voiceTrackId. Audible tracks: ${describeTracks(audible)}.`,
      },
    );
  }
  return { music, voices };
}

/** Speech ranges (timeline time) of the given voice tracks. */
export async function detectSpeech(
  services: Services,
  project: Project,
  voices: readonly Track[],
  options: { source?: DuckOptions['source']; thresholdDb?: number; signal?: AbortSignal } = {},
): Promise<{ ranges: TimeRange[]; source: 'silence' | 'transcript' }> {
  const ids = new Set(voices.map((t) => t.id));
  // Only the voice tracks, unmuted: what would be heard from them alone.
  const voiceOnly: Project = {
    ...project,
    tracks: project.tracks.filter((t) => ids.has(t.id)).map((t) => ({ ...t, muted: false })),
  };
  const assets = project.assets.filter(
    (a) =>
      a.hasAudio && voices.some((t) => t.clips.some((c) => 'assetId' in c && c.assetId === a.id)),
  );
  const mode = options.source ?? 'auto';
  if (mode !== 'silence') {
    const byAsset = new Map<string, Word[]>();
    for (const asset of assets) {
      const words =
        mode === 'transcript'
          ? await services.analysis.transcript(asset, { signal: options.signal })
          : await services.analysis.cachedTranscript(asset);
      if (words) byAsset.set(asset.id, words);
    }
    if (mode === 'transcript' || (assets.length > 0 && byAsset.size === assets.length)) {
      const ranges = mapWordsToTimeline(voiceOnly, byAsset).map((w) => ({
        start: w.start,
        end: w.end,
      }));
      return { ranges, source: 'transcript' };
    }
  }
  const duration = projectDuration(project);
  const env = timelineEnvelope(
    voiceOnly,
    await services.analysis.envelopes(voiceOnly, options.signal),
    0.01,
    duration,
  );
  const silences = detectSilences(env, {
    thresholdDb: options.thresholdDb ?? -40,
    minDuration: 0.3,
    padding: 0,
  });
  const ranges = invertRanges(silences, 0, duration)
    .filter((r) => r.end - r.start >= 0.05)
    .map((r) => ({ start: round3(r.start), end: round3(r.end) }));
  return { ranges, source: 'silence' };
}

/** Finds speech and builds the duck_audio operation for the music track. */
export async function planDucking(
  services: Services,
  projectId: string,
  options: DuckOptions = {},
  signal?: AbortSignal,
): Promise<DuckPlan> {
  const { project } = await services.docs.get(projectId);
  const { music, voices } = pickDuckingTracks(project, options.musicTrackId, options.voiceTrackId);
  const { ranges, source } = await detectSpeech(services, project, voices, {
    source: options.source,
    thresholdDb: options.thresholdDb,
    signal,
  });
  if (ranges.length === 0) {
    throw new CutlineError('INVALID_OPERATION', `No speech found on ${describeTracks(voices)}.`, {
      hint: 'Check that the voice clips are audible, lower thresholdDb (e.g. -50), or pass voiceTrackId.',
    });
  }
  return {
    operation: {
      type: 'duck_audio',
      trackId: music.id,
      ranges,
      ...(options.amountDb !== undefined && { amountDb: options.amountDb }),
      ...(options.attack !== undefined && { attack: options.attack }),
      ...(options.release !== undefined && { release: options.release }),
    },
    music,
    voices,
    ranges,
    source,
  };
}

// ---------------------------------------------------------------------------
// Loudness normalization
// ---------------------------------------------------------------------------

export interface LoudnessOptions {
  clipIds?: string[];
  trackId?: string;
  /** Integrated loudness target, LUFS (default -14). */
  target?: number;
  /** True-peak ceiling, dBTP (default -1). */
  truePeak?: number;
}

export interface ClipLoudness {
  clipId: string;
  trackId: string;
  /** Measured integrated loudness of the clip's source range, LUFS. */
  measuredLufs: number;
  measuredTruePeak: number | null;
  previousVolume: number;
  volume: number;
  gainDb: number;
  /** Expected loudness after the change, LUFS. */
  resultLufs: number;
  limitedBy?: 'truePeak' | 'maxVolume';
  skipped?: string;
}

export interface LoudnessPlan {
  operations: Array<{ type: 'set_volume'; clipId: string; volume: number }>;
  clips: ClipLoudness[];
  target: number;
  truePeak: number;
}

const MAX_VOLUME = 4;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Measures each clip's source loudness and computes the clip volume that hits the target. */
export async function planLoudness(
  services: Services,
  projectId: string,
  options: LoudnessOptions = {},
  signal?: AbortSignal,
): Promise<LoudnessPlan> {
  const { project } = await services.docs.get(projectId);
  const target = options.target ?? -14;
  const ceiling = options.truePeak ?? -1;
  let selected: Array<{ track: Track; clip: VideoClip | AudioClip }>;
  if (options.clipIds?.length) {
    selected = options.clipIds.map((id) => {
      const { track, clip } = findClip(project, id);
      if (!isAudibleClip(clip)) {
        throw new CutlineError(
          'INVALID_ARGUMENT',
          `Clip ${id} is a ${clip.type} clip without audio.`,
          {
            hint: 'Pass audio or video clips (see get_project).',
          },
        );
      }
      return { track, clip };
    });
  } else {
    const tracks = options.trackId
      ? [findTrack(project, options.trackId)]
      : project.tracks.filter((t) => !t.locked);
    selected = tracks.flatMap((track) =>
      track.clips.filter(isAudibleClip).map((clip) => ({ track, clip })),
    );
  }
  if (selected.length === 0) {
    throw new CutlineError('INVALID_OPERATION', 'There are no audio or video clips to normalize.', {
      hint: 'Add clips with sound first, or pass clipIds / trackId.',
    });
  }

  const clips: ClipLoudness[] = [];
  const operations: LoudnessPlan['operations'] = [];
  for (const { track, clip } of selected) {
    const asset = project.assets.find((a) => a.id === clip.assetId);
    const base = {
      clipId: clip.id,
      trackId: track.id,
      previousVolume: clip.volume,
      volume: clip.volume,
      gainDb: 0,
    };
    if (!asset?.hasAudio || asset.duration === null) {
      clips.push({
        ...base,
        measuredLufs: -70,
        measuredTruePeak: null,
        resultLufs: -70,
        skipped: 'no audio',
      });
      continue;
    }
    const duration = Math.min(clip.duration, asset.duration - clip.sourceStart);
    const m = await services.analysis.loudness(asset, clip.sourceStart, duration, signal);
    if (m.integrated <= -69) {
      clips.push({
        ...base,
        measuredLufs: m.integrated,
        measuredTruePeak: m.truePeak,
        resultLufs: m.integrated,
        skipped: 'silent or too short to measure (below the -70 LUFS gate)',
      });
      continue;
    }
    let gainDb = target - m.integrated;
    let limitedBy: ClipLoudness['limitedBy'];
    if (m.truePeak !== null && m.truePeak + gainDb > ceiling) {
      gainDb = ceiling - m.truePeak;
      limitedBy = 'truePeak';
    }
    let volume = 10 ** (gainDb / 20);
    if (volume > MAX_VOLUME) {
      volume = MAX_VOLUME;
      limitedBy = 'maxVolume';
    }
    volume = Math.round(volume * 1e4) / 1e4;
    const applied = 20 * Math.log10(volume);
    clips.push({
      ...base,
      measuredLufs: m.integrated,
      measuredTruePeak: m.truePeak,
      volume,
      gainDb: r2(applied),
      resultLufs: r2(m.integrated + applied),
      ...(limitedBy && { limitedBy }),
    });
    operations.push({ type: 'set_volume', clipId: clip.id, volume });
  }
  return { operations, clips, target, truePeak: ceiling };
}

/** One-line human summary of a loudness plan. */
export function describeLoudness(plan: LoudnessPlan): string {
  const done = plan.clips.filter((c) => !c.skipped);
  const limited = done.filter((c) => c.limitedBy);
  const skipped = plan.clips.length - done.length;
  return [
    `Normalized ${done.length} clip(s) to ${plan.target} LUFS (true peak ≤ ${plan.truePeak} dBTP).`,
    limited.length
      ? `${limited.length} clip(s) stayed below the target to avoid clipping (true peak or max volume ×${MAX_VOLUME}).`
      : '',
    skipped ? `Skipped ${skipped} silent clip(s).` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
