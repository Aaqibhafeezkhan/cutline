import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { CutlineConfig } from '../config';
import { fakeChatModel } from './fake';

/** One streamed model turn: raw stream events plus the assembled final message. */
export interface ChatStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

/**
 * The slice of the Anthropic client the chat agent needs. The real client
 * implements it via `client.beta.messages.stream`; tests and the dev-only
 * `CUTLINE_CHAT_FAKE` switch inject scripted implementations.
 */
export interface ChatModel {
  stream(params: BetaMessageStreamParams, signal: AbortSignal): ChatStream;
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

export function anthropicChatModel(apiKey: string): ChatModel {
  // The key is passed explicitly so that only ANTHROPIC_API_KEY enables the feature.
  const client = new Anthropic({ apiKey });
  return { stream: (params, signal) => client.beta.messages.stream(params, { signal }) };
}

/**
 * Picks the chat model from the server environment: the scripted fake when
 * CUTLINE_CHAT_FAKE=1 (dev only), the Anthropic API when ANTHROPIC_API_KEY is
 * set, otherwise null (chat disabled). The key never leaves this function.
 */
export function chatModelFromEnv(
  config: CutlineConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChatModel | null {
  if (config.chatFake) return fakeChatModel();
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? anthropicChatModel(key) : null;
}
