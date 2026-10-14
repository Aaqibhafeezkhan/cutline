import type { CanvasSink, WrappedCanvas } from 'mediabunny';

/** Seeking further ahead than this restarts decoding at the target instead of decoding through. */
const FORWARD_JUMP = 1.5;
/**
 * Source seconds decoded at once when frames are requested backwards
 * (reversed clips, stepping back). Decoders only run forwards, so each window
 * costs one decode from the preceding keyframe; the frames are kept as
 * ImageBitmaps (≈ 15 frames at 30 fps) and served from memory.
 */
const REVERSE_WINDOW = 0.5;

interface BackFrame {
  timestamp: number;
  bitmap: ImageBitmap;
}

/**
 * Reads frames of one clip in mostly-increasing time order (playback,
 * export) while tolerating random access (scrubbing): small forward steps
 * advance the decoder, large jumps restart it, and backward steps (reversed
 * clips) are served from a cache of the preceding REVERSE_WINDOW seconds.
 */
export class FrameReader {
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private upcoming: WrappedCanvas | null = null;
  private lastTime = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();
  private back: { frames: BackFrame[]; from: number; to: number } | null = null;
  private output: HTMLCanvasElement | OffscreenCanvas | null = null;

  constructor(private readonly sink: CanvasSink) {}

  /** The frame displayed at source time `t` (null before the first frame). Calls are serialized. */
  frameAt(t: number): Promise<WrappedCanvas | null> {
    const run = this.queue.then(() => this.read(t));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(t: number): Promise<WrappedCanvas | null> {
    const backward = t < this.lastTime - 1e-4;
    if (this.back && t >= this.back.from - 1e-6 && t <= this.back.to + 1e-6) {
      this.lastTime = t;
      return this.fromBack(t);
    }
    if (backward && this.lastTime - t < FORWARD_JUMP) {
      this.lastTime = t;
      await this.fillBack(t);
      return this.fromBack(t);
    }
    const jump = backward || t > this.lastTime + FORWARD_JUMP;
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

  /** Decodes [t - REVERSE_WINDOW, t] into the backward cache. */
  private async fillBack(t: number): Promise<void> {
    this.clearBack();
    // The forward iterator is positioned after `t`: start over on the next forward read.
    await this.iterator?.return();
    this.iterator = null;
    const frames: BackFrame[] = [];
    for await (const w of this.sink.canvases(Math.max(0, t - REVERSE_WINDOW), t + 1e-4)) {
      frames.push({ timestamp: w.timestamp, bitmap: await createImageBitmap(w.canvas) });
    }
    if (frames.length > 0) this.back = { frames, from: frames[0]!.timestamp, to: t };
  }

  /** Draws the cached frame shown at `t` into a reused output canvas. */
  private fromBack(t: number): WrappedCanvas | null {
    const frames = this.back?.frames ?? [];
    let hit: BackFrame | undefined;
    for (const f of frames) {
      if (f.timestamp <= t + 1e-6) hit = f;
      else break;
    }
    if (!hit) return null;
    const { width, height } = hit.bitmap;
    if (!this.output || this.output.width !== width || this.output.height !== height) {
      this.output =
        typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width, height })
          : new OffscreenCanvas(width, height);
    }
    const ctx = this.output.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    ctx?.drawImage(hit.bitmap, 0, 0);
    return { canvas: this.output, timestamp: hit.timestamp, duration: 0 } as WrappedCanvas;
  }

  private clearBack(): void {
    for (const f of this.back?.frames ?? []) f.bitmap.close();
    this.back = null;
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.iterator?.return();
    this.iterator = null;
    this.current = null;
    this.upcoming = null;
    this.clearBack();
  }
}
