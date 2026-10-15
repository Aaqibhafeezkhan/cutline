import { useState } from 'react';
import type { Marker, MarkerKind } from '@cutline/core';
import { seek } from '@/lib/player-bridge';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';

export const MARKER_COLORS: Record<MarkerKind, string> = {
  chapter: '#38bdf8',
  note: '#f59e0b',
  highlight: '#f472b6',
};

/** Height of the marker strip along the bottom of the ruler. */
export const MARKER_LANE_HEIGHT = 15;

export function markerColor(m: Marker): string {
  return m.color ?? MARKER_COLORS[m.kind];
}

/**
 * Markers on the ruler: chapters are labelled flags, highlights coloured
 * spans, notes small pins. Click seeks and selects (Del removes), double-click
 * renames.
 */
export function MarkerLane({ zoom }: { zoom: number }) {
  const markers = useEditor((s) => s.project?.markers);
  const selection = useEditor((s) => s.selection);
  const [editing, setEditing] = useState<string | null>(null);
  if (!markers?.length) return null;

  const rename = (m: Marker, label: string) => {
    setEditing(null);
    if (label.trim() === m.label) return;
    void useEditor
      .getState()
      .dispatch([{ type: 'update_marker', markerId: m.id, label: label.trim() }], 'Rename marker');
  };

  return (
    <div className="absolute inset-x-0 bottom-0" style={{ height: MARKER_LANE_HEIGHT }}>
      {markers.map((m) => {
        const color = markerColor(m);
        const selected = selection.includes(m.id);
        const left = m.time * zoom;
        const width = m.end !== undefined ? Math.max(2, (m.end - m.time) * zoom) : undefined;
        if (editing === m.id) {
          return (
            <input
              key={m.id}
              aria-label="Marker name"
              autoFocus
              defaultValue={m.label}
              className="absolute bottom-0 z-10 h-full w-40 rounded-sm border border-primary bg-background px-1 text-[10px] text-foreground outline-none"
              style={{ left }}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => rename(m, e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') rename(m, e.currentTarget.value);
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          );
        }
        return (
          <button
            key={m.id}
            type="button"
            data-marker={m.kind}
            aria-label={`${m.kind} marker${m.label ? ` "${m.label}"` : ''} at ${m.time.toFixed(2)} seconds`}
            aria-pressed={selected}
            title={`${m.label || m.kind} · ${m.time.toFixed(2)}s${m.end !== undefined ? `–${m.end.toFixed(2)}s` : ''} (double-click to rename)`}
            className={cn(
              'absolute bottom-0 flex h-full cursor-pointer items-center overflow-hidden text-left text-[10px] leading-none text-white',
              selected && 'z-10 outline outline-1 outline-offset-0 outline-white',
              m.kind === 'chapter' && 'max-w-40 rounded-r-sm pl-1 pr-1.5 font-medium',
              m.kind === 'highlight' && 'rounded-sm px-1',
              m.kind === 'note' && 'w-2.5 -translate-x-1/2 justify-center rounded-b-full',
            )}
            style={{
              left,
              ...(width !== undefined && m.kind !== 'chapter' && { width }),
              background: m.kind === 'highlight' ? `${color.slice(0, 7)}66` : color,
              ...(m.kind === 'highlight' && { borderBottom: `2px solid ${color}` }),
              ...(m.kind === 'chapter' && { borderLeft: `2px solid ${color}` }),
              color: m.kind === 'highlight' ? 'var(--color-foreground)' : '#0b1220',
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              useEditor.getState().select([m.id], e.shiftKey || e.metaKey || e.ctrlKey);
              seek(m.time);
            }}
            onDoubleClick={() => setEditing(m.id)}
          >
            {m.kind !== 'note' && <span className="truncate">{m.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
