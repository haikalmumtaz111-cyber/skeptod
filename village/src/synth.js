// Procedural sound synthesis for the soundscape: every sample is generated here, no audio files.
// Self-contained on purpose: the function is serialized into a Web Worker, so it must not
// reference anything outside its own body.
export function synthAll(low) {
  const SR = 48000, TAU = Math.PI * 2;
  const K = low ? 0.75 : 1; // loop length factor
  let S = 1;
  const seed = (s) => { S = s >>> 0; };
  const rnd = () => {
    S = (S + 0x6d2b79f5) >>> 0;
    let t = S;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = (a, b) => a + (b - a) * rnd();
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const sec = (s) => Math.floor(s * SR);
  const buf = (n) => new Float32Array(n);

  // ---------- DSP helpers ----------
  function biquad(x, type, f, q = 0.7071) {
    const w = (TAU * f) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
    const a0 = 1 + al, a1 = (-2 * c) / a0, a2 = (1 - al) / a0;
    b0 /= a0; b1 /= a0; b2 /= a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      x[i] = y;
    }
    return x;
  }
  function noise(n, color) {
    const o = buf(n);
    if (color === 'white') { for (let i = 0; i < n; i++) o[i] = rnd() * 2 - 1; return o; }
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        o[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
      return o;
    }
    let b = 0; // brown
    for (let i = 0; i < n; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; o[i] = b * 3.5; }
    return o;
  }
  function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length) || 1e-9; }
  function scale(x, k) { for (let i = 0; i < x.length; i++) x[i] *= k; return x; }
  function toRms(x, r) { return scale(x, r / rms(x)); }
  function toPeak(x, p) { let m = 1e-9; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return scale(x, p / m); }
  // smooth random curve: a new target every 1/rate s, cosine-interpolated
  function wander(n, rate, lo, hi) {
    const o = buf(n), step = Math.max(1, Math.floor(SR / rate));
    let a = R(lo, hi), b = R(lo, hi);
    for (let i = 0; i < n; i++) {
      const k = i % step;
      if (k === 0 && i) { a = b; b = R(lo, hi); }
      o[i] = a + (b - a) * (0.5 - 0.5 * Math.cos((Math.PI * k) / step));
    }
    return o;
  }
  // fold a buffer (pre-roll P, body n, tail F) into a seamless loop of n samples
  function loop(y, P, n, F) {
    const o = buf(n);
    for (let i = 0; i < n; i++) o[i] = y[P + i];
    for (let i = 0; i < F; i++) {
      const u = ((i / F) * Math.PI) / 2;
      o[i] = y[P + i] * Math.sin(u) + y[P + n + i] * Math.cos(u);
    }
    return o;
  }
  // Minnaert bubble: damped sine whose pitch rises as the bubble settles
  function bubble(x, at, f0, amp, rise, damp) {
    const tau = 1 / (Math.PI * f0 * (damp || R(0.03, 0.06)));
    const len = Math.min(Math.floor(tau * 5.5 * SR), x.length - at);
    const k0 = (TAU * f0) / SR, k1 = (TAU * f0 * rise) / (tau * SR * SR), d = Math.exp(-1 / (tau * SR));
    let ph = 0, a = amp;
    for (let i = 0; i < len; i++) {
      ph += k0 + k1 * i;
      x[at + i] += a * Math.sin(ph) * (i < 32 ? i / 32 : 1);
      a *= d;
    }
  }
  function grain(x, at, len, amp) {
    len = Math.min(len, x.length - at);
    for (let i = 0; i < len; i++) x[at + i] += amp * (0.5 - 0.5 * Math.cos((TAU * i) / len)) * (rnd() * 2 - 1);
  }
  // exponentially decaying sine (one resonant mode), computed by rotation
  function ring(x, at, f, amp, tau, ph0) {
    const len = Math.min(Math.floor(tau * 7 * SR), x.length - at);
    const w = (TAU * f) / SR, d = Math.exp(-1 / (tau * SR)), cw = Math.cos(w), sw = Math.sin(w);
    let c = Math.cos(ph0 || 0), s = Math.sin(ph0 || 0), a = amp;
    for (let i = 0; i < len; i++) {
      x[at + i] += a * s * (i < 24 ? i / 24 : 1);
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw; c = c2; a *= d;
    }
  }
  // swept tone with optional 2nd/3rd harmonics; fFn/aFn take u in [0,1]
  function tone(x, at, dur, fFn, aFn, h2 = 0, h3 = 0) {
    const len = Math.min(Math.floor(dur * SR), x.length - at);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const u = i / len;
      ph += (TAU * fFn(u)) / SR;
      x[at + i] += aFn(u) * (Math.sin(ph) + h2 * Math.sin(2 * ph) + h3 * Math.sin(3 * ph));
    }
  }
  const frame = (secs, pre = 0.25, tail = 0.6) => {
    const P = sec(pre), n = sec(secs * K), F = sec(tail);
    return { P, n, F, L: P + n + F };
  };

  // ---------- looping beds ----------
  // flowing water: broadband wash + resonant gurgle + bubble babble (+ splashes)
  function water(s, secs, o) {
    seed(s);
    const { P, n, F, L } = frame(secs);
    const wash = noise(L, 'pink');
    biquad(wash, 'hp', o.hp); biquad(wash, 'lp', o.lp); biquad(wash, 'lp', o.lp);
    toRms(wash, 1);
    const fl = wander(L, 5, 0.6, 1.15);
    const gur = noise(L, 'white');
    biquad(gur, 'bp', o.gur, 2.5); biquad(gur, 'bp', o.gur * 1.15, 2.5);
    toRms(gur, 1);
    const gm = wander(L, 6, 0, 1);
    const bab = buf(L);
    const nb = Math.floor((L / SR) * o.bubbles);
    for (let k = 0; k < nb; k++) {
      const f0 = 330 + 2700 * Math.pow(rnd(), 1.6);
      bubble(bab, Math.floor(rnd() * L), f0, Math.pow(rnd(), 2.2) * (700 / f0), R(0.3, 1.4));
    }
    const ns = Math.floor((L / SR) * o.splash);
    for (let k = 0; k < ns; k++) {
      const at = Math.floor(rnd() * L), m = RI(5, 12);
      for (let j = 0; j < m; j++) bubble(bab, Math.min(L - 1, at + sec(R(0, 0.16))), 450 + 2400 * rnd(), R(0.15, 0.6), R(0.4, 1.4));
    }
    toRms(bab, 1);
    const y = buf(L);
    for (let i = 0; i < L; i++) y[i] = wash[i] * fl[i] * o.wash + gur[i] * gm[i] * gm[i] * 1.6 * o.gurgle + bab[i] * o.babble;
    return [toRms(loop(y, P, n, F), 0.1)];
  }
  function waterfall(s, secs) {
    seed(s);
    const { P, n, F, L } = frame(secs, 0.25, 0.8);
    const hiss = noise(L, 'pink');
    biquad(hiss, 'hp', 120); biquad(hiss, 'lp', 6500);
    toRms(hiss, 1);
    const roar = noise(L, 'brown');
    biquad(roar, 'lp', 220); biquad(roar, 'hp', 35);
    toRms(roar, 1);
    const m1 = wander(L, 1.3, 0.8, 1.15), m2 = wander(L, 9, 0.85, 1.1);
    const bab = buf(L);
    const nb = Math.floor((L / SR) * 260);
    for (let k = 0; k < nb; k++) bubble(bab, Math.floor(rnd() * L), 600 + 3400 * rnd(), Math.pow(rnd(), 3), R(0.5, 1.5));
    toRms(bab, 1);
    const y = buf(L);
    for (let i = 0; i < L; i++) y[i] = hiss[i] * 0.85 * m2[i] + roar[i] * 0.8 * m1[i] + bab[i] * 0.3;
    return [toRms(loop(y, P, n, F), 0.1)];
  }
  // stereo wind: low rumble + airy band, with gusts built into the loop
  function wind(s, secs) {
    seed(s);
    const { P, n, F, L } = frame(secs, 0.3, 1.2);
    const g = wander(L, 0.16, 0.3, 1.0);
    const out = [];
    for (let c = 0; c < 2; c++) {
      const lo = noise(L, 'brown');
      biquad(lo, 'lp', 650); biquad(lo, 'hp', 45);
      toRms(lo, 1);
      const hi = noise(L, 'pink');
      biquad(hi, 'bp', 850 + c * 160, 0.9);
      toRms(hi, 1);
      const m = wander(L, 0.6, 0.65, 1.1);
      const y = buf(L);
      for (let i = 0; i < L; i++) y[i] = (lo[i] * 0.8 + hi[i] * 0.4 * g[i]) * (0.45 + 0.55 * g[i]) * m[i];
      out.push(loop(y, P, n, F));
    }
    const k = 0.1 / Math.sqrt((rms(out[0]) ** 2 + rms(out[1]) ** 2) / 2);
    return out.map((x) => scale(x, k));
  }
  // foliage rustle: dense micro-grains (leaves touching) + hiss + soft canopy swish
  function foliage(s, secs, o) {
    seed(s);
    const { P, n, F, L } = frame(secs);
    const m = wander(L, o.rate, 0.12, 1);
    const gr = buf(L);
    const total = Math.floor((L / SR) * o.dens);
    for (let k = 0; k < total; k++) {
      const at = Math.floor(rnd() * (L - 1));
      if (rnd() > m[at]) continue;
      grain(gr, at, Math.max(8, Math.floor(R(o.g0, o.g1) * SR)), Math.pow(rnd(), 2) * m[at]);
    }
    biquad(gr, 'hp', o.hp); biquad(gr, 'lp', o.lp);
    toRms(gr, 1);
    const hs = noise(L, 'pink');
    biquad(hs, 'hp', o.hp * 1.4); biquad(hs, 'lp', o.lp);
    toRms(hs, 1);
    const sw = noise(L, 'pink');
    biquad(sw, 'bp', o.swish, 0.8);
    toRms(sw, 1);
    const y = buf(L);
    for (let i = 0; i < L; i++) y[i] = gr[i] * 0.8 + hs[i] * 0.3 * m[i] + sw[i] * 0.3 * m[i] * m[i];
    const o2 = toRms(loop(y, P, n, F), 0.1);
    for (let i = 0; i < n; i++) o2[i] = 0.45 * Math.tanh(o2[i] / 0.45); // tame grain peaks
    return [toRms(o2, 0.1)];
  }
  // evening frog chorus: pulsed notes in bouts, several individuals
  function frogs(s, secs) {
    seed(s);
    const { P, n, F, L } = frame(secs, 0.25, 0.8);
    const y = buf(L), dur = L / SR;
    const nf = low ? 5 : 8;
    for (let f = 0; f < nf; f++) {
      const fc = rnd() < 0.7 ? R(1700, 2600) : R(600, 950);
      const pr = R(60, 110), nd = R(0.05, 0.09), rate = R(4, 7), amp = Math.pow(R(0.25, 1), 1.5);
      let t = R(0, 3);
      while (t < dur - 1) {
        const notes = RI(5, 14);
        for (let k = 0; k < notes && t < dur - 0.3; k++) {
          const at = sec(t), len = sec(nd * R(0.9, 1.1)), f0 = fc * R(0.98, 1.02);
          let ph = 0;
          for (let i = 0; i < len && at + i < L; i++) {
            const u = i / len;
            const pulse = Math.pow(0.5 - 0.5 * Math.cos((TAU * pr * i) / SR), 3);
            ph += (TAU * f0 * (1 - 0.04 * u)) / SR;
            y[at + i] += amp * Math.sin(Math.PI * u) * pulse * (Math.sin(ph) + 0.3 * Math.sin(2 * ph));
          }
          t += (1 / rate) * R(0.9, 1.1);
        }
        t += R(1.2, 4.5);
      }
    }
    biquad(y, 'lp', 3800); biquad(y, 'hp', 300);
    return [toRms(loop(y, P, n, F), 0.1)];
  }

  // ---------- one-shots ----------
  function twitter(s) {
    seed(s);
    const L = sec(1.8), y = buf(L);
    const nCh = RI(4, 10), base = R(4200, 6200), style = RI(0, 2);
    let t = 0.02;
    for (let k = 0; k < nCh && t < 1.65; k++) {
      const d = R(0.03, 0.075), f0 = base * R(0.92, 1.12), amp = R(0.5, 1);
      const f1 = style === 0 ? f0 * R(0.55, 0.75) : style === 1 ? f0 * R(1.1, 1.3) : f0 * R(0.8, 1.0);
      const tr = style === 2 ? R(35, 60) : 0;
      tone(y, sec(t), d, (u) => f0 + (f1 - f0) * u + (tr ? Math.sin(TAU * tr * u * d) * 380 : 0), (u) => amp * Math.pow(Math.sin(Math.PI * u), 0.6), 0.12, 0.03);
      t += d + R(0.035, 0.12);
    }
    return [toPeak(y, 0.8)];
  }
  // bush warbler: long rising whistle, then a quick three-note phrase ending in a falling slur
  function warbler(s) {
    seed(s);
    const L = sec(2.6), y = buf(L), p = R(0.95, 1.08), d1 = R(0.85, 1.25);
    tone(y, sec(0.02), d1, (u) => p * (1080 + 180 * u + 12 * Math.sin(TAU * 5.5 * u * d1)), (u) => Math.pow(u, 0.5) * (u > 0.9 ? (1 - u) / 0.1 : 1) * 0.75, 0.1, 0.02);
    let t = 0.02 + d1 + R(0.07, 0.12);
    tone(y, sec(t), 0.11, (u) => p * (2050 - 250 * u), (u) => Math.pow(Math.sin(Math.PI * u), 0.5) * 0.9, 0.08);
    t += 0.145;
    tone(y, sec(t), 0.07, (u) => p * (3150 - 200 * u), (u) => Math.pow(Math.sin(Math.PI * u), 0.5) * 0.85, 0.06);
    t += 0.1;
    const d3 = R(0.3, 0.38);
    tone(y, sec(t), d3,
      (u) => p * (u < 0.12 ? 3500 + (600 * u) / 0.12 : 4100 - 1500 * Math.pow((u - 0.12) / 0.88, 0.8)) + 120 * Math.sin(TAU * 28 * u * d3) * Math.sin(Math.PI * u),
      (u) => (u < 0.06 ? u / 0.06 : 1) * Math.pow(1 - u, 0.7), 0.06);
    return [toPeak(y, 0.85)];
  }
  // turtle dove: soft low four-note hoot, twice
  function dove(s) {
    seed(s);
    const L = sec(4.8), y = buf(L), p = R(0.95, 1.05);
    let t = 0.05;
    for (let r = 0; r < 2; r++) {
      for (const [d, a, b, gap] of [[0.3, 520, 495, 0.12], [0.3, 540, 500, 0.16], [0.16, 480, 470, 0.05], [0.36, 470, 425, 0]]) {
        tone(y, sec(t), d, (u) => p * (a + (b - a) * u), (u) => Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 0.8) * 0.9, 0.18, 0.05);
        t += d + gap;
      }
      t += R(0.6, 0.9);
    }
    return [toPeak(y, 0.8)];
  }
  // crow: harsh harmonic caw through two formants, 2-4 times
  function crow(s) {
    seed(s);
    const L = sec(2.4), y = buf(L), p = R(0.9, 1.1);
    const nC = RI(2, 4);
    let t = 0.03;
    for (let k = 0; k < nC && t < 1.9; k++) {
      const d = R(0.3, 0.45), at = sec(t), len = Math.min(sec(d), L - at);
      const src = buf(len);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const u = i / len;
        const f0 = p * (u < 0.2 ? 430 + (90 * u) / 0.2 : 520 - (130 * (u - 0.2)) / 0.8) * (1 + 0.03 * (rnd() - 0.5));
        ph += (TAU * f0) / SR;
        let v = 0;
        for (let h = 1; h <= 12; h++) v += Math.sin(h * ph) / Math.pow(h, 0.7);
        src[i] = v * Math.min(1, u / 0.06) * Math.min(1, (1 - u) / 0.25) * (0.85 + 0.3 * rnd());
      }
      const f1 = Float32Array.from(src), f2 = Float32Array.from(src);
      biquad(f1, 'bp', 1250, 2.2); biquad(f2, 'bp', 2500, 3);
      for (let i = 0; i < len; i++) y[at + i] += f1[i] + f2[i] * 0.6 + src[i] * 0.05;
      t += d + R(0.22, 0.4);
    }
    biquad(y, 'lp', 4500);
    return [toPeak(y, 0.85)];
  }
  // temple bell: inharmonic partials, each a slightly detuned pair so it beats as it decays
  function bell(s) {
    seed(s);
    const L = sec(low ? 18 : 26), y = buf(L), B = 126;
    const parts = [[0.5, 0.55, 24, 0.17], [1, 1, 20, 0.43], [1.71, 0.5, 13, 0.9], [2.33, 0.45, 10, 0.62], [3.17, 0.34, 7, 1.35], [4.12, 0.24, 5, 1.1], [5.29, 0.17, 3.6, 2.0], [6.62, 0.1, 2.6, 1.7], [8.1, 0.06, 1.8, 2.6]];
    for (const [r, a, tau, beat] of parts) {
      ring(y, 0, B * r - beat / 2, a * 0.6, tau, rnd() * TAU);
      ring(y, 0, B * r + beat / 2, a * 0.4, tau * 0.9, rnd() * TAU);
    }
    const th = noise(sec(0.3), 'white');
    biquad(th, 'lp', 260); biquad(th, 'lp', 260);
    toPeak(th, 1);
    for (let i = 0; i < th.length; i++) y[i] += th[i] * Math.exp(-i / (SR * 0.045)) * 0.9;
    for (let k = 0; k < 6; k++) ring(y, 0, R(900, 3200), R(0.03, 0.08), R(0.05, 0.25), rnd() * TAU);
    const fl = sec(2);
    for (let i = 0; i < fl; i++) y[L - 1 - i] *= i / fl;
    return [toPeak(y, 0.9)];
  }
  // hollow bamboo culms knocking together
  function knocks(s) {
    seed(s);
    const L = sec(1.0), y = buf(L), nK = RI(2, 4);
    let t = 0.01;
    for (let k = 0; k < nK && t < 0.8; k++) {
      const at = sec(t), f = R(480, 900), a = R(0.5, 1);
      ring(y, at, f, a, R(0.022, 0.04));
      ring(y, at, f * R(2.6, 2.9), a * 0.4, 0.012);
      ring(y, at, f * R(5.2, 5.6), a * 0.18, 0.006);
      grain(y, at, sec(0.0015), a * 0.4);
      t += R(0.07, 0.22);
    }
    return [toPeak(y, 0.8)];
  }
  // wood creak: stick-slip impulse train exciting a few plank resonances
  function creak(s) {
    seed(s);
    const d = R(0.45, 1.0), L = sec(d + 0.3), ex = buf(L);
    const r0 = R(70, 120), r1 = R(160, 280), sh = rnd();
    let t = 0.02;
    while (t < d) {
      const u = t / d;
      const rate = r0 + (r1 - r0) * Math.sin(Math.PI * Math.pow(u, 0.6 + sh));
      const a = Math.pow(Math.sin(Math.PI * u), 0.7) * R(0.6, 1);
      const at = sec(t);
      ex[at] += a; ex[at + 1] -= a * 0.5;
      t += (1 / rate) * R(0.88, 1.12);
    }
    const a1 = Float32Array.from(ex), a2 = Float32Array.from(ex), a3 = Float32Array.from(ex), fb = R(0.85, 1.2);
    biquad(a1, 'bp', 360 * fb, 14); biquad(a2, 'bp', 980 * fb, 16); biquad(a3, 'bp', 2150 * fb, 10);
    const y = buf(L);
    for (let i = 0; i < L; i++) y[i] = a1[i] + a2[i] * 0.7 + a3[i] * 0.35;
    biquad(y, 'hp', 150);
    return [toPeak(y, 0.75)];
  }
  function lapInto(y, at, amp) {
    const len = sec(R(0.3, 0.6)), nb = noise(len, 'white');
    biquad(nb, 'bp', R(320, 600), 1.3); biquad(nb, 'lp', 1400);
    toPeak(nb, 1);
    for (let i = 0; i < len && at + i < y.length; i++) { const u = i / len; y[at + i] += amp * nb[i] * Math.min(1, u / 0.12) * Math.pow(1 - u, 2); }
    for (let k = 0, m = RI(3, 7); k < m; k++) bubble(y, at + sec(R(0.02, 0.3)), R(220, 700), R(0.08, 0.3) * amp, R(0.3, 1));
  }
  function lap(s) { seed(s); const y = buf(sec(1.0)); lapInto(y, 0, 1); return [toPeak(y, 0.7)]; }
  // moored boat: hollow hull knock, sometimes a second bump, then water lapping
  function boat(s) {
    seed(s);
    const y = buf(sec(1.4)), f = R(160, 240);
    ring(y, 0, f, 1, 0.07); ring(y, 0, f * 2.3, 0.45, 0.025); ring(y, 0, f * 3.9, 0.2, 0.012);
    grain(y, 0, sec(0.002), 0.35);
    if (rnd() < 0.6) { const at = sec(R(0.12, 0.3)); ring(y, at, f * R(0.95, 1.05), 0.5, 0.06); ring(y, at, f * 2.3, 0.2, 0.02); }
    lapInto(y, sec(R(0.05, 0.15)), 0.6);
    return [toPeak(y, 0.8)];
  }
  function splash(s) {
    seed(s);
    const y = buf(sec(0.9)), len = sec(R(0.12, 0.3)), nb = noise(len, 'white');
    biquad(nb, 'bp', R(1100, 2200), 0.8);
    toPeak(nb, 1);
    for (let i = 0; i < len; i++) { const u = i / len; y[i] += nb[i] * Math.min(1, u / 0.08) * Math.pow(1 - u, 2.5) * 0.6; }
    for (let k = 0, m = RI(6, 16); k < m; k++) bubble(y, sec(R(0, 0.35)), 600 + 2600 * Math.pow(rnd(), 1.5), R(0.1, 0.5), R(0.4, 1.4));
    return [toPeak(y, 0.75)];
  }
  // koi surfacing in the pond
  function plip(s) {
    seed(s);
    const y = buf(sec(0.6));
    bubble(y, 0, R(750, 1100), 1, R(1.2, 2.2), 0.035);
    const g = buf(sec(0.012));
    grain(g, 0, g.length, 0.25);
    biquad(g, 'hp', 1500);
    for (let i = 0; i < g.length; i++) y[i] += g[i];
    for (let k = 0, m = RI(1, 3); k < m; k++) bubble(y, sec(R(0.05, 0.25)), R(1200, 2400), R(0.15, 0.35), 1);
    return [toPeak(y, 0.75)];
  }
  // stereo impulse response for a small open valley
  function impulse(s) {
    seed(s);
    const len = sec(low ? 1.6 : 2.4), pre = sec(0.012), out = [];
    for (let c = 0; c < 2; c++) {
      const nz = noise(len, 'white'), dk = Float32Array.from(nz);
      biquad(dk, 'lp', 2200); biquad(dk, 'lp', 2200);
      const y = buf(len);
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / SR;
        y[i] = nz[i] * Math.exp(-t / 0.09) * 0.35 + dk[i] * 2.2 * Math.exp(-t / 0.36) * Math.min(1, t / 0.03);
      }
      for (let k = 0; k < 6; k++) y[pre + sec(R(0.008, 0.09))] += R(-0.5, 0.5);
      const fl = sec(0.3);
      for (let i = 0; i < fl; i++) y[len - 1 - i] *= i / fl;
      out.push(y);
    }
    return out;
  }

  const river = { hp: 150, lp: 2300, gur: 480, bubbles: 70, splash: 0.4, wash: 0.8, gurgle: 0.35, babble: 0.55 };
  const upper = { hp: 180, lp: 2800, gur: 560, bubbles: 110, splash: 0.8, wash: 0.75, gurgle: 0.3, babble: 0.65 };
  const rapids = { hp: 160, lp: 5000, gur: 700, bubbles: 220, splash: 2.5, wash: 0.9, gurgle: 0.25, babble: 0.75 };
  const sakura = { rate: 1.1, dens: 2400, g0: 0.0004, g1: 0.0025, hp: 1500, lp: 8500, swish: 700 };
  const bamboo = { rate: 1.6, dens: 3800, g0: 0.0002, g1: 0.0012, hp: 2200, lp: 11000, swish: 950 };
  const B = {};
  B.river0 = water(11, 7.3, river);
  B.river1 = water(12, 8.9, river);
  B.river2 = water(13, 10.1, river);
  B.upper = water(14, 8.3, upper);
  B.rapids = water(15, 7.1, rapids);
  B.fall0 = waterfall(21, 9.1);
  B.fall1 = waterfall(22, 10.7);
  B.wind = wind(31, 12.3);
  B.leaves = foliage(41, 8.3, sakura);
  B.bamboo = foliage(42, 7.9, bamboo);
  B.frogs = frogs(51, 12.1);
  for (let i = 0; i < 5; i++) B['tw' + i] = twitter(100 + i);
  for (let i = 0; i < 3; i++) B['ug' + i] = warbler(200 + i);
  B.dove = dove(300);
  for (let i = 0; i < 3; i++) B['crow' + i] = crow(400 + i);
  B.bell = bell(500);
  for (let i = 0; i < 4; i++) B['knock' + i] = knocks(600 + i);
  for (let i = 0; i < 4; i++) B['creak' + i] = creak(700 + i);
  for (let i = 0; i < 2; i++) B['boat' + i] = boat(800 + i);
  for (let i = 0; i < 3; i++) B['lap' + i] = lap(900 + i);
  for (let i = 0; i < 4; i++) B['splash' + i] = splash(1000 + i);
  for (let i = 0; i < 2; i++) B['plip' + i] = plip(1100 + i);
  B.ir = impulse(1200);
  return { sr: SR, bufs: B };
}
