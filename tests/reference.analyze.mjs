/* Optional local benchmark for mixed TF2 recordings. The reference audio is
 * intentionally not committed. Usage:
 *   pnpm analyze:reference "C:\\path\\to\\recording.mp3"
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { MPEGDecoder } from 'mpg123-decoder';

const filename = process.argv[2];
if (!filename) {
  console.error('Usage: pnpm analyze:reference <recording.mp3>');
  process.exit(2);
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const db = (value) => 10 * Math.log10(Math.max(1e-15, value));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
};

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wLenR = Math.cos(angle), wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i + j], uI = im[i + j];
        const k = i + j + len / 2;
        const vR = re[k] * wr - im[k] * wi;
        const vI = re[k] * wi + im[k] * wr;
        re[i + j] = uR + vR; im[i + j] = uI + vI;
        re[k] = uR - vR; im[k] = uI - vI;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR; wr = nextWr;
      }
    }
  }
}

function spectralFeatures(samples, sideSamples, center, sampleRate, fftSize = 4096) {
  const powers = new Float64Array(fftSize / 2);
  // Average raw spectral power across the 0.5 s window before calculating
  // BOTH band shares and rolloff. Averaging percentiles separately is invalid.
  for (const fraction of [-0.35, 0, 0.35]) {
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    const sideRe = new Float64Array(fftSize), sideIm = new Float64Array(fftSize);
    const start = clamp(Math.round(center + fraction * 0.5 * sampleRate - fftSize / 2),
      0, Math.max(0, samples.length - fftSize));
    for (let i = 0; i < fftSize; i++) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
      re[i] = (samples[start + i] || 0) * window;
      sideRe[i] = (sideSamples[start + i] || 0) * window;
    }
    fft(re, im); fft(sideRe, sideIm);
    for (let bin = 1; bin < powers.length; bin++) {
      const midPower = re[bin] ** 2 + im[bin] ** 2;
      const sidePower = sideRe[bin] ** 2 + sideIm[bin] ** 2;
      // Center emphasis, NOT voice separation: centered game audio survives.
      powers[bin] += midPower > sidePower * 10 ? Math.max(0, midPower - sidePower) / 3 : 0;
    }
  }
  const edges = [0, 120, 300, 1000, 3000, 5000, 8000, 12000, sampleRate / 2];
  const bands = new Array(edges.length - 1).fill(0);
  const total = powers.reduce((sum, value) => sum + value, 0);
  let cumulative = 0, rolloff95 = 0, rolloff99 = 0;
  for (let bin = 1; bin < powers.length; bin++) {
    const frequency = bin * sampleRate / fftSize;
    const power = powers[bin];
    for (let band = 0; band < bands.length; band++) {
      if (frequency >= edges[band] && frequency < edges[band + 1]) { bands[band] += power; break; }
    }
    cumulative += power;
    if (total > 0 && !rolloff95 && cumulative >= total * 0.95) rolloff95 = frequency;
    if (total > 0 && !rolloff99 && cumulative >= total * 0.99) rolloff99 = frequency;
  }
  return { bands: bands.map(value => value / Math.max(total, 1e-15)), rolloff95, rolloff99 };
}

function timeEnergy(samples, start, length) {
  let sum = 0, peak = 0, clipped = 0;
  const end = Math.min(samples.length, start + length);
  for (let i = start; i < end; i++) {
    const value = samples[i];
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= 0.99) clipped++;
  }
  const count = Math.max(1, end - start);
  return { energy: sum / count, peak, clipped: clipped / count };
}

const decoder = new MPEGDecoder();
await decoder.ready;
const encoded = new Uint8Array(fs.readFileSync(filename));
const decoded = decoder.decode(encoded);
decoder.free();
if (!decoded.channelData.length || !decoded.samplesDecoded) throw new Error('The recording decoded to no audio.');

const sampleRate = decoded.sampleRate;
const channels = decoded.channelData;
const length = decoded.samplesDecoded;
const mid = new Float32Array(length);
const side = new Float32Array(length);
const left = channels[0];
const right = channels[1] || channels[0];
let correlationNumerator = 0, leftEnergy = 0, rightEnergy = 0;
for (let i = 0; i < length; i++) {
  mid[i] = (left[i] + right[i]) * 0.5;
  side[i] = (left[i] - right[i]) * 0.5;
  correlationNumerator += left[i] * right[i];
  leftEnergy += left[i] * left[i]; rightEnergy += right[i] * right[i];
}

const windowSeconds = 0.5;
const hopSeconds = 0.25;
const windowSamples = Math.round(windowSeconds * sampleRate);
const hopSamples = Math.round(hopSeconds * sampleRate);
const windows = [];
for (let start = 0; start + windowSamples <= length; start += hopSamples) {
  const midStats = timeEnergy(mid, start, windowSamples);
  const sideStats = timeEnergy(side, start, windowSamples);
  const spectral = spectralFeatures(mid, side, start + windowSamples / 2, sampleRate);
  const speechShare = spectral.bands[2] + spectral.bands[3] + spectral.bands[4]; // 300 Hz–5 kHz
  const presenceShare = spectral.bands[5] + spectral.bands[6]; // 5–12 kHz
  const sideDb = db(sideStats.energy / Math.max(midStats.energy, 1e-15));
  const levelDb = db(midStats.energy);
  // Centered, active, speech-band-heavy windows are the best available proxy
  // for voice when game audio is baked into the same recording.
  const score = clamp((levelDb + 48) / 28, 0, 1) * 2
    + clamp((-sideDb - 3) / 22, 0, 1) * 2
    + clamp((speechShare - 0.32) / 0.5, 0, 1) * 2
    + clamp((presenceShare - 0.01) / 0.18, 0, 1) * 0.5
    - clamp(spectral.bands[0] / 0.2, 0, 1);
  windows.push({
    start: start / sampleRate, score, levelDb, sideDb,
    speechShare, presenceShare, highShare: spectral.bands[7] || 0,
    rolloff95: spectral.rolloff95, rolloff99: spectral.rolloff99,
    peak: midStats.peak, clipped: midStats.clipped
  });
}

const candidates = [];
for (const window of [...windows].sort((a, b) => b.score - a.score)) {
  if (candidates.every((chosen) => Math.abs(chosen.start - window.start) >= 1.25)) candidates.push(window);
  if (candidates.length === 12) break;
}
candidates.sort((a, b) => a.start - b.start);

const blockSamples = Math.round(sampleRate * 0.02);
const blockLevels = [];
let totalClipped = 0;
for (let start = 0; start < length; start += blockSamples) {
  const stats = timeEnergy(mid, start, blockSamples);
  blockLevels.push(db(stats.energy));
  totalClipped += stats.clipped * Math.min(blockSamples, length - start);
}

const candidateSummary = {
  medianLevelDbfs: median(candidates.map((item) => item.levelDb)),
  medianSideDb: median(candidates.map((item) => item.sideDb)),
  medianSpeechBandPct: median(candidates.map((item) => item.speechShare)) * 100,
  medianPresence5To12kPct: median(candidates.map((item) => item.presenceShare)) * 100,
  medianAbove12kPct: median(candidates.map((item) => item.highShare)) * 100,
  medianRolloff95Hz: median(candidates.map((item) => item.rolloff95)),
  medianRolloff99Hz: median(candidates.map((item) => item.rolloff99))
};

const highBandCandidates = windows
  .filter((item) => item.levelDb > -32 && item.sideDb < -10 && item.speechShare > 0.55)
  .sort((a, b) => (b.presenceShare + b.highShare) - (a.presenceShare + a.highShare))
  .slice(0, 8);
const report = {
  file: path.basename(filename),
  sourceUrl: process.argv[3] || null,
  decoderErrors: decoded.errors || [],
  format: {
    sampleRate, channels: channels.length,
    durationSeconds: length / sampleRate,
    stereoCorrelation: correlationNumerator / Math.sqrt(Math.max(1e-15, leftEnergy * rightEnergy))
  },
  dynamics: {
    quietP10Dbfs: percentile(blockLevels, 0.10),
    median20msDbfs: median(blockLevels),
    activeP90Dbfs: percentile(blockLevels, 0.90),
    clippedSamplePct: totalClipped / length * 100
  },
  centeredCandidateSummary: candidateSummary,
  assessment: {
    codecSampleRate: 'not identifiable from this mixed recording',
    codecBitrate: 'not identifiable from this mixed recording',
    captureFilterCutoff: 'not identifiable from energy rolloff',
    caveat: 'Centered game sounds also pass the mid/side gate. These are listening candidates, not isolated or verified VOIP. No preset is calibrated automatically.'
  },
  centeredCandidates: candidates.map((item) => ({
    startSeconds: Number(item.start.toFixed(2)),
    levelDbfs: Number(item.levelDb.toFixed(1)),
    sideDb: Number(item.sideDb.toFixed(1)),
    speechBandPct: Number((item.speechShare * 100).toFixed(1)),
    presence5To12kPct: Number((item.presenceShare * 100).toFixed(2)),
    above12kPct: Number((item.highShare * 100).toFixed(2)),
    rolloff99Hz: Math.round(item.rolloff99)
  })),
  strongestCenteredHighBandWindows: highBandCandidates.map((item) => ({
    startSeconds: Number(item.start.toFixed(2)),
    sideDb: Number(item.sideDb.toFixed(1)),
    speechBandPct: Number((item.speechShare * 100).toFixed(1)),
    presence5To12kPct: Number((item.presenceShare * 100).toFixed(2)),
    above12kPct: Number((item.highShare * 100).toFixed(2)),
    rolloff99Hz: Math.round(item.rolloff99)
  }))
};

console.log(JSON.stringify(report, null, 2));
