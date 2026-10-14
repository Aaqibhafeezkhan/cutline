import type { WaveformBucket, WaveformSummary } from './analysis';
import { round3 } from './time';

export interface OutlineSentence {
  start: number;
  end: number;
  text: string;
}

export interface OutlineBlock {
  start: number;
  end: number;
  text: string;
}

export interface OutlineOptions {
  /** A block closes at the first good break after this many seconds (default 20). */
  minDuration?: number;
  /** A block never grows beyond this many seconds if it can be avoided (default 60). */
  maxDuration?: number;
  /** Times of natural breaks (scene cuts, silences) that make good block boundaries. */
  breaks?: readonly number[];
  /** A pause between sentences at least this long is a good break (default 1 s). */
  pause?: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Groups transcript sentences into ~20–60 s blocks for an LLM outline. A
 * block closes after `minDuration` at the first sentence end, pause, scene
 * cut or silence, and before a sentence would push it past `maxDuration`.
 */
export function groupIntoBlocks(
  sentences: readonly OutlineSentence[],
  options: OutlineOptions = {},
): OutlineBlock[] {
  const min = options.minDuration ?? 20;
  const max = options.maxDuration ?? 60;
  const pause = options.pause ?? 1;
  const breaks = options.breaks ?? [];
  const sorted = [...sentences].sort((a, b) => a.start - b.start);
  const blocks: OutlineBlock[] = [];
  let current: OutlineSentence[] = [];
  const close = () => {
    blocks.push({
      start: round3(current[0]!.start),
      end: round3(current[current.length - 1]!.end),
      text: current.map((s) => s.text).join(' '),
    });
    current = [];
  };
  sorted.forEach((s, i) => {
    if (current.length && s.end - current[0]!.start > max) close();
    current.push(s);
    const next = sorted[i + 1];
    if (!next) return close();
    if (s.end - current[0]!.start < min) return;
    const natural =
      SENTENCE_END.test(s.text.trim()) ||
      next.start - s.end >= pause ||
      breaks.some((b) => b >= s.end - 0.25 && b <= next.start + 0.25);
    if (natural) close();
  });
  return blocks;
}

/** The loudest buckets (at least `aboveDb` over the average), in time order. */
export function loudnessPeaks(summary: WaveformSummary, count = 5, aboveDb = 3): WaveformBucket[] {
  return summary.buckets
    .filter((b) => b.rmsDb >= summary.rmsDb + aboveDb)
    .sort((a, b) => b.rmsDb - a.rmsDb)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
}
