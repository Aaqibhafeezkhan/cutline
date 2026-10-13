import type { AudioSampleSink } from 'mediabunny';
import type { PcmChunk } from '../audio/mix';

/** Decodes [from, to) of an audio track into planar float chunks. */
export async function* decodePcm(
  sink: AudioSampleSink,
  from: number,
  to: number,
): AsyncGenerator<PcmChunk> {
  for await (const sample of sink.samples(from, to)) {
    try {
      const channels: Float32Array[] = [];
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const data = new Float32Array(sample.numberOfFrames);
        sample.copyTo(data, { planeIndex: c, format: 'f32-planar' });
        channels.push(data);
      }
      yield { channels, sampleRate: sample.sampleRate, timestamp: sample.timestamp };
    } finally {
      sample.close();
    }
  }
}
