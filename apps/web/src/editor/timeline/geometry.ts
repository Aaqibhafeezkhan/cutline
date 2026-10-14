import {
  clipEnd,
  clipSpeed,
  isReversed,
  sourceSpan,
  type Clip,
  type Project,
  type Track,
} from '@cutline/core';

export const TRACK_HEIGHT: Record<Track['kind'], number> = { video: 52, audio: 44, caption: 34 };
/** Tick labels on top, the marker strip (chapters, notes, highlights) below. */
export const RULER_HEIGHT = 40;
export const HEADER_WIDTH = 148;
/** Snap distance in screen pixels. */
export const SNAP_PX = 8;

/**
 * Display order: visual tracks (captions and video) with the top layer
 * first, then audio tracks in stacking order, like most NLEs.
 */
export function displayTracks(project: Project): Track[] {
  const visual = project.tracks.filter((t) => t.kind !== 'audio').reverse();
  const audio = project.tracks.filter((t) => t.kind === 'audio');
  return [...visual, ...audio];
}

/** Times a dragged edge can snap to: clip edges, the playhead, 0 and any extra (beats). */
export function snapPoints(
  project: Project,
  excludeIds: readonly string[],
  playhead: number,
  extra: readonly number[] = [],
): number[] {
  const points = new Set<number>([0, playhead, ...extra]);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (excludeIds.includes(clip.id)) continue;
      points.add(clip.start);
      points.add(clipEnd(clip));
    }
  }
  return [...points];
}

/** Timeline times of the beats (source time per asset) that fall inside a clip (speed-aware). */
export function beatTimes(clip: Clip, grid: readonly number[] | undefined): number[] {
  if (!grid || !('sourceStart' in clip)) return [];
  const speed = clipSpeed(clip);
  if (speed === 0) return [];
  const end = clip.sourceStart + sourceSpan(clip);
  return grid
    .filter((b) => b >= clip.sourceStart && b < end)
    .map((b) => {
      const local = (b - clip.sourceStart) / speed;
      return clip.start + (isReversed(clip) ? clip.duration - local : local);
    })
    .sort((a, b) => a - b);
}

/**
 * How far a media clip's edges can be dragged before running out of source:
 * [earliest start, latest end] in timeline seconds (unbounded for freeze frames).
 */
export function trimLimits(clip: Clip, assetDuration: number | null | undefined): [number, number] {
  if (!('sourceStart' in clip)) return [0, Infinity];
  const speed = clipSpeed(clip);
  if (speed === 0) return [0, Infinity];
  const before = clip.sourceStart / speed;
  const after = assetDuration
    ? (assetDuration - clip.sourceStart - sourceSpan(clip)) / speed
    : Infinity;
  return isReversed(clip)
    ? [clip.start - after, clipEnd(clip) + before]
    : [clip.start - before, clipEnd(clip) + after];
}

/** Beat snap targets of every clip with a known beat grid, except `excludeIds`. */
export function beatPoints(
  project: Project,
  grids: Readonly<Record<string, { beats: readonly number[] }>>,
  excludeIds: readonly string[],
): number[] {
  return project.tracks.flatMap((t) =>
    t.clips.flatMap((c) =>
      excludeIds.includes(c.id) || !('assetId' in c) ? [] : beatTimes(c, grids[c.assetId]?.beats),
    ),
  );
}

/** Snaps `t` to the nearest point within `threshold` seconds. */
export function snap(
  t: number,
  points: readonly number[],
  threshold: number,
): { time: number; snapped: boolean } {
  let best = t;
  let dist = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= dist) {
      dist = d;
      best = p;
    }
  }
  return { time: best, snapped: best !== t || dist === 0 };
}

/**
 * Snaps a moving block [start, start + duration): whichever edge lands closer
 * to a snap point wins.
 */
export function snapBlock(
  start: number,
  duration: number,
  points: readonly number[],
  threshold: number,
): number {
  const a = snap(start, points, threshold);
  const b = snap(start + duration, points, threshold);
  if (!a.snapped && !b.snapped) return start;
  if (
    a.snapped &&
    (!b.snapped || Math.abs(a.time - start) <= Math.abs(b.time - (start + duration)))
  ) {
    return a.time;
  }
  return b.time - duration;
}

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler tick spacing so labels are at least ~70 px apart. */
export function tickStep(zoom: number): number {
  return STEPS.find((s) => s * zoom >= 70) ?? 1200;
}

export function rulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const secs = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1) : String(Math.round(s));
  return m > 0 ? `${m}:${secs.padStart(step < 1 ? 4 : 2, '0')}` : `${secs}s`;
}
