// Spatial soundscape: procedural looping beds and scheduled one-shots placed in the world,
// following the camera, mixed through a small valley reverb. Starts on the first user gesture.
import { synthAll } from './synth.js';
import { layout, LOWER, UPPER, UPPER_Y, WATER_Y, cliffZ, hAt } from './world.js';
import { foamSpots } from './river.js';
import { BAMBOO_AREAS } from './vegetation.js';

export const MASTER = 0.85;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// same gust field that drives the visible sway (life.windAt / shader windOffset); T = sim time + 1000
const gust = (x, z, T) => 0.5 + 0.5 * Math.sin(T * 0.42 + x * 0.021 + z * 0.013) * Math.sin(T * 0.27 + z * 0.031 + 1.3);
const gustLevel = (k) => 0.15 + 0.85 * smooth(0.22, 0.95, k);
// high frequencies fade with distance (air absorption) and distant sources get more reverb
const airCut = (d) => Math.min(20000, 20000 / (1 + d / 45));
const sendFor = (d) => clamp(0.25 + d / 80, 0.25, 1.3);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function nearestIdx(P, x, z) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < P.length; i++) {
    const dx = P[i][0] - x, dz = P[i][1] - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// ---------- synthesis: in a worker when possible so the render loop never stalls ----------
let synthPromise = null;
export function prepareSounds(low) {
  if (synthPromise) return synthPromise;
  synthPromise = new Promise((resolve) => {
    const inline = () => setTimeout(() => resolve(synthAll(low)), 0);
    let w;
    try {
      const src = `self.onmessage=function(e){var r=(${synthAll.toString()})(e.data);var t=[];for(var k in r.bufs)for(var c of r.bufs[k])t.push(c.buffer);self.postMessage(r,t);};`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new Worker(url);
      URL.revokeObjectURL(url);
    } catch (e) { inline(); return; }
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { e.preventDefault(); w.terminate(); inline(); };
    w.postMessage(low);
  });
  return synthPromise;
}
function toBuffers(ctx, data) {
  const B = {};
  for (const k in data.bufs) {
    let ch = data.bufs[k], sr = data.sr;
    if (k === 'ir' && ctx.sampleRate !== sr) {
      // a convolver needs its impulse at the context rate: resample linearly
      const r = sr / ctx.sampleRate, n = Math.floor(ch[0].length / r);
      ch = ch.map((c) => {
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = i * r, j = Math.floor(x), f = x - j; o[i] = c[j] * (1 - f) + (c[j + 1] || 0) * f; }
        return o;
      });
      sr = ctx.sampleRate;
    }
    const b = ctx.createBuffer(ch.length, ch[0].length, sr);
    ch.forEach((c, i) => b.copyToChannel(c, i));
    B[k] = b;
  }
  return B;
}

// ---------- static scene info for sound placement ----------
function sceneInfo(life) {
  const T = (t) => [t.x, hAt(t.x, t.z) + 7, t.z];
  const trees = [...layout.sakura, ...layout.weeping, ...layout.maples, ...layout.pines, ...layout.greenTrees].map(T);
  // group the cherry trees into a handful of rustle sources (farthest-point seeds, then centroids)
  const sak = [...layout.sakura, ...layout.weeping];
  const seeds = [];
  if (sak.length) {
    seeds.push(sak[0]);
    while (seeds.length < Math.min(6, sak.length)) {
      let best = null, bd = -1;
      for (const t of sak) {
        const d = Math.min(...seeds.map((s) => Math.hypot(s.x - t.x, s.z - t.z)));
        if (d > bd) { bd = d; best = t; }
      }
      seeds.push(best);
    }
  }
  const groups = seeds.map(() => ({ x: 0, z: 0, n: 0 }));
  for (const t of sak) {
    let bi = 0, bd = Infinity;
    seeds.forEach((s, i) => { const d = Math.hypot(s.x - t.x, s.z - t.z); if (d < bd) { bd = d; bi = i; } });
    groups[bi].x += t.x; groups[bi].z += t.z; groups[bi].n++;
  }
  const sakura = groups.filter((g) => g.n).map((g) => { const x = g.x / g.n, z = g.z / g.n; return { p: [x, hAt(x, z) + 5, z], n: g.n }; });
  // rapids: the foaming mid-stream boulders, merged when close
  const rapids = [];
  for (const f of foamSpots) {
    if (f.k < 0.7) continue;
    const r = rapids.find((q) => Math.hypot(q.x - f.x, q.z - f.z) < 22);
    if (r) { r.x = (r.x * r.n + f.x) / (r.n + 1); r.z = (r.z * r.n + f.z) / (r.n + 1); r.n++; }
    else rapids.push({ x: f.x, z: f.z, n: 1 });
  }
  const fx = UPPER[0][0], fz = cliffZ(fx) - 1.6;
  const P = layout.pond;
  return {
    life, trees, sakura,
    rapids: rapids.map((r) => [r.x, WATER_Y + 0.4, r.z]),
    fall: [[fx - 2.6, 7, fz + 1.2], [fx + 2.6, 7, fz + 1.2], [fx, 0.6, fz + 3.5]],
    bell: [layout.bell.x, layout.bell.y + 3.4, layout.bell.z],
    bridges: layout.bridges.map((b) => [b.x, WATER_Y + (b.type === 'arch' ? 3.2 : 1.6), b.z]),
    boats: layout.boats.map((b) => [b.x, WATER_Y + 0.4, b.z]),
    pond: P,
    frogs: [[P.x, 0.4, P.z], [LOWER[nearestIdx(LOWER, 0, 110)][0] - 13, 0.8, 110], [LOWER[nearestIdx(LOWER, 0, 150)][0] + 15, 0.8, 150], [UPPER[nearestIdx(UPPER, 0, -175)][0] + 9, UPPER_Y + 0.6, -175]],
  };
}

// ---------- the mix graph (works for live and offline contexts) ----------
export class Mix {
  constructor(ctx, B, S, { offline = false, hrtf = true, seed = 7, solo = null } = {}) {
    this.ctx = ctx; this.B = B; this.S = S; this.offline = offline; this.hrtf = hrtf; this.solo = solo;
    this.r = mulberry(seed);
    const c = ctx;
    this.out = c.createGain();
    this.out.gain.value = 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.35;
    this.out.connect(comp); comp.connect(c.destination);
    this.dry = c.createGain(); this.dry.connect(this.out);
    this.rev = c.createConvolver(); this.rev.buffer = B.ir;
    const rg = c.createGain(); rg.gain.value = 0.55;
    this.rev.connect(rg); rg.connect(this.out);
    this.lis = [0, 30, 0];
    this.first = true;
    this.beds = [];
    this.near = 0; this.nearUp = 0;
    this.makeBeds();
    this.events = null;
  }
  R(a, b) { return a + (b - a) * this.r(); }
  pick(a) { return a[Math.floor(this.r() * a.length)]; }
  set(param, v, now, tc = 0.08) {
    if (this.first) param.setValueAtTime(v, now);
    else if (this.offline) param.linearRampToValueAtTime(v, now);
    else param.setTargetAtTime(v, now, tc);
  }
  panner(ref, roll, hrtf) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf && this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = 20000;
    return p;
  }
  place(pan, p, now) {
    if (pan.positionX) { this.set(pan.positionX, p[0], now, 0.05); this.set(pan.positionY, p[1], now, 0.05); this.set(pan.positionZ, p[2], now, 0.05); }
    else pan.setPosition(p[0], p[1], p[2]);
  }
  // looping source; `where(lis, T)` returns [position|null, level]
  bed(name, group, { gain = 1, ref = 5, roll = 1, send = 0.3, where, filt = null }) {
    if (this.solo && this.solo !== group) return;
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.B[name]; src.loop = true;
    const g = c.createGain(); g.gain.value = 0;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4; lp.frequency.value = filt || 20000;
    const sg = c.createGain(); sg.gain.value = send;
    src.connect(g); g.connect(lp); lp.connect(sg); sg.connect(this.rev);
    const positional = !filt;
    let pan = null;
    if (positional) { pan = this.panner(ref, roll, false); lp.connect(pan); pan.connect(this.dry); }
    else lp.connect(this.dry);
    src.start(this.ctx.currentTime, this.r() * src.buffer.duration);
    this.beds.push({ src, g, lp, sg, pan, gain, send, where, positional });
  }
  makeBeds() {
    const S = this.S, L = LOWER, U = UPPER;
    const along = (P, i0, off, y) => { const p = P[clamp(i0 + off, 0, P.length - 1)]; return [p[0], y, p[1]]; };
    // the river follows the listener: one source at the nearest bank point, two more up/downstream
    this.bed('river0', 'water', { gain: 0.56, ref: 5, send: 0.2, where: () => [along(L, this.near, 0, WATER_Y + 0.3), 1] });
    this.bed('river1', 'water', { gain: 0.42, ref: 5, send: 0.2, where: () => [along(L, this.near, -24, WATER_Y + 0.3), 1] });
    this.bed('river2', 'water', { gain: 0.42, ref: 5, send: 0.2, where: () => [along(L, this.near, 24, WATER_Y + 0.3), 1] });
    this.bed('upper', 'water', { gain: 0.42, ref: 5, send: 0.25, where: () => [along(U, this.nearUp, 0, UPPER_Y + 0.3), 1] });
    for (const p of S.rapids) this.bed('rapids', 'water', { gain: 0.35, ref: 3.5, send: 0.25, where: () => [p, 1] });
    this.bed('fall0', 'water', { gain: 0.63, ref: 9, send: 0.35, where: () => [S.fall[0], 1] });
    this.bed('fall1', 'water', { gain: 0.63, ref: 9, send: 0.35, where: () => [S.fall[1], 1] });
    this.bed('rapids', 'water', { gain: 0.56, ref: 6, send: 0.3, where: () => [S.fall[2], 1] });
    // wind: everywhere, swelling with the same gusts that sway the trees, stronger up high
    this.bed('wind', 'wind', {
      gain: 0.34, send: 0.12, filt: 900,
      where: (lis, T) => {
        const k = gust(lis[0], lis[2], T);
        const alt = clamp((lis[1] - hAt(lis[0], lis[2]) - 8) / 45, 0, 1);
        return [null, (0.3 + 0.9 * k * k) * (1 + 0.9 * alt), 500 + 1500 * k];
      },
    });
    for (const s of S.sakura) {
      const w = Math.sqrt(s.n) / 2.2;
      this.bed('leaves', 'wind', { gain: 0.3 * w, ref: 7, send: 0.25, where: (lis, T) => [s.p, gustLevel(gust(s.p[0], s.p[2], T))] });
    }
    // bamboo groves: the source slides to the nearest point of each grove (inside it, it surrounds you)
    for (const A of BAMBOO_AREAS) {
      this.bed('bamboo', 'wind', {
        gain: 0.37, ref: 6, send: 0.25,
        where: (lis, T) => {
          const x = clamp(lis[0], A.x0, A.x1), z = clamp(lis[2], A.z0, A.z1);
          return [[x, hAt(x, z) + 7, z], gustLevel(gust(x, z, T))];
        },
      });
    }
    for (const p of S.frogs) this.bed('frogs', 'frogs', { gain: 0.19, ref: 7, roll: 1.2, send: 0.4, where: () => [p, 1] });
  }
  initEvents(now) {
    const R = (a, b) => this.R(a, b);
    const ev = (kind, first, gap) => ({ kind, next: now + first, gap });
    this.events = [
      ev('twitter', R(1.5, 4), () => R(2.5, 7)),
      ev('warbler', R(5, 10), () => R(13, 26)),
      ev('dove', R(18, 30), () => R(28, 50)),
      ev('crow', R(8, 18), () => R(18, 38)),
      ev('bell', R(10, 15), () => R(45, 75)),
      ev('knock', 2, () => R(1.2, 4)),
      ev('creak', 3, () => R(6, 14)),
      ev('boat', 2.5, () => R(3.5, 8)),
      ev('splash', 1.5, () => R(1.0, 3.5)),
      ev('plip', 3, () => R(3.5, 9)),
    ];
  }
  pickTree(dmin, dmax) {
    const [x, , z] = this.lis;
    const c = this.S.trees.filter((t) => { const d = Math.hypot(t[0] - x, t[2] - z); return d > dmin && d < dmax; });
    if (c.length) return this.pick(c);
    const a = this.r() * Math.PI * 2, d = this.R(dmin, Math.min(dmax, dmin + 40));
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    return [px, hAt(px, pz) + 8, pz];
  }
  play(name, at, p, group, { gain = 1, rate = 1, ref = 3, roll = 1, send = 0.3, hrtf = true } = {}) {
    if (this.solo && this.solo !== group) return;
    const c = this.ctx, buf = this.B[name];
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf; src.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain;
    const d = dist3(this.lis, p);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4; lp.frequency.value = airCut(d);
    const pan = this.panner(ref, roll, hrtf);
    if (pan.positionX) { pan.positionX.value = p[0]; pan.positionY.value = p[1]; pan.positionZ.value = p[2]; } else pan.setPosition(p[0], p[1], p[2]);
    const sg = c.createGain(); sg.gain.value = send * sendFor(d);
    src.connect(g); g.connect(lp); lp.connect(pan); pan.connect(this.dry); lp.connect(sg); sg.connect(this.rev);
    src.onended = () => { src.disconnect(); g.disconnect(); lp.disconnect(); pan.disconnect(); sg.disconnect(); };
    src.start(at);
  }
  fire(kind, at, T) {
    const S = this.S, lis = this.lis, R = (a, b) => this.R(a, b);
    switch (kind) {
      case 'twitter': {
        const p = this.pickTree(10, 70);
        this.play('tw' + Math.floor(this.r() * 5), at, p, 'birds', { gain: R(0.13, 0.27), rate: R(0.92, 1.08), ref: 3, send: 0.35 });
        if (this.r() < 0.35) this.play('tw' + Math.floor(this.r() * 5), at + R(0.8, 2.2), p, 'birds', { gain: R(0.11, 0.22), rate: R(0.92, 1.08), ref: 3, send: 0.35 });
        break;
      }
      case 'warbler': {
        const p = this.pickTree(25, 110), nm = 'ug' + Math.floor(this.r() * 3), o = { gain: R(0.3, 0.42), rate: R(0.97, 1.03), ref: 4, send: 0.45 };
        this.play(nm, at, p, 'birds', o);
        if (this.r() < 0.55) this.play(nm, at + R(4, 7), p, 'birds', o);
        break;
      }
      case 'dove':
        this.play('dove', at, this.pickTree(50, 150), 'birds', { gain: 0.25, rate: R(0.97, 1.03), ref: 4, send: 0.5 });
        break;
      case 'crow': {
        // a caw from one of the dark birds circling over the valley
        const p = S.life ? S.life.birdPos(Math.floor(this.r() * 18), T) : [lis[0] + 120, 80, lis[2] - 150];
        this.play('crow' + Math.floor(this.r() * 3), at, p, 'birds', { gain: 0.3, rate: R(0.95, 1.05), ref: 25, send: 0.6 });
        break;
      }
      case 'bell':
        this.play('bell', at, S.bell, 'bell', { gain: 0.22, ref: 35, send: 0.7 });
        break;
      case 'knock':
        for (const A of BAMBOO_AREAS) {
          const x = clamp(lis[0], A.x0, A.x1), z = clamp(lis[2], A.z0, A.z1);
          const k = gust(x, z, T), d = Math.hypot(x - lis[0], z - lis[2]);
          if (d > 70 || k < 0.45 || this.r() > k) continue;
          const px = clamp(x + R(-9, 9), A.x0, A.x1), pz = clamp(z + R(-9, 9), A.z0, A.z1);
          this.play('knock' + Math.floor(this.r() * 4), at + R(0, 0.5), [px, hAt(px, pz) + R(3, 9), pz], 'wind', { gain: R(0.24, 0.55) * k, rate: R(0.9, 1.1), ref: 3, send: 0.3 });
        }
        break;
      case 'creak': {
        const near = [...S.bridges, ...S.boats].filter((p) => dist3(p, lis) < 45);
        if (near.length) this.play('creak' + Math.floor(this.r() * 4), at, this.pick(near), 'wood', { gain: R(0.3, 0.65), rate: R(0.9, 1.1), ref: 3, send: 0.25 });
        break;
      }
      case 'boat': {
        const near = S.boats.filter((p) => dist3(p, lis) < 40);
        if (near.length) this.play('boat' + Math.floor(this.r() * 2), at, this.pick(near), 'wood', { gain: R(0.4, 0.8), rate: R(0.92, 1.08), ref: 3, send: 0.25 });
        break;
      }
      case 'splash': {
        const q = LOWER[clamp(this.near + Math.round(R(-15, 15)), 0, LOWER.length - 1)];
        const p = [q[0] + R(-0.3, 0.3) * q[2], WATER_Y + 0.2, q[1]];
        if (dist3(p, lis) > 70) break;
        if (this.r() < 0.3) this.play('lap' + Math.floor(this.r() * 3), at, [q[0] + (this.r() < 0.5 ? -1 : 1) * q[2] * 0.95, WATER_Y + 0.2, q[1]], 'water', { gain: R(0.18, 0.35), ref: 3, send: 0.2 });
        else this.play('splash' + Math.floor(this.r() * 4), at, p, 'water', { gain: R(0.14, 0.35), rate: R(0.9, 1.15), ref: 3, send: 0.25 });
        break;
      }
      case 'plip': {
        const P = S.pond;
        if (Math.hypot(P.x - lis[0], P.z - lis[2]) > 45) break;
        const a = this.r() * Math.PI * 2, rr = Math.sqrt(this.r()) * 0.75;
        this.play('plip' + Math.floor(this.r() * 2), at, [P.x + Math.cos(a) * P.rx * rr, 0.2, P.z + Math.sin(a) * P.rz * rr], 'water', { gain: R(0.25, 0.5), rate: R(0.9, 1.15), ref: 2.5, send: 0.3 });
        break;
      }
    }
  }
  // now: context time these values apply at; T: sim time + 1000; pos/fwd/up: camera frame
  tick(now, T, pos, fwd, up) {
    this.lis = pos;
    const L = this.ctx.listener;
    if (L.positionX) {
      const tc = 0.04;
      this.set(L.positionX, pos[0], now, tc); this.set(L.positionY, pos[1], now, tc); this.set(L.positionZ, pos[2], now, tc);
      this.set(L.forwardX, fwd[0], now, tc); this.set(L.forwardY, fwd[1], now, tc); this.set(L.forwardZ, fwd[2], now, tc);
      this.set(L.upX, up[0], now, tc); this.set(L.upY, up[1], now, tc); this.set(L.upZ, up[2], now, tc);
    } else {
      L.setPosition(pos[0], pos[1], pos[2]);
      L.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
    this.near = nearestIdx(LOWER, pos[0], pos[2]);
    this.nearUp = nearestIdx(UPPER, pos[0], pos[2]);
    for (const b of this.beds) {
      const [p, level, cut] = b.where(pos, T);
      this.set(b.g.gain, b.gain * level, now, 0.25);
      if (b.positional) {
        this.place(b.pan, p, now);
        const d = dist3(pos, p);
        this.set(b.lp.frequency, airCut(d), now, 0.15);
        this.set(b.sg.gain, b.send * sendFor(d), now, 0.25);
      } else if (cut) this.set(b.lp.frequency, cut, now, 0.3);
    }
    if (!this.events) this.initEvents(now);
    const ahead = this.offline ? 0.05 : 0.3;
    for (const e of this.events) {
      if (e.next < now - 1) e.next = now + e.gap() * 0.5; // after a pause, do not fire a backlog
      while (e.next < now + ahead) { this.fire(e.kind, Math.max(e.next, now), T); e.next += e.gap(); }
    }
    this.first = false;
  }
  fadeTo(v, now, secs) {
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + secs);
  }
}

// ---------- live wrapper: first-gesture start, mute control, visibility handling ----------
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" fill-opacity=".18"/>'
  + '<g class="w"><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.8a7.4 7.4 0 0 1 0 10.4"/></g>'
  + '<g class="x"><path d="M16 9.5l5 5M21 9.5l-5 5"/></g></svg>';
const CSS = '#snd{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:5;width:40px;height:40px;padding:0;'
  + 'border-radius:50%;border:1px solid rgba(255,236,226,.16);background:rgba(18,12,16,.26);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fbeee6;'
  + 'display:grid;place-items:center;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .9s ease,background .3s ease;-webkit-tap-highlight-color:transparent}'
  + '#snd.on{opacity:.5;pointer-events:auto}#snd:hover,#snd:focus-visible{opacity:.95;background:rgba(18,12,16,.45)}'
  + '#snd:focus-visible{outline:2px solid rgba(255,214,200,.7);outline-offset:2px}#snd svg{width:20px;height:20px}'
  + '#snd .w,#snd .x{transition:opacity .35s ease}#snd[aria-pressed=false] .w{opacity:0}#snd[aria-pressed=true] .x{opacity:0}';

export class Soundscape {
  constructor(life, { low = false } = {}) {
    this.life = life; this.low = low;
    this.state = 'idle'; // idle → starting → on (or off when Web Audio is unavailable)
    this.muted = false;
    try { this.muted = localStorage.getItem('sakura-village-muted') === '1'; } catch (e) { /* storage blocked */ }
    this.ctx = null; this.mix = null; this.lastTick = -1; this.susT = 0;
  }
  mount() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    const b = document.createElement('button');
    b.id = 'snd'; b.type = 'button';
    b.setAttribute('aria-label', 'Sound');
    b.innerHTML = ICON;
    document.body.appendChild(b);
    this.btn = b;
    this.syncUI();
    b.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    const first = (e) => {
      if (e.target && e.target.closest && e.target.closest('#snd')) return;
      if (e.type === 'keydown' && (e.key === 'm' || e.key === 'M')) return; // handled below
      if (this.state === 'idle') this.unlock(false);
    };
    for (const t of ['pointerup', 'touchend', 'click', 'keydown']) addEventListener(t, first, { capture: true, passive: true });
    addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && !e.repeat) this.toggle(); });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || this.state !== 'on') return;
      if (document.hidden) this.ctx.suspend();
      else if (!this.muted) this.ctx.resume().catch(() => {});
    });
  }
  show() { if (this.btn && this.state !== 'off') this.btn.classList.add('on'); }
  prepare() { if (window.AudioContext || window.webkitAudioContext) prepareSounds(this.low); }
  syncUI() {
    if (!this.btn) return;
    const playing = this.state !== 'idle' && this.state !== 'off' && !this.muted;
    this.btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
  }
  save() { try { localStorage.setItem('sakura-village-muted', this.muted ? '1' : '0'); } catch (e) { /* storage blocked */ } }
  unlock(fromButton) {
    if (this.state !== 'idle') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.state = 'off'; if (this.btn) this.btn.style.display = 'none'; return; }
    if (fromButton) { this.muted = false; this.save(); }
    this.state = 'starting';
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    let ctx;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    this.ctx = ctx;
    if (!this.muted) ctx.resume().catch(() => {}); // inside the gesture, so the browser lets it start
    this.syncUI();
    prepareSounds(this.low).then((data) => {
      const B = toBuffers(ctx, data);
      data.bufs = null; // the AudioBuffers hold their own copy
      this.mix = new Mix(ctx, B, sceneInfo(this.life), { hrtf: !this.low, seed: (Math.random() * 1e9) | 0 });
      this.state = 'on';
      if (this.muted) ctx.suspend();
      else this.mix.fadeTo(MASTER, ctx.currentTime + 0.05, 3);
      this.syncUI();
    }).catch((e) => { console.warn('audio unavailable', e); this.state = 'off'; if (this.btn) this.btn.style.display = 'none'; });
  }
  toggle() {
    if (this.state === 'idle') { this.unlock(true); return; }
    if (this.state === 'off') return;
    this.muted = !this.muted;
    this.save();
    this.syncUI();
    if (this.state !== 'on') { if (!this.muted) this.ctx.resume().catch(() => {}); return; }
    const ctx = this.ctx;
    clearTimeout(this.susT);
    if (this.muted) {
      this.mix.fadeTo(0, ctx.currentTime, 0.35);
      this.susT = setTimeout(() => { if (this.muted) ctx.suspend(); }, 450);
    } else {
      ctx.resume().then(() => this.mix.fadeTo(MASTER, ctx.currentTime, 0.8));
    }
  }
  update(simT, camera) {
    if (this.state !== 'on' || this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastTick < 1 / 30) return;
    this.lastTick = now;
    const e = camera.matrixWorld.elements;
    this.mix.tick(now, simT + 1000, [e[12], e[13], e[14]], [-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]);
  }
}

// ---------- offline render of the camera path (for the video soundtrack) ----------
export async function renderOffline(life, dur, pose, solo = null) {
  const data = await prepareSounds(false);
  const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const mix = new Mix(ctx, toBuffers(ctx, data), sceneInfo(life), { offline: true, hrtf: true, seed: 20261125, solo });
  mix.out.gain.value = MASTER;
  for (let k = 0; k <= dur * 30; k++) {
    const t = k / 30, { pos, fwd, up } = pose(t);
    mix.tick(t, t + 1000, pos, fwd, up);
  }
  const out = await ctx.startRendering();
  // 16-bit PCM WAV, base64
  const n = out.length, L = out.getChannelData(0), Rc = out.getChannelData(1);
  const bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.round(clamp(L[i], -1, 1) * 32767), true);
    dv.setInt16(46 + i * 4, Math.round(clamp(Rc[i], -1, 1) * 32767), true);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
