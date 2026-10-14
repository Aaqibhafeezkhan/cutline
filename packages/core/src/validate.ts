import { CutlineError } from './errors';
import type { Project } from './schema';
import { ProjectSchema, TRACK_ACCEPTS, clipEnd, hasSource } from './schema';
import { formatRange } from './time';

/** Tolerance for source-range checks (decoders report durations with limited precision). */
const SOURCE_TOLERANCE = 1e-3;
const OVERLAP_TOLERANCE = 1e-6;

/**
 * Checks invariants that Zod cannot express: unique ids, sorted and
 * non-overlapping clips, clip types allowed on their track, valid asset
 * references and source ranges. Returns a list of problems (empty = valid).
 */
export function findProblems(project: Project): string[] {
  const problems: string[] = [];
  const parsed = ProjectSchema.safeParse(project);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`schema: ${issue.path.join('.')}: ${issue.message}`);
    }
  }
  const ids = new Set<string>();
  const seen = (id: string, what: string) => {
    if (ids.has(id)) problems.push(`duplicate id ${id} (${what})`);
    ids.add(id);
  };

  const assets = new Map(project.assets.map((a) => [a.id, a]));
  for (const asset of project.assets) seen(asset.id, 'asset');
  const logoId = project.settings.brand?.logoAssetId;
  if (logoId && assets.get(logoId)?.kind !== 'image') {
    problems.push(`brand: logo ${logoId} is not an image asset of this project`);
  }

  for (const track of project.tracks) {
    seen(track.id, 'track');
    if (track.captionStyle && track.kind !== 'caption') {
      problems.push(`track ${track.id}: captionStyle is only allowed on caption tracks`);
    }
    let prevEnd = -Infinity;
    let prevId = '';
    for (const clip of track.clips) {
      seen(clip.id, 'clip');
      if (!TRACK_ACCEPTS[track.kind].includes(clip.type)) {
        problems.push(
          `clip ${clip.id}: ${clip.type} clips are not allowed on ${track.kind} tracks`,
        );
      }
      if (clip.start < prevEnd - OVERLAP_TOLERANCE) {
        problems.push(
          `clip ${clip.id} (${formatRange(clip.start, clipEnd(clip))}) overlaps or is out of order after ${prevId}`,
        );
      }
      prevEnd = clipEnd(clip);
      prevId = clip.id;

      if ('assetId' in clip) {
        const asset = assets.get(clip.assetId);
        if (!asset) {
          problems.push(`clip ${clip.id}: unknown asset ${clip.assetId}`);
        } else if (hasSource(clip)) {
          if (asset.duration === null) {
            problems.push(`clip ${clip.id}: asset ${asset.id} has no duration`);
          } else if (clip.sourceStart + clip.duration > asset.duration + SOURCE_TOLERANCE) {
            problems.push(
              `clip ${clip.id}: source range ${formatRange(clip.sourceStart, clip.sourceStart + clip.duration)} exceeds asset duration ${asset.duration}s`,
            );
          }
          if (clip.type === 'audio' && !asset.hasAudio) {
            problems.push(`clip ${clip.id}: asset ${asset.id} has no audio`);
          }
          if (clip.type === 'video' && !asset.hasVideo) {
            problems.push(`clip ${clip.id}: asset ${asset.id} has no video`);
          }
        } else if (asset.kind !== 'image') {
          problems.push(`clip ${clip.id}: image clips need an image asset`);
        }
      }
    }
  }
  for (const marker of project.markers ?? []) {
    seen(marker.id, 'marker');
    if (marker.end !== undefined && marker.end <= marker.time) {
      problems.push(`marker ${marker.id}: end must be after time`);
    }
  }
  return problems;
}

export function assertValid(project: Project): void {
  const problems = findProblems(project);
  if (problems.length > 0) {
    throw new CutlineError('INVARIANT', `Project would become invalid: ${problems.join('; ')}`, {
      details: problems,
    });
  }
}
