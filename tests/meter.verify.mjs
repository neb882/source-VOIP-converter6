// The loudness meter (meter.js) against ITU-R BS.1770-4 and EBU Tech 3341/3342
// reference behaviour.
//
//   node tests/meter.verify.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TF2Meter = require('../meter.js');
let passed = 0;
function check(name, ok, detail = '') { assert.ok(ok, `${name}${detail ? ` (${detail})` : ''}`); passed++; console.log(`  ok    ${name}${detail ? `   [${detail}]` : ''}`); }

// Sine with 50 ms raised-cosine fades, so the edges add no inter-sample overshoot.
function sine(freq, amplitude, seconds, rate, phase = 0) {
  const n = Math.round(seconds * rate), fade = rate * 0.05;
  return Float32Array.from({ length: n }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * freq * i / rate + phase) * Math.sin(Math.PI / 2 * Math.min(1, Math.min(i, n - 1 - i) / fade)));
}
const concat = (...parts) => { const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

console.log('\n[Meter 1] K-weighting');
{
  // BS.1770-4 table 1 and 2: the filters at 48 kHz.
  const [shelf, highpass] = TF2Meter.kWeighting(48000);
  const expect = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585, -1.99004745483398, 0.99007225036621];
  const got = [...shelf.b, ...shelf.a, ...highpass.a];
  check('48 kHz coefficients match BS.1770-4', got.every((v, i) => near(v, expect[i], 1e-12)));
}

console.log('\n[Meter 2] Integrated loudness');
for (const rate of [44100, 48000, 96000]) {
  const r = TF2Meter.analyze(sine(997, 1, 10, rate), rate);
  check(`${rate} Hz: a full-scale 997 Hz sine in one channel reads -3.01 LUFS`, near(r.integrated, -3.01, 0.05), r.integrated.toFixed(3));
}
{
  const r = TF2Meter.analyze(sine(1000, 0.1, 20, 48000), 48000);
  check('a 1 kHz sine at -20 dBFS reads -23.0 LUFS', near(r.integrated, -23.0, 0.05), r.integrated.toFixed(3));
  // Gating: silence around the tone does not lower the reading.
  const gated = TF2Meter.analyze(concat(new Float32Array(48000 * 10), sine(1000, 0.1, 20, 48000), new Float32Array(48000 * 10)), 48000);
  // Blocks straddling the tone's edges pass the gates and pull it down slightly.
  check('the absolute gate ignores silence', near(gated.integrated, r.integrated, 0.1), gated.integrated.toFixed(3));
  // Relative gate: a part 20 LU down is excluded from the integrated level.
  const quiet = TF2Meter.analyze(concat(sine(1000, 0.1, 20, 48000), sine(1000, 0.01, 20, 48000)), 48000);
  check('the relative gate ignores a part 20 LU quieter', near(quiet.integrated, r.integrated, 0.1), quiet.integrated.toFixed(3));
  check('silence has no loudness', TF2Meter.analyze(new Float32Array(48000), 48000).integrated === -Infinity);
  check('under 400 ms there is no integrated loudness', TF2Meter.analyze(sine(1000, 0.1, 0.3, 48000), 48000).integrated === null);
}

console.log('\n[Meter 3] Loudness range and maxima');
{
  // EBU Tech 3342 case 1 (as one channel): 20 s at -20 LUFS then 20 s at -30 LUFS -> LRA 10 LU.
  const level = (lufs) => Math.pow(10, (lufs + 3.01) / 20);
  const r = TF2Meter.analyze(concat(sine(1000, level(-20), 20, 48000), sine(1000, level(-30), 20, 48000)), 48000);
  check('EBU 3342 two-level case: LRA 10 LU', near(r.lra, 10, 0.2), r.lra.toFixed(2));
  check('maximum short-term and momentary loudness read the loud part', near(r.shortTermMax, -20, 0.1) && near(r.momentaryMax, -20, 0.1),
    `${r.shortTermMax.toFixed(2)} / ${r.momentaryMax.toFixed(2)}`);
  check('a steady tone has no loudness range', near(TF2Meter.analyze(sine(1000, 0.1, 10, 48000), 48000).lra, 0, 0.1));
  check('under 3 s there is no loudness range', TF2Meter.analyze(sine(1000, 0.1, 2, 48000), 48000).lra === null);
}

console.log('\n[Meter 4] Peaks, RMS, DC');
{
  // A sine at a quarter of the rate, 45 degrees off the sample grid: samples
  // peak at -3.01 dBFS, the waveform between them at 0 dBTP.
  for (const rate of [44100, 48000]) {
    const r = TF2Meter.analyze(sine(rate / 4, 1, 1, rate, Math.PI / 4), rate);
    check(`${rate} Hz: fs/4 sine at 45°: sample peak -3.01, true peak 0.0 dBTP`,
      near(r.samplePeak, -3.01, 0.02) && near(r.truePeak, 0, 0.05), `${r.samplePeak.toFixed(2)} / ${r.truePeak.toFixed(2)}`);
  }
  const r = TF2Meter.analyze(Float32Array.from({ length: 96000 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 48000);
  check('true peak never reads below the sample peak', r.truePeak >= r.samplePeak);
  check('sine RMS and crest factor', near(r.rms, -9.03, 0.05) && near(r.crest, 3.01, 0.05), `${r.rms.toFixed(2)} dBFS, crest ${r.crest.toFixed(2)}`);
  check('peak-to-loudness ratio', near(r.plr, r.truePeak - r.integrated, 1e-9));
  const dc = TF2Meter.analyze(Float32Array.from({ length: 48000 }, () => 0.05), 48000);
  check('DC offset', near(dc.dc, 0.05, 1e-6));
}

console.log(`\n${passed} passed, 0 failed`);
