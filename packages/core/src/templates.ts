import { z } from 'zod';
import type { OperationInput } from './operations/schemas';
import { ColorSchema, DurationSchema, TimeSchema, type ProjectSettings } from './schema';

export const TemplateKindSchema = z.enum(['title', 'lower-third', 'banner', 'callout']);
export type TemplateKind = z.output<typeof TemplateKindSchema>;

export const TemplateParamsSchema = z.object({
  template: TemplateKindSchema.describe(
    'title: big centered heading; lower-third: name bar at the bottom left; banner: full-width bar at the top; callout: outlined box with a label',
  ),
  text: z.string().min(1).max(500).describe('Main text (heading, name, banner text, label)'),
  subtitle: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Second line (title subtitle, lower-third role)'),
  start: TimeSchema,
  duration: DurationSchema.default(4),
  accentColor: ColorSchema.default('#2563eb').describe('Bar / outline color'),
  textColor: ColorSchema.default('#ffffff'),
});

export type TemplateParams = z.input<typeof TemplateParamsSchema>;

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  title: 'Title',
  'lower-third': 'Lower third',
  banner: 'Banner',
  callout: 'Callout',
};

const r = Math.round;

/**
 * Expands a template into ordinary operations (shapes first, then text, so the
 * overlay stacking puts text on top). Positions scale with the project size.
 */
export function templateOperations(
  input: TemplateParams,
  settings: ProjectSettings,
): OperationInput[] {
  const p = TemplateParamsSchema.parse(input);
  const { width: W, height: H } = settings;
  const timing = { start: p.start, duration: p.duration };
  const ops: OperationInput[] = [];

  switch (p.template) {
    case 'title': {
      const size = r(H * 0.09);
      const headingY = p.subtitle ? -r(H * 0.05) : 0;
      ops.push({
        type: 'add_shape',
        ...timing,
        width: r(W * 0.08),
        height: Math.max(2, r(H * 0.006)),
        fill: p.accentColor,
        transform: { y: headingY + r(size * 0.75) },
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.text,
        style: { fontSize: size, color: p.textColor, bold: true },
        transform: { y: headingY },
      });
      if (p.subtitle) {
        ops.push({
          type: 'add_text',
          ...timing,
          text: p.subtitle,
          style: { fontSize: r(H * 0.04), color: p.textColor, bold: false },
          transform: { y: headingY + r(size * 1.35) },
        });
      }
      break;
    }
    case 'lower-third': {
      const barW = r(W * 0.42);
      const barH = r(H * (p.subtitle ? 0.14 : 0.09));
      const x = -r(W / 2) + r(W * 0.05) + r(barW / 2);
      const y = r(H / 2) - r(H * 0.1) - r(barH / 2);
      ops.push({
        type: 'add_shape',
        ...timing,
        width: barW,
        height: barH,
        fill: `${p.accentColor.slice(0, 7)}e6`,
        cornerRadius: r(H * 0.01),
        transform: { x, y },
      });
      const maxWidth = Math.min(1, (barW * 0.92) / W);
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.text,
        style: { fontSize: r(H * 0.045), color: p.textColor, bold: true, maxWidth },
        transform: { x, y: p.subtitle ? y - r(H * 0.025) : y },
      });
      if (p.subtitle) {
        ops.push({
          type: 'add_text',
          ...timing,
          text: p.subtitle,
          style: { fontSize: r(H * 0.03), color: p.textColor, bold: false, maxWidth },
          transform: { x, y: y + r(H * 0.035) },
        });
      }
      break;
    }
    case 'banner': {
      const barH = r(H * 0.1);
      const y = -r(H / 2) + r(barH / 2);
      ops.push({
        type: 'add_shape',
        ...timing,
        width: W,
        height: barH,
        fill: p.accentColor,
        transform: { y },
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.subtitle ? `${p.text} · ${p.subtitle}` : p.text,
        style: { fontSize: r(H * 0.05), color: p.textColor, bold: true, maxWidth: 0.95 },
        transform: { y },
      });
      break;
    }
    case 'callout': {
      const boxW = r(W * 0.3);
      const boxH = r(H * 0.3);
      ops.push({
        type: 'add_shape',
        ...timing,
        width: boxW,
        height: boxH,
        fill: null,
        strokeColor: p.accentColor,
        strokeWidth: Math.max(2, r(H * 0.008)),
        cornerRadius: r(H * 0.02),
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.subtitle ? `${p.text}\n${p.subtitle}` : p.text,
        style: {
          fontSize: r(H * 0.035),
          color: p.textColor,
          bold: true,
          backgroundColor: p.accentColor,
          maxWidth: Math.min(1, (boxW * 1.4) / W),
        },
        transform: { y: -r(boxH / 2) - r(H * 0.05) },
      });
      break;
    }
  }
  return ops;
}
