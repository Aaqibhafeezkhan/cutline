import type { CanvasSink, WrappedCanvas } from 'mediabunny';

/** Seeking further ahead than this restarts decoding at the target instead of decoding through. */
const FORWARD_JUMP = 1.5;

/**
 * Reads frames of one clip in mostly-increasing time order (playback,
 * export) while tolerating random access (scrubbing): small forward steps
 * advance the decoder, backward or large jumps restart it.
 */
export class FrameReader {
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private upcoming: WrappedCanvas | null = null;
  private lastTime = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly sink: CanvasSink) {}

  /** The frame displayed at source time `t` (null before the first frame). Calls are serialized. */
  frameAt(t: number): Promise<WrappedCanvas | null> {
    const run = this.queue.then(() => this.read(t));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(t: number): Promise<WrappedCanvas | null> {
    const jump = t < this.lastTime - 1e-4 || t > this.lastTime + FORWARD_JUMP;
    this.lastTime = t;
    if (!this.iterator || jump) {
      await this.restart(t);
      return this.current;
    }
    while (this.upcoming && this.upcoming.timestamp <= t + 1e-6) {
      this.current = this.upcoming;
      this.upcoming = (await this.iterator.next()).value ?? null;
    }
    return this.current;
  }

  private async restart(t: number): Promise<void> {
    await this.iterator?.return();
    this.iterator = this.sink.canvases(t);
    this.current = (await this.iterator.next()).value ?? null;
    this.upcoming = this.current ? ((await this.iterator.next()).value ?? null) : null;
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.iterator?.return();
    this.iterator = null;
    this.current = null;
    this.upcoming = null;
  }
}
