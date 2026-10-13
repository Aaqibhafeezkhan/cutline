import { useSyncExternalStore } from 'react';

/** Minimal history-API router: "/" and "/p/:projectId". */
const listeners = new Set<() => void>();

export function navigate(path: string): void {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}
