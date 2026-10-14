import { CutlineError } from './errors';
import { normalizeWord, type TimedWord } from './fillers';
import type { TimeRange } from './ranges';
import { roundTime } from './time';

/** An inclusive range of word indexes (positions in a time-ordered word list). */
export interface WordSelection {
  start: number;
  end: number;
}

export interface WordCutOptions {
  /** Extra time cut on each side of a deleted run, never into kept words. Default 0.05 s. */
  padding?: number;
  /** Merge cut ranges separated by at most this much. Default 0.2 s. */
  mergeGap?: number;
}

function checkSeconds(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new CutlineError('INVALID_ARGUMENT', `${name} must be a number >= 0 (got ${value}).`, {
      hint: `Pass ${name} in seconds, e.g. ${fallback}, or omit it for the default.`,
    });
  }
  return value;
}

function checkSelection(sel: WordSelection, count: number): void {
  const valid =
    Number.isInteger(sel.start) &&
    Number.isInteger(sel.end) &&
    sel.start >= 0 &&
    sel.start <= sel.end &&
    sel.end < count;
  if (!valid) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Word selection ${sel.start}..${sel.end} is not valid for ${count} word(s).`,
      {
        hint:
          count === 0
            ? 'The transcript has no words; there is nothing to delete.'
            : `Use whole word indexes with 0 <= start <= end <= ${count - 1} (inclusive).`,
      },
    );
  }
}

/**
 * Turns selected words (index ranges into time-ordered `words`) into the
 * timeline ranges that remove them. Each contiguous run of selected words
 * becomes one cut from its first word to its last (pauses inside the run go
 * too); padding is clamped so kept neighbours are never cut, and cuts closer
 * than `mergeGap` are merged. Pass the result to `delete_range`.
 */
export function wordRangesToCuts(
  words: readonly TimedWord[],
  selection: WordSelection | readonly WordSelection[],
  options: WordCutOptions = {},
): TimeRange[] {
  const padding = checkSeconds('padding', options.padding, 0.05);
  const mergeGap = checkSeconds('mergeGap', options.mergeGap, 0.2);
  const selections: readonly WordSelection[] = Array.isArray(selection)
    ? selection
    : [selection as WordSelection];
  const cut = new Array<boolean>(words.length).fill(false);
  for (const sel of selections) {
    checkSelection(sel, words.length);
    for (let i = sel.start; i <= sel.end; i++) cut[i] = true;
  }

  const raw: TimeRange[] = [];
  let prevKeptEnd = 0;
  for (let i = 0; i < words.length; i++) {
    if (!cut[i]) {
      prevKeptEnd = Math.max(prevKeptEnd, words[i]!.end);
      continue;
    }
    let j = i;
    while (j + 1 < words.length && cut[j + 1]) j++;
    const first = words[i]!;
    const last = words[j]!;
    const nextKeptStart = j + 1 < words.length ? words[j + 1]!.start : Infinity;
    const start = Math.max(prevKeptEnd, first.start - padding, 0);
    const end = Math.min(nextKeptStart, last.end + padding);
    if (end > start) raw.push({ start, end });
    i = j;
  }

  const ranges: TimeRange[] = [];
  for (const r of raw) {
    const prev = ranges[ranges.length - 1];
    if (prev && r.start - prev.end <= mergeGap) prev.end = Math.max(prev.end, r.end);
    else ranges.push({ ...r });
  }
  return ranges.map((r) => ({ start: roundTime(r.start), end: roundTime(r.end) }));
}

/**
 * Finds every non-overlapping occurrence of `phrase` in time-ordered words.
 * Matching ignores case and punctuation ("As I said," matches "as i said").
 * Returns inclusive word index ranges in order of appearance.
 */
export function findPhraseInWords(words: readonly TimedWord[], phrase: string): WordSelection[] {
  const tokens = phrase
    .split(/\s+/)
    .map(normalizeWord)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new CutlineError('INVALID_ARGUMENT', `"${phrase}" contains no words to search for.`, {
      hint: 'Pass the exact words to find, e.g. "as I said before".',
    });
  }
  const index: number[] = [];
  const norms: string[] = [];
  words.forEach((w, i) => {
    const n = normalizeWord(w.text);
    if (n) {
      index.push(i);
      norms.push(n);
    }
  });
  const found: WordSelection[] = [];
  for (let i = 0; i + tokens.length <= norms.length; i++) {
    if (tokens.every((t, k) => norms[i + k] === t)) {
      found.push({ start: index[i]!, end: index[i + tokens.length - 1]! });
      i += tokens.length - 1;
    }
  }
  return found;
}

export interface ParagraphOptions {
  /** Start a new paragraph after a pause longer than this. Default 1.2 s. */
  maxGap?: number;
  /** After this many words, break at the next sentence end. Default 40. */
  sentenceBreakAfter?: number;
}

/**
 * Groups time-ordered words into paragraphs for display: a new paragraph
 * starts after a long pause, or at a sentence end once a paragraph is long.
 */
export function groupParagraphs(
  words: readonly TimedWord[],
  options: ParagraphOptions = {},
): WordSelection[] {
  const maxGap = options.maxGap ?? 1.2;
  const sentenceBreakAfter = options.sentenceBreakAfter ?? 40;
  const out: WordSelection[] = [];
  let start = 0;
  for (let i = 1; i <= words.length; i++) {
    const prev = words[i - 1]!;
    const next = words[i];
    const pause = next !== undefined && next.start - prev.end > maxGap;
    const sentence = i - start >= sentenceBreakAfter && /[.!?…]["')\]]*$/.test(prev.text);
    if (next === undefined || pause || sentence) {
      out.push({ start, end: i - 1 });
      start = i;
    }
  }
  return out;
}
