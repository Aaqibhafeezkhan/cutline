/**
 * Optional fallback for media that WebCodecs cannot decode (e.g. ProRes,
 * some HEVC/AVI files): converts the file to H.264/AAC MP4 in the browser
 * with ffmpeg.wasm before uploading.
 *
 * Licensing: the wrapper packages (@ffmpeg/ffmpeg, @ffmpeg/util) are MIT.
 * The ffmpeg core itself (GPL) is NOT bundled; it is downloaded from a CDN
 * only when the user opts in, and runs entirely in their browser.
 */
const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

export async function convertWithFfmpegWasm(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<File> {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ]);
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  try {
    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
    await ffmpeg.writeFile(`input${ext}`, await fetchFile(file));
    const code = await ffmpeg.exec([
      '-i',
      `input${ext}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      'output.mp4',
    ]);
    if (code !== 0) throw new Error(`ffmpeg.wasm failed with exit code ${code}`);
    const data = (await ffmpeg.readFile('output.mp4')) as Uint8Array;
    const name = `${file.name.replace(/\.[^.]+$/, '')}.mp4`;
    return new File([data.slice()], name, { type: 'video/mp4' });
  } finally {
    ffmpeg.terminate();
  }
}
