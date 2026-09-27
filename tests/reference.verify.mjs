import assert from 'node:assert/strict';
import { fft, findMatch, consistentTimeline, sampleTimeline, describePair, rmsDb, clipSignature, levelTracking, audioEngine } from './reference.compare.mjs';
import { createRequire } from 'node:module';
const TF2Reference = createRequire(import.meta.url)('../reference.js');

let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); passed++; console.log(`  ok    ${label}`); };
const near = (x, y, tolerance) => Math.abs(x - y) < tolerance;
const source = Float32Array.from({ length: 30000 }, (_, i) => Math.sin(i * i * .035) + .2 * Math.cos(i * .23));
const template = Float32Array.from(source.subarray(3210, 4210), v => v * .2 + .03);
const matched = findMatch(source, template);
check('Alignment recovers delay despite gain and DC changes', matched.sample === 3210 && near(matched.correlation, 1, 1e-7));
const inverted = findMatch(source, Float32Array.from(template, v => -v));
check('Alignment identifies inverted polarity', inverted.sample === 3210 && near(inverted.correlation, -1, 1e-7));
check('Silence does not create a spurious match', findMatch(source, new Float32Array(100)).sample === null);
check('Silent source does not create a spurious match', findMatch(new Float32Array(1000), template.subarray(0, 100)).sample === null);
assert.throws(() => findMatch(new Float32Array(1), template));
check('Invalid matching lengths reject', true);
const re = Float64Array.from(source.subarray(0, 1024)), im = new Float64Array(1024), original = re.slice();
fft(re, im); fft(re, im, true);
check('FFT inverse reconstructs input', re.every((v, i) => near(v, original[i], 1e-10)));
assert.throws(() => fft(new Float64Array(3), new Float64Array(3)));
check('Non-power-of-two FFT rejects', true);
const matches = [4, 16, 28, 40, 52].map(t => ({ referenceStartSeconds: t, sourceStartSeconds: 51.2 + t * 1.0005, correlation: .6 }));
matches.push({ referenceStartSeconds: 64, sourceStartSeconds: 10, correlation: .95 });
const timeline = consistentTimeline(matches);
check('Timeline rejects a stronger unrelated repeated phrase', timeline.matches === 5);
check('Timeline recovers clock drift and offset', near(timeline.scale, 1.0005, 1e-10) && near(timeline.offsetSeconds, 51.2, 1e-10));
check('Too few matches cannot establish a timeline', consistentTimeline(matches.slice(0, 2)) === null);
const rate = 24000;
for (const hz of [100, 1000, 8000, 10000]) {
  const tone = Float32Array.from({ length: rate }, (_, i) => .2 * Math.sin(2 * Math.PI * hz * i / rate));
  const warped = sampleTimeline(tone, rate, .1 + .5 / rate, 1.0005, rate / 2);
  check(`${hz} Hz survives fractional clock correction`, Math.abs(rmsDb(warped) - rmsDb(tone)) < .02);
}
const broadband = Float32Array.from({ length: rate }, (_, i) => .05 * Math.sin(i * i * .001));
const comparison = describePair(broadband, Float32Array.from(broadband, v => v * .25), rate);
check('Pair metric recovers a constant gain change', near(comparison.anchorGainDb, 20 * Math.log10(.25), .001));
check('Volume matching does not fabricate a tonal change', comparison.bands.every(x => Math.abs(x.normalizedGainDb) < .001));
assert.throws(() => describePair(broadband, new Float32Array(1), rate));
check('Mismatched pair lengths reject', true);
assert.throws(() => describePair(new Float32Array(rate), new Float32Array(rate), rate), /active signal/);
check('Silence cannot be scored as a perfect tonal match', true);
assert.throws(() => sampleTimeline(source, rate, -1, 1, 100));
check('Out-of-range timeline rejects instead of silently padding', true);
const square = Float32Array.from({ length: 48000 }, (_, i) => (Math.floor(i / 50) % 2 ? .5 : -.5));
const squareSig = clipSignature(square, 48000);
check('Clip signature: a square wave is all ceiling', near(squareSig.meanOverCeiling, 1, 1e-9) && near(squareSig.crestDb, 0, 1e-6)
  && near(squareSig.ceilingDbfs, 20 * Math.log10(.5), 1e-6) && squareSig.blockPeakSpreadDb === 0);
const sine = Float32Array.from({ length: 48000 }, (_, i) => .5 * Math.sin(2 * Math.PI * 440 * i / 48000));
const clipped = Float32Array.from(sine, v => Math.max(-.25, Math.min(.25, 2 * v)));
const sineSig = clipSignature(sine, 48000), clippedSig = clipSignature(clipped, 48000);
check('Clip signature: clipping raises mean/ceiling and lowers crest', clippedSig.meanOverCeiling > sineSig.meanOverCeiling + .1
  && clippedSig.crestDb < sineSig.crestDb - 1 && clippedSig.clippedPercent > sineSig.clippedPercent);
assert.throws(() => clipSignature(new Float32Array(100), 48000));
check('Clip signature rejects silence', true);
const wobble = Float32Array.from({ length: 48000 * 4 }, (_, i) => (.2 + .15 * Math.sin(i / 20000)) * Math.sin(i * .05));
const tracked = levelTracking(wobble, Float32Array.from(wobble, v => v * .5), 48000);
check('Level tracking removes a constant gain and finds perfect agreement',
  near(tracked.offsetDb, 20 * Math.log10(2), 1e-6) && tracked.rmsDeviationDb < 1e-6 && near(tracked.correlation, 1, 1e-9));
assert.throws(() => levelTracking(wobble, wobble.subarray(1), 48000));
check('Level tracking rejects unequal lengths', true);

// The page's real-take comparison (reference.js): a take made from the app's
// own render, 1.2345 s late, on a clock 200 ppm fast, 10 dB quieter, with a
// little noise, must be found and lined up with the source to a few
// microseconds, and then compare as identical.
{
  const { audio, sandbox } = audioEngine();
  sandbox.TF2Opus = await import('../opus-codec.mjs');
  globalThis.TF2Audio = audio;
  const sr = 48000, seconds = 20;
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  // Speech-like: syllables of shaped noise and gliding harmonics, with pauses.
  const src = new Float32Array(sr * seconds);
  let lp = 0;
  for (let i = 0; i < src.length; i++) {
    const t = i / sr, syllable = Math.floor(t / .23), on = (syllable * 7919) % 5 !== 0;
    const env = on ? Math.sin(Math.PI * ((t / .23) % 1)) ** 2 : 0;
    const f0 = 110 + 40 * Math.sin(t * 1.3) + 15 * (syllable % 4);
    lp += .3 * (random() - lp);
    let v = .25 * lp;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / (h + 1);
    src[i] = .12 * env * v;
  }
  const sim = (await audio.process({ sampleRate: sr, length: src.length, numberOfChannels: 1, getChannelData: () => src }, { codec: 'steam' })).samples;
  const k = 1.0002, delay = 1.2345, takeLength = Math.round((seconds + 2) * sr);
  const clean = TF2Reference.locate(TF2Reference.warp(src, sr, { offsetSeconds: delay, scale: 1 / k }, sr, takeLength), sr, src, sr);
  check(`Real take: offset and clock of a delayed, skewed copy (${((clean.offsetSeconds + delay * k) * 1e6).toFixed(2)} us, ${((clean.scale / k - 1) * 1e6).toFixed(2)} ppm off)`,
    near(clean.offsetSeconds, -delay * k, 5e-6) && near(clean.scale, k, .5e-6));
  // Through the chain: the render itself sits a fraction of a millisecond
  // off the source (the codec's residual delay), and the take inherits it.
  const own = TF2Reference.locate(sim, sr, src, sr);
  const take = TF2Reference.warp(sim, sr, { offsetSeconds: delay, scale: 1 / k }, sr, takeLength).map(v => .316 * v + 1e-4 * random());
  const found = TF2Reference.locate(take, sr, src, sr);
  const expected = own.offsetSeconds - delay * k * own.scale;
  check(`Real take: a take of the render lines up with the source (${((found.offsetSeconds - expected) * 1e6).toFixed(2)} us, render ${(own.offsetSeconds * 1e6).toFixed(0)} us off the source)`,
    near(found.offsetSeconds, expected, 20e-6) && near(found.scale, own.scale * k, 1e-6) && found.polarity === 1 && found.correlation > .8);
  const aligned = TF2Reference.warp(take, sr, found, sr, src.length);
  const report = TF2Reference.compareTake(aligned, sim, sr);
  const worst = Math.max(...report.bands.filter(b => b.simMinusRealDb !== null && Number(b.hz.split('-')[1]) <= 12000).map(b => Math.abs(b.simMinusRealDb)));
  check(`Real take: aligned, the take matches the render (bands within ${worst.toFixed(2)} dB, levels ${report.levelTracking.rmsDeviationDb.toFixed(3)} dB rms)`,
    worst < .1 && report.levelTracking.rmsDeviationDb < .05 && near(report.anchorGainDb, 10, .1));
  const simOnSource = TF2Reference.warp(sim, sr, own, sr, src.length);
  let err = 0, ref = 0;
  for (let i = sr; i < src.length - sr; i++) { err += (.316 * simOnSource[i] - aligned[i]) ** 2; ref += (.316 * simOnSource[i]) ** 2; }
  check(`Real take: the aligned take nulls against the render (${(10 * Math.log10(err / ref)).toFixed(1)} dB)`, 10 * Math.log10(err / ref) < -25);
  const short = TF2Reference.locate(take.subarray(Math.round(3 * sr), Math.round(6 * sr)), sr, src, sr);
  // Too short to measure the clock (200 ppm here): within a fraction of a millisecond.
  const at = (tl, tau) => tl.offsetSeconds + tl.scale * tau;
  check(`Real take: a 3 s excerpt is found (${short.method}, ${((at(short, 1.5) - at(found, 4.5)) * 1e6).toFixed(0)} us at its centre)`,
    near(at(short, 1.5), at(found, 4.5), 200e-6) && near(at(short, 0), at(found, 3), 500e-6) && near(at(short, 3), at(found, 6), 500e-6));
  assert.throws(() => TF2Reference.locate(Float32Array.from({ length: sr * 5 }, () => .1 * random()), sr, src, sr), /not found|line up/);
  check('Real take: unrelated audio is rejected', true);

  // TF2's receiver re-times talk spurts and trims latency in 5.8 ms skips.
  // A source with a 1.2 s pause (two talk spurts for the gate); in the take
  // the second spurt comes 250 ms early, and 5.8 ms (256 samples at
  // 44.1 kHz) are skipped inside it at 16 s. The take must come apart into
  // those segments, breaks included, and line up.
  const paused = src.map((v, i) => (i >= 6.4 * sr && i < 7.6 * sr ? 0 : v));
  const simPaused = (await audio.process({ sampleRate: sr, length: paused.length, numberOfChannels: 1, getChannelData: () => paused }, { codec: 'steam' })).samples;
  const skip = 256 / 44100;
  const pieces = [{ a: -1, b: 1, start: 0, end: 7.75 }, { a: -.75, b: 1, start: 7.75, end: 16.75 }, { a: -.75 + skip, b: 1, start: 16.75, end: 20.75 }];
  const spurts = TF2Reference.warpSegments(simPaused, sr, pieces, sr, Math.round(21 * sr)).map(v => .316 * v + 1e-4 * random());
  const gate = { thresholdDb: -39.5, prerollMs: 120, holdMs: 440 };
  const tracked = TF2Reference.track(spurts, sr, paused, sr, { gate });
  const ownPaused = TF2Reference.locate(simPaused, sr, paused, sr);
  const renderLead = -ownPaused.offsetSeconds * 1000;
  const delays = tracked.segments.map(g => g.delayMs - renderLead);
  check(`Real take, spurt by spurt: segments at 1000 / 750 / 744.2 ms (${delays.map(d => d.toFixed(2)).join(' / ')} ms, ${tracked.spurts} spurts)`,
    tracked.segments.length === 3 && tracked.spurts === 2 && near(delays[0], 1000, .08) && near(delays[1], 750, .08) && near(delays[2], 750 - skip * 1000, .08));
  const breaks = tracked.segments.slice(0, -1).map(g => g.end);
  check(`Real take, spurt by spurt: breaks in the pause and at the trim (${breaks.map(b => b.toFixed(3)).join(', ')} s)`,
    breaks.length === 2 && breaks[0] > 6.5 && breaks[0] < 7.5 && near(breaks[1], 16, .011));
  // Against the construction: take time tau holds the render at
  // piece.a + tau, which should be source time t less the render's own
  // offset from its source.
  let misaligned = 0;
  for (const g of tracked.segments) {
    for (let t = g.start + .05; t < g.end - .05; t += .1) {
      if (t > 6.3 && t < 7.7) continue;   // the pause: silence either way
      const tau = g.a + g.b * t, piece = pieces.find(p => tau >= p.start && tau < p.end);
      if (!piece) continue;
      const e = Math.abs(piece.a + tau - (t - ownPaused.offsetSeconds));
      misaligned = Math.max(misaligned, e);
    }
  }
  check(`Real take, spurt by spurt: every segment lines up to within ${(misaligned * 1e6).toFixed(0)} us`, misaligned < 150e-6);
  // A steady tone gives no waveform lag; its spurt is placed by its onset.
  const tone = Float32Array.from({ length: 6 * sr }, (_, i) => (i > sr && i < 5 * sr ? .1 * Math.sin(2 * Math.PI * 440 * i / sr) : 0));
  const toneTake = new Float32Array(7 * sr);
  toneTake.set(tone.map(v => .5 * v), Math.round(.8 * sr));
  const toneTrack = TF2Reference.track(toneTake, sr, tone, sr, { gate });
  check(`Real take, spurt by spurt: a pure tone is placed by its onset (${toneTrack.segments[0].delayMs.toFixed(1)} ms)`,
    toneTrack.segments.length === 1 && near(toneTrack.segments[0].delayMs, 800, 3));
}

// Segment measures for the pre-registered predictions (tests/predictions).
{
  const sr = 48000, db = (x) => 20 * Math.log10(x);
  const sine = (f, amp, n) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
  // A 1 kHz sine at 0.1 reads its RMS level in its band; white noise 10 dB
  // louder than the sine is some 16 dB under it there.
  let seed = 1;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - .5; };
  const x = sine(1000, .1, 2 * sr), mixed = Float32Array.from(x, v => v + .775 * noise());
  const band = TF2Reference.segmentBand('sine1k_-20dB');
  check('Segment band: a 1 kHz sine is measured 30 Hz either side', band[0] === 970 && band[1] === 1030
    && TF2Reference.segmentBand('tone_5000Hz_-20dB').join() === '4970,5030' && TF2Reference.segmentBand('pink_-20dB').join() === '150,10000');
  check('Band level: a sine reads its RMS level in its band', near(TF2Reference.bandLevelDb(x, sr, 0, x.length, ...band), db(.1 / Math.SQRT2), .01));
  check('Band level: a sine stays measurable under 10 dB louder broadband noise',
    near(TF2Reference.bandLevelDb(mixed, sr, 0, mixed.length, ...band), db(.1 / Math.SQRT2), .3));
  // The clamp: a clipped sine's plateau, even with a spike 2 dB over it.
  const clipped = Float32Array.from(sine(1000, .3, sr), v => Math.max(-.15, Math.min(.15, v)));
  clipped[1000] = .15 * 10 ** (2.1 / 20);
  check('Clamp: found at the plateau, not at a louder spike', near(db(TF2Reference.clampLevel(clipped)), db(.15), .1));
  const stats = TF2Reference.segmentStats(clipped, sr, [{ name: 'sine1k_-10dB', start_s: 0, dur_s: 1 }], TF2Reference.clampLevel(clipped));
  const expected = 100 * (1 - 2 / Math.PI * Math.asin(.9 * .15 / .3));
  check(`Segment stats: the clipped share counts samples within 10% of the clamp (${stats[0].clipPct.toFixed(1)}%)`,
    stats.length === 1 && near(stats[0].clipPct, expected, 1));
}

console.log(`\n${passed} paired-reference checks passed.`);
