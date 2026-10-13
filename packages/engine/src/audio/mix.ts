import { gainAt, type AudioSegment } from '@cutline/core';

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

  // Timeline span covered by this chunk.
  const chunkStartTl = segment.timelineStart + (chunk.timestamp - segment.sourceStart);
  const chunkEndTl = chunkStartTl + inLength / chunk.sampleRate;
  const from = Math.max(outStart, segment.timelineStart, chunkStartTl);
  const to = Math.min(outStart + outLength / outRate, segment.timelineEnd, chunkEndTl);
  if (to <= from) return;

  const first = Math.max(0, Math.ceil((from - outStart) * outRate - 1e-9));
  const last = Math.min(outLength, Math.ceil((to - outStart) * outRate - 1e-9));
  const ratio = chunk.sampleRate / outRate;
  const inOffset = (outStart - chunkStartTl) * chunk.sampleRate;

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
        if (i < 0 || i >= inLength) continue;
        const frac = pos - i;
        const a = src[i]!;
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
  return {
    from: segment.sourceStart + (from - segment.timelineStart),
    to: segment.sourceStart + (to - segment.timelineStart),
  };
}
