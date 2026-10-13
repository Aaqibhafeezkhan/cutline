import type { EditLog } from './track-edit';

/** What an operation did, in a form useful for UIs (highlighting) and LLMs (summary). */
export interface OpOutcome {
  summary: string;
  /** Ids that now exist and were created or changed. */
  affectedIds: string[];
  createdIds: string[];
  removedIds: string[];
}

export function outcome(
  summary: string,
  log: Partial<EditLog> = {},
  extra: string[] = [],
): OpOutcome {
  const removed = new Set(log.removed ?? []);
  const created = [...new Set(log.created ?? [])].filter((id) => !removed.has(id));
  const affected = [...new Set([...extra, ...(log.modified ?? []), ...created])].filter(
    (id) => !removed.has(id),
  );
  return { summary, affectedIds: affected, createdIds: created, removedIds: [...removed] };
}
