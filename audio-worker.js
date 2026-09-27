/* Dedicated worker wrapper for the pure TF2Audio DSP core, for turning a
 * rendered WAV into the chosen download format, and for metering. */
'use strict';

importScripts('constants.js', 'audio.js', 'flac.js', 'formats.js', 'zip.js', 'meter.js');

async function processMessage(message) {
  const id = message.id;
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
  // Loudness and levels of the render (meter.js), when asked for.
  const stats = message.measure ? TF2Meter.analyze(result.samples, result.sampleRate) : null;
  self.postMessage({
    type: 'result', id,
    samples: result.samples.buffer,
    sampleRate: result.sampleRate,
    blob: result.blob,
    realOpus: result.realOpus,
    codecInfo: result.codecInfo,
    stats
  }, [result.samples.buffer]);
}

// WAV bytes in, the file in `message.format` out, with its CRC-32 for ZIPs.
async function exportMessage(message) {
  let bytes = await TF2Formats.fromWav(new Uint8Array(message.wav), message.format);
  if (bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
  self.postMessage({ type: 'exported', id: message.id, bytes: bytes.buffer, crc: TF2Zip.crc32(bytes) }, [bytes.buffer]);
}

// Loudness and levels (meter.js) of the samples in `message.samples`.
async function analyzeMessage(message) {
  const stats = TF2Meter.analyze(new Float32Array(message.samples), message.sampleRate);
  self.postMessage({ type: 'analyzed', id: message.id, stats });
}

const HANDLERS = { process: processMessage, export: exportMessage, analyze: analyzeMessage };

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  const handler = HANDLERS[message.type];
  if (!handler) return;
  try {
    await handler(message);
  } catch (error) {
    self.postMessage({
      type: 'error', id: message.id,
      message: error && error.message ? error.message : String(error)
    });
  }
});
