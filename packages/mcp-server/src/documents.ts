import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  CutlineError,
  agentModeOf,
  applyOperations,
  createHistory,
  createProject,
  defaultContext,
  describeHistory,
  diffProjects,
  isCutlineError,
  migrateProject,
  projectDuration,
  recordHistory,
  recordingContext,
  redo,
  replayContext,
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
  type Proposal,
  type RecentChange,
} from '@cutline/core';
import { log } from './log';
import type { ProjectStore } from './storage/types';
import { toolScope } from './tool-scope';

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

export interface ProposalsEvent {
  projectId: string;
  proposals: Proposal[];
}

interface Doc {
  project: Project;
  version: number;
  history: HistoryState;
  queue: Promise<unknown>;
  saveTimer: NodeJS.Timeout | null;
  proposals: Proposal[];
}

export interface LoadedProject {
  project: Project;
  version: number;
  history: HistoryInfo;
}

export interface EditResult extends ApplyResult {
  version: number;
  history: HistoryInfo;
  /** Set when the edit was proposed for review instead of applied (suggest mode). */
  proposal?: Proposal;
}

export interface ProposalOutcome {
  accepted: Proposal[];
  stale: Proposal[];
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
    proposals: [ProposalsEvent];
  }>();
  /** Most recently edited/opened project, used when a tool call omits projectId. */
  private lastTouched: string | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly ctx: OpContext = defaultContext,
    /** Where pending proposals are kept (per project id); null keeps them in memory. */
    private readonly proposalStore: ProjectStore | null = null,
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
          proposals: loadProposals(await this.proposalStore?.read(id)),
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

  /**
   * Creates a new project as a copy of `source` (assets, settings, tracks,
   * markers) transformed by `operations`, e.g. a highlight reel. The new
   * project starts with an empty history.
   */
  async createFrom(
    source: Project,
    name: string,
    operations: readonly unknown[],
  ): Promise<{ project: Project; summary: string }> {
    const fresh = createProject({ name, defaultTracks: false }, this.ctx);
    const copy: Project = {
      ...structuredClone(source),
      id: fresh.id,
      name: fresh.name,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
    };
    const result = applyOperations(copy, operations, this.ctx);
    await this.create({ name }, result.project);
    return { project: result.project, summary: result.summary };
  }

  async create(input: CreateProjectInput, prebuilt?: Project): Promise<Project> {
    const project = prebuilt ?? createProject(input, this.ctx);
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
        proposals: [],
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

  /**
   * Applies operations as one history entry. Agent edits on a project in
   * "suggest" mode are not applied: they become a proposal (returned as
   * `proposal`, with `project` showing the would-be result).
   */
  async apply(
    id: string,
    operations: readonly unknown[],
    origin: Origin,
    label?: string,
  ): Promise<EditResult> {
    return this.exclusive(id, async (doc) => {
      if (origin.kind === 'agent') {
        assertAgentAllowed(operations);
        if (agentModeOf(doc.project) === 'suggest' && !importOnly(operations)) {
          return this.propose(id, doc, operations, origin, label);
        }
      }
      const result = applyOperations(doc.project, operations, this.ctx);
      return this.commit(id, doc, result, origin, label ?? truncate(result.summary, 80));
    });
  }

  private commit(
    id: string,
    doc: Doc,
    result: ApplyResult,
    origin: Origin,
    entryLabel: string,
  ): EditResult {
    doc.project = result.project;
    doc.version++;
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
  }

  // --- suggestion mode --------------------------------------------------------

  private async propose(
    id: string,
    doc: Doc,
    operations: readonly unknown[],
    origin: Origin,
    label: string | undefined,
  ): Promise<EditResult> {
    const recorder = recordingContext(this.ctx);
    // Dry run: validates the operations and shows what they would do.
    const result = applyOperations(doc.project, operations, recorder.ctx);
    const scope = toolScope.getStore();
    const text = label ?? truncate(result.summary, 80);
    const proposal: Proposal = {
      id: `prop_${randomBytes(6).toString('hex')}`,
      projectId: id,
      label: truncate(scope ? `${scope.tool}: ${text}` : text, 120),
      summary: result.summary,
      operations: result.operations,
      ids: recorder.ids,
      baseVersion: doc.version,
      createdAt: this.ctx.now(),
      origin,
      status: 'pending',
      changes: diffProjects(doc.project, result.project),
      affectedIds: result.affectedIds,
    };
    doc.proposals.push(proposal);
    scope?.proposals.push(proposal);
    this.lastTouched = id;
    await this.saveProposals(id, doc);
    return {
      ...result,
      version: doc.version,
      history: describeHistory(doc.history),
      proposal,
    };
  }

  private async saveProposals(id: string, doc: Doc): Promise<void> {
    this.events.emit('proposals', { projectId: id, proposals: doc.proposals });
    if (!this.proposalStore) return;
    try {
      if (doc.proposals.length) await this.proposalStore.write(id, doc.proposals);
      else await this.proposalStore.delete(id);
    } catch (err) {
      log.error(`saving proposals of ${id} failed`, err);
    }
  }

  /** Pending agent proposals of a project, oldest first. */
  async proposals(id: string): Promise<Proposal[]> {
    return (await this.load(id)).proposals;
  }

  /**
   * Accepts one proposal (or all with `proposalId` undefined): each is applied
   * as one history entry, even if the project changed since it was proposed.
   * Proposals that no longer apply are marked "stale" and kept for review.
   */
  async acceptProposal(id: string, proposalId: string | undefined): Promise<ProposalOutcome> {
    return this.exclusive(id, async (doc) => {
      const targets =
        proposalId === undefined ? [...doc.proposals] : [findProposal(doc, proposalId)];
      const outcome: ProposalOutcome = { accepted: [], stale: [] };
      for (const p of targets) {
        try {
          const result = applyOperations(doc.project, p.operations, replayContext(this.ctx, p.ids));
          this.commit(id, doc, result, p.origin, truncate(`Accepted ${p.label}`, 120));
          doc.proposals = doc.proposals.filter((x) => x.id !== p.id);
          outcome.accepted.push(p);
        } catch (err) {
          p.status = 'stale';
          p.error = isCutlineError(err)
            ? err.toJSON()
            : { code: 'INVARIANT', message: err instanceof Error ? err.message : String(err) };
          outcome.stale.push(p);
        }
      }
      await this.saveProposals(id, doc);
      const [first] = outcome.stale;
      if (proposalId !== undefined && first) {
        throw new CutlineError(
          'STALE',
          `Proposal ${first.id} no longer applies: ${first.error!.message}`,
          {
            hint: 'The project changed since the agent proposed this. Reject it and ask the agent to try again.',
          },
        );
      }
      return outcome;
    });
  }

  /** Discards one proposal (or all with `proposalId` undefined). */
  async rejectProposal(id: string, proposalId: string | undefined): Promise<Proposal[]> {
    return this.exclusive(id, async (doc) => {
      const removed = proposalId === undefined ? doc.proposals : [findProposal(doc, proposalId)];
      doc.proposals = doc.proposals.filter((p) => !removed.includes(p));
      await this.saveProposals(id, doc);
      return removed;
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
      if (origin.kind === 'agent' && agentModeOf(doc.project) === 'suggest') {
        throw new CutlineError(
          'FORBIDDEN',
          `The user reviews your edits (suggest mode), so you cannot ${kind} directly.`,
          {
            hint: 'Propose the change you want with the editing tools instead; list_proposals shows what is waiting for review.',
          },
        );
      }
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

/** Agents may edit, but never change how their own edits are reviewed. */
function assertAgentAllowed(operations: readonly unknown[]): void {
  if (operations.some((op) => typeOf(op) === 'set_agent_mode')) {
    throw new CutlineError('FORBIDDEN', 'Only the user can change the agent mode.', {
      hint: 'The user switches between Direct and Suggest in the editor top bar. Leave set_agent_mode out of your operations.',
    });
  }
}

/** Importing media only adds to the asset bin, so it is not held for review. */
function importOnly(operations: readonly unknown[]): boolean {
  return operations.length > 0 && operations.every((op) => typeOf(op) === 'add_asset');
}

function typeOf(op: unknown): unknown {
  return typeof op === 'object' && op !== null ? (op as { type?: unknown }).type : undefined;
}

function findProposal(doc: Doc, proposalId: string): Proposal {
  const found = doc.proposals.find((p) => p.id === proposalId);
  if (!found) {
    throw new CutlineError('NOT_FOUND', `Proposal "${proposalId}" not found.`, {
      hint: doc.proposals.length
        ? `Pending proposals: ${doc.proposals.map((p) => p.id).join(', ')}.`
        : 'There are no pending proposals (it may have been accepted or rejected already).',
    });
  }
  return found;
}

function loadProposals(raw: unknown): Proposal[] {
  return Array.isArray(raw) ? (raw as Proposal[]) : [];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
