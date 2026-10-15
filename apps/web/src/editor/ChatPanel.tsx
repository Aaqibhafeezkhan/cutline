import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Loader2, MessageSquarePlus, SendHorizontal, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/misc';
import {
  chatApi,
  chatReducer,
  initialChatState,
  replay,
  toolIcon,
  type AssistantPart,
  type ChatEvent,
  type ChatMessage,
  type ChatState,
  type ChatStatusResponse,
} from '@/lib/chat';
import { parseMarkdownLite, type Inline } from '@/lib/markdown-lite';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  'Make this a 30-second short',
  'Remove the silences',
  'Add captions',
  'What is in this video?',
];

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.kind === 'bold' ? (
          <strong key={i} className="font-semibold text-foreground">
            {s.text}
          </strong>
        ) : s.kind === 'italic' ? (
          <em key={i}>{s.text}</em>
        ) : s.kind === 'code' ? (
          <code key={i} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.85em]">
            {s.text}
          </code>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {parseMarkdownLite(text).map((b, i) => {
        if (b.kind === 'pre') {
          return (
            <pre key={i} className="overflow-x-auto rounded bg-surface-2 p-2 font-mono text-xs">
              {b.text}
            </pre>
          );
        }
        if (b.kind === 'p') {
          return (
            <p key={i}>
              {b.lines.map((line, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  <Spans spans={line} />
                </Fragment>
              ))}
            </p>
          );
        }
        const List = b.kind === 'ul' ? 'ul' : 'ol';
        return (
          <List
            key={i}
            className={cn('space-y-0.5 pl-4', b.kind === 'ul' ? 'list-disc' : 'list-decimal')}
          >
            {b.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

function ToolChipView({ part }: { part: Extract<AssistantPart, { kind: 'tool' }> }) {
  const { tool } = part;
  return (
    <div
      className={cn(
        'flex items-start gap-1.5 rounded-md border px-2 py-1 text-xs',
        tool.status === 'error' ? 'border-danger/40 bg-danger/10' : 'border-agent/40 bg-agent/10',
      )}
      data-testid="chat-tool"
    >
      <span aria-hidden className="w-4 shrink-0 text-center">
        {tool.status === 'running' ? (
          <Loader2 className="mt-0.5 size-3 animate-spin" />
        ) : (
          toolIcon(tool.name)
        )}
      </span>
      <span className="min-w-0">
        <span className="font-mono font-medium text-foreground">{tool.name}</span>
        {tool.summary && <span className="text-muted"> — {tool.summary}</span>}
      </span>
    </div>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="ml-6 self-end rounded-lg bg-primary/15 px-3 py-2 text-sm whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm leading-relaxed">
      {message.parts.map((p, i) =>
        p.kind === 'text' ? (
          <Markdown key={i} text={p.text} />
        ) : (
          <ToolChipView key={p.tool.id} part={p} />
        ),
      )}
      {message.error && (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs"
        >
          <div className="font-medium">{message.error.message}</div>
          {message.error.hint && <div className="text-muted">{message.error.hint}</div>}
        </div>
      )}
    </div>
  );
}

function SetupHint({ status }: { status: ChatStatusResponse }) {
  return (
    <div className="m-3 space-y-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
      <div className="font-medium">Chat with Claude is not set up</div>
      <p className="text-muted">{status.reason}</p>
      <p className="text-muted">
        Add your Anthropic API key to the <strong>server</strong> environment, e.g. in{' '}
        <code className="font-mono">.env</code> next to the Cutline server:
      </p>
      <pre className="rounded bg-surface p-2 font-mono text-xs">ANTHROPIC_API_KEY=sk-ant-…</pre>
      <p className="text-xs text-muted">
        Then restart the server. The key never reaches the browser or your project files.
      </p>
    </div>
  );
}

export function ChatPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [status, setStatus] = useState<ChatStatusResponse | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback((e: ChatEvent) => setChat((s) => chatReducer(s, e)), []);

  // Load (or keep polling while a reply started elsewhere is still running).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const s = await chatApi.status(projectId);
        if (!alive) return;
        setStatus(s);
        if (!sending) setChat({ ...replay(s.events), streaming: s.running });
        if (s.running && !sending) timer = setTimeout(() => void load(), 1500);
      } catch (err) {
        if (alive) toast.error(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only per project
  }, [projectId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat]);

  useEffect(() => {
    if (status?.enabled) inputRef.current?.focus();
  }, [status?.enabled]);

  const busy = sending || chat.streaming;

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    setSending(true);
    try {
      await chatApi.send(projectId, trimmed, apply);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setInput(trimmed);
    } finally {
      setSending(false);
      setChat((s) => (s.streaming ? { ...s, streaming: false } : s));
    }
  };

  const stop = () => void chatApi.cancel(projectId);

  const newChat = async () => {
    try {
      await chatApi.reset(projectId);
      setChat(initialChatState);
      inputRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      stop();
    }
  };

  const last = chat.messages.at(-1);
  const waiting =
    busy &&
    (!last || last.role === 'user' || (last.role === 'assistant' && last.parts.length === 0));

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Chat with Claude">
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Bot className="size-4 text-agent" />
        <span className="text-sm font-semibold">Chat</span>
        {status?.model && (
          <span className="truncate text-xs text-muted" title={status.model}>
            {status.model}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <Tooltip content="New chat">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New chat"
              disabled={busy || chat.messages.length === 0}
              onClick={() => void newChat()}
            >
              <MessageSquarePlus />
            </Button>
          </Tooltip>
          <Tooltip content="Close chat (Ctrl+K)">
            <Button variant="ghost" size="icon-sm" aria-label="Close chat" onClick={onClose}>
              <X />
            </Button>
          </Tooltip>
        </div>
      </header>

      {status && !status.enabled ? (
        <SetupHint status={status} />
      ) : (
        <>
          <div
            ref={scroller}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
            aria-live="polite"
          >
            {chat.messages.length === 0 && (
              <div className="space-y-2 text-sm text-muted">
                <p>
                  Ask Claude to edit this project. Changes appear live on the timeline and{' '}
                  <strong>Ctrl+Z</strong> undoes them.
                </p>
                {status?.fake && (
                  <p className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs">
                    Dev mode: replies come from a scripted fake model (CUTLINE_CHAT_FAKE=1).
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-surface-2 hover:text-foreground"
                      onClick={() => void send(s)}
                      disabled={!status}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chat.messages.map((m, i) => (
              <MessageView key={i} message={m} />
            ))}
            {waiting && (
              <div className="flex items-center gap-1.5 text-xs text-muted" role="status">
                <Loader2 className="size-3 animate-spin" /> Claude is thinking…
              </div>
            )}
            {chat.stopped === 'cancelled' && !busy && (
              <div className="text-xs text-muted">Stopped.</div>
            )}
          </div>
          <form
            className="shrink-0 border-t border-border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <div className="flex items-end gap-1.5 rounded-md border border-border bg-surface-2 p-1.5 focus-within:border-primary">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                maxLength={20000}
                placeholder="Ask Claude to edit… (Enter to send)"
                aria-label="Message to Claude"
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted"
                disabled={!status}
              />
              {busy ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  aria-label="Stop"
                  onClick={stop}
                >
                  <Square className="fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon-sm"
                  aria-label="Send"
                  disabled={!input.trim() || !status}
                >
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
