/* TF2 Voice Emulator, demo.js: the voice in a TF2 demo (.dem).
 *
 * A SourceTV demo keeps every voice message exactly as the server received
 * it. With Steam voice (sv_voicecodec steam, TF2's default) each message
 * holds the speaker's SteamID and Opus packets with sequence numbers and
 * end-of-transmission markers; the older engine codecs (vaudio_celt,
 * vaudio_celt_high) send bare fixed-size packets. Client demos made with
 * `record` keep the messages but not their payloads.
 *
 * parse(bytes) reads the demo (header, frames, network messages) and returns
 * the voice: the codec announced by VoiceInit and, per speaker, every packet
 * with its demo tick. decode(...) turns one speaker's packets back into
 * audio as the receiving game would: talk spurts at their tick, frames back
 * to back, lost frames concealed, DTX frames as comfort noise, the decoder
 * reset at each end of transmission. Same record layout and results as
 * tests/demovoice (Rust).
 *
 * Message layouts follow tf-demo-parser 0.6 (MIT or Apache-2.0).
 */
(function (root) {
  'use strict';

  // Bits in Source's order: least significant first within each byte.
  class Bits {
    constructor(u8, start = 0, end = u8.length * 8) { this.u8 = u8; this.pos = start; this.end = end; }
    get left() { return this.end - this.pos; }
    need(n) { if (n > this.left) throw new RangeError('demo message runs past its packet'); }
    read(n) {
      this.need(n);
      let v = 0, shift = 0;
      while (n > 0) {
        const off = this.pos & 7, take = Math.min(8 - off, n);
        v += ((this.u8[this.pos >> 3] >> off) & ((1 << take) - 1)) * 2 ** shift;
        shift += take; n -= take; this.pos += take;
      }
      return v;
    }
    bool() { return this.read(1) === 1; }
    skip(n) { this.need(n); this.pos += n; }
    bytes(n) {
      this.need(n * 8);
      if ((this.pos & 7) === 0) { const out = this.u8.slice(this.pos >> 3, (this.pos >> 3) + n); this.pos += n * 8; return out; }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = this.read(8);
      return out;
    }
    string() {
      let s = '';
      for (let c = this.read(8); c !== 0; c = this.read(8)) s += String.fromCharCode(c);
      return s;
    }
    float() { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, this.read(32), true); return b.getFloat32(0, true); }
    varint() {
      let v = 0;
      for (let shift = 0; shift < 35; shift += 7) {
        const byte = this.read(8);
        v += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) break;
      }
      return v;
    }
  }

  const log2 = (n) => (n > 0 ? 31 - Math.clz32(n) : 0);
  const bitCoord = (b) => { const int = b.bool(), frac = b.bool(); if (int || frac) { b.skip(1); if (int) b.skip(14); if (frac) b.skip(5); } };

  // Reads one network message of the given type: VoiceInit and VoiceData are
  // kept, ServerInfo gives the tick length, everything else is skipped.
  function message(type, b, protocol, out, tick) {
    switch (type) {
      case 0: return;                                                   // NOP
      case 2: b.skip(32); b.string(); b.skip(1); return;                // file
      case 3: b.skip(64); return;                                       // net tick
      case 4: b.string(); return;                                       // string command
      case 5: for (let n = b.read(8); n > 0; n--) { b.string(); b.string(); } return; // set convar
      case 6: b.skip(40); return;                                       // sign-on state
      case 7: b.string(); return;                                       // print
      case 8: {                                                         // server info
        b.skip(16 + 32 + 1 + 1 + 32 + 16);
        b.skip(protocol > 17 ? 128 : 32);
        b.skip(16);
        out.intervalPerTick = b.float();
        b.skip(8);
        b.string(); out.map = b.string(); b.string(); out.server = b.string();
        if (protocol > 15) b.skip(1);
        return;
      }
      case 10: {                                                        // class info
        const count = b.read(16);
        if (!b.bool()) for (let i = 0; i < count; i++) { b.skip(log2(count) + 1); b.string(); b.string(); }
        return;
      }
      case 11: b.skip(1); return;                                       // pause
      case 12: {                                                        // create string table
        b.string();
        const max = b.read(16);
        b.skip(log2(max) + 1);
        const length = protocol > 23 ? b.varint() : b.read(20);
        if (b.bool()) b.skip(12 + 4);
        b.skip(1);
        b.skip(length);
        return;
      }
      case 13: { b.skip(5); if (b.bool()) b.skip(16); b.skip(b.read(20)); return; } // update string table
      case 14: {                                                        // voice init
        const codec = b.string(), quality = b.read(8);
        const rate = quality === 255 ? b.read(16) : codec === 'vaudio_celt' ? 22050 : 11025;
        out.codecs.push({ tick, codec, quality, rate });
        return;
      }
      case 15: {                                                        // voice data
        const client = b.read(8), proximity = b.read(8), bits = b.read(16);
        const data = b.bytes(bits >> 3);
        b.skip(bits & 7);
        out.voice.push({ tick, client, proximity, data });
        return;
      }
      case 17: { const reliable = b.bool(); if (!reliable) b.skip(8); b.skip(b.read(reliable ? 8 : 16)); return; } // sounds
      case 18: b.skip(11); return;                                      // set view
      case 19: b.skip(1 + 48); return;                                  // fix angle
      case 21: {                                                        // BSP decal
        const has = [b.bool(), b.bool(), b.bool()];
        for (const h of has) if (h) bitCoord(b);
        b.skip(9);
        if (b.bool()) b.skip(11 + 13);
        b.skip(1);
        return;
      }
      case 23: { b.skip(8); b.skip(b.read(11)); return; }               // user message
      case 24: { b.skip(11 + 9); b.skip(b.read(11)); return; }          // entity message
      case 25: b.skip(b.read(11)); return;                              // game event
      case 26: {                                                        // packet entities
        b.skip(11);
        if (b.bool()) b.skip(32);
        b.skip(1 + 11);
        const length = b.read(20);
        b.skip(1);
        b.skip(length);
        return;
      }
      case 27: { b.skip(8); b.skip(protocol > 23 ? b.varint() : b.read(17)); return; } // temp entities
      case 28: b.skip(protocol > 22 ? 14 : 13); return;                 // prefetch
      case 29: { b.skip(16); b.skip(b.read(16) * 8); return; }          // menu
      case 30: { b.skip(9); b.skip(b.read(20)); return; }               // game event list
      case 31: b.skip(32); b.string(); return;                          // get cvar value
      case 32: b.skip(b.read(32) * 8); return;                          // cmd key values
      default: throw new Error(`unknown demo message type ${type}`);
    }
  }

  function parse(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const text = (at, n) => { let s = ''; for (let i = 0; i < n && u8[at + i]; i++) s += String.fromCharCode(u8[at + i]); return s; };
    if (u8.length < 1072 || text(0, 8) !== 'HL2DEMO') throw new Error('not a Source demo (no HL2DEMO header)');
    const header = { demoProtocol: dv.getInt32(8, true), protocol: dv.getInt32(12, true), server: text(16, 260), nick: text(276, 260),
      map: text(536, 260), game: text(796, 260), seconds: dv.getFloat32(1056, true), ticks: dv.getInt32(1060, true), frames: dv.getInt32(1064, true) };
    const out = { header, intervalPerTick: header.ticks > 0 ? header.seconds / header.ticks : .015, codecs: [], voice: [], errors: 0 };
    let at = 1072;
    const u32 = () => { const v = dv.getUint32(at, true); at += 4; return v; };
    while (at + 5 <= u8.length) {
      const cmd = u8[at], tick = dv.getInt32(at + 1, true);
      at += 5;
      if (cmd === 7) break;                                             // stop
      if (cmd === 1 || cmd === 2) {                                     // sign-on / packet
        at += 84;                                                       // flags, view angles, sequence numbers
        const length = u32(), end = Math.min(u8.length, at + length);
        const b = new Bits(u8, at * 8, end * 8);
        try {
          while (b.left >= 6) message(b.read(6), b, header.protocol, out, tick);
        } catch (error) { out.errors++; }
        at = end;
      } else if (cmd === 3) {                                           // sync tick
      } else if (cmd === 5 || cmd === 4 || cmd === 6 || cmd === 8) {    // user command, console command, data tables, string tables
        if (cmd === 5) at += 4;                                         // its sequence number
        const length = u32();
        at += length;
      }
      else throw new Error(`unknown demo frame ${cmd} at byte ${at - 5}`);
    }
    out.speakers = speakers(out);
    return out;
  }

  function crc32(d, n) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < n; i++) {
      crc ^= d[i];
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
  }

  // Legacy engine codecs send fixed-size packets back to back.
  const LEGACY = { vaudio_celt: { rate: 22050, frame: 512, bytes: 64 }, vaudio_celt_high: { rate: 44100, frame: 256, bytes: 120 } };

  // Per speaker, the packets in order. Steam payload: u64 SteamID, typed
  // sections, u32 CRC32 of everything before it; section 6 holds Opus frames
  // as u16 length, u16 sequence number, frame (length 0xFFFF: end of
  // transmission), section 0 a run of silence, section 11 the sample rate.
  function speakers(out) {
    const byId = new Map();
    const get = (id, client) => {
      if (!byId.has(id)) byId.set(id, { id, client, packets: [], frames: 0, dtx: 0, lost: 0, spurts: 0, bytes: 0, tocs: {}, nextSeq: null, rate: 24000 });
      return byId.get(id);
    };
    const legacy = LEGACY[(out.codecs[out.codecs.length - 1] || {}).codec];
    let unreadable = 0;
    for (const m of out.voice) {
      const d = m.data;
      if (d.length >= 12 && crc32(d, d.length - 4) === new DataView(d.buffer, d.byteOffset + d.length - 4, 4).getUint32(0, true)) {
        const view = new DataView(d.buffer, d.byteOffset, d.length);
        const id = view.getBigUint64(0, true).toString(), sp = get(id, m.client), end = d.length - 4;
        for (let i = 8; i + 3 <= end;) {
          const kind = d[i], value = view.getUint16(i + 1, true);
          i += 3;
          if (kind === 11) { sp.rate = value; continue; }
          if (kind === 0) { sp.packets.push({ tick: m.tick, kind: 'silence', samples: value }); continue; }
          if (kind !== 6) { unreadable++; break; }
          const stop = Math.min(i + value, end);
          for (let j = i; j + 2 <= stop;) {
            const len = view.getUint16(j, true);
            j += 2;
            if (len === 0xFFFF) { sp.packets.push({ tick: m.tick, kind: 'end' }); sp.nextSeq = null; continue; }
            if (j + 2 > stop) break;
            const seq = view.getUint16(j, true);
            j += 2;
            const frame = d.slice(j, Math.min(j + len, stop));
            j += len;
            if (sp.nextSeq === null) sp.spurts++;
            else if (seq > sp.nextSeq) sp.lost += seq - sp.nextSeq;
            sp.nextSeq = (seq + 1) & 0xFFFF;
            sp.frames++;
            sp.bytes += frame.length;
            if (frame.length <= 2) sp.dtx++;
            if (frame.length) sp.tocs[frame[0] >> 3] = (sp.tocs[frame[0] >> 3] || 0) + 1;
            sp.packets.push({ tick: m.tick, kind: 'opus', seq, data: frame });
          }
          i = stop;
        }
      } else if (legacy && d.length) {
        const sp = get(`client ${m.client}`, m.client);
        sp.codec = out.codecs[out.codecs.length - 1].codec;
        sp.rate = legacy.rate;
        for (let j = 0; j + legacy.bytes <= d.length; j += legacy.bytes) {
          sp.frames++;
          sp.bytes += legacy.bytes;
          sp.packets.push({ tick: m.tick, kind: 'celt', data: d.slice(j, j + legacy.bytes) });
        }
      } else if (d.length) unreadable++;
    }
    out.unreadable = unreadable;
    return [...byId.values()].map(({ nextSeq, ...s }) => ({ ...s, codec: s.codec || 'steam' }));
  }

  // One speaker's audio at the codec's rate. `codecs` supplies the decoders:
  // { opus: (rate) => decoder (vendor/libopus-1.1 createDecoder),
  //   celt: (rate, frame, bytes) => codec (vendor/celt-0.11 createCodec) }.
  // Also returns a frame log over the whole timeline in opus-codec.mjs's
  // FRAME codes (0 nothing sent, 1-3 SILK/hybrid/CELT, 4 DTX, 5 lost) and
  // each frame's size, for the codec lane and net_graph.
  async function decode(parsed, speaker, codecs) {
    const tickSeconds = parsed.intervalPerTick, rate = speaker.rate, steam = speaker.codec === 'steam';
    const spec = steam ? { frame: rate / 50 } : LEGACY[speaker.codec];
    const t0 = speaker.packets.length ? speaker.packets[0].tick : 0;
    const chunks = [], frames = [];
    let pos = 0, decoder = null, next = null, concealed = 0, lastTick = null, spurts = 0;
    const put = (samples, code, bytes) => { chunks.push([pos, samples]); frames.push([pos, code, bytes]); pos += samples.length; };
    const at = (tick) => Math.round((tick - t0) * tickSeconds * rate);
    // RFC 6716: the TOC's top 5 bits; configurations 0-11 are SILK, 12-15 hybrid, 16-31 CELT.
    const mode = (toc) => ((toc >> 3) < 12 ? 1 : (toc >> 3) < 16 ? 2 : 3);
    if (steam) {
      for (const p of speaker.packets) {
        if (p.kind === 'end') { if (decoder) decoder.free(); decoder = null; next = null; continue; }
        if (p.kind !== 'opus') continue;
        if (!decoder) { decoder = await codecs.opus(rate); pos = Math.max(pos, at(p.tick)); spurts++; }
        else if (next !== null && p.seq > next) for (let s = next; s < p.seq; s++, concealed++) put(decoder.decodePacketLossFloat(spec.frame), 5, 0);
        put(decoder.decodeFloat(p.data, { frameSize: spec.frame }), p.data.length <= 2 ? 4 : mode(p.data[0]), p.data.length);
        next = p.seq + 1;
      }
      if (decoder) decoder.free();
    } else {
      const codec = await codecs.celt(spec.rate, spec.frame, spec.bytes);
      for (const p of speaker.packets) {
        // A gap of more than four frames starts a new talk spurt at its tick.
        if (lastTick === null || at(p.tick) > pos + spec.frame * 4) {
          if (lastTick !== null) codec.restart();
          pos = Math.max(pos, at(p.tick));
          spurts++;
        }
        lastTick = p.tick;
        put(codec.decode(p.data), 3, p.data.length);
      }
      codec.free();
    }
    const samples = new Float32Array(pos);
    for (const [start, s] of chunks) samples.set(s.subarray(0, Math.min(s.length, pos - start)), start);
    const count = Math.ceil(pos / spec.frame), frameLog = new Uint8Array(count), frameBytes = new Uint16Array(count);
    for (const [start, code, bytes] of frames) {
      const f = Math.min(count - 1, Math.round(start / spec.frame));
      frameLog[f] = code;
      frameBytes[f] = bytes;
    }
    return { samples, rate, frameSeconds: spec.frame / rate, frameSamples: spec.frame, frameLog, frameBytes, concealed, spurts };
  }

  const TF2Demo = { parse, decode, crc32, Bits };
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Demo;
  else root.TF2Demo = TF2Demo;
})(typeof self !== 'undefined' ? self : this);
