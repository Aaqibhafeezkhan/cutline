/// <reference lib="webworker" />
import { DOMAdapter, WebWorkerAdapter } from 'pixi.js';
import type { Asset, Project } from '@cutline/core';
import { renderExport } from './exporter';
import type { ExportOptions } from './plan';

DOMAdapter.set(WebWorkerAdapter);

export interface ExportWorkerRequest {
  project: Project;
  assetUrls: Record<string, string>;
  fetchInit?: RequestInit;
  options: ExportOptions;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  const { project, assetUrls, fetchInit, options } = event.data;
  try {
    const result = await renderExport(
      project,
      { url: (asset: Asset) => assetUrls[asset.id] ?? '', fetchInit },
      options,
      (progress) => ctx.postMessage({ type: 'progress', progress }),
    );
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
