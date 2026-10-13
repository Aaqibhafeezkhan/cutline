import { mergeDuckRanges, sliceDuck } from '../ducking';
import { CutlineError } from '../errors';
import { findTrack } from '../queries';
import { isAudibleClip, type Project } from '../schema';
import { formatTime, roundTime } from '../time';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';
import { assertEditable } from './track-edit';

/**
 * Stores a ducking envelope on every audible clip of a track (clip-relative,
 * so it follows later trims, splits and ripple cuts). Replaces any earlier
 * ducking; an empty range list removes it.
 */
export function duckAudio(draft: Project, op: OpOf<'duck_audio'>): OpOutcome {
  const track = findTrack(draft, op.trackId);
  assertEditable(track);
  const clips = track.clips.filter(isAudibleClip);
  if (clips.length === 0) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Track ${track.name} (${track.id}) has no audio or video clips to duck.`,
      { hint: 'Pass the id of the track that holds the music; get_project lists all tracks.' },
    );
  }
  const ranges = mergeDuckRanges(op.ranges, op.attack + op.release);
  const modified: string[] = [];
  for (const clip of clips) {
    const duck = sliceDuck(
      {
        amountDb: op.amountDb,
        attack: op.attack,
        release: op.release,
        ranges: ranges.map((r) => ({
          start: roundTime(r.start - clip.start),
          end: roundTime(r.end - clip.start),
        })),
      },
      0,
      clip.duration,
    );
    if (duck) {
      clip.duck = duck;
      modified.push(clip.id);
    } else if (clip.duck) {
      delete clip.duck;
      modified.push(clip.id);
    }
  }
  if (ranges.length === 0) {
    return outcome(`Removed ducking from ${modified.length} clip(s) on track ${track.name}.`, {
      modified,
    });
  }
  return outcome(
    `Ducked ${modified.length} clip(s) on track ${track.name} by ${op.amountDb} dB during ${ranges.length} range(s) (attack ${formatTime(op.attack)}, release ${formatTime(op.release)}).`,
    { modified },
    [track.id],
  );
}
