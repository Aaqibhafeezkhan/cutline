import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const FIXTURES = resolve(__dirname, '../../../fixtures/media');

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
export const hasFixtures = existsSync(join(FIXTURES, 'testsrc-5s.mp4'));

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

export async function tempDir(prefix = 'cutline-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export interface ProbeInfo {
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format: { duration: string };
}

export function ffprobe(path: string): ProbeInfo {
  const res = spawnSync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout) as ProbeInfo;
}
