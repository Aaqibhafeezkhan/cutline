import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { toast } from 'sonner';
import { applyOperation, type ClipPropsPatch, type Project, type VisualClip } from '@cutline/core';
import type { Player, RenderedFrame } from '@cutline/engine';
import { pause } from '@/lib/player-bridge';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  boundsToBox,
  boxContains,
  constrainAxis,
  containRect,
  cornerScaleFactor,
  displayScale,
  displayToProject,
  EDITABLE_TYPES,
  findVisualClip,
  hitTest,
  moveProps,
  pickableLayers,
  scaleProps,
  snapMove,
  type Box,
  type Point,
  type Rect,
  type Size,
} from './geometry';

/** Turns the live document into what the preview should show while a drag is in progress. */
export type DraftFn = (project: Project) => Project;

interface Props {
  player: Player | null;
  /** Shows a locally modified project (null = the live document). `render: false` keeps the frame. */
  setDraft: (draft: DraftFn | null, render?: boolean) => void;
}

/** Display pixels: drag threshold, snap distance and the grab margin around boxes. */
const DRAG_THRESHOLD = 3;
const SNAP_PX = 6;
const GRAB_PAD = 4;
const HANDLES = ['nw', 'ne', 'se', 'sw'] as const;
/** Snap guide: bright magenta with a dark halo so it reads on any footage. */
const GUIDE = 'absolute bg-[oklch(0.72_0.25_340)] shadow-[0_0_0_1px_rgb(0_0_0/0.45)]';

interface Drag {
  mode: 'move' | 'scale';
  clipId: string;
  pointerId: number;
  start: Point;
  startDisplay: Point;
  box: Box;
  clip: VisualClip;
  active: boolean;
  props: ClipPropsPatch | null;
}

interface DragView {
  guides: { x: number[]; y: number[] };
  label: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function describe(clip: VisualClip): string {
  const what =
    clip.type === 'text'
      ? `text overlay “${clip.text.slice(0, 40)}”`
      : clip.type === 'shape'
        ? (clip.name ?? clip.shape)
        : `${clip.type} ${clip.name ?? ''}`.trim();
  const t = clip.transform;
  return `${what}: x ${Math.round(t.x)}, y ${Math.round(t.y)}, scale ${pct(t.scale)}`;
}

function draftFor(clipId: string, props: ClipPropsPatch): DraftFn {
  return (project) => {
    try {
      return applyOperation(project, { type: 'set_clip_props', clipId, props }).project;
    } catch {
      return project;
    }
  };
}

function sameMotion(a: VisualClip, b: VisualClip): boolean {
  return (
    JSON.stringify([a.transform, a.keyframes ?? null]) ===
    JSON.stringify([b.transform, b.keyframes ?? null])
  );
}

function isNoop(clip: VisualClip, props: ClipPropsPatch): boolean {
  const t = props.transform ?? {};
  return (Object.keys(t) as Array<keyof typeof t>).every((k) => t[k] === clip.transform[k]);
}

/** Re-renders when the earliest agent highlight expires. */
function useActiveHighlights(): Set<string> {
  const highlights = useEditor((s) => s.highlights);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t0 = Date.now();
    const next = Math.min(
      ...Object.values(highlights)
        .map((h) => h.until)
        .filter((u) => u > t0),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), next - t0 + 20);
    return () => clearTimeout(timer);
  }, [highlights, now]);
  return useMemo(
    () =>
      new Set(
        Object.entries(highlights)
          .filter(([, h]) => h.until > now)
          .map(([id]) => id),
      ),
    // `now` is the clock this memo depends on; Date.now() inside would not re-run it.
    [highlights, now],
  );
}

/**
 * Interactive layer exactly over the letterboxed preview canvas: click to
 * select, drag to move, drag a corner to scale, arrow keys to nudge.
 */
export function CanvasOverlay({ player, setDraft }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const [frame, setFrame] = useState<RenderedFrame | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const drag = useRef<Drag | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const [hover, setHover] = useState(false);
  const [status, setStatus] = useState('');
  const highlighted = useActiveHighlights();
  const hintId = useId();

  // Geometry of the last rendered frame; skip identical frames (e.g. during playback).
  useEffect(() => {
    if (!player) return;
    let key = '';
    const update = (f: RenderedFrame) => {
      const next = JSON.stringify([f.canvasWidth, f.canvasHeight, f.projectWidth, f.layers]);
      if (next === key) return;
      key = next;
      setFrame(f);
    };
    const last = player.getRenderedFrame();
    if (last) update(last);
    return player.onRender(update);
  }, [player]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const canvas = useMemo(
    () => (frame ? { width: frame.canvasWidth, height: frame.canvasHeight } : null),
    [frame],
  );
  const frameSize = useMemo(
    () => (frame ? { width: frame.projectWidth, height: frame.projectHeight } : null),
    [frame],
  );
  const rect: Rect | null = canvas ? containRect(size, canvas) : null;

  const boxes = useMemo(() => {
    if (!frame || !canvas || !frameSize || !project) return [];
    return pickableLayers(frame.layers, project.tracks).map((l) => ({
      clipId: l.clipId,
      box: boundsToBox(l, canvas, frameSize),
    }));
  }, [frame, canvas, frameSize, project]);

  const selectedId = selection.length === 1 ? selection[0]! : null;
  const selected = useMemo(() => {
    if (!selectedId || !project || !frame || !canvas || !frameSize) return null;
    const found = findVisualClip(project, selectedId);
    const bounds = frame.layers.find((l) => l.clipId === selectedId);
    if (!found || !bounds || !EDITABLE_TYPES.has(bounds.type)) return null;
    return { ...found, box: boundsToBox(bounds, canvas, frameSize) };
  }, [selectedId, project, frame, canvas, frameSize]);

  const cancelDrag = useCallback(
    (notice?: string) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setDragView(null);
      if (root.current?.hasPointerCapture(d.pointerId)) {
        root.current.releasePointerCapture(d.pointerId);
      }
      if (d.active) setDraft(null);
      if (notice) toast.message(notice);
    },
    [setDraft],
  );

  // A patch arrived mid-drag: keep dragging on top of it unless the dragged clip itself
  // changed (an agent moved it, deleted it or locked its track), in which case it wins.
  useEffect(() => {
    const d = drag.current;
    if (!d || !project) return;
    const found = findVisualClip(project, d.clipId);
    if (!found || found.track.locked || !sameMotion(found.clip, d.clip)) {
      cancelDrag('The clip was changed by someone else, so your drag was cancelled.');
    }
  }, [project, cancelDrag]);

  // Escape cancels a drag (capture phase, before the editor's global shortcuts).
  useEffect(() => {
    if (!dragView) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelDrag();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragView, cancelDrag]);

  // Unmount (e.g. project switch) mid-drag: drop the draft.
  useEffect(() => () => cancelDrag(), [cancelDrag]);

  const toProject = (e: PointerEvent): Point | null => {
    if (!rect || !frameSize || rect.width === 0) return null;
    const r = root.current!.getBoundingClientRect();
    return displayToProject({ x: e.clientX - r.left, y: e.clientY - r.top }, rect, frameSize);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const p = toProject(e);
    const state = useEditor.getState();
    if (!p || !rect || !frameSize || !state.project) return;
    const pad = GRAB_PAD / displayScale(rect, frameSize);
    const handle = (e.target as HTMLElement).dataset.handle;
    const selectedEditable = selected && !selected.track.locked ? selected : null;

    let mode: Drag['mode'] = 'move';
    let clipId: string | null;
    if (handle && selectedEditable) {
      mode = 'scale';
      clipId = selectedEditable.clip.id;
    } else if (selectedEditable && boxContains(selectedEditable.box, p, pad)) {
      clipId = selectedEditable.clip.id;
    } else {
      clipId = hitTest(boxes, p, pad);
    }
    if (!clipId) {
      if (state.selection.length) state.select([]);
      return;
    }
    if (state.selection.length !== 1 || state.selection[0] !== clipId) state.select([clipId]);
    const found = findVisualClip(state.project, clipId);
    const box = boxes.find((b) => b.clipId === clipId)?.box;
    if (!found || !box) return;
    root.current!.setPointerCapture(e.pointerId);
    drag.current = {
      mode,
      clipId,
      pointerId: e.pointerId,
      start: p,
      startDisplay: { x: e.clientX, y: e.clientY },
      box,
      clip: found.clip,
      active: false,
      props: null,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) {
      const p = toProject(e);
      if (p && rect && frameSize) {
        const pad = GRAB_PAD / displayScale(rect, frameSize);
        setHover(hitTest(boxes, p, pad) !== null);
      }
      return;
    }
    if (e.pointerId !== d.pointerId || !rect || !frameSize) return;
    const p = toProject(e);
    if (!p) return;
    if (!d.active) {
      const moved = Math.hypot(e.clientX - d.startDisplay.x, e.clientY - d.startDisplay.y);
      if (moved < DRAG_THRESHOLD) return;
      d.active = true;
      pause();
    }
    let view: DragView;
    if (d.mode === 'move') {
      let delta = { x: p.x - d.start.x, y: p.y - d.start.y };
      const constrained = e.shiftKey;
      if (constrained) delta = constrainAxis(delta.x, delta.y);
      const threshold = SNAP_PX / displayScale(rect, frameSize);
      const lock = constrained ? { x: delta.x === 0, y: delta.y === 0 } : {};
      const snapped = snapMove(d.box, delta.x, delta.y, frameSize, threshold, lock);
      d.props = moveProps(d.clip, snapped.dx, snapped.dy);
      const t = d.props.transform!;
      view = { guides: snapped.guides, label: `x ${t.x} · y ${t.y}` };
    } else {
      const factor = cornerScaleFactor({ x: d.box.cx, y: d.box.cy }, d.start, p);
      d.props = scaleProps(d.clip, factor);
      view = { guides: { x: [], y: [] }, label: `scale ${pct(d.props.transform!.scale!)}` };
    }
    setDraft(draftFor(d.clipId, d.props));
    setDragView(view);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragView(null);
    if (root.current?.hasPointerCapture(d.pointerId)) {
      root.current.releasePointerCapture(d.pointerId);
    }
    if (!d.active || !d.props) return;
    if (isNoop(d.clip, d.props)) {
      setDraft(null);
      return;
    }
    // Keep showing the draft until the server's patch replaces it: one operation, one undo step.
    setDraft(null, false);
    const props = d.props;
    const label = d.mode === 'move' ? 'Move overlay' : 'Scale overlay';
    void useEditor
      .getState()
      .dispatch([{ type: 'set_clip_props', clipId: d.clipId, props }], label)
      .then((ok) => {
        if (!ok) setDraft(null);
        else {
          const clip = findVisualClip(useEditor.getState().project!, d.clipId)?.clip;
          if (clip) setStatus(`Moved ${describe(clip)}`);
        }
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = dir[e.key];
    if (!d || e.altKey || e.ctrlKey || e.metaKey || drag.current) return;
    if (!selected || selected.track.locked) return; // fall through to the playhead shortcuts
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 10 : 1;
    const props = moveProps(selected.clip, d[0] * step, d[1] * step);
    void useEditor
      .getState()
      .dispatch([{ type: 'set_clip_props', clipId: selected.clip.id, props }], 'Nudge overlay')
      .then((ok) => {
        const clip = ok && findVisualClip(useEditor.getState().project!, selected.clip.id)?.clip;
        if (clip) setStatus(describe(clip));
      });
  };

  const k = rect && frameSize ? displayScale(rect, frameSize) : 0;
  const boxStyle = (b: Box) => ({
    left: (b.cx - b.width / 2) * k,
    top: (b.cy - b.height / 2) * k,
    width: b.width * k,
    height: b.height * k,
    transform: `rotate(${b.rotation}rad)`,
  });
  const highlightBoxes =
    frame && canvas && frameSize
      ? frame.layers
          .filter((l) => highlighted.has(l.clipId))
          .map((l) => ({ id: l.clipId, box: boundsToBox(l, canvas, frameSize) }))
      : [];

  return (
    <div
      ref={root}
      tabIndex={0}
      role="group"
      aria-label="Preview canvas"
      aria-describedby={hintId}
      data-testid="canvas-overlay"
      className={cn(
        'absolute inset-0 touch-none select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70',
        dragView ? 'cursor-grabbing' : hover && 'cursor-move',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => cancelDrag()}
      onPointerLeave={() => setHover(false)}
      onKeyDown={onKeyDown}
    >
      <p id={hintId} className="sr-only">
        Click an overlay to select it. Drag it to move, drag a corner to scale, hold Shift to keep
        one axis. With the preview focused, arrow keys move the selected overlay by 1 pixel,
        Shift+arrow by 10 pixels.
      </p>
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      {rect && k > 0 && (
        <div
          className="pointer-events-none absolute overflow-hidden"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          {highlightBoxes.map(({ id, box }) => (
            <div
              key={`hl-${id}`}
              data-testid="canvas-agent-highlight"
              className="agent-highlight absolute rounded-sm"
              style={boxStyle(box)}
            />
          ))}
          {dragView?.guides.x.map((x) => (
            <div
              key={`gx-${x}`}
              data-testid="canvas-guide"
              className={cn(GUIDE, 'inset-y-0 w-px')}
              style={{ left: x * k }}
            />
          ))}
          {dragView?.guides.y.map((y) => (
            <div
              key={`gy-${y}`}
              data-testid="canvas-guide"
              className={cn(GUIDE, 'inset-x-0 h-px')}
              style={{ top: y * k }}
            />
          ))}
          {selected && (
            <div
              role="img"
              aria-label={`Selected ${describe(selected.clip)}${selected.track.locked ? ' (track locked)' : ''}`}
              data-testid="canvas-selection"
              className={cn(
                'absolute outline outline-1',
                selected.track.locked ? 'outline-dashed outline-muted' : 'outline-primary',
              )}
              style={boxStyle(selected.box)}
            >
              {!selected.track.locked &&
                HANDLES.map((h) => (
                  <div
                    key={h}
                    data-handle={h}
                    data-testid={`canvas-handle-${h}`}
                    className={cn(
                      'pointer-events-auto absolute size-2.5 rounded-[2px] border border-primary bg-white',
                      h === 'nw' && '-left-[5px] -top-[5px] cursor-nwse-resize',
                      h === 'ne' && '-right-[5px] -top-[5px] cursor-nesw-resize',
                      h === 'se' && '-bottom-[5px] -right-[5px] cursor-nwse-resize',
                      h === 'sw' && '-bottom-[5px] -left-[5px] cursor-nesw-resize',
                    )}
                  />
                ))}
            </div>
          )}
          {dragView && (
            <div className="absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white">
              {dragView.label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
