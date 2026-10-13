#!/usr/bin/env node
// Generates small synthetic test media with ffmpeg (lavfi sources only).
// Everything produced here is original, generated content released under CC0.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures', 'media');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const force = process.argv.includes('--force');

mkdirSync(outDir, { recursive: true });

const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '28'];
const aac = ['-c:a', 'aac', '-b:a', '96k', '-ar', '48000'];

/** @type {Record<string, string[]>} */
const fixtures = {
  // 5 s test pattern with a 440 Hz tone.
  'testsrc-5s.mp4': [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=5',
    ...h264,
    ...aac,
    '-shortest',
    '-movflags',
    '+faststart',
  ],
  // 12 s clip whose audio alternates 2 s of tone with 1 s of silence:
  // tone [0,2) silence [2,3) tone [3,5) silence [5,6) ... Used by silence detection tests.
  'beeps-12s.mp4': [
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=640x360:rate=30:duration=12',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.5*sin(2*PI*330*t)*lt(mod(t\\,3)\\,2)':s=48000:d=12",
    ...h264,
    ...aac,
    '-shortest',
    '-movflags',
    '+faststart',
  ],
  // Three 2 s shots with different content (test pattern, Mandelbrot zoom, HD bars):
  // hard cuts at 2 s and 4 s. Used by scene detection tests.
  'scenes-6s.mp4': [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'mandelbrot=size=640x360:rate=30,trim=duration=2',
    '-f',
    'lavfi',
    '-i',
    'smptehdbars=size=640x360:rate=30:duration=2',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    ...h264,
    '-movflags',
    '+faststart',
  ],
  // 3 s audio-only tone.
  'tone-3s.wav': [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523.25:sample_rate=48000:duration=3',
    '-c:a',
    'pcm_s16le',
  ],
  // 8 s click track at 120 BPM: a decaying 1 kHz click every 0.5 s starting at 0.25 s.
  // Used by beat detection tests.
  'clicks-120bpm-8s.wav': [
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.8*sin(2*PI*1000*t)*exp(-mod(t+0.25\\,0.5)/0.006)':s=44100:d=8",
    '-c:a',
    'pcm_s16le',
  ],
  // Still image.
  'still.png': ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1:duration=1', '-frames:v', '1'],
};

let failed = false;
for (const [name, args] of Object.entries(fixtures)) {
  const out = join(outDir, name);
  if (existsSync(out) && !force) {
    console.log(`✓ ${name} (exists)`);
    continue;
  }
  const res = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], {
    stdio: 'inherit',
  });
  if (res.error) {
    console.error(`✗ could not run ffmpeg (${ffmpeg}): ${res.error.message}`);
    console.error('  Install ffmpeg and put it on PATH, or set FFMPEG_PATH.');
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✗ ${name} failed`);
    failed = true;
  } else {
    console.log(`✓ ${name}`);
  }
}
if (failed) process.exit(1);
console.log(`Fixtures in ${outDir}`);
