import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  IDENTITY_ANIMATION,
  POP_FROM,
  ZOOM_FROM,
  animationAt,
  animationSampleTimes,
  applyOperation,
  assertAnimationsFit,
  backOut,
  parseOperation,
  presetPose,
  resolveFrame,
  summarizeProject,
  type Project,
  type TextClip,
} from '../src';
import { baseProject, clip, run } from './helpers';

const FRAME = { width: 1920, height: 1080 };

function textProject(ops: Parameters<typeof run>[1] = []) {
  const { project, ctx } = baseProject();
  const r = run(project, [{ type: 'add_text', text: 'Hi', start: 0, duration: 4, id: 't' }], ctx);
  return { project: ops.length ? run(r.project, ops, ctx).project : r.project, ctx };
}

const layer = (p: Project, t: number) => resolveFrame(p, t).layers.find((l) => l.clipId === 't');

describe('animation presets', () => {
  it('poses slides from and to the side named by their direction', () => {
    expect(presetPose('slide-left', 0.5, 'in', FRAME)).toEqual({
      dx: 120,
      dy: 0,
      scale: 1,
      opacity: 0.75,
    });
    expect(presetPose('slide-left', 0.5, 'out', FRAME).dx).toBe(-120);
    expect(presetPose('slide-right', 0, 'in', FRAME).dx).toBe(-480);
    expect(presetPose('slide-up', 0, 'in', FRAME).dy).toBe(270);
    expect(presetPose('slide-down', 0, 'in', FRAME).dy).toBe(-270);
    expect(presetPose('slide-down', 0, 'out', FRAME).dy).toBe(270);
    expect(presetPose('slide-up', 1, 'in', FRAME)).toEqual({ ...IDENTITY_ANIMATION, dy: 0 });
  });

  it('scales zoom and pop, and fades every preset', () => {
    expect(presetPose('zoom', 0, 'in', FRAME)).toMatchObject({ scale: ZOOM_FROM, opacity: 0 });
    expect(presetPose('zoom', 0.5, 'out', FRAME).scale).toBeCloseTo(0.875);
    expect(presetPose('pop', 0, 'in', FRAME).scale).toBeCloseTo(POP_FROM);
    expect(presetPose('pop', 1, 'in', FRAME).scale).toBeCloseTo(1);
    expect(presetPose('pop', 0.6, 'in', FRAME).scale).toBeGreaterThan(1.03);
    expect(presetPose('fade', 0.5, 'in', FRAME)).toEqual({ dx: 0, dy: 0, scale: 1, opacity: 0.75 });
    // Progress is clamped.
    expect(presetPose('fade', 2, 'in', FRAME).opacity).toBe(1);
    expect(backOut(0)).toBeCloseTo(0);
    expect(backOut(1)).toBe(1);
  });

  it('evaluates entrance and exit in clip-local time and composes overlaps', () => {
    const c = {
      duration: 4,
      animationIn: { preset: 'slide-left' as const, duration: 1 },
      animationOut: { preset: 'zoom' as const, duration: 2 },
    };
    expect(animationAt(c, 2, FRAME)).toEqual(IDENTITY_ANIMATION);
    expect(animationAt(c, 0.5, FRAME)).toMatchObject({ dx: 120, opacity: 0.75 });
    expect(animationAt(c, 3, FRAME).scale).toBeCloseTo(0.875);
    expect(animationAt(c, -1, FRAME).opacity).toBe(0);
    // Easing: exit starts slowly (easeIn in forward time).
    expect(animationAt(c, 2.2, FRAME).scale).toBeGreaterThan(0.98);
    const overlap = {
      duration: 1,
      animationIn: { preset: 'fade' as const, duration: 1 },
      animationOut: { preset: 'slide-up' as const, duration: 1 },
    };
    const mid = animationAt(overlap, 0.5, FRAME);
    expect(mid.opacity).toBeCloseTo(0.5625);
    expect(mid.dy).toBeCloseTo(-67.5);
    expect(animationAt({ duration: 3 }, 1, FRAME)).toEqual(IDENTITY_ANIMATION);
  });

  it('lists sample times for piecewise renderers', () => {
    expect(animationSampleTimes({ duration: 3 })).toEqual([]);
    expect(
      animationSampleTimes({ duration: 3, animationIn: { preset: 'fade', duration: 1 } }, 4),
    ).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(
      animationSampleTimes(
        {
          duration: 1,
          animationIn: { preset: 'fade', duration: 1 },
          animationOut: { preset: 'fade', duration: 0.5 },
        },
        2,
      ),
    ).toEqual([0, 0.5, 0.75, 1]);
  });

  it('checks that animations fit into the clip', () => {
    const c = { id: 'c', duration: 2 };
    expect(() => assertAnimationsFit(c, { preset: 'fade', duration: 2 }, undefined)).not.toThrow();
    expect(() => assertAnimationsFit(c, { preset: 'fade', duration: 3 }, undefined)).toThrow(
      /A 3s in animation does not fit into clip c \(2s long\)/,
    );
    try {
      assertAnimationsFit(c, undefined, { preset: 'pop', duration: 2.5 });
      expect.unreachable();
    } catch (e) {
      expect((e as CutlineError).message).toMatch(/out animation/);
      expect((e as CutlineError).hint).toMatch(/at most 2s/);
    }
    try {
      assertAnimationsFit(c, { preset: 'fade', duration: 1.5 }, { preset: 'pop', duration: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as CutlineError).code).toBe('OUT_OF_RANGE');
      expect((e as CutlineError).hint).toMatch(/add up to at most 2s, e\.g\. 1s each/);
    }
  });
});

describe('animations in the resolver', () => {
  it('offsets, scales and fades layers on top of base values and keyframes', () => {
    const { project } = textProject([
      {
        type: 'set_clip_props',
        clipId: 't',
        props: {
          transform: { x: 10, scale: 2, opacity: 0.8 },
          keyframes: {
            y: [
              { time: 0, value: 0 },
              { time: 4, value: 40 },
            ],
          },
        },
      },
      {
        type: 'set_animation',
        clipId: 't',
        in: { preset: 'slide-left', duration: 1 },
        out: { preset: 'zoom', duration: 1 },
      },
    ]);
    expect(layer(project, 0.5)!.transform).toMatchObject({ x: 130, y: 5, scale: 2 });
    expect(layer(project, 0.5)!.transform.opacity).toBeCloseTo(0.6);
    expect(layer(project, 2)!.transform).toMatchObject({ x: 10, y: 20, scale: 2, opacity: 0.8 });
    expect(layer(project, 3.5)!.transform.scale).toBeCloseTo(1.75);
    expect(layer(project, 3.5)!.transform.x).toBe(10);
  });
});

describe('animation operations', () => {
  it('sets, replaces and removes animations with set_animation', () => {
    const { project, ctx } = textProject();
    const r = applyOperation(
      project,
      {
        type: 'set_animation',
        clipId: 't',
        in: { preset: 'pop' },
        out: { preset: 'slide-down', duration: 1 },
      },
      ctx,
    );
    expect(r.summary).toBe('Clip t: in pop 0.5s, out slide-down 1s.');
    expect(r.affectedIds).toEqual(['t']);
    expect(clip<TextClip>(r.project, 't')).toMatchObject({
      animationIn: { preset: 'pop', duration: 0.5 },
      animationOut: { preset: 'slide-down', duration: 1 },
    });
    const removed = applyOperation(
      r.project,
      { type: 'set_animation', clipId: 't', in: null },
      ctx,
    );
    expect(removed.summary).toBe('Clip t: removed the in animation.');
    expect(clip<TextClip>(removed.project, 't').animationIn).toBeUndefined();
    expect(clip<TextClip>(removed.project, 't').animationOut).toBeDefined();
  });

  it('validates set_animation', () => {
    const { project, ctx } = textProject([{ type: 'add_clip', assetId: 'asset_a', id: 'aud' }]);
    expect(() => parseOperation({ type: 'set_animation', clipId: 't' })).toThrow(
      /give in and\/or out/,
    );
    expect(() =>
      applyOperation(
        project,
        { type: 'set_animation', clipId: 'aud', in: { preset: 'fade' } },
        ctx,
      ),
    ).toThrow(/only apply to visual clips/);
    // Out must fit next to the existing in animation.
    const withIn = applyOperation(
      project,
      { type: 'set_animation', clipId: 't', in: { preset: 'fade', duration: 3 } },
      ctx,
    ).project;
    expect(() =>
      applyOperation(
        withIn,
        { type: 'set_animation', clipId: 't', out: { preset: 'fade', duration: 2 } },
        ctx,
      ),
    ).toThrow(CutlineError);
  });

  it('sets animations via set_clip_props, where null removes them', () => {
    const { project, ctx } = textProject([{ type: 'add_clip', assetId: 'asset_a', id: 'aud' }]);
    const r = applyOperation(
      project,
      {
        type: 'set_clip_props',
        clipId: 't',
        props: { animationIn: { preset: 'fade' }, animationOut: { preset: 'zoom' } },
      },
      ctx,
    );
    expect(r.summary).toBe('Updated animationIn, animationOut on clip t.');
    const cleared = applyOperation(
      r.project,
      { type: 'set_clip_props', clipId: 't', props: { animationOut: null } },
      ctx,
    ).project;
    expect(clip<TextClip>(cleared, 't').animationIn).toEqual({ preset: 'fade', duration: 0.5 });
    expect(clip<TextClip>(cleared, 't').animationOut).toBeUndefined();
    expect(() =>
      applyOperation(
        project,
        { type: 'set_clip_props', clipId: 'aud', props: { animationIn: { preset: 'fade' } } },
        ctx,
      ),
    ).toThrow(/does not apply to audio/);
    expect(() =>
      applyOperation(
        project,
        {
          type: 'set_clip_props',
          clipId: 't',
          props: { animationIn: { preset: 'fade', duration: 5 } },
        },
        ctx,
      ),
    ).toThrow(/does not fit/);
  });

  it('keeps the entrance on the left and the exit on the right part of a split', () => {
    const { project, ctx } = textProject([
      { type: 'set_animation', clipId: 't', in: { preset: 'fade' }, out: { preset: 'pop' } },
    ]);
    const p = applyOperation(
      project,
      { type: 'split_clip', clipId: 't', time: 2, newClipId: 'r' },
      ctx,
    ).project;
    const left = clip<TextClip>(p, 't');
    const right = clip<TextClip>(p, 'r');
    expect(left.animationIn).toBeDefined();
    expect(left.animationOut).toBeUndefined();
    expect(right.animationIn).toBeUndefined();
    expect(right.animationOut).toBeDefined();
    // Motion follows the new edges at render time.
    expect(layer(p, 1.75)!.transform.opacity).toBe(1);
    expect(layer(p, 0.25)!.transform.opacity).toBeCloseTo(0.75);
  });

  it('drops the entrance when the head of a clip is cut away', () => {
    const { project, ctx } = textProject([
      { type: 'set_animation', clipId: 't', in: { preset: 'fade' }, out: { preset: 'pop' } },
    ]);
    const p = applyOperation(
      project,
      { type: 'delete_range', ranges: [{ start: 0, end: 1 }], ripple: false },
      ctx,
    ).project;
    const rest = p.tracks.flatMap((t) => t.clips)[0] as TextClip;
    expect(rest.start).toBe(1);
    expect(rest.animationIn).toBeUndefined();
    expect(rest.animationOut).toBeDefined();
  });

  it('mentions animations in project summaries', () => {
    const { project } = textProject([
      {
        type: 'set_animation',
        clipId: 't',
        in: { preset: 'slide-up', duration: 0.4 },
        out: { preset: 'fade' },
      },
    ]);
    const s = summarizeProject(project);
    const t = s.tracks.flatMap((tr) => tr.clips).find((c) => c.id === 't')!;
    expect(t.animation).toBe('in slide-up 0.4s, out fade 0.5s');
    const only = summarizeProject(
      textProject([{ type: 'set_animation', clipId: 't', out: { preset: 'zoom' } }]).project,
    );
    expect(only.tracks.flatMap((tr) => tr.clips)[0]!.animation).toBe('out zoom 0.5s');
    const none = summarizeProject(textProject().project);
    expect(none.tracks.flatMap((tr) => tr.clips)[0]!.animation).toBeUndefined();
  });
});
