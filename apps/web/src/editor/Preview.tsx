import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { projectDuration } from '@cutline/core';
import { Player } from '@cutline/engine';
import { Button } from '@/components/ui/button';
import { assetUrl, getToken } from '@/lib/api';
import { seek, setPlayer, togglePlay } from '@/lib/player-bridge';
import { useEditor, usePlayhead } from '@/lib/store';
import { formatTimecode } from '@/lib/utils';
import { CanvasOverlay, type DraftFn } from './canvas/CanvasOverlay';

/** WebGL preview of the live document (the engine re-renders on every change). */
export function Preview() {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [player, setPlayerState] = useState<Player | null>(null);
  // While dragging on the canvas the preview shows a local draft of the document.
  const draftRef = useRef<DraftFn | null>(null);
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const [error, setError] = useState<string | null>(null);
  const playing = usePlayhead((s) => s.playing);
  const time = usePlayhead((s) => s.time);

  useEffect(() => {
    if (!host.current || !projectId) return;
    let disposed = false;
    const token = getToken();
    // One canvas per Player: two WebGL apps must never share a canvas (and its context),
    // which happens with React StrictMode's double mount if the element is reused.
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    canvas.setAttribute('aria-label', 'Video preview');
    // object-fit letterboxes the canvas inside whatever space the layout gives it.
    canvas.className = 'block h-full w-full object-contain';
    host.current.appendChild(canvas);
    void Player.create({
      canvas,
      locator: {
        url: (asset) => assetUrl(projectId, asset),
        fetchInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
      },
      onTimeUpdate: (t) => usePlayhead.getState().setTime(t),
      onPlayStateChange: (p) => usePlayhead.getState().setPlaying(p),
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    })
      .then((player) => {
        if (disposed) return player.destroy();
        playerRef.current = player;
        setPlayer(player);
        setPlayerState(player);
        const current = useEditor.getState().project;
        if (current) {
          player.setProject(current);
          player.seek(usePlayhead.getState().time);
        }
      })
      .catch((err: unknown) =>
        setError(`Preview unavailable: ${err instanceof Error ? err.message : String(err)}`),
      );
    return () => {
      disposed = true;
      setPlayer(null);
      setPlayerState(null);
      playerRef.current?.destroy();
      playerRef.current = null;
      canvas.remove();
    };
  }, [projectId]);

  useEffect(() => {
    const draft = draftRef.current;
    if (project) playerRef.current?.setProject(draft ? draft(project) : project);
  }, [project]);

  const setDraft = useCallback((draft: DraftFn | null, render = true) => {
    draftRef.current = draft;
    const current = useEditor.getState().project;
    if (render && current) playerRef.current?.setProject(draft ? draft(current) : current);
  }, []);

  const duration = project ? projectDuration(project) : 0;

  return (
    <section aria-label="Preview" className="flex h-full min-h-0 flex-col bg-black/40">
      <div className="min-h-0 flex-1 p-3">
        <div className="relative h-full w-full">
          <div ref={host} className="h-full w-full" />
          <CanvasOverlay player={player} setDraft={setDraft} />
          {error && (
            <div
              role="alert"
              className="absolute inset-x-2 bottom-2 rounded bg-danger/90 px-2 py-1 text-xs"
            >
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-border bg-surface py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Go to start (Home)"
          onClick={() => seek(0)}
        >
          <SkipBack />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
          disabled={duration === 0}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Go to end (End)"
          onClick={() => seek(duration)}
        >
          <SkipForward />
        </Button>
        <span className="ml-2 w-36 font-mono text-xs tabular-nums text-muted">
          {formatTimecode(time)} / {formatTimecode(duration)}
        </span>
      </div>
    </section>
  );
}
