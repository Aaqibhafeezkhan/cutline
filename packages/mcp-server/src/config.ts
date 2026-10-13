import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export interface CutlineConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Bearer token required on every request when set. */
  token: string | undefined;
  /** Extra hostnames accepted in Host/Origin headers. */
  allowedHosts: string[];
  /** Directories add_asset may read local files from. */
  mediaRoots: string[];
  allowPrivateUrls: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  whisperModel: string;
  /** URL of the editor UI, used in tool results. */
  publicUrl: string;
  /** Built web app to serve at / (production / Docker). */
  webDistDir: string | undefined;
  maxUploadBytes: number;
}

function bool(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

/** Reads .env (if present) and CUTLINE_* environment variables. */
export function loadConfig(
  overrides: Partial<CutlineConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): CutlineConfig {
  const port = Number(env.CUTLINE_PORT ?? 4100);
  const dataDir = resolve(
    env.CUTLINE_DATA_DIR ?? join(workspaceRoot() ?? process.cwd(), '.cutline-data'),
  );
  const roots = env.CUTLINE_MEDIA_ROOTS
    ? env.CUTLINE_MEDIA_ROOTS.split(delimiter).filter(Boolean)
    : [homedir()];
  const config: CutlineConfig = {
    host: env.CUTLINE_HOST ?? '127.0.0.1',
    port,
    dataDir,
    token: env.CUTLINE_TOKEN || undefined,
    allowedHosts: (env.CUTLINE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    mediaRoots: [...roots.map((r) => resolve(r)), dataDir],
    allowPrivateUrls: bool(env.CUTLINE_ALLOW_PRIVATE_URLS),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    whisperModel: env.CUTLINE_WHISPER_MODEL || 'onnx-community/whisper-base_timestamped',
    publicUrl: env.CUTLINE_PUBLIC_URL || `http://localhost:${port === 4100 ? 5173 : port}`,
    webDistDir: env.CUTLINE_WEB_DIST || undefined,
    maxUploadBytes: Number(env.CUTLINE_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    ...overrides,
  };
  return config;
}

/** The monorepo root (directory with pnpm-workspace.yaml) when running from a checkout. */
export function workspaceRoot(from = process.cwd()): string | null {
  let dir = resolve(from);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Loads `.env` from the working directory or the workspace root (Node ≥ 20.12). */
export function loadDotEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const root = workspaceRoot();
  const candidates = ['.env', ...(root ? [join(root, '.env')] : [])];
  const found = candidates.find((p) => existsSync(p));
  if (found) process.loadEnvFile(found);
}
