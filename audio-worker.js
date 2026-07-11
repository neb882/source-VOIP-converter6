/* Dedicated worker wrapper for the pure TF2Audio DSP core. */
'use strict';

importScripts('constants.js', 'audio.js');

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.type !== 'process') return;
  const id = message.id;
  try {
    const mono = new Float32Array(message.samples);
    const source = {
      sampleRate: message.sampleRate,
      duration: mono.length / message.sampleRate,
      length: mono.length,
      numberOfChannels: 1,
      getChannelData: () => mono
    };
    const opts = {
      ...(message.opts || {}),
      onProgress: (value) => self.postMessage({ type: 'progress', id, value })
    };
    const result = await TF2Audio.process(source, opts);
    self.postMessage({
      type: 'result', id,
      samples: result.samples.buffer,
      sampleRate: result.sampleRate,
      blob: result.blob,
      realOpus: result.realOpus
    }, [result.samples.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'error', id,
      message: error && error.message ? error.message : String(error)
    });
  }
});
