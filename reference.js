/* Comparing the simulation with a real TF2 recording ("take") of the same
 * source: finding the source in the take, putting the take on the source's
 * timeline, and the measures that identified the real chain
 * (tests/REFERENCE_2026.md): level-matched band spectra, short-term level
 * tracking and the receiver's clipping signature.
 *
 * Runs in the page, in audio-worker.js and in Node (tests/reference.*.mjs).
 * locate() and the narrowing filter need TF2Audio (audio.js) for its
 * band-limited resampler and biquads.
 *
 *   TF2Reference.locate(take, takeRate, source, sourceRate)
 *     -> { offsetSeconds, scale, correlation, matches, polarity }
 *        where source time = offsetSeconds + scale * take time
 *   TF2Reference.warp(take, takeRate, timeline, outRate, length)
 *     -> the take on the source's timeline (zero where it has no audio)
 *   TF2Reference.compareTake(real, sim, rate) -> { bands, levelTracking, clip }
 */
(function () {
  'use strict';

  const db = (power) => 10 * Math.log10(Math.max(1e-15, power));

  function fft(re, im, inverse = false) {
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

  // Normalized cross-correlation of `template` against every position of
  // `source`, by FFT. The source's transform is computed once, so many
  // templates can be located cheaply.
  function createMatcher(source, maxTemplateLength) {
    let n = 1;
    while (n < source.length + maxTemplateLength - 1) n *= 2;
    const sre = new Float64Array(n), sim = new Float64Array(n);
    const sums = new Float64Array(source.length + 1), energy = new Float64Array(source.length + 1);
    for (let i = 0; i < source.length; i++) {
      sre[i] = source[i]; sums[i + 1] = sums[i] + source[i]; energy[i + 1] = energy[i] + source[i] ** 2;
    }
    fft(sre, sim);
    const re = new Float64Array(n), im = new Float64Array(n);
    return (template) => {
      if (!template.length || source.length < template.length || template.length > maxTemplateLength) throw new Error('Invalid matching lengths.');
      let mean = 0, templateEnergy = 0;
      for (const v of template) mean += v / template.length;
      re.fill(0); im.fill(0);
      for (let i = 0; i < template.length; i++) { re[i] = template[i] - mean; templateEnergy += re[i] ** 2; }
      if (templateEnergy < 1e-15) return { sample: null, correlation: 0 };
      fft(re, im);
      for (let i = 0; i < n; i++) {
        const r = sre[i] * re[i] + sim[i] * im[i];
        im[i] = sim[i] * re[i] - sre[i] * im[i]; re[i] = r;
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
    };
  }

  function findMatch(source, template) {
    if (!template.length || source.length < template.length) throw new Error('Invalid matching lengths.');
    return createMatcher(source, template.length)(template);
  }

  function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.round((sorted.length - 1) * fraction)];
  }

  // Reject repeated musical phrases unless they support the same continuous
  // timeline at three or more positions. Do not present a random maximum
  // correlation as a verified match.
  function consistentTimeline(matches) {
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

  const BAND_EDGES = [40, 80, 120, 200, 300, 500, 1000, 2000, 3000, 5000, 8000, 10000, 11000, 12000, 16000, 19000];
  function spectrum(samples, rate, size = 2048) {
    const bands = new Float64Array(BAND_EDGES.length - 1);
    const re = new Float64Array(size), im = new Float64Array(size);
    const band = new Int8Array(size / 2).fill(-1);
    for (let i = 1; i < size / 2; i++) {
      const hz = i * rate / size;
      for (let j = 0; j < bands.length; j++) if (hz >= BAND_EDGES[j] && hz < BAND_EDGES[j + 1]) { band[i] = j; break; }
    }
    let frames = 0;
    for (let start = 0; start + size <= samples.length; start += size / 2) {
      for (let i = 0; i < size; i++) re[i] = samples[start + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (size - 1)));
      im.fill(0);
      fft(re, im); frames++;
      for (let i = 1; i < size / 2; i++) if (band[i] >= 0) bands[band[i]] += re[i] ** 2 + im[i] ** 2;
    }
    return bands.map(x => x / Math.max(1, frames));
  }

  function rmsDb(samples) {
    if (!samples.length) return null;
    let sum = 0;
    for (const v of samples) sum += v * v;
    return db(sum / samples.length);
  }

  function describePair(input, output, rate) {
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
  function clipSignature(samples, rate) {
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
  function levelTracking(recorded, rendered, rate, seconds = .5) {
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

  // Band-limited fractional resampling kernels (Blackman-windowed sinc, 64
  // taps, 256 phases): linear interpolation would itself attenuate the high
  // frequencies being measured.
  function timelineKernels(cutoff) {
    const half = 32, phases = 256;
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
    return { half, phases, kernels };
  }

  // Samples of `source` at startSeconds * rate + i * scale; throws outside it.
  function sampleTimeline(source, rate, startSeconds, scale, length) {
    if (!(scale > 0) || !Number.isFinite(startSeconds) || !Number.isInteger(length) || length < 0) throw new Error('Invalid timeline.');
    const { half, phases, kernels } = timelineKernels(.49 / Math.max(1, scale));
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

  // The take on the source's timeline at outRate: output sample i is source
  // time i / outRate, which is take time (t - offsetSeconds) / scale. Zero
  // where the take has no audio.
  function warp(take, takeRate, timeline, outRate, length) {
    const step = takeRate / (outRate * timeline.scale);
    const { half, phases, kernels } = timelineKernels(.49 / Math.max(1, step));
    const out = new Float32Array(length);
    const start = -timeline.offsetSeconds / timeline.scale * takeRate;
    for (let i = 0; i < length; i++) {
      const position = start + i * step, base = Math.floor(position), fraction = position - base;
      if (base + half < 0 || base - half + 1 >= take.length) continue;
      const phase = fraction * phases, lower = Math.floor(phase), blend = phase - lower;
      const a = kernels[lower], b = kernels[lower + 1];
      let value = 0;
      for (let k = 0; k < a.length; k++) {
        const j = base - half + 1 + k;
        if (j >= 0 && j < take.length) value += take[j] * (a[k] + (b[k] - a[k]) * blend);
      }
      out[i] = value;
    }
    return out;
  }

  // Band-limit to 100 Hz .. rate / 2 at a low analysis rate: waveforms still
  // correlate through the codec, gate and clipping there.
  function narrow(samples, sampleRate, rate) {
    const audio = typeof TF2Audio !== 'undefined' ? TF2Audio : null;
    if (!audio) throw new Error('TF2Reference needs TF2Audio (audio.js).');
    return audio.applyBiquad(audio.resampleSinc(samples, sampleRate, rate), audio.biquadCoefs('highpass', rate, 100, .707));
  }

  // Where the source plays in the take. Templates cut from the take are
  // found in the source at 2 kHz; three or more that agree give the offset
  // and the clock ratio (as tests/reference.compare.mjs does), fewer give
  // the offset of the best one. A cross-correlation at 8 kHz over the
  // whole overlap then refines the offset to a fraction of a sample.
  function locate(take, takeRate, source, sourceRate, onProgress) {
    const searchRate = 2000;
    const t2 = narrow(take, takeRate, searchRate), s2 = narrow(source, sourceRate, searchRate);
    const takeSeconds = t2.length / searchRate, sourceSeconds = s2.length / searchRate;
    const segment = Math.min(4, Math.max(.5, Math.min(takeSeconds, sourceSeconds) / 4));
    const length = Math.round(segment * searchRate);
    if (length < 200 || s2.length < length || t2.length < length) throw new Error('The take and the source must be at least 0.4 s long.');
    const match = createMatcher(s2, length);
    const count = Math.min(25, Math.max(1, Math.floor((takeSeconds - segment) / (segment / 2)) + 1));
    const step = count > 1 ? (takeSeconds - segment) / (count - 1) : 0;
    const matches = [];
    for (let i = 0; i < count; i++) {
      const start = i * step;
      const m = match(t2.subarray(Math.round(start * searchRate), Math.round(start * searchRate) + length));
      matches.push({ referenceStartSeconds: start, sourceStartSeconds: m.sample === null ? null : m.sample / searchRate, correlation: m.correlation });
      if (onProgress) onProgress((i + 1) / count * .8);
    }
    let timeline = consistentTimeline(matches);
    let method = 'timeline';
    if (!timeline) {
      const best = matches.filter(x => x.sourceStartSeconds !== null)
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
      if (!best || Math.abs(best.correlation) < .3) throw new Error('The source was not found in the take.');
      timeline = { scale: 1, offsetSeconds: best.sourceStartSeconds - best.referenceStartSeconds, matches: 1,
        medianAbsoluteCorrelation: Math.abs(best.correlation) };
      method = 'single match';
    }
    // Refine at 8 kHz: in up to eight windows across the overlap, correlate
    // the source with the coarsely warped take over +-5 ms and interpolate
    // the peak. A line through the lags corrects the offset and the clock.
    const fineRate = 8000, lags = 40;
    const s8 = narrow(source, sourceRate, fineRate);
    const t8 = warp(narrow(take, takeRate, fineRate), fineRate, timeline, fineRate, s8.length);
    let first = -1, last = -1;
    for (let i = 0; i < t8.length; i++) if (t8[i] !== 0) { if (first < 0) first = i; last = i; }
    first = Math.max(first, lags); last = Math.min(last, s8.length - lags - 1);
    const points = [];
    const windows = Math.max(1, Math.min(8, Math.floor((last - first) / (fineRate / 2))));
    const size = Math.floor((last - first) / windows);
    let bestAll = { value: 0 };
    for (let w = 0; w < windows && size > 2 * lags; w++) {
      const from = first + w * size, to = from + size;
      let es = 0, et = 0;
      for (let i = from; i < to; i++) { es += s8[i] * s8[i]; et += t8[i] * t8[i]; }
      if (!(es > 0 && et > 0)) continue;
      const norm = Math.sqrt(es * et), values = new Float64Array(2 * lags + 1);
      let best = { lag: 0, value: 0 };
      for (let lag = -lags; lag <= lags; lag++) {
        let sum = 0;
        for (let i = from; i < to; i++) sum += s8[i] * t8[i + lag];
        values[lag + lags] = sum / norm;
        if (Math.abs(values[lag + lags]) > Math.abs(best.value)) best = { lag, value: values[lag + lags] };
      }
      const k = best.lag + lags;
      let fraction = 0;
      if (k > 0 && k < values.length - 1) {
        const a = Math.abs(values[k - 1]), b = Math.abs(values[k]), c = Math.abs(values[k + 1]);
        const denominator = a - 2 * b + c;
        if (denominator < 0) fraction = .5 * (a - c) / denominator;
      }
      if (Math.abs(best.value) > Math.abs(bestAll.value)) bestAll = best;
      if (Math.abs(best.value) >= .3) points.push({ t: (from + to) / 2 / fineRate, lag: (best.lag + fraction) / fineRate, weight: Math.abs(best.value) });
    }
    if (!points.length) throw new Error('The take does not line up with the source closely enough to compare.');
    // The warped take lags the source by d(t) = alpha + beta * t seconds.
    // Pitch periodicity can put a window on a neighbouring peak: drop lags
    // far from the median, fit, drop points off the line, fit again.
    const fit = (list) => {
      const W = list.reduce((s, p) => s + p.weight, 0);
      const mt = list.reduce((s, p) => s + p.weight * p.t, 0) / W, ml = list.reduce((s, p) => s + p.weight * p.lag, 0) / W;
      const spread = list[list.length - 1].t - list[0].t;
      // Under 4 s, codec phase noise (~50 us per window) swamps any clock drift.
      if (list.length < 3 || spread < 4) return { alpha: percentile(list.map(p => p.lag), .5), beta: 0 };
      let num = 0, den = 0;
      for (const p of list) { num += p.weight * (p.t - mt) * (p.lag - ml); den += p.weight * (p.t - mt) ** 2; }
      const beta = den > 0 ? num / den : 0;
      return { alpha: ml - beta * mt, beta };
    };
    const medianLag = percentile(points.map(p => p.lag), .5);
    let kept = points.filter(p => Math.abs(p.lag - medianLag) < 1.5e-3);
    let line = fit(kept);
    const onLine = kept.filter(p => Math.abs(p.lag - line.alpha - line.beta * p.t) < 2.5e-4);
    if (onLine.length >= Math.max(1, kept.length / 2)) { kept = onLine; line = fit(kept); }
    const { alpha, beta } = line;
    const scale = timeline.scale * (1 - beta);
    const offsetSeconds = -alpha + (1 - beta) * timeline.offsetSeconds;
    if (onProgress) onProgress(1);
    return { offsetSeconds, scale, matches: timeline.matches, method, windows: kept.length,
      correlation: kept.reduce((s, p) => s + p.weight, 0) / kept.length, polarity: bestAll.value < 0 ? -1 : 1,
      coarseCorrelation: timeline.medianAbsoluteCorrelation };
  }

  // The simulation against the aligned take, both at `rate` and equally long.
  // Band spectra are level-matched at 300 Hz-3 kHz; sim minus real per band.
  function compareTake(real, sim, rate) {
    const out = { bands: null, levelTracking: null, clip: { real: null, sim: null }, errors: [] };
    try {
      const pair = describePair(real, sim, rate);
      out.bands = pair.bands.map(b => ({ hz: b.hz, simMinusRealDb: b.normalizedGainDb }));
      out.anchorGainDb = pair.anchorGainDb;
    } catch (error) { out.errors.push(error.message); }
    try { out.levelTracking = levelTracking(real, sim, rate); } catch (error) { out.errors.push(error.message); }
    try { out.clip.real = clipSignature(real, rate); } catch (error) { out.errors.push(error.message); }
    try { out.clip.sim = clipSignature(sim, rate); } catch (error) { out.errors.push(error.message); }
    return out;
  }

  const TF2Reference = { fft, findMatch, createMatcher, percentile, consistentTimeline, BAND_EDGES, spectrum, rmsDb,
    describePair, clipSignature, levelTracking, sampleTimeline, warp, narrow, locate, compareTake };
  if (typeof window !== 'undefined') window.TF2Reference = TF2Reference;
  else if (typeof self !== 'undefined') self.TF2Reference = TF2Reference;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Reference;
})();
