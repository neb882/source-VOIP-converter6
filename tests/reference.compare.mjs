/* Local-only paired reference comparison. Never redistribute the input audio.
 * This measures a whole playback/capture chain, not isolated codec parameters.
 * Usage: node tests/reference.compare.mjs <recorded.mp3> <source.mp3> [...]
 *
 * Each source is located in the recording, warped onto the recording's clock,
 * rendered through the app at 48 kHz and compared on the properties that
 * identified the real chain (tests/REFERENCE_2026.md): level-matched spectra
 * up to 19 kHz, the receiver clipping signature and short-term level tracking.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { MPEGDecoder } from 'mpg123-decoder';

export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n < 1 || (n & (n - 1)) || im.length !== n) throw new Error('FFT needs equal power-of-two arrays.');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const ar = Math.cos(angle), ai = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const k = i + j + len / 2;
        const vr = re[k] * wr - im[k] * wi, vi = re[k] * wi + im[k] * wr;
        const ur = re[i + j], ui = im[i + j];
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[k] = ur - vr; im[k] = ui - vi;
        const next = wr * ar - wi * ai;
        wi = wr * ai + wi * ar; wr = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export function findMatch(source, template) {
  if (!template.length || source.length < template.length) throw new Error('Invalid matching lengths.');
  let n = 1;
  while (n < source.length + template.length - 1) n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n);
  const tr = new Float64Array(n), ti = new Float64Array(n);
  const sums = new Float64Array(source.length + 1), energy = new Float64Array(source.length + 1);
  let mean = 0, templateEnergy = 0;
  for (const v of template) mean += v / template.length;
  for (let i = 0; i < template.length; i++) { tr[i] = template[i] - mean; templateEnergy += tr[i] ** 2; }
  if (templateEnergy < 1e-15) return { sample: null, correlation: 0 };
  for (let i = 0; i < source.length; i++) {
    re[i] = source[i]; sums[i + 1] = sums[i] + source[i]; energy[i + 1] = energy[i] + source[i] ** 2;
  }
  fft(re, im); fft(tr, ti);
  for (let i = 0; i < n; i++) {
    const r = re[i] * tr[i] + im[i] * ti[i];
    im[i] = im[i] * tr[i] - re[i] * ti[i]; re[i] = r;
  }
  fft(re, im, true);
  let best = { sample: null, correlation: 0 };
  for (let i = 0; i <= source.length - template.length; i++) {
    const sum = sums[i + template.length] - sums[i];
    const e = energy[i + template.length] - energy[i] - sum * sum / template.length;
    if (e < 1e-15) continue;
    const correlation = Math.max(-1, Math.min(1, re[i] / Math.sqrt(e * templateEnergy)));
    if (Math.abs(correlation) > Math.abs(best.correlation)) best = { sample: i, correlation };
  }
  return best;
}

export async function decodeFile(filename) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const result = decoder.decode(new Uint8Array(fs.readFileSync(filename)));
    if (!result.samplesDecoded || result.errors.length) throw new Error(`Could not cleanly decode ${path.basename(filename)}.`);
    return { channels: result.channelData, rate: result.sampleRate, length: result.samplesDecoded };
  } finally { decoder.free(); }
}

export function audioEngine() {
  const sandbox = { window: {}, Blob, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../constants.js', import.meta.url), 'utf8') + '\n' +
    fs.readFileSync(new URL('../audio.js', import.meta.url), 'utf8'), sandbox);
  return { audio: sandbox.window.TF2Audio, sandbox };
}

export function mono(decoded, channel = 'mix') {
  if (channel === 'left') return decoded.channels[0];
  if (channel === 'right') return decoded.channels[1] || decoded.channels[0];
  return Float32Array.from(decoded.channels[0], (_, i) => decoded.channels.reduce((sum, x) => sum + x[i], 0) / decoded.channels.length);
}

const db = power => 10 * Math.log10(Math.max(1e-15, power));
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

// Reject repeated musical phrases unless they support the same continuous
// timeline at three or more positions. Do not present a random maximum
// correlation as a verified match.
export function consistentTimeline(matches) {
  const valid = matches.filter(x => x.sourceStartSeconds !== null && Math.abs(x.correlation) >= .2);
  let selected = [];
  for (const candidate of valid) {
    const offset = candidate.sourceStartSeconds - candidate.referenceStartSeconds;
    const group = valid.filter(x => Math.abs(x.sourceStartSeconds - x.referenceStartSeconds - offset) < .15);
    if (group.length > selected.length) selected = group;
  }
  if (selected.length < 3) return null;
  const slopes = [];
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const dt = selected[j].referenceStartSeconds - selected[i].referenceStartSeconds;
    if (Math.abs(dt) >= 8) slopes.push((selected[j].sourceStartSeconds - selected[i].sourceStartSeconds) / dt);
  }
  const scale = percentile(slopes, .5) ?? 1;
  const offset = percentile(selected.map(x => x.sourceStartSeconds - scale * x.referenceStartSeconds), .5);
  return { scale, offsetSeconds: offset, matches: selected.length,
    firstReferenceSeconds: Math.min(...selected.map(x => x.referenceStartSeconds)),
    lastReferenceSeconds: Math.max(...selected.map(x => x.referenceStartSeconds)),
    medianAbsoluteCorrelation: percentile(selected.map(x => Math.abs(x.correlation)), .5) };
}

export const BAND_EDGES = [40, 80, 120, 200, 300, 500, 1000, 2000, 3000, 5000, 8000, 10000, 11000, 12000, 16000, 19000];
export function spectrum(samples, rate, size = 2048) {
  const bands = new Float64Array(BAND_EDGES.length - 1);
  let frames = 0;
  for (let start = 0; start + size <= samples.length; start += size / 2) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = samples[start + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (size - 1)));
    fft(re, im); frames++;
    for (let i = 1; i < size / 2; i++) {
      const hz = i * rate / size, p = re[i] ** 2 + im[i] ** 2;
      for (let j = 0; j < bands.length; j++) if (hz >= BAND_EDGES[j] && hz < BAND_EDGES[j + 1]) { bands[j] += p; break; }
    }
  }
  return bands.map(x => x / Math.max(1, frames));
}

export function rmsDb(samples) {
  if (!samples.length) return null;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return db(sum / samples.length);
}

export function describePair(input, output, rate) {
  if (input.length !== output.length || !input.length) throw new Error('Comparison needs nonempty equal-length audio.');
  const a = spectrum(input, rate), b = spectrum(output, rate);
  // Speech/presence-band normalization avoids mistaking recording volume for
  // EQ. Absolute gain is reported separately. It is not perceptual loudness.
  const anchorA = a[4] + a[5] + a[6] + a[7], anchorB = b[4] + b[5] + b[6] + b[7];
  if (anchorA < 1e-15 || anchorB < 1e-15) throw new Error('Not enough active signal for a level-matched comparison.');
  const anchorGain = db(anchorB / Math.max(1e-15, anchorA));
  const totalA = a.reduce((x, y) => x + y, 0);
  // Bands above the analysis Nyquist (or with no input energy) have no gain.
  const bands = Array.from(a, (value, i) => {
    const measurable = BAND_EDGES[i] < rate / 2 && value > 1e-20;
    return { hz: `${BAND_EDGES[i]}-${BAND_EDGES[i + 1]}`,
      inputRelativeDb: measurable ? db(value / Math.max(1e-15, totalA)) : null,
      gainDb: measurable ? db(b[i] / value) : null,
      normalizedGainDb: measurable ? db(b[i] / value) - anchorGain : null };
  });
  const inputLevels = [], outputLevels = [], changes = [];
  const block = Math.round(rate * .25);
  for (let i = 0; i + block <= input.length; i += block) {
    const x = rmsDb(input.subarray(i, i + block)), y = rmsDb(output.subarray(i, i + block));
    if (x < -60 || y < -70) continue;
    inputLevels.push(x); outputLevels.push(y); changes.push(y - x);
  }
  return { inputRmsDbfs: rmsDb(input), outputRmsDbfs: rmsDb(output), anchorGainDb: anchorGain,
    inputLevelRangeP90P10Db: percentile(inputLevels, .9) - percentile(inputLevels, .1),
    outputLevelRangeP90P10Db: percentile(outputLevels, .9) - percentile(outputLevels, .1),
    gainChangeP10Db: percentile(changes, .1), gainChangeMedianDb: percentile(changes, .5), gainChangeP90Db: percentile(changes, .9), bands };
}

// The receiver's int16 clamp leaves a flat ceiling that most short blocks
// reach, with mean |x| near half of it (tests/REFERENCE_2026.md). The ceiling
// is estimated as the 99.5th percentile so MP3 overshoot does not define it.
export function clipSignature(samples, rate) {
  if (!samples.length) throw new Error('Clip signature needs audio.');
  const magnitudes = Float32Array.from(samples, Math.abs).sort();
  const ceiling = magnitudes[Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * .995))];
  if (!(ceiling > 0)) throw new Error('Clip signature needs non-silent audio.');
  let near = 0, sumAbs = 0, sumSq = 0;
  for (const v of samples) { const m = Math.abs(v); if (m > .95 * ceiling) near++; sumAbs += m; sumSq += v * v; }
  const block = Math.max(1, Math.round(rate * 256 / 48000)), peaks = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let peak = 0;
    for (let j = i; j < i + block; j++) peak = Math.max(peak, Math.abs(samples[j]));
    if (peak > .1 * ceiling) peaks.push(20 * Math.log10(peak));
  }
  return { ceilingDbfs: 20 * Math.log10(ceiling), clippedPercent: 100 * near / samples.length,
    meanOverCeiling: sumAbs / samples.length / ceiling, crestDb: 20 * Math.log10(ceiling / Math.sqrt(sumSq / samples.length)),
    blockPeakSpreadDb: percentile(peaks, .9) - percentile(peaks, .1) };
}

// Short-term level agreement after removing the overall volume difference.
export function levelTracking(recorded, rendered, rate, seconds = .5) {
  if (recorded.length !== rendered.length) throw new Error('Level tracking needs equal-length audio.');
  const block = Math.round(rate * seconds), a = [], b = [];
  for (let i = 0; i + block <= recorded.length; i += block) {
    const x = rmsDb(recorded.subarray(i, i + block)), y = rmsDb(rendered.subarray(i, i + block));
    if (x > -70 && y > -70) { a.push(x); b.push(y); }
  }
  if (a.length < 3) throw new Error('Level tracking needs at least three active blocks.');
  const offset = percentile(a.map((x, i) => x - b[i]), .5);
  const deviations = a.map((x, i) => x - b[i] - offset);
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return { blocks: a.length, offsetDb: offset, rmsDeviationDb: Math.sqrt(mean(deviations.map(d => d * d))),
    worstDeviationDb: Math.max(...deviations.map(Math.abs)), correlation: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null };
}

function compactReport(report) {
  const r = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;
  const sig = s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, r(v)]));
  return { ...report, sourceMatches: report.sourceMatches.map(s => ({ ...s, comparisons: s.comparisons?.map(c => ({
    channel: c.channel, recordedClipSignature: sig(c.recordedClipSignature), variants: c.variants.map(v => ({ name: v.name,
      clipSignature: sig(v.clipSignature), levelTracking: sig(v.levelTracking),
      renderedMinusRecordedDb: v.comparisonToRecorded.bands.map(x => [x.hz, x.normalizedGainDb === null ? null : r(-x.normalizedGainDb)]),
      secondHalfLevelTracking: sig(v.secondHalfLevelTracking) }))
  })) })) };
}

export function sampleTimeline(source, rate, startSeconds, scale, length) {
  if (!(scale > 0) || !Number.isFinite(startSeconds) || !Number.isInteger(length) || length < 0) throw new Error('Invalid timeline.');
  // Fractional delay / clock correction must not be linear interpolation:
  // that would itself attenuate the high frequencies we are measuring.
  const half = 32, phases = 256, cutoff = .49 / Math.max(1, scale);
  const kernels = Array.from({ length: phases + 1 }, (_, phase) => {
    const fraction = phase / phases;
    const weights = new Float64Array(half * 2);
    let total = 0;
    for (let k = 0; k < weights.length; k++) {
      const t = k - half + 1 - fraction, x = 2 * cutoff * t;
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = Math.PI * Math.max(-1, Math.min(1, t / half));
      weights[k] = 2 * cutoff * sinc * (.42 + .5 * Math.cos(u) + .08 * Math.cos(2 * u));
      total += weights[k];
    }
    return weights.map(x => x / total);
  });
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = startSeconds * rate + i * scale, base = Math.floor(position), fraction = position - base;
    if (base - half < 0 || base + half >= source.length) throw new Error('Aligned passage extends beyond source audio.');
    const phase = fraction * phases, lower = Math.floor(phase), blend = phase - lower;
    const a = kernels[lower], b = kernels[lower + 1];
    let value = 0;
    for (let k = 0; k < a.length; k++) value += source[base - half + 1 + k] * (a[k] + (b[k] - a[k]) * blend);
    out[i] = value;
  }
  return out;
}

async function main() {
  const compact = process.argv.includes('--compact');
  const [referencePath, ...sourcePaths] = process.argv.slice(2).filter(x => x !== '--compact');
  if (!referencePath || !sourcePaths.length) throw new Error('Usage: node tests/reference.compare.mjs <recorded.mp3> <source.mp3> [...]');
  const { audio, sandbox } = audioEngine();
  sandbox.TF2Opus = await import('../opus-codec.mjs');
  const preset = vm.runInContext('PRESETS.modern', sandbox);
  const reference = await decodeFile(referencePath);
  const searchRate = 2000, rate = 48000;
  const narrow = (samples, sr) => audio.applyBiquad(audio.resampleSinc(samples, sr, searchRate),
    audio.biquadCoefs('highpass', searchRate, 100, .707));
  const ref = narrow(mono(reference), reference.rate);
  const ref48 = audio.resampleSinc(mono(reference), reference.rate, rate);
  const sourceMatches = [];
  for (const sourcePath of sourcePaths) {
    const source = await decodeFile(sourcePath);
    console.error(`Locating ${path.basename(sourcePath)} in the recording...`);
    const channels = [];
    for (const channel of ['mix', 'left', 'right']) {
      const samples = narrow(mono(source, channel), source.rate);
      const matches = [];
      for (let start = 4; start + 4 < ref.length / searchRate; start += 12) {
        const match = findMatch(samples, ref.subarray(start * searchRate, (start + 4) * searchRate));
        matches.push({ referenceStartSeconds: start, sourceStartSeconds: match.sample === null ? null : match.sample / searchRate,
          correlation: match.correlation });
      }
      channels.push({ channel, matches });
    }
    const timelines = channels.map(x => ({ channel: x.channel, timeline: consistentTimeline(x.matches) })).filter(x => x.timeline);
    timelines.sort((a, b) => b.timeline.matches - a.timeline.matches || b.timeline.medianAbsoluteCorrelation - a.timeline.medianAbsoluteCorrelation);
    const selected = timelines[0];
    if (!selected) { sourceMatches.push({ file: path.basename(sourcePath), timelines, channels, comparisons: null }); continue; }
    const timeline = selected.timeline;
    // Stay inside the confirmed passage, away from push-to-talk edges.
    const start = timeline.firstReferenceSeconds + 2;
    const seconds = timeline.lastReferenceSeconds - timeline.firstReferenceSeconds;
    const length = Math.round(seconds * rate);
    const recorded = ref48.subarray(Math.round(start * rate), Math.round(start * rate) + length);
    const comparisons = [];
    // Which source channel reaches the game depends on the capture device's
    // stereo-to-mono handling, so every channel is rendered.
    for (const channel of ['mix', 'left', 'right']) {
      const source48 = audio.resampleSinc(mono(source, channel), source.rate, rate);
      const input = sampleTimeline(source48, rate, timeline.offsetSeconds + start * timeline.scale, timeline.scale, length);
      const settings = [
        ['modern', { codec: preset.codec, listenerPos: preset.position, micGain: preset.gain, voiceScale: preset.voice_scale, hp: preset.hp, lp: preset.lp }],
        ['voice-gate-off', { codec: preset.codec, listenerPos: preset.position, micGain: preset.gain, voiceScale: preset.voice_scale, hp: preset.hp, lp: preset.lp, gate: false }],
        ['receiver-auto-gain-off', { codec: preset.codec, listenerPos: preset.position, agc: false, volume: 1 }]
      ];
      const variants = [];
      for (const [name, opts] of settings) {
        console.error(`Comparing ${path.basename(sourcePath)} / ${channel} / ${name}...`);
        const rendered = (await audio.process({ sampleRate: rate, length, numberOfChannels: 1, getChannelData: () => input }, opts)).samples;
        const split = Math.floor(length / 2);
        variants.push({ name, clipSignature: clipSignature(rendered, rate),
          levelTracking: levelTracking(recorded, rendered, rate),
          secondHalfLevelTracking: levelTracking(recorded.subarray(split), rendered.subarray(split), rate),
          comparisonToRecorded: describePair(rendered, recorded, rate) });
      }
      comparisons.push({ channel, recordedClipSignature: clipSignature(recorded, rate), variants });
    }
    sourceMatches.push({ file: path.basename(sourcePath), sampleRate: source.rate, durationSeconds: source.length / source.rate,
      timelines, alignedReferenceStartSeconds: start, alignedDurationSeconds: seconds, comparisons });
  }
  const report = { reference: path.basename(referencePath), referenceDurationSeconds: reference.length / reference.rate,
    method: '4-second waveform cross-correlation at 2 kHz; robust offset/clock fit; band-limited fractional correction; ' +
      '48 kHz render of the aligned source; spectra normalized at 300-3000 Hz; clip signature; 0.5 s level tracking. ' +
      'Music and capture-chain benchmark, not a unique codec identification.', sourceMatches };
  console.log(JSON.stringify(compact ? compactReport(report) : report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
