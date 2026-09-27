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
 * Usage: node tests/accuracy.mjs --takes <folder> [--only name,name] [--json out.json]
 *   The folder (or TF2_TAKES) holds the takes and the non-generated sources
 *   under the names in the manifest; an 8-hex-digit upload prefix
 *   ("1a2b3c4d-") and punctuation are ignored when matching. Generate the
 *   test signals first (tests/testsignal/README.md).
 *   CHROMIUM_EXECUTABLE picks a preinstalled Chromium, as in browser.verify.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createStaticServer } = require('./static-server.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function args() {
  const out = { takes: process.env.TF2_TAKES || '', only: null, json: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--takes') out.takes = argv[++i];
    else if (argv[i] === '--only') out.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--json') out.json = argv[++i];
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

async function main() {
  const opt = args();
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

  const server = await createStaticServer(root);
  const base = `http://127.0.0.1:${server.address().port}`;
  const launchOptions = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE;
  let browser;
  try { browser = await chromium.launch(launchOptions); }
  catch (error) {
    if (!String(error.message).includes('Executable doesn\'t exist')) throw error;
    browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
  }
  const results = [];
  try {
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
    await browser.close();
    server.close();
  }
  if (opt.json) {
    fs.writeFileSync(opt.json, JSON.stringify({ generated: new Date().toISOString(), results }, null, 1));
    console.log(`\nWrote ${opt.json}`);
  }
  if (results.some(r => r.error)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
