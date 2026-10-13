import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export interface MediaProbe {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Whether this browser's WebCodecs can decode the tracks (false → needs a fallback/proxy). */
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
  mimeType: string;
}

/** Reads container metadata of a local file without decoding it. */
export async function probeMedia(file: Blob): Promise<MediaProbe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    return {
      duration: await input.computeDuration(),
      width: video ? await video.getDisplayWidth() : null,
      height: video ? await video.getDisplayHeight() : null,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video ? await video.getCodec() : null,
      audioCodec: audio ? await audio.getCodec() : null,
      canDecodeVideo: video ? await video.canDecode() : false,
      canDecodeAudio: audio ? await audio.canDecode() : false,
      mimeType: await input.getMimeType(),
    };
  } finally {
    input.dispose();
  }
}
