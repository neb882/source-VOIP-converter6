// Download formats: the FLAC encoder (flac.js), MP3 through LAME 3.100
// (vendor/lame), the WAV reader and format conversion (formats.js), and ZIP
// archives (zip.js). FLAC is checked with an independent decoder below that
// verifies every frame CRC; MP3 is decoded with mpg123.
//
//   node tests/formats.verify.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { MPEGDecoder } from 'mpg123-decoder';
import { encodeMp3, lameVersion } from '../vendor/lame/index.mjs';
import wasmBase64 from '../vendor/lame/lame-3.100.wasm.mjs';

const require = createRequire(import.meta.url);
let passed = 0;
function check(name, ok) { assert.ok(ok, name); passed++; console.log(`  ok    ${name}`); }

const sandbox = { window: {}, Blob, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../constants.js', import.meta.url), 'utf8') + '\n' +
  fs.readFileSync(new URL('../audio.js', import.meta.url), 'utf8'), sandbox);
const A = sandbox.window.TF2Audio;
globalThis.TF2Audio = A;
globalThis.TF2Flac = require('../flac.js');
const TF2Formats = require('../formats.js');
const TF2Zip = require('../zip.js');

// Deterministic music-like signal: tones under a beat, plus noise.
function testSignal(rate, seconds) {
  const n = Math.round(rate * seconds), out = new Int16Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const t = i / rate, noise = (seed / 2 ** 32 - 0.5) * 0.05;
    const beat = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t);
    const v = beat * (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 660 * t) + 0.08 * Math.sin(2 * Math.PI * 3300 * t)) + noise;
    out[i] = Math.round(v * 32767);
  }
  return out;
}
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const wavOf = async (int16, rate) => new Uint8Array(await A.encodeWav(Float32Array.from(int16, v => v / 32768), rate).arrayBuffer());

/* ---------------- an independent FLAC decoder ---------------- */

function crcTable(bits, poly) {
  const top = 1 << (bits - 1), mask = (1 << bits) - 1, table = [];
  for (let i = 0; i < 256; i++) {
    let c = i << (bits - 8);
    for (let k = 0; k < 8; k++) c = c & top ? ((c << 1) ^ poly) & mask : (c << 1) & mask;
    table.push(c);
  }
  return (bytes, from, to) => {
    let c = 0;
    for (let i = from; i < to; i++) c = ((c << 8) & mask) ^ table[((c >> (bits - 8)) ^ bytes[i]) & 0xff];
    return c;
  };
}
const crc8 = crcTable(8, 0x07), crc16 = crcTable(16, 0x8005);

function decodeFlac(bytes) {
  let bit = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = v * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  const signed = (n) => { const v = read(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; };
  const align = () => { bit = (bit + 7) & ~7; };
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'fLaC', 'FLAC marker');
  bit = 32;
  let info = null;
  for (let last = 0; !last;) {
    last = read(1);
    const type = read(7), length = read(24), start = bit;
    if (type === 0) {
      info = { minBlock: read(16), maxBlock: read(16), minFrame: read(24), maxFrame: read(24),
        rate: read(20), channels: read(3) + 1, bits: read(5) + 1, total: read(36) };
    }
    bit = start + length * 8;
  }
  const out = new Int16Array(info.total);
  let at = 0, frames = 0, types = new Set();
  const frameSizes = [];
  while (bit < bytes.length * 8) {
    const start = bit >> 3;
    assert.equal(read(15), 0x7ffc, 'frame sync');
    read(1);
    const sizeCode = read(4); read(4);
    assert.equal(read(4), 0, 'mono'); assert.equal(read(3), 4, '16 bits'); read(1);
    let first = read(8);
    for (let mask = 0x80; first & mask && mask > 1; mask >>= 1) read(8);
    const n = sizeCode === 6 ? read(8) + 1 : sizeCode === 7 ? read(16) + 1 : 256 << (sizeCode - 8);
    const headerEnd = bit >> 3;
    assert.equal(read(8), crc8(bytes, start, headerEnd), 'header CRC-8');
    read(1);
    const type = read(6);
    read(1);
    const x = new Int32Array(n);
    if (type === 0) { types.add('constant'); x.fill(signed(16)); }
    else if (type === 1) { types.add('verbatim'); for (let i = 0; i < n; i++) x[i] = signed(16); }
    else {
      const order = type - 8;
      assert.ok(order >= 0 && order <= 4, 'fixed predictor');
      types.add(`fixed${order}`);
      for (let i = 0; i < order; i++) x[i] = signed(16);
      assert.equal(read(2), 0, '4-bit Rice parameters');
      const po = read(4);
      let i = order;
      for (let p = 0; p < 1 << po; p++) {
        const k = read(4);
        assert.ok(k < 15, 'no escape partitions');
        const count = (n >> po) - (p === 0 ? order : 0);
        for (let j = 0; j < count; j++, i++) {
          let q = 0;
          while (!read(1)) q++;
          const u = q * 2 ** k + read(k);
          const r = u % 2 ? -(u + 1) / 2 : u / 2;
          const c = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][order];
          let prediction = 0;
          for (let m = 0; m < order; m++) prediction += c[m] * x[i - 1 - m];
          x[i] = prediction + r;
        }
      }
    }
    align();
    const end = bit >> 3;
    assert.equal(read(16), crc16(bytes, start, end), 'frame CRC-16');
    frameSizes.push((bit >> 3) - start);
    for (let i = 0; i < n; i++) out[at++] = x[i];
    frames++;
  }
  assert.equal(at, info.total, 'STREAMINFO total samples');
  return { info, samples: out, frames, types, frameSizes };
}

/* ---------------- FLAC ---------------- */

console.log('\n[Formats 1] FLAC encoder');
{
  const noise = (n, amp, seed) => Int16Array.from({ length: n }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.round(((seed / 2 ** 32) * 2 - 1) * amp);
  });
  const cases = [
    ['empty', new Int16Array(0), 48000],
    ['one sample', Int16Array.of(-32768), 44100],
    ['7 samples', Int16Array.of(1, -2, 3, 32767, -32768, 0, 5), 44100],
    ['silence', new Int16Array(10000), 48000],
    ['music-like, 4096 + 1 samples', testSignal(44100, 4097 / 44100), 44100],
    ['music-like, 2 s', testSignal(48000, 2), 48000],
    ['clipped square', Int16Array.from({ length: 9000 }, (_, i) => (i >> 5) % 2 ? 32767 : -32768), 44100],
    ['full-scale noise', noise(12000, 32767, 7), 48000],
    ['quiet noise', noise(12000, 40, 9), 48000],
    ['96 kHz', testSignal(96000, 0.2), 96000],
    ['non-standard 37800 Hz', testSignal(37800, 0.3), 37800]
  ];
  for (const [name, samples, rate] of cases) {
    const flac = TF2Flac.encode(samples, rate);
    const d = decodeFlac(flac);
    check(`${name}: decodes bit-exact with valid CRCs`, d.samples.length === samples.length && d.samples.every((v, i) => v === samples[i]));
    check(`${name}: STREAMINFO rate, length and frame sizes`, d.info.rate === rate && d.info.total === samples.length
      && d.info.channels === 1 && d.info.bits === 16 && d.info.minBlock === 4096 && d.info.maxBlock === 4096
      && (!d.frames || (d.info.minFrame === Math.min(...d.frameSizes) && d.info.maxFrame === Math.max(...d.frameSizes))));
    if (name === 'silence') check('silence uses CONSTANT subframes', [...d.types].join() === 'constant');
    if (name === 'full-scale noise') check('incompressible noise falls back to VERBATIM', d.types.has('verbatim') && flac.length < samples.length * 2 + 200);
    if (name === 'music-like, 2 s') {
      // Its noise floor (about 11 bits) bounds the gain; real renders come out near 45%.
      check('music-like audio compresses below 80% of WAV', flac.length < 0.8 * samples.length * 2);
      check('FLAC output is deterministic', sha256(flac) === sha256(TF2Flac.encode(samples, rate)));
    }
  }
  assert.throws(() => TF2Flac.encode(new Float32Array(4), 48000), /Int16Array/);
  assert.throws(() => TF2Flac.encode(new Int16Array(4), 0), /rate/);
  check('invalid input is rejected', true);
}

/* ---------------- WAV reader and conversion ---------------- */

console.log('\n[Formats 2] WAV reader and conversion');
{
  const pcm = testSignal(48000, 0.5);
  const wav = await wavOf(pcm, 48000);
  const read = TF2Formats.readWav(wav);
  check('readWav returns the samples encodeWav wrote', read.sampleRate === 48000 && read.samples.every((v, i) => v === A.toInt16(Float32Array.from(pcm, s => s / 32768))[i]));
  check('toInt16 matches the WAV conversion at full scale', [...A.toInt16(Float32Array.of(-1, -0.5, 0, 0.5, 1, 2, -2))].join() === '-32768,-16384,0,16383,32767,32767,-32768');
  check('WAV passes through unchanged', (await TF2Formats.fromWav(wav, 'wav')) === wav || sha256(await TF2Formats.fromWav(wav, 'wav')) === sha256(wav));
  const flac = decodeFlac(await TF2Formats.fromWav(wav, 'flac'));
  check('WAV to FLAC is lossless', flac.info.rate === 48000 && flac.samples.every((v, i) => v === read.samples[i]));
  await assert.rejects(() => TF2Formats.fromWav(wav, 'ogg'), /Unknown download format/);
  await assert.rejects(() => TF2Formats.fromWav(new Uint8Array(64), 'flac'), /not a WAV/);
  const stereo = new Uint8Array(wav);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  await assert.rejects(() => TF2Formats.fromWav(stereo, 'flac'), /16-bit mono/);
  check('unknown formats, non-WAV input and stereo WAV are rejected', true);
  check('every format has a label, extension and MIME type', Object.values(TF2Formats.FORMATS).every(f => f.label && f.ext && f.mime));
}

/* ---------------- MP3 ---------------- */

console.log('\n[Formats 3] MP3 (LAME 3.100)');
{
  const wasm = Buffer.from(wasmBase64, 'base64');
  check('LAME module matches the documented build', sha256(wasm) === '732c2c129f88e92eae1542783ddb1d299c908a0cb49ea4224f46766761c92877');
  check('LAME module has no imports', WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length === 0);
  check('LAME reports release 3.100', await lameVersion() === '3.100');
  // Same bytes as a native gcc build of the release with tests/lame/api.c (vendor/lame/README.md).
  const golden = [
    [44100, 2, {}, '9f28f4355c4b965a652a97dedc87b0bfc29667a01ad325413a1f31f38204d878'],
    [48000, 1.3, {}, '1ae4507e531370c6dce2466c1964b05d4cc956e134fcc3c24efab45c78a07a2f'],
    [44100, 2, { kbps: 192 }, '7deaa96a24660928e182979a1a336b86064f27b1f63a55d9d900cf131c37c9a1']
  ];
  for (const [rate, seconds, opts, hash] of golden) {
    const mp3 = await encodeMp3(testSignal(rate, seconds), rate, opts);
    check(`${rate} Hz ${opts.kbps ? `CBR ${opts.kbps}` : 'V0'}: MP3 matches the native reference build byte for byte`, sha256(mp3) === hash);
  }

  const decode = async (mp3) => {
    const decoder = new MPEGDecoder();
    await decoder.ready;
    try { return decoder.decode(mp3); } finally { decoder.free(); }
  };
  // The LAME tag's encoder delay and padding, which gapless decoders trim.
  function lameTag(mp3) {
    const text = String.fromCharCode(...mp3.subarray(0, 600));
    const at = text.indexOf('LAME3.100');
    if (at < 0) return null;
    const b = mp3.subarray(at + 21, at + 24);
    return { vbr: text.slice(0, at).includes('Xing'), delay: (b[0] << 4) | (b[1] >> 4), padding: ((b[1] & 15) << 8) | b[2] };
  }
  // mpg123-decoder skips the tag frame but does not trim; its output starts
  // with the encoder delay plus mpg123's own 529-sample decoder delay.
  const DECODER_DELAY = 529;
  for (const rate of [44100, 48000]) {
    const pcm = testSignal(rate, 2);
    const mp3 = await encodeMp3(pcm, rate);
    const tag = lameTag(mp3);
    check(`${rate} Hz: file starts with LAME's VBR tag, delay 576`, tag && tag.vbr && tag.delay === 576);
    const out = await decode(mp3);
    const y = out.channelData[0], x = Float32Array.from(pcm, v => v / 32768);
    check(`${rate} Hz: tag delay + padding + length covers the decoded frames exactly`,
      out.sampleRate === rate && y.length === tag.delay + pcm.length + tag.padding && y.length % 1152 === 0);
    const start = tag.delay + DECODER_DELAY;
    let xy = 0, xx = 0, err = 0;
    for (let i = 0; i < x.length; i++) { xy += x[i] * y[start + i]; xx += x[i] * x[i]; }
    for (let i = 0; i < x.length; i++) err += (y[start + i] - x[i]) ** 2;
    check(`${rate} Hz: V0 keeps the level and waveform (gain ${(xy / xx).toFixed(4)}, error ${(10 * Math.log10(err / xx)).toFixed(1)} dB)`,
      Math.abs(xy / xx - 1) < 0.01 && 10 * Math.log10(err / xx) < -20);
    check(`${rate} Hz: V0 is under a quarter of the WAV size`, mp3.length < 0.25 * pcm.length * 2);
  }
  for (const length of [1, 1152, 5000]) {
    const mp3 = await encodeMp3(new Int16Array(length).fill(1000), 44100);
    const tag = lameTag(mp3), out = await decode(mp3);
    check(`${length} samples: the tag accounts for every decoded sample`, out.channelData[0].length === tag.delay + length + tag.padding);
  }
  const empty = await decode(await encodeMp3(new Int16Array(0), 44100));
  check('0 samples: a tag-only file that decodes to nothing', (empty.channelData[0]?.length ?? 0) === 0);
  // Rates MP3 cannot carry are resampled to the nearest family, 48 or 44.1 kHz.
  for (const [rate, target] of [[96000, 48000], [88200, 44100], [50000, 48000]]) {
    const wav = await wavOf(testSignal(rate, 0.5), rate);
    const mp3 = await TF2Formats.fromWav(wav, 'mp3');
    const tag = lameTag(mp3), out = await decode(mp3);
    const length = out.channelData[0].length - tag.delay - tag.padding;
    check(`${rate} Hz renders become ${target} Hz MP3s of the same duration`, out.sampleRate === target && Math.abs(length - target / 2) <= 2);
  }
  await assert.rejects(() => encodeMp3(new Int16Array(10), 96000), /cannot carry/);
  await assert.rejects(() => encodeMp3(new Float32Array(10), 44100), /Int16Array/);
  check('invalid MP3 input is rejected', true);
}

/* ---------------- ZIP ---------------- */

console.log('\n[Formats 4] ZIP archives');
{
  const enc = new TextEncoder();
  check('CRC-32 check value', TF2Zip.crc32(enc.encode('123456789')) === 0xcbf43926);
  const parts = enc.encode('123456789');
  check('CRC-32 continues across chunks', TF2Zip.crc32(parts.subarray(4), TF2Zip.crc32(parts.subarray(0, 4))) === 0xcbf43926);
  const files = [
    ['readme.txt', enc.encode('hello')],
    ['sång (2)_tf2_steam.flac', Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 0xff)],
    ['empty.wav', new Uint8Array(0)]
  ];
  const date = new Date(2026, 8, 26, 21, 7, 30);
  const zip = new Uint8Array(await TF2Zip.build(files.map(([name, data], i) => ({
    name, data: i === 1 ? new Blob([data]) : data, crc: TF2Zip.crc32(data), size: data.length
  })), date).arrayBuffer());
  const view = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  check('end of central directory record', view.getUint32(eocd, true) === 0x06054b50 && view.getUint16(eocd + 10, true) === 3);
  let cd = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (const [name, data] of files) {
    assert.equal(view.getUint32(cd, true), 0x02014b50, 'central directory header');
    const nameLength = view.getUint16(cd + 28, true), offset = view.getUint32(cd + 42, true);
    const crc = view.getUint32(cd + 16, true), size = view.getUint32(cd + 24, true);
    check(`${name}: UTF-8 name, stored, DOS date`, dec.decode(zip.subarray(cd + 46, cd + 46 + nameLength)) === name
      && view.getUint16(cd + 8, true) === 0x0800 && view.getUint16(cd + 10, true) === 0
      && view.getUint16(cd + 14, true) === (((2026 - 1980) << 9) | (9 << 5) | 26)
      && view.getUint16(cd + 12, true) === ((21 << 11) | (7 << 5) | 15));
    assert.equal(view.getUint32(offset, true), 0x04034b50, 'local header');
    const localName = view.getUint16(offset + 26, true);
    const body = zip.subarray(offset + 30 + localName, offset + 30 + localName + size);
    check(`${name}: local header and data agree with the directory`, localName === nameLength && size === data.length
      && view.getUint32(offset + 14, true) === crc && TF2Zip.crc32(body) === crc && body.every((v, i) => v === data[i]));
    cd += 46 + nameLength;
  }
  check('central directory ends at the end record', cd === eocd && view.getUint32(eocd + 12, true) === eocd - view.getUint32(eocd + 16, true));
  assert.throws(() => TF2Zip.build([{ name: 'big.wav', data: new Uint8Array(0), crc: 0, size: 2 ** 32 }]), /too large/);
  check('archives over 4 GB are refused', true);
}

console.log(`\n${passed} passed, 0 failed`);
