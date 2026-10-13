/**
 * Caches asset files in the Origin Private File System so large media is
 * downloaded once and then read with fast random access (seeking).
 * Falls back to plain network access when OPFS is unavailable.
 */

const DIR = 'cutline-assets';
const inflight = new Map<string, Promise<Blob | null>>();

async function assetDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

function fileName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Returns the cached file for `key`, downloading `url` into OPFS on first use.
 * Resolves to null if OPFS is not available (callers then stream from `url`).
 */
export function getCachedAsset(
  key: string,
  url: string,
  fetchInit?: RequestInit,
): Promise<Blob | null> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = (async () => {
    const dir = await assetDir();
    if (!dir) return null;
    const name = fileName(key);
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      if (file.size > 0) return file;
    } catch {
      // not cached yet
    }
    const res = await fetch(url, fetchInit);
    if (!res.ok || !res.body)
      throw new Error(`Failed to download asset ${key}: HTTP ${res.status}`);
    const handle = await dir.getFileHandle(name, { create: true });
    // createWritable is unavailable in some browsers (older Safari): keep it in memory instead.
    if (!('createWritable' in handle)) return await res.blob();
    // Writes go to a swap file and are committed atomically when the stream closes,
    // so an interrupted download never leaves a truncated cache entry.
    await res.body.pipeTo(await handle.createWritable());
    return await handle.getFile();
  })().catch((err: unknown) => {
    inflight.delete(key);
    console.warn('[cutline] OPFS cache unavailable, streaming instead:', err);
    return null;
  });
  inflight.set(key, task);
  return task;
}

/** Removes every cached asset (e.g. from a settings menu). */
export async function clearAssetCache(): Promise<void> {
  inflight.clear();
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true });
  } catch {
    // nothing cached
  }
}
