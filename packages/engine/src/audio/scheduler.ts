import { gainAt, type Asset, type AudioSegment } from '@cutline/core';
import type { MediaPool } from '../media/media-pool';
import { decodePcm } from '../media/pcm';

/** How far ahead of the playhead audio is decoded and scheduled. */
const LOOKAHEAD = 2;

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

    try {
      const sink = await this.pool.audioSink(asset);
      if (!sink || session !== this.session) return;
      const srcFrom = seg.sourceStart + (begin - seg.timelineStart);
      const srcTo = seg.sourceStart + (seg.timelineEnd - seg.timelineStart);
      for await (const chunk of decodePcm(sink, srcFrom, srcTo)) {
        if (session !== this.session) return;
        const length = chunk.channels[0]?.length ?? 0;
        if (length === 0) continue;
        const buffer = this.ctx.createBuffer(chunk.channels.length, length, chunk.sampleRate);
        chunk.channels.forEach((data, c) =>
          buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c),
        );
        // Timeline time of the chunk start.
        const tl = seg.timelineStart + (chunk.timestamp - seg.sourceStart);
        const node = this.ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        const when = toCtx(tl);
        const now = this.ctx.currentTime;
        const offset = Math.max(0, now - when, begin - tl);
        if (offset >= buffer.duration) continue;
        const endAt = toCtx(seg.timelineEnd);
        node.start(Math.max(now, when + offset), offset);
        node.stop(Math.max(now, endAt));
        this.nodes.add(node);
        node.onended = () => this.nodes.delete(node);
        while (session === this.session && when - this.ctx.currentTime > LOOKAHEAD) {
          await sleep(200);
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
