/* Video in and out: an MP4 or MOV source keeps its video, and the rendered
 * voice replaces its audio. The video (and any other non-audio track, such as
 * a timecode) is copied sample for sample, never re-encoded; only the new
 * audio track is encoded:
 *   - AAC-LC with WebCodecs, where the browser has an AAC encoder
 *   - otherwise Opus (the bundled libopus) in MP4, or 16-bit PCM in MOV
 * Regular and fragmented files are read; the output is a regular file with
 * the index (moov) first. WebM and Matroska sources give audio only.
 *
 * TF2Video.inspect(bytes) -> { container, video, audio, note } or null
 * TF2Video.remux(bytes, samples, rate, { onProgress }) -> { blob, audioCodec, container }
 */
(function () {
  'use strict';

  /* ---------------- reading ---------------- */

  const fourcc = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

  // The boxes in [from, to): { type, start, body, end }.
  function children(u8, from, to) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
    let at = from;
    while (at + 8 <= to) {
      let size = view.getUint32(at), header = 8;
      const type = fourcc(u8, at + 4);
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
      else if (size === 0) size = to - at;
      if (size < header || at + size > to) throw new Error(`the ${type} box runs past the end of the file`);
      out.push({ type, start: at, body: at + header, end: at + size });
      at += size;
    }
    return out;
  }
  const find = (u8, box, type) => children(u8, box.body, box.end).find(b => b.type === type) || null;
  const findAll = (u8, box, type) => children(u8, box.body, box.end).filter(b => b.type === type);
  const path = (u8, box, ...types) => types.reduce((b, t) => (b ? find(u8, b, t) : null), box);

  function reader(u8, box) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let at = box.body;
    return {
      get at() { return at; }, skip(n) { at += n; },
      u8() { return u8[at++]; }, u16() { const v = view.getUint16(at); at += 2; return v; },
      u24() { const v = (u8[at] << 16) | (u8[at + 1] << 8) | u8[at + 2]; at += 3; return v; },
      u32() { const v = view.getUint32(at); at += 4; return v; }, i32() { const v = view.getInt32(at); at += 4; return v; },
      u64() { const v = Number(view.getBigUint64(at)); at += 8; return v; }, i64() { const v = Number(view.getBigInt64(at)); at += 8; return v; }
    };
  }
  const fullHeader = (r) => { const version = r.u8(), flags = r.u24(); return { version, flags }; };

  // One track of the movie box: identity, timing and, for a regular file,
  // its samples ({ offset, size, duration, cto, sync }).
  function readTrack(u8, trak) {
    const tkhd = find(u8, trak, 'tkhd'), mdia = find(u8, trak, 'mdia');
    const r = reader(u8, tkhd), h = fullHeader(r);
    r.skip(h.version === 1 ? 16 : 8);
    const id = r.u32();
    const mdhd = find(u8, mdia, 'mdhd'), m = reader(u8, mdhd), mh = fullHeader(m);
    m.skip(mh.version === 1 ? 16 : 8);
    const timescale = m.u32();
    const hdlr = reader(u8, find(u8, mdia, 'hdlr'));
    fullHeader(hdlr); hdlr.skip(4);
    const handler = fourcc(u8, hdlr.at);
    const stbl = path(u8, mdia, 'minf', 'stbl');
    const stsd = stbl && find(u8, stbl, 'stsd');
    const entry = stsd ? children(u8, stsd.body + 8, stsd.end)[0] : null;
    const edts = find(u8, trak, 'edts');
    return { trak, id, handler, timescale, stbl, stsd, format: entry ? entry.type : '', edts, samples: stbl ? tableSamples(u8, stbl) : [] };
  }

  function tableSamples(u8, stbl) {
    const get = (t) => find(u8, stbl, t);
    const sizes = [];
    const stsz = get('stsz'), stz2 = get('stz2');
    if (stsz) {
      const r = reader(u8, stsz); fullHeader(r);
      const fixed = r.u32(), count = r.u32();
      for (let i = 0; i < count; i++) sizes.push(fixed || r.u32());
    } else if (stz2) {
      const r = reader(u8, stz2); fullHeader(r); r.skip(3);
      const bits = r.u8(), count = r.u32();
      for (let i = 0; i < count; i++) {
        if (bits === 16) sizes.push(r.u16());
        else if (bits === 8) sizes.push(r.u8());
        else { const b = u8[r.at]; sizes.push(i % 2 ? b & 15 : b >> 4); if (i % 2) r.skip(1); }
      }
    }
    if (!sizes.length) return [];
    const offsets = [];
    const stco = get('stco'), co64 = get('co64');
    if (stco || co64) {
      const r = reader(u8, stco || co64); fullHeader(r);
      const count = r.u32();
      for (let i = 0; i < count; i++) offsets.push(stco ? r.u32() : r.u64());
    }
    const stsc = [];
    if (get('stsc')) {
      const r = reader(u8, get('stsc')); fullHeader(r);
      const count = r.u32();
      for (let i = 0; i < count; i++) stsc.push({ first: r.u32(), perChunk: r.u32(), desc: r.u32() });
    }
    const samples = sizes.map(size => ({ size, offset: 0, duration: 0, cto: 0, sync: true }));
    // Samples to chunks: each stsc run holds perChunk samples per chunk.
    let s = 0;
    for (let e = 0; e < stsc.length && s < samples.length; e++) {
      const lastChunk = e + 1 < stsc.length ? stsc[e + 1].first - 1 : offsets.length;
      for (let c = stsc[e].first; c <= lastChunk && s < samples.length; c++) {
        let at = offsets[c - 1];
        for (let k = 0; k < stsc[e].perChunk && s < samples.length; k++, s++) { samples[s].offset = at; at += samples[s].size; }
      }
    }
    if (s < samples.length) throw new Error('the sample table does not place every sample');
    if (get('stts')) {
      const r = reader(u8, get('stts')); fullHeader(r);
      let i = 0;
      for (let n = r.u32(); n > 0; n--) { const count = r.u32(), delta = r.u32(); for (let k = 0; k < count && i < samples.length; k++) samples[i++].duration = delta; }
    }
    if (get('ctts')) {
      const r = reader(u8, get('ctts')), h = fullHeader(r);
      let i = 0;
      for (let n = r.u32(); n > 0; n--) { const count = r.u32(), off = h.version ? r.i32() : r.u32(); for (let k = 0; k < count && i < samples.length; k++) samples[i++].cto = off; }
    }
    if (get('stss')) {
      samples.forEach(x => { x.sync = false; });
      const r = reader(u8, get('stss')); fullHeader(r);
      for (let n = r.u32(); n > 0; n--) { const k = r.u32() - 1; if (samples[k]) samples[k].sync = true; }
    }
    return samples;
  }

  // Fragments (moof + mdat): the samples each track run adds.
  function fragmentSamples(u8, top, tracks, moov) {
    const trex = new Map();
    const mvex = find(u8, moov, 'mvex');
    if (mvex) for (const t of findAll(u8, mvex, 'trex')) {
      const r = reader(u8, t); fullHeader(r);
      trex.set(r.u32(), { desc: r.u32(), duration: r.u32(), size: r.u32(), flags: r.u32() });
    }
    for (const moof of top.filter(b => b.type === 'moof')) {
      for (const traf of findAll(u8, moof, 'traf')) {
        const t = reader(u8, find(u8, traf, 'tfhd')), th = fullHeader(t);
        const id = t.u32(), d = trex.get(id) || { duration: 0, size: 0, flags: 0 };
        const base = th.flags & 1 ? t.u64() : moof.start;
        if (th.flags & 2) t.u32();
        const defDuration = th.flags & 8 ? t.u32() : d.duration;
        const defSize = th.flags & 0x10 ? t.u32() : d.size;
        const defFlags = th.flags & 0x20 ? t.u32() : d.flags;
        const track = tracks.find(x => x.id === id);
        if (!track) continue;
        let at = base;
        for (const trun of findAll(u8, traf, 'trun')) {
          const r = reader(u8, trun), h = fullHeader(r);
          const count = r.u32();
          if (h.flags & 1) at = base + r.i32();
          const first = h.flags & 4 ? r.u32() : null;
          for (let i = 0; i < count; i++) {
            const duration = h.flags & 0x100 ? r.u32() : defDuration;
            const size = h.flags & 0x200 ? r.u32() : defSize;
            const flags = h.flags & 0x400 ? r.u32() : i === 0 && first !== null ? first : defFlags;
            const cto = h.flags & 0x800 ? (h.version ? r.i32() : r.u32()) : 0;
            track.samples.push({ offset: at, size, duration, cto, sync: !(flags & 0x10000) });
            at += size;
          }
        }
      }
    }
  }

  function parse(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 16 || !['ftyp', 'moov', 'free', 'wide', 'mdat', 'skip', 'pnot'].includes(fourcc(u8, 4))) return null;
    const top = children(u8, 0, u8.length);
    const moov = top.find(b => b.type === 'moov');
    if (!moov) throw new Error('the file has no movie index (moov)');
    const ftyp = top.find(b => b.type === 'ftyp');
    const brand = ftyp ? fourcc(u8, ftyp.body) : 'qt  ';
    const mvhd = find(u8, moov, 'mvhd'), r = reader(u8, mvhd), h = fullHeader(r);
    r.skip(h.version === 1 ? 16 : 8);
    const timescale = r.u32();
    const tracks = findAll(u8, moov, 'trak').map(t => readTrack(u8, t));
    if (top.some(b => b.type === 'moof')) fragmentSamples(u8, top, tracks, moov);
    return { u8, top, moov, mvhd, ftyp, brand, container: brand === 'qt  ' ? 'mov' : 'mp4', timescale, tracks };
  }

  // What the app can do with a file: null if it is not MP4 or MOV.
  function inspect(bytes) {
    let movie;
    try { movie = parse(bytes); } catch (error) { return { container: 'mp4', video: false, audio: false, note: `Unreadable video file: ${error.message}` }; }
    if (!movie) return null;
    const video = movie.tracks.filter(t => t.handler === 'vide');
    const audio = movie.tracks.filter(t => t.handler === 'soun');
    const encrypted = video.some(t => /^enc/.test(t.format));
    return { container: movie.container, video: video.length > 0 && !encrypted, audio: audio.length > 0,
      codec: video[0] ? video[0].format : '', note: encrypted ? 'The video is encrypted; only its audio can be used.' : '' };
  }

  /* ---------------- writing ---------------- */

  const enc = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
  function concat(parts) {
    const n = parts.reduce((t, p) => t + p.length, 0), out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function be(bytes, value) {
    const out = new Uint8Array(bytes);
    let v = BigInt(Math.round(value));
    if (v < 0n) v += 1n << BigInt(bytes * 8);
    for (let i = bytes - 1; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; }
    return out;
  }
  const u8 = (v) => be(1, v), u16 = (v) => be(2, v), u24 = (v) => be(3, v), u32 = (v) => be(4, v), u64 = (v) => be(8, v);
  function box(type, ...parts) {
    const body = concat(parts.flat(Infinity));
    return concat([u32(body.length + 8), enc(type), body]);
  }
  const fullBox = (type, version, flags, ...parts) => box(type, u8(version), u24(flags), ...parts);

  // Run-length stts / ctts and the sync table from per-sample values.
  function runs(values) {
    const out = [];
    for (const v of values) { const last = out[out.length - 1]; if (last && last[1] === v) last[0]++; else out.push([1, v]); }
    return out;
  }
  function stblFor(samples, chunks, co64, stsdBytes, extra = []) {
    const stts = runs(samples.map(s => s.duration));
    const parts = [stsdBytes, fullBox('stts', 0, 0, u32(stts.length), stts.map(([n, d]) => [u32(n), u32(d)]))];
    if (samples.some(s => s.cto)) {
      const ctts = runs(samples.map(s => s.cto)), signed = samples.some(s => s.cto < 0);
      parts.push(fullBox('ctts', signed ? 1 : 0, 0, u32(ctts.length), ctts.map(([n, o]) => [u32(n), u32(o)])));
    }
    if (samples.some(s => !s.sync)) {
      const sync = samples.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
      parts.push(fullBox('stss', 0, 0, u32(sync.length), sync.map(u32)));
    }
    const stsc = runs(chunks.map(c => c.count)).reduce((list, [n, count], i, all) => {
      const first = all.slice(0, i).reduce((t, [m]) => t + m, 0) + 1;
      list.push([first, count]);
      return list;
    }, []);
    parts.push(fullBox('stsc', 0, 0, u32(stsc.length), stsc.map(([first, count]) => [u32(first), u32(count), u32(1)])));
    const fixed = samples.every(s => s.size === samples[0].size) ? samples[0].size : 0;
    parts.push(fullBox('stsz', 0, 0, u32(fixed), u32(samples.length), fixed ? [] : samples.map(s => u32(s.size))));
    parts.push(co64 ? fullBox('co64', 0, 0, u32(chunks.length), chunks.map(c => u64(c.offset)))
      : fullBox('stco', 0, 0, u32(chunks.length), chunks.map(c => u32(c.offset))));
    return box('stbl', parts, extra);
  }

  // A box rebuilt with some descendants replaced: replace(type path) -> bytes.
  function rebuild(src, b, replace, trail = []) {
    const here = [...trail, b.type];
    const swapped = replace(here);
    if (swapped !== undefined) return swapped;
    if (!['moov', 'trak', 'mdia', 'minf', 'edts'].includes(b.type)) return src.subarray(b.start, b.end);
    const kids = children(src, b.body, b.end).map(k => rebuild(src, k, replace, here)).filter(Boolean);
    return box(b.type, kids);
  }

  // The fields a duration change touches, patched in a copy of the box.
  function patchDuration(src, b, duration, fieldAfter) {
    const out = src.slice(b.start, b.end), version = out[b.body - b.start];
    const at = b.body - b.start + 4 + (version === 1 ? 16 : 8) + fieldAfter;
    out.set(version === 1 ? u64(duration) : u32(Math.min(duration, 0xffffffff)), at);
    return out;
  }

  /* ---------------- the new audio ---------------- */

  function resample(samples, from, to) {
    return from === to ? samples : TF2Audio.resampleSinc(samples, from, to);
  }

  // The AAC encoder's delay (priming samples), which the edit list skips:
  // found by decoding the start again and lining it up with the input, as
  // encoders differ (1024 or 2112 samples) and seldom say.
  async function aacPriming(frames, description, samples, rate) {
    const guess = frames[0].timestamp < 0 ? Math.round(-frames[0].timestamp / 1e6 * rate) : 1024;
    if (typeof AudioDecoder === 'undefined') return guess;
    const config = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, description };
    try { if (!(await AudioDecoder.isConfigSupported(config)).supported) return guess; } catch (e) { return guess; }
    const parts = [];
    const decoder = new AudioDecoder({
      output(data) { const x = new Float32Array(data.numberOfFrames); data.copyTo(x, { planeIndex: 0, format: 'f32-planar' }); parts.push(x); data.close(); },
      error() {}
    });
    decoder.configure(config);
    const count = Math.min(frames.length, Math.ceil((rate + 4096) / 1024));
    for (let i = 0; i < count; i++) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * 1024 / rate * 1e6), data: frames[i].data }));
    }
    try { await decoder.flush(); } catch (e) { return guess; }
    decoder.close();
    const out = new Float32Array(parts.reduce((t, p) => t + p.length, 0));
    parts.reduce((o, p) => { out.set(p, o); return o + p.length; }, 0);
    const span = Math.min(samples.length, out.length - 4096, Math.round(rate / 2));
    if (span < 2048) return guess;
    let best = guess, bestValue = -Infinity;
    for (let lag = 0; lag <= 4096; lag++) {
      let sum = 0;
      for (let i = 0; i < span; i += 2) sum += samples[i] * out[i + lag];
      if (sum > bestValue) { bestValue = sum; best = lag; }
    }
    return bestValue > 0 ? best : guess;
  }

  async function encodeAac(samples, rate) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
    const config = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, bitrate: 160000 };
    try { if (!(await AudioEncoder.isConfigSupported(config)).supported) return null; } catch (e) { return null; }
    const frames = [];
    let description = null, error = null;
    const encoder = new AudioEncoder({
      output(chunk, meta) {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) description = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        frames.push({ data, timestamp: chunk.timestamp });
      },
      error(e) { error = e; }
    });
    encoder.configure(config);
    const block = 4096;
    for (let at = 0; at < samples.length; at += block) {
      const part = samples.slice(at, Math.min(samples.length, at + block));
      encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: part.length, numberOfChannels: 1,
        timestamp: Math.round(at / rate * 1e6), data: part }));
    }
    await encoder.flush();
    encoder.close();
    if (error || !frames.length || !description) return null;
    const priming = await aacPriming(frames, description, samples, rate);
    // ES descriptor: decoder config (AAC, audio stream) with the AudioSpecificConfig.
    const descriptor = (tag, body) => concat([u8(tag), u8(body.length), body]);
    const dsi = descriptor(5, description);
    const dcd = descriptor(4, concat([u8(0x40), u8(0x15), u24(0), u32(config.bitrate), u32(config.bitrate), dsi]));
    const esd = descriptor(3, concat([u16(1), u8(0), dcd, descriptor(6, u8(2))]));
    const entry = box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(1), u16(16), u16(0), u16(0), u32(rate * 65536),
      fullBox('esds', 0, 0, esd));
    return { codec: 'AAC', timescale: rate, entry, preSkip: priming, length: samples.length,
      samples: frames.map(f => ({ data: f.data, duration: 1024 })) };
  }

  async function encodeOpus(samples, rate) {
    const opus = await import('./opus-codec.mjs');
    const pcm = resample(samples, rate, 48000);
    const { packets, preSkip } = await opus.encodeForContainer(pcm, 48000, 128000);
    const entry = box('Opus', new Uint8Array(6), u16(1), new Uint8Array(8), u16(1), u16(16), u16(0), u16(0), u32(48000 * 65536),
      box('dOps', u8(0), u8(1), u16(preSkip), u32(rate), u16(0), u8(0)));
    return { codec: 'Opus', timescale: 48000, entry, preSkip, length: pcm.length,
      samples: packets.map(data => ({ data, duration: 960 })) };
  }

  function encodePcm(samples, rate) {
    // QuickTime 'sowt': 16-bit little-endian PCM, one sample per frame.
    const data = new Uint8Array(samples.length * 2), view = new DataView(data.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
    const entry = box('sowt', new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u16(1), u16(16), u16(0), u16(0), u32(rate * 65536));
    return { codec: 'PCM', timescale: rate, entry, preSkip: 0, length: samples.length, pcm: data };
  }

  /* ---------------- remux ---------------- */

  async function remux(bytes, samples, rate, options = {}) {
    const movie = parse(bytes);
    if (!movie) throw new Error('only MP4 and MOV files can carry the voice back into their video');
    const { u8: src, timescale } = movie;
    const keep = movie.tracks.filter(t => t.handler !== 'soun' && t.samples.length);
    if (!keep.some(t => t.handler === 'vide')) throw new Error('the file has no video track to keep');
    const oldAudio = movie.tracks.find(t => t.handler === 'soun');
    const progress = (v) => { if (options.onProgress) options.onProgress(v); };

    // The voice, where the old audio started (its leading empty edits).
    let delay = 0;
    if (oldAudio && oldAudio.edts) {
      const elst = find(src, oldAudio.edts, 'elst'), r = reader(src, elst), h = fullHeader(r);
      for (let n = r.u32(); n > 0; n--) {
        const duration = h.version === 1 ? r.u64() : r.u32(), mediaTime = h.version === 1 ? r.i64() : r.i32();
        r.skip(4);
        if (mediaTime !== -1) break;
        delay += duration;
      }
    }
    progress(.05);
    const audio = (await encodeAac(samples, rate)) || (movie.container === 'mov' ? encodePcm(samples, rate) : await encodeOpus(samples, rate));
    progress(.6);
    const audioId = Math.max(...movie.tracks.map(t => t.id)) + 1;
    const audioSamples = audio.pcm
      ? Array.from({ length: Math.ceil(audio.length / rate) }, (_, k) => {
        const from = k * rate, to = Math.min(audio.length, from + rate);
        return { size: (to - from) * 2, frames: to - from, data: audio.pcm.subarray(from * 2, to * 2) };
      })
      : audio.samples.map(s => ({ size: s.data.length, duration: s.duration, data: s.data }));

    // Chunks of about a second per track, interleaved by time.
    const chunks = [];
    for (const t of keep) {
      let time = 0, current = null;
      t.samples.forEach((s, i) => {
        if (!current || time - current.time >= t.timescale || current.count >= 256) { current = { track: t, time, count: 0, parts: [], seconds: time / t.timescale }; chunks.push(current); }
        current.count++;
        const last = current.parts[current.parts.length - 1];
        if (last && last.end === s.offset) last.end += s.size; else current.parts.push({ start: s.offset, end: s.offset + s.size });
        time += s.duration;
      });
    }
    let time = 0;
    if (audio.pcm) {
      audioSamples.forEach((c) => { chunks.push({ track: null, count: c.frames, parts: [c.data], seconds: delay / timescale + time / rate }); time += c.frames; });
    } else {
      let current = null;
      for (const s of audioSamples) {
        if (!current || time - current.time >= audio.timescale) { current = { track: null, time, count: 0, parts: [], seconds: delay / timescale + time / audio.timescale }; chunks.push(current); }
        current.count++; current.parts.push(s.data); time += s.duration;
      }
    }
    chunks.sort((a, b) => a.seconds - b.seconds || (a.track ? 0 : 1) - (b.track ? 0 : 1));
    const chunkBytes = (c) => c.parts.reduce((t, p) => t + (p instanceof Uint8Array ? p.length : p.end - p.start), 0);
    const mdatSize = chunks.reduce((t, c) => t + chunkBytes(c), 0);

    const audioDuration = audio.length / (audio.pcm ? rate : audio.timescale);
    const audioMediaDuration = audio.pcm ? audio.length : audioSamples.reduce((t, s) => t + s.duration, 0);
    const trackDuration = (t) => t.samples.reduce((n, s) => n + s.duration, 0);
    const movieDurations = keep.map(t => {
      const elst = t.edts && find(src, t.edts, 'elst');
      if (!elst) return Math.round(trackDuration(t) / t.timescale * timescale);
      const r = reader(src, elst), h = fullHeader(r);
      let total = 0;
      for (let n = r.u32(); n > 0; n--) { total += h.version === 1 ? r.u64() : r.u32(); r.skip(h.version === 1 ? 12 : 8); }
      return total || Math.round(trackDuration(t) / t.timescale * timescale);
    });
    const audioMovieDuration = Math.round(delay + audioDuration * timescale);
    const movieDuration = Math.max(...movieDurations, audioMovieDuration);

    // The moov, laid out twice: once to learn its size, then with offsets.
    const build = (co64, offsetBase) => {
      let at = offsetBase;
      const placed = new Map();
      for (const c of chunks) { placed.set(c, at); at += chunkBytes(c); }
      const trackChunks = (track) => chunks.filter(c => c.track === track).map(c => ({ count: c.count, offset: placed.get(c) }));
      const audioChunks = trackChunks(null);
      const edits = [];
      if (delay > 0) edits.push([u32(delay), u32(-1 >>> 0), u16(1), u16(0)]);
      edits.push([u32(Math.round(audioDuration * timescale)), u32(audio.preSkip), u16(1), u16(0)]);
      const pcmStbl = () => box('stbl', fullBox('stsd', 0, 0, u32(1), audio.entry),
        fullBox('stts', 0, 0, u32(1), u32(audio.length), u32(1)),
        fullBox('stsc', 0, 0, u32(runs(audioChunks.map(c => c.count)).length),
          runs(audioChunks.map(c => c.count)).reduce((list, [n, count], i, all) => { list.push([u32(all.slice(0, i).reduce((t, [m]) => t + m, 0) + 1), u32(count), u32(1)]); return list; }, [])),
        fullBox('stsz', 0, 0, u32(2), u32(audio.length)),
        co64 ? fullBox('co64', 0, 0, u32(audioChunks.length), audioChunks.map(c => u64(c.offset)))
          : fullBox('stco', 0, 0, u32(audioChunks.length), audioChunks.map(c => u32(c.offset))));
      const audioTrak = box('trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(audioId), u32(0), u32(audioMovieDuration), new Uint8Array(8), u16(0), u16(1), u16(0x0100), u16(0),
          [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32), u32(0), u32(0)),
        box('edts', fullBox('elst', 0, 0, u32(edits.length), edits)),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(audio.pcm ? rate : audio.timescale), u32(audioMediaDuration), u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), enc('soun'), new Uint8Array(12), enc('SoundHandler\0')),
          box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            audio.pcm ? pcmStbl() : stblFor(audioSamples.map(s => ({ size: s.size, duration: s.duration, cto: 0, sync: true })), audioChunks, co64,
              fullBox('stsd', 0, 0, u32(1), audio.entry)))));
      const keptById = new Map(keep.map((t, i) => [t.id, { t, duration: movieDurations[i] }]));
      const tracks = [];
      for (const trakBox of findAll(src, movie.moov, 'trak')) {
        const t = movie.tracks.find(x => x.trak.start === trakBox.start);
        if (!keptById.has(t.id)) continue;
        tracks.push(rebuild(src, trakBox, (p) => {
          const key = p.join('/');
          if (key === 'trak/tkhd') return patchDuration(src, find(src, trakBox, 'tkhd'), keptById.get(t.id).duration, 8);
          if (key === 'trak/mdia/mdhd') return patchDuration(src, find(src, find(src, trakBox, 'mdia'), 'mdhd'), trackDuration(t), 4);
          if (key === 'trak/mdia/minf/stbl') {
            // Kept: the sample descriptions and per-sample groups, whose order is unchanged.
            const extra = ['sdtp', 'sgpd', 'sbgp', 'cslg'].flatMap(type => findAll(src, t.stbl, type)).map(b => src.subarray(b.start, b.end));
            return stblFor(t.samples, trackChunks(t), co64, src.subarray(t.stsd.start, t.stsd.end), extra);
          }
          return undefined;
        }));
      }
      const mvhd = src.slice(movie.mvhd.start, movie.mvhd.end);
      const v = mvhd[movie.mvhd.body - movie.mvhd.start];
      mvhd.set(v === 1 ? u64(movieDuration) : u32(movieDuration), movie.mvhd.body - movie.mvhd.start + 4 + (v === 1 ? 16 : 8) + 4);
      mvhd.set(u32(audioId + 1), mvhd.length - 4);
      const others = children(src, movie.moov.body, movie.moov.end).filter(b => !['mvhd', 'trak', 'mvex'].includes(b.type))
        .map(b => src.subarray(b.start, b.end));
      return box('moov', mvhd, tracks, audioTrak, others);
    };
    const ftyp = movie.container === 'mov'
      ? box('ftyp', enc('qt  '), u32(0), enc('qt  '))
      : box('ftyp', enc('isom'), u32(512), enc('isom'), enc('iso2'), enc('mp41'), audio.codec === 'Opus' ? enc('Opus') : new Uint8Array(0));
    const large = mdatSize + 16 > 0xffffffff;
    const mdatHeader = large ? concat([u32(1), enc('mdat'), u64(mdatSize + 16)]) : concat([u32(mdatSize + 8), enc('mdat')]);
    let moov = build(false, 0);
    const co64 = ftyp.length + moov.length + mdatHeader.length + mdatSize > 0xffffffff;
    moov = build(co64, 0);
    moov = build(co64, ftyp.length + moov.length + mdatHeader.length);
    progress(.9);
    const parts = [ftyp, moov, mdatHeader];
    for (const c of chunks) for (const p of c.parts) parts.push(p instanceof Uint8Array ? p : src.subarray(p.start, p.end));
    const type = movie.container === 'mov' ? 'video/quicktime' : 'video/mp4';
    progress(1);
    return { blob: new Blob(parts, { type }), audioCodec: audio.codec, container: movie.container };
  }

  const TF2Video = { parse, inspect, remux };
  if (typeof window !== 'undefined') window.TF2Video = TF2Video;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Video;
})();
