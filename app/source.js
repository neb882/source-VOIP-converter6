/* TF2 Voice Emulator, app/source.js: Loading the source (file, video or microphone) and input handling.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

/* ------------------------------------------------------------------ */
/* Source loading (file or microphone)                                */
/* ------------------------------------------------------------------ */

// `mono` is the L+R mix used for display and the dry A/B; stereo sources also
// keep their left channel so the render can capture it like a stereo cable.
function mountSource(mono, sampleRate, name, left = null) {
  const duration = mono.length / sampleRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('the clip has no decodable audio');
  if (duration > MAX_AUDIO_SECONDS) throw new Error('the clip exceeds the 10 minute limit');
  state.sourceName = name;
  state.sourceVideo = null;
  state.sourceDemo = null;
  if (els.demoSpeaker) els.demoSpeaker.hidden = true;
  updateVideoButton();
  if (state.dryBlob) URL.revokeObjectURL(state.dryBlob);
  if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
  state.lastBlob = null;
  state.lastWav = null;
  state.lastExports = {};
  state.processedBuffer = null;
  state.decodedSource = { sampleRate, duration, length: mono.length,
    numberOfChannels: 1, getChannelData: () => mono, left };
  state.dryBlob = URL.createObjectURL(TF2Audio.encodeWav(mono, sampleRate));
  els.process.disabled = false;
  els.dl.disabled = true;
  els.audio.pause();
  els.audio.removeAttribute('src');
  els.audio.load();
  if (els.audioDry) { els.audioDry.pause(); els.audioDry.removeAttribute('src'); els.audioDry.load(); }
  clearReferenceTake();
  if (els.reference) els.reference.hidden = false;
  els.abToggle.disabled = true;
  els.abToggle.textContent = 'A/B: Wet';
  state.abMode = 'wet';
  state.lastCodecInfo = null;
  resetVizView();
  refreshVisualizer();
  updateMeter();
  setStatus(`${name} · ${duration.toFixed(1)}s · ${sampleRate.toLocaleString()} Hz`, 'success');
  logLine(`FS_MountFile: "${name}" (${duration.toFixed(1)}s) mounted.`, 'sys');
  updateSignalChain();
}

let sourceLoadId = 0;
// Resolves true once the clip is the source (false if a newer one took over
// or it failed).
async function loadSourceFromArrayBuffer(ab, name) {
  const id = ++sourceLoadId;
  els.process.disabled = true;
  try {
    setStatus(`Decoding ${name}…`);
    if (!state.decodeCtx) state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await state.decodeCtx.decodeAudioData(ab);
    if (id !== sourceLoadId) return false; // A newer selection superseded this decode.
    if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error('the clip exceeds the 10 minute limit');
    mountSource(TF2Audio.bufferToMono(decoded), decoded.sampleRate, name,
      decoded.numberOfChannels > 1 ? decoded.getChannelData(0).slice() : null);
    return true;
  } catch (e) {
    if (id !== sourceLoadId) return false;
    logLine(`decodeAudioData failed: ${e.message}`, 'err');
    setStatus(`Could not load audio: ${e.message}`, 'error');
    state.decodedSource = null;
    els.process.disabled = true;
    return false;
  }
}

async function startRecord() {
  if (state.recorder || state.processing) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
    setStatus('Uncompressed microphone capture requires HTTPS or localhost and AudioWorklet support.', 'error');
    return;
  }
  const session = { stop: () => { session.stopRequested = true; } };
  state.recorder = session;
  ++sourceLoadId;
  els.process.disabled = true;
  els.file.disabled = true;
  els.mic.textContent = '⏹ Connecting…';
  let stream, context, source, capture, finished = false;
  const parts = [];
  const cleanup = async () => {
    if (finished) return;
    finished = true;
    stream?.getTracks().forEach(t => t.stop());
    source?.disconnect();
    capture?.disconnect();
    if (context && context.state !== 'closed') await context.close();
    if (state.recorder === session) state.recorder = null;
    clearInterval(state.recTick); state.recTick = null;
    els.mic.textContent = '🎤 Record';
    els.mic.classList.remove('recording');
    els.file.disabled = false;
    els.process.disabled = !state.decodedSource;
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    context = new (window.AudioContext || window.webkitAudioContext)();
    await context.audioWorklet.addModule('mic-capture.js');
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'mic-capture', {
      processorOptions: { maxSamples: MAX_RECORDING_SECONDS * context.sampleRate }
    });
    capture.onprocessorerror = async () => {
      await cleanup();
      setStatus('Microphone capture failed. Please record again.', 'error');
    };
    capture.port.onmessage = async e => {
      if (finished) return;
      if (e.data.type === 'samples') parts.push(e.data.data);
      if (e.data.type === 'complete') {
        const rate = context.sampleRate;
        await cleanup();
        const length = parts.reduce((sum, part) => sum + part.length, 0);
        if (!length) { setStatus('The microphone recording was empty.', 'error'); return; }
        const mono = new Float32Array(length);
        let offset = 0;
        for (const part of parts) { mono.set(part, offset); offset += part.length; }
        mountSource(mono, rate, 'microphone');
      }
    };
    source.connect(capture);
    capture.connect(context.destination); // Worklet outputs silence, never live mic monitoring.
    session.stop = () => { capture.port.postMessage('stop'); };
    await context.resume();
    if (session.stopRequested) session.stop();
    const started = performance.now();
    els.mic.classList.add('recording');
    state.recTick = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      els.mic.textContent = `⏹ ${elapsed.toFixed(0)}s`;
      if (elapsed >= MAX_RECORDING_SECONDS) session.stop();
    }, 250);
    setStatus('Recording uncompressed audio…');
    logLine('+voicerecord (PCM capture)', 'cmd');
  } catch (e) {
    await cleanup();
    setStatus(`Microphone unavailable: ${e.message}`, 'error');
    logLine(`VoiceRecord: ${e.message}`, 'err');
  }
}

function stopRecord() {
  if (state.recorder) state.recorder.stop();
}

if (els.mic) els.mic.addEventListener('click', () => {
  if (state.recorder) stopRecord(); else startRecord();
});

/* ------------------------------------------------------------------ */
/* Input handling                                                     */
/* ------------------------------------------------------------------ */

function cvarValue(name) {
  const c = cvars[name];
  if (!c) return null;
  if (c.link) { const el = document.getElementById(c.link); return el ? String(el.value) : null; }
  return c.val !== undefined ? String(c.val) : null;
}

function consoleMatches(prefix) {
  const p = prefix.toLowerCase();
  return [...new Set([...Object.keys(cvars), ...Object.keys(aliases)])].filter(k => k.startsWith(p)).sort();
}

function showHint(typed, rest) {
  const spacer = document.createElement('span');
  spacer.style.color = 'transparent';
  spacer.textContent = typed;
  els.conHint.append(spacer, document.createTextNode(rest));
}

// Grey inline hint: the first completion while typing a name, then the
// current value (or usage) once a known command is followed by a space.
function updateConsoleHint() {
  const val = els.conIn.value;
  els.conHint.replaceChildren();
  const argStart = /^(\S+) $/.exec(val);
  if (argStart && cvars[argStart[1].toLowerCase()]) {
    const name = argStart[1].toLowerCase(), c = cvars[name], current = cvarValue(name);
    const usage = c.usage ? c.usage.replace(/^\S+\s*/, '') : '';
    if (current !== null) showHint(val, `${current}   (current)`);
    else if (usage) showHint(val, usage);
  } else if (val && !/\s/.test(val)) {
    const match = consoleMatches(val)[0];
    if (match && match.length > val.length) showHint(val, match.substring(val.length));
  }
  updateCompleteBtn();
}
els.conIn.addEventListener('input', updateConsoleHint);

// Show the ⇥ tap-complete button whenever a completion is possible (touch
// keyboards have no Tab key).
function updateCompleteBtn() {
  if (!els.conComplete) return;
  const val = els.conIn.value;
  els.conComplete.style.display = val && !/\s/.test(val) && consoleMatches(val).length ? 'block' : 'none';
}

// Source-style Tab: complete a unique name, otherwise extend to the longest
// common prefix, otherwise list the candidates with their current values.
function completeConsole() {
  const val = els.conIn.value;
  if (!val || /\s/.test(val)) return;
  const matches = consoleMatches(val);
  if (matches.length === 1) {
    els.conIn.value = matches[0] + ' ';
  } else if (matches.length > 1) {
    let prefix = matches[0];
    for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > val.length) els.conIn.value = prefix;
    else {
      logLine(`] ${val}`, 'text');
      for (const m of matches.slice(0, 24)) {
        const value = cvarValue(m);
        logLine(`  ${m}${value !== null ? ` = "${value}"` : aliases[m] ? ' (alias)' : ''}`, 'help');
      }
      if (matches.length > 24) logLine(`  ... ${matches.length - 24} more`, 'help');
    }
  }
  updateConsoleHint();
  els.conIn.focus();
}

if (els.conComplete) els.conComplete.addEventListener('click', completeConsole);

els.conIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = els.conIn.value;
    if (val) {
      state.cmdHistory.push(val);
      if (state.cmdHistory.length > 50) state.cmdHistory.shift();
      state.cmdIndex = state.cmdHistory.length;
      LS.set('tf2ve_history', state.cmdHistory);
      execCommand(val);
      els.conIn.value = '';
      updateConsoleHint();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.cmdIndex > 0) {
      state.cmdIndex--; els.conIn.value = state.cmdHistory[state.cmdIndex];
      els.conIn.dispatchEvent(new Event('input'));
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.cmdIndex < state.cmdHistory.length - 1) {
      state.cmdIndex++; els.conIn.value = state.cmdHistory[state.cmdIndex];
      els.conIn.dispatchEvent(new Event('input'));
    } else {
      state.cmdIndex = state.cmdHistory.length; els.conIn.value = ''; updateConsoleHint();
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    completeConsole();
  }
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => { const cmd = btn.getAttribute('data-cmd'); if (cmd) execCommand(cmd); });
});

const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|3gp|webm|mkv)$/i.test(f.name);
const isDemoFile = (f) => /\.dem$/i.test(f.name);
// The codec profile whose receiver plays a demo's voice.
const DEMO_PROFILES = { steam: 'steam', vaudio_celt: 'celt_22', vaudio_celt_high: 'celt_44' };

// A TF2 demo: its voice as the game received it (demo.js). The packets are
// decoded here; Process then runs only the receiver (auto-gain, clamp,
// mixer), so the render is what a listener heard, not a second encoding.
async function loadDemoFile(f, speakerId = null) {
  if (f.size > MAX_DEMO_BYTES) {
    setStatus(`Demo is ${(f.size / 1048576).toFixed(0)} MB; the limit is ${MAX_DEMO_BYTES / 1048576} MB.`, 'error');
    return;
  }
  const selection = ++sourceLoadId;
  els.process.disabled = true;
  try {
    setStatus(`Reading ${f.name}…`);
    const parsed = state.sourceDemo && state.sourceDemo.file === f ? state.sourceDemo.parsed : TF2Demo.parse(await f.arrayBuffer());
    if (selection !== sourceLoadId) return;
    const speakers = parsed.speakers.filter(s => s.frames > 0).sort((a, b) => b.frames - a.frames);
    if (!speakers.length) {
      const why = parsed.voice.length ? 'its voice messages carry no audio (a demo made with record keeps only their headers; record with SourceTV)' : 'it has no voice messages';
      throw new Error(why);
    }
    const speaker = speakers.find(s => s.id === speakerId) || speakers[0];
    const codecKey = DEMO_PROFILES[speaker.codec];
    if (!codecKey) throw new Error(`its voice codec ${speaker.codec} is not supported`);
    setStatus(`Decoding ${speaker.frames} voice frames…`);
    // Imports resolve against this script's folder (app/); the codecs are at the root.
    const decoded = await TF2Demo.decode(parsed, speaker, {
      opus: async (rate) => (await import(new URL('vendor/libopus-1.1/index.mjs', document.baseURI).href)).createDecoder({ sampleRate: rate, channels: 1 }),
      celt: async (rate, frame, bytes) => (await import(new URL('vendor/celt-0.11/index.mjs', document.baseURI).href)).createCodec(rate, frame, { packetBytes: bytes })
    });
    if (selection !== sourceLoadId) return;
    // Renders stop at 10 minutes; a longer demo keeps its first 10.
    const keep = Math.min(decoded.samples.length, MAX_AUDIO_SECONDS * decoded.rate);
    const frames = Math.min(decoded.frameLog.length, Math.ceil(keep / decoded.frameSamples));
    if (keep < decoded.samples.length) logLine(`demo: the voice runs ${(decoded.samples.length / decoded.rate / 60).toFixed(1)} minutes; the first 10 are kept.`, 'warn');
    const name = `${f.name.replace(/\.dem$/i, '')}_${speaker.id.replace(/\s+/g, '')}.dem`;
    mountSource(decoded.samples.slice(0, keep), decoded.rate, name);
    state.sourceDemo = { file: f, parsed, speaker, codecKey,
      received: { frameLog: decoded.frameLog.slice(0, frames), frameBytes: decoded.frameBytes.slice(0, frames), frameMs: 1000 * decoded.frameSeconds,
        spurts: decoded.spurts, version: speaker.codec === 'steam' ? 'Steam packets from the demo' : `${speaker.codec} packets from the demo` } };
    els.codec.value = codecKey;
    els.codec.dispatchEvent(new Event('change'));
    updateDemoSpeakers(speakers, speaker);
    const h = parsed.header, kbps = speaker.frames > speaker.dtx ? (speaker.bytes * 8 / (speaker.frames * decoded.frameSeconds) / 1000) : 0;
    logLine(`demo: ${h.server || 'server'} on ${h.map}, ${h.seconds.toFixed(1)} s, voice codec ${speaker.codec}; ${speakers.length} speaker${speakers.length === 1 ? '' : 's'}.`, 'sys');
    logLine(`demo: ${speaker.id}: ${speaker.frames} frames in ${speaker.spurts || '?'} talk spurts, ${speaker.dtx} DTX, ${speaker.lost} lost before the server, ${kbps.toFixed(1)} kbps while talking.`, 'sys');
    setStatus(`${name} · ${(keep / decoded.rate).toFixed(1)}s of voice as sent · Process plays it through TF2's receiver`, 'success');
  } catch (error) {
    if (selection !== sourceLoadId) return;
    setStatus(`Could not read the demo's voice: ${error.message}`, 'error');
    logLine(`demo: ${error.message}`, 'err');
  }
}

function updateDemoSpeakers(speakers, current) {
  if (!els.demoSpeaker) return;
  els.demoSpeaker.hidden = speakers.length < 2;
  els.demoSpeaker.replaceChildren(...speakers.map(s => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} (${s.frames} frames)`;
    o.selected = s === current;
    return o;
  }));
}

if (els.demoSpeaker) els.demoSpeaker.addEventListener('change', () => {
  if (state.sourceDemo) loadDemoFile(state.sourceDemo.file, els.demoSpeaker.value);
});

// Load one file as the source (file picker or a single dropped file). A
// video's audio becomes the source; an MP4 or MOV is also kept, so the render
// can go back into it (video.js).
async function loadSourceFile(f) {
  if (isDemoFile(f)) return loadDemoFile(f);
  const video = isVideoFile(f), limit = video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (f.size > limit) {
    setStatus(`File is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${limit / 1024 / 1024} MB${video ? ' for video' : ''}.`, 'error');
    logLine(`FS_MountFile: file exceeds the ${limit / 1024 / 1024} MB safety limit.`, 'err');
    return;
  }
  const selection = ++sourceLoadId;
  els.process.disabled = true;
  try {
    const bytes = await f.arrayBuffer();
    if (selection !== sourceLoadId) return;
    // Decoding takes the buffer over, so a remuxable video keeps a copy.
    const info = video && window.TF2Video ? TF2Video.inspect(new Uint8Array(bytes)) : null;
    const keep = info && info.video ? bytes.slice(0) : null;
    if (!(await loadSourceFromArrayBuffer(bytes, f.name))) return;
    if (keep) {
      state.sourceVideo = { bytes: keep, name: f.name, info };
      logLine(`FS_MountFile: video (${info.container.toUpperCase()}, ${info.codec}) kept; Download video puts the render back into it.`, 'sys');
      setStatus(`${els.status.textContent} · video: process, then Download video (${info.container.toUpperCase()})`, 'success');
    } else if (video) {
      logLine(`FS_MountFile: ${info && info.note ? info.note : 'only MP4 and MOV videos can take the render back; this one gives its audio only.'}`, 'warn');
      setStatus(`${els.status.textContent} · the video's audio only (only MP4 and MOV can take the render back)`, 'success');
    }
    updateVideoButton();
  } catch (error) {
    if (selection !== sourceLoadId) return;
    setStatus(video ? `Could not read the video's audio: ${error.message}` : `Could not read audio: ${error.message}`, 'error');
    els.process.disabled = !state.decodedSource;
  }
}

// The video download: shown for an MP4 or MOV source, usable after a render.
function updateVideoButton() {
  if (!els.dlVideo) return;
  const video = state.sourceVideo;
  els.dlVideo.hidden = !video;
  if (els.dlVideo.dataset.busy) return;
  els.dlVideo.disabled = !video || !state.processedBuffer;
  els.dlVideo.textContent = video ? `Download video (${video.info.container.toUpperCase()})` : 'Download video';
}

if (els.dlVideo) els.dlVideo.addEventListener('click', async () => {
  const video = state.sourceVideo, samples = state.processedBuffer, rate = state.processedRate;
  if (!video || !samples || els.dlVideo.disabled) return;
  els.dlVideo.disabled = true;
  els.dlVideo.dataset.busy = '1';
  els.dlVideo.textContent = 'Writing video…';
  try {
    const { blob, audioCodec, container } = await TF2Video.remux(video.bytes, samples, rate);
    if (state.sourceVideo !== video) return;
    const name = outputName(video.name, state.lastCodecKey, container);
    saveBlob(blob, name);
    logLine(`Video: ${name} (${(blob.size / 1048576).toFixed(1)} MB): picture copied as is, voice as ${audioCodec}.`, 'sys');
    setStatus(`Saved ${name}: the video with the render as its audio (${audioCodec}).`, 'success');
  } catch (error) {
    setStatus(`Could not write the video: ${error.message}`, 'error');
    logLine(`Video: ${error.message}`, 'err');
  } finally {
    delete els.dlVideo.dataset.busy;
    updateVideoButton();
  }
});

els.file.addEventListener('change', () => {
  if (!els.file.files.length) return;
  const files = Array.from(els.file.files);
  // Several files at once go to the batch queue (batch.js).
  if (files.length > 1 && window.TF2Batch) {
    els.file.value = '';
    window.TF2Batch.add(files, { reveal: true });
    return;
  }
  if (!isDemoFile(files[0]) && files[0].size > (isVideoFile(files[0]) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) els.file.value = '';
  loadSourceFile(files[0]);
});
