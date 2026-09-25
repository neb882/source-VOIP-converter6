# Paired 2026 TF2 loopback: what the recording shows

Measured locally on 2026-09-24/25. No source music, recording or derived audio is distributed with this project.

## Provenance

The owner reports default TF2 voice settings, `voice_loopback 1` on a private server, and playback of the two exact supplied MP3s into a virtual audio cable. They did not change volume between songs. The recording application, cable channel mapping and any OS-level processing are not independently established.

| Supplied file | Decoded format / duration | SHA-256 |
| --- | --- | --- |
| tf2 VOIP test 2026 pure.mp3 | 48 kHz stereo / 170.76 s | `d538ade4cfecb7530bf0748c31519c70c974e82054fb5726c18cb52ed5cd9f6e` |
| Joni Mitchell - River.mp3 | 44.1 kHz stereo / 250.17 s | `c450847c6d1967d5608a731a356c839ad937fd20fbdb974a38bca202b7569ae4` |
| Ke$ha - Take It Off.mp3 | 44.1 kHz stereo / 215.61 s | `3b76981443496cdf6f8b23b1e3a1e2507ddc3aa7f11a5fdf1d22315b512f28da` |
| real tf2 VOIP recording 2024.mp3 | 44.1 kHz stereo / 59.98 s | `3bb37d8dad4800debd0282c2c4b62a8df4bf6922f737a4e68b395b161e45e543` |

The loopback file is effectively mono (L/R correlation 0.99997), was written by FFmpeg/LAME as VBR MP3 (about 147 kbps), and contains two talk spurts: River at 0.82–58.5 s and Take It Off at 81.2–163.8 s. Between spurts the file is digital zero; spurts start and stop abruptly with no fade. There are no dropouts inside either spurt.

## Findings

Each source was located by waveform cross-correlation and aligned in 0.5–1 s blocks. The recording runs about 450 ppm fast against the sources and wanders by ±1.5 ms, so coherence was measured in 0.1 s blocks with local re-alignment.

### 1. The voice is hard-clipped at a fixed ceiling

| | River passage | Take It Off passage | Sources |
| --- | ---: | ---: | ---: |
| Clip ceiling (99.5th percentile of \|y\|) | −16.4 dBFS | −16.3 dBFS | — |
| Samples within 5% of the ceiling | 13.6% | 12.8% | — |
| Spread of 256-sample block peaks (P90−P10) | 0.56 dB | 0.45 dB | 8.5–16 dB |
| Mean \|y\| ÷ ceiling | 0.49 | 0.52 | — |
| Crest factor (ceiling ÷ RMS) | 4.7 dB | 4.3 dB | 6.4–8.6 dB |

Runs of 20+ consecutive samples sit flat at the ceiling. Almost every 5 ms block reaches it. The ceiling is well below 0 dBFS, which reflects game/OS volume after the clip. It is not headroom in the voice path.

### 2. A block auto-gain drives the mean to half of full scale

River's source is about 10 dB quieter than Take It Off's. Both nevertheless come out at the same level with the same clip statistics. Over 100 ms blocks, the output mean stays at −5.5 to −6.6 dB re the ceiling (0.47–0.53; a target of 0.5 is −6.0 dB) across 24 dB of input level. The implied gain peaks at about 24 dB for the quietest River passages.

The fastest gain changes line up with 128-sample blocks at 44.1 kHz. The high-frequency envelope has spectral lines at 344.66 Hz and 689.3 Hz, which is 44100/128 and its harmonic, shifted by the measured clock offset. These lines are strongest in one River window and weaker elsewhere. With longer blocks (256–1024), the model no longer reproduces the 0.45 dB block-peak spread.

This matches the receiver-side voice auto-gain remembered from the Source engine's `voice.cpp`. That code (`voice_avggain`, `voice_maxgain`) is **not** in the public Source SDK 2013, so the gain law used here is fitted to this recording, not transcribed.

### 3. The clipping happens after decoding, at 44.1 kHz

The recording has noise-like energy at 12–19.5 kHz: −29 to −41 dB relative to 300–3000 Hz on Take It Off. Both source MP3s have nothing above 16 kHz, and Opus at 24 kHz codes nothing above 12 kHz. Four alternative explanations were ruled out:
- **Not transmitted source content.** It has no coherence with the source at the same frequency.
- **Not a resampling image.** Simulated linear-interpolation images of this music correlate 0.97–1.0 with their exact mirror band (24 kHz − f). The recording's HF bands correlate non-specifically: best with 11–12 kHz, 0.58–0.93.
- **Not the recording's MP3 encoding.** Re-encoding a clean simulation with LAME at 128–192 kbps adds less than −75 dB there.
- **Not a 48 kHz Opus stream.** Fullband CELT noise filling puts shelves at the wrong levels, and no 48 kHz configuration matched.

Clipping the decoded signal at 44.1 kHz reproduces the shelf's level and shape. The Source SDK's `public/soundsystem/snd_device.h` fixes the hardware mix rate at `SOUND_DMA_SPEED 44100`. `public/steam/isteamuser.h` documents that `DecompressVoice` outputs 16-bit PCM at any requested rate from 11025 to 48000, and recommends the output device's rate.

### 4. The codec is 24 kHz Opus in SILK/CELT hybrid mode

- **Band edge:** the passband ends at about 11.5–12 kHz.
- **Crossover:** coherence has a hole at 8 kHz (0.03 against 0.14–0.22 either side), at the crossover between SILK and CELT in hybrid mode. libopus reproduces the hole with the `voice` signal hint. At 32 kbps with automatic signal detection, libopus 1.6.1 codes this music CELT-only, and the hole disappears.
- **High-band level:** above 7.8 kHz the recording is about 2.5 dB lower relative to libopus 1.6.1. Neither VBR nor complexity explains it, so the likely cause is a different (older) libopus in Steam.
- **Bitrate:** within 16–40 kbps, bitrate barely changes these measurements. 32 kbps is kept from the cited 2021 reverse engineering.

## Model

| Stage | Setting | Basis |
| --- | --- | --- |
| Codec | Opus 24 kHz mono, VOIP, signal=voice, 32 kbps CBR, 20 ms, libopus 1.6.1 | band edge, hybrid crossover, 2021 reverse engineering |
| Profile EQ | −2.5 dB above 7.8 kHz, band edge from 11.8 kHz (95-tap FIR at 24 kHz) | fitted |
| Voice rate | 44.1 kHz | block-rate lines, clip products above 12 kHz, SDK mix rate |
| Auto-gain | 128-sample blocks; next gain = min(16, 0.5 ÷ mean\|x\|) × voice_scale, ramped linearly across the following block; int16 clamp | clip statistics, level tracking; cap fitted |
| Output stage | 3-tap `[0.1, 0.8, 0.1]` at 44.1 kHz | fitted to the 13–18 kHz slope |

Joint fit of the spectral calibration: 1.1 dB RMS error over 1.5–18 kHz for both songs. Fit of the cap: 0.54 dB RMS on half-second levels at 16×, versus 0.93 dB at 10×.

## Results

From `pnpm compare:reference` with the app's JS pipeline, stereo-average input, 48 kHz analysis:

| | River | Take It Off |
| --- | ---: | ---: |
| Spectrum, rendered − recorded, 40 Hz–19 kHz bands | within ±1.4 dB (16–19 kHz +2.4) | within ±1.0 dB |
| Half-second level tracking, RMS deviation / correlation | 0.55 dB / 0.77 | 0.42 dB / 0.88 |
| Clipped samples, rendered vs recorded | 11.7% vs 13.6% | 14.1% vs 13.3% |
| Mean ÷ ceiling, rendered vs recorded | 0.47 vs 0.49 | 0.51 vs 0.53 |
| Crest, rendered vs recorded | 5.1 vs 4.7 dB | 4.5 vs 4.3 dB |

The same tool renders a variant with the receiver auto-gain off. It misses badly: 0.7% clipped, 3–4 dB level-tracking error, and a high-frequency shelf 20–60 dB too low. The previous app version (RMS leveling after the codec, no clamp, 11 kHz capture low-pass) had no mechanism for any of findings 1–3.

## What remains unverified

- **Short-term level variation.** The recording varies more at the 100 ms scale than the model (P90−P10 2.2 dB vs 0.8 dB on Take It Off). The extra variation correlates with input crest factor. Neither a peak term in the gain law nor longer blocks fixed it without breaking the clip statistics.
- **Where the extra gain comes from.** The cap of 16 is an effective value. It is also consistent with a Source default of 10 plus about 4 dB elsewhere in the capture path.
- **High-band trim.** The −2.5 dB trim is attributed to a libopus version difference, which is not confirmed.
- **Recording chain.** The small post-clip roll-off may come from the recording chain rather than the game.
- **Single recording.** This is one default-settings recording of music through a virtual cable. Paired speech, a real network with loss, other volume settings and other clients are still unmeasured.
- **Legacy profiles.** They reuse the receiver model at their historical voice rates, with a linear-interpolation mixer. They are not validated against recordings.
- **Room presets** are not validated against recordings.
- **The 2024 gameplay recording** mixes game audio and so cannot be paired. Its late passages show compressed block peaks (about 1.5 dB spread) and mean/ceiling up to 0.44, which is consistent with the model but not proof.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm compare:reference 'path/to/tf2 VOIP test 2026 pure.mp3' 'path/to/Joni Mitchell - River.mp3' 'path/to/Ke$ha - Take It Off.mp3'
```

Use single quotes around filenames containing `$` in PowerShell. The tool reads files locally, prints JSON, and uploads nothing. A full run takes a few minutes.
