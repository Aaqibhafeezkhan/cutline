import { CutlineError } from './errors';
import type { TimeRange } from './ranges';
import { roundTime } from './time';

/**
 * Conservative default filler words (English + German). Only pure hesitation
 * sounds: words like "like", "so" or "also" carry meaning too often.
 */
export const DEFAULT_FILLERS: readonly string[] = [
  'um',
  'uh',
  'uhm',
  'uhh',
  'er',
  'erm',
  'ah',
  'hmm',
  'hm',
  'mhm',
  'äh',
  'ähm',
  'öhm',
  'öh',
];

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface FillerOptions {
  /** Words to remove (case and punctuation are ignored). Default: DEFAULT_FILLERS. */
  fillers?: readonly string[];
  /** Extra time cut on each side of a filler, never into neighbouring words. Default 0.05 s. */
  padding?: number;
  /** Merge cut ranges separated by at most this much. Default 0.2 s. */
  mergeGap?: number;
  /** Also cut immediate word repetitions ("I I think" → "I think"). Default false. */
  repeats?: boolean;
  /** Max pause between two equal words to count as a repetition. Default 1 s. */
  maxRepeatGap?: number;
}

export interface FillerMatch extends TimedWord {
  kind: 'filler' | 'repeat';
}

export interface FillerRanges {
  /** The words that will be cut, in time order. */
  matches: FillerMatch[];
  /** Merged ranges to cut (same time base as the input words). */
  ranges: TimeRange[];
}

/** Lower case, Unicode-normalized, letters and digits only: "Ähm…" → "ähm". */
export function normalizeWord(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function checkOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new CutlineError('INVALID_ARGUMENT', `${name} must be a number >= 0 (got ${value}).`, {
      hint: `Pass ${name} in seconds, e.g. ${fallback}, or omit it for the default.`,
    });
  }
  return value;
}

/**
 * Finds filler words (and optionally immediate repetitions) in timed words and
 * returns the ranges to cut. Padding is clamped so a cut never reaches into a
 * word that is kept; ranges closer than `mergeGap` are merged.
 */
export function findFillerRanges(
  words: readonly TimedWord[],
  options: FillerOptions = {},
): FillerRanges {
  const padding = checkOption('padding', options.padding, 0.05);
  const mergeGap = checkOption('mergeGap', options.mergeGap, 0.2);
  const maxRepeatGap = checkOption('maxRepeatGap', options.maxRepeatGap, 1);
  const fillers = new Set(
    (options.fillers ?? DEFAULT_FILLERS).map(normalizeWord).filter((w) => w.length > 0),
  );

  const sorted = words
    .filter((w) => normalizeWord(w.text).length > 0)
    .sort((a, b) => a.start - b.start);
  const norm = sorted.map((w) => normalizeWord(w.text));
  const kind: Array<FillerMatch['kind'] | null> = norm.map((n) =>
    fillers.has(n) ? 'filler' : null,
  );
  if (options.repeats) {
    // "I I think": cut the earlier copy, keep the one that flows into the next word.
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (
        kind[i] === null &&
        kind[i + 1] === null &&
        norm[i] === norm[i + 1] &&
        sorted[i + 1]!.start - sorted[i]!.end <= maxRepeatGap
      ) {
        kind[i] = 'repeat';
      }
    }
  }

  const matches: FillerMatch[] = [];
  const raw: TimeRange[] = [];
  let prevKeptEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    const k = kind[i];
    if (!k) {
      prevKeptEnd = Math.max(prevKeptEnd, w.end);
      continue;
    }
    let nextKeptStart = Infinity;
    for (let j = i + 1; j < sorted.length; j++) {
      if (!kind[j]) {
        nextKeptStart = sorted[j]!.start;
        break;
      }
    }
    matches.push({ text: w.text, start: w.start, end: w.end, kind: k });
    const start = Math.max(prevKeptEnd, w.start - padding);
    const end = Math.min(nextKeptStart, w.end + padding);
    if (end - start > 0.01) raw.push({ start, end });
  }

  const ranges: TimeRange[] = [];
  for (const r of raw) {
    const last = ranges[ranges.length - 1];
    if (last && r.start - last.end <= mergeGap) last.end = Math.max(last.end, r.end);
    else ranges.push({ ...r });
  }
  return {
    matches,
    ranges: ranges.map((r) => ({ start: roundTime(r.start), end: roundTime(r.end) })),
  };
}
