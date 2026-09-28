// TF2 demos (demo.js): a synthetic SourceTV demo, written here bit by bit,
// with Steam voice (Opus packets with sequence numbers, a lost frame, a DTX
// frame and end-of-transmission markers, from two speakers), messages that
// must be skipped at odd bit offsets, and a legacy vaudio_celt demo. Real
// demos are players' voices and stay out of the repository; the parser was
// checked against tests/demovoice (Rust) on the Set D demo (README).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as opus from '../vendor/libopus-1.1/index.mjs';
import { createCodec } from '../vendor/celt-0.11/index.mjs';
import { audioEngine } from './reference.compare.mjs';

const require = createRequire(import.meta.url);
const D = require('../demo.js');
const engine = audioEngine(), A = engine.audio;
// The sandbox has no import loader; the full chain gets the codec module injected.
engine.sandbox.TF2Opus = await import('../opus-codec.mjs');
let passed = 0;
function check(name, ok, detail = '') { assert.ok(ok, `${name} ${detail}`); passed++; console.log(`  ok    ${name}${detail ? `   [${detail}]` : ''}`); }

// Bits least significant first, as Source writes them.
class BitWriter {
  constructor() { this.bytes = []; this.bit = 0; }
  write(value, n) {
    for (let i = 0; i < n; i++) {
      if ((this.bit & 7) === 0) this.bytes.push(0);
      if (Math.floor(value / 2 ** i) % 2) this.bytes[this.bytes.length - 1] |= 1 << (this.bit & 7);
      this.bit++;
    }
  }
  string(s) { for (const c of s) this.write(c.charCodeAt(0), 8); this.write(0, 8); }
  data(u8) { for (const b of u8) this.write(b, 8); }
  get u8() { return Uint8Array.from(this.bytes); }
}

function crc32(d) {
  let crc = 0xFFFFFFFF;
  for (const b of d) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1)); }
  return (~crc) >>> 0;
}

// Steam voice payload: SteamID, sample rate section, Opus section, CRC32.
function steamPayload(steamId, frames) {
  const opusBytes = [];
  for (const f of frames) {
    if (f === 'end') { opusBytes.push(0xFF, 0xFF); continue; }
    opusBytes.push(f.data.length & 255, f.data.length >> 8, f.seq & 255, f.seq >> 8, ...f.data);
  }
  const body = [];
  const id = new DataView(new ArrayBuffer(8));
  id.setBigUint64(0, BigInt(steamId), true);
  body.push(...new Uint8Array(id.buffer), 11, 24000 & 255, 24000 >> 8, 6, opusBytes.length & 255, opusBytes.length >> 8, ...opusBytes);
  const crc = crc32(body);
  body.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24);
  return Uint8Array.from(body);
}

// A demo: header, then frames of network messages (one packet per frame).
function demoFile(packets, { ticks = 1000, seconds = 15 } = {}) {
  const header = new Uint8Array(1072), dv = new DataView(header.buffer);
  header.set([...'HL2DEMO'].map(c => c.charCodeAt(0)));
  dv.setInt32(8, 3, true); dv.setInt32(12, 24, true);
  header.set([...'Synthetic test'].map(c => c.charCodeAt(0)), 16);
  header.set([...'ctf_2fort'].map(c => c.charCodeAt(0)), 536);
  dv.setFloat32(1056, seconds, true); dv.setInt32(1060, ticks, true); dv.setInt32(1064, packets.length, true);
  const parts = [header];
  // A data table frame the parser skips.
  const table = new Uint8Array(1 + 4 + 4 + 5); table[0] = 6; new DataView(table.buffer).setUint32(5, 5, true); parts.push(table);
  for (const { tick, messages } of packets) {
    const w = new BitWriter();
    for (const m of messages) m(w);
    const data = w.u8, frame = new Uint8Array(1 + 4 + 84 + 4 + data.length), fv = new DataView(frame.buffer);
    frame[0] = 2; fv.setInt32(1, tick, true); fv.setUint32(89, data.length, true); frame.set(data, 93);
    parts.push(frame);
  }
  parts.push(Uint8Array.of(7, 0, 0, 0, 0));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out;
}
const msg = {
  pause: (w) => { w.write(11, 6); w.write(1, 1); },                                   // leaves the stream off byte alignment
  print: (text) => (w) => { w.write(7, 6); w.string(text); },
  netTick: (w) => { w.write(3, 6); w.write(1234, 32); w.write(15, 16); w.write(1, 16); },
  gameEvent: (w) => { w.write(25, 6); w.write(37, 11); w.write(0x1FFFFFFFFF, 37); },
  entities: (w) => { w.write(26, 6); w.write(24, 11); w.write(1, 1); w.write(77, 32); w.write(0, 1); w.write(3, 11); w.write(13, 20); w.write(0, 1); w.write(8191, 13); },
  voiceInit: (codec, quality = 255, rate = 0) => (w) => { w.write(14, 6); w.string(codec); w.write(quality, 8); if (quality === 255) w.write(rate, 16); },
  voice: (client, payload) => (w) => { w.write(15, 6); w.write(client, 8); w.write(0, 8); w.write(payload.length * 8, 16); w.data(payload); }
};

console.log('\n[Demo] Voice in a TF2 demo');
const rate = 24000, tone = (n, at) => Float32Array.from({ length: n }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * (at + i) / rate));
const encoder = await opus.createEncoder({ sampleRate: rate, channels: 1, bitrate: 32000, vbr: true, complexity: 10 });
const packets = Array.from({ length: 30 }, (_, k) => encoder.encodeFloat(tone(480, 480 * k)));
encoder.free();
// Speaker 1: frames 0-13, frame 14 lost, 15-19, a DTX frame, end; a second
// spurt of frames 0-9 at tick 400 (6 s at 15 ms). Speaker 2: one spurt.
const first = [...packets.slice(0, 14).map((data, i) => ({ seq: 100 + i, data })), ...packets.slice(15, 20).map((data, i) => ({ seq: 115 + i, data })),
  { seq: 120, data: Uint8Array.of(packets[0][0]) }, 'end'];
const second = [...packets.slice(20, 30).map((data, i) => ({ seq: 7 + i, data })), 'end'];
const bytes = demoFile([
  { tick: 100, messages: [msg.netTick, msg.print('hello'), msg.voiceInit('steam'), msg.pause, msg.entities] },
  { tick: 200, messages: [msg.pause, msg.voice(1, steamPayload('76561198000000001', first.slice(0, 10))), msg.gameEvent] },
  { tick: 201, messages: [msg.voice(1, steamPayload('76561198000000001', first.slice(10))), msg.pause, msg.voice(2, steamPayload('76561198000000002', second.slice(0, 5)))] },
  { tick: 400, messages: [msg.voice(1, steamPayload('76561198000000001', second)), msg.voice(2, steamPayload('76561198000000002', second.slice(5)))] },
  { tick: 401, messages: [msg.voice(3, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))] }  // bad CRC
]);
// tests/demo/synthetic.dem is this demo, for the browser test (browser.verify.js).
const fixture = new URL('./demo/synthetic.dem', import.meta.url);
if (process.argv.includes('--write-fixture')) { fs.mkdirSync(new URL('./demo/', import.meta.url), { recursive: true }); fs.writeFileSync(fixture, bytes); }
check('tests/demo/synthetic.dem is this demo', fs.existsSync(fixture) && Buffer.compare(fs.readFileSync(fixture), Buffer.from(bytes)) === 0,
  'node tests/demo.verify.mjs --write-fixture rewrites it');
const parsed = D.parse(bytes);
check('The header and the tick length are read', parsed.header.map === 'ctf_2fort' && parsed.header.protocol === 24 && Math.abs(parsed.intervalPerTick - .015) < 1e-9,
  `${parsed.header.map}, protocol ${parsed.header.protocol}`);
check('Every message is read, including ones that leave the stream off byte alignment', parsed.errors === 0 && parsed.voice.length === 6 && parsed.codecs[0].codec === 'steam',
  `${parsed.voice.length} voice messages, ${parsed.errors} errors`);
const [s1, s2] = parsed.speakers;
check('Speakers are told apart by SteamID; a payload that fails its CRC is not taken for voice', parsed.speakers.length === 2 && parsed.unreadable === 1
  && s1.id === '76561198000000001' && s2.id === '76561198000000002');
const opusPackets = s1.packets.filter(p => p.kind === 'opus');
check('Every Opus packet comes out byte for byte with its sequence number', opusPackets.length === 30
  && opusPackets.slice(0, 19).every((p, i) => p.seq === first[i].seq && Buffer.compare(Buffer.from(p.data), Buffer.from(first[i].data)) === 0));
check('Frames, talk spurts, DTX and the lost frame are counted', s1.frames === 30 && s1.spurts === 2 && s1.dtx === 1 && s1.lost === 1 && s2.spurts === 1,
  `${s1.frames} frames, ${s1.spurts} spurts, ${s1.dtx} DTX, ${s1.lost} lost`);

const decoded = await D.decode(parsed, s1, { opus: (r) => opus.createDecoder({ sampleRate: r, channels: 1 }) });
const second0 = Math.round(200 * .015 * rate);
check('Talk spurts sit at their demo tick; frames within one run back to back, the lost one concealed',
  decoded.concealed === 1 && decoded.spurts === 2 && decoded.samples.length === second0 + 10 * 480, `${(decoded.samples.length / rate).toFixed(3)} s`);
check('The frame log marks coded, lost, DTX and silent frames', decoded.frameLog[14] === 5 && decoded.frameLog[20] === 4
  && decoded.frameLog[5] === 2 && decoded.frameLog[25] === 0 && decoded.frameLog[second0 / 480] === 2);
// The decoded tone: Opus's lookahead delays it by 6.5 ms (156 samples), and
// the SILK layer shifts a low tone a little further (finding 20).
const match = (lag) => {
  let dot = 0, ea = 0, eb = 0;
  const ref = tone(14 * 480, -lag);
  for (let i = 480; i < 14 * 480; i++) { dot += decoded.samples[i] * ref[i]; ea += ref[i] ** 2; eb += decoded.samples[i] ** 2; }
  return dot / Math.sqrt(ea * eb);
};
const lags = Array.from({ length: 41 }, (_, k) => 136 + k), best = lags.reduce((b, l) => (match(l) > match(b) ? l : b));
check('The voice decodes back to the tone', match(best) > .98, `r ${match(best).toFixed(3)} at ${best} samples`);

// Legacy engine codec: bare 64-byte CELT packets, no SteamID or CRC.
const celt = await createCodec(22050, 512, { packetBytes: 64 });
const celtTone = Float32Array.from({ length: 512 * 20 }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * i / 22050));
const celtPackets = Array.from({ length: 20 }, (_, k) => celt.encode(celtTone.subarray(512 * k, 512 * (k + 1))));
celt.free();
const join = (list) => { const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0)); list.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0); return out; };
const legacy = D.parse(demoFile([
  { tick: 10, messages: [msg.voiceInit('vaudio_celt', 5)] },
  { tick: 20, messages: [msg.voice(4, join(celtPackets.slice(0, 10)))] },
  { tick: 21, messages: [msg.pause, msg.voice(4, join(celtPackets.slice(10)))] }
]));
const ls = legacy.speakers[0];
check('A vaudio_celt demo gives its 64-byte packets at 22050 Hz', legacy.codecs[0].rate === 22050 && ls && ls.codec === 'vaudio_celt' && ls.frames === 20,
  ls ? `${ls.frames} packets` : 'no speaker');
const legacyAudio = await D.decode(legacy, ls, { celt: (r, f, b) => createCodec(r, f, { packetBytes: b }) });
check('and decodes with CELT 0.11 into one talk spurt', legacyAudio.samples.length === 20 * 512 && legacyAudio.spurts === 1 && legacyAudio.frameLog.every(c => c === 3));

// A demo recorded with `record` keeps voice messages without their payloads.
const client = D.parse(demoFile([{ tick: 5, messages: [msg.voiceInit('steam'), msg.voice(1, new Uint8Array(0))] }]));
check('A client demo has voice messages but no speakers', client.voice.length === 1 && client.speakers.length === 0);
assert.throws(() => D.parse(new Uint8Array(2000)), /not a Source demo/);
check('A file that is not a demo is refused', true);

// The receiver alone: voice that arrives already coded skips the sender. A
// quiet spurt the sender's gate would silence comes through, raised by the
// receiver's auto-gain, and the render reports the demo's own frames.
const quiet = Float32Array.from(decoded.samples, v => v * .01);
const buffer = { sampleRate: rate, length: quiet.length, numberOfChannels: 1, getChannelData: () => quiet };
const received = await A.process(buffer, { codec: 'steam', received: { frameLog: Array.from(decoded.frameLog), frameBytes: Array.from(decoded.frameBytes), frameMs: 20, spurts: 2 } });
const full = await A.process(buffer, { codec: 'steam' });
const rms = (x) => 10 * Math.log10(x.reduce((t, v) => t + v * v, 0) / x.length + 1e-30);
check('Received voice runs through the receiver only: the sender gate does not apply', rms(received.samples) > rms(full.samples) + 20,
  `${rms(received.samples).toFixed(1)} dBFS against ${rms(full.samples).toFixed(1)} dBFS through the full chain`);
check('and its codec lane is the demo\'s frames', received.codecInfo.backend === 'demo' && received.codecInfo.frames === decoded.frameLog.length
  && received.codecInfo.lostFrames === 1 && received.codecInfo.dtxFrames === 1 && received.codecInfo.modes.hybrid + received.codecInfo.modes.silk + received.codecInfo.modes.celt === 29);
console.log(`\n${passed} demo checks passed`);
