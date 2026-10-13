import { EventEmitter } from 'node:events';
import type { Participant } from '@cutline/core';

const AGENT_TTL_MS = 5 * 60 * 1000;

interface Entry extends Participant {
  projectId: string;
  expires: number | null;
}

/** Who is looking at / working on which project (browsers and agents). */
export class PresenceService {
  private readonly entries = new Map<string, Entry>();
  readonly events = new EventEmitter<{ change: [projectId: string] }>();

  join(projectId: string, participant: Participant, ttl = false): void {
    const prev = this.entries.get(participant.id);
    const entry: Entry = {
      ...participant,
      projectId,
      expires: ttl ? Date.now() + AGENT_TTL_MS : null,
    };
    this.entries.set(participant.id, entry);
    if (prev && prev.projectId !== projectId) this.events.emit('change', prev.projectId);
    if (!prev || prev.projectId !== projectId || prev.name !== participant.name) {
      this.events.emit('change', projectId);
    }
  }

  leave(id: string): void {
    const prev = this.entries.get(id);
    if (!prev) return;
    this.entries.delete(id);
    this.events.emit('change', prev.projectId);
  }

  list(projectId: string): Participant[] {
    const now = Date.now();
    const out: Participant[] = [];
    for (const [id, e] of this.entries) {
      if (e.expires !== null && e.expires < now) {
        this.entries.delete(id);
        continue;
      }
      if (e.projectId === projectId) out.push({ id: e.id, kind: e.kind, name: e.name });
    }
    return out;
  }

  hasBrowser(projectId: string): boolean {
    return this.list(projectId).some((p) => p.kind === 'browser');
  }
}
