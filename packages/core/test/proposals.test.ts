import { describe, expect, it } from 'vitest';
import {
  agentModeOf,
  applyOperation,
  applyOperations,
  describeChanges,
  diffProjects,
  formatChange,
  recordingContext,
  replayContext,
  sequentialContext,
  type Project,
} from '../src';
import { NOW, baseProject } from './helpers';

function timeline(): { project: Project; ctx: ReturnType<typeof baseProject>['ctx'] } {
  const { project, ctx } = baseProject();
  const p = applyOperations(
    project,
    [
      { type: 'add_clip', assetId: 'asset_v', trackId: 'track_1', duration: 4, id: 'clip_v' },
      { type: 'add_clip', assetId: 'asset_a', trackId: 'track_2', duration: 4, id: 'clip_a' },
      { type: 'add_text', text: 'Hello world', start: 0, id: 'clip_t' },
    ],
    ctx,
  ).project;
  return { project: p, ctx };
}

describe('set_agent_mode', () => {
  it('switches between direct and suggest', () => {
    const { project, ctx } = baseProject();
    expect(agentModeOf(project)).toBe('direct');
    const r = applyOperation(project, { type: 'set_agent_mode', mode: 'suggest' }, ctx);
    expect(agentModeOf(r.project)).toBe('suggest');
    expect(r.summary).toBe('Agent edits are now proposed for review.');
    const back = applyOperation(r.project, { type: 'set_agent_mode', mode: 'direct' }, ctx);
    expect(back.project.settings.agentMode).toBeUndefined();
    expect(back.summary).toBe('Agent edits now apply directly.');
  });

  it('cannot be changed through update_project', () => {
    const { project, ctx } = baseProject();
    const r = applyOperation(
      project,
      { type: 'update_project', settings: { agentMode: 'suggest' } as never },
      ctx,
    );
    expect(agentModeOf(r.project)).toBe('direct');
  });
});

describe('id recording and replay', () => {
  it('replays recorded ids so a proposal keeps the ids the agent saw', () => {
    const { project } = timeline();
    const rec = recordingContext(sequentialContext(NOW));
    const op = { type: 'split_clip', clipId: 'clip_v', time: 2 } as const;
    const proposed = applyOperation(project, op, rec.ctx);
    expect(rec.ids).toEqual([proposed.createdIds[0]]);
    expect(rec.ctx.now()).toBe(NOW);

    const other = sequentialContext('2026-02-02T00:00:00.000Z');
    other.newId('clip'); // the live counter has moved on
    const replay = replayContext(other, rec.ids);
    const accepted = applyOperation(project, op, replay);
    expect(accepted.createdIds).toEqual(proposed.createdIds);
    expect(replay.now()).toBe('2026-02-02T00:00:00.000Z');
    // Once the recorded ids are used up (or no prefix matches) it falls back.
    expect(replay.newId('clip')).toBe('clip_2');
    expect(replayContext(other, ['track_9']).newId('clip')).toBe('clip_3');
  });
});

describe('diffProjects', () => {
  it('reports nothing for identical projects', () => {
    const { project } = timeline();
    expect(diffProjects(project, project)).toEqual([]);
    expect(describeChanges([])).toBe('No changes.');
  });

  it('lists added, removed and changed clips, tracks, assets and settings', () => {
    const { project: a, ctx } = timeline();
    const b = applyOperations(
      a,
      [
        { type: 'update_project', name: 'Renamed', settings: { fps: 25 } },
        { type: 'split_clip', clipId: 'clip_v', time: 2, newClipId: 'clip_v2' },
        { type: 'delete_clips', clipIds: ['clip_a'] },
        { type: 'set_clip_props', clipId: 'clip_t', props: { name: 'Title' } },
        { type: 'add_track', kind: 'audio', id: 'track_m', index: 0 },
        { type: 'update_track', trackId: 'track_2', muted: true },
        { type: 'remove_asset', assetId: 'asset_i' },
        {
          type: 'add_asset',
          asset: {
            id: 'asset_n',
            name: 'a-very-long-file-name-for-the-new-asset.png',
            kind: 'image',
            src: 'x.png',
            mimeType: 'image/png',
            duration: null,
            width: 10,
            height: 10,
            fps: null,
            hasVideo: true,
            hasAudio: false,
          },
        },
        { type: 'add_shape', start: 0, id: 'clip_s' },
      ],
      ctx,
    ).project;
    const changes = diffProjects(a, b);
    const lines = changes.map(formatChange);
    expect(lines).toContain('Changed project "Renamed" (name, settings.fps)');
    expect(lines).toContain('Added audio track A2');
    expect(lines).toContain('Changed audio track A1 (muted, position)');
    expect(lines).toContain('Changed video track V1 (position)');
    expect(lines).toContain('Removed audio clip "music.wav" on A1');
    expect(lines).toContain('Changed video clip "interview.mp4" on V1 (duration)');
    expect(lines).toContain('Added video clip "interview.mp4" on V1');
    expect(lines).toContain('Changed text clip "Title" on V2 (name)');
    expect(lines).toContain('Added shape clip clip_s on V3');
    expect(lines).toContain('Removed image asset "logo.png"');
    expect(lines).toContain('Added image asset "a-very-long-file-name-for-the-n…"');
    expect(describeChanges(changes)).toContain('project settings changed');
    expect(describeChanges(changes)).toContain('1 asset removed');
    expect(describeChanges(changes)).toContain('2 clips added');
  });

  it('labels clips by text, name, asset or id and notices track moves', () => {
    const { project: a, ctx } = timeline();
    const b = applyOperations(
      a,
      [
        { type: 'add_track', kind: 'video', id: 'track_x' },
        { type: 'move_clip', clipId: 'clip_t', start: 0, trackId: 'track_x' },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'Caption text' }] },
        { type: 'set_clip_props', clipId: 'clip_v', props: { name: 'Interview A' } },
      ],
      ctx,
    ).project;
    const lines = diffProjects(a, b).map(formatChange);
    expect(lines).toContain('Changed text clip "Hello world" on V3 (track)');
    expect(lines.some((l) => /^Added caption clip "Caption text" on /.test(l))).toBe(true);
    expect(lines).toContain('Changed video clip "Interview A" on V1 (name)');
    expect(formatChange({ kind: 'changed', entity: 'clip', id: 'c', label: 'clip c' })).toBe(
      'Changed clip c',
    );
  });

  it('falls back to the clip id when the asset is unknown and counts asset changes', () => {
    const { project: a } = timeline();
    const b: Project = {
      ...a,
      assets: a.assets.map((x) => (x.id === 'asset_v' ? { ...x, name: 'renamed.mp4' } : x)),
    };
    const orphan: Project = { ...a, assets: [] };
    expect(diffProjects(a, b).map(formatChange)).toEqual([
      'Changed video asset "renamed.mp4" (name)',
    ]);
    const removed = diffProjects(orphan, { ...orphan, tracks: [] }).map(formatChange);
    expect(removed).toContain('Removed video clip clip_v on V1');
    expect(describeChanges(diffProjects(a, b))).toBe('1 asset changed.');
  });
});
