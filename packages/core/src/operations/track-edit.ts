import { sliceClip, splitClip } from '../clipmath';
import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { overlappingClips } from '../queries';
import type { Clip, ClipType, Track } from '../schema';
import { TRACK_ACCEPTS, clipEnd } from '../schema';
import { EPSILON, formatRange, formatTime, roundTime } from '../time';

export type PlacementMode = 'error' | 'overwrite' | 'insert';

export interface EditLog {
  created: string[];
  modified: string[];
  removed: string[];
}

export function emptyLog(): EditLog {
  return { created: [], modified: [], removed: [] };
}

export function sortTrack(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
}

export function assertEditable(track: Track): void {
  if (track.locked) {
    throw new CutlineError('LOCKED', `Track ${track.name} (${track.id}) is locked.`, {
      hint: `Unlock it first with update_track { trackId: "${track.id}", locked: false }.`,
    });
  }
}

export function assertAccepts(track: Track, type: ClipType): void {
  if (!TRACK_ACCEPTS[track.kind].includes(type)) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Track ${track.name} (${track.id}) is a ${track.kind} track and cannot hold ${type} clips.`,
      { hint: `${track.kind} tracks accept: ${TRACK_ACCEPTS[track.kind].join(', ')}.` },
    );
  }
}

/**
 * Removes the timeline range [start, end) from a track: clips inside are
 * deleted, clips crossing the edges are trimmed, a clip spanning the whole
 * range is split in two. Does not shift anything.
 */
export function carveRange(
  track: Track,
  start: number,
  end: number,
  ctx: OpContext,
  log: EditLog,
): void {
  const next: Clip[] = [];
  for (const clip of track.clips) {
    const cStart = clip.start;
    const cEnd = clipEnd(clip);
    if (cEnd <= start + EPSILON || cStart >= end - EPSILON) {
      next.push(clip);
    } else if (cStart >= start - EPSILON && cEnd <= end + EPSILON) {
      log.removed.push(clip.id);
    } else if (cStart < start - EPSILON && cEnd > end + EPSILON) {
      const [left, rest] = splitClip(clip, start - cStart, ctx.newId('clip'));
      const right = sliceClip(rest, end - start, rest.duration);
      next.push(left, right);
      log.modified.push(left.id);
      log.created.push(right.id);
    } else if (cStart < start - EPSILON) {
      next.push(sliceClip(clip, 0, start - cStart));
      log.modified.push(clip.id);
    } else {
      const trimmed = sliceClip(clip, end - cStart, clip.duration);
      if ('fadeIn' in trimmed) trimmed.fadeIn = 0;
      if ('transitionIn' in trimmed) delete trimmed.transitionIn;
      if ('animationIn' in trimmed) delete trimmed.animationIn;
      next.push(trimmed);
      log.modified.push(clip.id);
    }
  }
  track.clips = next;
}

/** Shifts every clip starting at or after `from` by `delta` seconds. */
export function shiftClips(track: Track, from: number, delta: number, log: EditLog): void {
  if (delta === 0) return;
  for (const clip of track.clips) {
    if (clip.start >= from - EPSILON) {
      clip.start = roundTime(Math.max(0, clip.start + delta));
      log.modified.push(clip.id);
    }
  }
}

/**
 * Inserts `clip` into `track`, resolving collisions according to `mode`.
 * The clip's start/duration must already be final.
 */
export function placeClip(
  track: Track,
  clip: Clip,
  mode: PlacementMode,
  ctx: OpContext,
  log: EditLog,
): void {
  const start = clip.start;
  const end = clipEnd(clip);
  const collisions = overlappingClips(track, start, end, clip.id);
  if (collisions.length > 0) {
    if (mode === 'error') {
      const list = collisions
        .map((c) => `${c.id} (${formatRange(c.start, clipEnd(c))})`)
        .join(', ');
      const free = freeSlotAfter(track, start, clip.duration, clip.id);
      throw new CutlineError(
        'OVERLAP',
        `${formatRange(start, end)} on track ${track.name} is occupied by ${list}.`,
        {
          hint: `Use start ≥ ${formatTime(free)}, another track, or mode "overwrite" / "insert".`,
          details: { collisions: collisions.map((c) => c.id), nextFreeStart: free },
        },
      );
    }
    if (mode === 'overwrite') {
      carveRange(track, start, end, ctx, log);
    } else {
      const spanning = track.clips.find(
        (c) => c.start < start - EPSILON && clipEnd(c) > start + EPSILON,
      );
      if (spanning) {
        const idx = track.clips.indexOf(spanning);
        const [left, right] = splitClip(spanning, start - spanning.start, ctx.newId('clip'));
        track.clips.splice(idx, 1, left, right);
        log.modified.push(left.id);
        log.created.push(right.id);
      }
      shiftClips(track, start, clip.duration, log);
    }
  }
  track.clips.push(clip);
  sortTrack(track);
}

/** Earliest start ≥ `from` where a clip of `duration` fits on the track. */
export function freeSlotAfter(
  track: Track,
  from: number,
  duration: number,
  excludeId?: string,
): number {
  let candidate = from;
  const clips = track.clips.filter((c) => c.id !== excludeId).sort((a, b) => a.start - b.start);
  for (const c of clips) {
    if (clipEnd(c) <= candidate + EPSILON) continue;
    if (c.start >= candidate + duration - EPSILON) break;
    candidate = clipEnd(c);
  }
  return roundTime(candidate);
}
