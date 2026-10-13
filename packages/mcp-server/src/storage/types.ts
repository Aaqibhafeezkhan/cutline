import type { Readable } from 'node:stream';

/**
 * Storage adapters. The local-disk implementation is the default; an S3/R2
 * adapter only has to implement these two interfaces (see docs/storage.md).
 */
export interface ProjectStore {
  list(): Promise<string[]>;
  /** Raw JSON document (migrations are applied by the caller), or null. */
  read(id: string): Promise<unknown | null>;
  write(id: string, doc: unknown): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface BlobStat {
  size: number;
  modified: Date;
}

export interface BlobStore {
  /** Stores a stream under `key`; returns the byte size. */
  put(key: string, data: Readable | Buffer): Promise<number>;
  /** Copies a local file into the store. */
  putFile(key: string, path: string): Promise<number>;
  stat(key: string): Promise<BlobStat | null>;
  read(key: string, range?: { start: number; end: number }): Readable;
  /**
   * A local filesystem path for `key` (ffmpeg needs one). Remote adapters
   * download to a cache directory first.
   */
  localPath(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
