import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  applyOperation,
  isVisualClip,
  resolveFrame,
  summarizeProject,
  type ShapeClip,
} from '../src';
import { baseProject, clip, run } from './helpers';

describe('shapes', () => {
  it('adds rectangles and ellipses on overlay tracks with defaults', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 4 },
        { type: 'add_shape', start: 0, id: 'rect' },
        {
          type: 'add_shape',
          shape: 'ellipse',
          start: 1,
          duration: 2,
          width: 100,
          height: 50,
          fill: null,
          strokeWidth: 4,
          strokeColor: '#ff0000',
          id: 'ring',
        },
        { type: 'add_text', text: 'Above', start: 0, id: 'txt' },
      ],
      ctx,
    ).project;
    const rect = clip<ShapeClip>(p, 'rect');
    expect(rect).toMatchObject({
      shape: 'rectangle',
      width: 400,
      height: 200,
      fill: '#ffffff',
      strokeWidth: 0,
      cornerRadius: 0,
      duration: 3,
    });
    expect(isVisualClip(rect)).toBe(true);
    // Overlapping overlays stack on new tracks above the video, text on top.
    expect(p.tracks.map((t) => t.clips.map((c) => c.id))).toEqual([
      ['clip_1'],
      [],
      ['rect'],
      ['ring'],
      ['txt'],
    ]);
  });

  it('reports its creation and describes shapes in summaries', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'add_shape', start: 1, width: 300, height: 80, cornerRadius: 12, strokeWidth: 2 },
      ctx,
    );
    expect(r.summary).toMatch(/Added rectangle 300×80 \(clip_1\) at 1s–4s on track V1/);
    const s = summarizeProject(r.project);
    expect(s.tracks[0]!.clips[0]!.shape).toBe('rectangle 300x80 fill #ffffff stroke 2px #000000');
    const outline = applyOperation(project, { type: 'add_shape', start: 0, fill: null }, ctx);
    expect(summarizeProject(outline.project).tracks[0]!.clips[0]!.shape).toBe(
      'rectangle 400x200 fill none',
    );
  });

  it('places shapes on an explicit track and validates it', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(project, { type: 'add_shape', start: 0, trackId: 'track_1' }, ctx);
    expect(r.project.tracks[0]!.clips[0]!.type).toBe('shape');
    expect(() =>
      applyOperation(project, { type: 'add_shape', start: 0, trackId: 'track_2' }, ctx),
    ).toThrow(CutlineError);
  });

  it('edits shape properties and rejects them on other clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_shape', start: 0, id: 's' },
        { type: 'add_text', text: 'x', start: 5, id: 't' },
      ],
      ctx,
    ).project;
    const r = applyOperation(
      p,
      {
        type: 'set_clip_props',
        clipId: 's',
        props: {
          shape: 'ellipse',
          width: 10,
          height: 20,
          fill: null,
          strokeColor: '#00ff00',
          strokeWidth: 3,
          cornerRadius: 4,
          transform: { x: 5 },
          keyframes: { opacity: [{ time: 0, value: 0 }] },
        },
      },
      ctx,
    );
    expect(clip<ShapeClip>(r.project, 's')).toMatchObject({
      shape: 'ellipse',
      width: 10,
      height: 20,
      fill: null,
      strokeColor: '#00ff00',
      strokeWidth: 3,
      cornerRadius: 4,
      transform: { x: 5 },
    });
    expect(() =>
      applyOperation(p, { type: 'set_clip_props', clipId: 't', props: { width: 3 } }, ctx),
    ).toThrow(/does not apply to text/);
  });

  it('resolves shape layers with geometry', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_shape',
          start: 0,
          shape: 'ellipse',
          width: 50,
          height: 60,
          id: 's',
          transform: { opacity: 0.5 },
        },
      ],
      ctx,
    ).project;
    const layer = resolveFrame(p, 1).layers[0]!;
    expect(layer).toMatchObject({
      type: 'shape',
      transform: { opacity: 0.5 },
      shape: {
        kind: 'ellipse',
        width: 50,
        height: 60,
        fill: '#ffffff',
        strokeColor: '#000000',
        strokeWidth: 0,
        cornerRadius: 0,
      },
    });
    expect(layer.assetId).toBeUndefined();
  });
});
