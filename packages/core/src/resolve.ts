import { animationAt, type FrameSize } from './animation';
import { animatedValue } from './keyframes';
import { ADJACENT_TOLERANCE, previousAdjacent } from './queries';
import {
  CaptionStyleSchema,
  clipEnd,
  type Asset,
  type CaptionStyle,
  type Clip,
  type Effects,
  type Project,
  type ShapeKind,
  type TextStyle,
  type Track,
  type Transform,
  type VisualClip,
  type Word,
} from './schema';
import { clamp } from './time';

export interface VisualLayer {
  clipId: string;
  trackId: string;
  type: 'video' | 'image' | 'text' | 'shape' | 'caption';
  /** Time relative to the clip start (may be <0 or >duration during transitions). */
  localTime: number;
  assetId?: string;
  /** Source media time to show, for video clips. */
  sourceTime?: number;
  /** Evaluated transform; opacity already includes fades and transitions. */
  transform: Transform;
  effects: Effects;
  text?: string;
  style?: TextStyle;
  captionStyle?: CaptionStyle;
  words?: Word[];
  /** Index into `words` of the word being spoken, or -1. */
  activeWord?: number;
  /** Geometry and paint of shape layers. */
  shape?: ShapeGeometry;
}

export interface ShapeGeometry {
  kind: ShapeKind;
  width: number;
  height: number;
  fill: string | null;
  strokeColor: string;
  strokeWidth: number;
  cornerRadius: number;
}

export interface FrameDescription {
  time: number;
  width: number;
  height: number;
  background: string;
  layers: VisualLayer[];
}

const DEFAULT_CAPTION_STYLE = CaptionStyleSchema.parse({});

function nextAdjacent<C extends Clip>(track: { clips: readonly C[] }, clip: Clip): C | undefined {
  const end = clipEnd(clip);
  return track.clips.find((c) => c.id !== clip.id && Math.abs(c.start - end) <= ADJACENT_TOLERANCE);
}

function fadeFactor(local: number, duration: number, fadeIn: number, fadeOut: number): number {
  let f = 1;
  if (fadeIn > 0) f = Math.min(f, clamp(local / fadeIn, 0, 1));
  if (fadeOut > 0) f = Math.min(f, clamp((duration - local) / fadeOut, 0, 1));
  return f;
}

/**
 * Visibility (or audio gain) factor of a clip at time t, taking its own
 * transitionIn and the transitionIn of the following clip into account.
 * 0 = not drawn / silent. During an outgoing crossfade the picture stays at
 * full opacity underneath the incoming clip, while the audio ramps down.
 */
export function transitionFactor(
  track: Track,
  clip: Clip,
  t: number,
  mode: 'visual' | 'audio' = 'visual',
): number {
  if (clip.type === 'caption' || clip.type === 'audio') {
    return t >= clip.start && t < clipEnd(clip) ? 1 : 0;
  }
  const start = clip.start;
  const end = clipEnd(clip);
  let factor = t >= start && t < end ? 1 : 0;

  const tin = clip.transitionIn;
  if (tin) {
    const prev = previousAdjacent(track, clip);
    const d = tin.duration;
    if (!prev) {
      if (t >= start && t < start + d) factor = (t - start) / d;
    } else if (tin.type === 'crossfade') {
      if (t >= start - d / 2 && t < start + d / 2) factor = (t - (start - d / 2)) / d;
    } else if (t >= start && t < start + d / 2) {
      factor = (t - start) / (d / 2);
    }
  }

  const next = nextAdjacent(track, clip);
  const nin =
    next && next.type !== 'audio' && next.type !== 'caption' ? next.transitionIn : undefined;
  if (nin) {
    const d = nin.duration;
    if (nin.type === 'crossfade') {
      if (t >= end - d / 2 && t < end + d / 2) {
        factor = mode === 'visual' ? 1 : 1 - (t - (end - d / 2)) / d;
      }
    } else if (t >= end - d / 2 && t < end) {
      factor = Math.min(factor, (end - t) / (d / 2));
    }
  }
  return factor;
}

function visualLayer(
  assets: Map<string, Asset>,
  frame: FrameSize,
  track: Track,
  clip: VisualClip,
  t: number,
  factor: number,
): VisualLayer {
  const local = t - clip.start;
  const lt = clamp(local, 0, clip.duration);
  const kf = clip.keyframes;
  const base = clip.transform;
  // Entrance/exit presets: offsets add, scale and opacity multiply (see animation.ts).
  const anim = animationAt(clip, lt, frame);
  const opacity =
    animatedValue(kf, 'opacity', base.opacity, lt) *
    anim.opacity *
    factor *
    fadeFactor(lt, clip.duration, clip.fadeIn, clip.fadeOut);
  const layer: VisualLayer = {
    clipId: clip.id,
    trackId: track.id,
    type: clip.type,
    localTime: local,
    transform: {
      x: animatedValue(kf, 'x', base.x, lt) + anim.dx,
      y: animatedValue(kf, 'y', base.y, lt) + anim.dy,
      scale: animatedValue(kf, 'scale', base.scale, lt) * anim.scale,
      rotation: animatedValue(kf, 'rotation', base.rotation, lt),
      opacity: clamp(opacity, 0, 1),
    },
    effects: clip.effects,
  };
  if (clip.type === 'text') {
    layer.text = clip.text;
    layer.style = clip.style;
  } else if (clip.type === 'shape') {
    layer.shape = {
      kind: clip.shape,
      width: clip.width,
      height: clip.height,
      fill: clip.fill,
      strokeColor: clip.strokeColor,
      strokeWidth: clip.strokeWidth,
      cornerRadius: clip.cornerRadius,
    };
  } else {
    layer.assetId = clip.assetId;
    if (clip.type === 'video') {
      const asset = assets.get(clip.assetId);
      const max = asset?.duration ?? Infinity;
      layer.sourceTime = clamp(clip.sourceStart + local, 0, max);
    }
  }
  return layer;
}

/** Everything visible at timeline time `t`, bottom layer first. */
export function resolveFrame(project: Project, t: number): FrameDescription {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const layers: VisualLayer[] = [];
  for (const track of project.tracks) {
    if (track.hidden || track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (clip.type === 'caption') {
        if (t < clip.start || t >= clipEnd(clip)) continue;
        const local = t - clip.start;
        const words = clip.words ?? [];
        layers.push({
          clipId: clip.id,
          trackId: track.id,
          type: 'caption',
          localTime: local,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          effects: {},
          text: clip.text,
          captionStyle: track.captionStyle ?? DEFAULT_CAPTION_STYLE,
          words,
          activeWord: words.findIndex((w) => local >= w.start && local < w.end),
        });
        continue;
      }
      if (clip.type === 'audio') continue;
      const factor = transitionFactor(track, clip, t);
      if (factor <= 0) continue;
      layers.push(visualLayer(assets, project.settings, track, clip, t, factor));
    }
  }
  return {
    time: t,
    width: project.settings.width,
    height: project.settings.height,
    background: project.settings.backgroundColor,
    layers,
  };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface GainPoint {
  time: number;
  gain: number;
}

export interface AudioSegment {
  clipId: string;
  trackId: string;
  assetId: string;
  /** Timeline range during which this segment is audible. */
  timelineStart: number;
  timelineEnd: number;
  /** Source time at `timelineStart`. */
  sourceStart: number;
  /** Piecewise-linear gain envelope in timeline time (constant outside). */
  gain: GainPoint[];
}

/** Linear interpolation of a gain envelope at timeline time t. */
export function gainAt(points: readonly GainPoint[], t: number): number {
  const first = points[0];
  if (!first) return 0;
  if (t <= first.time) return first.gain;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t <= b.time) {
      // Points are sorted with unique times, and t > a.time here.
      return a.gain + ((b.gain - a.gain) * (t - a.time)) / (b.time - a.time);
    }
  }
  return points[points.length - 1]!.gain;
}

/** All audible material on the timeline, with gain envelopes, for mixing. */
export function resolveAudioSegments(project: Project): AudioSegment[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const segments: AudioSegment[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.kind === 'caption') continue;
    for (const clip of track.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      if (clip.muted) continue;
      const asset = assets.get(clip.assetId);
      if (!asset?.hasAudio) continue;

      let from = clip.start;
      let to = clipEnd(clip);
      // Audio follows the video transitions: crossfades overlap, dips fade.
      const tin = clip.type === 'video' ? clip.transitionIn : undefined;
      const prev = tin ? previousAdjacent(track, clip) : undefined;
      if (tin && prev && tin.type === 'crossfade') from = clip.start - tin.duration / 2;
      const next = nextAdjacent(track, clip);
      const nin = next?.type === 'video' ? next.transitionIn : undefined;
      if (nin && nin.type === 'crossfade') to = clipEnd(clip) + nin.duration / 2;
      from = Math.max(from, clip.start - clip.sourceStart); // cannot pre-roll before the asset start
      // Audible assets always have a duration (enforced by validation).
      to = Math.min(to, clip.start - clip.sourceStart + asset.duration!);

      const gainFn = (t: number) => {
        const local = clamp(t - clip.start, 0, clip.duration);
        const vol = animatedValue(clip.keyframes, 'volume', clip.volume, local);
        const tf = transitionFactor(track, clip, t, 'audio');
        return (
          vol * track.volume * fadeFactor(local, clip.duration, clip.fadeIn, clip.fadeOut) * tf
        );
      };

      const times = new Set<number>([from, to]);
      const add = (t: number) => {
        if (t > from && t < to) times.add(t);
      };
      add(clip.start);
      add(clipEnd(clip));
      add(clip.start + clip.fadeIn);
      add(clipEnd(clip) - clip.fadeOut);
      if (tin) {
        add(clip.start + tin.duration / 2);
        add(clip.start + tin.duration);
      }
      if (nin) {
        add(clipEnd(clip) - nin.duration / 2);
        add(clipEnd(clip) + nin.duration / 2);
      }
      const kf = clip.keyframes?.volume ?? [];
      kf.forEach((k, i) => {
        add(clip.start + k.time);
        const nextK = kf[i + 1];
        if (nextK && k.easing !== 'linear') {
          const steps = k.easing === 'hold' ? 0 : 8;
          for (let s = 1; s < steps; s++) {
            add(clip.start + k.time + ((nextK.time - k.time) * s) / steps);
          }
          if (k.easing === 'hold') add(clip.start + nextK.time - 1e-4);
        }
      });
      const sorted = [...times].sort((a, b) => a - b);
      // Sample just inside the end so segments that stop at `to` keep their last gain.
      const gain = sorted.map((time) => ({
        time,
        gain: gainFn(time === to ? to - 1e-6 : time),
      }));
      segments.push({
        clipId: clip.id,
        trackId: track.id,
        assetId: clip.assetId,
        timelineStart: from,
        timelineEnd: to,
        sourceStart: clip.sourceStart + (from - clip.start),
        gain,
      });
    }
  }
  return segments;
}
