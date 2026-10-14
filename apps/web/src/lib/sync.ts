import type { AckMessage, ClientMessage, OperationInput, ServerMessage } from '@cutline/core';
import { withToken } from './api';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

type Pending = { resolve: (ack: AckMessage) => void; reject: (err: Error) => void };

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * WebSocket client for the sync protocol: reconnects with backoff,
 * re-subscribes after reconnects and turns acks into promises.
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private projectId: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private retry = 0;
  private closed = false;
  private seq = 0;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onStatus: (status: ConnectionStatus) => void,
    private readonly clientName = 'Editor',
  ) {}

  connect(projectId: string): void {
    this.projectId = projectId;
    this.closed = false;
    this.open();
  }

  private open(): void {
    this.onStatus('connecting');
    const url = new URL('/ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(withToken(url.href));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      this.subscribe();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === 'ack') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          if (msg.ok) p.resolve(msg);
          else
            p.reject(
              new SyncError(
                msg.error?.message ?? 'Request failed',
                msg.error?.code ?? 'ERROR',
                msg.error?.hint,
              ),
            );
        }
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values())
        p.reject(new SyncError('Connection lost', 'DISCONNECTED'));
      this.pending.clear();
      this.onStatus('closed');
      if (!this.closed) {
        const delay = Math.min(10_000, 500 * 2 ** this.retry++);
        setTimeout(() => !this.closed && this.open(), delay);
      }
    };
  }

  /** (Re)subscribes, which makes the server send a fresh snapshot. */
  subscribe(): void {
    if (this.projectId)
      this.raw({ type: 'subscribe', projectId: this.projectId, clientName: this.clientName });
  }

  private raw(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private request(msg: ClientMessage & { requestId: string }): Promise<AckMessage> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new SyncError('Not connected to the Cutline server.', 'DISCONNECTED'));
        return;
      }
      this.pending.set(msg.requestId, { resolve, reject });
      this.raw(msg);
    });
  }

  ops(operations: OperationInput[], label?: string): Promise<AckMessage> {
    if (!this.projectId) return Promise.reject(new Error('No project'));
    return this.request({
      type: 'ops',
      requestId: `r${++this.seq}`,
      projectId: this.projectId,
      operations,
      label,
    });
  }

  undo(): Promise<AckMessage> {
    return this.request({ type: 'undo', requestId: `r${++this.seq}`, projectId: this.projectId! });
  }

  redo(): Promise<AckMessage> {
    return this.request({ type: 'redo', requestId: `r${++this.seq}`, projectId: this.projectId! });
  }

  /** Accepts or rejects an agent proposal (all of them without `proposalId`). */
  proposal(action: 'accept' | 'reject', proposalId?: string): Promise<AckMessage> {
    return this.request({
      type: 'proposal',
      requestId: `r${++this.seq}`,
      projectId: this.projectId!,
      action,
      proposalId,
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
