import type { Project } from '@cutline/core';
import type { AssetLocator } from '../media/media-pool';
import type { ExportWorkerRequest } from './export.worker';
import type { ExportOptions, ExportProgress, ExportResult } from './plan';

export interface ExportVideoOptions extends ExportOptions {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** Run on the main thread instead of a worker (debugging / no OffscreenCanvas). */
  mainThread?: boolean;
}

function supportsWorkerExport(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * Exports the project to a video file in the browser. Rendering, decoding
 * and encoding run in a Web Worker; falls back to the main thread when
 * workers with OffscreenCanvas are unavailable.
 */
export async function exportVideo(
  project: Project,
  locator: AssetLocator,
  options: ExportVideoOptions = {},
): Promise<ExportResult> {
  const { onProgress, signal, mainThread, ...exportOptions } = options;
  if (mainThread || !supportsWorkerExport()) {
    const { renderExport } = await import('./exporter');
    const canvasFactory = (w: number, h: number) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    return renderExport(project, locator, exportOptions, onProgress, canvasFactory, signal);
  }

  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  const assetUrls = Object.fromEntries(project.assets.map((a) => [a.id, locator.url(a)]));
  const request: ExportWorkerRequest = {
    project,
    assetUrls,
    fetchInit: locator.fetchInit,
    options: exportOptions,
  };
  return new Promise<ExportResult>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(new DOMException('Export aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'progress'; progress: ExportProgress }
        | { type: 'done'; result: ExportResult }
        | { type: 'error'; message: string };
      if (msg.type === 'progress') {
        onProgress?.(msg.progress);
        return;
      }
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (msg.type === 'done') resolve(msg.result);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      reject(new Error(`Export worker failed: ${e.message}`));
    };
    worker.postMessage(request);
  });
}
