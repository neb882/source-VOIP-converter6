# TF2 Voice Emulator

A browser-based emulation of the Source engine / Team Fortress 2 voice-chat pipeline. Drop in any audio file and it comes out the other end sounding like it was screamed through a clipped mic, crushed by `vaudio_celt`, sent over a lossy connection, and played back to a listener standing in a 2fort sewer.

Everything runs locally in the browser — no uploads, no server, no Web Audio dependency in the processing path.

## Quick start

Serve the folder over HTTP, pick an audio file — or hit **🎤 Mic** and record yourself — then **Process Audio**. Use the quick presets (`Modern`, `Legacy CELT`, `Mic Spam`, `2fort Sewers`, `Laggy`) or open **Advanced controls** to tune individual settings. The A/B button switches instantly between processed and original audio, BARS/SPEC switches the visualizer, and the collapsible developer console accepts Source-style cvars (`help` lists them, commands chain with `;`, `alias` works).

```sh
pnpm install
pnpm dev
```

Opening `index.html` directly still works through a compatibility path, but serving it enables the processing worker, microphone permissions, installability, and offline support. Inputs are limited to 100 MB and 10 minutes to keep browser memory predictable; microphone recordings stop automatically at 5 minutes.

Served over http(s) the page is an installable, offline-capable PWA. For the `steam` codec the pipeline uses the browser's **real Opus encoder** (WebCodecs) when available, falling back to the built-in emulation elsewhere (`snd_real_opus 0` forces the emulation).

## How the pipeline works

The chain in `audio.js` mirrors the real engine path:

1. **Capture** — downmix to mono, mic gain, then a hard clip at full scale (the classic Windows "+20 dB mic boost" distortion).
2. **Encode** — anti-aliased resample to the codec rate, sender AGC (Steam voice only), 0.85 pre-emphasis like CELT/Opus, then the sender band-limit filters.
3. **Codec** — a transform-codec emulation with real CELT mechanics: per 512-sample frame, Bark-band energies are coarse (6 dB) + fine quantized with inter-frame prediction, band shapes are PVQ pulse-quantized under the true bit budget (`vaudio_celt`: 64 bytes/frame at 22050 Hz = exactly 22.05 kbps), and bit-starved bands are reconstructed by spectral folding — the actual source of CELT's low-bitrate warble and birdies.
4. **Network** — frames are grouped into packets (`net_split` ms each) and dropped by a bursty Gilbert–Elliott loss model; the decoder conceals losses by repeating the last good spectrum with decay, like real CELT PLC.
5. **Decode** — codec noise floor, matched de-emphasis, anti-imaged upsample to the playback rate.
6. **Listener** — `voice_scale` gain, an underwater low-pass when submerged, then the `dsp_room` processor chain: DFR allpass diffusors, RVA parallel feedback combs (low-passed, optionally modulated), DLY echoes, AMP tremolo, and MDY modulated delays, with parameters transcribed verbatim from Valve's `dsp_presets.txt` for rooms 0–29.

Renders are deterministic: the same input and settings always produce the identical output (the loss pattern is seeded).
When served over HTTP(S), this pipeline runs in a dedicated worker so long renders do not monopolize the interface and can be cancelled immediately.

## Codec profiles

| `sv_voicecodec` | Rate | Frame | Bitrate | Notes |
| --- | --- | --- | --- | --- |
| `celt_22` | 22 050 Hz | 512 samples (23.2 ms) | 22.05 kbps | vaudio_celt, the classic TF2 sound |
| `celt_44` | 44 100 Hz | 512 samples (11.6 ms) | 44.1 kbps | vaudio_celt_high |
| `steam` | 24 000 Hz | ~21 ms | ~32 kbps | Steam voice (Opus era), with sender AGC |
| `steam_48` | 48 000 Hz | ~21 ms | ~64 kbps | native-rate Steam voice (2021+); fullband codec, capture filtering modeled separately |
| `speex` | 8 000 Hz | 32 ms | ~8 kbps | legacy narrowband |

`snd_bits` scales the per-frame byte budget (16 = stock rate; lower values starve the codec and get progressively more warbly).

## Sharing and saving

`writeconfig` copies a URL that encodes every setting in the hash — opening it restores the exact configuration. `preset_save <name>` / `preset_load <name>` / `preset_list` / `preset_delete <name>` manage named presets in localStorage, and console command history persists across sessions. `net_jitter <0-50>` adds late-packet crackle (buffer-starvation pops) on top of the burst-loss model.

## Hosting

Everything is static: push to GitHub, enable **Settings → Pages → Deploy from branch**, and it's live. The included service worker (`sw.js`) makes it work offline and installable on phones. A GitHub Action (`.github/workflows/test.yml`) runs the verification suite on every push.

## Files

`audio.js` is the pure-DSP core (FFT, resampler, transform codec, Source DSP processors). `audio-worker.js` runs that same core off the main thread. `constants.js` holds the codec profiles and Valve DSP preset data. `script.js` is the UI glue: validated config, console, cvars, visualizer, and net graph. `tests/verify.js` covers the DSP core; `tests/browser.verify.js` covers the complete browser/PWA flow.

## Tests

Run the fast DSP suite under plain Node:

```
pnpm test
```

Run the full DSP and Chromium integration suite with:

```
pnpm exec playwright install chromium
pnpm test:all
```

The tests check level sanity through every stage, codec bitrate behaviour, bass retention, every room preset, burst-loss statistics, PLC, AGC, band-limiting, determinism, malformed options, resampling, and WAV integrity. Browser checks cover malformed share links and storage, accessible labeling, safe console rendering, worker processing and cancellation, responsive layout, cache isolation, and offline startup.

For a local mixed-gameplay reference recording, run:

```
pnpm analyze:reference "path/to/recording.mp3"
```

The report identifies centered speech-like time windows, dynamics, stereo separation, spectral rolloff, and a conservative Modern-preset low-pass suggestion. Reference audio remains local and is never copied into the project.

## Browser support

Current Chromium, Firefox, and Safari releases support the emulated codec path. Real Opus requires the browser WebCodecs audio encoder/decoder; the app reports when it falls back to the deterministic transform emulation. Microphone capture and PWA installation require a secure context (`https://` or localhost).

## Accuracy notes and sources

Codec framing and rates: [Reversing Steam Voice Codec](https://zhenyangli.me/posts/reversing-steam-voice-codec/) and the [voicesend CELT config](https://github.com/arthurdead/voicesend/blob/master/voicecodec_celt.cpp) (22 050 Hz / 512 samples / 64 bytes). DSP room parameters: [Valve's dsp_presets.txt](https://raw.githubusercontent.com/Facepunch/garrysmod/master/garrysmod/scripts/dsp_presets.txt) via the Facepunch mirror.

The supplied mixed 2024 reference supports a centered voice bandwidth reaching roughly 10–11 kHz in its strongest high-band windows, with most speech energy below 5 kHz. Accordingly, the Modern preset uses a 12 kHz sender low-pass while retaining the engine-era 48 kHz Opus profile. Because game audio is baked into that recording, it is treated as a calibration guide rather than a bit-exact ground truth.

The codec stage reproduces CELT's artifact mechanics (band energy quantization, PVQ, folding) on an STFT rather than an MDCT, so it is not bit-exact with the real encoder — compiling libopus/CELT to WASM would close that last gap.

## License

MIT. TF2, Source, Steam, and Team Fortress are trademarks of Valve Corporation; this independent emulator is not affiliated with Valve.
