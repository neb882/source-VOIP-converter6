/* Accuracy suite: every real TF2 take against the app's render of its source.
 *
 * Local only: the recordings are not committed and nothing is uploaded. The
 * takes and the settings each was recorded with are in accuracy.takes.json;
 * this script finds the files by name in a folder, then, in headless
 * Chromium running the app itself:
 *   - decodes the take and the source with the browser's decoders (48 kHz)
 *   - renders the source with the take's settings (TF2Audio.process)
 *   - lines the take up with the source talk spurt by talk spurt
 *     (TF2Reference.track, the page's real-take check)
 *   - compares the two over the part the take covers (compareTake)
 * It prints one row per take and, with --json, writes everything, including
 * each talk spurt's timing in the take.
 *
 * Pre-registered predictions (tests/predictions): --write-predictions
 * renders every hypothesis in tests/predictions/plan.json and writes
 * predictions.json; --score-predictions --takes <folder> scores the takes
 * recorded since against it, segment by segment (see PREDICTIONS.md).
 * --simulate-takes <folder> --ambience <take> writes stand-in takes, each
 * hypothesis's render plus the game sound from a real take, to check that
 * the scoring picks the hypothesis a take was made from.
 *
 * Usage: node tests/accuracy.mjs --takes <folder> [--only name,name] [--json out.json]
 *        node tests/accuracy.mjs --write-predictions
 *        node tests/accuracy.mjs --score-predictions --takes <folder> [--json out.json]
 *        node tests/accuracy.mjs --simulate-takes <folder> --ambience <take>
 *   The folder (or TF2_TAKES) holds the takes and the non-generated sources
 *   under the names in the manifest; an 8-hex-digit upload prefix
 *   ("1a2b3c4d-") and punctuation are ignored when matching. Generate the
 *   test signals first (tests/testsignal/README.md).
 *   CHROMIUM_EXECUTABLE picks a preinstalled Chromium, as in browser.verify.js.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createStaticServer } = require('./static-server.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function args() {
  const out = { takes: process.env.TF2_TAKES || '', only: null, json: '', write: false, score: false, simulate: '', ambience: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--takes') out.takes = argv[++i];
    else if (argv[i] === '--only') out.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--json') out.json = argv[++i];
    else if (argv[i] === '--write-predictions') out.write = true;
    else if (argv[i] === '--score-predictions') out.score = true;
    else if (argv[i] === '--simulate-takes') out.simulate = argv[++i];
    else if (argv[i] === '--ambience') out.ambience = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return out;
}

// Names compare without an upload prefix, case, spaces or punctuation.
const key = (name) => path.basename(name).replace(/^[0-9a-f]{8}-/i, '').toLowerCase().replace(/[^a-z0-9.]/g, '');

function indexFolder(folder) {
  const files = new Map();
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (entry.isFile() && !files.has(key(entry.name))) files.set(key(entry.name), full);
    }
  };
  if (folder && fs.existsSync(folder)) walk(folder, 0);
  return files;
}

function resolveFile(name, files) {
  if (name.startsWith('tests/')) { const full = path.join(root, name); return fs.existsSync(full) ? full : null; }
  return files.get(key(name)) || null;
}

// Runs in the page, with the app's globals (TF2Audio, TF2Reference,
// renderOptions, takeChannel, takeTrackOptions).
async function measureInPage({ takeUrl, sourceUrl, settings, takeChannelName, takeSeconds }) {
  const rate = 48000, ctx = new OfflineAudioContext(1, 1, rate);
  const decode = async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const started = performance.now();
  const [takeBuffer, source] = await Promise.all([decode(takeUrl), decode(sourceUrl)]);
  let take = takeChannel(takeBuffer, takeChannelName || 'mix');
  let takeStart = 0;
  if (takeSeconds) {
    // A cut from a longer recording: that part, without the digital
    // silence around it.
    let a = Math.round(takeSeconds[0] * rate), b = Math.min(take.length, Math.round(takeSeconds[1] * rate));
    while (a < b && Math.abs(take[a]) < 1e-5) a++;
    while (b > a && Math.abs(take[b - 1]) < 1e-5) b--;
    take = take.slice(a, b);
    takeStart = a / rate;
  }
  const opts = { ...renderOptions(), ...settings };
  const rendered = await TF2Audio.process(source, opts);
  if (rendered.sampleRate !== rate) throw new Error(`rendered at ${rendered.sampleRate} Hz`);
  // The take is lined up against a render (see track()); a lossless one
  // when the take has random loss or jitter, whose concealment differs.
  const random = opts.lossPct > 0 || opts.jitterMs > 0;
  const guide = random ? await TF2Audio.process(source, { ...opts, lossPct: 0, jitterMs: 0 }) : rendered;
  const captured = TF2Audio.bufferToMono(source, opts.captureChannel);
  const trackOptions = { ...takeTrackOptions(opts), reference: { samples: guide.samples, rate, frames: guide.codecInfo.frameLog } };
  const timeline = TF2Reference.track(take, rate, captured, rate, trackOptions);
  const aligned = TF2Reference.warpSegments(take, rate, timeline.segments, rate, captured.length);
  const sim = rendered.samples;
  const from = Math.max(0, Math.round(timeline.overlap.t0 * rate));
  const to = Math.min(sim.length, aligned.length, Math.round(timeline.overlap.t1 * rate));
  if (to - from < rate) throw new Error('the take overlaps the source by less than a second');
  const report = TF2Reference.compareTake(aligned.subarray(from, to), sim.subarray(from, to), rate);
  const spurts = trackOptions.gate ? TF2Reference.gateSpurts(captured, rate, trackOptions.gate, trackOptions.micGain) : [];
  return {
    seconds: { take: takeBuffer.duration, source: source.duration, work: (performance.now() - started) / 1000 },
    takeStart, options: opts, trackOptions: { gate: trackOptions.gate, micGain: trackOptions.micGain },
    timeline: { spurts: timeline.spurts, points: timeline.points, correlation: timeline.correlation, polarity: timeline.polarity,
      overlap: timeline.overlap, segments: timeline.segments },
    gateSpurts: spurts,
    report
  };
}

// A prediction: the source rendered with one hypothesis's settings and
// measured as a take will be (reference.js segmentStats, bandProfile).
async function predictInPage({ sourceUrl, segmentsUrl, settings }) {
  const rate = 48000, ctx = new OfflineAudioContext(1, 1, rate);
  const source = await ctx.decodeAudioData(await (await fetch(sourceUrl)).arrayBuffer());
  const segments = (await (await fetch(segmentsUrl)).json()).segments;
  const opts = { ...renderOptions(), ...settings };
  const rendered = await TF2Audio.process(source, opts);
  const sim = rendered.samples.subarray(0, Math.round(source.duration * rate));
  // The clamp by its plateau (clampLevel), not a percentile.
  const ceiling = TF2Reference.clampLevel(sim);
  let near = 0;
  for (const v of sim) if (Math.abs(v) > .9 * ceiling) near++;
  const clip = { ceilingDbfs: 20 * Math.log10(ceiling), clippedPercent: 100 * near / sim.length };
  const round = (v, d = 2) => (v === null || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d);
  const info = rendered.codecInfo, log = info.frameLog || [];
  const count = (code) => log.reduce((n, c) => n + (c === code ? 1 : 0), 0);
  return {
    ceilingDbfs: round(clip.ceilingDbfs), clippedPercent: round(clip.clippedPercent),
    segments: TF2Reference.segmentStats(sim, rate, segments, ceiling)
      .map(x => ({ ...x, levelDb: round(x.levelDb), peakDb: round(x.peakDb), clipPct: round(x.clipPct), bandDb: round(x.bandDb) })),
    bands: TF2Reference.bandProfile(sim.subarray(Math.round(2.5 * rate)), rate).map(b => ({ hz: b.hz, db: round(b.db) })),
    codec: { backend: info.backend, version: info.version, frames: log.length, gated: count(0), dtx: count(4),
      frameMs: round(info.frameMs || 20), bitrate: info.bitrate, packetBytes: info.packetBytes || null }
  };
}

// A recorded take, lined up with the source as in measureInPage (against
// the primary hypothesis's render) and measured the same way.
async function takeStatsInPage({ takeUrl, sourceUrl, segmentsUrl, settings }) {
  const rate = 48000, ctx = new OfflineAudioContext(1, 1, rate);
  const decode = async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const [takeBuffer, source] = await Promise.all([decode(takeUrl), decode(sourceUrl)]);
  const segments = (await (await fetch(segmentsUrl)).json()).segments;
  const take = takeChannel(takeBuffer, 'mix');
  const opts = { ...renderOptions(), ...settings };
  const rendered = await TF2Audio.process(source, opts);
  const captured = TF2Audio.bufferToMono(source, opts.captureChannel);
  const trackOptions = { ...takeTrackOptions(opts), reference: { samples: rendered.samples, rate, frames: rendered.codecInfo.frameLog } };
  const timeline = TF2Reference.track(take, rate, captured, rate, trackOptions);
  const aligned = TF2Reference.warpSegments(take, rate, timeline.segments, rate, captured.length);
  const from = Math.max(0, Math.round(timeline.overlap.t0 * rate)), to = Math.min(aligned.length, Math.round(timeline.overlap.t1 * rate));
  const part = aligned.subarray(from, to), ceiling = TF2Reference.clampLevel(part);
  let near = 0;
  for (const v of part) if (Math.abs(v) > .9 * ceiling) near++;
  const clip = { ceilingDbfs: 20 * Math.log10(ceiling), clippedPercent: 100 * near / part.length };
  const stats = TF2Reference.segmentStats(aligned, rate, segments, ceiling)
    .filter(x => x.start >= timeline.overlap.t0 && x.end <= timeline.overlap.t1);
  // The ambience (game sound between segments): the median over quiet
  // segments of 1 s or more, broadband and in each segment band.
  const median = (v) => { v = v.filter(x => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : -Infinity; };
  const quiet = stats.filter(x => x.quiet && x.end - x.start >= 1);
  const bandAmbienceDb = {};
  for (const { band } of stats) {
    bandAmbienceDb[band.join('-')] ??= median(quiet.map(x => TF2Reference.bandLevelDb(aligned, rate,
      Math.round((x.start + .2 * (x.end - x.start)) * rate), Math.round((x.start + .8 * (x.end - x.start)) * rate), band[0], band[1])));
  }
  return { ceilingDbfs: clip.ceilingDbfs, clippedPercent: clip.clippedPercent, segments: stats,
    ambienceDb: median(quiet.map(x => x.levelDb)), bandAmbienceDb,
    bands: TF2Reference.bandProfile(aligned.subarray(Math.max(from, Math.round(2.5 * rate)), to), rate),
    timeline: { spurts: timeline.spurts, segments: timeline.segments.length, correlation: timeline.correlation, overlap: timeline.overlap } };
}

// One take against one hypothesis, with the pre-registered tolerances.
// Every segment is measured in its band (reference.js segmentBand). One the
// hypothesis puts 10 dB or more over the take's ambience in that band
// compares levels; one it puts lower passes if the take is under that line
// too (plus the level tolerance, since the ambience adds to what the
// hypothesis predicts). Opus (DTX) hypotheses report the DTX-sensitive
// tones apart.
function scoreHypothesis(pred, take, tol) {
  const apart = new Set(pred.codec && pred.codec.backend === 'libopus' ? tol.dtxSensitive || [] : []);
  const skip = new Set(tol.notScored || []);
  const rows = [];
  for (const p of pred.segments.filter(x => !x.quiet && !skip.has(x.name))) {
    const t = take.segments.find(x => x.name === p.name && Math.abs(x.start - p.start) < 1e-6);
    if (!t || t.bandDb === null || p.bandDb === null) continue;
    const floor = (take.bandAmbienceDb[p.band.join('-')] ?? -Infinity) + tol.scorableAboveAmbienceDb;
    const audible = p.bandDb >= floor;
    const levelOk = audible ? Math.abs(t.bandDb - p.bandDb) <= tol.levelDb : t.bandDb < floor + tol.levelDb;
    const clipTested = p.clipPct > .5 || t.clipPct > .5;
    const clipOk = !clipTested || Math.abs(t.clipPct - p.clipPct) <= tol.clipPoints;
    rows.push({ name: p.name, start: p.start, apart: apart.has(p.name), predictedDb: p.bandDb, measuredDb: t.bandDb, floorDb: floor, audible,
      errorDb: audible ? t.bandDb - p.bandDb : null, levelOk, predictedClip: p.clipPct, measuredClip: t.clipPct, clipOk: clipTested ? clipOk : null });
  }
  const bands = pred.bands.map((b, i) => {
    const [lo, hi] = b.hz.split('-').map(Number), t = take.bands[i];
    if (lo < tol.bandHz[0] || hi > tol.bandHz[1] || b.db === null || !t || t.db === null) return null;
    return { hz: b.hz, predictedDb: b.db, measuredDb: t.db, ok: Math.abs(t.db - b.db) <= tol.bandDb };
  }).filter(Boolean);
  const counted = rows.filter(r => !r.apart), audible = counted.filter(r => r.audible);
  const rmsError = audible.length ? Math.sqrt(audible.reduce((x, r) => x + r.errorDb ** 2, 0) / audible.length) : null;
  const ok = (r) => r.levelOk && r.clipOk !== false;
  rows.forEach(r => { r.ok = ok(r); });
  const passed = counted.filter(ok).length, bandsPassed = bands.filter(b => b.ok).length, ceilingErrorDb = take.ceilingDbfs - pred.ceilingDbfs;
  const rule = tol.holds;
  const holds = passed >= rule.segmentShare * counted.length && bandsPassed >= bands.length - rule.bandsMissed && Math.abs(ceilingErrorDb) <= rule.ceilingDb;
  return { rows, bands, rmsError, holds, passed, total: counted.length,
    apartPassed: rows.filter(r => r.apart && ok(r)).length, apartTotal: rows.filter(r => r.apart).length,
    bandsPassed, bandsTotal: bands.length, ceilingErrorDb };
}

// Two hypotheses are told apart on the segments where no measurement can be
// within tolerance of both: level predictions more than twice the level
// tolerance apart, or one hypothesis predicting a level at least that far
// over the line the other's "nothing here" allows. Segments either reports
// apart are left out.
function discriminate(a, b, tol) {
  const segments = [];
  // The levels a row accepts.
  const range = (r) => (r.audible ? [r.predictedDb - tol.levelDb, r.predictedDb + tol.levelDb] : [-Infinity, r.floorDb + tol.levelDb]);
  for (const x of a.rows) {
    const y = b.rows.find(r => r.name === x.name && r.start === x.start);
    if (!y || x.apart || y.apart) continue;
    const [x0, x1] = range(x), [y0, y1] = range(y);
    if (x1 < y0 || y1 < x0) {
      segments.push({ name: x.name, start: x.start, [a.id]: x.ok, [b.id]: y.ok });
    }
  }
  const passA = segments.filter(s => s[a.id]).length, passB = segments.filter(s => s[b.id]).length;
  const [win, lose, pw, pl] = passA >= passB ? [a, b, passA, passB] : [b, a, passB, passA];
  const n = segments.length, rule = tol.decisive;
  const decisive = n >= rule.minSegments && pw >= rule.winnerShare * n && pl <= rule.loserShare * n;
  return { segments, [a.id]: passA, [b.id]: passB, best: n ? win.id : null, other: lose.id, decisive };
}

// Sums a take's timing up: re-timings between segments of one spurt are
// latency trims (5.8 ms) or other steps; between spurts, re-timings.
const TRIM_MS = 1000 * 256 / 44100;
function timing(result) {
  const segs = result.timeline.segments;
  const steps = [];
  for (let i = 1; i < segs.length; i++) {
    const d = segs[i].delayMs - segs[i - 1].delayMs;
    steps.push({ at: segs[i].start, ms: d, within: segs[i].spurt === segs[i - 1].spurt,
      trim: Math.abs(Math.abs(d) - TRIM_MS) < 0.8 });
  }
  const delays = segs.map(s => s.delayMs);
  return { steps, trims: steps.filter(s => s.trim).length, within: steps.filter(s => s.within && !s.trim).length,
    between: steps.filter(s => !s.within).length, minMs: Math.min(...delays), maxMs: Math.max(...delays),
    clockPpm: segs[0].clockPpm };
}

function summary(result) {
  const r = result.report, lt = r.levelTracking || {};
  const inBand = (r.bands || []).filter(b => {
    const [lo, hi] = String(b.hz).split('-').map(Number);
    return lo >= 80 && hi <= 12000 && b.simMinusRealDb !== null;
  });
  const worst = inBand.reduce((w, b) => (Math.abs(b.simMinusRealDb) > Math.abs(w.simMinusRealDb) ? b : w), { simMinusRealDb: 0, hz: '' });
  return { levelRms: lt.rmsDeviationDb, levelWorst: lt.worstDeviationDb, levelR: lt.correlation, blocks: lt.blocks,
    bandWorst: worst.simMinusRealDb, bandWorstHz: worst.hz, anchorDb: r.anchorGainDb,
    clipTake: r.clip && r.clip.real ? r.clip.real.clippedPercent : null, clipSim: r.clip && r.clip.sim ? r.clip.sim.clippedPercent : null };
}

const f = (v, d = 1, sign = false) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${sign && v >= 0 ? '+' : ''}${v.toFixed(d)}`);

// The app in headless Chromium, with local files served under /__take/.
async function openApp() {
  const server = await createStaticServer(root);
  const base = `http://127.0.0.1:${server.address().port}`;
  const launchOptions = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE;
  let browser;
  try { browser = await chromium.launch(launchOptions); }
  catch (error) {
    if (!String(error.message).includes('Executable doesn\'t exist')) { server.close(); throw error; }
    browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const served = new Map();
  await page.route('**/__take/**', (route) => {
    const file = served.get(decodeURIComponent(new URL(route.request().url()).pathname.replace('/__take/', '')));
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto(base);
  await page.waitForFunction(() => window.TF2Audio && window.TF2Reference && typeof renderOptions === 'function' && typeof takeTrackOptions === 'function');
  return { page, base, served, close: async () => { await browser.close(); server.close(); } };
}

const PREDICTIONS = path.join(root, 'tests/predictions');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The model files a prediction depends on, so a later run can tell whether
// the model has changed since.
const MODEL_FILES = ['audio.js', 'constants.js', 'opus-codec.mjs', 'reference.js', 'vendor/libopus-1.1/libopus-1.1.5.wasm.mjs',
  'vendor/celt-0.11/celt-0.11.wasm.mjs', 'vendor/libopus/generated/libopus.generated.mjs'];

async function writePredictions() {
  const plan = JSON.parse(fs.readFileSync(path.join(PREDICTIONS, 'plan.json'), 'utf8'));
  if (!fs.existsSync(path.join(root, plan.signal))) throw new Error(`${plan.signal} is missing: generate it first (tests/testsignal/README.md).`);
  const app = await openApp();
  const takes = [];
  try {
    for (const take of plan.takes) {
      const hypotheses = [];
      for (const h of take.hypotheses) {
        process.stdout.write(`${take.id} / ${h.id}… `);
        const result = await app.page.evaluate(predictInPage, { sourceUrl: `${app.base}/${plan.signal}`, segmentsUrl: `${app.base}/${plan.segments}`, settings: h.settings });
        const audible = result.segments.filter(x => !x.quiet && x.levelDb > -60).length;
        console.log(`ceiling ${result.ceilingDbfs} dBFS, ${result.clippedPercent}% at it, ${audible} audible segments`);
        hypotheses.push({ ...h, prediction: result });
      }
      takes.push({ ...take, hypotheses });
    }
  } finally { await app.close(); }
  const out = { about: 'Pre-registered predictions: the app\'s renders of takes not yet recorded (tests/predictions/PREDICTIONS.md).',
    generated: new Date().toISOString(), app: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    signalSha256: sha256(path.join(root, plan.signal)),
    modelFiles: Object.fromEntries(MODEL_FILES.map(f => [f, sha256(path.join(root, f))])),
    tolerances: plan.tolerances, takes };
  const file = path.join(PREDICTIONS, 'predictions.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log(`\nWrote ${path.relative(root, file)}, SHA-256 ${sha256(file)}`);
}

async function scorePredictions(opt) {
  const file = path.join(PREDICTIONS, 'predictions.json');
  const predictions = JSON.parse(fs.readFileSync(file, 'utf8'));
  const registered = /SHA-256 of predictions\.json: `([0-9a-f]{64})`/.exec(fs.readFileSync(path.join(PREDICTIONS, 'PREDICTIONS.md'), 'utf8'));
  const hash = sha256(file);
  console.log(`predictions.json SHA-256 ${hash}: ${registered && registered[1] === hash ? 'matches the registered hash' : 'DOES NOT match the registered hash'}`);
  const changed = MODEL_FILES.filter(f => predictions.modelFiles[f] !== sha256(path.join(root, f)));
  if (changed.length) console.log(`The model has changed since the predictions (${changed.join(', ')}); they are scored as registered.`);
  const files = indexFolder(opt.takes);
  const plan = JSON.parse(fs.readFileSync(path.join(PREDICTIONS, 'plan.json'), 'utf8'));
  const source = path.join(root, plan.signal);
  const jobs = predictions.takes.map(t => ({ ...t, takeFile: [].concat(t.file).map(n => resolveFile(n, files)).find(Boolean) })).filter(t => t.takeFile);
  if (!jobs.length) { console.log(`No predicted takes found in ${opt.takes || '(no folder)'}: ${predictions.takes.map(t => [].concat(t.file)[0]).join(', ')}`); process.exitCode = 1; return; }
  const app = await openApp();
  const results = [];
  try {
    app.served.set('source', source);
    for (const job of jobs) {
      app.served.set('take', job.takeFile);
      const primary = job.hypotheses.find(h => h.primary) || job.hypotheses[0];
      const take = await app.page.evaluate(takeStatsInPage, { takeUrl: `${app.base}/__take/take?${results.length}`, sourceUrl: `${app.base}/__take/source`,
        segmentsUrl: `${app.base}/${plan.segments}`, settings: primary.settings });
      const scored = job.hypotheses.map(h => ({ id: h.id, label: h.label, primary: !!h.primary, ...scoreHypothesis(h.prediction, take, predictions.tolerances) }));
      // The two that fit best (most segments within tolerance, then level
      // error) are compared on the segments that tell them apart.
      const ranked = scored.slice().sort((x, y) => y.passed / Math.max(1, y.total) - x.passed / Math.max(1, x.total) || (x.rmsError ?? 99) - (y.rmsError ?? 99));
      const versus = ranked.length > 1 ? discriminate(ranked[0], ranked[1], predictions.tolerances) : null;
      console.log(`\n${job.id}${job.control ? ' (control: recorded before the predictions)' : ''}: ${job.question}\n  take: ambience ${f(take.ambienceDb, 1)} dBFS, ceiling ${f(take.ceilingDbfs, 1)} dBFS, ${take.timeline.spurts} spurts, r ${f(take.timeline.correlation, 2)}`);
      for (const x of scored) {
        console.log(`  ${x.primary ? '*' : ' '} ${x.id.padEnd(12)} segments ${x.passed}/${x.total} within tolerance${x.apartTotal ? ` (DTX-sensitive tones ${x.apartPassed}/${x.apartTotal})` : ''}, `
          + `level error ${f(x.rmsError, 2)} dB rms, bands ${x.bandsPassed}/${x.bandsTotal}, ceiling ${f(x.ceilingErrorDb, 1, true)} dB: ${x.holds ? 'holds' : 'misses'}  (${x.label})`);
      }
      if (versus) {
        const n = versus.segments.length;
        console.log(`  ${n} segments tell ${ranked[0].id} and ${ranked[1].id} apart: ${ranked[0].id} ${versus[ranked[0].id]}/${n}, ${ranked[1].id} ${versus[ranked[1].id]}/${n}`
          + ` → ${versus.best ? `${versus.best}${versus.decisive ? ' (decisive)' : ' (not decisive)'}` : 'no verdict'}`);
      }
      results.push({ id: job.id, take: path.basename(job.takeFile), measured: take, scored, versus,
        best: versus ? versus.best : scored[0].id, decisive: versus ? versus.decisive : null });
    }
  } finally { await app.close(); }
  if (opt.json) { fs.writeFileSync(opt.json, JSON.stringify({ generated: new Date().toISOString(), predictionsSha256: hash, results }, null, 1)); console.log(`\nWrote ${opt.json}`); }
}

// A stand-in take: one hypothesis's render, 3 s in, plus game sound (the
// quietest 30% of a real take's 100 ms stretches, strung together), as a
// 16-bit WAV. Read back by --score-predictions like a recording.
async function simulateInPage({ sourceUrl, ambienceUrl, settings }) {
  const rate = 48000, lead = 3 * rate, step = rate / 10, ctx = new OfflineAudioContext(1, 1, rate);
  const source = await ctx.decodeAudioData(await (await fetch(sourceUrl)).arrayBuffer());
  const a = takeChannel(await ctx.decodeAudioData(await (await fetch(ambienceUrl)).arrayBuffer()), 'mix');
  const windows = [];
  for (let i = 0; i + step <= a.length; i += step) {
    let e = 0;
    for (let k = 0; k < step; k++) e += a[i + k] ** 2;
    windows.push({ at: i, e });
  }
  const cut = windows.map(w => w.e).sort((x, y) => x - y)[Math.floor(windows.length * .3)];
  const quiet = windows.filter(w => w.e > 0 && w.e <= cut).map(w => a.subarray(w.at, w.at + step));
  if (!quiet.length) throw new Error('the ambience take is silent');
  const rendered = (await TF2Audio.process(source, { ...renderOptions(), ...settings })).samples;
  const n = rendered.length + lead, x = new Float32Array(n);
  x.set(rendered, lead);
  for (let i = 0, q = 0; i < n; i += step, q++) {
    const w = quiet[q % quiet.length];
    for (let k = 0; k < step && i + k < n; k++) x[i + k] += w[k];
  }
  const buffer = new ArrayBuffer(44 + n * 2), dv = new DataView(buffer);
  const text = (at, s) => [...s].forEach((c, i) => dv.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  text(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), true);
  const u8 = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// One folder per hypothesis (<take>__<hypothesis>), holding the take's file
// name, so each can be scored with --score-predictions --takes <that folder>.
async function simulateTakes(opt) {
  if (!opt.ambience || !fs.existsSync(opt.ambience)) throw new Error('--simulate-takes needs --ambience <a real take>');
  const plan = JSON.parse(fs.readFileSync(path.join(PREDICTIONS, 'plan.json'), 'utf8'));
  const app = await openApp();
  try {
    app.served.set('ambience', path.resolve(opt.ambience));
    for (const take of plan.takes.filter(t => !t.control)) {
      for (const h of take.hypotheses) {
        const b64 = await app.page.evaluate(simulateInPage, { sourceUrl: `${app.base}/${plan.signal}`, ambienceUrl: `${app.base}/__take/ambience`, settings: h.settings });
        const dir = path.join(opt.simulate, `${take.id}__${h.id}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, [].concat(take.file)[0]), Buffer.from(b64, 'base64'));
        console.log(`${path.relative(process.cwd(), dir)}/${[].concat(take.file)[0]}`);
      }
    }
  } finally { await app.close(); }
}

async function main() {
  const opt = args();
  if (opt.simulate) return simulateTakes(opt);
  if (opt.write) return writePredictions();
  if (opt.score) return scorePredictions(opt);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/accuracy.takes.json'), 'utf8'));
  if (opt.help) {
    console.log('node tests/accuracy.mjs --takes <folder> [--only name,name] [--json out.json]\n');
    for (const t of manifest.takes) console.log(`  ${t.name.padEnd(26)} set ${t.set}  ${t.take[0]}  ←  ${t.source}`);
    return;
  }
  const files = indexFolder(opt.takes);
  const entries = manifest.takes.filter(t => !opt.only || opt.only.includes(t.name));
  const jobs = [], missing = [];
  for (const t of entries) {
    const take = t.take.map(n => resolveFile(n, files)).find(Boolean), source = resolveFile(t.source, files);
    if (!take || !source) missing.push(`${t.name} (${!take ? t.take[0] : t.source})`);
    else jobs.push({ ...t, takeFile: take, sourceFile: source });
  }
  if (missing.length) console.log(`Skipped, file not found: ${missing.join(', ')}`);
  if (!jobs.length) { console.log('Nothing to measure. Pass the folder with --takes (see --help).'); process.exitCode = 1; return; }

  const app = await openApp();
  const { page, base, served } = app;
  const results = [];
  try {
    console.log('\nTake                       Set  Spurts Segs  Delay, s (min…max)  Trims Other  Clock ppm  r     Level rms/worst dB  r      Worst band 80 Hz–12 kHz  Clip % take/sim  Level, sim − take');
    for (const job of jobs) {
      served.set('take', job.takeFile);
      served.set('source', job.sourceFile);
      process.stdout.write(`${job.name.padEnd(27)}${job.set.padEnd(5)}`);
      try {
        const result = await page.evaluate(measureInPage, { takeUrl: `${base}/__take/take?${results.length}`, sourceUrl: `${base}/__take/source?${results.length}`,
          settings: job.settings || {}, takeChannelName: job.takeChannel || 'mix', takeSeconds: job.takeSeconds || null });
        const t = timing(result), s = summary(result);
        results.push({ name: job.name, set: job.set, take: path.basename(job.takeFile), source: path.basename(job.sourceFile),
          settings: job.settings, random: !!job.random, timing: t, summary: s, ...result });
        console.log(`${String(result.timeline.spurts).padStart(6)} ${String(result.timeline.segments.length).padStart(4)}  `
          + `${f(t.minMs / 1000, 3).padStart(8)}…${f(t.maxMs / 1000, 3).padEnd(9)}  ${String(t.trims).padStart(5)} ${String(t.within + t.between).padStart(5)}  `
          + `${f(t.clockPpm, 0, true).padStart(9)}  ${f(result.timeline.correlation, 2)}  ${f(s.levelRms, 2).padStart(8)} / ${f(s.levelWorst, 1).padEnd(6)}  ${f(s.levelR, 3)}  `
          + `${(f(s.bandWorst, 1, true) + ' dB at ' + s.bandWorstHz).padEnd(23)}  ${(f(s.clipTake, 1) + ' / ' + f(s.clipSim, 1)).padEnd(15)}  ${f(s.anchorDb, 1, true)} dB`
          + `${job.random ? '  (random loss: statistics only)' : ''}`);
      } catch (error) {
        console.log(`failed: ${error.message.split('\n')[0]}`);
        results.push({ name: job.name, set: job.set, error: error.message });
      }
    }
  } finally {
    await app.close();
  }
  if (opt.json) {
    fs.writeFileSync(opt.json, JSON.stringify({ generated: new Date().toISOString(), results }, null, 1));
    console.log(`\nWrote ${opt.json}`);
  }
  if (results.some(r => r.error)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
