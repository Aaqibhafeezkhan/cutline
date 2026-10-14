import {
  findFillerRanges,
  mapWordsToTimeline,
  round3,
  type Asset,
  type FillerMatch,
  type Project,
  type FillerOptions,
  type TimeRange,
  type Word,
} from '@cutline/core';
import type { Services } from '../services';

export interface FillerCut {
  /** Filler words found (timeline seconds, rounded to ms). */
  found: FillerMatch[];
  /** Merged timeline ranges to pass to delete_range. */
  ranges: TimeRange[];
  /** Total seconds the cut removes. */
  removed: number;
}

/** Timeline words → filler words and the ranges that remove them. */
export function planFillerCut(words: readonly Word[], options: FillerOptions = {}): FillerCut {
  const { matches, ranges } = findFillerRanges(words, options);
  return {
    found: matches.map((m) => ({ ...m, start: round3(m.start), end: round3(m.end) })),
    ranges,
    removed: round3(ranges.reduce((s, r) => s + r.end - r.start, 0)),
  };
}

export interface TranscriptProgress {
  update(fraction: number, message: string): void;
}

/**
 * Transcribes every audible asset used on the timeline (cached per asset)
 * and maps the words to timeline time through the clips that use them.
 */
export async function transcribeTimeline(
  services: Services,
  projectId: string,
  options: { language?: string; signal?: AbortSignal; progress?: TranscriptProgress } = {},
): Promise<Word[]> {
  const { docs, analysis } = services;
  const { project } = await docs.get(projectId);
  const audible = audibleAssets(project);
  const byAsset = new Map<string, Word[]>();
  for (const [i, asset] of audible.entries()) {
    options.progress?.update(i / Math.max(1, audible.length), `Transcribing ${asset.name}…`);
    byAsset.set(
      asset.id,
      await analysis.transcript(asset, { language: options.language, signal: options.signal }),
    );
  }
  // Re-read: the timeline may have changed while transcribing.
  const latest = (await docs.get(projectId)).project;
  return mapWordsToTimeline(latest, byAsset);
}

/** Assets with audio that an unmuted clip on an unmuted track plays. */
function audibleAssets(project: Project): Asset[] {
  const used = new Set(
    project.tracks.flatMap((t) =>
      t.muted
        ? []
        : t.clips.flatMap((c) =>
            (c.type === 'video' || c.type === 'audio') && !c.muted ? [c.assetId] : [],
          ),
    ),
  );
  return project.assets.filter((a) => used.has(a.id) && a.hasAudio);
}

export interface TranscriptSources {
  /** Source-time words per audible asset (map them with mapWordsToTimeline). */
  byAsset: Record<string, Word[]>;
  /** Audible assets without a cached transcript yet. */
  missing: string[];
  /** The words mapped onto the current timeline. */
  words: Word[];
}

/**
 * Per-asset transcripts of the audible assets, so the editor can re-map them
 * onto the timeline after every edit without asking the server again. Without
 * `transcribe` only cached transcripts are returned (fast, never runs Whisper).
 */
export async function timelineTranscriptSources(
  services: Services,
  projectId: string,
  options: { transcribe?: boolean; progress?: TranscriptProgress } = {},
): Promise<TranscriptSources> {
  const { docs, analysis } = services;
  const { project } = await docs.get(projectId);
  const audible = audibleAssets(project);
  const byAsset = new Map<string, Word[]>();
  const missing: string[] = [];
  for (const [i, asset] of audible.entries()) {
    let words = await analysis.cachedTranscript(asset);
    if (!words && options.transcribe) {
      options.progress?.update(i / Math.max(1, audible.length), `Transcribing ${asset.name}…`);
      words = await analysis.transcript(asset);
    }
    if (words) byAsset.set(asset.id, words);
    else missing.push(asset.id);
  }
  const latest = (await docs.get(projectId)).project;
  return {
    byAsset: Object.fromEntries(byAsset),
    missing,
    words: mapWordsToTimeline(latest, byAsset),
  };
}
