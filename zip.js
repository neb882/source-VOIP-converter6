/* ZIP archives for batch downloads. Audio does not deflate, so entries are
 * stored uncompressed with their CRC-32; names are UTF-8 (general purpose
 * flag bit 11). No ZIP64, so an archive must stay under 4 GiB and 65535 files.
 *
 * TF2Zip.crc32(bytes, crc = 0) -> crc; pass the previous result to continue
 * TF2Zip.build(entries, date = new Date()) -> Blob
 *   entries: [{ name, data: Blob | Uint8Array, crc, size }]
 */
(function () {
  'use strict';

  const TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[i] = c >>> 0;
  }
  function crc32(bytes, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  const LIMIT = 0xffffffff;

  function build(entries, date = new Date()) {
    if (entries.length > 0xffff) throw new RangeError('too many files for one ZIP');
    const { time, day } = dosDateTime(date);
    const encoder = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const size = entry.size;
      if (!Number.isInteger(size) || size < 0 || offset + size + 30 + name.length > LIMIT) {
        throw new RangeError('the files are too large for one ZIP (4 GB); save them one by one');
      }
      // Shared fields: version needed 1.0, UTF-8 names, stored, time, date, CRC, sizes, name length.
      const common = (view, at) => {
        view.setUint16(at, 10, true);
        view.setUint16(at + 2, 0x0800, true);
        view.setUint16(at + 4, 0, true);
        view.setUint16(at + 6, time, true);
        view.setUint16(at + 8, day, true);
        view.setUint32(at + 10, entry.crc >>> 0, true);
        view.setUint32(at + 14, size, true);
        view.setUint32(at + 18, size, true);
        view.setUint16(at + 22, name.length, true);
      };
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      common(lv, 4);
      local.set(name, 30);
      const record = new Uint8Array(46 + name.length);
      const cv = new DataView(record.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);                 // made by: MS-DOS, spec 2.0
      common(cv, 6);
      cv.setUint32(42, offset, true);            // local header offset
      record.set(name, 46);
      parts.push(local, entry.data);
      central.push(record);
      offset += local.length + size;
    }
    const centralSize = central.reduce((sum, r) => sum + r.length, 0);
    if (offset + centralSize + 22 > LIMIT) throw new RangeError('the files are too large for one ZIP (4 GB); save them one by one');
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const TF2Zip = { crc32, build };
  if (typeof window !== 'undefined') window.TF2Zip = TF2Zip;
  else if (typeof self !== 'undefined') self.TF2Zip = TF2Zip;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Zip;
})();
