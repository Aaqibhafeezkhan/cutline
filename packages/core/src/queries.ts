import { CutlineError } from './errors';
import type { Asset, Clip, Project, Track } from './schema';
import { clipEnd } from './schema';
import { formatRange } from './time';

const MAX_LISTED = 12;

function listIds(ids: string[]): string {
  if (ids.length === 0) return '(none)';
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  return ids.length > MAX_LISTED ? `${shown}, … (${ids.length} total)` : shown;
}

export function findTrack(project: Project, trackId: string): Track {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) {
    throw new CutlineError('NOT_FOUND', `Track "${trackId}" not found.`, {
      hint: `Existing tracks: ${listIds(project.tracks.map((t) => `${t.id} (${t.kind})`))}.`,
    });
  }
  return track;
}

export interface ClipLocation<C extends Clip = Clip> {
  track: Track;
  trackIndex: number;
  clip: C;
  index: number;
}

export function tryFindClip(project: Project, clipId: string): ClipLocation | undefined {
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
    const track = project.tracks[trackIndex]!;
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, trackIndex, clip: track.clips[index]!, index };
  }
  return undefined;
}

export function findClip(project: Project, clipId: string): ClipLocation {
  const loc = tryFindClip(project, clipId);
  if (!loc) {
    const all = allClips(project).map(
      ({ clip }) => `${clip.id} (${clip.type} ${formatRange(clip.start, clipEnd(clip))})`,
    );
    throw new CutlineError('NOT_FOUND', `Clip "${clipId}" not found.`, {
      hint: `Existing clips: ${listIds(all)}. Call get_project for the full timeline.`,
    });
  }
  return loc;
}

export function findAsset(project: Project, assetId: string): Asset {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) {
    throw new CutlineError('NOT_FOUND', `Asset "${assetId}" not found.`, {
      hint: `Existing assets: ${listIds(project.assets.map((a) => `${a.id} (${a.name})`))}. Add media with add_asset first.`,
    });
  }
  return asset;
}

export function allClips(project: Project): Array<{ track: Track; clip: Clip }> {
  return project.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
}

/** End of the last clip on any track, in seconds. */
export function projectDuration(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  }
  return end;
}

export function trackEnd(track: Track): number {
  let end = 0;
  for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

/** Clips on `track` whose [start, end) intersects [start, end), excluding `excludeId`. */
export function overlappingClips(
  track: Track,
  start: number,
  end: number,
  excludeId?: string,
  eps = 1e-6,
): Clip[] {
  return track.clips.filter(
    (c) => c.id !== excludeId && c.start < end - eps && clipEnd(c) > start + eps,
  );
}

/** Tolerance for treating two clips as touching (cut points). */
export const ADJACENT_TOLERANCE = 1e-3;

/** The clip that ends exactly where `clip` starts on the same track, if any. */
export function previousAdjacent<C extends Clip>(
  track: { clips: readonly C[] },
  clip: Clip,
): C | undefined {
  return track.clips.find(
    (c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) <= ADJACENT_TOLERANCE,
  );
}

/** Track names like V1, V2, A1, C1 that are not taken yet. */
export function nextTrackName(project: Project, kind: Track['kind']): string {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'C';
  const taken = new Set(project.tracks.map((t) => t.name));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
