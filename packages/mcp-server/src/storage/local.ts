import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStat, BlobStore, ProjectStore } from './types';

/** Resolves `key` below `root`, refusing anything that escapes it (path traversal). */
function safeJoin(root: string, key: string): string {
  const full = resolve(root, key);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid storage key "${key}"`);
  }
  return full;
}

/** Projects as JSON files: <dir>/<id>.json, written atomically. */
export class LocalProjectStore implements ProjectStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<string[]> {
    await mkdir(this.dir, { recursive: true });
    const files = await readdir(this.dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  async read(id: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(safeJoin(this.dir, `${id}.json`), 'utf8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(id: string, doc: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = safeJoin(this.dir, `${id}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, path);
  }

  async delete(id: string): Promise<void> {
    await rm(safeJoin(this.dir, `${id}.json`), { force: true });
  }
}

/** Blobs as files below a root directory; keys are relative paths. */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return safeJoin(this.root, key);
  }

  async put(key: string, data: Readable | Buffer): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    try {
      await pipeline(Buffer.isBuffer(data) ? Readable.from([data]) : data, createWriteStream(tmp));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return (await stat(path)).size;
  }

  async putFile(key: string, source: string): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(source, path);
    return (await stat(path)).size;
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const s = await stat(this.path(key));
      return s.isFile() ? { size: s.size, modified: s.mtime } : null;
    } catch {
      return null;
    }
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(key), range);
  }

  async localPath(key: string): Promise<string> {
    return this.path(key);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true, recursive: true });
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.path(prefix);
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join('/'));
    } catch {
      return [];
    }
  }
}
