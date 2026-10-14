import { describe, expect, it } from 'vitest';
import type { Project } from '@cutline/core';
import { audibleAssetKey, orderedRange, wordIndexAt } from './transcript';

const words = [
  { text: 'a', start: 0, end: 0.5 },
  { text: 'b', start: 0.6, end: 1 },
  { text: 'c', start: 2, end: 2.5 },
];

describe('transcript panel helpers', () => {
  it('finds the word under the playhead', () => {
    expect(wordIndexAt(words, 0)).toBe(0);
    expect(wordIndexAt(words, 0.7)).toBe(1);
    expect(wordIndexAt(words, 2.49)).toBe(2);
    expect(wordIndexAt(words, 1.5)).toBe(-1);
    expect(wordIndexAt(words, 2.5)).toBe(-1);
    expect(wordIndexAt([], 1)).toBe(-1);
  });

  it('orders a selection', () => {
    expect(orderedRange({ anchor: 4, focus: 1 })).toEqual({ start: 1, end: 4 });
    expect(orderedRange({ anchor: 2, focus: 2 })).toEqual({ start: 2, end: 2 });
  });

  it('keys the audible assets of a project', () => {
    const project = {
      assets: [
        { id: 'asset_b', hasAudio: true },
        { id: 'asset_a', hasAudio: true },
        { id: 'asset_img', hasAudio: false },
        { id: 'asset_muted', hasAudio: true },
        { id: 'asset_unused', hasAudio: true },
      ],
      tracks: [
        {
          muted: false,
          clips: [
            { type: 'video', assetId: 'asset_b', muted: false },
            { type: 'image', assetId: 'asset_img' },
            { type: 'audio', assetId: 'asset_a', muted: false },
            { type: 'audio', assetId: 'asset_muted', muted: true },
            { type: 'text' },
          ],
        },
        { muted: true, clips: [{ type: 'audio', assetId: 'asset_unused', muted: false }] },
      ],
    } as unknown as Project;
    expect(audibleAssetKey(project)).toBe('asset_a,asset_b');
  });
});
