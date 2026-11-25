// Procedural traditional Japanese architecture.
import * as THREE from 'three';
import { Builder, box, cyl, lathe, quad, M, mul, segMatrix, fan, srgb, scaleC, mixC } from './geom.js';
import { buildRoof } from './roof.js';
import { RNG } from './noise.js';
import { layout, hAt, LAND_Y, riverXAt, toriiPathHeight, WATER_Y } from './world.js';

export const C = {
  wood: srgb('#4a3424'), woodD: srgb('#33241a'), woodL: srgb('#6e4e33'), woodW: srgb('#7b6650'),
  plaster: srgb('#efe8da'), cream: srgb('#e6d7bd'), clay: srgb('#c49a6c'),
  stone: srgb('#8d887e'), stoneD: srgb('#6c6860'),
  roof: srgb('#737d8a'), roofD: srgb('#646d7a'), ridge: srgb('#4b525d'),
  thatch: srgb('#9a7c52'), verm: srgb('#c8412b'), vermD: srgb('#a2321f'), black: srgb('#1d1b1a'),
  gold: srgb('#d9a845'), bronze: srgb('#7a6a48'), dark: srgb('#0d0a08'), noren: srgb('#26375e'),
  norenR: srgb('#7a1f22'), bamboo: srgb('#a89a5a'), redCloth: srgb('#b3242a'), white: srgb('#f4f1ea'),
};

export const hanging = []; // chochin lantern anchors {x,y,z,color,s}
export const lights = []; // candidate point lights {x,y,z,i}
export const smokeSources = [];

function vary(c, rng, k = 0.12) { const f = 1 + (rng.next() - 0.5) * 2 * k; return [c[0] * f, c[1] * f, c[2] * f]; }

function wallFrames(base, w, d) {
  return {
    front: { m: mul(base, M(0, 0, d / 2, 0)), L: w },
    back: { m: mul(base, M(0, 0, -d / 2, Math.PI)), L: w },
    right: { m: mul(base, M(w / 2, 0, 0, Math.PI / 2)), L: d },
    left: { m: mul(base, M(-w / 2, 0, 0, -Math.PI / 2)), L: d },
  };
}

// ---- wall bay infill in wall frame (u along wall, outward +z) ----
function bay(b, F, u0, u1, y0, y1, kind, o) {
  const w = u1 - u0, cu = (u0 + u1) / 2, h = y1 - y0;
  const wood = o.wood, rng = o.rng;
  const plasterC = o.plaster;
  const P = (x, y, z) => mul(F.m, M(x, y, z));
  switch (kind) {
    case 'plaster': {
      const ws = o.wainscot ? Math.min(0.85, h * 0.4) : 0;
      if (ws) b.add('wood', box(w, ws, 0.1), P(cu, y0 + ws / 2, 0.012), scaleC(wood, 0.95));
      b.add('plaster', box(w, h - ws, 0.1), P(cu, y0 + ws + (h - ws) / 2, 0), plasterC);
      if (ws) b.add('wood', box(w, 0.06, 0.13), P(cu, y0 + ws, 0.02), wood);
      break;
    }
    case 'boards': {
      b.add('wood', box(w, h, 0.1), P(cu, y0 + h / 2, 0.01), scaleC(wood, 1.1));
      const n = Math.floor(w / 0.6);
      for (let i = 1; i < n; i++) b.add('wood', box(0.04, h, 0.03), P(u0 + (i * w) / n, y0 + h / 2, 0.065), scaleC(wood, 0.7));
      break;
    }
    case 'shoji': {
      const sh = Math.min(h - 0.35, 2.05);
      const np = w > 1.3 ? 2 : 1;
      const pw = w / np;
      const key = o.lit ? 'shojiLit' : 'shojiDim';
      for (let i = 0; i < np; i++) {
        const pu = u0 + pw * (i + 0.5);
        b.add(key, quad(pw - 0.02, sh), P(pu, y0 + sh / 2, (i % 2) * 0.03 - 0.01), [1, 1, 1]);
      }
      b.add('wood', box(w, 0.08, 0.14), P(cu, y0 + 0.04, 0.0), wood);
      b.add('wood', box(w, 0.12, 0.14), P(cu, y0 + sh + 0.06, 0.0), wood);
      if (h - sh - 0.12 > 0.05) {
        const th = h - sh - 0.12;
        if (o.ranma) {
          b.add('wood', box(w, th, 0.06), P(cu, y0 + sh + 0.12 + th / 2, -0.03), scaleC(C.dark, 1));
          const n = Math.floor(w / 0.12);
          for (let i = 0; i <= n; i++) b.add('wood', box(0.03, th, 0.04), P(u0 + (i * w) / n, y0 + sh + 0.12 + th / 2, 0.01), wood);
        } else b.add('plaster', box(w, th, 0.1), P(cu, y0 + sh + 0.12 + th / 2, 0), plasterC);
      }
      break;
    }
    case 'koshi': {
      const kh = Math.min(h - 0.3, 2.1);
      // warm light behind the lattice
      b.add(o.lit ? 'shojiLit' : 'shojiDim', quad(w, kh), P(cu, y0 + kh / 2, -0.04), [1, 1, 1]);
      const n = Math.floor(w / 0.085);
      for (let i = 0; i <= n; i++) b.add('wood', box(0.035, kh, 0.05), P(u0 + (i * w) / n, y0 + kh / 2, 0.035), scaleC(o.woodL, 1));
      b.add('wood', box(w, 0.06, 0.08), P(cu, y0 + kh * 0.62, 0.065), o.woodL);
      b.add('wood', box(w, 0.1, 0.14), P(cu, y0 + kh + 0.05, 0.0), wood);
      b.add('wood', box(w, 0.08, 0.14), P(cu, y0 + 0.04, 0.0), wood);
      if (h - kh - 0.1 > 0.05) b.add('plaster', box(w, h - kh - 0.1, 0.1), P(cu, y0 + kh + 0.1 + (h - kh - 0.1) / 2, 0), plasterC);
      break;
    }
    case 'door': {
      const dh = Math.min(h - 0.3, 2.0);
      b.add('wood', box(w, dh, 0.06), P(cu, y0 + dh / 2, -0.12), C.dark);
      b.add('shojiLit', quad(w * 0.7, dh * 0.8), P(cu, y0 + dh * 0.4, -0.2), [1, 1, 1]);
      b.add('wood', box(w + 0.1, 0.14, 0.16), P(cu, y0 + dh + 0.07, 0.0), wood);
      if (h - dh - 0.14 > 0.05) b.add('plaster', box(w, h - dh - 0.14, 0.1), P(cu, y0 + dh + 0.14 + (h - dh - 0.14) / 2, 0), plasterC);
      // noren curtain (split panels)
      const np = 3, pw = (w * 0.92) / np;
      const nc = rng.chance(0.5) ? C.noren : rng.chance(0.5) ? C.norenR : srgb('#3d4a3a');
      for (let i = 0; i < np; i++) {
        const pu = u0 + w * 0.04 + pw * (i + 0.5);
        b.add('cloth', quad(pw - 0.03, 0.95), P(pu, y0 + dh - 0.48, 0.12), nc);
      }
      b.add('wood', cyl(0.025, 0.025, w, 6), mul(P(cu, y0 + dh + 0.0, 0.12), M(0, 0, 0, 0, 0, Math.PI / 2)), C.woodD);
      if (o.lantern) {
        const wp = new THREE.Vector3(u0 - 0.35, y0 + dh + 0.2, 0.5).applyMatrix4(F.m);
        hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: rng.chance(0.7) ? 0 : 1, s: 0.9 });
      }
      break;
    }
    case 'window': {
      b.add('plaster', box(w, h, 0.1), P(cu, y0 + h / 2, 0), plasterC);
      const ww = Math.min(w * 0.6, 1.3), wh = Math.min(h * 0.4, 0.8), wy = y0 + h * 0.55;
      b.add(o.lit ? 'shojiLit' : 'shojiDim', quad(ww, wh), P(cu, wy, 0.055), [1, 1, 1]);
      const n = Math.floor(ww / 0.1);
      for (let i = 0; i <= n; i++) b.add('wood', box(0.035, wh, 0.04), P(cu - ww / 2 + (i * ww) / n, wy, 0.08), o.woodL);
      b.add('wood', box(ww + 0.12, 0.06, 0.1), P(cu, wy + wh / 2 + 0.03, 0.07), wood);
      b.add('wood', box(ww + 0.12, 0.06, 0.1), P(cu, wy - wh / 2 - 0.03, 0.07), wood);
      break;
    }
    case 'mushiko': {
      b.add('plaster', box(w, h, 0.1), P(cu, y0 + h / 2, 0), plasterC);
      const ww = w * 0.8, wh = h * 0.45, wy = y0 + h * 0.5;
      b.add(o.lit ? 'shojiLit' : 'shojiDim', quad(ww, wh), P(cu, wy, 0.0), [1, 1, 1]);
      const n = Math.floor(ww / 0.14);
      for (let i = 0; i <= n; i++) b.add('plaster', box(0.07, wh, 0.12), P(cu - ww / 2 + (i * ww) / n, wy, 0.04), scaleC(plasterC, 0.96));
      break;
    }
  }
}

function postsAndBeams(b, base, w, d, y0, y1, o, posts = true) {
  const ps = o.ps || 0.17;
  const nx = Math.max(2, Math.round(w / 1.8)), nz = Math.max(2, Math.round(d / 1.8));
  if (posts) {
    for (let i = 0; i <= nx; i++) for (const sz of [-1, 1]) b.add('wood', box(ps, y1 - y0, ps), mul(base, M(-w / 2 + (i * w) / nx, (y0 + y1) / 2, sz * d / 2)), o.wood);
    for (let j = 1; j < nz; j++) for (const sx of [-1, 1]) b.add('wood', box(ps, y1 - y0, ps), mul(base, M(sx * w / 2, (y0 + y1) / 2, -d / 2 + (j * d) / nz)), o.wood);
  }
  // sill and head beams
  for (const [yy, hh] of [[y0 + 0.07, 0.14], [y1 - 0.1, 0.2]]) {
    b.add('wood', box(w + ps, hh, ps + 0.02), mul(base, M(0, yy, d / 2)), o.wood);
    b.add('wood', box(w + ps, hh, ps + 0.02), mul(base, M(0, yy, -d / 2)), o.wood);
    b.add('wood', box(ps + 0.02, hh, d + ps), mul(base, M(w / 2, yy, 0)), o.wood);
    b.add('wood', box(ps + 0.02, hh, d + ps), mul(base, M(-w / 2, yy, 0)), o.wood);
  }
  return { nx, nz };
}

function fillWall(b, F, n, y0, y1, kinds, o) {
  const L = F.L;
  for (let i = 0; i < n; i++) {
    const u0 = -L / 2 + (i * L) / n + 0.085, u1 = -L / 2 + ((i + 1) * L) / n - 0.085;
    bay(b, F, u0, u1, y0 + 0.14, y1 - 0.2, kinds[i % kinds.length], o);
  }
}

function gableWall(b, base, x, w, d, roofInfo, yBase, ez, thick, plasterC, wood) {
  // triangular wall in plane x = const between wall top (yBase) and roof underside
  const pts = [];
  const tw = (ez - d / 2) / ez;
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = tw + (1 - tw) * (i / steps);
    pts.push([x, roofInfo.y0 + roofInfo.yOf(t) - thick - 0.02, ez * (1 - t), ez * (1 - t), roofInfo.y0 + roofInfo.yOf(t)]);
  }
  for (let i = steps - 1; i >= 0; i--) {
    const t = tw + (1 - tw) * (i / steps);
    pts.push([x, roofInfo.y0 + roofInfo.yOf(t) - thick - 0.02, -ez * (1 - t), -ez * (1 - t), roofInfo.y0 + roofInfo.yOf(t)]);
  }
  const poly = [[x, yBase, 0, 0, yBase], [x, yBase, d / 2, d / 2, yBase], ...pts, [x, yBase, -d / 2, -d / 2, yBase]];
  b.add('plaster', fan(poly, [Math.sign(x), 0, 0]), base, plasterC);
  // exposed timber on gable
  const top = roofInfo.y0 + roofInfo.yOf(1) - thick;
  const sx = Math.sign(x);
  b.add('wood', box(0.12, top - yBase, 0.16), mul(base, M(x + sx * 0.03, (top + yBase) / 2, 0)), wood);
  const ym = yBase + (top - yBase) * 0.45;
  const tm = (() => { // z half-width at ym
    let best = 0;
    for (let i = 0; i <= 40; i++) { const t = tw + (1 - tw) * i / 40; if (roofInfo.y0 + roofInfo.yOf(t) - thick > ym) { best = ez * (1 - t); break; } }
    return best;
  })();
  if (tm > 0.3) b.add('wood', box(0.12, 0.16, tm * 2), mul(base, M(x + sx * 0.03, ym, 0)), wood);
  // small vent
  b.add('wood', box(0.06, 0.35, 0.5), mul(base, M(x + sx * 0.05, ym + (top - ym) * 0.45, 0)), C.dark);
}

// ---------------- houses ----------------
export function makeHouse(b, H) {
  const rng = new RNG(H.seed);
  const base = M(H.x, H.y, H.z, H.rot);
  const { w, d } = H;
  const wood = vary(rng.chance(0.25) ? C.woodL : C.wood, rng, 0.15);
  const woodL = vary(C.woodL, rng, 0.12);
  const plasterC = rng.chance(0.18) ? vary(C.clay, rng, 0.06) : rng.chance(0.3) ? vary(C.cream, rng, 0.04) : vary(C.plaster, rng, 0.03);
  const roofC = vary(C.roof, rng, 0.1);
  const lit = rng.chance(0.75);
  const o = { wood, woodL, plaster: plasterC, rng, lit, wainscot: true, ps: 0.17 };
  const plinth = H.type === 'kura' ? 0.6 : 0.42;

  // stone plinth
  b.add('stone', box(w + 0.35, plinth, d + 0.35), mul(base, M(0, plinth / 2 - 0.05, 0)), vary(C.stone, rng, 0.08));

  if (H.type === 'machiya' || H.type === 'riverside') {
    const h1 = 2.75, h2 = 2.25;
    const y0 = plinth, y1 = y0 + h1, y2 = y1 + 0.3, y3 = y2 + h2;
    postsAndBeams(b, base, w, d, y0, y1, o);
    postsAndBeams(b, base, w, d, y2, y3, o);
    // floor band between storeys
    b.add('wood', box(w + 0.2, 0.32, d + 0.2), mul(base, M(0, y1 + 0.13, 0)), scaleC(wood, 0.9));
    const F = wallFrames(base, w, d);
    const nF = Math.max(3, Math.round(w / 1.8)), nS = Math.max(4, Math.round(d / 1.8));
    const front1 = [];
    const doorI = rng.chance(0.5) ? 0 : nF - 1;
    for (let i = 0; i < nF; i++) front1.push(i === doorI ? 'door' : H.type === 'riverside' ? 'shoji' : 'koshi');
    fillWall(b, F.front, nF, y0, y1, front1, { ...o, lantern: true });
    fillWall(b, F.back, nF, y0, y1, ['plaster', 'window', 'plaster'], o);
    fillWall(b, F.left, nS, y0, y1, ['plaster'], o);
    fillWall(b, F.right, nS, y0, y1, ['plaster', 'plaster', 'window'], o);
    // upper floor
    const up = H.type === 'riverside' ? 'shoji' : rng.chance(0.6) ? 'mushiko' : 'window';
    fillWall(b, F.front, nF, y2, y3, [up, 'plaster', up], { ...o, wainscot: false, ranma: true });
    fillWall(b, F.back, nF, y2, y3, ['plaster', 'window'], { ...o, wainscot: false });
    fillWall(b, F.left, nS, y2, y3, ['plaster'], { ...o, wainscot: false });
    fillWall(b, F.right, nS, y2, y3, ['plaster'], { ...o, wainscot: false });
    // pent roof (hisashi) along the front
    buildRoof(b, mul(base, M(0, y1 + 0.32, d / 2)), {
      type: 'shed', ex: w / 2 + 0.25, ez: 1.05, H: 0.55, curve: 0.2, lift: 0.0, tileP: 0.27, tileH: 0.045,
      thick: 0.12, roofColor: roofC, ridgeColor: scaleC(roofC, 0.75), underColor: scaleC(wood, 0.8), rafters: true, wallZ: 0.01,
    });
    // also at back
    buildRoof(b, mul(base, M(0, y1 + 0.32, -d / 2, Math.PI)), {
      type: 'shed', ex: w / 2 + 0.25, ez: 0.8, H: 0.45, curve: 0.2, lift: 0.0, tileP: 0.27, tileH: 0.045,
      thick: 0.12, roofColor: roofC, ridgeColor: scaleC(roofC, 0.75), underColor: scaleC(wood, 0.8), rafters: false,
    });
    if (H.type === 'riverside') balcony(b, base, w, d, y2, wood, woodL, rng);
    // main gable roof, ridge along x (parallel to street)
    const ez = d / 2 + 0.9, ex = w / 2 + 0.55, Hr = d * 0.27;
    const tw = (ez - d / 2) / ez;
    const curve = 0.35;
    const a = 1 - curve;
    const yOfTw = Hr * (a * tw + (1 - a) * tw * tw);
    const yr = y3 + 0.18 - yOfTw;
    const R = buildRoof(b, mul(base, M(0, yr, 0)), {
      type: 'gable', ex, ez, H: Hr, curve, lift: 0.05, tileP: 0.29, tileH: 0.055, thick: 0.2,
      roofColor: roofC, ridgeColor: scaleC(roofC, 0.72), underColor: scaleC(wood, 0.8), bargeColor: scaleC(wood, 0.85),
      wallZ: d / 2, ridgeH: 0.32,
    });
    R.y0 = yr;
    for (const sx of [1, -1]) gableWall(b, base, sx * (w / 2), w, d, R, y3, ez, 0.2, plasterC, wood);
    if (rng.chance(0.35)) smokeSources.push(new THREE.Vector3(0, yr + Hr + 0.4, 0).applyMatrix4(base));
  } else if (H.type === 'minka') {
    const h1 = 2.85;
    const y0 = plinth + 0.15, y1 = y0 + h1;
    // engawa deck
    b.add('wood', box(w + 0.2, 0.12, 1.05), mul(base, M(0, y0 - 0.06, d / 2 + 0.55)), woodL);
    for (let i = 0; i <= Math.round(w / 1.8); i++) b.add('wood', box(0.12, y0 - 0.1, 0.12), mul(base, M(-w / 2 + (i * w) / Math.round(w / 1.8), (y0 - 0.1) / 2, d / 2 + 0.98)), wood);
    b.add('wood', box(w + 0.2, 0.08, 0.14), mul(base, M(0, y0 - 0.16, d / 2 + 1.03)), wood);
    postsAndBeams(b, base, w, d, y0, y1, o);
    const F = wallFrames(base, w, d);
    const nF = Math.max(4, Math.round(w / 1.8)), nS = Math.max(4, Math.round(d / 1.8));
    const fr = []; for (let i = 0; i < nF; i++) fr.push(i === 1 ? 'door' : 'shoji');
    fillWall(b, F.front, nF, y0, y1, fr, { ...o, ranma: true, lantern: true });
    fillWall(b, F.back, nF, y0, y1, ['boards', 'window', 'boards', 'plaster'], o);
    fillWall(b, F.left, nS, y0, y1, ['plaster', 'boards'], o);
    fillWall(b, F.right, nS, y0, y1, ['plaster', 'shoji', 'plaster'], o);
    const thatch = rng.chance(0.5);
    const ez = d / 2 + (thatch ? 1.25 : 1.1), ex = w / 2 + (thatch ? 1.25 : 1.0);
    const Hr = thatch ? d * 0.62 : d * 0.42;
    const tw = (ez - d / 2) / ez;
    const curve = thatch ? 0.05 : 0.45;
    const a = 1 - curve;
    const yr = y1 + 0.2 - Hr * (a * tw + (1 - a) * tw * tw);
    if (thatch) {
      buildRoof(b, mul(base, M(0, yr, 0)), {
        type: 'irimoya', tf: 0.62, ex, ez, H: Hr, curve, lift: 0, kind: 'thatch', thick: 0.55,
        roofKey: 'thatch', roofColor: vary(C.thatch, rng, 0.1), ridgeKey: 'roof', ridgeColor: scaleC(C.roofD, 0.9),
        underColor: scaleC(wood, 0.7), bargeColor: scaleC(wood, 0.8), wallZ: d / 2, wallX: w / 2, rafters: true, rafterSpacing: 0.6,
        gableKey: 'wood', gableColor: scaleC(wood, 0.8),
      });
      smokeSources.push(new THREE.Vector3(ex - ez * 0.62 - 0.2, yr + Hr * 0.85, 0).applyMatrix4(base));
    } else {
      buildRoof(b, mul(base, M(0, yr, 0)), {
        type: 'irimoya', tf: 0.5, ex, ez, H: Hr, curve, lift: 0.22, flare: 0.05, tileP: 0.3, tileH: 0.06, thick: 0.24,
        roofColor: roofC, ridgeColor: scaleC(roofC, 0.7), underColor: scaleC(wood, 0.8), bargeColor: scaleC(wood, 0.85),
        wallZ: d / 2, wallX: w / 2, ridgeH: 0.42, ridgeW: 0.38, gableColor: plasterC,
      });
    }
  } else if (H.type === 'kura') {
    const h = 5.0;
    const y0 = plinth, y1 = y0 + h;
    const white = vary(C.white, rng, 0.02);
    // thick plaster body with namako skirt
    b.add('plaster', box(w, h, d), mul(base, M(0, y0 + h / 2, 0)), white);
    const sk = 1.3;
    b.add('namako', box(w + 0.08, sk, d + 0.08), mul(base, M(0, y0 + sk / 2, 0)), [1, 1, 1]);
    b.add('lacquer', box(w + 0.12, 0.12, d + 0.12), mul(base, M(0, y0 + sk + 0.04, 0)), C.black);
    // corner pilasters & mid band
    b.add('plaster', box(w + 0.16, 0.2, d + 0.16), mul(base, M(0, y0 + h * 0.55, 0)), scaleC(white, 0.97));
    // door with heavy shutters
    const F = wallFrames(base, w, d);
    const dP = (x, y, z) => mul(F.front.m, M(x, y, z));
    b.add('lacquer', box(1.5, 2.2, 0.2), dP(0, y0 + 1.1, 0.08), C.black);
    b.add('wood', box(1.1, 1.9, 0.1), dP(0, y0 + 0.95, 0.14), C.dark);
    b.add('plaster', box(1.9, 0.45, 0.4), dP(0, y0 + 2.45, 0.18), white);
    // upper windows
    for (const fr of [F.front, F.right, F.left]) {
      for (const u of fr === F.front ? [-w * 0.25, w * 0.25] : [0]) {
        b.add('lacquer', box(0.8, 0.8, 0.14), mul(fr.m, M(u, y0 + 3.7, 0.05)), C.black);
        b.add('wood', box(0.6, 0.6, 0.06), mul(fr.m, M(u, y0 + 3.7, 0.11)), C.dark);
        for (let k = -1; k <= 1; k++) b.add('metal', box(0.03, 0.6, 0.03), mul(fr.m, M(u + k * 0.18, y0 + 3.7, 0.14)), C.bronze);
        b.add('plaster', box(1.1, 0.12, 0.25), mul(fr.m, M(u, y0 + 4.18, 0.1)), white);
      }
    }
    const ez = d / 2 + 0.55, ex = w / 2 + 0.4, Hr = d * 0.33;
    const tw = (ez - d / 2) / ez;
    const a = 0.65;
    const yr = y1 + 0.15 - Hr * (a * tw + (1 - a) * tw * tw);
    const roofC2 = scaleC(roofC, 0.8);
    const R = buildRoof(b, mul(base, M(0, yr, 0)), {
      type: 'gable', ex, ez, H: Hr, curve: 0.35, lift: 0.04, tileP: 0.3, tileH: 0.06, thick: 0.28,
      roofColor: roofC2, ridgeColor: scaleC(roofC2, 0.7), underColor: white, underKey: 'plaster', bargeColor: white, wallZ: d / 2, ridgeH: 0.45, ridgeW: 0.42, rafters: false,
    });
    R.y0 = yr;
    for (const sx of [1, -1]) gableWall(b, base, sx * (w / 2), w, d, R, y1, ez, 0.28, white, white);
  }
}

function balcony(b, base, w, d, yFloor, wood, woodL, rng) {
  const dep = 1.05, z0 = d / 2;
  const P = (x, y, z) => mul(base, M(x, y, z));
  b.add('wood', box(w + 0.3, 0.1, dep), P(0, yFloor - 0.05, z0 + dep / 2), woodL);
  b.add('wood', box(w + 0.3, 0.18, 0.12), P(0, yFloor - 0.15, z0 + dep), wood);
  // posts down to ground
  const n = Math.max(2, Math.round(w / 2.2));
  for (let i = 0; i <= n; i++) {
    const x = -w / 2 - 0.1 + (i * (w + 0.2)) / n;
    b.add('wood', box(0.13, yFloor + 0.9, 0.13), P(x, (yFloor + 0.9) / 2, z0 + dep - 0.05), wood);
  }
  // railing
  const rh = 0.85;
  b.add('wood', box(w + 0.3, 0.07, 0.1), P(0, yFloor + rh, z0 + dep - 0.04), woodL);
  b.add('wood', box(w + 0.3, 0.05, 0.06), P(0, yFloor + 0.18, z0 + dep - 0.04), woodL);
  const nb = Math.floor(w / 0.16);
  for (let i = 0; i <= nb; i++) b.add('wood', box(0.035, rh - 0.18, 0.035), P(-w / 2 + (i * w) / nb, yFloor + 0.18 + (rh - 0.18) / 2, z0 + dep - 0.04), scaleC(woodL, 0.9));
  // side rails
  for (const sx of [1, -1]) b.add('wood', box(0.07, 0.07, dep), P(sx * (w / 2 + 0.12), yFloor + rh, z0 + dep / 2), woodL);
  // rolled sudare blinds
  for (let i = 0; i < 2; i++) b.add('wood', cyl(0.07, 0.07, w * 0.4, 8), mul(P((i - 0.5) * w * 0.5, yFloor + 2.0, z0 + 0.25), M(0, 0, 0, 0, 0, Math.PI / 2)), srgb('#a08a5c'));
  // lanterns under balcony
  if (rng.chance(0.8)) {
    for (const x of [-w * 0.3, w * 0.3]) {
      const wp = new THREE.Vector3(x, yFloor - 0.35, z0 + dep - 0.2).applyMatrix4(base);
      hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 0, s: 1 });
    }
  }
}

// ---------------- teahouse ----------------
export function makeTeahouse(b, T) {
  const y = hAt(T.x, T.z);
  const base = M(T.x, y, T.z, T.rot);
  const rng = new RNG(5);
  const w = 7.2, d = 5.4;
  const wood = C.woodL;
  const o = { wood: C.wood, woodL: C.woodL, plaster: C.cream, rng, lit: true, wainscot: true };
  const plinth = 0.3, y1 = plinth + 2.7;
  b.add('stone', box(w + 0.4, plinth, d + 0.4), mul(base, M(0, plinth / 2 - 0.05, 0)), C.stone);
  postsAndBeams(b, base, w, d, plinth, y1, o);
  const F = wallFrames(base, w, d);
  fillWall(b, F.back, 4, plinth, y1, ['plaster', 'window', 'plaster', 'plaster'], o);
  fillWall(b, F.left, 3, plinth, y1, ['plaster', 'shoji', 'plaster'], o);
  fillWall(b, F.right, 3, plinth, y1, ['plaster', 'shoji', 'plaster'], o);
  // open front: lit interior + noren strip
  b.add('shojiLit', quad(w - 0.4, 2.0), mul(F.front.m, M(0, plinth + 1.0, -d * 0.7)), [1, 1, 1]);
  b.add('wood', box(w - 0.3, 2.3, 0.05), mul(F.front.m, M(0, plinth + 1.15, -d * 0.72)), C.dark);
  b.add('wood', box(w, 0.08, d - 0.2), mul(base, M(0, plinth + 0.02, 0)), C.woodL);
  for (let i = 0; i < 6; i++) b.add('cloth', quad(1.1, 0.55), mul(F.front.m, M(-w / 2 + 0.65 + i * 1.18, y1 - 0.45, 0.1)), C.noren);
  // benches with red cloth
  for (const [x, z, r] of [[-2.0, 4.6, 0], [2.0, 4.6, 0], [4.6, 1.2, Math.PI / 2]]) {
    const bm = mul(base, M(x, 0, z, r));
    b.add('wood', box(1.9, 0.08, 0.75), mul(bm, M(0, 0.45, 0)), wood);
    b.add('cloth2', box(1.95, 0.025, 0.8), mul(bm, M(0, 0.5, 0)), C.redCloth);
    b.add('cloth2', box(1.95, 0.25, 0.02), mul(bm, M(0, 0.39, 0.4)), C.redCloth);
    for (const sx of [-0.8, 0.8]) for (const sz of [-0.3, 0.3]) b.add('wood', box(0.07, 0.45, 0.07), mul(bm, M(sx, 0.22, sz)), C.wood);
  }
  // parasol (nodate-gasa)
  const pm = mul(base, M(0.2, 0, 4.8));
  b.add('wood', cyl(0.035, 0.035, 2.9, 6), mul(pm, M(0, 1.45, 0)), C.woodL);
  b.add('cloth2', lathe([[0.02, 0], [0.6, -0.12], [1.2, -0.3], [1.65, -0.52], [1.72, -0.56]], 20), mul(pm, M(0, 3.0, 0)), C.redCloth);
  const lat = lathe([[1.72, -0.56], [1.65, -0.52], [1.2, -0.3], [0.6, -0.12], [0.02, 0]], 20);
  b.add('cloth2', lat, mul(pm, M(0, 2.995, 0)), scaleC(C.redCloth, 0.6));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const { m, len } = segMatrix([0, 2.3, 0], [Math.cos(a) * 1.3, 2.72, Math.sin(a) * 1.3]);
    b.add('wood', box(0.015, 0.015, len), mul(pm, m), C.woodL);
  }
  // roof (irimoya)
  const ez = d / 2 + 1.5, ex = w / 2 + 0.8, Hr = 2.0;
  const tw = (ez - d / 2) / ez; const a = 0.6;
  const yr = y1 + 0.18 - Hr * (a * tw + (1 - a) * tw * tw);
  buildRoof(b, mul(base, M(0, yr, 0)), {
    type: 'irimoya', tf: 0.5, ex, ez, H: Hr, curve: 0.4, lift: 0.2, tileP: 0.27, tileH: 0.05, thick: 0.2,
    roofColor: C.roof, ridgeColor: C.ridge, underColor: C.wood, bargeColor: C.wood, wallZ: d / 2, wallX: w / 2, gableColor: C.cream,
  });
  for (const x of [-w / 2 - 0.2, w / 2 + 0.2]) {
    const wp = new THREE.Vector3(x, y1 - 0.2, d / 2 + 0.9).applyMatrix4(base);
    hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 0, s: 1.2 });
  }
  for (let i = 0; i < 4; i++) {
    const wp = new THREE.Vector3(-w / 2 + 1 + i * 1.75, y1 - 0.05, d / 2 + 1.1).applyMatrix4(base);
    hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: i % 2, s: 0.75 });
  }
  const lp = new THREE.Vector3(0, 2.2, d / 2 + 2).applyMatrix4(base);
  lights.push({ x: lp.x, y: lp.y, z: lp.z, i: 1.2 });
}

// ---------------- torii ----------------
export function makeTorii(b, x, y, z, rot, s = 1, simple = false) {
  const base = M(x, y, z, rot, 0, 0, s, s, s);
  const span = simple ? 1.9 : 3.6, H = simple ? 3.0 : 5.0;
  const pr = simple ? 0.11 : 0.24;
  const V = C.verm, K = C.black;
  for (const sx of [-1, 1]) {
    const lean = sx * 0.025;
    const pm = mul(base, M(sx * span / 2, H / 2, 0, 0, 0, lean));
    b.add('lacquer', cyl(pr * 0.92, pr, H, 14), pm, V);
    b.add('lacquer', cyl(pr * 1.18, pr * 1.22, simple ? 0.35 : 0.6, 14), mul(base, M(sx * span / 2 - lean * 0.3, simple ? 0.17 : 0.3, 0)), K);
    if (!simple) b.add('lacquer', cyl(pr * 1.08, pr * 1.08, 0.18, 14), mul(base, M(sx * (span / 2 - 0.08), H - 0.15, 0)), K);
  }
  // nuki
  const ny = H * (simple ? 0.74 : 0.76);
  b.add('lacquer', box(span + (simple ? 0.7 : 1.4), simple ? 0.16 : 0.32, simple ? 0.1 : 0.2), mul(base, M(0, ny, 0)), V);
  // gakuzuka
  if (!simple) b.add('lacquer', box(0.28, H - ny - 0.1, 0.18), mul(base, M(0, (H + ny) / 2 + 0.05, 0)), V);
  // kasagi + shimaki with upturned ends
  const L = span + (simple ? 1.3 : 2.8);
  const n = 10;
  const curve = (u) => (simple ? 0.12 : 0.32) * Math.pow(Math.abs(u), 2.4);
  for (let i = 0; i < n; i++) {
    const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n;
    const p0 = [u0 * L / 2, H + 0.12 + curve(u0), 0], p1 = [u1 * L / 2, H + 0.12 + curve(u1), 0];
    const { m, len } = segMatrix(p0, p1);
    const sh = simple ? 0.14 : 0.26;
    b.add('lacquer', box(simple ? 0.16 : 0.3, sh, len + 0.02), mul(base, mul(m, M(0, 0, 0))), V);
    const k0 = [p0[0] * 1.02, p0[1] + sh * 0.5 + (simple ? 0.06 : 0.12), 0], k1 = [p1[0] * 1.02, p1[1] + sh * 0.5 + (simple ? 0.06 : 0.12), 0];
    const r2 = segMatrix(k0, k1);
    b.add('lacquer', box(simple ? 0.2 : 0.42, simple ? 0.12 : 0.24, r2.len + 0.03), mul(base, r2.m), K);
  }
}

// ---------------- stone lantern ----------------
export function makeStoneLantern(b, x, y, z, s = 1, kind = 'kasuga', rot = 0) {
  const base = M(x, y, z, rot, 0, 0, s, s, s);
  const st = C.stone;
  const P = (yy, m2 = null) => mul(base, M(0, yy, 0));
  if (kind === 'yukimi') {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const { m, len } = segMatrix([Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55], [Math.cos(a) * 0.25, 0.62, Math.sin(a) * 0.25]);
      b.add('stone', box(0.12, 0.12, len), mul(base, m), st);
    }
    b.add('stone', cyl(0.3, 0.3, 0.1, 6), P(0.68), st);
    b.add('glow', cyl(0.2, 0.2, 0.3, 6), P(0.88), [1, 1, 1]);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; b.add('stone', box(0.06, 0.32, 0.06), mul(base, M(Math.cos(a) * 0.24, 0.88, Math.sin(a) * 0.24)), st); }
    b.add('stone', cyl(0.18, 0.95, 0.36, 6), P(1.2), st);
    b.add('stone', lathe([[0, 0], [0.12, 0.02], [0.14, 0.12], [0.08, 0.24], [0, 0.3]], 10), P(1.36), st);
    lights.push({ x, y: y + 0.9 * s, z, i: 0.5, small: true });
    return;
  }
  b.add('stone', cyl(0.42, 0.5, 0.22, 6), P(0.11), st);
  b.add('stone', cyl(0.25, 0.34, 0.14, 6), P(0.29), st);
  b.add('stone', cyl(0.13, 0.15, 1.0, 12), P(0.86), st);
  b.add('stone', cyl(0.16, 0.16, 0.06, 12), P(0.86), scaleC(st, 0.9));
  b.add('stone', cyl(0.36, 0.24, 0.2, 6), P(1.45), st);
  b.add('glow', cyl(0.2, 0.2, 0.36, 6), P(1.75), [1, 1, 1]);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; b.add('stone', box(0.07, 0.4, 0.07), mul(base, M(Math.cos(a) * 0.25, 1.75, Math.sin(a) * 0.25)), st); }
  b.add('stone', cyl(0.3, 0.3, 0.05, 6), P(1.57), st);
  b.add('stone', cyl(0.06, 0.58, 0.32, 6), P(2.1), st);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.add('stone', box(0.1, 0.12, 0.12), mul(base, M(Math.cos(a) * 0.55, 1.98, Math.sin(a) * 0.55, -a, 0, 0)), st); }
  b.add('stone', lathe([[0, 0], [0.1, 0.02], [0.13, 0.12], [0.07, 0.22], [0.02, 0.3], [0, 0.32]], 10), P(2.25), st);
  lights.push({ x, y: y + 1.75 * s, z, i: 0.6, small: true });
}

// ---------------- bridges ----------------
export function makeBridge(b, B) {
  const base = M(B.x, 0, B.z, B.rot);
  const L = B.len, W = B.w;
  if (B.type === 'arch') {
    const yEnd = LAND_Y + 0.15;
    const rise = B.rise;
    const yOf = (u) => yEnd + rise * (1 - u * u); // u in [-1,1]
    const n = Math.floor(L / 0.24);
    for (let i = 0; i < n; i++) {
      const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n;
      const p0 = [u0 * L / 2, yOf(u0), 0], p1 = [u1 * L / 2, yOf(u1), 0];
      const r = segMatrix(p0, p1);
      b.add('wood', box(W, 0.08, r.len - 0.02), mul(base, r.m), vary(C.woodW, new RNG(i), 0.1));
    }
    // girders + fascia (vermilion)
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 16; i++) {
        const u0 = -1 + (2 * i) / 16, u1 = -1 + (2 * (i + 1)) / 16;
        const p0 = [u0 * L / 2, yOf(u0) - 0.22, sz * (W / 2 - 0.05)], p1 = [u1 * L / 2, yOf(u1) - 0.22, sz * (W / 2 - 0.05)];
        const r = segMatrix(p0, p1);
        b.add('lacquer', box(0.14, 0.36, r.len + 0.03), mul(base, r.m), C.verm);
        // railing rails
        const q0 = [p0[0], p0[1] + 1.15, p0[2]], q1 = [p1[0], p1[1] + 1.15, p1[2]];
        const r2 = segMatrix(q0, q1);
        b.add('lacquer', box(0.12, 0.1, r2.len + 0.03), mul(base, r2.m), C.verm);
        const q2 = [p0[0], p0[1] + 0.62, p0[2]], q3 = [p1[0], p1[1] + 0.62, p1[2]];
        const r3 = segMatrix(q2, q3);
        b.add('lacquer', box(0.07, 0.07, r3.len + 0.03), mul(base, r3.m), C.verm);
      }
      // posts + giboshi
      const np = 8;
      for (let i = 0; i <= np; i++) {
        const u = -1 + (2 * i) / np;
        const px = u * L / 2, py = yOf(u);
        const main = i === 0 || i === np || i === np / 2;
        const ph = main ? 1.45 : 1.25;
        b.add('lacquer', box(0.15, ph, 0.15), mul(base, M(px, py + ph / 2 - 0.1, sz * (W / 2 - 0.05))), C.verm);
        if (main) {
          const gm = mul(base, M(px, py + ph - 0.1, sz * (W / 2 - 0.05)));
          b.add('metal', lathe([[0.1, 0], [0.11, 0.08], [0.06, 0.1], [0.12, 0.2], [0.1, 0.3], [0.03, 0.4], [0, 0.48]], 12), gm, C.gold);
        }
      }
    }
    // cross beams + piers in water
    for (const u of [-0.62, -0.25, 0.25, 0.62]) {
      const px = u * L / 2, py = yOf(u) - 0.42;
      b.add('wood', box(0.22, 0.22, W + 0.5), mul(base, M(px, py, 0)), C.woodD);
      for (const sz of [-1, 1]) {
        const h = py + 1.8;
        b.add('wood', cyl(0.14, 0.16, h, 10), mul(base, M(px, py - h / 2, sz * (W / 2 - 0.2))), C.woodD);
      }
      // diagonal brace
      const { m, len } = segMatrix([px, py - 0.2, -W / 2 + 0.2], [px, -0.6, W / 2 - 0.2]);
      b.add('wood', box(0.1, 0.1, len), mul(base, m), C.woodD);
    }
    // stone abutments
    for (const sx of [-1, 1]) b.add('stone', box(2.2, 2.2, W + 1.2), mul(base, M(sx * (L / 2 - 0.6), yEnd - 1.1, 0)), C.stoneD);
  } else {
    const flat = B.type === 'flat';
    const yEnd = LAND_Y + (flat ? 0.1 : -0.1);
    const rise = flat ? 0.55 : 0.2;
    const yOf = (u) => yEnd + rise * (1 - u * u);
    const n = Math.floor(L / 0.26);
    const rng = new RNG(B.z | 0);
    for (let i = 0; i < n; i++) {
      const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n;
      const p0 = [u0 * L / 2, yOf(u0), 0], p1 = [u1 * L / 2, yOf(u1), 0];
      const r = segMatrix(p0, p1);
      b.add('wood', box(W + rng.range(-0.1, 0.1), 0.08, r.len - 0.025), mul(base, mul(r.m, M(rng.range(-0.04, 0.04), 0, 0))), vary(C.woodW, rng, 0.15));
    }
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 10; i++) {
        const u0 = -1 + (2 * i) / 10, u1 = -1 + (2 * (i + 1)) / 10;
        const p0 = [u0 * L / 2, yOf(u0) - 0.16, sz * (W / 2 - 0.12)], p1 = [u1 * L / 2, yOf(u1) - 0.16, sz * (W / 2 - 0.12)];
        const r = segMatrix(p0, p1);
        b.add('wood', box(0.14, 0.22, r.len + 0.02), mul(base, r.m), C.woodD);
        if (flat) {
          const q0 = [p0[0], p0[1] + 1.05, sz * (W / 2 - 0.04)], q1 = [p1[0], p1[1] + 1.05, sz * (W / 2 - 0.04)];
          const r2 = segMatrix(q0, q1);
          b.add('wood', box(0.1, 0.09, r2.len + 0.02), mul(base, r2.m), C.woodW);
        }
      }
      if (flat) for (let i = 0; i <= 8; i++) {
        const u = -1 + (2 * i) / 8, px = u * L / 2, py = yOf(u);
        b.add('wood', box(0.12, 1.1, 0.12), mul(base, M(px, py + 0.45, sz * (W / 2 - 0.04))), C.woodD);
      }
    }
    const piers = flat ? [-0.5, 0, 0.5] : [-0.6, -0.2, 0.2, 0.6];
    for (const u of piers) {
      const px = u * L / 2, py = yOf(u) - 0.3;
      b.add('wood', box(0.18, 0.18, W + 0.4), mul(base, M(px, py, 0)), C.woodD);
      for (const sz of [-1, 1]) {
        const h = py + 1.8;
        b.add('wood', cyl(0.12, 0.14, h, 8), mul(base, M(px, py - h / 2, sz * (W / 2 - 0.1))), C.woodD);
      }
    }
  }
}

// ---------------- pagoda (five storeys) ----------------
export function makePagoda(b, Pd) {
  const base = M(Pd.x, Pd.y, Pd.z, 0.2);
  const P = (x, y, z) => mul(base, M(x, y, z));
  // podium
  b.add('stone', box(10, 0.9, 10), P(0, 0.45, 0), C.stone);
  b.add('stone', box(10.4, 0.12, 10.4), P(0, 0.9, 0), C.stoneD);
  for (const [r, w] of [[0, 3], [Math.PI / 2, 3], [Math.PI, 3], [-Math.PI / 2, 3]]) {
    for (let k = 0; k < 3; k++) b.add('stone', box(w, 0.3, 0.45), mul(base, M(0, 0, 0, r)).multiply(M(0, 0.15 + k * 0.3, 5.5 + (2 - k) * 0.42)), C.stoneD);
  }
  let y = 1.0;
  const tiers = 5;
  let bw = 6.2;
  for (let i = 0; i < tiers; i++) {
    const bh = i === 0 ? 3.2 : 2.25;
    const hw = bw / 2;
    // body
    if (i > 0) {
      // balcony deck + railing
      b.add('wood', box(bw + 1.4, 0.12, bw + 1.4), P(0, y + 0.06, 0), C.woodD);
      for (let s = 0; s < 4; s++) {
        const rm = mul(base, M(0, 0, 0, (s * Math.PI) / 2));
        const rr = hw + 0.65;
        b.add('lacquer', box(bw + 1.3, 0.06, 0.06), mul(rm, M(0, y + 0.62, rr)), C.verm);
        b.add('lacquer', box(bw + 1.3, 0.05, 0.05), mul(rm, M(0, y + 0.3, rr)), C.verm);
        const nb = Math.floor((bw + 1.3) / 0.55);
        for (let k = 0; k <= nb; k++) b.add('lacquer', box(0.05, 0.6, 0.05), mul(rm, M(-(bw + 1.3) / 2 + (k * (bw + 1.3)) / nb, y + 0.32, rr)), C.verm);
      }
    }
    const yb = y + 0.12;
    // walls: plaster core
    b.add('plaster', box(bw - 0.1, bh, bw - 0.1), P(0, yb + bh / 2, 0), C.white);
    // posts (4 per side)
    for (let s = 0; s < 4; s++) {
      const rm = mul(base, M(0, 0, 0, (s * Math.PI) / 2));
      for (let k = 0; k < 4; k++) {
        const u = -hw + (k * bw) / 3;
        b.add('lacquer', box(0.24, bh, 0.24), mul(rm, M(u, yb + bh / 2, hw)), C.verm);
      }
      // doors in center bay (vermilion panels with gold studs) and windows on side bays
      const dw = bw / 3 - 0.3;
      b.add('lacquer', box(dw, bh * 0.82, 0.08), mul(rm, M(0, yb + bh * 0.41, hw + 0.02)), C.vermD);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) b.add('metal', box(0.09, 0.09, 0.05), mul(rm, M((c - 0.5) * dw * 0.5, yb + bh * (0.2 + r * 0.25), hw + 0.07)), C.gold);
      for (const u of [-bw / 3, bw / 3]) {
        b.add('wood', box(dw * 0.75, bh * 0.4, 0.06), mul(rm, M(u, yb + bh * 0.55, hw + 0.02)), C.dark);
        const nbr = 7;
        for (let k = 0; k <= nbr; k++) b.add('lacquer', box(0.05, bh * 0.4, 0.06), mul(rm, M(u - dw * 0.375 + (k * dw * 0.75) / nbr, yb + bh * 0.55, hw + 0.06)), C.verm);
      }
      // head beams
      b.add('lacquer', box(bw + 0.3, 0.22, 0.26), mul(rm, M(0, yb + bh - 0.11, hw)), C.verm);
      b.add('lacquer', box(bw + 0.3, 0.16, 0.24), mul(rm, M(0, yb + bh * 0.08, hw)), C.verm);
      // bracket sets (tokyo): 3 layers of stepped blocks
      for (let L = 0; L < 3; L++) {
        const yy = yb + bh + 0.12 + L * 0.22;
        const out = hw + 0.18 + L * 0.28;
        b.add('wood', box(bw + 0.4 + L * 0.6, 0.12, 0.22), mul(rm, M(0, yy + 0.08, out)), C.woodD);
        for (let k = 0; k < 4; k++) {
          const u = -hw + (k * bw) / 3;
          b.add('lacquer', box(0.3, 0.16, 0.3 + L * 0.2), mul(rm, M(u, yy, out - 0.1)), L === 1 ? C.verm : C.woodD);
          if (L === 2) b.add('wood', box(0.24, 0.14, 0.6), mul(rm, M(u, yy + 0.12, out + 0.25)), C.woodD);
        }
      }
    }
    // roof
    const ex = hw + 2.55 - i * 0.12;
    const Hr = 1.9 - i * 0.06;
    const yR = yb + bh + 0.85;
    const curve = 0.45;
    buildRoof(b, P(0, yR, 0), {
      type: 'pyramid', ex, ez: ex, H: Hr * 1.8, curve, lift: 0.75, flare: 0.04, tileP: 0.32, tileH: 0.07, thick: 0.3,
      roofColor: C.roofD, ridgeColor: C.ridge, underColor: C.verm, underKey: 'lacquer', endCaps: true, doubleRafter: true,
      wallZ: hw + 0.6, wallX: hw + 0.6, ridgeH: 0.32, ridgeW: 0.3, rafterSpacing: 0.36,
    });
    // next tier starts where roof meets smaller body
    const nbw = bw * 0.86;
    const inset = ex - nbw / 2 - 0.5;
    const t = inset / ex;
    const a = 1 - curve;
    y = yR + Hr * 1.8 * (a * t + (1 - a) * t * t) - 0.05;
    bw = nbw;
    if (i === tiers - 1) {
      // sorin spire
      const sy = yR + Hr * 1.8 - 0.4;
      const sp = (yy) => P(0, sy + yy, 0);
      b.add('lacquer', box(1.4, 0.6, 1.4), sp(0.3), C.black);
      b.add('metal', lathe([[0, 0], [0.75, 0], [0.7, 0.2], [0.5, 0.42], [0, 0.48]], 16), sp(0.6), C.bronze);
      b.add('metal', lathe([[0, 0], [0.3, 0], [0.55, 0.22], [0.5, 0.3], [0, 0.3]], 16), sp(1.08), C.bronze);
      b.add('metal', cyl(0.1, 0.12, 5.4, 10), sp(4.1), C.bronze);
      for (let k = 0; k < 9; k++) b.add('metal', cyl(0.42 - k * 0.02, 0.42 - k * 0.02, 0.1, 16), sp(1.6 + k * 0.42), C.gold);
      b.add('metal', lathe([[0, 0], [0.25, 0.1], [0.4, 0.5], [0.15, 0.9], [0, 1.0]], 12), sp(5.4), C.gold);
      b.add('metal', lathe([[0, 0], [0.18, 0.06], [0.2, 0.2], [0.1, 0.36], [0, 0.4]], 12), sp(6.5), C.gold);
      b.add('metal', lathe([[0, 0], [0.16, 0.1], [0.14, 0.3], [0, 0.5]], 12), sp(6.95), C.gold);
      Pd.top = new THREE.Vector3(0, sy + 7.5, 0).applyMatrix4(base);
    }
  }
  // lanterns hanging from first-tier eave corners
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2 + Math.PI / 4;
    const wp = new THREE.Vector3(Math.sin(a) * 6.3, 4.2, Math.cos(a) * 6.3).applyMatrix4(base);
    hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 2, s: 0.9, chain: 1.2 });
  }
  const lp = new THREE.Vector3(0, 2.2, 0).applyMatrix4(base);
  lights.push({ x: lp.x, y: lp.y, z: lp.z + 0.0, i: 0.6 });
}

// ---------------- temple main hall ----------------
export function makeTemple(b, T) {
  const base = M(T.x, T.y, T.z, T.rot);
  const P = (x, y, z) => mul(base, M(x, y, z));
  const w = T.w, d = T.d;
  // kidan platform
  b.add('stone', box(w + 4, 1.1, d + 4), P(0, 0.55, 0), C.stone);
  b.add('stone', box(w + 4.3, 0.12, d + 4.3), P(0, 1.1, 0), C.stoneD);
  for (let k = 0; k < 4; k++) b.add('stone', box(6, 0.28, 0.5), P(0, 0.14 + k * 0.28, d / 2 + 2 + (3 - k) * 0.48), C.stoneD);
  const y0 = 1.25, bh = 5.0, y1 = y0 + bh;
  // floor + veranda
  b.add('wood', box(w + 2.4, 0.3, d + 2.4), P(0, y0 + 0.3, 0), C.woodD);
  for (let s = 0; s < 4; s++) {
    const rm = mul(base, M(0, 0, 0, (s * Math.PI) / 2));
    const L = s % 2 === 0 ? w : d, out = (s % 2 === 0 ? d : w) / 2 + 1.1;
    b.add('lacquer', box(L + 2.2, 0.08, 0.1), mul(rm, M(0, y0 + 1.25, out)), C.verm);
    b.add('lacquer', box(L + 2.2, 0.06, 0.08), mul(rm, M(0, y0 + 0.75, out)), C.verm);
    const n = Math.floor((L + 2.2) / 1.1);
    for (let k = 0; k <= n; k++) {
      if (s === 0 && Math.abs(-(L + 2.2) / 2 + (k * (L + 2.2)) / n) < 1.6) continue;
      b.add('lacquer', box(0.1, 0.85, 0.1), mul(rm, M(-(L + 2.2) / 2 + (k * (L + 2.2)) / n, y0 + 0.85, out)), C.verm);
    }
  }
  const yb = y0 + 0.45;
  const H1 = y1 - yb;
  b.add('plaster', box(w - 0.2, H1, d - 0.2), P(0, yb + H1 / 2, 0), C.white);
  // columns
  const nx = 5, nz = 4;
  for (let i = 0; i <= nx; i++) for (const sz of [-1, 1]) b.add('lacquer', cyl(0.28, 0.3, H1, 14), P(-w / 2 + (i * w) / nx, yb + H1 / 2, sz * d / 2), C.verm);
  for (let j = 1; j < nz; j++) for (const sx of [-1, 1]) b.add('lacquer', cyl(0.28, 0.3, H1, 14), P(sx * w / 2, yb + H1 / 2, -d / 2 + (j * d) / nz), C.verm);
  // front: lattice doors (shitomido) lit from inside
  for (let i = 0; i < nx; i++) {
    const cx = -w / 2 + ((i + 0.5) * w) / nx;
    const bw = w / nx - 0.62;
    b.add('shojiLit', quad(bw, H1 * 0.62), P(cx, yb + H1 * 0.35, d / 2 + 0.03), [1, 1, 1]);
    const n = 8;
    for (let k = 0; k <= n; k++) b.add('lacquer', box(0.05, H1 * 0.62, 0.06), P(cx - bw / 2 + (k * bw) / n, yb + H1 * 0.35, d / 2 + 0.08), C.black);
    for (let k = 0; k <= 10; k++) b.add('lacquer', box(bw, 0.05, 0.06), P(cx, yb + (k * H1 * 0.62) / 10 + 0.04, d / 2 + 0.08), C.black);
    b.add('lacquer', box(bw, H1 * 0.2, 0.08), P(cx, yb + H1 * 0.78, d / 2 + 0.04), C.vermD);
  }
  for (const [sx, F] of [[1, 'r'], [-1, 'l']]) {
    for (let j = 0; j < nz; j++) {
      const cz = -d / 2 + ((j + 0.5) * d) / nz;
      b.add('wood', box(0.06, H1 * 0.3, d / nz - 1.2), P(sx * (w / 2 + 0.02), yb + H1 * 0.55, cz), C.dark);
      for (let k = 0; k <= 7; k++) b.add('lacquer', box(0.06, H1 * 0.3, 0.05), P(sx * (w / 2 + 0.06), yb + H1 * 0.55, cz - (d / nz - 1.2) / 2 + (k * (d / nz - 1.2)) / 7), C.verm);
    }
  }
  // head beams + brackets
  for (let s = 0; s < 4; s++) {
    const rm = mul(base, M(0, 0, 0, (s * Math.PI) / 2));
    const L = s % 2 === 0 ? w : d, out = (s % 2 === 0 ? d : w) / 2;
    b.add('lacquer', box(L + 0.8, 0.35, 0.34), mul(rm, M(0, y1 - 0.2, out)), C.verm);
    b.add('lacquer', box(L + 0.8, 0.22, 0.3), mul(rm, M(0, y1 - 0.85, out)), C.verm);
    for (let Ly = 0; Ly < 3; Ly++) {
      const yy = y1 + 0.12 + Ly * 0.26, o2 = out + 0.2 + Ly * 0.32;
      b.add('wood', box(L + 0.8 + Ly * 0.8, 0.14, 0.24), mul(rm, M(0, yy + 0.1, o2)), C.woodD);
      const nb = Math.round(L / 1.2);
      for (let k = 0; k <= nb; k++) b.add('lacquer', box(0.34, 0.18, 0.34), mul(rm, M(-L / 2 + (k * L) / nb, yy, o2 - 0.12)), Ly === 1 ? C.verm : C.woodD);
    }
  }
  // roof
  const ez = d / 2 + 3.4, ex = w / 2 + 3.4, Hr = 7.2;
  const yr = y1 + 0.7;
  buildRoof(b, P(0, yr - 0.55, 0), {
    type: 'irimoya', tf: 0.52, ex, ez, H: Hr, curve: 0.55, lift: 0.85, flare: 0.05, tileP: 0.36, tileH: 0.085, thick: 0.38,
    roofColor: C.roofD, ridgeColor: C.ridge, underColor: C.verm, underKey: 'lacquer', bargeColor: C.woodD, endCaps: true, doubleRafter: true,
    wallZ: d / 2 + 0.6, wallX: w / 2 + 0.6, ridgeH: 0.7, ridgeW: 0.6, rafterSpacing: 0.36, gableColor: C.white,
    ridgeOrn: (bb, bs, len, ytop) => {
      for (const sx of [1, -1]) {
        // shibi (golden fish-tail finials)
        const m0 = mul(bs, M(sx * (len / 2 - 0.3), ytop + 0.35, 0, 0, 0, -sx * 0.25));
        bb.add('metal', box(0.5, 1.2, 0.35), m0, C.gold);
        bb.add('metal', box(0.35, 0.9, 0.3), mul(m0, M(-sx * 0.35, 0.35, 0, 0, 0, sx * 0.5)), C.gold);
        bb.add('metal', box(0.25, 0.5, 0.25), mul(m0, M(-sx * 0.6, 0.75, 0, 0, 0, sx * 0.8)), C.gold);
      }
    },
  });
  // front canopy (kohai) over stairs
  buildRoof(b, P(0, y1 - 0.9, d / 2 + 1.2), {
    type: 'shed', ex: 3.4, ez: 2.6, H: 1.1, curve: 0.5, lift: 0.18, tileP: 0.32, tileH: 0.07, thick: 0.25,
    roofColor: C.roofD, ridgeColor: C.ridge, underColor: C.verm, underKey: 'lacquer', rafters: false,
  });
  for (const sx of [-1, 1]) b.add('lacquer', cyl(0.2, 0.22, y1 - 1.0, 12), P(sx * 3.0, (y1 - 1.0) / 2, d / 2 + 3.6), C.verm);
  // big hanging lantern at entrance
  const wp = new THREE.Vector3(0, y1 - 1.2, d / 2 + 2.6).applyMatrix4(base);
  hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 0, s: 2.4 });
  const lp = new THREE.Vector3(0, y0 + 3, d / 2 + 4.5).applyMatrix4(base);
  lights.push({ x: lp.x, y: lp.y, z: lp.z, i: 2.0 });
  // offering box + incense burner
  b.add('wood', box(2.2, 0.8, 0.9), P(0, y0 + 1.1, d / 2 + 1.7), C.woodD);
  const ib = P(0, 0, d / 2 + 6.5);
  b.add('metal', lathe([[0, 0], [0.5, 0], [0.55, 0.5], [0.7, 0.9], [0.62, 1.0], [0, 1.0]], 16), ib, C.bronze);
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2; b.add('metal', box(0.12, 0.4, 0.12), mul(ib, M(Math.cos(a) * 0.4, -0.15 + 0.2, Math.sin(a) * 0.4)), C.bronze); }
  b.add('metal', lathe([[0, 0], [0.5, 0], [0.3, 0.4], [0.08, 0.6], [0, 0.8]], 12), mul(ib, M(0, 1.0, 0)), C.bronze);
  smokeSources.push(new THREE.Vector3(0, 1.7, d / 2 + 6.5).applyMatrix4(base));
}

// ---------------- gate (shikyakumon) ----------------
export function makeGate(b, G) {
  const base = M(G.x, G.y, G.z, G.rot);
  const P = (x, y, z) => mul(base, M(x, y, z));
  const w = 4.6, d = 2.6, h = 3.6;
  for (const sx of [-1, 1]) {
    b.add('lacquer', cyl(0.24, 0.26, h, 12), P(sx * w / 2, h / 2, 0), C.verm);
    for (const sz of [-1, 1]) b.add('lacquer', box(0.2, h - 0.3, 0.2), P(sx * w / 2, (h - 0.3) / 2, sz * d / 2), C.verm);
    b.add('stone', cyl(0.4, 0.45, 0.25, 8), P(sx * w / 2, 0.12, 0), C.stone);
  }
  b.add('lacquer', box(w + 0.6, 0.3, 0.3), P(0, h - 0.15, 0), C.verm);
  b.add('lacquer', box(w + 0.4, 0.2, 0.22), P(0, h - 0.9, 0), C.verm);
  for (const sx of [-1, 1]) b.add('lacquer', box(0.2, 0.25, d + 0.3), P(sx * w / 2, h - 0.3, 0), C.verm);
  // open doors
  for (const sx of [-1, 1]) b.add('wood', box(0.08, 2.6, w / 2 - 0.2), mul(P(sx * (w / 2 - 0.15), 1.4, 0.0), M(0, 0, (w / 4 - 0.1), 0)), C.woodD);
  const ez = d / 2 + 1.5, ex = w / 2 + 1.3, Hr = 1.9;
  buildRoof(b, P(0, h + 0.15, 0), {
    type: 'gable', ex, ez, H: Hr, curve: 0.5, lift: 0.18, tileP: 0.3, tileH: 0.06, thick: 0.25,
    roofColor: C.roofD, ridgeColor: C.ridge, underColor: C.verm, underKey: 'lacquer', bargeColor: C.woodD, ridgeH: 0.4, ridgeW: 0.4, rafters: false,
  });
  for (const sx of [-1, 1]) {
    const wp = new THREE.Vector3(0, h - 0.7, sx * 1.6).applyMatrix4(base);
    hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 0, s: 1.4 });
  }
}

// ---------------- bell tower ----------------
export function makeBell(b, Bl) {
  const base = M(Bl.x, Bl.y, Bl.z, 0.1);
  const P = (x, y, z) => mul(base, M(x, y, z));
  b.add('stone', box(5.4, 1.0, 5.4), P(0, 0.5, 0), C.stone);
  const h = 4.2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('lacquer', box(0.3, h, 0.3), mul(P(sx * 1.8, 1.0 + h / 2, sz * 1.8), M(0, 0, 0, 0, -sz * 0.04, sx * 0.04)), C.verm);
  for (const yy of [1.6, h + 0.85]) for (let s = 0; s < 4; s++) b.add('lacquer', box(4.1, 0.24, 0.24), mul(base, M(0, 0, 0, (s * Math.PI) / 2)).multiply(M(0, yy, 1.8)), C.verm);
  b.add('metal', lathe([[0, 0], [0.75, 0], [0.72, 0.15], [0.62, 0.6], [0.6, 1.3], [0.5, 1.55], [0, 1.65]], 18), P(0, 2.4, 0), srgb('#5b5a3e'));
  b.add('wood', cyl(0.08, 0.08, 2.4, 8), mul(P(0, 3.1, 1.4), M(0, 0, 0, 0, 0, Math.PI / 2)), C.woodW);
  buildRoof(b, P(0, h + 1.1, 0), {
    type: 'irimoya', tf: 0.5, ex: 3.4, ez: 3.4, H: 2.4, curve: 0.55, lift: 0.5, tileP: 0.3, tileH: 0.06, thick: 0.25,
    roofColor: C.roofD, ridgeColor: C.ridge, underColor: C.verm, underKey: 'lacquer', bargeColor: C.woodD, ridgeH: 0.4, ridgeW: 0.38, rafters: false, gableColor: C.white,
  });
}

// ---------------- shrine at top of torii path ----------------
export function makeShrine(b, S) {
  const y = hAt(S.x, S.z);
  const base = M(S.x, y, S.z, S.rot);
  const P = (x, y2, z) => mul(base, M(x, y2, z));
  const w = 4.2, d = 3.6;
  b.add('stone', box(w + 2.4, 0.6, d + 2.6), P(0, 0.3, 0), C.stone);
  b.add('wood', box(w + 1.6, 0.18, d + 1.6), P(0, 1.3, 0), C.woodD);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('lacquer', box(0.22, 1.3, 0.22), P(sx * (w / 2 + 0.7), 0.65 + 0.3, sz * (d / 2 + 0.7)), C.verm);
  const y0 = 1.4, h = 2.6;
  b.add('plaster', box(w - 0.1, h, d - 0.1), P(0, y0 + h / 2, 0), C.white);
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) b.add('lacquer', box(0.22, h, 0.22), P(sx * w / 2, y0 + h / 2, sz * d / 2), C.verm);
  b.add('shojiLit', quad(w * 0.7, h * 0.7), P(0, y0 + h * 0.4, d / 2 + 0.06), [1, 1, 1]);
  for (let k = 0; k <= 10; k++) b.add('lacquer', box(0.05, h * 0.7, 0.05), P(-w * 0.35 + (k * w * 0.7) / 10, y0 + h * 0.4, d / 2 + 0.1), C.verm);
  for (let s = 0; s < 4; s++) b.add('lacquer', box((s % 2 ? d : w) + 0.6, 0.24, 0.3), mul(base, M(0, 0, 0, (s * Math.PI) / 2)).multiply(M(0, y0 + h - 0.1, (s % 2 ? w : d) / 2)), C.verm);
  // nagare-style roof: asymmetric, front slope extended
  const ez = d / 2 + 1.4, ex = w / 2 + 0.9;
  buildRoof(b, P(0, y0 + h + 0.05, 0.6), {
    type: 'gable', ex, ez: ez + 0.6, H: 1.7, curve: 0.55, lift: 0.1, tileP: 0.26, tileH: 0.05, thick: 0.22,
    roofColor: srgb('#4d5a52'), ridgeColor: C.black, underColor: C.verm, underKey: 'lacquer', bargeColor: C.verm, ridgeH: 0.3, ridgeW: 0.3, rafters: false,
    ridgeOrn: (bb, bs, len, ytop) => {
      for (let i = 0; i < 5; i++) bb.add('metal', cyl(0.12, 0.12, 0.7, 8), mul(bs, M(-len / 2 + 0.4 + (i * (len - 0.8)) / 4, ytop + 0.05, 0, 0, Math.PI / 2, 0)), C.gold);
      for (const sx of [1, -1]) {
        const { m, len: l2 } = segMatrix([sx * len / 2, ytop - 0.2, 0], [sx * (len / 2 + 0.6), ytop + 0.9, 0]);
        bb.add('lacquer', box(0.12, 0.12, l2), mul(bs, m), C.black);
      }
    },
  });
  for (const sx of [-1, 1]) makeStoneLantern(b, ...new THREE.Vector3(sx * 3.4, 0, d / 2 + 4.0).applyMatrix4(base).toArray().map((v, i) => (i === 1 ? y : v)), 0.9);
  for (const sx of [-1, 1]) {
    const wp = new THREE.Vector3(sx * 1.5, y0 + h - 0.4, d / 2 + 1.3).applyMatrix4(base);
    hanging.push({ x: wp.x, y: wp.y, z: wp.z, color: 1, s: 0.9 });
  }
  const lp = new THREE.Vector3(0, 2.5, d / 2 + 3).applyMatrix4(base);
  lights.push({ x: lp.x, y: lp.y, z: lp.z, i: 1.0 });
}

// ---------------- boats ----------------
export function makeBoat(b, Bt) {
  const base = M(Bt.x, WATER_Y + 0.05, Bt.z, Bt.rot);
  const P = (x, y, z) => mul(base, M(x, y, z));
  const L = 5.6, W = 1.25;
  b.add('wood', box(W - 0.2, 0.08, L - 0.6), P(0, -0.12, 0), C.woodW);
  for (const sx of [-1, 1]) {
    const { m, len } = segMatrix([sx * W / 2, 0.05, -L / 2 + 0.3], [sx * W / 2, 0.05, L / 2 - 0.4]);
    b.add('wood', box(0.07, 0.42, len), mul(base, m), scaleC(C.woodW, 0.85));
    const r1 = segMatrix([sx * W / 2, 0.08, L / 2 - 0.4], [sx * 0.05, 0.35, L / 2 + 0.25]);
    b.add('wood', box(0.07, 0.36, r1.len), mul(base, r1.m), scaleC(C.woodW, 0.85));
  }
  b.add('wood', box(W, 0.4, 0.08), P(0, 0.05, -L / 2 + 0.3), scaleC(C.woodW, 0.8));
  for (const z of [-1.2, 0.4, 1.6]) b.add('wood', box(W - 0.05, 0.05, 0.25), P(0, 0.2, z), C.woodW);
  b.add('wood', cyl(0.03, 0.03, 3.2, 6), mul(P(0.2, 0.4, -0.2), M(0, 0, 0, 0.3, 1.2, 0)), C.woodL);
}

// ---------------- bamboo fence ----------------
export function makeFence(b, x0, z0, x1, z1, h = 1.3) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ang = Math.atan2(x1 - x0, z1 - z0);
  const n = Math.floor(len / 0.06);
  const rng = new RNG((x0 * 13 + z0 * 7) | 0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const y = hAt(x, z);
    if (i % 2 === 0) b.add('wood', cyl(0.028, 0.03, h, 5), M(x, y + h / 2, z), vary(C.bamboo, rng, 0.12));
  }
  for (const yy of [0.35, h * 0.62, h - 0.1]) {
    const ym = hAt((x0 + x1) / 2, (z0 + z1) / 2);
    b.add('wood', cyl(0.03, 0.03, len, 5), mul(M((x0 + x1) / 2, ym + yy, (z0 + z1) / 2, ang), M(0, 0, 0, 0, Math.PI / 2, 0)), scaleC(C.bamboo, 0.8));
  }
  for (let i = 0; i <= Math.floor(len / 1.8); i++) {
    const t = i / Math.floor(len / 1.8);
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    b.add('wood', cyl(0.05, 0.05, h + 0.15, 6), M(x, hAt(x, z) + (h + 0.15) / 2, z), C.woodD);
  }
}

// ---------------- build everything ----------------
export function buildArchitecture() {
  const b = new Builder();
  for (const h of layout.houses) makeHouse(b, h);
  makeTeahouse(b, layout.teahouse);
  makeTemple(b, layout.temple);
  makePagoda(b, layout.pagoda);
  makeGate(b, layout.gate);
  makeBell(b, layout.bell);
  makeShrine(b, layout.shrine);
  for (const B of layout.bridges) makeBridge(b, B);
  for (const t of layout.torii) makeTorii(b, t.x, hAt(t.x, t.z), t.z, t.rot, t.s);
  // senbon torii along the hill path
  const tp = layout.toriiPath;
  const pts = tp.pts;
  let total = 0; const segs = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push([total, l, i]); total += l; }
  for (let s = 1.2; s < total - 1.0; s += 1.3) {
    const sg = segs.find((q) => s >= q[0] && s <= q[0] + q[1]) || segs[segs.length - 1];
    const i = sg[2], t = (s - sg[0]) / sg[1];
    const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    const rot = Math.atan2(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    makeTorii(b, x, toriiPathHeight(s) - 0.05, z, rot, 1.0, true);
  }
  // stone steps along torii path
  for (let s = 0.5; s < total; s += 0.7) {
    const sg = segs.find((q) => s >= q[0] && s <= q[0] + q[1]) || segs[segs.length - 1];
    const i = sg[2], t = (s - sg[0]) / sg[1];
    const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    const rot = Math.atan2(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    b.add('stone', box(2.0, 0.22, 0.62), M(x, toriiPathHeight(s) - 0.06, z, rot), vary(C.stone, new RNG(s * 100), 0.08));
  }
  for (const L of layout.stoneLanterns) makeStoneLantern(b, L.x, hAt(L.x, L.z), L.z, L.s, L.kind || 'kasuga', L.x * 0.1);
  for (const Bt of layout.boats) makeBoat(b, Bt);
  makeYatsuhashi(b);
  // terrace steps
  const S = layout.steps;
  const nSteps = 12;
  for (let k = 0; k < nSteps; k++) {
    const t = k / (nSteps - 1);
    const x = S.x1 - t * (S.x1 - S.x0 + 0.4);
    const yy = S.hBot + (S.hTop - S.hBot) * t;
    b.add('stone', box(0.62, yy - S.hBot + 0.35, S.w), M(x, (yy + S.hBot) / 2 - 0.15, S.z), vary(C.stone, new RNG(k + 3), 0.05));
  }
  // garden fences
  for (const h of layout.houses) {
    if (h.type === 'machiya' && (h.seed % 3 === 0)) {
      const c = Math.cos(h.rot), s = Math.sin(h.rot);
      const lx = -h.w / 2 - 0.3, z0 = -h.d / 2 - 2.5, z1 = h.d / 2 - 1;
      const X = (lx2, lz) => [h.x + lx2 * c + lz * s, h.z - lx2 * s + lz * c];
      const a = X(-h.w / 2 - 0.5, -h.d / 2 - 0.5), bb = X(h.w / 2 + 0.5, -h.d / 2 - 0.5);
      makeFence(b, a[0], a[1], bb[0], bb[1], 1.6);
    }
  }
  // temple terrace back fence
  const T = layout.terrace;
  makeFence(b, T.x - T.w / 2 + 1, T.z - T.d / 2 + 1, T.x + T.w / 2 - 6, T.z - T.d / 2 + 1, 1.7);
  return b;
}

// zigzag plank bridge (yatsuhashi) across the garden pond
export function makeYatsuhashi(b) {
  const P = layout.pond;
  const c = Math.cos(P.rot), s = Math.sin(P.rot);
  const W = (lx, lz) => [P.x + lx * c - lz * s, P.z + lx * s + lz * c];
  const pts = [[-3.2, -P.rz - 2.4], [-1.4, -1.8], [1.5, 1.9], [2.8, P.rz + 2.4]].map(([x, z]) => W(x, z));
  const ys = pts.map(([x, z], i) => (i === 0 || i === pts.length - 1 ? Math.max(0.4, hAt(x, z) + 0.05) : 0.42));
  const rng = new RNG(71);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = [pts[i][0], ys[i], pts[i][1]], e = [pts[i + 1][0], ys[i + 1], pts[i + 1][1]];
    const { m, len } = segMatrix(a, e);
    for (const off of [-0.21, 0.21]) b.add('wood', box(0.4, 0.09, len + 0.35), mul(m, M(off, 0, 0)), vary(C.woodW, rng, 0.12));
    for (const t of [0.2, 0.8]) {
      const x = a[0] + (e[0] - a[0]) * t, z = a[2] + (e[2] - a[2]) * t, y = a[1] + (e[1] - a[1]) * t;
      for (const off of [-1, 1]) {
        const p = new THREE.Vector3(off * 0.36, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(m));
        b.add('wood', cyl(0.06, 0.07, y + 1.0, 6), M(x + p.x, (y - 1.0) / 2 - 0.05, z + p.z), C.woodD);
      }
      b.add('wood', box(0.9, 0.1, 0.12), mul(new THREE.Matrix4().makeTranslation(0, 0, 0), mul(M(x, y - 0.1, z), new THREE.Matrix4().extractRotation(m))), C.woodD);
    }
  }
}

// strings of lanterns across the east street
export function lanternStrings() {
  const out = [];
  for (const z of [-26, -6, 22, 44]) {
    const rx = riverXAt(z);
    const a = [rx + 27.4, 5.2, z], c = [rx + 33.6, 5.2, z];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = a[0] + (c[0] - a[0]) * t;
      const sag = Math.sin(t * Math.PI) * 0.55;
      out.push({ x, y: hAt(x, z) + 4.6 - sag, z, color: i % 2 ? 0 : 1, s: 0.7, chain: 0.25 });
    }
    out.push({ pole: true, x: a[0], z, h: 5.4 }, { pole: true, x: c[0], z, h: 5.4 });
  }
  return out;
}
