import { existsSync } from 'node:fs';

type Variant = 'regular' | 'bold' | 'italic' | 'boldItalic';

const CANDIDATES: Record<Variant, string[]> = {
  regular: [
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
  ],
  bold: [
    'C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
  ],
  italic: [
    'C:/Windows/Fonts/ariali.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    '/System/Library/Fonts/Supplemental/Arial Italic.ttf',
  ],
  boldItalic: [
    'C:/Windows/Fonts/arialbi.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
  ],
};

const cache = new Map<Variant, string | undefined>();

/**
 * A concrete font file for drawtext. Explicit files avoid depending on a
 * working fontconfig setup (which many Windows ffmpeg builds lack).
 * Override with CUTLINE_FONT_FILE (used for every variant).
 */
export function resolveFontFile(bold: boolean, italic: boolean): string | undefined {
  if (process.env.CUTLINE_FONT_FILE) return process.env.CUTLINE_FONT_FILE;
  const variant: Variant =
    bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  if (!cache.has(variant)) {
    const found = CANDIDATES[variant].find((p) => existsSync(p));
    cache.set(
      variant,
      found ?? (variant === 'regular' ? undefined : resolveFontFile(false, false)),
    );
  }
  return cache.get(variant);
}
