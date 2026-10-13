import { describe, expect, it } from 'vitest';
import { CutlineError, DEFAULT_FILLERS, findFillerRanges, normalizeWord } from '../src';

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe('normalizeWord', () => {
  it('ignores case, punctuation and Unicode composition', () => {
    expect(normalizeWord('Um,')).toBe('um');
    expect(normalizeWord('…Ähm!')).toBe('ähm');
    expect(normalizeWord('Ähm')).toBe('ähm');
    expect(normalizeWord('--')).toBe('');
  });
});

describe('findFillerRanges', () => {
  it('finds default English and German fillers with padding', () => {
    const r = findFillerRanges([
      w('So', 0, 0.3),
      w('Um,', 1, 1.3),
      w('we', 2, 2.2),
      w('ÄH', 3, 3.2),
      w('go.', 4, 4.4),
    ]);
    expect(r.matches).toEqual([
      { text: 'Um,', start: 1, end: 1.3, kind: 'filler' },
      { text: 'ÄH', start: 3, end: 3.2, kind: 'filler' },
    ]);
    expect(r.ranges).toEqual([
      { start: 0.95, end: 1.35 },
      { start: 2.95, end: 3.25 },
    ]);
    expect(DEFAULT_FILLERS).toContain('ähm');
  });

  it('clamps padding so neighbouring words are never cut', () => {
    const r = findFillerRanges([w('Hello', 0, 0.98), w('uh', 1, 1.2), w('there', 1.22, 1.5)], {
      padding: 0.1,
    });
    expect(r.ranges).toEqual([{ start: 0.98, end: 1.22 }]);
  });

  it('skips a filler whose span is entirely covered by kept words', () => {
    const r = findFillerRanges([w('long', 0, 2), w('um', 1, 1.5), w('next', 1.5, 2)]);
    expect(r.matches).toHaveLength(1);
    expect(r.ranges).toEqual([]);
  });

  it('merges consecutive fillers and close ranges, keeps distant ones apart', () => {
    const words = [w('um', 0.5, 0.7), w('uh', 0.75, 0.9), w('yes', 1, 1.2), w('hmm', 1.6, 1.8)];
    expect(findFillerRanges(words).ranges).toEqual([
      { start: 0.45, end: 0.95 },
      { start: 1.55, end: 1.85 },
    ]);
    expect(findFillerRanges(words, { mergeGap: 1, padding: 0 }).ranges).toEqual([
      { start: 0.5, end: 1.8 },
    ]);
    // A trailing filler without a following word is padded freely.
    expect(findFillerRanges([w('end', 0, 1), w('ähm', 2, 2.3)]).ranges).toEqual([
      { start: 1.95, end: 2.35 },
    ]);
  });

  it('uses a custom filler list and ignores empty entries and empty words', () => {
    const words = [w('like', 0, 0.2), w('...', 0.3, 0.4), w('um', 0.5, 0.6), w('cool', 0.7, 1)];
    const r = findFillerRanges(words, { fillers: ['Like', '?!'], padding: 0 });
    expect(r.matches.map((m) => m.text)).toEqual(['like']);
    expect(r.ranges).toEqual([{ start: 0, end: 0.2 }]);
  });

  it('sorts unsorted input', () => {
    const r = findFillerRanges([w('two', 2, 2.5), w('uh', 1, 1.2), w('one', 0, 0.5)], {
      padding: 0,
    });
    expect(r.ranges).toEqual([{ start: 1, end: 1.2 }]);
  });

  it('optionally cuts immediate repetitions', () => {
    const words = [
      w('I', 0, 0.1),
      w('I', 0.2, 0.3),
      w('i,', 0.4, 0.5),
      w('think', 0.6, 0.9),
      w('um', 1, 1.1),
      w('um', 1.2, 1.3),
      w('that', 1.4, 1.6),
      w('that', 3, 3.2),
      w('works', 3.3, 3.6),
    ];
    expect(findFillerRanges(words, { padding: 0 }).matches.map((m) => m.kind)).toEqual([
      'filler',
      'filler',
    ]);
    const r = findFillerRanges(words, { repeats: true, padding: 0, mergeGap: 0 });
    expect(r.matches.map((m) => [m.text, m.kind])).toEqual([
      ['I', 'repeat'],
      ['I', 'repeat'],
      ['um', 'filler'],
      ['um', 'filler'],
    ]);
    expect(r.ranges).toEqual([
      { start: 0, end: 0.1 },
      { start: 0.2, end: 0.3 },
      { start: 1, end: 1.1 },
      { start: 1.2, end: 1.3 },
    ]);
    // "that … that" with a long pause is not a stutter unless maxRepeatGap allows it.
    const loose = findFillerRanges(words, { repeats: true, maxRepeatGap: 2, padding: 0 });
    expect(loose.matches.map((m) => m.text)).toContain('that');
  });

  it('rejects negative options with a hint', () => {
    expect(() => findFillerRanges([], { padding: -1 })).toThrow(CutlineError);
    expect(() => findFillerRanges([], { mergeGap: Number.NaN })).toThrow(/mergeGap must be/);
    expect(findFillerRanges([])).toEqual({ matches: [], ranges: [] });
  });
});
