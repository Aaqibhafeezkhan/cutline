import { EventEmitter } from 'node:events';
import {
  CutlineError,
  applyOperations,
  createHistory,
  createProject,
  defaultContext,
  describeHistory,
  migrateProject,
  projectDuration,
  recordHistory,
  redo,
  undo,
  type ActivityMessage,
  type ApplyResult,
  type CreateProjectInput,
  type HistoryInfo,
  type HistoryState,
  type JsonPatchOperation,
  type OpContext,
  type Origin,
  type Project,
  type RecentChange,
} from '@cutline/core';
import { log } from './log';
import type { ProjectStore } from './storage/types';

export interface ChangeEvent {
  projectId: string;
  version: number;
  project: Project;
  patches: JsonPatchOperation[];
  origin: Origin;
  label: string;
  summary: string;
  affectedIds: string[];
  history: HistoryInfo;
  kind: 'edit' | 'undo' | 'redo';
}

export type ActivityEvent = Omit<ActivityMessage, 'type'>;

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
  duration: number;
  assetCount: number;
  clipCount: number;
}

interface Doc {
  project: Project;
  version: number;
  history: HistoryState;
  queue: Promise<unknown>;
  saveTimer: NodeJS.Timeout | null;
}

export interface LoadedProject {
  project: Project;
  version: number;
  history: HistoryInfo;
}

export interface EditResult extends ApplyResult {
  version: number;
  history: HistoryInfo;
}

/** Short debounce: coalesces bursts of edits but keeps the data-loss window tiny. */
const SAVE_DELAY = 100;

/**
 * Owns all projects: the single source of truth. Edits are serialized per
 * project, recorded in a shared undo history and broadcast as JSON patches.
 */
export class DocumentService {
  private readonly docs = new Map<string, Promise<Doc>>();
  readonly events = new EventEmitter<{
    change: [ChangeEvent];
    activity: [ActivityEvent];
  }>();
  /** Most recently edited/opened project, used when a tool call omits projectId. */
  private lastTouched: string | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly ctx: OpContext = defaultContext,
  ) {
    this.events.setMaxListeners(100);
  }

  private async load(id: string): Promise<Doc> {
    let entry = this.docs.get(id);
    if (!entry) {
      entry = (async () => {
        const raw = await this.store.read(id);
        if (raw === null) {
          const known = await this.store.list();
          throw new CutlineError('NOT_FOUND', `Project "${id}" not found.`, {
            hint: known.length
              ? `Existing projects: ${known.slice(0, 10).join(', ')}. Call get_project without arguments to list them.`
              : 'There are no projects yet. Call create_project first.',
          });
        }
        return {
          project: migrateProject(raw),
          version: 1,
          history: createHistory(),
          queue: Promise.resolve(),
          saveTimer: null,
        };
      })();
      entry.catch(() => this.docs.delete(id));
      this.docs.set(id, entry);
    }
    return entry;
  }

  /** Runs `fn` exclusively for a project (edits never interleave). */
  private async exclusive<T>(id: string, fn: (doc: Doc) => Promise<T> | T): Promise<T> {
    const doc = await this.load(id);
    const run = doc.queue.then(() => fn(doc));
    doc.queue = run.catch(() => undefined);
    return run;
  }

  private scheduleSave(id: string, doc: Doc): void {
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    doc.saveTimer = setTimeout(() => {
      doc.saveTimer = null;
      this.store.write(id, doc.project).catch((err) => log.error(`saving ${id} failed`, err));
    }, SAVE_DELAY);
  }

  async list(): Promise<ProjectListItem[]> {
    const ids = await this.store.list();
    const items: ProjectListItem[] = [];
    for (const id of ids) {
      try {
        const { project } = await this.load(id);
        items.push({
          id,
          name: project.name,
          updatedAt: project.updatedAt,
          duration: projectDuration(project),
          assetCount: project.assets.length,
          clipCount: project.tracks.reduce((n, t) => n + t.clips.length, 0),
        });
      } catch (err) {
        log.warn(`skipping unreadable project ${id}`, err);
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const project = createProject(input, this.ctx);
    if (await this.store.read(project.id)) {
      throw new CutlineError('INVALID_ARGUMENT', `Project "${project.id}" already exists.`);
    }
    await this.store.write(project.id, project);
    this.docs.set(
      project.id,
      Promise.resolve({
        project,
        version: 1,
        history: createHistory(),
        queue: Promise.resolve(),
        saveTimer: null,
      }),
    );
    this.lastTouched = project.id;
    return project;
  }

  async get(id: string): Promise<LoadedProject> {
    const doc = await this.load(id);
    this.lastTouched = id;
    return { project: doc.project, version: doc.version, history: describeHistory(doc.history) };
  }

  /** The most recent history entries (newest first), for editors that join late. */
  async recent(id: string, limit = 30): Promise<RecentChange[]> {
    const doc = await this.load(id);
    return doc.history.past
      .slice(-limit)
      .reverse()
      .map(({ id: entryId, label, origin, at, affectedIds }) => ({
        id: entryId,
        label,
        origin,
        at,
        affectedIds,
      }));
  }

  /** Resolves an optional project id to a concrete one (falls back to the last used project). */
  async resolveId(id: string | undefined): Promise<string> {
    if (id) return id;
    if (this.lastTouched) return this.lastTouched;
    const [latest] = await this.list();
    if (!latest) {
      throw new CutlineError('NOT_FOUND', 'No project exists yet.', {
        hint: 'Call create_project first (or open the editor and create one).',
      });
    }
    return latest.id;
  }

  async apply(
    id: string,
    operations: readonly unknown[],
    origin: Origin,
    label?: string,
  ): Promise<EditResult> {
    return this.exclusive(id, (doc) => {
      const result = applyOperations(doc.project, operations, this.ctx);
      doc.project = result.project;
      doc.version++;
      const entryLabel = label ?? truncate(result.summary, 80);
      doc.history = recordHistory(doc.history, {
        id: `${doc.version}`,
        label: entryLabel,
        origin,
        at: this.ctx.now(),
        affectedIds: result.affectedIds,
        patches: result.patches,
        inversePatches: result.inversePatches,
      });
      this.lastTouched = id;
      this.scheduleSave(id, doc);
      const history = describeHistory(doc.history);
      this.events.emit('change', {
        projectId: id,
        version: doc.version,
        project: doc.project,
        patches: result.patches,
        origin,
        label: entryLabel,
        summary: result.summary,
        affectedIds: result.affectedIds,
        history,
        kind: 'edit',
      });
      return { ...result, version: doc.version, history };
    });
  }

  async undo(id: string, origin: Origin) {
    return this.step(id, origin, 'undo');
  }

  async redo(id: string, origin: Origin) {
    return this.step(id, origin, 'redo');
  }

  private step(id: string, origin: Origin, kind: 'undo' | 'redo') {
    return this.exclusive(id, (doc) => {
      const step =
        kind === 'undo' ? undo(doc.project, doc.history) : redo(doc.project, doc.history);
      doc.project = step.project;
      doc.history = step.history;
      doc.version++;
      this.lastTouched = id;
      this.scheduleSave(id, doc);
      const history = describeHistory(doc.history);
      const summary = `${kind === 'undo' ? 'Undid' : 'Redid'} "${step.entry.label}".`;
      this.events.emit('change', {
        projectId: id,
        version: doc.version,
        project: doc.project,
        patches: step.patches,
        origin,
        label: step.entry.label,
        summary,
        affectedIds: step.entry.affectedIds,
        history,
        kind,
      });
      return { project: doc.project, version: doc.version, history, summary, entry: step.entry };
    });
  }

  /** Reports non-editing agent activity (analysis, rendering) to connected editors. */
  activity(event: ActivityEvent): void {
    this.events.emit('activity', event);
  }

  /** Writes pending changes to storage. */
  async flush(): Promise<void> {
    for (const [id, entry] of this.docs) {
      const doc = await entry.catch(() => null);
      if (doc?.saveTimer) {
        clearTimeout(doc.saveTimer);
        doc.saveTimer = null;
        await this.store.write(id, doc.project);
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
