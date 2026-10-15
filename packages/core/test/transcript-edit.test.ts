import { describe, expect, it } from 'vitest';
import { CutlineError, findPhraseInWords, groupParagraphs, wordRangesToCuts } from '../src';

const w = (text: string, start: number, end: number) => ({ text, start, end });

// "So as I said before, we go."
const words = [
  w('So', 0, 0.3),
  w('as', 1, 1.2),
  w('I', 1.25, 1.3),
  w('said', 1.35, 1.6),
  w('before,', 1.65, 2),
  w('we', 3, 3.2),
  w('go.', 3.3, 3.6),
];

describe('wordRangesToCuts', () => {
  it('cuts a contiguous run as one range including inner pauses, with padding', () => {
    expect(wordRangesToCuts(words, { start: 1, end: 4 })).toEqual([{ start: 0.95, end: 2.05 }]);
    expect(wordRangesToCuts(words, [{ start: 4, end: 5 }])).toEqual([{ start: 1.6, end: 3.25 }]);
  });

  it('clamps padding to kept neighbours and to zero', () => {
    expect(wordRangesToCuts(words, { start: 2, end: 2 }, { padding: 0.1 })).toEqual([
      { start: 1.2, end: 1.35 },
    ]);
    expect(wordRangesToCuts(words, { start: 0, end: 0 }, { padding: 0.5 })).toEqual([
      { start: 0, end: 0.8 },
    ]);
    expect(wordRangesToCuts(words, { start: 6, end: 6 })).toEqual([{ start: 3.25, end: 3.65 }]);
  });

  it('merges close cuts, keeps distant ones apart and accepts overlapping selections', () => {
    expect(
      wordRangesToCuts(words, [
        { start: 1, end: 1 },
        { start: 3, end: 3 },
      ]),
    ).toEqual([{ start: 0.95, end: 1.65 }]);
    expect(
      wordRangesToCuts(
        words,
        [
          { start: 1, end: 1 },
          { start: 3, end: 3 },
        ],
        { padding: 0, mergeGap: 0 },
      ),
    ).toEqual([
      { start: 1, end: 1.2 },
      { start: 1.35, end: 1.6 },
    ]);
    expect(
      wordRangesToCuts(words, [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 6, end: 6 },
      ]),
    ).toEqual([
      { start: 0, end: 1.65 },
      { start: 3.25, end: 3.65 },
    ]);
  });

  it('skips runs squeezed to nothing by overlapping kept words', () => {
    const odd = [w('a', 0, 2), w('b', 1, 1.5), w('c', 1.2, 3)];
    expect(wordRangesToCuts(odd, { start: 1, end: 1 })).toEqual([]);
  });

  it('rejects bad selections and options with hints', () => {
    for (const sel of [
      { start: -1, end: 0 },
      { start: 2, end: 1 },
      { start: 0, end: 7 },
      { start: 0.5, end: 1 },
      { start: 0, end: 1.5 },
    ]) {
      expect(() => wordRangesToCuts(words, sel)).toThrow(CutlineError);
    }
    try {
      wordRangesToCuts([], { start: 0, end: 0 });
      expect.unreachable();
    } catch (err) {
      expect((err as CutlineError).hint).toMatch(/no words/);
    }
    expect(() => wordRangesToCuts(words, { start: 0, end: 0 }, { padding: -1 })).toThrow(/padding/);
    expect(() => wordRangesToCuts(words, { start: 0, end: 0 }, { mergeGap: NaN })).toThrow(
      /mergeGap/,
    );
    expect(wordRangesToCuts(words, [])).toEqual([]);
  });
});

describe('findPhraseInWords', () => {
  it('finds phrases ignoring case and punctuation, skipping punctuation-only words', () => {
    expect(findPhraseInWords(words, 'As I said before')).toEqual([{ start: 1, end: 4 }]);
    expect(findPhraseInWords(words, '  go!  ')).toEqual([{ start: 6, end: 6 }]);
    const withDash = [w('well', 0, 1), w('—', 1, 1.1), w('yes', 1.2, 2)];
    expect(findPhraseInWords(withDash, 'well yes')).toEqual([{ start: 0, end: 2 }]);
    expect(findPhraseInWords(words, 'nothing here')).toEqual([]);
  });

  it('returns all non-overlapping occurrences', () => {
    const rep = [w('na', 0, 1), w('na', 1, 2), w('na', 2, 3), w('hey', 3, 4)];
    expect(findPhraseInWords(rep, 'na na')).toEqual([{ start: 0, end: 1 }]);
    expect(findPhraseInWords(rep, 'na')).toHaveLength(3);
  });

  it('rejects a phrase without words', () => {
    expect(() => findPhraseInWords(words, ' ... ')).toThrow(/no words/);
  });
});

describe('groupParagraphs', () => {
  it('breaks at long pauses', () => {
    expect(groupParagraphs(words, { maxGap: 0.6 })).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    expect(groupParagraphs(words)).toEqual([{ start: 0, end: 6 }]);
    expect(groupParagraphs([])).toEqual([]);
  });

  it('breaks long paragraphs at sentence ends', () => {
    const long = Array.from({ length: 6 }, (_, i) => w(i % 3 === 2 ? 'end."' : 'word', i, i + 0.9));
    expect(groupParagraphs(long, { sentenceBreakAfter: 2 })).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});
