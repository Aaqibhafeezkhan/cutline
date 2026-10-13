import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CutlineError,
  computeEnvelope,
  type Asset,
  type Envelope,
  type Project,
  type Word,
} from '@cutline/core';
import type { BlobStore } from '../storage/types';
import { BEAT_SAMPLE_RATE, detectBeats, type BeatAnalysis, type BeatOptions } from './beats';
import type { Ffmpeg } from './ffmpeg';
import type { Transcriber, TranscribeOptions } from './transcribe';

const ENVELOPE_WINDOW = 0.01;
const PCM_RATE = 16000;

/**
 * Per-asset media analysis with an on-disk cache (cache/<assetId>/…):
 * loudness envelopes, transcripts and scene cuts.
 */
export class AnalysisService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly ffmpeg: Ffmpeg,
    private readonly transcriber: Transcriber,
  ) {}

  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const stat = await this.blobs.stat(key);
    if (stat) {
      const chunks: Buffer[] = [];
      for await (const c of this.blobs.read(key)) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    }
    let task = this.inflight.get(key) as Promise<T> | undefined;
    if (!task) {
      task = (async () => {
        const value = await compute();
        await this.blobs.put(key, Readable.from([Buffer.from(JSON.stringify(value))]));
        return value;
      })();
      this.inflight.set(key, task);
      task.finally(() => this.inflight.delete(key)).catch(() => undefined);
    }
    return task;
  }

  private async pcm(asset: Asset, signal?: AbortSignal): Promise<Float32Array> {
    if (!asset.hasAudio) {
      throw new CutlineError('INVALID_ARGUMENT', `Asset "${asset.name}" has no audio.`);
    }
    return this.ffmpeg.decodePcm(await this.blobs.localPath(asset.src), PCM_RATE, signal);
  }

  /** RMS/peak envelope (10 ms windows). Silent envelope for assets without audio. */
  async envelope(asset: Asset, signal?: AbortSignal): Promise<Envelope> {
    if (!asset.hasAudio) return { windowSec: ENVELOPE_WINDOW, rms: [], peak: [] };
    return this.cached(`cache/${asset.id}/envelope.json`, async () => {
      const env = computeEnvelope(await this.pcm(asset, signal), PCM_RATE, ENVELOPE_WINDOW);
      const r = (x: number) => Math.round(x * 1e5) / 1e5;
      return { windowSec: env.windowSec, rms: env.rms.map(r), peak: env.peak.map(r) };
    });
  }

  async envelopes(project: Project, signal?: AbortSignal): Promise<Map<string, Envelope>> {
    const used = new Set(
      project.tracks.flatMap((t) => t.clips.flatMap((c) => ('assetId' in c ? [c.assetId] : []))),
    );
    const out = new Map<string, Envelope>();
    for (const asset of project.assets) {
      if (used.has(asset.id) && asset.hasAudio)
        out.set(asset.id, await this.envelope(asset, signal));
    }
    return out;
  }

  /** Word-level transcript of an asset in source time. */
  async transcript(asset: Asset, options: TranscribeOptions = {}): Promise<Word[]> {
    const variant = createHash('sha1')
      .update(`${this.transcriber.id}|${options.language ?? 'auto'}`)
      .digest('hex')
      .slice(0, 10);
    return this.cached(`cache/${asset.id}/transcript-${variant}.json`, async () =>
      this.transcriber.transcribe(await this.pcm(asset, options.signal), options),
    );
  }

  private beatKey(asset: Asset, options: BeatOptions): string {
    return `cache/${asset.id}/beats-${options.minBpm ?? 60}-${options.maxBpm ?? 200}.json`;
  }

  /** Tempo and beat grid of an asset's audio in source time. */
  async beats(
    asset: Asset,
    options: BeatOptions = {},
    signal?: AbortSignal,
  ): Promise<BeatAnalysis> {
    if (!asset.hasAudio) {
      throw new CutlineError('INVALID_ARGUMENT', `Asset "${asset.name}" has no audio.`, {
        hint: 'Detect beats on a music or video asset that has an audio stream.',
      });
    }
    return this.cached(this.beatKey(asset, options), async () =>
      detectBeats(
        await this.ffmpeg.decodePcm(
          await this.blobs.localPath(asset.src),
          BEAT_SAMPLE_RATE,
          signal,
        ),
        BEAT_SAMPLE_RATE,
        options,
      ),
    );
  }

  /** Beats computed earlier with the default BPM range, without analysing anything new. */
  async cachedBeats(asset: Asset): Promise<BeatAnalysis | null> {
    if (!asset.hasAudio || !(await this.blobs.stat(this.beatKey(asset, {})))) return null;
    return this.beats(asset);
  }

  /** Scene cut timestamps in source time. */
  async scenes(asset: Asset, threshold: number, signal?: AbortSignal): Promise<number[]> {
    if (!asset.hasVideo || asset.kind === 'image') return [];
    return this.cached(`cache/${asset.id}/scenes-${Math.round(threshold * 1000)}.json`, async () =>
      this.ffmpeg.sceneChanges(await this.blobs.localPath(asset.src), threshold, signal),
    );
  }
}
