/* =========================================================================
 * TF2 Voice Emulator — batch.js
 *
 * Batch queue: render many files with the current settings, one or two at a
 * time in workers, then save them one by one or as a single ZIP in the
 * format picked in step 3. Files come from the batch picker, a multi-file
 * choice in step 1, or drag and drop (files or whole folders).
 *
 * Each finished item keeps its render as a WAV blob; FLAC and MP3 are made
 * from it when saved. A render made with settings that have since changed is
 * marked, and "Render" redoes it.
 *
 * Depends on the app/ page scripts: els, state, LS, renderOptions, captureSource,
 * startWorkerJob, canUseWorker, exportWav, cachedExport, currentFormat,
 * outputName, saveBlob, loadSourceFile, isVideoFile, logLine, MAX_FILE_BYTES,
 * MAX_VIDEO_BYTES, MAX_AUDIO_SECONDS; and on TF2Audio, TF2Formats, TF2Zip.
 * =========================================================================
 */
(function () {
  'use strict';

  const ui = {
    panel:   document.getElementById('batch-panel'),
    files:   document.getElementById('batch-files'),
    run:     document.getElementById('batch-run'),
    cancel:  document.getElementById('batch-cancel'),
    zip:     document.getElementById('batch-zip'),
    clear:   document.getElementById('batch-clear'),
    summary: document.getElementById('batch-summary'),
    progress: document.getElementById('batch-progress'),
    list:    document.getElementById('batch-list'),
    preview: document.getElementById('batch-preview')
  };
  if (!ui.panel || !ui.list) return;

  const AUDIO_EXT = /\.(mp3|wav|wave|flac|ogg|oga|opus|m4a|m4b|aac|mp4|webm|weba|aif|aiff|aifc|caf|mka)$/i;
  const BASE_TITLE = document.title;
  const batch = {
    items: [], nextId: 1,
    running: false, zipping: false, cancelled: false,
    runTotal: 0, runDone: 0, zipTotal: 0, zipDone: 0,
    preview: null, note: '', noteTimer: 0, dragDepth: 0
  };

  // Audio, or a video whose audio track is rendered (isVideoFile, app/source.js).
  const isAudio = (file) => !file.name.startsWith('.') && (/^audio\//.test(file.type) || AUDIO_EXT.test(file.name) || isVideoFile(file));
  const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const clock = (seconds) => { const t = Math.round(seconds); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const settingsKey = () => JSON.stringify(renderOptions());
  const dbText = (v) => (Number.isFinite(v) ? v.toFixed(1).replace('-', '−') : '−∞');
  const loudness = (stats) => (stats && stats.integrated !== null
    ? ` · ${dbText(stats.integrated)} LUFS · ${dbText(stats.truePeak)} dBTP` : '');
  // A short remark after the summary (skipped files, saved ZIP, errors); it fades after a while.
  function setNote(text) {
    batch.note = text;
    clearTimeout(batch.noteTimer);
    if (text) batch.noteTimer = setTimeout(() => { batch.note = ''; refresh(); }, 12000);
  }
  function abortError() {
    const error = new Error('Batch cancelled.');
    error.name = 'AbortError';
    return error;
  }

  // Parallel renders: two where the machine has cores and memory to spare.
  function lanes() {
    if (!canUseWorker()) return 1;
    const cores = navigator.hardwareConcurrency || 2, memory = navigator.deviceMemory || 8;
    return cores >= 4 && memory >= 4 ? 2 : 1;
  }

  // `key`: settingsKey() of the current controls.
  function status(item, key) {
    if (item.working) return 'working';
    if (item.error) return 'error';
    if (!item.wav) return 'queued';
    return item.key === key ? 'done' : 'stale';
  }
  const needsRender = (item, key) => status(item, key) !== 'done' && !item.working;

  /* ---------------- rows ---------------- */

  function makeRow(item) {
    const row = document.createElement('li');
    row.className = 'batch-item';
    const name = document.createElement('div');
    name.className = 'bi-name';
    name.textContent = item.path;
    name.title = item.path;
    const actions = document.createElement('div');
    actions.className = 'bi-actions';
    const button = (cls, text, label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', `${label}: ${item.path}`);
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };
    const play = button('bi-play', '▶', 'Preview', () => previewItem(item));
    const save = button('bi-save', '⬇', 'Save', () => saveItem(item));
    button('bi-remove', '✕', 'Remove', () => removeItem(item));
    const info = document.createElement('div');
    info.className = 'bi-status';
    const progress = document.createElement('progress');
    progress.className = 'bi-progress';
    progress.max = 100;
    progress.hidden = true;
    progress.setAttribute('aria-label', `Render progress: ${item.path}`);
    row.append(name, actions, info, progress);
    item.ui = { row, play, save, info, progress };
    ui.list.appendChild(row);
  }

  function renderRow(item, key = settingsKey()) {
    const s = status(item, key);
    const { row, play, save, info, progress } = item.ui;
    row.dataset.state = s;
    row.classList.toggle('previewing', batch.preview === item);
    const length = item.duration ? ` · ${clock(item.duration)}` : '';
    let text;
    if (s === 'working') text = item.stage === 'decode' ? 'Decoding…' : `Rendering… ${Math.round(item.progress * 100)}%`;
    else if (s === 'error') text = `Error: ${item.error}`;
    else if (s === 'queued') text = `Queued · ${(item.file.size / 1048576).toFixed(1)} MB`;
    else if (s === 'stale') text = `Rendered with older settings${length}${loudness(item.stats)} · Render to update`;
    else text = `Done${length}${loudness(item.stats)} · ${(item.took / 1000).toFixed(1)} s`;
    if (item.busy) text = item.busy;
    info.textContent = text;
    progress.hidden = s !== 'working';
    progress.value = Math.round((item.stage === 'decode' ? 0 : item.progress) * 100);
    play.disabled = !item.wav;
    save.disabled = !item.wav || !!item.busy || batch.zipping;
  }

  function renderAll() {
    const key = settingsKey();
    batch.items.forEach(item => renderRow(item, key));
  }

  /* ---------------- summary, buttons, title ---------------- */

  function refresh() {
    const items = batch.items, key = settingsKey();
    const count = (s) => items.filter(i => status(i, key) === s).length;
    const done = count('done'), stale = count('stale'), failed = count('error');
    const pending = items.filter(i => needsRender(i, key)).length;
    const saved = items.filter(i => i.wav).length;
    const busy = batch.running || batch.zipping;
    const { label } = TF2Formats.FORMATS[currentFormat()];

    ui.run.disabled = busy || state.processing || !pending;
    ui.run.textContent = !pending || pending === items.length ? 'Render all' : `Render ${pending} more`;
    ui.zip.disabled = busy || !saved;
    ui.zip.textContent = `Save ${saved > 1 ? 'all ' : ''}as ${label} (.zip)`;
    ui.clear.disabled = !items.length || batch.zipping;
    ui.cancel.hidden = !busy;
    ui.files.disabled = batch.zipping;

    let text;
    if (!items.length) text = 'No files queued.';
    else if (batch.zipping) text = `Preparing the ZIP: ${batch.zipDone} of ${batch.zipTotal} files as ${label}…`;
    else if (batch.running) text = `Rendering ${batch.runDone} of ${batch.runTotal} done…`;
    else {
      const parts = [plural(items.length, 'file'), `${done} rendered`];
      if (stale) parts.push(`${stale} with older settings`);
      if (failed) parts.push(`${failed} failed`);
      if (pending - failed - stale > 0) parts.push(`${pending - failed - stale} to render`);
      text = parts.join(' · ');
    }
    if (batch.note && !busy) text += ` — ${batch.note}`;
    ui.summary.textContent = text;
    refreshProgress();
  }

  function refreshProgress() {
    let fraction = null;
    if (batch.running && batch.runTotal) {
      const working = batch.items.filter(i => i.working).reduce((sum, i) => sum + (i.stage === 'decode' ? 0 : i.progress), 0);
      fraction = Math.min(1, (batch.runDone + working) / batch.runTotal);
    } else if (batch.zipping && batch.zipTotal) {
      fraction = batch.zipDone / batch.zipTotal;
    }
    ui.progress.hidden = fraction === null;
    if (fraction !== null) ui.progress.value = Math.round(fraction * 100);
    // Show progress in the tab title, so it can be followed from another tab.
    if (batch.running) document.title = `[${batch.runDone}/${batch.runTotal}] ${BASE_TITLE}`;
    else if (batch.zipping) document.title = `[ZIP ${batch.zipDone}/${batch.zipTotal}] ${BASE_TITLE}`;
  }

  function finishTitle(text) {
    document.title = document.hidden ? `${text} ${BASE_TITLE}` : BASE_TITLE;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !batch.running && !batch.zipping) document.title = BASE_TITLE;
  });

  /* ---------------- adding files ---------------- */

  // `files`: File objects, or { file, path } for files from a dropped folder.
  function add(files, { reveal = false } = {}) {
    const entries = files.map(f => (f instanceof File ? { file: f, path: f.name } : f));
    const audio = entries.filter(e => isAudio(e.file)).sort(byPath);
    const skipped = entries.length - audio.length;
    let added = 0;
    for (const { file, path } of audio) {
      const duplicate = batch.items.some(i => i.path === path && i.file.size === file.size && i.file.lastModified === file.lastModified);
      if (duplicate) continue;
      const item = { id: batch.nextId++, file, path, name: file.name, wav: null, key: null, exports: {},
        working: false, stage: '', progress: 0, error: null, busy: null, duration: 0, took: 0, job: null };
      batch.items.push(item);
      makeRow(item);
      renderRow(item);
      added++;
    }
    setNote(skipped ? `skipped ${plural(skipped, 'file')} that ${skipped === 1 ? 'is' : 'are'} not audio or video` : '');
    if (added) logLine(`FS_MountFile: ${plural(added, 'file')} added to the batch.`, 'sys');
    refresh();
    if (reveal) ui.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return added;
  }

  ui.files.addEventListener('change', () => {
    const files = Array.from(ui.files.files || []);
    ui.files.value = '';
    if (files.length) add(files);
  });

  /* ---------------- rendering ---------------- */

  async function decodeFile(file) {
    if (!state.decodeCtx) state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    return state.decodeCtx.decodeAudioData(await file.arrayBuffer());
  }

  async function renderItem(item, opts, key) {
    item.working = true; item.stage = 'decode'; item.progress = 0; item.error = null;
    renderRow(item); refresh();
    const started = performance.now();
    try {
      const limit = isVideoFile(item.file) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
      if (item.file.size > limit) throw new Error(`the file is over the ${limit / 1048576} MB limit`);
      const decoded = await decodeFile(item.file);
      if (!decoded.length) throw new Error('no decodable audio');
      if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error('longer than the 10 minute limit');
      if (batch.cancelled || !batch.items.includes(item)) throw abortError();
      item.duration = decoded.duration;
      const mono = TF2Audio.bufferToMono(decoded);
      const source = captureSource({
        sampleRate: decoded.sampleRate, duration: decoded.duration, length: mono.length,
        numberOfChannels: 1, getChannelData: () => mono,
        left: decoded.numberOfChannels > 1 ? decoded.getChannelData(0).slice() : null
      }, opts.captureChannel);
      item.stage = 'render';
      const onProgress = (p) => { item.progress = p; renderRow(item); refreshProgress(); };
      item.job = canUseWorker()
        ? startWorkerJob(source, { ...opts, onProgress })
        : { promise: TF2Audio.process(source, { ...opts, onProgress }), cancel() {} };
      const result = await item.job.promise;
      if (!batch.items.includes(item)) return;
      if (item.url) { URL.revokeObjectURL(item.url); item.url = null; }
      if (batch.preview === item) stopPreview();
      item.wav = result.blob;
      item.stats = result.stats || (typeof TF2Meter !== 'undefined' ? TF2Meter.analyze(result.samples, result.sampleRate) : null);
      item.wavCrc = null;
      item.exports = {};
      item.key = key;
      item.codecKey = opts.codec;
      item.took = performance.now() - started;
    } catch (error) {
      if (error.name !== 'AbortError') {
        item.error = error.message || String(error);
        logLine(`batch: ${item.path} failed: ${item.error}`, 'err');
      }
    } finally {
      item.working = false;
      item.job = null;
      if (batch.items.includes(item)) renderRow(item);
      batch.runDone++;
      refresh();
    }
  }

  async function run() {
    if (batch.running || batch.zipping || state.processing) return;
    const opts = renderOptions(), key = JSON.stringify(opts);
    const todo = batch.items.filter(i => needsRender(i, key));
    if (!todo.length) return;
    batch.running = true; batch.cancelled = false; setNote('');
    batch.runTotal = todo.length; batch.runDone = 0;
    state.batchRunning = true;
    if (els.controls) els.controls.inert = true;
    els.process.disabled = true;
    refresh();
    logLine(`batch: rendering ${plural(todo.length, 'file')} (codec=${opts.codec}, ${lanes()} at a time)`, 'cmd');
    const started = performance.now();
    let next = 0;
    const lane = async () => {
      while (!batch.cancelled && next < todo.length) {
        const item = todo[next++];
        if (batch.items.includes(item)) await renderItem(item, opts, key);
        else batch.runDone++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(lanes(), todo.length) }, lane));
    } finally {
      batch.running = false;
      state.batchRunning = false;
      if (els.controls) els.controls.inert = false;
      els.process.disabled = !state.decodedSource;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      if (batch.cancelled) {
        setNote('cancelled');
        logLine('batch: cancelled.', 'warn');
      } else {
        logLine(`batch: finished ${plural(todo.length, 'file')} in ${seconds} s.`, 'sys');
      }
      renderAll();
      refresh();
      finishTitle(batch.cancelled ? '[cancelled]' : '[✓]');
    }
  }

  function cancel() {
    batch.cancelled = true;
    batch.items.forEach((item) => { if (item.job) item.job.cancel(); });
    refresh();
  }

  /* ---------------- preview, save, remove ---------------- */

  function stopPreview() {
    ui.preview.pause();
    ui.preview.removeAttribute('src');
    ui.preview.load();
    ui.preview.hidden = true;
    const previous = batch.preview;
    batch.preview = null;
    if (previous && batch.items.includes(previous)) renderRow(previous);
  }

  function previewItem(item) {
    if (!item.wav) return;
    const previous = batch.preview;
    if (!item.url) item.url = URL.createObjectURL(item.wav);
    batch.preview = item;
    if (previous && previous !== item && batch.items.includes(previous)) renderRow(previous);
    renderRow(item);
    ui.preview.hidden = false;
    if (ui.preview.getAttribute('src') !== item.url) ui.preview.src = item.url;
    ui.preview.play().catch(() => {});
  }

  // The file for one item in `format`, as { blob, crc }. A WAV is the render
  // itself; only its CRC (for the ZIP) is computed, in a worker.
  async function exportItem(item, format) {
    if (format === 'wav') {
      if (item.wavCrc == null) item.wavCrc = (await exportWav(item.wav, 'wav')).crc;
      return { blob: item.wav, crc: item.wavCrc };
    }
    return cachedExport(item.exports, item.wav, format);
  }

  async function saveItem(item) {
    if (!item.wav || item.busy) return;
    const format = currentFormat(), wav = item.wav;
    const { ext, label } = TF2Formats.FORMATS[format];
    const name = outputName(item.name, item.codecKey, ext);
    if (format === 'wav') { saveBlob(wav, name); return; }
    item.busy = `Encoding ${label}…`;
    renderRow(item);
    try {
      const { blob } = await cachedExport(item.exports, wav, format);
      if (item.wav === wav) saveBlob(blob, name);
    } catch (error) {
      logLine(`batch: ${label} export of ${item.path} failed: ${error.message}`, 'err');
      setNote(`${label} export of ${item.name} failed: ${error.message}`);
    } finally {
      item.busy = null;
      if (batch.items.includes(item)) renderRow(item);
      refresh();
    }
  }

  function removeItem(item) {
    const index = batch.items.indexOf(item);
    if (index < 0) return;
    if (item.job) item.job.cancel();
    if (batch.preview === item) stopPreview();
    if (item.url) URL.revokeObjectURL(item.url);
    batch.items.splice(index, 1);
    item.ui.row.remove();
    refresh();
  }

  function clear() {
    if (batch.zipping) return;
    if (batch.running) cancel();
    stopPreview();
    batch.items.slice().forEach(removeItem);
    setNote('');
    refresh();
  }

  /* ---------------- ZIP ---------------- */

  function uniqueName(name, used) {
    const dot = name.lastIndexOf('.');
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  async function saveZip() {
    if (batch.running || batch.zipping) return;
    const items = batch.items.filter(i => i.wav);
    if (!items.length) return;
    const format = currentFormat();
    const { ext, label } = TF2Formats.FORMATS[format];
    batch.zipping = true; batch.cancelled = false; setNote('');
    batch.zipTotal = items.length; batch.zipDone = 0;
    renderAll();
    refresh();
    try {
      const results = new Array(items.length);
      let next = 0;
      const lane = async () => {
        while (!batch.cancelled && next < items.length) {
          const index = next++;
          results[index] = await exportItem(items[index], format);
          batch.zipDone++;
          refresh();
        }
      };
      await Promise.all(Array.from({ length: Math.min(lanes(), items.length) }, lane));
      if (batch.cancelled) { setNote('ZIP cancelled'); return; }
      const used = new Set();
      const entries = items.map((item, i) => ({
        name: uniqueName(outputName(item.name, item.codecKey, ext), used),
        data: results[i].blob, crc: results[i].crc, size: results[i].blob.size
      }));
      const zip = TF2Zip.build(entries);
      const codecs = new Set(items.map(i => i.codecKey));
      const zipName = `tf2_voice_${codecs.size === 1 ? items[0].codecKey : 'batch'}_${items.length}_${ext}.zip`;
      saveBlob(zip, zipName);
      logLine(`Host_WriteFile: ${zipName} (${plural(items.length, 'file')}, ${(zip.size / 1048576).toFixed(1)} MB)`, 'sys');
      setNote(`saved ${zipName}`);
    } catch (error) {
      logLine(`batch: ZIP failed: ${error.message}`, 'err');
      setNote(`ZIP failed: ${error.message}`);
    } finally {
      batch.zipping = false;
      renderAll();
      refresh();
      finishTitle('[✓]');
    }
  }

  ui.run.addEventListener('click', run);
  ui.cancel.addEventListener('click', cancel);
  ui.zip.addEventListener('click', saveZip);
  ui.clear.addEventListener('click', clear);
  document.addEventListener('tf2:settings', () => { if (!batch.running) { renderAll(); refresh(); } });
  document.addEventListener('tf2:format', refresh);
  document.addEventListener('tf2:busy', refresh);

  /* ---------------- drag and drop ---------------- */

  const hasFiles = (event) => !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');

  function readEntries(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }
  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns a directory in chunks, then an empty list.
      for (let chunk = await readEntries(reader); chunk.length; chunk = await readEntries(reader)) {
        for (const child of chunk) await walk(child, `${prefix}${entry.name}/`, out);
      }
    }
  }

  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    batch.dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    batch.dragDepth = Math.max(0, batch.dragDepth - 1);
    if (!batch.dragDepth) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    batch.dragDepth = 0;
    document.body.classList.remove('dragging');
    const onBatch = ui.panel.contains(event.target);
    // Entries must be taken while the event is live; folders are read after.
    const entries = Array.from(event.dataTransfer.items || [])
      .map(item => (item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    let files;
    if (entries.length) {
      files = [];
      try {
        for (const entry of entries) await walk(entry, '', files);
      } catch (error) {
        logLine(`drop: could not read a dropped folder: ${error.message}`, 'err');
      }
    } else {
      files = Array.from(event.dataTransfer.files || []).map(file => ({ file, path: file.name }));
    }
    const folder = entries.some(entry => entry.isDirectory);
    const audio = files.filter(f => isAudio(f.file));
    // One file dropped outside the batch panel loads as the source, like step 1.
    if (!onBatch && !folder && files.length === 1) {
      if (audio.length) loadSourceFile(audio[0].file);
      else setStatus(`${files[0].file.name} is not an audio or video file.`, 'error');
      return;
    }
    if (files.length) add(files, { reveal: !onBatch });
  });

  refresh();
  window.TF2Batch = { add, run, cancel, clear, items: () => batch.items.slice() };
})();
