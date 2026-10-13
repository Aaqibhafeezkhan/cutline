import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { api, type BeatInfo } from './api';
import { useEditor } from './store';

/** Beat grids per asset (source time), fetched from the server's analysis cache. */
interface BeatsState {
  projectId: string | null;
  byAsset: Record<string, BeatInfo>;
  busy: Record<string, boolean>;
  /** Fetches grids the server already computed (never starts an analysis). */
  load(projectId: string, assetIds: readonly string[]): Promise<void>;
  /** Analyses an asset's audio now. */
  detect(projectId: string, assetId: string): Promise<void>;
}

export const useBeats = create<BeatsState>()((set, get) => ({
  projectId: null,
  byAsset: {},
  busy: {},

  async load(projectId, assetIds) {
    if (get().projectId !== projectId) set({ projectId, byAsset: {}, busy: {} });
    const results = await Promise.all(
      assetIds.map((id) =>
        api
          .getBeats(projectId, id)
          .then((r) => [id, r.beats] as const)
          .catch(() => [id, null] as const),
      ),
    );
    if (get().projectId !== projectId) return;
    const found: Record<string, BeatInfo> = {};
    for (const [id, beats] of results) if (beats) found[id] = beats;
    set((s) => ({ byAsset: { ...s.byAsset, ...found } }));
  },

  async detect(projectId, assetId) {
    if (get().projectId !== projectId) set({ projectId, byAsset: {}, busy: {} });
    set((s) => ({ busy: { ...s.busy, [assetId]: true } }));
    try {
      const { beats } = await api.detectBeats(projectId, assetId);
      if (get().projectId !== projectId) return;
      set((s) => ({ byAsset: { ...s.byAsset, [assetId]: beats } }));
      if (beats.beats.length === 0) toast.info('No steady beat found.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      set((s) => ({ busy: { ...s.busy, [assetId]: false } }));
    }
  },
}));

/**
 * Keeps beat grids for the project's audio in sync: loads the ones the server already knows on
 * open, and again whenever an agent finishes detect_beats or cut_to_beats.
 */
export function useBeatSync(): void {
  const projectId = useEditor((s) => s.projectId);
  const assetKey = useEditor((s) => {
    const p = s.project;
    if (!p) return '';
    const ids = new Set<string>();
    for (const t of p.tracks)
      for (const c of t.clips)
        if (c.type === 'audio' || c.type === 'video') {
          if (p.assets.find((a) => a.id === c.assetId)?.hasAudio) ids.add(c.assetId);
        }
    return [...ids].sort().join(',');
  });
  const lastAnalysis = useEditor(
    (s) =>
      s.activity.find(
        (a) => (a.tool === 'detect_beats' || a.tool === 'cut_to_beats') && a.status === 'finished',
      )?.id,
  );
  useEffect(() => {
    if (projectId && assetKey) void useBeats.getState().load(projectId, assetKey.split(','));
  }, [projectId, assetKey, lastAnalysis]);
}
