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
 *   TF2Reference.track(take, takeRate, source, sourceRate, { gate, micGain })
 *     -> { segments: [{ start, end, a, b, delayMs, clockPpm }], overlap, ... }
 *        talk spurt by talk spurt: take time = a + b * source time
 *   TF2Reference.warpSegments(take, takeRate, segments, outRate, length)
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
  // Blocks count where both are above -70 dBFS and the render is 10 dB
  // above the recording's own floor (game ambience), taken from the blocks
  // where the render is silent (the gate closed).
  function levelTracking(recorded, rendered, rate, seconds = .5) {
    if (recorded.length !== rendered.length) throw new Error('Level tracking needs equal-length audio.');
    const block = Math.round(rate * seconds), all = [], a = [], b = [];
    for (let i = 0; i + block <= recorded.length; i += block) all.push([rmsDb(recorded.subarray(i, i + block)), rmsDb(rendered.subarray(i, i + block))]);
    const quiet = all.filter(([x, y]) => y <= -70 && x > -100).map(([x]) => x);
    const floor = quiet.length >= 3 ? percentile(quiet, .5) : -Infinity;
    for (const [x, y] of all) if (x > -70 && y > -70 && y > floor + 10) { a.push(x); b.push(y); }
    if (a.length < 3) throw new Error('Level tracking needs at least three active blocks.');
    const offset = percentile(a.map((x, i) => x - b[i]), .5);
    const deviations = a.map((x, i) => x - b[i] - offset);
    const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
    const ma = mean(a), mb = mean(b);
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return { blocks: a.length, floorDb: Number.isFinite(floor) ? floor : null, offsetDb: offset, rmsDeviationDb: Math.sqrt(mean(deviations.map(d => d * d))),
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
  // With options.coarse, a take whose delay changes too much for one
  // offset (talk spurts re-timed by the receiver) keeps the 2 kHz result
  // instead of failing (refined: false).
  function locate(take, takeRate, source, sourceRate, onProgress, options = {}) {
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
    if (!points.length) {
      if (!options.coarse) throw new Error('The take does not line up with the source closely enough to compare.');
      if (onProgress) onProgress(1);
      return { offsetSeconds: timeline.offsetSeconds, scale: timeline.scale, matches: timeline.matches, method, windows: 0,
        correlation: timeline.medianAbsoluteCorrelation, polarity: 1, coarseCorrelation: timeline.medianAbsoluteCorrelation, refined: false };
    }
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
      coarseCorrelation: timeline.medianAbsoluteCorrelation, refined: true };
  }

  // Where Steam's gate would send: 20 ms frames above the threshold (RMS,
  // dBFS, after the capture gain) with the pre-roll before and the hold
  // after. Returns talk spurts as { start, end } in seconds.
  function gateSpurts(samples, rate, gate, gain = 1) {
    const frame = Math.round(rate / 50), frames = Math.ceil(samples.length / frame);
    const threshold = 10 ** (gate.thresholdDb / 20) / Math.max(1e-9, gain);
    const preroll = Math.round(gate.prerollMs / 20), hold = Math.round(gate.holdMs / 20);
    const sent = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) {
      let e = 0;
      const end = Math.min(samples.length, (f + 1) * frame);
      for (let i = f * frame; i < end; i++) e += samples[i] * samples[i];
      if (Math.sqrt(e / frame) > threshold) sent.fill(1, Math.max(0, f - preroll), Math.min(frames, f + hold + 1));
    }
    const spurts = [];
    for (let f = 0; f < frames; f++) {
      if (!sent[f]) continue;
      const start = f;
      while (f < frames && sent[f]) f++;
      spurts.push({ start: start * frame / rate, end: Math.min(samples.length, f * frame) / rate });
    }
    return spurts;
  }

  // Level envelope in dB, 5 ms steps, over what the voice path passes
  // (150 Hz-10 kHz): below that Opus's voice high-pass removes content the
  // source still has (a sweep's first seconds), and tones of any frequency
  // in the band count.
  // With broadband set, only the low-pass: low tones that Opus turns into
  // near-DC plateaus (finding 18) still show.
  function envelope(samples, rate, step = .005, broadband = false) {
    const audio = typeof TF2Audio !== 'undefined' ? TF2Audio : null;
    let x = samples;
    if (audio) {
      if (!broadband) x = audio.applyBiquad(x, audio.biquadCoefs('highpass', rate, 150, .707));
      if (rate > 22000) x = audio.applyBiquad(audio.applyBiquad(x, audio.biquadCoefs('lowpass', rate, 10000, .707)), audio.biquadCoefs('lowpass', rate, 10000, .707));
    }
    const n = Math.round(rate * step), count = Math.floor(x.length / n), out = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      let e = 0;
      for (let i = k * n; i < (k + 1) * n; i++) e += x[i] * x[i];
      out[k] = Math.max(-100, 10 * Math.log10(e / n + 1e-20));
    }
    return out;
  }

  // Talk spurt by talk spurt. TF2's receiver re-times every talk spurt, so
  // the delay can change by hundreds of ms from one to the next, and within
  // a spurt it trims buffered latency in 256-sample (5.8 ms) skips
  // (tests/REFERENCE_2026.md, findings 10 and 15). One offset and clock
  // ratio cannot follow that.
  //
  // track() takes the talk spurts from the gate model (options.gate, as the
  // render's profile and settings have it; 98.7% of frames agree with
  // Steam's) or, without a gate, treats the source as one spurt. Each spurt
  // is placed by its broadband level envelope, which even a pure tone's
  // onset pins down, within +-0.6 s of the running delay. Inside a spurt,
  // 1 s windows refine the delay at 8 kHz and split it where it steps (the
  // trims); periodic windows, where a waveform lag is ambiguous, keep the
  // envelope's. One clock ratio serves the whole take (the recorder's
  // clock against the game's is steady; finding 15); each segment gets its
  // own offset. Segments map source time t to take time a + b * t.
  //
  // options.reference, { samples, rate, frames }: the app's render of the
  // source (same timeline) and, optionally, its codec's frame log (one
  // code per 20 ms, opus-codec.mjs FRAME). When given, the take is matched
  // against the render rather than the raw source: it has the take's
  // gating, comfort noise and codec phase, so envelopes and waveforms agree
  // far better (a low tone that Opus turns into a near-DC plateau, a tone
  // faded by DTX). Windows that are mostly comfort noise are not matched by
  // waveform: it is random, and its plateaus step on the frame grid, which
  // lines up spuriously. The talk spurts still come from the source.
  function track(take, takeRate, source0, sourceRate0, options = {}, onProgress) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const report = (v) => { if (onProgress) onProgress(v); };
    const ref = options.reference && options.reference.samples && options.reference.samples.length ? options.reference : null;
    const source = ref ? ref.samples : source0, sourceRate = ref ? ref.rate : sourceRate0;
    const coarse = locate(take, takeRate, source, sourceRate, (v) => report(v * .3), { coarse: true });
    const sourceSeconds = source0.length / sourceRate0, takeSeconds = take.length / takeRate;
    const spurts = (options.gate ? gateSpurts(source0, sourceRate0, options.gate, options.micGain) : [{ start: 0, end: sourceSeconds }])
      .filter(s => s.end - s.start >= .1);
    if (!spurts.length) throw new Error('The source has nothing loud enough for the voice gate to send.');
    const step = .005, es = envelope(source, sourceRate, step), et = envelope(take, takeRate, step);
    const esB = envelope(source, sourceRate, step, true), etB = envelope(take, takeRate, step, true);
    const lo = 2000, s2 = narrow(source, sourceRate, lo), t2 = narrow(take, takeRate, lo);
    const frameLog = ref && ref.frames && ref.frames.length ? ref.frames : null;
    // Share of the render's energy over [t0, t1) in frames the codec coded
    // (SILK, hybrid or CELT), not comfort noise.
    const frameEnergy = frameLog ? Float64Array.from(frameLog, (_, f) => {
      let e = 0;
      for (let i = f * 40; i < Math.min(s2.length, (f + 1) * 40); i++) e += s2[i] * s2[i];
      return e;
    }) : null;
    const coded = (t0, t1) => {
      if (!frameLog) return 1;
      const f0 = Math.max(0, Math.floor(t0 * 50)), f1 = Math.min(frameLog.length, Math.ceil(t1 * 50));
      let all = 0, kept = 0;
      for (let f = f0; f < f1; f++) { all += frameEnergy[f]; if (frameLog[f] >= 1 && frameLog[f] <= 3) kept += frameEnergy[f]; }
      return all > 0 ? kept / all : 0;
    };
    const hi = 8000, s8 = narrow(source, sourceRate, hi), t8 = narrow(take, takeRate, hi);
    const b0 = 1 / coarse.scale;   // take seconds per source second
    const reach = Math.round(.6 / step);
    const segments = [];
    let delay = coarse.offsetSeconds * -b0;   // take time minus b0 * source time
    const esBand = es, etBand = et;
    // Normalized correlation of the source envelope over [from, to) with
    // the take's, shifted by `lag` bins from the running mapping.
    // Each envelope is floored 30 dB below its own loud level (90th
    // percentile), so digital silence in the source and game ambience in
    // the take read alike; the take's also 6 dB above its ambience (its
    // 10th percentile overall), whose wobble would otherwise count.
    const sparse = (e) => { const list = []; for (let k = 0; k < e.length; k += 7) list.push(e[k]); return list; };
    const ambience = { band: percentile(sparse(et), .1) + 6, broad: percentile(sparse(etB), .1) + 6 };
    const floored = (e, from, to, bottom = -Infinity) => {
      const top = percentile(Array.from(e.subarray(Math.max(0, from), Math.min(e.length, to))), .9);
      const at = Math.max(top - 30, Math.min(bottom, top - 6));
      return (v) => Math.max(v, at);
    };
    // `prior` (seconds, from the running delay): where the spurt most likely
    // sits, the median delay so far.
    const envMatch = (from, to, base, broad = false, prior = 0) => {
      const es = broad ? esB : esBand, et = broad ? etB : etBand;
      const fs = floored(es, from, to), ft = floored(et, base + from - reach, base + to + reach, broad ? ambience.broad : ambience.band);
      // Against a render with its frame log, audible comfort noise (DTX
      // frames above the floor) does not count; quiet DTX is the silence
      // between sounds and does.
      const quiet = fs(-1000) + 6;
      const envKeep = (k) => !frameLog || frameLog[Math.floor(k * step * 50)] !== 4 || es[k] <= quiet;
      let mean = 0, n = 0;
      for (let k = from; k < to; k++) if (envKeep(k)) { mean += fs(es[k]); n++; }
      if (n < 20) return { lag: 0, value: -2 };
      mean /= n;
      let best = { lag: 0, value: -2 };
      const values = new Float64Array(2 * reach + 1);
      for (let lag = -reach; lag <= reach; lag++) {
        let sxy = 0, sxx = 0, syy = 0, my = 0, m = 0;
        for (let k = from; k < to; k++) { const j = base + k + lag; if (j >= 0 && j < et.length && envKeep(k)) { my += ft(et[j]); m++; } }
        if (m < n * .8) { values[lag + reach] = -2; continue; }
        my /= m;
        for (let k = from; k < to; k++) {
          const j = base + k + lag;
          if (j < 0 || j >= et.length || !envKeep(k)) continue;
          const x = fs(es[k]) - mean, y = ft(et[j]) - my;
          sxy += x * y; sxx += x * x; syy += y * y;
        }
        const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : -2;
        values[lag + reach] = r;
        if (r > best.value) best = { lag, value: r };
      }
      // A repeating pattern (beeps 0.5 s apart, the first one clipped by
      // the receiver) peaks at several lags: of the peaks, the best once
      // each loses 0.6 per second away from the prior. Every take's spurt
      // delays stay within about 0.35 s of their median.
      const score = (k) => values[k] - .6 * Math.abs((k - reach) * step - prior);
      for (let k = 1; k < values.length - 1; k++) {
        if (values[k] > -2 && values[k] >= values[k - 1] && values[k] >= values[k + 1] && score(k) > score(best.lag + reach)) best = { lag: k - reach, value: values[k] };
      }
      const i = best.lag + reach;
      let fraction = 0;
      if (i > 0 && i < values.length - 1 && values[i - 1] > -2 && values[i + 1] > -2) {
        const d = values[i - 1] - 2 * values[i] + values[i + 1];
        if (d < 0) fraction = .5 * (values[i - 1] - values[i + 1]) / d;
      }
      return { lag: (best.lag + fraction) * step, value: best.value };
    };
    // Waveform lag at 8 kHz of the source over [t0, t1) against the take at
    // a + b0 * t, within +-L samples; null when periodic or weak.
    const waveMatch = (t0, t1, a, L = 120) => {
      const a8 = Math.round(t0 * hi), n8 = Math.round((t1 - t0) * hi), b8 = Math.round((a + b0 * t0) * hi);
      if (a8 < 0 || a8 + n8 > s8.length || b8 - L < 0 || b8 + n8 + L > t8.length || n8 < hi / 10 || coded(t0, t1) < .5) return null;
      let es8 = 0, periodic = 0;
      for (let i = 0; i < n8; i++) es8 += s8[a8 + i] ** 2;
      if (!(es8 > 0)) return null;
      for (let lag = 16; lag <= 400; lag += 4) {
        let sum = 0;
        for (let i = 0; i + lag < n8; i += 2) sum += s8[a8 + i] * s8[a8 + i + lag];
        periodic = Math.max(periodic, 2 * sum / es8);
      }
      if (periodic > .9) return null;
      const values = new Float64Array(2 * L + 1);
      let best = L, et8 = 0;
      for (let i = 0; i < n8; i++) et8 += t8[b8 + i] ** 2;
      const norm = Math.sqrt(es8 * et8) || 1;
      for (let lag = -L; lag <= L; lag++) {
        let sum = 0;
        for (let i = 0; i < n8; i++) sum += s8[a8 + i] * t8[b8 + i + lag];
        values[lag + L] = sum / norm;
        if (Math.abs(values[lag + L]) > Math.abs(values[best])) best = lag + L;
      }
      if (Math.abs(values[best]) < .5) return null;
      let fraction = 0;
      if (best > 0 && best < values.length - 1) {
        const p = Math.abs(values[best - 1]), q = Math.abs(values[best]), r = Math.abs(values[best + 1]), d = p - 2 * q + r;
        if (d < 0) fraction = .5 * (p - r) / d;
      }
      return { lag: (best - L + fraction) / hi, weight: Math.abs(values[best]), sign: Math.sign(values[best]) };
    };
    // Normalized correlation at 8 kHz of the source over [t0, t1) with the
    // take at exactly a + b0 * t (to the nearest 8 kHz sample).
    const waveAt = (t0, t1, a) => {
      const a8 = Math.round(t0 * hi), n8 = Math.round((t1 - t0) * hi), b8 = Math.round((a + b0 * t0) * hi);
      if (a8 < 0 || a8 + n8 > s8.length || b8 < 0 || b8 + n8 > t8.length) return 0;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n8; i++) { sxy += s8[a8 + i] * t8[b8 + i]; sxx += s8[a8 + i] ** 2; syy += t8[b8 + i] ** 2; }
      return sxx > 0 && syy > 0 ? Math.abs(sxy) / Math.sqrt(sxx * syy) : 0;
    };
    // The delay of the source's [t0, t0 + W/lo) at 2 kHz, searched +-0.6 s
    // around `guess`; null when periodic, silent or weak.
    const wideMatch = (t0, W, guess) => {
      const R = Math.round(.6 * lo), start = Math.round(t0 * lo), template = s2.subarray(start, start + W);
      if (template.length < W || W < 100 || coded(t0, t0 + W / lo) < .5) return null;
      let e = 0, periodic = 0;
      for (const v of template) e += v * v;
      if (!(e > 0)) return null;
      for (let lag = 8; lag <= 100; lag += 2) {
        let sum = 0;
        for (let i = 0; i + lag < W; i++) sum += template[i] * template[i + lag];
        periodic = Math.max(periodic, sum / e);
      }
      if (periodic > .9) return null;
      const predicted = Math.round((guess + b0 * t0) * lo);
      const from = Math.max(0, predicted - R), to = Math.min(t2.length, predicted + W + R);
      if (to - from < W + 2) return null;
      const m = createMatcher(t2.subarray(from, to), W)(template);
      return m.sample !== null && Math.abs(m.correlation) >= .5 ? (from + m.sample) / lo - b0 * t0 : null;
    };
    // A spurt's delay from its waveform: 1 s windows (up to twelve) at
    // 2 kHz, searched +-0.6 s around `guess`; the median of two or more
    // that agree within 2 ms, else null (tones, sweeps' onsets).
    const coarseWave = (spurt, guess) => {
      const W = Math.round(Math.min(1, spurt.end - spurt.start) * lo), found = [];
      for (let t0 = spurt.start, k = 0; t0 + W / lo <= spurt.end + 1e-9 && k < 12; t0 += W / lo / 2, k++) {
        if (W < 100 || Math.round(t0 * lo) + W > s2.length) break;
        const d = wideMatch(t0, W, guess);
        if (d !== null) found.push(d);
      }
      for (const d of found) {
        const agree = found.filter(x => Math.abs(x - d) <= 2e-3);
        if (agree.length >= 2) return percentile(agree, .5);
      }
      return null;
    };
    // The whole take's level envelope against the source's, at 20 ms. Where
    // the source repeats itself (tone after tone), templates can lock onto
    // the wrong repeat; the envelope sequence as a whole cannot. When it
    // disagrees with locate() by more than the per-spurt search allows, it
    // sets the starting delay.
    const globalDelay = (e1, e2, bottom) => {
      const pool = (e) => { const out = new Float32Array(Math.floor(e.length / 4)); for (let k = 0; k < out.length; k++) out[k] = (e[4 * k] + e[4 * k + 1] + e[4 * k + 2] + e[4 * k + 3]) / 4; return out; };
      const src = pool(e1), tk = pool(e2);
      const fs = floored(src, 0, src.length), ft = floored(tk, 0, tk.length, bottom);
      const pad = Math.floor(src.length / 2), hay = new Float32Array(tk.length + 2 * pad).fill(ft(-100));
      for (let k = 0; k < tk.length; k++) hay[pad + k] = ft(tk[k]);
      const template = Float32Array.from(src, fs);
      if (template.length < 50 || hay.length < template.length) return null;
      const m = createMatcher(hay, template.length)(template);
      return m.sample !== null && m.correlation >= .5 ? { delay: (m.sample - pad) * step * 4, value: m.correlation } : null;
    };
    const globals = [globalDelay(es, et, ambience.band), globalDelay(esB, etB, ambience.broad)].filter(Boolean).sort((x, y) => y.value - x.value);
    if (globals.length && Math.abs(globals[0].delay - delay) > .3) delay = globals[0].delay;
    let signs = 0;
    const placed = [];
    spurts.forEach((whole, index) => {
      report(.3 + .6 * index / spurts.length);
      // Only the part of the spurt the take can hold (a take can be an
      // excerpt of a long source).
      const spurt = { start: Math.max(whole.start, -delay / b0 + .6), end: Math.min(whole.end, (takeSeconds - delay) / b0 - .6) };
      if (spurt.end - spurt.start < .3) return;
      // The spurt's envelope, with 100 ms of the silence before it, placed
      // within +-0.6 s of the running delay.
      const from = Math.max(0, Math.round((spurt.start - .1) / step)), to = Math.min(es.length, Math.round(Math.min(spurt.end, spurt.start + 8) / step));
      if (to - from < 20) return;
      const base = Math.round(delay / step + (b0 - 1) * from);
      // The band-limited envelope first: a raw source still has what the
      // voice path removes below 150 Hz. The broadband one where that is
      // weak, or always against a render (which has been through Opus).
      const prior = placed.length ? percentile(placed, .5) - delay : 0;
      const placeBy = (from, to) => {
        let env = envMatch(from, to, base, false, prior);
        if (env.value < .5 || ref) { const broad = envMatch(from, to, base, true, prior); if (broad.value > env.value) env = broad; }
        return env;
      };
      const wave = coarseWave(spurt, delay);
      // Without a waveform (tones) and without a frame log to leave out
      // comfort noise, the onset's first second decides: once DTX sets in,
      // comfort noise is random and matches nothing.
      const onsetTo = Math.min(to, from + Math.round(1.1 / step));
      let env = wave === null && !frameLog && onsetTo - from >= 40 ? placeBy(from, onsetTo) : { value: 0, lag: 0 };
      if (env.value < .6) { const whole = placeBy(from, to); if (whole.value > env.value) env = whole; }
      if (wave === null && env.value < .5) return;
      // Weak evidence does not move a spurt far from where the others sit.
      if (wave === null && env.value < .75 && Math.abs(env.lag - prior) > .1) env = { lag: prior, value: env.value };
      let a = wave !== null ? wave : delay + env.lag;
      // Inside the spurt: 1 s windows every 0.5 s refine the delay, each
      // searched around the median of the last three (trims move it). A
      // window that does not match there is searched +-0.6 s: Steam's gate
      // can close in a pause the model's holds across, and the receiver
      // then re-times what follows.
      const points = [];
      const span = spurt.end - spurt.start, win = Math.min(1, span), hop = win / 2;
      for (let t0 = spurt.start; t0 + win <= spurt.end + 1e-9; t0 += hop) {
        let center = points.length ? percentile(points.slice(-3).map(p => p.tau - b0 * p.t), .5) : a;
        let m = waveMatch(t0, t0 + win, center);
        if (!m) {
          const wide = wideMatch(t0, Math.round(win * lo), center);
          if (wide !== null && Math.abs(wide - center) > 5e-3) { center = wide; m = waveMatch(t0, t0 + win, center); }
        }
        if (m) { points.push({ t: t0 + win / 2, tau: center + b0 * (t0 + win / 2) + m.lag, weight: m.weight }); signs += m.sign; }
      }
      // Group the points where the delay steps by more than 2 ms: two points
      // must agree on the new delay, and the waveform must fit it clearly
      // better than the old one (periodic music can offer a second peak).
      // A spurt without usable windows keeps the envelope's delay.
      const d = (p) => p.tau - b0 * p.t;
      const groups = [];
      let current = [];
      points.forEach((p, k) => {
        const next = points[k + 1];
        // The first group starts at a point within 30 ms of the spurt's
        // placement, or one the next point confirms.
        if (!current.length && !groups.length) {
          if (Math.abs(d(p) - a) <= .03 || (next && Math.abs(d(next) - d(p)) <= 2e-3)) current.push(p);
          return;
        }
        if (!current.length || Math.abs(d(p) - d(current[current.length - 1])) <= 2e-3) { current.push(p); return; }
        if (next && Math.abs(d(next) - d(p)) <= 2e-3) {
          const old = d(current[current.length - 1]), neu = (d(p) + d(next)) / 2;
          const cOld = (waveAt(p.t - win / 2, p.t + win / 2, old) + waveAt(next.t - win / 2, next.t + win / 2, old)) / 2;
          const cNew = (waveAt(p.t - win / 2, p.t + win / 2, neu) + waveAt(next.t - win / 2, next.t + win / 2, neu)) / 2;
          if (cNew >= cOld + .1) { groups.push(current); current = [p]; }
        }
      });
      if (current.length) groups.push(current);
      if (!groups.length) groups.push([]);
      groups.forEach((list, g) => segments.push({ spurt: index, points: list,
        a: list.length ? percentile(list.map(d), .5) : a,
        first: list.length ? list[0].t : spurt.start, last: list.length ? list[list.length - 1].t : spurt.end,
        spurtStart: whole.start, spurtEnd: whole.end, envelope: env.value }));
      const lastGroup = groups[groups.length - 1];
      delay = lastGroup.length ? percentile(lastGroup.map(d), .5) : a;
      placed.push(delay);
    });
    if (!segments.length) throw new Error('The take does not line up with the source closely enough to compare.');
    // One clock ratio for the whole take from the spread inside segments
    // (fall back to locate()'s), then each segment's offset. Points far off
    // the fit (by the median absolute deviation) are dropped and the fit
    // repeated: lost and concealed frames scatter them.
    const measured = segments.filter(s => s.points.length);
    const off = (s, p, b) => Math.abs(p.tau - b * p.t - percentile(s.points.map(q => q.tau - b * q.t), .5));
    const slope = (keep) => {
      let num = 0, den = 0;
      for (const s of measured) {
        const list = s.points.filter(p => keep(s, p));
        if (list.length < 2) continue;
        const mt = list.reduce((x, p) => x + p.t, 0) / list.length, mtau = list.reduce((x, p) => x + p.tau, 0) / list.length;
        for (const p of list) { num += (p.t - mt) * (p.tau - mtau); den += (p.t - mt) ** 2; }
      }
      return den > 16 ? num / den : b0;
    };
    let b = slope(() => true), limit = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const residuals = measured.flatMap(s => s.points.map(p => off(s, p, b)));
      limit = Math.max(5e-5, 4 * 1.4826 * (percentile(residuals, .5) || 0));
      const bb = b;
      b = slope((s, p) => off(s, p, bb) <= limit);
    }
    for (const s of segments) {
      const kept = s.points.filter(p => Math.abs(p.tau - b * p.t - percentile(s.points.map(q => q.tau - b * q.t), .5)) <= limit);
      if (kept.length) s.a = percentile(kept.map(p => p.tau - b * p.t), .5);
      else if (!s.points.length) s.a += (b0 - b) * (s.spurtStart + s.spurtEnd) / 2;
      s.pointCount = kept.length;
    }
    // Breaks: at the silence before each spurt (midway through the gap), and
    // inside a spurt where the next group starts to fit better (10 ms blocks).
    const block = Math.round(.01 * hi);
    const misfit = (s, i) => {
      const j = Math.round((s.a + b * i / hi) * hi);
      let e = 0;
      for (let n = 0; n < block; n++) e += (s8[i + n] - (j + n >= 0 && j + n < t8.length ? t8[j + n] : 0)) ** 2;
      return e;
    };
    for (let g = 0; g + 1 < segments.length; g++) {
      const A = segments[g], B = segments[g + 1];
      if (A.spurt !== B.spurt) { A.end = B.start = (A.spurtEnd + B.spurtStart) / 2; continue; }
      const from = Math.round(A.last * hi), to = Math.round(B.first * hi);
      let bestAt = Math.round((A.last + B.first) / 2 * hi), bestCost = Infinity;
      if (to - from > 2 * block) {
        const blocks = Math.floor((to - from) / block), eA = [], eB = [];
        for (let k = 0; k < blocks; k++) { eA.push(misfit(A, from + k * block)); eB.push(misfit(B, from + k * block)); }
        let prefix = 0, suffix = eB.reduce((x, v) => x + v, 0);
        for (let k = 0; k <= blocks; k++) {
          if (prefix + suffix < bestCost) { bestCost = prefix + suffix; bestAt = from + k * block; }
          if (k < blocks) { prefix += eA[k]; suffix -= eB[k]; }
        }
      }
      A.end = B.start = bestAt / hi;
    }
    segments[0].start = 0;
    segments[segments.length - 1].end = sourceSeconds;
    // No segment reaches past the take's own audio, nor, at either end of
    // the take, more than a window past the last one that matched (an
    // excerpt stopped or faded mid-song).
    for (const s of segments) { s.start = Math.max(s.start, -s.a / b); s.end = Math.min(s.end, (takeSeconds - s.a) / b); }
    const head = segments[0], tail = segments[segments.length - 1];
    if (head.points.length && head.first - head.start > 2) head.start = head.first - 1;
    if (tail.points.length && tail.end - tail.last > 2) tail.end = tail.last + 1;
    const live = segments.filter(s => s.end > s.start);
    report(1);
    const weights = measured.flatMap(s => s.points.map(p => p.weight));
    return {
      // Delay (take time minus source time) at each segment's middle.
      segments: live.map(s => ({ a: s.a, b, start: s.start, end: s.end, spurt: s.spurt, points: s.pointCount,
        delayMs: (s.a + (b - 1) * (s.start + s.end) / 2) * 1000, clockPpm: (1 / b - 1) * 1e6 })),
      spurts: spurts.length, coarse, points: weights.length, guided: !!ref,
      overlap: { t0: live[0].start, t1: live[live.length - 1].end },
      correlation: weights.length ? weights.reduce((x, w) => x + w, 0) / weights.length : coarse.correlation,
      polarity: signs < 0 ? -1 : 1
    };
  }

  // The take on the source's timeline, segment by segment (track()). Zero
  // outside the segments.
  function warpSegments(take, takeRate, segments, outRate, length) {
    const out = new Float32Array(length);
    for (const seg of segments) {
      const step = seg.b * takeRate / outRate;
      const { half, phases, kernels } = timelineKernels(.49 / Math.max(1, step));
      const i0 = Math.max(0, Math.ceil(seg.start * outRate)), i1 = Math.min(length, Math.ceil(seg.end * outRate));
      for (let i = i0; i < i1; i++) {
        const position = (seg.a + seg.b * i / outRate) * takeRate, base = Math.floor(position), fraction = position - base;
        if (base + half < 0 || base - half + 1 >= take.length) continue;
        const phase = fraction * phases, lower = Math.floor(phase), blend = phase - lower;
        const ka = kernels[lower], kb = kernels[lower + 1];
        let value = 0;
        for (let k = 0; k < ka.length; k++) {
          const j = base - half + 1 + k;
          if (j >= 0 && j < take.length) value += take[j] * (ka[k] + (kb[k] - ka[k]) * blend);
        }
        out[i] = value;
      }
    }
    return out;
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

  // Per-segment measures on the test signal's timeline (its JSON segment
  // map): RMS level and peak over the middle 60% of each segment of at least
  // 0.5 s, and the share of those samples within 10% of `ceiling` (the
  // file's clamp, linear; wide enough that game sound riding on a clipped
  // stretch does not push its samples out). Gaps and silences are measured too: they give the
  // recording's ambience.
  //
  // Each segment also gets a band level (bandDb) in the band its content
  // occupies: 30 Hz either side of a steady tone or 1 kHz sine (the analysis
  // window's main lobe is 23 Hz wide each way), half an octave around 1 kHz
  // for the short sync beeps, 150 Hz-10 kHz for the rest. A recording's game
  // sound is broadband, so a tone stays measurable in its band 20 dB or more
  // below the recording's broadband level.
  function segmentBand(name) {
    const tone = /^tone_(\d+)Hz/.exec(name);
    if (tone) return [+tone[1] - 30, +tone[1] + 30];
    if (/^(sine1k|step_sine)/.test(name)) return [970, 1030];
    if (/^sync/.test(name)) return [707, 1414];
    return [150, 10000];
  }
  // Mean-square level (dB) of [a, b) in [lo, hi) Hz: Hann-windowed 4096-point
  // frames, half overlapping, scaled so a sine reads its RMS level.
  function bandLevelDb(samples, rate, a, b, lo, hi) {
    const size = 4096, re = new Float64Array(size), im = new Float64Array(size);
    let w2 = 0;
    for (let i = 0; i < size; i++) w2 += (.5 - .5 * Math.cos(2 * Math.PI * i / size)) ** 2;
    const k0 = Math.max(1, Math.ceil(lo * size / rate)), k1 = Math.min(size / 2 - 1, Math.floor(hi * size / rate));
    let total = 0, frames = 0;
    for (let start = a; start + size <= b; start += size / 2) {
      for (let i = 0; i < size; i++) { re[i] = samples[start + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / size)); im[i] = 0; }
      fft(re, im);
      let e = 0;
      for (let k = k0; k <= k1; k++) e += re[k] * re[k] + im[k] * im[k];
      total += 2 * e / (size * w2);
      frames++;
    }
    return frames ? db(total / frames) : null;
  }
  function segmentStats(samples, rate, segments, ceiling) {
    return segments.filter(s => s.dur_s >= .5).map(s => {
      const a = Math.max(0, Math.round((s.start_s + .2 * s.dur_s) * rate));
      const b = Math.min(samples.length, Math.round((s.start_s + .8 * s.dur_s) * rate));
      let sum = 0, peak = 0, near = 0;
      for (let i = a; i < b; i++) {
        const m = Math.abs(samples[i]);
        sum += m * m; peak = Math.max(peak, m);
        if (ceiling > 0 && m > .9 * ceiling) near++;
      }
      const n = Math.max(1, b - a), band = segmentBand(s.name);
      return { name: s.name, start: s.start_s, end: s.start_s + s.dur_s, quiet: /^(gap|silence)/.test(s.name),
        levelDb: b > a ? db(sum / n) : null, peakDb: b > a && peak > 0 ? 20 * Math.log10(peak) : -Infinity, clipPct: 100 * near / n,
        band, bandDb: b > a ? bandLevelDb(samples, rate, a, b, band[0], band[1]) : null };
    });
  }

  // The clamp a take or render sits at (linear): the most populated 0.05 dB
  // step within 6 dB of the loudest sample, where clipped samples pile up.
  // The output filter overshoots square edges by up to about 0.5 dB, which
  // throws a percentile off, and game sound riding on clipped stretches can
  // put a take's loudest sample 2 dB over the clamp. The step counts as a
  // plateau if it holds 0.2% of the samples or more and twice the mean of
  // the steps 0.5-1 dB below it; if not, the 99.5th percentile as in clipSignature.
  function clampLevel(samples) {
    let max = 0;
    for (const v of samples) { const m = v < 0 ? -v : v; if (m > max) max = m; }
    if (!(max > 0)) return 0;
    const bins = new Float64Array(140);
    for (const v of samples) {
      const m = v < 0 ? -v : v;
      if (m <= 0) continue;
      const k = Math.floor(20 * Math.log10(max / m) / .05);
      if (k < bins.length) bins[k]++;
    }
    let best = 0;
    for (let k = 1; k < 120; k++) if (bins[k] > bins[best]) best = k;
    let below = 0;
    for (let k = best + 10; k < best + 20; k++) below += bins[k] / 10;
    if (bins[best] >= samples.length * .002 && bins[best] >= 2 * below) return max / 10 ** (best * .05 / 20);
    return 10 ** (clipSignature(samples, 48000).ceilingDbfs / 20);
  }

  // Band levels (BAND_EDGES) in dB relative to the 300 Hz-3 kHz anchor that
  // describePair level-matches on.
  function bandProfile(samples, rate) {
    const a = spectrum(samples, rate), anchor = a[4] + a[5] + a[6] + a[7];
    if (!(anchor > 1e-15)) throw new Error('Not enough signal at 300 Hz-3 kHz for a band profile.');
    return Array.from(a, (v, i) => ({ hz: `${BAND_EDGES[i]}-${BAND_EDGES[i + 1]}`,
      db: BAND_EDGES[i] < rate / 2 && v > 1e-20 ? db(v / anchor) : null }));
  }

  const TF2Reference = { fft, findMatch, createMatcher, percentile, consistentTimeline, BAND_EDGES, spectrum, rmsDb,
    describePair, clipSignature, levelTracking, sampleTimeline, warp, narrow, locate, gateSpurts, track, warpSegments, compareTake, segmentStats, segmentBand, bandLevelDb, bandProfile, clampLevel };
  if (typeof window !== 'undefined') window.TF2Reference = TF2Reference;
  else if (typeof self !== 'undefined') self.TF2Reference = TF2Reference;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Reference;
})();
