# Paired 2026 TF2 loopback check

Measured locally on 2026-09-19. No source music, recording, or derived audio is distributed with this project.

## Provenance

The owner reports default TF2 voice settings, `voice_loopback 1` on a private server, and playback of the two exact supplied MP3s into a virtual audio cable. They did not change volume between songs. The recording application, cable channel mapping, explicit codec cvar/version and any capture processing are not independently established.

| Supplied file | Decoded format / duration | SHA-256 |
| --- | --- | --- |
| tf2 VOIP test 2026 pure.mp3 | 48 kHz stereo / 170.76 s | `d538ade4cfecb7530bf0748c31519c70c974e82054fb5726c18cb52ed5cd9f6e` |
| Joni Mitchell - River.mp3 | 44.1 kHz stereo / 250.17 s | `c450847c6d1967d5608a731a356c839ad937fd20fbdb974a38bca202b7569ae4` |
| Ke$ha - Take It Off.mp3 | 44.1 kHz stereo / 215.61 s | `3b76981443496cdf6f8b23b1e3a1e2507ddc3aa7f11a5fdf1d22315b512f28da` |

The loopback recording decodes without reported errors, is effectively mono (L/R correlation 0.999972), and peaks at approximately -13.63 dBFS. Lack of full-scale samples does **not** rule out clipping earlier in the playback/capture chain.

## Method

Run after installing the project's pinned development dependencies:

```sh
pnpm compare:reference "path/to/loopback.mp3" "path/to/source-one.mp3" "path/to/source-two.mp3"
```

Use single quotes around filenames containing `$` in PowerShell. The tool reads files locally and prints JSON; it uploads nothing and never edits the inputs.

The coarse search uses four-second normalized waveform correlation after anti-aliased downsampling and a 100 Hz high-pass. Repeated musical phrases can create stronger but wrong matches, so at least three matches must share a continuous timeline. A robust linear fit estimates offset and small clock drift. A windowed-sinc fractional-delay filter corrects timing without the high-frequency attenuation introduced by linear interpolation.

Matched reference intervals were 6–54 s for River and 90–150 s for Take It Off. Their source intervals are approximately 57.158–105.192 s and 10.214–70.242 s respectively. Three additional two-second, 24 kHz waveform checks per song produced correlations of 0.623–0.834 and 0.510–0.717, with remaining offsets under 5 ms. Those correlations verify passage identity; they are **not** fidelity scores.

Analysis uses a common 24 kHz rate, 2048-point Hann spectra with 50% overlap, and 250 ms RMS blocks. Spectral comparisons use the summed 300–3000 Hz power to remove recording-volume differences. This is not perceptual loudness matching. No unique codec bitrate, capture filter, AGC implementation or channel routing can be inferred from these metrics alone.

## Before and after

These are the app's normal stereo-average input results, not the more favorable left-channel-only results. Level variation is the P90 minus P10 of 250 ms RMS levels over each matched passage; it is not a standard integrated loudness or dynamic-range rating.

| Paired passage | Recorded TF2 level variation | Previous Modern | Updated Modern |
| --- | ---: | ---: | ---: |
| River | 2.09 dB | 6.03 dB | 2.62 dB |
| Take It Off | 1.89 dB | 5.60 dB | 2.69 dB |

| Absolute 40–80 Hz band-balance error, relative to the 300–3000 Hz anchor | Previous Modern | Updated Modern |
| --- | ---: | ---: |
| River | 10.47 dB | 2.91 dB |
| Take It Off | 8.85 dB | 0.42 dB |

The previous baseline is reproduced in the comparison tool: 1.3 input gain, modeled pre-encoder peak AGC, 120 Hz high-pass, and the same real Opus configuration. Updated Modern uses unity input gain, a 40 Hz high-pass and post-decoder RMS leveling. Opus stays 24 kHz mono / 32 kbps / 20 ms; the 11 kHz low-pass is unchanged. A few milliseconds of residual alignment error is acceptable for these pooled spectra and 250 ms statistics, but not for samplewise error or codec identification.

## What remains unverified

- Improvements are not uniform across every band. With stereo-average input, River still has about 4.6 dB too much 80–120 Hz energy relative to the anchor, and remaining high-band differences. Left-only input matches portions of River better, but cable routing is unknown; the app still averages stereo rather than silently choosing a channel.
- Both excerpts were used during tuning. Second-half results are consistency checks, **not an independent holdout**. Independent paired speech, additional music, silence/onsets and different capture levels are still needed.
- The files are MP3, including the final recording. Capture compression, device processing, channel routing and game playback volume remain confounding factors.
- `voice_loopback` is a local test, not evidence for behavior under real network loss. Native Opus loss concealment and the app's simulated packet-loss model have separate synthetic tests.
- The revised leveling stage is a bounded empirical model, not recovered Valve code. It remains optional. This check does not establish the actual TF2 Opus version, bitrate, encoder settings, or exact internal DSP order.

The change is supported as a closer match to the measured bass and level behavior of these pairs, not as bit-exact or universally perceptually equivalent TF2 emulation.
