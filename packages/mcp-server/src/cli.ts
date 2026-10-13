import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadDotEnv, workspaceRoot } from './config';
import { log } from './log';
import { createMcpServer } from './mcp/server';
import { startServer } from './server';
import { VERSION } from './version';

const HELP = `cutline-mcp ${VERSION}

Usage:
  cutline-mcp [options]          Start the Cutline server (HTTP API, WebSocket sync, MCP at /mcp)
  cutline-mcp --stdio [options]  Serve MCP over stdio (for Claude Desktop & co.). Bridges to a
                                 running Cutline server if there is one, otherwise starts one.

Options:
  --port <n>        HTTP port (default 4100, env CUTLINE_PORT)
  --host <host>     Bind address (default 127.0.0.1, env CUTLINE_HOST)
  --data-dir <dir>  Where projects and media are stored (env CUTLINE_DATA_DIR)
  --serve-web       Also serve the built editor UI (apps/web/dist or CUTLINE_WEB_DIST)
  -h, --help        Show this help
`;

/** --serve-web: serve the built editor from this server (apps/web/dist unless CUTLINE_WEB_DIST is set). */
function serveWeb(): void {
  const dist =
    process.env.CUTLINE_WEB_DIST ??
    [workspaceRoot(), resolve(import.meta.dirname, '../../../apps/web/dist')]
      .filter((p): p is string => Boolean(p))
      .map((p) => (p.endsWith('dist') ? p : join(p, 'apps/web/dist')))
      .find((p) => existsSync(join(p, 'index.html')));
  if (!dist) {
    log.warn('--serve-web: no built editor found. Run `pnpm build` first or set CUTLINE_WEB_DIST.');
    return;
  }
  process.env.CUTLINE_WEB_DIST = dist;
  process.env.CUTLINE_PUBLIC_URL ??= `http://localhost:${process.env.CUTLINE_PORT ?? 4100}`;
}

async function findRunningServer(base: string, token: string | undefined): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const body = (await res.json()) as { name?: string };
    return res.ok && body.name === 'cutline';
  } catch {
    return false;
  }
}

/** Forwards MCP messages between stdio and a running server's /mcp endpoint. */
async function bridge(base: string, token: string | undefined): Promise<void> {
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  stdio.onmessage = (msg) => {
    http.send(msg).catch((err) => log.error('bridge: forwarding to server failed', err));
  };
  http.onmessage = (msg) => {
    stdio.send(msg).catch((err) => log.error('bridge: forwarding to client failed', err));
  };
  http.onerror = (err) => log.error('bridge: server connection error', err);
  stdio.onclose = () => void http.close().finally(() => process.exit(0));
  http.onclose = () => void stdio.close().finally(() => process.exit(0));
  await http.start();
  await stdio.start();
  log.info(`stdio bridge connected to ${base}/mcp`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      stdio: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
      'data-dir': { type: 'string' },
      'serve-web': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stderr.write(HELP);
    return;
  }
  loadDotEnv();
  if (values.port) process.env.CUTLINE_PORT = values.port;
  if (values.host) process.env.CUTLINE_HOST = values.host;
  if (values['data-dir']) process.env.CUTLINE_DATA_DIR = values['data-dir'];
  if (values['serve-web']) serveWeb();

  const port = Number(process.env.CUTLINE_PORT ?? 4100);
  const host = process.env.CUTLINE_HOST ?? '127.0.0.1';
  const probeHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  const base = `http://${probeHost}:${port}`;
  const token = process.env.CUTLINE_TOKEN || undefined;

  if (values.stdio) {
    if (await findRunningServer(base, token)) {
      await bridge(base, token);
      return;
    }
    const running = await startServer();
    log.info(
      `Cutline server started at ${running.url} (editor: ${running.services.config.publicUrl})`,
    );
    const server = createMcpServer(running.services, { id: 'stdio' });
    const transport = new StdioServerTransport();
    transport.onclose = () => void running.close().finally(() => process.exit(0));
    await server.connect(transport);
    return;
  }

  const running = await startServer();
  log.info(`Cutline ${VERSION} listening on ${running.url}`);
  log.info(`MCP endpoint:  ${running.url}/mcp`);
  log.info(`Editor:        ${running.services.config.publicUrl}`);
  const shutdown = () => {
    log.info('shutting down…');
    void running.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
