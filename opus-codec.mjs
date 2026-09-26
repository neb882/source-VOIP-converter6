// Real Opus packets, 20 ms framing, and decoder packet-loss concealment.
// Pinned libopus version, not a claim of Valve's exact encoder build.
import { createEncoder, createDecoder, Application, Signal, loadLibopus } from './vendor/libopus/index.mjs';

const APPLICATIONS = { voip: Application.Voip, audio: Application.Audio, lowdelay: Application.RestrictedLowDelay };
const SIGNALS = { auto: Signal.Auto, voice: Signal.Voice, music: Signal.Music };

// RFC 6716 section 3.1: the TOC configuration number selects the coding mode.
function packetMode(packet) {
  const config = packet[0] >> 3;
  return config < 12 ? 'silk' : config < 16 ? 'hybrid' : 'celt';
}

export async function roundTrip(samples, sampleRate, bitrate, options = {}) {
  const frameSize = sampleRate / 50;
  const application = options.application ?? 'voip';
  const signal = options.signal ?? 'auto';
  if (!(application in APPLICATIONS)) throw new RangeError(`Unknown Opus application "${application}"`);
  if (!(signal in SIGNALS)) throw new RangeError(`Unknown Opus signal "${signal}"`);
  let encoder, decoder;
  try {
    encoder = await createEncoder({ sampleRate, channels: 1, frameSize,
      application: APPLICATIONS[application], signal: SIGNALS[signal], bitrate,
      complexity: options.complexity ?? 10, vbr: !!options.vbr, dtx: false, fec: false });
    decoder = await createDecoder({ sampleRate, channels: 1 });
    const lookahead = encoder.getLookahead();
    const frames = Math.ceil((samples.length + lookahead) / frameSize);
    const lossMask = options.makeLossMask ? options.makeLossMask(frames) : null;
    const output = new Float32Array(samples.length);
    const input = new Float32Array(frameSize);
    const modes = { silk: 0, hybrid: 0, celt: 0 };
    // Sender voice gate: a frame whose RMS exceeds the threshold opens it for
    // that frame and the next holdFrames. Closed frames are neither encoded
    // nor sent, so the receiver outputs silence for them.
    const gate = options.gate ? {
      threshold: 10 ** (Number(options.gate.thresholdDb) / 20),
      hold: Math.max(0, Math.round(Number(options.gate.holdFrames) || 0))
    } : null;
    let encodedBytes = 0, lostFrames = 0, gatedFrames = 0, holdLeft = 0;
    for (let f = 0; f < frames; f++) {
      input.fill(0);
      const start = f * frameSize;
      input.set(samples.subarray(start, Math.min(samples.length, start + frameSize)));
      let open = true;
      if (gate) {
        let energy = 0;
        for (let i = 0; i < frameSize; i++) energy += input[i] * input[i];
        if (Math.sqrt(energy / frameSize) > gate.threshold) holdLeft = gate.hold + 1;
        open = holdLeft > 0;
        if (holdLeft > 0) holdLeft--;
      }
      if (open) {
        // Encode even lost packets: capture/encoder state continues at the sender.
        const packet = encoder.encodeFloat(input);
        encodedBytes += packet.byteLength;
        modes[packetMode(packet)]++;
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
      } else {
        gatedFrames++;
      }
      if ((f & 31) === 31) {
        options.onProgress?.((f + 1) / frames);
        if (options.yieldControl) await options.yieldControl();
      }
    }
    options.onProgress?.(1);
    return { samples: output, info: { backend: 'libopus', version: (await loadLibopus()).version,
      sampleRate, bitrate, application, signal, vbr: !!options.vbr, frameSamples: frameSize, frameMs: 20,
      lookahead, frames, lostFrames, gatedFrames, gate: gate ? Number(options.gate.thresholdDb) : null,
      encodedBytes, modes, plc: 'opus' } };
  } finally {
    decoder?.free();
    encoder?.free();
  }
}
