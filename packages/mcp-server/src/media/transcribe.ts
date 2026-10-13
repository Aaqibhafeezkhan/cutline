import { CutlineError, roundTime, type Word } from '@cutline/core';
import { log } from '../log';

export interface TranscribeOptions {
  /** ISO language code, e.g. "en" or "de". Omit to auto-detect. */
  language?: string;
  signal?: AbortSignal;
}

/** Speech-to-text with word timestamps. Input is 16 kHz mono PCM. */
export interface Transcriber {
  readonly id: string;
  transcribe(pcm16k: Float32Array, options?: TranscribeOptions): Promise<Word[]>;
}

type AsrPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
}>;

/**
 * Whisper via transformers.js (ONNX Runtime, runs locally on the CPU). The
 * model is downloaded from the Hugging Face Hub on first use and cached.
 * `@huggingface/transformers` is an optional dependency.
 */
export class WhisperTranscriber implements Transcriber {
  private pipe: Promise<AsrPipeline> | null = null;

  constructor(readonly model: string) {}

  get id(): string {
    return `whisper:${this.model}`;
  }

  private load(): Promise<AsrPipeline> {
    this.pipe ??= (async () => {
      let mod: { pipeline: (task: string, model: string, opts: object) => Promise<unknown> };
      try {
        mod = (await import('@huggingface/transformers')) as never;
      } catch {
        this.pipe = null;
        throw new CutlineError('INVALID_OPERATION', 'Speech-to-text is not installed.', {
          hint: 'Install the optional dependency: pnpm --filter @cutline/mcp-server add @huggingface/transformers',
        });
      }
      log.info(`loading speech model ${this.model} (first run downloads it)…`);
      return (await mod.pipeline('automatic-speech-recognition', this.model, {
        dtype: 'q8',
      })) as AsrPipeline;
    })();
    this.pipe.catch(() => (this.pipe = null));
    return this.pipe;
  }

  async transcribe(pcm16k: Float32Array, options: TranscribeOptions = {}): Promise<Word[]> {
    const asr = await this.load();
    const out = await asr(pcm16k, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(options.language ? { language: options.language, task: 'transcribe' } : {}),
    });
    const words: Word[] = [];
    for (const chunk of out.chunks ?? []) {
      const text = chunk.text.trim();
      const [start, end] = chunk.timestamp;
      if (!text || start === null || start === undefined) continue;
      words.push({
        text,
        start: roundTime(start),
        end: roundTime(Math.max(start, end ?? start + 0.3)),
      });
    }
    return words;
  }
}

/** Deterministic transcriber for tests: returns the given words for every input. */
export class StaticTranscriber implements Transcriber {
  readonly id = 'static';
  constructor(private readonly words: Word[]) {}
  async transcribe(): Promise<Word[]> {
    return this.words;
  }
}
