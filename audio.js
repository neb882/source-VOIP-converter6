/* TF2 Voice Emulator — local DSP and codec orchestration.
 *
 * Sender:   mono capture (left channel by default) -> capture gain / int16
 *           clip -> resample to the codec rate -> optional capture filters
 *           -> Steam voice gate (pre-roll, hold, one encoder per talk spurt)
 *           -> real libopus encode with Steam's VBR and DTX settings
 * Network:  20 ms packets grouped by net_split; measured burst loss and
 *           late (jittered) frames, seeded
 * Receiver: libopus decode + native concealment and comfort noise -> sender
 *           EQ -> engine voice rate -> Source-style auto-gain with int16
 *           clamp -> 44.1 kHz mixer (room DSP) -> output stage -> output rate
 *
 * The Steam profile, voice gate and receiver path are identified from 2026
 * voice_loopback recordings of music, speech and a calibrated test signal,
 * and from Steam's own voice packets in a SourceTV demo
 * (tests/REFERENCE_2026.md). Room processors are effects built from Valve's
 * preset data, not Valve's implementations.
 * Same decoded PCM + settings + pinned runtime gives repeatable output.
 *
 * TF2Audio.process(buffer, opts) -> { samples, sampleRate, blob, codecInfo }
 * TF2Audio.encodeWav(samples, rate) -> 16-bit mono WAV
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Math helpers                                                       */
  /* ------------------------------------------------------------------ */

  const TAU = Math.PI * 2;
  const INT16_FULL_SCALE = 32767 / 32768;
  const DEFAULT_SENDER_GATE = { thresholdDb: -39.5, prerollMs: 120, holdMs: 440 };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const finiteOr = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic hash -> [0,1). Used for comb detuning in the room DSP.
  function hash01(a, b, c) {
    const s = Math.sin(a * 12.9898 + b * 78.233 + (c || 0) * 37.719) * 43758.5453;
    return s - Math.floor(s);
  }

  // Cooperative yield — keeps the UI responsive during long renders
  // (no-op in bare JS contexts like the Node test sandbox).
  const microYield = (typeof setTimeout === 'function')
    ? () => new Promise(r => setTimeout(r, 0))
    : () => Promise.resolve();

  /* ------------------------------------------------------------------ */
  /* FFT — iterative radix-2, in-place, complex                          */
  /* ------------------------------------------------------------------ */

  function fftInPlace(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? TAU : -TAU) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr;        im[a] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Channel downmix                                                    */
  /* ------------------------------------------------------------------ */

  // Mono capture of a (possibly stereo) buffer: 'mix' averages every channel;
  // 'left' / 'right' take one channel, as a mono capture of a stereo virtual
  // cable does (the 2026 music loopback matched the left channel).
  function bufferToMono(buffer, channel = 'mix') {
    const ch = buffer.numberOfChannels;
    if (ch === 1) return buffer.getChannelData(0).slice(0);
    if (channel === 'left') return buffer.getChannelData(0).slice(0);
    if (channel === 'right') return buffer.getChannelData(1).slice(0);
    const out = new Float32Array(buffer.length);
    if (ch === 2) {
      const a = buffer.getChannelData(0), b = buffer.getChannelData(1);
      for (let i = 0; i < out.length; i++) out[i] = (a[i] + b[i]) * 0.5;
      return out;
    }
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i];
    }
    const inv = 1 / ch;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Resampling — exact rational polyphase, Kaiser-windowed sinc         */
  /*                                                                    */
  /* Equivalent to upsampling by `up`, filtering at the lower Nyquist and */
  /* decimating by `down`, but only the needed taps are evaluated. The    */
  /* filter is -6 dB at the lower Nyquist, flat to ~0.9 of it and at      */
  /* least 75 dB down 1.17x beyond it. Output is time-aligned to input.   */
  /* ------------------------------------------------------------------ */

  function besselI0(x) {
    let sum = 1, term = 1;
    const q = x * x / 4;
    for (let k = 1; k < 64; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < sum * 1e-16) break;
    }
    return sum;
  }

  const KAISER_BETA = 8.6;
  const ZEROS_PER_SIDE = 16;
  const kernelCache = new Map();
  function resampleKernel(up, down) {
    const key = `${up}/${down}`;
    if (kernelCache.has(key)) return kernelCache.get(key);
    const m = Math.max(up, down);
    const half = ZEROS_PER_SIDE * m;
    const h = new Float64Array(2 * half + 1);
    const i0Beta = besselI0(KAISER_BETA);
    let sum = 0;
    for (let k = 0; k <= 2 * half; k++) {
      const t = (k - half) / m;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = (k - half) / half;
      const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta;
      h[k] = sinc * w;
      sum += h[k];
    }
    const scale = up / sum;
    for (let k = 0; k < h.length; k++) h[k] *= scale;
    const kernel = { h, half };
    if (kernelCache.size > 16) kernelCache.clear();
    kernelCache.set(key, kernel);
    return kernel;
  }

  function resampleSinc(input, inRate, outRate) {
    inRate = Math.round(inRate); outRate = Math.round(outRate);
    if (!input.length || inRate === outRate) return Float32Array.from(input);
    const g = gcd(inRate, outRate);
    const up = outRate / g, down = inRate / g;
    const { h, half } = resampleKernel(up, down);
    const n = input.length;
    const outLen = Math.max(1, Math.round(n * up / down));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const t = i * down;                          // position at the up-rate
      let j = Math.ceil((t - half) / up);
      if (j < 0) j = 0;
      let jEnd = Math.floor((t + half) / up);
      if (jEnd > n - 1) jEnd = n - 1;
      let k = half + t - j * up;
      let acc = 0;
      for (; j <= jEnd; j++, k -= up) acc += input[j] * h[k];
      out[i] = acc;
    }
    return out;
  }

  // Source's software mixer converts voice to the mix rate by linear
  // interpolation; used for the low-rate legacy profiles.
  function resampleLinear(input, inRate, outRate) {
    if (inRate === outRate) return Float32Array.from(input);
    const ratio = inRate / outRate;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    const last = input.length - 1;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.min(last, pos | 0);
      const i1 = Math.min(last, i0 + 1);
      const frac = pos - (pos | 0);
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* FIR design / filtering                                             */
  /* ------------------------------------------------------------------ */

  // Frequency-sampling design with a Hamming window, matching
  // scipy.signal.firwin2 (linear gains interpolated between points).
  function firwin2(numtaps, freqs, gainsDb, rate) {
    const nyq = rate / 2;
    const nfreqs = 1 + (1 << Math.ceil(Math.log2(numtaps)));
    const size = 2 * (nfreqs - 1);
    const re = new Float64Array(size), im = new Float64Array(size);
    const gains = gainsDb.map(db => Math.pow(10, db / 20));
    for (let k = 0; k < nfreqs; k++) {
      const f = nyq * k / (nfreqs - 1);
      let seg = 0;
      while (seg < freqs.length - 2 && f > freqs[seg + 1]) seg++;
      const span = freqs[seg + 1] - freqs[seg];
      const mix = span > 0 ? clamp((f - freqs[seg]) / span, 0, 1) : 0;
      const gain = gains[seg] + (gains[seg + 1] - gains[seg]) * mix;
      const phase = -(numtaps - 1) / 2 * Math.PI * k / (nfreqs - 1);
      re[k] = gain * Math.cos(phase);
      im[k] = gain * Math.sin(phase);
      if (k > 0 && k < nfreqs - 1) { re[size - k] = re[k]; im[size - k] = -im[k]; }
    }
    im[nfreqs - 1] = 0;
    fftInPlace(re, im, true);
    const taps = new Float64Array(numtaps);
    for (let n = 0; n < numtaps; n++) {
      taps[n] = re[n] * (0.54 - 0.46 * Math.cos(TAU * n / (numtaps - 1)));
    }
    return taps;
  }

  // Linear-phase FIR with its group delay removed: output aligns to input.
  function applyFirZeroPhase(x, taps) {
    const n = x.length, m = taps.length, center = (m - 1) >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const k0 = Math.max(0, i + center - (n - 1));
      const k1 = Math.min(m - 1, i + center);
      for (let k = k0; k <= k1; k++) acc += taps[k] * x[i + center - k];
      out[i] = acc;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Biquads (RBJ)                                                       */
  /* ------------------------------------------------------------------ */

  function biquadCoefs(type, rate, f0, Q) {
    const w0 = TAU * clamp(f0, 1, rate * 0.49) / rate;
    const cosw = Math.cos(w0), sinw = Math.sin(w0);
    const alpha = sinw / (2 * Math.max(0.05, Q));
    let b0, b1, b2;
    if (type === 'lowpass') { b0 = (1 - cosw) / 2; b1 = 1 - cosw;    b2 = b0; }
    else /* highpass */     { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = b0; }
    const a0 = 1 + alpha;
    return {
      b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
      a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0
    };
  }

  function applyBiquad(x, c) {
    const out = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      out[i] = y;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Nonlinearities                                                      */
  /* ------------------------------------------------------------------ */

  // int16 conversion: anything past full scale is flattened.
  function hardClip(samples, t) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = clamp(samples[i], -t, t);
    return out;
  }

  function softLimit(samples, threshold = 0.85) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      if (Math.abs(x) <= threshold) out[i] = x;
      else {
        const sign = x < 0 ? -1 : 1;
        const over = (Math.abs(x) - threshold) / (1 - threshold);
        out[i] = sign * (threshold + (1 - threshold) * Math.tanh(over));
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Receiver auto-gain (Source voice channel)                          */
  /*                                                                    */
  /* Identified from the 2026 test-signal takes (tests/REFERENCE_2026). */
  /* The decoded voice is int16. Each 128-sample block sets a target    */
  /*   T = min(maxGain, 32767 / (mean + avgGain * (peak - mean)))       */
  /* so voice_avggain 0 drives the block mean to full scale and 1 the   */
  /* block peak; the default 0.5 overdrives a sine by 1.22x. Over the   */
  /* following block the gain starts at s*s*T_prev and steps toward s*T */
  /* in 1/128 fixed-point increments truncated toward zero, with        */
  /* s = voice_scale, and every sample is clamped to int16. At s = 1 the */
  /* gain ramps from the previous target and the sub-step remainder     */
  /* jumps at the block edge; other scales give the recorded sawtooth.  */
  /* All-zero blocks (no voice data) leave the state untouched.         */
  /* ------------------------------------------------------------------ */

  function receiverAutoGain(samples, options = {}) {
    const block = Math.max(1, Math.round(finiteOr(options.blockSize, 128)));
    const avgGain = Math.max(0, finiteOr(options.avgGain, 0.5));
    const maxGain = Math.max(0, finiteOr(options.maxGain, 10));
    const scale = Math.max(0, finiteOr(options.scale, 1));
    const out = new Float32Array(samples.length);
    let fixed = Math.trunc(scale * 128), step = 0, prevTarget = 1;
    for (let start = 0; start < samples.length; start += block) {
      const end = Math.min(samples.length, start + block);
      let total = 0, peak = 0;
      for (let i = start, j = 0; i < end; i++, j++) {
        const x = clamp(Math.round(samples[i] * 32768), -32768, 32767);
        const a = x < 0 ? -x : x;
        total += a;
        if (a > peak) peak = a;
        const y = Math.floor(x * (fixed + j * step) / 128);
        out[i] = (y > 32767 ? 32767 : (y < -32768 ? -32768 : y)) / 32768;
      }
      if (end - start < block) break;
      if (peak === 0) { fixed += block * step; step = 0; continue; }
      const mean = total / block;
      const target = Math.min(maxGain, 32767 / (mean + avgGain * (peak - mean)));
      const current = prevTarget * scale;
      fixed = Math.trunc(current * scale * 128);
      step = Math.trunc((target - current) / block * scale * 128);
      prevTarget = target;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Network: packet loss and jitter, measured in TF2                   */
  /*                                                                    */
  /* Loss is a two-state (Gilbert-Elliott) process over packets whose   */
  /* stationary rate is lossPct of voice frames and whose bursts last    */
  /* 2.2 frames on average, which reproduces the event rate, burst       */
  /* sizes and lost share of the 2026 net_fakeloss takes. The decoder    */
  /* conceals lost frames (mask 1). Jitter makes frames arrive too late: */
  /* 3.2% of frames at net_fakejitter 50, scaled linearly; one in ten    */
  /* plays as silence (mask 2) instead of being concealed. Packets group */
  /* net_split frames. See tests/REFERENCE_2026.md.                      */
  /* ------------------------------------------------------------------ */

  function buildLossMask(nFrames, framesPerPacket, lossPct, rand, jitterMs = 0) {
    nFrames = Math.max(0, Math.floor(finiteOr(nFrames, 0)));
    framesPerPacket = Math.max(1, Math.round(finiteOr(framesPerPacket, 1)));
    rand = typeof rand === 'function' ? rand : mulberry32(0xC0FFEE);
    const net = VOICE_ENGINE.network;
    const p = clamp(finiteOr(lossPct, 0) / 100, 0, 1);
    const late = clamp(net.lateFramesAt50ms * finiteOr(jitterMs, 0) / 50, 0, 0.5);
    if ((p <= 0 && late <= 0) || nFrames <= 0) return null;
    const mask = new Uint8Array(nFrames);
    if (p >= 1) { mask.fill(1); return mask; }
    // Mean burst in packets; at high loss, lengthen bursts rather than cap the rate.
    const meanBurst = Math.max(1, net.burstMeanFrames / framesPerPacket);
    const pBG = p > 0 ? Math.min(1 / meanBurst, 0.98 * (1 - p) / p) : 1;
    const pGB = p > 0 ? pBG * p / (1 - p) : 0;
    let bad = rand() < p;
    for (let f = 0; f < nFrames; f += framesPerPacket) {
      const end = Math.min(f + framesPerPacket, nFrames);
      if (bad) mask.fill(1, f, end);
      else if (late > 0) {
        for (let i = f; i < end; i++) {
          if (rand() < late) mask[i] = rand() < net.underrunShare ? 2 : 1;
        }
      }
      bad = bad ? (rand() >= pBG) : (rand() < pGB);
    }
    return mask;
  }

  // The same pinned codec runs in browsers, workers, and the Node tests.
  // Tests inject the module because their DSP sandbox has no import loader.
  let opusModulePromise;
  function loadOpusModule() {
    if (typeof TF2Opus !== 'undefined') return Promise.resolve(TF2Opus);
    if (!opusModulePromise) {
      opusModulePromise = import('./opus-codec.mjs').catch(error => {
        opusModulePromise = null;
        throw new Error('The bundled Opus codec could not load. Serve the complete folder over HTTP(S). ' +
          error.message);
      });
    }
    return opusModulePromise;
  }

  // Compatibility helper for external callers; no browser-dependent fallback.
  async function realOpusRoundTrip(samples, rate, bitrate, options = {}) {
    const opus = await loadOpusModule();
    return (await opus.roundTrip(samples, rate, bitrate, options)).samples;
  }

  /* ==================================================================== */
  /* SOURCE ENGINE DSP PROCESSORS                                         */
  /*                                                                      */
  /* The engine's dsp_room is not a convolution reverb — it's a serial    */
  /* chain of small IIR processors. These implement the ones the room     */
  /* presets use, with parameters transcribed from dsp_presets.txt into   */
  /* constants.js: DFR (series allpass diffusor), RVA (parallel feedback  */
  /* combs, low-passed and optionally modulated), DLY (low-passed echo),  */
  /* AMP (tremolo/distortion), MDY (modulated delay).                     */
  /* ==================================================================== */

  const DFR_BASE_MS = [13.7, 21.3, 29.1, 40.9];

  function dspDFR(x, rate, p) {
    const n = clamp(Math.round(p.ndly) || 2, 1, 4);
    const g = clamp(p.fb != null ? p.fb : 0.15, 0, 0.9);
    const size = p.size != null ? p.size : 1.0;
    let cur = x;
    for (let i = 0; i < n; i++) {
      const D = Math.max(1, Math.round(DFR_BASE_MS[i] * size * rate / 1000));
      const out = new Float32Array(cur.length);
      const buf = new Float32Array(D);
      let w = 0;
      for (let t = 0; t < cur.length; t++) {
        const vd = buf[w];
        const v = cur[t] + g * vd;
        out[t] = vd - g * v;
        buf[w] = v;
        w = (w + 1) % D;
      }
      cur = out;
    }
    return cur;
  }

  async function dspRVA(x, rate, p) {
    const n = clamp(Math.round(p.ndly) || 1, 1, 12);
    const fb = clamp(p.fb || 0, 0, 0.97);
    const gain = p.gain != null ? p.gain : 1.0;
    const lpA = p.cutoff > 0 ? Math.exp(-TAU * p.cutoff / rate) : 0;
    const fpar = p.fpar !== 0;
    const modSamp = (p.fmod || 0) * rate / 1000;
    const modHz = p.rate || 0;
    // Normalise each comb to unity *average* power (not unity peak), so the
    // preset gains behave like Valve's "0 dB in = 0 dB out" convention.
    const combScale = Math.sqrt(Math.max(0.06, 1 - fb * fb));

    const out = new Float32Array(x.length);
    for (let c = 0; c < n; c++) {
      // spread comb delays sizeMin..sizeMax with a deterministic detune
      const frac = n === 1 ? 1 : c / (n - 1);
      const hiMs = p.sizeMax != null ? p.sizeMax : 50;
      const loMs = p.sizeMin != null ? Math.min(p.sizeMin, hiMs) : hiMs;
      let dMs = loMs + (hiMs - loMs) * frac;
      dMs *= 1 + 0.017 * (hash01(c, 7, 3) - 0.5);
      const D = Math.max(2, Math.round(dMs * rate / 1000));
      const bufSize = D + Math.ceil(modSamp) + 4;
      const buf = new Float32Array(bufSize);
      let w = 0, lpState = 0;
      const phase = TAU * hash01(c, 13, 1);

      for (let t = 0; t < x.length; t++) {
        // modulated fractional delay read
        let Dt = D;
        if (modSamp > 0 && modHz > 0) {
          Dt = D + modSamp * Math.sin(TAU * modHz * t / rate + phase);
          if (Dt < 1) Dt = 1;
        }
        const rp = w - Dt;
        const ri = Math.floor(rp);
        const rf = rp - ri;
        const i0 = ((ri % bufSize) + bufSize) % bufSize;
        const i1 = (i0 + 1) % bufSize;
        let dl = buf[i0] * (1 - rf) + buf[i1] * rf;
        if (fpar && lpA > 0) {                    // low-pass inside the loop
          lpState = lpState * lpA + dl * (1 - lpA);
          dl = lpState;
        }
        const y = x[t] + fb * dl;
        buf[w] = y;
        w = (w + 1) % bufSize;
        out[t] += y * combScale;
      }
      await microYield();               // one yield per comb keeps UI alive
    }
    const sc = gain / Math.sqrt(n);
    for (let t = 0; t < out.length; t++) out[t] *= sc;
    if (!fpar && p.cutoff > 0) {                  // filter on the summed output
      const a = Math.exp(-TAU * p.cutoff / rate);
      let s = 0;
      for (let t = 0; t < out.length; t++) { s = s * a + out[t] * (1 - a); out[t] = s; }
    }
    return out;
  }

  function dspDLY(x, rate, p) {
    const D = Math.max(1, Math.round((p.delay || 100) * rate / 1000));
    const fb = clamp(p.fb || 0, 0, 0.95);
    const gain = p.gain != null ? p.gain : 1.0;
    const lpA = p.cutoff > 0 ? Math.exp(-TAU * p.cutoff / rate) : 0;
    const out = new Float32Array(x.length);
    const buf = new Float32Array(D);
    let w = 0, lpState = 0;
    for (let t = 0; t < x.length; t++) {
      let dl = buf[w];
      if (lpA > 0) { lpState = lpState * lpA + dl * (1 - lpA); dl = lpState; }
      const e = x[t] + fb * dl;
      buf[w] = e;
      w = (w + 1) % D;
      out[t] = gain * e;
    }
    return out;
  }

  function dspAMP(x, rate, p) {
    const gain = p.gain != null ? p.gain : 1.0;
    const out = new Float32Array(x.length);
    const modrate = p.modrate || 0;
    const depth = p.moddepth || 0;
    const glideA = Math.exp(-1 / (Math.max(1, p.modglide || 10) / 1000 * rate));
    const interval = modrate > 0 ? Math.max(1, Math.round(rate / modrate)) : 0;
    let cur = gain, target = gain, phaseHigh = true;

    const vthresh = p.vthresh || 0;
    const distmix = p.distmix || 0;

    for (let t = 0; t < x.length; t++) {
      if (interval > 0 && t % interval === 0) {
        phaseHigh = !phaseHigh;                   // alternate gain / gain*(1-depth)
        target = phaseHigh ? gain : gain * (1 - depth);
      }
      cur = cur * glideA + target * (1 - glideA);
      let y = x[t] * cur;
      if (distmix > 0 && vthresh > 0 && vthresh < 1) {
        const clipped = clamp(y, -vthresh, vthresh) / vthresh;
        y = y * (1 - distmix) + clipped * distmix;
      }
      out[t] = y;
    }
    return out;
  }

  function dspMDY(x, rate, p) {
    const D = Math.max(2, Math.round((p.delay || 100) * rate / 1000));
    const fb = clamp(p.fb || 0, 0, 0.95);
    const gain = p.gain != null ? p.gain : 1.0;
    const depthSamp = D * (p.moddepth || 0);
    const modHz = p.modrate || 0;
    const bufSize = D + Math.ceil(depthSamp) + 4;
    const out = new Float32Array(x.length);
    const buf = new Float32Array(bufSize);
    let w = 0;
    for (let t = 0; t < x.length; t++) {
      let Dt = D;
      if (depthSamp > 0 && modHz > 0) {
        Dt = D - depthSamp * 0.5 * (1 + Math.sin(TAU * modHz * t / rate));
        if (Dt < 1) Dt = 1;
      }
      const rp = w - Dt;
      const ri = Math.floor(rp);
      const rf = rp - ri;
      const i0 = ((ri % bufSize) + bufSize) % bufSize;
      const i1 = (i0 + 1) % bufSize;
      const dl = buf[i0] * (1 - rf) + buf[i1] * rf;
      const e = x[t] + fb * dl;
      buf[w] = e;
      w = (w + 1) % bufSize;
      out[t] = gain * e;
    }
    return out;
  }

  // Map the emulator's custom knobs (duration s, decay, mix) onto an RVA.
  function customChain(env) {
    const duration = Math.max(0.05, env.duration != null ? env.duration : 1.5);
    const decay = Math.max(0.5, env.decay != null ? env.decay : 3.0);
    const fb = clamp(Math.pow(0.001, 0.045 / duration), 0.3, 0.97); // T60 ≈ duration
    const cutoff = clamp(9000 / decay, 800, 12000);
    return [
      { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
      { type: 'rva', sizeMax: clamp(duration * 60, 25, 220), sizeMin: 12,
        ndly: 5, fb, gain: 1.2, cutoff, fpar: 1, fmod: 0, rate: 0 }
    ];
  }

  /**
   * Run a preset's processor chain and crossfade with the dry signal
   * (Source crossfades dsp output by `mix`). Renders extra tail and trims
   * trailing silence below -66 dBFS.
   */
  async function runDspChain(x, rate, chain, mix) {
    if (!chain || !chain.length || mix <= 0) return x;
    const tail = Math.min(4 * rate, 6 * rate);
    let wet = new Float32Array(x.length + tail);
    wet.set(x);
    for (const p of chain) {
      if (p.type === 'dfr') wet = dspDFR(wet, rate, p);
      else if (p.type === 'rva') wet = await dspRVA(wet, rate, p);
      else if (p.type === 'dly') wet = dspDLY(wet, rate, p);
      else if (p.type === 'amp') wet = dspAMP(wet, rate, p);
      else if (p.type === 'mdy') wet = dspMDY(wet, rate, p);
      await microYield();
    }
    const m = clamp(mix, 0, 1);
    // The diffusor decorrelates wet from dry, so the crossfade adds
    // incoherently; normalise so the blend stays near 0 dB overall.
    const norm = 1 / Math.sqrt((1 - m) * (1 - m) + m * m);
    const out = new Float32Array(wet.length);
    for (let i = 0; i < wet.length; i++) {
      out[i] = ((i < x.length ? x[i] * (1 - m) : 0) + wet[i] * m) * norm;
    }
    // trim trailing silence
    const thr = 0.0005;
    let end = out.length - 1;
    while (end > x.length && Math.abs(out[end]) < thr) end--;
    return out.slice(0, Math.min(out.length, end + 1 + Math.round(0.15 * rate)));
  }

  /* ------------------------------------------------------------------ */
  /* Main processing function                                            */
  /* ------------------------------------------------------------------ */

  const firCache = new Map();
  function profileEq(codec) {
    const eq = codec.decoderEq;
    if (!eq) return null;
    const key = `${codec.codecRate}:${eq.taps}:${eq.freqs}:${eq.gainsDb}`;
    if (!firCache.has(key)) firCache.set(key, firwin2(eq.taps, eq.freqs, eq.gainsDb, codec.codecRate));
    return firCache.get(key);
  }

  function resolveRoom(opts) {
    let dspId = 0;
    if (opts.listenerPos && LISTENER_POSITIONS[opts.listenerPos]) {
      dspId = LISTENER_POSITIONS[opts.listenerPos].dsp;
    } else if (opts.dspRoom != null && DSP_PRESETS[opts.dspRoom]) {
      dspId = opts.dspRoom;
    }
    const preset = DSP_PRESETS[dspId] || DSP_PRESETS[0];
    if (!preset.custom) return { chain: preset.chain || [], mix: preset.mix || 0 };
    const supplied = opts.customEnv || {};
    const env = {
      duration: clamp(finiteOr(supplied.duration, finiteOr(preset.duration, 1.5)), 0.05, 6),
      decay: clamp(finiteOr(supplied.decay, finiteOr(preset.decay, 3)), 0.5, 8),
      mix: clamp(finiteOr(supplied.mix, finiteOr(preset.mix, 0.25)), 0, 1)
    };
    return { chain: customChain(env), mix: env.mix };
  }

  /**
   * Render a source AudioBuffer (or any { sampleRate, length,
   * numberOfChannels, getChannelData }) through the TF2 voice pipeline.
   *
   * opts = {
   *   codec:        key of CODEC_PROFILES                               ['steam']
   *   listenerPos:  key of LISTENER_POSITIONS. Overrides dspRoom.
   *   dspRoom:      numeric id into DSP_PRESETS (when listenerPos absent)
   *   customEnv:    { duration, decay, mix } override for DSP_PRESETS[99]
   *   captureChannel: 'left' | 'right' | 'mix' for stereo input    ['left']
   *   micGain:      sender capture gain; > 1 clips the int16 capture   [1]
   *   hp / lp:      optional sender filters in Hz (off: hp <= 10,
   *                 lp >= 0.45 x codec rate)                           [off]
   *   bits:         bitrate scale; 16 = profile bitrate                 [16]
   *   lossPct:      % of voice frames lost, in bursts of ~2.2 frames     [0]
   *   frameMs:      net_split packet duration (whole 20 ms frames)      [20]
   *   jitterMs:     net_fakejitter in ms: late frames, measured          [0]
   *   enableWarble: false bypasses the codec (filters/engine remain)    [true]
   *   gate:         Steam sender voice gate; null = profile default     [null]
   *   gateThresholdDb: gate opening level, frame RMS in dBFS [profile/-39.5]
   *   agc:          receiver auto-gain (false = unity gain)             [true]
   *   avgGain:      voice_avggain, mean (0) to peak (1) normalization   [0.5]
   *   maxGain:      voice_maxgain gain cap                              [10]
   *   voiceScale:   voice_scale, applied inside the auto-gain           [1]
   *   volume:       output level after the mixer                        [0.5]
   *   seed:         PRNG seed for the loss pattern / crackle        [0xC0FFEE]
   * }
   *
   * Resolves to { samples: Float32Array, sampleRate, blob, codecInfo }
   */
  async function process(audioBuffer, opts = {}) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function' ||
        !Number.isFinite(audioBuffer.sampleRate) || audioBuffer.sampleRate <= 0 ||
        !Number.isInteger(audioBuffer.length) || audioBuffer.length < 0 ||
        !Number.isInteger(audioBuffer.numberOfChannels) || audioBuffer.numberOfChannels < 1) {
      throw new TypeError('TF2Audio.process requires a valid AudioBuffer-like source.');
    }
    const codecKey = Object.hasOwn(CODEC_PROFILES, opts.codec) ? opts.codec : 'steam';
    const codec = CODEC_PROFILES[codecKey];
    const engine = VOICE_ENGINE;
    const room = resolveRoom(opts);
    const listenerCfg = opts.listenerPos ? LISTENER_POSITIONS[opts.listenerPos] : null;

    const codecRate    = codec.codecRate;
    const micGain      = clamp(finiteOr(opts.micGain, 1), 0, 20);
    const hp           = clamp(finiteOr(opts.hp, 0), 0, codecRate * 0.45);
    const lp           = clamp(finiteOr(opts.lp, codecRate / 2), 100, codecRate / 2);
    const bits         = clamp(finiteOr(opts.bits, 16), 2, 32);
    const lossPct      = clamp(finiteOr(opts.lossPct, 0), 0, 100);
    const jitterMs     = clamp(finiteOr(opts.jitterMs, 0), 0, 500);
    const enableCodec  = opts.enableWarble !== false;
    const autoGain     = opts.agc !== false;
    const captureChannel = ['left', 'right', 'mix'].includes(opts.captureChannel) ? opts.captureChannel : 'left';
    const gateSpec     = codec.senderGate || DEFAULT_SENDER_GATE;
    const gateOn       = opts.gate == null ? !!codec.senderGate : !!opts.gate;
    const gateDb       = clamp(finiteOr(opts.gateThresholdDb, gateSpec.thresholdDb), -90, 0);
    const avgGain      = clamp(finiteOr(opts.avgGain, engine.autoGain.avgGain), 0, 2);
    const maxGain      = clamp(finiteOr(opts.maxGain, engine.autoGain.maxGain), 1, 100);
    const voiceScale   = clamp(finiteOr(opts.voiceScale, 1), 0, 4);
    const volume       = clamp(finiteOr(opts.volume, engine.volume), 0, 1);
    const rand         = mulberry32(finiteOr(opts.seed, 0xC0FFEE) >>> 0);

    const srcRate = audioBuffer.sampleRate;
    const mixRate = engine.mixRate;
    const playbackRate = Math.max(mixRate, Math.round(srcRate));
    const frameMs = 20;
    const framesPerPacket = clamp(Math.round(finiteOr(opts.frameMs, frameMs) / frameMs), 1, 10);
    const report = (f) => { if (typeof opts.onProgress === 'function') opts.onProgress(f); };

    /* ---- 1) Sender capture: downmix, capture gain, int16 clip ---- */
    let samples = bufferToMono(audioBuffer, captureChannel);
    if (!samples.every(Number.isFinite)) throw new TypeError('Source PCM contains a non-finite sample.');
    const playbackLength = Math.round(samples.length * playbackRate / srcRate);
    if (micGain !== 1) {
      for (let i = 0; i < samples.length; i++) samples[i] *= micGain;
    }
    samples = hardClip(samples, INT16_FULL_SCALE);
    report(0.05);
    await microYield();

    /* ---- 2) Resample to the codec rate; optional capture filters ---- */
    samples = resampleSinc(samples, srcRate, codecRate);
    if (hp > 10) samples = applyBiquad(samples, biquadCoefs('highpass', codecRate, hp, 0.707));
    if (lp < codecRate * 0.45) {
      samples = applyBiquad(samples, biquadCoefs('lowpass', codecRate, lp, 0.707));
      samples = applyBiquad(samples, biquadCoefs('lowpass', codecRate, lp, 0.707));
    }
    report(0.2);
    await microYield();

    /* ---- 3) Encode -> lose packets -> decode / conceal ---- */
    let codecInfo = { backend: 'bypass', sampleRate: codecRate, frameMs };
    if (enableCodec) {
      const opus = await loadOpusModule();
      const bitrate = Math.max(6000, Math.round(codec.bitrate * bits / 16));
      const result = await opus.roundTrip(samples, codecRate, bitrate, {
        application: codec.application, signal: codec.signal,
        complexity: codec.encoder?.complexity, vbr: codec.encoder?.vbr, dtx: codec.encoder?.dtx,
        gate: gateOn ? { thresholdDb: gateDb, prerollFrames: Math.round(gateSpec.prerollMs / frameMs),
          holdFrames: Math.round(gateSpec.holdMs / frameMs) } : null,
        makeLossMask: count => buildLossMask(count, framesPerPacket, lossPct, rand, jitterMs),
        yieldControl: microYield,
        onProgress: f => report(0.2 + 0.5 * f)
      });
      samples = result.samples;
      codecInfo = { ...result.info, framesPerPacket };
      const eq = profileEq(codec);
      if (eq) samples = applyFirZeroPhase(samples, eq);
    }
    report(0.72);
    await microYield();

    /* ---- 4) Receiver voice channel: auto-gain + int16 clamp ---- */
    samples = resampleSinc(samples, codecRate, codec.voiceRate);
    if (autoGain) {
      samples = receiverAutoGain(samples, { blockSize: engine.autoGain.blockSize,
        avgGain, maxGain, scale: voiceScale });
    } else {
      for (let i = 0; i < samples.length; i++) samples[i] *= voiceScale;
      samples = hardClip(samples, INT16_FULL_SCALE);
    }

    /* ---- 5) Mixer at 44.1 kHz: rate conversion, room DSP, output ---- */
    samples = codec.mixer === 'linear'
      ? resampleLinear(samples, codec.voiceRate, mixRate)
      : resampleSinc(samples, codec.voiceRate, mixRate);
    const dryMixLength = samples.length;
    report(0.8);
    await microYield();
    if (listenerCfg && listenerCfg.extraLpf) {
      samples = applyBiquad(samples, biquadCoefs('lowpass', mixRate, listenerCfg.extraLpf, 0.8));
    }
    samples = await runDspChain(samples, mixRate, room.chain, room.mix);
    if (engine.outputFir) samples = applyFirZeroPhase(samples, engine.outputFir);
    if (volume !== 1) {
      for (let i = 0; i < samples.length; i++) samples[i] *= volume;
    }
    report(0.9);
    await microYield();

    /* ---- 6) Output rate; keep every source frame plus any room tail ---- */
    const tail = Math.max(0, Math.round((samples.length - dryMixLength) * playbackRate / mixRate));
    samples = resampleSinc(samples, mixRate, playbackRate);
    const outLength = playbackLength + tail;
    if (samples.length !== outLength) {
      const aligned = new Float32Array(outLength);
      aligned.set(samples.subarray(0, outLength));
      samples = aligned;
    }
    samples = softLimit(samples, 0.98);
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) throw new Error(`DSP produced a non-finite sample at index ${i}.`);
    }

    const blob = encodeWav(samples, playbackRate);
    report(1);
    return { samples, sampleRate: playbackRate, blob, realOpus: enableCodec,
      codecInfo: { ...codecInfo, codec: codecKey, autoGain, voiceRate: codec.voiceRate } };
  }

  /* ------------------------------------------------------------------ */
  /* WAV encoder (16-bit PCM mono)                                      */
  /* ------------------------------------------------------------------ */

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate
    view.setUint16(32, 2, true);        // block align
    view.setUint16(34, 16, true);       // bits per sample
    wstr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = clamp(samples[i], -1, 1);
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ------------------------------------------------------------------ */
  /* Public surface                                                     */
  /* ------------------------------------------------------------------ */

  const TF2Audio = {
    process,
    encodeWav,
    bufferToMono,
    // exposed for tests / tools
    resampleSinc,
    resampleLinear,
    firwin2,
    applyFirZeroPhase,
    softLimit,
    hardClip,
    receiverAutoGain,
    biquadCoefs,
    applyBiquad,
    mulberry32,
    buildLossMask,
    runDspChain,
    realOpusRoundTrip
  };

  if (typeof window !== 'undefined') window.TF2Audio = TF2Audio;
  else if (typeof self !== 'undefined') self.TF2Audio = TF2Audio;
  else if (typeof globalThis !== 'undefined') globalThis.TF2Audio = TF2Audio;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Audio;
})();
