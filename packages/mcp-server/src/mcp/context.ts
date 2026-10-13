import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { isCutlineError, projectDuration, round3, type Origin } from '@cutline/core';
import type { EditResult } from '../documents';
import { log } from '../log';
import type { Services } from '../services';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface SessionInfo {
  id: string;
}

/** Per-MCP-session helpers shared by all tools. */
export class ToolContext {
  constructor(
    readonly services: Services,
    private readonly server: McpServer,
    readonly session: SessionInfo,
  ) {}

  /** Who is calling: shown in the editor next to every change. */
  origin(): Origin {
    const client = this.server.server.getClientVersion();
    return { kind: 'agent', name: prettyClientName(client?.name), clientId: this.session.id };
  }

  /** Resolves an optional projectId and marks the agent as present on it. */
  async projectId(id: string | undefined): Promise<string> {
    const resolved = await this.services.docs.resolveId(id);
    const origin = this.origin();
    this.services.presence.join(
      resolved,
      { id: this.session.id, kind: 'agent', name: origin.name ?? 'AI agent' },
      true,
    );
    return resolved;
  }

  editorUrl(projectId: string): string {
    return `${this.services.config.publicUrl.replace(/\/$/, '')}/p/${encodeURIComponent(projectId)}`;
  }

  /** Reports a long-running step to the client (progress) and to the editor (activity). */
  progress(extra: Extra, projectId: string, tool: string) {
    const id = randomUUID();
    const origin = this.origin();
    const token = extra._meta?.progressToken;
    const send = (
      status: 'started' | 'progress' | 'finished' | 'failed',
      message: string,
      fraction?: number,
    ) => {
      this.services.docs.activity({
        projectId,
        id,
        origin,
        tool,
        status,
        message,
        ...(fraction !== undefined && { progress: fraction }),
        at: new Date().toISOString(),
      });
      if (token !== undefined && fraction !== undefined) {
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              progress: Math.round(fraction * 100),
              total: 100,
              message,
            },
          })
          .catch(() => undefined);
      }
    };
    return {
      start: (message: string) => send('started', message, 0),
      update: (fraction: number, message: string) => send('progress', message, fraction),
      done: (message: string) => send('finished', message, 1),
      fail: (message: string) => send('failed', message),
    };
  }
}

function prettyClientName(name: string | undefined): string {
  if (!name) return 'AI agent';
  if (/claude/i.test(name)) return 'Claude';
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/** Successful tool result: one-line summary plus compact JSON (also as structuredContent). */
export function ok(summary: string, data: Record<string, unknown> = {}): CallToolResult {
  const text = Object.keys(data).length ? `${summary}\n${JSON.stringify(data)}` : summary;
  return { content: [{ type: 'text', text }], structuredContent: { summary, ...data } };
}

/** Error result that tells the model what went wrong and how to fix it. */
export function fail(err: unknown): CallToolResult {
  if (isCutlineError(err)) {
    const body = err.toJSON();
    return {
      isError: true,
      content: [{ type: 'text', text: `Error ${err.code}: ${err.describe()}` }],
      structuredContent: {
        error: { code: body.code, message: body.message, hint: body.hint ?? null },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  log.warn('tool failed', err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: { error: { code: 'INTERNAL', message, hint: null } },
  };
}

/** Wraps a tool handler so every thrown error becomes an actionable tool error. */
export function guard<A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) {
  return async (args: A, extra: Extra): Promise<CallToolResult> => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Standard payload for document edits. */
export function editPayload(projectId: string, result: EditResult) {
  return {
    projectId,
    version: result.version,
    duration: round3(projectDuration(result.project)),
    ...(result.createdIds.length && { createdIds: result.createdIds }),
    ...(result.affectedIds.length && { affectedIds: result.affectedIds }),
    ...(result.removedIds.length && { removedIds: result.removedIds }),
    canUndo: result.history.canUndo,
  };
}
