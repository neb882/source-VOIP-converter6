/* =========================================================================
 * TF2 Voice Emulator — audio.js  (authentic DSP core, v3)
 *
 * Pure-DSP module, no Web Audio dependency: deterministic and testable
 * under Node (see tests/verify.js). Consumes CODEC_PROFILES, DSP_PRESETS,
 * LISTENER_POSITIONS from constants.js. Public surface unchanged:
 *
 *   TF2Audio.process(audioBuffer, opts) -> Promise<{ samples, sampleRate, blob }>
 *   TF2Audio.encodeWav(samples, rate)   -> Blob (audio/wav)
 *   TF2Audio.bufferToMono(buffer)       -> Float32Array
 *
 * Pipeline (mirrors the real Source voice path):
 *
 *   [capture]  downmix -> mic gain -> hard clip (ADC/mic-boost clipping)
 *   [encode]   anti-aliased resample to codec rate -> (AGC, Steam voice only)
 *              -> pre-emphasis (0.85, like CELT/Opus) -> band-limit ->
 *              TRANSFORM CODEC: per 512-sample frame, band energies are
 *              coarse+fine quantized and band shapes are PVQ-quantized
 *              under the real bit budget (vaudio_celt: 64 bytes/frame at
 *              22050 Hz = 22.05 kbps). Bit-starved bands use spectral
 *              folding — the actual source of CELT's "birdie"/warble sound.
 *   [network]  frames grouped into packets (net_split ms per packet);
 *              packets dropped by a bursty Gilbert-Elliott loss model;
 *              decoder PLC repeats the last good spectrum with decay.
 *   [decode]   noise floor -> matched de-emphasis -> upsample to playback.
 *   [listener] voice_scale -> underwater low-pass (if submerged) ->
 *              Source DSP chain: DFR/RVA/DLY/AMP/MDY processors with
 *              Valve's real dsp_presets.txt parameters -> soft limit.
 *
 * Deterministic: same input + settings -> identical output. Pass opts.seed
 * to vary the packet-loss pattern.
 * ========================================================================= */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Math helpers                                                       */
  /* ------------------------------------------------------------------ */

  const TAU = Math.PI * 2;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const finiteOr = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic hash -> [0,1). Used for folding signs, comb detuning, etc.
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

  function bufferToMono(buffer) {
    const ch = buffer.numberOfChannels;
    if (ch === 1) return buffer.getChannelData(0).slice(0);
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
  /* Resampling — polyphase windowed-sinc (anti-alias / anti-image)      */
  /* ------------------------------------------------------------------ */

  function resampleSinc(input, inRate, outRate) {
    if (!input.length || inRate === outRate) return input.slice(0);
    const ratio = inRate / outRate;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);

    const fc = 0.5 * Math.min(1, outRate / inRate) * 0.92;
    const zeros = 12;
    const halfW = Math.min(192, Math.max(4, Math.ceil(zeros / (2 * fc))));
    const taps = 2 * halfW;
    const PHASES = 128;

    const table = new Float32Array((PHASES + 1) * taps);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      const row = p * taps;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const t = (k - halfW + 1) - frac;
        const x = 2 * fc * t;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const u = Math.PI * clamp(t / halfW, -1, 1);
        const w = 0.42 + 0.5 * Math.cos(u) + 0.08 * Math.cos(2 * u);
        const v = sinc * w;
        table[row + k] = v;
        sum += v;
      }
      const norm = sum !== 0 ? 1 / sum : 1;
      for (let k = 0; k < taps; k++) table[row + k] *= norm;
    }

    const lastIn = input.length - 1;
    for (let i = 0; i < outLen; i++) {
      const c = i * ratio;
      const base = Math.floor(c);
      const row = Math.round((c - base) * PHASES) * taps;
      const j0 = base - halfW + 1;
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        let j = j0 + k;
        if (j < 0) j = 0; else if (j > lastIn) j = lastIn;
        acc += input[j] * table[row + k];
      }
      out[i] = acc;
    }
    return out;
  }

  function resampleLinear(input, inRate, outRate) {  // legacy export
    if (inRate === outRate) return input.slice(0);
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const i0 = srcPos | 0;
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = srcPos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
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
  /* Pre/de-emphasis (matched pair, applied at codec rate)               */
  /* ------------------------------------------------------------------ */

  function preEmphasis(samples, a) {
    if (!a) return samples;
    const out = new Float32Array(samples.length);
    let prev = 0;
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] - a * prev;
      prev = samples[i];
    }
    return out;
  }

  function deEmphasis(samples, a) {
    if (!a) return samples;
    const out = new Float32Array(samples.length);
    let prev = 0;
    for (let i = 0; i < samples.length; i++) {
      prev = samples[i] + a * prev;
      out[i] = prev;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Capture nonlinearities                                              */
  /* ------------------------------------------------------------------ */

  // Hard clip — the sound of Windows "+20 dB mic boost" hitting the ADC.
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

  // Simple AGC modelling Steam voice preprocessing: slow gain rise, fast
  // gain drop, targets ~-18 dBFS RMS.
  function applyAGC(samples, rate) {
    const target = 0.12;
    const envA = Math.exp(-1 / (0.050 * rate));   // 50 ms envelope
    const upA  = Math.exp(-1 / (0.400 * rate));   // gain rises slowly
    const dnA  = Math.exp(-1 / (0.015 * rate));   // gain drops fast
    const out = new Float32Array(samples.length);
    let env = target, gain = 1;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      env = Math.max(a, env * envA + a * (1 - envA));
      const want = clamp(target / Math.max(env, 1e-4), 0.25, 6);
      const alpha = want < gain ? dnA : upA;
      gain = gain * alpha + want * (1 - alpha);
      out[i] = samples[i] * gain;
    }
    return out;
  }

  /* ==================================================================== */
  /* TRANSFORM CODEC EMULATION                                            */
  /*                                                                      */
  /* CELT/Opus are MDCT codecs: per frame they quantize each critical     */
  /* band's energy (coarse 6 dB steps + fine bits) and the band's shape   */
  /* as a PVQ pulse vector, under a fixed bit budget. Bands that get no   */
  /* shape bits are reconstructed by FOLDING spectrum up from lower       */
  /* bands — that folding is the signature low-bitrate warble/birdies.    */
  /*                                                                      */
  /* We do the same thing on an STFT (sqrt-Hann, 50% overlap, hop =       */
  /* codec frame = 512 samples for vaudio_celt). Not bit-exact CELT, but  */
  /* the same artifact mechanics under the same 64-byte/frame budget.     */
  /* ==================================================================== */

  // Bark-style band edges (Hz), same layout family CELT uses.
  const BARK_EDGES = [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 2000,
    2400, 2800, 3200, 4000, 4800, 5600, 6800, 8000, 9600, 12000, 15600, 20000, 26000];

  function makeBandEdges(rate, fftSize) {
    const nyqBin = fftSize >> 1;
    const binHz = rate / fftSize;
    const edges = [0];
    for (let i = 1; i < BARK_EDGES.length; i++) {
      const bin = Math.min(nyqBin, Math.round(BARK_EDGES[i] / binHz));
      if (bin > edges[edges.length - 1] + 1) edges.push(bin);
      if (bin >= nyqBin) break;
    }
    if (edges[edges.length - 1] < nyqBin) edges.push(nyqBin);
    return edges;
  }

  // Rough per-pulse bit cost — enough to reproduce CELT's allocation
  // behaviour (low bands get resolved, high bands starve and fold).
  function pulsesForBits(dims, bits) {
    if (bits <= 0.5 || dims <= 0) return 0;
    let K = 0, used = 0;
    while (K < 96) {
      const cost = Math.log2(1 + (2 * dims) / (K + 1)) + 1;
      if (used + cost > bits) break;
      used += cost;
      K++;
    }
    return K;
  }

  // PVQ: quantize vec to K signed integer pulses (L1 = K), return the
  // L2-normalised reconstruction.
  function pvqQuantize(vec, K) {
    const n = vec.length;
    const y = new Float32Array(n);
    let l1 = 0;
    for (let i = 0; i < n; i++) l1 += Math.abs(vec[i]);
    if (l1 < 1e-12) { y[0] = K; }
    else {
      let used = 0;
      for (let i = 0; i < n; i++) {
        const t = K * Math.abs(vec[i]) / l1;
        const q = Math.floor(t + 0.5);
        y[i] = vec[i] < 0 ? -q : q;
        used += q;
      }
      // Adjust pulse count to exactly K (guarded; each step moves one pulse)
      let guard = 2 * n + K + 8;
      while (used > K && guard-- > 0) {
        let best = -1, bestErr = -Infinity;
        for (let i = 0; i < n; i++) {
          const a = Math.abs(y[i]);
          if (a <= 0) continue;
          const err = a - K * Math.abs(vec[i]) / l1;   // most over-allocated
          if (err > bestErr) { bestErr = err; best = i; }
        }
        if (best < 0) break;
        y[best] -= Math.sign(y[best]);
        used--;
      }
      while (used < K && guard-- > 0) {
        let best = 0, bestErr = -Infinity;
        for (let i = 0; i < n; i++) {
          const err = K * Math.abs(vec[i]) / l1 - Math.abs(y[i]); // most under-allocated
          if (err > bestErr) { bestErr = err; best = i; }
        }
        y[best] += (vec[best] < 0 ? -1 : 1);
        used++;
      }
    }
    let e = 0;
    for (let i = 0; i < n; i++) e += y[i] * y[i];
    const s = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < n; i++) y[i] *= s;
    return y;
  }

  // Spectral folding: build a unit shape for a bit-starved band by tiling
  // the lower band's quantized shape with pseudo-random signs.
  function foldShape(source, dims, frameIdx, bandIdx) {
    const y = new Float32Array(dims);
    if (source && source.length) {
      for (let i = 0; i < dims; i++) {
        const v = source[i % source.length];
        const flip = hash01(frameIdx, bandIdx, i) < 0.5 ? -1 : 1;
        y[i] = v * flip;
      }
    } else {
      for (let i = 0; i < dims; i++) y[i] = hash01(frameIdx, bandIdx, i) - 0.5;
    }
    let e = 0;
    for (let i = 0; i < dims; i++) e += y[i] * y[i];
    const s = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < dims; i++) y[i] *= s;
    return y;
  }

  /**
   * Run the transform codec over `samples`.
   *   codecCfg: { frameSamples, sampleRate }
   *   quantize: false = transparent transform (band-limit only)
   *   bytesPerFrame: bit budget when quantizing
   *   lossMask: Uint8Array per frame (1 = lost) or null
   */
  async function transformCodec(samples, rate, frameSamples, quantize, bytesPerFrame, lossMask, onProgress) {
    if (!samples.length) return samples;
    const hop = nextPow2(Math.max(64, frameSamples | 0));  // STFT hop must be pow-2
    const fftSize = hop * 2;
    const nyqBin = hop;

    const win = new Float32Array(fftSize);
    for (let n = 0; n < fftSize; n++) win[n] = Math.sin(Math.PI * (n + 0.5) / fftSize);

    const edges = makeBandEdges(rate, fftSize);
    const nb = edges.length - 1;

    // --- bit allocation (fixed per render) ---
    const totalBits = Math.max(48, Math.round(bytesPerFrame * 8));
    const fine = new Uint8Array(nb);
    const K = new Uint16Array(nb);
    {
      let energyBits = 0;
      for (let b = 0; b < nb; b++) {
        fine[b] = b < nb / 2 ? 2 : 1;
        energyBits += 2 + fine[b];
      }
      const shapeTotal = Math.max(0, totalBits - energyBits);
      const w = new Float32Array(nb);
      let wsum = 0;
      for (let b = 0; b < nb; b++) {
        const width = edges[b + 1] - edges[b];
        w[b] = Math.pow(width, 0.85) * (1.25 - 0.5 * b / Math.max(1, nb - 1));
        wsum += w[b];
      }
      for (let b = 0; b < nb; b++) {
        const dims = 2 * (edges[b + 1] - edges[b]);
        K[b] = pulsesForBits(dims, shapeTotal * w[b] / wsum);
      }
    }

    // --- codec state ---
    const prevLogE = new Float32Array(nb).fill(-14);
    let havePrev = false;
    const prevRe = new Float32Array(fftSize);
    const prevIm = new Float32Array(fftSize);
    let consecLost = 0;

    const pad = hop;
    const paddedLen = samples.length + 2 * pad + fftSize;
    const acc = new Float32Array(paddedLen);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);

    const shapes = new Array(nb).fill(null);   // per-band quantized shapes (this frame)

    const totalHops = Math.max(1, Math.ceil((paddedLen - fftSize) / hop) + 1);
    for (let start = 0, hopIdx = 0; start + fftSize <= paddedLen; start += hop, hopIdx++) {
      if ((hopIdx & 63) === 63) {
        if (onProgress) onProgress(hopIdx / totalHops);
        await microYield();
      }
      for (let n = 0; n < fftSize; n++) {
        const j = start + n - pad;
        re[n] = (j >= 0 && j < samples.length ? samples[j] : 0) * win[n];
        im[n] = 0;
      }
      fftInPlace(re, im, false);

      const frameIdx = Math.max(0, hopIdx - 1);  // frame index in input time
      const lost = lossMask ? (frameIdx < lossMask.length && lossMask[frameIdx] === 1) : false;

      if (lost) {
        // --- decoder PLC: repeat last good spectrum with decay ---
        consecLost++;
        const g = consecLost > 6 ? 0 : Math.pow(0.72, consecLost);
        if (havePrev && g > 0) {
          for (let k = 0; k < fftSize; k++) { re[k] = prevRe[k] * g; im[k] = prevIm[k] * g; }
        } else {
          re.fill(0); im.fill(0);
        }
      } else {
        consecLost = 0;
        if (quantize) {
          // --- encode/decode this frame under the bit budget ---
          for (let b = 0; b < nb; b++) {
            const s = edges[b], e = edges[b + 1], m = e - s, dims = 2 * m;

            // 1) band energy -> coarse (6 dB) + fine quantization w/ prediction
            let en = 1e-20;
            for (let k = s; k < e; k++) en += re[k] * re[k] + im[k] * im[k];
            const logE = clamp(0.5 * Math.log2(en), -30, 20);   // log2 amplitude
            const pred = havePrev ? prevLogE[b] : logE;
            const step = 1 / (1 << fine[b]);                    // in 6 dB units
            const qLogE = pred + Math.round((logE - pred) / step) * step;
            prevLogE[b] = qLogE;
            const E = Math.pow(2, qLogE);

            // 2) band shape -> PVQ pulses, or folding when starved
            let shape;
            if (K[b] > 0) {
              const vec = new Float32Array(dims);
              for (let i = 0; i < m; i++) { vec[2 * i] = re[s + i]; vec[2 * i + 1] = im[s + i]; }
              shape = pvqQuantize(vec, K[b]);
            } else {
              shape = foldShape(shapes[b > 0 ? b - 1 : 0], dims, frameIdx, b);
            }
            shapes[b] = shape;

            // 3) reconstruct: unit shape × quantized energy
            for (let i = 0; i < m; i++) {
              re[s + i] = shape[2 * i] * E;
              im[s + i] = shape[2 * i + 1] * E;
            }
          }
          // zero anything above the top band, keep spectrum conjugate-symmetric
          for (let k = edges[nb]; k <= nyqBin; k++) { re[k] = 0; im[k] = 0; }
          for (let k = 1; k < nyqBin; k++) {
            re[fftSize - k] = re[k];
            im[fftSize - k] = -im[k];
          }
          im[0] = 0; im[nyqBin] = 0;
        }
        prevRe.set(re); prevIm.set(im);
        havePrev = true;
      }

      fftInPlace(re, im, true);
      for (let n = 0; n < fftSize; n++) acc[start + n] += re[n] * win[n];
    }

    return acc.slice(pad, pad + samples.length);
  }

  /* ------------------------------------------------------------------ */
  /* Network: bursty packet loss (Gilbert-Elliott two-state model)       */
  /* Real loss is bursty — a bad stretch kills several consecutive       */
  /* packets, each packet carrying one or more codec frames.             */
  /* ------------------------------------------------------------------ */

  function buildLossMask(nFrames, framesPerPacket, lossPct, rand) {
    const p = clamp(lossPct / 100, 0, 1);
    if (p <= 0 || nFrames <= 0) return null;
    const mask = new Uint8Array(nFrames);
    if (p >= 1) { mask.fill(1); return mask; }
    const meanBurst = 2.2;                       // packets per loss burst (avg)
    const pBG = 1 / meanBurst;                   // leave bad state
    const pGB = Math.min(0.98, pBG * p / (1 - p)); // enter bad state
    let bad = rand() < p;
    for (let f = 0; f < nFrames; f += framesPerPacket) {
      if (bad) {
        for (let i = f; i < Math.min(f + framesPerPacket, nFrames); i++) mask[i] = 1;
      }
      bad = bad ? (rand() >= pBG) : (rand() < pGB);
    }
    return mask;
  }

  /* Late-packet "crackle": when the jitter buffer starves, playback emits
   * short hard gaps (1-3 ms) at packet boundaries — the classic TF2 voice
   * pop/crunch on a bad connection. Deterministic via the seeded PRNG.   */
  function applyJitterCrackle(samples, rate, packetSamples, pct, rand) {
    if (!(pct > 0) || !samples.length) return samples;
    const rnd = rand || Math.random;
    const out = samples.slice(0);
    const step = Math.max(32, packetSamples | 0);
    for (let off = 0; off < out.length; off += step) {
      if (rnd() * 100 < pct) {
        const gap = Math.round((1 + rnd() * 2) * rate / 1000);   // 1-3 ms
        const end = Math.min(off + gap, out.length);
        for (let i = off; i < end; i++) out[i] = 0;
      }
    }
    return out;
  }

  function rmsOf(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  }

  // Steep (-36 dB/oct) high-passed RMS — used to detect narrowband results
  // without bass leakage skewing the comparison.
  function steepHfRms(x, rate, f0) {
    let y = x;
    for (let i = 0; i < 3; i++) y = applyBiquad(y, biquadCoefs('highpass', rate, f0, 0.707));
    return rmsOf(y);
  }

  /* Real Opus round-trip via WebCodecs (browser-only). Used for the
   * Steam-voice profile when available: genuine Opus coloration instead of
   * the emulation. Returns null on any failure — including a result that
   * lost its top octaves (some encoders pick a narrowband VOIP mode) — so
   * callers can fall back to the emulation. */
  async function realOpusRoundTrip(samples, rate, bitrate) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return null;
    let encoder = null, decoder = null;
    let outs = [];
    try {
      // Encode at Opus's native 48 kHz — this is what Steam itself does —
      // and resample back to the profile rate afterwards. Encoding at other
      // rates pushes some browser encoders into narrowband VOIP modes.
      const encRate = 48000;
      const support = await AudioEncoder.isConfigSupported({
        codec: 'opus', sampleRate: encRate, numberOfChannels: 1, bitrate
      });
      if (!support || !support.supported) return null;

      const up = resampleSinc(samples, rate, encRate);

      const chunks = [];
      let failed = false;
      encoder = new AudioEncoder({
        output: (c) => chunks.push(c),
        error: () => { failed = true; }
      });
      try {
        // Hint the fullband music path; unknown members are ignored by
        // implementations that don't support them.
        encoder.configure({ codec: 'opus', sampleRate: encRate, numberOfChannels: 1,
                            bitrate, opus: { application: 'audio', signal: 'music' } });
      } catch (cfgErr) {
        encoder.configure({ codec: 'opus', sampleRate: encRate, numberOfChannels: 1, bitrate });
      }
      const frameLen = Math.round(encRate * 0.02);               // 20 ms frames
      for (let off = 0; off < up.length; off += frameLen) {
        const n = Math.min(frameLen, up.length - off);
        const data = up.slice(off, off + n);
        const ad = new AudioData({
          format: 'f32', sampleRate: encRate, numberOfFrames: n,
          numberOfChannels: 1, timestamp: Math.round(off / encRate * 1e6), data
        });
        try { encoder.encode(ad); }
        finally { ad.close(); }
      }
      await encoder.flush();
      encoder.close();
      encoder = null;
      if (failed || !chunks.length) return null;

      outs = [];
      decoder = new AudioDecoder({
        output: (a) => outs.push(a),
        error: () => { failed = true; }
      });
      decoder.configure({ codec: 'opus', sampleRate: encRate, numberOfChannels: 1 });
      for (const c of chunks) decoder.decode(c);
      await decoder.flush();
      decoder.close();
      decoder = null;
      if (failed || !outs.length) return null;

      let total = 0;
      for (const a of outs) total += a.numberOfFrames;
      const dec = new Float32Array(total);
      let w = 0;
      for (const a of outs) {
        const tmp = new Float32Array(a.numberOfFrames);
        a.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
        dec.set(tmp, w);
        w += a.numberOfFrames;
        a.close();
      }
      outs = [];
      // Align to the encoder input length (lookahead lands at the head),
      // then bring the result back to the profile rate.
      let aligned;
      if (dec.length >= up.length) {
        const offset = dec.length - up.length;
        aligned = dec.slice(offset, offset + up.length);
      } else {
        aligned = new Float32Array(up.length);
        aligned.set(dec);
      }
      const down = resampleSinc(aligned, encRate, rate);
      const out = down.length === samples.length ? down : (() => {
        const o = new Float32Array(samples.length);
        o.set(down.subarray(0, Math.min(down.length, samples.length)));
        return o;
      })();

      // Leak-proof narrowband check: steep-filtered HF must survive within
      // ~9 dB of the input, otherwise the encoder went phone-band and the
      // emulation will sound far more authentic.
      const hfIn = steepHfRms(samples, rate, 4500);
      const hfOut = steepHfRms(out, rate, 4500);
      if (hfIn > 1e-4 && hfOut < hfIn * 0.35) return null;
      return out;
    } catch (e) {
      return null;
    } finally {
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) {}
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
      for (const output of outs) { try { output.close(); } catch (e) {} }
    }
  }

  function addNoiseFloor(samples, level, rand) {
    if (!level) return samples;
    const rnd = rand || Math.random;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] + (rnd() * 2 - 1) * level;
    }
    return out;
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

  /**
   * Render a source AudioBuffer (or any { sampleRate, length,
   * numberOfChannels, getChannelData }) through the TF2 VOIP pipeline.
   *
   * opts = {
   *   codec:        key of CODEC_PROFILES   ('celt_22' default)
   *   listenerPos:  key of LISTENER_POSITIONS. Overrides dspRoom.
   *   dspRoom:      numeric id into DSP_PRESETS (when listenerPos absent)
   *   customEnv:    { duration, decay, mix } override for DSP_PRESETS[99]
   *   micGain:      pre-codec gain (mic boost; >1 clips like a real mic) [1.2]
   *   voiceScale:   post-codec receiver gain (voice_scale)              [1.0]
   *   hp / lp:      sender-side HP/LP in Hz                             [120 / 11000]
   *   bits:         bitrate scale — 16 = stock rate (64 B/frame for     [16]
   *                 vaudio_celt), lower = starved and warbly
   *   lossPct:      simulated packet loss %                             [0]
   *   frameMs:      net_split packet duration in ms (frames per packet) [20]
   *   enableWarble: false bypasses codec quantization (clean transform) [true]
   *   seed:         PRNG seed for the loss pattern / noise              [0xC0FFEE]
   * }
   *
   * Resolves to { samples: Float32Array, sampleRate, blob }
   */
  async function process(audioBuffer, opts = {}) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function' ||
        !Number.isFinite(audioBuffer.sampleRate) || audioBuffer.sampleRate <= 0) {
      throw new TypeError('TF2Audio.process requires a valid AudioBuffer-like source.');
    }
    const codecKey = opts.codec || 'celt_22';
    const codec = CODEC_PROFILES[codecKey] || CODEC_PROFILES.celt_22;

    // Resolve listener position / dsp_room -> preset id (copy + merge 99)
    let dspId = 0;
    if (opts.listenerPos && LISTENER_POSITIONS[opts.listenerPos]) {
      dspId = LISTENER_POSITIONS[opts.listenerPos].dsp;
    } else if (opts.dspRoom != null && DSP_PRESETS[opts.dspRoom]) {
      dspId = opts.dspRoom;
    }
    const dspPreset = DSP_PRESETS[dspId] || DSP_PRESETS[0];
    let dspChainDef = dspPreset.chain || [];
    let dspMix = dspPreset.mix || 0;
    if (dspPreset.custom) {
      const supplied = opts.customEnv || {};
      const env = {
        duration: clamp(finiteOr(supplied.duration, finiteOr(dspPreset.duration, 1.5)), 0.05, 6),
        decay: clamp(finiteOr(supplied.decay, finiteOr(dspPreset.decay, 3)), 0.5, 8),
        mix: clamp(finiteOr(supplied.mix, finiteOr(dspPreset.mix, 0.25)), 0, 1)
      };
      dspChainDef = customChain(env);
      dspMix = env.mix;
    }
    const listenerCfg = opts.listenerPos ? LISTENER_POSITIONS[opts.listenerPos] : null;

    const micGain      = clamp(finiteOr(opts.micGain, 1.2), 0, 20);
    const voiceScale   = clamp(finiteOr(opts.voiceScale, 1.0), 0, 4);
    const hp           = clamp(finiteOr(opts.hp, 120), 0, codec.sampleRate * 0.45);
    const lp           = clamp(finiteOr(opts.lp, Math.min(codec.bandLimit, 11000)), 100, codec.sampleRate * 0.49);
    const bits         = clamp(finiteOr(opts.bits, 16), 2, 32);
    const lossPct      = clamp(finiteOr(opts.lossPct, 0), 0, 100);
    const jitterPct    = clamp(finiteOr(opts.jitterPct, 0), 0, 100);
    const enableWarble = opts.enableWarble !== false;
    const rand         = mulberry32(finiteOr(opts.seed, 0xC0FFEE) >>> 0);

    const srcRate = audioBuffer.sampleRate;
    const codecRate = codec.sampleRate;
    const playbackRate = Math.max(22050, srcRate);
    const frameSamples = codec.frameSamples;
    const frameDurMs = 1000 * frameSamples / codecRate;
    const netFrameMs = clamp(finiteOr(opts.frameMs, frameDurMs), 5, 200);
    const framesPerPacket = clamp(Math.round(netFrameMs / frameDurMs), 1, 8);
    const bytesPerFrame = Math.max(12, Math.round(codec.bytesPerFrame * bits / 16));

    const yieldUI = microYield;
    const report = (f) => { if (typeof opts.onProgress === 'function') opts.onProgress(f); };

    /* ---- 1) Capture: downmix + mic gain + ADC hard clip ---- */
    let samples = bufferToMono(audioBuffer);
    if (micGain !== 1) {
      for (let i = 0; i < samples.length; i++) samples[i] *= micGain;
    }
    // Soft knee first (console-level saturation), hard edge only for real
    // overdrive — moderate gains stay musical, mic-spam gains stay crunchy.
    samples = softLimit(samples, 0.92);
    samples = hardClip(samples, 0.99);
    report(0.05);
    await yieldUI();

    /* ---- 2) Resample to codec rate; Steam voice runs AGC ---- */
    samples = resampleSinc(samples, srcRate, codecRate);
    if (codec.agc) samples = applyAGC(samples, codecRate);

    // Steam profile: try the REAL Opus codec (WebCodecs) on the clean,
    // un-emphasised signal — the engine feeds Opus raw PCM and Opus does
    // its own internal pre-emphasis. When it succeeds we skip our own
    // pre/de-emphasis and quantization entirely; the transform stage then
    // only applies network loss + PLC on top of the genuine Opus render.
    let realCoded = false;
    if (enableWarble && codec.webcodecs === 'opus' && opts.realCodec !== false) {
      const rt = await realOpusRoundTrip(samples, codecRate, codec.opusBitrate || 32000);
      if (rt) { samples = rt; realCoded = true; }
    }
    if (!realCoded) samples = preEmphasis(samples, codec.preEmphasis);

    /* ---- 3) Sender band-limit ---- */
    if (hp > 10) {
      samples = applyBiquad(samples, biquadCoefs('highpass', codecRate, hp, 0.707));
    }
    const lpEdge = Math.min(lp, codec.bandLimit);
    samples = applyBiquad(samples, biquadCoefs('lowpass', codecRate, lpEdge, 0.707));
    samples = applyBiquad(samples, biquadCoefs('lowpass', codecRate, lpEdge, 0.85));
    report(0.30);
    await yieldUI();

    /* ---- 4) Transform codec + network loss + PLC ---- */
    const nFrames = Math.ceil(samples.length / frameSamples) + 2;
    const lossMask = buildLossMask(nFrames, framesPerPacket, lossPct, rand);
    samples = await transformCodec(samples, codecRate, frameSamples,
                                   enableWarble && !realCoded, bytesPerFrame, lossMask,
                                   (f) => report(0.30 + 0.45 * Math.min(1, f)));
    report(0.75);
    await yieldUI();

    /* ---- 4b) Jitter-buffer starvation crackle (net_jitter) ---- */
    if (jitterPct > 0) {
      samples = applyJitterCrackle(samples, codecRate,
                                   frameSamples * framesPerPacket, jitterPct, rand);
    }

    /* ---- 5) Decode: noise floor + matched de-emphasis ---- */
    samples = addNoiseFloor(samples, codec.noiseFloor, rand);
    if (!realCoded) samples = deEmphasis(samples, codec.preEmphasis);

    /* ---- 6) Upsample to playback rate ---- */
    samples = resampleSinc(samples, codecRate, playbackRate);
    report(0.85);
    await yieldUI();

    /* ---- 7) Listener: voice_scale + underwater LP + dsp_room chain ---- */
    if (voiceScale !== 1) {
      const s = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) s[i] = samples[i] * voiceScale;
      samples = s;
    }
    if (listenerCfg && listenerCfg.extraLpf) {
      samples = applyBiquad(samples, biquadCoefs('lowpass', playbackRate, listenerCfg.extraLpf, 0.8));
    }
    samples = await runDspChain(samples, playbackRate, dspChainDef, dspMix);
    report(0.98);
    await yieldUI();

    /* ---- 8) Final safety soft-clip ---- */
    samples = softLimit(samples, 0.98);
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) throw new Error(`DSP produced a non-finite sample at index ${i}.`);
    }

    const blob = encodeWav(samples, playbackRate);
    report(1);
    return { samples, sampleRate: playbackRate, blob, realOpus: realCoded };
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
    resampleLinear,
    resampleSinc,
    softLimit,
    hardClip,
    biquadCoefs,
    applyBiquad,
    mulberry32,
    transformCodec,
    buildLossMask,
    runDspChain,
    makeBandEdges,
    applyJitterCrackle,
    realOpusRoundTrip
  };

  if (typeof window !== 'undefined') window.TF2Audio = TF2Audio;
  else if (typeof self !== 'undefined') self.TF2Audio = TF2Audio;
  else if (typeof globalThis !== 'undefined') globalThis.TF2Audio = TF2Audio;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Audio;
})();
