export type IdPrefix = 'proj' | 'asset' | 'track' | 'clip' | 'marker';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/** Random, URL-safe, human-skimmable id such as `clip_k3x9a0bq`. */
export function randomId(prefix: IdPrefix, length = 8): string {
  const { crypto } = globalThis as unknown as { crypto: CryptoLike };
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Context injected into operations so they stay pure and testable. */
export interface OpContext {
  now(): string;
  newId(prefix: IdPrefix): string;
}

export const defaultContext: OpContext = {
  now: () => new Date().toISOString(),
  newId: (prefix) => randomId(prefix),
};

/** Deterministic ids (`clip_1`, `clip_2`, …) and a fixed clock, for tests and fixtures. */
export function sequentialContext(now = '2026-01-01T00:00:00.000Z'): OpContext {
  const counters = new Map<IdPrefix, number>();
  return {
    now: () => now,
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
}
