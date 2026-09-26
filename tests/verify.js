/* =========================================================================
 * tests/verify.js — headless verification of the TF2 voice pipeline.
 *
 * The DSP core (audio.js) is pure JS, so it runs under Node:
 *     node tests/verify.js
 * TF2_DIR env var points the suite at a copy of the sources elsewhere.
 *
 * Covers:
 *   - resampler passband, stopband, alignment and exact lengths
 *   - profile calibration FIR response
 *   - receiver auto-gain: target, cap, int16 clamp, silence, voice_scale
 *   - the measured clipping signature on dense input
 *   - real libopus modes for every codec profile
 *   - Valve DSP room presets, burst loss, WAV integrity, option robustness
 * ========================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.env.TF2_DIR || path.join(__dirname, '..');
const code =
  fs.readFileSync(path.join(root, 'constants.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(root, 'audio.js'), 'utf8');

const sandbox = { window: {}, Blob: globalThis.Blob, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const TF2Audio = sandbox.window.TF2Audio;
const ENGINE = vm.runInContext('VOICE_ENGINE', sandbox);

/* ---------------- helpers ---------------- */

function mkBuffer(channelData, sampleRate) {
  return { sampleRate, length: channelData.length, numberOfChannels: 1, getChannelData: () => channelData };
}

function tone(freq, seconds, rate, amp) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return out;
}

function whiteNoise(seconds, rate, amp, seed) {
  const rnd = TF2Audio.mulberry32(seed);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rnd() * 2 - 1);
  return out;
}

// Dense, music-like material: harmonic tones plus noise with a beat envelope.
function musicLike(seconds, rate, seed) {
  const rnd = TF2Audio.mulberry32(seed);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const beat = 0.55 + 0.45 * Math.exp(-((t * 2) % 1) * 6);
    let v = 0;
    for (const [f, a] of [[110, .3], [220, .2], [330, .12], [660, .08], [1320, .05]]) v += a * Math.sin(2 * Math.PI * f * t);
    out[i] = beat * (v + 0.12 * (rnd() * 2 - 1));
  }
  return out;
}

// Syllabic voiced signal: 115 Hz harmonics with a 3.2 Hz syllable envelope, scaled to an RMS level.
// Opus's voice detector keeps it active, as it did the test signal's vowel synth.
function speechLike(seconds, rate, rmsDb) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.pow(Math.abs(Math.sin(Math.PI * ((t * 3.2) % 1))), 0.6);
    const f0 = 115 * (1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t));
    let v = 0;
    for (let h = 1; h <= 30; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = env * v; sum += out[i] * out[i];
  }
  const k = 10 ** (rmsDb / 20) / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

function rms(x, from, to) {
  const a = from || 0, b = to || x.length;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function meanAbs(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += Math.abs(x[i]);
  return s / Math.max(1, to - from);
}

function peakAbs(x) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; }

function diffRms(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / Math.max(1, n));
}

function hasBadValues(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return true;
  return false;
}

function clipFraction(x, thr) {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr) c++;
  return c / Math.max(1, x.length);
}

function bandRms(x, rate, type, f0) {
  let y = TF2Audio.applyBiquad(x, TF2Audio.biquadCoefs(type, rate, f0, 0.707));
  y = TF2Audio.applyBiquad(y, TF2Audio.biquadCoefs(type, rate, f0, 0.707));
  return rms(y);
}

// Magnitude of an FIR at one frequency.
function firGainDb(taps, f, rate) {
  let re = 0, im = 0;
  for (let k = 0; k < taps.length; k++) { re += taps[k] * Math.cos(2 * Math.PI * f * k / rate); im -= taps[k] * Math.sin(2 * Math.PI * f * k / rate); }
  return 20 * Math.log10(Math.hypot(re, im));
}

// Average power in [lo, hi) Hz relative to 300-3000 Hz (Hann, 4096-point FFT).
function bandDb(x, rate, lo, hi) {
  const n = 4096, re = new Float64Array(n), im = new Float64Array(n);
  let band = 0, ref = 0;
  for (let start = 0; start + n <= x.length; start += n / 2) {
    for (let i = 0; i < n; i++) { re[i] = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); im[i] = 0; }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k), d = Math.sin(a * k), p = i + k, q = p + len / 2;
        const vr = re[q] * c - im[q] * d, vi = re[q] * d + im[q] * c;
        re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi;
      }
    }
    for (let k = 1; k < n / 2; k++) {
      const hz = k * rate / n, pw = re[k] * re[k] + im[k] * im[k];
      if (hz >= lo && hz < hi) band += pw / Math.max(1, (hi - lo) * n / rate);
      if (hz >= 300 && hz < 3000) ref += pw / (2700 * n / rate);
    }
  }
  return 10 * Math.log10(Math.max(1e-30, band) / Math.max(1e-30, ref));
}

function db(ratio) { return 20 * Math.log10(Math.max(ratio, 1e-12)); }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${name}${detail ? '   [' + detail + ']' : ''}`); }
  else      { fail++; console.error(`  FAIL  ${name}${detail ? '   [' + detail + ']' : ''}`); }
}

// Clean path: no codec, unity receiver gain, full output volume.
const clean = { enableWarble: false, agc: false, volume: 1, listenerPos: 'open' };

/* ---------------- tests ---------------- */

async function main() {
  sandbox.TF2Opus = await import('../opus-codec.mjs');
  const SR = 48000;

  console.log('\n[1] Resampler');
  {
    for (const f of [1000, 8000, 10000]) {
      const x = tone(f, 1, SR, 0.5);
      const y = TF2Audio.resampleSinc(x, SR, 24000);
      const g = db(rms(y, 2000, y.length - 2000) / rms(x, 4000, x.length - 4000));
      check(`48k->24k passband flat at ${f} Hz`, Math.abs(g) < 0.05, `${g.toFixed(3)} dB`);
    }
    const alias = TF2Audio.resampleSinc(tone(16000, 1, SR, 1), SR, 24000);
    const aliasDb = db(rms(alias, 2000, alias.length - 2000) / Math.SQRT1_2);
    check('16 kHz tone is rejected, not aliased, when decimating', aliasDb < -90, `${aliasDb.toFixed(1)} dB`);
    const imp = new Float32Array(4410); imp[2205] = 1;
    const up = TF2Audio.resampleSinc(imp, 44100, 48000);
    let at = 0; for (let i = 1; i < up.length; i++) if (Math.abs(up[i]) > Math.abs(up[at])) at = i;
    check('resampling preserves timing (impulse lands at 2400)', at === 2400, String(at));
    for (const [a, b] of [[44100, 48000], [48000, 44100], [8000, 44100], [24000, 44100], [96000, 24000]]) {
      const n = 12345;
      const out = TF2Audio.resampleSinc(new Float32Array(n), a, b);
      check(`${a} -> ${b} length is round(n * ratio)`, out.length === Math.round(n * b / a), String(out.length));
    }
    const src = tone(330, 0.25, SR, 0.2);
    const roundTrip = TF2Audio.resampleSinc(TF2Audio.resampleSinc(src, SR, SR / 2), SR / 2, SR);
    check('resampler round-trip reconstructs an in-band tone', diffRms(roundTrip.subarray(500, -500), src.subarray(500, -500)) < 1e-3);
  }

  console.log('\n[2] Profile calibration FIR');
  {
    const eq = vm.runInContext('CODEC_PROFILES.steam.decoderEq', sandbox);
    const taps = TF2Audio.firwin2(eq.taps, eq.freqs, eq.gainsDb, 24000);
    const g1k = firGainDb(taps, 1000, 24000), g5k = firGainDb(taps, 5000, 24000), g9k = firGainDb(taps, 9000, 24000);
    check('steam EQ is transparent at low frequencies', Math.abs(g1k) < 0.15, `${g1k.toFixed(2)} dB`);
    check('steam EQ adds the measured 1 dB to the SILK band above 3 kHz', Math.abs(g5k - 1) < 0.2, `${g5k.toFixed(2)} dB`);
    check('steam EQ trims the CELT band above 8 kHz by the measured 1 dB', Math.abs(g9k + 1) < 0.2, `${g9k.toFixed(2)} dB`);
    const g75 = firGainDb(taps, 7500, 24000), g11 = firGainDb(taps, 11000, 24000), g115 = firGainDb(taps, 11500, 24000), g12 = firGainDb(taps, 12000, 24000);
    check('steam EQ keeps the SILK side of the 8 kHz crossover', g75 > 0.6, `${g75.toFixed(2)} dB at 7.5 kHz`);
    check('steam EQ follows the capture resampler roll-off from 11.2 kHz', g11 > -1.6 && g115 < -3 && g115 > -5 && g12 < -5.5,
      `${g11.toFixed(2)} / ${g115.toFixed(2)} / ${g12.toFixed(2)} dB`);
    const js = TF2Audio.firwin2(95, [0, 6000, 12000], [0, -6, -6], 24000);
    // Gains interpolate linearly: halfway from 1.0 to 0.501 is 0.75 (-2.5 dB).
    check('firwin2 design follows its gain points', Math.abs(firGainDb(js, 9000, 24000) + 6) < 0.1 && Math.abs(firGainDb(js, 3000, 24000) + 2.5) < 0.2);
    const impulse = new Float32Array(301); impulse[150] = 1;
    const y = TF2Audio.applyFirZeroPhase(impulse, taps);
    let at = 0; for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
    check('zero-phase FIR keeps the signal time-aligned', at === 150, String(at));
  }

  console.log('\n[3] Receiver auto-gain (Source voice channel model)');
  {
    const R = 44100;
    // Gain actually applied at sample i (only where the input is large and the output unclipped).
    const gainAt = (y, x, i) => (Math.abs(x[i]) > 0.05 && Math.abs(y[i]) < 0.99 ? y[i] / x[i] : NaN);
    const avgGainOver = (y, x, offsets, fromBlock, toBlock) => {
      let s = 0, n = 0;
      for (let b = fromBlock; b < toBlock; b++) for (const j of offsets) { const g = gainAt(y, x, b * 128 + j); if (Number.isFinite(g)) { s += g; n++; } }
      return s / Math.max(1, n);
    };
    // Steady sine: the default mean/peak blend (voice_avggain 0.5) overdrives by 1 / (2/pi + 0.5 (1 - 2/pi)) = 1.22.
    const sine = tone(440, 1, R, 0.2);
    const def = TF2Audio.receiverAutoGain(sine, {});
    const c1 = clipFraction(def.subarray(R / 2), 0.95 * 32767 / 32768), m1 = meanAbs(def, R / 2);
    check('voice_avggain 0.5 overdrives a steady sine 1.22x into the clamp (takes: 42% clipped, mean 0.71)', c1 > 0.40 && c1 < 0.46 && Math.abs(m1 - 0.71) < 0.02,
      `${(c1 * 100).toFixed(1)}% / ${m1.toFixed(3)}`);
    const c25 = clipFraction(TF2Audio.receiverAutoGain(sine, { avgGain: 0.25 }).subarray(R / 2), 0.95 * 32767 / 32768);
    check('voice_avggain 0.25 drives harder (take: 50% clipped)', c25 > 0.47 && c25 < 0.53, `${(c25 * 100).toFixed(1)}%`);
    const pk = TF2Audio.receiverAutoGain(sine, { avgGain: 1 });
    const p1 = peakAbs(pk.subarray(R / 2));
    check('voice_avggain 1 normalizes the block peak to full scale', p1 > 0.985 && p1 <= 1, p1.toFixed(4));
    const tiny = tone(440, 1, R, 0.001);
    const gain10 = rms(TF2Audio.receiverAutoGain(tiny, {}), R / 2) / rms(tiny, R / 2);
    const gain16 = rms(TF2Audio.receiverAutoGain(tiny, { maxGain: 16 }), R / 2) / rms(tiny, R / 2);
    check('quiet input stops at voice_maxgain (default 10)', Math.abs(gain10 - 10) < 0.05 && Math.abs(gain16 - 16) < 0.08,
      `${gain10.toFixed(3)} / ${gain16.toFixed(3)}`);
    const dense = TF2Audio.receiverAutoGain(musicLike(1, R, 5), {});
    const dpk = peakAbs(dense);
    check('output is int16 PCM clamped to full scale', dpk <= 1 && dpk > 0.99 && dense.every(v => Number.isInteger(v * 32768)), dpk.toFixed(6));
    check('dense input is hard-clipped at the ceiling', clipFraction(dense, 0.999) > 0.02, `${(clipFraction(dense, 0.999) * 100).toFixed(1)}%`);
    const onsetAt = 128 * 172;          // a block boundary
    const silentThenTone = new Float32Array(R);
    silentThenTone.set(tone(440, 0.5, R, 0.3), onsetAt);
    const onset = TF2Audio.receiverAutoGain(silentThenTone, {});
    check('digital silence stays silent', peakAbs(onset.subarray(0, onsetAt)) === 0);
    check('silent blocks hold the gain instead of arming maximum gain', peakAbs(onset.subarray(onsetAt, onsetAt + 128)) < 0.31,
      peakAbs(onset.subarray(onsetAt, onsetAt + 128)).toFixed(3));
    // Level step at a block edge: the old gain covers the next block, the ramp the one after, then the new target holds.
    const stepIn = new Float32Array(128 * 40);
    stepIn.set(tone(440, 128 * 8 / R, R, 0.02));
    stepIn.set(tone(440, 128 * 32 / R, R, 0.3), 128 * 8);
    const st = TF2Audio.receiverAutoGain(stepIn, {});
    const clipBlock = (b0, b1) => clipFraction(st.subarray(b0 * 128, b1 * 128), 0.95 * 32767 / 32768);
    check('after a level step the old gain holds for one block, then settles', clipBlock(8, 9) > 0.7 && Math.abs(clipBlock(10, 40) - 0.43) < 0.04,
      `${(clipBlock(8, 9) * 100).toFixed(0)}% -> ${(clipBlock(10, 40) * 100).toFixed(0)}%`);
    // voice_scale s: each block starts at s*s*T_prev and steps toward s*T by whole 1/128 increments (truncated).
    const x12 = tone(1000, 1, R, 0.25);
    const saw = TF2Audio.receiverAutoGain(x12, { scale: 0.5 });
    const gStart = avgGainOver(saw, x12, [0, 1, 2, 3, 4, 5, 6, 7], 100, 300), gEnd = avgGainOver(saw, x12, [120, 121, 122, 123, 124, 125, 126, 127], 100, 300);
    // T = 32767 / (mean + 0.5 (peak - mean)) = 4.89 here: s*s*T = 1.22; step = trunc(0.5 (T - s T)) = 1/128 per sample.
    check('voice_scale 0.5 saws from s*s*T toward s*T in 1/128 steps (take: 0.32 -> 0.55 FS at -12 dBFS)',
      Math.abs(gStart - 1.23) < 0.04 && Math.abs(gEnd - 2.19) < 0.04, `${gStart.toFixed(3)} -> ${gEnd.toFixed(3)}`);
    const loudSine = tone(1000, 1, R, 0.5);
    const flat = TF2Audio.receiverAutoGain(loudSine, { scale: 0.5 });
    const flatDb = 20 * Math.log10(rms(flat, R / 2));
    check('voice_scale 0.5 on a loud sine truncates the step to zero (take: -13.4 dB rms)', Math.abs(flatDb + 13.3) < 0.2, `${flatDb.toFixed(2)} dB`);
    check('voice_scale 0 mutes exactly', peakAbs(TF2Audio.receiverAutoGain(tone(440, .2, R, .2), { scale: 0 })) === 0);
  }

  console.log('\n[4] Measured signature: dense music through the Steam path');
  {
    const src = musicLike(4, SR, 7);
    const r = await TF2Audio.process(mkBuffer(src, SR), { codec: 'steam', volume: 1 });
    const y = r.samples.subarray(SR / 2);
    const C = 32767 / 32768;
    const mc = meanAbs(y) / C, clipped = clipFraction(y, 0.95 * C), crest = db(C / rms(y));
    check('mean |y| sits near half the clip ceiling (recording: 0.49-0.52)', mc > 0.42 && mc < 0.58, mc.toFixed(3));
    check('a large share of samples reaches the ceiling (recording: ~13%)', clipped > 0.05 && clipped < 0.3, `${(clipped * 100).toFixed(1)}%`);
    check('crest factor is compressed (recording: 4.3-4.7 dB)', crest > 3 && crest < 6.5, `${crest.toFixed(2)} dB`);
    const hf = bandDb(y, SR, 14500, 20000);
    check('clipping after decode puts energy above the 12 kHz codec edge (recording: -37 to -56 dB)', hf > -70 && hf < -25, `${hf.toFixed(1)} dB rel`);
    const noAgc = await TF2Audio.process(mkBuffer(src.map(v => v * 0.3), SR), { codec: 'steam', volume: 1, agc: false });
    const hfOff = bandDb(noAgc.samples.subarray(SR / 2), SR, 14500, 20000);
    check('without the receiver clamp, the codec band edge holds', hfOff < -80, `${hfOff.toFixed(1)} dB rel`);
    const vol = await TF2Audio.process(mkBuffer(src, SR), { codec: 'steam' });
    const expected = ENGINE.volume;
    // RMS rather than peak: at volume 1 the final soft limiter touches the clipped peaks.
    check('output volume scales the rendered file linearly', Math.abs(rms(vol.samples) / rms(r.samples) - expected) < 0.01,
      (rms(vol.samples) / rms(r.samples)).toFixed(4));
  }

  console.log('\n[5] Real codec modes per profile');
  {
    const src = musicLike(1, SR, 3);
    const expect = { steam: ['hybrid', 34000], steam_48: ['hybrid', 64000], celt_22: ['celt', 22000], celt_44: ['celt', 44000], speex: ['silk', 8000] };
    for (const [codec, [mode, bitrate]] of Object.entries(expect)) {
      const r = await TF2Audio.process(mkBuffer(src, SR), { codec });
      const m = r.codecInfo.modes;
      const total = m.silk + m.hybrid + m.celt;
      check(`${codec}: libopus runs in ${mode} mode at ${bitrate / 1000} kbps`,
        r.codecInfo.backend === 'libopus' && r.codecInfo.bitrate === bitrate && m[mode] / total > 0.8, JSON.stringify(m));
      check(`${codec}: finite output`, !hasBadValues(r.samples) && r.samples.length === Math.round(src.length * r.sampleRate / SR));
    }
    const wide = whiteNoise(1, SR, 0.15, 7);
    const sp = await TF2Audio.process(mkBuffer(wide, SR), { codec: 'speex', agc: false, volume: 1 });
    // Narrowband codec: nothing between its 4 kHz edge and the mixer's
    // linear-interpolation images, which start near 11025 - 4000 Hz.
    const gap = bandDb(sp.samples, SR, 4500, 6000);
    check('speex stand-in is narrowband', gap < -50, `${gap.toFixed(1)} dB rel`);
    const st = await TF2Audio.process(mkBuffer(wide, SR), { codec: 'steam', agc: false, volume: 1 });
    const stHi = bandRms(st.samples, SR, 'highpass', 4000) / rms(st.samples);
    check('steam keeps its 4-12 kHz band', db(stHi) > -8, `${db(stHi).toFixed(1)} dB rel`);
  }

  console.log('\n[5b] Sender voice gate (Steam VAD, measured)');
  {
    const rmsDbfs = (db) => 10 ** (db / 20) * Math.SQRT2;          // sine amplitude for an RMS level
    const quiet = await TF2Audio.process(mkBuffer(tone(1000, 1.5, SR, rmsDbfs(-45)), SR), { codec: 'steam', volume: 1 });
    check('a steady -45 dBFS RMS tone never opens the gate (take: -42 dB sine silent)', peakAbs(quiet.samples) === 0 && quiet.codecInfo.gatedFrames === quiet.codecInfo.frames,
      `${quiet.codecInfo.gatedFrames}/${quiet.codecInfo.frames}`);
    const open = await TF2Audio.process(mkBuffer(speechLike(1.5, SR, -38), SR), { codec: 'steam', volume: 1 });
    check('speech-like input at -38 dBFS RMS is transmitted and boosted to the 20 dB cap', open.codecInfo.gatedFrames === 0 && open.codecInfo.dtxFrames === 0 && Math.abs(db(rms(open.samples, SR / 2)) + 18) < 1.5,
      `${open.codecInfo.gatedFrames} gated, ${db(rms(open.samples, SR / 2)).toFixed(1)} dB`);
    const forced = await TF2Audio.process(mkBuffer(speechLike(1.5, SR, -45), SR), { codec: 'steam', volume: 1, gate: false });
    check('gate: false transmits everything', forced.codecInfo.gatedFrames === 0 && forced.codecInfo.gate === null && Math.abs(db(rms(forced.samples, SR / 2)) + 25) < 1.5,
      `${db(rms(forced.samples, SR / 2)).toFixed(1)} dB`);
    const lower = await TF2Audio.process(mkBuffer(tone(1000, 1.5, SR, rmsDbfs(-45)), SR), { codec: 'steam', volume: 1, gateThresholdDb: -50 });
    check('the gate threshold is adjustable', lower.codecInfo.gatedFrames === 0 && lower.codecInfo.gate === -50);
    const legacy = await TF2Audio.process(mkBuffer(tone(1000, 1, SR, rmsDbfs(-45)), SR), { codec: 'speex', volume: 1 });
    check('push-to-talk engine codecs have no gate by default', legacy.codecInfo.gatedFrames === 0 && legacy.codecInfo.gate === null);
    // 0.5 s at -20 dBFS then 1.5 s at -60 dBFS. Steam's packets: the quiet tail is coded normally for ~10
    // frames, then DTX comfort noise, and transmission ends 22 frames (440 ms) after the last loud frame.
    const burst = new Float32Array(2 * SR);
    burst.set(tone(700, 0.5, SR, rmsDbfs(-20)));
    burst.set(tone(700, 1.5, SR, rmsDbfs(-60)), SR / 2);
    const hb = await TF2Audio.process(mkBuffer(burst, SR), { codec: 'steam', volume: 1 });
    const tail = (a, b) => rms(hb.samples, Math.round(a * SR), Math.round(b * SR));
    check('the gate holds 440 ms after speech, carrying the quiet tail at full auto-gain', Math.abs(db(tail(0.52, 0.66)) + 40) < 1.5 && peakAbs(hb.samples.subarray(Math.round(0.96 * SR))) === 0,
      `${db(tail(0.52, 0.66)).toFixed(1)} dB then silence`);
    check('the held tail falls into DTX comfort noise', hb.codecInfo.dtxFrames >= 5 && db(tail(0.74, 0.92)) < db(tail(0.52, 0.66)) - 6,
      `${hb.codecInfo.dtxFrames} DTX frames, ${db(tail(0.74, 0.92)).toFixed(1)} dB`);
    check('closed frames are neither encoded nor sent', hb.codecInfo.gatedFrames > 50 && hb.codecInfo.modes.hybrid + hb.codecInfo.modes.silk + hb.codecInfo.modes.celt === hb.codecInfo.frames - hb.codecInfo.gatedFrames,
      JSON.stringify({ gated: hb.codecInfo.gatedFrames, frames: hb.codecInfo.frames }));
    // A -60 dBFS floor, then speech at 1.0 s: the 120 ms before the onset is sent too (Steam's pre-roll).
    const onset = new Float32Array(2 * SR);
    onset.set(whiteNoise(1, SR, 10 ** (-60 / 20) * Math.sqrt(3), 5));
    onset.set(speechLike(1, SR, -20), SR);
    const po = await TF2Audio.process(mkBuffer(onset, SR), { codec: 'steam', volume: 1 });
    const pre = db(rms(po.samples, Math.round(0.89 * SR), Math.round(0.99 * SR)));
    // The white floor loses half its power in the 24 kHz resample and ~3 dB in the codec, then gains 20 dB.
    check('the gate sends 120 ms of pre-roll before an onset', peakAbs(po.samples.subarray(0, Math.round(0.86 * SR))) === 0 && pre > -49 && pre < -43, `${pre.toFixed(1)} dB`);
    const twoBursts = (gap) => { const x = new Float32Array(Math.round((1 + gap) * SR)); x.set(speechLike(0.5, SR, -20)); x.set(speechLike(0.5, SR, -20), Math.round((0.5 + gap) * SR)); return x; };
    const near = await TF2Audio.process(mkBuffer(twoBursts(0.5), SR), { codec: 'steam', volume: 1 });
    const far = await TF2Audio.process(mkBuffer(twoBursts(0.8), SR), { codec: 'steam', volume: 1 });
    check('pauses under hold + pre-roll stay in one talk spurt; longer ones restart the encoder', near.codecInfo.spurts === 1 && far.codecInfo.spurts === 2,
      `${near.codecInfo.spurts} / ${far.codecInfo.spurts}`);
    // Steam's encoder put the test signal's steady -36 and -30 dB sines into DTX; so does the model.
    const steady = await TF2Audio.process(mkBuffer(tone(1000, 2, SR, rmsDbfs(-30)), SR), { codec: 'steam', volume: 1 });
    const early = db(rms(steady.samples, 0, Math.round(0.3 * SR))), late = db(rms(steady.samples, SR, 2 * SR));
    check('a steady tone decays into DTX comfort noise', steady.codecInfo.dtxFrames > 30 && late < early - 3, `${steady.codecInfo.dtxFrames} DTX frames, ${early.toFixed(1)} -> ${late.toFixed(1)} dB`);
    // Stereo capture: the measured default takes the left channel, as a mono read of a stereo cable does.
    const L = tone(500, 1, SR, 0.2), Rch = new Float32Array(SR);
    const stereoSrc = { sampleRate: SR, length: SR, numberOfChannels: 2, getChannelData: (c) => c ? Rch : L };
    const capL = await TF2Audio.process(stereoSrc, { codec: 'steam', volume: 1, enableWarble: false, agc: false });
    const capR = await TF2Audio.process(stereoSrc, { codec: 'steam', volume: 1, enableWarble: false, agc: false, captureChannel: 'right' });
    const capM = await TF2Audio.process(stereoSrc, { codec: 'steam', volume: 1, enableWarble: false, agc: false, captureChannel: 'mix' });
    check('stereo input: left channel by default, right and mix on request', Math.abs(db(rms(capL.samples) / rms(L))) < 0.3 && rms(capR.samples) === 0 && Math.abs(db(rms(capM.samples) / rms(L)) + 6.02) < 0.3,
      `${db(rms(capL.samples) / rms(L)).toFixed(2)} / ${db(rms(capM.samples) / rms(L)).toFixed(2)} dB`);
  }

  console.log('\n[6] Clean path and codec bypass');
  {
    const src = tone(1000, 2, SR, 0.25);
    const { samples, sampleRate, codecInfo } = await TF2Audio.process(mkBuffer(src, SR), clean);
    const ratio = rms(samples) / rms(src);
    check('no NaN/Inf', !hasBadValues(samples));
    check('playback rate = source rate', sampleRate === SR, String(sampleRate));
    check('bypass with unity gain is level-transparent', Math.abs(db(ratio)) < 0.2, `${db(ratio).toFixed(2)} dB`);
    check('bypass is reported honestly', codecInfo.backend === 'bypass');
    const low = await TF2Audio.process(mkBuffer(tone(1000, 0.5, 16000, 0.2), 16000), clean);
    check('low-rate sources render at the 44.1 kHz mixer rate', low.sampleRate === 44100, String(low.sampleRate));
  }

  console.log('\n[7] Valve DSP room presets (real dsp_presets.txt parameters)');
  {
    const src = tone(440, 1.5, SR, 0.25);
    const inLen = Math.round(1.5 * SR);
    for (let id = 0; id <= 29; id++) {
      const { samples } = await TF2Audio.process(mkBuffer(src, SR), { ...clean, listenerPos: null, dspRoom: id });
      const ratio = rms(samples, 0, Math.min(inLen, samples.length)) / rms(src);
      check(`dsp ${id}: level sane`, ratio > 0.2 && ratio < 2.5, `${db(ratio).toFixed(2)} dB`);
      check(`dsp ${id}: not crushed`, clipFraction(samples, 0.95) < 0.02, `clip ${(clipFraction(samples, 0.95) * 100).toFixed(2)}%`);
      check(`dsp ${id}: no NaN/Inf`, !hasBadValues(samples));
    }
    for (const id of [7, 22]) {
      const { samples } = await TF2Audio.process(mkBuffer(src, SR), { ...clean, listenerPos: null, dspRoom: id });
      check(`dsp ${id}: has a tail`, samples.length > inLen + 0.3 * SR, `${((samples.length - inLen) / SR).toFixed(2)}s`);
    }
    const dry = await TF2Audio.process(mkBuffer(src, SR), { ...clean, listenerPos: null, dspRoom: 0 });
    check('dsp 0: exact passthrough length', dry.samples.length === inLen);
  }

  console.log('\n[8] Custom env (dsp_room 99) and processor robustness');
  {
    const src = tone(440, 1.5, SR, 0.25);
    const opts = { ...clean, listenerPos: null, dspRoom: 99 };
    const wet = await TF2Audio.process(mkBuffer(src, SR), { ...opts, customEnv: { duration: 1.2, decay: 2.0, mix: 0.6 } });
    const dry = await TF2Audio.process(mkBuffer(src, SR), { ...opts, customEnv: { duration: 1.2, decay: 2.0, mix: 0.0 } });
    check('custom mix adds a tail', wet.samples.length > dry.samples.length, `${wet.samples.length} vs ${dry.samples.length}`);
    check('custom mix changes output', diffRms(wet.samples, dry.samples) > 0.02 * rms(dry.samples));
    const ratio = rms(wet.samples, 0, dry.samples.length) / rms(src);
    check('custom level sane', ratio > 0.25 && ratio < 2.5, `${db(ratio).toFixed(2)} dB`);
    const x = whiteNoise(0.5, SR, 0.2, 3);
    const out = await TF2Audio.runDspChain(x, SR, [
      { type: 'rva', sizeMax: 60, sizeMin: 0, ndly: 3, fb: 0.9, gain: 1.0, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 }
    ], 0.45);
    const r2 = rms(out, 0, x.length) / rms(x);
    check('rva with sizeMin=0 stays finite and sane', !hasBadValues(out) && r2 > 0.2 && r2 < 3, `${db(r2).toFixed(2)} dB`);
  }

  console.log('\n[9] Packet loss and jitter (measured) + native PLC');
  {
    const burstStats = (mask, value = 1) => {
      let ones = 0, runs = 0, runLen = 0, runSum = 0;
      for (let i = 0; i <= mask.length; i++) {
        if (i < mask.length && mask[i] === value) { ones++; runLen++; }
        else if (runLen > 0) { runs++; runSum += runLen; runLen = 0; }
      }
      return { rate: ones / mask.length, meanBurst: runs ? runSum / runs : 0, runs };
    };
    const lossMask = TF2Audio.buildLossMask(40000, 1, 22, TF2Audio.mulberry32(1234));
    const ls = burstStats(lossMask);
    check('loss rate near target 22%', Math.abs(ls.rate - 0.22) < 0.02, `${(ls.rate * 100).toFixed(1)}%`);
    // Measured: net_fakeloss 5 on a listen server lost ~22% of frames in bursts of ~2.2 frames,
    // i.e. about 50 * 0.22 / 2.2 = 5 bursts per second.
    check('bursts average ~2.2 frames, ~5 per second at 22%', Math.abs(ls.meanBurst - 2.2) < 0.25 && Math.abs(ls.runs / (40000 / 50) - 5) < 0.6,
      `${ls.meanBurst.toFixed(2)} frames, ${(ls.runs / (40000 / 50)).toFixed(2)}/s`);
    for (const target of [1, 50, 70, 90, 99]) {
      const m = TF2Audio.buildLossMask(200000, 3, target, TF2Audio.mulberry32(56));
      const measured = m.reduce((a, b) => a + b, 0) * 100 / m.length;
      check(`loss ${target}% stays near target`, Math.abs(measured - target) < 1.5, `${measured.toFixed(2)}%`);
      check(`loss ${target}% groups complete packets`, m.every((x, i) => x === m[i - i % 3]));
    }
    const jm = TF2Audio.buildLossMask(200000, 1, 0, TF2Audio.mulberry32(9), 50);
    const late = jm.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / jm.length;
    const silentShare = jm.reduce((a, v) => a + (v === 2 ? 1 : 0), 0) / Math.max(1, jm.reduce((a, v) => a + (v > 0 ? 1 : 0), 0));
    check('50 ms jitter makes ~3.2% of frames late, a tenth of them silent', Math.abs(late - 0.032) < 0.003 && Math.abs(silentShare - 0.1) < 0.02,
      `${(late * 100).toFixed(2)}% late, ${(silentShare * 100).toFixed(0)}% silent`);
    check('late frames are isolated, not bursts', burstStats(jm, 1).meanBurst < 1.1, burstStats(jm, 1).meanBurst.toFixed(2));
    check('no loss and no jitter means no mask', TF2Audio.buildLossMask(100, 1, 0, TF2Audio.mulberry32(1), 0) === null);

    const src = whiteNoise(2, SR, 0.2, 42);
    const opts = { codec: 'steam', agc: false, volume: 1, listenerPos: 'open', lossPct: 25, frameMs: 20 };
    const none = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 0 });
    const lossy = await TF2Audio.process(mkBuffer(src, SR), opts);
    const eRatio = Math.pow(rms(lossy.samples) / rms(none.samples), 2);
    check('25% loss reduces energy, PLC fills some', eRatio > 0.35 && eRatio < 0.99, `energy ${eRatio.toFixed(3)}`);
    const f80 = await TF2Audio.process(mkBuffer(src, SR), { ...opts, frameMs: 80 });
    check('net_split changes the loss pattern', diffRms(lossy.samples, f80.samples) > 1e-6);
    check('net_split is reported in whole frames', f80.codecInfo.framesPerPacket === 4);
    const dead = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 100 });
    check('100% loss -> silence', rms(dead.samples) < 1e-6, `rms ${rms(dead.samples).toExponential(2)}`);

    const jproc = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 0, jitterMs: 100 });
    check('jitterMs wired into process(): late frames concealed or silent', diffRms(jproc.samples, none.samples) > 1e-4
      && jproc.codecInfo.lostFrames + jproc.codecInfo.underrunFrames > 0, `${jproc.codecInfo.lostFrames} concealed, ${jproc.codecInfo.underrunFrames} silent`);
  }

  console.log('\n[10] Input and option robustness');
  {
    const left = new Float32Array([1, -1, 0.5]);
    const right = new Float32Array([-1, 1, 0.5]);
    const stereo = { sampleRate: SR, length: left.length, numberOfChannels: 2, getChannelData: (c) => c ? right : left };
    const mono = TF2Audio.bufferToMono(stereo);
    check('stereo downmix averages channels', mono[0] === 0 && mono[1] === 0 && Math.abs(mono[2] - 0.5) < 1e-6);

    const src = tone(330, 0.25, SR, 0.2);
    const robust = await TF2Audio.process(mkBuffer(src, SR), {
      codec: 'not-a-codec', listenerPos: 'not-a-place', dspRoom: 99,
      customEnv: { duration: NaN, decay: Infinity, mix: 'bad' },
      micGain: NaN, voiceScale: Infinity, hp: 'bad', lp: NaN, maxGain: NaN, avgGain: 'x', volume: -3,
      bits: NaN, lossPct: Infinity, jitterMs: NaN, frameMs: 'bad', seed: NaN
    });
    check('invalid options fall back without NaN/Inf', robust.samples.length > 0 && !hasBadValues(robust.samples));
    const unknown = await TF2Audio.process(mkBuffer(src, SR), { codec: 'not-a-codec' });
    const known = await TF2Audio.process(mkBuffer(src, SR), { codec: 'steam' });
    check('unknown codec falls back to steam', diffRms(unknown.samples, known.samples) === 0);
    const again = await TF2Audio.process(mkBuffer(src, SR), { codec: 'steam' });
    check('deterministic render', again.samples.every((v, i) => v === known.samples[i]));

    const tiny = new Float32Array(17);
    tiny[0] = 0.5;
    const tinyResult = await TF2Audio.process(mkBuffer(tiny, 22050), { codec: 'speex' });
    check('very short buffers render safely', tinyResult.samples.length > 0 && !hasBadValues(tinyResult.samples));

    const hot = await TF2Audio.process(mkBuffer(tone(440, 0.5, SR, 0.9), SR), { ...clean, micGain: 4 });
    check('mic gain above unity clips the int16 capture', peakAbs(hot.samples) < 1.02 && clipFraction(hot.samples, 0.9) > 0.2);

    let rejected = false;
    try { await TF2Audio.process(null, {}); } catch (error) { rejected = error && error.name === 'TypeError'; }
    check('invalid source is rejected clearly', rejected);
  }

  console.log('\n[11] WAV encoding');
  {
    const src = tone(440, 0.5, SR, 0.25);
    const { samples, sampleRate, blob } = await TF2Audio.process(mkBuffer(src, SR), { codec: 'steam' });
    check('blob size = 44 + 2N', blob.size === 44 + samples.length * 2, String(blob.size));
    const ab = Buffer.from(await blob.arrayBuffer());
    check('RIFF/WAVE header', ab.toString('ascii', 0, 4) === 'RIFF' && ab.toString('ascii', 8, 12) === 'WAVE');
    check('header sample rate matches', ab.readUInt32LE(24) === sampleRate, String(ab.readUInt32LE(24)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
