import { z } from 'zod';
import { CutlineError } from './errors';
import type { OperationInput } from './operations/schemas';
import {
  ColorSchema,
  DurationSchema,
  LogoPositionSchema,
  TimeSchema,
  type ProjectSettings,
} from './schema';

export const TemplateKindSchema = z.enum(['title', 'lower-third', 'banner', 'callout', 'logo']);
export type TemplateKind = z.output<typeof TemplateKindSchema>;

/** Fallbacks when neither the call nor the brand kit sets a color. */
export const DEFAULT_ACCENT_COLOR = '#2563eb';
export const DEFAULT_TEXT_COLOR = '#ffffff';

export const TemplateParamsSchema = z.object({
  template: TemplateKindSchema.describe(
    'title: big centered heading; lower-third: name bar at the bottom left; banner: full-width bar at the top; callout: outlined box with a label; logo: the brand-kit logo in a corner (set it with set_brand_kit first)',
  ),
  text: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Main text (heading, name, banner text, label); required except for logo'),
  subtitle: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Second line (title subtitle, lower-third role)'),
  start: TimeSchema,
  duration: DurationSchema.optional().describe(
    'Seconds (default 4; logo: until the end of the timeline)',
  ),
  accentColor: ColorSchema.optional().describe(
    `Bar / outline color (default: brand-kit primary or accent color, else ${DEFAULT_ACCENT_COLOR})`,
  ),
  textColor: ColorSchema.optional().describe(
    `Text color (default: brand-kit text color, else ${DEFAULT_TEXT_COLOR})`,
  ),
  position: LogoPositionSchema.optional().describe(
    'logo only: corner (default: brand-kit logoPosition, else top-right)',
  ),
});

export type TemplateParams = z.input<typeof TemplateParamsSchema>;

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  title: 'Title',
  'lower-third': 'Lower third',
  banner: 'Banner',
  callout: 'Callout',
  logo: 'Logo',
};

/** Colors a template uses, resolved from the call, then the brand kit, then defaults. */
export function templateColors(
  template: TemplateKind,
  settings: Pick<ProjectSettings, 'brand'>,
  overrides: { accentColor?: string | undefined; textColor?: string | undefined } = {},
): { accent: string; text: string } {
  const c = settings.brand?.colors;
  // Bars use the primary color; lines and outlines prefer the accent color.
  const brandAccent =
    template === 'title' || template === 'callout'
      ? (c?.accent ?? c?.primary)
      : (c?.primary ?? c?.accent);
  return {
    accent: overrides.accentColor ?? brandAccent ?? DEFAULT_ACCENT_COLOR,
    text: overrides.textColor ?? c?.text ?? DEFAULT_TEXT_COLOR,
  };
}

const r = Math.round;

/**
 * Expands a template into ordinary operations (shapes first, then text, so the
 * overlay stacking puts text on top). Positions scale with the project size;
 * colors and fonts default to the project's brand kit.
 */
export function templateOperations(
  input: TemplateParams,
  settings: ProjectSettings,
): OperationInput[] {
  const p = TemplateParamsSchema.parse(input);
  if (p.template === 'logo') {
    return [{ type: 'add_logo', start: p.start, duration: p.duration, position: p.position }];
  }
  if (!p.text) {
    throw new CutlineError('INVALID_ARGUMENT', `The ${p.template} template needs text.`, {
      hint: 'Pass text (the heading, name, banner text or label).',
    });
  }
  const { width: W, height: H } = settings;
  const timing = { start: p.start, duration: p.duration ?? 4 };
  const { accent, text: textColor } = templateColors(p.template, settings, p);
  const brand = settings.brand;
  const headingFont = brand?.headingFontFamily ?? brand?.fontFamily;
  const heading = headingFont ? { fontFamily: headingFont } : {};
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
        fill: accent,
        transform: { y: headingY + r(size * 0.75) },
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.text,
        style: { ...heading, fontSize: size, color: textColor, bold: true },
        transform: { y: headingY },
      });
      if (p.subtitle) {
        ops.push({
          type: 'add_text',
          ...timing,
          text: p.subtitle,
          style: { fontSize: r(H * 0.04), color: textColor, bold: false },
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
        fill: `${accent.slice(0, 7)}e6`,
        cornerRadius: r(H * 0.01),
        transform: { x, y },
      });
      const maxWidth = Math.min(1, (barW * 0.92) / W);
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.text,
        style: { ...heading, fontSize: r(H * 0.045), color: textColor, bold: true, maxWidth },
        transform: { x, y: p.subtitle ? y - r(H * 0.025) : y },
      });
      if (p.subtitle) {
        ops.push({
          type: 'add_text',
          ...timing,
          text: p.subtitle,
          style: { fontSize: r(H * 0.03), color: textColor, bold: false, maxWidth },
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
        fill: accent,
        transform: { y },
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.subtitle ? `${p.text} · ${p.subtitle}` : p.text,
        style: { ...heading, fontSize: r(H * 0.05), color: textColor, bold: true, maxWidth: 0.95 },
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
        strokeColor: accent,
        strokeWidth: Math.max(2, r(H * 0.008)),
        cornerRadius: r(H * 0.02),
      });
      ops.push({
        type: 'add_text',
        ...timing,
        text: p.subtitle ? `${p.text}\n${p.subtitle}` : p.text,
        style: {
          fontSize: r(H * 0.035),
          color: textColor,
          bold: true,
          backgroundColor: accent,
          maxWidth: Math.min(1, (boxW * 1.4) / W),
        },
        transform: { y: -r(boxH / 2) - r(H * 0.05) },
      });
      break;
    }
  }
  return ops;
}
