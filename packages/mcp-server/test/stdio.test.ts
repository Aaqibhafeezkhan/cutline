import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startServer, type RunningServer } from '../src/server';
import { tempDir } from './helpers';

const CLI = resolve(__dirname, '../src/cli.ts');
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
});

async function stdioClient(port: number, dataDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', CLI, '--stdio', '--port', String(port)],
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, CUTLINE_DATA_DIR: dataDir, CUTLINE_LOG_LEVEL: 'warn' } as Record<
      string,
      string
    >,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

describe('stdio transport', () => {
  it('starts its own server when none is running', async () => {
    const port = randomPort();
    const client = await stdioClient(port, await tempDir());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(24);
    const r = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Via stdio' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    // The in-process server also serves the browser API.
    const health = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const body = (await health.json()) as { projects: Array<{ name: string }> };
    expect(body.projects.map((p) => p.name)).toEqual(['Via stdio']);
  }, 60_000);

  it('bridges to a running server so the editor sees the same project', async () => {
    const dataDir = await tempDir();
    const server: RunningServer = await startServer({ port: randomPort(), dataDir });
    cleanup.push(() => server.close());
    const client = await stdioClient(server.port, await tempDir());
    const r = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Bridged' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const list = await server.services.docs.list();
    expect(list.map((p) => p.name)).toEqual(['Bridged']);
  }, 60_000);
});
