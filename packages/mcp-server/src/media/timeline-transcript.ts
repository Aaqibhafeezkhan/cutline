import {
  findFillerRanges,
  mapWordsToTimeline,
  round3,
  type FillerMatch,
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
  const used = new Set(
    project.tracks.flatMap((t) =>
      t.muted
        ? []
        : t.clips.flatMap((c) =>
            (c.type === 'video' || c.type === 'audio') && !c.muted ? [c.assetId] : [],
          ),
    ),
  );
  const audible = project.assets.filter((a) => used.has(a.id) && a.hasAudio);
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
