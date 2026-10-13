import { produceWithPatches } from 'immer';
import { z } from 'zod';
import { CutlineError } from '../errors';
import { defaultContext, type OpContext } from '../ids';
import { toJsonPatch, type JsonPatchOperation } from '../patch';
import type { Project } from '../schema';
import { assertValid } from '../validate';
import { duckAudio } from './audio';
import {
  addClip,
  deleteClips,
  deleteRange,
  moveClip,
  setAnimation,
  setClipProps,
  setTransition,
  setVolume,
  splitClipOp,
  trimClip,
} from './clips';
import type { OpOutcome } from './outcome';
import { addCaptions, addShape, addText } from './overlays';
import { OperationSchema, type OpOf, type Operation, type OperationType } from './schemas';
import {
  addAsset,
  addTrack,
  moveTrack,
  removeAsset,
  removeTrack,
  updateProject,
  updateTrack,
} from './structure';

type Handler<T extends OperationType> = (draft: Project, op: OpOf<T>, ctx: OpContext) => OpOutcome;

const HANDLERS: { [K in OperationType]: Handler<K> } = {
  update_project: updateProject,
  add_asset: addAsset,
  remove_asset: removeAsset,
  add_track: addTrack,
  update_track: updateTrack,
  remove_track: removeTrack,
  move_track: moveTrack,
  add_clip: addClip,
  add_text: addText,
  add_shape: addShape,
  add_captions: addCaptions,
  split_clip: splitClipOp,
  trim_clip: trimClip,
  move_clip: moveClip,
  delete_clips: deleteClips,
  delete_range: deleteRange,
  set_clip_props: setClipProps,
  set_transition: setTransition,
  set_animation: setAnimation,
  set_volume: setVolume,
  duck_audio: duckAudio,
};

export function parseOperation(input: unknown): Operation {
  const result = OperationSchema.safeParse(input);
  if (!result.success) {
    const type =
      typeof input === 'object' && input !== null && 'type' in input
        ? String((input as { type: unknown }).type)
        : '(missing type)';
    throw new CutlineError(
      'INVALID_OPERATION',
      `Invalid operation ${type}: ${z.prettifyError(result.error)}`,
      {
        hint: `Valid operation types: ${Object.keys(HANDLERS).join(', ')}.`,
        details: result.error.issues,
      },
    );
  }
  return result.data;
}

export interface ApplyResult extends OpOutcome {
  project: Project;
  operations: Operation[];
  patches: JsonPatchOperation[];
  inversePatches: JsonPatchOperation[];
}

/**
 * Applies operations atomically: either all succeed and one combined patch
 * set is returned, or the first error is thrown and nothing changes.
 */
export function applyOperations(
  project: Project,
  inputs: readonly unknown[],
  ctx: OpContext = defaultContext,
): ApplyResult {
  if (inputs.length === 0) {
    throw new CutlineError('INVALID_ARGUMENT', 'No operations given.');
  }
  const operations = inputs.map(parseOperation);
  const outcomes: OpOutcome[] = [];
  const [next, patches, inversePatches] = produceWithPatches(project, (draft) => {
    for (const op of operations) {
      const handler = HANDLERS[op.type] as Handler<OperationType>;
      outcomes.push(handler(draft as Project, op as never, ctx));
    }
    draft.updatedAt = ctx.now();
  });
  assertValid(next);

  const removed = new Set(outcomes.flatMap((o) => o.removedIds));
  const uniq = (ids: string[]) => [...new Set(ids)].filter((id) => !removed.has(id));
  return {
    project: next,
    operations,
    patches: toJsonPatch(patches),
    inversePatches: toJsonPatch(inversePatches),
    summary: outcomes.map((o) => o.summary).join(' '),
    affectedIds: uniq(outcomes.flatMap((o) => o.affectedIds)),
    createdIds: uniq(outcomes.flatMap((o) => o.createdIds)),
    removedIds: [...removed],
  };
}

export function applyOperation(
  project: Project,
  input: unknown,
  ctx: OpContext = defaultContext,
): ApplyResult {
  return applyOperations(project, [input], ctx);
}
