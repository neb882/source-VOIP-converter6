// libopus 1.1.5, the release Steam's voice packets match (tests/REFERENCE_2026.md),
// compiled to WebAssembly by tests/libopus11/build.mjs. The API follows the subset
// of libopus-wasm (vendor/libopus) that opus-codec.mjs uses.
import wasmBase64 from './libopus-1.1.5.wasm.mjs';

export const Application = { Voip: 2048, Audio: 2049, RestrictedLowDelay: 2051 };
export const Signal = { Auto: -1000, Voice: 3001, Music: 3002 };
const CTL = { bitrate: 4002, vbr: 4006, complexity: 4010, fec: 4012, packetLoss: 4014, dtx: 4016, vbrConstraint: 4020, signal: 4024, lookahead: 4027 };
const MAX_PACKET = 4000, MAX_FRAME = 5760;

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
  // Self-contained: musl's libm is compiled in, so the module has no imports.
  exportsPromise ??= WebAssembly.instantiate(wasmBytes(), {}).then(result => result.instance.exports);
  return exportsPromise;
}
function check(code, what) {
  if (code < 0) throw new Error(`libopus 1.1.5 ${what} failed (error ${code})`);
  return code;
}

export async function loadLibopus() {
  const x = await load();
  const ptr = x.opus_get_version_string();
  const bytes = new Uint8Array(x.memory.buffer, ptr, 64);
  return { version: new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0))) };
}

class Encoder {
  #x; #ptr; #pcm; #out;
  constructor(x, o) {
    this.#x = x; this.sampleRate = o.sampleRate; this.channels = o.channels ?? 1;
    this.frameSize = o.frameSize ?? o.sampleRate / 50;
    const err = x.malloc(4);
    this.#ptr = x.opus_encoder_create(o.sampleRate, this.channels, o.application ?? Application.Voip, err);
    const code = new Int32Array(x.memory.buffer, err, 1)[0];
    x.free(err);
    if (!this.#ptr || code !== 0) throw new Error(`libopus 1.1.5 encoder create failed (error ${code})`);
    this.#pcm = x.malloc(MAX_FRAME * this.channels * 4);
    this.#out = x.malloc(MAX_PACKET);
    const set = (request, value) => { if (value !== undefined) check(x.oc_encoder_set(this.#ptr, request, Number(value)), 'encoder ctl'); };
    set(CTL.bitrate, o.bitrate); set(CTL.complexity, o.complexity); set(CTL.signal, o.signal);
    set(CTL.vbr, o.vbr === undefined ? undefined : o.vbr ? 1 : 0);
    set(CTL.vbrConstraint, o.vbrConstraint === undefined ? undefined : o.vbrConstraint ? 1 : 0);
    set(CTL.dtx, o.dtx ? 1 : 0); set(CTL.fec, o.fec ? 1 : 0); set(CTL.packetLoss, o.packetLossPercent);
  }
  getLookahead() { return check(this.#x.oc_encoder_get(this.#ptr, CTL.lookahead), 'lookahead'); }
  encodeFloat(pcm) {
    const x = this.#x;
    if (pcm.length !== this.frameSize * this.channels) throw new RangeError(`Expected ${this.frameSize * this.channels} samples`);
    new Float32Array(x.memory.buffer, this.#pcm, pcm.length).set(pcm);
    const len = check(x.opus_encode_float(this.#ptr, this.#pcm, this.frameSize, this.#out, MAX_PACKET), 'encode');
    return new Uint8Array(x.memory.buffer, this.#out, len).slice();
  }
  free() {
    if (!this.#ptr) return;
    this.#x.opus_encoder_destroy(this.#ptr); this.#x.free(this.#pcm); this.#x.free(this.#out); this.#ptr = 0;
  }
}

class Decoder {
  #x; #ptr; #pcm; #in;
  constructor(x, o) {
    this.#x = x; this.sampleRate = o.sampleRate; this.channels = o.channels ?? 1;
    const err = x.malloc(4);
    this.#ptr = x.opus_decoder_create(o.sampleRate, this.channels, err);
    const code = new Int32Array(x.memory.buffer, err, 1)[0];
    x.free(err);
    if (!this.#ptr || code !== 0) throw new Error(`libopus 1.1.5 decoder create failed (error ${code})`);
    this.#pcm = x.malloc(MAX_FRAME * this.channels * 4);
    this.#in = x.malloc(MAX_PACKET);
  }
  #decode(packet, frameSize) {
    const x = this.#x;
    let len = 0;
    if (packet) { len = packet.length; new Uint8Array(x.memory.buffer, this.#in, len).set(packet); }
    const n = check(x.opus_decode_float(this.#ptr, packet ? this.#in : 0, len, this.#pcm, frameSize, 0), 'decode');
    return new Float32Array(x.memory.buffer, this.#pcm, n * this.channels).slice();
  }
  decodeFloat(packet, options = {}) { return this.#decode(packet, options.frameSize ?? MAX_FRAME); }
  decodePacketLossFloat(frameSize = this.sampleRate / 50) { return this.#decode(null, frameSize); }
  free() {
    if (!this.#ptr) return;
    this.#x.opus_decoder_destroy(this.#ptr); this.#x.free(this.#pcm); this.#x.free(this.#in); this.#ptr = 0;
  }
}

export async function createEncoder(options) { return new Encoder(await load(), options); }
export async function createDecoder(options) { return new Decoder(await load(), options); }
