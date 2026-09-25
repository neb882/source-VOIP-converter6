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
    check('steam EQ is transparent below the SILK/CELT crossover', Math.abs(g1k) < 0.1 && Math.abs(g5k) < 0.1, `${g1k.toFixed(2)} / ${g5k.toFixed(2)} dB`);
    check('steam EQ trims the hybrid high band by the measured 2.5 dB', Math.abs(g9k + 2.5) < 0.2, `${g9k.toFixed(2)} dB`);
    check('steam EQ starts the band edge above 11.5 kHz', firGainDb(taps, 11500, 24000) > -3 && firGainDb(taps, 12000, 24000) < -5,
      `${firGainDb(taps, 11500, 24000).toFixed(2)} / ${firGainDb(taps, 12000, 24000).toFixed(2)} dB`);
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
    const quiet = TF2Audio.receiverAutoGain(tone(440, 1, R, 0.05), {});
    const loud = TF2Audio.receiverAutoGain(tone(440, 1, R, 0.3), {});
    const mq = meanAbs(quiet, R / 2), ml = meanAbs(loud, R / 2);
    check('mean |y| settles at voice_avggain (0.5) for quiet input', Math.abs(mq - 0.5) < 0.01, mq.toFixed(4));
    check('mean |y| settles at voice_avggain (0.5) for loud input', Math.abs(ml - 0.5) < 0.01, ml.toFixed(4));
    const tiny = tone(440, 1, R, 0.001);
    const capped = TF2Audio.receiverAutoGain(tiny, { maxGain: 16 });
    const gain = rms(capped, R / 2) / rms(tiny, R / 2);
    check('gain never exceeds voice_maxgain', gain <= 16.0001 && gain > 15.9, gain.toFixed(3));
    const dense = TF2Audio.receiverAutoGain(musicLike(1, R, 5), {});
    const pk = peakAbs(dense);
    check('output is clamped to int16 full scale', pk <= 32767 / 32768 + 1e-7 && pk > 0.99, pk.toFixed(6));
    check('dense input is hard-clipped at the ceiling', clipFraction(dense, 0.999) > 0.02, `${(clipFraction(dense, 0.999) * 100).toFixed(1)}%`);
    const onsetAt = 128 * 172;          // a block boundary
    const silentThenTone = new Float32Array(R);
    silentThenTone.set(tone(440, 0.5, R, 0.3), onsetAt);
    const onset = TF2Audio.receiverAutoGain(silentThenTone, {});
    check('digital silence stays silent', peakAbs(onset.subarray(0, onsetAt)) === 0);
    check('silent blocks hold the gain instead of arming maximum gain', peakAbs(onset.subarray(onsetAt, onsetAt + 128)) < 0.31,
      peakAbs(onset.subarray(onsetAt, onsetAt + 128)).toFixed(3));
    const half = TF2Audio.receiverAutoGain(tone(440, 1, R, 0.2), { scale: 0.5 });
    check('voice_scale scales the auto-gain target', Math.abs(meanAbs(half, R / 2) - 0.25) < 0.01, meanAbs(half, R / 2).toFixed(4));
    check('voice_scale 0 mutes exactly', peakAbs(TF2Audio.receiverAutoGain(tone(440, .2, R, .2), { scale: 0 })) === 0);
    // A level step: the gain must ramp across blocks, never jump inside one.
    const step = new Float32Array(2048).fill(0.1); step.fill(0.4, 1024);
    const g = TF2Audio.receiverAutoGain(step, { avgGain: 0.5 });
    let maxJump = 0; for (let i = 1; i < g.length; i++) maxJump = Math.max(maxJump, Math.abs(g[i] - g[i - 1]) * (i === 1024 ? 0 : 1));
    check('gain ramps smoothly between 128-sample blocks', maxJump < 0.05, maxJump.toFixed(4));
    check('block gain lags by one block, then reaches target', Math.abs(g[1024 + 255] - 0.5) < 1e-6 && g[1024 + 1] > 0.5,
      `${g[1025].toFixed(3)} -> ${g[1279].toFixed(3)}`);
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
    check('output volume scales the rendered file linearly', Math.abs(peakAbs(vol.samples) / peakAbs(r.samples) - expected) < 0.01,
      (peakAbs(vol.samples) / peakAbs(r.samples)).toFixed(4));
  }

  console.log('\n[5] Real codec modes per profile');
  {
    const src = musicLike(1, SR, 3);
    const expect = { steam: ['hybrid', 32000], steam_48: ['hybrid', 64000], celt_22: ['celt', 22000], celt_44: ['celt', 44000], speex: ['silk', 8000] };
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

  console.log('\n[9] Burst loss (Gilbert-Elliott) + native PLC');
  {
    const rand = TF2Audio.mulberry32(1234);
    const mask = TF2Audio.buildLossMask(20000, 1, 25, rand);
    let ones = 0, runs = 0, runLen = 0, runSum = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { ones++; runLen++; }
      else if (runLen > 0) { runs++; runSum += runLen; runLen = 0; }
    }
    if (runLen > 0) { runs++; runSum += runLen; }
    const meanLoss = ones / mask.length;
    const meanBurst = runs ? runSum / runs : 0;
    check('loss rate near target 25%', meanLoss > 0.18 && meanLoss < 0.32, `${(meanLoss * 100).toFixed(1)}%`);
    check('loss is bursty (mean run > 1.5 frames)', meanBurst > 1.5, meanBurst.toFixed(2));
    for (const target of [1, 50, 70, 90, 99]) {
      const m = TF2Audio.buildLossMask(200000, 3, target, TF2Audio.mulberry32(56));
      const measured = m.reduce((a, b) => a + b, 0) * 100 / m.length;
      check(`loss ${target}% stays near target`, Math.abs(measured - target) < 1.5, `${measured.toFixed(2)}%`);
      check(`loss ${target}% groups complete packets`, m.every((x, i) => x === m[i - i % 3]));
    }

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

    const jx = whiteNoise(1, 24000, 0.2, 9);
    const jout = TF2Audio.applyJitterCrackle(jx, 24000, 512, 40, TF2Audio.mulberry32(7));
    let zeros = 0;
    for (let i = 0; i < jout.length; i++) if (jout[i] === 0) zeros++;
    check('net_jitter zeroes short gaps', zeros > 24, `${zeros} zeroed samples`);
    check('net_jitter deterministic', diffRms(jout, TF2Audio.applyJitterCrackle(jx, 24000, 512, 40, TF2Audio.mulberry32(7))) === 0);
    const jproc = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 0, jitterPct: 30 });
    check('jitterPct wired into process()', diffRms(jproc.samples, none.samples) > 1e-4);
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
      bits: NaN, lossPct: Infinity, jitterPct: NaN, frameMs: 'bad', seed: NaN
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
