import { projectDuration } from './queries';
import type { Clip, Project } from './schema';
import { clipEnd } from './schema';
import { round3 } from './time';

const r3 = round3;

export interface ClipSummary {
  id: string;
  type: Clip['type'];
  start: number;
  end: number;
  asset?: string;
  source?: [number, number];
  text?: string;
  shape?: string;
  volume?: number;
  muted?: boolean;
  /** Automatic ducking, e.g. "-12 dB in 4 range(s)". */
  ducked?: string;
  transitionIn?: string;
  /** Entrance/exit presets, e.g. "in fade 0.5s, out slide-left 0.5s". */
  animation?: string;
  effects?: string[];
  animated?: string[];
}

function summarizeClip(clip: Clip, assetNames: Map<string, string>): ClipSummary {
  const s: ClipSummary = {
    id: clip.id,
    type: clip.type,
    start: r3(clip.start),
    end: r3(clipEnd(clip)),
  };
  if ('assetId' in clip) s.asset = `${clip.assetId} (${assetNames.get(clip.assetId) ?? '?'})`;
  if (clip.type === 'video' || clip.type === 'audio') {
    s.source = [r3(clip.sourceStart), r3(clip.sourceStart + clip.duration)];
    if (clip.volume !== 1) s.volume = clip.volume;
    if (clip.muted) s.muted = true;
    if (clip.duck) s.ducked = `${clip.duck.amountDb} dB in ${clip.duck.ranges.length} range(s)`;
  }
  if (clip.type === 'text' || clip.type === 'caption') s.text = clip.text;
  if (clip.type === 'shape') {
    const stroke = clip.strokeWidth ? ` stroke ${clip.strokeWidth}px ${clip.strokeColor}` : '';
    s.shape = `${clip.shape} ${clip.width}x${clip.height} fill ${clip.fill ?? 'none'}${stroke}`;
  }
  if (clip.type !== 'audio' && clip.type !== 'caption') {
    if (clip.transitionIn)
      s.transitionIn = `${clip.transitionIn.type} ${clip.transitionIn.duration}s`;
    const anim = [
      clip.animationIn && `in ${clip.animationIn.preset} ${clip.animationIn.duration}s`,
      clip.animationOut && `out ${clip.animationOut.preset} ${clip.animationOut.duration}s`,
    ].filter(Boolean);
    if (anim.length) s.animation = anim.join(', ');
    const fx = Object.keys(clip.effects);
    if (fx.length) s.effects = fx;
  }
  if (clip.type !== 'caption' && clip.keyframes) s.animated = Object.keys(clip.keyframes);
  return s;
}

/** Compact structured view of a project for LLMs: ids, times, text, no style noise. */
export function summarizeProject(project: Project, options: { maxClipsPerTrack?: number } = {}) {
  const max = options.maxClipsPerTrack ?? 200;
  const assetNames = new Map(project.assets.map((a) => [a.id, a.name]));
  const brand = project.settings.brand;
  return {
    id: project.id,
    name: project.name,
    duration: r3(projectDuration(project)),
    settings: {
      width: project.settings.width,
      height: project.settings.height,
      fps: project.settings.fps,
    },
    ...(brand && {
      /** Brand kit: templates and new text/shapes use these colors and fonts by default. */
      brand: {
        colors: brand.colors,
        ...(brand.fontFamily && { fontFamily: brand.fontFamily }),
        ...(brand.headingFontFamily && { headingFontFamily: brand.headingFontFamily }),
        ...(brand.logoAssetId && {
          logo: `${brand.logoAssetId} (${assetNames.get(brand.logoAssetId) ?? '?'})`,
        }),
        ...(brand.logoPosition && { logoPosition: brand.logoPosition }),
      },
    }),
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      duration: a.duration === null ? null : r3(a.duration),
      ...(a.width && a.height ? { size: `${a.width}x${a.height}` } : {}),
      hasAudio: a.hasAudio,
    })),
    tracks: project.tracks.map((t, index) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      index,
      ...(t.muted && { muted: true }),
      ...(t.hidden && { hidden: true }),
      ...(t.locked && { locked: true }),
      ...(t.volume !== 1 && { volume: t.volume }),
      clipCount: t.clips.length,
      clips: t.clips.slice(0, max).map((c) => summarizeClip(c, assetNames)),
      ...(t.clips.length > max && { truncated: true }),
    })),
  };
}

export type ProjectSummary = ReturnType<typeof summarizeProject>;
