import { sourceRangeToLocal } from './clipmath';
import { mergeRanges, type TimeRange } from './ranges';
import { gainAt, resolveAudioSegments, segmentSourceTime, type AudioSegment } from './resolve';
import type { Project } from './schema';
import { clipEnd } from './schema';
import { roundTime } from './time';

/** Loudness envelope: one RMS and peak value (linear, 0..1) per window. */
export interface Envelope {
  windowSec: number;
  rms: number[];
  peak: number[];
}

export function toDb(amplitude: number): number {
  return amplitude <= 1e-5 ? -100 : 20 * Math.log10(amplitude);
}

export function computeEnvelope(
  samples: ArrayLike<number>,
  sampleRate: number,
  windowSec = 0.01,
): Envelope {
  const size = Math.max(1, Math.round(sampleRate * windowSec));
  const rms: number[] = [];
  const peak: number[] = [];
  for (let i = 0; i < samples.length; i += size) {
    const end = Math.min(samples.length, i + size);
    let sum = 0;
    let max = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j]!;
      sum += v * v;
      const a = Math.abs(v);
      if (a > max) max = a;
    }
    rms.push(Math.sqrt(sum / (end - i)));
    peak.push(max);
  }
  return { windowSec: size / sampleRate, rms, peak };
}

export function envelopeDuration(env: Envelope): number {
  return env.rms.length * env.windowSec;
}

export interface SilenceOptions {
  /** Windows quieter than this (RMS, dBFS) count as silent. Default -40. */
  thresholdDb?: number;
  /** Ignore pauses shorter than this. Default 0.5 s. */
  minDuration?: number;
  /** Keep this much audio on each side of a silence (so cuts are not abrupt). Default 0.1 s. */
  padding?: number;
}

/** Silent ranges (in envelope time), already shrunk by `padding` on both sides. */
export function detectSilences(env: Envelope, options: SilenceOptions = {}): TimeRange[] {
  const thresholdDb = options.thresholdDb ?? -40;
  const minDuration = options.minDuration ?? 0.5;
  const padding = options.padding ?? 0.1;
  const total = envelopeDuration(env);
  const raw: TimeRange[] = [];
  let runStart = -1;
  for (let i = 0; i <= env.rms.length; i++) {
    const silent = i < env.rms.length && toDb(env.rms[i]!) < thresholdDb;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      raw.push({ start: runStart * env.windowSec, end: Math.min(total, i * env.windowSec) });
      runStart = -1;
    }
  }
  return raw
    .filter((r) => r.end - r.start >= minDuration)
    .map((r) => ({
      // No padding at the very start/end of the media: there is nothing to protect.
      start: roundTime(r.start <= 0 ? 0 : r.start + padding),
      end: roundTime(r.end >= total ? total : r.end - padding),
    }))
    .filter((r) => r.end - r.start > 0.01);
}

function envelopeAt(env: Envelope, sourceTime: number): number {
  const i = Math.floor(sourceTime / env.windowSec);
  return env.rms[i] ?? 0;
}

/**
 * Mixes per-asset envelopes into a timeline envelope using the same audio
 * segments the renderers use (gains, fades, mutes, transitions).
 */
export function timelineEnvelope(
  project: Project,
  envelopes: ReadonlyMap<string, Envelope>,
  windowSec = 0.02,
  duration?: number,
): Envelope {
  const segments = resolveAudioSegments(project);
  const end = duration ?? segments.reduce((max, s) => Math.max(max, s.timelineEnd), 0);
  const count = Math.ceil(end / windowSec);
  const rms: number[] = new Array<number>(count).fill(0);
  for (const seg of segments) {
    const env = envelopes.get(seg.assetId);
    if (!env) continue;
    addSegment(rms, seg, env, windowSec);
  }
  const mixed = rms.map((energy) => Math.sqrt(energy));
  return { windowSec, rms: mixed, peak: mixed.slice() };
}

function addSegment(energy: number[], seg: AudioSegment, env: Envelope, windowSec: number): void {
  const first = Math.floor(seg.timelineStart / windowSec);
  const last = Math.ceil(seg.timelineEnd / windowSec);
  for (let i = first; i < last && i < energy.length; i++) {
    const t = (i + 0.5) * windowSec;
    if (t < seg.timelineStart || t >= seg.timelineEnd) continue;
    const amp = envelopeAt(env, segmentSourceTime(seg, t)) * gainAt(seg.gain, t);
    energy[i]! += amp * amp;
  }
}

export interface WaveformBucket {
  start: number;
  end: number;
  peakDb: number;
  rmsDb: number;
}

export interface WaveformSummary {
  duration: number;
  peakDb: number;
  rmsDb: number;
  buckets: WaveformBucket[];
  loudest: WaveformBucket[];
  quietest: WaveformBucket[];
}

/** Compact, LLM-sized description of an envelope. */
export function summarizeWaveform(env: Envelope, bucketCount = 40): WaveformSummary {
  const duration = roundTime(envelopeDuration(env));
  const n = env.rms.length;
  const buckets: WaveformBucket[] = [];
  const count = Math.max(1, Math.min(bucketCount, n));
  let totalEnergy = 0;
  let totalPeak = 0;
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let energy = 0;
    let peak = 0;
    for (let i = from; i < to && i < n; i++) {
      energy += env.rms[i]! ** 2;
      peak = Math.max(peak, env.peak[i]!);
    }
    totalEnergy += energy;
    totalPeak = Math.max(totalPeak, peak);
    buckets.push({
      start: roundTime(from * env.windowSec),
      end: roundTime(Math.min(to, n) * env.windowSec),
      peakDb: Math.round(toDb(peak) * 10) / 10,
      rmsDb: Math.round(toDb(Math.sqrt(energy / Math.max(1, to - from))) * 10) / 10,
    });
  }
  const byLoudness = [...buckets].sort((a, b) => b.rmsDb - a.rmsDb);
  return {
    duration,
    peakDb: Math.round(toDb(totalPeak) * 10) / 10,
    rmsDb: Math.round(toDb(Math.sqrt(totalEnergy / Math.max(1, n))) * 10) / 10,
    buckets: n === 0 ? [] : buckets,
    loudest: n === 0 ? [] : byLoudness.slice(0, 3),
    quietest: n === 0 ? [] : byLoudness.slice(-3).reverse(),
  };
}

export interface MappedRange extends TimeRange {
  clipId: string;
}

/**
 * Maps a range of source time in `assetId` to every timeline range where that
 * material is used (video or audio clips).
 */
export function mapSourceRangeToTimeline(
  project: Project,
  assetId: string,
  range: TimeRange,
): MappedRange[] {
  const out: MappedRange[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if ((clip.type !== 'video' && clip.type !== 'audio') || clip.assetId !== assetId) continue;
      const local = sourceRangeToLocal(clip, range.start, range.end);
      if (!local) continue;
      out.push({
        clipId: clip.id,
        start: roundTime(clip.start + local[0]),
        end: roundTime(clip.start + local[1]),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Merges overlapping ranges (exported for convenience). */
export function unionRanges(ranges: readonly TimeRange[]): TimeRange[] {
  return mergeRanges(ranges).map((r) => ({ start: roundTime(r.start), end: roundTime(r.end) }));
}

/** Total timeline span covered by clips of the given asset. */
export function assetUsage(project: Project, assetId: string): TimeRange[] {
  return unionRanges(
    project.tracks.flatMap((t) =>
      t.clips
        .filter((c) => 'assetId' in c && c.assetId === assetId)
        .map((c) => ({ start: c.start, end: clipEnd(c) })),
    ),
  );
}
