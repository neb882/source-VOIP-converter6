# Legacy voice codecs: what is known

Source's older engine codecs are `sv_voicecodec vaudio_celt`, `vaudio_celt_high` and `vaudio_speex`. The `celt_22` and `celt_44` profiles now run the real codec, CELT 0.11 ([`vendor/celt-0.11`](../vendor/celt-0.11/README.md)), at the settings below. The `speex` profile is still a stand-in: it runs Opus SILK. None of the three has been measured against a TF2 recording, and their receiver side (gate, auto-gain rate) is assumed. This file collects what public sources say about the real codecs.

Leaked engine source was deliberately not used. Valve's public Source SDK 2013 has no voice-codec code: the codecs live in the engine's `vaudio_*` libraries.

## Summary

| `sv_voicecodec` | Real codec (public evidence) | App profile | Evidence |
|---|---|---|---|
| `vaudio_celt` | **CELT 0.11** custom mode, mono. **22050 Hz**, **512-sample frames** (23.2 ms), **64-byte constant-size packets** = 22.05 kbps. Encoder complexity 10. | `celt_22`: CELT 0.11 with exactly these settings; decoded voice at 22.05 kHz | Strong: three independent decoders and two encoders agree |
| `vaudio_celt_high` | CELT 0.11, **44100 Hz**, **256-sample frames** (5.8 ms), **120-byte packets** = 165.4 kbps | `celt_44`: CELT 0.11 with these settings | Weak: one reimplementation. The "44 kbps" on Valve's wiki does not match it and may mean 44 kHz. |
| `vaudio_speex` | Speex, 8 kHz narrowband per one reimplementation. Source's quality setting is not public. | Opus SILK, 8 kHz, 8 kbps; decoded voice at 11.025 kHz | Weak. It currently fails to load in TF2 ([Source-1-Games#7551](https://github.com/ValveSoftware/source-1-games/issues/7551)), so it cannot be recorded today. |

## vaudio_celt

- **Decoders.** Three tools decode real CS:GO demo voice with a plain CELT 0.11 decoder: `celt_mode_create(22050, 512)`, `celt_decoder_create_custom(mode, 1)`, reading 64 bytes per frame.
  - [ericek111's gist](https://gist.github.com/ericek111/abe5829f6e52e4b25b3b97a0efd0b22b)
  - [FrozenFish259/csgo_demo_voicedata_decoder](https://github.com/FrozenFish259/csgo_demo_voicedata_decoder), which builds against [celt-0.11.0](https://github.com/mumble-voip/celt-0.11.0)
  - [saiko-tech/csgo-demo-voice-capture-example](https://github.com/saiko-tech/csgo-demo-voice-capture-example), which plays the result as 22050 Hz, 16-bit mono
- **Encoders.** Two SourceMod extensions that inject voice encode the same way: `celt_encoder_create_custom`, `CELT_SET_COMPLEXITY(10)`, `celt_encode(…, 512 samples, …, 64 bytes)`.
  - [arthurdead/voicesend](https://github.com/arthurdead/voicesend/blob/master/voicecodec_celt.cpp)
  - [Dolly132/sm-ext-voice](https://github.com/Dolly132/sm-ext-voice). It notes: "2009 Games with 22050 samplerate and 512 frames per packet -> 23.22ms per packet". TF2 was on the Source 2009 branch.
- **Rate control.** A fixed packet size of 64 bytes makes CELT constant-rate, whatever the `CELT_SET_BITRATE` ceiling (64 kbps in both encoders).

**In the app.** Until this release the profile ran Opus's CELT layer, which is not the same codec: Opus changed the bitstream and the psychoacoustics after 0.11. It now runs CELT 0.11 itself, built from the tree the CS:GO decoders use, with 512-sample frames and 64-byte packets. Loss and jitter act on 23.2 ms frames. The codec's delay (64 samples, its MDCT overlap) is trimmed, so renders keep the source timeline.

## vaudio_celt_high

- The only concrete source is [voicesend](https://github.com/arthurdead/voicesend/blob/master/voicecodec_celt.cpp): 44100 Hz, 256 samples, 120 bytes.
- That is 165 kbps with 5.8 ms frames, nearly transparent for voice.
- Community descriptions call it "44 kHz and 44 kbps"; 44 kbps would be 32 bytes per 256-sample frame. Only a take can settle it.

## vaudio_speex

- Speex is BSD-licensed ([xiph/speex](https://github.com/xiph/speex)).
- **Settings.** voicesend's table lists 8000 Hz for `vaudio_speex`. Source's Speex quality setting is not in any public source found. GoldSrc's `sv_voicequality` levels 1–5 were 2.4, 6.0, 8.0, 11.2 and 15.2 kbps, which are close to Speex narrowband qualities 1, 2, 3/4, 5/6 and 7/8.
- **Current TF2.** `vaudio_speex` fails to load: "Unable to load voice codec 'vaudio_speex'. Voice disabled." ([#7551](https://github.com/ValveSoftware/source-1-games/issues/7551), also [Portal 2 #226](https://github.com/ValveSoftware/portal2/issues/226)).

## Also unknown, for all three

- **Voice gate.** Whether modern TF2's capture still goes through Steam's voice gate (−39.5 dBFS, 120 ms pre-roll, 440 ms hold) when a legacy codec is selected. The stand-ins transmit continuously.
- **Receiver path.** Whether the receiver auto-gain runs at the codec's rate (22.05 or 11.025 kHz), as the stand-ins assume.
- **Does CELT work at all?** [Source-1-Games#5520](https://github.com/ValveSoftware/Source-1-Games/issues/5520) (February 2024, 64-bit test build) reports `vaudio_celt` garbled or silent. #7551 says CELT and CELT High work.

## Takes that would settle it

Record exactly as for the 2026 Steam takes ([testsignal/README.md](testsignal/README.md)), on a local server:

1. `sv_voicecodec vaudio_celt`, then load a map. The codec is picked at map load.
2. `voice_loopback 1`.
3. Play `tf2_voice_testsignal_v1.wav` into the mic path and record the output.
4. Repeat with `sv_voicecodec vaudio_celt_high`.

The test signal's segments answer the open questions:
- the gate segments show whether Steam's gate still applies
- the sweeps show band edges and frame sizes
- the level steps show the receiver gain

## Done without takes

CELT 0.11 is built to WebAssembly by [`tests/celt011/build.mjs`](celt011/build.mjs), the same way `tests/libopus11/` builds libopus 1.1.5, and both CELT profiles run it. `vaudio_celt_high` uses the one public source's 120-byte packets until a take confirms or corrects them. Speex can follow if its quality setting turns up.
