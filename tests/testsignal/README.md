# Test signals

Deterministic signals for recording TF2 voice. Each script writes a 48 kHz, 16-bit stereo WAV (L = R) and a JSON segment map with every segment's exact position. The WAVs are not committed; regenerate them with numpy and scipy (`make_lowtone.py` needs numpy only):

```sh
python3 make_testsignal.py   # tf2_voice_testsignal_v1.wav, 142.9 s
python3 make_nettest.py      # tf2_voice_nettest_v1.wav, 58.2 s
python3 make_lowtone.py      # tf2_voice_lowtone_v1.wav, 147.5 s
```

| Signal | SHA-256 (numpy 2.4 / scipy 1.17) | Use |
| --- | --- | --- |
| `tf2_voice_testsignal_v1` | `efd1c0bce69bfd87c70fff4ab591d9b165046f67ed992b8c0d185152eecf75e0` | receiver gain law, gate, codec (see [REFERENCE_2026.md](../REFERENCE_2026.md)) |
| `tf2_voice_nettest_v1` | `1b8b6ac07e344674f25d855301b457076501fd71368eef8d1ffbcb6666318633` | packet loss and jitter |
| `tf2_voice_lowtone_v1` | `9e8f79b71e4063c7a79b9fd547c92fd219d7144811c3a23acd1304aeed4944c3` | DC from comfort noise below 60 Hz ([finding 18](../REFERENCE_2026.md)) |

## Recording setup (all signals)

1. Play the WAV at 100% player volume into a virtual cable that TF2 uses as its microphone.
2. In TF2 set `voice_loopback 1` and keep voice settings at their defaults unless a take says otherwise.
3. Record only the game's output, losslessly (e.g. OBS, then export FLAC).
4. Stand somewhere quiet, and note the TF2 `volume` value.

## Network takes (`tf2_voice_nettest_v1`)

The segments:
- continuous pink noise (12 s)
- a 300–3300 Hz chirp (10 s)
- a synthetic voice with gliding pitch and changing vowels (12 s)
- eight 1.2 s noise bursts, each its own talk spurt

Sync beeps mark the start and end.

The levels are chosen so that Steam's voice gate stays open, the receiver auto-gain sits at its fixed +20 dB cap and nothing clips. Every lost or concealed 20 ms frame then shows against the known waveform.

The `net_fake*` commands are cheat-protected, so use your own server with `sv_cheats 1`. On a server you host from the game (a listen server), your own traffic normally bypasses the network layer. `net_fakelag` is documented to include that loopback path, but `net_fakeloss` is not.

**Setup on a listen server:**
1. Run `find usesockets`. If `net_usesocketsforloopback` exists, set it to 1 before loading the map, then load the map (`map ctf_2fort`, or `retry` if one is already running).
2. Set `sv_cheats 1` and `voice_loopback 1`, and turn on `net_graph 1`.
3. Run a 30-second check: set `net_fakeloss 30` and talk. Your echo should turn choppy and `net_graph` should report loss. If it stays clean, the loss is not reaching the voice path; use a dedicated server instead (connect with `connect 127.0.0.1`).
4. Set `net_fakeloss 0` again.

Record one take per line, naming each file after its settings:

| Take | Console |
| --- | --- |
| baseline | `net_fakeloss 0; net_fakelag 0; net_fakejitter 0` |
| loss 5% | `net_fakeloss 5` |
| loss 15% | `net_fakeloss 15` |
| jitter | `net_fakeloss 0; net_fakelag 100; net_fakejitter 50` |
| combined | `net_fakeloss 10; net_fakelag 100; net_fakejitter 50` |

Some notes on these commands:
- `net_fakejitter` varies the `net_fakelag` delay, so it only acts together with it.
- The commands affect all incoming game traffic. On a listen server they may apply in both directions, so the voice loss can exceed the setting. The analysis measures the actual loss, so the exact figure does not matter.
- Reset all three to 0 afterwards.
- A `net_graph 1` screenshot during each take records the loss the game itself reports.

## Low-tone takes (`tf2_voice_lowtone_v1`)

In the model, the comfort noise that replaces a steady tone below about 60 Hz is nearly DC (finding 18). At default settings the render of a steady 50 Hz tone shifts by up to 40% of full scale. These takes show whether TF2's output keeps that offset or removes it.

The signal (147.5 s) contains:
- sync beeps at the start and end
- steady 30, 40 and 50 Hz tones at −24, −12 and −6 dBFS, 6 s each
- controls at 60, 80, 100 Hz and 1 kHz, −12 dBFS
- 30, 40 and 50 Hz tones stepping between −18 and −6 dBFS every 0.5 s. The steps keep Opus's voice detector active, so these are mostly coded frames rather than comfort noise.
- a sub-bass line (E1, G1, A1, F1) under a melody, like music

Each tone is followed by 2 s of silence, so every tone is its own talk spurt. The file itself has no DC offset: every tone averages to zero, and the bass line to below 0.01% of full scale.

Record two takes with the recording setup above, each as its own lossless file:

| Take | Console | What it shows |
| --- | --- | --- |
| default | defaults (`voice_maxgain 10`) | the offset as players hear it. The auto-gain boosts and clips these tones, which by itself can shift the mean. |
| maxgain 1 | `voice_maxgain 1` | the same without boosting or clipping, so any offset comes from the codec |

Reset `voice_maxgain 10` afterwards.

Extra care, because this test is about the lowest frequencies and the mean level:
- Turn off anything that filters or processes the audio: Windows "audio enhancements", "loudness equalization" and spatial sound on the virtual cable and on the game's output device, EQ or normalization in the media player, and filters on the OBS source.
- Keep the player at 100% and the file at 48 kHz, as provided.
- Pick a quiet spot on the map, as before. Game sounds barely affect a mean level, but less is better.

If the game keeps the offset, the default take's steady 50 Hz tones look visibly lifted off the centre line in an editor, and the louder 30 Hz tones visibly lowered. If it removes the offset, every segment stays centred.
