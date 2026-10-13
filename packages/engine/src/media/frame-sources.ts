import type { Asset, FrameDescription } from '@cutline/core';
import type { FrameSources } from '../render/compositor';
import { FrameReader } from './frame-reader';
import type { MediaPool } from './media-pool';

interface ReaderEntry {
  assetId: string;
  reader: Promise<FrameReader | null>;
}

/** Fetches decoded pixels for every visual layer of a frame. */
export class FrameSourceProvider {
  private readers = new Map<string, ReaderEntry>();
  private warned = new Set<string>();

  constructor(
    private readonly pool: MediaPool,
    private maxWidth: number,
    private maxHeight: number,
  ) {}

  /** Changes the decode resolution (drops existing decoders). */
  setMaxSize(maxWidth: number, maxHeight: number): void {
    if (maxWidth === this.maxWidth && maxHeight === this.maxHeight) return;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.disposeReaders();
  }

  private reader(clipId: string, asset: Asset): Promise<FrameReader | null> {
    const existing = this.readers.get(clipId);
    if (existing && existing.assetId === asset.id) return existing.reader;
    if (existing) void existing.reader.then((r) => r?.dispose());
    const reader = this.pool
      .canvasSink(asset, this.maxWidth, this.maxHeight)
      .then((sink) => (sink ? new FrameReader(sink) : null));
    this.readers.set(clipId, { assetId: asset.id, reader });
    return reader;
  }

  async gather(frame: FrameDescription, assets: ReadonlyMap<string, Asset>): Promise<FrameSources> {
    const video: FrameSources['video'] = new Map();
    const images: FrameSources['images'] = new Map();
    await Promise.all(
      frame.layers.map(async (layer) => {
        const asset = layer.assetId ? assets.get(layer.assetId) : undefined;
        if (!asset) return;
        try {
          if (layer.type === 'video') {
            const reader = await this.reader(layer.clipId, asset);
            const wrapped = await reader?.frameAt(layer.sourceTime ?? 0);
            if (wrapped) video.set(layer.clipId, wrapped.canvas);
          } else if (layer.type === 'image') {
            images.set(asset.id, await this.pool.image(asset));
          }
        } catch (err) {
          if (!this.warned.has(asset.id)) {
            this.warned.add(asset.id);
            console.warn(`[cutline] cannot decode ${asset.name}:`, err);
          }
        }
      }),
    );
    return { video, images };
  }

  /** Disposes decoders of clips that no longer exist. */
  prune(clipIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.readers) {
      if (!clipIds.has(id)) {
        void entry.reader.then((r) => r?.dispose());
        this.readers.delete(id);
      }
    }
  }

  disposeReaders(): void {
    for (const entry of this.readers.values()) void entry.reader.then((r) => r?.dispose());
    this.readers.clear();
  }
}
