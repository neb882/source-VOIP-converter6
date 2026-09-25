import assert from 'node:assert/strict';
import { fft, findMatch, consistentTimeline, sampleTimeline, describePair, rmsDb, clipSignature, levelTracking } from './reference.compare.mjs';

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
console.log(`\n${passed} paired-reference checks passed.`);
