import { CutlineError } from '../errors';
import type { OpContext } from '../ids';
import { findAsset, findTrack, nextTrackName } from '../queries';
import { AssetSchema, CaptionStyleSchema, TrackSchema, type Project } from '../schema';
import { formatTime } from '../time';
import { outcome, type OpOutcome } from './outcome';
import type { OpOf } from './schemas';
import { assertEditable } from './track-edit';

export function updateProject(draft: Project, op: OpOf<'update_project'>): OpOutcome {
  const changes: string[] = [];
  if (op.name !== undefined) {
    draft.name = op.name;
    changes.push(`renamed to "${op.name}"`);
  }
  if (op.settings) {
    Object.assign(draft.settings, op.settings);
    const s = draft.settings;
    changes.push(`settings ${s.width}×${s.height} @ ${s.fps} fps`);
  }
  return outcome(`Project ${changes.join(', ') || 'unchanged'}.`, {}, [draft.id]);
}

export function setAgentMode(draft: Project, op: OpOf<'set_agent_mode'>): OpOutcome {
  if (op.mode === 'direct') delete draft.settings.agentMode;
  else draft.settings.agentMode = op.mode;
  return outcome(
    op.mode === 'suggest'
      ? 'Agent edits are now proposed for review.'
      : 'Agent edits now apply directly.',
    {},
    [draft.id],
  );
}

export function addAsset(draft: Project, op: OpOf<'add_asset'>, ctx: OpContext): OpOutcome {
  const id = op.asset.id ?? ctx.newId('asset');
  if (draft.assets.some((a) => a.id === id)) {
    throw new CutlineError('INVALID_ARGUMENT', `An asset with id "${id}" already exists.`, {
      hint: 'Omit the id to get a fresh one.',
    });
  }
  const asset = AssetSchema.parse({ ...op.asset, id, createdAt: op.asset.createdAt ?? ctx.now() });
  draft.assets.push(asset);
  const length = asset.duration === null ? 'still image' : formatTime(asset.duration);
  return outcome(`Added ${asset.kind} asset "${asset.name}" (${id}, ${length}).`, {
    created: [id],
  });
}

export function removeAsset(draft: Project, op: OpOf<'remove_asset'>): OpOutcome {
  const asset = findAsset(draft, op.assetId);
  const users = draft.tracks.flatMap((t) =>
    t.clips.filter((c) => 'assetId' in c && c.assetId === asset.id).map((c) => ({ t, c })),
  );
  if (users.length > 0 && !op.removeClips) {
    throw new CutlineError(
      'IN_USE',
      `Asset "${asset.name}" is used by ${users.length} clip(s): ${users.map((u) => u.c.id).join(', ')}.`,
      { hint: 'Delete those clips first or pass removeClips: true.' },
    );
  }
  for (const { t } of users) assertEditable(t);
  const removed = users.map((u) => u.c.id);
  for (const track of draft.tracks) {
    track.clips = track.clips.filter((c) => !removed.includes(c.id));
  }
  draft.assets = draft.assets.filter((a) => a.id !== asset.id);
  const brand = draft.settings.brand;
  let logoNote = '';
  if (brand?.logoAssetId === asset.id) {
    delete brand.logoAssetId;
    logoNote = ' and cleared the brand logo';
  }
  return outcome(
    `Removed asset "${asset.name}"${removed.length ? ` and ${removed.length} clip(s)` : ''}${logoNote}.`,
    { removed: [asset.id, ...removed] },
  );
}

export function addTrack(draft: Project, op: OpOf<'add_track'>, ctx: OpContext): OpOutcome {
  const id = op.id ?? ctx.newId('track');
  if (draft.tracks.some((t) => t.id === id)) {
    throw new CutlineError('INVALID_ARGUMENT', `A track with id "${id}" already exists.`);
  }
  const track = TrackSchema.parse({
    id,
    kind: op.kind,
    name: op.name ?? nextTrackName(draft, op.kind),
    captionStyle: op.kind === 'caption' ? CaptionStyleSchema.parse({}) : undefined,
  });
  // Default position: the top of the stack, but below caption tracks so captions stay visible.
  const firstCaption = draft.tracks.findIndex((t) => t.kind === 'caption');
  const top = op.kind === 'caption' || firstCaption < 0 ? draft.tracks.length : firstCaption;
  const index = Math.min(op.index ?? top, draft.tracks.length);
  draft.tracks.splice(index, 0, track);
  return outcome(`Added ${op.kind} track ${track.name} (${id}).`, { created: [id] });
}

export function updateTrack(draft: Project, op: OpOf<'update_track'>): OpOutcome {
  const track = findTrack(draft, op.trackId);
  const changes: string[] = [];
  if (op.name !== undefined) track.name = op.name;
  if (op.muted !== undefined) track.muted = op.muted;
  if (op.hidden !== undefined) track.hidden = op.hidden;
  if (op.locked !== undefined) track.locked = op.locked;
  if (op.volume !== undefined) track.volume = op.volume;
  for (const key of ['name', 'muted', 'hidden', 'locked', 'volume'] as const) {
    if (op[key] !== undefined) changes.push(`${key}=${String(op[key])}`);
  }
  if (op.captionStyle) {
    if (track.kind !== 'caption') {
      throw new CutlineError('INVALID_ARGUMENT', `captionStyle only applies to caption tracks.`, {
        hint: `Track ${track.name} is a ${track.kind} track.`,
      });
    }
    track.captionStyle = CaptionStyleSchema.parse({ ...track.captionStyle, ...op.captionStyle });
    changes.push('caption style');
  }
  return outcome(`Updated track ${track.name}: ${changes.join(', ') || 'no changes'}.`, {}, [
    track.id,
  ]);
}

export function removeTrack(draft: Project, op: OpOf<'remove_track'>): OpOutcome {
  const track = findTrack(draft, op.trackId);
  assertEditable(track);
  draft.tracks = draft.tracks.filter((t) => t.id !== track.id);
  return outcome(`Removed track ${track.name} with ${track.clips.length} clip(s).`, {
    removed: [track.id, ...track.clips.map((c) => c.id)],
  });
}

export function moveTrack(draft: Project, op: OpOf<'move_track'>): OpOutcome {
  const track = findTrack(draft, op.trackId);
  const from = draft.tracks.indexOf(track);
  draft.tracks.splice(from, 1);
  const to = Math.min(op.index, draft.tracks.length);
  draft.tracks.splice(to, 0, track);
  return outcome(`Moved track ${track.name} to position ${to} (0 = bottom).`, {}, [track.id]);
}
