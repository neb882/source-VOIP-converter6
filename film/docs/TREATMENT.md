# voice_loopback 1: treatment & style bible

Draft 1. A short narrated film about this project: what Team Fortress 2 does to a voice, and how that was measured. It is built the way [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video) and [neb882/pantheon-video](https://github.com/neb882/pantheon-video) are built:
- every frame is a deterministic function of time
- every word is synced
- each chapter is a plate with its own drawing idiom within one palette
- the renderer is pantheon-video's port of p(doom)'s engine

The narration is neural text-to-speech, made the way [neb882/pantheon-continuation1](https://github.com/neb882/pantheon-continuation1)'s was.

## The idea in one paragraph

**The film is narrated by a voice that goes through the thing it describes.** At chosen words, the soundtrack plays the narrator through this project's own emulator: the same `audio.js` and libopus 1.1.5 the site runs, rendered deterministically by `audio/mix.mjs`.
- **Loopback:** when the narrator says "voice loopback, one", the next sentence comes back through TF2 voice chat.
- **The gate:** when it explains the gate, the quiet words don't arrive.
- **DTX:** when it explains DTX, a steady tone turns into comfort noise at the moment the codec gives up on it.
- **The clamp:** when it explains the clamp, the narrator's own peaks are flattened.

Every claim is demonstrated on the soundtrack as it is made. The pictures draw that exact render: its 20 ms frames, its gate decisions, its gains and its clipped samples come from `data/chain.json`, written by the same process that made the audio you hear. Nothing on screen is illustrative when it could be measured.

## Tone

- **A lab film with a straight face.** The humour is in the precision: a hundred and twenty milliseconds *from before you started to speak*, sixty-two and a half milliseconds of silence *after every sentence*, a ceiling of *exactly* minus 16.48 dBFS. Deadpan labels, tiny footnotes, instrument readouts.
- **Nostalgia, measured.** Under the precision is why anyone would do this: the crushed, slightly late sound of friends in a TF2 lobby. The film never says so. It lets the loopback sentence land and moves on.
- **Dynamic.** Something is always moving. Cuts land on sentence boundaries and score downbeats, and moves ease into them with strong eases, holds and snaps. No floating screensaver motion.
- **Not slop.** No glowing waveforms in the void, no stock "audio visualizer" bars, no neon, no particle nebulae.
- **No Valve art.** No game footage, logos, characters, fonts or game audio. Team Fortress 2, Steam, Source TV and the console commands appear only as words, set in our own type. The look nods to the game's mid-century industrial era through its own idioms (instrument panels, engineering drawings, ticker tape), never through the game's art.

## Palette

- **ink** `#15110F` warm black, **ink2** `#1E1916` panels, **graphite** `#5B534C`, **ash** `#A39A8E`, **bone** `#EFE5D2` paper and type.
- **red** `#C4473A`: **the sender**, the voice as it leaves you. The trace is red from the microphone to the server.
- **blu** `#5F8FB0`: **the receiver**, the voice as it arrives. The trace turns blu where the listener's game takes it.
- **amber** `#E8A33D`: **overload**, used for one thing only: samples flattened by the clamp, and the clamp's own heat.
- The two team colours meet only in the packets: in `packets` a frame is bone, belonging to neither side yet.
- Some plates invert to **bone paper with ink lines**: the test-signal specimen, the gate drawing and the prediction envelope. Red and blu stay the same on both grounds.
- Only red, blu and amber may glow, and only where they carry signal.

## Typography

pantheon-video's families, used the same way:
- **Archivo** (width 62–125, weight 300–900) is the narrator's voice on screen. Its width follows the level: words set on loud passages spread, quiet ones condense.
- **IBM Plex Mono** is the machine: the console, labels, readouts and frame counts.
- **Bodoni Moda** is the sealed register, used once: the predictions and their hash.
- **Single-stroke fonts** are for anything written by a pen plotter or an instrument's stylus.

The craft rules carry over: kerning everywhere, typographic punctuation, no outlined or haloed type, and no glyphs outside the families.

## Kinetic type

The narration is not subtitled. Each sentence is set in the plate's own idiom, word by word as it is spoken (`Lyrics.wordProgress`, now narration words).
- In `gate`, words below the line are set in graphite behind the gate and never reach the far side.
- In `codec`, "a single byte" is one byte: eight bits, drawn as eight cells.
- In `receiver`, "flattened" is flattened: its top is cut off at the ceiling line, in amber.

Stressed numbers are full-frame, and the connective words are small. A word lands at its `start` and completes by its `end`. Anticipation is a faint ghost, never a highlight ahead of the voice. Keep text at least 96 px from the frame edge.

## Motifs

1. **The trace.** One oscilloscope hairline running through every plate: the narrator's actual waveform at that moment, from the soundtrack. It is red from the microphone to the server and blu after. When the soundtrack is processed, the trace shows the processed signal: gated frames missing, DTX frames as comfort-noise stipple, clamped peaks cut flat in amber.
2. **The frame grid.** The 20 ms frame is the film's unit of time. It appears in each plate in that plate's material: tiles, punch holes, relay lamps, stamps, ticker marks, coloured as the site's codec lane colours them (coded, DTX, not sent, lost).
3. **The console.** Each chapter begins with the console line that exposes its mechanism, typed in mono: `] voice_loopback 1`, `] sv_voicecodec`, `] tv_record`, `] voice_scale 2`, `] volume 0.15`.
4. **The level.** A needle and a dBFS readout staged in each plate in its own idiom. It reads the level of what you are hearing, from `data/chain.json`.
5. **Three beeps.** The test signal's sync marker: three 1 kHz beeps, 60 ms long, half a second apart. They are the first and last sound of the film, and three points of light are its first and last frame, so the film loops.

## Audio design

- **Narration:** Azure Speech Studio neural TTS, 24 kHz mono, which happens to be Steam's own codec rate (`narration/AZURE.md`).
- **Processing (`audio/mix.mjs`):** the cue segments in `narration/script.md` run through the emulator in Node with the settings each cue names.
  - `loopback`: the default Steam chain.
  - `gate`: the words attenuated below the gate first, so they don't pass.
  - `clamp`: `voice_scale 2`.
  - `gap`: the second phrase appended to the first, 62.5 ms apart, as finding 21 describes.
  - `dtx`: a steady 1 kHz tone at −36 dBFS through the chain, which Opus turns into comfort noise after about 0.4 s (finding 13).

  The mix crossfades from the clean narration into each processed segment and back.
- **Score (`audio/score.mjs`):** sparse and deterministic, made from the test signal's own material at a fixed tempo:
  - a sub-bass drone
  - the sync beeps as a clock
  - pink-noise swells under the transitions
  - the sine staircase under `signal`

  It sits under the narration and ducks for it. Chapter starts snap to its downbeats.
- **Data (`data/chain.json`):** for every processed segment, the frame log, per-block gains, clipped samples and levels. For the whole mix, envelopes for the visuals. The pictures read only this; they never approximate the audio.

## Plates

| id | chapter | idiom |
|---|---|---|
| `open` | Voice loopback | oscilloscope and console, black |
| `signal` | The test signal | engraved specimen sheet on bone |
| `gate` | The gate | engineering drawing of a sluice gate on bone |
| `codec` | The codec | Opus frame anatomy, punched tape, a lineup of releases |
| `packets` | The packets | stenograph ticker tape |
| `receiver` | The receiver | flyball governor and hydraulic clamp |
| `gap` | The gap | pneumatic tube queue |
| `result` | The result | two traces locked together, a falling error readout, the app |
| `predict` | The prediction | sealed envelope, six cards, the hash |

### `open`: "this is what comes back"

- **Frame 0:** black, with three points of light on a scope's graticule: the sync beeps, one per half second.
- **The console:** it types `] voice_loopback 1`, and the Enter lands on the narrator's "one".
- **The trace:** the narrator's trace draws red across the scope. On "And this is what comes back", it runs into a patch cable that loops round the frame and comes back in blu, late by the chain's own latency and crushed: the clamped samples are cut flat in amber.
- **Title:** voice_loopback 1, set in Archivo 900 as a console value, the "1" in blu.

### `signal`: the specimen

- **The sheet:** the test signal laid out on bone paper like a type specimen or a tuning chart.
- **The elements:** each is engraved as it is named, on its word: the sine staircase in six-decibel steps, the noise bursts, the sweep from 20 Hz to 20 kHz, the clicks, and the vowel's glottal pulses.
- **The ruler:** a 142.9 s ruler runs along the bottom with the segment names in mono.
- **"Played into the game":** the sheet folds into a diagram of the recording loop: media player → virtual cable → TF2 → OBS → FLAC.

### `gate`: the sluice

- **The drawing:** an engineering drawing on bone of a sluice gate across a channel. The water level is the narrator's level, and the gate's sill sits at −39.5 dBFS.
- **The frames:** 20 ms lock chambers.
- **"So if I say this quietly":** those words are set small in graphite. Their water never clears the sill, and their chambers are stamped NOT SENT.
- **"six frames before it":** a bracket reaches back six chambers: 120 MS · SENT BEFORE YOU SPOKE.
- **"four hundred and forty":** the gate stays up for 22 chambers after the last loud one.

### `codec`: anatomy of a frame

- **The frame:** one Opus frame drawn as an exploded diagram: the TOC byte (config 13: hybrid, super-wideband, 20 ms), then the SILK and CELT layers.
- **The rate:** frames stream past as punched tape at fifty a second.
- **"Which Opus?":** the libopus releases from 1.1 to 1.6.1 stand in a row as rack units, each stamping its DTX decisions onto a strip under Steam's own strip. Only 1.1.x lines up: 627 of 693.
- **The DTX demo:** a spectrogram engraves the steady tone. At 0.38 s its lines break into the stipple of comfort noise, and one byte, eight cells, drops onto the tape.

### `packets`: the record

- **The tape:** a Source TV demo as a stenograph's paper tape running under the stylus.
- **The marks:** every one of the 5,109 frames is a mark. The twenty talk spurts are bursts, and the 693 single-byte frames are hollow.
- **The rhythm:** voice arrives every 4 ticks (60 ms), and the tape advances in exactly those steps.
- **The trace:** it turns from red to bone here, in the server's hands.

### `receiver`: the governor and the clamp

- **The governor:** a flyball governor, the steam engine's regulator, is the auto-gain. Its arms rise and fall once per 128-sample block, driven by the render's real gains.
- **"enters that arithmetic twice":** a second governor gear engages.
- **The clamp:** `] voice_scale 2` is typed, and a hydraulic press lowers to the ceiling line at 16-bit full scale times the volume. The narrator's peaks are cut flat against it in amber.
- **"minus sixteen and a half decibels":** the readout sets 0.15 × 32767/32768 = −16.48 dBFS.

### `gap`: the queue

- **The tube:** a pneumatic tube runs to the listener. Talk spurts travel as capsules, each followed by a thin 62.5 ms spacer, the silence record.
- **"It appends you":** the next capsule arrives while the last is still in the receiver's hopper, so it docks straight behind it, and the gap on the timeline below closes.

### `result`: two traces

- **The traces:** the real recording and the render, locked together.
- **The error readout:** it rolls down through the project's history, 1.70 → 0.47 → 0.37 dB (50 ms level error, SD), then 0.14 dB on Steam's own packets.
- **"It runs in a browser":** a quick montage of the site itself: live, video, demo.

### `predict`: sealed

- **The envelope:** a bone envelope, addressed in Bodoni: PREDICTIONS · SIX TAKES NOT YET RECORDED.
- **The cards:** six cards, P1–P6, each with its console line, slide in under the narrator's list.
- **The seal:** the SHA-256 of `predictions.json` is pressed into the wax.
- **The loop:** the console returns, `] voice_loopback 1`, and the scope's three beeps close the film on frame 0.

## Technical conventions

- **Engine:** pantheon-video's (three.js, bun, Vite) with deterministic frames, stills and contact sheets, type QA, adaptive motion blur, and GPU rendering on an RTX 5070 with NVENC drafts.
- **Timing:** the narration is aligned word by word; before it exists, `scripts/placeholder.mjs` lays the script at 150 words a minute.
- **The two dependencies on the repository are its own code:**
  - `audio/mix.mjs` runs `audio.js` and the vendored codecs.
  - `scripts/facts.mjs` reads the numbers the film shows from the repository's files.
