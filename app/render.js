/* TF2 Voice Emulator, app/render.js: Rendering, download formats, the video download and the A/B toggle.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

/* ------------------------------------------------------------------ */
/* Process button                                                     */
/* ------------------------------------------------------------------ */

if (els.advancedToggle) {
  els.advancedToggle.addEventListener('click', () => showAdvanced(!document.body.classList.contains('advanced')));
}
if (els.consoleDetails) {
  els.consoleDetails.addEventListener('toggle', () => {
    els.conOut.setAttribute('aria-live', els.consoleDetails.open ? 'polite' : 'off');
  });
}

// Whether jobs can run in audio-worker.js (not from file://).
function canUseWorker() {
  return typeof Worker !== 'undefined' && location.protocol !== 'file:';
}

// One job in a dedicated worker. Returns { promise, cancel }: the promise
// resolves with the worker's reply; cancel() terminates the worker and
// rejects with an AbortError.
function startWorker(message, transfer, onProgress) {
  const worker = new Worker('audio-worker.js');
  const id = ++state.processId;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const finish = () => { done = true; worker.terminate(); };
    cancel = () => {
      if (done) return;
      finish();
      const error = new Error('Audio processing cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    worker.onmessage = (event) => {
      const reply = event.data || {};
      if (reply.id !== id || done) return;
      if (reply.type === 'progress') {
        if (onProgress) onProgress(reply.value);
      } else if (reply.type === 'error') {
        finish();
        reject(new Error(reply.message || 'Audio worker failed.'));
      } else {
        finish();
        resolve(reply);
      }
    };
    worker.onerror = (event) => {
      if (done) return;
      finish();
      reject(new Error(event.message || 'Audio worker could not start.'));
    };
    worker.postMessage({ ...message, id }, transfer);
  });
  return { promise, cancel };
}

// One render in a dedicated worker, as { promise, cancel }. The result
// carries the render's loudness and levels (meter.js) as `stats`.
function startWorkerJob(source, opts) {
  const mono = source.getChannelData(0).slice();
  const workerOpts = { ...opts };
  delete workerOpts.onProgress;
  const job = startWorker({ type: 'process', sampleRate: source.sampleRate, samples: mono.buffer, opts: workerOpts, measure: true },
    [mono.buffer], opts.onProgress);
  return {
    cancel: job.cancel,
    promise: job.promise.then((reply) => ({
      samples: new Float32Array(reply.samples),
      sampleRate: reply.sampleRate,
      blob: reply.blob,
      realOpus: reply.realOpus,
      codecInfo: reply.codecInfo,
      stats: reply.stats
    }))
  };
}

function processInWorker(source, opts) {
  const job = startWorkerJob(source, opts);
  state.cancelProcessing = job.cancel;
  return job.promise.finally(() => {
    if (state.cancelProcessing === job.cancel) state.cancelProcessing = null;
  });
}

function describeModes(modes) {
  if (!modes) return 'modes unknown';
  const total = modes.silk + modes.hybrid + modes.celt;
  const parts = Object.entries(modes).filter(([, n]) => n > 0)
    .map(([mode, n]) => `${mode.toUpperCase()} ${Math.round(100 * n / Math.max(1, total))}%`);
  return parts.length ? parts.join(', ') : 'no packets';
}

// The mono signal the game's microphone input receives from the source.
function captureSource(source, channel) {
  if (!source.left || channel === 'mix') return source;
  const mix = source.getChannelData(0), left = source.left;
  let mono = left;
  if (channel === 'right') {
    mono = new Float32Array(mix.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 2 * mix[i] - left[i];
  }
  return { sampleRate: source.sampleRate, duration: source.duration, length: mono.length, numberOfChannels: 1, getChannelData: () => mono };
}

// The render settings of the current controls (everything but progress).
function renderOptions() {
  const posKey = els.position.value;
  const dspRoomId = parseInt(els.env.value);
  return {
    codec: els.codec.value,
    // If user chose 'manual', respect the dsp_room dropdown; otherwise use listener position.
    listenerPos: (posKey === 'manual') ? null : posKey,
    dspRoom: dspRoomId,
    customEnv: (dspRoomId === 99) ? {
      duration: Number(els.cDur.value),
      decay:    Number(els.cDec.value),
      mix:      Number(els.cMix.value) / 100
    } : null,
    captureChannel: els.captureChannel.value,
    micGain:     Number(els.gain.value),
    voiceScale:  Number(els.voiceScale.value),
    hp:          Number(els.hp.value),
    lp:          Number(els.lp.value),
    bits:        Number(els.bits.value),
    agc:         els.agc.value === '1',
    retime:      !!els.retime && els.retime.value === '1',
    maxGain:     Number(els.maxGain.value),
    avgGain:     Number(els.avgGain.value),
    gate:        els.vad.value === 'auto' ? null : els.vad.value === '1',
    gateThresholdDb: Number(els.vadThreshold.value),
    volume:      Number(els.volume.value),
    lossPct:     Number(els.loss.value),
    frameMs:     Number(els.frameMs.value),
    enableWarble: els.warble.value === '1',
    jitterMs:    Number(els.jitter.value)
  };
}

async function runAudioProcess(source, opts) {
  source = captureSource(source, opts.captureChannel);
  if (canUseWorker()) {
    try {
      return await processInWorker(source, opts);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      logLine(`Audio worker unavailable; using compatibility path (${error.message})`, 'warn');
    }
  }
  state.cancelProcessing = null;
  if (els.cancel) els.cancel.hidden = true;
  return TF2Audio.process(source, opts);
}

// Download name for a render of `sourceName` with codec profile `codecKey`.
function outputName(sourceName, codecKey, ext = 'wav') {
  const base = (sourceName || 'clip').replace(/\.[^/.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return `${base}_tf2_${codecKey}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* Download formats (formats.js): WAV, FLAC, MP3                      */
/* ------------------------------------------------------------------ */

function currentFormat() {
  const key = els.format ? els.format.value : 'wav';
  return TF2Formats.FORMATS[key] ? key : 'wav';
}

// The file for `format` made from a rendered WAV blob, as { blob, crc }
// (crc: CRC-32 for ZIP archives). Runs in a worker when it can.
async function exportWav(wavBlob, format) {
  const { mime } = TF2Formats.FORMATS[format];
  const wav = await wavBlob.arrayBuffer();
  if (canUseWorker()) {
    const reply = await startWorker({ type: 'export', wav, format }, [wav]).promise;
    return { blob: new Blob([reply.bytes], { type: mime }), crc: reply.crc };
  }
  const bytes = await TF2Formats.fromWav(new Uint8Array(wav), format);
  return { blob: new Blob([bytes], { type: mime }), crc: TF2Zip.crc32(bytes) };
}

// exportWav with the result kept per format in `cache`; a failure is not kept.
function cachedExport(cache, wavBlob, format) {
  if (!cache[format]) {
    cache[format] = exportWav(wavBlob, format);
    cache[format].catch(() => { delete cache[format]; });
  }
  return cache[format];
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function updateDownloadLabel() {
  if (els.dl && !els.dl.dataset.busy) els.dl.textContent = `Download ${TF2Formats.FORMATS[currentFormat()].label}`;
}

if (els.format) {
  const saved = LS.get('tf2ve_format', 'wav');
  if (TF2Formats.FORMATS[saved]) els.format.value = saved;
  els.format.addEventListener('change', () => {
    LS.set('tf2ve_format', currentFormat());
    updateDownloadLabel();
    document.dispatchEvent(new Event('tf2:format'));
  });
  updateDownloadLabel();
}

// Show a finished render: console report, preview players (wet plus the muted
// dry twin for A/B), download name, visualizer and status.
function presentRender({ samples, sampleRate, blob, realOpus, codecInfo, stats }, took, codecKey) {
  // Report the actual processing path: codec version, bitrate and the
  // Opus modes the encoder really chose.
  logLine(realOpus
    ? `S_Voice: ${codecInfo.version}, ${codecInfo.bitrate / 1000} kbps ${codecInfo.vbr ? 'VBR' : 'CBR'}${codecInfo.dtx ? ' + DTX' : ''}, `
      + `${codecInfo.packetBytes ? `${codecInfo.packetBytes}-byte packets of ` : ''}${+(codecInfo.frameMs || 20).toFixed(1)} ms, native PLC (${describeModes(codecInfo.modes)})`
    : 'S_Voice: codec bypassed', 'sys');
  if (realOpus && codecInfo.gate != null) {
    const held = codecInfo.frames ? Math.round(100 * codecInfo.gatedFrames / codecInfo.frames) : 0;
    logLine(`S_Voice: voice gate at ${codecInfo.gate} dBFS sent ${codecInfo.spurts} talk spurt${codecInfo.spurts === 1 ? '' : 's'} and held back ${codecInfo.gatedFrames} of ${codecInfo.frames} frames (${held}%)`, 'sys');
  }
  if (realOpus && codecInfo.dtxFrames) {
    logLine(`S_Voice: ${codecInfo.dtxFrames} inactive frames sent as DTX comfort noise`, 'sys');
  }
  if (realOpus && (codecInfo.lostFrames || codecInfo.underrunFrames)) {
    logLine(`S_Voice: ${codecInfo.lostFrames} frames lost and concealed, ${codecInfo.underrunFrames || 0} late frames played as silence`, 'sys');
  }
  logLine(`S_Voice: receiver auto-gain ${codecInfo.autoGain ? 'on' : 'off'} at ${codecInfo.voiceRate} Hz`, 'sys');

  state.processedBuffer = samples;
  state.processedRate   = sampleRate;
  if (stats) meterResults.set(bufferId(samples), Promise.resolve(stats));
  if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
  state.lastBlob = URL.createObjectURL(blob);
  state.lastWav = blob;
  state.lastExports = {};

  // Default to wet after a new render; arm the muted dry twin so the
  // A/B toggle is an instant unmute rather than a src swap.
  state.abMode = 'wet';
  els.abToggle.disabled = false;
  els.abToggle.textContent = 'A/B: Wet';

  els.audio.src = state.lastBlob;
  els.audio.muted = false;
  if (els.audioDry) {
    els.audioDry.src = state.dryBlob;
    els.audioDry.muted = true;
    els.audioDry.volume = els.audio.volume;
  }
  if (els.audioReal) els.audioReal.muted = true;
  state.lastCodecKey = codecKey;
  els.dl.disabled = false;

  state.renderId++;
  state.lastCodecInfo = codecInfo;
  updateVideoButton();
  // A re-render of the same source keeps the view, band and selection.
  refreshVisualizer();
  updateMeter();
  // A loaded take lines up better against the render than against the
  // source (comfort noise, low tones); re-align it when the render allows.
  if (referenceDecoded && renderGuide()) alignReferenceTake();
  else updateReferenceReport();
  const method = realOpus ? `Real Opus · ${codecInfo.bitrate / 1000} kbps` : 'Codec bypassed';
  setStatus(`Ready · ${method} · ${(took / 1000).toFixed(1)}s render · ${sampleRate.toLocaleString()} Hz`, 'success');
  logLine(`ChangeLevel: rendered ${samples.length} samples @ ${sampleRate}Hz in ${took}ms`, 'sys');
  logLine(`Net_SendPacket: reliable stream ready.`);
}

// A recorded live-monitor session (live.js): the microphone becomes the
// source and the voice the render, already lined up by the live worker, so
// A/B, the views, the meter and downloads work as after a render. Rendering
// again replaces the voice with an offline render of the same microphone.
function mountLiveTake({ dry, wet, rate, frameLog, counts, info }) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  mountSource(dry, rate, `live-${stamp}`);
  const codecRate = (CODEC_PROFILES[info.codec] || CODEC_PROFILES.steam).codecRate, frameSamples = info.frameSamples || codecRate / 50;
  const codecInfo = { backend: info.realOpus ? 'libopus' : 'bypass', version: info.version || 'bypass', bitrate: info.bitrate,
    vbr: info.vbr, dtx: info.dtx, modes: counts.modes, gate: info.gate, spurts: counts.spurts, gatedFrames: counts.gated,
    frames: counts.frames, dtxFrames: counts.dtx, lostFrames: counts.lost, underrunFrames: counts.late,
    autoGain: info.autoGain, voiceRate: info.voiceRate, codec: info.codec, live: true,
    // One code per codec frame of the recording, from its start.
    frameLog, frameSamples, sampleRate: codecRate, lookahead: 0, frameMs: 1000 * frameSamples / codecRate, framesPerPacket: 1 };
  logLine(`voice_record: live take of ${(dry.length / rate).toFixed(1)} s loaded (${counts.spurts} talk spurt${counts.spurts === 1 ? '' : 's'}).`, 'sys');
  presentRender({ samples: wet, sampleRate: rate, blob: TF2Audio.encodeWav(wet, rate), realOpus: !!info.realOpus, codecInfo }, 0, info.codec || 'steam');
}

if (els.cancel) els.cancel.addEventListener('click', () => {
  if (state.cancelProcessing) state.cancelProcessing();
});

if (els.dl) els.dl.addEventListener('click', async () => {
  if (!state.lastWav || els.dl.disabled) return;
  const format = currentFormat(), wav = state.lastWav;
  const { ext, label } = TF2Formats.FORMATS[format];
  const name = outputName(state.sourceName, state.lastCodecKey, ext);
  if (format === 'wav') { saveBlob(wav, name); return; }
  els.dl.disabled = true;
  els.dl.dataset.busy = '1';
  els.dl.textContent = `Encoding ${label}…`;
  try {
    const { blob } = await cachedExport(state.lastExports, wav, format);
    // Skip the save if a new render or source replaced this one meanwhile.
    if (state.lastWav === wav) saveBlob(blob, name);
    logLine(`Host_WriteFile: ${name} (${(blob.size / 1048576).toFixed(1)} MB)`, 'sys');
  } catch (e) {
    logLine(`${label} export failed: ${e.message}`, 'err');
    setStatus(`Could not make the ${label} file: ${e.message}`, 'error');
  } finally {
    delete els.dl.dataset.busy;
    updateDownloadLabel();
    els.dl.disabled = !state.lastWav || state.processing;
  }
});

els.process.addEventListener('click', async () => {
  if (!state.decodedSource) { logLine('No decoded audio — select a file first.', 'err'); return; }
  if (state.processing || state.batchRunning) return;
  state.processing = true;
  document.dispatchEvent(new Event('tf2:busy'));
  els.process.disabled = true;
  els.dl.disabled = true;
  els.file.disabled = true;
  if (els.mic) els.mic.disabled = true;
  if (els.controls) els.controls.inert = true;
  if (els.cancel) els.cancel.hidden = false;
  if (els.progress) { els.progress.hidden = false; els.progress.value = 0; }
  setStatus(`Processing ${state.decodedSource.duration.toFixed(1)}s of audio in the background…`);
  logLine(`S_StartSound: initializing render...`);

  try {
    // A demo's voice arrives already coded: only the receiver runs, with the
    // demo's own codec (audio.js opts.received).
    const demo = state.sourceDemo;
    const codecKey = demo ? demo.codecKey : els.codec.value;
    const opts = {
      ...renderOptions(),
      ...(demo ? { codec: demo.codecKey, received: demo.received } : {}),
      onProgress:  (p) => {
        const percent = Math.min(100, Math.max(0, Math.round(p * 100)));
        els.process.textContent = `Processing… ${percent}%`;
        if (els.progress) els.progress.value = percent;
      }
    };

    logLine(demo ? `MIX: demo voice as received, codec=${opts.codec}, receiver only; vs=${opts.voiceScale}`
      : `MIX: codec=${opts.codec} pos=${opts.listenerPos || 'manual:'+opts.dspRoom} gain=${opts.micGain} vs=${opts.voiceScale}`);

    const t0 = performance.now();
    const result = await runAudioProcess(state.decodedSource, opts);
    const took = Math.round(performance.now() - t0);

    presentRender(result, took, codecKey);
  } catch (e) {
    if (e.name === 'AbortError') {
      logLine('S_StopSound: render cancelled.', 'warn');
      setStatus('Processing cancelled. Your source audio is still loaded.');
    } else {
      console.error(e);
      logLine(`render failed: ${e.message}`, 'err');
      setStatus(`Processing failed: ${e.message}`, 'error');
    }
  } finally {
    state.processing = false;
    state.cancelProcessing = null;
    els.process.disabled = false;
    els.dl.disabled = !state.lastWav;
    els.file.disabled = false;
    if (els.mic) els.mic.disabled = false;
    if (els.controls) els.controls.inert = false;
    els.process.textContent = 'Process Audio';
    if (els.cancel) els.cancel.hidden = true;
    if (els.progress) els.progress.hidden = true;
    document.dispatchEvent(new Event('tf2:busy'));
  }
});

/* ------------------------------------------------------------------ */
/* A/B toggle                                                         */
/* ------------------------------------------------------------------ */

// A/B cycles wet, dry and, with a real take loaded, real. All versions play
// in sync; switching is an instant mute swap, with no re-buffering.
const AB_LABELS = { wet: 'A/B: Wet', dry: 'A/B: Dry', real: 'A/B: Real' };
function setAbMutes() {
  els.audio.muted = state.abMode !== 'wet';
  if (els.audioDry) els.audioDry.muted = state.abMode !== 'dry';
  if (els.audioReal) els.audioReal.muted = state.abMode !== 'real';
}
els.abToggle.addEventListener('click', () => {
  if (!state.lastBlob || !state.dryBlob || !els.audioDry) return;
  const modes = ['wet', 'dry', ...(state.realTake && els.audioReal ? ['real'] : [])];
  state.abMode = modes[(modes.indexOf(state.abMode) + 1) % modes.length];
  setAbMutes();
  syncTwins(true);
  els.abToggle.textContent = AB_LABELS[state.abMode];
  refreshVisualizer();
});

// The hidden twins of the main (wet) player: the dry source and the real take.
const twins = () => [els.audioDry, els.audioReal].filter(el => el && el.src);
// Keep the twins locked to the main transport.
function syncTwins(force = false) {
  for (const el of twins()) {
    const d = el.duration;
    const t = Math.min(els.audio.currentTime, isFinite(d) && d > 0 ? Math.max(0, d - 0.01) : els.audio.currentTime);
    try {
      if (force || Math.abs(el.currentTime - t) > 0.02) el.currentTime = t;
    } catch (e) { /* metadata not ready yet */ }
  }
}

els.audio.addEventListener('volumechange', () => { for (const el of [els.audioDry, els.audioReal]) if (el) el.volume = els.audio.volume; });
els.audio.addEventListener('ratechange', () => { for (const el of [els.audioDry, els.audioReal]) if (el) el.playbackRate = els.audio.playbackRate; });
