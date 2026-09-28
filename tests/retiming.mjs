/* Talk-spurt re-timing (REFERENCE_2026.md, finding 21): TF2's receiver
 * against a queue model, from the accuracy suite's results.
 *
 * The queue model: the receiver holds l seconds of voice ahead of playback.
 * A spurt that starts on an empty queue waits the restart latency L0. After
 * each spurt the sender sends a 62.5 ms silence record (demo.js shows it
 * after every end of transmission). If the next spurt's first packet
 * arrives g seconds after the previous one ended and l + 62.5 ms > g, the
 * spurt is appended: it starts g - 62.5 ms early and the queue shrinks by
 * as much. Otherwise the queue has drained and the spurt restarts at L0.
 *
 *   node tests/retiming.mjs --accuracy results.json [--demo voicetest.dem] [--jitter 0.03]
 *
 * results.json is `pnpm accuracy --takes <folder> --json results.json`.
 * With the Set D SourceTV demo, the Set D takes are checked transition by
 * transition against the packets' arrival at the server. Every take is then
 * predicted transition by transition from its own earlier transitions only
 * (the model learns the session's L0), against the app's current rule (a
 * 41% chance after a silence of at most 0.45 s, `voice_retime`).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../demo.js');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const accuracyFile = arg('--accuracy'), demoFile = arg('--demo'), J = Number(arg('--jitter', .03));
if (!accuracyFile) { console.log('node tests/retiming.mjs --accuracy results.json [--demo voicetest.dem] [--jitter 0.03]'); process.exit(1); }
const accuracy = JSON.parse(fs.readFileSync(accuracyFile, 'utf8'));

const SILENCE = .0625;   // the silence record after each end of transmission (1500 samples at 24 kHz)
const EARLY = -80, LATE = 80;
const kindOf = (ms) => (ms <= EARLY ? 'early' : ms >= LATE ? 'late' : 'kept');
const mark = { early: 'E', late: 'L', kept: '.' };

// Every transition from one gate-model spurt to the next: the silence
// between them in the gate model and the change in delay across it.
const transitions = [];
for (const r of accuracy.results) {
  if (!r.timeline || !r.gateSpurts || r.random) continue;
  const segs = r.timeline.segments, gs = r.gateSpurts;
  for (let k = 1; k < gs.length; k++) {
    const prev = segs.filter(s => s.spurt === k - 1), next = segs.filter(s => s.spurt === k);
    if (!prev.length || !next.length) continue;
    const change = next[0].delayMs - prev[prev.length - 1].delayMs;
    transitions.push({ take: r.name, set: r.set, k, gap: gs[k].start - gs[k - 1].end, change, kind: kindOf(change) });
  }
}
for (const t of transitions) { const p = transitions.find(x => x.take === t.take && x.k === t.k - 1); t.afterEarly = !!(p && p.kind === 'early'); }
console.log('\nTransitions (gate-model silence in ms : delay change in ms, E early, L late)');
for (const take of [...new Set(transitions.map(t => t.take))]) {
  console.log(`  ${take.padEnd(26)} ${transitions.filter(t => t.take === take).map(t => `${Math.round(t.gap * 1000)}:${Math.round(t.change)}${mark[t.kind]}`).join(' ')}`);
}

// Set D: the arrival gap of each of Steam's own spurts at the server.
if (demoFile) {
  const parsed = D.parse(fs.readFileSync(demoFile));
  const tick = parsed.intervalPerTick, spurts = [];
  let cur = null;
  for (const p of parsed.speakers[0].packets) {
    if (p.kind === 'end') { if (cur) spurts.push(cur); cur = null; continue; }
    if (p.kind !== 'opus') continue;
    if (!cur) cur = { t0: p.tick * tick, frames: 0 };
    cur.frames++;
  }
  if (cur) spurts.push(cur);
  // Server time minus test-signal time: the offset that puts the most of
  // Steam's spurt starts within 0.1 s of a gate-model spurt start.
  const takes = accuracy.results.filter(r => r.set === 'D' && r.timeline);
  const starts = takes[0].gateSpurts.map(g => g.start);
  const score = (o) => spurts.filter(sp => starts.some(st => Math.abs(sp.t0 - o - st) < .1)).length;
  const offset = spurts.flatMap(sp => starts.map(st => sp.t0 - st)).reduce((best, o) => (score(o) > score(best) ? o : best));
  const rows = spurts.slice(1).map((b, i) => {
    const a = spurts[i], dur = a.frames * .02;
    return { k: i + 1, gap: b.t0 - a.t0 - dur, start: b.t0 - offset, end: a.t0 - offset + dur };
  });
  const simulate = (L0) => {
    let l = L0;
    return rows.map(r => { const next = l + SILENCE - r.gap > 0 ? l + SILENCE - r.gap : L0; const c = (next - l) * 1000; l = next; return c; });
  };
  console.log(`\nSet D: ${spurts.length} Steam spurts; arrival gaps from the demo (${Math.round(tick * 4000)} ms resolution: SourceTV writes voice every 4 ticks)`);
  for (const take of takes) {
    const delayAt = (t) => (take.timeline.segments.find(x => t >= x.start && t < x.end) || take.timeline.segments[take.timeline.segments.length - 1]).delayMs;
    const observed = rows.map(r => delayAt(r.start + .05) - delayAt(r.end - .05));
    // Spurts whose packets overlap (gap under 0.1 s) are one spurt in the gate
    // model: their change is not observable, but they still move the queue.
    const fits = [];
    for (let L0 = .1; L0 <= .8 + 1e-9; L0 += .005) {
      const p = simulate(L0);
      if (rows.every((r, i) => r.gap < .1 || kindOf(p[i]) === kindOf(observed[i]))) fits.push(Math.round(L0 * 1000));
    }
    const L0 = fits.length ? fits[Math.floor(fits.length / 2)] / 1000 : null, pred = L0 !== null ? simulate(L0) : null;
    const largest = Math.max(...observed.map(Math.abs));
    console.log(`  ${take.name}: ${fits.length ? `every observable transition reproduced for L0 ${fits[0]}-${fits[fits.length - 1]} ms` : 'no single L0 reproduces every transition'}; largest change ${Math.round(largest)} ms`);
    console.log(`    ${rows.map((r, i) => `${Math.round(r.gap * 1000)}:${Math.round(observed[i])}${r.gap < .1 ? '(merged)' : mark[kindOf(observed[i])]}${pred ? `/${Math.round(pred[i])}` : ''}`).join(' ')}`);
  }
}

// Prequential comparison: each transition predicted from the take's earlier ones.
const B = .03, FLOOR = .02;   // gate-model silences run ~30 ms longer than Steam's arrival gaps (Set D)
const L0s = Array.from({ length: 61 }, (_, i) => .25 + i * .005);
let totalM = 0, totalR = 0, n = 0;
console.log(`\nPrequential log-likelihood (queue model with arrival jitter ±${J * 1000} ms, against the current rule)`);
for (const take of [...new Set(transitions.map(t => t.take))]) {
  const rows = transitions.filter(t => t.take === take);
  let w = L0s.map(() => 1 / L0s.length), l = L0s.slice(), M = 0, R = 0;
  for (const r of rows) {
    const g = r.gap - B, early = r.kind === 'early';
    const p = l.map(x => Math.min(1, Math.max(0, (x + SILENCE - (g - J)) / (2 * J))));
    const pM = Math.min(1 - FLOOR, Math.max(FLOOR, p.reduce((s, x, i) => s + w[i] * x, 0)));
    const pR = Math.min(1 - FLOOR, Math.max(FLOOR, r.gap <= .45 && !r.afterEarly ? .41 : 0));
    M += Math.log(early ? pM : 1 - pM); R += Math.log(early ? pR : 1 - pR);
    w = w.map((x, i) => x * Math.max(FLOOR, early ? p[i] : 1 - p[i]));
    const sum = w.reduce((a, b) => a + b, 0); w = w.map(x => x / sum);
    l = l.map((x, i) => (early ? Math.max(0, x + r.change / 1000) : r.kind === 'late' ? L0s[i] : x));
  }
  const learnt = L0s.reduce((s, x, i) => s + w[i] * x, 0);
  console.log(`  ${take.padEnd(26)} ${String(rows.length).padStart(2)} transitions: queue ${M.toFixed(1).padStart(6)}, rule ${R.toFixed(1).padStart(6)}; L0 learnt ${Math.round(learnt * 1000)} ms`);
  totalM += M; totalR += R; n += rows.length;
}
console.log(`  all ${n}: queue ${(totalM / n).toFixed(3)} per transition, rule ${(totalR / n).toFixed(3)}`);
