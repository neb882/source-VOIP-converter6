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
        check(log.includes('libopus 1.6.1, 34 kbps VBR + DTX') && !log.includes('compatibility path'),
          `${label}: real Opus conversion completes in the worker`);
      }
      check(errors.length === 0, `${decodeRate} Hz browser: no page errors`, errors.join('; '));
    } finally { await context.close(); }
  }
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
    check(consoleText.includes('libopus 1.6.1, 34 kbps VBR + DTX'), 'worker used the pinned real Opus codec');
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
      check(await painted() > 0.02, `${mode.toUpperCase()} view paints the rendered audio`);
    }
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
    check(afterUpdate.keys.includes('tf2ve-v10'), 'current app shell cache is populated');
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
    check((await page.locator('#console-out').textContent()).includes('libopus 1.6.1'), 'bundled real codec converts audio offline');
    await context.setOffline(false);
    check(pageErrors.length === 0, 'complete conversion and recording flow has no page errors', pageErrors.join('; '));

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
