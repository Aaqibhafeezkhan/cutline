import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTime, type Origin, type Project } from '@cutline/core';
import type { DocumentService } from './documents';
import type { RenderOptions, RenderQuality, Renderer } from './render/renderer';
import type { BlobStore } from './storage/types';

export interface ExportRequest {
  quality?: RenderQuality;
  width?: number;
  fps?: number;
  range?: { start: number; end: number };
  /** File name prefix (default: project name). */
  name?: string;
}

export interface ExportJob {
  id: string;
  projectId: string;
  status: 'running' | 'done' | 'failed';
  progress: number;
  quality: RenderQuality;
  fileName?: string;
  /** Download URL path, relative to the server. */
  url?: string;
  /** Absolute path on the server machine. */
  path?: string;
  sizeBytes?: number;
  duration?: number;
  width?: number;
  height?: number;
  warnings?: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'export'
  );
}

/** Runs server-side renders as jobs and stores results under exports/<projectId>/. */
export class ExportService {
  private readonly jobs = new Map<string, ExportJob>();

  constructor(
    private readonly renderer: Renderer,
    private readonly blobs: BlobStore,
    private readonly docs: DocumentService,
  ) {}

  get(id: string): ExportJob | undefined {
    return this.jobs.get(id);
  }

  static url(projectId: string, fileName: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(fileName)}`;
  }

  /** Renders and resolves when finished (progress is also reported as editor activity). */
  async run(
    projectId: string,
    request: ExportRequest,
    origin: Origin,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<ExportJob> {
    const { done } = await this.begin(projectId, request, origin, onProgress, signal);
    return done;
  }

  /** Creates a job and starts rendering in the background. */
  async begin(
    projectId: string,
    request: ExportRequest,
    origin: Origin,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<{ job: ExportJob; done: Promise<ExportJob> }> {
    const { project } = await this.docs.get(projectId);
    const quality = request.quality ?? 'standard';
    const job: ExportJob = {
      id: randomUUID(),
      projectId,
      status: 'running',
      progress: 0,
      quality,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    const tool = quality === 'preview' ? 'render_preview' : 'export_video';
    const report = (
      status: 'started' | 'progress' | 'finished' | 'failed',
      message: string,
      link?: string,
    ) =>
      this.docs.activity({
        projectId,
        id: job.id,
        origin,
        tool,
        status,
        message,
        progress: job.progress,
        at: new Date().toISOString(),
        ...(link ? { link } : {}),
      });
    report('started', quality === 'preview' ? 'Rendering a preview…' : 'Exporting video…');
    const done = this.execute(job, project, request, onProgress, signal, report);
    done.catch(() => undefined);
    return { job, done };
  }

  private async execute(
    job: ExportJob,
    project: Project,
    request: ExportRequest,
    onProgress: ((fraction: number) => void) | undefined,
    signal: AbortSignal | undefined,
    report: (status: 'progress' | 'finished' | 'failed', message: string, link?: string) => void,
  ): Promise<ExportJob> {
    const { projectId, quality } = job;
    const dir = await mkdtemp(join(tmpdir(), 'cutline-export-'));
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const fileName = `${slug(request.name ?? project.name)}-${quality === 'preview' ? 'preview-' : ''}${stamp}-${job.id.slice(0, 4)}.mp4`;
    const tmp = join(dir, fileName);
    let lastReported = 0;
    const options: RenderOptions = {
      quality,
      width: request.width,
      fps: request.fps,
      range: request.range,
      signal,
      onProgress: (p) => {
        job.progress = p;
        onProgress?.(p);
        if (p - lastReported >= 0.05) {
          lastReported = p;
          report('progress', `${Math.round(p * 100)}%`);
        }
      },
    };
    try {
      const result = await this.renderer.render(project, tmp, options);
      const key = `exports/${projectId}/${fileName}`;
      job.sizeBytes = await this.blobs.putFile(key, tmp);
      job.path = await this.blobs.localPath(key);
      job.fileName = fileName;
      job.url = ExportService.url(projectId, fileName);
      job.duration = result.duration;
      job.width = result.width;
      job.height = result.height;
      job.warnings = result.warnings;
      job.status = 'done';
      job.progress = 1;
      report('finished', `Exported ${fileName} (${formatTime(result.duration)}).`, job.url);
      return job;
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      report('failed', `Export failed: ${job.error.split('\n')[0]}`);
      throw err;
    } finally {
      job.finishedAt = new Date().toISOString();
      await rm(dir, { recursive: true, force: true });
    }
  }

  async list(
    projectId: string,
  ): Promise<Array<{ fileName: string; url: string; sizeBytes: number }>> {
    const keys = await this.blobs.list(`exports/${projectId}`);
    const out = [];
    for (const key of keys) {
      const stat = await this.blobs.stat(key);
      const fileName = key.split('/').pop()!;
      out.push({
        fileName,
        url: ExportService.url(projectId, fileName),
        sizeBytes: stat?.size ?? 0,
      });
    }
    return out.sort((a, b) => b.fileName.localeCompare(a.fileName));
  }
}
