import { clipSpeed, isFreeze, isReversed, sourceSpan } from './clipmath';
import { chapterList } from './markers';
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
  /** Playback speed when not 1 (timeline duration = source span / speed). */
  speed?: number;
  /** The source window plays backwards. */
  reverse?: boolean;
  /** Freeze frame: holds the frame at source[0], silent. */
  freeze?: boolean;
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
    s.source = [r3(clip.sourceStart), r3(clip.sourceStart + sourceSpan(clip))];
    if (isFreeze(clip)) s.freeze = true;
    else {
      if (clipSpeed(clip) !== 1) s.speed = clipSpeed(clip);
      if (isReversed(clip)) s.reverse = true;
    }
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
  const chapters = chapterList(project);
  const others = (project.markers ?? []).filter((m) => m.kind !== 'chapter');
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
    ...(chapters.length && {
      /** Chapter markers in time order (YouTube description / MP4 chapters). */
      chapters: chapters.map((c) => ({ time: r3(c.time), title: c.title })),
    }),
    ...(others.length && {
      /** Note and highlight markers (highlights may span until `end`). */
      markers: others.slice(0, max).map((m) => ({
        id: m.id,
        kind: m.kind,
        time: r3(m.time),
        ...(m.end !== undefined && { end: r3(m.end) }),
        label: m.label,
      })),
    }),
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
