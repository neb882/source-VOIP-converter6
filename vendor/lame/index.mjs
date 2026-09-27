// LAME 3.100, the MP3 encoder behind the MP3 download option, compiled to
// WebAssembly by tests/lame/build.mjs.
import wasmBase64 from './lame-3.100.wasm.mjs';

// Sample rates an MPEG-1/2 layer III stream can carry.
export const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const CHUNK = 1152 * 64;
const OUT_BYTES = Math.ceil(1.25 * CHUNK) + 7200;   // lame.h's worst-case bound

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

export async function lameVersion() {
  const x = await load();
  const ptr = x.get_lame_version();
  const bytes = new Uint8Array(x.memory.buffer, ptr, 32);
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
}

// Mono 16-bit PCM to an MP3 file. VBR at `vbrQuality` (0 = best, lame -V 0)
// unless `kbps` asks for CBR. The first frame is LAME's Xing/Info tag, which
// carries the encoder delay and padding, so decoders return exactly
// `samples.length` samples.
export async function encodeMp3(samples, sampleRate, { vbrQuality = 0, kbps = 0 } = {}) {
  if (Object.prototype.toString.call(samples) !== '[object Int16Array]') throw new TypeError('encodeMp3 expects Int16Array samples');
  if (!MP3_RATES.includes(sampleRate)) throw new RangeError(`MP3 cannot carry ${sampleRate} Hz audio`);
  const x = await load();
  const encoder = x.tf2_mp3_create(sampleRate, kbps, vbrQuality);
  if (!encoder) throw new Error('LAME could not set up the encoder');
  const pcm = x.malloc(CHUNK * 2), out = x.malloc(OUT_BYTES);
  try {
    const parts = [];
    let total = 0;
    const take = (count, what) => {
      if (count < 0) throw new Error(`LAME ${what} failed (error ${count})`);
      if (count) { parts.push(new Uint8Array(x.memory.buffer, out, count).slice()); total += count; }
    };
    for (let i = 0; i < samples.length; i += CHUNK) {
      const chunk = samples.subarray(i, i + CHUNK);
      new Int16Array(x.memory.buffer, pcm, chunk.length).set(chunk);
      take(x.lame_encode_buffer(encoder, pcm, pcm, chunk.length, out, OUT_BYTES), 'encode');
    }
    take(x.lame_encode_flush(encoder, out, OUT_BYTES), 'flush');
    const mp3 = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { mp3.set(part, offset); offset += part.length; }
    // Replace the placeholder first frame with the finished tag.
    const tag = x.lame_get_lametag_frame(encoder, out, OUT_BYTES);
    if (tag > 0 && tag <= mp3.length) mp3.set(new Uint8Array(x.memory.buffer, out, tag), 0);
    return mp3;
  } finally {
    x.free(pcm);
    x.free(out);
    x.lame_close(encoder);
  }
}
