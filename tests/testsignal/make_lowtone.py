"""TF2 voice low-tone test signal v1 — deterministic (seeded). 48 kHz, 16-bit stereo (L = R).

Does TF2's voice output keep the DC offset that libopus 1.1.x adds to strong
content below ~60 Hz (tests/REFERENCE_2026.md, finding 18)? The tones hold
whole cycles and the bass line stays below 0.01% of full scale, so any offset
in a recording comes from the voice path.

- steady 30, 40 and 50 Hz tones at -24, -12 and -6 dBFS, 6 s each
- 60, 80, 100 Hz and 1 kHz controls at -12 dBFS
- the same low tones stepping between -18 and -6 dBFS every 0.5 s. Opus puts
  long steady tones into DTX; the steps keep its voice detector active, so
  these segments are coded frames.
- a sub-bass line under a melody, as in music
Each tone is followed by 2 s of silence, so Steam's gate closes and the next
one starts a fresh talk spurt.

    python3 make_lowtone.py      # needs numpy
"""
import numpy as np, json, wave
SR = 48000
rng = np.random.default_rng(20260927)
db = lambda L: 10 ** (L / 20)
def tone(f, dur, level_db, phase=0.0):
    t = np.arange(int(dur * SR)) / SR
    return db(level_db) * np.sin(2 * np.pi * f * t + phase)
def silence(dur): return np.zeros(int(dur * SR))
def fade(x, ms=20):
    n = min(len(x) // 2, int(ms / 1000 * SR)); w = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x = x.copy(); x[:n] *= w; x[-n:] *= w[::-1]; return x
def beeps():  # sync marker: three 1 kHz beeps, 60 ms, 0.5 s apart
    out = []
    for _ in range(3): out += [fade(tone(1000, 0.06, -12), 3), silence(0.44)]
    return np.concatenate(out)
def stepped(f, dur, low_db=-18, high_db=-6, step=0.5):
    # One continuous sine whose level alternates every `step` seconds. Each step
    # holds whole cycles, so the level changes at zero crossings and adds no DC;
    # an odd number of steps starts and ends quiet, so the end fades cancel too.
    assert abs(f * step - round(f * step)) < 1e-9
    t = np.arange(int(dur * SR)) / SR
    k = np.floor(t / step + 1e-9)
    return np.where(k % 2 == 0, db(low_db), db(high_db)) * np.sin(2 * np.pi * f * t)
def bassline(dur, level_db=-12, melody_db=-18):
    # Sub-bass notes (41.2, 49.0, 55.0, 43.7 Hz = E1, G1, A1, F1), 0.5 s each, under a
    # melody of plucked mid tones. Phase runs continuously across notes.
    n = int(dur * SR); t = np.arange(n) / SR
    notes = np.array([41.2, 49.0, 55.0, 43.7])
    f = notes[(t // 0.5).astype(int) % len(notes)]
    bass = db(level_db) * np.sin(2 * np.pi * np.cumsum(f) / SR)
    mel_notes = np.array([440.0, 523.3, 659.3, 587.3, 523.3, 392.0, 440.0, 493.9])
    k = (t // 0.25).astype(int)
    fm = mel_notes[k % len(mel_notes)]
    env = np.exp(-(t % 0.25) * 12)
    melody = db(melody_db) * env * np.sin(2 * np.pi * np.cumsum(fm) / SR)
    return bass + melody

segments, parts, cursor = [], [], 0
def add(name, x, **info):
    global cursor
    parts.append(x); segments.append({'name': name, 'start_s': round(cursor / SR, 6), 'dur_s': round(len(x) / SR, 6), **info}); cursor += len(x)
def gap(dur=2.0): add('gap', silence(dur))

add('sync_start', beeps(), note='3 x 1 kHz beeps at -12 dBFS')
gap()
for f in [30, 40, 50]:
    for L in [-24, -12, -6]:
        add(f'tone_{f}Hz_{L}dB', fade(tone(f, 6.0, L)), freq_hz=f, level_dbfs_peak=L)
        gap()
for f in [60, 80, 100, 1000]:
    add(f'tone_{f}Hz_-12dB', fade(tone(f, 6.0, -12)), freq_hz=f, level_dbfs_peak=-12, note='control')
    gap()
for f in [30, 40, 50]:
    add(f'stepped_{f}Hz_-18_-6dB', fade(stepped(f, 6.5)), freq_hz=f,
        note='level alternates -18 / -6 dBFS every 0.5 s; keeps the Opus voice detector active')
    gap()
add('bassline_melody', fade(bassline(10.0)), note='E1 G1 A1 F1 sub-bass at -12 dBFS, 0.5 s each, under a -18 dBFS melody')
gap(3.0)
add('sync_end', beeps(), note='end marker for clock-drift measurement')

x = np.concatenate(parts)
assert np.max(np.abs(x)) < 1.0, np.max(np.abs(x))
pcm = np.clip(np.round(x * 32767 + rng.uniform(-0.5, 0.5, len(x)) + rng.uniform(-0.5, 0.5, len(x))), -32768, 32767).astype('<i2')
st = np.stack([pcm, pcm], 1).reshape(-1)
with wave.open('tf2_voice_lowtone_v1.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
json.dump({'version': 1, 'sample_rate': SR, 'seed': 20260927, 'duration_s': round(len(x) / SR, 3), 'segments': segments},
          open('tf2_voice_lowtone_v1.json', 'w'), indent=1)
print('duration', round(len(x) / SR, 1), 's; peak', round(20 * np.log10(np.max(np.abs(x))), 2), 'dBFS; segments', len(segments),
      '; DC', f'{pcm.astype(float).mean():.3f} LSB')
