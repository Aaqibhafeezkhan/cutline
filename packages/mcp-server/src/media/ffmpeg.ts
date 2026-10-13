import { spawn } from 'node:child_process';
import { CutlineError } from '@cutline/core';

export interface FfmpegInfo {
  available: boolean;
  version: string | null;
  major: number | null;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with the output time (seconds) parsed from `-progress`. */
  onProgress?: (seconds: number) => void;
  /** Collect stdout as a Buffer. */
  captureStdout?: boolean;
}

const STDERR_TAIL = 4000;

/** Thin wrapper around the system ffmpeg/ffprobe binaries (never bundled). */
export class Ffmpeg {
  private info: Promise<FfmpegInfo> | null = null;

  constructor(
    readonly ffmpegPath: string,
    readonly ffprobePath: string,
  ) {}

  /** Detects ffmpeg once; never throws. */
  detect(): Promise<FfmpegInfo> {
    this.info ??= new Promise<FfmpegInfo>((resolve) => {
      const child = spawn(this.ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', () => resolve({ available: false, version: null, major: null }));
      child.on('close', (code) => {
        const m = /ffmpeg version n?(\d+)(?:\.(\d+))?\S*/.exec(out);
        resolve({
          available: code === 0,
          version: m ? m[0].replace('ffmpeg version ', '') : null,
          major: m ? Number(m[1]) : null,
        });
      });
    });
    return this.info;
  }

  async require(feature: string): Promise<FfmpegInfo> {
    const info = await this.detect();
    if (!info.available) {
      throw new CutlineError('INVALID_OPERATION', `${feature} needs ffmpeg, which was not found.`, {
        hint: `Install ffmpeg and put it on PATH (or set FFMPEG_PATH), then restart the Cutline server. Tried "${this.ffmpegPath}".`,
      });
    }
    return info;
  }

  /** Runs ffmpeg with `args`; rejects with the stderr tail on failure. */
  run(args: string[], options: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const progressArgs = options.onProgress ? ['-progress', 'pipe:2', '-nostats'] : [];
      const child = spawn(this.ffmpegPath, ['-hide_banner', '-nostdin', ...progressArgs, ...args], {
        windowsHide: true,
        signal: options.signal,
      });
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        if (options.captureStdout) chunks.push(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-STDERR_TAIL * 4);
        if (options.onProgress) {
          for (const m of text.matchAll(/out_time_us=(\d+)/g))
            options.onProgress(Number(m[1]) / 1e6);
        }
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
        else {
          const tail = stderr
            .split('\n')
            .filter(
              (l) =>
                l &&
                !/^(frame|fps|stream_|bitrate|total_size|out_time|dup_frames|drop_frames|speed|progress)=/.test(
                  l,
                ),
            )
            .slice(-15)
            .join('\n');
          reject(new Error(`ffmpeg exited with code ${code}:\n${tail.slice(-STDERR_TAIL)}`));
        }
      });
    });
  }

  /** Decodes the first audio stream to mono float PCM at `sampleRate`. */
  async decodePcm(path: string, sampleRate = 16000, signal?: AbortSignal): Promise<Float32Array> {
    await this.require('Audio analysis');
    const { stdout } = await this.run(
      [
        '-i',
        path,
        '-vn',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        'f32le',
        'pipe:1',
      ],
      { captureStdout: true, signal },
    );
    const aligned = new Uint8Array(stdout.byteLength - (stdout.byteLength % 4));
    aligned.set(stdout.subarray(0, aligned.byteLength));
    return new Float32Array(aligned.buffer);
  }

  /** Timestamps (seconds) where the picture changes by more than `threshold` (0..1). */
  async sceneChanges(path: string, threshold: number, signal?: AbortSignal): Promise<number[]> {
    await this.require('Scene detection');
    const { stderr } = await this.run(
      ['-i', path, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
      { signal },
    );
    return [...stderr.matchAll(/showinfo.*?pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  }

  /** EBU R128 integrated loudness and true peak of `duration` seconds from `start`. */
  async loudness(
    path: string,
    start: number,
    duration: number,
    signal?: AbortSignal,
  ): Promise<Loudness> {
    await this.require('Loudness measurement');
    const { stderr } = await this.run(
      [
        '-ss',
        String(start),
        '-t',
        String(duration),
        '-i',
        path,
        '-vn',
        '-map',
        '0:a:0',
        '-af',
        'ebur128=peak=true',
        '-f',
        'null',
        '-',
      ],
      { signal },
    );
    return parseEbur128(stderr);
  }

  /** One JPEG frame of a source file at `time` seconds, `width` px wide. */
  async frameAt(path: string, time: number, width: number): Promise<Buffer> {
    await this.require('Frame extraction');
    const { stdout } = await this.run(
      [
        '-ss',
        String(time),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '4',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { captureStdout: true },
    );
    return stdout;
  }

  /** ffprobe JSON for a file (format + streams). */
  probe(path: string): Promise<FfprobeResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { windowsHide: true },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited with ${code}`));
        try {
          resolve(JSON.parse(out) as FfprobeResult);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
  }
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

export interface Loudness {
  /** Integrated loudness in LUFS (-70 or below = silence). */
  integrated: number;
  /** True peak in dBTP (null if ffmpeg did not report it). */
  truePeak: number | null;
}

/** Parses the summary that the ebur128 filter prints when it finishes. */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-inf|-?[\d.]+)\s+LUFS/.exec(summary);
  if (!integrated) throw new Error('ffmpeg ebur128 did not report an integrated loudness.');
  const peak = /True peak:\s+Peak:\s+(-?[\d.]+)\s+dBFS/.exec(summary);
  // -inf (digital silence) is reported as the -70 LUFS gate so the value stays JSON-safe.
  return {
    integrated: integrated[1] === '-inf' ? -70 : Math.max(-70, Number(integrated[1])),
    truePeak: peak ? Number(peak[1]) : null,
  };
}

/** Escapes a value for use inside a single-quoted ffmpeg filter argument. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');
}
