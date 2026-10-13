import { describe, expect, it } from 'vitest';
import {
  CutlineError,
  applyOperation,
  applyOperations,
  findProblems,
  resolveFrame,
  summarizeProject,
  templateColors,
  templateOperations,
  type ImageClip,
  type Project,
  type ShapeClip,
  type TextClip,
} from '../src';
import { baseProject, clip, imageAsset, run } from './helpers';

function errorOf(fn: () => unknown): CutlineError {
  try {
    fn();
  } catch (err) {
    return err as CutlineError;
  }
  throw new Error('expected an error');
}

function branded(): { project: Project; ctx: ReturnType<typeof baseProject>['ctx'] } {
  const { project, ctx } = baseProject();
  const p = applyOperation(
    project,
    {
      type: 'set_brand',
      colors: { primary: '#112233', accent: '#ff8800', text: '#fafafa' },
      fontFamily: 'Georgia, serif',
      headingFontFamily: 'Impact',
      logoAssetId: 'asset_i',
      logoPosition: 'bottom-left',
    },
    ctx,
  ).project;
  return { project: p, ctx };
}

describe('set_brand', () => {
  it('merges partial updates, clears with null and removes an empty kit', () => {
    const { project, ctx } = baseProject();
    const r1 = applyOperation(
      project,
      { type: 'set_brand', colors: { primary: '#112233' }, fontFamily: 'Georgia' },
      ctx,
    );
    expect(r1.project.settings.brand).toEqual({
      colors: { primary: '#112233' },
      fontFamily: 'Georgia',
    });
    expect(r1.summary).toBe('Brand kit primary #112233, fontFamily Georgia.');
    expect(r1.affectedIds).toEqual([project.id]);

    const r2 = applyOperation(
      r1.project,
      { type: 'set_brand', colors: { accent: '#ff0000', primary: null }, logoAssetId: 'asset_i' },
      ctx,
    );
    expect(r2.project.settings.brand).toEqual({
      colors: { accent: '#ff0000' },
      fontFamily: 'Georgia',
      logoAssetId: 'asset_i',
    });
    expect(r2.summary).toMatch(/primary cleared/);

    const r3 = applyOperation(
      r2.project,
      { type: 'set_brand', colors: { accent: null }, fontFamily: null, logoAssetId: null },
      ctx,
    );
    expect(r3.project.settings.brand).toBeUndefined();

    const noop = applyOperation(project, { type: 'set_brand' }, ctx);
    expect(noop.summary).toBe('Brand kit unchanged.');
    expect(noop.project.settings.brand).toBeUndefined();
  });

  it('resets the whole kit', () => {
    const { project, ctx } = branded();
    const r = applyOperation(project, { type: 'set_brand', reset: true, fontFamily: 'Arial' }, ctx);
    expect(r.project.settings.brand).toEqual({ colors: {}, fontFamily: 'Arial' });
    expect(r.summary).toBe('Brand kit reset, fontFamily Arial.');
    // A bare reset removes the kit entirely.
    expect(
      applyOperations(r.project, [{ type: 'set_brand', reset: true }], ctx).project.settings,
    ).not.toHaveProperty('brand');
  });

  it('rejects logos that are missing or not images, with hints', () => {
    const { project, ctx } = baseProject();
    const missing = errorOf(() =>
      applyOperation(project, { type: 'set_brand', logoAssetId: 'asset_nope' }, ctx),
    );
    expect(missing.code).toBe('NOT_FOUND');
    const video = errorOf(() =>
      applyOperation(project, { type: 'set_brand', logoAssetId: 'asset_v' }, ctx),
    );
    expect(video.code).toBe('INVALID_ARGUMENT');
    expect(video.message).toMatch(/is a video; a logo must be an image/);
    expect(video.hint).toMatch(/Image assets: asset_i \(logo\.png\)/);
    const noImages = applyOperation(
      project,
      { type: 'remove_asset', assetId: 'asset_i' },
      ctx,
    ).project;
    const none = errorOf(() =>
      applyOperation(noImages, { type: 'set_brand', logoAssetId: 'asset_v' }, ctx),
    );
    expect(none.hint).toMatch(/Import a PNG/);
    expect(() =>
      applyOperation(project, { type: 'set_brand', colors: { primary: 'red' } }, ctx),
    ).toThrow(/Invalid operation set_brand/);
  });

  it('keeps the logo reference valid when the asset is removed', () => {
    const { project, ctx } = branded();
    const r = applyOperation(project, { type: 'remove_asset', assetId: 'asset_i' }, ctx);
    expect(r.summary).toMatch(/and cleared the brand logo/);
    expect(r.project.settings.brand?.logoAssetId).toBeUndefined();
    const other = applyOperation(project, { type: 'remove_asset', assetId: 'asset_a' }, ctx);
    expect(other.project.settings.brand?.logoAssetId).toBe('asset_i');
    // update_project cannot sneak in an invalid logo either.
    expect(() =>
      applyOperation(
        project,
        { type: 'update_project', settings: { brand: { colors: {}, logoAssetId: 'asset_v' } } },
        ctx,
      ),
    ).toThrow(/brand: logo asset_v is not an image asset/);
    expect(
      findProblems({
        ...project,
        settings: { ...project.settings, brand: { colors: {}, logoAssetId: 'asset_gone' } },
      }),
    ).toEqual(['brand: logo asset_gone is not an image asset of this project']);
  });
});

describe('brand defaults for new overlays', () => {
  it('applies brand fonts and colors unless the call sets them', () => {
    const { project, ctx } = branded();
    const p = run(
      project,
      [
        { type: 'add_text', text: 'Branded', start: 0, id: 't1' },
        {
          type: 'add_text',
          text: 'Explicit',
          start: 0,
          id: 't2',
          style: { color: '#000000', fontFamily: 'monospace' },
        },
        { type: 'add_shape', start: 0, id: 's1', strokeWidth: 2 },
        { type: 'add_shape', start: 0, id: 's2', fill: null, strokeColor: '#00ff00' },
        { type: 'add_shape', start: 0, id: 's3', fill: '#abcdef' },
      ],
      ctx,
    ).project;
    expect(clip<TextClip>(p, 't1').style).toMatchObject({
      fontFamily: 'Georgia, serif',
      color: '#fafafa',
    });
    expect(clip<TextClip>(p, 't2').style).toMatchObject({
      fontFamily: 'monospace',
      color: '#000000',
    });
    expect(clip<ShapeClip>(p, 's1')).toMatchObject({ fill: '#112233', strokeColor: '#ff8800' });
    expect(clip<ShapeClip>(p, 's2')).toMatchObject({ fill: null, strokeColor: '#00ff00' });
    expect(clip<ShapeClip>(p, 's3').fill).toBe('#abcdef');
  });

  it('keeps the old defaults without a brand kit', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_text', text: 'Plain', start: 0, id: 't1' },
        { type: 'add_shape', start: 0, id: 's1' },
      ],
      ctx,
    ).project;
    expect(clip<TextClip>(p, 't1').style).toMatchObject({
      fontFamily: 'sans-serif',
      color: '#ffffff',
    });
    expect(clip<ShapeClip>(p, 's1')).toMatchObject({ fill: '#ffffff', strokeColor: '#000000' });
  });

  it('brands templates: colors, heading font and body font', () => {
    const { project, ctx } = branded();
    const ops = templateOperations(
      { template: 'lower-third', text: 'Ada', subtitle: 'Mathematician', start: 0 },
      project.settings,
    );
    expect(ops[0]).toMatchObject({ type: 'add_shape', fill: '#112233e6' });
    expect(ops[1]).toMatchObject({ style: { fontFamily: 'Impact', color: '#fafafa' } });
    const p = applyOperations(project, ops, ctx).project;
    const texts = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'text');
    expect(texts.map((t) => t.style.fontFamily)).toEqual(['Impact', 'Georgia, serif']);

    const title = templateOperations({ template: 'title', text: 'Hi', start: 0 }, project.settings);
    expect(title[0]).toMatchObject({ fill: '#ff8800' });
    const callout = templateOperations(
      { template: 'callout', text: 'Look', start: 0, accentColor: '#000000', textColor: '#111111' },
      project.settings,
    );
    expect(callout[0]).toMatchObject({ strokeColor: '#000000' });
    expect(callout[1]).toMatchObject({ style: { color: '#111111' } });
  });

  it('resolves template colors from the call, the brand kit, then defaults', () => {
    expect(templateColors('banner', {})).toEqual({ accent: '#2563eb', text: '#ffffff' });
    const onlyAccent = { brand: { colors: { accent: '#ff0000' } } };
    expect(templateColors('banner', onlyAccent).accent).toBe('#ff0000');
    const onlyPrimary = { brand: { colors: { primary: '#00ff00' } } };
    expect(templateColors('title', onlyPrimary).accent).toBe('#00ff00');
    expect(templateColors('title', onlyPrimary, { accentColor: '#0000ff' }).accent).toBe('#0000ff');
    // A heading font falls back to the body font.
    const ops = templateOperations(
      { template: 'banner', text: 'x', start: 0 },
      {
        width: 1920,
        height: 1080,
        fps: 30,
        backgroundColor: '#000000',
        sampleRate: 48000,
        brand: { colors: {}, fontFamily: 'Verdana' },
      },
    );
    expect(ops[1]).toMatchObject({ style: { fontFamily: 'Verdana' } });
  });

  it('needs text for every template except logo', () => {
    const { project } = baseProject();
    const err = errorOf(() =>
      templateOperations({ template: 'banner', start: 0 }, project.settings),
    );
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.hint).toMatch(/Pass text/);
  });
});

describe('add_logo', () => {
  it('places the brand logo in its corner for the whole timeline', () => {
    const { project, ctx } = branded();
    const withVideo = run(
      project,
      [{ type: 'add_clip', assetId: 'asset_v', duration: 12 }],
      ctx,
    ).project;
    const ops = templateOperations({ template: 'logo', start: 0 }, withVideo.settings);
    expect(ops).toEqual([{ type: 'add_logo', start: 0, duration: undefined, position: undefined }]);
    const r = applyOperations(withVideo, ops, ctx);
    const logo = clip<ImageClip>(r.project, r.createdIds[0]!);
    expect(logo).toMatchObject({ type: 'image', assetId: 'asset_i', start: 0, duration: 12 });
    // 1920x1080 logo, 12% of 1080 tall = 129.6 px, 4% margin = 43.2 px; bottom-left corner.
    expect(logo.transform).toEqual({
      x: -801.6,
      y: 432,
      scale: 0.12,
      rotation: 0,
      opacity: 1,
    });
    const track = r.project.tracks.find((t) => t.clips.includes(logo))!;
    expect(track.name).toBe('Logo');
    expect(r.project.tracks.at(-1)).toBe(track);
    expect(r.summary).toMatch(/Added logo "logo\.png" \(clip_\w+\) bottom-left/);
    const frame = resolveFrame(r.project, 1);
    expect(frame.layers.map((l) => l.type)).toEqual(['video', 'image']);

    // A second logo reuses the logo track; explicit options win.
    const r2 = applyOperation(
      r.project,
      {
        type: 'add_logo',
        start: 13,
        duration: 2,
        position: 'top-right',
        size: 0.2,
        margin: 0,
        opacity: 0.5,
        id: 'logo2',
      },
      ctx,
    );
    const logo2 = clip<ImageClip>(r2.project, 'logo2');
    expect(r2.project.tracks.find((t) => t.clips.includes(logo2))).toEqual(
      expect.objectContaining({ id: track.id }),
    );
    expect(logo2.transform).toMatchObject({ x: 960 - 192, y: -(540 - 108), opacity: 0.5 });
    expect(r2.createdIds).toEqual(['logo2']);
  });

  it('uses defaults without a brand kit and caps wide logos at half the width', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_asset',
          asset: imageAsset({ id: 'wide', name: 'wide.png', width: 2000, height: 100 }),
        },
        {
          type: 'add_asset',
          asset: imageAsset({ id: 'nosize', name: 'nosize.svg', width: null, height: null }),
        },
      ],
      ctx,
    ).project;
    const r = applyOperation(p, { type: 'add_logo', assetId: 'wide', id: 'w' }, ctx);
    const wide = clip<ImageClip>(r.project, 'w');
    // Empty timeline: 5 s; top-right default; width capped to 960 px.
    expect(wide).toMatchObject({ start: 0, duration: 5 });
    expect(wide.transform.x).toBeCloseTo(960 - 43.2 - 480);
    expect(wide.transform.y).toBeCloseTo(-(540 - 43.2 - 24));
    const r2 = applyOperation(
      p,
      { type: 'add_logo', assetId: 'nosize', id: 'n', position: 'top-left' },
      ctx,
    );
    expect(clip<ImageClip>(r2.project, 'n').transform.x).toBeCloseTo(-(960 - 43.2 - 64.8));
  });

  it('honours an explicit track and explains missing logos', () => {
    const { project, ctx } = branded();
    const r = applyOperation(project, { type: 'add_logo', trackId: 'track_1', id: 'l' }, ctx);
    expect(r.project.tracks[0]!.clips.map((c) => c.id)).toEqual(['l']);
    expect(() => applyOperation(project, { type: 'add_logo', trackId: 'track_2' }, ctx)).toThrow(
      CutlineError,
    );

    const plain = baseProject();
    const err = errorOf(() => applyOperation(plain.project, { type: 'add_logo' }, plain.ctx));
    expect(err.message).toBe('The project has no brand logo.');
    expect(err.hint).toMatch(/set_brand_kit/);
    expect(() =>
      applyOperation(plain.project, { type: 'add_logo', assetId: 'asset_a' }, plain.ctx),
    ).toThrow(/a logo must be an image/);
  });
});

describe('brand in summaries', () => {
  it('describes the brand kit compactly', () => {
    const { project } = branded();
    expect(summarizeProject(project).brand).toEqual({
      colors: { primary: '#112233', accent: '#ff8800', text: '#fafafa' },
      fontFamily: 'Georgia, serif',
      headingFontFamily: 'Impact',
      logo: 'asset_i (logo.png)',
      logoPosition: 'bottom-left',
    });
    const minimal = summarizeProject({
      ...project,
      settings: { ...project.settings, brand: { colors: {}, logoAssetId: 'asset_x' } },
    });
    expect(minimal.brand).toEqual({ colors: {}, logo: 'asset_x (?)' });
    expect(summarizeProject(baseProject().project)).not.toHaveProperty('brand');
  });
});
