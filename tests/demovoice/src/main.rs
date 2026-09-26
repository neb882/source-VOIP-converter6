//! Dump every Steam voice packet in a TF2 demo.
//!
//!     cargo run --release -- voicetest.dem voicetest.voice
//!
//! SourceTV demos keep each voice message as the server received it. Client
//! demos (`record`) keep the messages but not their payloads. The output file
//! is a flat list of little-endian records, read by decode.mjs:
//!
//!     u32 tick, u32 message index, u8 client, u8 kind, u16 value, u16 length, bytes
//!
//! kind 0 = voice message header (value = 0), 1 = Opus frame (value = sequence
//! number, bytes = the frame), 2 = silence (value = samples), 3 = end of
//! transmission (Steam's 0xFFFF marker; the decoder resets). A summary per
//! speaker goes to stderr.
use bitbuffer::{BitReadBuffer, BitReadStream, BitWriteStream, LittleEndian};
use std::collections::BTreeMap;
use std::{env, fs, process};
use tf_demo_parser::demo::data::DemoTick;
use tf_demo_parser::demo::message::Message;
use tf_demo_parser::demo::parser::MessageHandler;
use tf_demo_parser::{Demo, DemoParser, MessageType, ParserState};

#[derive(Default)]
struct Speaker { frames: u32, dtx: u32, lost: u32, spurts: u32, bytes: u64, next_seq: Option<u16>, tocs: BTreeMap<u8, u32> }

#[derive(Default)]
struct Voice { out: Vec<u8>, messages: u32, codecs: Vec<String>, speakers: BTreeMap<u64, Speaker>, bad: u32 }

fn record(out: &mut Vec<u8>, tick: u32, msg: u32, client: u8, kind: u8, value: u16, data: &[u8]) {
    out.extend_from_slice(&tick.to_le_bytes());
    out.extend_from_slice(&msg.to_le_bytes());
    out.push(client);
    out.push(kind);
    out.extend_from_slice(&value.to_le_bytes());
    out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    out.extend_from_slice(data);
}

fn u16le(d: &[u8], i: usize) -> u16 { u16::from_le_bytes([d[i], d[i + 1]]) }

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 { crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg()); }
    }
    !crc
}

impl Voice {
    // Steam voice payload: u64 SteamID, typed sections, u32 CRC32 of everything before it.
    fn steam_payload(&mut self, tick: u32, client: u8, d: &[u8]) {
        if d.len() < 12 || crc32(&d[..d.len() - 4]) != u32::from_le_bytes(d[d.len() - 4..].try_into().unwrap()) {
            self.bad += 1;
            return;
        }
        let steam_id = u64::from_le_bytes(d[..8].try_into().unwrap());
        let body = &d[8..d.len() - 4];
        let sp = self.speakers.entry(steam_id).or_default();
        let msg = self.messages;
        record(&mut self.out, tick, msg, client, 0, 0, &[]);
        let mut i = 0;
        while i + 3 <= body.len() {
            let (kind, value) = (body[i], u16le(body, i + 1));
            i += 3;
            match kind {
                11 => {}                                              // sample rate (24000)
                0 => record(&mut self.out, tick, msg, client, 2, value, &[]),
                6 => {                                                // Opus frames: u16 length, u16 sequence, frame
                    let end = (i + value as usize).min(body.len());
                    let mut j = i;
                    while j + 2 <= end {
                        let len = u16le(body, j);
                        j += 2;
                        if len == 0xFFFF {
                            record(&mut self.out, tick, msg, client, 3, 0, &[]);
                            sp.next_seq = None;
                            continue;
                        }
                        if j + 2 > end { break; }
                        let seq = u16le(body, j);
                        j += 2;
                        let frame = &body[j..(j + len as usize).min(end)];
                        j += len as usize;
                        match sp.next_seq {
                            None => sp.spurts += 1,
                            Some(n) if seq > n => sp.lost += (seq - n) as u32,
                            _ => {}
                        }
                        sp.next_seq = Some(seq.wrapping_add(1));
                        sp.frames += 1;
                        sp.bytes += frame.len() as u64;
                        if frame.len() <= 2 { sp.dtx += 1; }
                        if let Some(&toc) = frame.first() { *sp.tocs.entry(toc >> 3).or_default() += 1; }
                        record(&mut self.out, tick, msg, client, 1, seq, frame);
                    }
                    i = end;
                }
                _ => { self.bad += 1; return; }
            }
        }
    }
}

impl MessageHandler for Voice {
    type Output = Voice;
    fn does_handle(t: MessageType) -> bool { matches!(t, MessageType::VoiceInit | MessageType::VoiceData) }
    fn handle_message(&mut self, message: &Message, tick: DemoTick, _state: &ParserState) {
        match message {
            Message::VoiceInit(init) => self.codecs.push(format!("{:?}", init)),
            Message::VoiceData(m) => {
                self.messages += 1;
                // The parser keeps the fields private; re-encode the message and
                // read client (8 bits), proximity (8), length in bits (16), data.
                let mut raw = Vec::new();
                if BitWriteStream::new(&mut raw, LittleEndian).write(m).is_err() { self.bad += 1; return; }
                let mut r = BitReadStream::new(BitReadBuffer::new(&raw, LittleEndian));
                let client: u8 = r.read().unwrap_or(0);
                let _proximity: u8 = r.read().unwrap_or(0);
                let bits: u16 = r.read().unwrap_or(0);
                match r.read_bytes(bits as usize / 8) {
                    Ok(data) => self.steam_payload(u32::from(tick), client, &data),
                    Err(_) => self.bad += 1,
                }
            }
            _ => {}
        }
    }
    fn into_output(self, _state: &ParserState) -> Voice { self }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: demovoice <demo.dem> <out.voice>");
        process::exit(2);
    }
    let file = fs::read(&args[1]).unwrap_or_else(|e| { eprintln!("{}: {e}", args[1]); process::exit(1) });
    let demo = Demo::new(&file);
    let (header, v) = DemoParser::new_with_analyser(demo.get_stream(), Voice::default())
        .parse().unwrap_or_else(|e| { eprintln!("parse error: {e}"); process::exit(1) });
    fs::write(&args[2], &v.out).unwrap_or_else(|e| { eprintln!("{}: {e}", args[2]); process::exit(1) });
    eprintln!("{} on {}, {:.1} s, {} ticks; voice codec {}", header.server, header.map, header.duration, header.ticks, v.codecs.join(" / "));
    eprintln!("{} voice messages, {} unreadable", v.messages, v.bad);
    for (id, s) in &v.speakers {
        let coded = s.frames - s.dtx;
        eprintln!("  {id}: {} frames in {} talk spurts, {} DTX, {} lost (sequence gaps), {:.1} kbps while coding, TOC configs {:?}",
            s.frames, s.spurts, s.dtx, s.lost,
            if coded > 0 { (s.bytes - s.dtx as u64) as f64 * 8.0 * 50.0 / coded as f64 / 1000.0 } else { 0.0 }, s.tocs);
    }
    if v.messages > 0 && v.speakers.is_empty() {
        eprintln!("  no voice payloads: a client demo (`record`) keeps the messages but not the audio");
    }
}
