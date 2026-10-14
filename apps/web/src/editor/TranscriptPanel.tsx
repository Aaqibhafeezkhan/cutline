import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { AudioLines, Eraser, Loader2, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { groupParagraphs, mapWordsToTimeline, wordRangesToCuts, type Word } from '@cutline/core';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { api } from '@/lib/api';
import { seek } from '@/lib/player-bridge';
import { useEditor, usePlayhead } from '@/lib/store';
import { cn, formatTimecode } from '@/lib/utils';
import { audibleAssetKey, orderedRange, wordIndexAt } from './transcript';

interface Sources {
  byAsset: Record<string, Word[]>;
  missing: string[];
}

interface Selection {
  anchor: number;
  focus: number;
}

type Status = 'idle' | 'loading' | 'transcribing' | 'busy';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Edit the video by editing its transcript: the timeline's words as text,
 * the spoken word highlighted, click to seek, select words and press Delete
 * to cut them out (one delete_range, one undo step).
 */
export function TranscriptPanel() {
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const dispatch = useEditor((s) => s.dispatch);
  const [sources, setSources] = useState<Sources | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [sel, setSel] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ active: boolean; moved: boolean }>({ active: false, moved: false });

  const audioKey = project ? audibleAssetKey(project) : '';

  // Cached transcripts only (fast); re-checked when the audible media changes.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setStatus((s) => (s === 'transcribing' ? s : 'loading'));
    api
      .transcript(projectId)
      .then((r) => !cancelled && setSources(r))
      .catch((err: unknown) => {
        if (!cancelled)
          toast.error('Could not load the transcript', { description: errorText(err) });
      })
      .finally(() => !cancelled && setStatus((s) => (s === 'loading' ? 'idle' : s)));
    return () => {
      cancelled = true;
    };
  }, [projectId, audioKey]);

  // Re-mapped on every edit, so cut words disappear without asking the server.
  const words = useMemo(
    () =>
      project && sources
        ? mapWordsToTimeline(project, new Map(Object.entries(sources.byAsset)))
        : [],
    [project, sources],
  );
  const paragraphs = useMemo(() => groupParagraphs(words), [words]);
  const current = usePlayhead((s) => wordIndexAt(words, s.time));
  const playing = usePlayhead((s) => s.playing);

  // Word indexes shift after every edit: drop a stale selection.
  useEffect(() => setSel(null), [words]);

  useEffect(() => {
    if (!playing || current < 0) return;
    bodyRef.current
      ?.querySelector(`[data-word="${current}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current, playing]);

  useEffect(() => {
    const up = () => {
      drag.current.active = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const range = sel ? orderedRange(sel) : null;
  const selectedCount = range ? range.end - range.start + 1 : 0;

  const transcribe = async () => {
    if (!projectId) return;
    setStatus('transcribing');
    try {
      setSources(await api.transcript(projectId, true));
    } catch (err) {
      toast.error('Could not transcribe the timeline', { description: errorText(err) });
    } finally {
      setStatus('idle');
    }
  };

  const deleteSelected = useCallback(async () => {
    if (!range) return;
    const ranges = wordRangesToCuts(words, range);
    if (ranges.length === 0) return;
    const ok = await dispatch(
      [{ type: 'delete_range', ranges }],
      `Delete ${selectedCount} word(s) from the transcript`,
    );
    if (ok) setSel(null);
  }, [dispatch, range, selectedCount, words]);

  const removeFillers = async () => {
    if (!projectId) return;
    setStatus('busy');
    try {
      const r = await api.removeFillers(projectId);
      toast.success(r.summary, {
        description: r.found.length
          ? r.found.map((f) => f.text).join(', ')
          : 'The transcript may omit hesitations; select them and press Delete if you still hear any.',
      });
    } catch (err) {
      toast.error('Could not remove filler words', { description: errorText(err) });
    } finally {
      setStatus('idle');
    }
  };

  const moveFocus = (delta: number, extend: boolean) => {
    if (words.length === 0) return;
    const from = sel?.focus ?? (current >= 0 ? current : delta > 0 ? -1 : words.length);
    const focus = Math.min(words.length - 1, Math.max(0, from + delta));
    setSel(extend && sel ? { anchor: sel.anchor, focus } : { anchor: focus, focus });
    if (!extend) seek(words[focus]!.start);
    bodyRef.current?.querySelector(`[data-word="${focus}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === 'Delete' || e.key === 'Backspace') void deleteSelected();
    else if (e.key === 'ArrowLeft' && !e.altKey) moveFocus(-1, e.shiftKey);
    else if (e.key === 'ArrowRight' && !e.altKey) moveFocus(1, e.shiftKey);
    else if (e.key === 'Escape' && sel) setSel(null);
    else if (e.key === 'Enter' && range) seek(words[range.start]!.start);
    else if (mod && e.key.toLowerCase() === 'a' && words.length)
      setSel({ anchor: 0, focus: words.length - 1 });
    else handled = false;
    // Keep the editor's global shortcuts (delete clip, select all clips, …) out of it.
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onWordMouseDown = (e: MouseEvent, i: number) => {
    // The words are select-none: we draw our own selection; the mouse focuses the text box.
    if (e.button !== 0) return;
    if (e.shiftKey && sel) {
      setSel({ anchor: sel.anchor, focus: i });
      return;
    }
    drag.current = { active: true, moved: false };
    setSel({ anchor: i, focus: i });
  };

  const onWordMouseEnter = (i: number) => {
    if (!drag.current.active) return;
    drag.current.moved = true;
    setSel((s) => (s ? { anchor: s.anchor, focus: i } : { anchor: i, focus: i }));
  };

  const onWordClick = (e: MouseEvent, i: number) => {
    if (!e.shiftKey && !drag.current.moved) seek(words[i]!.start);
  };

  const onWordContextMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    if (!range || i < range.start || i > range.end) setSel({ anchor: i, focus: i });
    setMenu({ x: e.clientX, y: e.clientY });
  };

  if (!project || !projectId) return null;

  const noMedia = audioKey === '';
  const untranscribed = sources ? sources.missing.length : 0;
  const working = status !== 'idle';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
        {(untranscribed > 0 || status === 'transcribing') && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void transcribe()}
            disabled={working}
            title="Transcribe the timeline audio with local Whisper (cached per file)"
          >
            {status === 'transcribing' ? <Loader2 className="animate-spin" /> : <AudioLines />}
            Transcribe
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void deleteSelected()}
          disabled={selectedCount === 0 || working}
          title="Cut the selected words out of the timeline (Del)"
        >
          <Trash2 /> Delete
          {selectedCount ? ` ${selectedCount} word${selectedCount > 1 ? 's' : ''}` : ''}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void removeFillers()}
          disabled={working || noMedia}
          title='Cut "um", "uh", "äh" … from the timeline (one undo step)'
        >
          {status === 'busy' ? <Loader2 className="animate-spin" /> : <Eraser />} Remove fillers
        </Button>
      </div>
      <div
        ref={bodyRef}
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label="Transcript"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm leading-7 outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      >
        {status === 'loading' && !sources && (
          <p className="flex items-center gap-2 text-muted" role="status">
            <Loader2 className="size-4 animate-spin" /> Loading transcript…
          </p>
        )}
        {status === 'transcribing' && (
          <p className="flex items-center gap-2 text-muted" role="status">
            <Loader2 className="size-4 animate-spin" /> Transcribing the timeline audio… This can
            take a while the first time.
          </p>
        )}
        {sources && noMedia && (
          <p className="text-muted">
            No speech on the timeline yet. Add a video or audio clip, then edit it here like text.
          </p>
        )}
        {sources && !noMedia && words.length === 0 && status !== 'transcribing' && (
          <p className="text-muted">
            {untranscribed > 0
              ? 'Not transcribed yet. Click Transcribe to turn the speech into editable text.'
              : 'No words found in the timeline audio.'}
          </p>
        )}
        {paragraphs.map((p) => (
          <p key={`${p.start}-${words[p.start]!.start}`} className="mb-3">
            <button
              type="button"
              tabIndex={-1}
              className="mr-1 font-mono text-[10px] text-muted hover:text-foreground"
              onClick={() => seek(words[p.start]!.start)}
            >
              {formatTimecode(words[p.start]!.start, 1)}
            </button>
            {words.slice(p.start, p.end + 1).map((w, k) => {
              const i = p.start + k;
              const selected = range !== null && i >= range.start && i <= range.end;
              return (
                <span key={i}>
                  <span
                    data-word={i}
                    title={`${w.start.toFixed(2)}s`}
                    onMouseDown={(e) => onWordMouseDown(e, i)}
                    onMouseEnter={() => onWordMouseEnter(i)}
                    onClick={(e) => onWordClick(e, i)}
                    onContextMenu={(e) => onWordContextMenu(e, i)}
                    className={cn(
                      'cursor-text rounded-sm px-px select-none',
                      i === current && 'bg-primary/20 text-foreground',
                      selected && 'bg-primary/40 text-foreground',
                      !selected && i !== current && 'hover:bg-surface-2',
                    )}
                  >
                    {w.text}
                  </span>
                  <span className={cn('select-none', selected && i < range.end && 'bg-primary/40')}>
                    {' '}
                  </span>
                </span>
              );
            })}
          </p>
        ))}
      </div>
      {words.length > 0 && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
          Click a word to jump there. Drag or Shift+click to select, then Del cuts it.
        </p>
      )}
      <DropdownMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed size-0"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            bodyRef.current?.focus();
          }}
        >
          <DropdownMenuItem
            icon={<Trash2 />}
            shortcut="Del"
            disabled={selectedCount === 0}
            onSelect={() => void deleteSelected()}
          >
            Delete {selectedCount} word{selectedCount === 1 ? '' : 's'}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Play />}
            disabled={!range}
            onSelect={() => range && seek(words[range.start]!.start)}
          >
            Jump here
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Eraser />} onSelect={() => void removeFillers()}>
            Remove fillers
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
