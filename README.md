# TF2 Voice Emulator

Make any audio sound like it came through Team Fortress 2 voice chat. The default profile runs **real Opus**: libopus 1.1.5, the release Steam's own voice packets match, bundled as WebAssembly. Around it the app applies:
- Steam's sender voice gate
- TF2's receiver auto-gain with int16 clipping

Both were identified from 2026 TF2 recordings of a calibrated test signal, speech and music, and from Steam's own voice packets in a SourceTV demo. The older engine codec `vaudio_celt` runs the real CELT 0.11. Video files work too: their audio is the source, and the render can go back into the video without re-encoding the picture. Audio stays on your computer; there are no uploads and no runtime CDN dependencies.

## Run or publish

Development requires Node 22+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For GitHub Pages, enable Pages from the root of your publishing branch; no build is required. **Keep `.nojekyll`, `vendor/` (all four codec folders), `opus-codec.mjs`, `audio-worker.js`, `mic-capture.js`, `live-worker.js` and `live-worklet.js`** alongside the HTML, CSS, other scripts and icons. `node_modules/` is not needed on the website.

Use HTTPS or localhost. Opening `index.html` as a local file does not reliably support codec modules or microphone capture. After the app and its service worker load, conversion works offline. Background cache updates never reload the page or discard loaded audio; refresh when you are ready to use updated page code.

Choose an audio or video file (or drop one on the page) or record, pick a preset, process, and download. Microphone capture uses uncompressed PCM, so the only lossy pass is the emulated codec. Limits: 100 MB (1 GB for video) and 10 minutes per file, 5 minutes for recording. Supported upload formats depend on the browser.

## Downloads and batches

Renders are mono 16-bit. The format picker next to Download sets the format for single files and batches:

| Format | Size (typical render) | Notes |
| --- | --- | --- |
| **WAV** | 100% | the render itself |
| **FLAC** | about 45% | lossless: decodes to exactly the WAV's samples |
| **MP3** | about 15–20% | LAME 3.100 at `-V 0`, LAME's highest VBR quality. Level and waveform are kept (gain within 0.1%). The LAME tag carries the encoder delay, so players return exactly the render's length. |

FLAC and MP3 are made from the WAV when a file is saved. MP3 is lossy on top of the emulated codec. It is meant for sharing; keep WAV or FLAC for further processing.

**Video.** A video file's audio track becomes the source. For an MP4 or MOV, **Download video** then saves the video with the render as its audio:
- **Picture:** every video sample is copied as is, with its timing; it is never re-encoded. Other non-audio tracks (such as a timecode) are kept.
- **Audio:** AAC where the browser has an AAC encoder (WebCodecs). Otherwise Opus in MP4, or 16-bit PCM in MOV, which editors and DAWs import directly. It starts where the old audio did, and the encoder's delay is skipped by an edit list.
- **Files:** regular and fragmented MP4/MOV are read; the output is a regular file with its index first. WebM and Matroska files give their audio only.

**Batch** (step 4) renders many files with the current settings and saves them one by one or as one ZIP.
- **Adding files:** use the batch file picker, choose several files in step 1, or drop files or whole folders anywhere on the page. A single file dropped outside the batch loads as the source.
- **Rendering:** runs two files at a time on machines with four or more cores. Each row reports length, integrated loudness and true peak, and has preview, save and remove buttons.
- **Changed settings:** changing a setting marks earlier renders as older; "Render" redoes them. The tab title shows progress.

## The voice path

1. **Sender:** capture and filtering.
   - Stereo input is captured from its **left channel** (measured through a stereo virtual cable); a mix is optional.
   - Optional mic gain is applied, then int16 capture clipping. The audio is resampled to the codec rate, with optional high-/low-pass filters (off by default).
   - **Steam's voice gate** decides which 20 ms frames are sent. A frame above −39.5 dBFS RMS is sent together with the 120 ms before it (pre-roll) and the 440 ms after it (hold). Longer pauses become silence instead of boosted noise, and each talk spurt starts a fresh encoder and decoder.
2. **Codec and network:** Steam's capture resampler rolls off the band above 11.1 kHz. libopus 1.1.5 then encodes the sent frames as Steam does: 32 kbps VBR, complexity 10, with DTX. When Opus's voice detector calls a frame inactive, as it does in held pauses and on steady tones, the encoder sends a 1-byte DTX packet and the decoder plays comfort noise. `net_split` groups whole frames into packets. Both network effects were measured in TF2:
   - **Loss** (`net_fakeloss`, the share of voice frames lost) comes in bursts averaging 2.2 frames, and the decoder's own concealment fills them.
   - **Jitter** (`net_fakejitter`) makes isolated frames arrive too late. At 50 ms that's 3% of frames; nine in ten are concealed and one plays as silence.

   Encoding continues through loss, and the encoder's reported delay is removed.
3. **Receiver:** libopus 1.1.5 decodes, as Steam's receiver does, and the audio moves to the engine voice rate (44.1 kHz for Steam). Next comes the **auto-gain** on the int16 voice.
   - Each 128-sample block sets a target `min(voice_maxgain, 32767 / (mean + voice_avggain × (peak − mean)))`. The defaults are 0.5 and 10.
   - The next block steps toward it in truncated 1/128 fixed-point increments, scaled by `voice_scale`, and every sample is clamped to int16.
   - A steady tone ends up 1.22× over full scale (42% of samples flattened), and speech and music about 5–6 dB under it: the dominant "TF2 voice" character.
4. **Mixer:** the 44.1 kHz mix applies the optional listener room (`dsp_room`) and underwater low-pass, then a small output roll-off and the output volume. It resamples to the file's rate (at least 44.1 kHz).

The quick presets reset every control. The live chain strip under the controls shows what the next render will do.

## Profiles

| Profile | Codec | Receiver | Status |
| --- | --- | --- | --- |
| Modern / `steam` | libopus 1.1.5: Opus 24 kHz, 32 kbps VBR with DTX, VOIP, voice hint (SILK/CELT hybrid) | auto-gain at 44.1 kHz | **Measured** against 2026 TF2 recordings and Steam's own packets |
| `steam_48` | libopus 1.1.5: Opus 48 kHz, 64 kbps VBR with DTX | auto-gain at 44.1 kHz | Experimental |
| `celt_22` (vaudio_celt) | **CELT 0.11**, 22050 Hz, 512-sample frames (23.2 ms), 64-byte packets (22.05 kbps), complexity 10 | auto-gain at 22.05 kHz, linear-interpolation mixer | Codec real; receiver modeled |
| `celt_44` (vaudio_celt_high) | CELT 0.11, 44100 Hz, 256-sample frames, 120-byte packets (one public source; unconfirmed) | auto-gain at 44.1 kHz | Modeled |
| `speex` | Opus SILK, 8 kHz, 8 kbps (stand-in for vaudio_speex) | auto-gain at 11.025 kHz, linear-interpolation mixer | Modeled |

Every profile runs a real codec; nothing is a hand-made approximation. The Steam profiles use **libopus 1.1.5**, built to WebAssembly by `tests/libopus11/build.mjs`. The CELT profiles use **CELT 0.11** in Source's custom mode, the tree the public CS:GO voice decoders use, built by `tests/celt011/build.mjs`. `speex` uses **libopus 1.6.1 via libopus-wasm 0.4.0** as a stand-in: Speex's settings in Source are not public, and current TF2 cannot load it. The status line and console report the modes the encoder actually chose (SILK / hybrid / CELT, from each packet's TOC byte). [tests/LEGACY_CODECS.md](tests/LEGACY_CODECS.md) collects what public sources say about the legacy codecs and which takes would settle the rest.

## Live monitor

**🎧 Live** (step 1) plays your microphone through the TF2 voice chain in real time, with the current settings. It uses the same stages and parameters as a render:
- capture gain and int16 clip
- Steam's gate
- libopus 1.1.5, frame by frame, with the loss and jitter model
- the receiver auto-gain and the output

The Node tests check each streaming stage against its offline counterpart sample for sample, and the whole chain against a render (r 0.99, within 0.1 dB).

**Latency.** About 230 ms from microphone to speaker. The largest part is authentic: Steam's gate sends the 120 ms before a word, so it has to hold that much back. The rest is the capture filter, Opus lookahead, a 40 ms jitter buffer and the audio device.

**While it runs:**
- **Settings:** changes apply as you make them, presets included.
- **Status:** the panel shows whether the gate is sending, the Opus mode, the bitrate, lost and late frames, input and output levels, and the latency.
- **Output device:** choose a virtual audio cable here to use the TF2 voice in other apps, such as Discord or OBS. Chrome and Edge can pick output devices; other browsers play on the default output.
- **Push-to-talk:** sends only while **V** (TF2's `+voicerecord` key) or the Talk button is held. Audio from before the key goes down is never sent, and the gate still applies while you hold it.
- **Low latency:** skips the gate's 120 ms pre-roll, so the gate opens on the loud frame itself. That saves 120 ms but cuts the start of each word, which TF2 does not.
- **Record:** captures the session and loads it into the app as a dry/wet pair: your microphone as the source and the voice as the render, lined up to the sample. A/B, the views, the meter and every download work on it, and **Process Audio** re-renders the microphone with other settings.

Rooms (`dsp_room`) are not applied live. Use headphones: speakers feed the output back into the microphone.

## Accuracy

The Steam profile, voice gate and receiver path come from 2026 recordings made with `voice_loopback 1`. The main set is a calibrated 143 s test signal recorded losslessly at default settings and with `voice_scale 0.5`, `voice_maxgain 1` and `voice_avggain 0.25`. The owner's speech and an earlier music recording validate it.

A SourceTV demo of the same test signal holds Steam's own voice packets. Decoding them gave the sender side exactly: its gate timing, DTX and encoder settings. Re-encoding the test signal with every libopus release from 1.1 to 1.6.1 identified Steam's codec as libopus 1.1.x, at both the sender and the receiver. With those packets as input, the receiver model matches the game's output within 0.1 dB per band up to 11.5 kHz, for both the sender's loopback and a second account on another PC.

Rendered through the app with each take's settings:
- **Test signal:** levels and clipped-sample shares match to within about 0.3 dB and 1–2%. That holds for sines, noise and a synthetic vowel across all three receiver settings.
- **Sender:**
  - Talk spurts: 16 of 18 start and end within 4 frames of Steam's, and 98.7% of 20 ms frames agree on sent or not sent.
  - Bytes: the total is within 0.2% of Steam's packets.
  - Decoded spectrum: within ±0.06 dB of Steam's packets up to 11.4 kHz.
  - Steady tones: they fall into DTX at the same moment as in Steam's packets (0.38 s against 0.42 s for a −36 dBFS sine).
- **Speech:** tracks within ±0.37 dB in 50 ms windows (correlation 0.998), with the spectrum within 0.3 dB.
- **Music:** tracks within 0.07–0.11 dB in half-second windows, and the spectrum agrees within ±0.3 dB from 80 Hz to 12 kHz.
- **Packet loss and jitter:** a one-minute network test signal was recorded under simulated loss and jitter. The app reproduces the loss-event rate, burst sizes and lost-frame share of every take (for example 4.4 against 4.3 events per second, and 16% against 17% of frames).

Evidence, method, residuals and open questions are in [tests/REFERENCE_2026.md](tests/REFERENCE_2026.md).

What that does **not** establish:
- Valve's source code for the gain stage or Steam's gate. Neither is in the public Source SDK 2013; both are identified from recordings.
- Which talk spurts TF2's receiver re-times. The receiver starts about 40% of spurts early after a short silence (finding 19), but which ones varies from take to take of the same signal. Renders keep the source timeline unless **Talk-spurt timing** is set to TF2 re-timing, which applies the measured statistics; latency trims inside a spurt are not modeled.
- Steam's exact libopus build and capture resampler. The release is 1.1.x (1.1.2–1.1.5 give identical packets). The resampler is modeled by its measured roll-off, and pure tones at 11.5–12 kHz still differ.
- The absolute playback level. That depends on game and OS volume; the rendered file uses `volume 0.5`, where the recordings used 0.15.
- Real internet loss. The network model comes from simulated loss and jitter in TF2 (`net_fakeloss`, `net_fakejitter` on a listen server).

Room presets use parameters from [Valve's preset data mirrored by Facepunch](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/scripts/dsp_presets.txt). The processors are this app's implementations, and the reference recording was dry, so rooms remain an effect. The same decoded PCM, settings and pinned runtime always produce the same output.

## Controls and console

Advanced controls are grouped in signal order. Every control has a console name.

| Group | Controls |
| --- | --- |
| **Sender** | `voice_capture_channel`, mic gain, filters, `voice_vad` and `voice_vad_threshold` |
| **Codec & network** | codec on/off, `snd_bits` bitrate scale, `net_split`, `net_fakeloss`, `net_fakejitter` |
| **Receiver** | `voice_agc`, `voice_retime`, `voice_avggain`, `voice_maxgain`, `voice_scale` |
| **Listener room & output** | `dsp_room`, custom room, `volume` |

Some controls behave differently from their names:
- `voice_scale` acts inside the fixed-point auto-gain, as in the game. Values below 1 do not simply scale the result: 0.5 lowers voice by 8–11 dB and adds a 344 Hz sawtooth.
- `net_fakeloss` is the share of voice frames lost, not TF2's own setting. On a listen server, TF2's `net_fakeloss 5`, `10` and `15` lost about 22%, 45% and 64% of voice frames.
- `voice_retime` is not a TF2 setting. It switches on the receiver's measured talk-spurt re-timing (random, seeded), which moves some spurts earlier than in the source.

The developer console supports Source-style `;` chaining, `alias`, `toggle`, `find`, history, and Tab completion. Tab completes to the longest common prefix, then lists matching commands with their current values. `writeconfig` copies a share URL; `preset_save/load/list/delete` manage local presets. `net_graph 1–4` overlays a Source-style HUD whose packet rate, payload rate and loss come from the last render. The background game-event feed (kills, chat, joins and drops) can be stopped with `sv_simulate_events 0`.

## Visualizer and meter

The visualizer has three views. All three follow the A/B toggle.
- **WAVE:** peak and RMS envelope, down to individual samples. **dB** switches to a dBFS amplitude scale for quiet detail: fades, the gate's tails, DTX comfort noise and noise floors. Full-scale samples are marked red.
- **BARS:** a log-frequency spectrum from 20 Hz, 8192-point, in dBFS; live while playing, computed at the playhead when paused. The version you are not hearing is drawn over it as a line. With a real take loaded, that is the take when you hear the render, and the render otherwise.
  - **AVG** switches to the long-term average spectrum of the render against the source, or against a real take once one is loaded. It covers the selection or the whole file, with 1/6-octave smoothing and silent windows skipped. The reference is shifted to the render's loudness, and a lane below shows the difference in dB: the chain's tonal footprint at a glance.
- **SPEC:** a spectrogram with a dB colour scale, on a linear axis or, with **LOG**, from 20 Hz. The ruler marks the 12 kHz Opus band edge in amber.

**Spectrogram resolution.** The visible band is analysed in tiers. Each tier reads the signal decimated as far as its top frequency allows (by up to 64), so a low band gets long windows cheaply. **RES AUTO** sizes the FFT to the zoom, as iZotope RX's auto-adjust does. A Blackman window of T seconds blurs about 0.4 T in time and 2.35 / T in frequency. AUTO picks T = 3.4 · √(seconds per column / Hz per row), which blurs about twice as many pixels in time as in frequency, so tones, harmonics and hum stay sharp.
- Zooming in on time shortens the window.
- Zooming in on frequency, or going lower on the log axis, lengthens it (up to 1.4 s).
- On the log axis every octave-ish band has its own window, and levels are per Hz so noise reads the same across them.

A fixed RES (256–16384 samples at the file's rate) uses one window length everywhere. The corner label and the hover readout give the window and bin width in use.

**Navigating** WAVE and SPEC:
- Zoom in time with Ctrl/⌘ + wheel, a trackpad or touch pinch, the − and + buttons or the + and − keys.
- Pan by dragging, with Shift + wheel or with the arrow keys.
- SPEC's frequency axis: the wheel over the frequency ruler, Alt + wheel or Ctrl/⌘ + Shift + wheel over the view, or ↑ and ↓. Drag the ruler to move the band (Shift + ↑/↓ with the keys). Double-click the ruler to show the whole band.
- FIT or 0 shows the whole file and the whole band.
- Click to seek. While playing zoomed in, the view pages along with the playhead.

Only the visible range is analysed, at the display's full pixel resolution. The range button sets how many dB the colours (or the dB waveform) span. TALL, or dragging the bottom-right corner, makes the view taller. Hovering reads out time, level, and in SPEC the frequency with its nearest note, the level and the analysis window.

**Lanes** under WAVE and SPEC:
- **Codec lane:** what the voice path did with each 20 ms frame, in playback time. It shows SILK, Hybrid or CELT coding, DTX (comfort noise), not sent (gate closed), lost (concealed) and late (played as silence).
  - Zoomed out, a pixel shows the most common frame type, with a red or orange strip on top for the share lost or late.
  - Hovering gives the frame's packet size and bitrate.
  - The legend under the view counts each type.
- **LUFS** adds a loudness lane: momentary (400 ms, thin) and short-term (3 s, bold) loudness of the render (blue) and the source (white), each drawn at the centre of its window. Dashed lines mark each version's integrated loudness.

**Selection and loop.** Shift + drag, or a drag along the time ruler, selects a range. Shift + click moves the nearer end. The meter then measures just the selection, wet and dry, with a header offering **Zoom to selection** (Z) and **Clear** (Esc). **LOOP** (L) loops the selection or, with none, the whole file.

**Meter.** Under the visualizer, the meter lists for the wet render and the dry source:
- integrated loudness and maximum short-term and momentary loudness (ITU-R BS.1770-4, gated)
- loudness range (EBU Tech 3342)
- true peak (4× oversampled), sample peak and RMS
- peak-to-loudness ratio and DC offset

A Δ row gives wet minus dry. Values are measured as one channel; played as dual mono they read 3 dB higher.

**Match loudness** makes the A/B comparison fair: the louder version plays quieter by the difference in integrated loudness over the whole file, so neither wins just by being louder.

**Shortcuts:** Space plays and pauses, B switches A/B, L loops. With the view focused: + − 0 and the arrows navigate, Z zooms to the selection and Esc clears it.

With a real take loaded, the meter adds a REAL row and a "Δ real" row (wet minus real), and loudness matching plays every version at the level of the quietest.

The meter shows a real codec property. When DTX replaces a steady tone below about 60 Hz, libopus 1.1.x's comfort noise is nearly DC, and TF2 plays it as is. See finding 18 in [REFERENCE_2026.md](tests/REFERENCE_2026.md).

## Checking against your own take

**Compare with a real TF2 take** (under the player) checks the simulation against a recording of the same source through TF2. Record it with `voice_loopback 1` as in [tests/testsignal/README.md](tests/testsignal/README.md), load the source, render it with the settings you recorded with, and load the take.

**Alignment** (`reference.js`, in a worker) goes talk spurt by talk spurt, because TF2's receiver re-times spurts by up to about 350 ms (finding 19):
- **Spurts:** the gate model of the current settings splits the source into talk spurts.
- **Reference:** once there is a render without random loss, the take is lined up against the render rather than the raw source. The render shares the take's gating, comfort noise and low-tone plateaus, and loaded takes are re-aligned after each such render.
- **Placing each spurt:** by its waveform at 2 kHz, or by its level envelope where the waveform repeats (tones, beeps). The search is within ±0.6 s, with a prior toward the delay the other spurts have.
- **Refining:** 1 s windows at 8 kHz follow the delay through the spurt, and split it where it steps. One clock ratio serves the whole take.

The status line reports the spurts, the latency trims and other re-timings, the clock and the correlation.

The aligned take then:
- plays as a third A/B version (B cycles wet, dry, real)
- shows in WAVE, SPEC, the loudness lane and AVG
- joins the meter

**The report** compares the render with the take where they overlap:
- sim minus take per band from 40 Hz to 19 kHz, level-matched at 300 Hz–3 kHz
- short-term level tracking in 0.5 s blocks
- the receiver's clipping signature for both

For the clip from the "whoosh" investigation (a river recording and its TF2 take), rendered at `volume 0.15`:
- the bands agree within ±0.4 dB from 80 Hz to 16 kHz
- levels track within 0.2 dB rms (r 0.98)
- the clip ceilings are −16.5 and −16.4 dBFS

**Timing of the render.** The Steam render keeps the source's timeline: its 8–11 kHz band lines up with the source to within a microsecond. Lower frequencies lead by 35–370 µs, which is the phase of Opus's SILK layer. TF2's libopus does the same, so it is kept (finding 20).

**Every take at once.** `pnpm accuracy --takes <folder>` runs this check over the owner's 18 recordings in headless Chromium. Each is rendered with the settings it was recorded with, lined up and compared, and the talk-spurt timing goes to JSON with `--json`. The takes and their settings are listed in [`tests/accuracy.takes.json`](tests/accuracy.takes.json); the recordings themselves are not distributed. The results are in [REFERENCE_2026.md](tests/REFERENCE_2026.md#results).

**Predictions made before the recordings.** A model fitted to recordings should reproduce them; the harder test is recordings it has not seen. [`tests/predictions/`](tests/predictions/PREDICTIONS.md) holds the app's predictions for six takes nobody has recorded yet:
- `vaudio_celt` and `vaudio_celt_high`, each with two competing hypotheses
- `voice_scale 2`, `voice_avggain 1` and `voice_maxgain 3`
- `volume 1`

They were rendered, measured and frozen by hash before the takes exist, with the scoring rules fixed in advance. The rules were checked on the Set B takes and on stand-in takes made from the renders plus real game sound. When the takes come in, `pnpm accuracy --score-predictions --takes <folder>` scores them against the registered file, and the results go in that file whatever they are.

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

- **`tests/verify.js`:** resampler passband/stopband/alignment, the profile FIR, and the auto-gain law. Also the live chain: each streaming stage (resamplers, FIR, auto-gain, loss model) equals its offline counterpart sample for sample, and the whole chain reproduces a render. The law checks cover the measured sine overdrive at `voice_avggain` 0.5 and 0.25, the cap, the int16 clamp, silence hold, step timing and the `voice_scale` sawtooth and truncation. Also the voice gate (threshold, pre-roll, hold, talk spurts, DTX comfort noise on steady tones, send/skip accounting), stereo capture, real codec modes per profile, all room presets 0–29, the measured loss bursts and late-frame jitter with PLC, option robustness and WAV structure.
- **`tests/opus.verify.mjs`:** frame timing and boundary pulses, exact lengths, bitrates and packet sizes, TOC mode reporting, native concealment, silence, mute, determinism, the sender gate inside the round trip (pre-roll, hold, talk spurts), opt-in DTX, the per-frame log behind the codec lane, leveling and cap behavior, output-volume linearity, pre-encoder filtering, and codec-failure reporting. Also the libopus 1.1.5 build: its packets are bit-identical to a native build of the release, and its DTX differs from 1.6.1's as Steam's does.
- **`tests/reference.verify.mjs`:** alignment, clock drift, polarity, fractional delay, clip-signature and level-tracking metrics. Also the in-page real-take check. A take made from a render (delayed, clock-skewed, quieter) is lined up with its source to within 10 µs and 0.2 ppm, and compares as identical. Short excerpts are found, and unrelated audio is rejected.
- **`tests/video.verify.mjs`:** the video remux on ffmpeg-made fixtures in `tests/video/`: H.264 with AAC (regular, fragmented, and with delayed audio), H.264 with PCM in MOV, and VP9 with Opus. Every video sample comes out byte for byte with its timing, the index comes first, and the new audio decodes back on time and starts where the old audio did. A stand-in WebCodecs encoder checks the AAC path: frames land unchanged, the AudioSpecificConfig goes into the `esds` box, and the edit list skips the priming.
- **`tests/formats.verify.mjs`:** download formats and ZIPs.
  - FLAC decodes bit-exact with valid frame CRCs, through an independent decoder in the test.
  - The MP3 module matches its documented build. Its files are byte-identical to a native gcc build of LAME 3.100. Decoded with mpg123, they keep level and waveform, and their LAME tag accounts for every sample.
  - Rates MP3 cannot carry are resampled.
  - The WAV reader works, and ZIP archives have correct headers and CRC-32.
- **`tests/meter.verify.mjs`:** the meter against BS.1770-4 and EBU Tech 3342:
  - K-weighting coefficients
  - −3.01 LUFS for a full-scale 997 Hz sine, and −23 LUFS at −20 dBFS
  - both gates
  - LRA 10 LU on the two-level case
  - true peak 0 dBTP on the fs/4, 45° sine
  - the loudness history that the LUFS lane draws
- **Chromium checks:**
  - worker parity, cancellation, PCM recording and offline conversion
  - every visualizer mode, zoom, pan, seek, keys and scales
  - the codec and loudness lanes, frequency zoom, AUTO and fixed resolution, selection statistics, zoom to selection and loop
  - BARS AVG, and the real-take comparison: alignment of a synthetic take, the band report, A/B/C, the meter's REAL rows and removal
  - the live monitor with a fake microphone: frames sent, modes, reported latency, low latency, push-to-talk, recording into the app, stop
  - video in and out: an MP4 and a MOV load as sources, and **Download video** keeps every picture sample
  - the meter, loudness-matched A/B and shortcuts
  - batch queueing: picker, step 1 multi-select, drop on the batch panel, single-file drop as source
  - batch rendering with loudness per file, and ZIPs in all three formats, with FLAC decoded in the browser to exactly the WAV's samples
  - stale-render marking and remembered format
  - the chain strip, presets, console completion, `net_graph`, accessibility and mobile layout
  - the 44.1/48 kHz file × decode-rate matrix

  Set `CHROMIUM_EXECUTABLE` to use a preinstalled browser whose build differs from Playwright's pin.

These tests establish implementation behavior; the accuracy claims rest on the paired comparison above. CI runs Node 22 and Chromium.

`pnpm vendor:opus` copies the pinned 1.6.1 runtime and notices verbatim. `pnpm build:opus11` rebuilds the libopus 1.1.5 module from the tagged sources, and `pnpm build:celt` the CELT 0.11 module from its pinned commit. `pnpm build:lame` rebuilds the LAME 3.100 module from the release tarball, checked against its SHA-256. They need clang with the wasm32 target and wasm-ld. `pnpm test:vendor` checks the 1.6.1 files against the installed dependency and the 1.1.5 module against its recorded hash. The runtimes and licenses are required distribution files.

## Files and licensing

| File | Role |
| --- | --- |
| `audio.js` | DSP and orchestration |
| `opus-codec.mjs` | packets, modes and delay; picks the libopus runtime; the CELT 0.11 round trip |
| `vendor/libopus-1.1/` | libopus 1.1.5 WebAssembly for the Steam profile |
| `vendor/celt-0.11/` | CELT 0.11 WebAssembly for the vaudio_celt profiles |
| `vendor/libopus/` | libopus 1.6.1 (libopus-wasm) for the other profiles |
| `vendor/lame/` | LAME 3.100 WebAssembly, the MP3 encoder |
| `audio-worker.js` | cancellable background rendering, format conversion and metering |
| `mic-capture.js` | PCM recording |
| `constants.js` | presets, codec profiles, receiver model, room data |
| `app/` | the interface, in load order: `core.js` (elements, state, event feed), `console.js`, `source.js` (file, video and microphone), `render.js` (rendering, downloads, A/B), `meter.js`, `realtake.js`, `visualizer.js`, `netgraph.js`, `boot.js` |
| `batch.js` | batch queue, drag and drop, ZIP downloads |
| `formats.js`, `flac.js`, `zip.js` | download formats: WAV reader, FLAC encoder, stored ZIP |
| `meter.js` | loudness and level measurement |
| `reference.js` | finding a source in a real take, aligning it talk spurt by talk spurt, and the comparison measures (page, worker and Node tools) |
| `video.js` | reading MP4/MOV and writing the video back with the render as its audio |
| `live.js`, `live-worker.js`, `live-worklet.js` | live monitor: interface, the streaming chain in a worker, capture and playback on the audio thread |

Tests and local tooling are under `tests/`.

Application code: MIT. Codec notices: `vendor/libopus/LICENSE`, `COPYING.opus` and `THIRD_PARTY_NOTICES.md`, `vendor/libopus-1.1/COPYING.opus` (libopus, BSD), `vendor/celt-0.11/COPYING.celt` (CELT, BSD) and `COPYRIGHT.musl` (musl libm, MIT). The MP3 encoder is LAME 3.100, unmodified, under the GNU LGPL version 2 (`vendor/lame/COPYING.lame`). It is a separate module that loads only when an MP3 is saved and can be rebuilt or replaced with `tests/lame/build.mjs`; see `vendor/lame/README.md`. TF2, Source and Steam are Valve trademarks. This independent tool is not affiliated with Valve.
