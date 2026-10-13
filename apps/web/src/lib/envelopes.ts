import type { Envelope } from '@cutline/core';
import { create } from 'zustand';
import { api } from './api';

interface EnvelopesState {
  projectId: string | null;
  byAsset: Record<string, Envelope | null>;
  loaded: Record<string, boolean>;
  load(projectId: string, assetId: string): Promise<void>;
}

const pending = new Map<string, Promise<void>>();

export const useEnvelopes = create<EnvelopesState>()((set, get) => ({
  projectId: null,
  byAsset: {},
  loaded: {},

  load(projectId, assetId) {
    if (get().projectId !== projectId) {
      set({ projectId, byAsset: {}, loaded: {} });
    }
    if (get().loaded[assetId]) return Promise.resolve();

    const key = `${projectId}:${assetId}`;
    const existing = pending.get(key);
    if (existing) return existing;

    const task = (async () => {
      try {
        const { envelope } = await api.getEnvelope(projectId, assetId);
        if (get().projectId !== projectId) return;
        set((s) => ({
          byAsset: { ...s.byAsset, [assetId]: envelope },
          loaded: { ...s.loaded, [assetId]: true },
        }));
      } catch {
        if (get().projectId !== projectId) return;
        set((s) => ({
          byAsset: { ...s.byAsset, [assetId]: null },
          loaded: { ...s.loaded, [assetId]: true },
        }));
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  },
}));
