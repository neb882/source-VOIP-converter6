# TF2 Voice Emulator

Make any audio sound like it came through Team Fortress 2 voice chat. The default profile runs **real Opus** (bundled libopus). Around it the app applies:
- Steam's sender voice gate
- TF2's receiver auto-gain with int16 clipping

Both were identified from 2026 TF2 recordings of a calibrated test signal, speech and music, and from Steam's own voice packets in a SourceTV demo. Audio stays on your computer; there are no uploads and no runtime CDN dependencies.

## Run or publish

Development requires Node 22+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For GitHub Pages, enable Pages from the root of your publishing branch; no build is required. **Keep `.nojekyll`, `vendor/`, `opus-codec.mjs`, `audio-worker.js` and `mic-capture.js`** alongside the HTML, CSS, other scripts and icons. `node_modules/` is not needed on the website.

Use HTTPS or localhost. Opening `index.html` as a local file does not reliably support codec modules or microphone capture. After the app and its service worker load, conversion works offline. Background cache updates never reload the page or discard loaded audio; refresh when you are ready to use updated page code.

Choose a file or record, pick a preset, process, and download the mono 16-bit PCM WAV. Microphone capture uses uncompressed PCM, so the only lossy pass is the emulated codec. Limits: 100 MB / 10 minutes for files, 5 minutes for recording. Supported upload formats depend on the browser.

## The voice path

1. **Sender:** capture and filtering.
   - Stereo input is captured from its **left channel** (measured through a stereo virtual cable); a mix is optional.
   - Optional mic gain is applied, then int16 capture clipping. The audio is resampled to the codec rate, with optional high-/low-pass filters (off by default).
   - **Steam's voice gate** decides which 20 ms frames are sent. A frame above −39.5 dBFS RMS is sent together with the 120 ms before it (pre-roll) and the 440 ms after it (hold). Longer pauses become silence instead of boosted noise, and each talk spurt starts a fresh encoder and decoder.
2. **Codec and network:** real libopus encodes the sent frames with the settings that reproduce Steam's packets: VBR at a 34 kbps target (about 32 kbps on noise, 26 on speech) and complexity 6, with DTX. When Opus's voice detector calls a frame inactive, as it does in held pauses and on steady tones, the encoder sends a 1-byte DTX packet and the decoder plays comfort noise. `net_split` groups whole frames into packets. Both network effects were measured in TF2:
   - **Loss** (`net_fakeloss`, the share of voice frames lost) comes in bursts averaging 2.2 frames, and the decoder's own concealment fills them.
   - **Jitter** (`net_fakejitter`) makes isolated frames arrive too late. At 50 ms that's 3% of frames; nine in ten are concealed and one plays as silence.

   Encoding continues through loss, and the encoder's reported delay is removed.
3. **Receiver:** the profile EQ runs, then the audio moves to the engine voice rate (44.1 kHz for Steam). The EQ is the ±1 dB difference between Steam's encoder and libopus 1.6.1 plus Steam's capture roll-off above 11.2 kHz; the receiver itself adds none. Next comes the **auto-gain** on the int16 voice.
   - Each 128-sample block sets a target `min(voice_maxgain, 32767 / (mean + voice_avggain × (peak − mean)))`. The defaults are 0.5 and 10.
   - The next block steps toward it in truncated 1/128 fixed-point increments, scaled by `voice_scale`, and every sample is clamped to int16.
   - A steady tone ends up 1.22× over full scale (42% of samples flattened), and speech and music about 5–6 dB under it: the dominant "TF2 voice" character.
4. **Mixer:** the 44.1 kHz mix applies the optional listener room (`dsp_room`) and underwater low-pass, then a small output roll-off and the output volume. It resamples to the file's rate (at least 44.1 kHz).

The quick presets reset every control. The live chain strip under the controls shows what the next render will do.

## Profiles

| Profile | Codec | Receiver | Status |
| --- | --- | --- | --- |
| Modern / `steam` | Opus 24 kHz, VBR ~32 kbps with DTX, VOIP, voice hint (SILK/CELT hybrid) | auto-gain at 44.1 kHz | **Measured** against 2026 TF2 recordings and Steam's own packets |
| `steam_48` | Opus 48 kHz, 64 kbps, VBR with DTX | auto-gain at 44.1 kHz | Experimental |
| `celt_22` | Opus CELT layer, 24 kHz, 22 kbps (stand-in for vaudio_celt) | auto-gain at 22.05 kHz, linear-interpolation mixer | Modeled |
| `celt_44` | Opus CELT layer, 48 kHz, 44 kbps | auto-gain at 44.1 kHz | Modeled |
| `speex` | Opus SILK, 8 kHz, 8 kbps (stand-in for vaudio_speex) | auto-gain at 11.025 kHz, linear-interpolation mixer | Modeled |

Every profile runs the pinned **libopus 1.6.1 via libopus-wasm 0.4.0**; nothing is a hand-made approximation. The status line and console report the Opus modes the encoder actually chose (SILK / hybrid / CELT, from each packet's TOC byte). The legacy profiles are stand-ins built on the modern codec: CELT 0.x and Speex bitstreams are not reproduced.

## Accuracy

The Steam profile, voice gate and receiver path come from 2026 recordings made with `voice_loopback 1`. The main set is a calibrated 143 s test signal recorded losslessly at default settings and with `voice_scale 0.5`, `voice_maxgain 1` and `voice_avggain 0.25`. The owner's speech and an earlier music recording validate it.

A SourceTV demo of the same test signal holds Steam's own voice packets. Decoding them gave the sender side exactly: its gate timing, DTX and encoder settings. With those packets as input, the receiver model matches the game's output within 0.1 dB per band up to 11.5 kHz, for both the sender's loopback and a second account on another PC.

Rendered through the app with each take's settings:
- **Test signal:** levels and clipped-sample shares match to within about 0.3 dB and 1–2%. That holds for sines, noise and a synthetic vowel across all three receiver settings.
- **Sender:** 16 of 18 talk spurts start and end within 4 frames of Steam's, and 98.7% of 20 ms frames agree on sent or not sent. Steady tones fall into DTX at the same moment as in Steam's packets (0.40 s against 0.42 s for a −36 dBFS sine).
- **Speech:** tracks within ±0.38 dB in 50 ms windows (correlation 0.997), with the spectrum within 0.3 dB.
- **Music:** tracks within 0.09–0.10 dB in half-second windows, and the spectrum agrees within ±0.5 dB from 80 Hz to 12 kHz.
- **Packet loss and jitter:** a one-minute network test signal was recorded under simulated loss and jitter. The app reproduces the loss-event rate, burst sizes and lost-frame share of every take (for example 4.4 against 4.3 events per second, and 16% against 17% of frames).

Evidence, method, residuals and open questions are in [tests/REFERENCE_2026.md](tests/REFERENCE_2026.md).

What that does **not** establish:
- Valve's source code for the gain stage or Steam's gate. Neither is in the public Source SDK 2013; both are identified from recordings.
- The receiver's per-talk-spurt delay changes and latency trimming. Neither is modeled; renders keep the source timeline.
- The exact Steam libopus build. libopus 1.6.1 at complexity 6 reproduces its DTX decisions, and an EQ fitted to its packets covers the remaining ±1 dB. Pure tones at 11.5–12 kHz still differ.
- The absolute playback level. That depends on game and OS volume; the rendered file uses `volume 0.5`, where the recordings used 0.15.
- Real internet loss. The network model comes from simulated loss and jitter in TF2 (`net_fakeloss`, `net_fakejitter` on a listen server), and the receiver's per-spurt re-timing is not modeled.

Room presets use parameters from [Valve's preset data mirrored by Facepunch](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/scripts/dsp_presets.txt). The processors are this app's implementations, and the reference recording was dry, so rooms remain an effect. The same decoded PCM, settings and pinned runtime always produce the same output.

## Controls and console

Advanced controls are grouped in signal order. Every control has a console name.

| Group | Controls |
| --- | --- |
| **Sender** | `voice_capture_channel`, mic gain, filters, `voice_vad` and `voice_vad_threshold` |
| **Codec & network** | codec on/off, `snd_bits` bitrate scale, `net_split`, `net_fakeloss`, `net_fakejitter` |
| **Receiver** | `voice_agc`, `voice_avggain`, `voice_maxgain`, `voice_scale` |
| **Listener room & output** | `dsp_room`, custom room, `volume` |

Some controls behave differently from their names:
- `voice_scale` acts inside the fixed-point auto-gain, as in the game. Values below 1 do not simply scale the result: 0.5 lowers voice by 8–11 dB and adds a 344 Hz sawtooth.
- `net_fakeloss` is the share of voice frames lost, not TF2's own setting. On a listen server, TF2's `net_fakeloss 5`, `10` and `15` lost about 22%, 45% and 64% of voice frames.

The developer console supports Source-style `;` chaining, `alias`, `toggle`, `find`, history, and Tab completion. Tab completes to the longest common prefix, then lists matching commands with their current values. `writeconfig` copies a share URL; `preset_save/load/list/delete` manage local presets. `net_graph 1–4` overlays a Source-style HUD whose packet rate, payload rate and loss come from the last render. The background game-event feed (kills, chat, joins and drops) can be stopped with `sv_simulate_events 0`.

The visualizer has three views:
- **WAVE:** peak and RMS envelope.
- **BARS:** a log-frequency spectrum in dBFS; live while playing, computed at the playhead when paused.
- **SPEC:** a whole-file linear-frequency spectrogram, where the 12 kHz Opus edge and the post-clip shelf are visible.

All three follow the A/B toggle.

## Reference recordings

The owner attributes `real tf2 VOIP recording 2024.mp3` to [this TF2 video](https://www.youtube.com/watch?v=nqXpT5uNdT8). It is mixed with game audio, so it can only be screened:

```sh
pnpm analyze:reference "path/to/recording.mp3" "https://www.youtube.com/watch?v=nqXpT5uNdT8"
```

The paired tool locates each source in a recording, corrects clock drift and fractional delay with band-limited filters, and renders the aligned excerpt through the app. It then reports level-matched spectra up to 19 kHz, the clip signature, and half-second level tracking. Each source channel (mix, left, right) is rendered with the full model, with the voice gate off, and with the receiver auto-gain off:

```sh
pnpm compare:reference "path/to/loopback.mp3" "path/to/source-one.mp3" "path/to/source-two.mp3"
```

None of the recordings or music files is distributed here. The synthetic test signals are: [tests/testsignal/](tests/testsignal/) rebuilds them bit for bit (numpy and scipy), with segment maps and recording steps. `make_testsignal.py` covers the receiver, and `make_nettest.py` is a one-minute signal for packet-loss and jitter takes.

[tests/demovoice/](tests/demovoice/) extracts Steam's voice packets from a SourceTV demo (Rust) and decodes them with the bundled libopus. The output is the exact sender side of a take, with frame sizes, DTX and sequence gaps.

## Tests

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:all
```

- **`tests/verify.js`:** resampler passband/stopband/alignment, the profile FIR, and the auto-gain law. The law checks cover the measured sine overdrive at `voice_avggain` 0.5 and 0.25, the cap, the int16 clamp, silence hold, step timing and the `voice_scale` sawtooth and truncation. Also the voice gate (threshold, pre-roll, hold, talk spurts, DTX comfort noise on steady tones, send/skip accounting), stereo capture, real codec modes per profile, all room presets 0–29, the measured loss bursts and late-frame jitter with PLC, option robustness and WAV structure.
- **`tests/opus.verify.mjs`:** frame timing and boundary pulses, exact lengths, bitrates and packet sizes, TOC mode reporting, native concealment, silence, mute, determinism, the sender gate inside the round trip (pre-roll, hold, talk spurts), opt-in DTX, leveling and cap behavior, output-volume linearity, pre-encoder filtering, and codec-failure reporting.
- **`tests/reference.verify.mjs`:** alignment, clock drift, polarity, fractional delay, clip-signature and level-tracking metrics.
- **Chromium checks:** worker parity, cancellation, PCM recording, offline conversion, every visualizer mode, the chain strip, presets, console completion, `net_graph`, accessibility, mobile layout, and the 44.1/48 kHz file × decode-rate matrix. Set `CHROMIUM_EXECUTABLE` to use a preinstalled browser whose build differs from Playwright's pin.

These tests establish implementation behavior; the accuracy claims rest on the paired comparison above. CI runs Node 22 and Chromium.

`pnpm vendor:opus` copies the pinned runtime and notices verbatim; `pnpm test:vendor` checks the vendored files against the installed dependency. The runtime and licenses are required distribution files.

## Files and licensing

| File | Role |
| --- | --- |
| `audio.js` | DSP and orchestration |
| `opus-codec.mjs` | packets, modes and delay |
| `audio-worker.js` | cancellable background processing |
| `mic-capture.js` | PCM recording |
| `constants.js` | presets, codec profiles, receiver model, room data |
| `script.js` | interface, visualizer and console |

Tests and local tooling are under `tests/`.

Application code: MIT. Codec notices: `vendor/libopus/LICENSE`, `COPYING.opus` and `THIRD_PARTY_NOTICES.md`. TF2, Source and Steam are Valve trademarks. This independent tool is not affiliated with Valve.
