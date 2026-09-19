// Real Opus packets, 20 ms framing, and decoder packet-loss concealment.
// Pinned libopus version, not a claim of Valve's exact encoder configuration.
import { createEncoder, createDecoder, Application, Signal, loadLibopus } from './vendor/libopus/index.mjs';

export async function roundTrip(samples, sampleRate, bitrate, options = {}) {
  const frameSize = sampleRate / 50;
  let encoder, decoder;
  try {
    encoder = await createEncoder({ sampleRate, channels: 1, frameSize,
      application: Application.Voip, signal: Signal.Auto, bitrate,
      complexity: 10, vbr: false, dtx: false, fec: false });
    decoder = await createDecoder({ sampleRate, channels: 1 });
    const lookahead = encoder.getLookahead();
    const frames = Math.ceil((samples.length + lookahead) / frameSize);
    const lossMask = options.makeLossMask ? options.makeLossMask(frames) : null;
    const output = new Float32Array(samples.length);
    const input = new Float32Array(frameSize);
    let encodedBytes = 0, lostFrames = 0;
    for (let f = 0; f < frames; f++) {
      input.fill(0);
      const start = f * frameSize;
      input.set(samples.subarray(start, Math.min(samples.length, start + frameSize)));
      // Encode even lost packets: capture/encoder state continues at the sender.
      const packet = encoder.encodeFloat(input);
      encodedBytes += packet.byteLength;
      const lost = !!(lossMask && lossMask[f]);
      if (lost) lostFrames++;
      const decoded = lost ? decoder.decodePacketLossFloat(frameSize)
        : decoder.decodeFloat(packet, { frameSize });
      if (decoded.length !== frameSize) throw new Error('Unexpected Opus frame length');
      // Trim only libopus's declared delay. Padding remains at the END.
      const destStart = start - lookahead;
      const begin = Math.max(0, -destStart);
      const end = Math.min(frameSize, samples.length - destStart);
      if (end > begin) output.set(decoded.subarray(begin, end), destStart + begin);
      if ((f & 31) === 31) {
        options.onProgress?.((f + 1) / frames);
        if (options.yieldControl) await options.yieldControl();
      }
    }
    options.onProgress?.(1);
    return { samples: output, info: { backend: 'libopus', version: (await loadLibopus()).version,
      sampleRate, bitrate, frameSamples: frameSize, frameMs: 20, lookahead,
      frames, lostFrames, encodedBytes, plc: 'opus' } };
  } finally {
    decoder?.free();
    encoder?.free();
  }
}
