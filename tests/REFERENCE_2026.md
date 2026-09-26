# 2026 TF2 voice recordings: what they show

Measured locally from 2026-09-24 to 2026-09-27. No recording, source music or derived audio is distributed with this project. The exceptions are the synthetic test signals, whose generators are in [`tests/testsignal/`](testsignal/).

Four sets of recordings were made on private servers, playing files into TF2's microphone input through a virtual audio cable:

- **Set A** (music): one MP3 of two songs, recorded with `voice_loopback 1`.
- **Set B**: a calibrated test signal recorded under four settings, plus the owner's own speech, all with `voice_loopback 1`. All are lossless FLAC.
- **Set C**: a one-minute network test signal recorded under simulated packet loss and jitter, plus the owner's speech under loss. All are lossless FLAC.
- **Set D**: the test signal sent from one PC to a dedicated server with SourceTV. The set has three parts: the demo, holding Steam's own voice packets; the sender's loopback output; and the output of a second account on a second PC.

Set B identified the receiver law, and Set A and the speech take validate it. Set C measured what loss and jitter do to the voice. Set D separates the sender from the receiver: its packets show exactly what Steam's encoder sent, and the recordings show what the game made of them.

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

### Set D: SourceTV packets and two listeners

The owner ran a TF2 dedicated server with `sv_cheats 1`, `sv_alltalk 1` and SourceTV. Two setups joined it:
- **PC A** (account A, with `voice_loopback 1`) played `tf2_voice_testsignal_v1.wav` through the virtual cable and recorded its own game output.
- **PC B** (account B) recorded its game output as a remote listener.

Both recordings are lossless FLAC (48 kHz, 24-bit).

| File | Content | Duration | SHA-256 |
| --- | --- | --- | --- |
| voicetest.dem (in voicetest_demo.zip) | SourceTV demo, ctf_2fort, 15 970 ticks | 239.5 s | `7e6f13b2a01ef793120a1135da61e7e18617f34c0307dfba0bdf24bc3e7db526` |
| user_A_recording.flac | sender's loopback output | 147.6 s | `e61d7b97a5363b8ff1f18fe4beb102b38c30da88a4f72b6b38a27f47def924ee` |
| user_B_recording.flac | remote listener's output | 154.5 s | `3adc5fcbb49c57d8bed19229778aa2ef088527dab5ccf056f5b5c2b3984f327c` |

The demo holds 1 816 voice messages from one speaker:
- 5 109 Opus frames in 20 talk spurts
- no sequence gaps
- one end-of-transmission marker after each talk spurt

[`tests/demovoice/`](demovoice/) extracts and decodes them.

The decoded packets were aligned to the test signal spurt by spurt by cross-correlation. Each recording was aligned to the packets in 100 ms windows every 50 ms, following the delay.

Output levels imply `volume` 0.147 on PC A (the owner's `volume 0.15`) and about 0.077 on PC B. Game ambience sits near −35 dBFS in A and −40 dBFS in B, so quieter voice output cannot be checked against the recordings.

## Findings

### 1. The output ceiling is int16 full scale times `volume`

With the default settings, loud input comes out hard-clipped at a 99.9th-percentile ceiling of exactly 0.15 × 32767/32768 (−16.48 dBFS). That is int16 full scale times the owner's `volume 0.15`. The music recording's −16.4 dBFS ceiling is the same `volume`, not headroom in the voice path.

### 2. Sender and codec are linear; the codec is 24 kHz Opus in SILK/CELT hybrid mode

With `voice_maxgain 1` the receiver never boosts, so that take shows the sender and codec on their own:
- **Levels:** sines come out at +0.5 dB against the file from −24 to −1 dBFS. The sender has no gain control or noise suppression; 10 s of steady pink noise does not decay.
- **Spectrum:** libopus 1.6.1 at 24 kHz, VOIP, `signal=voice` reproduces the take's hybrid structure. Finding 14 measures the remaining difference, up to ±1 dB, directly against Steam's packets.
- **Profile EQ:** refitted to this take at the time. Finding 14 replaces it with a fit to Steam's own packets.
- **Pure tones:** 8, 8.5, 11 and 11.5 kHz tones come out 10–18 dB lower than libopus 1.6.1 made them. Steam's packets show why: its encoder sent them as DTX comfort noise (finding 13).

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
- **Closed frames are not sent;** the receiver hears silence.

Set D refines the timing (finding 12). The gate sends a pre-roll before each onset and holds for 440 ms, not 300. For about the last 240 ms of that hold the encoder sends DTX comfort noise, so the audible tail is about 200 ms of coded sound plus a quieter fade. The WebRTC VAD in every mode fits worse than threshold and hold.

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

### 11. Steam's packets: Opus 24 kHz hybrid, VBR, DTX, no in-band FEC

Every frame in the demo is a 20 ms Opus packet with TOC configuration 13: hybrid, super-wideband (12 kHz band), mono. The stream's rate field says 24 000.
- **VBR:** coded frames carry 34–189 bytes (98% between 40 and 105). That is about 32 kbps on noise, 26 kbps on the synthetic vowel and 29.9 kbps averaged over all coded frames.
- **DTX:** 693 of the 5 109 frames are 1-byte packets. The decoder answers these with comfort noise.
- **No in-band FEC:** the LBRR flag is never set.
- **Spurt ends:** each talk spurt ends with Steam's end-of-transmission marker, which resets the receiver's decoder, and a silence record of 62.5 ms (sometimes 31 ms).

libopus 1.6.1 reproduces Steam's DTX decisions only at complexity 6 or below:

| Setting | DTX frames in both Steam and libopus | Steam only | libopus only |
| --- | ---: | ---: | ---: |
| Complexity ≤ 6 | 588 | 105 | 14 |
| Complexity 7–10 | 97 | 596 | 4 |

At complexity 6 or below libopus decides from the SILK voice detector. From complexity 7 its tonality analysis decides, and that analysis entered libopus in 1.3. Steam's encoder therefore likely predates 1.3 or runs at a low complexity.

Steam spends up to 15% more bytes than libopus 1.6.1 at 32 kbps on the same input, about 10% more on noise and the vowel. A 34 kbps target matches its total within 0.2% and each segment type within about 8%.

A client demo made with `record` keeps the voice messages but not their payloads. That held for both client demos checked.

### 12. The gate sends 120 ms of pre-roll and holds 440 ms

Talk spurts start on a 31.25 ms grid, 115–152 ms before a loud onset, so the frames before the onset go out too. Spurts end 425–485 ms after the last loud frame.

A 20 ms frame model reproduces this. A frame above −39.5 dBFS RMS is sent with the 6 frames before it and the 22 after it. That puts both boundaries of 16 of the 18 spurts within 4 frames of Steam's, and most within 1–2. The exceptions are pure tones at 11.8–12 kHz, which Steam's gate and the model's (on the 24 kHz signal) treat differently.

A pause shorter than the hold plus the pre-roll (560 ms) keeps the spurt going. Each new talk spurt starts a fresh encoder and decoder.

### 13. DTX is why steady tones fade

Opus's voice detector marks a steady tone inactive after a while. The encoder then sends DTX packets, and the decoder plays comfort noise 7–20 dB below the tone. The same applies to other steady signals. That was the unexplained "gate adaptation" on steady tones in Set B:

| Segment | First DTX frame, Steam / model | DTX frames, Steam / model |
| --- | ---: | ---: |
| sine −36 dBFS | 0.42 / 0.40 s | 75 / 77 |
| sine −30 dBFS | 1.16 / 1.20 s | 40 / 39 |
| sine −24 to −1 dBFS | none / none | 0 / 0 |
| 8, 8.5 and 11 kHz tones | — | 41, 47, 42 / 40, 47, 40 |
| pink noise −36 to −18 dB | — | 19 / 16 |
| synthetic vowel | — | 0 / 0 |

Speech-like material keeps the detector active; steady tones and very even noise do not.

### 14. The high-band difference is on the sender; the receiver is flat

Decoding Steam's packets and passing them through the receiver model matches recording A within 0.1 dB per band from 100 Hz to 11.5 kHz. The receiver model here is the 44.1 kHz auto-gain, the `[0.1, 0.8, 0.1]` output stage and `volume`. Median 50 ms levels match within ±0.3 dB on segments more than 15 dB above the game ambience. The receiver adds no EQ.

Against libopus 1.6.1 on the same input, Steam's decoded packets have:
- 0.5–1.1 dB more energy from 1.5 kHz up to the 8 kHz SILK/CELT crossover
- 1.0 dB less in the CELT band above it
- a roll-off from 11.2 kHz to −7 dB at 11.8 kHz (the capture resampler)

The earlier profile EQ trimmed 2.5 dB above 8.2 kHz and nothing below. That left the old model 1–2 dB dull from 2 to 12 kHz against recording A. It is replaced by an EQ fitted to the packets. Moving the roll-off in front of the encoder fits worse, so the whole EQ stays after the decoder.

### 15. A remote listener hears the same chain

Recording B divided by recording A is flat within ±0.2 dB from 100 Hz to 11 kHz on pink noise. B is 6 dB lower overall, which is its `volume`. Both recordings drift by −0.4 ms/s against the sender between the latency trims of finding 10.

Both also re-time talk spurts:
- In A, some spurts start up to 330 ms early against their neighbours, shortening the silence before them.
- In B the spurt-to-spurt changes stay within about 90 ms.

## Model

| Stage | Setting | Basis |
| --- | --- | --- |
| Capture | left channel of stereo input; int16 | finding 6 |
| Voice gate | a 20 ms frame with RMS > −39.5 dBFS is sent with the 6 frames before it and the 22 after it; other frames not sent; a fresh encoder and decoder per talk spurt | findings 5 and 12 |
| Codec | Opus 24 kHz mono, VOIP, signal=voice, VBR at a 34 kbps target, DTX, complexity 6, 20 ms, libopus 1.6.1 | findings 11 and 13 |
| Profile EQ | 0 dB to 1 kHz, rising to +1 dB from 4 to 7.8 kHz, −1 dB from 8.1 to 11 kHz, then −2.5 dB at 11.4, −4 dB at 11.5 and −6.5 dB from 11.75 kHz (95-tap FIR at 24 kHz, after decoding) | finding 14 |
| Voice rate | 44.1 kHz | block-rate lines, post-decode clipping, SDK mix rate |
| Auto-gain | finding 3 law and finding 4 update; `voice_avggain 0.5`, `voice_maxgain 10`, `voice_scale 1` | Set B |
| Output stage | 3-tap `[0.1, 0.8, 0.1]` at 44.1 kHz, then `volume` | fitted to Set A's 13–18 kHz slope |
| Network | lost frames in Gilbert-Elliott bursts, mean 2.2 frames, concealed by Opus; jitter makes 3.2% of frames late at 50 ms (scaled linearly), one in ten silent | findings 8 and 9 |

## Results

**Set B.** Rendered by the app with each take's settings and `volume 0.15`. Each entry is level (dB re full scale), then samples within 5% of the clamp:

| Segment | Default: real / model | `voice_avggain 0.25` | `voice_scale 0.5` |
| --- | ---: | ---: | ---: |
| sine −36 dBFS (DTX after 0.4 s) | −26.2 / −26.8 dB | −25.6 / −26.8 dB | −32.6 / −35.8 dB |
| sine −30 dBFS (DTX after 1.2 s) | −14.9 / −14.7 dB | −14.6 / −14.7 dB | −23.5 / −23.8 dB |
| sine −24 dBFS (gain at the cap) | −6.9 / −7.0 dB, 0 / 0% | −6.9 / −7.0 dB, 0 / 0% | −16.1 / −16.1 dB |
| sine −12 dBFS | −2.1 / −2.1 dB, 42 / 42% | −1.8 / −1.8 dB, 50 / 50% | −10.1 / −10.3 dB |
| sine −1 dBFS | −2.2 / −2.1 dB, 42 / 42% | −1.8 / −1.8 dB, 50 / 50% | −13.4 / −13.4 dB |
| pink −18 dB RMS | −5.3 / −5.3 dB, 10 / 10% | −4.2 / −3.9 dB, 19 / 18% | −13.5 / −13.5 dB |
| pink −20 dB RMS, 10 s | −5.5 / −5.5 dB, 9 / 8% | −4.5 / −4.5 dB, 15 / 13% | −13.6 / −13.7 dB |
| pink steps −45/−18 | −8.1 / −8.1 dB, 5 / 5% | −6.8 / −6.8 dB, 10 / 9% | −16.3 / −16.3 dB |
| synthetic vowel −18 dB | −5.0 / −5.0 dB, 22 / 21% | −4.5 / −4.6 dB, 23 / 22% | −9.9 / −9.8 dB |
| sweep −20 dB | −4.1 / −4.2 dB, 16 / 11% | −4.1 / −4.2 dB, 16 / 10% | −12.9 / −13.2 dB |

The model before Set D put the −36 dBFS sine at −19.1 dB and the −30 dBFS sine at −13.1 dB, because it had no DTX.

**Speech.** The owner's raw speech was rendered by the app and compared spurt by spurt. The spectrum error is the largest band deviation from 100 Hz to 11.5 kHz:

| Metric | Recording | Current model | Before Set D | Before Set B |
| --- | ---: | ---: | ---: | ---: |
| 50 ms level error (mean ± SD) | — | +0.12 ± 0.38 dB | +0.03 ± 0.47 dB | +1.34 ± 1.70 dB |
| 50 ms level correlation | — | 0.997 | 0.996 | 0.968 |
| Spectrum error | — | 0.3 dB | 1.7 dB (above 3 kHz) | — |
| Samples at the clamp | 8.4% | 9.1% | 9.1% | — |
| Overall level | −6.62 dB | −6.50 dB | −6.51 dB | — |

**Set D.** The app against Steam's packets and recording A:
- **Talk spurts:** 18 against Steam's 20. Steam closes and reopens where the model runs on across a 440–500 ms gap. Both boundaries of 16 of 18 spurts fall within 4 frames. 98.7% of 20 ms frames agree on sent or not sent.
- **DTX and bytes:** 571 DTX frames against 693. Nearly all of the difference is in the 11.5–12 kHz tones. Bytes per coded frame are within 8% on every segment type.
- **Codec spectrum against the packets:** within ±0.3 dB from 0 to 11.4 kHz on noise.
- **Full render against recording A:** spectrum within ±0.3 dB from 100 Hz to 11.8 kHz on noise and the vowel, where the model before Set D was 1–2 dB low above 2 kHz. Median segment levels are within ±0.2 dB on segments more than 15 dB above the ambience.

**Set C.** The app rendered the network test signal and was measured the same way as the takes:

| Take | App setting | Events per second, real / app | Frames lost, real / app | Events of 1 / 2 / 3 / 4+ frames, real / app |
| --- | --- | ---: | ---: | --- |
| loss5 | 22% | 4.3 / 4.4 | 17 / 16% | 51/23/17/9 / 54/25/11/10% |
| loss15 | 64% | 14.1 / 14.9 | 58 / 60% | 54/21/10/15 / 49/30/8/12% |
| jitter | 50 ms | 1.36 / 1.39 | 3.1 / 2.8% | 81/11/9/0 / 100/0/0/0% |
| combined | 45%, 50 ms | 12.0 / 10.6 | 43 / 41% | 57/25/9/9 / 54/24/9/13% |

**Set A.** From `pnpm compare:reference`, left channel:
- **Level tracking (half-second RMS deviation):** River 0.10 dB, Take It Off 0.09 dB. The model before Set D gave 0.16 and 0.07 dB; the one before Set B gave 0.55 and 0.42 dB.
- **Spectrum:** within ±0.5 dB from 80 Hz to 12 kHz (River −0.95 dB at 40–80 Hz). Before Set D, 8–12 kHz sat 0.9–1.4 dB low. From 12 to 16 kHz it is 0.6–0.9 dB low; from 16 to 19 kHz it is within 2.5 dB.
- **Clip statistics:** higher than the MP3 shows (16–18% against 13%), as finding 7 predicts.
- **Receiver auto-gain off:** misses by 3–4 dB in level tracking and 20–60 dB above 12 kHz.

## What remains unverified

- **Talk-spurt timing and latency trimming.** Renders keep the source timeline; none of the following is modeled:
  - the per-spurt delay changes, up to about 330 ms
  - the 5.8 ms latency-trimming skips (finding 10)
  - the −0.4 ms/s drift (finding 15)
  
  They occur with a remote listener on a dedicated server too (Set D).
- **Steam's libopus build.** The model uses libopus 1.6.1 at the settings that match Steam's packets best (finding 11). Steam's own build is not known. Pure tones at 11.5–12 kHz fall into DTX in Steam's encoder but not in the model.
- **Comfort noise at the receiver.** Steam's receiver is assumed to decode DTX frames as libopus does. The recordings' ambience hides that level.
- **Stereo capture.** Finding 6 is one capture chain (a stereo virtual cable). A physical microphone is mono either way.
- **Output stage.** The small post-clip roll-off may come from the recording chain rather than the game.
- **Legacy profiles and rooms.** Speex and CELT stand-ins, and room presets, are not validated against recordings.
- **Network settings.** Set C used simulated loss on a listen server, where `net_fakeloss` hits both directions. How a given real-world or one-way loss rate maps to lost frames is not measured, so the app's control is the share of frames lost. The jitter rate is calibrated at one setting (`net_fakejitter 50` with `net_fakelag 100`) and scaled linearly. Set D ran on a LAN with no loss. Real internet loss was not recorded.

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

For SourceTV packets, see [`tests/demovoice/`](demovoice/README.md).

Use single quotes around filenames containing `$` in PowerShell. The compare tool reads files locally, prints JSON and uploads nothing. A full run takes a few minutes.
