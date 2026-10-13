import { CutlineError, type OperationInput } from '@cutline/core';

export interface BeatCutClip {
  id: string;
  start: number;
  duration: number;
  /** Longest duration the clip can have (media left after its in-point); Infinity for stills/text. */
  maxDuration: number;
}

export interface BeatCut {
  clipId: string;
  start: number;
  end: number;
  /** How many beats the clip spans. */
  beats: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** A clip that starts up to this much after a beat still counts as starting on it. */
const ON_BEAT = 0.02;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Lays clips back-to-back from the first clip's start so that every cut lands on a beat, each
 * clip spanning `everyNBeats` beats (fewer when its media runs out). The beat grid is extended
 * at the music's tempo past the last detected beat.
 */
export function planBeatCuts(
  clips: readonly BeatCutClip[],
  beats: readonly number[],
  everyNBeats: number,
): BeatCut[] {
  if (clips.length === 0) {
    throw new CutlineError('INVALID_ARGUMENT', 'No clips to cut to the beat.', {
      hint: 'Pass clipIds, or put video or image clips on the main video track.',
    });
  }
  if (beats.length < 2) {
    throw new CutlineError('INVALID_OPERATION', 'Not enough beats to cut to.', {
      hint: 'Use a music clip with a steady beat (check it with detect_beats first).',
    });
  }
  const sorted = [...beats].sort((a, b) => a - b);
  const period = median(sorted.slice(1).map((b, i) => b - sorted[i]!));
  const last = sorted.length - 1;
  const beatAt = (i: number) => (i <= last ? sorted[i]! : sorted[last]! + (i - last) * period);

  let t = clips[0]!.start;
  let index = sorted.findIndex((b) => b >= t - ON_BEAT);
  if (index < 0) index = last + Math.ceil((t - ON_BEAT - sorted[last]!) / period);
  const plan: BeatCut[] = [];
  for (const clip of clips) {
    let end = index + everyNBeats;
    while (end > index && beatAt(end) - t > clip.maxDuration + 1e-6) end--;
    if (end === index || beatAt(end) - t <= 1e-3) {
      throw new CutlineError(
        'OUT_OF_RANGE',
        `Clip ${clip.id} has only ${round3(clip.maxDuration)}s of media but the next beat is at ${round3(beatAt(index + 1))}s (${round3(beatAt(index + 1) - t)}s away).`,
        {
          hint: 'Leave this clip out of clipIds, use a smaller everyNBeats, or trim its in-point earlier so more media is available.',
        },
      );
    }
    const cut = round3(beatAt(end));
    plan.push({ clipId: clip.id, start: round3(t), end: cut, beats: end - index });
    t = cut;
    index = end;
  }
  return plan;
}

/**
 * Operations that apply a plan as one batch: park every clip past the end of the timeline, set
 * its new length there, then move it into place. Parking first means the clips never collide
 * with each other while the batch runs, whatever their old order and lengths were.
 */
export function beatCutOperations(
  clips: readonly BeatCutClip[],
  plan: readonly BeatCut[],
  timelineEnd: number,
): OperationInput[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const park: OperationInput[] = [];
  const trim: OperationInput[] = [];
  const place: OperationInput[] = [];
  let offset = Math.ceil(timelineEnd) + 10;
  for (const cut of plan) {
    const clip = byId.get(cut.clipId)!;
    const duration = Math.min(cut.end - cut.start, clip.maxDuration);
    park.push({ type: 'move_clip', clipId: clip.id, start: offset });
    if (Math.abs(duration - clip.duration) > 1e-6) {
      trim.push({ type: 'trim_clip', clipId: clip.id, end: offset + duration });
    }
    place.push({ type: 'move_clip', clipId: clip.id, start: cut.start });
    offset = Math.ceil(offset + Math.max(duration, clip.duration) + 1);
  }
  return [...park, ...trim, ...place];
}
