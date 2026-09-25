# TF2 Voice Emulator

Make any audio sound like it came through Team Fortress 2 voice chat. The default profile runs **real Opus** (bundled libopus). It then applies the **receiver auto-gain and int16 clipping** identified in a paired TF2 recording. Audio stays on your computer; there are no uploads and no runtime CDN dependencies.

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

1. **Sender:** stereo is averaged to mono. Optional mic gain is applied, then int16 capture clipping. The audio is resampled to the codec rate, with optional high-/low-pass filters (off by default).
2. **Codec:** real libopus encodes 20 ms frames. `net_split` groups whole frames into packets, and a seeded burst model drops packets. The decoder's native concealment fills the gaps. Encoding continues through loss, and the encoder's reported delay is removed.
3. **Receiver:** the profile EQ runs, then the audio moves to the engine voice rate (44.1 kHz for Steam). Next comes the **auto-gain**: per 128-sample block, the next gain brings mean |x| to `voice_avggain` (0.5) of full scale, capped at `voice_maxgain` (16) and scaled by `voice_scale`. The gain ramps linearly across the following block, and every sample is clamped to int16. On music this keeps levels locked and flattens about 13% of samples, which is the dominant "TF2 voice" character.
4. **Mixer:** the 44.1 kHz mix applies the optional listener room (`dsp_room`) and underwater low-pass, then a small output roll-off and the output volume. It resamples to the file's rate (at least 44.1 kHz).

The quick presets reset every control. The live chain strip under the controls shows what the next render will do.

## Profiles

| Profile | Codec | Receiver | Status |
| --- | --- | --- | --- |
| Modern / `steam` | Opus 24 kHz, 32 kbps, VOIP, voice hint (SILK/CELT hybrid) | auto-gain at 44.1 kHz | **Measured** against a 2026 TF2 loopback |
| `steam_48` | Opus 48 kHz, 64 kbps | auto-gain at 44.1 kHz | Experimental |
| `celt_22` | Opus CELT layer, 24 kHz, 22 kbps (stand-in for vaudio_celt) | auto-gain at 22.05 kHz, linear-interpolation mixer | Modeled |
| `celt_44` | Opus CELT layer, 48 kHz, 44 kbps | auto-gain at 44.1 kHz | Modeled |
| `speex` | Opus SILK, 8 kHz, 8 kbps (stand-in for vaudio_speex) | auto-gain at 11.025 kHz, linear-interpolation mixer | Modeled |

Every profile runs the pinned **libopus 1.6.1 via libopus-wasm 0.4.0**; nothing is a hand-made approximation. The status line and console report the Opus modes the encoder actually chose (SILK / hybrid / CELT, from each packet's TOC byte). The legacy profiles are stand-ins built on the modern codec: CELT 0.x and Speex bitstreams are not reproduced.

## Accuracy

The Steam profile and receiver path were identified from the supplied pair: `tf2 VOIP test 2026 pure.mp3` and the two source songs played into TF2 with `voice_loopback 1`. Rendered through the app and compared with the recording, the model matches within about ±1 dB across 40 Hz–19 kHz. Half-second levels track within 0.4–0.55 dB RMS, and the clip ceiling statistics agree (13% of samples at the ceiling, mean at half of it). Evidence, method, residuals and open questions are in [tests/REFERENCE_2026.md](tests/REFERENCE_2026.md).

What that does **not** establish:
- Valve's source code for the gain stage. The engine's voice code is not in the public Source SDK 2013; the law is fitted to the recording.
- The exact Steam libopus version. A −2.5 dB high-band trim stands in for it.
- The absolute playback level. That depends on game and OS volume; the rendered file uses `volume 0.5`.
- Behavior under real network loss.

Room presets use parameters from [Valve's preset data mirrored by Facepunch](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/scripts/dsp_presets.txt). The processors are this app's implementations, and the reference recording was dry, so rooms remain an effect. The same decoded PCM, settings and pinned runtime always produce the same output.

## Controls and console

Advanced controls are grouped in signal order: **Sender** (mic gain, filters), **Codec & network** (codec on/off, `snd_bits` bitrate scale, `net_split`, `net_fakeloss`), **Receiver** (`voice_agc`, `voice_avggain`, `voice_maxgain`, `voice_scale`) and **Listener room & output** (`dsp_room`, custom room, `volume`). Every control has a console name. `voice_scale` acts inside the auto-gain, so raising it adds clipping rather than just volume. `net_jitter` (console only) is an artistic crackle, not a jitter-buffer simulation.

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

The paired tool locates each source in a recording, corrects clock drift and fractional delay with band-limited filters, and renders the aligned excerpt through the app. It then reports level-matched spectra up to 19 kHz, the clip signature, and half-second level tracking, for the full model and for a variant with the receiver auto-gain off:

```sh
pnpm compare:reference "path/to/loopback.mp3" "path/to/source-one.mp3" "path/to/source-two.mp3"
```

None of the recordings or music files is distributed here. For further validation, record paired **lossless speech** before and after TF2 with game sounds muted, and note the TF2/Steam versions and volume settings.

## Tests

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:all
```

- **`tests/verify.js`:** resampler passband/stopband/alignment, the profile FIR, and the auto-gain law (target, cap, int16 clamp, silence hold, `voice_scale`, block ramps). Also the measured clipping signature on dense input, real codec modes per profile, all room presets 0–29, burst-loss statistics and PLC, option robustness and WAV structure.
- **`tests/opus.verify.mjs`:** frame timing and boundary pulses, exact lengths, bitrates and packet sizes, TOC mode reporting, native concealment, silence, mute, determinism, leveling and cap behavior, output-volume linearity, pre-encoder filtering, and codec-failure reporting.
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
