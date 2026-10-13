import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_LABELS,
  applyOperations,
  resolveFrame,
  templateOperations,
  type TemplateKind,
} from '../src';
import { baseProject, run } from './helpers';

const KINDS = Object.keys(TEMPLATE_LABELS) as TemplateKind[];

describe('templates', () => {
  it.each(KINDS)('%s expands into shapes and text that apply cleanly', (template) => {
    const { project, ctx } = baseProject();
    for (const subtitle of [undefined, 'Second line']) {
      const ops = templateOperations(
        { template, text: 'Hello', subtitle, start: 1 },
        project.settings,
      );
      expect(ops.length).toBeGreaterThanOrEqual(2);
      expect(ops[0]!.type).toBe('add_shape');
      const result = applyOperations(project, ops, ctx);
      const frame = resolveFrame(result.project, 2);
      // Shapes first, text on top of them.
      const types = frame.layers.map((l) => l.type);
      expect(types[0]).toBe('shape');
      expect(types.at(-1)).toBe('text');
      expect(frame.layers.some((l) => l.text?.includes('Hello'))).toBe(true);
    }
  });

  it('stacks template text above an existing overlay at the same time', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', duration: 10 },
        { type: 'add_text', text: 'Earlier', start: 8, duration: 1 },
      ],
      ctx,
    ).project;
    const ops = templateOperations(
      { template: 'lower-third', text: 'Ada', start: 0, accentColor: '#ff0000' },
      p.settings,
    );
    const frame = resolveFrame(applyOperations(p, ops, ctx).project, 1);
    expect(frame.layers.map((l) => l.type)).toEqual(['video', 'shape', 'text']);
    expect(frame.layers[1]!.shape?.fill).toBe('#ff0000e6');
  });

  it('scales with the project size and rejects bad input', () => {
    const { project } = baseProject();
    const small = templateOperations(
      { template: 'banner', text: 'x', start: 0 },
      { ...project.settings, width: 640, height: 360 },
    );
    expect(small[0]).toMatchObject({ type: 'add_shape', width: 640, height: 36 });
    expect(() =>
      templateOperations({ template: 'title', text: '', start: 0 }, project.settings),
    ).toThrow();
  });
});
