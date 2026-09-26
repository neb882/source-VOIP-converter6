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

// Steam's sender voice gate, measured frame by frame from SourceTV packets:
// a frame whose RMS exceeds the threshold is sent together with the
// prerollFrames before it and the holdFrames after it. Returns 1 per sent frame.
function gatePlan(samples, frames, frameSize, gate) {
  const sent = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * frameSize;
    const end = Math.min(samples.length, start + frameSize);
    let energy = 0;
    for (let i = start; i < end; i++) energy += samples[i] * samples[i];
    if (Math.sqrt(energy / frameSize) > gate.threshold) {
      sent.fill(1, Math.max(0, f - gate.preroll), Math.min(frames, f + gate.hold + 1));
    }
  }
  return sent;
}

export async function roundTrip(samples, sampleRate, bitrate, options = {}) {
  const frameSize = sampleRate / 50;
  const application = options.application ?? 'voip';
  const signal = options.signal ?? 'auto';
  if (!(application in APPLICATIONS)) throw new RangeError(`Unknown Opus application "${application}"`);
  if (!(signal in SIGNALS)) throw new RangeError(`Unknown Opus signal "${signal}"`);
  const complexity = options.complexity ?? 10;
  const vbr = !!options.vbr, dtx = !!options.dtx;
  const encoderOptions = { sampleRate, channels: 1, frameSize,
    application: APPLICATIONS[application], signal: SIGNALS[signal], bitrate, complexity, vbr, dtx, fec: false };
  let encoder, decoder;
  try {
    encoder = await createEncoder(encoderOptions);
    decoder = await createDecoder({ sampleRate, channels: 1 });
    const lookahead = encoder.getLookahead();
    const frames = Math.ceil((samples.length + lookahead) / frameSize);
    const lossMask = options.makeLossMask ? options.makeLossMask(frames) : null;
    const output = new Float32Array(samples.length);
    const input = new Float32Array(frameSize);
    const modes = { silk: 0, hybrid: 0, celt: 0 };
    const gate = options.gate ? {
      threshold: 10 ** (Number(options.gate.thresholdDb) / 20),
      preroll: Math.max(0, Math.round(Number(options.gate.prerollFrames) || 0)),
      hold: Math.max(0, Math.round(Number(options.gate.holdFrames) || 0))
    } : null;
    // Frames outside the plan are neither encoded nor sent, so the receiver
    // outputs silence for them. Each talk spurt starts a fresh encoder and
    // decoder, as Steam's end-of-transmission marker resets the decoder.
    const plan = gate ? gatePlan(samples, frames, frameSize, gate) : null;
    let encodedBytes = 0, lostFrames = 0, underrunFrames = 0, gatedFrames = 0, dtxFrames = 0, spurts = 0;
    let open = false;
    for (let f = 0; f < frames; f++) {
      if (plan && !plan[f]) {
        gatedFrames++;
        open = false;
        continue;
      }
      if (!open) {
        if (spurts > 0) {
          encoder.free(); encoder = null;
          decoder.free(); decoder = null;
          encoder = await createEncoder(encoderOptions);
          decoder = await createDecoder({ sampleRate, channels: 1 });
        }
        spurts++;
        open = true;
      }
      input.fill(0);
      const start = f * frameSize;
      if (start < samples.length) input.set(samples.subarray(start, Math.min(samples.length, start + frameSize)));
      // Encode even lost packets: capture/encoder state continues at the sender.
      const packet = encoder.encodeFloat(input);
      encodedBytes += packet.byteLength;
      modes[packetMode(packet)]++;
      // A DTX packet is the TOC byte alone (plus at most one byte); the
      // decoder answers it with comfort noise.
      if (packet.byteLength <= 2) dtxFrames++;
      options.onPacket?.(f, packet);
      // Loss mask: 1 = lost, concealed by the decoder; 2 = arrived too late
      // for playback, so the slot plays silence and the decoder skips it.
      const miss = lossMask ? lossMask[f] : 0;
      if (miss === 1) lostFrames++;
      else if (miss === 2) underrunFrames++;
      if (miss !== 2) {
        const decoded = miss === 1 ? decoder.decodePacketLossFloat(frameSize)
          : decoder.decodeFloat(packet, { frameSize });
        if (decoded.length !== frameSize) throw new Error('Unexpected Opus frame length');
        // Trim only libopus's declared delay. Padding remains at the END.
        const destStart = start - lookahead;
        const begin = Math.max(0, -destStart);
        const end = Math.min(frameSize, samples.length - destStart);
        if (end > begin) output.set(decoded.subarray(begin, end), destStart + begin);
      }
      if ((f & 31) === 31) {
        options.onProgress?.((f + 1) / frames);
        if (options.yieldControl) await options.yieldControl();
      }
    }
    options.onProgress?.(1);
    return { samples: output, info: { backend: 'libopus', version: (await loadLibopus()).version,
      sampleRate, bitrate, application, signal, complexity, vbr, dtx, frameSamples: frameSize, frameMs: 20,
      lookahead, frames, lostFrames, underrunFrames, gatedFrames, dtxFrames, spurts,
      gate: gate ? Number(options.gate.thresholdDb) : null,
      prerollFrames: gate ? gate.preroll : 0, holdFrames: gate ? gate.hold : 0,
      encodedBytes, modes, plc: 'opus' } };
  } finally {
    decoder?.free();
    encoder?.free();
  }
}
