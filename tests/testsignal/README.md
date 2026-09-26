# Test signals

Deterministic signals for recording TF2 voice. Each script writes a 48 kHz, 16-bit stereo WAV (L = R) and a JSON segment map with every segment's exact position. The WAVs are not committed; regenerate them with numpy and scipy:

```sh
python3 make_testsignal.py   # tf2_voice_testsignal_v1.wav, 142.9 s
python3 make_nettest.py      # tf2_voice_nettest_v1.wav, 58.2 s
```

| Signal | SHA-256 (numpy 2.4 / scipy 1.17) | Use |
| --- | --- | --- |
| `tf2_voice_testsignal_v1` | `efd1c0bce69bfd87c70fff4ab591d9b165046f67ed992b8c0d185152eecf75e0` | receiver gain law, gate, codec (see [REFERENCE_2026.md](../REFERENCE_2026.md)) |
| `tf2_voice_nettest_v1` | `1b8b6ac07e344674f25d855301b457076501fd71368eef8d1ffbcb6666318633` | packet loss and jitter |

## Recording setup (both signals)

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

Use your own server with `sv_cheats 1`; the `net_fake*` commands are cheat-protected. Record one take per line, naming each file after its settings:

| Take | Console |
| --- | --- |
| baseline | `net_fakeloss 0; net_fakelag 0; net_fakejitter 0` |
| loss 5% | `net_fakeloss 5` |
| loss 15% | `net_fakeloss 15` |
| jitter | `net_fakeloss 0; net_fakelag 100; net_fakejitter 50` |
| combined | `net_fakeloss 10; net_fakelag 100; net_fakejitter 50` |

Some notes on these commands:
- `net_fakejitter` only acts together with `net_fakelag`.
- The commands affect all incoming game traffic. On a server hosted from the same game they may apply in both directions, so the voice loss can exceed the setting. The analysis measures the actual loss, so the exact figure does not matter.
- Reset all three to 0 afterwards.
- A `net_graph 1` screenshot during each take records the loss the game itself reports.
