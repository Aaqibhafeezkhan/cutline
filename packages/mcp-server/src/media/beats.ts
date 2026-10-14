/**
 * Pure beat tracking (no ffmpeg, no native code), after D. Ellis, "Beat Tracking by Dynamic
 * Programming" (2007):
 *
 * 1. Onset strength: half-wave rectified spectral flux of the log-compressed magnitude spectrum
 *    (Hann window, ~10 ms hop), with the local mean removed.
 * 2. Tempo: autocorrelation of the onset envelope over the allowed BPM range, weighted towards
 *    80–160 BPM to avoid octave errors, refined to a fractional lag.
 * 3. Beats: dynamic programming that trades onset strength against deviations from the tempo,
 *    then each beat is refined to the nearest onset peak (sub-frame) and the BPM is re-estimated
 *    from the beat times.
 */

/** Analysis sample rate: enough bandwidth for onsets, cheap to decode and process. */
export const BEAT_SAMPLE_RATE = 11025;

export interface BeatOptions {
  /** Lowest tempo considered (default 60). */
  minBpm?: number;
  /** Highest tempo considered (default 200). */
  maxBpm?: number;
}

export interface BeatAnalysis {
  /** Tempo in beats per minute (0 if no steady beat was found). */
  bpm: number;
  /** 0..1: how periodic the onsets are at that tempo. */
  confidence: number;
  /** Beat times in seconds (source time of the analysed audio). */
  beats: number[];
  /** Likely first beats of a bar, assuming 4/4. Omitted when unclear. */
  downbeats?: number[];
  /** Length of the analysed audio in seconds. */
  duration: number;
}

const FRAME = 512;
const HOP = 110;
/** Tightness of the DP tempo constraint (librosa's default). */
const TIGHTNESS = 100;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** In-place iterative radix-2 FFT; `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export interface OnsetEnvelope {
  /** Onset strength per frame (>= 0). */
  values: Float64Array;
  /** Seconds between frames. */
  hopSec: number;
  /** Time of frame 0 in seconds. */
  offsetSec: number;
}

/** Spectral-flux onset strength envelope of mono PCM. */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): OnsetEnvelope {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2;
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[base + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      if (f > 0) sum += Math.max(0, cur[k]! - prev[k]!);
    }
    flux[f] = sum;
    [prev, cur] = [cur, prev];
  }
  // Remove the slowly varying part (~0.4 s moving average) so sustained loudness doesn't count.
  const half = 20;
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i]! + flux[i]!;
  const values = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(frames, i + half + 1);
    values[i] = Math.max(0, flux[i]! - (prefix[hi]! - prefix[lo]!) / (hi - lo));
  }
  // Flux of a percussive onset peaks when it is three quarters into the window.
  return { values, hopSec: HOP / sampleRate, offsetSec: (FRAME * 3) / 4 / sampleRate };
}

/** Parabolic interpolation of a peak at index i: returns the fractional offset in [-0.5, 0.5]. */
function parabolic(a: number, b: number, c: number): number {
  const denom = a - 2 * b + c;
  if (denom >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}

/** Tempo prior: log-Gaussian around 120 BPM, one octave wide (favours 80–160). */
const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);

/**
 * Estimates the beat period (in frames, fractional) from the onset envelope.
 * Returns null when there is no periodicity at all.
 */
export function estimatePeriod(
  env: Float64Array,
  hopSec: number,
  minBpm: number,
  maxBpm: number,
): { period: number; confidence: number } | null {
  const n = env.length;
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopSec)));
  const maxLag = Math.ceil(60 / (minBpm * hopSec));
  if (n < maxLag * 2) return null;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const x = Float64Array.from(env, (v) => v - mean);
  let zero = 0;
  for (const v of x) zero += v * v;
  if (zero <= 1e-12) return null;
  zero /= n;
  const acf = new Float64Array(maxLag + 2);
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i]! * x[i - lag]!;
    acf[lag] = s / (n - lag);
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = acf[lag]! * prior(60 / (lag * hopSec));
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (acf[best]! <= 0) return null;
  const period = best + parabolic(acf[best - 1]!, acf[best]!, acf[best + 1]!);
  return { period, confidence: Math.max(0, Math.min(1, acf[best]! / zero)) };
}

/** Ellis' dynamic-programming beat tracker. Returns beat frame indices. */
export function trackBeats(env: Float64Array, period: number): number[] {
  const n = env.length;
  let sq = 0;
  for (const v of env) sq += v * v;
  const norm = Math.sqrt(sq / n) || 1;
  const local = Float64Array.from(env, (v) => v / norm);
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = -Infinity;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p]! - TIGHTNESS * Math.log((t - p) / period) ** 2;
      if (v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = local[t]! + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestVal > 0 ? bestPrev : -1;
  }
  // Last beat: the best-scoring frame within the final period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) beats.push(t);
  beats.reverse();
  // Trim beats at the edges that sit on (near-)silence.
  const threshold = 0.5 * Math.sqrt(sq / n);
  const strength = (b: number) => {
    let m = 0;
    for (let i = Math.max(0, b - 2); i <= Math.min(n - 1, b + 2); i++) m = Math.max(m, env[i]!);
    return m;
  };
  let first = 0;
  let last = beats.length - 1;
  while (first <= last && strength(beats[first]!) < threshold) first++;
  while (last >= first && strength(beats[last]!) < threshold) last--;
  return beats.slice(first, last + 1);
}

/** Moves a beat frame to the nearest onset peak (±2 frames), with sub-frame precision. */
function refine(env: Float64Array, b: number): number {
  let peak = b;
  for (let i = Math.max(1, b - 2); i <= Math.min(env.length - 2, b + 2); i++) {
    if (env[i]! > env[peak]!) peak = i;
  }
  if (peak <= 0 || peak >= env.length - 1) return peak;
  return peak + parabolic(env[peak - 1]!, env[peak]!, env[peak + 1]!);
}

/** Tempo from beat times: least squares over beat indices (robust to a skipped beat). */
function fitBpm(times: number[], fallback: number): number {
  if (times.length < 4) return fallback;
  const intervals = times.slice(1).map((t, i) => t - times[i]!);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const idx = times.map((t) => Math.round((t - times[0]!) / median));
  const m = idx.length;
  const mx = idx.reduce((s, v) => s + v, 0) / m;
  const my = times.reduce((s, v) => s + v, 0) / m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    num += (idx[i]! - mx) * (times[i]! - my);
    den += (idx[i]! - mx) ** 2;
  }
  return den > 0 && num > 0 ? 60 / (num / den) : fallback;
}

/** Bar phase assuming 4/4: the beat position (0..3) with the strongest onsets, if clear. */
function downbeatPhase(env: Float64Array, frames: number[]): number | null {
  if (frames.length < 8) return null;
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  frames.forEach((f, i) => {
    sums[i % 4]! += env[Math.round(f)] ?? 0;
    counts[i % 4]!++;
  });
  const means = sums.map((s, i) => s / Math.max(1, counts[i]!));
  const best = means.indexOf(Math.max(...means));
  const others = means.filter((_, i) => i !== best);
  const rest = others.reduce((s, v) => s + v, 0) / others.length;
  return means[best]! > rest * 1.1 ? best : null;
}

/** Full analysis: onset envelope → tempo → beat grid (and downbeats when clear). */
export function detectBeats(
  pcm: Float32Array,
  sampleRate: number,
  options: BeatOptions = {},
): BeatAnalysis {
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;
  const duration = round3(pcm.length / sampleRate);
  const empty: BeatAnalysis = { bpm: 0, confidence: 0, beats: [], duration };
  const onset = onsetEnvelope(pcm, sampleRate);
  const tempo = estimatePeriod(onset.values, onset.hopSec, minBpm, maxBpm);
  if (!tempo) return empty;
  const frames = trackBeats(onset.values, tempo.period).map((b) => refine(onset.values, b));
  if (frames.length < 2) return empty;
  const toTime = (f: number) => Math.max(0, f * onset.hopSec + onset.offsetSec);
  const times = frames.map(toTime);
  const bpm = Math.round(fitBpm(times, 60 / (tempo.period * onset.hopSec)) * 100) / 100;
  const phase = downbeatPhase(onset.values, frames);
  return {
    bpm,
    confidence: Math.round(tempo.confidence * 100) / 100,
    beats: times.map(round3),
    ...(phase !== null && {
      downbeats: times.filter((_, i) => i % 4 === phase).map(round3),
    }),
    duration,
  };
}

/** Beats of a clip's source window mapped to timeline time (follows speed and reverse). */
export function beatsInClip(
  beats: readonly number[],
  clip: {
    start: number;
    duration: number;
    sourceStart: number;
    speed?: number;
    reverse?: boolean;
    freeze?: boolean;
  },
): number[] {
  const speed = clip.freeze ? 0 : (clip.speed ?? 1);
  if (speed === 0) return [];
  const end = clip.sourceStart + clip.duration * speed;
  return beats
    .filter((b) => b >= clip.sourceStart - 1e-6 && b < end - 1e-6)
    .map((b) => {
      const offset = (b - clip.sourceStart) / speed;
      return round3(clip.start + (clip.reverse ? clip.duration - offset : offset));
    })
    .sort((a, b) => a - b);
}
