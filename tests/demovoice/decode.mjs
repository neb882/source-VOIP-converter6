// Decode a demovoice dump with the app's pinned libopus into one WAV per client.
//
//   node decode.mjs voicetest.voice [outPrefix]
//
// Talk spurts are placed at their demo tick (15 ms), frames within a spurt
// back to back. Lost frames (sequence gaps) are concealed, DTX frames give
// libopus comfort noise and each end-of-transmission marker resets the
// decoder, as Steam's receiver does. Also writes <prefix>.client<N>.tsv:
// one row per frame with its tick, sequence number, size, TOC configuration,
// SILK VAD and LBRR (in-band FEC) bits and the sample where it starts.
import fs from 'node:fs';
import { createDecoder } from '../../vendor/libopus/index.mjs';

const [, , input, prefixArg] = process.argv;
if (!input) { console.error('usage: node decode.mjs <file.voice> [outPrefix]'); process.exit(2); }
const prefix = prefixArg || input.replace(/\.voice$/, '');
const RATE = 24000, FRAME = 480, TICK = 0.015;
const buf = fs.readFileSync(input);
const clients = new Map();
for (let i = 0; i < buf.length;) {
  const rec = { tick: buf.readUInt32LE(i), client: buf[i + 8], kind: buf[i + 9], value: buf.readUInt16LE(i + 10) };
  const len = buf.readUInt16LE(i + 12);
  rec.data = buf.subarray(i + 14, i + 14 + len);
  i += 14 + len;
  if (!clients.has(rec.client)) clients.set(rec.client, []);
  clients.get(rec.client).push(rec);
}

function writeWav(path, pcm) {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let k = 0; k < pcm.length; k++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[k] * 32768))), 44 + 2 * k);
  fs.writeFileSync(path, out);
}

for (const [client, recs] of clients) {
  const t0 = recs[0].tick;
  const chunks = []; const rows = ['tick\tseq\tbytes\ttoc_config\tvad\tlbrr\tsample'];
  let decoder = null, next = null, pos = 0, lost = 0;
  const put = (samples, at) => { chunks.push([at, samples]); pos = at + samples.length; };
  for (const r of recs) {
    if (r.kind === 3) { decoder?.free(); decoder = null; next = null; continue; }
    if (r.kind !== 1) continue;
    if (!decoder) {
      decoder = await createDecoder({ sampleRate: RATE, channels: 1 });
      pos = Math.max(pos, Math.round((r.tick - t0) * TICK * RATE));
    } else if (next !== null && r.value > next) {
      for (let s = next; s < r.value; s++, lost++) put(decoder.decodePacketLossFloat(FRAME), pos);
    }
    const d = r.data;
    // RFC 6716: config in the TOC's top 5 bits; for 20 ms SILK/hybrid frames the
    // first payload bits are the VAD and LBRR flags (opus_packet_has_lbrr()).
    const silk = d.length > 1 && (d[0] >> 3) < 16;
    rows.push([r.tick, r.value, d.length, d.length ? d[0] >> 3 : '', silk ? d[1] >> 7 : '', silk ? (d[1] >> 6) & 1 : '', pos].join('\t'));
    put(decoder.decodeFloat(d, { frameSize: FRAME }), pos);
    next = r.value + 1;
  }
  decoder?.free();
  const pcm = new Float32Array(pos);
  for (const [at, s] of chunks) pcm.set(s, at);
  writeWav(`${prefix}.client${client}.wav`, pcm);
  fs.writeFileSync(`${prefix}.client${client}.tsv`, rows.join('\n') + '\n');
  console.log(`client ${client}: ${rows.length - 1} frames, ${lost} concealed, ${(pos / RATE).toFixed(1)} s -> ${prefix}.client${client}.wav`);
}
