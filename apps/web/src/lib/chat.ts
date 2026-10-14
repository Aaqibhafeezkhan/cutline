import { ApiError, getToken } from './api';

/** Why a reply ended (mirrors the server's ChatStopReason). */
export type ChatStopReason = 'end' | 'limit' | 'cancelled' | 'refusal' | 'max_tokens' | 'error';

/** Events streamed by POST /api/projects/:id/chat (one JSON object per SSE `data:` line). */
export type ChatEvent =
  | { type: 'user'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'error'; message: string; hint?: string }
  | { type: 'done'; reason: ChatStopReason };

export interface ToolChip {
  id: string;
  name: string;
  status: 'running' | 'ok' | 'error';
  summary?: string;
}

/** A reply is a sequence of text and tool-call parts, in the order they happened. */
export type AssistantPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolChip };

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; parts: AssistantPart[]; error?: { message: string; hint?: string } };

export interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  /** How the last reply ended (null while streaming or before the first reply). */
  stopped: ChatStopReason | null;
}

export const initialChatState: ChatState = { messages: [], streaming: false, stopped: null };

/** Pure reducer: folds server events into the message list (also used to replay the transcript). */
export function chatReducer(state: ChatState, event: ChatEvent): ChatState {
  const messages = state.messages.slice();
  const lastAssistant = (): Extract<ChatMessage, { role: 'assistant' }> => {
    const last = messages.at(-1);
    if (last?.role === 'assistant') {
      const copy = { ...last, parts: last.parts.slice() };
      messages[messages.length - 1] = copy;
      return copy;
    }
    const created: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', parts: [] };
    messages.push(created);
    return created;
  };

  switch (event.type) {
    case 'user':
      messages.push({ role: 'user', text: event.text });
      return { messages, streaming: true, stopped: null };
    case 'text': {
      const msg = lastAssistant();
      const tail = msg.parts.at(-1);
      if (tail?.kind === 'text') {
        msg.parts[msg.parts.length - 1] = { kind: 'text', text: tail.text + event.delta };
      } else msg.parts.push({ kind: 'text', text: event.delta });
      return { ...state, messages };
    }
    case 'tool_start':
      lastAssistant().parts.push({
        kind: 'tool',
        tool: { id: event.id, name: event.name, status: 'running' },
      });
      return { ...state, messages };
    case 'tool_end': {
      const msg = lastAssistant();
      const i = msg.parts.findIndex((p) => p.kind === 'tool' && p.tool.id === event.id);
      const tool: ToolChip = {
        id: event.id,
        name: event.name,
        status: event.ok ? 'ok' : 'error',
        summary: event.summary,
      };
      if (i >= 0) msg.parts[i] = { kind: 'tool', tool };
      else msg.parts.push({ kind: 'tool', tool });
      return { ...state, messages };
    }
    case 'error': {
      const msg = lastAssistant();
      msg.error = { message: event.message, ...(event.hint && { hint: event.hint }) };
      return { ...state, messages };
    }
    case 'done': {
      // Chips still "running" when a reply ends were interrupted.
      const last = messages.at(-1);
      if (
        last?.role === 'assistant' &&
        last.parts.some((p) => p.kind === 'tool' && p.tool.status === 'running')
      ) {
        messages[messages.length - 1] = {
          ...last,
          parts: last.parts.map((p) =>
            p.kind === 'tool' && p.tool.status === 'running'
              ? { kind: 'tool', tool: { ...p.tool, status: 'error', summary: 'Stopped' } }
              : p,
          ),
        };
      }
      return { messages, streaming: false, stopped: event.reason };
    }
  }
}

/** Rebuilds the panel from the server's transcript (e.g. after a reload). */
export function replay(events: ChatEvent[]): ChatState {
  return events.reduce(chatReducer, initialChatState);
}

/** Splits an SSE buffer into complete events and the unfinished rest. */
export function parseSse(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
  const chunks = buffer.split(/\r?\n\r?\n/);
  const rest = chunks.pop() ?? '';
  for (const chunk of chunks) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ChatEvent);
    } catch {
      // ignore malformed frames
    }
  }
  return { events, rest };
}

const ICONS: Record<string, string> = {
  delete_range: '✂',
  split_clip: '✂',
  trim_clip: '✂',
  remove_filler_words: '✂',
  cut_to_beats: '✂',
  delete_clip: '🗑',
  get_frames: '👁',
  get_project: '📋',
  get_transcript: '📝',
  add_captions: '💬',
  add_text_overlay: 'T',
  export_video: '⬇',
  render_preview: '▶',
};

/** Short icon for a tool chip. */
export function toolIcon(name: string): string {
  return ICONS[name] ?? (name.startsWith('detect_') ? '🔍' : '⚙');
}

export interface ChatStatusResponse {
  enabled: boolean;
  model: string | null;
  fake: boolean;
  reason?: string;
  hint?: string;
  running: boolean;
  events: ChatEvent[];
}

function headers(json = false): Headers {
  const h = new Headers();
  const token = getToken();
  if (token) h.set('authorization', `Bearer ${token}`);
  if (json) h.set('content-type', 'application/json');
  return h;
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string; hint?: string };
  } | null;
  return new ApiError(
    res.status,
    (body?.error ?? { code: 'INVARIANT', message: `HTTP ${res.status}` }) as never,
  );
}

export const chatApi = {
  async status(projectId: string): Promise<ChatStatusResponse> {
    const res = await fetch(`/api/projects/${projectId}/chat`, { headers: headers() });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as ChatStatusResponse;
  },

  /** Sends a message and calls onEvent for each streamed event until the reply ends. */
  async send(
    projectId: string,
    text: string,
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
      signal,
    });
    if (!res.ok) throw await failure(res);
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(buffer + value);
      buffer = parsed.rest;
      parsed.events.forEach(onEvent);
    }
  },

  async cancel(projectId: string): Promise<void> {
    await fetch(`/api/projects/${projectId}/chat/cancel`, { method: 'POST', headers: headers() });
  },

  async reset(projectId: string): Promise<void> {
    const res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw await failure(res);
  },
};
