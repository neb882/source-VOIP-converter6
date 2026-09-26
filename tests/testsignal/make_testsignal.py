"""TF2 voice test signal v1 — deterministic (seeded). 48 kHz, 16-bit stereo (L = R).

Each segment probes one property of the TF2 voice path; the segment map is written
alongside the WAV so recordings can be analyzed against exact sample positions.
The 2026 takes in tests/REFERENCE_2026.md were recorded from this exact file.

    python3 make_testsignal.py      # needs numpy and scipy

With numpy 2.4 / scipy 1.17 the WAV's SHA-256 is
efd1c0bce69bfd87c70fff4ab591d9b165046f67ed992b8c0d185152eecf75e0 (142.9 s, -1 dBFS peak).
"""
import numpy as np, json, wave
from scipy import signal
SR = 48000
rng = np.random.default_rng(20260926)
db = lambda L: 10 ** (L / 20)
def sine(f, dur, level_db): t = np.arange(int(dur * SR)) / SR; return db(level_db) * np.sin(2 * np.pi * f * t)
def pink(dur, rms_db):
    n = int(dur * SR); w = rng.standard_normal(n)
    b, a = [0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.522189400]
    p = signal.lfilter(b, a, w); p = signal.sosfilt(signal.butter(2, 25, 'high', fs=SR, output='sos'), p)
    return p / np.sqrt(np.mean(p ** 2)) * db(rms_db)
def silence(dur): return np.zeros(int(dur * SR))
def fade(x, ms=5):
    n = min(len(x) // 2, int(ms / 1000 * SR)); w = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x = x.copy(); x[:n] *= w; x[-n:] *= w[::-1]; return x
def beeps():  # sync marker: three 1 kHz beeps, 60 ms, 0.5 s apart
    out = []
    for _ in range(3): out += [fade(sine(1000, 0.06, -12), 3), silence(0.44)]
    return np.concatenate(out)
def vowel(dur, f0=115, level_db=-18):  # synthetic voiced speech: glottal pulses through formants, syllable envelope
    n = int(dur * SR); t = np.arange(n) / SR
    f0t = f0 * (1 + 0.08 * np.sin(2 * np.pi * 0.7 * t)); ph = np.cumsum(f0t) / SR
    src = signal.sawtooth(2 * np.pi * ph, 0.02)
    out = np.zeros(n)
    for fc, bw, g in [(700, 90, 1.0), (1150, 110, 0.6), (2600, 160, 0.3), (3500, 250, 0.15)]:
        b, a = signal.iirpeak(fc, fc / bw, fs=SR); out += g * signal.lfilter(b, a, src)
    env = np.clip(np.sin(np.pi * ((t * 3.2) % 1)) ** 0.6, 0, 1) * (0.55 + 0.45 * np.sin(2 * np.pi * 0.37 * t) ** 2)
    out *= env; return out / np.sqrt(np.mean(out ** 2)) * db(level_db)

segments, parts, cursor = [], [], 0
def add(name, x, **info):
    global cursor
    parts.append(x); segments.append({'name': name, 'start_s': round(cursor / SR, 6), 'dur_s': round(len(x) / SR, 6), **info}); cursor += len(x)

add('sync_start', beeps(), note='3 x 1 kHz beeps at -12 dBFS')
add('gap', silence(1.0))
for L in [*range(-60, -5, 6), -1]:   # static gain curve with a steady sine (crest 3 dB)
    add(f'sine1k_{L}dB', sine(1000, 2.0, L), level_dbfs_peak=L)
add('gap', silence(1.0))
for L in range(-66, -17, 6):  # static gain curve with pink noise (crest ~12 dB -> clipping behavior)
    add(f'pink_{L}dB', pink(2.0, L), level_dbfs_rms=L)
add('gap', silence(1.0))
step = np.concatenate([sine(1000, 1.0, -40 if i % 2 == 0 else -10) for i in range(8)])
add('step_sine_-40_-10', step, note='abrupt 30 dB steps every 1 s (gain attack/release, block timing)')
stepn = np.concatenate([pink(1.0, -45 if i % 2 == 0 else -18) for i in range(8)])
add('step_pink_-45_-18', stepn)
add('gap', silence(1.0))
for g in [0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 4.0]:  # silence handling / voice activity cut-off
    add('burst_pink_-20dB', fade(pink(1.0, -20)), note='1 s burst')
    add(f'silence_{int(g*1000)}ms', silence(g))
add('sweep_-20dB', fade(db(-20) * signal.chirp(np.arange(15 * SR) / SR, 20, 15, 20000, method='logarithmic', phi=-90), 20),
    note='exponential sine sweep 20 Hz-20 kHz, 15 s')
add('pink_steady_-20dB', pink(10.0, -20), note='steady spectrum reference')
for f in [5000, 7000, 7500, 8000, 8500, 10000, 11000, 11500, 12000, 13000]:  # hybrid crossover / band edge
    add(f'tone_{f}Hz_-20dB', fade(sine(f, 1.0, -20)))
add('gap', silence(1.0))
clicks = silence(3.0)
for i in range(12): clicks[int((0.1 + 0.25 * i) * SR)] = db(-6)
add('clicks_-6dB', clicks, note='12 impulses 250 ms apart (timing / jitter)')
add('vowel_synth_-18dB', vowel(15.0), note='synthetic voiced speech, 115 Hz')
add('pink_quiet_-50dB', pink(5.0, -50), note='low-level noise: is it boosted, gated, or held?')
add('silence_end', silence(5.0))
add('sync_end', beeps(), note='end marker for clock-drift measurement')

x = np.concatenate(parts)
assert np.max(np.abs(x)) < 1.0, np.max(np.abs(x))
pcm = np.clip(np.round(x * 32767 + rng.uniform(-0.5, 0.5, len(x)) + rng.uniform(-0.5, 0.5, len(x))), -32768, 32767).astype('<i2')
st = np.stack([pcm, pcm], 1).reshape(-1)
with wave.open('tf2_voice_testsignal_v1.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
json.dump({'version': 1, 'sample_rate': SR, 'seed': 20260926, 'duration_s': round(len(x) / SR, 3), 'segments': segments}, open('tf2_voice_testsignal_v1.json', 'w'), indent=1)
print('duration', round(len(x) / SR, 1), 's; peak', round(20 * np.log10(np.max(np.abs(x))), 2), 'dBFS; segments', len(segments))
