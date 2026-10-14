import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import {
  YOUTUBE_MIN_CHAPTERS,
  YOUTUBE_MIN_CHAPTER_SECONDS,
  formatTimestamp,
  sortMarkers,
} from '../markers';
import { projectDuration } from '../queries';
import { MarkerSchema, type Marker, type Project } from '../schema';
import { EPSILON, formatTime, roundTime } from '../time';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';

function markersOf(draft: Project): Marker[] {
  draft.markers ??= [];
  return draft.markers;
}

function findMarker(draft: Project, id: string): Marker {
  const marker = draft.markers?.find((m) => m.id === id);
  if (!marker) {
    const ids = (draft.markers ?? []).slice(0, 12).map((m) => `${m.id} (${m.kind} "${m.label}")`);
    throw new CutlineError('NOT_FOUND', `Marker "${id}" not found.`, {
      hint: ids.length ? `Existing markers: ${ids.join(', ')}.` : 'The project has no markers.',
    });
  }
  return marker;
}

/** Drops the `markers` array again when it became empty (keeps documents minimal). */
function tidy(draft: Project): void {
  const markers = draft.markers!;
  if (markers.length === 0) delete draft.markers;
  else sortMarkers(markers);
}

export function addMarkers(draft: Project, op: OpOf<'add_markers'>, ctx: OpContext): OpOutcome {
  const markers = markersOf(draft);
  const created: string[] = [];
  for (const input of op.markers) {
    const marker = MarkerSchema.parse({
      ...input,
      id: input.id ?? ctx.newId('marker'),
      time: roundTime(input.time),
      ...(input.end !== undefined && { end: roundTime(input.end) }),
    });
    markers.push(marker);
    created.push(marker.id);
  }
  tidy(draft);
  const kinds = [...new Set(op.markers.map((m) => m.kind))].join('/');
  return outcome(`Added ${op.markers.length} ${kinds} marker(s).`, { created });
}

export function updateMarker(draft: Project, op: OpOf<'update_marker'>): OpOutcome {
  const marker = findMarker(draft, op.markerId);
  if (op.time !== undefined) marker.time = roundTime(op.time);
  if (op.label !== undefined) marker.label = op.label;
  if (op.kind !== undefined) marker.kind = op.kind;
  if (op.end === null) delete marker.end;
  else if (op.end !== undefined) marker.end = roundTime(op.end);
  if (op.color === null) delete marker.color;
  else if (op.color !== undefined) marker.color = op.color;
  if (marker.end !== undefined && marker.end <= marker.time + EPSILON) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Marker ${marker.id} would end (${formatTime(marker.end)}) before it starts (${formatTime(marker.time)}).`,
      { hint: 'Pass an end after time, or end: null for a point marker.' },
    );
  }
  tidy(draft);
  return outcome(`Updated marker ${marker.id} ("${marker.label}").`, { modified: [marker.id] });
}

export function removeMarkers(draft: Project, op: OpOf<'remove_markers'>): OpOutcome {
  const ids = op.markerIds
    ? new Set(op.markerIds.map((id) => findMarker(draft, id).id))
    : new Set((draft.markers ?? []).filter((m) => m.kind === op.kind).map((m) => m.id));
  draft.markers = (draft.markers ?? []).filter((m) => !ids.has(m.id));
  tidy(draft);
  return outcome(`Removed ${ids.size} marker(s).`, { removed: [...ids] });
}

function chapterError(message: string, hint: string): CutlineError {
  return new CutlineError('INVALID_ARGUMENT', message, { hint });
}

/** Replaces all chapter markers, validating the list (YouTube rules by default). */
export function setChapters(draft: Project, op: OpOf<'set_chapters'>, ctx: OpContext): OpOutcome {
  const chapters = op.chapters;
  const duration = projectDuration(draft);
  if (chapters.length && duration <= 0) {
    throw chapterError('The timeline is empty; chapters need content.', 'Add clips first.');
  }
  chapters.forEach((c, i) => {
    const prev = chapters[i - 1];
    if (prev && c.time <= prev.time + EPSILON) {
      throw chapterError(
        `Chapter ${i + 1} "${c.title}" (${formatTime(c.time)}) does not come after "${prev.title}" (${formatTime(prev.time)}).`,
        'Sort chapters by time; each needs its own start time.',
      );
    }
    if (c.time >= duration - EPSILON) {
      throw new CutlineError(
        'OUT_OF_RANGE',
        `Chapter "${c.title}" starts at ${formatTime(c.time)}, at or after the end of the ${formatTime(duration)} timeline.`,
        { hint: `Chapter times must be below ${formatTime(duration)}.` },
      );
    }
  });
  if (op.youtube && chapters.length) {
    if (chapters[0]!.time > EPSILON) {
      throw chapterError(
        `The first chapter "${chapters[0]!.title}" starts at ${formatTime(chapters[0]!.time)}; YouTube needs one at 0.`,
        'Add { time: 0, title: "Intro" } first, or move the first chapter to 0 (or pass youtube: false).',
      );
    }
    if (chapters.length < YOUTUBE_MIN_CHAPTERS) {
      throw chapterError(
        `YouTube needs at least ${YOUTUBE_MIN_CHAPTERS} chapters; got ${chapters.length}.`,
        'Split the video into more sections, or pass youtube: false.',
      );
    }
    chapters.forEach((c, i) => {
      const end = chapters[i + 1]?.time ?? duration;
      if (end - c.time < YOUTUBE_MIN_CHAPTER_SECONDS - EPSILON) {
        throw chapterError(
          `Chapter "${c.title}" (${formatTimestamp(c.time)}) is only ${formatTime(roundTime(end - c.time))} long; YouTube needs at least ${YOUTUBE_MIN_CHAPTER_SECONDS}s per chapter.`,
          i + 1 < chapters.length
            ? `Move "${chapters[i + 1]!.title}" to ${formatTime(c.time + YOUTUBE_MIN_CHAPTER_SECONDS)} or later, or merge the two chapters.`
            : `Start the last chapter by ${formatTime(duration - YOUTUBE_MIN_CHAPTER_SECONDS)}, or merge it into the previous one.`,
        );
      }
    });
  }
  const old = (draft.markers ?? []).filter((m) => m.kind === 'chapter').map((m) => m.id);
  const markers = markersOf(draft).filter((m) => m.kind !== 'chapter');
  const created = chapters.map((c) => {
    const marker = MarkerSchema.parse({
      id: ctx.newId('marker'),
      time: roundTime(c.time),
      label: c.title,
      kind: 'chapter',
    });
    markers.push(marker);
    return marker.id;
  });
  draft.markers = markers;
  tidy(draft);
  return outcome(
    chapters.length
      ? `Set ${chapters.length} chapter(s): ${chapters.map((c) => `${formatTimestamp(c.time)} ${c.title}`).join(', ')}.`
      : 'Removed all chapters.',
    { created, removed: old },
  );
}
