/* TF2 Voice Emulator, app/realtake.js: Checking a render against a real TF2 take.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

/* ------------------------------------------------------------------ */
/* Real take (reference.js)                                           */
/*                                                                    */
/* A real TF2 recording of the loaded source (voice_loopback) is      */
/* found in the source and put on its timeline, offset and clock      */
/* drift corrected. It becomes the third version of A/B, joins the    */
/* views and the meter, and a report compares it with the render:     */
/* level-matched band spectra, short-term level tracking and the      */
/* receiver's clipping signature.                                     */
/* ------------------------------------------------------------------ */

els.reference = document.getElementById('reference');
els.referenceFile = document.getElementById('reference-file');
els.referenceChannel = document.getElementById('reference-channel');
els.referenceClear = document.getElementById('reference-clear');
els.referenceStatus = document.getElementById('reference-status');
els.referenceReport = document.getElementById('reference-report');
els.audioReal = document.getElementById('preview-real');
state.realTake = null;   // { name, samples, rate, timeline, overlap: { t0, t1 }, blob }
let referenceJob = 0, reportJob = 0, referenceDecoded = null;
const REFERENCE_HELP = 'Load a voice_loopback recording of this source to check the simulation against it.';

function setReferenceStatus(text, level = '') {
  if (!els.referenceStatus) return;
  els.referenceStatus.textContent = text;
  els.referenceStatus.className = `reference-status${level ? ` ${level}` : ''}`;
}

function takeChannel(decoded, channel) {
  if (decoded.numberOfChannels < 2 || channel === 'mix') return TF2Audio.bufferToMono(decoded);
  return decoded.getChannelData(channel === 'right' ? 1 : 0).slice();
}

// Where the gate model puts talk spurts, for track(): the profile and
// settings the render uses (the current ones by default).
function takeTrackOptions(o = renderOptions()) {
  const profile = CODEC_PROFILES[o.codec] || CODEC_PROFILES.steam;
  const on = o.enableWarble !== false && (o.gate == null ? !!profile.senderGate : o.gate);
  if (!on) return {};
  const spec = profile.senderGate || { thresholdDb: -39.5, prerollMs: 120, holdMs: 440 };
  return { gate: { thresholdDb: Number.isFinite(o.gateThresholdDb) ? o.gateThresholdDb : spec.thresholdDb,
    prerollMs: spec.prerollMs, holdMs: spec.holdMs }, micGain: o.micGain };
}

// The render the take is lined up against (track()'s options.reference):
// the current one, unless it has random loss or jitter, whose concealment
// the take does not share.
function renderGuide() {
  const info = state.lastCodecInfo;
  if (!state.processedBuffer || !info || info.lostFrames || info.underrunFrames) return null;
  return { samples: state.processedBuffer, rate: state.processedRate, frames: info.frameLog || null };
}

// The search and the warp, in a worker when there is one. The aligned take
// keeps the take's sample rate and runs the length of the source.
function locateTake(take, takeRate, source, sourceRate, onProgress) {
  const length = Math.round(source.length / sourceRate * takeRate), options = takeTrackOptions();
  const guide = renderGuide();
  if (guide) options.reference = guide;
  if (canUseWorker()) {
    const t = take.slice(), s = source.slice();
    if (guide) options.reference = { ...guide, samples: guide.samples.slice() };
    return startWorker({ type: 'locate', take: t.buffer, takeRate, source: s.buffer, sourceRate, length, options }, [t.buffer, s.buffer], onProgress)
      .promise.then(reply => ({ timeline: reply.timeline, aligned: new Float32Array(reply.aligned) }));
  }
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      const timeline = TF2Reference.track(take, takeRate, source, sourceRate, options);
      resolve({ timeline, aligned: TF2Reference.warpSegments(take, takeRate, timeline.segments, takeRate, length) });
    } catch (error) { reject(error); }
  }, 0));
}

function compareTakeJob(real, sim, rate) {
  if (canUseWorker()) {
    const r = real.slice(), s = sim.slice();
    return startWorker({ type: 'compareTake', real: r.buffer, sim: s.buffer, rate }, [r.buffer, s.buffer]).promise.then(reply => reply.report);
  }
  return new Promise(resolve => setTimeout(() => resolve(TF2Reference.compareTake(real, sim, rate)), 0));
}

async function loadReferenceTake(file) {
  if (!file || !state.decodedSource) return;
  const job = ++referenceJob;
  try {
    setReferenceStatus(`Decoding ${file.name}…`);
    if (!state.decodeCtx) state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await state.decodeCtx.decodeAudioData(await file.arrayBuffer());
    if (job !== referenceJob) return;
    if (decoded.duration > MAX_AUDIO_SECONDS * 1.5) throw new Error('takes are limited to 15 minutes');
    referenceDecoded = { decoded, name: file.name };
    await alignReferenceTake(job);
  } catch (error) {
    if (job === referenceJob) setReferenceStatus(`Could not use ${file.name}: ${error.message}`, 'reference-bad');
  }
}

async function alignReferenceTake(job = ++referenceJob) {
  if (!referenceDecoded || !state.decodedSource) return;
  const { decoded, name } = referenceDecoded;
  const take = takeChannel(decoded, els.referenceChannel ? els.referenceChannel.value : 'mix'), rate = decoded.sampleRate;
  // The source as the game's microphone got it (the gate model needs that).
  const source = captureSource(state.decodedSource, renderOptions().captureChannel).getChannelData(0), sourceRate = state.decodedSource.sampleRate;
  setReferenceStatus(`Finding the source in ${name}…`);
  try {
    const { timeline, aligned } = await locateTake(take, rate, source, sourceRate,
      (value) => { if (job === referenceJob) setReferenceStatus(`Finding the source in ${name}… ${Math.round(value * 100)}%`); });
    if (job !== referenceJob) return;
    clearReferenceTake(false);
    const overlap = timeline.overlap;
    const blob = URL.createObjectURL(TF2Audio.encodeWav(aligned, rate));
    state.realTake = { name, samples: aligned, rate, timeline, overlap, blob };
    if (els.audioReal) {
      els.audioReal.src = blob;
      els.audioReal.muted = state.abMode !== 'real';
      els.audioReal.volume = els.audio.volume;
      els.audioReal.playbackRate = els.audio.playbackRate;
      syncTwins(true);
      if (!els.audio.paused) els.audioReal.play().catch(() => {});
    }
    if (els.referenceClear) els.referenceClear.hidden = false;
    setReferenceStatus(`${name}: ${describeTiming(timeline)} It plays as the third A/B version (B cycles wet, dry, real).`, 'reference-good');
    const first = timeline.segments[0];
    logLine(`Reference: aligned "${name}" in ${timeline.segments.length} segment${timeline.segments.length === 1 ? '' : 's'} `
      + `(delay ${first.delayMs.toFixed(1)} ms first, clock ${first.clockPpm.toFixed(1)} ppm, ${timeline.points} windows, r ${timeline.correlation.toFixed(3)})`, 'sys');
    updateReferenceReport();
    updateMeter();
    refreshVisualizer();
  } catch (error) {
    if (job === referenceJob) setReferenceStatus(`Could not align ${name}: ${error.message}`, 'reference-bad');
  }
}

// The take's timing against the source, in words: TF2's receiver re-times
// talk spurts and trims latency in 256-sample (5.8 ms) skips.
function describeTiming(timeline) {
  const segs = timeline.segments;
  // Delay: take time minus source time (negative when the take starts
  // after the source does).
  const fmt = (ms) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)} s`;
  const delays = segs.map(g => g.delayMs);
  const steps = delays.slice(1).map((d, i) => d - delays[i]);
  const trims = steps.filter(d => Math.abs(Math.abs(d) - 1000 * 256 / 44100) < 0.8).length;
  const clock = segs[0].clockPpm;
  const spurts = timeline.spurts || 1;
  let text = segs.length === 1 ? `delay ${fmt(delays[0])} (take minus source)`
    : `${spurts} talk spurt${spurts === 1 ? '' : 's'} in ${segs.length} segments, delay ${fmt(Math.min(...delays))} to ${fmt(Math.max(...delays))}`
      + ` (take minus source; ${trims} 5.8 ms latency trim${trims === 1 ? '' : 's'}, ${steps.length - trims} other re-timing${steps.length - trims === 1 ? '' : 's'})`;
  text += `, clock ${clock >= 0 ? '+' : '−'}${Math.abs(clock).toFixed(0)} ppm, correlation ${timeline.correlation.toFixed(2)}${timeline.polarity < 0 ? ', polarity inverted' : ''}`
    + `${timeline.guided ? ', lined up against the render' : ''}.`;
  return text;
}

// Remove the aligned take (and, unless keepFile, forget the decoded file).
function clearReferenceTake(forget = true) {
  if (state.realTake) URL.revokeObjectURL(state.realTake.blob);
  const had = !!state.realTake;
  state.realTake = null;
  if (els.audioReal) { els.audioReal.pause(); els.audioReal.removeAttribute('src'); els.audioReal.load(); }
  if (state.abMode === 'real') {
    state.abMode = 'wet';
    setAbMutes();
    els.abToggle.textContent = AB_LABELS.wet;
  }
  if (els.referenceReport) { els.referenceReport.hidden = true; els.referenceReport.replaceChildren(); }
  if (forget) {
    ++referenceJob;
    referenceDecoded = null;
    if (els.referenceFile) els.referenceFile.value = '';
    if (els.referenceClear) els.referenceClear.hidden = true;
    setReferenceStatus(REFERENCE_HELP);
    if (had) { updateMeter(); refreshVisualizer(); }
  }
}

const BAND_LABELS = ['40–80', '80–120', '120–200', '200–300', '300–500', '0.5–1k', '1–2k', '2–3k', '3–5k', '5–8k', '8–10k', '10–11k', '11–12k', '12–16k', '16–19k'];

// The simulation against the take over the part of the source the take covers.
async function updateReferenceReport() {
  const take = state.realTake, box = els.referenceReport;
  if (!box) return;
  box.hidden = !take;
  if (!take) return;
  const note = (text) => { const p = document.createElement('p'); p.textContent = text; return p; };
  if (!state.processedBuffer) { box.replaceChildren(note('Render the source to compare the simulation with the take.')); return; }
  const job = ++reportJob;
  box.replaceChildren(note('Comparing the render with the take…'));
  const sim = state.processedBuffer, rate = state.processedRate;
  const real = take.rate === rate ? take.samples : TF2Audio.resampleSinc(take.samples, take.rate, rate);
  const from = Math.max(0, Math.round(take.overlap.t0 * rate)), to = Math.min(sim.length, real.length, Math.round(take.overlap.t1 * rate));
  let report;
  try {
    if (to - from < rate) throw new Error('the take overlaps the source by less than a second');
    report = await compareTakeJob(real.subarray(from, to), sim.subarray(from, to), rate);
  } catch (error) {
    if (job === reportJob) box.replaceChildren(note(`Could not compare: ${error.message}`));
    return;
  }
  if (job !== reportJob || take !== state.realTake) return;
  const table = document.createElement('table');
  table.className = 'reference-bands';
  const caption = document.createElement('caption');
  caption.textContent = `Simulation minus take per band, dB, with the two level-matched at 300 Hz–3 kHz (${formatTime(take.overlap.t0, 1)}–${formatTime(take.overlap.t1, 1)})`;
  const head = document.createElement('tr'), body = document.createElement('tr');
  const cell = (tag, text, cls = '', title = '') => { const c = document.createElement(tag); c.textContent = text; if (cls) c.className = cls; if (title) c.title = title; return c; };
  head.append(cell('th', 'Hz'));
  body.append(cell('th', 'Δ', '', 'simulation minus take'));
  (report.bands || []).forEach((band, i) => {
    head.append(cell('th', BAND_LABELS[i] || band.hz));
    const d = band.simMinusRealDb;
    body.append(d === null ? cell('td', '—') : cell('td', `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`,
      Math.abs(d) <= 1.5 ? 'ref-good' : Math.abs(d) <= 3 ? 'ref-warn' : 'ref-bad'));
  });
  const thead = document.createElement('thead'), tbody = document.createElement('tbody');
  thead.append(head); tbody.append(body);
  table.append(caption, thead, tbody);
  const parts = [];
  const lt = report.levelTracking;
  if (lt) parts.push(`Short-term level: ${lt.rmsDeviationDb.toFixed(1)} dB rms apart, worst ${lt.worstDeviationDb.toFixed(1)} dB, r ${lt.correlation === null ? '—' : lt.correlation.toFixed(2)} (${lt.blocks} blocks of 0.5 s).`);
  const clip = report.clip || {};
  const sig = (s) => `ceiling ${s.ceilingDbfs.toFixed(1)} dBFS, ${s.clippedPercent.toFixed(1)}% at it, mean/ceiling ${s.meanOverCeiling.toFixed(2)}`;
  if (clip.real && clip.sim) parts.push(`Clipping: take ${sig(clip.real)}; simulation ${sig(clip.sim)}.`);
  if (Number.isFinite(report.anchorGainDb)) {
    const g = report.anchorGainDb;
    parts.push(`Level at 300 Hz–3 kHz: the simulation is ${Math.abs(g).toFixed(1)} dB ${g >= 0 ? 'louder' : 'quieter'} (volume and voice_scale set this).`);
  }
  box.replaceChildren(table, ...parts.map(note));
}

if (els.referenceFile) els.referenceFile.addEventListener('change', () => loadReferenceTake(els.referenceFile.files[0]));
if (els.referenceChannel) els.referenceChannel.addEventListener('change', () => { if (referenceDecoded) alignReferenceTake(); });
if (els.referenceClear) els.referenceClear.addEventListener('click', () => clearReferenceTake());
setReferenceStatus(REFERENCE_HELP);
