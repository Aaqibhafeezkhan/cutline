import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type CutlineConfig } from './config';
import { createApp } from './http/app';
import { SyncHub } from './http/ws';
import { log } from './log';
import { createServices, type ServiceOverrides, type Services } from './services';

export interface RunningServer {
  url: string;
  port: number;
  services: Services;
  http: Server;
  close(): Promise<void>;
}

/** Starts the HTTP API, WebSocket sync hub and MCP endpoint in one process. */
export async function startServer(
  configOverrides: Partial<CutlineConfig> = {},
  overrides: ServiceOverrides = {},
): Promise<RunningServer> {
  const config = loadConfig(configOverrides);
  const services = createServices(config, overrides);
  const { app, close: closeMcp } = createApp(services);
  const http = createServer(app);
  const hub = new SyncHub(services);
  hub.attach(http);

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const shownHost = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host;
  const url = `http://${shownHost}:${port}`;
  const ff = await services.ffmpeg.detect();
  if (!ff.available) {
    log.warn(
      'ffmpeg not found: perception tools and server-side export are disabled until it is installed (or FFMPEG_PATH is set).',
    );
  }
  if (!config.token && ['0.0.0.0', '::'].includes(config.host)) {
    log.warn(
      'Listening on all interfaces without CUTLINE_TOKEN. Set a token before exposing this server.',
    );
  }

  return {
    url,
    port,
    services,
    http,
    async close() {
      hub.close();
      await closeMcp();
      await services.docs.flush();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
