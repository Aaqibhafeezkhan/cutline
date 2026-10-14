import type { CutlineErrorJSON } from './errors';
import type { Origin } from './history';
import type { IdPrefix, OpContext } from './ids';
import type { Operation } from './operations/schemas';
import type { AgentMode, Clip, Project } from './schema';

/**
 * Suggestion mode: in "suggest" mode, agent edits are not applied but stored
 * as proposals ("pull requests for edits") that the user previews, accepts
 * or rejects. Everything here is pure; the server owns storage.
 */

export type ProposalStatus = 'pending' | 'stale';

export interface Proposal {
  id: string;
  projectId: string;
  /** Tool name plus a short summary, e.g. "split_clip: Split clip_1 at 2.00s". */
  label: string;
  /** What the operations did when they were proposed. */
  summary: string;
  /** Parsed operations, re-applied on accept. */
  operations: Operation[];
  /**
   * Ids generated while the proposal was computed, replayed on accept so the
   * ids the agent was told about stay valid.
   */
  ids: string[];
  /** Project version the proposal was computed against. */
  baseVersion: number;
  createdAt: string;
  origin: Origin;
  status: ProposalStatus;
  /** Why the proposal no longer applies (status "stale"). */
  error?: CutlineErrorJSON;
  changes: ProjectChange[];
  affectedIds: string[];
}

/** The agent mode of a project ("direct" unless set). */
export function agentModeOf(project: Project): AgentMode {
  return project.settings.agentMode ?? 'direct';
}

/** Wraps a context and records every id it generates. */
export function recordingContext(ctx: OpContext): { ctx: OpContext; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    ctx: {
      now: () => ctx.now(),
      newId: (prefix) => {
        const id = ctx.newId(prefix);
        ids.push(id);
        return id;
      },
    },
  };
}

/** Replays recorded ids (matched by prefix, in order) before falling back to `ctx`. */
export function replayContext(ctx: OpContext, ids: readonly string[]): OpContext {
  const queue = [...ids];
  return {
    now: () => ctx.now(),
    newId: (prefix: IdPrefix) => {
      const i = queue.findIndex((id) => id.startsWith(`${prefix}_`));
      if (i < 0) return ctx.newId(prefix);
      return queue.splice(i, 1)[0]!;
    },
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type ChangeEntity = 'project' | 'track' | 'clip' | 'asset' | 'marker';

export interface ProjectChange {
  kind: 'added' | 'removed' | 'changed';
  entity: ChangeEntity;
  id: string;
  /** Human-readable name, e.g. `text clip "Hello" on V2`. */
  label: string;
  /** Changed fields (kind "changed" only). */
  fields?: string[];
}

function changedKeys(a: object, b: object, ignore: readonly string[] = []): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])];
  return keys.filter((k) => !ignore.includes(k) && JSON.stringify(ra[k]) !== JSON.stringify(rb[k]));
}

function shorten(s: string, n = 32): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function clipLabel(project: Project, clip: Clip, trackName: string): string {
  let name = clip.name;
  if (clip.type === 'text' || clip.type === 'caption') name ??= clip.text;
  if ('assetId' in clip) name ??= project.assets.find((a) => a.id === clip.assetId)?.name;
  return `${clip.type} clip ${name ? `"${shorten(name)}"` : clip.id} on ${trackName}`;
}

interface Located {
  clip: Clip;
  track: string;
  trackName: string;
}

function clipIndex(project: Project): Map<string, Located> {
  const map = new Map<string, Located>();
  for (const t of project.tracks) {
    for (const clip of t.clips) map.set(clip.id, { clip, track: t.id, trackName: t.name });
  }
  return map;
}

function diffById<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  entity: ChangeEntity,
  label: (item: T, project: 'a' | 'b') => string,
  fields: (a: T, b: T) => string[],
): ProjectChange[] {
  const out: ProjectChange[] = [];
  const old = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  for (const x of before) {
    if (!next.has(x.id)) out.push({ kind: 'removed', entity, id: x.id, label: label(x, 'a') });
  }
  for (const x of after) {
    const prev = old.get(x.id);
    if (!prev) {
      out.push({ kind: 'added', entity, id: x.id, label: label(x, 'b') });
      continue;
    }
    const changed = fields(prev, x);
    if (changed.length)
      out.push({ kind: 'changed', entity, id: x.id, label: label(x, 'b'), fields: changed });
  }
  return out;
}

/**
 * Lists what differs between two versions of a project: tracks, clips and
 * assets and markers added/removed/changed, plus project-level changes
 * (name, settings).
 */
export function diffProjects(a: Project, b: Project): ProjectChange[] {
  const changes: ProjectChange[] = [];
  const projectFields = [
    ...(a.name !== b.name ? ['name'] : []),
    ...changedKeys(a.settings, b.settings).map((k) => `settings.${k}`),
  ];
  if (projectFields.length) {
    changes.push({
      kind: 'changed',
      entity: 'project',
      id: b.id,
      label: `project "${shorten(b.name)}"`,
      fields: projectFields,
    });
  }

  const order = (p: Project) => new Map(p.tracks.map((t, i) => [t.id, i]));
  const ia = order(a);
  const ib = order(b);
  changes.push(
    ...diffById(
      a.tracks,
      b.tracks,
      'track',
      (t) => `${t.kind} track ${t.name}`,
      (x, y) => [
        ...changedKeys(x, y, ['clips']),
        ...(ia.get(x.id) !== ib.get(y.id) ? ['position'] : []),
      ],
    ),
  );

  const ca = clipIndex(a);
  const cb = clipIndex(b);
  const located = (index: Map<string, Located>) =>
    [...index.values()].map((l) => ({ ...l, id: l.clip.id }));
  changes.push(
    ...diffById(
      located(ca),
      located(cb),
      'clip',
      (l, side) => clipLabel(side === 'a' ? a : b, l.clip, l.trackName),
      (x, y) => [...changedKeys(x.clip, y.clip), ...(x.track !== y.track ? ['track'] : [])],
    ),
  );

  changes.push(
    ...diffById(
      a.assets,
      b.assets,
      'asset',
      (x) => `${x.kind} asset "${shorten(x.name)}"`,
      (x, y) => changedKeys(x, y),
    ),
  );

  changes.push(
    ...diffById(
      a.markers ?? [],
      b.markers ?? [],
      'marker',
      (m) => `${m.kind} marker ${m.label ? `"${shorten(m.label)}"` : m.id} at ${m.time}s`,
      (x, y) => changedKeys(x, y),
    ),
  );
  return changes;
}

/** One line such as "2 clips added, 1 clip changed, 1 track added". */
export function describeChanges(changes: readonly ProjectChange[]): string {
  if (changes.length === 0) return 'No changes.';
  const counts = new Map<string, number>();
  for (const c of changes) {
    const key = `${c.entity}|${c.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => {
    const [entity, kind] = key.split('|') as [ChangeEntity, ProjectChange['kind']];
    if (entity === 'project') return 'project settings changed';
    return `${n} ${entity}${n === 1 ? '' : 's'} ${kind}`;
  });
  return `${parts.join(', ')}.`;
}

/** A change as one readable line, e.g. `Changed text clip "Hi" on V2 (start, duration)`. */
export function formatChange(change: ProjectChange): string {
  const verb =
    change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : 'Changed';
  const fields = change.fields?.length ? ` (${change.fields.join(', ')})` : '';
  return `${verb} ${change.label}${fields}`;
}
