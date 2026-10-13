import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type AudioSampleSink,
  type Quality,
  type VideoCodec,
} from 'mediabunny';
import { resolveAudioSegments, resolveFrame, type Asset, type Project } from '@cutline/core';
import { clipSamples, mixChunk, segmentsInWindow, sourceWindow } from '../audio/mix';
import { FrameSourceProvider } from '../media/frame-sources';
import { MediaPool, type AssetLocator } from '../media/media-pool';
import { decodePcm } from '../media/pcm';
import { Compositor } from '../render/compositor';
import { exportPlan, type ExportOptions, type ExportProgress, type ExportResult } from './plan';

const QUALITIES: Record<NonNullable<ExportOptions['quality']>, Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  'very-high': QUALITY_VERY_HIGH,
};

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
/** Audio/video are interleaved in windows of this many seconds. */
const WINDOW = 1;

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;

export const defaultCanvasFactory: CanvasFactory = (w, h) => new OffscreenCanvas(w, h);

/**
 * Renders a project to an MP4 (or WebM) file with WebCodecs. Runs in a
 * worker (preferred) or on the main thread.
 */
export async function renderExport(
  project: Project,
  locator: AssetLocator,
  options: ExportOptions = {},
  onProgress: (p: ExportProgress) => void = () => undefined,
  createCanvas: CanvasFactory = defaultCanvasFactory,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const plan = exportPlan(project, options);
  if (plan.duration <= 0) throw new Error('Nothing to export: the timeline is empty.');
  onProgress({ phase: 'preparing', progress: 0, frame: 0, totalFrames: plan.totalFrames });

  const mp4 = plan.container === 'mp4';
  const format = mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
  const quality = QUALITIES[options.quality ?? 'high'];
  const preferredVideo: VideoCodec[] = mp4 ? ['avc', 'vp9', 'av1', 'hevc'] : ['vp9', 'vp8', 'av1'];
  const videoCodec = await getFirstEncodableVideoCodec(
    preferredVideo.filter((c) => format.getSupportedVideoCodecs().includes(c)),
    { width: plan.width, height: plan.height, quality },
  );
  if (!videoCodec) {
    throw new Error(
      'This browser cannot encode video with WebCodecs (no H.264/VP9/AV1 encoder). Try a recent Chrome/Edge, or export on the server.',
    );
  }
  const segments = resolveAudioSegments(project).filter(
    (s) => s.timelineEnd > plan.start && s.timelineStart < plan.end,
  );
  const preferredAudio: AudioCodec[] = mp4 ? ['aac', 'opus'] : ['opus', 'vorbis'];
  const audioCodec =
    segments.length > 0
      ? await getFirstEncodableAudioCodec(
          preferredAudio.filter((c) => format.getSupportedAudioCodecs().includes(c)),
          { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, quality },
        )
      : null;

  const canvas = createCanvas(plan.width, plan.height);
  const compositor = await Compositor.create(
    canvas,
    project.settings.width,
    project.settings.height,
  );
  compositor.resize(plan.width, plan.height, project.settings.width, project.settings.height);
  const pool = new MediaPool({ ...locator, useOpfs: locator.useOpfs ?? true });
  const sources = new FrameSourceProvider(pool, plan.width, plan.height);
  const assets = new Map<string, Asset>(project.assets.map((a) => [a.id, a]));

  const target = new BufferTarget();
  const output = new Output({ format, target });
  const video = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: quality,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(video, { frameRate: plan.fps });
  const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: quality }) : null;
  if (audio) output.addAudioTrack(audio);

  const audioSinks = new Map<string, Promise<AudioSampleSink | null>>();
  const sinkFor = (asset: Asset) => {
    let s = audioSinks.get(asset.id);
    if (!s) {
      s = pool.audioSink(asset).catch(() => null);
      audioSinks.set(asset.id, s);
    }
    return s;
  };

  try {
    await output.start();
    const frameDuration = 1 / plan.fps;
    let frame = 0;
    for (let w = plan.start; w < plan.end - 1e-9; w += WINDOW) {
      const windowEnd = Math.min(plan.end, w + WINDOW);
      // Video frames in [w, windowEnd)
      while (frame < plan.totalFrames && plan.start + frame * frameDuration < windowEnd - 1e-9) {
        if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
        const t = plan.start + frame * frameDuration;
        const desc = resolveFrame(project, t);
        compositor.render(desc, await sources.gather(desc, assets));
        await video.add(frame * frameDuration, frameDuration);
        frame++;
        onProgress({
          phase: 'rendering',
          progress: frame / plan.totalFrames,
          frame,
          totalFrames: plan.totalFrames,
        });
      }
      // Audio for the same window
      if (audio) {
        const length = Math.round((windowEnd - w) * SAMPLE_RATE);
        const out = Array.from({ length: CHANNELS }, () => new Float32Array(length));
        for (const seg of segmentsInWindow(segments, w, windowEnd)) {
          const asset = assets.get(seg.assetId);
          const sink = asset ? await sinkFor(asset) : null;
          if (!sink) continue;
          const { from, to } = sourceWindow(seg, w, windowEnd);
          for await (const chunk of decodePcm(sink, from, to)) {
            mixChunk(out, w, SAMPLE_RATE, seg, chunk);
          }
        }
        clipSamples(out);
        const data = new Float32Array(length * CHANNELS);
        out.forEach((ch, c) => data.set(ch, c * length));
        const sample = new AudioSample({
          data,
          format: 'f32-planar',
          numberOfChannels: CHANNELS,
          sampleRate: SAMPLE_RATE,
          timestamp: w - plan.start,
        });
        await audio.add(sample);
        sample.close();
      }
    }
    onProgress({ phase: 'finalizing', progress: 1, frame, totalFrames: plan.totalFrames });
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    sources.disposeReaders();
    pool.dispose();
    compositor.destroy();
  }

  const buffer = target.buffer;
  if (!buffer) throw new Error('Export produced no data.');
  const mimeType = mp4 ? 'video/mp4' : 'video/webm';
  onProgress({
    phase: 'done',
    progress: 1,
    frame: plan.totalFrames,
    totalFrames: plan.totalFrames,
  });
  return {
    blob: new Blob([buffer], { type: mimeType }),
    mimeType,
    extension: mp4 ? 'mp4' : 'webm',
    videoCodec,
    audioCodec: audioCodec ?? null,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: plan.end - plan.start,
  };
}
