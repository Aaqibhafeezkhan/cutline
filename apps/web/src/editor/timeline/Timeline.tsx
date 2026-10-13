import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from 'react';
import { Circle, Magnet, Minus, Plus, Scissors, Square, Trash2, Type } from 'lucide-react';
import { clipEnd, projectDuration, type Clip, type Track } from '@cutline/core';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/misc';
import { useBeatSync, useBeats } from '@/lib/beats';
import { seek } from '@/lib/player-bridge';
import { useEditor, usePlayhead } from '@/lib/store';
import { cn, formatTimecode } from '@/lib/utils';
import { AddMenu } from '../AddMenu';
import { addShape, addText, deleteSelection, splitAtPlayhead } from '../commands';
import { ClipView, type DragKind } from './ClipView';
import {
  HEADER_WIDTH,
  RULER_HEIGHT,
  SNAP_PX,
  beatPoints,
  TRACK_HEIGHT,
  displayTracks,
  snap,
  snapBlock,
  snapPoints,
} from './geometry';
import { Ruler } from './Ruler';
import { TrackHeader } from './TrackHeader';

export const ASSET_DRAG_TYPE = 'application/x-cutline-asset';

interface DragState {
  clip: Clip;
  kind: DragKind;
  originX: number;
  originY: number;
  start: number;
  duration: number;
  trackId: string;
  moved: boolean;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const dispatch = useEditor((s) => s.dispatch);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const [snapping, setSnapping] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  useBeatSync();

  const tracks = useMemo(() => (project ? displayTracks(project) : []), [project]);
  const duration = project ? projectDuration(project) : 0;
  const contentWidth = Math.max((duration + 30) * zoom, 1200);

  // ctrl/cmd + wheel zooms around the pointer
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left + el.scrollLeft - HEADER_WIDTH;
      const t = x / useEditor.getState().zoom;
      const next = useEditor.getState().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = t * useEditor.getState().zoom - (e.clientX - rect.left - HEADER_WIDTH);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = scroller.current!;
      const rect = el.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left + el.scrollLeft - HEADER_WIDTH) / zoom);
    },
    [zoom],
  );

  const trackAtClientY = useCallback(
    (clientY: number): Track | null => {
      const el = lanes.current;
      if (!el) return null;
      let y = clientY - el.getBoundingClientRect().top;
      for (const track of tracks) {
        y -= TRACK_HEIGHT[track.kind];
        if (y < 0) return track;
      }
      return null;
    },
    [tracks],
  );

  const beginDrag = useCallback((clip: Clip, kind: DragKind, e: PointerEvent) => {
    const track = useEditor
      .getState()
      .project?.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!track || track.locked) return;
    // Keep receiving pointer events even when the pointer leaves the timeline.
    scroller.current?.setPointerCapture(e.pointerId);
    setDrag({
      clip,
      kind,
      originX: e.clientX,
      originY: e.clientY,
      start: clip.start,
      duration: clip.duration,
      trackId: track.id,
      moved: false,
    });
  }, []);

  const onPointerMove = (e: PointerEvent) => {
    if (!drag || !project) return;
    const dx = (e.clientX - drag.originX) / zoom;
    const moved =
      drag.moved ||
      Math.abs(e.clientX - drag.originX) > 3 ||
      Math.abs(e.clientY - drag.originY) > 3;
    if (!moved) return;
    const points = snapping
      ? snapPoints(
          project,
          [drag.clip.id],
          usePlayhead.getState().time,
          beatPoints(project, useBeats.getState().byAsset, [drag.clip.id]),
        )
      : [];
    const threshold = SNAP_PX / zoom;
    const c = drag.clip;
    const asset = 'assetId' in c ? project.assets.find((a) => a.id === c.assetId) : undefined;
    const minDur = 1 / project.settings.fps;
    if (drag.kind === 'move') {
      const start = Math.max(0, snapBlock(c.start + dx, c.duration, points, threshold));
      const target = trackAtClientY(e.clientY);
      const sameKind =
        target &&
        (target.kind === 'audio') === (c.type === 'audio') &&
        (target.kind === 'caption') === (c.type === 'caption');
      setDrag({
        ...drag,
        moved,
        start,
        trackId: sameKind && !target.locked ? target.id : drag.trackId,
      });
    } else if (drag.kind === 'trim-start') {
      let start = snap(c.start + dx, points, threshold).time;
      const earliest = 'sourceStart' in c ? c.start - c.sourceStart : 0;
      start = Math.min(Math.max(start, earliest, 0), clipEnd(c) - minDur);
      setDrag({ ...drag, moved, start, duration: clipEnd(c) - start });
    } else {
      let end = snap(clipEnd(c) + dx, points, threshold).time;
      const latest =
        'sourceStart' in c && asset?.duration ? c.start + asset.duration - c.sourceStart : Infinity;
      end = Math.max(Math.min(end, latest), c.start + minDur);
      setDrag({ ...drag, moved, duration: end - c.start });
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) {
      select([d.clip.id], e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    const c = d.clip;
    if (d.kind === 'move') {
      const originalTrack = project?.tracks.find((t) => t.clips.some((x) => x.id === c.id))?.id;
      if (Math.abs(d.start - c.start) < 1e-6 && d.trackId === originalTrack) return;
      void dispatch([
        {
          type: 'move_clip',
          clipId: c.id,
          start: d.start,
          ...(d.trackId !== originalTrack && { trackId: d.trackId }),
        },
      ]);
    } else if (d.kind === 'trim-start') {
      void dispatch([{ type: 'trim_clip', clipId: c.id, start: d.start }]);
    } else {
      void dispatch([{ type: 'trim_clip', clipId: c.id, end: c.start + d.duration }]);
    }
  };

  const onDrop = (e: DragEvent) => {
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!assetId || !project) return;
    e.preventDefault();
    const asset = project.assets.find((a) => a.id === assetId);
    const track = trackAtClientY(e.clientY);
    const start = timeAtClientX(e.clientX);
    const fits =
      track &&
      !track.locked &&
      ((asset?.kind === 'audio' && track.kind === 'audio') ||
        (asset?.kind !== 'audio' && track.kind === 'video'));
    void dispatch([{ type: 'add_clip', assetId, start, ...(fits && { trackId: track.id }) }]);
  };

  if (!project) return null;

  const dragTrackIndex = drag ? tracks.findIndex((t) => t.id === drag.trackId) : -1;
  const dragTop = tracks
    .slice(0, Math.max(0, dragTrackIndex))
    .reduce((y, t) => y + TRACK_HEIGHT[t.kind], 0);

  return (
    <section aria-label="Timeline" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Tooltip content="Split at playhead (S)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Split at playhead"
            onClick={() => void splitAtPlayhead()}
          >
            <Scissors />
          </Button>
        </Tooltip>
        <Tooltip content="Delete selection (Del, Shift+Del to ripple)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete selected clips"
            disabled={selection.length === 0}
            onClick={() => void deleteSelection(false)}
          >
            <Trash2 />
          </Button>
        </Tooltip>
        <Tooltip content="Snapping">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle snapping"
            aria-pressed={snapping}
            className={cn(snapping && 'text-primary')}
            onClick={() => setSnapping((s) => !s)}
          >
            <Magnet />
          </Button>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <AddMenu />
        <Tooltip content="Add text at playhead (T)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add text"
            onClick={() => void addText()}
          >
            <Type />
          </Button>
        </Tooltip>
        <Tooltip content="Add rectangle at playhead">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add rectangle"
            onClick={() => void addShape('rectangle')}
          >
            <Square />
          </Button>
        </Tooltip>
        <Tooltip content="Add ellipse at playhead">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add ellipse"
            onClick={() => void addShape('ellipse')}
          >
            <Circle />
          </Button>
        </Tooltip>
        <TimeReadout duration={duration} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => setZoom(zoom / 1.4)}
          >
            <Minus />
          </Button>
          <input
            aria-label="Timeline zoom"
            type="range"
            min={Math.log(4)}
            max={Math.log(800)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
            className="w-28 accent-[var(--color-primary)]"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => setZoom(zoom * 1.4)}
          >
            <Plus />
          </Button>
        </div>
      </div>

      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="relative" style={{ width: contentWidth + HEADER_WIDTH }}>
          <div className="sticky top-0 z-20 flex" style={{ height: RULER_HEIGHT }}>
            <div
              className="sticky left-0 z-30 shrink-0 border-b border-r border-border bg-surface"
              style={{ width: HEADER_WIDTH }}
            />
            <Ruler
              width={contentWidth}
              zoom={zoom}
              onSeek={(clientX) => seek(timeAtClientX(clientX))}
            />
          </div>

          <div className="flex">
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-border bg-surface"
              style={{ width: HEADER_WIDTH }}
            >
              {tracks.map((t) => (
                <TrackHeader key={t.id} track={t} />
              ))}
            </div>
            <div
              ref={lanes}
              className="relative"
              style={{ width: contentWidth }}
              onDragOver={(e) =>
                e.dataTransfer.types.includes(ASSET_DRAG_TYPE) && e.preventDefault()
              }
              onDrop={onDrop}
              onPointerDown={(e) => {
                if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.lane) {
                  select([]);
                  seek(timeAtClientX(e.clientX));
                }
              }}
            >
              {tracks.map((track) => (
                <div
                  key={track.id}
                  data-lane="true"
                  className={cn('relative border-b border-border/60', track.hidden && 'opacity-40')}
                  style={{ height: TRACK_HEIGHT[track.kind] }}
                >
                  {track.clips.map((clip) => (
                    <ClipView
                      key={clip.id}
                      clip={clip}
                      track={track}
                      zoom={zoom}
                      dragging={drag?.clip.id === clip.id && drag.moved}
                      onBeginDrag={beginDrag}
                    />
                  ))}
                </div>
              ))}
              {drag?.moved && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 rounded-md border-2 border-dashed border-primary bg-primary/20"
                  style={{
                    left: drag.start * zoom,
                    width: Math.max(2, drag.duration * zoom),
                    top: dragTop + 3,
                    height: TRACK_HEIGHT[tracks[dragTrackIndex]?.kind ?? 'video'] - 6,
                  }}
                />
              )}
              <PlayheadLine zoom={zoom} scroller={scroller} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TimeReadout({ duration }: { duration: number }) {
  const time = usePlayhead((s) => s.time);
  return (
    <div className="ml-2 font-mono text-xs tabular-nums text-muted" aria-live="off">
      <span className="text-foreground">{formatTimecode(time)}</span> / {formatTimecode(duration)}
    </div>
  );
}

function PlayheadLine({
  zoom,
  scroller,
}: {
  zoom: number;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const time = usePlayhead((s) => s.time);
  const playing = usePlayhead((s) => s.playing);
  const x = time * zoom;
  useEffect(() => {
    // Keep the playhead in view while playing.
    const el = scroller.current;
    if (!playing || !el) return;
    const visible = el.clientWidth - HEADER_WIDTH;
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40)
      el.scrollLeft = Math.max(0, x - visible * 0.2);
  }, [x, playing, scroller]);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-red-500"
      style={{ left: x }}
    />
  );
}
