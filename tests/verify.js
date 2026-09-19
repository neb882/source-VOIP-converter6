/* =========================================================================
 * tests/verify.js — headless verification of the TF2 VOIP pipeline (v3).
 *
 * The DSP core (audio.js) is pure JS, so it runs under Node:
 *     node tests/verify.js
 * TF2_DIR env var points the suite at a copy of the sources elsewhere.
 *
 * Covers the authenticity pass:
 *   - transform codec: level sanity, bitrate starvation, bass retention
 *   - Valve DSP presets: level sanity, reverb tails, no blowout
 *   - Gilbert-Elliott burst loss statistics, PLC, determinism
 *   - Steam-voice AGC, band-limiting, WAV integrity, no NaNs
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

/* ---------------- helpers ---------------- */

function mkBuffer(channelData, sampleRate) {
  return {
    sampleRate,
    length: channelData.length,
    numberOfChannels: 1,
    getChannelData: () => channelData
  };
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

function rms(x, from, to) {
  const a = from || 0, b = to || x.length;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

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

function db(ratio) { return 20 * Math.log10(Math.max(ratio, 1e-12)); }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${name}${detail ? '   [' + detail + ']' : ''}`); }
  else      { fail++; console.error(`  FAIL  ${name}${detail ? '   [' + detail + ']' : ''}`); }
}

const base = {
  micGain: 1, voiceScale: 1, hp: 120, lp: 11000,
  bits: 16, lossPct: 0, enableWarble: true
};

/* ---------------- tests ---------------- */

async function main() {
  sandbox.TF2Opus = await import('../opus-codec.mjs');
  const SR = 48000;

  console.log('\n[1] Transparent path (quantization off, dsp 0)');
  {
    const src = tone(1000, 2, SR, 0.25);
    const { samples, sampleRate } = await TF2Audio.process(mkBuffer(src, SR), {
      ...base, enableWarble: false, codec: 'celt_22', listenerPos: 'open'
    });
    const ratio = rms(samples) / rms(src);
    check('no NaN/Inf', !hasBadValues(samples));
    check('playback rate = source rate', sampleRate === SR, String(sampleRate));
    check('level ~unity', ratio > 0.8 && ratio < 1.2, `${db(ratio).toFixed(2)} dB`);
  }

  console.log('\n[2] Transform codec at stock bitrate (vaudio_celt, 64 B/frame)');
  {
    const src = tone(350, 2, SR, 0.25);
    const coded = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'celt_22', listenerPos: 'open' });
    const clean = await TF2Audio.process(mkBuffer(src, SR), { ...base, enableWarble: false, codec: 'celt_22', listenerPos: 'open' });
    const ratio = rms(coded.samples) / rms(src);
    check('level within 4.5 dB of source', Math.abs(db(ratio)) < 4.5, `${db(ratio).toFixed(2)} dB`);
    check('codec audibly does something', diffRms(coded.samples, clean.samples) > 0.01 * rms(clean.samples));
    check('no NaN/Inf', !hasBadValues(coded.samples));

    const a = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'celt_22', listenerPos: 'open' });
    let identical = a.samples.length === coded.samples.length;
    if (identical) for (let i = 0; i < a.samples.length; i++) {
      if (a.samples[i] !== coded.samples[i]) { identical = false; break; }
    }
    check('deterministic render', identical);
  }

  console.log('\n[3] Bitrate starvation increases distortion');
  {
    const src = whiteNoise(2, SR, 0.15, 11);
    const clean  = await TF2Audio.process(mkBuffer(src, SR), { ...base, enableWarble: false, codec: 'celt_22', listenerPos: 'open' });
    const stock  = await TF2Audio.process(mkBuffer(src, SR), { ...base, bits: 16, codec: 'celt_22', listenerPos: 'open' });
    const starved = await TF2Audio.process(mkBuffer(src, SR), { ...base, bits: 6, codec: 'celt_22', listenerPos: 'open' });
    const dStock = diffRms(stock.samples, clean.samples);
    const dStarved = diffRms(starved.samples, clean.samples);
    check('bits=6 distorts more than bits=16', dStarved > dStock * 1.15,
      `${dStarved.toFixed(4)} vs ${dStock.toFixed(4)}`);
    check('starved level still sane', rms(starved.samples) / rms(src) > 0.3 && rms(starved.samples) / rms(src) < 2.5,
      `${db(rms(starved.samples) / rms(src)).toFixed(2)} dB`);
    check('no NaN/Inf', !hasBadValues(starved.samples));
  }

  console.log('\n[4] Bass survives the codec');
  {
    const bass = tone(150, 2, SR, 0.25);
    const b = await TF2Audio.process(mkBuffer(bass, SR), { ...base, hp: 0, codec: 'celt_22', listenerPos: 'open' });
    const ratio = rms(b.samples) / rms(bass);
    check('150 Hz retained', ratio > 0.4, `${db(ratio).toFixed(2)} dB`);
  }

  console.log('\n[5] Valve DSP room presets (real dsp_presets.txt parameters)');
  {
    const src = tone(440, 1.5, SR, 0.25);
    const inLen = Math.round(1.5 * SR);
    for (let id = 0; id <= 29; id++) {
      const { samples } = await TF2Audio.process(mkBuffer(src, SR), {
        ...base, enableWarble: false, codec: 'celt_22', dspRoom: id
      });
      const ratio = rms(samples, 0, Math.min(inLen, samples.length)) / rms(src);
      check(`dsp ${id}: level sane`, ratio > 0.2 && ratio < 2.5, `${db(ratio).toFixed(2)} dB`);
      check(`dsp ${id}: not crushed`, clipFraction(samples, 0.95) < 0.02,
        `clip ${(clipFraction(samples, 0.95) * 100).toFixed(2)}%`);
      check(`dsp ${id}: no NaN/Inf`, !hasBadValues(samples));
    }
    // reverb tails actually ring out
    for (const id of [7, 22]) {
      const { samples } = await TF2Audio.process(mkBuffer(src, SR), {
        ...base, enableWarble: false, codec: 'celt_22', dspRoom: id
      });
      check(`dsp ${id}: has a tail`, samples.length > inLen + 0.3 * SR,
        `${((samples.length - inLen) / SR).toFixed(2)}s`);
    }
    // dry preset has no tail
    const dry = await TF2Audio.process(mkBuffer(src, SR), {
      ...base, enableWarble: false, codec: 'celt_22', dspRoom: 0
    });
    check('dsp 0: passthrough length', Math.abs(dry.samples.length - inLen) < 0.05 * SR);
  }

  console.log('\n[6] Custom env (dsp_room 99)');
  {
    const src = tone(440, 1.5, SR, 0.25);
    const wet = await TF2Audio.process(mkBuffer(src, SR), {
      ...base, enableWarble: false, codec: 'celt_22', dspRoom: 99,
      customEnv: { duration: 1.2, decay: 2.0, mix: 0.6 }
    });
    const dry = await TF2Audio.process(mkBuffer(src, SR), {
      ...base, enableWarble: false, codec: 'celt_22', dspRoom: 99,
      customEnv: { duration: 1.2, decay: 2.0, mix: 0.0 }
    });
    check('custom mix adds a tail', wet.samples.length > dry.samples.length,
      `${wet.samples.length} vs ${dry.samples.length}`);
    check('custom mix changes output', diffRms(wet.samples, dry.samples) > 0.02 * rms(dry.samples));
    const ratio = rms(wet.samples, 0, dry.samples.length) / rms(src);
    check('custom level sane', ratio > 0.25 && ratio < 2.5, `${db(ratio).toFixed(2)} dB`);
  }

  console.log('\n[6b] DSP processor robustness');
  {
    const x = whiteNoise(0.5, SR, 0.2, 3);
    const out = await TF2Audio.runDspChain(x, SR, [
      { type: 'rva', sizeMax: 60, sizeMin: 0, ndly: 3, fb: 0.9, gain: 1.0, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 }
    ], 0.45);
    const ratio = rms(out, 0, x.length) / rms(x);
    check('rva with sizeMin=0 stays finite', !hasBadValues(out));
    check('rva with sizeMin=0 level sane', ratio > 0.2 && ratio < 3, `${db(ratio).toFixed(2)} dB`);
  }

  console.log('\n[7] Burst loss (Gilbert-Elliott) + PLC');
  {
    // statistics of the mask itself
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
      const mask = TF2Audio.buildLossMask(200000, 3, target, TF2Audio.mulberry32(56));
      const measured = mask.reduce((a, b) => a + b, 0) * 100 / mask.length;
      check(`loss ${target}% stays near target`, Math.abs(measured - target) < 1.5, `${measured.toFixed(2)}%`);
      check(`loss ${target}% groups complete packets`, mask.every((x, i) => x === mask[i - i % 3]));
    }

    const src = whiteNoise(2, SR, 0.2, 42);
    const opts = { ...base, codec: 'steam', listenerPos: 'open', lossPct: 25, frameMs: 20 };
    const none = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 0 });
    const lossy = await TF2Audio.process(mkBuffer(src, SR), opts);
    const eRatio = Math.pow(rms(lossy.samples) / rms(none.samples), 2);
    check('25% loss reduces energy, PLC fills some', eRatio > 0.35 && eRatio < 0.99, `energy ${eRatio.toFixed(3)}`);

    const f80 = await TF2Audio.process(mkBuffer(src, SR), { ...opts, frameMs: 80 });
    check('net_split changes the loss pattern', diffRms(lossy.samples, f80.samples) > 1e-6);

    const dead = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 100 });
    check('100% loss -> near-silence', rms(dead.samples) < 0.15 * rms(src), `rms ${rms(dead.samples).toFixed(5)}`);

    // net_jitter buffer-starvation crackle
    const jx = whiteNoise(1, 24000, 0.2, 9);
    const jout = TF2Audio.applyJitterCrackle(jx, 24000, 512, 40, TF2Audio.mulberry32(7));
    let zeros = 0;
    for (let i = 0; i < jout.length; i++) if (jout[i] === 0) zeros++;
    check('net_jitter zeroes short gaps', zeros > 24, `${zeros} zeroed samples`);
    const jout2 = TF2Audio.applyJitterCrackle(jx, 24000, 512, 40, TF2Audio.mulberry32(7));
    check('net_jitter deterministic', diffRms(jout, jout2) === 0);
    const jproc = await TF2Audio.process(mkBuffer(src, SR), { ...opts, lossPct: 0, jitterPct: 30 });
    check('jitterPct wired into process()', diffRms(jproc.samples, none.samples) > 1e-4);
  }

  console.log('\n[8] Steam voice AGC');
  {
    const quiet = tone(440, 2, SR, 0.02);
    const st = await TF2Audio.process(mkBuffer(quiet, SR), { ...base, enableWarble: false, codec: 'steam', listenerPos: 'open' });
    const ce = await TF2Audio.process(mkBuffer(quiet, SR), { ...base, enableWarble: false, codec: 'celt_22', listenerPos: 'open' });
    const rSteam = rms(st.samples) / rms(quiet);
    const rCelt = rms(ce.samples) / rms(quiet);
    check('AGC boosts quiet input on steam path', rSteam > rCelt * 1.4,
      `steam ${db(rSteam).toFixed(1)} dB vs celt ${db(rCelt).toFixed(1)} dB`);
  }

  console.log('\n[9] Codec band-limiting');
  {
    const src = whiteNoise(2, SR, 0.15, 7);
    const { samples } = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'celt_22', listenerPos: 'open' });
    const hi = bandRms(samples, SR, 'highpass', 13000);
    check('celt_22: little energy above 13 kHz', hi / rms(samples) < 0.06, `${db(hi / rms(samples)).toFixed(1)} dB`);

    // Regression: the codec paths must keep their top octaves — a broken
    // steam render once came out phone-band (everything above ~5 kHz gone).
    for (const ck of ['steam', 'steam_48', 'celt_22']) {
      const r = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: ck, listenerPos: 'open' });
      const hi4k = bandRms(r.samples, SR, 'highpass', 4000) / rms(r.samples);
      check(`${ck}: highs above 4 kHz retained`, hi4k > 0.25, `${db(hi4k).toFixed(1)} dB rel`);
    }

    const sp = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'speex', listenerPos: 'open' });
    const spHi = bandRms(sp.samples, SR, 'highpass', 6000);
    check('speex: narrowband', !hasBadValues(sp.samples) && spHi / rms(sp.samples) < 0.06,
      `${db(spHi / rms(sp.samples)).toFixed(1)} dB`);

    const c44 = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'celt_44', listenerPos: 'open' });
    check('celt_44: renders clean', !hasBadValues(c44.samples) && c44.samples.length > 0);
  }

  console.log('\n[10] Input and option robustness');
  {
    const left = new Float32Array([1, -1, 0.5]);
    const right = new Float32Array([-1, 1, 0.5]);
    const stereo = {
      sampleRate: SR, length: left.length, numberOfChannels: 2,
      getChannelData: (channel) => channel ? right : left
    };
    const mono = TF2Audio.bufferToMono(stereo);
    check('stereo downmix averages channels', mono[0] === 0 && mono[1] === 0 && Math.abs(mono[2] - 0.5) < 1e-6);

    const src = tone(330, 0.25, SR, 0.2);
    const robust = await TF2Audio.process(mkBuffer(src, SR), {
      codec: 'not-a-codec', listenerPos: 'not-a-place', dspRoom: 99,
      customEnv: { duration: NaN, decay: Infinity, mix: 'bad' },
      micGain: NaN, voiceScale: Infinity, hp: 'bad', lp: NaN,
      bits: NaN, lossPct: Infinity, jitterPct: NaN, frameMs: 'bad', seed: NaN
    });
    check('invalid options fall back without NaN/Inf', robust.samples.length > 0 && !hasBadValues(robust.samples));
    const unknown = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'not-a-codec' });
    const known = await TF2Audio.process(mkBuffer(src, SR), { ...base, codec: 'celt_22' });
    check('unknown codec falls back to celt_22', diffRms(unknown.samples, known.samples) === 0);

    const tiny = new Float32Array(17);
    tiny[0] = 0.5;
    const tinyResult = await TF2Audio.process(mkBuffer(tiny, 22050), { ...base, codec: 'speex' });
    check('very short buffers render safely', tinyResult.samples.length > 0 && !hasBadValues(tinyResult.samples));

    const half = TF2Audio.resampleSinc(src, SR, SR / 2);
    const roundTrip = TF2Audio.resampleSinc(half, SR / 2, SR);
    check('resampler length tracks rate ratio', Math.abs(half.length - src.length / 2) <= 1);
    check('resampler round-trip stays finite', roundTrip.length === src.length && !hasBadValues(roundTrip));

    let rejected = false;
    try { await TF2Audio.process(null, {}); } catch (error) { rejected = error && error.name === 'TypeError'; }
    check('invalid source is rejected clearly', rejected);
  }

  console.log('\n[11] WAV encoding');
  {
    const src = tone(440, 0.5, SR, 0.25);
    const { samples, sampleRate, blob } = await TF2Audio.process(mkBuffer(src, SR), {
      ...base, codec: 'celt_22', listenerPos: 'open'
    });
    check('blob size = 44 + 2N', blob.size === 44 + samples.length * 2, String(blob.size));
    const ab = Buffer.from(await blob.arrayBuffer());
    check('RIFF/WAVE header', ab.toString('ascii', 0, 4) === 'RIFF' && ab.toString('ascii', 8, 12) === 'WAVE');
    check('header sample rate matches', ab.readUInt32LE(24) === sampleRate, String(ab.readUInt32LE(24)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
