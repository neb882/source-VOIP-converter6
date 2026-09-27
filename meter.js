/* Level and loudness of a render, for the meter under the visualizer and the
 * loudness-matched A/B:
 *   - integrated loudness per ITU-R BS.1770-4: K-weighting, 400 ms blocks with
 *     75% overlap, gates at -70 LUFS and 10 LU below. The render is one
 *     channel and is measured as one (a dual-mono playback reads 3 dB higher).
 *   - loudness range per EBU Tech 3342: 3 s short-term loudness every 100 ms,
 *     gates at -70 LUFS and 20 LU below, 10th to 95th percentile
 *   - maximum momentary (400 ms) and short-term (3 s) loudness
 *   - true peak, 4x oversampled with a 32-tap windowed-sinc interpolator,
 *     evaluated between every pair of samples within 8 dB of the sample peak
 *   - sample peak, RMS, crest factor, peak-to-loudness ratio, DC offset
 * Runs in the page and in audio-worker.js.
 *
 * TF2Meter.analyze(samples, sampleRate) -> stats; levels in dB, -Infinity for
 * silence, null where the file is too short (under 0.4 s, or 3 s for LRA).
 * stats.history holds momentary and short-term loudness every 100 ms
 * (Float32Array, LUFS); value k covers the window ending at (k + 4) * 0.1 s
 * (momentary) or (k + 30) * 0.1 s (short-term).
 */
(function () {
  'use strict';

  const toDb = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
  const loudness = (meanSquare) => -0.691 + toDb(meanSquare);

  // The two K-weighting stages (high shelf, then high-pass) at any rate, from
  // the BS.1770 prototypes' parameters, as libebur128 derives them.
  function kWeighting(rate) {
    let K = Math.tan(Math.PI * 1681.974450955533 / rate), Q = 0.7071752369554196;
    const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    K = Math.tan(Math.PI * 38.13547087602444 / rate); Q = 0.5003270373238773;
    a0 = 1 + K / Q + K * K;
    const highpass = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    return [shelf, highpass];
  }

  function biquad(x, { b, a }) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  // Loudness of the blocks that pass the absolute gate and the relative one
  // `relative` LU below their power mean.
  function gated(energies, relative) {
    const above = energies.filter(e => loudness(e) > -70);
    if (!above.length) return { energies: [], level: -Infinity };
    const threshold = loudness(above.reduce((s, e) => s + e, 0) / above.length) - relative;
    const kept = above.filter(e => loudness(e) > threshold);
    return { energies: kept, level: loudness(kept.reduce((s, e) => s + e, 0) / kept.length) };
  }

  // 4x interpolation phases (1/4, 2/4, 3/4 between samples): 32 taps each,
  // Kaiser-windowed sinc, normalized to unity gain at DC.
  const TAPS = 16;
  const PHASES = [1, 2, 3].map((p) => {
    const h = new Float64Array(2 * TAPS);
    let sum = 0;
    for (let k = -TAPS + 1; k <= TAPS; k++) {
      const t = k - p / 4, r = t / TAPS;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const w = besselI0(8 * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(8);
      h[k + TAPS - 1] = sinc * w;
      sum += sinc * w;
    }
    for (let i = 0; i < h.length; i++) h[i] /= sum;
    return h;
  });
  function besselI0(x) {
    let sum = 1, term = 1;
    for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
    return sum;
  }

  function truePeak(x, samplePeak) {
    let peak = samplePeak;
    const threshold = samplePeak * 0.4;              // -8 dB
    const n = x.length;
    for (let i = 0; i + 1 < n; i++) {
      if (Math.abs(x[i]) < threshold && Math.abs(x[i + 1]) < threshold) continue;
      // Points between x[i] and x[i + 1]: taps x[i - 15] .. x[i + 16].
      for (const h of PHASES) {
        let v = 0;
        for (let k = 0; k < 2 * TAPS; k++) {
          const j = i - TAPS + 1 + k;
          if (j >= 0 && j < n) v += x[j] * h[k];
        }
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    return peak;
  }

  function analyze(samples, sampleRate) {
    const rate = Math.round(sampleRate), n = samples.length;
    let peak = 0, sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i], a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v; sumSq += v * v;
    }
    const [shelf, highpass] = kWeighting(rate);
    const k = biquad(biquad(samples, shelf), highpass);
    // Sum of K-weighted squares per 100 ms segment.
    const segments = Math.floor(n / (rate / 10));
    const segment = new Float64Array(segments);
    for (let s = 0; s < segments; s++) {
      const from = Math.round(s * rate / 10), to = Math.round((s + 1) * rate / 10);
      let e = 0;
      for (let i = from; i < to; i++) e += k[i] * k[i];
      segment[s] = e;
    }
    const windows = (count) => {
      const out = [], length = count * rate / 10;
      let e = 0;
      for (let s = 0; s < segments; s++) {
        e += segment[s];
        if (s >= count) e -= segment[s - count];
        if (s >= count - 1) out.push(Math.max(0, e) / length);
      }
      return out;
    };
    const momentary = windows(4), shortTerm = windows(30);
    const integrated = momentary.length ? gated(momentary, 10).level : null;
    let lra = null;
    if (shortTerm.length) {
      const kept = gated(shortTerm, 20).energies.map(loudness).sort((a, b) => a - b);
      if (kept.length) {
        const at = (q) => kept[Math.min(kept.length - 1, Math.max(0, Math.round(q * (kept.length - 1))))];
        lra = at(0.95) - at(0.10);
      }
    }
    const max = (values) => (values.length ? loudness(Math.max(...values)) : null);
    const tp = n ? truePeak(samples, peak) : 0;
    const history = {
      hop: 0.1,
      momentary: Float32Array.from(momentary, loudness),
      shortTerm: Float32Array.from(shortTerm, loudness)
    };
    const rms = n ? Math.sqrt(sumSq / n) : 0;
    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return {
      duration: n / sampleRate,
      integrated,
      lra,
      momentaryMax: max(momentary),
      shortTermMax: max(shortTerm),
      truePeak: db(tp),
      samplePeak: db(peak),
      rms: db(rms),
      crest: peak > 0 && rms > 0 ? db(peak) - db(rms) : null,
      plr: integrated !== null && Number.isFinite(integrated) && tp > 0 ? db(tp) - integrated : null,
      dc: n ? sum / n : 0,
      history
    };
  }

  const TF2Meter = { analyze, kWeighting };
  if (typeof window !== 'undefined') window.TF2Meter = TF2Meter;
  else if (typeof self !== 'undefined') self.TF2Meter = TF2Meter;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Meter;
})();
