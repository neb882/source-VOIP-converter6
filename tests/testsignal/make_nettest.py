"""TF2 voice network test signal v1 — deterministic (seeded). 48 kHz, 16-bit stereo (L = R).

A one-minute companion to tf2_voice_testsignal_v1 for recording TF2 voice under
packet loss and jitter (net_fakeloss / net_fakelag / net_fakejitter). Every
segment sits between Steam's voice gate (-39.5 dBFS, so it keeps transmitting)
and the level at which the receiver auto-gain leaves its voice_maxgain cap. The
game then applies a fixed +20 dB without clipping, and each lost or concealed
20 ms frame can be located against the known waveform. The segment map is
written alongside the WAV.

    python3 make_nettest.py      # needs numpy and scipy
"""
import numpy as np, json, wave
from scipy import signal
SR = 48000
SEED = 20260927
rng = np.random.default_rng(SEED)
db = lambda L: 10 ** (L / 20)
def silence(dur): return np.zeros(int(round(dur * SR)))
def sine(f, dur, level_db): t = np.arange(int(round(dur * SR))) / SR; return db(level_db) * np.sin(2 * np.pi * f * t)
def fade(x, ms=5):
    n = min(len(x) // 2, int(ms / 1000 * SR)); w = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    x = x.copy(); x[:n] *= w; x[-n:] *= w[::-1]; return x
def beeps():  # sync marker: three 1 kHz beeps, 60 ms, 0.5 s apart (as in the v1 test signal)
    out = []
    for _ in range(3): out += [fade(sine(1000, 0.06, -12), 3), silence(0.44)]
    return np.concatenate(out)
def pink(dur, rms_db):  # fresh noise every call, so every segment is unique for alignment
    n = int(round(dur * SR)); w = rng.standard_normal(n)
    b, a = [0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.522189400]
    p = signal.lfilter(b, a, w); p = signal.sosfilt(signal.butter(2, 25, 'high', fs=SR, output='sos'), p)
    return p / np.sqrt(np.mean(p ** 2)) * db(rms_db)
def chirp(f0, f1, dur, peak_db):
    t = np.arange(int(round(dur * SR))) / SR
    return db(peak_db) * signal.chirp(t, f0, dur, f1, method='linear', phi=-90)
# Synthetic voice whose pitch glides and whose vowel keeps changing, so concealment
# that repeats the last pitch period or spectral envelope is audible and measurable.
VOWELS = {'a': [730, 1090, 2440, 3400], 'i': [270, 2290, 3010, 3700], 'u': [300, 870, 2240, 3300], 'e': [530, 1840, 2480, 3500]}
def voice(dur, rms_db, block=240):
    n = int(round(dur * SR)); t = np.arange(n) / SR
    f0 = 125 + 35 * np.sin(2 * np.pi * 0.11 * t) + 4 * np.sin(2 * np.pi * 5.3 * t)
    src = signal.sawtooth(2 * np.pi * np.cumsum(f0) / SR, 0.02)
    order = ['a', 'i', 'u', 'e']
    bws, gains = [90, 110, 160, 250], [1.0, 0.6, 0.3, 0.15]
    out = np.zeros(n); zi = [np.zeros(2) for _ in bws]
    for s in range(0, n, block):
        pos = (s / SR) / 0.75                      # one vowel target every 0.75 s, linear morph between
        k = int(pos) % 4; frac = pos - int(pos)
        fa, fb = VOWELS[order[k]], VOWELS[order[(k + 1) % 4]]
        seg = src[s:s + block]
        for j in range(4):
            fc = fa[j] + (fb[j] - fa[j]) * frac
            b, a = signal.iirpeak(fc, fc / bws[j], fs=SR)
            y, zi[j] = signal.lfilter(b, a, seg, zi=zi[j])
            out[s:s + block] += gains[j] * y
    env = np.clip(np.sin(np.pi * ((t * 3.2) % 1)) ** 0.6, 0, 1) * (0.55 + 0.45 * np.sin(2 * np.pi * 0.37 * t) ** 2)
    out *= env
    return out / np.sqrt(np.mean(out ** 2)) * db(rms_db)

segments, parts, cursor = [], [], 0
def add(name, x, **info):
    global cursor
    parts.append(x); segments.append({'name': name, 'start_s': round(cursor / SR, 6), 'dur_s': round(len(x) / SR, 6), **info}); cursor += len(x)

add('sync_start', beeps(), note='3 x 1 kHz beeps at -12 dBFS')
add('gap', silence(1.0))
add('pink_-30dB', fade(pink(12.0, -30)), level_dbfs_rms=-30, note='continuous noise: frame-by-frame loss detection by correlation')
add('gap', silence(1.0))
add('chirp_300-3300Hz_-22dB', fade(chirp(300, 3300, 10.0, -22), 20), level_dbfs_peak=-22,
    note='linear chirp: concealment holds a stale pitch; buffer time-warps show as frequency error')
add('gap', silence(1.0))
add('voice_synth_-32dB', fade(voice(12.0, -32), 20), level_dbfs_rms=-32, note='gliding pitch, morphing vowels a-i-u-e')
add('gap', silence(1.0))
for i in range(8):   # 0.8 s gaps outlast the 300 ms gate hold, so each burst is a new talk spurt
    add('spurt_pink_-30dB', fade(pink(1.2, -30)), level_dbfs_rms=-30, note=f'talk spurt {i + 1} of 8: start delay and onset')
    add('gap', silence(0.8))
add('silence_end', silence(1.2))
add('sync_end', beeps(), note='end marker for clock-drift measurement')

x = np.concatenate(parts)
assert np.max(np.abs(x)) < 1.0, np.max(np.abs(x))
pcm = np.clip(np.round(x * 32767 + rng.uniform(-0.5, 0.5, len(x)) + rng.uniform(-0.5, 0.5, len(x))), -32768, 32767).astype('<i2')
st = np.stack([pcm, pcm], 1).reshape(-1)
with wave.open('tf2_voice_nettest_v1.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
json.dump({'version': 1, 'name': 'tf2_voice_nettest_v1', 'sample_rate': SR, 'seed': SEED, 'duration_s': round(len(x) / SR, 3),
           'segments': segments}, open('tf2_voice_nettest_v1.json', 'w'), indent=1)
print('duration', round(len(x) / SR, 1), 's; peak', round(20 * np.log10(np.max(np.abs(x))), 2), 'dBFS; segments', len(segments))
