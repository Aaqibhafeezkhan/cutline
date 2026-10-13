import { assertAnimationsFit } from '../animation';
import { CutlineError } from '../errors';
import { sortKeyframes } from '../keyframes';
import { previousAdjacent } from '../queries';
import {
  type AnimatableProperty,
  type Animation,
  type Clip,
  type ClipType,
  type Effects,
  type Keyframe,
  type Keyframes,
  type TextStyle,
  type Track,
  type Transform,
  type Transition,
  type Word,
} from '../schema';
import { EPSILON, formatTime } from '../time';
import type { ClipPropsPatch } from './schemas';

const VISUAL: ClipType[] = ['video', 'image', 'text', 'shape'];
const AUDIBLE: ClipType[] = ['video', 'audio'];
const FADEABLE: ClipType[] = ['video', 'audio', 'image', 'text', 'shape'];
const SHAPE: ClipType[] = ['shape'];
/** Plain values copied as-is from the patch (applicability checked first). */
const SHAPE_FIELDS = [
  'shape',
  'width',
  'height',
  'fill',
  'strokeColor',
  'strokeWidth',
  'cornerRadius',
] as const;

const APPLIES: Record<keyof ClipPropsPatch, readonly ClipType[]> = {
  name: ['video', 'audio', 'image', 'text', 'shape', 'caption'],
  transform: VISUAL,
  effects: VISUAL,
  keyframes: FADEABLE,
  fadeIn: FADEABLE,
  fadeOut: FADEABLE,
  volume: AUDIBLE,
  muted: AUDIBLE,
  text: ['text', 'caption'],
  style: ['text'],
  words: ['caption'],
  transitionIn: VISUAL,
  animationIn: VISUAL,
  animationOut: VISUAL,
  shape: SHAPE,
  width: SHAPE,
  height: SHAPE,
  fill: SHAPE,
  strokeColor: SHAPE,
  strokeWidth: SHAPE,
  cornerRadius: SHAPE,
};

function keyframeAllowed(type: ClipType, prop: AnimatableProperty): boolean {
  if (prop === 'volume') return AUDIBLE.includes(type);
  return VISUAL.includes(type);
}

function notApplicable(clip: Clip, what: string): CutlineError {
  const applicable = (Object.keys(APPLIES) as Array<keyof ClipPropsPatch>).filter((k) =>
    APPLIES[k].includes(clip.type),
  );
  return new CutlineError(
    'INVALID_ARGUMENT',
    `"${what}" does not apply to ${clip.type} clips (clip ${clip.id}).`,
    { hint: `Settable on ${clip.type} clips: ${applicable.join(', ')}.` },
  );
}

/**
 * Max transition length into `clip`. With an adjacent predecessor the
 * transition is centered on the cut, so half of it must fit into each side;
 * without one it is a fade from transparent inside the clip.
 */
export function maxTransitionDuration(track: Track, clip: Clip): number {
  const prev = previousAdjacent(track, clip);
  return prev ? 2 * Math.min(clip.duration, prev.duration) : clip.duration;
}

export function assertTransitionFits(track: Track, clip: Clip, duration: number): void {
  const max = maxTransitionDuration(track, clip);
  if (duration > max + EPSILON) {
    throw new CutlineError(
      'OUT_OF_RANGE',
      `A ${formatTime(duration)} transition does not fit into clip ${clip.id}.`,
      { hint: `Use at most ${formatTime(max)} (limited by the clip and its neighbor).` },
    );
  }
}

/** Union of all clip fields; applicability is checked before writing. */
interface LooseClip {
  id: string;
  type: ClipType;
  name?: string;
  transform?: Transform;
  effects?: Effects;
  keyframes?: Keyframes;
  fadeIn?: number;
  fadeOut?: number;
  volume?: number;
  muted?: boolean;
  text?: string;
  style?: TextStyle;
  words?: Word[];
  transitionIn?: Transition;
  animationIn?: Animation;
  animationOut?: Animation;
}

/**
 * Sets (Animation), removes (null) or keeps (undefined) the entrance and exit
 * animations of a visual clip draft, after checking that they fit together.
 */
export function applyAnimations(
  clip: Clip,
  animationIn: Animation | null | undefined,
  animationOut: Animation | null | undefined,
): void {
  const c = clip as unknown as LooseClip & { duration: number };
  const nextIn = animationIn === undefined ? c.animationIn : (animationIn ?? undefined);
  const nextOut = animationOut === undefined ? c.animationOut : (animationOut ?? undefined);
  assertAnimationsFit(c, nextIn, nextOut);
  if (nextIn) c.animationIn = nextIn;
  else delete c.animationIn;
  if (nextOut) c.animationOut = nextOut;
  else delete c.animationOut;
}

/** Applies a props patch to a clip draft in place, validating applicability. */
export function applyPropsPatch(track: Track, clip: Clip, patch: ClipPropsPatch): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(patch) as Array<keyof ClipPropsPatch>) {
    if (patch[key] === undefined) continue;
    if (!APPLIES[key].includes(clip.type)) throw notApplicable(clip, key);
    changed.push(key);
  }
  const c = clip as unknown as LooseClip;
  if (patch.name !== undefined) c.name = patch.name;
  if (patch.transform && c.transform) Object.assign(c.transform, patch.transform);
  if (patch.effects && c.effects) {
    for (const [k, v] of Object.entries(patch.effects)) {
      const key = k as keyof Effects;
      if (v === null) delete c.effects[key];
      else if (v !== undefined) c.effects[key] = v;
    }
  }
  if (patch.keyframes) {
    const kf = { ...c.keyframes };
    for (const [prop, list] of Object.entries(patch.keyframes) as Array<
      [AnimatableProperty, Keyframe[]]
    >) {
      if (!keyframeAllowed(c.type, prop)) throw notApplicable(clip, `keyframes.${prop}`);
      if (list.length === 0) delete kf[prop];
      else kf[prop] = sortKeyframes(list);
    }
    if (Object.keys(kf).length > 0) c.keyframes = kf;
    else delete c.keyframes;
  }
  if (patch.fadeIn !== undefined) c.fadeIn = patch.fadeIn;
  if (patch.fadeOut !== undefined) c.fadeOut = patch.fadeOut;
  if (patch.volume !== undefined) c.volume = patch.volume;
  if (patch.muted !== undefined) c.muted = patch.muted;
  if (patch.text !== undefined) c.text = patch.text;
  if (patch.style && c.style) Object.assign(c.style, patch.style);
  if (patch.words !== undefined) c.words = patch.words;
  const loose = c as unknown as Record<string, unknown>;
  for (const key of SHAPE_FIELDS) {
    if (patch[key] !== undefined) loose[key] = patch[key];
  }
  if (patch.transitionIn !== undefined) {
    if (patch.transitionIn === null) delete c.transitionIn;
    else {
      assertTransitionFits(track, clip, patch.transitionIn.duration);
      c.transitionIn = patch.transitionIn;
    }
  }
  if (patch.animationIn !== undefined || patch.animationOut !== undefined) {
    applyAnimations(clip, patch.animationIn, patch.animationOut);
  }
  return changed;
}
