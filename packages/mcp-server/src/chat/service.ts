import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { CutlineError, isCutlineError } from '@cutline/core';
import { log } from '../log';
import { INSTRUCTIONS } from '../mcp/server';
import type { Services } from '../services';
import { runAgent, type ChatEvent, type Effort } from './agent';
import type { ChatModel } from './model';
import { connectToolHost, type ToolHost } from './tools';

export const MAX_TOOL_CALLS = 20;

export const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.literal('user'),
        content: z.string().trim().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(10),
});

export interface ChatStatus {
  enabled: boolean;
  model: string | null;
  /** True for the dev-only scripted model (CUTLINE_CHAT_FAKE=1). */
  fake: boolean;
  /** Why chat is disabled and how to enable it. */
  reason?: string;
  hint?: string;
}

interface Conversation {
  history: BetaMessageParam[];
  /** Display log for the panel (consecutive text deltas merged). */
  events: ChatEvent[];
  running: AbortController | null;
  host: Promise<ToolHost> | null;
}

export interface ChatServiceOptions {
  model: ChatModel | null;
  modelId: string;
  effort?: Effort;
  fake?: boolean;
  maxToolCalls?: number;
}

const DISABLED_REASON = 'Chat is off: ANTHROPIC_API_KEY is not set on the Cutline server.';
const DISABLED_HINT =
  'Set ANTHROPIC_API_KEY in the server environment (or in .env next to the server) and restart the server.';

function systemPrompt(projectId: string): string {
  return `${INSTRUCTIONS}

You are chatting with the user inside the Cutline editor, next to the timeline of project ${projectId}. Every tool already acts on this project: never pass a projectId, and you cannot create or switch projects. The user watches your edits appear live and can undo any of them with Ctrl+Z.
Keep replies short and concrete. Say what you changed in one or two sentences. Use plain text with occasional **bold**, \`code\` and "- " bullet lists; no tables or headings.`;
}

/** Turns an error into a chat error event without leaking internals (or credentials). */
export function describeChatError(err: unknown): { message: string; hint?: string } {
  if (isCutlineError(err)) return { message: err.message, hint: err.hint };
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      message: 'The Anthropic API rejected the API key.',
      hint: 'Check ANTHROPIC_API_KEY on the server and restart it.',
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { message: 'The Anthropic API is rate limiting requests.', hint: 'Try again shortly.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      message: 'Could not reach the Anthropic API.',
      hint: 'Check the server’s internet connection.',
    };
  }
  if (err instanceof Anthropic.APIError) {
    return { message: `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim() };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Per-project conversations with Claude, kept in memory (a server restart starts fresh). */
export class ChatService {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly services: Services,
    private readonly options: ChatServiceOptions,
  ) {}

  status(): ChatStatus {
    const { model, modelId, fake } = this.options;
    if (!model) {
      return {
        enabled: false,
        model: null,
        fake: false,
        reason: DISABLED_REASON,
        hint: DISABLED_HINT,
      };
    }
    return { enabled: true, model: fake ? 'scripted dev model' : modelId, fake: Boolean(fake) };
  }

  private conversation(projectId: string): Conversation {
    let c = this.conversations.get(projectId);
    if (!c) {
      c = { history: [], events: [], running: null, host: null };
      this.conversations.set(projectId, c);
    }
    return c;
  }

  /** Display log of the current conversation. */
  events(projectId: string): ChatEvent[] {
    return this.conversations.get(projectId)?.events ?? [];
  }

  isRunning(projectId: string): boolean {
    return Boolean(this.conversations.get(projectId)?.running);
  }

  /** Validates a request before the response starts streaming (throws CutlineError). */
  prepare(projectId: string, body: unknown): string[] {
    if (!this.options.model) {
      throw new CutlineError('INVALID_OPERATION', DISABLED_REASON, { hint: DISABLED_HINT });
    }
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new CutlineError(
        'INVALID_ARGUMENT',
        'Body must be { messages: [{ role: "user", content: string }] }.',
        {
          hint: 'Send only the new user message(s); the server keeps the conversation.',
        },
      );
    }
    if (this.isRunning(projectId)) {
      throw new CutlineError(
        'INVALID_OPERATION',
        'Claude is still answering the previous message.',
        {
          hint: 'Wait for the reply or press Stop first.',
        },
      );
    }
    return parsed.data.messages.map((m) => m.content);
  }

  /** Runs one user turn, streaming events to `write`. Never throws. */
  async send(projectId: string, texts: string[], write: (e: ChatEvent) => void): Promise<void> {
    const model = this.options.model;
    const c = this.conversation(projectId);
    const controller = new AbortController();
    c.running = controller;
    const emit = (e: ChatEvent) => {
      const last = c.events.at(-1);
      if (e.type === 'text' && last?.type === 'text') last.delta += e.delta;
      else c.events.push({ ...e });
      try {
        write(e);
      } catch {
        // client went away; the run continues until cancelled
      }
    };
    try {
      for (const text of texts) {
        c.history.push({ role: 'user', content: text });
        emit({ type: 'user', text });
      }
      if (!model)
        throw new CutlineError('INVALID_OPERATION', DISABLED_REASON, { hint: DISABLED_HINT });
      c.host ??= connectToolHost(this.services, projectId);
      const host = await c.host;
      const reason = await runAgent({
        model,
        modelId: this.options.modelId,
        effort: this.options.effort,
        system: systemPrompt(projectId),
        host,
        history: c.history,
        maxToolCalls: this.options.maxToolCalls ?? MAX_TOOL_CALLS,
        signal: controller.signal,
        emit,
      });
      emit({ type: 'done', reason });
    } catch (err) {
      if (!isCutlineError(err)) log.warn(`chat failed: ${describeChatError(err).message}`);
      emit({ type: 'error', ...describeChatError(err) });
      emit({ type: 'done', reason: 'error' });
    } finally {
      c.running = null;
    }
  }

  /** Stops the running reply (if any). */
  cancel(projectId: string): boolean {
    const running = this.conversations.get(projectId)?.running;
    running?.abort();
    return Boolean(running);
  }

  /** "New chat": cancels and forgets the conversation. */
  async reset(projectId: string): Promise<void> {
    const c = this.conversations.get(projectId);
    if (!c) return;
    c.running?.abort();
    this.conversations.delete(projectId);
    await c.host?.then((h) => h.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.conversations.keys()].map((id) => this.reset(id)));
  }
}
