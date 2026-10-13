import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema,
  isCutlineError,
  type ClientMessage,
  type CutlineErrorJSON,
  type Origin,
  type ServerMessage,
} from '@cutline/core';
import type { ActivityEvent, ChangeEvent } from '../documents';
import { log } from '../log';
import type { Services } from '../services';
import { allowedHostnames, checkRequest } from './security';

interface Client {
  id: string;
  socket: WebSocket;
  name: string;
  projectId: string | null;
}

function toErrorJSON(err: unknown): CutlineErrorJSON {
  if (isCutlineError(err)) return err.toJSON();
  return { code: 'INVARIANT', message: err instanceof Error ? err.message : String(err) };
}

/**
 * WebSocket sync hub (/ws): browsers subscribe to a project, receive a
 * snapshot and then JSON patches for every change (with who made it),
 * and send their own edits as operations.
 */
export class SyncHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private readonly clients = new Map<string, Client>();
  private readonly hosts: Set<string>;

  constructor(private readonly services: Services) {
    this.hosts = allowedHostnames(services.config);
    services.docs.events.on('change', this.onChange);
    services.docs.events.on('activity', this.onActivity);
    services.presence.events.on('change', this.onPresence);
    this.wss.on('connection', (socket) => this.onConnection(socket));
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/ws') return;
      const problem = checkRequest(req, this.services.config, this.hosts);
      if (problem) {
        socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${problem}`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(msg));
  }

  private broadcast(projectId: string, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.projectId === projectId && c.socket.readyState === WebSocket.OPEN) c.socket.send(data);
    }
  }

  private onConnection(socket: WebSocket): void {
    const client: Client = { id: randomUUID(), socket, name: 'Editor', projectId: null };
    this.clients.set(client.id, client);
    let alive = true;
    socket.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);
    socket.on('message', (data) => void this.onMessage(client, data.toString()));
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(client.id);
      this.services.presence.leave(client.id);
    });
    socket.on('error', (err) => log.debug('websocket error', err));
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = ClientMessageSchema.parse(JSON.parse(raw));
    } catch {
      this.send(client, {
        type: 'error',
        error: { code: 'INVALID_ARGUMENT', message: 'Malformed message.' },
      });
      return;
    }
    const origin: Origin = { kind: 'user', name: client.name, clientId: client.id };
    try {
      switch (msg.type) {
        case 'ping':
          this.send(client, { type: 'pong' });
          return;
        case 'subscribe': {
          const loaded = await this.services.docs.get(msg.projectId);
          client.projectId = msg.projectId;
          client.name = msg.clientName ?? 'Editor';
          this.services.presence.join(msg.projectId, {
            id: client.id,
            kind: 'browser',
            name: client.name,
          });
          this.send(client, {
            type: 'snapshot',
            projectId: msg.projectId,
            version: loaded.version,
            project: loaded.project,
            history: loaded.history,
          });
          this.send(client, {
            type: 'presence',
            projectId: msg.projectId,
            participants: this.services.presence.list(msg.projectId),
          });
          return;
        }
        case 'ops': {
          const r = await this.services.docs.apply(
            msg.projectId,
            msg.operations,
            origin,
            msg.label,
          );
          this.send(client, {
            type: 'ack',
            requestId: msg.requestId,
            ok: true,
            version: r.version,
          });
          return;
        }
        case 'undo':
        case 'redo': {
          const r = await this.services.docs[msg.type](msg.projectId, origin);
          this.send(client, {
            type: 'ack',
            requestId: msg.requestId,
            ok: true,
            version: r.version,
          });
          return;
        }
      }
    } catch (err) {
      if ('requestId' in msg) {
        this.send(client, {
          type: 'ack',
          requestId: msg.requestId,
          ok: false,
          error: toErrorJSON(err),
        });
      } else {
        this.send(client, { type: 'error', error: toErrorJSON(err) });
      }
    }
  }

  private onChange = (e: ChangeEvent): void => {
    this.broadcast(e.projectId, {
      type: 'patch',
      projectId: e.projectId,
      version: e.version,
      patches: e.patches,
      origin: e.origin,
      label: e.label,
      summary: e.summary,
      affectedIds: e.affectedIds,
      history: e.history,
      kind: e.kind,
    });
  };

  private onActivity = (e: ActivityEvent): void => {
    this.broadcast(e.projectId, { type: 'activity', ...e });
  };

  private onPresence = (projectId: string): void => {
    this.broadcast(projectId, {
      type: 'presence',
      projectId,
      participants: this.services.presence.list(projectId),
    });
  };

  close(): void {
    this.services.docs.events.off('change', this.onChange);
    this.services.docs.events.off('activity', this.onActivity);
    this.services.presence.events.off('change', this.onPresence);
    for (const c of this.clients.values()) c.socket.close(1001, 'server shutting down');
    this.wss.close();
  }
}
