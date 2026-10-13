import { clipEnd, type OperationInput } from '@cutline/core';
import { toast } from 'sonner';
import { currentTime } from '@/lib/player-bridge';
import { useEditor } from '@/lib/store';

const EPS = 1e-3;

/** Splits the selected clips (or every unlocked clip) under the playhead. */
export async function splitAtPlayhead(): Promise<void> {
  const { project, selection, dispatch } = useEditor.getState();
  if (!project) return;
  const t = currentTime();
  const candidates = project.tracks
    .filter((tr) => !tr.locked)
    .flatMap((tr) => tr.clips)
    .filter((c) => c.start + EPS < t && clipEnd(c) - EPS > t);
  const targets = selection.length
    ? candidates.filter((c) => selection.includes(c.id))
    : candidates;
  if (targets.length === 0) {
    toast.message('Nothing to split at the playhead.');
    return;
  }
  await dispatch(
    targets.map((c) => ({ type: 'split_clip', clipId: c.id, time: t })),
    `Split ${targets.length} clip(s)`,
  );
}

export async function deleteSelection(ripple: boolean): Promise<void> {
  const { selection, dispatch, select } = useEditor.getState();
  if (selection.length === 0) return;
  if (await dispatch([{ type: 'delete_clips', clipIds: selection, ripple }])) select([]);
}

/** Moves the selected clips by `delta` seconds (keyboard nudge). */
export async function nudgeSelection(delta: number): Promise<void> {
  const { project, selection, dispatch } = useEditor.getState();
  if (!project || selection.length === 0) return;
  const clips = project.tracks.flatMap((t) => t.clips).filter((c) => selection.includes(c.id));
  // Move the clips away from the direction of travel first so they don't collide with each other.
  clips.sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
  const ops: OperationInput[] = clips.map((c) => ({
    type: 'move_clip',
    clipId: c.id,
    start: Math.max(0, c.start + delta),
  }));
  await dispatch(ops, 'Nudge');
}

export function selectAll(): void {
  const { project, select } = useEditor.getState();
  if (project) select(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}
