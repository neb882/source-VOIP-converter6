/* The live monitor's voice chain (TF2Audio.createLiveChain), fed 20 ms
 * blocks of microphone audio by live-worklet.js over a MessagePort and
 * answering with processed blocks for it to play. Settings changes rebuild
 * the chain; stats go to the page ten times a second.
 *
 * Recording keeps the microphone blocks (dry) and the chain's output (wet)
 * and lines them up: each chain's output is its own input contentDelay
 * samples later (a rebuilt chain starts its count afresh). On stop the pair
 * goes to the page with a frame log for the codec lane. */
'use strict';

importScripts('constants.js', 'audio.js');

let chain = null, port = null, rate = 48000, queue = Promise.resolve(), generation = 0;
let talking = true, inputTotal = 0, recording = null;

function report(error) {
  self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
}

// Everything runs in order: a settings change waits for the block in hand.
function enqueue(task) {
  queue = queue.then(task).catch(report);
}

function configure(opts) {
  const mine = ++generation;
  enqueue(async () => {
    const next = await TF2Audio.createLiveChain(opts, rate);
    if (mine !== generation) { next.free(); return; }
    if (chain) chain.free();
    chain = next;
    chain.setTalking(talking);
    chain.startTotal = null;   // global input sample of its first block
    chain.outTotal = 0;
    chain.frameTotal = 0;
    self.postMessage({ type: 'ready', latencyMs: chain.stats.latencyMs, codec: chain.stats.codec });
  });
}

async function processBlock(block) {
  if (!chain) return;
  const c = chain, at = inputTotal;
  inputTotal += block.length;
  if (c.startTotal === null) c.startTotal = at;
  const out = await c.process(block);
  const codes = c.takeFrameCodes();
  if (recording) {
    recording.dry.push(block);
    // Output sample j of this chain is its input sample j - contentDelay.
    if (out.length) recording.wet.push({ at: c.startTotal + c.outTotal - c.contentDelay - recording.start, samples: out.slice() });
    // Codec frame k of this chain covers its input from k * 20 ms.
    codes.forEach((code, k) => recording.frames.push({ at: c.startTotal / rate + (c.frameTotal + k) * .02 - recording.start / rate, code }));
    recording.chain = c;
  }
  c.outTotal += out.length;
  c.frameTotal += codes.length;
  if (out.length) port.postMessage({ type: 'out', samples: out.buffer }, [out.buffer]);
}

function finishRecording() {
  const rec = recording;
  recording = null;
  if (!rec) return;
  const length = rec.dry.reduce((n, b) => n + b.length, 0);
  const dry = new Float32Array(length), wet = new Float32Array(length);
  let offset = 0;
  for (const b of rec.dry) { dry.set(b, offset); offset += b.length; }
  for (const piece of rec.wet) {
    for (let i = 0; i < piece.samples.length; i++) {
      const j = piece.at + i;
      if (j >= 0 && j < length) wet[j] = piece.samples[i];
    }
  }
  const frameLog = new Uint8Array(Math.ceil(length / rate * 50));
  const counts = { frames: frameLog.length, gated: 0, dtx: 0, lost: 0, late: 0, modes: { silk: 0, hybrid: 0, celt: 0 } };
  for (const { at, code } of rec.frames) {
    const f = Math.round(at * 50);
    if (f >= 0 && f < frameLog.length) frameLog[f] = code;
  }
  let spurts = 0;
  frameLog.forEach((code, f) => {
    if (code === 0) counts.gated++;
    else if (f === 0 || frameLog[f - 1] === 0) spurts++;
    if (code === 1) counts.modes.silk++;
    if (code === 2) counts.modes.hybrid++;
    if (code === 3) counts.modes.celt++;
    if (code === 4) counts.dtx++;
    if (code === 5) counts.lost++;
    if (code === 6) counts.late++;
  });
  const c = rec.chain || chain;
  const info = c ? { version: c.version, bitrate: c.bitrate, vbr: c.vbr, dtx: c.dtx, gate: c.gateDb, autoGain: c.autoGain,
    voiceRate: c.voiceRate, codec: c.stats.codec, realOpus: c.realOpus } : {};
  self.postMessage({ type: 'recording', dry: dry.buffer, wet: wet.buffer, rate, frameLog: frameLog.buffer, counts: { ...counts, spurts }, info },
    [dry.buffer, wet.buffer, frameLog.buffer]);
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'start') {
    rate = message.rate;
    port = message.port;
    port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'in') return;
      const block = new Float32Array(e.data.samples);
      enqueue(() => processBlock(block));
    };
    configure(message.opts);
  } else if (message.type === 'config') {
    configure(message.opts);
  } else if (message.type === 'talk') {
    talking = !!message.on;
    enqueue(() => { if (chain) chain.setTalking(talking); });
  } else if (message.type === 'record') {
    enqueue(() => {
      if (message.on) recording = { start: inputTotal, dry: [], wet: [], frames: [], chain: null };
      else finishRecording();
    });
  } else if (message.type === 'stop') {
    generation++;
    enqueue(() => { if (chain) chain.free(); chain = null; self.close(); });
  }
};

setInterval(() => {
  if (!chain) return;
  const s = chain.stats;
  self.postMessage({ type: 'stats', stats: { ...s, modes: { ...s.modes } }, recording: !!recording });
  s.inputPeak = 0;
  s.outputPeak = 0;
}, 100);
