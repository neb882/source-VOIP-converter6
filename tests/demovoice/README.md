# SourceTV voice packets

A SourceTV demo stores every voice message exactly as the server received it: Steam's own Opus packets, sequence numbers and end-of-transmission markers. Decoding them gives the sender's output with no game audio, mixer or receiver auto-gain. This is how the sender model (voice gate, DTX, encoder settings) in [REFERENCE_2026.md](../REFERENCE_2026.md) was measured.

Client demos made with `record` keep the voice messages but not their payloads, so use SourceTV.

## Recording

1. Run a dedicated server with SourceTV. SteamCMD app 232250 installs it; launch it with `+sv_cheats 1 +sv_alltalk 1 +tv_enable 1 +tv_delay 0 +map ctf_2fort`.
2. Join with the talking account (and, for a remote-listener take, a second account on another PC).
3. In the server console, run `tv_record voicetest`, play the test signal, then run `tv_stoprecord`. The demo is written to the server's `tf/` folder.

## Decoding

This needs Rust (cargo) and Node 22.

```sh
cargo run --release -- voicetest.dem voicetest.voice   # dump packets and print a summary per speaker
node decode.mjs voicetest.voice                         # voicetest.client<N>.wav + .tsv
```

The summary lists, for each speaker:
- frames and talk spurts
- DTX frames: 1-byte packets that the decoder answers with comfort noise
- sequence gaps, meaning frames lost before the server
- the bitrate while coding
- the Opus TOC configurations (13 = hybrid super-wideband, 20 ms)

The WAV places each talk spurt at its demo tick, at 24 kHz.

Demos, dumps and decoded audio contain players' SteamIDs and voices. Keep them out of the repository; `.gitignore` covers this folder's outputs.
