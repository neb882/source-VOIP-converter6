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
import { createRequire } from 'node:module';
import { MPEGDecoder } from 'mpg123-decoder';

// The shared measures (also used by the page's real-take comparison).
const TF2Reference = createRequire(import.meta.url)('../reference.js');
export const { fft, findMatch, percentile, consistentTimeline, BAND_EDGES, spectrum, rmsDb, describePair,
  clipSignature, levelTracking, sampleTimeline } = TF2Reference;

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
