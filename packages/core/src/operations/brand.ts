import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { findAsset, findTrack, projectDuration } from '../queries';
import {
  BRAND_COLOR_KEYS,
  BrandSchema,
  ImageClipSchema,
  type Asset,
  type Brand,
  type LogoPosition,
  type Project,
  type Track,
} from '../schema';
import { formatRange, roundTime } from '../time';
import { createTrack } from './clips';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';
import { assertAccepts, assertEditable, emptyLog, placeClip } from './track-edit';

export const DEFAULT_LOGO_POSITION: LogoPosition = 'top-right';

function assertLogoAsset(project: Project, assetId: string): Asset {
  const asset = findAsset(project, assetId);
  if (asset.kind !== 'image') {
    const images = project.assets.filter((a) => a.kind === 'image');
    throw new CutlineError(
      'INVALID_ARGUMENT',
      `Asset "${asset.name}" (${asset.id}) is a ${asset.kind}; a logo must be an image.`,
      {
        hint: images.length
          ? `Image assets: ${images.map((a) => `${a.id} (${a.name})`).join(', ')}.`
          : 'Import a PNG/JPEG/SVG logo with add_asset first.',
      },
    );
  }
  return asset;
}

/** Partial merge of a brand kit; null clears a field, an empty kit is removed. */
export function setBrand(draft: Project, op: OpOf<'set_brand'>): OpOutcome {
  if (op.logoAssetId) assertLogoAsset(draft, op.logoAssetId);
  const brand: Brand = op.reset || !draft.settings.brand ? { colors: {} } : draft.settings.brand;
  const changes: string[] = op.reset ? ['reset'] : [];
  for (const key of BRAND_COLOR_KEYS) {
    const value = op.colors?.[key];
    if (value === undefined) continue;
    if (value === null) delete brand.colors[key];
    else brand.colors[key] = value;
    changes.push(`${key} ${value ?? 'cleared'}`);
  }
  for (const key of ['fontFamily', 'headingFontFamily', 'logoAssetId', 'logoPosition'] as const) {
    const value = op[key];
    if (value === undefined) continue;
    if (value === null) delete brand[key];
    else (brand as Record<typeof key, string>)[key] = value;
    changes.push(`${key} ${value ?? 'cleared'}`);
  }
  const empty =
    Object.keys(brand.colors).length === 0 &&
    Object.entries(brand).every(([k, v]) => k === 'colors' || v === undefined);
  if (empty) delete draft.settings.brand;
  else draft.settings.brand = BrandSchema.parse(brand);
  return outcome(`Brand kit ${changes.join(', ') || 'unchanged'}.`, {}, [draft.id]);
}

/** The highest unlocked video track that holds only this logo, else a new "Logo" track. */
function logoTrack(
  draft: Project,
  trackId: string | undefined,
  assetId: string,
  ctx: OpContext,
  created: string[],
): Track {
  if (trackId) {
    const track = findTrack(draft, trackId);
    assertAccepts(track, 'image');
    assertEditable(track);
    return track;
  }
  const existing = draft.tracks.findLast(
    (t) =>
      t.kind === 'video' &&
      !t.locked &&
      t.clips.length > 0 &&
      t.clips.every((c) => c.type === 'image' && c.assetId === assetId),
  );
  if (existing) return existing;
  const track = createTrack(draft, 'video', ctx);
  track.name = 'Logo';
  created.push(track.id);
  return track;
}

/** Places the brand logo (or another image) in a corner, sized relative to the canvas. */
export function addLogo(draft: Project, op: OpOf<'add_logo'>, ctx: OpContext): OpOutcome {
  const brand = draft.settings.brand;
  const assetId = op.assetId ?? brand?.logoAssetId;
  if (!assetId) {
    throw new CutlineError('INVALID_ARGUMENT', 'The project has no brand logo.', {
      hint: 'Set one with set_brand { logoAssetId } (MCP: set_brand_kit), or pass assetId.',
    });
  }
  const asset = assertLogoAsset(draft, assetId);
  const { width: W, height: H } = draft.settings;
  const start = roundTime(op.start);
  const duration = roundTime(op.duration ?? Math.max(5, projectDuration(draft) - start));
  const position = op.position ?? brand?.logoPosition ?? DEFAULT_LOGO_POSITION;

  // Image clips fit inside the canvas at scale 1 (contain); size the logo by height,
  // but never wider than half the canvas.
  const aw = asset.width ?? H;
  const ah = asset.height ?? H;
  const fit = Math.min(W / aw, H / ah);
  const scale = Math.min((op.size * H) / (ah * fit), (W * 0.5) / (aw * fit));
  const w = aw * fit * scale;
  const h = ah * fit * scale;
  const margin = op.margin * H;
  const sx = position.endsWith('left') ? -1 : 1;
  const sy = position.startsWith('top') ? -1 : 1;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const transform = {
    x: r2(sx * (W / 2 - margin - w / 2)),
    y: r2(sy * (H / 2 - margin - h / 2)),
    scale: Math.round(scale * 10000) / 10000,
    opacity: op.opacity,
  };

  const created: string[] = [];
  const track = logoTrack(draft, op.trackId, asset.id, ctx, created);
  const id = op.id ?? ctx.newId('clip');
  const clip = ImageClipSchema.parse({
    type: 'image',
    id,
    start,
    duration,
    assetId: asset.id,
    name: 'Logo',
    transform,
  });
  const log = emptyLog();
  log.created.push(id, ...created);
  placeClip(track, clip, op.mode, ctx, log);
  return outcome(
    `Added logo "${asset.name}" (${id}) ${position} at ${formatRange(start, start + duration)} on track ${track.name}.`,
    log,
  );
}
