// CELT 0.11, the codec behind Source's vaudio_celt (tests/LEGACY_CODECS.md),
// compiled to WebAssembly by tests/celt011/build.mjs. Mono custom modes:
// createCodec(rate, frameSize) gives an encoder and decoder pair that code
// one frame into a fixed-size packet, as the engine does.
import wasmBase64 from './celt-0.11.wasm.mjs';

const COMPLEXITY = 2, VBR = 12;   // CELT_SET_COMPLEXITY / CELT_SET_VBR requests

let exportsPromise;
function wasmBytes() {
  if (typeof atob === 'function') {
    const text = atob(wasmBase64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(wasmBase64, 'base64'));
}
function load() {
  exportsPromise ??= WebAssembly.instantiate(wasmBytes(), {}).then(result => result.instance.exports);
  return exportsPromise;
}

export const version = 'CELT 0.11 (celt-0.11.0)';

// options: { packetBytes, complexity }. encode(frame) takes frameSize floats
// (full scale 1) and returns a packetBytes packet; decode(packet) and
// conceal() return frameSize floats. The output is delayed by `lookahead`
// samples (the MDCT overlap).
export async function createCodec(rate, frameSize, options = {}) {
  const x = await load();
  const packetBytes = options.packetBytes ?? 64;
  const mode = x.cc_mode_create(rate, frameSize);
  if (!mode) throw new Error(`CELT 0.11 has no mode for ${rate} Hz / ${frameSize} samples`);
  let encoder = 0, decoder = 0;
  const pcm = x.malloc(frameSize * 4), packet = x.malloc(Math.max(packetBytes, 1275));
  const open = () => {
    encoder = x.cc_encoder_create(mode);
    decoder = x.cc_decoder_create(mode);
    if (!encoder || !decoder) throw new Error('CELT 0.11 could not create its encoder or decoder');
    if (x.cc_encoder_set(encoder, COMPLEXITY, options.complexity ?? 10) < 0) throw new Error('CELT 0.11 rejected the complexity');
    x.cc_encoder_set(encoder, VBR, 0);
  };
  const close = () => {
    if (encoder) x.celt_encoder_destroy(encoder);
    if (decoder) x.celt_decoder_destroy(decoder);
    encoder = decoder = 0;
  };
  open();
  // CELT works at 16-bit scale internally; the float API takes +-1.
  const decodeInto = (data, length) => {
    const n = x.celt_decode_float(decoder, data, length, pcm, frameSize);
    if (n < 0) throw new Error(`CELT 0.11 decode failed (error ${n})`);
    return new Float32Array(x.memory.buffer, pcm, frameSize).slice();
  };
  return {
    frameSize, packetBytes, lookahead: x.cc_mode_overlap(mode), version,
    encode(frame) {
      if (frame.length !== frameSize) throw new RangeError(`Expected ${frameSize} samples`);
      new Float32Array(x.memory.buffer, pcm, frameSize).set(frame);
      const n = x.celt_encode_float(encoder, pcm, frameSize, packet, packetBytes);
      if (n < 0) throw new Error(`CELT 0.11 encode failed (error ${n})`);
      return new Uint8Array(x.memory.buffer, packet, n).slice();
    },
    decode(bytes) {
      new Uint8Array(x.memory.buffer, packet, bytes.length).set(bytes);
      return decodeInto(packet, bytes.length);
    },
    conceal() { return decodeInto(0, 0); },
    // A new talk spurt: fresh encoder and decoder state.
    restart() { close(); open(); },
    free() {
      close();
      if (pcm) { x.free(pcm); x.free(packet); }
      x.celt_mode_destroy(mode);
    }
  };
}
