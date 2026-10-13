// Dev-only playground for @cutline/engine: builds a project from the generated
// fixtures and exposes window.cutlineDemo for manual and automated checks.
import { applyOperations, createProject, type Project } from '@cutline/core';
import { Player, exportVideo, probeMedia } from '@cutline/engine';

const FIXTURES = '/@fs/' + __FIXTURES_DIR__.replace(/^\//, '');
const status = document.getElementById('status')!;
const canvas = document.getElementById('preview') as HTMLCanvasElement;

async function buildProject(): Promise<Project> {
  const files = ['testsrc-5s.mp4', 'beeps-12s.mp4', 'still.png'];
  const probes = await Promise.all(
    files.map(async (f) => {
      if (f.endsWith('.png')) return null;
      const blob = await (await fetch(`${FIXTURES}/${f}`)).blob();
      return probeMedia(blob);
    }),
  );
  const asset = (id: string, file: string, i: number) => {
    const p = probes[i];
    return {
      id,
      name: file,
      kind: p ? ('video' as const) : ('image' as const),
      src: `${FIXTURES}/${file}`,
      mimeType: p?.mimeType ?? 'image/png',
      duration: p?.duration ?? null,
      width: p?.width ?? 640,
      height: p?.height ?? 360,
      hasVideo: true,
      hasAudio: p?.hasAudio ?? false,
    };
  };
  const base = createProject({ name: 'Engine demo', settings: { width: 1280, height: 720 } });
  return applyOperations(base, [
    { type: 'add_asset', asset: asset('test', files[0]!, 0) },
    { type: 'add_asset', asset: asset('beeps', files[1]!, 1) },
    { type: 'add_asset', asset: asset('still', files[2]!, 2) },
    { type: 'add_clip', assetId: 'test', start: 0, duration: 3, id: 'a' },
    { type: 'add_clip', assetId: 'beeps', start: 3, duration: 3, sourceStart: 1, id: 'b' },
    { type: 'set_transition', clipId: 'b', transition: { type: 'crossfade', duration: 1 } },
    {
      type: 'add_clip',
      assetId: 'still',
      start: 1,
      duration: 4,
      id: 'pip',
      props: { transform: { x: 420, y: -200, scale: 0.25 }, effects: { saturation: -1 } },
    },
    {
      type: 'add_text',
      text: 'Cutline engine',
      start: 0.5,
      duration: 4,
      transform: { y: 250 },
      style: { backgroundColor: '#00000099' },
    },
    {
      type: 'add_captions',
      cues: [
        {
          start: 0,
          end: 2.5,
          text: 'Hello from the timeline',
          words: [
            { text: 'Hello', start: 0, end: 0.5 },
            { text: 'from', start: 0.5, end: 1 },
            { text: 'the', start: 1, end: 1.5 },
            { text: 'timeline', start: 1.5, end: 2.5 },
          ],
        },
        { start: 2.5, end: 6, text: 'Rendered with WebGL' },
      ],
      style: { highlightColor: '#fbbf24' },
    },
  ]).project;
}

const project = await buildProject();
const locator = { url: (a: { src: string }) => new URL(a.src, location.href).href, useOpfs: false };
const player = await Player.create({
  canvas,
  locator,
  onTimeUpdate: (t) => (status.textContent = `t=${t.toFixed(2)}s`),
});
player.setProject(project);
await player.renderFrame(1.5);
status.textContent = 'ready';

document.getElementById('play')!.onclick = () => void player.toggle();
document.getElementById('export')!.onclick = async () => {
  const result = await exportVideo(project, locator, {
    width: 640,
    onProgress: (p) => (status.textContent = `${p.phase} ${(p.progress * 100).toFixed(0)}%`),
  });
  status.textContent = `exported ${(result.blob.size / 1024).toFixed(0)} KiB (${result.videoCodec}/${result.audioCodec})`;
};

declare global {
  interface Window {
    cutlineDemo: unknown;
  }
}
window.cutlineDemo = { project, player, exportVideo: (o = {}) => exportVideo(project, locator, o) };
