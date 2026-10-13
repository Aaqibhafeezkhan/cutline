import {
  applyOperations,
  createProject,
  findClip,
  sequentialContext,
  type ApplyResult,
  type Asset,
  type Clip,
  type OpContext,
  type OperationInput,
  type Project,
} from '../src';

export const NOW = '2026-01-01T00:00:00.000Z';

export function videoAsset(
  overrides: Partial<Asset> = {},
): Omit<Asset, 'createdAt'> & { createdAt?: string } {
  return {
    id: 'asset_v',
    name: 'interview.mp4',
    kind: 'video',
    src: 'assets/asset_v/interview.mp4',
    mimeType: 'video/mp4',
    duration: 20,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    ...overrides,
  };
}

export function audioAsset(overrides: Partial<Asset> = {}) {
  return videoAsset({
    id: 'asset_a',
    name: 'music.wav',
    kind: 'audio',
    mimeType: 'audio/wav',
    width: null,
    height: null,
    fps: null,
    hasVideo: false,
    duration: 30,
    ...overrides,
  });
}

export function imageAsset(overrides: Partial<Asset> = {}) {
  return videoAsset({
    id: 'asset_i',
    name: 'logo.png',
    kind: 'image',
    mimeType: 'image/png',
    duration: null,
    fps: null,
    hasAudio: false,
    ...overrides,
  });
}

/** A project with V1 (track_1), A1 (track_2) and video/audio/image assets. */
export function baseProject(ctx: OpContext = sequentialContext(NOW)): {
  project: Project;
  ctx: OpContext;
} {
  let project = createProject({ name: 'Test', id: 'proj_test' }, ctx);
  project = applyOperations(
    project,
    [
      { type: 'add_asset', asset: videoAsset() },
      { type: 'add_asset', asset: audioAsset() },
      { type: 'add_asset', asset: imageAsset() },
    ],
    ctx,
  ).project;
  return { project, ctx };
}

/** Applies ops in sequence, returning the final result. */
export function run(project: Project, ops: OperationInput[], ctx: OpContext): ApplyResult {
  return applyOperations(project, ops, ctx);
}

export function clip<T extends Clip = Clip>(project: Project, id: string): T {
  return findClip(project, id).clip as T;
}

export function spans(project: Project, trackIndex: number): Array<[string, number, number]> {
  return project.tracks[trackIndex]!.clips.map((c) => [c.id, c.start, c.start + c.duration]);
}
