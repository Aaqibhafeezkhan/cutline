import { gainAt, segmentSourceTime, segmentTimelineTime, type AudioSegment } from '@cutline/core';

/** Decoded PCM: one Float32Array per channel, starting at `timestamp` (source seconds). */
export interface PcmChunk {
  channels: Float32Array[];
  sampleRate: number;
  timestamp: number;
}

/** Gain is evaluated once per block to keep mixing cheap. */
const GAIN_BLOCK = 64;

/**
 * Mixes a decoded chunk of `segment`'s source into `out` (stereo or mono
 * planar buffers) that start at timeline time `outStart`. Resamples with
 * linear interpolation and applies the segment's gain envelope.
 */
export function mixChunk(
  out: Float32Array[],
  outStart: number,
  outRate: number,
  segment: AudioSegment,
  chunk: PcmChunk,
): void {
  const outLength = out[0]?.length ?? 0;
  const inLength = chunk.channels[0]?.length ?? 0;
  if (outLength === 0 || inLength === 0) return;

  // Timeline span covered by this chunk (reversed segments play it backwards).
  const a = segmentTimelineTime(segment, chunk.timestamp);
  const b = segmentTimelineTime(segment, chunk.timestamp + inLength / chunk.sampleRate);
  const from = Math.max(outStart, segment.timelineStart, Math.min(a, b));
  const to = Math.min(outStart + outLength / outRate, segment.timelineEnd, Math.max(a, b));
  if (to <= from) return;

  const first = Math.max(0, Math.ceil((from - outStart) * outRate - 1e-9));
  const last = Math.min(outLength, Math.ceil((to - outStart) * outRate - 1e-9));
  // Input samples per output sample: speed resamples (pitch follows, like
  // AudioBufferSourceNode.playbackRate), reverse walks backwards.
  const ratio = ((segment.reverse ? -1 : 1) * segment.speed * chunk.sampleRate) / outRate;
  // Backwards, the sample heard at source time s is the one ending at s.
  const inOffset =
    (segmentSourceTime(segment, outStart) - chunk.timestamp) * chunk.sampleRate -
    (segment.reverse ? 1 : 0);

  for (let blockStart = first; blockStart < last; blockStart += GAIN_BLOCK) {
    const blockEnd = Math.min(last, blockStart + GAIN_BLOCK);
    const gain = gainAt(
      segment.gain,
      outStart + (blockStart + (blockEnd - blockStart) / 2) / outRate,
    );
    if (gain === 0) continue;
    for (let c = 0; c < out.length; c++) {
      const src = chunk.channels[Math.min(c, chunk.channels.length - 1)]!;
      const dst = out[c]!;
      for (let j = blockStart; j < blockEnd; j++) {
        const pos = inOffset + j * ratio;
        const i = Math.floor(pos);
        // i = -1 happens at the start of a reversed chunk: hold its first sample (no gap).
        if (i < -1 || i >= inLength) continue;
        const frac = i < 0 ? 0 : pos - i;
        const a = src[Math.max(0, i)]!;
        const b = i + 1 < inLength ? src[i + 1]! : a;
        dst[j]! += (a + (b - a) * frac) * gain;
      }
    }
  }
}

/** Hard-limits samples to [-1, 1] in place. */
export function clipSamples(channels: Float32Array[]): void {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]!;
      if (v > 1) ch[i] = 1;
      else if (v < -1) ch[i] = -1;
    }
  }
}

/** Segments overlapping [start, end) of the timeline. */
export function segmentsInWindow(segments: readonly AudioSegment[], start: number, end: number) {
  return segments.filter((s) => s.timelineStart < end && s.timelineEnd > start);
}

/** Source range of `segment` needed to render timeline window [start, end). */
export function sourceWindow(segment: AudioSegment, start: number, end: number) {
  const from = Math.max(start, segment.timelineStart);
  const to = Math.min(end, segment.timelineEnd);
  const a = segmentSourceTime(segment, from);
  const b = segmentSourceTime(segment, to);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}
