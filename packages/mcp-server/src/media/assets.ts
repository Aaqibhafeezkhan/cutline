import { lookup } from 'node:dns/promises';
import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, extname, relative, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { CutlineError, randomId, type Asset, type Origin } from '@cutline/core';
import type { CutlineConfig } from '../config';
import type { DocumentService } from '../documents';
import type { BlobStore } from '../storage/types';
import type { Ffmpeg } from './ffmpeg';
import { guessMimeType, probeFile, type ProbeResult } from './probe';

const SAFE_NAME = /[^A-Za-z0-9._ -]/g;

function safeFileName(name: string): string {
  const base = basename(name).replace(SAFE_NAME, '_').slice(0, 120);
  return base || 'media';
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return (
      v6 === '::1' ||
      v6 === '::' ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') ||
      v6.startsWith('fe80')
    );
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function sizeLimiter(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > max)
        cb(
          new CutlineError(
            'OUT_OF_RANGE',
            `File exceeds the ${Math.round(max / 1048576)} MB limit.`,
          ),
        );
      else cb(null, chunk);
    },
  });
}

/** Imports media into the blob store and registers it as a project asset. */
export class AssetService {
  constructor(
    private readonly config: CutlineConfig,
    private readonly blobs: BlobStore,
    private readonly docs: DocumentService,
    private readonly ffmpeg: Ffmpeg,
  ) {}

  /** Storage key for an asset file. */
  static key(assetId: string, fileName: string): string {
    return `assets/${assetId}/${fileName}`;
  }

  private async assertReadable(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new CutlineError('INVALID_ARGUMENT', `"${path}" is not an absolute path.`, {
        hint: 'Pass the full path of the file on the machine running the Cutline server.',
      });
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new CutlineError('NOT_FOUND', `File "${path}" does not exist.`);
    }
    const allowed = await Promise.all(
      this.config.mediaRoots.map(async (root) => {
        const r = await realpath(root).catch(() => root);
        const rel = relative(r, real);
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      }),
    );
    if (!allowed.some(Boolean)) {
      throw new CutlineError('INVALID_ARGUMENT', `Reading "${path}" is not allowed.`, {
        hint: `Files must be inside CUTLINE_MEDIA_ROOTS (${this.config.mediaRoots.join(', ')}).`,
      });
    }
    const s = await stat(real);
    if (!s.isFile()) throw new CutlineError('INVALID_ARGUMENT', `"${path}" is not a file.`);
    return real;
  }

  async importFromPath(
    projectId: string,
    path: string,
    origin: Origin,
    name?: string,
  ): Promise<Asset> {
    const real = await this.assertReadable(path);
    return this.register(projectId, origin, name ?? basename(real), async (key) => {
      await this.blobs.putFile(key, real);
    });
  }

  async importFromUrl(
    projectId: string,
    url: string,
    origin: Origin,
    name?: string,
  ): Promise<Asset> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CutlineError('INVALID_ARGUMENT', `"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CutlineError('INVALID_ARGUMENT', 'Only http(s) URLs can be imported.');
    }
    if (!this.config.allowPrivateUrls) {
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host)
        ? [host]
        : (await lookup(host, { all: true })).map((a) => a.address);
      if (addresses.some(isPrivateAddress)) {
        throw new CutlineError(
          'INVALID_ARGUMENT',
          `Refusing to download from private address ${host}.`,
          {
            hint: 'Set CUTLINE_ALLOW_PRIVATE_URLS=1 to allow local network downloads.',
          },
        );
      }
    }
    const res = await fetch(parsed, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new CutlineError('INVALID_ARGUMENT', `Download failed: HTTP ${res.status} for ${url}.`);
    }
    const fileName = name ?? (decodeURIComponent(basename(parsed.pathname)) || 'download');
    const body = Readable.fromWeb(res.body as never);
    return this.register(projectId, origin, fileName, async (key) => {
      await this.blobs.put(key, body.pipe(sizeLimiter(this.config.maxUploadBytes)));
    });
  }

  async importFromStream(
    projectId: string,
    stream: Readable,
    fileName: string,
    origin: Origin,
  ): Promise<Asset> {
    return this.register(projectId, origin, fileName, async (key) => {
      await this.blobs.put(key, stream.pipe(sizeLimiter(this.config.maxUploadBytes)));
    });
  }

  private async register(
    projectId: string,
    origin: Origin,
    displayName: string,
    write: (key: string) => Promise<void>,
  ): Promise<Asset> {
    await this.docs.get(projectId); // fail fast on unknown projects
    const assetId = randomId('asset');
    const fileName = safeFileName(displayName);
    const key = AssetService.key(assetId, fileName);
    await write(key);
    let probe: ProbeResult;
    try {
      probe = await probeFile(await this.blobs.localPath(key), this.ffmpeg);
    } catch (err) {
      await this.blobs.delete(`assets/${assetId}`);
      throw err;
    }
    const size = (await this.blobs.stat(key))?.size;
    const result = await this.docs.apply(
      projectId,
      [
        {
          type: 'add_asset',
          asset: {
            id: assetId,
            name: displayName.slice(0, 256),
            kind: probe.kind,
            src: key,
            mimeType:
              probe.mimeType === 'application/octet-stream'
                ? guessMimeType(fileName)
                : probe.mimeType,
            duration: probe.duration,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            hasVideo: probe.hasVideo,
            hasAudio: probe.hasAudio,
            sizeBytes: size,
          },
        },
      ],
      origin,
      `Import ${displayName}`,
    );
    return result.project.assets.find((a) => a.id === assetId)!;
  }

  extensionOf(asset: Asset): string {
    return extname(asset.src);
  }
}
