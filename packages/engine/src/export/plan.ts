import { projectDuration, type Project } from '@cutline/core';

export interface ExportOptions {
  /** Output width (default: project width). Height follows the project aspect ratio unless given. */
  width?: number;
  height?: number;
  fps?: number;
  quality?: 'low' | 'medium' | 'high' | 'very-high';
  container?: 'mp4' | 'webm';
  /** Export only part of the timeline. */
  range?: { start: number; end: number };
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing' | 'done';
  /** 0..1 */
  progress: number;
  frame: number;
  totalFrames: number;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Resolves export options against the project: size (even numbers for H.264), fps, range, frames. */
export function exportPlan(project: Project, options: ExportOptions = {}) {
  const { width: pw, height: ph, fps: pfps } = project.settings;
  const width = even(options.width ?? pw);
  const height = even(options.height ?? (options.width ? (options.width * ph) / pw : ph));
  const fps = options.fps ?? pfps;
  const total = projectDuration(project);
  const start = Math.max(0, Math.min(options.range?.start ?? 0, total));
  const end = Math.max(start, Math.min(options.range?.end ?? total, total));
  const totalFrames = Math.max(0, Math.round((end - start) * fps));
  return {
    width,
    height,
    fps,
    start,
    end,
    duration: end - start,
    totalFrames,
    container: options.container ?? 'mp4',
  };
}
