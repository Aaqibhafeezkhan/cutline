import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CutlineError } from '@cutline/core';
import {
  sequentialContext,
  type Origin,
  type ProposalsMessage,
  type ServerMessage,
} from '@cutline/core';
import { loadConfig } from '../src/config';
import { DocumentService, type ProposalsEvent } from '../src/documents';
import { createMcpServer } from '../src/mcp/server';
import { startServer, type RunningServer } from '../src/server';
import { createServices } from '../src/services';
import { LocalProjectStore } from '../src/storage/local';
import { tempDir } from './helpers';

const AGENT: Origin = { kind: 'agent', name: 'Claude' };
const USER: Origin = { kind: 'user', name: 'Editor' };

async function docsService(dir?: string) {
  const root = dir ?? (await tempDir());
  const docs = new DocumentService(
    new LocalProjectStore(join(root, 'projects')),
    sequentialContext(),
    new LocalProjectStore(join(root, 'proposals')),
  );
  return { docs, root };
}

async function errorOf(p: Promise<unknown>): Promise<CutlineError> {
  try {
    await p;
  } catch (err) {
    return err as CutlineError;
  }
  throw new Error('expected an error');
}

/** A project in suggest mode with one text clip (clip_1). */
async function suggestProject(docs: DocumentService) {
  const project = await docs.create({ name: 'Review me' });
  await docs.apply(project.id, [{ type: 'add_text', text: 'Hello', start: 0 }], USER);
  await docs.apply(project.id, [{ type: 'set_agent_mode', mode: 'suggest' }], USER);
  return project.id;
}

describe('suggestion mode (document service)', () => {
  it('turns agent edits into proposals and accepts them as one undo step', async () => {
    const { docs } = await docsService();
    const id = await suggestProject(docs);
    const events: ProposalsEvent[] = [];
    docs.events.on('proposals', (e) => events.push(e));
    const before = await docs.get(id);

    const r = await docs.apply(
      id,
      [
        { type: 'split_clip', clipId: 'clip_1', time: 1 },
        { type: 'add_text', text: 'Second', start: 5 },
      ],
      AGENT,
    );
    expect(r.proposal).toMatchObject({ status: 'pending', baseVersion: before.version });
    expect(r.proposal!.id).toMatch(/^prop_/);
    expect(r.proposal!.changes.map((c) => `${c.kind} ${c.entity}`)).toEqual([
      'changed clip',
      'added clip',
      'added clip',
    ]);
    // Nothing changed yet.
    const after = await docs.get(id);
    expect(after.version).toBe(before.version);
    expect(after.project).toEqual(before.project);
    expect(events.at(-1)!.proposals).toHaveLength(1);

    const outcome = await docs.acceptProposal(id, r.proposal!.id);
    expect(outcome.accepted).toHaveLength(1);
    const accepted = await docs.get(id);
    expect(accepted.version).toBe(before.version + 1);
    expect(accepted.history.undoLabel).toMatch(/^Accepted /);
    // The ids the agent was told about are the ones that now exist.
    const clipIds = accepted.project.tracks.flatMap((t) => t.clips.map((c) => c.id));
    for (const created of r.createdIds) expect(clipIds).toContain(created);
    expect(await docs.proposals(id)).toEqual([]);
    expect(events.at(-1)!.proposals).toEqual([]);

    // One undo removes the whole proposal.
    await docs.undo(id, USER);
    expect((await docs.get(id)).project.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });

  it('rejects one or all proposals and reports unknown ids', async () => {
    const { docs } = await docsService();
    const id = await suggestProject(docs);
    const a = await docs.apply(id, [{ type: 'add_text', text: 'A', start: 4 }], AGENT, 'Add A');
    await docs.apply(id, [{ type: 'add_text', text: 'B', start: 8 }], AGENT);
    expect(a.proposal!.label).toBe('Add A');
    expect(await docs.rejectProposal(id, a.proposal!.id)).toHaveLength(1);
    expect(await docs.proposals(id)).toHaveLength(1);
    const missing = await errorOf(docs.rejectProposal(id, 'prop_nope'));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.hint).toMatch(/Pending proposals: prop_/);
    expect(await docs.rejectProposal(id, undefined)).toHaveLength(1);
    expect((await errorOf(docs.acceptProposal(id, 'prop_nope'))).hint).toMatch(/no pending/);
    expect((await docs.get(id)).project.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });

  it('rebases onto later edits and marks proposals that no longer apply as stale', async () => {
    const { docs } = await docsService();
    const id = await suggestProject(docs);
    const move = await docs.apply(id, [{ type: 'move_clip', clipId: 'clip_1', start: 2 }], AGENT);
    const extra = await docs.apply(id, [{ type: 'add_text', text: 'Later', start: 9 }], AGENT);
    // The user keeps editing: the add still applies, the move does not.
    await docs.apply(id, [{ type: 'delete_clips', clipIds: ['clip_1'] }], USER);

    const err = await errorOf(docs.acceptProposal(id, move.proposal!.id));
    expect(err.code).toBe('STALE');
    expect(err.message).toMatch(/no longer applies/);
    const [stale] = await docs.proposals(id);
    expect(stale).toMatchObject({ id: move.proposal!.id, status: 'stale' });
    expect(stale!.error!.code).toBe('NOT_FOUND');

    const all = await docs.acceptProposal(id, undefined);
    expect(all.accepted.map((p) => p.id)).toEqual([extra.proposal!.id]);
    expect(all.stale.map((p) => p.id)).toEqual([move.proposal!.id]);
    expect((await docs.get(id)).project.tracks.flatMap((t) => t.clips.map((c) => c.id))).toEqual(
      extra.createdIds.filter((c) => c.startsWith('clip')),
    );
  });

  it('keeps agents from bypassing review', async () => {
    const { docs } = await docsService();
    const id = await suggestProject(docs);
    for (const mode of ['direct', 'suggest'] as const) {
      const err = await errorOf(docs.apply(id, [{ type: 'set_agent_mode', mode }], AGENT));
      expect(err.code).toBe('FORBIDDEN');
      expect(err.hint).toMatch(/top bar/);
    }
    expect((await errorOf(docs.undo(id, AGENT))).code).toBe('FORBIDDEN');
    expect((await errorOf(docs.redo(id, AGENT))).code).toBe('FORBIDDEN');
    // update_project silently ignores agentMode, so the mode stays.
    const r = await docs.apply(
      id,
      [{ type: 'update_project', settings: { agentMode: 'direct' } }],
      AGENT,
    );
    expect(r.proposal).toBeDefined();
    await docs.acceptProposal(id, r.proposal!.id);
    expect((await docs.get(id)).project.settings.agentMode).toBe('suggest');
    // The user can always undo (here: the accepted proposal).
    await docs.undo(id, USER);
    // Importing media only fills the asset bin and is applied right away.
    const imported = await docs.apply(
      id,
      [
        {
          type: 'add_asset',
          asset: {
            name: 'a.png',
            kind: 'image',
            src: 'a.png',
            mimeType: 'image/png',
            duration: null,
            width: 1,
            height: 1,
            fps: null,
            hasVideo: true,
            hasAudio: false,
          },
        },
      ],
      AGENT,
    );
    expect(imported.proposal).toBeUndefined();
    // Malformed operations are rejected before anything is proposed.
    expect((await errorOf(docs.apply(id, [null], AGENT))).code).toBe('INVALID_OPERATION');
    expect(await docs.proposals(id)).toEqual([]);
  });

  it('persists pending proposals with the project data', async () => {
    const { docs, root } = await docsService();
    const id = await suggestProject(docs);
    await docs.apply(id, [{ type: 'add_text', text: 'Keep me', start: 3 }], AGENT);
    await docs.flush();
    const reopened = (await docsService(root)).docs;
    const [p] = await reopened.proposals(id);
    expect(p!.summary).toMatch(/Keep me/);
    await reopened.acceptProposal(id, p!.id);
    expect((await reopened.get(id)).project.tracks.flatMap((t) => t.clips)).toHaveLength(2);
    // Once nothing is pending the stored file is removed.
    expect(await new LocalProjectStore(join(root, 'proposals')).read(id)).toBeNull();
    // Without a proposal store, proposals live in memory only.
    const memory = new DocumentService(new LocalProjectStore(join(root, 'projects')));
    expect(await memory.proposals(id)).toEqual([]);
  });
});

describe('suggestion mode over MCP', () => {
  type Result = CallToolResult & { structuredContent?: Record<string, unknown> };

  async function setup() {
    const dataDir = await tempDir();
    const services = createServices(loadConfig({ dataDir, publicUrl: 'http://localhost:5173' }));
    const server = createMcpServer(services, { id: 'review-session' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-test', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as Result;
    return { services, client, call };
  }

  it('tells the agent its edit is waiting for review', async () => {
    const { services, client, call } = await setup();
    const created = (await call('create_project', { name: 'MCP review' })).structuredContent!;
    const id = created.projectId as string;
    await services.docs.apply(id, [{ type: 'set_agent_mode', mode: 'suggest' }], USER);

    const project = (await call('get_project')).structuredContent!;
    expect(project.agentMode).toBe('suggest');
    expect(project.summary).toMatch(/Suggest mode/);
    expect(project.proposals).toBeUndefined();

    const r = await call('add_text_overlay', { text: 'Proposed title', start: 0 });
    expect(r.isError).toBeFalsy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/^Proposed as prop_\w+, waiting for the user's review/);
    expect(text).toMatch(/- Added text clip "Proposed title"/);
    expect(r.structuredContent!.status).toBe('proposed');
    const [proposal] = r.structuredContent!.proposals as Array<{ id: string; label: string }>;
    expect(proposal!.label).toMatch(/^add_text_overlay: /);
    expect((await services.docs.get(id)).project.tracks.flatMap((t) => t.clips)).toEqual([]);

    const listed = (await call('list_proposals')).structuredContent!;
    expect(listed.summary).toMatch(/1 proposal\(s\) waiting for review\. Suggest mode is on/);
    expect((listed.proposals as Array<{ id: string }>)[0]!.id).toBe(proposal!.id);
    expect(((await call('get_project')).structuredContent!.proposals as unknown[]).length).toBe(1);

    const forbidden = await call('apply_operations', {
      operations: [{ type: 'set_agent_mode', mode: 'direct' }],
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent!.error).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call('undo')).isError).toBe(true);

    // Errors are passed through untouched; a big change set is shortened.
    expect((await call('split_clip', { clipId: 'clip_nope', time: 1 })).isError).toBe(true);
    const many = await call('apply_operations', {
      operations: Array.from({ length: 22 }, (_, i) => ({
        type: 'add_text',
        text: `T${i}`,
        start: i * 3,
      })),
    });
    expect((many.content[0] as { text: string }).text).toMatch(/… and \d+ more/);

    await services.docs.apply(id, [{ type: 'set_agent_mode', mode: 'direct' }], USER);
    const direct = (await call('list_proposals')).structuredContent!;
    expect(direct.summary).toMatch(/Direct mode is on/);
    await client.close();
  });
});

describe('suggestion mode over the WebSocket', () => {
  let server: RunningServer | undefined;
  afterAll(async () => {
    await server?.close();
  });

  it('streams proposals to the editor and accepts/rejects on request', async () => {
    server = await startServer({ port: 0, dataDir: await tempDir() });
    const { docs } = server.services;
    const id = await suggestProject(docs);
    await docs.apply(id, [{ type: 'add_text', text: 'One', start: 4 }], AGENT);

    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', projectId: id }));
    const latest = () =>
      messages.filter((m): m is ProposalsMessage => m.type === 'proposals').at(-1)?.proposals;
    await expect.poll(() => latest()?.length).toBe(1);

    await docs.apply(id, [{ type: 'add_text', text: 'Two', start: 8 }], AGENT);
    await expect.poll(() => latest()?.length).toBe(2);

    const ack = (requestId: string) =>
      messages.find((m) => m.type === 'ack' && m.requestId === requestId);
    const send = (msg: Record<string, unknown>) =>
      ws.send(JSON.stringify({ type: 'proposal', projectId: id, ...msg }));

    send({ requestId: 'a1', action: 'accept', proposalId: latest()![0]!.id });
    await expect.poll(() => ack('a1')).toMatchObject({ ok: true });
    expect(latest()).toHaveLength(1);
    expect(messages.some((m) => m.type === 'patch' && m.origin.kind === 'agent')).toBe(true);

    send({ requestId: 'a2', action: 'reject', proposalId: 'prop_missing' });
    await expect.poll(() => ack('a2')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    send({ requestId: 'a3', action: 'reject' });
    await expect.poll(() => ack('a3')).toMatchObject({ ok: true });
    expect(latest()).toEqual([]);
    ws.close();
  });
});
