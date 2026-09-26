# 2026 TF2 voice recordings: what they show

Measured locally from 2026-09-24 to 2026-09-26. No recording, source music or derived audio is distributed with this project. The exceptions are the synthetic test signals, whose generators are in [`tests/testsignal/`](testsignal/).

Two sets of recordings were made with `voice_loopback 1` on a private server, playing files into TF2's microphone input through a virtual audio cable:

- **Set A** (music): one MP3 of two songs.
- **Set B**: a calibrated test signal recorded under four settings, plus the owner's own speech. All are lossless FLAC.
- **Set C**: a one-minute network test signal recorded under simulated packet loss and jitter, plus the owner's speech under loss. All are lossless FLAC.

Set B identified the receiver law, and Set A and the speech take validate it. Set C measured what loss and jitter do to the voice.

## Provenance

### Set A: music loopback

The owner reports default TF2 voice settings. They did not change volume between songs.

| Supplied file | Decoded format / duration | SHA-256 |
| --- | --- | --- |
| tf2 VOIP test 2026 pure.mp3 | 48 kHz stereo / 170.76 s | `d538ade4cfecb7530bf0748c31519c70c974e82054fb5726c18cb52ed5cd9f6e` |
| Joni Mitchell - River.mp3 | 44.1 kHz stereo / 250.17 s | `c450847c6d1967d5608a731a356c839ad937fd20fbdb974a38bca202b7569ae4` |
| Ke$ha - Take It Off.mp3 | 44.1 kHz stereo / 215.61 s | `3b76981443496cdf6f8b23b1e3a1e2507ddc3aa7f11a5fdf1d22315b512f28da` |
| real tf2 VOIP recording 2024.mp3 | 44.1 kHz stereo / 59.98 s | `3bb37d8dad4800debd0282c2c4b62a8df4bf6922f737a4e68b395b161e45e543` |

The loopback file is:
- Effectively mono (L/R correlation 0.99997).
- VBR MP3 written by FFmpeg/LAME, about 147 kbps.
- Two talk spurts: River at 0.82–58.5 s and Take It Off at 81.2–163.8 s. Between spurts the file is digital zero.

### Set B: test signal and speech

The test signal (`tf2_voice_testsignal_v1.wav`, 142.9 s, SHA-256 `efd1c0bc…75e0`) contains:
- 1 kHz sine and pink-noise level staircases
- level steps
- noise bursts separated by 20 ms–4 s of silence
- a 20 Hz–20 kHz sweep
- band-edge tones
- clicks
- a synthetic vowel
- quiet noise
- sync beeps

Every segment's exact position is in [`tf2_voice_testsignal_v1.json`](testsignal/tf2_voice_testsignal_v1.json). The owner's console showed `volume 0.15`, `voice_maxgain 10` and `voice_scale 1`. After a fresh game start it also reported `voice_avggain 0.5`. They recorded the game output with OBS and exported lossless FLAC (48 kHz, 24-bit).

| Take | Setting changed from default | Duration | SHA-256 (FLAC) |
| --- | --- | --- | --- |
| take1_default | none | 149.5 s | `dd4a0cfb83c697c4389463141b052eb8882527029ef45eac2adde0b2f7c99e2f` |
| take2_voice_scale_0.5 | `voice_scale 0.5` | 147.8 s | `f1cad2c864fcd19678dc3fbe45f7d61bafd121c789edb0ee6d0ce5a96bf5f0d8` |
| take3_voice_maxgain_1 | `voice_maxgain 1` (receiver gain can only fall to unity, i.e. never boosts) | 144.9 s | `576fa567c5e3ebd25e4ee21c3c6b3e7626c95693055683a7ee8aca878674a7fc` |
| take3_voice_avggain_0.25 | `voice_avggain 0.25` | 146.1 s | `013ca3e2af8e8c028c60697e7e8e69024b0bb8b7d1b392e669ff6b2dd2eab420` |
| take4_my_own_speech | none; 124 s of speech | 127.6 s | `2500b7a5b61de4e4e3bdd9c3cbe0f96f7687c1160eee0e6bc3a50e01c8c78f83` |
| my_own_speech_raw_from_audacity.wav | the unprocessed speech source | 124.4 s | `37476e14c20bd8b30ce1ea18c7e63bfda181bc8333d4236b6214982f3bb65749` |

Game ambience is mixed into Set B at about −30 dB re the voice clip level, mostly below 100 Hz (1–3 kHz: −43 dB; above 8 kHz: −68 dB). Quiet-segment measurements therefore use band-limited levels.

Each take was aligned to the test signal from its level envelope, then from 10–13 short noise anchors:

| Take | Clock drift | Anchor residual |
| --- | ---: | ---: |
| take1_default | −51 ppm | 3.5 ms SD |
| take2_voice_scale_0.5 | −138 ppm | 3.0 ms SD |
| take3_voice_maxgain_1 | −90 ppm | 4.7 ms SD |
| take3_voice_avggain_0.25 | −208 ppm | 4.4 ms SD |

The speech take needed a separate alignment for each talk spurt. The delay changes between spurts, between 1.94 s and 2.29 s, which is consistent with the receiver's jitter buffer restarting at each spurt.

### Set C: packet loss and jitter

The network test signal (`tf2_voice_nettest_v1.wav`, 58.2 s, SHA-256 `1b8b6ac0…8633`) was played the same way on a listen server with `net_usesocketsforloopback 1` and `sv_cheats 1`. Its segments are 12 s of pink noise, a 10 s chirp, 12 s of synthetic voice and eight separate 1.2 s noise bursts. Levels keep the voice gate open and the auto-gain at its +20 dB cap. `net_graph` showed 14–19 ms ping without `net_fakelag` and 204–210 ms with `net_fakelag 100`.

| Take | Console | `net_graph` loss | Duration | SHA-256 (FLAC) |
| --- | --- | ---: | --- | --- |
| baseline | all 0 | 0 | 64.1 s | `87f513579b2543633e2c91b59a2f70c0fdd987f524a08598d3f8b46a0a28fa4e` |
| loss5 | `net_fakeloss 5` | 13 | 60.8 s | `e032ab14c4ca3642625308ff77c20aff69bb00921a75e862645393a060fa6708` |
| loss15 | `net_fakeloss 15` | 34 | 61.9 s | `b10e2b4ebc8b2551100508c4278dfccb61d68dbddaca20ebb291dffbf962b7a6` |
| jitter | `net_fakelag 100; net_fakejitter 50` | 0 | 61.6 s | `031e2d62813ca105349b0c247e4d97697e903550818cf46dde577672e3a10094` |
| combined | `net_fakeloss 10; net_fakelag 100; net_fakejitter 50` | 20 | 61.7 s | `e5215d465ada55cbe63735b7650331f101a6b87b8cfa6b76207550d0bf2c1938` |
| speech_loss10 | `net_fakeloss 10`, owner's raw speech | — | 87.9 s | `7aba8b3921c32e918d0753872721cde2811a11c798dc772aa3d754ffac445ef3` |

Each take was compared with the app's lossless render in 10 ms windows every 2.5 ms (300–4000 Hz correlation), following the delay at 20 ms resolution. A window below 0.4 correlation counts as damaged; a damaged stretch of at least 15 ms counts as one loss event. In the clean baseline, received frames correlate at a median of 0.86–0.99, and false events occur about 0.9 times per second. The rates below have that subtracted.

## Findings

### 1. The output ceiling is int16 full scale times `volume`

With the default settings, loud input comes out hard-clipped at a 99.9th-percentile ceiling of exactly 0.15 × 32767/32768 (−16.48 dBFS). That is int16 full scale times the owner's `volume 0.15`. The music recording's −16.4 dBFS ceiling is the same `volume`, not headroom in the voice path.

### 2. Sender and codec are linear; the codec is 24 kHz Opus in SILK/CELT hybrid mode

With `voice_maxgain 1` the receiver never boosts, so that take shows the sender and codec on their own:
- **Levels:** sines come out at +0.5 dB against the file from −24 to −1 dBFS. The sender has no gain control or noise suppression; 10 s of steady pink noise does not decay.
- **Spectrum:** libopus 1.6.1 at 24 kHz / 32 kbps, VOIP, `signal=voice` matches the take on steady pink noise within ±0.3 dB below 7 kHz.
- **Profile EQ:** refitted to this take. The SILK/CELT crossover near 8 kHz is kept, the hybrid band from 8.2 kHz is trimmed by 2.5 dB, and the band edge rolls off from 11.5 kHz. This brought 5–12 kHz from 1.34 to 0.36 dB RMS error.
- **Pure tones:** above 8 kHz the real encoder treats them more harshly than libopus 1.6.1: 8, 8.5, 11 and 11.5 kHz tones come out 10–18 dB lower, and differ from take to take. Noise-like content, which is what speech and music contain, matches.

Set A shows the same codec:
- Coherence has a hole at 8 kHz, the hybrid SILK/CELT crossover, which libopus reproduces only with the `voice` hint.
- The band ends at about 11.5–12 kHz.
- Noise-like energy at 12–19.5 kHz is not transmitted content. It is incoherent with the source, is not a resampling image, not MP3 encoding, and not a 48 kHz stream. It is reproduced by clipping the decoded voice at 44.1 kHz (`SOUND_DMA_SPEED 44100` in `public/soundsystem/snd_device.h`). `DecompressVoice` in `public/steam/isteamuser.h` returns 16-bit PCM at any requested rate from 11025 to 48000.

### 3. The receiver auto-gain blends the block mean and peak

The engine's voice-channel auto-gain (`voice.cpp`, not in the public Source SDK 2013) works on the int16 voice at 44.1 kHz in 128-sample blocks. The fixed-point details are in finding 4. Every block sets the target gain for the next one:

```
T = min(voice_maxgain, 32767 / (mean|x| + voice_avggain * (peak|x| - mean|x|)))
```

`voice_avggain` 0 would drive the block mean to full scale, and 1 the block peak. The game's default is 0.5: the console reports it, and the default take fits it. The takes pin the law down in three ways:
- **Sine overdrive.** A steady sine has mean/peak = 2/π, so the default blend overdrives it by 1/(2/π + 0.5 (1 − 2/π)) = 1.22×. Every sine from −18 to −1 dBFS came out identical: −2.1 dB RMS with 42% of samples at the clamp. The law predicts 41.7%. At `voice_avggain 0.25` the overdrive is 1.37×: predicted and measured 50%.
- **Noise level.** Pink noise has a much lower mean/peak ratio, so it comes out lower (−5.3 dB, 10% clipped) with no separate noise parameter.
- **The cap.** A −24 dBFS sine gets exactly 20 dB (`voice_maxgain 10`), where the law would ask for more.

The previous model normalized the block mean to 0.5 with a fitted cap of 16. It matched the music's average statistics but put sines 3 dB low without clipping them, and missed noise by 2–3 dB.

### 4. `voice_scale` enters the fixed-point ramp twice

`voice_scale 0.5` does not simply halve the output: sines came out 8 dB down and loud sines 11 dB down. Folding the output gain of a steady sine over the 128-sample block period (44100/128 Hz) shows a sawtooth.

The gain starts each block at s²·T. It then climbs toward s·T in whole 1/128 fixed-point steps per sample, with the step truncated toward zero, where s is `voice_scale`. That reproduces everything in that take:
- **Sawtooth shape:** 0.17 → 0.29 of full scale recorded, 0.16 → 0.28 modeled.
- **The extra 3 dB drop on −6 and −1 dBFS sines:** their step truncates to zero, so the gain stays at s²·T.
- **Every level:** within 0.3 dB, including pink −13.5 / −13.5 and vowel −9.9 / −9.8 dB.

At the default s = 1 the same update ramps from the previous target, and any remainder below one step lands at the block edge. That is where the 344.5 Hz (44100/128) lines in Set A come from. All-zero blocks, when no voice data arrives, leave the gain untouched. With that rule the modeled onsets after gaps match the recording in 1.3 ms steps: 0.08 / 0.10 / 0.13 / 0.64 / 1.0 of full scale against 0.07 / 0.08 / 0.17 / 0.53 / 0.98.

### 5. Steam's sender gates quiet input

The sender transmits only while its level gate is open:
- **Opening:** full-band RMS of a 20 ms frame above about −39.5 dBFS.
- **Evidence for the threshold:** a −36 dBFS sine (−39.0 dBFS RMS) opens it. A −42 dB RMS pink noise, whose loudest frame is −39.97 dBFS, never does. Neither does a −40 or −42 dBFS sine.
- **Opening is immediate.** It stays open for roughly 300 ms after the last frame above threshold, which lets speech tails through.
- **Closed frames are not sent;** the receiver hears silence, with no comfort noise.

Across labelled windows this threshold-and-hold gate agrees with the test-signal takes 95% of the time and with the speech take 99% of the time.

It is not libopus DTX (DTX only drops near-silence here) and not the WebRTC VAD in any mode. Both were tested against the same labels.

### 6. A stereo source reached the game as its left channel

Set A's River passage tracks the model within 0.16 dB when the model is fed River's left channel. It tracks within 0.79 dB from the right channel and 1.14 dB from the L+R average. Take It Off is mostly centre-panned and fits any channel (0.07–0.11 dB). Rendering without the voice gate gives identical numbers, so the channel is the cause. The owner's virtual-cable capture passed the left channel to the game's mono microphone, so stereo input now defaults to it.

### 7. MP3 encoding biases Set A's clip statistics

Set A was delivered as VBR MP3. Encoding the model's lossless output with LAME:
- dropped the share of pink-noise samples within 5% of the ceiling from 10.4% to 3.3–9.4%
- widened the 256-sample block-peak spread from 0.14 to 0.23–0.72 dB

Set B is lossless and matches the model's clip statistics directly. The previous model had been tuned to Set A's biased values.

### 8. Lost voice frames are concealed in bursts averaging 2.2 frames

Lost audio is replaced in place, not skipped or left silent. Across 54 of 55 isolated events the delay is the same before and after, and the damaged stretch carries noise within about 3 dB of the true level: Opus's own concealment. It fades toward silence only in long bursts at high loss.

The damage comes in bursts:

| Take | Events per second | Frames lost | Events of 1 / 2 / 3 / 4+ frames |
| --- | ---: | ---: | --- |
| loss5 | 4.3 | 17% | 51 / 23 / 17 / 9% |
| loss15 | 14.1 | 58% | 54 / 21 / 10 / 15% |
| combined | 12.0 | 43% | 57 / 25 / 9 / 9% |

A two-state (Gilbert-Elliott) loss process whose mean burst is 2.2 frames reproduces all three when set to 22%, 64% and 45% of frames lost. `net_fakeloss` on this listen server therefore removed far more voice than its number: about 22%, 45% and 64% of frames at 5, 10 and 15. It applies to the packets in both directions, and `net_graph` itself reported 13%, 20% and 34%.

The speech take agrees. Under `net_fakeloss 10`, 38% of active speech frames correlate below 0.5 with the clean render (median 0.71). The app at 45% loss gives 37% (median 0.67), against 23% at 30% and 51% at 60%.

### 9. Jitter adds isolated late frames

With `net_fakelag 100` and `net_fakejitter 50`, about 1.4 extra events per second appear (3% of frames). They are single frames: 81% last one frame, against 51% for packet loss. Nine in ten are concealed and about one in ten plays as a short silence, consistent with a frame that arrived too late for playback.

### 10. The receiver re-times talk spurts and trims latency in 256-sample skips

The delay from source to output changes from one talk spurt to the next. In the baseline, alternate noise bursts came out about 240 ms apart in delay (2.02 s against 1.74–1.81 s), so the receiver shortens some silences between spurts and restores others. Within continuous voice, the delay falls by 2–8 ms per second in steps of about 5.8 ms, the length of 256 samples at 44.1 kHz. That happens in every take, including the clean baseline, so it is the receiver trimming buffered latency rather than an effect of jitter. `help voice_buffer_ms` describes the 100 ms voice buffer as avoiding "dropouts due to jitter and frame time differences".

## Model

| Stage | Setting | Basis |
| --- | --- | --- |
| Capture | left channel of stereo input; int16 | finding 6 |
| Voice gate | 20 ms frame RMS > −39.5 dBFS opens; 300 ms hold; closed frames not sent | finding 5 |
| Codec | Opus 24 kHz mono, VOIP, signal=voice, 32 kbps CBR, 20 ms, libopus 1.6.1 | finding 2; 2021 reverse engineering |
| Profile EQ | 0 dB to 7.7 kHz, −2.5 dB from 8.2 kHz, −4 dB at 11.5, −8 dB at 11.8 kHz (95-tap FIR at 24 kHz) | fitted to Set B, checked on Set A |
| Voice rate | 44.1 kHz | block-rate lines, post-decode clipping, SDK mix rate |
| Auto-gain | finding 3 law and finding 4 update; `voice_avggain 0.5`, `voice_maxgain 10`, `voice_scale 1` | Set B |
| Output stage | 3-tap `[0.1, 0.8, 0.1]` at 44.1 kHz, then `volume` | fitted to Set A's 13–18 kHz slope |
| Network | lost frames in Gilbert-Elliott bursts, mean 2.2 frames, concealed by Opus; jitter makes 3.2% of frames late at 50 ms (scaled linearly), one in ten silent | findings 8 and 9 |

## Results

**Set B.** Rendered by the app with each take's settings and `volume 0.15`. Each entry is level (dB re full scale), then samples within 5% of the clamp:

| Segment | Default: real / model | `voice_avggain 0.25` | `voice_scale 0.5` |
| --- | ---: | ---: | ---: |
| sine −24 dBFS (gain at the cap) | −6.9 / −7.1 dB, 0 / 0% | −6.9 / −7.1 dB, 0 / 0% | −16.1 / −16.1 dB |
| sine −12 dBFS | −2.1 / −2.1 dB, 42 / 42% | −1.8 / −1.8 dB, 50 / 50% | −10.1 / −10.3 dB |
| sine −1 dBFS | −2.2 / −2.1 dB, 42 / 42% | −1.8 / −1.8 dB, 50 / 50% | −13.4 / −13.4 dB |
| pink −18 dB RMS | −5.3 / −5.3 dB, 10 / 10% | −4.2 / −4.0 dB, 19 / 18% | −13.5 / −13.4 dB |
| pink −20 dB RMS, 10 s | −5.5 / −5.3 dB, 9 / 10% | −4.5 / −4.3 dB, 15 / 15% | −13.6 / −13.4 dB |
| pink steps −45/−18 | −8.1 / −7.9 dB, 5 / 6% | −6.8 / −6.7 dB, 10 / 10% | −16.3 / −16.0 dB |
| synthetic vowel −18 dB | −5.0 / −5.0 dB, 22 / 21% | −4.5 / −4.6 dB, 23 / 23% | −9.9 / −9.8 dB |
| sweep −20 dB | −4.1 / −4.4 dB, 16 / 9% | −4.1 / −4.4 dB, 16 / 8% | −12.9 / −13.4 dB |

**Speech.** The owner's raw speech was rendered by the app and compared spurt by spurt:

| Metric | Recording | Current model | Previous model |
| --- | ---: | ---: | ---: |
| 50 ms level error (mean ± SD) | — | +0.03 ± 0.47 dB | +1.34 ± 1.70 dB |
| 50 ms level correlation | — | 0.996 | 0.968 |
| Samples at the clamp | 8.4% | 9.1% | — |
| Overall level | −6.62 dB | −6.51 dB | — |

**Set C.** The app rendered the network test signal and was measured the same way as the takes:

| Take | App setting | Events per second, real / app | Frames lost, real / app | Events of 1 / 2 / 3 / 4+ frames, real / app |
| --- | --- | ---: | ---: | --- |
| loss5 | 22% | 4.3 / 4.4 | 17 / 16% | 51/23/17/9 / 54/25/11/10% |
| loss15 | 64% | 14.1 / 14.9 | 58 / 60% | 54/21/10/15 / 49/30/8/12% |
| jitter | 50 ms | 1.36 / 1.39 | 3.1 / 2.8% | 81/11/9/0 / 100/0/0/0% |
| combined | 45%, 50 ms | 12.0 / 10.6 | 43 / 41% | 57/25/9/9 / 54/24/9/13% |

**Set A.** From `pnpm compare:reference`:
- **Level tracking (half-second RMS deviation):** River 0.16 dB (left channel), Take It Off 0.07 dB. The previous model gave 0.55 and 0.42 dB.
- **Spectrum:** within ±1.4 dB from 40 Hz to 12 kHz, with 8–12 kHz sitting 0.9–1.4 dB low against this MP3. Within ±2 dB from 12 to 19 kHz.
- **Clip statistics:** higher than the MP3 shows (16–19% against 13%), as finding 7 predicts.
- **Receiver auto-gain off:** misses by 3–4 dB in level tracking and 20–60 dB above 12 kHz.

## What remains unverified

- **Steady tones.** The real gate also closes on steady tones after a while. A −36 dBFS sine closes after 0.4 s, −30 dBFS after about 1.1 s, and −24 dBFS near 2 s. Noise and sweeps at similar levels stay open. The modeled gate has no such adaptation; a floor-tracking version fitted the tones but closed wrongly on steady noise.
- **Talk-spurt timing and latency trimming.** The per-spurt delay changes (up to about 300 ms) and the 5.8 ms latency-trimming skips (finding 10) are not modeled. Renders keep the source timeline. The skip rate may depend on this single-PC setup.
- **High-band pure tones and the sweep's top octave.** The real encoder attenuates them more than libopus 1.6.1 (finding 2). This is attributed to a different libopus build in Steam, which is not confirmed.
- **Stereo capture.** Finding 6 is one capture chain (a stereo virtual cable). A physical microphone is mono either way.
- **Output stage.** The small post-clip roll-off may come from the recording chain rather than the game.
- **Legacy profiles and rooms.** Speex and CELT stand-ins, and room presets, are not validated against recordings.
- **Network settings.** Set C used simulated loss on a listen server, where `net_fakeloss` hits both directions. How a given real-world or one-way loss rate maps to lost frames is not measured, so the app's control is the share of frames lost. The jitter rate is calibrated at one setting (`net_fakejitter 50` with `net_fakelag 100`) and scaled linearly. Real internet loss was not recorded.

## Reproduce

```sh
python3 tests/testsignal/make_testsignal.py   # writes the v1 WAV and segment map (numpy, scipy)
python3 tests/testsignal/make_nettest.py      # the network test signal
pnpm install --frozen-lockfile
pnpm compare:reference 'path/to/tf2 VOIP test 2026 pure.mp3' 'path/to/Joni Mitchell - River.mp3' 'path/to/Ke$ha - Take It Off.mp3'
```

For a new take of the test signal:
1. Set `voice_loopback 1` and push-to-talk, with the voice settings under test.
2. Play the WAV into the microphone input at unity gain through a virtual cable.
3. Record only the game's output, losslessly.
4. Note the TF2 and Steam versions and the `volume` value.

Use single quotes around filenames containing `$` in PowerShell. The compare tool reads files locally, prints JSON and uploads nothing. A full run takes a few minutes.
