'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createStaticServer } = require('./static-server');

let passed = 0;
// The app shell cache sw.js populates, e.g. tf2ve-v13.
const SHELL_CACHE = `tf2ve-v${/CACHE_PREFIX\}v(\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'))[1]}`;
function check(condition, name, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? ` (${detail})` : ''}`);
  passed++;
  console.log(`  ok    ${name}${detail ? `   [${detail}]` : ''}`);
}

function wavTone(seconds, rate = 48000, frequency = 440) {
  const length = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const sample = Math.sin(2 * Math.PI * frequency * i / rate) * 0.2;
    buffer.writeInt16LE(Math.round(sample * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

// Speech-like test audio: gliding harmonics in syllables, with pauses, so
// alignment has something to lock onto (a steady tone would not do).
function wavSpeech(seconds, rate = 48000) {
  const length = Math.round(seconds * rate), buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  let seed = 11, noise = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate, syllable = Math.floor(t / .23);
    const env = (syllable * 7919) % 5 ? Math.sin(Math.PI * ((t / .23) % 1)) ** 2 : 0;
    const f0 = 110 + 40 * Math.sin(t * 1.3) + 15 * (syllable % 4);
    seed = (seed * 1103515245 + 12345) >>> 0;
    noise += .3 * (seed / 4294967296 * 2 - 1 - noise);
    let v = .25 * noise;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / (h + 1);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, .12 * env * v)) * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

async function readRenderedWav(page) {
  return page.evaluate(async () => {
    const response = await fetch(document.getElementById('preview').src);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = (from, count) => String.fromCharCode(...bytes.slice(from, from + count));
    const view = new DataView(bytes.buffer);
    const rate = view.getUint32(24, true), frames = (bytes.length - 44) / 2;
    let power = 0;
    const crossings = [];
    for (let i = 0; i < frames; i++) {
      const value = view.getInt16(44 + i * 2, true) / 32768;
      power += value * value;
      // Ignore codec startup/end transients when checking the tone's pitch.
      if (i > rate * .05 && i < frames - rate * .05) {
        const previous = view.getInt16(44 + (i - 1) * 2, true) / 32768;
        if (previous <= 0 && value > 0) crossings.push(i - 1 - previous / (value - previous));
      }
    }
    return { size: bytes.length, riff: text(0, 4), wave: text(8, 4), rate, frames,
      format: view.getUint16(20, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true),
      dataBytes: view.getUint32(40, true), rms: Math.sqrt(power / frames),
      toneHz: crossings.length > 1 ? rate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]) : null };
  });
}

function checkRenderedTone(wav, source, label) {
  check(wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.size > 44,
    `${label}: populated PCM WAV`, `${wav.size} bytes`);
  check(wav.format === 1 && wav.channels === 1 && wav.bits === 16 && wav.dataBytes === wav.frames * 2,
    `${label}: mono 16-bit PCM header agrees with payload`);
  // decodeAudioData resamples to AudioContext.sampleRate. The browser's
  // default can be 44.1 kHz on CI and 48 kHz locally, regardless of file rate.
  check(wav.rate === source.rate, `${label}: WAV preserves decoded playback rate`, `${wav.rate} Hz`);
  check(wav.frames === source.length && wav.size === 44 + source.length * 2,
    `${label}: conversion preserves every decoded input frame`, `${wav.frames} frames`);
  // Separately guard duration so a wrong decoder length cannot validate itself.
  // Chromium may round down by one sample during browser-side resampling.
  check(Math.abs(wav.frames / wav.rate - .5) <= 1 / wav.rate + 1e-9,
    `${label}: half-second fixture retains duration within one sample`);
  check(wav.rms > .01 && wav.rms < .5, `${label}: audible, bounded samples`);
  check(wav.toneHz !== null && Math.abs(wav.toneHz - 440) < 2,
    `${label}: resampling preserves tone pitch`, `${wav.toneHz?.toFixed(2)} Hz`);
}

async function verifySampleRateMatrix(browser, base) {
  console.log('\n[Browser 5] Explicit file-rate / decode-rate matrix');
  for (const decodeRate of [44100, 48000]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      // A real AudioContext at the requested rate, not mocked decoded PCM.
      // Keep production defaults unchanged; exercise both CI and local paths.
      await context.addInitScript((sampleRate) => {
        const NativeAudioContext = window.AudioContext;
        window.AudioContext = class extends NativeAudioContext {
          constructor(options = {}) { super({ ...options, sampleRate }); }
        };
      }, decodeRate);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      for (const fileRate of [44100, 48000]) {
        const label = `${fileRate} Hz file -> ${decodeRate} Hz browser`;
        await page.locator('#file').setInputFiles({ name: `tone-${fileRate}.wav`, mimeType: 'audio/wav', buffer: wavTone(.5, fileRate) });
        await page.waitForFunction(() => !document.getElementById('process').disabled);
        const source = await page.evaluate(() => ({ rate: state.decodedSource.sampleRate,
          length: state.decodedSource.length, contextRate: state.decodeCtx.sampleRate }));
        check(source.contextRate === decodeRate && source.rate === decodeRate,
          `${label}: requested browser decode rate is actually active`);
        await page.locator('#process').click();
        await page.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
        checkRenderedTone(await readRenderedWav(page), source, label);
        const log = await page.locator('#console-out').textContent();
        check(log.includes('libopus 1.1.5, 32 kbps VBR + DTX') && !log.includes('compatibility path'),
          `${label}: real Opus conversion completes in the worker`);
      }
      check(errors.length === 0, `${decodeRate} Hz browser: no page errors`, errors.join('; '));
    } finally { await context.close(); }
  }
}

// Visualizer zoom, scales, meter and loudness-matched A/B, on the last render.
async function verifyVisualizerTools(page) {
  console.log('\n[Browser 3c] Zoom, scales, meter, and loudness-matched A/B');
  const view = () => page.evaluate(() => document.getElementById('visualizer').dataset.view || '');
  const span = (v) => { const m = /:([\d.]+)-([\d.]+)$/.exec(v); return m ? Number(m[2]) - Number(m[1]) : NaN; };
  await page.locator('#viz-wave').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('wave'));
  const full = span(await view());
  await page.locator('#viz-zoom-in').click();
  await page.locator('#viz-zoom-in').click();
  await page.waitForFunction((f) => {
    const m = /:([\d.]+)-([\d.]+)$/.exec(document.getElementById('visualizer').dataset.view || '');
    return m && Number(m[2]) - Number(m[1]) < f * 0.3;
  }, full);
  check(Math.abs(span(await view()) - full / 4) < 0.01, 'two zoom steps show a quarter of the file', `${span(await view()).toFixed(3)} of ${full.toFixed(3)} s`);
  await page.locator('#visualizer').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('0');
  await page.waitForFunction((f) => {
    const m = /:([\d.]+)-([\d.]+)$/.exec(document.getElementById('visualizer').dataset.view || '');
    return m && Math.abs(Number(m[2]) - Number(m[1]) - f) < 1e-3;
  }, full);
  check(true, 'keyboard pans and 0 returns to the whole file');
  const box = await page.locator('#visualizer').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5);
  const seeked = await page.evaluate(() => document.getElementById('preview').currentTime / document.getElementById('preview').duration);
  check(Math.abs(seeked - 0.75) < 0.02, 'a click on the waveform seeks the player', seeked.toFixed(3));
  await page.locator('#viz-log').click();
  check(await page.locator('#viz-log').getAttribute('aria-pressed') === 'true' && !(await page.locator('#viz-range').isHidden()),
    'WAVE switches to a dBFS amplitude scale with a selectable range');
  await page.locator('#viz-log').click();
  await page.locator('#viz-spec').click();
  const wasLog = await page.locator('#viz-log').getAttribute('aria-pressed') === 'true';
  if (!wasLog) await page.locator('#viz-log').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('spec:log'));
  check(true, 'SPEC renders a log-frequency spectrogram');
  const range = await page.locator('#viz-range').textContent();
  await page.locator('#viz-range').click();
  check(await page.locator('#viz-range').textContent() !== range, 'the dynamic range button cycles');
  await page.locator('#viz-range').click(); await page.locator('#viz-range').click(); await page.locator('#viz-range').click();
  if (!wasLog) await page.locator('#viz-log').click();
  await page.locator('#viz-wave').click();

  await page.waitForFunction(() => document.querySelectorAll('#meter-rows tr').length >= 2
    && !document.getElementById('meter-rows').textContent.includes('…'), null, { timeout: 60000 });
  const meter = await page.evaluate(() => [...document.querySelectorAll('#meter-rows tr')].map(r => [...r.children].map(c => c.textContent)));
  const lufs = (row) => Number(row[1].replace('−', '-'));
  check(meter[0][0] === 'WET' && meter[1][0] === 'DRY' && Number.isFinite(lufs(meter[0])) && Number.isFinite(lufs(meter[1])),
    'meter lists integrated loudness for the render and the source', `${meter[0][1]} / ${meter[1][1]} LUFS`);
  await page.locator('#ab-match').click();
  const matched = await page.locator('#ab-match').textContent();
  const gains = await page.evaluate(() => ({ louder: state.abLouder, offset: state.abOffsetDb }));
  check(/^Matched: (wet|dry) −?\d+\.\d dB$/.test(matched) && gains.offset <= 0
    && Math.abs(Math.abs(gains.offset) - Math.abs(lufs(meter[0]) - lufs(meter[1]))) < 0.11,
    'loudness matching lowers the louder version by the LUFS difference', matched);
  await page.locator('#ab-match').click();
  await page.locator('h1').click();
  const before = await page.locator('#ab-toggle').textContent();
  await page.keyboard.press('b');
  check(await page.locator('#ab-toggle').textContent() !== before, 'the B key switches A/B');
  await page.keyboard.press('b');
}

async function verifyLanesAndSelection(page) {
  console.log('\n[Browser 3d] Codec and loudness lanes, frequency zoom, resolution, selection and loop');
  const view = () => page.evaluate(() => document.getElementById('visualizer').dataset.view || '');
  const band = (v) => { const m = /:f([\d.]+)-([\d.]+):/.exec(v); return m ? [Number(m[1]), Number(m[2])] : null; };
  const span = (v) => { const m = /:([\d.]+)-([\d.]+)$/.exec(v); return m ? Number(m[2]) - Number(m[1]) : NaN; };
  // The canvas's place on screen, read before each gesture (clicks may scroll the page).
  const canvasBox = async () => { await page.locator('#visualizer').scrollIntoViewIfNeeded(); return page.locator('#visualizer').boundingBox(); };
  let box = await canvasBox();
  await page.mouse.move(0, 0);
  await page.locator('#viz-wave').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('wave'));
  // Pixels of a lane, as [r, g, b] per pixel of its middle row or of its whole height.
  const lanePixels = (region) => page.evaluate((which) => {
    const canvas = document.getElementById('visualizer'), rect = canvas.getBoundingClientRect(), scale = canvas.width / rect.width;
    const L = vizLayout(rect.width, rect.height);
    const [y0, h] = which === 'lane' ? [L.laneY + L.laneH / 2, 1] : [L.lufsY + 2, L.lufsH - 4];
    if (!h || (which === 'lane' && !L.laneH)) return [];
    const data = canvas.getContext('2d').getImageData(0, Math.round(y0 * scale), canvas.width, Math.max(1, Math.round(h * scale))).data;
    const out = [];
    for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]]);
    return out;
  }, region);

  const lane = await page.evaluate(() => {
    const info = state.lastCodecInfo;
    const items = [...document.querySelectorAll('#viz-legend .lg-item')].filter(e => e.querySelector('.lg-box')).map(e => e.textContent);
    return { frames: info.frames, log: info.frameLog.length, bytes: info.frameBytes.reduce((a, b) => a + b, 0), encoded: info.encodedBytes,
      items, sum: items.reduce((n, t) => n + Number(t.split(' ').pop()), 0), legend: !document.getElementById('viz-legend').hidden,
      colors: FRAME_STYLE.map(f => f.color) };
  });
  check(lane.log === lane.frames && lane.bytes === lane.encoded && lane.legend && lane.sum === lane.frames,
    'the codec lane logs every frame and its legend counts them', lane.items.join(', '));
  const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  const laneColors = new Set((await lanePixels('lane')).map(hex));
  check([...laneColors].some(c => lane.colors.includes(c)), 'the codec lane is drawn under the waveform in the frame colours', [...laneColors].slice(0, 4).join(' '));

  await page.locator('#viz-lufs').click();
  await page.waitForFunction(() => state.meterStats && state.meterStats.wet && state.meterStats.wet.history);
  const lufsLegend = await page.locator('#viz-legend').textContent();
  const blue = (await lanePixels('lufs')).filter(([r, g, b]) => b > 80 && b > r + 30).length;
  check(await page.locator('#viz-lufs').getAttribute('aria-pressed') === 'true' && lufsLegend.includes('Loudness') && blue > 0,
    'the loudness lane draws the render\'s loudness history', `${blue} px`);

  // Frequency zoom and resolution, on the linear axis.
  await page.locator('#viz-spec').click();
  if (await page.locator('#viz-log').getAttribute('aria-pressed') === 'true') await page.locator('#viz-log').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('spec:lin'));
  const fullBand = band(await view());
  box = await canvasBox();
  const mainH = await page.evaluate(() => { const r = document.getElementById('visualizer').getBoundingClientRect(); return vizLayout(r.width, r.height).mainH; });
  await page.mouse.move(box.x + 10, box.y + mainH * 0.8);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((hi) => { const m = /:f([\d.]+)-([\d.]+):/.exec(document.getElementById('visualizer').dataset.view || ''); return m && Number(m[2]) - Number(m[1]) < hi * 0.5; }, fullBand[1]);
  const zoomedBand = band(await view());
  check(fullBand[0] === 0 && zoomedBand[1] - zoomedBand[0] < (fullBand[1] - fullBand[0]) * 0.5,
    'the wheel over the frequency ruler zooms the spectrogram\'s band', `${zoomedBand[0].toFixed(0)}–${zoomedBand[1].toFixed(0)} Hz`);
  box = await canvasBox();
  await page.mouse.dblclick(box.x + 10, box.y + mainH * 0.5);
  await page.waitForFunction((hi) => { const m = /:f([\d.]+)-([\d.]+):/.exec(document.getElementById('visualizer').dataset.view || ''); return m && Number(m[2]) === hi; }, fullBand[1]);
  await page.locator('#visualizer').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((hi) => { const m = /:f([\d.]+)-([\d.]+):/.exec(document.getElementById('visualizer').dataset.view || ''); return m && Number(m[2]) - Number(m[1]) < hi * 0.6; }, fullBand[1]);
  await page.keyboard.press('0');
  await page.waitForFunction((hi) => { const m = /:f([\d.]+)-([\d.]+):/.exec(document.getElementById('visualizer').dataset.view || ''); return m && Number(m[2]) === hi && Number(m[1]) === 0; }, fullBand[1]);
  check(true, 'double-click on the ruler, ↑ and 0 reset and zoom the band');

  const resolution = () => page.evaluate(() => (vizImage && vizImage.tiers ? { fixed: vizImage.fixed, windows: vizImage.tiers.map(t => t.windowSec), rate: audibleBuffer().rate } : null));
  const whole = await resolution();
  await page.locator('#viz-zoom-in').click();
  await page.locator('#viz-zoom-in').click();
  await page.waitForFunction(() => vizImage && vizImage.tiers && (document.getElementById('visualizer').dataset.view || '').startsWith('spec') && vizImage.t1 - vizImage.t0 < 0.2);
  const zoomed = await resolution();
  check(!whole.fixed && zoomed.windows[0] < whole.windows[0], 'AUTO resolution shortens the window when zoomed in on time',
    `${(whole.windows[0] * 1000).toFixed(1)} → ${(zoomed.windows[0] * 1000).toFixed(1)} ms`);
  await page.locator('#viz-res').selectOption('4096');
  await page.waitForFunction(() => vizImage && vizImage.fixed === 4096 && (document.getElementById('visualizer').dataset.view || '').startsWith('spec'));
  const fixed = await resolution();
  check(fixed.windows.every(w => Math.abs(w - 4096 / fixed.rate) < 1e-9), 'a fixed RES sets the FFT size', `${(fixed.windows[0] * 1000).toFixed(1)} ms`);
  await page.locator('#viz-res').selectOption('auto');
  await page.locator('#viz-fit').click();

  // Selection: Shift + drag, meter statistics for it, Shift + click, loop, zoom, Esc.
  await page.locator('#viz-wave').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('wave'));
  box = await canvasBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.04, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.96, box.y + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => !document.getElementById('meter-sel').hidden && document.querySelectorAll('#meter-rows tr').length >= 2
    && !document.getElementById('meter-rows').textContent.includes('…'), null, { timeout: 60000 });
  const selected = await page.evaluate(() => {
    const rate = state.processedRate, from = Math.floor(vizSel.t0 * rate), to = Math.ceil(vizSel.t1 * rate);
    return { t0: vizSel.t0, t1: vizSel.t1, expect: TF2Meter.analyze(state.processedBuffer.subarray(from, to), rate).integrated,
      shown: Number(document.querySelector('#meter-rows tr td').textContent.replace('−', '-')), text: document.getElementById('meter-sel-text').textContent };
  });
  check(Math.abs(selected.t0 - 0.02) < 0.01 && Math.abs(selected.t1 - 0.48) < 0.01 && Math.abs(selected.shown - selected.expect) < 0.051,
    'Shift + drag selects a range and the meter measures it', `${selected.text}; ${selected.shown} LUFS`);
  box = await canvasBox();
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + box.width * 0.6, box.y + 30);
  await page.keyboard.up('Shift');
  const extended = await page.evaluate(() => vizSel && [vizSel.t0, vizSel.t1]);
  check(Math.abs(extended[0] - 0.02) < 0.01 && Math.abs(extended[1] - 0.3) < 0.01, 'Shift + click moves the nearer end of the selection', extended.map(t => t.toFixed(3)).join('–'));
  await page.locator('h1').click();
  await page.keyboard.press('l');
  check(await page.locator('#viz-loop').getAttribute('aria-pressed') === 'true' && !(await page.evaluate(() => document.getElementById('preview').loop)),
    'L loops the selection (not the whole file)');
  await page.locator('#visualizer').focus();
  await page.keyboard.press('z');
  await page.waitForFunction(() => { const m = /:([\d.]+)-([\d.]+)$/.exec(document.getElementById('visualizer').dataset.view || ''); return m && Number(m[2]) - Number(m[1]) < 0.4; });
  check(Math.abs(span(await view()) - 0.28 * 1.1) < 0.01, 'Z zooms to the selection', span(await view()).toFixed(3));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('meter-sel').hidden);
  check(await page.evaluate(() => document.getElementById('preview').loop), 'Esc clears the selection; the loop then covers the whole file');
  await page.locator('h1').click();
  await page.keyboard.press('l');
  check(await page.locator('#viz-loop').getAttribute('aria-pressed') === 'false' && !(await page.evaluate(() => document.getElementById('preview').loop)), 'L turns the loop off');
  await page.locator('#viz-lufs').click();
  await page.locator('#viz-fit').click();
}

async function verifyAverageAndRealTake(page) {
  console.log('\n[Browser 3e] Average spectrum and the real-take comparison');
  const view = () => page.evaluate(() => document.getElementById('visualizer').dataset.view || '');
  await page.locator('#file').setInputFiles({ name: 'speech.wav', mimeType: 'audio/wav', buffer: wavSpeech(6) });
  await page.waitForFunction(() => state.sourceName === 'speech.wav' && !document.getElementById('process').disabled);
  await page.locator('#process').click();
  await page.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
  await page.locator('#viz-bars').click();
  if (await page.locator('#viz-avg').getAttribute('aria-pressed') !== 'true') await page.locator('#viz-avg').click();
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('avg:dry'), null, { timeout: 60000 });
  check((await view()).startsWith('avg:dry:0.0000-6.0000'), 'BARS AVG shows the average spectrum of the render against the source', await view());

  // A take made from the render: 0.4321 s late, its clock 100 ppm fast,
  // 6 dB down, recorded at 44.1 kHz.
  const wav = await page.evaluate(async () => {
    const sim = state.processedBuffer, rate = state.processedRate, k = 1.0001;
    const take = TF2Reference.warp(sim, rate, { offsetSeconds: .4321, scale: 1 / k }, rate, sim.length + rate);
    const at44 = TF2Audio.resampleSinc(take.map(v => v * .5), rate, 44100);
    return [...new Uint8Array(await TF2Audio.encodeWav(at44, 44100).arrayBuffer())];
  });
  await page.locator('#reference summary').click();
  await page.locator('#reference-file').setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) });
  await page.waitForFunction(() => document.querySelector('#reference-report table'), null, { timeout: 60000 });
  const take = await page.evaluate(() => ({ segments: state.realTake.timeline.segments.length,
    delay: state.realTake.timeline.segments[0].a, ppm: state.realTake.timeline.segments[0].clockPpm,
    status: document.getElementById('reference-status').textContent,
    bands: [...document.querySelectorAll('#reference-report tbody td')].map(td => td.textContent),
    rows: [...document.querySelectorAll('#meter-rows tr th')].map(th => th.textContent) }));
  check(take.segments === 1 && Math.abs(take.delay - .4321) < .001 && Math.abs(take.ppm - 100) < 10,
    'a real take is found in the source and lined up (delay and clock)', `${take.segments} segment, ${(take.delay * 1000).toFixed(2)} ms, ${take.ppm.toFixed(1)} ppm; ${take.status}`);
  const within = take.bands.slice(0, 13).map(t => Math.abs(Number(t.replace('−', '-'))));
  check(within.every(d => d <= .3), 'the report finds the take and the render alike, band by band up to 12 kHz', take.bands.join(' '));
  check(take.rows.includes('REAL') && take.rows.includes('Δ real'), 'the meter adds the real take and wet minus real');
  await page.locator('#ab-toggle').click();
  await page.locator('#ab-toggle').click();
  check(await page.locator('#ab-toggle').textContent() === 'A/B: Real' && await page.evaluate(() => audibleBuffer().label) === 'REAL',
    'A/B cycles to the real take');
  await page.waitForFunction(() => (document.getElementById('visualizer').dataset.view || '').startsWith('avg:real'), null, { timeout: 60000 });
  check(true, 'AVG compares the render with the real take once one is loaded');
  await page.locator('#reference-clear').click();
  check(await page.evaluate(() => !state.realTake) && await page.locator('#ab-toggle').textContent() === 'A/B: Wet'
    && !(await page.evaluate(() => [...document.querySelectorAll('#meter-rows tr th')].some(th => th.textContent === 'REAL'))),
    'removing the take restores wet/dry A/B and the meter');
  await page.locator('#viz-avg').click();
  await page.locator('#viz-wave').click();
}

async function verifyLiveMonitor(page) {
  console.log('\n[Browser 3f] Live monitor');
  await page.locator('#live-toggle').click();
  await page.waitForFunction(() => window.TF2Live && TF2Live.stats && TF2Live.stats.frames > 40, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const live = await page.evaluate(() => ({ stats: TF2Live.stats, latency: document.getElementById('live-latency').textContent,
    tx: document.getElementById('live-tx').textContent, pressed: document.getElementById('live-toggle').getAttribute('aria-pressed') }));
  check(live.pressed === 'true' && live.stats.sent > 0 && live.stats.modes.hybrid > 0,
    'the live monitor runs the microphone through the Steam chain in real time', `${live.stats.sent} of ${live.stats.frames} frames sent, ${live.tx}`);
  const ms = Number(/^(\d+) ms/.exec(live.latency)?.[1]);
  check(ms >= 130 && ms < 600, 'the live monitor reports its latency, gate pre-roll included', live.latency);

  // Low latency drops the 120 ms pre-roll from the chain.
  await page.locator('#live-lowlat').check();
  await page.waitForFunction(() => TF2Live.stats && TF2Live.stats.latencyMs < 20, null, { timeout: 15000 });
  const lowMs = await page.evaluate(() => TF2Live.stats.latencyMs);
  await page.locator('#live-lowlat').uncheck();
  await page.waitForFunction(() => TF2Live.stats && TF2Live.stats.latencyMs > 120, null, { timeout: 15000 });
  check(lowMs < 20, 'low-latency mode drops the gate pre-roll from the live chain', `${lowMs.toFixed(1)} ms chain delay`);

  // Push-to-talk: nothing is sent until the key or the button is held.
  await page.locator('#live-ptt').check();
  await page.waitForFunction(() => TF2Live.stats && TF2Live.stats.talking === false, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const idle0 = await page.evaluate(() => TF2Live.stats.sent);
  await page.waitForTimeout(800);
  const idle1 = await page.evaluate(() => ({ sent: TF2Live.stats.sent, tx: document.getElementById('live-tx').textContent,
    button: !document.getElementById('live-talk').hidden }));
  await page.keyboard.down('v');
  await page.waitForFunction((n) => TF2Live.stats.sent > n + 10, idle1.sent, { timeout: 15000 });
  await page.keyboard.up('v');
  check(idle1.sent === idle0 && idle1.button && /push-to-talk/.test(idle1.tx),
    'push-to-talk sends nothing until V is held, then sends', `${idle1.sent - idle0} frames sent while released; ${idle1.tx}`);
  await page.locator('#live-ptt').uncheck();

  // Record: the microphone and the voice come into the app lined up.
  await page.locator('#live-record').click();
  await page.waitForTimeout(3000);
  await page.locator('#live-record').click();
  await page.waitForFunction(() => state.sourceName && state.sourceName.startsWith('live-') && state.processedBuffer, null, { timeout: 20000 });
  const take = await page.evaluate(async () => {
    const dry = state.decodedSource.getChannelData(0), wet = state.processedBuffer, rate = state.processedRate;
    const render = (await TF2Audio.process(state.decodedSource, renderOptions())).samples;
    let dot = 0, ea = 0, eb = 0;
    for (let i = Math.round(rate * .4); i < Math.min(wet.length, render.length) - rate * .2; i++) { dot += render[i] * wet[i]; ea += render[i] ** 2; eb += wet[i] ** 2; }
    return { seconds: dry.length / rate, same: dry.length === wet.length, r: ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0,
      lane: !!(state.lastCodecInfo && state.lastCodecInfo.frameLog && state.lastCodecInfo.frameLog.some(c => c > 0)),
      ab: !els.abToggle.disabled };
  });
  check(take.seconds > 2 && take.same && take.ab && take.lane,
    'Record loads the live session into the app as a dry/wet pair with its codec lane', `${take.seconds.toFixed(1)} s`);
  check(take.r > 0.8, 'the recorded voice lines up with an offline render of the recorded microphone', `r ${take.r.toFixed(3)}`);
  await page.locator('#live-toggle').click();
  await page.waitForFunction(() => !TF2Live.running);
  check(await page.locator('#live-toggle').getAttribute('aria-pressed') === 'false', 'the live monitor stops');
}

// A minimal reader for the stored ZIPs the batch writes.
function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const end = buffer.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('no end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true), size = view.getUint32(at + 24, true), offset = view.getUint32(at + 42, true);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = view.getUint16(offset + 26, true);
    files.push({ name, data: buffer.subarray(offset + 30 + local, offset + 30 + local + size), crc: view.getUint32(at + 16, true) });
    at += 46 + nameLength;
  }
  return files;
}

async function verifyBatchAndFormats(browser, base) {
  console.log('\n[Browser 6] Batch queue, drag and drop, and download formats');
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const summary = () => page.locator('#batch-summary').textContent();
    await page.locator('#batch-files').setInputFiles([
      { name: 'b-song.wav', mimeType: 'audio/wav', buffer: wavTone(0.6, 48000, 330) },
      { name: 'a-song.wav', mimeType: 'audio/wav', buffer: wavTone(0.5, 44100, 440) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') }
    ]);
    check((await summary()).includes('2 files') && (await summary()).includes('skipped 1 file'), 'batch adds audio files and skips others', await summary());
    check(JSON.stringify(await page.locator('.batch-item .bi-name').allTextContents()) === '["a-song.wav","b-song.wav"]', 'batch sorts files by name');
    // A multi-file choice in step 1 and a drop on the batch panel both queue files.
    await page.locator('#file').setInputFiles([
      { name: 'c-song.wav', mimeType: 'audio/wav', buffer: wavTone(0.4, 48000, 550) },
      { name: 'd-song.wav', mimeType: 'audio/wav', buffer: wavTone(0.3, 48000, 660) }]);
    await page.evaluate(async (bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'e-song.wav', { type: 'audio/wav' }));
      document.getElementById('batch-list').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [...wavTone(0.3, 48000, 770)]);
    await page.waitForFunction(() => document.querySelectorAll('.batch-item').length === 5);
    check(true, 'step 1 multi-select and a drop on the batch panel add to the queue');
    // A single file dropped elsewhere loads as the source instead.
    await page.evaluate(async (bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped-source.wav', { type: 'audio/wav' }));
      document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [...wavTone(0.3)]);
    await page.waitForFunction(() => state.sourceName === 'dropped-source.wav');
    check(true, 'one file dropped outside the batch loads as the source');
    for (const name of ['c-song.wav', 'd-song.wav', 'e-song.wav']) {
      await page.locator('.batch-item', { hasText: name }).locator('.bi-remove').click();
    }
    await page.locator('#batch-run').click();
    await page.waitForFunction(() => /2 rendered/.test(document.getElementById('batch-summary').textContent), null, { timeout: 120000 });
    const statuses = await page.locator('.batch-item .bi-status').allTextContents();
    check(statuses.every(text => /^Done · 0:01 · −\d+\.\d LUFS · −\d+\.\d dBTP/.test(text)), 'rendered items report loudness and true peak', statuses.join(' | '));

    const zips = {};
    for (const format of ['wav', 'flac', 'mp3']) {
      await page.locator('#format').selectOption(format);
      check((await page.locator('#batch-zip').textContent()).includes(format.toUpperCase()), `ZIP button names ${format.toUpperCase()}`);
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#batch-zip').click()]);
      const buffer = fs.readFileSync(await download.path());
      zips[format] = readZip(buffer);
      const names = zips[format].map(f => f.name).join(', ');
      check(download.suggestedFilename() === `tf2_voice_steam_2_${format}.zip` && names === `a-song_tf2_steam.${format}, b-song_tf2_steam.${format}`,
        `${format.toUpperCase()} ZIP holds both renders`, names);
    }
    check(zips.wav.every(f => f.data.subarray(0, 4).toString() === 'RIFF') && zips.flac.every(f => f.data.subarray(0, 4).toString() === 'fLaC')
      && zips.mp3.every(f => f.data.subarray(0, 700).includes('Xing') && f.data.subarray(0, 700).includes('LAME3.100')),
      'ZIP entries are WAV, FLAC and MP3 (LAME VBR) files');
    // The browser's own decoders: FLAC must give back the WAV's samples exactly.
    const decoded = await page.evaluate(async ({ wav, flac, mp3 }) => {
      const decode = async (bytes) => {
        const probe = new DataView(new Uint8Array(wav).buffer);
        const context = new OfflineAudioContext(1, 1, probe.getUint32(24, true));
        return (await context.decodeAudioData(new Uint8Array(bytes).buffer)).getChannelData(0);
      };
      const [a, b, c] = await Promise.all([decode(wav), decode(flac), decode(mp3)]);
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) same = a[i] === b[i];
      return { same, wav: a.length, mp3: c.length };
    }, { wav: [...zips.wav[0].data], flac: [...zips.flac[0].data], mp3: [...zips.mp3[0].data] });
    check(decoded.same, 'FLAC decodes to exactly the WAV samples in the browser', `${decoded.wav} samples`);
    check(Math.abs(decoded.mp3 - decoded.wav) <= 1152, 'MP3 decodes to the WAV duration in the browser', `${decoded.mp3} vs ${decoded.wav}`);

    await page.locator('#advanced-toggle').click();
    await page.locator('#volume').fill('0.3');
    await page.locator('#volume').dispatchEvent('change');
    check((await summary()).includes('2 with older settings') && (await page.locator('.batch-item[data-state="stale"]').count()) === 2,
      'changing a setting marks earlier renders as older');
    await page.locator('#batch-clear').click();
    check((await summary()) === 'No files queued.' && (await page.locator('.batch-item').count()) === 0, 'Clear empties the queue');

    // Single render saved as FLAC through the format picker.
    await page.locator('#file').setInputFiles({ name: 'solo.wav', mimeType: 'audio/wav', buffer: wavTone(0.4) });
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
    await page.locator('#format').selectOption('flac');
    check(await page.locator('#download').textContent() === 'Download FLAC', 'download button follows the format');
    const [single] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#download').click()]);
    check(single.suggestedFilename() === 'solo_tf2_steam.flac'
      && fs.readFileSync(await single.path()).subarray(0, 4).toString() === 'fLaC', 'single render downloads as FLAC');
    await page.reload({ waitUntil: 'domcontentloaded' });
    check(await page.locator('#format').inputValue() === 'flac', 'the chosen format is remembered');
    check(errors.length === 0, 'batch and formats run without page errors', errors.join('; '));
  } finally { await context.close(); }
}

async function activateServiceWorker(page, scriptPath) {
  // Activation and controller assignment are separate lifecycle events. Wait
  // for BOTH, and fail on timeout rather than silently proceeding offline.
  await page.evaluate(async (path) => {
    const expected = new URL(path, location.href).href;
    await navigator.serviceWorker.register(path);
    await new Promise((resolve, reject) => {
      let observed = null;
      const cleanup = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', inspect);
        observed?.removeEventListener('statechange', inspect);
      };
      const inspect = () => {
        const controller = navigator.serviceWorker.controller;
        if (controller !== observed) {
          observed?.removeEventListener('statechange', inspect);
          observed = controller;
          observed?.addEventListener('statechange', inspect);
        }
        if (controller?.scriptURL === expected && controller.state === 'activated') {
          cleanup(); resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup(); reject(new Error(`Service worker did not activate and control the page: ${expected}`));
      }, 30000);
      navigator.serviceWorker.addEventListener('controllerchange', inspect);
      inspect();
    });
  }, scriptPath);
}

async function main() {
  const root = path.join(__dirname, '..');
  const server = await createStaticServer(root);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let browser = null, context = null;
  try {
    const launchOptions = { headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] };
    // Optional: a preinstalled Chromium whose build differs from Playwright's pin.
    if (process.env.CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE;
    try { browser = await chromium.launch(launchOptions); }
    catch (error) {
      if (!String(error.message).includes('Executable doesn\'t exist')) throw error;
      browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
    }
    context = await browser.newContext({ serviceWorkers: 'allow', permissions: ['microphone'] });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    console.log('\n[Browser 1] Startup and malformed persisted state');
    await page.goto(`${base}/#codec=not-a-codec&gain=not-a-number`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    check(pageErrors.length === 0, 'malformed share URL does not crash', pageErrors.join('; '));
    check(await page.locator('#codec').inputValue() === 'steam', 'invalid codec retains real Opus default');
    check(await page.locator('#gain').inputValue() === '1.0', 'invalid number retains safe default');
    await page.evaluate(() => {
      localStorage.setItem('tf2ve_history', JSON.stringify({ broken: true }));
      localStorage.setItem('tf2ve_presets', JSON.stringify(['broken']));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    check(pageErrors.length === 0, 'malformed local storage does not crash');

    console.log('\n[Browser 2] Accessibility, disclosure, and safe console');
    const controlIds = ['codec', 'listener_position', 'gain', 'voice_scale', 'hp', 'lp', 'env',
      'c_dur', 'c_dec', 'c_mix', 'agc', 'maxgain', 'avggain', 'volume', 'bits', 'frameMs', 'loss', 'warble_on',
      'capture_channel', 'vad', 'vad_threshold', 'jitter'];
    const unlabeled = await page.evaluate((ids) => ids.filter((id) => {
      const element = document.getElementById(id);
      return !element || !element.labels || element.labels.length === 0;
    }), controlIds);
    check(unlabeled.length === 0, 'every settings control has an associated label', unlabeled.join(', '));
    check(!(await page.locator('#gain').isVisible()), 'advanced controls start collapsed');
    await page.locator('#advanced-toggle').click();
    check(await page.locator('#gain').isVisible(), 'advanced controls expand');
    await page.locator('#bits').fill('6');
    await page.locator('#agc').selectOption('0');
    await page.locator('#maxgain').fill('3');
    await page.locator('#volume').fill('0.1');
    await page.locator('#vad').selectOption('0');
    await page.locator('#vad_threshold').fill('-20');
    await page.locator('#capture_channel').selectOption('mix');
    await page.getByRole('button', { name: 'Modern (Steam Voice)', exact: true }).click();
    check(await page.locator('#codec').inputValue() === 'steam', 'Modern preset selects the measured 24 kHz Steam profile');
    check(await page.locator('#lp').inputValue() === '20000' && await page.locator('#hp').inputValue() === '0',
      'Modern preset leaves the optional sender filters off');
    check(Number(await page.locator('#gain').inputValue()) === 1, 'Modern preset restores unity capture gain');
    check(await page.locator('#bits').inputValue() === '16' && await page.locator('#agc').inputValue() === '1'
      && await page.locator('#maxgain').inputValue() === '10' && await page.locator('#avggain').inputValue() === '0.5'
      && await page.locator('#volume').inputValue() === '0.5',
      'preset resets quality, receiver auto-gain and output overrides');
    check(await page.locator('#vad').inputValue() === 'auto' && await page.locator('#vad_threshold').inputValue() === '-39.5'
      && await page.locator('#capture_channel').inputValue() === 'left',
      'preset restores the measured voice gate and left-channel capture');
    await page.locator('#console-details summary').click();
    await page.locator('#console-input').fill('echo <img src=x onerror="window.__consoleXss=1">');
    await page.locator('#console-input').press('Enter');
    check(await page.locator('#console-out img').count() === 0, 'console treats entered HTML as text');
    check(await page.evaluate(() => !window.__consoleXss), 'console input cannot execute markup');

    console.log('\n[Browser 3] Worker render and cancellation');
    await page.locator('#file').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wavTone(0.5) });
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    const decodedSource = await page.evaluate(() => ({ rate: state.decodedSource.sampleRate, length: state.decodedSource.length }));
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
    check((await page.locator('#preview').getAttribute('src') || '').startsWith('blob:'), 'worker render creates playable output');
    check((await page.locator('#source-status').textContent()).includes('Ready'), 'completed render reports ready');
    checkRenderedTone(await readRenderedWav(page), decodedSource, 'Default browser');
    const consoleText = await page.locator('#console-out').textContent();
    check(!consoleText.includes('compatibility path'), 'dedicated audio worker completed the render');
    check(consoleText.includes('libopus 1.1.5, 32 kbps VBR + DTX'), 'worker used the pinned real Opus codec');
    await page.evaluate(() => { document.getElementById('preview').volume = .25; document.getElementById('preview').playbackRate = 1.25; });
    await page.waitForFunction(() => {
      const dry = document.getElementById('preview-dry');
      return dry.volume === .25 && dry.playbackRate === 1.25;
    });
    check(true, 'A/B comparison preserves playback volume and speed');

    console.log('\n[Browser 3b] Visualizer, signal chain, presets, console, net_graph');
    const painted = () => page.evaluate(() => {
      const canvas = document.getElementById('visualizer');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 16) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
      return lit / (data.length / 16);
    });
    for (const mode of ['wave', 'bars', 'spec']) {
      await page.locator(`#viz-${mode}`).click();
      check(await page.locator(`#viz-${mode}`).getAttribute('aria-pressed') === 'true', `${mode.toUpperCase()} view is selected`);
      // WAVE and SPEC images are computed for the visible range; wait for the finished one.
      if (mode !== 'bars') await page.waitForFunction((m) => (document.getElementById('visualizer').dataset.view || '').startsWith(m), mode);
      check(await painted() > 0.02, `${mode.toUpperCase()} view paints the rendered audio`);
    }
    await verifyVisualizerTools(page);
    await verifyLanesAndSelection(page);
    await page.locator('#viz-wave').click();
    await page.locator('#loss').fill('12');
    await page.locator('#loss').dispatchEvent('change');
    check((await page.locator('#signal-chain').textContent()).includes('12% lost'), 'signal chain follows control edits');
    check(await page.locator('.preset-row .preset-btn[aria-pressed="true"]').count() === 0, 'a hand-edited control clears the active preset');
    await page.getByRole('button', { name: 'Laggy 18% Loss', exact: true }).click();
    check(await page.locator('.preset-btn[data-preset="laggy"]').getAttribute('aria-pressed') === 'true'
      && (await page.locator('#signal-chain').textContent()).includes('18% lost · 50 ms jitter')
      && await page.locator('#jitter').inputValue() === '50', 'preset highlights itself and updates the chain, including jitter');
    await page.getByRole('button', { name: 'Modern (Steam Voice)', exact: true }).click();
    check(await page.locator('#jitter').inputValue() === '0', 'presets reset jitter');
    await page.getByRole('button', { name: 'Modern (Steam Voice)', exact: true }).click();
    await page.locator('#console-input').fill('net_g');
    await page.locator('#console-input').press('Tab');
    check(await page.locator('#console-input').inputValue() === 'net_graph ', 'Tab completes a unique command');
    await page.locator('#console-input').fill('voice_m');
    await page.locator('#console-input').press('Tab');
    const listing = await page.locator('#console-out').textContent();
    check(listing.includes('voice_maxgain = "10"') && listing.includes('voice_micgain = "1'), 'ambiguous Tab lists candidates with values');
    await page.locator('#console-input').fill('net_graph 2');
    await page.locator('#console-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('ng-in').textContent !== '0 0.00');
    check((await page.locator('#ng-in').textContent()).startsWith('50 '), 'net_graph reports the rendered packet rate', await page.locator('#ng-in').textContent());
    await page.locator('#console-input').fill('net_graph 0');
    await page.locator('#console-input').press('Enter');

    const parity = await page.evaluate(async () => {
      const data = Float32Array.from({ length: 24000 }, (_, i) => .2 * Math.sin(2 * Math.PI * 431 * i / 24000));
      const opts = { codec: 'steam', bits: 10, lossPct: 25, frameMs: 60, seed: 56 };
      const direct = await TF2Audio.process({ sampleRate: 24000, length: data.length, numberOfChannels: 1, getChannelData: () => data }, opts);
      const worker = new Worker('audio-worker.js');
      try {
        const result = await new Promise((resolve, reject) => {
          worker.onerror = reject;
          worker.onmessage = e => {
            if (e.data.type === 'result') resolve(e.data);
            if (e.data.type === 'error') reject(new Error(e.data.message));
          };
          worker.postMessage({ type: 'process', id: 1, samples: data.buffer, sampleRate: 24000, opts });
        });
        const samples = new Float32Array(result.samples);
        return { exact: samples.length === direct.samples.length && samples.every((v, i) => v === direct.samples[i]),
          plc: result.codecInfo.plc, lost: result.codecInfo.lostFrames };
      } finally { worker.terminate(); }
    });
    check(parity.exact && parity.plc === 'opus' && parity.lost > 0, 'worker and main thread agree with native packet-loss concealment');
    await verifyAverageAndRealTake(page);
    await verifyLiveMonitor(page);

    await page.locator('#file').setInputFiles({ name: 'long-tone.wav', mimeType: 'audio/wav', buffer: wavTone(20) });
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    await page.locator('#process').click();
    await page.locator('#cancel-process').waitFor({ state: 'visible' });
    await page.locator('#cancel-process').click();
    await page.waitForFunction(() => document.getElementById('source-status').textContent.includes('cancelled'));
    check(!(await page.locator('#process').isDisabled()), 'cancel restores processing controls');

    await page.locator('#mic').click();
    await page.waitForFunction(() => document.getElementById('source-status').textContent.includes('Recording uncompressed'));
    await page.waitForTimeout(1100); // Accumulate a meaningful fake-microphone recording.
    await page.locator('#mic').click();
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    check((await page.locator('#source-status').textContent()).includes('microphone'), 'uncompressed microphone recording loads successfully');
    const recording = await page.evaluate(() => {
      const pcm = state.decodedSource.getChannelData(0);
      return { duration: state.decodedSource.duration, power: pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length };
    });
    check(recording.duration > .5 && recording.duration < 3 && recording.power > 1e-8,
      'PCM microphone capture contains the synthetic input at the expected duration');
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled);
    check((await page.locator('#source-status').textContent()).includes('Ready'), 'microphone PCM passes through real Opus');

    console.log('\n[Browser 4] Responsive and offline behavior');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      presetHeights: Array.from(document.querySelectorAll('.preset-row .preset-btn')).map((el) => el.getBoundingClientRect().height)
    }));
    check(mobile.fits, 'mobile layout has no horizontal overflow');
    check(mobile.presetHeights.every((height) => height >= 44), 'mobile preset targets are at least 44px');

    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    check(await page.evaluate(() => 'serviceWorker' in navigator), 'service worker is available');
    await activateServiceWorker(page, 'sw.js');
    await page.locator('#file').setInputFiles({ name: 'update-survival.wav', mimeType: 'audio/wav', buffer: wavTone(.5) });
    await page.waitForFunction(() => state.sourceName === 'update-survival.wav' && !document.getElementById('process').disabled);
    const beforeUpdate = await page.evaluate(async () => {
      await caches.open('unrelated-test-cache');
      window.__sourceBeforeWorkerUpdate = state.decodedSource;
      return { frames: state.decodedSource.length, controller: navigator.serviceWorker.controller.scriptURL };
    });
    // A different URL forces a real worker replacement, even if its bytes
    // match. Previously this triggered an automatic reload and lost the file.
    await activateServiceWorker(page, 'sw.js?cache-isolation-test=1');
    const afterUpdate = await page.evaluate(async () => ({
      keys: await caches.keys(), controller: navigator.serviceWorker.controller.scriptURL,
      sameSource: state.decodedSource === window.__sourceBeforeWorkerUpdate,
      frames: state.decodedSource?.length, sourceName: state.sourceName,
      processEnabled: !document.getElementById('process').disabled
    }));
    check(afterUpdate.controller !== beforeUpdate.controller, 'regression test performs a real service-worker replacement');
    check(afterUpdate.sameSource && afterUpdate.frames === beforeUpdate.frames && afterUpdate.sourceName === 'update-survival.wav',
      'worker replacement preserves the loaded audio without reloading');
    check(afterUpdate.processEnabled, 'worker replacement leaves Process Audio enabled');
    check(afterUpdate.keys.includes('unrelated-test-cache'), 'activation preserves unrelated origin caches');
    check(afterUpdate.keys.includes(SHELL_CACHE), 'current app shell cache is populated', SHELL_CACHE);
    check(await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      const needed = ['batch.js', 'formats.js', 'flac.js', 'zip.js', 'meter.js', 'reference.js', 'live.js', 'live-worker.js', 'live-worklet.js',
        'vendor/lame/index.mjs', 'vendor/lame/lame-3.100.wasm.mjs'];
      return (await Promise.all(needed.map(path => cache.match(new URL(path, location.href).href)))).every(Boolean);
    }, SHELL_CACHE), 'batch, format, meter, reference, live-monitor and MP3 encoder files are cached for offline use');
    // Restore the normal registration while still online. Otherwise reloading
    // registers sw.js again and races another replacement against file loading.
    await activateServiceWorker(page, 'sw.js');
    check(await page.evaluate(() => state.decodedSource === window.__sourceBeforeWorkerUpdate),
      'restoring the normal worker also preserves the loaded audio');
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    check((await page.locator('h1').textContent()) === 'TF2 Voice Emulator', 'app shell starts offline');
    await page.locator('#file').setInputFiles({ name: 'offline-tone.wav', mimeType: 'audio/wav', buffer: wavTone(.3) });
    await page.waitForFunction(() => state.sourceName === 'offline-tone.wav' && state.decodedSource && !document.getElementById('process').disabled);
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled);
    check((await page.locator('#console-out').textContent()).includes('libopus 1.1.5'), 'bundled real codec converts audio offline');
    await context.setOffline(false);
    check(pageErrors.length === 0, 'complete conversion and recording flow has no page errors', pageErrors.join('; '));

    await verifyBatchAndFormats(browser, base);
    await verifySampleRateMatrix(browser, base);

    console.log(`\n${passed} browser checks passed`);
  } finally {
    if (context) await context.setOffline(false).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
