// Video in and out (video.js): the render goes back into an MP4 or MOV with
// the video copied sample for sample. Node has no WebCodecs, so the audio is
// Opus (MP4) or PCM (MOV) here; the fixtures in tests/video are made with
// ffmpeg (H.264 + AAC, fragmented, delayed audio, H.264 + PCM MOV, VP9 + Opus).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createDecoder } from '../vendor/libopus/index.mjs';
import { audioEngine } from './reference.compare.mjs';

const require = createRequire(import.meta.url);
globalThis.TF2Audio = audioEngine().audio;
const V = require('../video.js');
let passed = 0;
function check(name, ok, detail = '') { assert.ok(ok, `${name} ${detail}`); passed++; console.log(`  ok    ${name}${detail ? `   [${detail}]` : ''}`); }
const fixture = (name) => new Uint8Array(fs.readFileSync(new URL(`./video/${name}`, import.meta.url)));

console.log('\n[Video] Remuxing the render into the source video');
const rate = 48000, n = Math.round(rate * 1.5);
// A chirp stands in for the voice, so content and timing are checkable.
const voice = Float32Array.from({ length: n }, (_, i) => .25 * Math.sin(2 * Math.PI * (200 * i / rate + 600 * (i / rate) ** 2)));
const bytesOf = (movie, s) => movie.u8.subarray(s.offset, s.offset + s.size);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const leadingEmpty = (movie, track) => {
  if (!track.edts) return 0;
  const u8 = movie.u8, dv = new DataView(u8.buffer, u8.byteOffset), e = track.edts.body + 8;
  let total = 0;
  for (let i = 0, count = dv.getUint32(e + 4); i < count; i++) {
    const at = e + 8 + i * 12;
    if (dv.getInt32(at + 4) !== -1) break;
    total += dv.getUint32(at);
  }
  return total / movie.timescale;
};

for (const [name, container] of [['h264_aac.mp4', 'mp4'], ['h264_aac_fragmented.mp4', 'mp4'], ['h264_aac_delayed.mp4', 'mp4'],
  ['h264_pcm.mov', 'mov'], ['vp9_opus.mp4', 'mp4']]) {
  const input = fixture(name);
  const info = V.inspect(input);
  check(`${name}: recognised as ${container.toUpperCase()} with video and audio`, info && info.container === container && info.video && info.audio, info && info.codec);
  const out = await V.remux(input, voice, rate);
  const bytes = new Uint8Array(await out.blob.arrayBuffer());
  const a = V.parse(input), b = V.parse(bytes);
  const va = a.tracks.find(t => t.handler === 'vide'), vb = b.tracks.find(t => t.handler === 'vide');
  check(`${name}: every video sample copied byte for byte, with its timing`,
    va.samples.length === vb.samples.length && va.samples.every((s, i) => same(bytesOf(a, s), bytesOf(b, vb.samples[i]))
      && s.duration === vb.samples[i].duration && s.cto === vb.samples[i].cto && s.sync === vb.samples[i].sync),
    `${va.samples.length} samples`);
  const top = [];
  for (let at = 0; at < bytes.length;) { const size = new DataView(bytes.buffer).getUint32(at); top.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8))); at += size; }
  check(`${name}: a regular file with the index first`, top.join(',') === 'ftyp,moov,mdat', top.join(','));
  const audio = b.tracks.filter(t => t.handler === 'soun');
  check(`${name}: one audio track, the voice as ${container === 'mov' ? 'PCM' : 'Opus'}`,
    audio.length === 1 && audio[0].format === (container === 'mov' ? 'sowt' : 'Opus') && out.audioCodec === (container === 'mov' ? 'PCM' : 'Opus'));
  const old = a.tracks.find(t => t.handler === 'soun');
  check(`${name}: the voice starts where the old audio did`, Math.abs(leadingEmpty(b, audio[0]) - leadingEmpty(a, old)) < 1e-3,
    `${leadingEmpty(b, audio[0]).toFixed(3)} s`);
  // Decode the new audio and compare it with what went in.
  let decoded;
  if (container === 'mov') {
    const pcm = audio[0].samples.map(s => bytesOf(b, s));
    const all = new Uint8Array(pcm.reduce((t, p) => t + p.length, 0));
    pcm.reduce((o, p) => { all.set(p, o); return o + p.length; }, 0);
    const view = new DataView(all.buffer);
    decoded = Float32Array.from({ length: all.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32767);
  } else {
    const decoder = await createDecoder({ sampleRate: 48000, channels: 1 });
    const parts = audio[0].samples.map(s => decoder.decodeFloat(bytesOf(b, s), { frameSize: 960 }));
    decoder.free();
    const all = new Float32Array(parts.reduce((t, p) => t + p.length, 0));
    parts.reduce((o, p) => { all.set(p, o); return o + p.length; }, 0);
    const dv = new DataView(b.u8.buffer, b.u8.byteOffset), entry = audio[0].stsd.body + 8;
    const preSkip = dv.getUint16(entry + 36 + 8 + 2);
    decoded = all.subarray(preSkip);
  }
  let dot = 0, ea = 0, eb = 0;
  for (let i = 2000; i < n - 2000; i++) { dot += voice[i] * decoded[i]; ea += voice[i] ** 2; eb += decoded[i] ** 2; }
  const r = dot / Math.sqrt(ea * eb);
  check(`${name}: the voice decodes back on time`, r > .99 && decoded.length >= n, `r ${r.toFixed(4)}`);
}

// AAC through WebCodecs, where a browser has an AAC encoder (Node has none):
// a stand-in encoder returns the fixture's own AAC frames, and a stand-in
// decoder answers with the voice 2112 samples late, the priming an encoder
// might add. The frames must land unchanged, with the priming skipped.
{
  const src = V.parse(fixture('h264_aac.mp4')), track = src.tracks.find(t => t.handler === 'soun');
  const frames = track.samples.map(s => bytesOf(src, s).slice());
  // The AudioSpecificConfig: descriptor 5 inside 4 inside 3 (lengths use 7 bits a byte).
  const esds = src.u8.subarray(track.stsd.body + 8 + 36 + 12, track.stsd.end);
  const descriptor = (at) => { let size = 0, k = at + 1; for (;;) { const b = esds[k++]; size = size * 128 + (b & 127); if (!(b & 128)) break; } return { tag: esds[at], body: k, end: k + size }; };
  const es = descriptor(0), dcd = descriptor(es.body + 3), dsi = descriptor(dcd.body + 13);
  assert.ok(es.tag === 3 && dcd.tag === 4 && dsi.tag === 5, 'fixture esds layout');
  const asc = esds.slice(dsi.body, dsi.end);
  const priming = 2112;
  globalThis.AudioData = class { constructor(init) { Object.assign(this, init); } close() {} };
  globalThis.EncodedAudioChunk = class { constructor(init) { Object.assign(this, init); } };
  globalThis.AudioEncoder = class {
    static async isConfigSupported(config) { return { supported: config.codec === 'mp4a.40.2', config }; }
    constructor({ output }) { this.output = output; }
    configure() {} encode() {}
    async flush() { frames.forEach((data, i) => this.output({ byteLength: data.length, timestamp: Math.round(i * 1024 / rate * 1e6), copyTo: (dst) => dst.set(data) }, i ? {} : { decoderConfig: { description: asc.buffer } })); }
    close() {}
  };
  globalThis.AudioDecoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor({ output }) { this.output = output; this.count = 0; }
    configure() {} decode() { this.count++; }
    async flush() {
      const n = this.count * 1024, x = Float32Array.from({ length: n }, (_, i) => (i >= priming ? voice[i - priming] || 0 : 0));
      this.output({ numberOfFrames: n, copyTo: (dst) => dst.set(x), close() {} });
    }
    close() {}
  };
  const out = await V.remux(fixture('h264_aac.mp4'), voice, rate);
  const b = V.parse(new Uint8Array(await out.blob.arrayBuffer())), audio = b.tracks.find(t => t.handler === 'soun');
  const u8 = b.u8, dv = new DataView(u8.buffer, u8.byteOffset), elst = audio.edts.body + 8;
  const entry = u8.subarray(audio.stsd.body + 8, audio.stsd.end);
  check('With a WebCodecs AAC encoder the voice is AAC in an esds with its AudioSpecificConfig',
    out.audioCodec === 'AAC' && audio.format === 'mp4a' && entry.join(',').includes(Array.from(asc).join(',')));
  check('The AAC frames land unchanged', audio.samples.length === frames.length && audio.samples.every((s, i) => same(bytesOf(b, s), frames[i])),
    `${frames.length} frames`);
  check('The edit list skips the priming the decoder shows', dv.getInt32(elst + 8 + 4) === priming, `${dv.getInt32(elst + 8 + 4)} samples`);
  for (const k of ['AudioData', 'EncodedAudioChunk', 'AudioEncoder', 'AudioDecoder']) delete globalThis[k];
}

check('Audio-only and non-ISO files are not taken for video', V.inspect(new Uint8Array(64)) === null);
console.log(`\n${passed} video checks passed`);
