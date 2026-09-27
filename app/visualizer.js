/* TF2 Voice Emulator, app/visualizer.js: The visualizer: WAVE, BARS and SPEC, lanes, zoom and selection.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

/* ------------------------------------------------------------------ */
/* Visualizer                                                         */
/*                                                                    */
/* WAVE: peak + RMS envelope of the audible version; the samples      */
/*       themselves once zoomed in far enough.                        */
/* BARS: log-frequency spectrum in dBFS. Live from the AnalyserNode   */
/*       while playing; computed from the rendered buffer at the      */
/*       playhead when paused, with the analyser's own window/scale.  */
/* SPEC: spectrogram, linear or log frequency. The visible band is    */
/*       analysed in up to three tiers, each from a signal decimated  */
/*       to suit its top frequency. The FFT size follows the zoom so  */
/*       one window spans about as many pixels in time as one bin in  */
/*       frequency (like iZotope RX's auto-adjust), or is set by hand.*/
/*                                                                    */
/* Under WAVE and SPEC: an optional loudness lane (momentary and      */
/* short-term LUFS, wet and dry), the codec lane (what the voice path */
/* did with each 20 ms frame) and the time ruler.                     */
/*                                                                    */
/* Time: Ctrl/⌘ + wheel or a pinch zooms, a drag or Shift + wheel     */
/* pans, a click seeks, the − + FIT buttons and + − 0 ← → keys too.   */
/* Frequency (SPEC): the wheel over the left ruler, Alt or            */
/* Ctrl/⌘ + Shift + wheel over the view, ↑ ↓ keys; drag the ruler to  */
/* pan, double-click it to reset. Shift + drag selects a range for    */
/* the meter and the loop; Z zooms to it, Esc clears it, L loops.     */
/* ------------------------------------------------------------------ */

const ctx = els.canvas.getContext('2d', { alpha: false });
const VIZ = {
  minHz: 20, maxHz: 20000,   // BARS log-frequency axis
  minDb: -100, maxDb: -10,   // AnalyserNode dB scale (full-scale sine ~ -13.6)
  fftSize: 8192,             // BARS: 5.4-5.9 Hz bins, 170-186 ms window
  ranges: [48, 72, 96, 120], // selectable displayed dynamic range (SPEC, WAVE in dB)
  bandEdgeHz: 12000,         // Opus super-wideband edge used by the Steam profile
  logMinHz: 20,              // floor of the log spectrogram
  minFreqSpanHz: 40,         // deepest frequency zoom, linear axis
  minFreqRatio: 1.3,         // deepest frequency zoom, log axis (top / bottom)
  fftMin: 64, fftMax: 16384, // FFT sizes, in samples of the analysed (decimated) signal
  maxWindowSec: 1.4,         // longest AUTO analysis window
  maxDecimation: 64,
  maxColumns: 1600,          // spectrogram columns per image (stretched to the canvas)
  minSpanSamples: 48,        // deepest time zoom: this many samples across the view
  rulerH: 16, laneH: 12,     // px: time ruler and codec lane under WAVE / SPEC
  lufsFrac: 0.26, lufsMinH: 48, lufsTop: 0, lufsFloor: -48,
  freqRulerW: 36,            // px: the SPEC frequency ruler along the left edge
  tallHeight: 520            // px, the TALL view
};
els.vizContainer = document.getElementById('viz-container');
els.vizLog = document.getElementById('viz-log');
els.vizZoomIn = document.getElementById('viz-zoom-in');
els.vizZoomOut = document.getElementById('viz-zoom-out');
els.vizFit = document.getElementById('viz-fit');
els.vizTall = document.getElementById('viz-tall');
els.vizRange = document.getElementById('viz-range');
els.vizRes = document.getElementById('viz-res');
els.vizLufs = document.getElementById('viz-lufs');
els.vizLoop = document.getElementById('viz-loop');
els.vizLegend = document.getElementById('viz-legend');
els.vizAvg = document.getElementById('viz-avg');
state.vizScale = LS.get('tf2ve_viz_scale', 'lin') === 'log' ? 'log' : 'lin';
state.waveScale = LS.get('tf2ve_wave_scale', 'lin') === 'db' ? 'db' : 'lin';
state.vizRange = VIZ.ranges.includes(Number(LS.get('tf2ve_viz_range', 72))) ? Number(LS.get('tf2ve_viz_range', 72)) : 72;
state.specRes = (() => { const v = LS.get('tf2ve_spec_res', 'auto'); return v === 'auto' || [256, 512, 1024, 2048, 4096, 8192, 16384].includes(Number(v)) ? v : 'auto'; })();
state.showLufs = LS.get('tf2ve_lufs_lane', false) === true;
state.loop = false;
let vizPeaks = null, vizPeakTime = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  // Only touch the backing store when the size really changed: assigning
  // canvas.width clears it.
  if (els.canvas.width !== W || els.canvas.height !== H) {
    els.canvas.width = W;
    els.canvas.height = H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { w: rect.width, h: rect.height, dpr };
}

// Inferno-like palette for the spectrogram, 256 entries.
const PALETTE = (() => {
  const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  return lut;
})();

const dbToUnit = (value) => Math.min(1, Math.max(0, (value - VIZ.minDb) / (VIZ.maxDb - VIZ.minDb)));
const hzToX = (hz, w, top) => w * Math.log(hz / VIZ.minHz) / Math.log(top / VIZ.minHz);

// Log-spaced [fromBin, toBin] ranges for `count` bars/rows.
function logBands(count, sampleRate, fftSize) {
  const top = Math.min(VIZ.maxHz, sampleRate / 2), binHz = sampleRate / fftSize, bands = [];
  for (let i = 0; i < count; i++) {
    const lo = VIZ.minHz * Math.pow(top / VIZ.minHz, i / count);
    const hi = VIZ.minHz * Math.pow(top / VIZ.minHz, (i + 1) / count);
    bands.push([lo / binHz, hi / binHz]);
  }
  return bands;
}

// Max over each band; narrow low bands interpolate between bins.
function bandLevels(spectrumDb, bands, out) {
  const last = spectrumDb.length - 1;
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i];
    let value = -Infinity;
    if (hi - lo < 1) {
      const pos = Math.min(last, (lo + hi) / 2), k = Math.floor(pos), f = pos - k;
      value = spectrumDb[k] * (1 - f) + spectrumDb[Math.min(last, k + 1)] * f;
    } else {
      for (let k = Math.ceil(lo); k <= Math.min(last, Math.floor(hi)); k++) value = Math.max(value, spectrumDb[k]);
    }
    out[i] = Number.isFinite(value) ? value : VIZ.minDb;
  }
  return out;
}

const blackman = (() => {
  const cache = new Map();
  return (n) => {
    if (!cache.has(n)) cache.set(n, Float32Array.from({ length: n },
      (_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n)));
    return cache.get(n);
  };
})();

// Radix-2 FFT plans: bit-reversal and twiddle tables and work buffers,
// made once per size.
const fftPlans = new Map();
function fftPlan(n) {
  let plan = fftPlans.get(n);
  if (!plan) {
    const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | (i & 1 ? n >> 1 : 0);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    plan = { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n), win: blackman(n) };
    fftPlans.set(n, plan);
  }
  return plan;
}

// Blackman-windowed FFT of `samples` centred on `center` (zero outside);
// leaves the spectrum in plan.re / plan.im.
function windowedFft(plan, samples, center) {
  const { n, rev, cos, sin, re, im, win } = plan;
  const start = Math.round(center - n / 2);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    re[rev[i]] = (j >= 0 && j < samples.length ? samples[j] : 0) * win[i];
  }
  im.fill(0);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0, t = 0; k < half; k++, t += stride) {
        const a = i + k, b = a + half, wr = cos[t], wi = sin[t];
        const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
      }
    }
  }
}

// Same windowing and scaling as AnalyserNode.getFloatFrequencyData.
function spectrumAt(samples, center, fftSize, out) {
  const plan = fftPlan(fftSize);
  windowedFft(plan, samples, center);
  for (let k = 0; k < fftSize / 2; k++) out[k] = 20 * Math.log10(Math.hypot(plan.re[k], plan.im[k]) / fftSize + 1e-12);
  return out;
}

// The version the listener hears: processed (wet) or original (dry).
function audibleBuffer() {
  if (state.abMode === 'real' && state.realTake) return { samples: state.realTake.samples, rate: state.realTake.rate, label: 'REAL' };
  if (state.abMode === 'dry' && state.decodedSource) {
    return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'DRY' };
  }
  if (state.processedBuffer) return { samples: state.processedBuffer, rate: state.processedRate, label: 'WET' };
  if (state.decodedSource) return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'SOURCE' };
  return null;
}

// A stable id per sample array, so cached images never outlive their audio.
const bufferIds = new WeakMap();
let nextBufferId = 1;
function bufferId(samples) {
  if (!bufferIds.has(samples)) bufferIds.set(samples, nextBufferId++);
  return bufferIds.get(samples);
}

function playheadFraction() {
  const d = els.audio.duration;
  return Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, els.audio.currentTime / d)) : 0;
}

/* ---------------- time view (zoom and pan) and selection ---------------- */

// Visible time range in seconds; t1 = Infinity runs to the end of the file.
const vizView = { t0: 0, t1: Infinity };
let vizSel = null;   // selected time range { t0, t1 } in seconds, or null
function resetVizView() {
  vizView.t0 = 0;
  vizView.t1 = Infinity;
  resetFreqView();
  setSelection(null);
}

function visibleRange(buffer) {
  const duration = Math.max(buffer.samples.length / buffer.rate, 1e-6);
  const minSpan = Math.min(duration, VIZ.minSpanSamples / buffer.rate);
  const end = Number.isFinite(vizView.t1) ? vizView.t1 : duration;
  const span = Math.min(duration, Math.max(minSpan, end - vizView.t0));
  const t0 = Math.min(Math.max(0, vizView.t0), duration - span);
  return { t0, t1: t0 + span, duration, minSpan, zoomed: span < duration * (1 - 1e-9) };
}

function setVizView(start, span, duration) {
  const t0 = Math.min(Math.max(0, start), Math.max(0, duration - span));
  vizView.t0 = t0;
  vizView.t1 = t0 + span >= duration * (1 - 1e-9) ? Infinity : t0 + span;
  refreshVisualizer();
}

// Zoom by `factor` (< 1 zooms in) keeping the time at `anchor` (0..1 across the view) in place.
function zoomViz(factor, anchor = null) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode === 'bars') return;
  const r = visibleRange(buffer), span = r.t1 - r.t0;
  if (anchor === null) {
    // Buttons and keys zoom around the playhead when it is in view.
    const t = els.audio.currentTime;
    anchor = els.audio.src && t >= r.t0 && t <= r.t1 ? (t - r.t0) / span : 0.5;
  }
  const next = Math.min(r.duration, Math.max(r.minSpan, span * factor));
  setVizView(r.t0 + anchor * span - anchor * next, next, r.duration);
}

function panViz(fraction) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode === 'bars') return;
  const r = visibleRange(buffer);
  setVizView(r.t0 + fraction * (r.t1 - r.t0), r.t1 - r.t0, r.duration);
}

let selectionTimer = 0;
function setSelection(range) {
  const next = range && range.t1 - range.t0 > 1e-4 ? { t0: Math.max(0, range.t0), t1: range.t1 } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(vizSel);
  vizSel = next;
  if (!changed) return;
  applyLoop();
  // The meter follows the selection once it settles.
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => { if (typeof updateMeter === 'function') updateMeter(); }, 150);
}

function zoomToSelection() {
  const buffer = audibleBuffer();
  if (!buffer || !vizSel || state.vizMode === 'bars') return;
  const r = visibleRange(buffer), span = vizSel.t1 - vizSel.t0;
  // A little room either side, as editors do.
  setVizView(vizSel.t0 - span * 0.05, Math.max(r.minSpan, span * 1.1), r.duration);
}

/* ---------------- frequency view (SPEC) ---------------- */

// Visible band in Hz; null ends run to the full band.
const vizFreq = { lo: null, hi: null };
function specTop(rate) { return Math.min(VIZ.maxHz, rate / 2); }

function freqRange(rate, scale = state.vizScale) {
  const top = specTop(rate), floor = scale === 'log' ? VIZ.logMinHz : 0;
  let lo = Math.max(floor, Math.min(vizFreq.lo ?? floor, top));
  let hi = Math.min(top, Math.max(vizFreq.hi ?? top, lo));
  if (scale === 'log') {
    if (hi / lo < VIZ.minFreqRatio) { hi = Math.min(top, lo * VIZ.minFreqRatio); lo = hi / VIZ.minFreqRatio; }
  } else if (hi - lo < VIZ.minFreqSpanHz) {
    hi = Math.min(top, lo + VIZ.minFreqSpanHz); lo = Math.max(floor, hi - VIZ.minFreqSpanHz);
  }
  return { lo, hi, top, floor, scale, zoomed: lo > floor * 1.0001 + 1e-6 || hi < top * 0.9999 };
}
// The axis is linear in Hz or in log Hz; d() maps a frequency onto it.
const freqDomain = (scale) => (scale === 'log' ? Math.log : (f) => f);
const freqUndomain = (scale) => (scale === 'log' ? Math.exp : (d) => d);

// Frequency at height fraction u (0 = bottom, 1 = top) of the visible band.
function specHz(u, rate, scale = state.vizScale) {
  const r = freqRange(rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  return inv(d(r.lo) + u * (d(r.hi) - d(r.lo)));
}
function hzToU(hz, rate, scale = state.vizScale) {
  const r = freqRange(rate, scale), d = freqDomain(scale);
  return (d(Math.max(hz, 1e-9)) - d(r.lo)) / (d(r.hi) - d(r.lo));
}

function setFreqView(lo, hi, rate) {
  const full = freqRange(rate, state.vizScale);
  const floor = full.floor, top = full.top;
  if (lo <= floor * 1.0001 + 1e-6 && hi >= top * 0.9999) { vizFreq.lo = null; vizFreq.hi = null; }
  else { vizFreq.lo = Math.max(floor, lo); vizFreq.hi = Math.min(top, hi); }
  refreshVisualizer();
}

// Zoom the frequency axis by `factor` (< 1 zooms in) around height fraction `anchor`.
function zoomFreq(factor, anchor = 0.5) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode !== 'spec') return;
  const scale = state.vizScale, r = freqRange(buffer.rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  const d0 = d(r.lo), d1 = d(r.hi), dFloor = d(r.floor), dTop = d(r.top);
  const minSpan = scale === 'log' ? Math.log(VIZ.minFreqRatio) : VIZ.minFreqSpanHz;
  const span = Math.min(dTop - dFloor, Math.max(minSpan, (d1 - d0) * factor));
  const at = d0 + anchor * (d1 - d0);
  const start = Math.min(Math.max(dFloor, at - anchor * span), dTop - span);
  setFreqView(inv(start), inv(start + span), buffer.rate);
}

function panFreq(fraction) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode !== 'spec') return;
  const scale = state.vizScale, r = freqRange(buffer.rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  const d0 = d(r.lo), d1 = d(r.hi), span = d1 - d0, dFloor = d(r.floor), dTop = d(r.top);
  const start = Math.min(Math.max(dFloor, d0 + fraction * span), dTop - span);
  setFreqView(inv(start), inv(start + span), buffer.rate);
}

function resetFreqView() { vizFreq.lo = null; vizFreq.hi = null; }

/* ---------------- layout ---------------- */

// The per-frame log of the last render, if its codec ran.
function codecFrames() {
  const info = state.lastCodecInfo;
  return info && info.frameLog && state.processedBuffer ? info : null;
}

// WAVE and SPEC: the image on top, then the loudness lane (if on), the
// codec lane (after a render with the codec) and the time ruler.
function vizLayout(w, h) {
  const time = state.vizMode !== 'bars';
  const rulerH = time ? VIZ.rulerH : 0;
  const laneH = time && codecFrames() ? VIZ.laneH : 0;
  let lufsH = time && state.showLufs ? Math.max(VIZ.lufsMinH, Math.round(h * VIZ.lufsFrac)) : 0;
  if (h - rulerH - laneH - lufsH < 40) lufsH = 0;
  const mainH = Math.max(20, h - rulerH - laneH - lufsH);
  return { w, h, mainH, lufsY: mainH, lufsH, laneY: mainH + lufsH, laneH, rulerY: mainH + lufsH + laneH, rulerH };
}

function regionAt(layout, y) {
  if (y < layout.mainH) return 'main';
  if (y < layout.laneY) return 'lufs';
  if (y < layout.rulerY) return 'lane';
  return 'ruler';
}

/* ---------------- drawing helpers ---------------- */

function drawBackdrop(w, h, y = 0) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, y, w, h);
}

function drawLabel(text, x, y, color = 'rgba(200, 210, 220, 0.75)', align = 'left') {
  ctx.font = '9px Verdana, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// A label on a dark plate, kept inside the canvas.
function drawTag(text, x, y, w, color = 'rgba(230, 238, 245, 0.95)') {
  ctx.font = '10px Verdana, sans-serif';
  const width = ctx.measureText(text).width + 8;
  const left = Math.max(0, Math.min(w - width, x));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)'; ctx.fillRect(left, y, width, 14);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = color;
  ctx.fillText(text, left + 4, y + 2);
}

// A small label on a translucent plate, for text over the images.
function drawPlate(text, x, y) {
  ctx.font = '9px Verdana, sans-serif';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'; ctx.fillRect(x - 2, y - 1, ctx.measureText(text).width + 6, 12);
  drawLabel(text, x + 1, y + 1, 'rgba(210, 220, 230, 0.9)');
}

function formatTime(t, decimals = 0) {
  const minutes = Math.floor(t / 60), seconds = t - minutes * 60;
  return `${minutes}:${seconds.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`;
}
const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${hz.toFixed(hz < 100 ? 1 : 0)} Hz`);
// Nearest equal-tempered note (A4 = 440 Hz) and its offset in cents.
function noteName(hz) {
  if (!(hz >= 16 && hz <= 20000)) return '';
  const n = Math.round(12 * Math.log2(hz / 440)), cents = Math.round(1200 * Math.log2(hz / 440) - 100 * n);
  const names = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
  const name = names[((n % 12) + 12) % 12], octave = 4 + Math.floor((n + 9) / 12);
  return `${name}${octave}${cents ? ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢` : ''}`;
}

function drawFrequencyGrid(w, h, top, labels) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 1;
  for (const hz of [100, 1000, 10000]) {
    if (hz >= top) continue;
    const x = Math.round(hzToX(hz, w, top)) + 0.5;
    if (labels) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(x + 1, h - 12, 22, 11);
      drawLabel(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 11);
    } else { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  }
  if (VIZ.bandEdgeHz < top) {
    const x = Math.round(hzToX(VIZ.bandEdgeHz, w, top)) + 0.5;
    if (labels) drawLabel('12k', x + 3, 16, 'rgba(255, 184, 34, 0.85)');
    else {
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255, 184, 34, 0.35)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.restore();
    }
  }
}

function drawBars(levels, w, h, top, now) {
  drawBackdrop(w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(h * (1 - dbToUnit(dbLine))) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  drawFrequencyGrid(w, h, top, false);
  const count = levels.length, slot = w / count, barW = Math.max(1, slot - 1);
  if (!vizPeaks || vizPeaks.length !== count) vizPeaks = new Float32Array(count);
  const dt = vizPeakTime ? Math.min(0.1, (now - vizPeakTime) / 1000) : 0;
  vizPeakTime = now;
  for (let i = 0; i < count; i++) {
    const u = dbToUnit(levels[i]);
    vizPeaks[i] = Math.max(u, vizPeaks[i] - dt * 0.5);       // caps fall 50%/s
    const barH = u * h;
    ctx.fillStyle = `hsl(${Math.round(205 - 205 * Math.min(1, u * 1.15))}, 85%, ${40 + 20 * u}%)`;
    ctx.fillRect(i * slot, h - barH, barW, barH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(i * slot, Math.round(h - vizPeaks[i] * h) - 1, barW, 1.5);
  }
  drawFrequencyGrid(w, h, top, true);
}

function drawPlayhead(w, h, range) {
  if (!els.audio.src) return;
  const t = els.audio.currentTime;
  if (t < range.t0 || t > range.t1) return;
  const x = Math.round((t - range.t0) / (range.t1 - range.t0) * w) + 0.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

// The time ruler: its own strip under the lanes, ticks at least ~70 px apart.
function drawTimeRuler(w, y, hR, range) {
  ctx.fillStyle = '#0b0e12'; ctx.fillRect(0, y, w, hR);
  const span = range.t1 - range.t0;
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s / span * w >= 70) || 600;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
  for (let k = Math.ceil(range.t0 / step - 1e-9); k * step <= range.t1 + 1e-9; k++) {
    const x = Math.round((k * step - range.t0) / span * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 4); ctx.stroke();
    if (x + 44 < w) drawLabel(formatTime(k * step, decimals), x + 3, y + 4, 'rgba(210, 220, 230, 0.85)');
  }
}

// "Nice" frequency ticks for the visible band, at least `minGap` px apart:
// on the log axis the densest of 1-2-...-9, 1-2-5 and 1 per decade that
// fits (a linear series on a very deep zoom), on the linear axis a 1-2-5
// step.
function freqTicks(r, height, minGap = 22) {
  const d = freqDomain(r.scale), span = d(r.hi) - d(r.lo);
  const px = (hz) => (d(hz) - d(r.lo)) / span * height;
  let out = [];
  if (r.scale === 'log') {
    const series = (mantissas) => {
      const list = [];
      for (let e = Math.floor(Math.log10(Math.max(r.lo, 1))); e <= Math.ceil(Math.log10(r.hi)); e++) {
        for (const m of mantissas) { const hz = m * 10 ** e; if (hz >= r.lo && hz <= r.hi) list.push(hz); }
      }
      return list;
    };
    const spaced = (list) => list.every((hz, i) => !i || px(hz) - px(list[i - 1]) >= minGap);
    out = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 5], [1]].map(series).find(spaced) || series([1]);
    if (out.length < 3) return freqTicks({ ...r, scale: 'lin' }, height, minGap);
  } else {
    const target = Math.max(2, height / (minGap * 1.8));
    const raw = (r.hi - r.lo) / target, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || 10 * p;
    for (let hz = Math.ceil(r.lo / step) * step; hz <= r.hi + 1e-9; hz += step) out.push(+hz.toFixed(6));
  }
  // Thin to the minimum spacing, keeping the band edge when it is in view.
  const kept = [];
  for (const hz of out) if (!kept.length || Math.abs(px(hz) - px(kept[kept.length - 1])) >= minGap) kept.push(hz);
  if (VIZ.bandEdgeHz > r.lo && VIZ.bandEdgeHz < r.hi && !kept.includes(VIZ.bandEdgeHz)) kept.push(VIZ.bandEdgeHz);
  return kept;
}
const tickLabel = (hz) => (hz >= 1000 ? `${+(hz / 1000).toFixed(hz % 1000 ? 2 : 0)}k` : `${+hz.toFixed(hz < 10 ? 1 : 0)}`);

// The frequency ruler on the left of SPEC: interactive (wheel zooms, drag pans).
function drawFrequencyAxisLabels(w, h, rate) {
  const r = freqRange(rate);
  ctx.fillStyle = r.zoomed ? 'rgba(102, 192, 244, 0.10)' : 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, VIZ.freqRulerW - 8, h);
  for (const hz of freqTicks(r, h)) {
    const y = h - h * hzToU(hz, rate);
    if (y < 1 || y > h - 1) continue;
    const edge = hz === VIZ.bandEdgeHz;
    ctx.strokeStyle = edge ? 'rgba(255, 184, 34, 0.45)' : 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath(); ctx.moveTo(VIZ.freqRulerW - 12, Math.round(y) + 0.5); ctx.lineTo(VIZ.freqRulerW - 4, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(1, Math.max(0, y - 10), VIZ.freqRulerW - 12, 10);
    drawLabel(tickLabel(hz), 3, Math.max(0, y - 10), edge ? 'rgba(255, 184, 34, 0.95)' : 'rgba(220, 230, 240, 0.9)');
  }
}

/* ---------------- static images of the visible range ---------------- */

// The last WAVE or SPEC image: { base, key, canvas, t0, t1, ... }. `base`
// names what it shows apart from the time and frequency range; while a new
// range is computed, the last image with the same base is drawn stretched
// to it.
let vizImage = null;
let vizPending = null, specJob = 0, specTimer = 0;
const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

function imageBase(buffer) {
  const scale = state.vizMode === 'spec' ? state.vizScale : state.waveScale === 'db' ? `db${state.vizRange}` : 'lin';
  return `${state.vizMode}:${scale}:${bufferId(buffer.samples)}:${buffer.rate}`;
}

// Height fraction (0..1 from the centre line) of a sample value on the
// waveform: linear, or dBFS down to the selected range.
function waveMapper() {
  if (state.waveScale !== 'db') return (v) => v;
  const floor = -state.vizRange;
  return (v) => {
    const a = Math.abs(v);
    if (a <= 0) return 0;
    const u = Math.max(0, 1 - (20 * Math.log10(a)) / floor);
    return v < 0 ? -u : u;
  };
}
// Amplitude grid levels in dBFS for the current waveform scale.
function waveGridDb() {
  return state.waveScale === 'db' ? [-6, -12, -24, -48, -72, -96].filter(d => d > -state.vizRange) : [-6];
}

function renderWaveImage(buffer, W, H, range) {
  const image = document.createElement('canvas');
  image.width = W; image.height = H;
  const g = image.getContext('2d', { alpha: false });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const mid = H / 2, map = waveMapper();
  g.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  g.beginPath();
  g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(W, Math.round(mid) + 0.5);
  for (const dbLevel of waveGridDb()) {
    const u = map(Math.pow(10, dbLevel / 20));
    for (const y of [mid - u * mid, mid + u * mid]) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); }
  }
  g.stroke();
  const data = buffer.samples, first = range.t0 * buffer.rate;
  const clip = 0.999;   // full scale: samples here clip when saved as 16-bit
  const perPixel = (range.t1 - range.t0) * buffer.rate / W;
  if (perPixel >= 2) {
    for (let x = 0; x < W; x++) {
      const from = Math.max(0, Math.floor(first + x * perPixel));
      const to = Math.min(data.length, Math.max(from + 1, Math.floor(first + (x + 1) * perPixel)));
      let min = 0, max = 0, sq = 0;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < min) min = v; if (v > max) max = v;
        sq += v * v;
      }
      const rmsValue = Math.sqrt(sq / Math.max(1, to - from));
      const top = map(max), bottom = map(min), r = map(rmsValue);
      g.fillStyle = '#2a5f86';
      g.fillRect(x, mid - top * mid, 1, Math.max(1, (top - bottom) * mid));
      g.fillStyle = '#66c0f4';
      g.fillRect(x, mid - r * mid, 1, Math.max(1, 2 * r * mid));
      if (max >= clip || min <= -clip) {
        g.fillStyle = '#ff4040';
        g.fillRect(x, 0, 1, 3); g.fillRect(x, H - 3, 1, 3);
      }
    }
  } else {
    // Zoomed in to single samples: the sample values joined by lines, and
    // dots once they are far enough apart.
    const i0 = Math.max(0, Math.floor(first) - 1), i1 = Math.min(data.length - 1, Math.ceil(first + W * perPixel) + 1);
    g.strokeStyle = '#66c0f4'; g.lineWidth = Math.max(1, Math.round(H / 180));
    g.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = (i - first) / perPixel, y = mid - map(data[i]) * mid;
      if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    if (perPixel < 0.15) {
      const r = Math.max(2, Math.round(H / 120));
      for (let i = i0; i <= i1; i++) {
        g.fillStyle = Math.abs(data[i]) >= clip ? '#ff4040' : '#d7efff';
        g.fillRect((i - first) / perPixel - r / 2, mid - map(data[i]) * mid - r / 2, r, r);
      }
    }
  }
  return { canvas: image, t0: range.t0, t1: range.t1 };
}

// The signal decimated by 2, 4, ... VIZ.maxDecimation for the lower bands of
// the spectrogram. Each level halves the one above with the renderer's
// Kaiser-windowed sinc (flat to 0.83 of the new Nyquist, 86 dB stopband),
// in slices so the page stays responsive. Sample i of the level for factor
// D is sample D * i of the input; the spectrogram reads each level only up
// to 0.4 of its rate.
const decimations = new WeakMap();
function decimated(samples, factor) {
  let levels = decimations.get(samples);
  if (!levels) decimations.set(samples, levels = new Map([[1, Promise.resolve(samples)]]));
  if (!levels.has(factor)) {
    const level = decimated(samples, factor / 2).then(halve);
    level.catch(() => levels.delete(factor));
    levels.set(factor, level);
  }
  return levels.get(factor);
}
async function halve(x) {
  const out = new Float32Array(Math.max(1, Math.round(x.length / 2)));
  // resampleSinc reads 32 inputs either side of each output.
  const margin = 64, block = 1 << 17;
  for (let s = 0; s < x.length; s += block) {
    const from = Math.max(0, s - margin), to = Math.min(x.length, s + block + margin);
    const part = TF2Audio.resampleSinc(x.subarray(from, to), 2, 1);
    const offset = (s - from) / 2, count = Math.min(block / 2, out.length - s / 2);
    out.set(part.subarray(offset, offset + count), s / 2);
    await yieldToUi();
  }
  return out;
}

// How the spectrogram analyses the visible band. The rows are split into
// tiers, each read from the signal decimated as far as its top frequency
// allows: one tier on the linear axis, one per octave-ish band on the log
// axis. The FFT size of a tier is fixed (RES) or, on AUTO, sized to the
// view: a Blackman window of T seconds smears about 0.4 T in time and
// 2.35 / T in frequency (its -6 dB widths), so T = 2.4 * sqrt(column
// seconds / row Hz) would blur as many pixels one way as the other. AUTO
// uses 3.4 instead of 2.4, blurring about twice as many pixels in time as
// in frequency: tones, harmonics and hum stay sharp and onsets soften a
// little. Zooming in time shortens the window; zooming in frequency, or
// going lower on the log axis, lengthens it.
function specPlan(rate, H, colSec) {
  const r = freqRange(rate), log = r.scale === 'log';
  const fixed = state.specRes === 'auto' ? 0 : Number(state.specRes);
  // A fixed size keeps at least VIZ.fftMin points after decimation.
  const maxD = fixed ? Math.max(1, Math.min(VIZ.maxDecimation, fixed / VIZ.fftMin)) : VIZ.maxDecimation;
  const decimationFor = (hz) => { let D = 1; while (D < maxD && hz <= 0.4 * rate / (D * 2)) D *= 2; return D; };
  const edges = Float64Array.from({ length: H + 1 }, (_, i) => specHz(i / H, rate));
  const tiers = new Map(), rowTier = new Uint8Array(H);
  const linearD = decimationFor(r.hi);
  for (let row = 0; row < H; row++) {
    const D = log ? decimationFor(edges[row + 1]) : linearD;
    if (!tiers.has(D)) tiers.set(D, { D, rows: [] });
    tiers.get(D).rows.push(row);
  }
  const list = [...tiers.values()].sort((a, b) => b.D - a.D);
  const perRow = (freqDomain(r.scale)(r.hi) - freqDomain(r.scale)(r.lo)) / H;
  list.forEach((tier, index) => {
    tier.rate = rate / tier.D;
    let N;
    if (fixed) N = fixed / tier.D;
    else {
      // Row height in Hz at the tier's centre (on the log axis df = f d(ln f)).
      const first = edges[tier.rows[0]], last = edges[tier.rows[tier.rows.length - 1] + 1];
      const rowHz = log ? Math.sqrt(first * last) * perRow : perRow;
      const T = Math.min(VIZ.maxWindowSec, 3.4 * Math.sqrt(colSec / rowHz));
      N = 2 ** Math.round(Math.log2(Math.max(1, T * tier.rate)));
    }
    tier.fft = Math.min(VIZ.fftMax, Math.max(VIZ.fftMin, N));
    tier.windowSec = tier.fft / tier.rate;
    tier.binHz = tier.rate / tier.fft;
    for (const row of tier.rows) rowTier[row] = index;
  });
  return { tiers: list, edges, rowTier, fixed };
}

// Spectrogram of the visible range, computed a few columns at a time. When a
// column spans more than half a window, up to four windows are max-held so
// short events are not missed. Levels are dB (a full-scale sine reads about
// -13.6, as in BARS) on the linear axis; on the log axis, where tiers differ
// in resolution, they are per Hz so noise stays continuous across them.
async function renderSpectrogram(job, buffer, W, H, range, fr, base, key) {
  const { samples, rate } = buffer;
  const log = fr.scale === 'log';
  const cols = Math.min(W, VIZ.maxColumns);
  const step = (range.t1 - range.t0) * rate / cols;
  const plan = specPlan(rate, H, step / rate);
  for (const tier of plan.tiers) {
    tier.data = await decimated(samples, tier.D);
    if (job !== specJob) return;
    tier.bands = tier.rows.map(row => [plan.edges[row] / tier.binHz, plan.edges[row + 1] / tier.binHz]);
    tier.plan = fftPlan(tier.fft);
    tier.spectrum = new Float32Array(tier.fft / 2);
    tier.level = new Float32Array(tier.rows.length);
    tier.norm = log ? -10 * Math.log10(tier.binHz) : 0;
    tier.hops = Math.max(1, Math.min(4, Math.round(step / tier.D / (tier.fft / 2))));
  }
  const grid = new Float32Array(cols * H);
  let yieldAt = performance.now() + 12;
  for (let x = 0; x < cols; x++) {
    const column = grid.subarray(x * H, (x + 1) * H);
    column.fill(-400);
    const start = range.t0 * rate + x * step;
    for (const tier of plan.tiers) {
      for (let hop = 0; hop < tier.hops; hop++) {
        windowedFft(tier.plan, tier.data, (start + (hop + 0.5) * step / tier.hops) / tier.D);
        const { re, im, n } = tier.plan;
        for (let k = 0; k < n / 2; k++) tier.spectrum[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (n * n) + 1e-24) + tier.norm;
        bandLevels(tier.spectrum, tier.bands, tier.level);
        for (let i = 0; i < tier.rows.length; i++) if (tier.level[i] > column[tier.rows[i]]) column[tier.rows[i]] = tier.level[i];
      }
    }
    if (performance.now() > yieldAt) {
      await yieldToUi();
      if (job !== specJob) return;
      yieldAt = performance.now() + 12;
    }
  }
  // Scale each image to its own loud end so band edges stay visible on
  // loud, clipped renders: the colours span the selected range below the
  // 99th-percentile level.
  const sorted = grid.filter((_, i) => i % 7 === 0).sort();
  const topDb = sorted[Math.floor(sorted.length * 0.99)] ?? VIZ.maxDb;
  const tiers = plan.tiers.map(({ D, fft, rate: tierRate, windowSec, binHz }) => ({ D, fft, rate: tierRate, windowSec, binHz }));
  vizImage = { base, key, canvas: document.createElement('canvas'), t0: range.t0, t1: range.t1, lo: fr.lo, hi: fr.hi, scale: fr.scale,
    grid, cols, rows: H, log, topDb, tiers, rowTier: plan.rowTier, fixed: plan.fixed };
  paintSpectrogram(vizImage);
  vizPending = null;
  refreshVisualizer();
}

// Colour a computed spectrogram grid for the selected range (cheap; redone
// when only the range changes).
function paintSpectrogram(image) {
  const { grid, cols, rows: H, topDb } = image, span = state.vizRange;
  image.canvas.width = cols; image.canvas.height = H;
  const g = image.canvas.getContext('2d');
  const pixels = g.createImageData(cols, H);
  for (let x = 0; x < cols; x++) {
    for (let r = 0; r < H; r++) {
      const u = Math.min(1, Math.max(0, (grid[x * H + r] - topDb + span) / span));
      const c = Math.round(u * 255) * 3, p = ((H - 1 - r) * cols + x) * 4;
      pixels.data[p] = PALETTE[c]; pixels.data[p + 1] = PALETTE[c + 1]; pixels.data[p + 2] = PALETTE[c + 2]; pixels.data[p + 3] = 255;
    }
  }
  g.putImageData(pixels, 0, 0);
  image.range = span;
}

// The analysis resolution of a spectrogram image, for the corner label.
function describeResolution(img) {
  if (!img || !img.tiers) return '';
  const ms = (s) => (s < 0.1 ? (s * 1000).toFixed(1) : (s * 1000).toFixed(0));
  const windows = img.tiers.map(t => t.windowSec);
  const lo = Math.min(...windows), hi = Math.max(...windows);
  const mode = img.fixed ? `FFT ${img.fixed}` : 'AUTO';
  if (img.tiers.length === 1) return `${mode} · ${ms(lo)} ms · ${formatHz(img.tiers[0].binHz)} bins`;
  return `${mode} · ${ms(lo)}–${ms(hi)} ms windows`;
}

// Colour scale at the right edge of the spectrogram.
function drawColorbar(w, h) {
  const img = vizImage;
  if (!img || !img.grid) return;
  const x = w - 12, top = 8, bottom = h - 8, height = bottom - top;
  if (height < 40) return;
  for (let y = 0; y < height; y++) {
    const c = Math.round((1 - y / height) * 255) * 3;
    ctx.fillStyle = `rgb(${PALETTE[c]}, ${PALETTE[c + 1]}, ${PALETTE[c + 2]})`;
    ctx.fillRect(x, top + y, 7, 1);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.strokeRect(x - 0.5, top - 0.5, 8, height + 1);
  const unit = img.log ? ' dB/Hz' : ' dB';
  for (const [value, y] of [[img.topDb, top], [img.topDb - img.range, bottom - 10]]) {
    const text = `${value.toFixed(0)}${y === top ? unit : ''}`;
    ctx.font = '9px Verdana, sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(x - tw - 7, y, tw + 5, 11);
    drawLabel(text, x - 4, y + 1, 'rgba(220, 230, 240, 0.85)', 'right');
  }
}

function requestSpectrogram(buffer, W, H, range, fr, base, key) {
  if (vizPending === key) return;
  vizPending = key;
  clearTimeout(specTimer);
  const job = ++specJob;
  // Right away when nothing comparable is on screen; otherwise once a zoom or
  // pan gesture settles, showing the stretched last image meanwhile.
  const delay = vizImage && vizImage.base === base ? 90 : 0;
  specTimer = setTimeout(() => {
    renderSpectrogram(job, buffer, W, H, range, fr, base, key).catch((error) => {
      if (job === specJob) { vizPending = null; logLine(`spectrogram failed: ${error.message}`, 'err'); }
    });
  }, delay);
}

// Draw the part of `img` that overlaps the view, stretched to it. SPEC images
// also map their frequency band onto the visible one.
function drawImageInView(img, range, fr, w, h) {
  const iw = img.canvas.width, ih = img.canvas.height, span = img.t1 - img.t0;
  const sx = (range.t0 - img.t0) / span * iw, sw = (range.t1 - range.t0) / span * iw;
  const x0 = Math.max(0, sx), x1 = Math.min(iw, sx + sw);
  if (x1 <= x0) return;
  let sy0 = 0, sy1 = ih, dy0 = 0, dy1 = h;
  if (fr && img.lo !== undefined) {
    const d = freqDomain(fr.scale), a0 = d(img.lo), a1 = d(img.hi), b0 = d(fr.lo), b1 = d(fr.hi);
    const top = Math.min(a1, b1), bottom = Math.max(a0, b0);
    if (top <= bottom) return;
    sy0 = (a1 - top) / (a1 - a0) * ih; sy1 = (a1 - bottom) / (a1 - a0) * ih;
    dy0 = (b1 - top) / (b1 - b0) * h; dy1 = (b1 - bottom) / (b1 - b0) * h;
  }
  ctx.drawImage(img.canvas, x0, sy0, x1 - x0, sy1 - sy0, (x0 - sx) / sw * w, dy0, (x1 - x0) / sw * w, dy1 - dy0);
}

// WAVE or SPEC for the visible range, in the top `h` pixels. Returns the range drawn.
function drawTimeView(buffer, w, h, dpr) {
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  const range = visibleRange(buffer);
  const spec = state.vizMode === 'spec';
  const fr = spec ? freqRange(buffer.rate) : null;
  const base = imageBase(buffer);
  const key = `${base}:${W}x${H}:${range.t0}:${range.t1}${spec ? `:${fr.lo}:${fr.hi}:${state.specRes}` : ''}`;
  if (vizImage && vizImage.key === key && vizImage.grid && vizImage.range !== state.vizRange) paintSpectrogram(vizImage);
  if (!vizImage || vizImage.key !== key) {
    if (spec) requestSpectrogram(buffer, W, H, range, fr, base, key);
    else vizImage = { base, key, ...renderWaveImage(buffer, W, H, range) };
  }
  drawBackdrop(w, h);
  const ready = vizImage && vizImage.key === key;
  if (vizImage && vizImage.base === base) drawImageInView(vizImage, range, fr, w, h);
  if (!ready) drawLabel('Analyzing…', w - 24, h - 14, 'rgba(255, 184, 34, 0.9)', 'right');
  // Read by the browser tests: mode, scale, band (SPEC) and time range of a finished image.
  els.canvas.dataset.view = ready
    ? `${state.vizMode}:${spec ? `${state.vizScale}:f${fr.lo.toFixed(1)}-${fr.hi.toFixed(1)}` : ''}:${range.t0.toFixed(4)}-${range.t1.toFixed(4)}`
    : '';
  return range;
}

/* ---------------- lanes under WAVE and SPEC ---------------- */

// Codec lane: what the voice path did with each 20 ms frame, in playback
// time (frame f plays from (f * frame - lookahead) / rate). Colours by code
// in opus-codec.mjs FRAME. A pixel covering several frames shows the most
// common of them, with a strip along the top whose strength is the share
// of frames lost (red) or late (orange) there.
const FRAME_STYLE = [
  { name: 'not sent', color: '#1c232b', text: 'not sent: the voice gate was closed, the listener hears silence' },
  { name: 'SILK', color: '#3d7fc4', text: 'SILK: speech coding, up to 8 kHz' },
  { name: 'Hybrid', color: '#2fa58a', text: 'Hybrid: SILK below 8 kHz, CELT above' },
  { name: 'CELT', color: '#9a6ad6', text: 'CELT: transform coding, full band' },
  { name: 'DTX', color: '#9a7414', text: 'DTX: no speech detected; the decoder plays comfort noise' },
  { name: 'lost', color: '#ff4040', text: 'lost: the decoder conceals the gap (PLC)' },
  { name: 'late', color: '#ff9d2e', text: 'late: arrived after its playout time, played as silence' }
];
const FRAME_LOST = 5, FRAME_LATE = 6;

function frameAt(info, t) {
  const f = Math.floor((t * info.sampleRate + info.lookahead) / info.frameSamples);
  return f >= 0 && f < info.frames ? f : -1;
}
const frameStart = (info, f) => (f * info.frameSamples - info.lookahead) / info.sampleRate;

function drawCodecLane(L, range) {
  const info = codecFrames();
  if (!info || !L.laneH) return;
  const { w } = L, y = L.laneY + 1, hL = L.laneH - 2, span = range.t1 - range.t0;
  ctx.fillStyle = '#07090c'; ctx.fillRect(0, L.laneY, w, L.laneH);
  const log = info.frameLog, frameSec = info.frameSamples / info.sampleRate;
  const perPixel = span / w / frameSec;
  if (perPixel < 0.5) {
    // Frames several pixels wide: one block each, with a hairline between.
    const f0 = Math.max(0, frameAt(info, Math.max(range.t0, 0))), f1 = frameAt(info, range.t1);
    for (let f = f0; f <= (f1 < 0 ? info.frames - 1 : f1); f++) {
      const x0 = (frameStart(info, f) - range.t0) / span * w, x1 = x0 + frameSec / span * w;
      ctx.fillStyle = FRAME_STYLE[log[f]].color;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0)), hL);
    }
    return;
  }
  const counts = new Uint16Array(FRAME_STYLE.length);
  for (let x = 0; x < w; x++) {
    const a = range.t0 + x / w * span, b = range.t0 + (x + 1) / w * span;
    let f0 = Math.floor((a * info.sampleRate + info.lookahead) / info.frameSamples);
    let f1 = Math.floor((b * info.sampleRate + info.lookahead) / info.frameSamples);
    f0 = Math.max(0, f0); f1 = Math.min(info.frames - 1, Math.max(f0, f1));
    if (f0 >= info.frames) break;
    counts.fill(0);
    for (let f = f0; f <= f1; f++) counts[log[f]]++;
    let code = 0;
    for (let c = 1; c < FRAME_STYLE.length; c++) if (counts[c] > counts[code]) code = c;
    ctx.fillStyle = FRAME_STYLE[code].color;
    ctx.fillRect(x, y, 1, hL);
    const missed = counts[FRAME_LOST] + counts[FRAME_LATE];
    if (missed && code !== FRAME_LOST && code !== FRAME_LATE) {
      const share = missed / (f1 - f0 + 1);
      ctx.fillStyle = counts[FRAME_LOST] >= counts[FRAME_LATE] ? `rgba(255, 64, 64, ${0.35 + 0.65 * Math.min(1, share * 2.5)})`
        : `rgba(255, 157, 46, ${0.35 + 0.65 * Math.min(1, share * 2.5)})`;
      ctx.fillRect(x, y, 1, 3);
    }
  }
}

// Loudness lane: momentary (400 ms, thin) and short-term (3 s, bold) loudness
// of the wet render and the dry source, each value drawn at the centre of its
// window, with dashed lines at their integrated loudness.
const LUFS_STYLE = { WET: '102, 192, 244', DRY: '235, 235, 235', REAL: '164, 208, 7' };
function drawLufsLane(L, range) {
  if (!L.lufsH) return;
  const { w } = L, y0 = L.lufsY, hL = L.lufsH, span = range.t1 - range.t0;
  ctx.fillStyle = '#05080b'; ctx.fillRect(0, y0, w, hL);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(0, y0, w, 1);
  const toY = (lufs) => y0 + 3 + (VIZ.lufsTop - Math.max(VIZ.lufsFloor, Math.min(VIZ.lufsTop, lufs))) / (VIZ.lufsTop - VIZ.lufsFloor) * (hL - 6);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const level of [-12, -24, -36]) { const y = Math.round(toY(level)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  const stats = state.meterStats;
  const series = stats ? [['DRY', stats.dry], ['REAL', stats.real], ['WET', stats.wet]].filter(([, s]) => s && s.history) : [];
  for (const [label, s] of series) {
    const rgb = LUFS_STYLE[label], hop = s.history.hop;
    for (const [values, windowHops, width, alpha] of [[s.history.momentary, 4, 1, 0.45], [s.history.shortTerm, 30, 1.6, 0.95]]) {
      if (!values.length) continue;
      const off = windowHops / 2;
      const k0 = Math.max(0, Math.floor(range.t0 / hop - off) - 1), k1 = Math.min(values.length - 1, Math.ceil(range.t1 / hop - off) + 1);
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`; ctx.lineWidth = width;
      ctx.beginPath();
      for (let k = k0; k <= k1; k++) {
        const x = ((k + off) * hop - range.t0) / span * w, y = toY(values[k]);
        if (k === k0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (Number.isFinite(s.integrated)) {
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = `rgba(${rgb}, 0.6)`; ctx.lineWidth = 1;
      const y = Math.round(toY(s.integrated)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.restore();
    }
  }
  for (const level of [-12, -24, -36]) {
    const y = toY(level);
    if (y - 5 < y0 + 2 || y + 5 > y0 + hL) continue;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(level).replace('-', '−'), 4, y - 5, 'rgba(200, 210, 220, 0.7)');
  }
  drawLabel(series.length ? 'LUFS' : 'LUFS · measuring…', w - 6, y0 + 3, 'rgba(200, 210, 220, 0.6)', 'right');
}

// Loudness values at time t, for the lane's hover readout.
function lufsAt(s, t) {
  const read = (values, windowHops) => {
    const k = Math.round(t / s.history.hop - windowHops / 2);
    return k >= 0 && k < values.length ? values[k] : null;
  };
  return { m: read(s.history.momentary, 4), s: read(s.history.shortTerm, 30) };
}

/* ---------------- selection and loop ---------------- */

function drawSelection(L, range) {
  if (!vizSel) return;
  const span = range.t1 - range.t0;
  const x0 = (vizSel.t0 - range.t0) / span * L.w, x1 = (vizSel.t1 - range.t0) / span * L.w;
  if (x1 < 0 || x0 > L.w) return;
  const a = Math.max(0, x0), b = Math.min(L.w, x1);
  ctx.fillStyle = 'rgba(102, 192, 244, 0.16)'; ctx.fillRect(a, 0, b - a, L.rulerY);
  ctx.fillStyle = state.loop ? 'rgba(164, 208, 7, 0.85)' : 'rgba(102, 192, 244, 0.85)';
  ctx.fillRect(a, L.rulerY, b - a, 3);
  ctx.strokeStyle = state.loop ? 'rgba(164, 208, 7, 0.8)' : 'rgba(102, 192, 244, 0.75)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of [x0, x1]) if (x >= 0 && x <= L.w) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.h); }
  ctx.stroke();
}

// Looping: the whole file loops through the element itself; a selection
// loops by seeking back to its start when playback crosses its end.
let loopLastTime = 0;
function applyLoop() {
  els.audio.loop = state.loop && !vizSel;
  if (els.vizLoop) {
    els.vizLoop.setAttribute('aria-pressed', String(state.loop));
    els.vizLoop.title = vizSel ? 'Loop the selection (L)' : 'Loop the whole file (L); Shift + drag or drag the time ruler to select a range';
  }
}
function checkLoop() {
  const t = els.audio.currentTime;
  if (state.loop && vizSel && !els.audio.paused && loopLastTime < vizSel.t1 && t >= vizSel.t1) {
    els.audio.currentTime = vizSel.t0;
    loopLastTime = vizSel.t0;
    return;
  }
  loopLastTime = t;
}
function toggleLoop() {
  state.loop = !state.loop;
  applyLoop();
  // Starting a selection loop from outside it jumps in.
  if (state.loop && vizSel && els.audio.src && (els.audio.currentTime < vizSel.t0 || els.audio.currentTime >= vizSel.t1)) {
    els.audio.currentTime = vizSel.t0;
  }
  refreshVisualizer();
}

/* ---------------- hover readout ---------------- */

let vizHover = null;   // pointer position over the canvas, CSS pixels
function drawHover(L, buffer, range) {
  if (!vizHover) return;
  const { x, y } = vizHover, { w } = L;
  const region = regionAt(L, y);
  const span = range.t1 - range.t0, t = range.t0 + x / w * span;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.rulerY);
  let text = formatTime(t, 3);
  if (region === 'main' && state.vizMode === 'spec') {
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    const hz = specHz(1 - y / L.mainH, buffer.rate);
    const note = noteName(hz);
    text += ` · ${formatHz(hz)}${note ? ` (${note})` : ''}`;
    const img = vizImage;
    if (img && img.grid && img.base === imageBase(buffer) && t >= img.t0 && t <= img.t1 && hz >= img.lo && hz <= img.hi) {
      const d = freqDomain(img.scale);
      const col = Math.min(img.cols - 1, Math.floor((t - img.t0) / (img.t1 - img.t0) * img.cols));
      const row = Math.min(img.rows - 1, Math.max(0, Math.floor((d(hz) - d(img.lo)) / (d(img.hi) - d(img.lo)) * img.rows)));
      const db = img.grid[col * img.rows + row];
      if (db > -300) text += ` · ${db.toFixed(0)} dB${img.log ? '/Hz' : ''}`;
      const tier = img.tiers[img.rowTier[row]];
      if (tier) text += ` · ${(tier.windowSec * 1000).toFixed(tier.windowSec < 0.1 ? 1 : 0)} ms / ${formatHz(tier.binHz)}`;
    }
  } else if (region === 'main' && state.vizMode === 'wave') {
    const perPixel = Math.max(1, span * buffer.rate / w);
    const from = Math.max(0, Math.floor(t * buffer.rate)), to = Math.min(buffer.samples.length, from + Math.ceil(perPixel));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(buffer.samples[i]));
    text += ` · ${peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '−∞'} dBFS`;
  } else if (region === 'lufs') {
    const stats = state.meterStats || {};
    const fmt = (v) => (v === null ? '—' : Number.isFinite(v) ? v.toFixed(1) : '−∞');
    for (const [label, s] of [['wet', stats.wet], ['dry', stats.dry], ['real', stats.real]]) {
      if (!s || !s.history) continue;
      const v = lufsAt(s, t);
      text += ` · ${label} M ${fmt(v.m)} S ${fmt(v.s)}`;
    }
    text += ' LUFS';
  } else if (region === 'lane') {
    const info = codecFrames(), f = info ? frameAt(info, t) : -1;
    if (f >= 0) {
      const code = info.frameLog[f], bytes = info.frameBytes ? info.frameBytes[f] : 0;
      const perPacket = info.framesPerPacket || 1;
      text = `frame ${f}${perPacket > 1 ? ` (packet ${Math.floor(f / perPacket)})` : ''} · ${formatTime(Math.max(0, frameStart(info, f)), 3)} · ${FRAME_STYLE[code].name}`;
      if (bytes && code !== 0) text += ` · ${bytes} B${code === FRAME_LOST || code === FRAME_LATE ? '' : ` (${(bytes * 8 / (info.frameMs || 20)).toFixed(1)} kbps)`}`;
    }
  }
  ctx.stroke();
  const tagY = region === 'main' ? Math.max(4, Math.min(L.mainH - 18, y - 20)) : Math.max(4, L.lufsY - 18);
  drawTag(text, x + 10, tagY, w);
}

/* ---------------- BARS ---------------- */

// The version to overlay in BARS: the render when hearing the source or the
// real take; the real take (or else the source) when hearing the render.
function otherBuffer() {
  if (!state.processedBuffer || !state.decodedSource) return null;
  if (state.abMode !== 'wet') return { samples: state.processedBuffer, rate: state.processedRate, label: 'WET' };
  if (state.realTake) return { samples: state.realTake.samples, rate: state.realTake.rate, label: 'REAL' };
  return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'DRY' };
}

// Spectrum of `buffer` at the playhead, as band levels, shifted by its A/B
// matching gain so it compares with what is heard.
function bufferBandLevels(buffer, bands, out) {
  const spectrum = state.vizSpectrum2 || (state.vizSpectrum2 = new Float32Array(VIZ.fftSize / 2));
  spectrumAt(buffer.samples, els.audio.currentTime * buffer.rate, VIZ.fftSize, spectrum);
  bandLevels(spectrum, bands, out);
  const offset = abGainDb(buffer.label);
  if (offset) for (let i = 0; i < out.length; i++) out[i] += offset;
  return out;
}


function drawBarsView(buffer, w, h, now) {
  const live = state.isPlaying && state.analyser;
  const rate = live ? state.audioCtx.sampleRate : buffer.rate;
  const top = Math.min(VIZ.maxHz, rate / 2);
  const count = Math.max(16, Math.min(200, Math.floor(w / 5)));
  if (!state.vizBands || state.vizBands.count !== count || state.vizBands.rate !== rate) {
    state.vizBands = { count, rate, bands: logBands(count, rate, VIZ.fftSize), levels: new Float32Array(count),
      overlay: new Float32Array(count), smoothed: null };
  }
  const bands = state.vizBands;
  if (live) {
    const spectrum = state.vizSpectrum || (state.vizSpectrum = new Float32Array(VIZ.fftSize / 2));
    state.analyser.getFloatFrequencyData(spectrum);
    bandLevels(spectrum, bands.bands, bands.levels);
  } else {
    bufferBandLevels(buffer, bands.bands, bands.levels);
  }
  drawBars(bands.levels, w, h, top, now);

  // The other version (dry when hearing wet, and vice versa) as a line,
  // smoothed like the analyser while playing.
  const other = otherBuffer();
  if (other) {
    const fresh = bufferBandLevels(other, logBands(count, other.rate, VIZ.fftSize), bands.overlay);
    if (live && bands.smoothed && bands.smoothed.length === count) {
      const tau = state.analyser.smoothingTimeConstant;
      for (let i = 0; i < count; i++) {
        bands.smoothed[i] = 20 * Math.log10(tau * Math.pow(10, bands.smoothed[i] / 20) + (1 - tau) * Math.pow(10, fresh[i] / 20) + 1e-12);
      }
    } else {
      bands.smoothed = Float32Array.from(fresh);
    }
    const slot = w / count;
    ctx.strokeStyle = 'rgba(235, 235, 235, 0.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = (i + 0.5) * slot, y = h - dbToUnit(bands.smoothed[i]) * h;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(h * (1 - dbToUnit(dbLine)));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(dbLine), 4, y - 5, 'rgba(200, 210, 220, 0.75)');
  }
  if (live) {
    const wave = state.vizWave || (state.vizWave = new Float32Array(state.analyser.fftSize));
    state.analyser.getFloatTimeDomainData(wave);
    let peak = 0, sq = 0;
    for (const v of wave) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
    const toDb = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
    drawLabel(`${buffer.label}  peak ${toDb(peak)}  rms ${toDb(Math.sqrt(sq / wave.length))} dBFS`, 30, 4);
  } else {
    drawLabel(`${buffer.label}  spectrum at ${els.audio.currentTime.toFixed(2)} s`, 30, 4);
  }
  if (other) drawLabel(`— ${other.label}`, 30, 16, 'rgba(235, 235, 235, 0.85)');
  if (state.abMatch && state.abOffsetDb) drawLabel('levels matched', 30, 28, 'rgba(164, 208, 7, 0.9)');

  if (vizHover) {
    const i = Math.min(count - 1, Math.max(0, Math.floor(vizHover.x / (w / count))));
    const [lo, hi] = bands.bands[i], binHz = rate / VIZ.fftSize;
    const hz = Math.sqrt(Math.max(lo, 0.5) * hi) * binHz;
    let text = `${formatHz(hz)} · ${buffer.label} ${bands.levels[i].toFixed(1)} dB`;
    if (other && bands.smoothed) text += ` · ${other.label} ${bands.smoothed[i].toFixed(1)} dB`;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(vizHover.x) + 0.5, 0); ctx.lineTo(Math.round(vizHover.x) + 0.5, h); ctx.stroke();
    drawTag(text, vizHover.x + 10, Math.max(40, Math.min(h - 32, vizHover.y - 20)), w);
  }
}

/* ---------------- BARS: average spectrum ---------------- */

// AVG: the long-term average spectrum of the render and the source over the
// selection (or the whole file), the source shifted to the render's
// loudness, and their difference. Welch's method: power averaged over
// 8192-point Blackman windows (up to 1500, spread evenly), skipping windows
// below -70 dBFS RMS as BS.1770 gates silence; then 1/6-octave smoothing.
const AVG = { fft: 8192, minFft: 1024, maxWindows: 1500, gateDb: -70, octave: 1 / 6, diffRange: 24 };
state.barsAvg = LS.get('tf2ve_bars_avg', false) === true;
const avgResults = new Map();   // "id:t0:t1" -> Promise<{ power, rate, fft, windows }>

function averagePower(samples, rate, t0, t1) {
  const key = `${bufferId(samples)}:${t0.toFixed(4)}:${t1.toFixed(4)}`;
  if (!avgResults.has(key)) {
    if (avgResults.size >= 16) avgResults.delete(avgResults.keys().next().value);
    const job = (async () => {
      const from = Math.max(0, Math.floor(t0 * rate)), to = Math.min(samples.length, Math.ceil(t1 * rate));
      const part = samples.subarray(from, to);
      let n = AVG.fft;
      while (n > AVG.minFft && n > part.length) n /= 2;
      const plan = fftPlan(n), sum = new Float64Array(n / 2 + 1);
      const count = Math.max(1, Math.min(AVG.maxWindows, Math.floor((part.length - n) / (n / 2)) + 1));
      const step = count > 1 ? (part.length - n) / (count - 1) : 0;
      const gate = Math.pow(10, AVG.gateDb / 10) * n;
      let used = 0, yieldAt = performance.now() + 12;
      for (let i = 0; i < count; i++) {
        const start = Math.round(i * step);
        let energy = 0;
        for (let j = start; j < Math.min(part.length, start + n); j++) energy += part[j] * part[j];
        if (energy < gate && count > 1) continue;
        windowedFft(plan, part, part.length < n ? part.length / 2 : start + n / 2);
        for (let k = 0; k <= n / 2; k++) sum[k] += plan.re[k] * plan.re[k] + plan.im[k] * plan.im[k];
        used++;
        if (performance.now() > yieldAt) { await yieldToUi(); yieldAt = performance.now() + 12; }
      }
      // Mean power per bin, scaled like AnalyserNode (a full-scale sine reads about -13.6 dB).
      for (let k = 0; k <= n / 2; k++) sum[k] = used ? sum[k] / used / (n * n) : 0;
      return { power: sum, rate, fft: n, windows: used };
    })();
    job.catch(() => avgResults.delete(key));
    avgResults.set(key, job);
  }
  return avgResults.get(key);
}

// dB per pixel column, smoothed over 1/6 octave around each column's
// frequency (prefix sums of power; narrow low bands interpolate).
function smoothedSpectrum(result, w, top) {
  const { power, rate, fft } = result, binHz = rate / fft, last = power.length - 1;
  const prefix = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k++) prefix[k + 1] = prefix[k] + power[k];
  const at = (bin) => { const k = Math.min(last - 1, Math.floor(bin)), f = bin - k; return power[k] * (1 - f) + power[k + 1] * f; };
  const half = Math.pow(2, AVG.octave / 2), out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const hz = VIZ.minHz * Math.pow(top / VIZ.minHz, (x + 0.5) / w);
    const lo = hz / half / binHz, hi = Math.min(last, hz * half / binHz);
    let p;
    if (hi - lo < 2) p = at(Math.min(last - 1, hz / binHz));
    else { const k0 = Math.ceil(lo), k1 = Math.floor(hi); p = (prefix[k1 + 1] - prefix[k0]) / (k1 - k0 + 1); }
    out[x] = p > 0 ? 10 * Math.log10(p) : -Infinity;
  }
  return out;
}

let avgView = null;   // { key, wet, ref, extra, ... } for the current width and range
// The render against the real take when one is loaded (dry drawn faintly
// behind), else against the dry source. Each is shifted to the render's
// loudness over the analysed range.
function drawAverageView(w, h) {
  drawBackdrop(w, h);
  const versions = {
    WET: state.processedBuffer ? { samples: state.processedBuffer, rate: state.processedRate } : null,
    DRY: state.decodedSource ? { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate } : null,
    REAL: state.realTake ? { samples: state.realTake.samples, rate: state.realTake.rate } : null
  };
  const refLabel = versions.REAL ? 'REAL' : 'DRY';
  const order = ['WET', refLabel, ...(versions.REAL ? ['DRY'] : [])].filter(label => versions[label]);
  const first = versions[order[0]];
  const duration = first.samples.length / first.rate;
  const range = vizSel ? { t0: vizSel.t0, t1: Math.min(vizSel.t1, duration) } : { t0: 0, t1: duration };
  // A take covers only part of the source: analyse where it has audio.
  if (state.realTake) { range.t0 = Math.max(range.t0, state.realTake.overlap.t0); range.t1 = Math.min(range.t1, state.realTake.overlap.t1); }
  if (!(range.t1 - range.t0 > 0.05)) { drawLabel('The selection is outside the real take.', 8, 8); els.canvas.dataset.view = ''; return; }
  const top = Math.min(VIZ.maxHz, ...order.map(label => versions[label].rate / 2));
  const key = `${order.map(label => bufferId(versions[label].samples)).join(':')}:${range.t0.toFixed(4)}:${range.t1.toFixed(4)}:${Math.round(w)}`;
  const whole = !vizSel && !state.realTake;
  if (!avgView || avgView.key !== key) {
    avgView = { key, pending: true };
    const view = avgView;
    Promise.all(order.map(label => averagePower(versions[label].samples, versions[label].rate, range.t0, range.t1)))
      .then(async (powers) => {
        // Match loudness over the same range (RMS when it is under 0.4 s).
        const levels = await Promise.all(order.map(label => (whole ? measure(versions[label].samples, versions[label].rate)
          : measureRange(versions[label].samples, versions[label].rate, range.t0, range.t1)).catch(() => null)));
        if (avgView !== view) return;
        const lufs = (s) => (s && Number.isFinite(s.integrated) ? s.integrated : null);
        const curves = {};
        order.forEach((label, i) => {
          let offset = 0, match = '';
          if (i > 0 && order[0] === 'WET') {
            if (lufs(levels[0]) !== null && lufs(levels[i]) !== null) { offset = lufs(levels[0]) - lufs(levels[i]); match = 'loudness'; }
            else if (levels[0] && levels[i] && Number.isFinite(levels[0].rms) && Number.isFinite(levels[i].rms)) { offset = levels[0].rms - levels[i].rms; match = 'RMS'; }
          }
          curves[label] = { values: smoothedSpectrum(powers[i], Math.round(w), top).map(v => v + offset), offset, match };
        });
        Object.assign(view, { pending: false, top, range, curves, refLabel, windows: powers[0].windows, fft: powers[0].fft });
        refreshVisualizer();
      })
      .catch((error) => { if (avgView === view) { view.pending = false; view.error = error.message; refreshVisualizer(); } });
  }
  const v = avgView;
  const specH = Math.round(h * 0.68), diffY = specH + 4, diffH = h - diffY - 2;
  // Level grid and frequency grid.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; ctx.lineWidth = 1;
  const yDb = (db) => specH * (1 - dbToUnit(db));
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(yDb(dbLine)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  drawFrequencyGrid(w, specH, top, false);
  ctx.fillStyle = '#05080b'; ctx.fillRect(0, specH, w, h - specH);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(0, specH, w, 1);
  const yDiff = (d) => diffY + diffH / 2 - Math.max(-1, Math.min(1, d / AVG.diffRange)) * diffH / 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.beginPath();
  for (const d of [-12, 12]) { const y = Math.round(yDiff(d)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath(); ctx.moveTo(0, Math.round(yDiff(0)) + 0.5); ctx.lineTo(w, Math.round(yDiff(0)) + 0.5); ctx.stroke();
  const STYLE = { WET: ['rgba(102, 192, 244, 0.95)', 2], DRY: ['rgba(235, 235, 235, 0.85)', 1.5], REAL: ['rgba(164, 208, 7, 0.95)', 1.5] };
  if (v.pending || v.error) {
    drawLabel(v.error ? `Average spectrum failed: ${v.error}` : 'Analyzing…', w - 8, 6, 'rgba(255, 184, 34, 0.9)', 'right');
  } else {
    const curve = (values, color, width, y) => {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      let pen = false;
      for (let x = 0; x < values.length; x++) {
        if (!Number.isFinite(values[x])) { pen = false; continue; }
        const yy = y(values[x]);
        if (pen) ctx.lineTo(x + 0.5, yy); else { ctx.moveTo(x + 0.5, yy); pen = true; }
      }
      ctx.stroke();
    };
    // Back to front: the faint source behind a real take, the reference, the render.
    if (v.curves.DRY && v.refLabel === 'REAL') curve(v.curves.DRY.values, 'rgba(235, 235, 235, 0.3)', 1, yDb);
    if (v.curves[v.refLabel]) curve(v.curves[v.refLabel].values, ...STYLE[v.refLabel], yDb);
    if (v.curves.WET) curve(v.curves.WET.values, ...STYLE.WET, yDb);
    v.diff = null;
    if (v.curves.WET && v.curves[v.refLabel]) {
      // Difference, where either version is above the display floor.
      const ref = v.curves[v.refLabel].values;
      const diff = v.curves.WET.values.map((a, x) => (Math.max(a, ref[x]) > VIZ.minDb ? a - ref[x] : NaN));
      ctx.fillStyle = 'rgba(255, 184, 34, 0.18)';
      for (let x = 0; x < diff.length; x++) {
        if (!Number.isFinite(diff[x])) continue;
        const y0 = yDiff(0), y1 = yDiff(diff[x]);
        ctx.fillRect(x, Math.min(y0, y1), 1, Math.abs(y1 - y0));
      }
      curve(diff, 'rgba(255, 184, 34, 0.95)', 1.5, yDiff);
      v.diff = diff;
    }
  }
  drawFrequencyGrid(w, specH, top, true);
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(yDb(dbLine));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(dbLine), 4, y - 5, 'rgba(200, 210, 220, 0.75)');
  }
  for (const d of [-12, 12]) {
    const y = yDiff(d);
    if (y - 5 < specH + 2 || y + 5 > h) continue;
    drawLabel(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, 4, y - 5, 'rgba(200, 210, 220, 0.6)');
  }
  drawLabel(`Δ wet − ${refLabel.toLowerCase()}`, w - 6, diffY + 2, 'rgba(255, 184, 34, 0.8)', 'right');
  const where = vizSel || state.realTake ? `${formatTime(range.t0, 2)}–${formatTime(range.t1, 2)}` : 'whole file';
  drawPlate(`AVERAGE SPECTRUM · ${where}${v.fft ? ` · ${v.fft}-pt, ${v.windows} windows, 1/6 oct` : ''}`, 30, 3);
  if (v.curves) {
    let x = 30;
    for (const label of ['WET', refLabel, ...(refLabel === 'REAL' ? ['DRY'] : [])]) {
      const c = v.curves[label];
      if (!c) continue;
      const shift = c.match ? ` (${c.offset >= 0 ? '+' : '−'}${Math.abs(c.offset).toFixed(1)} dB)` : '';
      const text = `— ${label}${shift}`;
      drawLabel(text, x, 17, label === 'DRY' && refLabel === 'REAL' ? 'rgba(235, 235, 235, 0.5)' : STYLE[label][0]);
      ctx.font = '9px Verdana, sans-serif';
      x += ctx.measureText(text).width + 12;
    }
    if (Object.values(v.curves).some(c => c.match)) drawLabel(`${Object.values(v.curves).find(c => c.match).match} matched to wet`, x, 17, 'rgba(200, 210, 220, 0.55)');
  }
  els.canvas.dataset.view = v.pending ? '' : `avg:${refLabel.toLowerCase()}:${range.t0.toFixed(4)}-${range.t1.toFixed(4)}`;

  if (vizHover && !v.pending && v.curves) {
    const x = Math.min(w - 1, Math.max(0, Math.floor(vizHover.x)));
    const hz = VIZ.minHz * Math.pow(v.top / VIZ.minHz, (x + 0.5) / w);
    const fmt = (d) => (Number.isFinite(d) ? d.toFixed(1) : '−∞');
    let text = formatHz(hz);
    for (const label of ['WET', 'REAL', 'DRY']) if (v.curves[label]) text += ` · ${label.toLowerCase()} ${fmt(v.curves[label].values[x])}`;
    if (v.diff && Number.isFinite(v.diff[x])) text += ` · Δ ${v.diff[x] >= 0 ? '+' : '−'}${Math.abs(v.diff[x]).toFixed(1)} dB`;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
    drawTag(text, vizHover.x + 10, Math.max(30, Math.min(specH - 18, vizHover.y - 20)), w);
  }
}

// dBFS labels for the waveform's amplitude grid.
function drawWaveLabels(w, h) {
  const map = waveMapper(), mid = h / 2;
  for (const dbLevel of waveGridDb()) {
    const y = mid - map(Math.pow(10, dbLevel / 20)) * mid;
    if (y < 18) continue;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 24, 10);
    drawLabel(String(dbLevel), 4, y - 5, 'rgba(200, 210, 220, 0.7)');
  }
}


/* ---------------- main draw ---------------- */

function drawVisualizer(now = performance.now()) {
  const { w, h, dpr } = resizeCanvas();
  const buffer = audibleBuffer();
  if (!buffer) { drawBackdrop(w, h); drawLabel('Load audio to visualize', 8, 8); els.canvas.dataset.view = ''; return; }
  if (state.vizMode === 'bars') {
    if (state.barsAvg) drawAverageView(w, h); else drawBarsView(buffer, w, h, now);
    return;
  }
  const L = vizLayout(w, h);
  const range = drawTimeView(buffer, w, L.mainH, dpr);
  const spec = state.vizMode === 'spec';
  if (spec) {
    drawFrequencyAxisLabels(w, L.mainH, buffer.rate);
    drawColorbar(w, L.mainH);
  } else {
    drawWaveLabels(w, L.mainH);
  }
  drawLufsLane(L, range);
  drawCodecLane(L, range);
  drawTimeRuler(w, L.rulerY, L.rulerH, range);
  drawSelection(L, range);
  const zoom = range.zoomed ? `  ${formatTime(range.t0, 2)}–${formatTime(range.t1, 2)}` : '';
  const resolution = spec && vizImage && vizImage.tiers && vizImage.base === imageBase(buffer) ? `  ·  ${describeResolution(vizImage)}` : '';
  drawPlate(`${buffer.label}${zoom}${resolution}`, spec ? VIZ.freqRulerW : 6, 3);
  drawPlayhead(w, L.rulerY, range);
  drawHover(L, buffer, range);
}

function animateVisualizer(now) {
  checkLoop();
  // Zoomed in, the view pages along with the playhead.
  const buffer = state.vizMode !== 'bars' && audibleBuffer();
  if (buffer) {
    const r = visibleRange(buffer), t = els.audio.currentTime;
    if (r.zoomed && (t > r.t1 || t < r.t0)) {
      const span = r.t1 - r.t0;
      vizView.t0 = Math.min(Math.max(0, t - 0.02 * span), r.duration - span);
      vizView.t1 = vizView.t0 + span;
    }
  }
  drawVisualizer(now);
  if (state.isPlaying) state.animationId = requestAnimationFrame(animateVisualizer);
}

function refreshVisualizer() {
  updateVizTools();
  if (!state.isPlaying) drawVisualizer();
}

// The legend under the view: codec lane colours with frame counts, and the
// loudness lane's lines.
const frameCounts = new WeakMap();
let legendKey = '';
function updateLegend() {
  if (!els.vizLegend) return;
  const time = state.vizMode !== 'bars';
  const info = time ? codecFrames() : null;
  const lufs = time && state.showLufs && !!(state.processedBuffer || state.decodedSource);
  const key = `${info ? bufferId(info.frameLog) : 0}:${lufs}:${!!state.realTake}`;
  if (key === legendKey) return;
  legendKey = key;
  const items = [];
  const item = (swatch, text, title) => {
    const span = document.createElement('span');
    span.className = 'lg-item';
    if (title) span.title = title;
    span.append(swatch, text);
    return span;
  };
  const box = (color) => { const i = document.createElement('i'); i.className = 'lg-box'; i.style.background = color; return i; };
  const line = (rgb, width, dashed) => {
    const i = document.createElement('i');
    i.className = 'lg-line';
    i.style.borderTop = `${width}px ${dashed ? 'dashed' : 'solid'} rgb(${rgb})`;
    return i;
  };
  if (info) {
    if (!frameCounts.has(info.frameLog)) {
      const counts = new Array(FRAME_STYLE.length).fill(0);
      for (const code of info.frameLog) counts[code]++;
      frameCounts.set(info.frameLog, counts);
    }
    const counts = frameCounts.get(info.frameLog);
    const head = document.createElement('b');
    head.textContent = 'Codec';
    head.title = 'What the voice path did with each 20 ms frame; hover the lane for packet sizes';
    items.push(head);
    FRAME_STYLE.forEach((style, code) => {
      if (counts[code]) items.push(item(box(style.color), `${style.name} ${counts[code]}`, style.text));
    });
  }
  if (lufs) {
    const head = document.createElement('b');
    head.textContent = 'Loudness';
    head.title = 'BS.1770 loudness over time: momentary (400 ms) and short-term (3 s), each at the centre of its window';
    items.push(head);
    for (const label of ['WET', 'DRY', ...(state.realTake ? ['REAL'] : [])]) {
      items.push(item(line(LUFS_STYLE[label], 2, false), `${label.toLowerCase()} S`, `${label.toLowerCase()} short-term (3 s)`));
      items.push(item(line(LUFS_STYLE[label], 1, false), `${label.toLowerCase()} M`, `${label.toLowerCase()} momentary (400 ms)`));
    }
    items.push(item(line('180, 180, 180', 1, true), 'integrated', 'Integrated loudness of the whole file'));
  }
  els.vizLegend.replaceChildren(...items);
  els.vizLegend.hidden = !items.length;
}

function updateVizTools() {
  const loaded = !!(state.processedBuffer || state.decodedSource);
  const timeView = state.vizMode !== 'bars' && loaded;
  for (const button of [els.vizZoomIn, els.vizZoomOut, els.vizFit]) if (button) button.disabled = !timeView;
  if (els.vizLog) {
    // SPEC: log frequency axis. WAVE: dBFS amplitude.
    const wave = state.vizMode === 'wave', on = wave ? state.waveScale === 'db' : state.vizScale === 'log';
    els.vizLog.textContent = wave ? 'dB' : 'LOG';
    els.vizLog.title = wave ? 'Waveform amplitude in dBFS: shows quiet detail, fades, gates and noise floors'
      : 'Spectrogram frequency axis: log from 20 Hz, analysed with longer windows for the low octaves';
    els.vizLog.disabled = state.vizMode === 'bars';
    els.vizLog.setAttribute('aria-pressed', String(on));
  }
  if (els.vizRange) {
    els.vizRange.hidden = !(state.vizMode === 'spec' || (state.vizMode === 'wave' && state.waveScale === 'db'));
    els.vizRange.textContent = `${state.vizRange} dB`;
  }
  if (els.vizAvg) {
    els.vizAvg.hidden = state.vizMode !== 'bars';
    els.vizAvg.disabled = !loaded;
    els.vizAvg.setAttribute('aria-pressed', String(state.barsAvg));
  }
  if (els.vizRes) {
    els.vizRes.hidden = state.vizMode !== 'spec';
    if (els.vizRes.value !== String(state.specRes)) els.vizRes.value = String(state.specRes);
  }
  if (els.vizLufs) {
    els.vizLufs.disabled = state.vizMode === 'bars';
    els.vizLufs.setAttribute('aria-pressed', String(state.showLufs));
  }
  if (els.vizLoop) els.vizLoop.disabled = !loaded;
  applyLoop();
  updateLegend();
}

// Segmented WAVE | BARS | SPEC control.
function setVizMode(mode) {
  if (state.vizMode === mode) return;
  state.vizMode = mode;
  for (const [button, value] of [[els.vizWave, 'wave'], [els.vizBars, 'bars'], [els.vizSpec, 'spec']]) {
    if (!button) continue;
    button.classList.toggle('active', mode === value);
    button.setAttribute('aria-pressed', String(mode === value));
  }
  vizPeaks = null;
  refreshVisualizer();
}

// FIT: the whole file and the whole band; the selection stays.
function fitView() {
  vizView.t0 = 0;
  vizView.t1 = Infinity;
  resetFreqView();
  refreshVisualizer();
}

if (els.vizWave) els.vizWave.addEventListener('click', () => setVizMode('wave'));
if (els.vizBars) els.vizBars.addEventListener('click', () => setVizMode('bars'));
if (els.vizSpec) els.vizSpec.addEventListener('click', () => setVizMode('spec'));
if (els.vizZoomIn) els.vizZoomIn.addEventListener('click', () => zoomViz(0.5));
if (els.vizZoomOut) els.vizZoomOut.addEventListener('click', () => zoomViz(2));
if (els.vizFit) els.vizFit.addEventListener('click', fitView);
if (els.vizLog) els.vizLog.addEventListener('click', () => {
  if (state.vizMode === 'wave') {
    state.waveScale = state.waveScale === 'db' ? 'lin' : 'db';
    LS.set('tf2ve_wave_scale', state.waveScale);
  } else {
    state.vizScale = state.vizScale === 'log' ? 'lin' : 'log';
    LS.set('tf2ve_viz_scale', state.vizScale);
    // Keep the visible band where the new axis can show it (log starts at 20 Hz).
    if (vizFreq.lo !== null && state.vizScale === 'log') vizFreq.lo = Math.max(VIZ.logMinHz, vizFreq.lo);
  }
  refreshVisualizer();
});
if (els.vizAvg) els.vizAvg.addEventListener('click', () => {
  state.barsAvg = !state.barsAvg;
  LS.set('tf2ve_bars_avg', state.barsAvg);
  refreshVisualizer();
});
if (els.vizRange) els.vizRange.addEventListener('click', () => {
  state.vizRange = VIZ.ranges[(VIZ.ranges.indexOf(state.vizRange) + 1) % VIZ.ranges.length];
  LS.set('tf2ve_viz_range', state.vizRange);
  refreshVisualizer();
});
if (els.vizRes) els.vizRes.addEventListener('change', () => {
  state.specRes = els.vizRes.value === 'auto' ? 'auto' : Number(els.vizRes.value);
  LS.set('tf2ve_spec_res', String(state.specRes));
  refreshVisualizer();
});
if (els.vizLufs) els.vizLufs.addEventListener('click', () => {
  state.showLufs = !state.showLufs;
  LS.set('tf2ve_lufs_lane', state.showLufs);
  refreshVisualizer();
});
if (els.vizLoop) els.vizLoop.addEventListener('click', toggleLoop);

// Taller view: the TALL button, or drag the bottom-right corner (desktop).
// Taller than the stylesheet's height for this screen (TALL, or a drag).
function isTall() {
  const box = els.vizContainer, inline = box.style.height;
  if (!inline) return false;
  box.style.height = '';
  const natural = box.offsetHeight;
  box.style.height = inline;
  return box.offsetHeight > natural + 20;
}
function setVizHeight(px) {
  els.vizContainer.style.height = px ? `${px}px` : '';
  if (els.vizTall) els.vizTall.setAttribute('aria-pressed', String(isTall()));
}
if (els.vizTall) els.vizTall.addEventListener('click', () => {
  const tall = isTall();
  setVizHeight(tall ? 0 : VIZ.tallHeight);
  LS.set('tf2ve_viz_height', tall ? 0 : VIZ.tallHeight);
});
{
  const saved = Number(LS.get('tf2ve_viz_height', 0));
  if (saved >= 160 && saved <= 2000) setVizHeight(saved);
}
if (typeof ResizeObserver !== 'undefined') {
  let lastHeight = els.vizContainer.offsetHeight, timer = 0;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const height = els.vizContainer.offsetHeight;
      if (height !== lastHeight && els.vizContainer.style.height) LS.set('tf2ve_viz_height', height);
      lastHeight = height;
      if (els.vizTall) els.vizTall.setAttribute('aria-pressed', String(isTall()));
      refreshVisualizer();
    }, 100);
  }).observe(els.vizContainer);
}

/* ---------------- pointer, wheel and keys ---------------- */

const vizPointers = new Map();
let vizDrag = null, vizPinch = null;
const canvasPoint = (event) => {
  const rect = els.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
};
// What a point on the canvas is over: 'freq' (the SPEC frequency ruler),
// 'main', 'lufs', 'lane' or 'ruler'.
function pointRegion(p) {
  const L = vizLayout(p.w, p.h), region = regionAt(L, p.y);
  return { L, region: region === 'main' && state.vizMode === 'spec' && p.x < VIZ.freqRulerW ? 'freq' : region };
}
const timeAtPoint = (p, r) => Math.min(r.duration, Math.max(0, r.t0 + p.x / p.w * (r.t1 - r.t0)));

els.canvas.addEventListener('wheel', (event) => {
  const buffer = state.vizMode !== 'bars' && audibleBuffer();
  if (!buffer) return;
  const p = canvasPoint(event), { L, region } = pointRegion(p);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? p.h : 1;
  const delta = Math.max(-100, Math.min(100, (event.deltaY || event.deltaX) * unit));
  // Frequency zoom (SPEC): the wheel over the frequency ruler, or Alt or
  // Ctrl/⌘ + Shift + wheel over the view, around the pointer's frequency.
  if (state.vizMode === 'spec' && (region === 'freq' || event.altKey || ((event.ctrlKey || event.metaKey) && event.shiftKey))) {
    event.preventDefault();
    zoomFreq(Math.exp(delta * 0.005), Math.min(1, Math.max(0, 1 - p.y / L.mainH)));
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/⌘ + wheel, and trackpad pinches (which arrive as ctrl + wheel).
    event.preventDefault();
    zoomViz(Math.exp(Math.max(-100, Math.min(100, event.deltaY * unit)) * 0.005), p.x / p.w);
    return;
  }
  const dx = event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX;
  if (dx && visibleRange(buffer).zoomed) {
    event.preventDefault();
    panViz(dx * unit / p.w);
  }
}, { passive: false });

els.canvas.addEventListener('pointerdown', (event) => {
  if (state.vizMode === 'bars' || !audibleBuffer() || event.button > 0) return;
  const p = canvasPoint(event), { L, region } = pointRegion(p);
  vizPointers.set(event.pointerId, p);
  try { els.canvas.setPointerCapture(event.pointerId); } catch (e) { /* synthetic pointer */ }
  const buffer = audibleBuffer(), r = visibleRange(buffer);
  if (vizPointers.size === 1) {
    const base = { x: p.x, y: p.y, w: p.w, moved: false, t0: r.t0, span: r.t1 - r.t0, duration: r.duration, shift: event.shiftKey };
    if (region === 'freq') {
      // Drag the frequency ruler to move the band; double-click resets it.
      const fr = freqRange(buffer.rate), d = freqDomain(fr.scale);
      vizDrag = { ...base, kind: 'freq', h: L.mainH, d0: d(fr.lo), d1: d(fr.hi), rate: buffer.rate };
    } else if (event.shiftKey || region === 'ruler') {
      // Shift + drag, or a drag along the time ruler, selects a range.
      vizDrag = { ...base, kind: 'select', anchor: timeAtPoint(p, r), region };
    } else {
      vizDrag = { ...base, kind: 'pan' };
    }
  } else if (vizPointers.size === 2) {
    const [a, b] = [...vizPointers.values()];
    vizDrag = null;
    vizPinch = { dist: Math.max(10, Math.abs(a.x - b.x)), mid: (a.x + b.x) / 2, w: p.w, t0: r.t0, span: r.t1 - r.t0,
      duration: r.duration, minSpan: r.minSpan };
  }
});

els.canvas.addEventListener('pointermove', (event) => {
  const p = canvasPoint(event);
  if (vizPointers.has(event.pointerId)) vizPointers.set(event.pointerId, p);
  if (vizPinch && vizPointers.size === 2) {
    const [a, b] = [...vizPointers.values()];
    const dist = Math.max(10, Math.abs(a.x - b.x)), mid = (a.x + b.x) / 2;
    const span = Math.min(vizPinch.duration, Math.max(vizPinch.minSpan, vizPinch.span * vizPinch.dist / dist));
    const at = vizPinch.t0 + vizPinch.mid / vizPinch.w * vizPinch.span;
    setVizView(at - mid / vizPinch.w * span, span, vizPinch.duration);
  } else if (vizDrag && vizPointers.has(event.pointerId)) {
    const dx = p.x - vizDrag.x, dy = p.y - vizDrag.y;
    if (Math.abs(dx) > 4 || (vizDrag.kind === 'freq' && Math.abs(dy) > 3)) vizDrag.moved = true;
    if (vizDrag.moved) {
      if (vizDrag.kind === 'pan') setVizView(vizDrag.t0 - dx / vizDrag.w * vizDrag.span, vizDrag.span, vizDrag.duration);
      else if (vizDrag.kind === 'select') {
        const t = Math.min(vizDrag.duration, Math.max(0, vizDrag.t0 + p.x / vizDrag.w * vizDrag.span));
        setSelection({ t0: Math.min(vizDrag.anchor, t), t1: Math.max(vizDrag.anchor, t) });
        refreshVisualizer();
      } else if (vizDrag.kind === 'freq') {
        // Dragging down shows higher frequencies, like dragging the image.
        const span = vizDrag.d1 - vizDrag.d0, shift = dy / vizDrag.h * span;
        const full = freqRange(vizDrag.rate), d = freqDomain(full.scale), inv = freqUndomain(full.scale);
        const start = Math.min(Math.max(d(full.floor), vizDrag.d0 + shift), d(full.top) - span);
        setFreqView(inv(start), inv(start + span), vizDrag.rate);
      }
    }
  }
  if (event.pointerType === 'mouse') {
    vizHover = { x: p.x, y: p.y };
    const { region } = pointRegion(p);
    els.canvas.style.cursor = vizDrag && vizDrag.moved && vizDrag.kind === 'pan' ? 'grabbing'
      : region === 'freq' ? 'ns-resize' : region === 'ruler' || event.shiftKey ? 'col-resize' : '';
    if (!state.isPlaying) drawVisualizer();
  }
});

function endVizPointer(event) {
  if (!vizPointers.has(event.pointerId)) return;
  vizPointers.delete(event.pointerId);
  const drag = vizDrag;
  if (event.type === 'pointerup' && drag && !drag.moved && drag.kind !== 'freq' && els.audio.src && Number.isFinite(els.audio.duration)) {
    const t = Math.min(Math.max(0, drag.t0 + canvasPoint(event).x / drag.w * drag.span), els.audio.duration);
    if (drag.shift && vizSel) {
      // Shift + click moves the nearer end of the selection there.
      if (Math.abs(t - vizSel.t0) < Math.abs(t - vizSel.t1)) setSelection({ t0: t, t1: vizSel.t1 });
      else setSelection({ t0: vizSel.t0, t1: t });
      refreshVisualizer();
    } else {
      // A click seeks the player there; in the view, a click outside the
      // selection also clears it.
      if (drag.kind === 'pan' && vizSel && (t < vizSel.t0 || t > vizSel.t1)) setSelection(null);
      els.audio.currentTime = t;
      refreshVisualizer();
    }
  }
  if (!vizPointers.size) { vizDrag = null; vizPinch = null; }
  else if (vizPinch) vizPinch = null;
}
els.canvas.addEventListener('pointerup', endVizPointer);
els.canvas.addEventListener('pointercancel', endVizPointer);
els.canvas.addEventListener('pointerleave', () => {
  if (!vizHover) return;
  vizHover = null;
  if (!state.isPlaying) drawVisualizer();
});
els.canvas.addEventListener('dblclick', (event) => {
  if (state.vizMode !== 'spec' || pointRegion(canvasPoint(event)).region !== 'freq') return;
  resetFreqView();
  refreshVisualizer();
});

els.canvas.addEventListener('keydown', (event) => {
  if (state.vizMode === 'bars' || event.ctrlKey || event.metaKey || event.altKey) return;
  const spec = state.vizMode === 'spec';
  const actions = {
    '+': () => zoomViz(0.5), '=': () => zoomViz(0.5), '-': () => zoomViz(2), '_': () => zoomViz(2),
    '0': fitView,
    ArrowLeft: () => panViz(-0.25), ArrowRight: () => panViz(0.25),
    ArrowUp: spec ? () => (event.shiftKey ? panFreq(0.25) : zoomFreq(0.5)) : null,
    ArrowDown: spec ? () => (event.shiftKey ? panFreq(-0.25) : zoomFreq(2)) : null,
    z: vizSel ? zoomToSelection : null, Z: vizSel ? zoomToSelection : null,
    Escape: vizSel ? () => { setSelection(null); refreshVisualizer(); } : null
  };
  if (!actions[event.key]) return;
  event.preventDefault();
  actions[event.key]();
});

els.audio.addEventListener('play', () => {
  if (!state.audioCtx) {
    try {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = VIZ.fftSize;
      state.analyser.smoothingTimeConstant = 0.6;
      state.analyser.minDecibels = VIZ.minDb;
      state.analyser.maxDecibels = VIZ.maxDb;
      // Each element has its own gain for the loudness-matched A/B.
      state.wetGain = state.audioCtx.createGain();
      state.sourceNode = state.audioCtx.createMediaElementSource(els.audio);
      state.sourceNode.connect(state.wetGain).connect(state.analyser);
      state.analyser.connect(state.audioCtx.destination);
      if (els.audioDry) {
        // Route the dry twin through the same analyser: a muted element is
        // silent in the graph, so the visualizer always shows the audible one.
        state.dryGain = state.audioCtx.createGain();
        state.sourceNodeDry = state.audioCtx.createMediaElementSource(els.audioDry);
        state.sourceNodeDry.connect(state.dryGain).connect(state.analyser);
      }
      if (els.audioReal) {
        state.realGain = state.audioCtx.createGain();
        state.sourceNodeReal = state.audioCtx.createMediaElementSource(els.audioReal);
        state.sourceNodeReal.connect(state.realGain).connect(state.analyser);
      }
      applyAbMatch();
    } catch (e) {
      state.analyser = null;   // visualizer falls back to buffer analysis
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  // A selection loop starts at the selection when played from outside it.
  if (state.loop && vizSel && (els.audio.currentTime < vizSel.t0 || els.audio.currentTime >= vizSel.t1)) els.audio.currentTime = vizSel.t0;
  loopLastTime = els.audio.currentTime;
  syncTwins();
  for (const el of twins()) el.play().catch(() => {});
  state.isPlaying = true;
  cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(animateVisualizer);
});
function stopVisualizer() {
  for (const el of [els.audioDry, els.audioReal]) if (el) el.pause();
  state.isPlaying = false;
  cancelAnimationFrame(state.animationId);
  refreshVisualizer();
}
els.audio.addEventListener('pause', stopVisualizer);
els.audio.addEventListener('ended', () => {
  // A selection that runs to the end of the file loops from here.
  if (state.loop && vizSel) { els.audio.currentTime = vizSel.t0; els.audio.play().catch(() => {}); return; }
  stopVisualizer();
});
els.audio.addEventListener('seeked', () => { syncTwins(); loopLastTime = els.audio.currentTime; refreshVisualizer(); });
els.audio.addEventListener('timeupdate', () => { checkLoop(); refreshVisualizer(); });
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refreshVisualizer, 150); });
