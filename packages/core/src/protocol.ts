import { z } from 'zod';
import type { CutlineErrorJSON } from './errors';
import type { Origin } from './history';
import type { JsonPatchOperation } from './patch';
import type { Project } from './schema';

/** Shared by the server and the browser: the WebSocket sync protocol. */
export const PROTOCOL_VERSION = 1;

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface Participant {
  id: string;
  kind: 'browser' | 'agent';
  name: string;
}

// --- client → server -------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    projectId: z.string().min(1),
    clientName: z.string().max(100).optional(),
  }),
  z.object({
    type: z.literal('ops'),
    requestId: z.string().min(1).max(100),
    projectId: z.string().min(1),
    operations: z.array(z.unknown()).min(1).max(2000),
    label: z.string().max(200).optional(),
  }),
  z.object({
    type: z.enum(['undo', 'redo']),
    requestId: z.string().min(1).max(100),
    projectId: z.string().min(1),
  }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.output<typeof ClientMessageSchema>;

// --- server → client -------------------------------------------------------

export interface SnapshotMessage {
  type: 'snapshot';
  projectId: string;
  version: number;
  project: Project;
  history: HistoryInfo;
}

export interface PatchMessage {
  type: 'patch';
  projectId: string;
  /** Version after applying `patches`; clients must be at `version - 1`. */
  version: number;
  patches: JsonPatchOperation[];
  origin: Origin;
  label: string;
  summary: string;
  affectedIds: string[];
  history: HistoryInfo;
  kind: 'edit' | 'undo' | 'redo';
}

export interface AckMessage {
  type: 'ack';
  requestId: string;
  ok: boolean;
  version?: number;
  error?: CutlineErrorJSON;
}

export interface PresenceMessage {
  type: 'presence';
  projectId: string;
  participants: Participant[];
}

/** Something an agent is doing that does not change the document (e.g. analysing audio). */
export interface ActivityMessage {
  type: 'activity';
  projectId: string;
  id: string;
  origin: Origin;
  tool: string;
  status: 'started' | 'progress' | 'finished' | 'failed';
  message: string;
  progress?: number;
  /** Optional URL, e.g. a finished export to download. */
  link?: string;
  at: string;
}

export interface ErrorMessage {
  type: 'error';
  error: CutlineErrorJSON;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | SnapshotMessage
  | PatchMessage
  | AckMessage
  | PresenceMessage
  | ActivityMessage
  | ErrorMessage
  | PongMessage;
