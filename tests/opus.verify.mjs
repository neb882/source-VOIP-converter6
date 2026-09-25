import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as opus from '../opus-codec.mjs';
import { createEncoder, getPacketInfo } from '../vendor/libopus/index.mjs';

let passed = 0;
function check(name, ok) { assert.ok(ok, name); passed++; console.log(`  ok    ${name}`); }
const energy = x => x.reduce((sum, v) => sum + v * v, 0);
const peak = x => { let at = 0; for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i; return at; };
const difference = (a, b) => a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0);
const sandbox = { window: {}, Blob, console, TF2Opus: opus };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../constants.js', import.meta.url), 'utf8') + '\n' +
  fs.readFileSync(new URL('../audio.js', import.meta.url), 'utf8'), sandbox);
const A = sandbox.window.TF2Audio;
const buffer = (data, sampleRate) => ({ sampleRate, length: data.length, numberOfChannels: 1, getChannelData: () => data });

console.log('\n[Opus] Timing, framing, controls, and actual decoder concealment');
for (const rate of [24000, 48000]) {
  for (const length of [0, 1, 17, rate / 10, rate / 10 + 1, rate / 10 + 113]) {
    const x = Float32Array.from({ length }, (_, i) => .2 * Math.sin(2 * Math.PI * 440 * i / rate));
    const result = await opus.roundTrip(x, rate, 32000);
    check(`${rate} Hz / ${length} samples retains exact length`, result.samples.length === length);
    check(`${rate} Hz / ${length} samples stays finite`, result.samples.every(Number.isFinite));
  }
  for (const length of [rate / 10, rate / 10 + 1, rate / 10 + 113]) {
    let middleEnergy;
    for (const fraction of [.5, .05, .95]) {
      const center = Math.round(length * fraction);
      const x = Float32Array.from({ length }, (_, i) => .3 * Math.exp(-.5 * ((i - center) / (rate * .000375)) ** 2));
      const { samples, info } = await opus.roundTrip(x, rate, 64000);
      check(`${rate}/${length}: pulse ${fraction} timing`, Math.abs(peak(samples) - center) <= rate * .0003);
      if (fraction === .5) middleEnergy = energy(samples);
      else check(`${rate}/${length}: boundary pulse survives`, energy(samples) > middleEnergy * .5);
      check('Opus reports exact 20 ms frames and codec delay', info.frameSamples === rate / 50 && info.lookahead > 0);
    }
  }
}

const rate = 24000;
// Voiced harmonics plus changing high-frequency content, unlike a single tone.
const x = Float32Array.from({ length: rate }, (_, i) => .10 * Math.sin(2 * Math.PI * 233 * i / rate)
  + .06 * Math.sin(2 * Math.PI * 3123 * i / rate) + .04 * Math.sin(2 * Math.PI * (5100 * i / rate + 600 * (i / rate) ** 2)));
const base = { codec: 'steam', micGain: 1, voiceScale: 1, listenerPos: 'open', bits: 16 };
const high = await A.process(buffer(x, rate), base);
const low = await A.process(buffer(x, rate), { ...base, bits: 6 });
check('Both quality settings use real Opus', high.realOpus && low.realOpus);
check('Quality changes the actual encoder bitrate', high.codecInfo.bitrate === 32000 && low.codecInfo.bitrate === 12000);
check('Lower bitrate produces fewer encoded bytes', low.codecInfo.encodedBytes < high.codecInfo.encodedBytes * .6);
check('Quality changes the decoded audio', difference(high.samples, low.samples) > .01);
const repeat = await A.process(buffer(x, rate), base);
check('Pinned real codec is repeatable', difference(high.samples, repeat.samples) === 0);
check('Steam profile encodes as VOIP with the voice signal hint', high.codecInfo.application === 'voip' && high.codecInfo.signal === 'voice');
check('Encoder mode per packet is reported from the TOC byte',
  Object.values(high.codecInfo.modes).reduce((a, b) => a + b, 0) === high.codecInfo.frames);
const lost = await A.process(buffer(x, rate), { ...base, lossPct: 100 });
check('100% loss reaches native decoder PLC', lost.codecInfo.plc === 'opus' && lost.codecInfo.lostFrames === lost.codecInfo.frames);
check('No voice leaks through 100% loss from stream start', energy(lost.samples) < 1e-12);
const lossy = await A.process(buffer(x, rate), { ...base, lossPct: 25 });
check('Partial loss conceals packets without changing duration',
  lossy.samples.length === Math.round(x.length * lossy.sampleRate / rate) && lossy.codecInfo.lostFrames > 0 && energy(lossy.samples) > 0);
const silent = await A.process(buffer(new Float32Array(rate), rate), base);
// Opus's own quantization may return very small nonzero PCM for silence.
check('Silence stays below -100 dBFS RMS without added hiss', energy(silent.samples) / silent.samples.length < 1e-10);
const muted = await A.process(buffer(x, rate), { ...base, voiceScale: 0 });
check('Receiver mute is exact silence', energy(muted.samples) === 0);
const quiet = Float32Array.from(x, v => v * .1);
const leveled = await A.process(buffer(quiet, rate), base);
const unleveled = await A.process(buffer(quiet, rate), { ...base, agc: false });
check('Disabling receiver auto-gain preserves quiet input levels', energy(leveled.samples) > energy(unleveled.samples) * 20);
const levelDb = (samples) => 10 * Math.log10(energy(samples) / energy(high.samples));
const halfIn = await A.process(buffer(Float32Array.from(x, v => v * .5), rate), base);
check('Receiver auto-gain levels a 6 dB input difference to within 0.5 dB', Math.abs(levelDb(halfIn.samples)) < .5);
const faint = await A.process(buffer(Float32Array.from(x, v => v * .05), rate), base);
// x needs ~7x gain; 26 dB quieter needs ~140x, so voice_maxgain (16) binds.
check('voice_maxgain caps the boost for very quiet input', levelDb(faint.samples) < -15 && levelDb(faint.samples) > -22);
const quarter = await A.process(buffer(x, rate), { ...base, volume: .25 });
const halfVol = await A.process(buffer(x, rate), { ...base, volume: .5 });
check('Output volume is linear and applied after the voice clamp',
  difference(Float32Array.from(quarter.samples, v => v * 2), halfVol.samples) < 1e-9);
for (const sourceRate of [8000, 44100, 96000]) {
  const data = Float32Array.from({ length: 1001 }, (_, i) => .1 * Math.sin(2 * Math.PI * 440 * i / sourceRate));
  const result = await A.process(buffer(data, sourceRate), base);
  check(`${sourceRate} Hz conversion preserves duration after both resamplers`,
    result.samples.length === Math.round(data.length * result.sampleRate / sourceRate));
}
await assert.rejects(() => A.process(buffer(new Float32Array([NaN]), rate), base), /non-finite/);
check('Invalid PCM is rejected before encoding', true);
const aliasSource = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 16000 * i / 48000));
const downsampled = A.resampleSinc(aliasSource, 48000, 24000).slice(100, -100);
check('Downsampling rejects an out-of-band tone instead of aliasing it', energy(downsampled) / downsampled.length < 1e-7);

// Observe the real encoder boundary to verify filter order, not just output EQ.
let captured;
sandbox.TF2Opus = { roundTrip: async (samples, sr, bitrate, options) => {
  captured = samples.slice(); return opus.roundTrip(samples, sr, bitrate, options);
} };
const highTone = Float32Array.from({ length: rate }, (_, i) => .15 * Math.sin(2 * Math.PI * 8000 * i / rate));
await A.process(buffer(highTone, rate), { ...base, lp: 1500 });
check('Sender low-pass removes out-of-band energy before encoding', energy(captured) < energy(highTone) * .001);
sandbox.TF2Opus = opus;
const bypassed = await A.process(buffer(x, rate), { ...base, enableWarble: false });
check('Codec bypass is only selected explicitly and reported honestly', !bypassed.realOpus && bypassed.codecInfo.backend === 'bypass');
sandbox.TF2Opus = { roundTrip: async () => { throw new Error('Codec unavailable'); } };
await assert.rejects(() => A.process(buffer(x, rate), base), /Codec unavailable/);
check('Codec failure is reported, never silently bypassed', true);
sandbox.TF2Opus = opus;

// Independent packet parser confirms actual codec framing, not a metadata label.
const encoder = await createEncoder({ sampleRate: rate, channels: 1, frameSize: 480, bitrate: 32000 });
try {
  const packet = encoder.encodeFloat(x.subarray(0, 480));
  const info = await getPacketInfo(packet, { sampleRate: rate });
  check('Encoded packet parses as mono 20 ms Opus', info.channels === 1 && info.durationMs === 20 && info.samples === 480);
} finally { encoder.free(); }
console.log(`\n${passed} Opus checks passed`);
