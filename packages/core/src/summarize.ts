import { projectDuration } from './queries';
import type { Clip, Project } from './schema';
import { clipEnd } from './schema';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface ClipSummary {
  id: string;
  type: Clip['type'];
  start: number;
  end: number;
  asset?: string;
  source?: [number, number];
  text?: string;
  volume?: number;
  muted?: boolean;
  transitionIn?: string;
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
  }
  if (clip.type === 'text' || clip.type === 'caption') s.text = clip.text;
  if (clip.type !== 'audio' && clip.type !== 'caption') {
    if (clip.transitionIn)
      s.transitionIn = `${clip.transitionIn.type} ${clip.transitionIn.duration}s`;
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
  return {
    id: project.id,
    name: project.name,
    duration: r3(projectDuration(project)),
    settings: {
      width: project.settings.width,
      height: project.settings.height,
      fps: project.settings.fps,
    },
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
