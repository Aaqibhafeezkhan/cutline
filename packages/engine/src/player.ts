import {
  projectDuration,
  resolveAudioSegments,
  resolveFrame,
  type Asset,
  type Project,
} from '@cutline/core';
import { AudioScheduler } from './audio/scheduler';
import { FrameSourceProvider } from './media/frame-sources';
import { MediaPool, type AssetLocator } from './media/media-pool';
import { Compositor } from './render/compositor';

export interface PlayerOptions {
  canvas: HTMLCanvasElement;
  locator: AssetLocator;
  /** Max preview height in canvas pixels (default 720). The canvas keeps the project aspect ratio. */
  maxPreviewHeight?: number;
  onTimeUpdate?: (time: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onError?: (error: unknown) => void;
}

/** Scheduling lead between pressing play and the first audible sample. */
const START_LEAD = 0.08;

/**
 * Real-time preview of a project: renders frames to a canvas with WebGL and
 * plays audio through Web Audio. Call setProject() whenever the document
 * changes (including changes made by an AI agent).
 */
export class Player {
  private project: Project | null = null;
  private assets = new Map<string, Asset>();
  private time = 0;
  private playing = false;
  private rendering = false;
  private pendingRender: number | null = null;
  private renderWaiters: Array<() => void> = [];
  private raf = 0;
  private audioCtx: AudioContext | null = null;
  private scheduler: AudioScheduler | null = null;
  private playStartCtx = 0;
  private playStartTime = 0;
  private readonly pool: MediaPool;
  private readonly sources: FrameSourceProvider;
  private destroyed = false;

  private constructor(
    private readonly options: PlayerOptions,
    private readonly compositor: Compositor,
  ) {
    this.pool = new MediaPool(options.locator);
    this.sources = new FrameSourceProvider(this.pool, options.canvas.width, options.canvas.height);
  }

  static async create(options: PlayerOptions): Promise<Player> {
    const compositor = await Compositor.create(options.canvas, 1920, 1080);
    return new Player(options, compositor);
  }

  get currentTime(): number {
    return this.time;
  }

  get duration(): number {
    return this.project ? projectDuration(this.project) : 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setProject(project: Project): void {
    const prev = this.project;
    this.project = project;
    this.assets = new Map(project.assets.map((a) => [a.id, a]));
    this.sources.prune(new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id))));
    if (
      !prev ||
      prev.settings.width !== project.settings.width ||
      prev.settings.height !== project.settings.height
    ) {
      this.resizeCanvas();
    }
    if (this.playing) {
      // Timeline changed under the playhead (e.g. an agent cut something): resync audio.
      if (prev && prev.tracks !== project.tracks) this.restartAudio(this.clockTime());
    } else {
      void this.renderFrame(this.time);
    }
  }

  private resizeCanvas(): void {
    if (!this.project) return;
    const { width, height } = this.project.settings;
    const maxH = this.options.maxPreviewHeight ?? 720;
    const scale = Math.min(1, maxH / height);
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    this.compositor.resize(w, h, width, height);
    this.sources.setMaxSize(w, h);
  }

  /**
   * Renders the frame at time t. Concurrent requests are coalesced to the latest
   * one; the returned promise resolves once that frame is on the canvas.
   */
  async renderFrame(t: number = this.time): Promise<void> {
    if (!this.project || this.destroyed) return;
    if (this.rendering) {
      this.pendingRender = t;
      return new Promise((resolve) => this.renderWaiters.push(resolve));
    }
    this.rendering = true;
    try {
      let next: number | null = t;
      while (next !== null && this.project && !this.destroyed) {
        this.pendingRender = null;
        const frame = resolveFrame(this.project, next);
        const sources = await this.sources.gather(frame, this.assets);
        if (this.destroyed) return;
        this.compositor.render(frame, sources);
        next = this.pendingRender;
      }
    } catch (err) {
      this.options.onError?.(err);
    } finally {
      this.rendering = false;
      const waiters = this.renderWaiters;
      this.renderWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(t, this.duration));
    this.options.onTimeUpdate?.(this.time);
    if (this.playing) this.restartAudio(this.time);
    void this.renderFrame(this.time);
  }

  async play(): Promise<void> {
    if (this.playing || !this.project) return;
    if (this.time >= this.duration - 1e-3) this.time = 0;
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.scheduler = new AudioScheduler(this.audioCtx, this.pool, this.audioCtx.destination);
    }
    await this.audioCtx.resume();
    this.playing = true;
    this.restartAudio(this.time);
    this.options.onPlayStateChange?.(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.scheduler?.stop();
    this.options.onPlayStateChange?.(false);
    void this.renderFrame(this.time);
  }

  toggle(): Promise<void> | void {
    return this.playing ? this.pause() : this.play();
  }

  /** Re-anchors the clock so timeline time `from` plays shortly from now, and reschedules audio. */
  private restartAudio(from: number): void {
    if (!this.project || !this.scheduler || !this.audioCtx) return;
    this.playStartTime = from;
    this.playStartCtx = this.audioCtx.currentTime + START_LEAD;
    this.scheduler.start(
      resolveAudioSegments(this.project),
      this.assets,
      this.playStartTime,
      this.playStartCtx,
    );
  }

  private clockTime(): number {
    const ctxNow = this.audioCtx?.currentTime ?? 0;
    return this.playStartTime + Math.max(0, ctxNow - this.playStartCtx);
  }

  private tick = (): void => {
    if (!this.playing) return;
    this.time = this.clockTime();
    if (this.time >= this.duration) {
      this.time = this.duration;
      this.options.onTimeUpdate?.(this.time);
      this.pause();
      return;
    }
    this.options.onTimeUpdate?.(this.time);
    void this.renderFrame(this.time);
    this.raf = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.scheduler?.stop();
    void this.audioCtx?.close();
    this.sources.disposeReaders();
    this.pool.dispose();
    this.compositor.destroy();
  }
}
