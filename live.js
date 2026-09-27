/* Live monitor: the microphone through the TF2 voice chain in real time.
 *
 * live-worklet.js captures 20 ms blocks on the audio thread and plays the
 * result; live-worker.js runs TF2Audio.createLiveChain on them. The two talk
 * over a MessageChannel, so audio never passes through this page. The chain
 * follows the settings panel while running, and the output can go to any
 * output device (a virtual cable makes it a live TF2 voice for other apps).
 *
 * Push-to-talk sends only while V or the Talk button is held (the gate still
 * applies inside). Low latency drops the gate's 120 ms pre-roll. Record keeps
 * the microphone and the voice and loads them into the app as a dry/wet
 * pair (mountLiveTake).
 * Needs script.js (state, els, renderOptions, logLine, mountLiveTake).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    toggle: $('live-toggle'), panel: $('live-panel'), input: $('live-input'), output: $('live-output'),
    tx: $('live-tx'), mode: $('live-mode'), rate: $('live-rate'), loss: $('live-loss'), latency: $('live-latency'),
    inMeter: $('live-in'), outMeter: $('live-out'), note: $('live-note'),
    record: $('live-record'), ptt: $('live-ptt'), talk: $('live-talk'), lowLatency: $('live-lowlat')
  };
  if (!ui.toggle) return;

  let live = null;   // { ctx, stream, source, node, worker, timer, lastOpts, stats, talking, recording }
  let keyHeld = false, buttonHeld = false;

  // The render settings plus the live-only low-latency switch.
  const liveOptions = () => ({ ...renderOptions(), lowLatency: !!(ui.lowLatency && ui.lowLatency.checked) });
  const pttOn = () => !!(ui.ptt && ui.ptt.checked);

  function updateTalk() {
    const on = !pttOn() || keyHeld || buttonHeld;
    if (ui.talk) { ui.talk.hidden = !pttOn(); ui.talk.classList.toggle('live-held', on && pttOn()); }
    if (!live || live.talking === on) return;
    live.talking = on;
    live.worker.postMessage({ type: 'talk', on });
  }

  // Recording: the worker lines the microphone and the voice up and sends
  // both when it stops (also when the monitor stops mid-recording).
  function setRecordButton() {
    if (!ui.record) return;
    const rec = live && live.recording;
    ui.record.disabled = !live || (live && live.saving);
    ui.record.classList.toggle('live-recording', !!rec);
    ui.record.textContent = live && live.saving ? 'Saving…' : rec
      ? `⏹ Stop recording ${formatClock((performance.now() - rec.started) / 1000)}` : '⏺ Record';
  }
  const formatClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function toggleRecording() {
    if (!live || live.saving) return;
    if (!live.recording) {
      live.recording = { started: performance.now() };
      live.worker.postMessage({ type: 'record', on: true });
      logLine('voice_record: recording the live monitor.', 'sys');
    } else {
      live.recording = null;
      live.saving = true;
      live.worker.postMessage({ type: 'record', on: false });
    }
    setRecordButton();
  }

  function deliverRecording(message) {
    if (live) { live.saving = false; live.recording = null; }
    setRecordButton();
    const dry = new Float32Array(message.dry);
    if (dry.length < message.rate * 0.2) { ui.note.textContent = 'The recording was too short to keep.'; return; }
    try {
      mountLiveTake({ dry, wet: new Float32Array(message.wet), rate: message.rate, frameLog: new Uint8Array(message.frameLog),
        counts: message.counts, info: message.info });
      ui.note.textContent = `Loaded ${(dry.length / message.rate).toFixed(1)} s of the live session: A/B plays the voice against your microphone.`;
    } catch (error) {
      ui.note.textContent = `Could not load the recording: ${error.message}`;
    }
  }

  const dbfs = (peak) => (peak > 0 ? 20 * Math.log10(peak) : -Infinity);
  const setMeter = (el, peak) => {
    if (!el) return;
    const db = dbfs(peak);
    el.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
    el.classList.toggle('live-hot', db > -1);
    el.parentElement.title = Number.isFinite(db) ? `${db.toFixed(1)} dBFS peak` : 'silence';
  };

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, fallback) => {
      if (!select) return;
      const current = select.value;
      select.replaceChildren(...[{ deviceId: '', label: fallback }, ...devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default')]
        .map((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${kind} ${i}`; return o; }));
      if ([...select.options].some(o => o.value === current)) select.value = current;
    };
    fill(ui.input, 'audioinput', 'Default microphone');
    fill(ui.output, 'audiooutput', 'Default output');
  }

  function stopLive(message) {
    if (!live) return;
    const l = live;
    live = null;
    clearInterval(l.timer);
    try { l.node.port.postMessage({ type: 'stop' }); } catch (e) { /* closed */ }
    // A recording in progress is finished and delivered before the worker goes.
    const saving = !!(l.recording || l.saving);
    try { if (l.recording) l.worker.postMessage({ type: 'record', on: false }); } catch (e) { /* closed */ }
    try { l.worker.postMessage({ type: 'stop' }); } catch (e) { /* closed */ }
    setTimeout(() => l.worker.terminate(), saving ? 5000 : 500);
    setRecordButton();
    l.stream.getTracks().forEach(t => t.stop());
    l.source.disconnect();
    l.node.disconnect();
    l.ctx.close().catch(() => {});
    ui.toggle.textContent = '🎧 Live';
    ui.toggle.setAttribute('aria-pressed', 'false');
    ui.tx.textContent = '○ off';
    ui.tx.className = 'live-tx';
    setMeter(ui.inMeter, 0); setMeter(ui.outMeter, 0);
    if (message) ui.note.textContent = message;
    logLine('voice_loopback: live monitor stopped.', 'sys');
  }

  async function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      ui.panel.hidden = false;
      ui.note.textContent = 'The live monitor needs microphone access over HTTPS (or localhost) and AudioWorklet support.';
      return;
    }
    ui.panel.hidden = false;
    ui.toggle.disabled = true;
    ui.note.textContent = 'Starting… Use headphones: speakers feed the output back into the microphone.';
    let stream, ctx;
    try {
      // The raw microphone, as the game's capture gets it: no browser
      // echo cancellation, noise suppression or gain control.
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: ui.input && ui.input.value ? { exact: ui.input.value } : undefined,
        channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      if (ui.output && ui.output.value && ctx.setSinkId) await ctx.setSinkId(ui.output.value);
      await ctx.audioWorklet.addModule('live-worklet.js');
      const opts = liveOptions();
      const node = new AudioWorkletNode(ctx, 'tf2-live-monitor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { block: Math.round(ctx.sampleRate / 50), channel: opts.captureChannel, prebuffer: Math.round(ctx.sampleRate * 0.04) } });
      const worker = new Worker('live-worker.js');
      const bridge = new MessageChannel();
      node.port.postMessage({ type: 'bridge', port: bridge.port1 }, [bridge.port1]);
      worker.postMessage({ type: 'start', port: bridge.port2, opts, rate: ctx.sampleRate }, [bridge.port2]);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      node.connect(ctx.destination);
      if (els.audio && !els.audio.paused) els.audio.pause();
      live = { ctx, stream, source, node, worker, lastOpts: JSON.stringify(opts), channel: opts.captureChannel,
        stats: null, worklet: null, lastBytes: 0, lastTime: performance.now(), talking: true, recording: null, saving: false };
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'recording') deliverRecording(data);
        else onWorker(data);
      };
      updateTalk();
      setRecordButton();
      worker.onerror = (event) => stopLive(`The live chain failed: ${event.message || 'worker error'}`);
      node.port.onmessage = (event) => { if (live && event.data && event.data.type === 'stats') live.worklet = event.data; };
      // Follow the settings panel (presets included) while live.
      live.timer = setInterval(() => {
        if (!live) return;
        const now = liveOptions(), key = JSON.stringify(now);
        if (key === live.lastOpts) return;
        live.lastOpts = key;
        if (now.captureChannel !== live.channel) { live.channel = now.captureChannel; node.port.postMessage({ type: 'channel', channel: now.captureChannel }); }
        worker.postMessage({ type: 'config', opts: now });
      }, 300);
      ui.toggle.textContent = '⏹ Stop live';
      ui.toggle.setAttribute('aria-pressed', 'true');
      ui.note.textContent = 'Live. Settings changes apply as you make them. Rooms (dsp_room) are not applied live.';
      logLine(`voice_loopback 1: live monitor at ${ctx.sampleRate} Hz.`, 'sys');
      listDevices().catch(() => {});
    } catch (error) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
      live = null;
      ui.note.textContent = `Could not start the live monitor: ${error.message}`;
    } finally {
      ui.toggle.disabled = false;
    }
  }

  function onWorker(message) {
    if (!live) return;
    if (message.type === 'error') { stopLive(`The live chain failed: ${message.message}`); return; }
    if (message.type === 'ready') { live.chainLatencyMs = message.latencyMs; return; }
    if (message.type !== 'stats') return;
    const s = message.stats, w = live.worklet;
    const now = performance.now(), seconds = (now - live.lastTime) / 1000;
    const kbps = live.stats && seconds > 0 ? (s.bytes - live.stats.bytes) * 8 / seconds / 1000 : 0;
    live.stats = s; live.lastTime = now;
    const sending = s.gateOpen;
    ui.tx.textContent = sending ? '● TX' : s.talking === false ? '○ push-to-talk' : '○ gate closed';
    ui.tx.className = `live-tx${sending ? ' live-on' : ''}`;
    ui.mode.textContent = !sending ? '—' : { silk: 'SILK', hybrid: 'Hybrid', celt: 'CELT', dtx: 'DTX (comfort noise)' }[s.lastMode] || '—';
    ui.rate.textContent = `${kbps.toFixed(1)} kbps`;
    ui.loss.textContent = `${s.lost} lost · ${s.late} late`;
    if (w) {
      // Mic to speaker: half a 20 ms capture block on average, the chain's own
      // delay (gate pre-roll, capture EQ, Opus lookahead), the jitter buffer
      // and the audio device's buffers.
      const device = ((live.ctx.baseLatency || 0) + (live.ctx.outputLatency || 0)) * 1000;
      const ms = 10 + (live.chainLatencyMs || s.latencyMs || 0) + w.queued / live.ctx.sampleRate * 1000 + device;
      ui.latency.textContent = `${Math.max(0, ms).toFixed(0)} ms${w.underruns ? ` · ${w.underruns} dropout${w.underruns === 1 ? '' : 's'}` : ''}`;
    }
    setMeter(ui.inMeter, s.inputPeak);
    setMeter(ui.outMeter, s.outputPeak);
    if (live.recording) {
      // The app holds up to MAX_AUDIO_SECONDS of source.
      if ((performance.now() - live.recording.started) / 1000 > MAX_AUDIO_SECONDS - 1) toggleRecording();
      else setRecordButton();
    }
  }

  // Push-to-talk: V (TF2's +voicerecord default) or the on-screen button.
  // Not while typing: text fields and selects keep V.
  const typing = (target) => target && (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)
    || (target.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file|color)$/.test(target.type)));
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyV' || !live || !pttOn() || typing(event.target)) return;
    event.preventDefault();
    if (!event.repeat) { keyHeld = true; updateTalk(); }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code !== 'KeyV' || !keyHeld) return;
    keyHeld = false;
    updateTalk();
  });
  window.addEventListener('blur', () => { keyHeld = false; buttonHeld = false; updateTalk(); });
  if (ui.talk) {
    const release = () => { if (buttonHeld) { buttonHeld = false; updateTalk(); } };
    ui.talk.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { ui.talk.setPointerCapture(event.pointerId); } catch (e) { /* not capturable */ }
      buttonHeld = true;
      updateTalk();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.talk.addEventListener(type, release);
  }
  if (ui.ptt) ui.ptt.addEventListener('change', updateTalk);
  if (ui.record) ui.record.addEventListener('click', toggleRecording);

  ui.toggle.addEventListener('click', () => (live ? stopLive() : startLive()));
  if (ui.input) ui.input.addEventListener('change', () => { if (live) { stopLive(); startLive(); } });
  if (ui.output) {
    if (!(window.AudioContext && AudioContext.prototype.setSinkId)) {
      ui.output.disabled = true;
      ui.output.title = 'This browser cannot choose an output device for web audio; it plays on the default output.';
    }
    ui.output.addEventListener('change', () => {
      if (live && live.ctx.setSinkId) live.ctx.setSinkId(ui.output.value).catch(error => { ui.note.textContent = `Could not switch output: ${error.message}`; });
    });
  }
  window.addEventListener('pagehide', () => stopLive());
  updateTalk();
  window.TF2Live = { start: startLive, stop: stopLive, record: toggleRecording, get running() { return !!live; },
    get stats() { return live && live.stats; }, get recording() { return !!(live && live.recording); },
    talk(on) { buttonHeld = !!on; updateTalk(); } };
})();
