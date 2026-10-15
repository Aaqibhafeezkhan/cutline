import {
  gainAt,
  segmentSourceTime,
  segmentTimelineTime,
  type Asset,
  type AudioSegment,
} from '@cutline/core';
import type { MediaPool } from '../media/media-pool';
import { decodePcm } from '../media/pcm';
import type { PcmChunk } from './mix';

/** How far ahead of the playhead audio is decoded and scheduled. */
const LOOKAHEAD = 2;
/** Timeline seconds of reversed audio decoded (forwards) and scheduled per step. */
const REVERSE_BLOCK = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Schedules timeline audio on an AudioContext for real-time preview.
 * One session per play(); stop() cancels everything.
 */
export class AudioScheduler {
  private session = 0;
  private nodes = new Set<AudioScheduledSourceNode>();
  private gains = new Set<GainNode>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly pool: MediaPool,
    private readonly output: AudioNode,
  ) {}

  /**
   * Starts playback of `segments` so that timeline time `from` plays at
   * context time `ctxStart`.
   */
  start(
    segments: readonly AudioSegment[],
    assets: ReadonlyMap<string, Asset>,
    from: number,
    ctxStart: number,
  ): void {
    this.stop();
    const session = ++this.session;
    for (const seg of segments) {
      if (seg.timelineEnd <= from) continue;
      const asset = assets.get(seg.assetId);
      if (asset) void this.playSegment(session, seg, asset, from, ctxStart);
    }
  }

  private async playSegment(
    session: number,
    seg: AudioSegment,
    asset: Asset,
    from: number,
    ctxStart: number,
  ): Promise<void> {
    const toCtx = (t: number) => ctxStart + (t - from);
    const gain = this.ctx.createGain();
    gain.connect(this.output);
    this.gains.add(gain);
    // Envelope automation from the resolver.
    const g = gain.gain;
    const begin = Math.max(from, seg.timelineStart);
    g.setValueAtTime(gainAt(seg.gain, begin), Math.max(this.ctx.currentTime, toCtx(begin)));
    for (const p of seg.gain) {
      if (p.time > begin) g.linearRampToValueAtTime(p.gain, toCtx(p.time));
    }

    /**
     * Plays the part of `chunk` that falls into timeline [lo, hi). Speed uses
     * playbackRate (pitch follows the speed, no time stretching); reversed
     * segments play each chunk's samples backwards.
     */
    const play = (chunk: PcmChunk, lo: number, hi: number): number => {
      const length = chunk.channels[0]?.length ?? 0;
      if (length === 0) return lo;
      const dur = length / chunk.sampleRate;
      // Timeline time of the first buffer sample (a reversed chunk starts with its end).
      const tl0 = segmentTimelineTime(seg, seg.reverse ? chunk.timestamp + dur : chunk.timestamp);
      const tl1 = tl0 + dur / seg.speed;
      const nowTl = from + (this.ctx.currentTime - ctxStart);
      const x = Math.max(tl0, lo, nowTl);
      const y = Math.min(tl1, hi);
      if (y <= x) return tl0;
      const buffer = this.ctx.createBuffer(chunk.channels.length, length, chunk.sampleRate);
      chunk.channels.forEach((data, c) => {
        const samples = seg.reverse ? data.slice().reverse() : data;
        buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, c);
      });
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = seg.speed;
      node.connect(gain);
      node.start(toCtx(x), (x - tl0) * seg.speed);
      node.stop(toCtx(y));
      this.nodes.add(node);
      node.onended = () => this.nodes.delete(node);
      return tl0;
    };
    const waitUntil = async (tl: number) => {
      while (session === this.session && toCtx(tl) - this.ctx.currentTime > LOOKAHEAD) {
        await sleep(200);
      }
    };

    try {
      const sink = await this.pool.audioSink(asset);
      if (!sink || session !== this.session) return;
      const end = seg.timelineEnd;
      if (!seg.reverse) {
        const srcFrom = segmentSourceTime(seg, begin);
        for await (const chunk of decodePcm(sink, srcFrom, seg.sourceEnd)) {
          if (session !== this.session) return;
          await waitUntil(play(chunk, begin, end));
        }
        return;
      }
      // Reversed: decode blocks from the end of the source window backwards,
      // each covering REVERSE_BLOCK timeline seconds, just ahead of the playhead.
      for (let blockStart = begin; blockStart < end - 1e-9; blockStart += REVERSE_BLOCK) {
        const blockEnd = Math.min(end, blockStart + REVERSE_BLOCK);
        await waitUntil(blockStart);
        if (session !== this.session) return;
        const srcLo = segmentSourceTime(seg, blockEnd);
        const srcHi = segmentSourceTime(seg, blockStart);
        for await (const chunk of decodePcm(sink, srcLo, srcHi)) {
          if (session !== this.session) return;
          play(chunk, blockStart, blockEnd);
        }
      }
    } catch (err) {
      console.warn(`[cutline] audio playback failed for ${asset.name}:`, err);
    }
  }

  stop(): void {
    this.session++;
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // already stopped
      }
    }
    this.nodes.clear();
    for (const g of this.gains) g.disconnect();
    this.gains.clear();
  }
}
