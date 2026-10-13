import { CutlineError } from './errors';
import { ease } from './keyframes';
import type { Animation, AnimationPreset } from './schema';
import { EPSILON, clamp, formatTime } from './time';

/**
 * Entrance/exit animation presets.
 *
 * Presets are evaluated at render time from `animationIn` / `animationOut`
 * and the clip-local time, never baked into keyframes, so trimming or
 * splitting a clip keeps the motion attached to its (new) edges.
 *
 * Each preset describes the *off-screen pose* of the clip and is driven by a
 * visibility progress `p` in [0, 1] (0 = fully off, 1 = at rest):
 *
 * - entrance: `p = local / in.duration` over the first `in.duration` seconds,
 *   eased with easeOut (fast start, gentle landing);
 * - exit: `p = (clipDuration - local) / out.duration` over the last
 *   `out.duration` seconds. Feeding the same easeOut curve with a decreasing
 *   `p` is an easeIn in forward time (gentle start, fast departure), so the
 *   exit is the time-mirror of the entrance.
 *
 * The contribution combines with the base transform and user keyframes:
 *
 * - `dx` / `dy`: additive position offset in project pixels. Slides travel
 *   {@link SLIDE_DISTANCE} of the frame width (left/right) or height (up/down).
 *   The preset name is the direction of motion: `slide-left` enters from the
 *   right moving left and exits by continuing to the left.
 * - `scale`: multiplier. `zoom` grows from {@link ZOOM_FROM} to 1; `pop` grows
 *   from {@link POP_FROM} with a small overshoot (easeOutBack, peaks ≈ 1.07).
 * - `opacity`: multiplier, `easeOut(p)` for every preset (slides, zooms and
 *   pops also fade).
 *
 * When entrance and exit overlap (a clip trimmed shorter than both), their
 * contributions simply compose: offsets add, scale and opacity multiply.
 */
export interface AnimationContribution {
  dx: number;
  dy: number;
  scale: number;
  opacity: number;
}

export const IDENTITY_ANIMATION: Readonly<AnimationContribution> = Object.freeze({
  dx: 0,
  dy: 0,
  scale: 1,
  opacity: 1,
});

/** Fraction of the frame size that slide presets travel. */
export const SLIDE_DISTANCE = 0.25;
/** Starting scale of the zoom preset. */
export const ZOOM_FROM = 0.5;
/** Starting scale of the pop preset (before the overshoot). */
export const POP_FROM = 0.3;

/** Frame size the slide distance is relative to (project settings). */
export interface FrameSize {
  width: number;
  height: number;
}

interface AnimatedClip {
  duration: number;
  animationIn?: Animation;
  animationOut?: Animation;
}

/** easeOutBack: overshoots 1 by ~7% around p ≈ 0.6, then settles at 1. */
export function backOut(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
}

/** Direction (in units of the frame size) a slide comes from / goes to. */
const SLIDE_DIRECTION: Partial<Record<AnimationPreset, [number, number]>> = {
  'slide-left': [1, 0],
  'slide-right': [-1, 0],
  'slide-up': [0, 1],
  'slide-down': [0, -1],
};

/**
 * Pose of one preset at visibility progress `p` (0 = off, 1 = at rest).
 * `edge` selects the side for slides: entering from `+dir`, leaving to `-dir`.
 */
export function presetPose(
  preset: AnimationPreset,
  p: number,
  edge: 'in' | 'out',
  frame: FrameSize,
): AnimationContribution {
  const v = clamp(p, 0, 1);
  const e = ease('easeOut', v);
  const pose: AnimationContribution = { dx: 0, dy: 0, scale: 1, opacity: e };
  const dir = SLIDE_DIRECTION[preset];
  if (dir) {
    const sign = edge === 'in' ? 1 : -1;
    pose.dx = sign * dir[0] * (1 - e) * SLIDE_DISTANCE * frame.width;
    pose.dy = sign * dir[1] * (1 - e) * SLIDE_DISTANCE * frame.height;
  } else if (preset === 'zoom') {
    pose.scale = ZOOM_FROM + (1 - ZOOM_FROM) * e;
  } else if (preset === 'pop') {
    pose.scale = POP_FROM + (1 - POP_FROM) * backOut(v);
  }
  return pose;
}

/**
 * Combined entrance/exit contribution at clip-local time `local`
 * (clamped to the clip). Returns the identity outside the animated edges.
 */
export function animationAt(
  clip: AnimatedClip,
  local: number,
  frame: FrameSize,
): AnimationContribution {
  const lt = clamp(local, 0, clip.duration);
  const out: AnimationContribution = { ...IDENTITY_ANIMATION };
  const parts: AnimationContribution[] = [];
  const ain = clip.animationIn;
  if (ain && lt < ain.duration) parts.push(presetPose(ain.preset, lt / ain.duration, 'in', frame));
  const aout = clip.animationOut;
  if (aout && clip.duration - lt < aout.duration) {
    parts.push(presetPose(aout.preset, (clip.duration - lt) / aout.duration, 'out', frame));
  }
  for (const p of parts) {
    out.dx += p.dx;
    out.dy += p.dy;
    out.scale *= p.scale;
    out.opacity *= p.opacity;
  }
  return out;
}

/**
 * Clip-local times at which to sample {@link animationAt} for a
 * piecewise-linear approximation (used by the ffmpeg renderer). Empty when
 * the clip has no animation; sorted and unique otherwise.
 */
export function animationSampleTimes(clip: AnimatedClip, steps = 12): number[] {
  const times = new Set<number>();
  const ramp = (from: number, to: number) => {
    for (let i = 0; i <= steps; i++) {
      times.add(clamp(from + ((to - from) * i) / steps, 0, clip.duration));
    }
  };
  if (clip.animationIn) ramp(0, clip.animationIn.duration);
  if (clip.animationOut) ramp(clip.duration - clip.animationOut.duration, clip.duration);
  return [...times].sort((a, b) => a - b);
}

/**
 * Checks that entrance and exit animations fit into the clip together.
 * `animationIn` / `animationOut` are the values the clip will have.
 */
export function assertAnimationsFit(
  clip: { id: string } & AnimatedClip,
  animationIn: Animation | undefined,
  animationOut: Animation | undefined,
): void {
  const din = animationIn?.duration ?? 0;
  const dout = animationOut?.duration ?? 0;
  if (din + dout <= clip.duration + EPSILON) return;
  const both = din > 0 && dout > 0;
  const what = both
    ? `In (${formatTime(din)}) and out (${formatTime(dout)}) animations together do`
    : `A ${formatTime(din || dout)} ${din ? 'in' : 'out'} animation does`;
  const hint = both
    ? `Their durations must add up to at most ${formatTime(clip.duration)}, e.g. ${formatTime(clip.duration / 2)} each.`
    : `Use a duration of at most ${formatTime(clip.duration)}, or lengthen the clip first.`;
  throw new CutlineError(
    'OUT_OF_RANGE',
    `${what} not fit into clip ${clip.id} (${formatTime(clip.duration)} long).`,
    { hint },
  );
}
