import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  Input,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
  type Source,
} from 'mediabunny';
import type { Asset } from '@cutline/core';
import { getCachedAsset } from './opfs-cache';

export interface AssetLocator {
  /** Absolute URL of the asset file (supports HTTP range requests). */
  url(asset: Asset): string;
  /** Extra fetch options, e.g. an Authorization header. */
  fetchInit?: RequestInit;
  /** Cache media in OPFS (default true). */
  useOpfs?: boolean;
}

export interface OpenedMedia {
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
}

/** Lazily opens assets with Mediabunny and shares the demuxers between users. */
export class MediaPool {
  private readonly opened = new Map<string, Promise<OpenedMedia>>();
  private readonly images = new Map<string, Promise<ImageBitmap>>();

  constructor(private readonly locator: AssetLocator) {}

  private async source(asset: Asset): Promise<Source> {
    const url = this.locator.url(asset);
    if (this.locator.useOpfs !== false) {
      const cached = await getCachedAsset(asset.id, url, this.locator.fetchInit);
      if (cached) return new BlobSource(cached);
    }
    return new UrlSource(url, { requestInit: this.locator.fetchInit });
  }

  open(asset: Asset): Promise<OpenedMedia> {
    let entry = this.opened.get(asset.id);
    if (!entry) {
      entry = (async () => {
        const input = new Input({ source: await this.source(asset), formats: ALL_FORMATS });
        const video = asset.hasVideo ? await input.getPrimaryVideoTrack() : null;
        const audio = asset.hasAudio ? await input.getPrimaryAudioTrack() : null;
        return {
          input,
          video,
          audio,
          canDecodeVideo: video ? await video.canDecode() : false,
          canDecodeAudio: audio ? await audio.canDecode() : false,
        };
      })();
      entry.catch(() => this.opened.delete(asset.id));
      this.opened.set(asset.id, entry);
    }
    return entry;
  }

  /** Decoded still image (image assets). */
  image(asset: Asset): Promise<ImageBitmap> {
    let entry = this.images.get(asset.id);
    if (!entry) {
      entry = (async () => {
        const res = await fetch(this.locator.url(asset), this.locator.fetchInit);
        if (!res.ok) throw new Error(`Failed to load image ${asset.name}: HTTP ${res.status}`);
        return createImageBitmap(await res.blob());
      })();
      entry.catch(() => this.images.delete(asset.id));
      this.images.set(asset.id, entry);
    }
    return entry;
  }

  async canvasSink(asset: Asset, maxWidth: number, maxHeight: number): Promise<CanvasSink | null> {
    const media = await this.open(asset);
    if (!media.video || !media.canDecodeVideo) return null;
    const w = await media.video.getDisplayWidth();
    const h = await media.video.getDisplayHeight();
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return new CanvasSink(media.video, {
      width: Math.max(2, Math.round(w * scale)),
      height: Math.max(2, Math.round(h * scale)),
      fit: 'fill',
      poolSize: 2,
    });
  }

  async audioSink(asset: Asset): Promise<AudioSampleSink | null> {
    const media = await this.open(asset);
    if (!media.audio || !media.canDecodeAudio) return null;
    return new AudioSampleSink(media.audio);
  }

  dispose(): void {
    for (const entry of this.opened.values()) {
      entry.then((m) => m.input.dispose()).catch(() => undefined);
    }
    for (const entry of this.images.values()) {
      entry.then((b) => b.close()).catch(() => undefined);
    }
    this.opened.clear();
    this.images.clear();
  }
}
