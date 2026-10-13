import { useState } from 'react';
import { Eraser, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CaptionStyleSchema,
  clipEnd,
  type CaptionClip,
  type CaptionStyle,
  type Track,
} from '@cutline/core';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { seek } from '@/lib/player-bridge';
import { useEditor, usePlayhead } from '@/lib/store';
import { cn, formatTimecode } from '@/lib/utils';
import { ColorField, NumberField, Section } from './fields';

export function CaptionsPanel() {
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const dispatch = useEditor((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  const selection = useEditor((s) => s.selection);
  const [busy, setBusy] = useState(false);
  if (!project || !projectId) return null;

  const track: Track | undefined = project.tracks.find((t) => t.kind === 'caption');
  const cues = (track?.clips ?? []) as CaptionClip[];
  const style = track?.captionStyle ?? CaptionStyleSchema.parse({});

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.autoCaptions(projectId);
      toast.success(r.summary);
    } catch (err) {
      toast.error('Could not generate captions', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const removeFillers = async () => {
    setBusy(true);
    try {
      const r = await api.removeFillers(projectId);
      toast.success(r.summary, {
        description: r.found.length
          ? r.found.map((f) => f.text).join(', ')
          : 'The transcript may omit hesitations; cut them by hand if you still hear any.',
      });
    } catch (err) {
      toast.error('Could not remove filler words', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const addCue = () => {
    const t = usePlayhead.getState().time;
    void dispatch([
      {
        type: 'add_captions',
        cues: [{ start: t, end: t + 2, text: 'New caption' }],
        replace: false,
      },
    ]);
  };

  const updateStyle = (patch: Partial<CaptionStyle>) => {
    if (track) void dispatch([{ type: 'update_track', trackId: track.id, captionStyle: patch }]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-1 border-b border-border p-2">
        <Button size="sm" variant="secondary" onClick={() => void generate()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} From speech
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void removeFillers()}
          disabled={busy}
          title='Cut "um", "uh", "äh" … from the timeline (one undo step)'
        >
          <Eraser /> Remove fillers
        </Button>
        <Button size="sm" variant="ghost" onClick={addCue}>
          <Plus /> Cue at playhead
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto" aria-label="Caption cues">
        {cues.length === 0 && (
          <li className="p-4 text-sm text-muted">
            No captions yet. Generate them from speech, add cues manually, or ask your agent to call{' '}
            <code>add_captions</code>.
          </li>
        )}
        {cues.map((cue) => (
          <li
            key={cue.id}
            className={cn(
              'group border-b border-border/60 px-3 py-2',
              selection.includes(cue.id) && 'bg-primary/10',
            )}
          >
            <button
              type="button"
              className="font-mono text-[11px] text-muted hover:text-foreground"
              onClick={() => {
                seek(cue.start);
                select([cue.id]);
              }}
            >
              {formatTimecode(cue.start)} → {formatTimecode(clipEnd(cue))}
            </button>
            <div className="flex items-start gap-1">
              <textarea
                aria-label={`Caption text at ${cue.start.toFixed(2)} seconds`}
                defaultValue={cue.text}
                key={cue.text}
                rows={Math.min(3, Math.ceil(cue.text.length / 34))}
                className="w-full resize-none rounded bg-transparent px-1 text-sm hover:bg-surface-2 focus:bg-background"
                onBlur={(e) => {
                  const text = e.target.value.trim();
                  if (text && text !== cue.text)
                    void dispatch([
                      { type: 'set_clip_props', clipId: cue.id, props: { text, words: [] } },
                    ]);
                }}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete caption"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={() => void dispatch([{ type: 'delete_clips', clipIds: [cue.id] }])}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {track && (
        <div className="border-t border-border">
          <Section title="Caption style">
            <NumberField
              label="Font size"
              min={8}
              max={400}
              step={1}
              value={style.fontSize}
              onCommit={(fontSize) => updateStyle({ fontSize })}
            />
            <ColorField
              label="Color"
              value={style.color}
              onCommit={(color) => updateStyle({ color })}
            />
            <ColorField
              label="Highlight"
              value={style.highlightColor ?? '#fbbf24'}
              onCommit={(highlightColor) => updateStyle({ highlightColor })}
            />
            <div className="grid grid-cols-[84px_1fr] items-center gap-2">
              <span className="text-xs font-medium text-muted">Position</span>
              <Select
                label="Caption position"
                value={style.position}
                onValueChange={(position) =>
                  updateStyle({ position: position as CaptionStyle['position'] })
                }
                options={[
                  { value: 'bottom', label: 'Bottom' },
                  { value: 'middle', label: 'Middle' },
                  { value: 'top', label: 'Top' },
                ]}
              />
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
