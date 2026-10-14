import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { FALLBACK_MODELS, type ChatModel } from './model';
import type { ToolHost } from './tools';

/** Why a chat turn ended. */
export type ChatStopReason = 'end' | 'limit' | 'cancelled' | 'refusal' | 'max_tokens' | 'error';

/** Events streamed to the editor (and replayed from the transcript after a reload). */
export type ChatEvent =
  | { type: 'user'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'error'; message: string; hint?: string }
  | { type: 'done'; reason: ChatStopReason };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentOptions {
  model: ChatModel;
  modelId: string;
  /** Omitted from the request when undefined (model default). */
  effort?: Effort;
  system: string;
  host: ToolHost;
  /** Conversation so far; the run appends to it (append-only, never edited). */
  history: BetaMessageParam[];
  maxToolCalls: number;
  signal: AbortSignal;
  emit(event: ChatEvent): void;
}

const MAX_JSON_RETRIES = 2;

function requestParams(o: AgentOptions): BetaMessageStreamParams {
  const fallback = FALLBACK_MODELS.has(o.modelId);
  return {
    model: o.modelId,
    max_tokens: 64000,
    system: o.system,
    tools: o.host.tools,
    messages: o.history,
    // Auto-caches the growing conversation prefix (tools + system + history).
    cache_control: { type: 'ephemeral' },
    ...(o.effort && { output_config: { effort: o.effort } }),
    // On a policy decline, the API re-runs the turn on a fallback model.
    ...(fallback && {
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
    }),
  };
}

const errorResult = (id: string, text: string): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: id,
  content: text,
  is_error: true,
});

/**
 * Runs one user turn: streams the model, executes its tool calls through the
 * MCP host (sequentially, edits are serial anyway), feeds the results back,
 * and repeats until the model stops, the tool-call cap is hit or the user
 * cancels. The history stays a valid conversation in every exit path.
 */
export async function runAgent(o: AgentOptions): Promise<ChatStopReason> {
  let toolCalls = 0;
  let jsonRetries = 0;
  for (;;) {
    if (o.signal.aborted) return 'cancelled';
    const stream = o.model.stream(requestParams(o), o.signal);
    let message: BetaMessage;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          o.emit({ type: 'text', delta: event.delta.text });
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (o.signal.aborted || err instanceof Anthropic.APIUserAbortError) return 'cancelled';
      // A tool input that is not parseable JSON (eager input streaming) rejects the
      // stream; re-issue the turn a couple of times. API errors are not retried here.
      if (!(err instanceof Anthropic.APIError) && jsonRetries++ < MAX_JSON_RETRIES) continue;
      throw err;
    }

    const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');

    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool call off mid-input: never run it, never store it.
      o.emit({
        type: 'error',
        message: 'Claude declined to continue with this request.',
        hint: 'Rephrase the request, or start a new chat.',
      });
      return 'refusal';
    }
    if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
      o.emit({
        type: 'error',
        message: 'The reply was cut off while Claude was writing a tool call.',
        hint: 'Ask for a smaller step, e.g. one edit at a time.',
      });
      return 'max_tokens';
    }

    o.history.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue;
    if (toolUses.length === 0) return 'end';

    const results: BetaToolResultBlockParam[] = [];
    let cancelled = false;
    let limited = false;
    for (const use of toolUses) {
      if (o.signal.aborted) {
        cancelled = true;
        results.push(errorResult(use.id, 'Cancelled by the user before this tool ran.'));
        continue;
      }
      if (toolCalls >= o.maxToolCalls) {
        limited = true;
        results.push(
          errorResult(use.id, `Not run: the limit of ${o.maxToolCalls} tool calls per message.`),
        );
        continue;
      }
      toolCalls += 1;
      o.emit({ type: 'tool_start', id: use.id, name: use.name });
      let outcome;
      try {
        outcome = await o.host.call(use.name, use.input, o.signal);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (o.signal.aborted) cancelled = true;
        outcome = {
          content: [{ type: 'text' as const, text: `Error: ${text}` }],
          isError: true,
          summary: cancelled ? 'Cancelled' : text,
        };
      }
      o.emit({
        type: 'tool_end',
        id: use.id,
        name: use.name,
        ok: !outcome.isError,
        summary: outcome.summary,
      });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError && { is_error: true }),
      });
    }
    o.history.push({ role: 'user', content: results });
    if (cancelled) return 'cancelled';
    if (limited) {
      o.emit({
        type: 'error',
        message: `Stopped after ${o.maxToolCalls} tool calls.`,
        hint: 'Send "continue" to let Claude keep going.',
      });
      return 'limit';
    }
  }
}
