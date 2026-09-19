'use strict';

const path = require('path');
const { chromium } = require('playwright');
const { createStaticServer } = require('./static-server');

let passed = 0;
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

async function main() {
  const root = path.join(__dirname, '..');
  const server = await createStaticServer(root);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let browser = null, context = null;
  try {
    const launchOptions = { headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] };
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
      'c_dur', 'c_dec', 'c_mix', 'agc', 'bits', 'frameMs', 'loss', 'warble_on'];
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
    await page.getByRole('button', { name: 'Modern (Steam Voice)', exact: true }).click();
    check(await page.locator('#codec').inputValue() === 'steam', 'Modern preset selects documented 24 kHz baseline');
    check(await page.locator('#lp').inputValue() === '11000', 'Modern preset uses provisional capture filtering');
    check(await page.locator('#hp').inputValue() === '40' && Number(await page.locator('#gain').inputValue()) === 1,
      'Modern preset restores reference-tuned bass and unity input gain');
    check(await page.locator('#bits').inputValue() === '16' && await page.locator('#agc').inputValue() === '1', 'preset resets previous quality and gain-model overrides');
    await page.locator('#console-details summary').click();
    await page.locator('#console-input').fill('echo <img src=x onerror="window.__consoleXss=1">');
    await page.locator('#console-input').press('Enter');
    check(await page.locator('#console-out img').count() === 0, 'console treats entered HTML as text');
    check(await page.evaluate(() => !window.__consoleXss), 'console input cannot execute markup');

    console.log('\n[Browser 3] Worker render and cancellation');
    await page.locator('#file').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wavTone(0.5) });
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
    check((await page.locator('#preview').getAttribute('src') || '').startsWith('blob:'), 'worker render creates playable output');
    check((await page.locator('#source-status').textContent()).includes('Ready'), 'completed render reports ready');
    const renderedWav = await page.evaluate(async () => {
      const response = await fetch(document.getElementById('preview').src);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = (from, count) => String.fromCharCode(...bytes.slice(from, from + count));
      const view = new DataView(bytes.buffer);
      let power = 0;
      for (let i = 44; i < bytes.length; i += 2) power += (view.getInt16(i, true) / 32768) ** 2;
      return { size: bytes.length, riff: text(0, 4), wave: text(8, 4), rate: view.getUint32(24, true),
        rms: Math.sqrt(power / ((bytes.length - 44) / 2)) };
    });
    check(renderedWav.riff === 'RIFF' && renderedWav.wave === 'WAVE' && renderedWav.size > 44,
      'worker output is a populated PCM WAV', `${renderedWav.size} bytes`);
    check(renderedWav.rate === 48000, 'worker WAV header preserves playback rate', `${renderedWav.rate} Hz`);
    check(renderedWav.size === 48044, 'Opus render preserves exact input duration');
    check(renderedWav.rms > .01 && renderedWav.rms < .5, 'WAV contains audible, bounded samples');
    const consoleText = await page.locator('#console-out').textContent();
    check(!consoleText.includes('compatibility path'), 'dedicated audio worker completed the render');
    check(consoleText.includes('libopus 1.6.1, 32 kbps'), 'worker used the pinned real Opus codec');
    await page.evaluate(() => { document.getElementById('preview').volume = .25; document.getElementById('preview').playbackRate = 1.25; });
    await page.waitForFunction(() => {
      const dry = document.getElementById('preview-dry');
      return dry.volume === .25 && dry.playbackRate === 1.25;
    });
    check(true, 'A/B comparison preserves playback volume and speed');

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
    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      await navigator.serviceWorker.ready;
      await caches.open('unrelated-test-cache');
      const registration = await navigator.serviceWorker.register('sw.js?cache-isolation-test=1');
      const candidate = registration.installing || registration.waiting;
      if (candidate && candidate.state !== 'activated') {
        await Promise.race([
          new Promise((resolve) => candidate.addEventListener('statechange', () => {
            if (candidate.state === 'activated' || candidate.state === 'redundant') resolve();
          })),
          new Promise((resolve) => setTimeout(resolve, 10000))
        ]);
      }
      const keys = await caches.keys();
      return { supported: true, keys };
    });
    check(sw.supported, 'service worker is available');
    check(sw.keys.includes('unrelated-test-cache'), 'activation preserves unrelated origin caches');
    check(sw.keys.includes('tf2ve-v5'), 'current app shell cache is populated');
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    check((await page.locator('h1').textContent()) === 'TF2 Voice Emulator', 'app shell starts offline');
    await page.locator('#file').setInputFiles({ name: 'offline-tone.wav', mimeType: 'audio/wav', buffer: wavTone(.3) });
    await page.waitForFunction(() => !document.getElementById('process').disabled);
    await page.locator('#process').click();
    await page.waitForFunction(() => !document.getElementById('download').disabled);
    check((await page.locator('#console-out').textContent()).includes('libopus 1.6.1'), 'bundled real codec converts audio offline');
    await context.setOffline(false);
    check(pageErrors.length === 0, 'complete conversion and recording flow has no page errors', pageErrors.join('; '));

    console.log(`\n${passed} browser checks passed`);
  } finally {
    if (context) await context.setOffline(false).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
