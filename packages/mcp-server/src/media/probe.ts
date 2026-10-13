import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { CutlineError, type AssetKind } from '@cutline/core';
import type { Ffmpeg } from './ffmpeg';

export interface ProbeResult {
  kind: AssetKind;
  mimeType: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
};

export function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return IMAGE_TYPES[ext] ?? MEDIA_TYPES[ext] ?? 'application/octet-stream';
}

/** Width/height from PNG, JPEG, GIF or WebP headers. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ')
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function readHead(path: string, bytes = 256 * 1024): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function probeWithMediabunny(path: string): Promise<ProbeResult | null> {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) return null;
    let fps: number | null = null;
    if (video) {
      const stats = await video.computePacketStats(120);
      fps = stats.averagePacketRate > 0 ? Math.round(stats.averagePacketRate * 1000) / 1000 : null;
    }
    return {
      kind: video ? 'video' : 'audio',
      mimeType: await input.getMimeType(),
      duration: await input.computeDuration(),
      width: video ? await video.getDisplayWidth() : null,
      height: video ? await video.getDisplayHeight() : null,
      fps,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video ? await video.getCodec() : null,
      audioCodec: audio ? await audio.getCodec() : null,
    };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  return n && d ? Math.round((n / d) * 1000) / 1000 : null;
}

async function probeWithFfprobe(path: string, ffmpeg: Ffmpeg): Promise<ProbeResult | null> {
  try {
    const info = await ffmpeg.probe(path);
    const streams = info.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!video && !audio) return null;
    const duration = Number(info.format?.duration ?? video?.duration ?? audio?.duration);
    return {
      kind: video ? 'video' : 'audio',
      mimeType: guessMimeType(path),
      duration: Number.isFinite(duration) ? duration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    };
  } catch {
    return null;
  }
}

/** Identifies a media file: still image, video (with/without audio) or audio. */
export async function probeFile(path: string, ffmpeg: Ffmpeg): Promise<ProbeResult> {
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    const size = imageSize(await readHead(path));
    if (size) {
      return {
        kind: 'image',
        mimeType: IMAGE_TYPES[ext]!,
        duration: null,
        width: size.width,
        height: size.height,
        fps: null,
        hasVideo: true,
        hasAudio: false,
        videoCodec: null,
        audioCodec: null,
      };
    }
  }
  const result = (await probeWithMediabunny(path)) ?? (await probeWithFfprobe(path, ffmpeg));
  if (!result || (result.duration ?? 0) <= 0) {
    throw new CutlineError('INVALID_ARGUMENT', `Unsupported or unreadable media file "${path}".`, {
      hint: 'Supported: MP4/MOV/WebM/MKV video, MP3/WAV/AAC/OGG/FLAC audio, PNG/JPEG/GIF/WebP images.',
    });
  }
  return result;
}
