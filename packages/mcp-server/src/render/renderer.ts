import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CutlineError, projectDuration, type Project } from '@cutline/core';
import type { Ffmpeg } from '../media/ffmpeg';
import type { BlobStore } from '../storage/types';
import { resolveFontFile } from './fonts';
import { buildRenderGraph, type RenderGraph } from './graph';

export type RenderQuality = 'preview' | 'draft' | 'standard' | 'high';

export interface RenderOptions {
  quality?: RenderQuality;
  /** Output width; height follows the project aspect ratio. */
  width?: number;
  fps?: number;
  range?: { start: number; end: number };
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  sizeBytes: number;
  warnings: string[];
}

const PRESETS: Record<RenderQuality, { preset: string; crf: number; audio: string }> = {
  preview: { preset: 'ultrafast', crf: 32, audio: '96k' },
  draft: { preset: 'veryfast', crf: 26, audio: '128k' },
  standard: { preset: 'medium', crf: 21, audio: '160k' },
  high: { preset: 'slow', crf: 17, audio: '192k' },
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Server-side renderer: project JSON → ffmpeg filtergraph → MP4 / JPEG. */
export class Renderer {
  constructor(
    private readonly ffmpeg: Ffmpeg,
    private readonly blobs: BlobStore,
  ) {}

  private async assetPaths(project: Project): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const asset of project.assets) {
      if (await this.blobs.stat(asset.src))
        out.set(asset.id, await this.blobs.localPath(asset.src));
    }
    return out;
  }

  private async withGraph<T>(
    project: Project,
    opts: {
      start: number;
      end: number;
      width: number;
      height: number;
      fps: number;
      includeAudio: boolean;
    },
    run: (graph: RenderGraph, scriptArgs: string[], dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'cutline-render-'));
    try {
      let textCount = 0;
      const graph = buildRenderGraph(project, await this.assetPaths(project), {
        ...opts,
        fontFile: resolveFontFile,
        textFile: (content) => {
          const path = join(dir, `text${textCount++}.txt`);
          writeFileSync(path, content);
          return path;
        },
      });
      const script = join(dir, 'graph.txt');
      await writeFile(script, graph.filter);
      const info = await this.ffmpeg.detect();
      // ffmpeg 7 replaced -filter_complex_script with the generic "-/option file" syntax.
      const scriptArgs =
        (info.major ?? 0) >= 7 ? ['-/filter_complex', script] : ['-filter_complex_script', script];
      return await run(graph, scriptArgs, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async render(
    project: Project,
    outPath: string,
    options: RenderOptions = {},
  ): Promise<RenderResult> {
    await this.ffmpeg.require('Server-side rendering');
    const total = projectDuration(project);
    const start = Math.max(0, options.range?.start ?? 0);
    const end = Math.min(total, options.range?.end ?? total);
    if (end - start <= 0) {
      throw new CutlineError(
        'INVALID_OPERATION',
        'Nothing to render: the timeline (or range) is empty.',
        {
          hint: 'Add clips with add_clip first.',
        },
      );
    }
    const quality = options.quality ?? 'standard';
    const { preset, crf, audio } = PRESETS[quality];
    const width = even(options.width ?? project.settings.width);
    const height = even((width * project.settings.height) / project.settings.width);
    const fps = options.fps ?? project.settings.fps;
    return this.withGraph(
      project,
      { start, end, width, height, fps, includeAudio: true },
      async (graph, scriptArgs) => {
        await this.ffmpeg.run(
          [
            '-y',
            ...graph.inputs.flat(),
            ...scriptArgs,
            '-map',
            `[${graph.video}]`,
            '-map',
            `[${graph.audio}]`,
            '-c:v',
            'libx264',
            '-preset',
            preset,
            '-crf',
            String(crf),
            '-pix_fmt',
            'yuv420p',
            '-r',
            String(fps),
            '-c:a',
            'aac',
            '-b:a',
            audio,
            '-movflags',
            '+faststart',
            '-t',
            String(graph.duration),
            outPath,
          ],
          {
            signal: options.signal,
            onProgress: options.onProgress
              ? (s) => options.onProgress!(Math.min(1, s / graph.duration))
              : undefined,
          },
        );
        const { size } = await stat(outPath);
        return {
          path: outPath,
          width,
          height,
          fps,
          duration: graph.duration,
          sizeBytes: size,
          warnings: graph.warnings,
        };
      },
    );
  }

  /** Renders single frames at timeline times as JPEG thumbnails. */
  async frames(project: Project, times: readonly number[], width: number): Promise<Buffer[]> {
    await this.ffmpeg.require('Frame extraction');
    const w = even(width);
    const h = even((w * project.settings.height) / project.settings.width);
    const fps = project.settings.fps;
    const out: Buffer[] = [];
    for (const t of times) {
      const frame = await this.withGraph(
        project,
        { start: t, end: t + 1 / fps, width: w, height: h, fps, includeAudio: false },
        async (graph, scriptArgs, dir) => {
          const file = join(dir, 'frame.jpg');
          await this.ffmpeg.run([
            '-y',
            ...graph.inputs.flat(),
            ...scriptArgs,
            '-map',
            `[${graph.video}]`,
            '-frames:v',
            '1',
            '-q:v',
            '4',
            file,
          ]);
          return readFile(file);
        },
      );
      out.push(frame);
    }
    return out;
  }
}
