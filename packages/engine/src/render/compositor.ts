import {
  Application,
  BlurFilter,
  CanvasTextMetrics,
  ColorMatrixFilter,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
  type Filter,
} from 'pixi.js';
import type {
  CaptionStyle,
  FrameDescription,
  TextStyle as CutlineTextStyle,
  VisualLayer,
} from '@cutline/core';
import { captionTokens, layoutWords } from './caption-layout';
import { colorMatrix, hasColorEffects } from './color';
import { captionCenterY, parseColor, placeMedia, placeText } from './layout';

/** Decoded pixels for the visual layers of one frame. */
export interface FrameSources {
  /** Video frame per clip id. */
  video: Map<string, CanvasImageSource & { width: number; height: number }>;
  /** Still image per asset id. */
  images: Map<string, ImageBitmap>;
}

interface Node {
  container: Container;
  sprite?: Sprite;
  text?: Text;
  background?: Graphics;
  key?: string;
  colorFilter?: ColorMatrixFilter;
  blurFilter?: BlurFilter;
}

const PAD = 0.35; // caption/text background padding in em

/**
 * WebGL compositor (PixiJS). Draws a FrameDescription from the core resolver.
 * Works with an HTMLCanvasElement or, inside a worker, an OffscreenCanvas.
 */
export class Compositor {
  private readonly nodes = new Map<string, Node>();
  private readonly textures = new WeakMap<object, Texture>();

  private constructor(
    private readonly app: Application,
    private projectWidth: number,
    private projectHeight: number,
  ) {}

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    projectWidth: number,
    projectHeight: number,
  ): Promise<Compositor> {
    const app = new Application();
    await app.init({
      canvas: canvas as HTMLCanvasElement,
      width: canvas.width,
      height: canvas.height,
      preference: 'webgl',
      antialias: true,
      autoStart: false,
      autoDensity: false,
      resolution: 1,
      background: '#000000',
      preserveDrawingBuffer: true,
    });
    app.ticker?.stop();
    return new Compositor(app, projectWidth, projectHeight);
  }

  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.app.canvas;
  }

  /** Canvas pixels per project pixel. */
  get renderScale(): number {
    return this.app.renderer.width / this.projectWidth;
  }

  resize(canvasWidth: number, canvasHeight: number, projectWidth: number, projectHeight: number) {
    this.projectWidth = projectWidth;
    this.projectHeight = projectHeight;
    this.app.renderer.resize(canvasWidth, canvasHeight);
  }

  render(frame: FrameDescription, sources: FrameSources): void {
    if (frame.width !== this.projectWidth || frame.height !== this.projectHeight) {
      this.projectWidth = frame.width;
      this.projectHeight = frame.height;
    }
    this.app.renderer.background.color = frame.background;
    const seen = new Set<string>();
    frame.layers.forEach((layer, z) => {
      const node = this.nodeFor(layer);
      seen.add(layer.clipId);
      const visible = this.update(node, layer, sources);
      node.container.visible = visible;
      node.container.zIndex = z;
    });
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.container.destroy({ children: true });
        this.nodes.delete(id);
      }
    }
    this.app.stage.sortChildren();
    this.app.render();
  }

  private nodeFor(layer: VisualLayer): Node {
    let node = this.nodes.get(layer.clipId);
    if (!node) {
      node = { container: new Container() };
      this.app.stage.addChild(node.container);
      this.nodes.set(layer.clipId, node);
    }
    return node;
  }

  private update(node: Node, layer: VisualLayer, sources: FrameSources): boolean {
    switch (layer.type) {
      case 'video': {
        const src = sources.video.get(layer.clipId);
        return src ? this.updateMedia(node, layer, src, true) : false;
      }
      case 'image': {
        const src = layer.assetId ? sources.images.get(layer.assetId) : undefined;
        return src ? this.updateMedia(node, layer, src, false) : false;
      }
      case 'text':
        this.updateText(node, layer);
        return true;
      case 'caption':
        this.updateCaption(node, layer);
        return true;
    }
  }

  private textureFor(src: CanvasImageSource & { width: number; height: number }, dynamic: boolean) {
    let tex = this.textures.get(src);
    if (!tex) {
      tex = Texture.from(src as never);
      this.textures.set(src, tex);
    } else if (dynamic) {
      tex.source.update();
    }
    return tex;
  }

  private updateMedia(
    node: Node,
    layer: VisualLayer,
    src: CanvasImageSource & { width: number; height: number },
    dynamic: boolean,
  ): boolean {
    if (!node.sprite) {
      node.sprite = new Sprite();
      node.sprite.anchor.set(0.5);
      node.container.addChild(node.sprite);
    }
    const sprite = node.sprite;
    sprite.texture = this.textureFor(src, dynamic);
    const place = placeMedia(
      { width: this.projectWidth, height: this.projectHeight },
      { width: src.width, height: src.height },
      layer.transform,
      this.renderScale,
    );
    sprite.position.set(place.centerX, place.centerY);
    sprite.width = place.width;
    sprite.height = place.height;
    sprite.rotation = place.rotation;
    sprite.alpha = place.alpha;
    this.applyEffects(node, sprite, layer);
    return true;
  }

  private applyEffects(node: Node, target: Container, layer: VisualLayer) {
    const filters: Filter[] = [];
    if (hasColorEffects(layer.effects)) {
      node.colorFilter ??= new ColorMatrixFilter();
      node.colorFilter.matrix = colorMatrix(layer.effects);
      filters.push(node.colorFilter);
    }
    if (layer.effects.blur) {
      node.blurFilter ??= new BlurFilter();
      node.blurFilter.strength = layer.effects.blur * this.renderScale;
      filters.push(node.blurFilter);
    }
    target.filters = filters.length ? filters : null;
  }

  /** wrapWidth null disables Pixi's word wrap (captions are laid out manually). */
  private textStyle(
    style: CutlineTextStyle | CaptionStyle,
    wrapWidth: number | null,
    color?: string,
  ) {
    const s = this.renderScale;
    const fill = parseColor(color ?? style.color);
    const isText = 'strokeWidth' in style;
    return new TextStyle({
      fontFamily: style.fontFamily,
      fontSize: style.fontSize * s,
      fill: { color: fill.color, alpha: fill.alpha },
      fontWeight: isText ? (style.bold ? 'bold' : 'normal') : '600',
      fontStyle: isText && style.italic ? 'italic' : 'normal',
      align: isText ? style.align : 'center',
      wordWrap: wrapWidth !== null,
      wordWrapWidth: wrapWidth ?? 100,
      stroke:
        isText && style.strokeWidth > 0
          ? { color: parseColor(style.strokeColor).color, width: style.strokeWidth * s }
          : undefined,
    });
  }

  private updateText(node: Node, layer: VisualLayer) {
    const style = layer.style!;
    const s = this.renderScale;
    const wrap = style.maxWidth * this.projectWidth * s;
    const key = JSON.stringify([layer.text, style, s]);
    if (node.key !== key) {
      node.container.removeChildren().forEach((c) => c.destroy());
      node.background = undefined;
      node.text = new Text({ text: layer.text ?? '', style: this.textStyle(style, wrap) });
      node.text.anchor.set(0.5);
      if (style.backgroundColor) {
        const bg = parseColor(style.backgroundColor);
        const pad = style.fontSize * s * PAD;
        node.background = new Graphics()
          .roundRect(
            -node.text.width / 2 - pad,
            -node.text.height / 2 - pad,
            node.text.width + pad * 2,
            node.text.height + pad * 2,
            pad,
          )
          .fill({ color: bg.color, alpha: bg.alpha });
        node.container.addChild(node.background);
      }
      node.container.addChild(node.text);
      node.key = key;
    }
    const place = placeText(
      { width: this.projectWidth, height: this.projectHeight },
      layer.transform,
      s,
    );
    node.container.position.set(place.centerX, place.centerY);
    node.container.scale.set(place.scale);
    node.container.rotation = place.rotation;
    node.container.alpha = place.alpha;
    this.applyEffects(node, node.container, layer);
  }

  private updateCaption(node: Node, layer: VisualLayer) {
    const style = layer.captionStyle!;
    const s = this.renderScale;
    const canvasW = this.app.renderer.width;
    const canvasH = this.app.renderer.height;
    const { tokens, timed } = captionTokens(layer.text ?? '', layer.words);
    const active = timed && style.highlightColor ? (layer.activeWord ?? -1) : -1;
    const key = JSON.stringify([layer.text, style, s, active]);
    if (node.key === key) return;
    node.key = key;
    node.container.removeChildren().forEach((c) => c.destroy());

    const base = this.textStyle(style, null);
    const metrics = (t: string) => CanvasTextMetrics.measureText(t, base).width;
    const lines = layoutWords(tokens, metrics, style.maxWidth * canvasW);
    const lineHeight = style.fontSize * s * 1.25;
    const pad = style.fontSize * s * PAD;
    const boxW = Math.max(0, ...lines.map((l) => l.width)) + pad * 2;
    const boxH = lines.length * lineHeight + pad * 2;
    const centerY = captionCenterY(canvasH, style, boxH);
    if (style.backgroundColor && lines.length > 0) {
      const bg = parseColor(style.backgroundColor);
      node.container.addChild(
        new Graphics()
          .roundRect(canvasW / 2 - boxW / 2, centerY - boxH / 2, boxW, boxH, pad)
          .fill({ color: bg.color, alpha: bg.alpha }),
      );
    }
    const highlight = style.highlightColor
      ? this.textStyle(style, null, style.highlightColor)
      : base;
    lines.forEach((line, i) => {
      const y = centerY - boxH / 2 + pad + i * lineHeight + lineHeight / 2;
      const x0 = canvasW / 2 - line.width / 2;
      for (const word of line.words) {
        const t = new Text({ text: word.text, style: word.index === active ? highlight : base });
        t.anchor.set(0, 0.5);
        t.position.set(x0 + word.x, y);
        node.container.addChild(t);
      }
    });
    node.container.position.set(0, 0);
    node.container.alpha = 1;
  }

  destroy(): void {
    this.nodes.clear();
    this.app.destroy({ removeView: false }, { children: true, texture: false });
  }
}
