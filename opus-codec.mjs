// Real Opus packets, 20 ms framing, and decoder packet-loss concealment.
// Two pinned libopus builds: 1.1.5, the release Steam's voice packets match
// (tests/REFERENCE_2026.md), and 1.6.1 from libopus-wasm for the other profiles.
const RUNTIMES = {
  '1.6.1': () => import('./vendor/libopus/index.mjs'),
  '1.1.5': () => import('./vendor/libopus-1.1/index.mjs')
};
const loaded = new Map();
let celtModule = null;
const loadCelt = () => (celtModule ??= import('./vendor/celt-0.11/index.mjs'));
function runtime(version) {
  if (!(version in RUNTIMES)) throw new RangeError(`Unknown libopus runtime "${version}"`);
  if (!loaded.has(version)) loaded.set(version, RUNTIMES[version]());
  return loaded.get(version);
}

// Opus API constants, identical in every libopus release.
const APPLICATIONS = { voip: 2048, audio: 2049, lowdelay: 2051 };
const SIGNALS = { auto: -1000, voice: 3001, music: 3002 };

// Codes in roundTrip's info.frameLog, one per 20 ms frame (info.frameBytes
// holds each frame's packet size; 0 when the gate held it back).
export const FRAME = { gated: 0, silk: 1, hybrid: 2, celt: 3, dtx: 4, lost: 5, late: 6 };

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

// Encoder settings shared by roundTrip and createVoiceStream.
function encoderSettings(sampleRate, bitrate, options) {
  const frameSize = sampleRate / 50;
  const application = options.application ?? 'voip';
  const signal = options.signal ?? 'auto';
  if (!(application in APPLICATIONS)) throw new RangeError(`Unknown Opus application "${application}"`);
  if (!(signal in SIGNALS)) throw new RangeError(`Unknown Opus signal "${signal}"`);
  const complexity = options.complexity ?? 10;
  const vbr = !!options.vbr, dtx = !!options.dtx;
  return { sampleRate, channels: 1, frameSize,
    application: APPLICATIONS[application], signal: SIGNALS[signal], bitrate, complexity, vbr, dtx, fec: false };
}

// One 20 ms frame at a time, with roundTrip's settings: for the live monitor.
// restart() starts a new talk spurt with a fresh encoder and decoder, as
// roundTrip does. encode() returns the packet with its mode; decode() and
// conceal() return frameSize samples.
export async function createVoiceStream(sampleRate, bitrate, options = {}) {
  const encoderOptions = encoderSettings(sampleRate, bitrate, options);
  const { frameSize } = encoderOptions;
  const { createEncoder, createDecoder, loadLibopus } = await runtime(options.runtime ?? '1.6.1');
  let encoder = await createEncoder(encoderOptions);
  let decoder = await createDecoder({ sampleRate, channels: 1 });
  return {
    frameSize,
    version: (await loadLibopus()).version,
    lookahead: encoder.getLookahead(),
    async restart() {
      encoder.free(); decoder.free();
      encoder = await createEncoder(encoderOptions);
      decoder = await createDecoder({ sampleRate, channels: 1 });
    },
    encode(frame) {
      const packet = encoder.encodeFloat(frame);
      return { bytes: packet.byteLength, mode: packetMode(packet), dtx: packet.byteLength <= 2, packet };
    },
    decode(packet) { return decoder.decodeFloat(packet, { frameSize }); },
    conceal() { return decoder.decodePacketLossFloat(frameSize); },
    free() { encoder?.free(); decoder?.free(); encoder = decoder = null; }
  };
}

export async function roundTrip(samples, sampleRate, bitrate, options = {}) {
  const encoderOptions = encoderSettings(sampleRate, bitrate, options);
  const { frameSize, complexity, vbr, dtx } = encoderOptions;
  const application = options.application ?? 'voip', signal = options.signal ?? 'auto';
  const { createEncoder, createDecoder, loadLibopus } = await runtime(options.runtime ?? '1.6.1');
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
    // What happened to each frame, for the visualizer's codec lane.
    const frameLog = new Uint8Array(frames), frameBytes = new Uint16Array(frames);
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
      frameBytes[f] = packet.byteLength;
      const mode = packetMode(packet);
      modes[mode]++;
      // A DTX packet is the TOC byte alone (plus at most one byte); the
      // decoder answers it with comfort noise.
      const dtx = packet.byteLength <= 2;
      if (dtx) dtxFrames++;
      frameLog[f] = dtx ? FRAME.dtx : FRAME[mode];
      options.onPacket?.(f, packet);
      // Loss mask: 1 = lost, concealed by the decoder; 2 = arrived too late
      // for playback, so the slot plays silence and the decoder skips it.
      const miss = lossMask ? lossMask[f] : 0;
      if (miss === 1) { lostFrames++; frameLog[f] = FRAME.lost; }
      else if (miss === 2) { underrunFrames++; frameLog[f] = FRAME.late; }
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
      runtime: options.runtime ?? '1.6.1', sampleRate, bitrate, application, signal, complexity, vbr, dtx, frameSamples: frameSize, frameMs: 20,
      lookahead, frames, lostFrames, underrunFrames, gatedFrames, dtxFrames, spurts,
      gate: gate ? Number(options.gate.thresholdDb) : null,
      prerollFrames: gate ? gate.preroll : 0, holdFrames: gate ? gate.hold : 0,
      encodedBytes, modes, plc: 'opus', frameLog, frameBytes } };
  } finally {
    decoder?.free();
    encoder?.free();
  }
}

// Source's engine CELT codecs (vaudio_celt, vaudio_celt_high): CELT 0.11 in a
// custom mode, one frameSize-sample frame per fixed packetBytes packet, the
// same gate, loss and delay handling as roundTrip. Frames are
// frameSize / sampleRate long (23.2 ms for vaudio_celt), not 20 ms.
export async function celtRoundTrip(samples, sampleRate, options = {}) {
  const frameSize = options.frameSize ?? 512, packetBytes = options.packetBytes ?? 64;
  const { createCodec, version } = await loadCelt();
  const codec = await createCodec(sampleRate, frameSize, { packetBytes, complexity: options.complexity ?? 10 });
  try {
    const lookahead = codec.lookahead;
    const frames = Math.ceil((samples.length + lookahead) / frameSize);
    const lossMask = options.makeLossMask ? options.makeLossMask(frames) : null;
    const output = new Float32Array(samples.length);
    const input = new Float32Array(frameSize);
    const gate = options.gate ? {
      threshold: 10 ** (Number(options.gate.thresholdDb) / 20),
      preroll: Math.max(0, Math.round(Number(options.gate.prerollFrames) || 0)),
      hold: Math.max(0, Math.round(Number(options.gate.holdFrames) || 0))
    } : null;
    const plan = gate ? gatePlan(samples, frames, frameSize, gate) : null;
    const frameLog = new Uint8Array(frames), frameBytes = new Uint16Array(frames);
    let encodedBytes = 0, lostFrames = 0, underrunFrames = 0, gatedFrames = 0, spurts = 0, coded = 0, open = false;
    for (let f = 0; f < frames; f++) {
      if (plan && !plan[f]) { gatedFrames++; open = false; continue; }
      if (!open) { if (spurts > 0) codec.restart(); spurts++; open = true; }
      input.fill(0);
      const start = f * frameSize;
      if (start < samples.length) input.set(samples.subarray(start, Math.min(samples.length, start + frameSize)));
      const packet = codec.encode(input);
      encodedBytes += packet.byteLength;
      frameBytes[f] = packet.byteLength;
      frameLog[f] = FRAME.celt;
      coded++;
      const miss = lossMask ? lossMask[f] : 0;
      if (miss === 1) { lostFrames++; frameLog[f] = FRAME.lost; }
      else if (miss === 2) { underrunFrames++; frameLog[f] = FRAME.late; }
      if (miss !== 2) {
        const decoded = miss === 1 ? codec.conceal() : codec.decode(packet);
        const destStart = start - lookahead;
        const begin = Math.max(0, -destStart), end = Math.min(frameSize, samples.length - destStart);
        if (end > begin) output.set(decoded.subarray(begin, end), destStart + begin);
      }
      if ((f & 31) === 31) {
        options.onProgress?.((f + 1) / frames);
        if (options.yieldControl) await options.yieldControl();
      }
    }
    options.onProgress?.(1);
    const bitrate = Math.round(packetBytes * 8 * sampleRate / frameSize);
    return { samples: output, info: { backend: 'celt', version, runtime: 'celt-0.11', sampleRate, bitrate,
      application: 'celt', signal: 'auto', complexity: options.complexity ?? 10, vbr: false, dtx: false,
      frameSamples: frameSize, frameMs: 1000 * frameSize / sampleRate, packetBytes,
      lookahead, frames, lostFrames, underrunFrames, gatedFrames, dtxFrames: 0, spurts,
      gate: gate ? Number(options.gate.thresholdDb) : null,
      prerollFrames: gate ? gate.preroll : 0, holdFrames: gate ? gate.hold : 0,
      encodedBytes, modes: { silk: 0, hybrid: 0, celt: coded }, plc: 'celt', frameLog, frameBytes } };
  } finally {
    codec.free();
  }
}

// One CELT frame at a time with celtRoundTrip's settings, for the live
// monitor; the same interface as createVoiceStream.
export async function createCeltStream(sampleRate, options = {}) {
  const frameSize = options.frameSize ?? 512;
  const { createCodec, version } = await loadCelt();
  const codec = await createCodec(sampleRate, frameSize, { packetBytes: options.packetBytes ?? 64, complexity: options.complexity ?? 10 });
  return {
    frameSize, version, lookahead: codec.lookahead,
    async restart() { codec.restart(); },
    encode(frame) { const packet = codec.encode(frame); return { bytes: packet.byteLength, mode: 'celt', dtx: false, packet }; },
    decode(packet) { return codec.decode(packet); },
    conceal() { return codec.conceal(); },
    free() { codec.free(); }
  };
}

// A finished recording as Opus packets for a container (video.js): libopus
// 1.6.1, fullband music settings, 20 ms frames. The first preSkip samples
// of the decoded stream are the encoder's delay.
export async function encodeForContainer(samples, sampleRate, bitrate = 128000) {
  const { createEncoder } = await runtime('1.6.1');
  const encoder = await createEncoder({ sampleRate, channels: 1, frameSize: sampleRate / 50, application: APPLICATIONS.audio,
    signal: SIGNALS.auto, bitrate, complexity: 10, vbr: true, dtx: false, fec: false });
  try {
    const frameSize = sampleRate / 50, preSkip = encoder.getLookahead();
    const frames = Math.ceil((samples.length + preSkip) / frameSize), packets = [], frame = new Float32Array(frameSize);
    for (let f = 0; f < frames; f++) {
      frame.fill(0);
      const start = f * frameSize;
      if (start < samples.length) frame.set(samples.subarray(start, Math.min(samples.length, start + frameSize)));
      packets.push(encoder.encodeFloat(frame));
    }
    return { packets, preSkip, frameSize };
  } finally {
    encoder.free();
  }
}
