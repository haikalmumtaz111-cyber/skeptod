// Japanese roof generator: tiled kawara / thatch surfaces with curved profile,
// upturned corners, soffits, rafters, ridges and bargeboards.
import * as THREE from 'three';
import { paramSurface, fan, box, cyl, segMatrix, mul, M } from './geom.js';

// opt: ex, ez (eave half extents), H (rise), type: hip|gable|irimoya|pyramid|shed,
// tf (irimoya hip fraction), lift (corner upturn), flare, curve (0..1 concavity),
// tileP (tile pitch), tileH, thick, kind: 'tile'|'thatch', colors
export function buildRoof(b, base, opt) {
  const o = Object.assign({
    type: 'gable', tf: 0.45, lift: 0.12, flare: 0.0, curve: 0.45, tileP: 0.3, tileH: 0.06,
    thick: 0.2, kind: 'tile', roofKey: 'roof', underKey: 'wood', ridgeKey: 'roof', ridgeH: 0.3, ridgeW: 0.32,
    roofColor: [0.33, 0.35, 0.4], underColor: [0.3, 0.2, 0.14], ridgeColor: [0.24, 0.25, 0.28],
    rafters: true, rafterSpacing: 0.42, wallX: 0, wallZ: 0, bargeColor: [0.32, 0.22, 0.15], onigawara: true,
    endCaps: false, doubleRafter: false, hipEnds: true, ridgeOrn: null,
  }, opt);
  const { ex, ez, H, type } = o;
  const a = 1 - o.curve;
  const yOf = (t) => H * (a * t + (1 - a) * t * t);
  const tfx = type === 'hip' || type === 'pyramid' ? 1 : type === 'irimoya' ? o.tf : 0;
  const hasEnds = tfx > 0;
  const liftAt = (s2, t) => o.lift * Math.pow(Math.abs(s2), 3.2) * (1 - t) * (1 - t);

  // base surface point for side (0:+z,1:-z,2:+x,3:-x)
  function P(side, s, t) {
    const s2 = 2 * s - 1;
    const y = yOf(t) + liftAt(s2, t);
    const fl = 1 + o.flare * Math.pow(Math.abs(s2), 3) * (1 - t);
    if (side < 2) {
      const xh = type === 'gable' || type === 'shed' ? ex : ex - ez * Math.min(t, tfx);
      const zz = type === 'shed' ? ez * (1 - t) : ez * (1 - t);
      const x = s2 * xh * fl;
      const z = (side === 0 ? 1 : -1) * zz * (1 + o.flare * Math.pow(Math.abs(s2), 3) * (1 - t) * 0.5);
      return [x, y, z];
    } else {
      const zh = ez * (1 - t);
      const xx = ex - ez * t;
      const z = s2 * zh * fl;
      const x = (side === 2 ? 1 : -1) * xx * (1 + o.flare * Math.pow(Math.abs(s2), 3) * (1 - t) * 0.5);
      return [x, y, z];
    }
  }
  const sides = type === 'shed' ? [0] : hasEnds ? [0, 1, 2, 3] : [0, 1];

  const slopeLen = Math.hypot(ez, H) * 1.05;
  for (const side of sides) {
    const isEnd = side >= 2;
    const tMax = isEnd ? tfx : 1;
    const span = isEnd ? 2 * ez : 2 * ex;
    const per = o.kind === 'tile' ? o.tileP / 4 : 0.5;
    const ns = Math.max(6, Math.ceil(span / per));
    const nt = Math.max(5, Math.ceil((slopeLen * tMax) / 0.6));
    const eps = 1e-3;
    // top tiled surface
    const top = paramSurface(ns, nt, (s, tt) => {
      const t = tt * tMax;
      const p = P(side, s, t);
      // normal via finite differences
      const ps = P(side, Math.min(1, s + eps), t), pt = P(side, s, Math.min(1, t + eps));
      const ds = [ps[0] - p[0], ps[1] - p[1], ps[2] - p[2]], dt = [pt[0] - p[0], pt[1] - p[1], pt[2] - p[2]];
      let nx = ds[1] * dt[2] - ds[2] * dt[1], ny = ds[2] * dt[0] - ds[0] * dt[2], nz = ds[0] * dt[1] - ds[1] * dt[0];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const along = side < 2 ? p[0] : p[2];
      let bump = 0;
      if (o.kind === 'tile') {
        const f = ((along / o.tileP) % 1 + 1) % 1;
        bump = o.tileH * Math.pow(Math.sin(Math.PI * f), 0.8);
        // near edges of a side taper bumps a bit
      } else {
        bump = 0.03 * Math.sin(along * 9.0);
      }
      return [p[0] + nx * bump, p[1] + ny * bump, p[2] + nz * bump, along, t * slopeLen];
    }, side === 0 || side === 3);
    b.add(o.roofKey, top, base, o.roofColor);

    // underside (soffit) — slightly below, no tiles, faces down
    const under = paramSurface(Math.max(4, Math.ceil(ns / 6)), nt, (s, tt) => {
      const t = tt * tMax;
      const p = P(side, s, t);
      return [p[0], p[1] - o.thick, p[2], p[0] + p[2], t];
    }, side === 1 || side === 2);
    b.add(o.underKey, under, base, o.underColor);

    // eave edge band (connects tiled top to soffit along the eave)
    const nsE = ns;
    const edge = paramSurface(nsE, 1, (s, k) => {
      const p = P(side, s, 0);
      const along = side < 2 ? p[0] : p[2];
      let bump = 0;
      if (o.kind === 'tile') { const f = ((along / o.tileP) % 1 + 1) % 1; bump = o.tileH * Math.pow(Math.sin(Math.PI * f), 0.8); }
      const outN = side === 0 ? [0, 0, 1] : side === 1 ? [0, 0, -1] : side === 2 ? [1, 0, 0] : [-1, 0, 0];
      const y = k === 0 ? p[1] + bump + 0.01 : p[1] - o.thick;
      const push = o.kind === 'thatch' ? 0.0 : 0.02;
      return [p[0] + outN[0] * push, y, p[2] + outN[2] * push, along, k];
    }, side === 1 || side === 2);
    b.add(o.kind === 'thatch' ? o.roofKey : o.ridgeKey, edge, base, o.kind === 'thatch' ? o.roofColor : o.ridgeColor);

    // round tile end caps (noki-gawara) for temples
    if (o.endCaps && o.kind === 'tile') {
      const count = Math.floor(span / o.tileP);
      const capG = cyl(o.tileP * 0.36, o.tileP * 0.36, 0.06, 8);
      for (let i = 0; i < count; i++) {
        const sMeters = -span / 2 + (i + 0.5) * o.tileP;
        const s = (sMeters / (span / 2) + 1) / 2;
        const sAdj = side < 2 ? s : s;
        const p = P(side, sAdj, 0);
        const outA = side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? Math.PI / 2 : -Math.PI / 2;
        const m = mul(base, M(p[0], p[1] + o.tileH * 0.5 - 0.02, p[2], outA, Math.PI / 2, 0));
        b.add(o.ridgeKey, capG, m, o.ridgeColor);
      }
    }

    // rafters below soffit
    if (o.rafters) {
      const wallInset = side < 2 ? (o.wallZ ? ez - o.wallZ : 0.9) : (o.wallX ? ex - o.wallX : 0.9);
      const tWall = Math.min(0.95, Math.max(0.05, wallInset / ez));
      const span2 = side < 2 ? 2 * (ex - (hasEnds ? ez * 0 : 0)) : 2 * ez;
      const cnt = Math.floor(span2 / o.rafterSpacing);
      const layers = o.doubleRafter ? 2 : 1;
      for (let L = 0; L < layers; L++) {
        const tStart = L === 0 ? 0 : 0;
        const rs = 0.07 + L * 0.01;
        for (let i = 1; i < cnt; i++) {
          const s = i / cnt;
          const s2 = 2 * s - 1;
          // skip rafters outside the hip triangle on ends
          const p0 = P(side, s, tStart + L * 0.0);
          const p1 = P(side, s, tWall);
          if (side >= 2 && Math.abs(s2) > 1 - tWall * 0.9) continue;
          if (side < 2 && hasEnds && Math.abs(p1[0]) > ex - ez * tWall - 0.1) continue;
          const drop = o.thick + rs * 0.5 + L * 0.12;
          const ext = L === 1 ? -0.25 : 0;
          const a0 = [p0[0], p0[1] - drop, p0[2]], a1 = [p1[0], p1[1] - drop, p1[2]];
          if (ext) { const dx = a1[0] - a0[0], dy = a1[1] - a0[1], dz = a1[2] - a0[2]; const l = Math.hypot(dx, dy, dz); a0[0] -= dx / l * ext; a0[1] -= dy / l * ext; a0[2] -= dz / l * ext; }
          const { m, len } = segMatrix(a0, a1);
          b.add(o.underKey, box(rs, rs, len), mul(base, m), o.underColor);
        }
      }
    }
  }

  // gable triangles (tsuma) for irimoya: vertical wall at x = ±(ex - ez*tf)
  const ridgeTop = yOf(1);
  if (type === 'irimoya') {
    for (const sx of [1, -1]) {
      const xw = sx * (ex - ez * o.tf);
      const pts = [];
      const steps = 10;
      // bottom-left -> along profile up -> down other side
      for (let i = 0; i <= steps; i++) {
        const t = o.tf + (1 - o.tf) * (i / steps);
        pts.push([xw - sx * 0.25, yOf(t) - o.thick * 0.6, ez * (1 - t) - 0.02, ez * (1 - t), yOf(t)]);
      }
      for (let i = steps - 1; i >= 0; i--) {
        const t = o.tf + (1 - o.tf) * (i / steps);
        pts.push([xw - sx * 0.25, yOf(t) - o.thick * 0.6, -ez * (1 - t) + 0.02, -ez * (1 - t), yOf(t)]);
      }
      // fan from center bottom
      const yb = yOf(o.tf) - o.thick;
      const center = [xw - sx * 0.25, yb, 0, 0, yb];
      const poly = [center, [xw - sx * 0.25, yb, ez * (1 - o.tf) - 0.02, 0, 0], ...pts, [xw - sx * 0.25, yb, -ez * (1 - o.tf) + 0.02, 0, 0]];
      b.add(o.gableKey || 'plasterTri', fan(poly, [sx, 0, 0]), base, o.gableColor || [0.92, 0.9, 0.85]);
      // timber lines on the gable
      const tb = o.bargeColor;
      b.add(o.underKey, box(0.08, 0.12, 2 * ez * (1 - o.tf)), mul(base, M(xw - sx * 0.2, yb + 0.06, 0)), tb);
      const hmid = (yOf(1) + yb) / 2;
      b.add(o.underKey, box(0.07, 0.1, ez * (1 - o.tf) * 1.0), mul(base, M(xw - sx * 0.2, hmid, 0)), tb);
      b.add(o.underKey, box(0.07, ridgeTop - yb, 0.1), mul(base, M(xw - sx * 0.2, (ridgeTop + yb) / 2, 0)), tb);
      // bargeboards following the profile
      for (const sz of [1, -1]) {
        for (let i = 0; i < steps; i++) {
          const t0 = o.tf + (1 - o.tf) * (i / steps), t1 = o.tf + (1 - o.tf) * ((i + 1) / steps);
          const p0 = [xw + sx * 0.02, yOf(t0) - 0.05, sz * ez * (1 - t0)], p1 = [xw + sx * 0.02, yOf(t1) - 0.05, sz * ez * (1 - t1)];
          const { m, len } = segMatrix(p0, p1);
          b.add(o.underKey, box(0.07, 0.3, len + 0.04), mul(base, m), o.bargeColor);
        }
      }
      // gegyo ornament
      b.add(o.underKey, box(0.1, 0.45, 0.35), mul(base, M(xw + sx * 0.05, ridgeTop - 0.35, 0)), o.bargeColor);
    }
  }
  // gable type: bargeboards along verge edges (s=0 / s=1) and verge tiles
  if (type === 'gable') {
    for (const s of [0, 1]) {
      for (const side of [0, 1]) {
        const steps = 8;
        for (let i = 0; i < steps; i++) {
          const t0 = i / steps, t1 = (i + 1) / steps;
          const p0 = P(side, s, t0), p1 = P(side, s, t1);
          const out = s === 0 ? -1 : 1;
          const a0 = [p0[0] + out * 0.02, p0[1] - o.thick * 0.6, p0[2]], a1 = [p1[0] + out * 0.02, p1[1] - o.thick * 0.6, p1[2]];
          const { m, len } = segMatrix(a0, a1);
          b.add(o.underKey, box(0.07, o.thick + 0.18, len + 0.03), mul(base, m), o.bargeColor);
          // verge tile roll on top
          const v0 = [p0[0] - out * 0.08, p0[1] + o.tileH + 0.04, p0[2]], v1 = [p1[0] - out * 0.08, p1[1] + o.tileH + 0.04, p1[2]];
          const r = segMatrix(v0, v1);
          b.add(o.ridgeKey, box(o.ridgeW * 0.55, 0.12, r.len + 0.02), mul(base, r.m), o.ridgeColor);
        }
      }
    }
  }

  // main ridge
  if (type !== 'pyramid' && type !== 'shed') {
    const rx = type === 'hip' ? ex - ez : type === 'irimoya' ? ex - ez * o.tf : ex;
    const len = 2 * rx + (type === 'gable' ? 0.1 : 0.4);
    if (o.kind === 'tile') {
      b.add(o.ridgeKey, box(len, o.ridgeH, o.ridgeW), mul(base, M(0, ridgeTop + o.ridgeH / 2 - 0.04, 0)), o.ridgeColor);
      const capR = cyl(o.ridgeW * 0.42, o.ridgeW * 0.42, len + 0.05, 10);
      b.add(o.ridgeKey, capR, mul(base, M(0, ridgeTop + o.ridgeH - 0.02, 0, 0, 0, Math.PI / 2)), o.ridgeColor);
      // tile courses on ridge sides (thin strips)
      b.add(o.ridgeKey, box(len, 0.05, o.ridgeW + 0.06), mul(base, M(0, ridgeTop + o.ridgeH * 0.35, 0)), o.ridgeColor.map((c) => c * 0.85));
      if (o.onigawara) {
        for (const sx of [1, -1]) {
          const og = mul(base, M(sx * (len / 2 + 0.02), ridgeTop + o.ridgeH * 0.8, 0, 0, 0, -sx * 0.18));
          b.add(o.ridgeKey, box(0.22, o.ridgeH * 2.2, o.ridgeW * 1.5), og, o.ridgeColor);
          b.add(o.ridgeKey, cyl(o.ridgeW * 0.35, o.ridgeW * 0.35, 0.08, 10), mul(og, M(sx * 0.12, 0, 0, 0, 0, Math.PI / 2)), o.ridgeColor.map((c) => c * 0.8));
        }
      }
      if (o.ridgeOrn) o.ridgeOrn(b, base, len, ridgeTop + o.ridgeH);
    } else {
      // thatch ridge: thick rounded roll + crosspieces
      const roll = cyl(0.45, 0.45, len + 0.6, 10);
      b.add(o.roofKey, roll, mul(base, M(0, ridgeTop + 0.05, 0, 0, 0, Math.PI / 2)), o.roofColor.map((c) => c * 0.8));
      b.add(o.ridgeKey, box(len + 0.4, 0.22, 0.7), mul(base, M(0, ridgeTop + 0.42, 0)), o.ridgeColor);
      const n = Math.floor(len / 0.9);
      for (let i = 0; i <= n; i++) {
        const x = -len / 2 + (i / n) * len;
        b.add(o.underKey, box(0.12, 0.12, 1.5), mul(base, M(x, ridgeTop + 0.25, 0, 0, 0.0)), [0.25, 0.17, 0.1]);
      }
    }
  }

  // hip ridges
  if (hasEnds && o.kind === 'tile') {
    const tEnd = type === 'irimoya' ? o.tf : type === 'pyramid' ? 0.88 : 1;
    for (const [side, s] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const t0 = (i / steps) * tEnd, t1 = ((i + 1) / steps) * tEnd;
        const p0 = P(side, s, t0), p1 = P(side, s, t1);
        const a0 = [p0[0], p0[1] + o.ridgeH * 0.35, p0[2]], a1 = [p1[0], p1[1] + o.ridgeH * 0.35, p1[2]];
        const { m, len } = segMatrix(a0, a1);
        b.add(o.ridgeKey, box(o.ridgeW * 0.75, o.ridgeH * 0.75, len + 0.05), mul(base, m), o.ridgeColor);
      }
      if (o.hipEnds) {
        const p0 = P(side, s, 0);
        const ang = Math.atan2(p0[0], p0[2]);
        b.add(o.ridgeKey, box(o.ridgeW * 0.9, o.ridgeH * 1.4, 0.25), mul(base, M(p0[0], p0[1] + o.ridgeH * 0.7, p0[2], ang, -0.5, 0)), o.ridgeColor);
      }
    }
    // irimoya: ridge running down the gable edge (from tf to top)
    if (type === 'irimoya') {
      for (const [side, s] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const steps = 6;
        for (let i = 0; i < steps; i++) {
          const t0 = o.tf + (1 - o.tf) * (i / steps), t1 = o.tf + (1 - o.tf) * ((i + 1) / steps);
          const p0 = P(side, s, t0), p1 = P(side, s, t1);
          const a0 = [p0[0], p0[1] + o.ridgeH * 0.3, p0[2]], a1 = [p1[0], p1[1] + o.ridgeH * 0.3, p1[2]];
          const { m, len } = segMatrix(a0, a1);
          b.add(o.ridgeKey, box(o.ridgeW * 0.7, o.ridgeH * 0.7, len + 0.04), mul(base, m), o.ridgeColor);
        }
      }
    }
  }
  return { yOf, P, ridgeTop };
}
