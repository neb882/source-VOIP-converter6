/* The live monitor's voice chain (TF2Audio.createLiveChain), fed 20 ms
 * blocks of microphone audio by live-worklet.js over a MessagePort and
 * answering with processed blocks for it to play. Settings changes rebuild
 * the chain; stats go to the page ten times a second. */
'use strict';

importScripts('constants.js', 'audio.js');

let chain = null, port = null, rate = 48000, queue = Promise.resolve(), generation = 0;

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
    self.postMessage({ type: 'ready', latencyMs: chain.stats.latencyMs, codec: chain.stats.codec });
  });
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'start') {
    rate = message.rate;
    port = message.port;
    port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'in') return;
      const block = new Float32Array(e.data.samples);
      enqueue(async () => {
        if (!chain) return;
        const out = await chain.process(block);
        if (out.length) port.postMessage({ type: 'out', samples: out.buffer }, [out.buffer]);
      });
    };
    configure(message.opts);
  } else if (message.type === 'config') {
    configure(message.opts);
  } else if (message.type === 'stop') {
    generation++;
    enqueue(() => { if (chain) chain.free(); chain = null; self.close(); });
  }
};

setInterval(() => {
  if (!chain) return;
  const s = chain.stats;
  self.postMessage({ type: 'stats', stats: { ...s, modes: { ...s.modes } } });
  s.inputPeak = 0;
  s.outputPeak = 0;
}, 100);
