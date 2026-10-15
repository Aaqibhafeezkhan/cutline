import { assertAnimationsFit } from '../animation';
import { assertSourceRange, clipSpeed, isFreeze } from '../clipmath';
import { CutlineError } from '../errors';
import { scaleKeyframes, sortKeyframes } from '../keyframes';
import { overlappingClips, previousAdjacent } from '../queries';
import {
  clipEnd,
  hasSource,
  type AnimatableProperty,
  type Asset,
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
import { EPSILON, formatTime, roundTime } from '../time';
import type { ClipPropsPatch } from './schemas';
import { emptyLog, shiftClips, type EditLog } from './track-edit';

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
  speed: AUDIBLE,
  reverse: AUDIBLE,
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

export interface SpeedChange {
  speed?: number;
  reverse?: boolean;
  /** Keep the timeline duration and use more/less source instead (default false). */
  keepDuration?: boolean;
  /** Shift later clips on the track by the change in duration (default false). */
  ripple?: boolean;
}

/**
 * Changes speed and/or direction of a video/audio clip draft in place. By
 * default the source window is kept, so the timeline duration becomes
 * span / speed (keyframes scale along); with keepDuration the source window
 * changes instead and must fit into `asset`.
 */
export function applySpeedChange(
  track: Track,
  clip: Clip,
  change: SpeedChange,
  asset: Asset | undefined,
  log: EditLog,
): void {
  if (!hasSource(clip)) {
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Speed and reverse only apply to video and audio clips, not ${clip.type} (clip ${clip.id}).`,
      {
        hint: 'Images, text and shapes have no source timing: change how long they show with trim_clip.',
      },
    );
  }
  if (isFreeze(clip)) {
    throw new CutlineError('INVALID_ARGUMENT', `Clip ${clip.id} is a freeze frame.`, {
      hint: 'A freeze frame holds one frame: change its length with trim_clip, or set the speed of the clip it was taken from.',
    });
  }
  if (change.reverse !== undefined) {
    if (change.reverse) clip.reverse = true;
    else delete clip.reverse;
  }
  const oldSpeed = clipSpeed(clip);
  const speed = change.speed ?? oldSpeed;
  if (speed === oldSpeed) return;
  if (change.keepDuration) {
    assertSourceRange(clip, asset, clip.sourceStart, clip.duration * speed, speed);
  } else {
    const duration = roundTime((clip.duration * oldSpeed) / speed);
    const oldEnd = clipEnd(clip);
    const delta = duration - clip.duration;
    if (change.ripple) {
      shiftClips(track, oldEnd, delta, log);
    } else {
      const collisions = overlappingClips(track, clip.start, clip.start + duration, clip.id);
      if (collisions.length > 0) {
        throw new CutlineError(
          'OVERLAP',
          `At speed ${speed} clip ${clip.id} would last ${formatTime(duration)} and overlap ${collisions.map((c) => c.id).join(', ')}.`,
          {
            hint: 'Pass ripple: true to push later clips, keepDuration: true to keep the length, or make room first.',
          },
        );
      }
    }
    if (clip.keyframes) clip.keyframes = scaleKeyframes(clip.keyframes, duration / clip.duration);
    clip.duration = duration;
  }
  if (speed === 1) delete clip.speed;
  else clip.speed = speed;
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
  if (patch.speed !== undefined || patch.reverse !== undefined) {
    // Keeps the source window: the duration follows the speed (no ripple).
    applySpeedChange(
      track,
      clip,
      { speed: patch.speed, reverse: patch.reverse },
      undefined,
      emptyLog(),
    );
  }
  return changed;
}
