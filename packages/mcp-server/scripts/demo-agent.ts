// A scripted "agent" that drives a running Cutline server over MCP, step by
// step, so you can watch the editor update live.
//
//   pnpm --filter @cutline/mcp-server demo -- <absolute path to a video with speech>
//
// Options: --url http://localhost:4100/mcp  --project <id>  --step setup|edit|all  --delay 1500
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://localhost:4100/mcp' },
    project: { type: 'string' },
    step: { type: 'string', default: 'all' },
    delay: { type: 'string', default: '1500' },
  },
});

const media = positionals[0];
const delay = Number(values.delay);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: 'Demo agent', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(values.url!), {
    requestInit: process.env.CUTLINE_TOKEN
      ? { headers: { authorization: `Bearer ${process.env.CUTLINE_TOKEN}` } }
      : undefined,
  }),
);

async function call(name: string, args: Record<string, unknown> = {}) {
  process.stdout.write(`→ ${name} ${JSON.stringify(args)}\n`);
  // Transcription and export can take a while; progress notifications keep the request alive.
  const r = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => process.stdout.write(`  … ${p.message ?? `${p.progress}/${p.total}`}\n`),
  })) as CallToolResult;
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  process.stdout.write(`${r.isError ? '✗' : '✓'} ${text.split('\n')[0]}\n\n`);
  if (r.isError) throw new Error(text);
  await sleep(delay);
  return r.structuredContent as Record<string, unknown>;
}

let projectId = values.project;
if (values.step === 'setup' || values.step === 'all') {
  if (!media) throw new Error('Pass the absolute path of a video file with speech.');
  const created = await call('create_project', { name: 'Agent demo' });
  projectId = String(created.projectId);
  console.log(`Open ${String(created.editorUrl)} to watch.\n`);
  const { asset } = (await call('add_asset', { projectId, path: media })) as {
    asset: { id: string };
  };
  await call('add_clip', { projectId, assetId: asset.id });
}
if (values.step === 'edit' || values.step === 'all') {
  const silence = await call('detect_silence', { projectId, minDuration: 0.6 });
  const ranges = silence.ranges as unknown[];
  if (ranges.length) await call('delete_range', { projectId, ranges });
  await call('add_captions', {
    projectId,
    fromTranscript: true,
    style: { highlightColor: '#fbbf24' },
  });
  await call('add_text_overlay', {
    projectId,
    text: 'Edited by an AI agent',
    start: 0,
    duration: 2.5,
    transform: { y: -380 },
    style: { fontSize: 56, backgroundColor: '#00000099' },
  });
  await call('get_frames', { projectId, count: 3 });
  const out = await call('export_video', { projectId, quality: 'draft' });
  console.log(`Exported: ${String(out.url)}`);
}
await client.close();
