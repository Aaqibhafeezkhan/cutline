import { Bookmark, Copy, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  chapterList,
  formatTimestamp,
  projectDuration,
  youtubeChapterText,
  youtubeChapterWarnings,
  type Marker,
} from '@cutline/core';
import { Button } from '@/components/ui/button';
import { seek } from '@/lib/player-bridge';
import { useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';
import { addMarker } from './commands';
import { Section } from './fields';
import { markerColor } from './timeline/Markers';

/** Chapters (with "Copy for YouTube") and the other timeline markers. */
export function ChaptersPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const dispatch = useEditor((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  if (!project) return null;

  const markers = project.markers ?? [];
  const chapterMarkers = markers.filter((m) => m.kind === 'chapter');
  const others = markers.filter((m) => m.kind !== 'chapter');
  const duration = projectDuration(project);
  const chapters = chapterList(project);
  const warnings = chapters.length ? youtubeChapterWarnings(chapters, duration) : [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(youtubeChapterText(chapters, duration));
      toast.success('Chapters copied for the YouTube description.');
    } catch {
      toast.error('Could not access the clipboard.');
    }
  };

  const row = (m: Marker) => (
    <li
      key={m.id}
      className={cn(
        'group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2',
        selection.includes(m.id) && 'bg-surface-2',
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: markerColor(m) }}
      />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-xs"
        onClick={() => {
          select([m.id]);
          seek(m.time);
        }}
      >
        <span className="mr-2 font-mono tabular-nums text-muted">
          {formatTimestamp(m.time, duration >= 3600)}
          {m.end !== undefined && `–${formatTimestamp(m.end, duration >= 3600)}`}
        </span>
        {m.label || <span className="text-muted">({m.kind})</span>}
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${m.kind} "${m.label}"`}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => void dispatch([{ type: 'remove_markers', markerIds: [m.id] }])}
      >
        <Trash2 />
      </Button>
    </li>
  );

  return (
    <div>
      <Section title="Chapters">
        {chapterMarkers.length ? (
          <ul className="space-y-0.5" aria-label="Chapters">
            {chapterMarkers.map(row)}
          </ul>
        ) : (
          <p className="text-xs text-muted">
            No chapters yet. Add one at the playhead, or ask the agent to find chapters
            (get_chapters_input → set_chapters).
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => void addMarker('chapter')}>
            <Plus /> Chapter at playhead
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!chapters.length}
            onClick={() => void copy()}
          >
            <Copy /> Copy for YouTube
          </Button>
        </div>
        {warnings.length > 0 && (
          <ul className="space-y-1 text-[11px] text-amber-400" aria-label="YouTube warnings">
            {warnings.map((w) => (
              <li key={w} className="flex gap-1.5">
                <TriangleAlert className="mt-px size-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Markers & highlights">
        {others.length ? (
          <ul className="space-y-0.5" aria-label="Markers">
            {others.map(row)}
          </ul>
        ) : (
          <p className="text-xs text-muted">
            Press M to drop a note marker at the playhead. Highlights marked by the agent appear
            here and as coloured spans on the ruler.
          </p>
        )}
        <Button variant="secondary" size="sm" onClick={() => void addMarker('note')}>
          <Bookmark /> Marker at playhead
        </Button>
      </Section>
    </div>
  );
}
