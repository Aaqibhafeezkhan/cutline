import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  applyJsonPatch,
  applyOperations,
  defaultContext,
  replayContext,
  type AgentMode,
  type HistoryInfo,
  type OperationInput,
  type Origin,
  type Participant,
  type Project,
  type Proposal,
  type ServerMessage,
} from '@cutline/core';
import { toast } from 'sonner';
import { SyncClient, SyncError, type ConnectionStatus } from './sync';

export interface ActivityEntry {
  id: string;
  at: string;
  origin: Origin;
  message: string;
  kind: 'edit' | 'undo' | 'redo' | 'activity';
  affectedIds: string[];
  status?: 'started' | 'progress' | 'finished' | 'failed';
  progress?: number;
  link?: string;
  tool?: string;
}

/** How long clips touched by an agent stay highlighted. */
export const HIGHLIGHT_MS = 4000;
const MAX_ACTIVITY = 60;

interface EditorState {
  projectId: string | null;
  project: Project | null;
  version: number;
  history: HistoryInfo;
  connection: ConnectionStatus;
  participants: Participant[];
  selection: string[];
  /** Pixels per second on the timeline. */
  zoom: number;
  /** clipId → highlight expiry (ms timestamp) and who caused it. */
  highlights: Record<string, { until: number; origin: Origin }>;
  activity: ActivityEntry[];
  /** Pending agent proposals (suggest mode), oldest first. */
  proposals: Proposal[];
  /** The proposal shown in the preview, applied to a local copy of the project. */
  preview: ProposalPreview | null;

  open(projectId: string): void;
  close(): void;
  dispatch(operations: OperationInput[], label?: string): Promise<boolean>;
  undo(): void;
  redo(): void;
  setAgentMode(mode: AgentMode): Promise<boolean>;
  /** Accepts one proposal, or all without an id. */
  acceptProposal(id?: string): Promise<void>;
  /** Rejects one proposal, or all without an id. */
  rejectProposal(id?: string): Promise<void>;
  /** Shows a proposal in the preview, or goes back to the live project. */
  togglePreview(id: string | null): void;
  select(ids: string[], additive?: boolean): void;
  setZoom(zoom: number): void;
  receive(msg: ServerMessage): void;
}

export interface ProposalPreview {
  id: string;
  project: Project;
  affectedIds: string[];
}

/** Applies a proposal to a local copy of the project (null if it no longer applies). */
export function previewProposal(project: Project, proposal: Proposal): ProposalPreview | null {
  try {
    const result = applyOperations(
      project,
      proposal.operations,
      replayContext(defaultContext, proposal.ids),
    );
    return { id: proposal.id, project: result.project, affectedIds: result.affectedIds };
  } catch {
    return null;
  }
}

let client: SyncClient | null = null;

function reportError(err: unknown) {
  if (err instanceof SyncError) {
    toast.error(err.message, { description: err.hint });
  } else {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

export const useEditor = create<EditorState>()(
  immer((set, get) => ({
    projectId: null,
    project: null,
    version: 0,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    connection: 'closed',
    participants: [],
    selection: [],
    zoom: 60,
    highlights: {},
    activity: [],
    proposals: [],
    preview: null,

    open(projectId) {
      client?.close();
      set((s) => {
        s.projectId = projectId;
        s.project = null;
        s.version = 0;
        s.selection = [];
        s.activity = [];
        s.highlights = {};
        s.proposals = [];
        s.preview = null;
      });
      client = new SyncClient(
        (msg) => get().receive(msg),
        (status) =>
          set((s) => {
            s.connection = status;
          }),
      );
      client.connect(projectId);
    },

    close() {
      client?.close();
      client = null;
      set((s) => {
        s.projectId = null;
        s.project = null;
        s.connection = 'closed';
      });
    },

    async dispatch(operations, label) {
      if (!client) return false;
      try {
        await client.ops(operations, label);
        return true;
      } catch (err) {
        reportError(err);
        return false;
      }
    },

    undo() {
      client?.undo().catch(reportError);
    },

    redo() {
      client?.redo().catch(reportError);
    },

    setAgentMode(mode) {
      return get().dispatch(
        [{ type: 'set_agent_mode', mode }],
        mode === 'suggest' ? 'Review agent edits' : 'Apply agent edits directly',
      );
    },

    async acceptProposal(id) {
      if (!client) return;
      try {
        await client.proposal('accept', id);
        const stale = get().proposals.filter((p) => p.status === 'stale');
        if (id === undefined && stale.length) {
          toast.warning(`${stale.length} suggestion(s) no longer apply`, {
            description:
              'The project changed since the agent proposed them. Reject them or ask the agent again.',
          });
        }
      } catch (err) {
        reportError(err);
      }
    },

    async rejectProposal(id) {
      if (!client) return;
      try {
        await client.proposal('reject', id);
      } catch (err) {
        reportError(err);
      }
    },

    togglePreview(id) {
      const { project, proposals, preview } = get();
      const proposal = proposals.find((p) => p.id === id);
      if (!id || !project || !proposal || preview?.id === id) {
        set((s) => {
          s.preview = null;
        });
        return;
      }
      const next = previewProposal(project, proposal);
      if (!next) toast.error('This suggestion no longer applies to the current project.');
      set((s) => {
        s.preview = next;
      });
    },

    select(ids, additive = false) {
      set((s) => {
        s.selection = additive ? [...new Set([...s.selection, ...ids])] : ids;
      });
    },

    setZoom(zoom) {
      set((s) => {
        s.zoom = Math.min(800, Math.max(4, zoom));
      });
    },

    receive(msg) {
      switch (msg.type) {
        case 'snapshot':
          set((s) => {
            s.project = msg.project;
            s.version = msg.version;
            s.history = msg.history;
            // Show what happened before this editor joined (keep running tool activity).
            const running = s.activity.filter((a) => a.kind === 'activity');
            const past: ActivityEntry[] = msg.recent.map((r) => ({
              id: `h${r.id}`,
              at: r.at,
              origin: r.origin,
              message: r.label,
              kind: 'edit',
              affectedIds: r.affectedIds,
            }));
            s.activity = [...running, ...past].slice(0, MAX_ACTIVITY);
          });
          refreshPreview();
          return;
        case 'patch': {
          const state = get();
          if (!state.project || msg.version !== state.version + 1) {
            // Missed a message (e.g. reconnect): ask for a fresh snapshot.
            client?.subscribe();
            return;
          }
          const project = applyJsonPatch(state.project, msg.patches);
          const until = Date.now() + HIGHLIGHT_MS;
          set((s) => {
            s.project = project;
            s.version = msg.version;
            s.history = msg.history;
            s.selection = s.selection.filter((id) =>
              project.tracks.some((t) => t.clips.some((c) => c.id === id)),
            );
            if (msg.origin.kind === 'agent') {
              for (const id of msg.affectedIds) s.highlights[id] = { until, origin: msg.origin };
            }
            s.activity.unshift({
              id: `v${msg.version}`,
              at: new Date().toISOString(),
              origin: msg.origin,
              message: msg.summary,
              kind: msg.kind,
              affectedIds: msg.affectedIds,
            });
            s.activity.splice(MAX_ACTIVITY);
          });
          refreshPreview();
          return;
        }
        case 'activity':
          set((s) => {
            const existing = s.activity.find((a) => a.id === msg.id);
            const entry: ActivityEntry = {
              id: msg.id,
              at: msg.at,
              origin: msg.origin,
              message: msg.message,
              kind: 'activity',
              affectedIds: [],
              status: msg.status,
              progress: msg.progress,
              link: msg.link,
              tool: msg.tool,
            };
            if (existing) Object.assign(existing, entry);
            else {
              s.activity.unshift(entry);
              s.activity.splice(MAX_ACTIVITY);
            }
          });
          return;
        case 'proposals':
          set((s) => {
            s.proposals = msg.proposals;
          });
          refreshPreview();
          return;
        case 'presence':
          set((s) => {
            s.participants = msg.participants;
          });
          return;
        case 'error':
          toast.error(msg.error.message, { description: msg.error.hint });
          return;
        default:
          return;
      }
    },
  })),
);

/**
 * Re-applies the previewed proposal after the project or the proposals
 * changed; ends the preview when the proposal is gone or no longer applies.
 */
function refreshPreview() {
  const { preview, project, proposals } = useEditor.getState();
  if (!preview) return;
  const proposal = proposals.find((p) => p.id === preview.id);
  const next = project && proposal ? previewProposal(project, proposal) : null;
  useEditor.setState({ preview: next });
}

/** Playhead time lives in its own store so 60 fps updates don't re-render the timeline. */
interface PlayheadState {
  time: number;
  playing: boolean;
  setTime(t: number): void;
  setPlaying(p: boolean): void;
}

export const usePlayhead = create<PlayheadState>()((set) => ({
  time: 0,
  playing: false,
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
}));
