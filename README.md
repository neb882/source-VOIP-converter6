# TF2 Voice Emulator

Local TF2-inspired voice conversion. The default Steam-inspired profile uses a **real bundled Opus encoder and decoder**. Legacy CELT-style and narrowband profiles are explicitly approximate effects. Audio stays on your computer; no uploads or runtime CDN dependencies.

## Run or publish

Development requires Node 22+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For GitHub Pages, copy this project into your repository and enable Pages from the root of your publishing branch. No build is required. **Keep `.nojekyll`, `vendor/`, `opus-codec.mjs`, `audio-worker.js` and `mic-capture.js`** alongside the HTML, CSS, other scripts and icons. `node_modules/` is not needed on the website.

Use HTTPS or localhost. Opening `index.html` as a local file does not reliably support codec modules or microphone capture. After the app and its service worker load, conversion works offline. Background cache updates do not automatically reload the page or discard loaded audio; refresh when ready to use updated page code.

Choose a file or record, select a preset, process, and download the mono 16-bit PCM WAV. Microphone capture uses uncompressed PCM, avoiding an extra lossy codec pass. Limits: 100 MB / 10 minutes for files, 5 minutes for recording. Uploaded format support depends on the browser.

## Processing and controls

1. Average channels to mono; apply microphone gain and modeled saturation.
2. Resample with a windowed-sinc filter.
3. Apply capture high-pass and low-pass filters **before encoding**.
4. Encode real Opus in 20 ms frames, group frames into simulated packets, drop packets with a seeded burst-loss model, and use the decoder's native packet-loss concealment. Sender encoding continues during loss.
5. Remove the delay reported by the encoder and trim end padding to preserve duration. Real Opus receives no synthetic hiss or additional transform quantization.
6. Optionally apply modeled RMS voice leveling to Steam profiles, then resample for playback; apply receiver gain, optional underwater/room effects and safety limiting.

`snd_bits` multiplies bitrate: 16 selects the profile's base bitrate; 8 selects half. It changes actual Opus packet sizes and decoded sound. `net_split` groups whole codec frames, rounding to a whole-frame count. `net_jitter` is an artistic crackle effect, not a full jitter-buffer simulation.

Quick presets reset bitrate, codec processing, modeled gain, grouping and jitter. Advanced controls can disable voice leveling to preserve dynamics. It operates after decoding and before user playback gain; the volume control and mute remain effective. The detector uses a 30 ms RMS envelope, 10 ms gain reduction and 50 ms recovery, with bounded gain and protection against boosting tiny codec silence residue. This is an empirical model, not Valve's recovered algorithm. Source-style console names are this app's controls, not exact copies of every game cvar.

The status line identifies real Opus, an approximate effect, or codec bypass. Failed codec loading reports an error instead of silently changing the sound. `snd_real_opus 0` explicitly selects the approximate transform for Steam profiles; shared configurations retain this choice.

## Profiles and accuracy

| Profile | Processing | Status |
| --- | --- | --- |
| Modern / `steam` | Real Opus, 24 kHz mono, 32 kbps, 20 ms | Steam-inspired historical baseline |
| `steam_48` | Real Opus, 48 kHz mono, 64 kbps, 20 ms | Experimental; not a verified TF2-era preset |
| `celt_22` | 22.05 kHz STFT/PVQ effect | Approximate, not original CELT |
| `celt_44` | 44.1 kHz STFT/PVQ effect | Approximate, not original CELT |
| `speex` | 8 kHz narrowband transform effect | Not real Speex/CELP |

Modern follows the 24 kHz / 32 kbps observations in [this 2021 Steam voice investigation](https://zhenyangli.me/posts/reversing-steam-voice-codec/), not a claim about every game version. Runtime: **libopus 1.6.1 via libopus-wasm 0.4.0**, newer than the supplied 2024 reference. Settings: VOIP application, automatic signal selection, constant bitrate, complexity 10, no DTX or in-band FEC. These are reproducible choices, not all verified Valve settings.

The Modern and Laggy presets now use unity input gain and a gentler 40 Hz high-pass filter. These and RMS voice leveling improve measured bass balance and level variation against the supplied 2026 loopback/music pairs. The 11 kHz low-pass and codec configuration are unchanged. See [the reproducible comparison notes](tests/REFERENCE_2026.md).

Capture gain, EQ, voice leveling and room processing remain models. Room values come from [Valve's preset data mirrored by Facepunch](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/scripts/dsp_presets.txt); copied parameters do not reproduce the engine's processor implementations. Legacy transform budgets are estimates, not real encoded bitstreams. Exact historical matching still requires matching codec versions, capture processing and engine validation.

The same decoded PCM, settings and pinned runtime produce repeatable conversion. Compressed-file decoding and microphone hardware can vary between browsers/devices.

## Reference recordings

The owner attributes `real tf2 VOIP recording 2024.mp3` to [this TF2 video](https://www.youtube.com/watch?v=nqXpT5uNdT8). The supplied clip is approximately 59.98 seconds, stereo, 44.1 kHz, with game audio mixed in. That rate describes the MP3, not the voice codec. The audio is not distributed with this project.

```sh
pnpm analyze:reference "path/to/recording.mp3" "https://www.youtube.com/watch?v=nqXpT5uNdT8"
```

The analyzer reports mixed levels and centered listening candidates using averaged spectral power. Centered game sounds survive its mid/side gate, and energy rolloff does not identify a voice filter cutoff. It makes **no automatic codec, bitrate or filter recommendations**. Re-encoding this already-compressed mix is not a fidelity comparison.

The owner also supplied `tf2 VOIP test 2026 pure.mp3`: approximately 170.76 seconds, 48 kHz stereo, effectively mono. They recorded it using `voice_loopback 1` in a private server, playing two supplied music MP3s through a virtual audio cable, with default game settings and unchanged volume. Those exact source files make a paired comparison possible. None of the recordings or music files is distributed here.

```sh
pnpm compare:reference "path/to/loopback.mp3" "path/to/source-one.mp3" "path/to/source-two.mp3"
```

The paired tool finds repeated timeline-consistent matches, estimates timing drift, corrects fractional timing with a band-limited filter, and compares aligned spectra and short-time levels. It checks both stereo-average and left-channel input because the cable's channel routing is unverified. Spectral gain is normalized at 300–3000 Hz to separate volume from tonal balance; this is not perceptual loudness matching. It retains the former preset as a reproducible baseline and also reports second-half consistency checks, **not an independent holdout validation**. The automated alignment tests do not need the private audio.

Paired music checks have now been performed, but this is not proof of an exact TF2 codec match. Loopback does not validate a real network's packet-loss behavior, MP3 capture adds another lossy stage, and capture/channel settings are not fully known. For further validation, record paired **lossless speech** before and after TF2, with unrelated game sounds muted, and record TF2/Steam versions, codec, capture settings, gain and room state. Compare level-matched speech, sibilants, quiet passages, clipping and loss.

## Tests

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:all
```

Tests cover boundary pulse timing, partial frames, actual bitrates/packet sizes, packet parsing, native concealment, duration, silence, mute, determinism, pre-encoder filtering, bounded RMS leveling, all room presets 0–29, loss statistics, resampling and WAV structure. Paired-reference tests cover delay, polarity, gain, clock drift, repeated-phrase rejection, fractional-delay frequency preservation and silent-input rejection. Chromium checks cover sample content, worker parity, cancellation, PCM recording, offline conversion, configuration safety and accessibility. Automated microphone tests use synthetic input, not a physical device.

Browser verification also covers all four combinations of 44.1/48 kHz input files and 44.1/48 kHz decoding contexts. WAV rate and frame count must match the decoded input; duration, PCM headers and tone pitch are checked independently. This avoids assuming that every computer's default audio rate is 48 kHz.

Offline checks explicitly wait for an activated worker to control the page, exercise a real worker replacement with audio loaded, and verify that the source survives without a forced reload. A worker-activation timeout fails the test rather than being ignored.

These tests establish implementation behavior, not perceptual equivalence to TF2. CI runs Node 22 and Chromium.

`pnpm vendor:opus` copies the pinned runtime and notices verbatim; `pnpm test:vendor` checks the vendored files against the installed dependency. The runtime and licenses are required distribution files.

## Files and licensing

`audio.js` orchestrates DSP; `opus-codec.mjs` handles packets and delay; `audio-worker.js` keeps processing cancellable; `mic-capture.js` records PCM. `constants.js` contains presets and `script.js` the interface. Tests and local tooling are under `tests/`.

Application code: MIT. Codec notices: `vendor/libopus/LICENSE`, `COPYING.opus` and `THIRD_PARTY_NOTICES.md`. TF2, Source and Steam are Valve trademarks. This independent tool is not affiliated with Valve.
