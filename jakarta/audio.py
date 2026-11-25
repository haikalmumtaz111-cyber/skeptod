# Synthesises a 30 s soundtrack: soft lo-fi pad + plucks, rain, thunder, train, sizzle, birds.
import numpy as np, wave, sys

SR = 44100
D = 30.0
N = int(SR * D)
t = np.arange(N) / SR
rng = np.random.default_rng(7)

def onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.empty_like(x); s = 0.0
    b = 1 - a
    for i in range(len(x)):
        s = b * x[i] + a * s
        y[i] = s
    return y

def env(points):
    xs, ys = zip(*points)
    return np.interp(t, xs, ys)

def mtof(m): return 440 * 2 ** ((m - 69) / 12)

# ---------------------------------------------------------------- music
music = np.zeros((N, 2))
bpm = 84; beat = 60 / bpm
# Fmaj7 - Em7 - Dm7 - Cmaj7/E (each 2 bars of 4 beats)
chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]]
bar = beat * 4
for ci in range(int(D / (bar * 2)) + 1):
    ch = chords[ci % 4]
    t0 = ci * bar * 2; t1 = t0 + bar * 2
    m = (t >= t0 - 0.3) & (t < t1 + 1.2)
    tt = t[m] - t0
    a = np.clip(tt / 0.8, 0, 1) * np.clip((bar * 2 + 1.2 - tt) / 1.2, 0, 1)
    for k, n in enumerate(ch):
        f = mtof(n)
        sig = np.zeros_like(tt)
        for h in range(1, 7):
            for det in (-0.12, 0.12):
                sig += np.sin(2 * np.pi * f * h * (1 + det / 100 * h) * tt + k + h) / (h ** 1.6)
        pan = 0.3 + 0.4 * (k / 3)
        music[m, 0] += sig * a * 0.035 * (1 - pan)
        music[m, 1] += sig * a * 0.035 * pan
    # bass
    f = mtof(ch[0] - 12)
    bs = np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt)
    music[m, 0] += bs * a * 0.05; music[m, 1] += bs * a * 0.05

# pluck melody (pentatonic-ish over the chords)
mel = [72, 69, 67, 64, None, 67, 69, 72, 71, 67, 64, None, 62, 64, 67, None,
       69, 65, 64, 62, None, 60, 62, 64, 67, 64, 62, None, 60, 59, 60, None]
step = beat / 1
for i in range(int(D / step)):
    n = mel[i % len(mel)]
    if n is None or (i % 2 == 1 and rng.random() < 0.35): continue
    t0 = i * step + (0.02 if i % 2 else 0)
    m = (t >= t0) & (t < t0 + 1.6)
    tt = t[m] - t0
    f = mtof(n)
    sig = sum(np.sin(2 * np.pi * f * h * tt) * np.exp(-tt * (3 + h * 2.5)) / h for h in range(1, 6))
    sig *= np.clip(tt / 0.004, 0, 1)
    pan = 0.5 + 0.25 * np.sin(i)
    music[m, 0] += sig * 0.06 * (1 - pan)
    music[m, 1] += sig * 0.06 * pan
# simple echo
d = int(SR * beat * 0.75)
for ch in range(2):
    music[d:, 1 - ch] += music[:-d, ch] * 0.28
music_env = env([(0, 0), (1.5, 0.55), (3.6, 1.0), (D - 2.5, 1.0), (D, 0)])
music *= music_env[:, None]

# ---------------------------------------------------------------- ambience
white = rng.standard_normal(N)
rain = white - onepole_lp(white, 600)            # hiss
rain = onepole_lp(rain, 7000)
drops = (rng.random(N) < 0.0025) * rng.standard_normal(N) * 3
drops = drops - onepole_lp(drops, 1500)
rain_l = rain + drops
rain_r = np.roll(rain, 1234) + np.roll(drops, 777)
rain_e = env([(0, 0.0), (0.5, 0.9), (3.6, 0.9), (4.2, 0.08), (14.5, 0.08), (15.0, 0.75), (18.4, 0.75), (18.8, 0.9), (22.1, 0.9), (22.6, 0.0), (D, 0)])
amb = np.zeros((N, 2))
amb[:, 0] += rain_l * rain_e * 0.05
amb[:, 1] += rain_r * rain_e * 0.05

# thunder at ~2.4 s
th0 = 2.45
m = t >= th0
tt = t[m] - th0
rum = onepole_lp(onepole_lp(rng.standard_normal(m.sum()), 120), 90)
rum *= np.exp(-tt * 0.9) * (0.6 + 0.4 * np.sin(tt * 7) ** 2) * np.clip(tt / 0.08, 0, 1)
rum /= np.abs(rum).max() + 1e-9
amb[m, 0] += rum * 0.55; amb[m, 1] += rum * 0.5

# train approaching 4..8.2
m = (t >= 3.9) & (t < 8.6)
tt = t[m] - 3.9
tr = onepole_lp(rng.standard_normal(m.sum()), 180)
tr /= np.abs(tr).max()
vol = np.clip(tt / 4.0, 0, 1) ** 1.6 * np.clip((4.7 - tt) / 0.5, 0, 1)
clack = np.zeros_like(tt)
for c0 in np.arange(0.2, 4.6, 0.62):
    for dd in (0, 0.09):
        k = (tt >= c0 + dd) & (tt < c0 + dd + 0.06)
        clack[k] += np.sin(2 * np.pi * 900 * (tt[k] - c0 - dd)) * np.exp(-(tt[k] - c0 - dd) * 80)
sig = tr * 0.6 + clack * 0.5
amb[m, 0] += sig * vol * 0.5; amb[m, 1] += sig * vol * 0.42
# horn
for h0, f in ((5.3, 466), (5.75, 392)):
    m = (t >= h0) & (t < h0 + 0.42)
    tt = t[m] - h0
    hs = sum(np.sin(2 * np.pi * f * k * tt) / k for k in (1, 2, 3)) * np.clip(tt / 0.03, 0, 1) * np.clip((0.42 - tt) / 0.06, 0, 1)
    amb[m, 0] += hs * 0.08; amb[m, 1] += hs * 0.08

# platform / crowd murmur 4..14.7
mur = onepole_lp(rng.standard_normal(N), 500) - onepole_lp(rng.standard_normal(N), 120)
mur_e = env([(0, 0), (4.0, 0), (4.6, 0.25), (11.0, 0.25), (11.4, 0.35), (14.5, 0.3), (15.0, 0), (D, 0)])
amb[:, 0] += mur * mur_e * 0.12; amb[:, 1] += np.roll(mur, 999) * mur_e * 0.12

# sizzle 22.1..26
m = (t >= 22.0) & (t < 26.2)
tt = t[m] - 22.0
sz = rng.standard_normal(m.sum())
sz = sz - onepole_lp(sz, 2500)
crack = (rng.random(m.sum()) < 0.004) * rng.standard_normal(m.sum()) * 4
sz = sz * (0.6 + 0.4 * np.abs(np.sin(tt * 3.1))) + crack
v = np.clip(tt / 0.4, 0, 1) * np.clip((4.2 - tt) / 0.5, 0, 1)
amb[m, 0] += sz * v * 0.07; amb[m, 1] += sz * v * 0.065

# birds 25.8..30
for i in range(9):
    b0 = 26.0 + rng.random() * 3.3
    f0 = 2800 + rng.random() * 1500
    for j in range(rng.integers(2, 4)):
        s0 = b0 + j * 0.13
        m = (t >= s0) & (t < s0 + 0.09)
        tt = t[m] - s0
        ff = f0 * (1 + 0.35 * np.sin(tt * 60))
        ph = 2 * np.pi * np.cumsum(ff) / SR
        ch = np.sin(ph) * np.sin(np.pi * tt / 0.09)
        p = rng.random()
        amb[m, 0] += ch * 0.03 * (1 - p); amb[m, 1] += ch * 0.03 * p

mix = music + amb
fade = env([(0, 0), (0.4, 1), (D - 1.0, 1), (D, 0)])
mix *= fade[:, None]
mix /= max(1e-9, np.abs(mix).max()) / 0.89
out = (mix * 32767).astype(np.int16)
with wave.open(sys.argv[1] if len(sys.argv) > 1 else 'audio.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(out.tobytes())
print('ok')
