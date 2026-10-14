import type { Marker, Project, Track } from './schema';
import { EPSILON, roundTime } from './time';

/** Sorts markers by time (then id) in place. */
export function sortMarkers(markers: Marker[]): void {
  markers.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** Where timeline time `t` lands after [start, end) is cut out and the gap closed. */
export function timeAfterRemoval(t: number, start: number, end: number): number {
  if (t <= start + EPSILON) return t;
  if (t >= end - EPSILON) return roundTime(t - (end - start));
  return start;
}

/**
 * Ripples the project's markers after the timeline range [start, end) was cut
 * out: later markers move left, markers inside snap to the cut, spans shrink.
 * Spans that vanish are removed; their ids are returned.
 */
export function rippleMarkersRemove(project: Project, start: number, end: number): string[] {
  const removed: string[] = [];
  for (const m of project.markers ?? []) {
    const time = timeAfterRemoval(m.time, start, end);
    const mEnd = m.end === undefined ? undefined : timeAfterRemoval(m.end, start, end);
    if (mEnd !== undefined && mEnd - time <= EPSILON) {
      removed.push(m.id);
      continue;
    }
    m.time = time;
    if (mEnd !== undefined) m.end = mEnd;
  }
  if (removed.length) project.markers = project.markers!.filter((m) => !removed.includes(m.id));
  return removed;
}

/** Moves every marker (and span end) at or after `from` by `delta` seconds. */
export function shiftMarkers(project: Project, from: number, delta: number): void {
  if (delta === 0) return;
  for (const m of project.markers ?? []) {
    if (m.time >= from - EPSILON) m.time = roundTime(m.time + delta);
    if (m.end !== undefined && m.end >= from - EPSILON) m.end = roundTime(m.end + delta);
  }
}

/**
 * The track whose ripple edits move the markers: the bottom video track (the
 * main story), or the first audio track for audio-only projects.
 */
export function mainTrack(project: Project): Track | undefined {
  return (
    project.tracks.find((t) => t.kind === 'video') ?? project.tracks.find((t) => t.kind === 'audio')
  );
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export interface Chapter {
  time: number;
  title: string;
}

/** YouTube's rules: first chapter at 0:00, at least 3 chapters, each at least 10 s long. */
export const YOUTUBE_MIN_CHAPTERS = 3;
export const YOUTUBE_MIN_CHAPTER_SECONDS = 10;

export function chapterList(project: Project): Chapter[] {
  return (project.markers ?? [])
    .filter((m) => m.kind === 'chapter')
    .map((m) => ({ time: m.time, title: m.label }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Chapters of the timeline window [start, end), re-timed so the window starts
 * at 0. The chapter that is running at `start` begins the list at 0.
 */
export function chaptersInRange(
  chapters: readonly Chapter[],
  start: number,
  end: number,
): Chapter[] {
  const out: Chapter[] = [];
  for (const c of chapters) {
    if (c.time >= end - EPSILON) break;
    const time = roundTime(Math.max(0, c.time - start));
    if (time === 0) out.length = 0;
    out.push({ time, title: c.title });
  }
  return out;
}

/** "05:30" (or "1:05:30" when `hours`), as YouTube expects in descriptions. */
export function formatTimestamp(t: number, hours = false): string {
  const total = Math.max(0, Math.floor(t + EPSILON));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m + h * 60)}:${pad(s)}`;
}

/** Problems that make YouTube ignore the chapters (empty = fine). */
export function youtubeChapterWarnings(chapters: readonly Chapter[], duration: number): string[] {
  const warnings: string[] = [];
  if (chapters.length === 0) return ['There are no chapters.'];
  if (chapters[0]!.time > EPSILON) {
    warnings.push(
      `The first chapter starts at ${formatTimestamp(chapters[0]!.time)}; YouTube needs one at 00:00.`,
    );
  }
  if (chapters.length < YOUTUBE_MIN_CHAPTERS) {
    warnings.push(
      `YouTube needs at least ${YOUTUBE_MIN_CHAPTERS} chapters; there are ${chapters.length}.`,
    );
  }
  chapters.forEach((c, i) => {
    const end = chapters[i + 1]?.time ?? duration;
    if (end - c.time < YOUTUBE_MIN_CHAPTER_SECONDS - EPSILON) {
      warnings.push(
        `Chapter "${c.title}" (${formatTimestamp(c.time)}) is ${Math.max(0, Math.round((end - c.time) * 10) / 10)}s long; YouTube needs at least ${YOUTUBE_MIN_CHAPTER_SECONDS}s.`,
      );
    }
  });
  return warnings;
}

/** Chapter list for a YouTube description: one "00:00 Title" line per chapter. */
export function youtubeChapterText(chapters: readonly Chapter[], duration: number): string {
  const hours = duration >= 3600;
  return chapters.map((c) => `${formatTimestamp(c.time, hours)} ${c.title}`).join('\n');
}

function escapeMeta(value: string): string {
  return value.replace(/[=;#\\\n]/g, (ch) => `\\${ch}`);
}

/**
 * ffmpeg FFMETADATA1 text with one [CHAPTER] per chapter (millisecond
 * timebase), each ending where the next begins. Chapters at or after
 * `duration` are dropped.
 */
export function ffmetadataChapters(
  chapters: readonly Chapter[],
  duration: number,
  title?: string,
): string {
  const inside = chapters.filter((c) => c.time < duration - EPSILON);
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${escapeMeta(title)}`);
  inside.forEach((c, i) => {
    const end = inside[i + 1]?.time ?? duration;
    lines.push(
      '',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(c.time * 1000)}`,
      `END=${Math.round(end * 1000)}`,
      `title=${escapeMeta(c.title)}`,
    );
  });
  return `${lines.join('\n')}\n`;
}
