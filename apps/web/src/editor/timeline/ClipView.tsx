import { memo, useEffect, useState, type PointerEvent } from 'react';
import { Bot, Lock } from 'lucide-react';
import { clipEnd, type Clip, type Track } from '@cutline/core';
import { HIGHLIGHT_MS, useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TRACK_HEIGHT } from './geometry';

export type DragKind = 'move' | 'trim-start' | 'trim-end';

// Note: not `bg-clip-*`, which collides with Tailwind's background-clip utilities.
const COLORS: Record<Clip['type'], string> = {
  video: 'bg-media-video',
  image: 'bg-media-image',
  audio: 'bg-media-audio',
  text: 'bg-media-text',
  caption: 'bg-media-caption',
};

function useHighlight(clipId: string) {
  const highlight = useEditor((s) => s.highlights[clipId]);
  const [, force] = useState(0);
  const active = Boolean(highlight && highlight.until > Date.now());
  useEffect(() => {
    if (!highlight) return;
    const left = highlight.until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => force((n) => n + 1), Math.min(left, HIGHLIGHT_MS) + 20);
    return () => clearTimeout(t);
  }, [highlight]);
  return active ? highlight : undefined;
}

function label(clip: Clip, assetName: string | undefined): string {
  if (clip.type === 'text' || clip.type === 'caption') return clip.text;
  return clip.name ?? assetName ?? clip.type;
}

export const ClipView = memo(function ClipView({
  clip,
  track,
  zoom,
  dragging,
  onBeginDrag,
}: {
  clip: Clip;
  track: Track;
  zoom: number;
  dragging: boolean;
  onBeginDrag: (clip: Clip, kind: DragKind, e: PointerEvent) => void;
}) {
  const selected = useEditor((s) => s.selection.includes(clip.id));
  const assetName = useEditor((s) =>
    'assetId' in clip ? s.project?.assets.find((a) => a.id === clip.assetId)?.name : undefined,
  );
  const select = useEditor((s) => s.select);
  const highlight = useHighlight(clip.id);
  const width = Math.max(2, clip.duration * zoom);
  const text = label(clip, assetName);
  const height = TRACK_HEIGHT[track.kind] - 6;

  const start = (kind: DragKind) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onBeginDrag(clip, kind, e);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${clip.type} clip ${text}, ${clip.start.toFixed(2)} to ${clipEnd(clip).toFixed(2)} seconds${track.locked ? ', locked' : ''}`}
      data-clip-id={clip.id}
      className={cn(
        'group absolute top-[3px] overflow-hidden rounded-md text-[11px] text-white/95 shadow-sm outline-offset-1 transition-[box-shadow,opacity]',
        COLORS[clip.type],
        selected && 'ring-2 ring-white',
        highlight && 'agent-highlight',
        dragging && 'opacity-40',
        track.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing',
      )}
      style={{ left: clip.start * zoom, width, height }}
      onPointerDown={start('move')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select([clip.id], e.shiftKey);
        }
      }}
    >
      {'transitionIn' in clip && clip.transitionIn && (
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-black/45 to-transparent"
          style={{ width: Math.min(width, (clip.transitionIn.duration / 2) * zoom) }}
        />
      )}
      <div className="pointer-events-none flex h-full items-start gap-1 px-1.5 py-1">
        {track.locked && <Lock className="size-3 shrink-0 opacity-70" />}
        {highlight && (
          <Bot
            className="size-3 shrink-0"
            aria-label={`changed by ${highlight.origin.name ?? 'agent'}`}
          />
        )}
        <span className="truncate font-medium leading-tight">{text}</span>
      </div>
      {'muted' in clip && clip.muted && (
        <span className="pointer-events-none absolute bottom-0.5 right-1 text-[9px] uppercase opacity-70">
          muted
        </span>
      )}
      {!track.locked && width > 14 && (
        <>
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
            onPointerDown={start('trim-start')}
          />
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
            onPointerDown={start('trim-end')}
          />
        </>
      )}
    </div>
  );
});
