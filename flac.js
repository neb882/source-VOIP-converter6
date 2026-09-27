/* FLAC encoder for the emulator's 16-bit mono renders (lossless, smaller than
 * WAV). Fixed-blocksize stream of 4096-sample frames; each subframe is
 * CONSTANT, VERBATIM or a FIXED predictor (order 0-4) with partitioned Rice
 * residuals, as in https://www.rfc-editor.org/rfc/rfc9639. The STREAMINFO MD5
 * is left zero ("not computed"), which the format allows.
 *
 * TF2Flac.encode(int16Samples, sampleRate) -> Uint8Array
 */
(function () {
  'use strict';

  const BLOCK = 4096;
  const MAX_RICE = 14;              // 4-bit parameters; 15 is the escape code
  const MAX_PARTITION_ORDER = 8;

  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    CRC8[i] = c;
    let d = i << 8;
    for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
    CRC16[i] = d;
  }
  function crc8(bytes, from, to) {
    let c = 0;
    for (let i = from; i < to; i++) c = CRC8[c ^ bytes[i]];
    return c;
  }
  function crc16(bytes, from, to) {
    let c = 0;
    for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ bytes[i]];
    return c;
  }

  // MSB-first bit writer. Writes of up to 24 bits at a time keep the
  // accumulator inside 32-bit integer range.
  class BitWriter {
    constructor(capacity) { this.buf = new Uint8Array(Math.max(1024, capacity)); this.pos = 0; this.acc = 0; this.n = 0; }
    reserve(bytes) {
      if (this.pos + bytes <= this.buf.length) return;
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + bytes));
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }
    bits(value, count) {
      while (count > 24) { count -= 24; this.bits(Math.floor(value / 2 ** count) & 0xffffff, 24); value %= 2 ** count; }
      if (!count) return;
      this.reserve(4);
      this.acc = (this.acc << count) | (value & ((1 << count) - 1));
      this.n += count;
      while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 0xff; }
      this.acc &= (1 << this.n) - 1;
    }
    unary(zeros) {                 // `zeros` 0 bits, then a 1
      while (zeros >= 24) { this.bits(0, 24); zeros -= 24; }
      this.bits(1, zeros + 1);
    }
    align() { if (this.n) this.bits(0, 8 - this.n); }
    bytes() { this.align(); return this.buf.subarray(0, this.pos); }
  }

  const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

  function writeUtf8Number(w, value) {          // frame number, UTF-8 style
    if (value < 0x80) { w.bits(value, 8); return; }
    let len = 2;
    while (value >= 2 ** (5 * len + 1)) len++;
    const shift = 6 * (len - 1);
    w.bits(((0xff << (8 - len)) & 0xff) | Math.floor(value / 2 ** shift), 8);
    for (let s = shift - 6; s >= 0; s -= 6) w.bits(0x80 | (Math.floor(value / 2 ** s) & 0x3f), 8);
  }

  // Residual of the order-p fixed predictor at sample i (i >= p).
  function residual(x, i, p) {
    switch (p) {
      case 0: return x[i];
      case 1: return x[i] - x[i - 1];
      case 2: return x[i] - 2 * x[i - 1] + x[i - 2];
      case 3: return x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      default: return x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }

  // Best Rice parameter and estimated bits for `count` residuals summing to `sum` (zigzagged).
  function riceCost(sum, count) {
    if (!count) return { k: 0, bits: 0 };
    let best = null;
    const guess = Math.min(MAX_RICE, sum > count ? Math.floor(Math.log2(sum / count)) : 0);
    for (let k = Math.max(0, guess - 1); k <= Math.min(MAX_RICE, guess + 1); k++) {
      const bits = count * (k + 1) + Math.floor(sum / 2 ** k);
      if (!best || bits < best.bits) best = { k, bits };
    }
    return best;
  }

  function encodeSubframe(w, x, n) {
    let constant = true;
    for (let i = 1; i < n && constant; i++) constant = x[i] === x[0];
    if (constant) { w.bits(0, 8); w.bits(x[0] & 0xffff, 16); return; }

    // Fixed predictor order by the smallest sum of absolute residuals.
    let order = 0, bestSum = Infinity;
    for (let p = 0; p <= Math.min(4, n - 1); p++) {
      let s = 0;
      for (let i = p; i < n; i++) s += Math.abs(residual(x, i, p));
      if (s < bestSum) { bestSum = s; order = p; }
    }
    const u = new Uint32Array(n);
    for (let i = order; i < n; i++) { const r = residual(x, i, order); u[i] = r >= 0 ? 2 * r : -2 * r - 1; }

    // Partition order: finest partition sums, merged upward.
    let maxOrder = 0;
    while (maxOrder < MAX_PARTITION_ORDER && n % (2 << maxOrder) === 0 && (n >> (maxOrder + 1)) > order) maxOrder++;
    let sums = new Float64Array(1 << maxOrder);
    const fine = n >> maxOrder;
    for (let pt = 0; pt < sums.length; pt++) {
      let s = 0;
      for (let i = Math.max(pt * fine, order); i < (pt + 1) * fine; i++) s += u[i];
      sums[pt] = s;
    }
    let best = null;
    for (let po = maxOrder; po >= 0; po--) {
      const size = n >> po;
      let bits = 0; const ks = [];
      for (let pt = 0; pt < sums.length; pt++) {
        const count = pt === 0 ? size - order : size;
        const c = riceCost(sums[pt], count);
        bits += 4 + c.bits; ks.push(c.k);
      }
      if (!best || bits < best.bits) best = { po, ks, bits };
      if (po > 0) {
        const merged = new Float64Array(sums.length / 2);
        for (let pt = 0; pt < merged.length; pt++) merged[pt] = sums[2 * pt] + sums[2 * pt + 1];
        sums = merged;
      }
    }

    if (best.bits + 16 * order + 6 >= 16 * n) {         // VERBATIM is no larger
      w.bits(1 << 1, 8);
      for (let i = 0; i < n; i++) w.bits(x[i] & 0xffff, 16);
      return;
    }
    w.bits((8 + order) << 1, 8);                          // FIXED, no wasted bits
    for (let i = 0; i < order; i++) w.bits(x[i] & 0xffff, 16);
    w.bits(0, 2);                                          // Rice, 4-bit parameters
    w.bits(best.po, 4);
    const size = n >> best.po;
    for (let pt = 0; pt < best.ks.length; pt++) {
      const k = best.ks[pt];
      w.bits(k, 4);
      const mask = (1 << k) - 1;
      for (let i = Math.max(pt * size, order); i < (pt + 1) * size; i++) {
        w.unary(u[i] >>> k);
        if (k) w.bits(u[i] & mask, k);
      }
    }
  }

  function encode(samples, sampleRate) {
    if (Object.prototype.toString.call(samples) !== '[object Int16Array]') throw new TypeError('TF2Flac.encode expects Int16Array samples');
    const rate = Math.round(sampleRate);
    if (!(rate > 0 && rate < 2 ** 20)) throw new RangeError('FLAC sample rate out of range');
    const total = samples.length;
    const w = new BitWriter(total * 2 + 1024);
    // fLaC marker + STREAMINFO (last metadata block); frame sizes filled in below.
    w.bits(0x664c6143, 32);
    w.bits(0x80, 8); w.bits(34, 24);
    const info = w.pos;
    w.bits(BLOCK, 16); w.bits(BLOCK, 16);
    w.bits(0, 24); w.bits(0, 24);
    w.bits(rate, 20); w.bits(0, 3); w.bits(15, 5);
    w.bits(Math.floor(total / 2 ** 32), 4); w.bits(total % 2 ** 32, 32);
    for (let i = 0; i < 16; i++) w.bits(0, 8);          // MD5 not computed

    const block = new Int32Array(BLOCK);
    let minFrame = Infinity, maxFrame = 0;
    for (let start = 0, frame = 0; start < total; start += BLOCK, frame++) {
      const n = Math.min(BLOCK, total - start);
      for (let i = 0; i < n; i++) block[i] = samples[start + i];
      const at = w.pos;
      w.bits(0xfff8, 16);                                  // sync, fixed blocksize
      const sizeCode = n === BLOCK ? 12 : n <= 256 ? 6 : 7;
      w.bits(sizeCode, 4); w.bits(RATE_CODES[rate] || 0, 4);
      w.bits(0, 4);                                        // mono
      w.bits(4, 3); w.bits(0, 1);                          // 16 bits per sample
      writeUtf8Number(w, frame);
      if (sizeCode === 6) w.bits(n - 1, 8);
      else if (sizeCode === 7) w.bits(n - 1, 16);
      w.bits(crc8(w.buf, at, w.pos), 8);
      encodeSubframe(w, block, n);
      w.align();
      w.bits(crc16(w.buf, at, w.pos), 16);
      const size = w.pos - at;
      minFrame = Math.min(minFrame, size);
      maxFrame = Math.max(maxFrame, size);
    }
    const out = w.bytes();
    if (Number.isFinite(minFrame)) {
      out[info + 4] = minFrame >> 16; out[info + 5] = (minFrame >> 8) & 0xff; out[info + 6] = minFrame & 0xff;
    }
    out[info + 7] = maxFrame >> 16; out[info + 8] = (maxFrame >> 8) & 0xff; out[info + 9] = maxFrame & 0xff;
    return out.slice();
  }

  const TF2Flac = { encode };
  if (typeof window !== 'undefined') window.TF2Flac = TF2Flac;
  else if (typeof self !== 'undefined') self.TF2Flac = TF2Flac;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Flac;
})();
