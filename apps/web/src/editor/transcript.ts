import type { Project, Word } from '@cutline/core';

/** Index of the word being spoken at `time` (timeline seconds), or -1 in a pause. */
export function wordIndexAt(words: readonly Word[], time: number): number {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    if (time < w.start) hi = mid - 1;
    else if (time >= w.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Ids of the assets whose audio the timeline plays (same rule as the server's
 * timeline transcript), as a stable key: it changes only when that set does.
 */
export function audibleAssetKey(project: Project): string {
  const ids = new Set<string>();
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if ((clip.type === 'video' || clip.type === 'audio') && !clip.muted) ids.add(clip.assetId);
    }
  }
  return project.assets
    .filter((a) => ids.has(a.id) && a.hasAudio)
    .map((a) => a.id)
    .sort()
    .join(',');
}

/** Inclusive, ordered word range of a selection made from an anchor and a focus. */
export function orderedRange(sel: { anchor: number; focus: number }): {
  start: number;
  end: number;
} {
  return { start: Math.min(sel.anchor, sel.focus), end: Math.max(sel.anchor, sel.focus) };
}
