import { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ChatModel, ChatStream } from './model';

/** A scripted assistant turn: text and tool calls in order. */
export type ScriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface ScriptTurn {
  content: ScriptBlock[];
  stopReason?: BetaStopReason;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turns a scripted assistant turn into the stream interface the agent loop
 * consumes (the same event shapes the Anthropic SDK yields). Used by tests and
 * by the dev-only fake model.
 */
export function scriptedStream(turn: ScriptTurn, signal: AbortSignal, delayMs = 0): ChatStream {
  const stopReason =
    turn.stopReason ?? (turn.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  const message = {
    id: `msg_fake_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: 'cutline-fake',
    content: turn.content.map((b) => (b.type === 'text' ? { ...b, citations: null } : { ...b })),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as BetaMessage;

  async function* events(): AsyncGenerator<BetaRawMessageStreamEvent> {
    const ev = (e: unknown) => e as BetaRawMessageStreamEvent;
    const check = () => {
      if (signal.aborted) throw new APIUserAbortError();
    };
    check();
    yield ev({ type: 'message_start', message: { ...message, content: [] } });
    for (const [index, block] of turn.content.entries()) {
      if (block.type === 'text') {
        yield ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const piece of block.text.match(/\S+\s*|\s+/g) ?? []) {
          if (delayMs) await sleep(delayMs);
          check();
          yield ev({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: piece },
          });
        }
      } else {
        yield ev({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        yield ev({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      }
      yield ev({ type: 'content_block_stop', index });
    }
    check();
    yield ev({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } });
    yield ev({ type: 'message_stop' });
  }

  let consumed: Promise<void> | null = null;
  const iterator = events();
  return {
    [Symbol.asyncIterator]() {
      consumed = Promise.resolve();
      return iterator;
    },
    async finalMessage() {
      if (!consumed) for await (const _ of iterator) void _;
      if (signal.aborted) throw new APIUserAbortError();
      return message;
    },
  };
}

/** Text of the most recent tool result in the conversation (for the fake model's reply). */
function lastToolResultText(messages: BetaMessageParam[]): string | null {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return null;
  for (const block of last.content) {
    if (block.type !== 'tool_result') continue;
    const content = block.content;
    if (typeof content === 'string') return content;
    const text = content?.find((c) => c.type === 'text');
    if (text && text.type === 'text') return text.text;
  }
  return null;
}

/**
 * DEV ONLY (CUTLINE_CHAT_FAKE=1): a scripted stand-in for Claude so the chat
 * panel can be tried and tested without an API key. It always looks at the
 * project with get_project and then reports what it found.
 */
export function fakeChatModel(delayMs = 25): ChatModel {
  let n = 0;
  return {
    stream(params, signal) {
      const toolText = lastToolResultText(params.messages);
      if (toolText === null) {
        n += 1;
        return scriptedStream(
          {
            content: [
              { type: 'text', text: 'Let me look at the timeline first.' },
              { type: 'tool_use', id: `toolu_fake_${n}`, name: 'get_project', input: {} },
            ],
          },
          signal,
          delayMs,
        );
      }
      const firstLine = toolText.split('\n')[0] ?? '';
      return scriptedStream(
        {
          content: [
            {
              type: 'text',
              text: `Here is what I found:\n\n- **Project:** ${firstLine}\n- Edits I make show up live on the timeline, and \`Ctrl+Z\` undoes them.\n\n*This reply comes from the scripted dev model (CUTLINE_CHAT_FAKE=1). Set ANTHROPIC_API_KEY for real answers.*`,
            },
          ],
        },
        signal,
        delayMs,
      );
    },
  };
}
