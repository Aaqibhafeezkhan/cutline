import { CutlineError } from './errors';
import { applyJsonPatch, type JsonPatchOperation } from './patch';
import type { Project } from './schema';

export type OriginKind = 'user' | 'agent' | 'system';

/** Who made a change. Agents show up highlighted in the editor. */
export interface Origin {
  kind: OriginKind;
  /** Display name, e.g. "Claude" or a client name. */
  name?: string;
  /** Connection id of the browser/MCP session. */
  clientId?: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  origin: Origin;
  at: string;
  affectedIds: string[];
  patches: JsonPatchOperation[];
  inversePatches: JsonPatchOperation[];
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  limit: number;
}

export function createHistory(limit = 200): HistoryState {
  return { past: [], future: [], limit };
}

/** Records a new change; clears the redo stack and enforces the size limit. */
export function recordHistory(history: HistoryState, entry: HistoryEntry): HistoryState {
  const past = [...history.past, entry];
  if (past.length > history.limit) past.splice(0, past.length - history.limit);
  return { ...history, past, future: [] };
}

export interface HistoryStep {
  project: Project;
  history: HistoryState;
  entry: HistoryEntry;
  /** Patches that turn the previous project into `project` (to broadcast). */
  patches: JsonPatchOperation[];
}

export function undo(project: Project, history: HistoryState): HistoryStep {
  const entry = history.past[history.past.length - 1];
  if (!entry) {
    throw new CutlineError('NOTHING_TO_UNDO', 'There is nothing to undo.', {
      hint: 'The history is empty (it is kept in memory per server session).',
    });
  }
  return {
    project: applyJsonPatch(project, entry.inversePatches),
    history: { ...history, past: history.past.slice(0, -1), future: [entry, ...history.future] },
    entry,
    patches: entry.inversePatches,
  };
}

export function redo(project: Project, history: HistoryState): HistoryStep {
  const entry = history.future[0];
  if (!entry) {
    throw new CutlineError('NOTHING_TO_REDO', 'There is nothing to redo.', {
      hint: 'Redo is only possible right after an undo, before any new edit.',
    });
  }
  return {
    project: applyJsonPatch(project, entry.patches),
    history: { ...history, past: [...history.past, entry], future: history.future.slice(1) },
    entry,
    patches: entry.patches,
  };
}

export function describeHistory(history: HistoryState) {
  return {
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undoLabel: history.past[history.past.length - 1]?.label ?? null,
    redoLabel: history.future[0]?.label ?? null,
  };
}
