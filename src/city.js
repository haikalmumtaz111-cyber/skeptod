import * as THREE from 'three';
import { Geo, RNG, offsetPoly, rectPoly, chamferPoly, roundRectPoly, circlePoly, notchPoly, frameMatrix, PALETTE, NEON_LIST, clamp } from './util.js';
import { BLOCK, STREET, PITCH, SIDEWALK, GRID, CURB_H, ROAD_HALF, blockRect, pathDistance, pathNearest } from './layout.js';
import { ICONS, ICON_NAMES } from './icons.js';

export const LANE_ALTS = [22, 30, 38, 57, 66, 88, 100, 126, 148];
const BRIDGE_BANDS = [44, 75, 110];

const FACADE_TINTS = [
  [0.17, 0.17, 0.19], [0.13, 0.14, 0.17], [0.2, 0.17, 0.15], [0.1, 0.105, 0.12], [0.24, 0.23, 0.25], [0.15, 0.12, 0.15], [0.12, 0.15, 0.16], [0.19, 0.2, 0.22],
];

function inStreet(x, z) {
  const lx = ((x % PITCH) + PITCH) % PITCH, lz = ((z % PITCH) + PITCH) % PITCH;
  const h = STREET / 2;
  return lx < h || lx > PITCH - h || lz < h || lz > PITCH - h;
}

function screenColor(seed) {
  const k = ((seed * 3.17) % 1 + 1) % 1;
  const a = [1.0, 0.1, 0.6], b = [0.1, 0.85, 1.0], c = [1.0, 0.55, 0.1], d = [0.55, 0.2, 1.0];
  const c1 = k < 0.25 ? a : k < 0.5 ? b : k < 0.75 ? c : d;
  const c2 = k < 0.25 ? b : k < 0.5 ? d : k < 0.75 ? a : b;
  return new THREE.Color((c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2, (c1[2] + c2[2]) / 2);
}

export function buildCity(path) {
  const samples = path.samples;
  const chunks = new Map();
  const CH = 230;
  function chunk(x, z) {
    const inGrid = x > -520 && x < 520 && z > -860 && z < 400;
    const S = inGrid ? CH : 1100;
    const key = (inGrid ? 'g' : 'f') + Math.floor((x + 3300) / S) + ',' + Math.floor((z + 3300) / S);
    let c = chunks.get(key);
    if (!c) {
      c = {
        facade: new Geo({ color: 3, aWin: 4, aWall: 4 }),
        trim: new Geo({ color: 3 }),
        props: new Geo({ color: 3 }),
        neon: new Geo({ aCol: 3, aNeon: 4 }),
        screen: new Geo({ aSign: 4 }),
        holo: new Geo({ aSign: 4 }),
      };
      chunks.set(key, c);
    }
    return c;
  }
  const emitters = [];
  const obstacles = [];
  const lamps = [];
  const beams = [];
  const steam = [];
  const points = []; // small distant blinking lights
  const searchlights = [];
  const lanternStrings = [];

  const rng = new RNG(1337);

  const emit = (p, color, intensity, range) => emitters.push({ p: p.clone ? p.clone() : new THREE.Vector3(...p), c: color.clone(), i: intensity, r: range });

  // distance from rect to camera path (xz)
  function rectPathDist(x0, z0, x1, z1) {
    let best = 1e9;
    for (const s of samples) {
      const dx = Math.max(x0 - s.x, 0, s.x - x1), dz = Math.max(z0 - s.z, 0, s.z - z1);
      const d = dx * dx + dz * dz; if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // ---------------------------------------------------------------- neon helpers
  function neonTube(g, pts, radius, col, inten, mode = 0, phase = 0, speed = 1, rseg = 5) {
    g.set('aCol', col.r, col.g, col.b);
    g.set('aNeon', inten, mode, phase, speed);
    if (pts.length < 2) return;
    g.tube(pts, radius, rseg);
  }
  function neonBox(g, x0, x1, y0, y1, z0, z1, col, inten, mode = 0, phase = 0, speed = 1) {
    g.set('aCol', col.r, col.g, col.b); g.set('aNeon', inten, mode, phase, speed);
    g.box(x0, x1, y0, y1, z0, z1);
  }
  // icon in a local plane: origin o (Vector3 local), axis a (horizontal), axis b (up)
  function neonIcon(g, name, ox, oy, oz, ax, az, size, col, inten, mode, phase, rseg = 4) {
    const strokes = ICONS[name]();
    for (const s of strokes) {
      const pts = [];
      for (const [u, v] of s.pts) {
        const p = new THREE.Vector3(ox + ax * u * size, oy + v * size, oz + az * u * size);
        if (!pts.length || pts[pts.length - 1].distanceToSquared(p) > 1e-6) pts.push(p);
      }
      neonTube(g, pts, Math.max(0.025, size * 0.022), col, inten, mode, phase, 1, rseg);
    }
  }
  function roundedRectPts(cx, cy, w, h, r, n = 3) {
    const pts = [];
    const cs = [[cx + w / 2 - r, cy - h / 2 + r, -Math.PI / 2], [cx + w / 2 - r, cy + h / 2 - r, 0], [cx - w / 2 + r, cy + h / 2 - r, Math.PI / 2], [cx - w / 2 + r, cy - h / 2 + r, Math.PI]];
    for (const [x, y, a0] of cs) for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI / 2; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    pts.push(pts[0]);
    return pts;
  }

  // ---------------------------------------------------------------- structure helpers
  function setFacade(g, style, seed, floorH, colW, wallLen, baseY, shop, topY, tint) {
    g.set('aWin', style, seed, floorH, colW);
    g.set('aWall', wallLen, baseY, shop, topY);
    g.set('color', tint[0], tint[1], tint[2]);
  }
  function ringPrism(g, poly, y0, y1, out, inn) {
    // ledge ring: outer walls + top ring + bottom ring (outer offset by out, inner by -inn)
    const P = offsetPoly(poly, out), Q = offsetPoly(poly, -inn);
    g.prism(P, y0, y1, { top: false });
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n], c = Q[(i + 1) % n], d = Q[i];
      g.quad([a[0], y1, a[1]], [b[0], y1, b[1]], [c[0], y1, c[1]], [d[0], y1, d[1]], [0, 1, 0]);
      g.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [c[0], y0, c[1]], [d[0], y0, d[1]], [0, -1, 0]);
    }
  }
  function parapet(g, poly, y, h, t) {
    const Q = offsetPoly(poly, -t); const n = poly.length;
    g.prism(poly, y, y + h, { top: false });
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], c = Q[(i + 1) % n], d = Q[i];
      g.quad([a[0], y + h, a[1]], [b[0], y + h, b[1]], [c[0], y + h, c[1]], [d[0], y + h, d[1]], [0, 1, 0]);
      // inner wall (normal inward)
      const ex = c[0] - d[0], ez = c[1] - d[1]; const L = Math.hypot(ex, ez) || 1;
      let nx = -ez / L, nz = ex / L; // one of perpendiculars
      // choose pointing to centroid
      let cx = 0, cz = 0; for (const p of Q) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
      const mx = (c[0] + d[0]) / 2, mz = (c[1] + d[1]) / 2;
      if ((cx - mx) * nx + (cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
      g.quad([d[0], y, d[1]], [c[0], y, c[1]], [c[0], y + h, c[1]], [d[0], y + h, d[1]], [nx, 0, nz]);
    }
  }
  function outwardPts(poly, dist, y, maxN = 4) {
    let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
    const out = []; const step = Math.max(1, Math.floor(poly.length / maxN));
    for (let i = 0; i < poly.length && out.length < maxN; i += step) {
      const [x, z] = poly[i]; let dx = x - cx, dz = z - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      out.push(new THREE.Vector3(x + dx * dist, y, z + dz * dist));
    }
    return out;
  }
  function polyBounds(poly) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return { x0, z0, x1, z1 };
  }

  // ---------------------------------------------------------------- roof props
  function roofProps(c, poly, y, r, bigTower, neonCol, lvl) {
    const b = polyBounds(poly);
    const isRound = poly.length > 12;
    let ix0 = b.x0 + 1.5, ix1 = b.x1 - 1.5, iz0 = b.z0 + 1.5, iz1 = b.z1 - 1.5;
    if (isRound) { const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, hs = (b.x1 - b.x0) * 0.33; ix0 = cx - hs; ix1 = cx + hs; iz0 = cz - hs; iz1 = cz + hs; }
    const w = ix1 - ix0, d = iz1 - iz0;
    if (w < 3 || d < 3) return;
    const g = lvl >= 1 ? c.props : c.trim;
    const tg = c.trim;
    // elevator / stair housing
    if (r.chance(0.8)) {
      const hw = Math.min(w * 0.4, r.range(3, 7)), hd = Math.min(d * 0.4, r.range(3, 6)), hh = r.range(2.8, 5);
      const hx = r.range(ix0, ix1 - hw), hz = r.range(iz0, iz1 - hd);
      tg.set('color', 0.16, 0.16, 0.18); tg.setMatrix(null);
      tg.box(hx, hx + hw, y, y + hh, hz, hz + hd, 'b');
      tg.box(hx - 0.2, hx + hw + 0.2, y + hh, y + hh + 0.25, hz - 0.2, hz + hd + 0.2, 'b');
      if (r.chance(0.5)) { // door light
        neonBox(c.neon, hx + hw * 0.4, hx + hw * 0.6, y + 2.2, y + 2.35, hz - 0.08, hz, new THREE.Color(1, 0.75, 0.45), 2.5);
      }
    }
    if (lvl < 1 && !bigTower) return;
    // AC / chillers
    const nAC = Math.floor(clamp(w * d / 40, 1, 7));
    for (let i = 0; i < nAC; i++) {
      const aw = r.range(1.6, 3.2), ad = r.range(1.2, 2.4), ah = r.range(1.0, 1.8);
      const ax = r.range(ix0, ix1 - aw), az = r.range(iz0, iz1 - ad);
      g.setMatrix(null); g.set('color', 0.28, 0.29, 0.31);
      g.box(ax, ax + aw, y, y + ah, az, az + ad, 'b');
      g.set('color', 0.05, 0.05, 0.06);
      const fr = Math.min(aw, ad) * 0.32;
      g.cylinder(ax + aw / 2, az + ad / 2, fr, fr, y + ah, y + ah + 0.12, 10, true);
    }
    // water tank on legs
    if (r.chance(0.45) && w > 5 && d > 5) {
      const tr = r.range(1.2, 2.0), tx = r.range(ix0 + tr, ix1 - tr), tz = r.range(iz0 + tr, iz1 - tr), legH = r.range(1.5, 3.0), th = r.range(2.5, 4.0);
      g.setMatrix(null); g.set('color', 0.12, 0.1, 0.09);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.box(tx + lx * tr * 0.65 - 0.1, tx + lx * tr * 0.65 + 0.1, y, y + legH, tz + lz * tr * 0.65 - 0.1, tz + lz * tr * 0.65 + 0.1, 'bt');
      g.set('color', 0.22, 0.17, 0.13);
      g.cylinder(tx, tz, tr, tr, y + legH, y + legH + th, 12, false);
      g.cylinder(tx, tz, tr * 1.03, 0.15, y + legH + th, y + legH + th + tr * 0.6, 12, false);
      g.cylinder(tx, tz, tr, tr, y + legH - 0.01, y + legH, 12, true);
    }
    // antenna masts
    const nAnt = bigTower ? r.int(1, 3) : (r.chance(0.5) ? 1 : 0);
    for (let i = 0; i < nAnt; i++) {
      const ax = r.range(ix0, ix1), az = r.range(iz0, iz1), ah = bigTower ? r.range(10, 28) : r.range(4, 10);
      tg.setMatrix(null); tg.set('color', 0.18, 0.18, 0.2);
      tg.cylinder(ax, az, 0.18, 0.06, y, y + ah, 6, false);
      for (let k = 1; k < 4; k++) { const yy = y + ah * k / 4; tg.box(ax - 0.9 + k * 0.15, ax + 0.9 - k * 0.15, yy, yy + 0.08, az - 0.04, az + 0.04); }
      points.push({ p: new THREE.Vector3(ax, y + ah + 0.2, az), c: new THREE.Color(1, 0.06, 0.04), size: bigTower ? 1.6 : 0.9, blink: 1, phase: r.f() });
    }
    // satellite dish
    if (r.chance(0.35)) {
      const dx = r.range(ix0 + 1, ix1 - 1), dz = r.range(iz0 + 1, iz1 - 1);
      const m = new THREE.Matrix4().makeTranslation(dx, y + 1.2, dz).multiply(new THREE.Matrix4().makeRotationX(-0.9 + r.f() * 0.3)).multiply(new THREE.Matrix4().makeRotationZ(r.f() * 6.28));
      g.setMatrix(null); g.set('color', 0.4, 0.4, 0.42); g.cylinder(dx, dz, 0.12, 0.12, y, y + 1.2, 5, false);
      g.setMatrix(m); g.lathe(0, 0, [[0.05, 0], [0.6, 0.12], [1.1, 0.4], [1.2, 0.48]], 12); g.setMatrix(null);
    }
    // rooftop helipad / neon ring for big towers
    if (bigTower && r.chance(0.5) && w > 12 && d > 12) {
      const cx = (ix0 + ix1) / 2, cz = (iz0 + iz1) / 2, rr = Math.min(w, d) * 0.4;
      tg.setMatrix(null); tg.set('color', 0.1, 0.1, 0.11); tg.cylinder(cx, cz, rr, rr, y, y + 0.6, 24, true);
      const pts = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2; pts.push(new THREE.Vector3(cx + Math.cos(a) * rr * 0.92, y + 0.65, cz + Math.sin(a) * rr * 0.92)); }
      neonTube(c.neon, pts, 0.12, neonCol, 4, 2, r.f(), 1.2, 4);
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; points.push({ p: new THREE.Vector3(cx + Math.cos(a) * rr, y + 0.8, cz + Math.sin(a) * rr), c: new THREE.Color(0.2, 1, 0.5), size: 0.8, blink: 2, phase: i / 8 }); }
    }
  }

  // ---------------------------------------------------------------- facade dressing
  // A wall frame: local x along the wall, y up, z outward.
  function wallFrameFrom(a, b, nx, nz) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
    const m = frameMatrix(a[0], 0, a[1], tx, tz, nx, nz);
    return { m, L, tx, tz, nx, nz, a, world: (u, y, d) => new THREE.Vector3(a[0] + tx * u + nx * d, y, a[1] + tz * u + nz * d) };
  }

  function bladeSign(c, f, u, y0, h, p, r, near) {
    const g = c.props, n = c.neon, s = c.screen;
    const t = 0.34, zf = 0.35;
    const col = PALETTE[r.pick(NEON_LIST)];
    const col2 = PALETTE[r.pick(NEON_LIST)];
    g.setMatrix(f.m); n.setMatrix(f.m); s.setMatrix(f.m);
    g.set('color', 0.05, 0.05, 0.06);
    g.box(u - t / 2, u + t / 2, y0, y0 + h, zf, zf + p);
    // brackets
    g.set('color', 0.1, 0.1, 0.11);
    g.box(u - 0.08, u + 0.08, y0 + 0.4, y0 + 0.6, 0, zf);
    g.box(u - 0.08, u + 0.08, y0 + h - 0.6, y0 + h - 0.4, 0, zf);
    const kind = near ? r.weighted([['screen', 3], ['icons', 4], ['cells', 2]]) : r.weighted([['screen', 4], ['icons', 1], ['cells', 3]]);
    const mode = r.f() < 0.3 ? 1 : 0;
    const ph = r.f();
    const inset = 0.12;
    if (kind === 'screen') {
      const seed = r.f() * 100;
      s.set('aSign', r.pick([0, 3, 5, 7, 7, 2, 4]), seed, p / h, r.range(0.8, 1.25));
      for (const side of [-1, 1]) {
        const x = u + side * (t / 2 + 0.01);
        s.quad([x, y0 + inset, zf + inset], [x, y0 + inset, zf + p - inset], [x, y0 + h - inset, zf + p - inset], [x, y0 + h - inset, zf + inset], [side, 0, 0],
          side > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[1, 0], [0, 0], [0, 1], [1, 1]]);
      }
      emit(f.world(u, y0 + h / 2, zf + p + 1.4), screenColor(seed), 30 * h * p / 12, 22);
    } else if (kind === 'cells') {
      const nc = Math.max(2, Math.round(h / p));
      const ch = (h - inset * 2) / nc;
      for (let i = 0; i < nc; i++) {
        const cc = i % 2 ? col : col2;
        for (const side of [-1, 1]) {
          const x0 = u + side * (t / 2), x1 = x0 + side * 0.03;
          neonBox(n, Math.min(x0, x1), Math.max(x0, x1), y0 + inset + i * ch + 0.06, y0 + inset + (i + 1) * ch - 0.06, zf + inset, zf + p - inset, cc, 2.2, mode, ph + i * 0.1, 1);
        }
      }
      emit(f.world(u, y0 + h / 2, zf + p + 1.4), col.clone().lerp(col2, 0.5), 30 * h * p / 12, 22);
    } else {
      const nIcons = Math.max(1, Math.floor(h / (p * 1.05)));
      const sz = Math.min(p * 0.78, (h - 0.3) / nIcons * 0.85);
      for (let i = 0; i < nIcons; i++) {
        const name = r.pick(ICON_NAMES); const ic = i % 2 ? col2 : col;
        const cy = y0 + h - (i + 0.5) * (h / nIcons);
        for (const side of [-1, 1]) neonIcon(n, name, u + side * (t / 2 + 0.06), cy, zf + p / 2, 0, side, sz, ic, 5, mode, ph, near ? 4 : 3);
        // icon backplate glow
      }
      emit(f.world(u, y0 + h / 2, zf + p + 1.4), col, 26 * h * p / 12, 20);
    }
    // neon border
    const bp = roundedRectPts(zf + p / 2, y0 + h / 2, p + 0.1, h + 0.1, 0.25, 2);
    for (const side of [-1, 1]) {
      const pts = bp.map(([zz, yy]) => new THREE.Vector3(u + side * (t / 2 + 0.05), yy, zz));
      neonTube(n, pts, 0.045, col, 6, mode, ph, 1, near ? 4 : 3);
    }
    g.setMatrix(null); n.setMatrix(null); s.setMatrix(null);
  }

  function billboard(c, f, u0, u1, y0, y1, r, mode, inten = 1.6) {
    const g = c.trim, n = c.neon, s = c.screen;
    g.setMatrix(f.m); n.setMatrix(f.m); s.setMatrix(f.m);
    const z = 0.6;
    g.set('color', 0.06, 0.06, 0.07);
    g.box(u0 - 0.4, u1 + 0.4, y0 - 0.4, y1 + 0.4, 0, z - 0.05);
    const seed = r.f() * 100;
    const W = u1 - u0, H = y1 - y0;
    s.set('aSign', mode, seed, W / H, inten);
    s.quad([u0, y0, z], [u1, y0, z], [u1, y1, z], [u0, y1, z], [0, 0, 1]);
    const col = screenColor(seed);
    // light bars
    neonBox(n, u0 - 0.4, u1 + 0.4, y1 + 0.4, y1 + 0.55, 0.1, z + 0.05, col, 3, 0);
    neonBox(n, u0 - 0.4, u1 + 0.4, y0 - 0.55, y0 - 0.4, 0.1, z + 0.05, col, 3, 0);
    // corner floodlights
    g.set('color', 0.1, 0.1, 0.1);
    for (const uu of [u0 + W * 0.2, u1 - W * 0.2]) g.box(uu - 0.3, uu + 0.3, y0 - 1.2, y0 - 0.9, 0.3, 1.6);
    emit(f.world((u0 + u1) / 2, (y0 + y1) / 2, 4), col, 6 * W * H / 10, Math.min(60, 18 + Math.sqrt(W * H) * 2));
    g.setMatrix(null); n.setMatrix(null); s.setMatrix(null);
  }

  function storefront(c, f, L, r, bld, full = true) {
    const g = c.props, n = c.neon, s = c.screen;
    g.setMatrix(f.m); n.setMatrix(f.m); s.setMatrix(f.m);
    const sw = 3.4;
    const nb = Math.floor(L / sw);
    // pillars
    g.set('color', 0.07, 0.07, 0.08);
    for (let i = 0; i <= nb; i++) { const uu = Math.min(i * sw, L); g.box(uu - 0.17, uu + 0.17, CURB_H, 4.6, 0, 0.18, 'b'); }
    // header beam
    g.box(0, L, 4.5, 4.75, 0, 0.3);
    let i = 0;
    while (i < nb) {
      const span = Math.min(nb - i, r.int(1, 3));
      const u0 = i * sw + 0.2, u1 = (i + span) * sw - 0.2;
      const col = PALETTE[r.pick(NEON_LIST)];
      const k = r.f();
      if (k < 0.6) {
        // horizontal sign box with screen or neon border
        g.set('color', 0.04, 0.04, 0.05);
        g.box(u0, u1, 3.6, 4.45, 0.18, 0.42);
        if (r.chance(full ? 0.55 : 0.85)) {
          const seed = r.f() * 100;
          s.set('aSign', r.pick([7, 7, 0, 3, 5]), seed, (u1 - u0) / 0.75, 1.2);
          s.quad([u0 + 0.08, 3.65, 0.43], [u1 - 0.08, 3.65, 0.43], [u1 - 0.08, 4.4, 0.43], [u0 + 0.08, 4.4, 0.43], [0, 0, 1]);
        } else {
          const pts = roundedRectPts((u0 + u1) / 2, 4.02, u1 - u0 - 0.2, 0.68, 0.15, 2).map(([x, y]) => new THREE.Vector3(x, y, 0.47));
          neonTube(n, pts, 0.04, col, 6, r.chance(0.2) ? 1 : 0, r.f(), 1, full ? 4 : 3);
          const nIcons = full ? Math.min(3, Math.floor((u1 - u0) / 1.2)) : 0;
          const name = r.pick(ICON_NAMES);
          for (let q = 0; q < nIcons; q++) neonIcon(n, r.chance(0.5) ? name : r.pick(ICON_NAMES), u0 + 0.7 + q * ((u1 - u0 - 1.4) / Math.max(1, nIcons - 1)), 4.02, 0.47, 1, 0, 0.5, PALETTE[r.pick(NEON_LIST)], 5, 3, q * 0.25, 3);
        }
      }
      if (r.chance(0.55)) {
        // awning
        const ac = r.pick([[0.32, 0.03, 0.06], [0.03, 0.18, 0.2], [0.05, 0.05, 0.06], [0.25, 0.12, 0.02], [0.12, 0.03, 0.22]]);
        g.set('color', ac[0], ac[1], ac[2]);
        const yA = 3.5, yB = 3.0, zA = 0.3, zB = r.range(1.4, 2.4);
        g.quad([u0, yA, zA], [u1, yA, zA], [u1, yB, zB], [u0, yB, zB], [0, 0.9, 0.4]);
        g.quad([u0, yA - 0.05, zA], [u1, yA - 0.05, zA], [u1, yB - 0.05, zB], [u0, yB - 0.05, zB], [0, -0.9, -0.4]);
        g.box(u0, u1, yB - 0.25, yB, zB - 0.03, zB + 0.03);
        if (r.chance(0.6)) neonTube(n, [new THREE.Vector3(u0, yB - 0.27, zB + 0.05), new THREE.Vector3(u1, yB - 0.27, zB + 0.05)], 0.035, col, 5, 0, r.f(), 1, 4);
        // lanterns under the awning
        if (full && r.chance(0.3)) {
          for (let q = 0; q < Math.floor((u1 - u0) / 1.4); q++) {
            const lx = u0 + 0.7 + q * 1.4;
            g.set('color', 0.05, 0.05, 0.05); g.box(lx - 0.01, lx + 0.01, yB - 0.6, yB - 0.25, zB - 0.4, zB - 0.38);
            n.set('aCol', 1.0, 0.18, 0.06); n.set('aNeon', 3.0, 0, r.f(), 1);
            n.lathe(lx, zB - 0.39, [[0.0, yB - 1.05], [0.17, yB - 0.98], [0.22, yB - 0.82], [0.17, yB - 0.66], [0.0, yB - 0.6]], 8);
          }
        }
      }
      if (full && r.chance(0.25)) {
        neonIcon(n, r.pick(ICON_NAMES), (u0 + u1) / 2 + r.range(-0.5, 0.5), r.range(1.6, 2.6), 0.08, 1, 0, r.range(0.6, 1.0), PALETTE[r.pick(NEON_LIST)], 5, r.chance(0.3) ? 1 : 2, r.f(), 3);
      }
      emit(f.world((u0 + u1) / 2, 2.6, 1.6), col, 20, 16);
      i += span;
    }
    // vending machines / boxes
    if (r.chance(0.35) && L > 6) {
      const vu = r.range(1, L - 2);
      g.set('color', 0.18, 0.2, 0.22); g.box(vu, vu + 1.0, CURB_H, 2.0, 0.18, 0.95);
      const vc = PALETTE[r.pick(['cyan', 'pink', 'amber', 'white'])];
      neonBox(n, vu + 0.1, vu + 0.9, 0.9, 1.85, 0.95, 0.97, vc, 2.2, 0);
      emit(f.world(vu + 0.5, 1.4, 1.5), vc, 6, 8);
    }
    g.setMatrix(null); n.setMatrix(null); s.setMatrix(null);
  }

  function acUnits(c, f, L, floorH, colW, baseY, topY, r, density) {
    const g = c.props; g.setMatrix(f.m);
    const nCols = Math.max(1, Math.floor(L / colW)); const margin = (L - nCols * colW) / 2;
    let count = 0;
    for (let fl = 0; baseY + (fl + 1) * floorH < Math.min(topY, 60); fl++) {
      for (let col = 0; col < nCols; col++) {
        if (r.f() > density || count > 70) continue;
        const uc = margin + (col + 0.5) * colW + r.range(-0.3, 0.3);
        const yb = baseY + fl * floorH + r.range(0.05, 0.4);
        const sh = r.range(0.85, 1.0);
        g.set('color', 0.34 * sh, 0.34 * sh, 0.32 * sh);
        g.box(uc - 0.45, uc + 0.45, yb, yb + 0.6, 0.02, 0.55, 'n');
        g.set('color', 0.06, 0.06, 0.065);
        g.box(uc - 0.3, uc + 0.12, yb + 0.1, yb + 0.5, 0.55, 0.58, 'n');
        // bracket
        g.set('color', 0.1, 0.1, 0.1);
        g.box(uc - 0.4, uc + 0.4, yb - 0.08, yb, 0.02, 0.6, 'n');
        count++;
      }
    }
    g.setMatrix(null);
  }

  function balconies(c, f, L, floorH, colW, baseY, topY, r) {
    const g = c.props; g.setMatrix(f.m);
    const nCols = Math.max(1, Math.floor(L / colW)); const margin = (L - nCols * colW) / 2;
    for (let fl = 1; baseY + (fl + 1) * floorH < Math.min(topY, 70); fl++) {
      for (let col = 0; col < nCols - 1; col += 2) {
        if (r.f() > 0.35) continue;
        const u0 = margin + col * colW + 0.15, u1 = margin + (col + 2) * colW - 0.15;
        const yb = baseY + fl * floorH;
        g.set('color', 0.14, 0.14, 0.15);
        g.box(u0, u1, yb - 0.12, yb, 0, 1.1, 'n');
        g.set('color', 0.08, 0.08, 0.09);
        g.box(u0, u1, yb + 0.95, yb + 1.0, 1.05, 1.1, 'n');
        for (let k = 0; k <= Math.floor((u1 - u0) / 0.5); k++) { const uu = u0 + k * 0.5; g.box(uu - 0.015, uu + 0.015, yb, yb + 0.95, 1.06, 1.09, 'nbt'); }
        if (r.chance(0.35)) { // laundry / plants clutter
          const cc = r.pick([[0.3, 0.05, 0.05], [0.05, 0.15, 0.25], [0.25, 0.25, 0.25], [0.05, 0.2, 0.08]]);
          g.set('color', ...cc); g.box(u0 + 0.3, u0 + r.range(0.8, 1.6), yb + 0.4, yb + 1.0, 0.85, 0.95);
        }
      }
    }
    g.setMatrix(null);
  }

  function fireEscape(c, f, u0, floorH, baseY, topY, r) {
    const g = c.props; g.setMatrix(f.m);
    const W = r.range(3.2, 4.4), D = 1.3;
    const u1 = u0 + W;
    const yTop = Math.min(topY - 1.5, baseY + floorH * r.int(4, 9));
    g.set('color', 0.07, 0.065, 0.065);
    let k = 0;
    for (let y = baseY + floorH; y <= yTop; y += floorH, k++) {
      // platform grating
      g.box(u0, u1, y - 0.06, y, 0.05, D, 'n');
      // rails
      g.box(u0, u1, y + 0.95, y + 1.0, D - 0.04, D, 'n');
      g.box(u0, u0 + 0.04, y + 0.95, y + 1.0, 0.05, D, 'n');
      g.box(u1 - 0.04, u1, y + 0.95, y + 1.0, 0.05, D, 'n');
      for (let q = 0; q <= Math.floor(W / 0.8); q++) { const uu = u0 + q * 0.8; g.box(uu - 0.015, uu + 0.015, y, y + 0.95, D - 0.03, D - 0.01, 'nbt'); }
      g.box(u0, u0 + 0.03, y, y + 0.95, 0.05, 0.08, 'nbt'); g.box(u1 - 0.03, u1, y, y + 0.95, 0.05, 0.08, 'nbt');
      // stairs to next platform (zig-zag)
      if (y + floorH <= yTop) {
        const dir = k % 2 ? 1 : -1;
        const sx0 = dir > 0 ? u0 + 0.4 : u1 - 0.4, sx1 = dir > 0 ? u1 - 0.6 : u0 + 0.6;
        const run = Math.abs(sx1 - sx0), rise = floorH;
        const steps = Math.floor(rise / 0.22);
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const uu = sx0 + (sx1 - sx0) * t0, yy = y + rise * t0;
          const ua = Math.min(uu, uu + (sx1 - sx0) / steps), ub = Math.max(uu, uu + (sx1 - sx0) / steps);
          g.box(ua, ub, yy + 0.02, yy + 0.06, 0.15, 0.75, 'nb');
        }
        // stringer approximated by thin boxes
        const m = new THREE.Matrix4();
        const ang = Math.atan2(rise, (sx1 - sx0));
        const len = Math.hypot(run, rise);
        for (const zz of [0.12, 0.78]) {
          m.copy(f.m).multiply(new THREE.Matrix4().makeTranslation(sx0, y, zz)).multiply(new THREE.Matrix4().makeRotationZ(ang));
          g.setMatrix(m); g.box(0, len, -0.08, 0.04, -0.02, 0.02, 'n'); g.setMatrix(f.m);
        }
      }
    }
    // drop ladder
    g.box(u0 + 0.2, u0 + 0.25, baseY + 1.6, baseY + floorH, D - 0.25, D - 0.2, 'n');
    g.box(u0 + 0.65, u0 + 0.7, baseY + 1.6, baseY + floorH, D - 0.25, D - 0.2, 'n');
    for (let y = baseY + 1.8; y < baseY + floorH; y += 0.35) g.box(u0 + 0.2, u0 + 0.7, y, y + 0.03, D - 0.24, D - 0.21, 'n');
    g.setMatrix(null);
  }

  function pipes(c, f, L, topY, r) {
    const g = c.props; g.setMatrix(f.m);
    const n = r.int(1, 3);
    for (let i = 0; i < n; i++) {
      const u = r.range(0.5, L - 0.5), rad = r.range(0.07, 0.17), top = r.range(8, Math.min(topY, 70));
      g.set('color', r.pick([[0.1, 0.1, 0.11], [0.2, 0.12, 0.08], [0.16, 0.17, 0.18]]));
      const m = new THREE.Matrix4().copy(f.m);
      g.cylinder(u, rad + 0.12, rad, rad, CURB_H, top, 6, false);
      for (let y = 1.5; y < top; y += 3) g.box(u - rad - 0.05, u + rad + 0.05, y, y + 0.12, 0, rad * 2 + 0.14, 'n');
      if (r.chance(0.5)) { // elbow + horizontal run
        const dir = r.sign(); const len = r.range(2, 6);
        const pts = [new THREE.Vector3(u, top, rad + 0.12), new THREE.Vector3(u + dir * 0.4, top + 0.35, rad + 0.12), new THREE.Vector3(u + dir * len, top + 0.45, rad + 0.12)];
        g.tube(pts, rad, 6);
      }
      // steam vent at the bottom
      if (r.chance(0.15)) steam.push({ p: f.world(u, 0.5, 0.6), s: r.range(0.6, 1.2) });
    }
    g.setMatrix(null);
  }

  function facadeCables(c, f, L, r) {
    const g = c.props; g.setMatrix(f.m);
    const n = r.int(1, 4);
    g.set('color', 0.02, 0.02, 0.025);
    for (let i = 0; i < n; i++) {
      const y = r.range(4.8, 12), sag = r.range(0.2, 1.0), z = r.range(0.1, 0.4);
      const u0 = r.range(-1, L * 0.3), u1 = r.range(L * 0.6, L + 1);
      const pts = [];
      for (let k = 0; k <= 10; k++) { const t = k / 10; pts.push(new THREE.Vector3(u0 + (u1 - u0) * t, y - sag * 4 * t * (1 - t), z)); }
      g.tube(pts, r.range(0.015, 0.04), 4);
    }
    g.setMatrix(null);
  }

  function holoPanel(c, f, u, y0, r) {
    const h = c.holo; h.setMatrix(f.m);
    const W = r.range(2.2, 4.0), H = r.range(3, 6);
    const seed = r.f() * 100;
    h.set('aSign', r.pick([1, 2, 4, 5, 6]), seed, W / H, 1.6);
    h.quad([u, y0, 0.6], [u, y0, 0.6 + W], [u, y0 + H, 0.6 + W], [u, y0 + H, 0.6], [1, 0, 0]);
    h.setMatrix(null);
    // emitter
    const g = c.props; g.setMatrix(f.m); g.set('color', 0.05, 0.05, 0.06); g.box(u - 0.15, u + 0.15, y0 - 0.25, y0, 0, 0.9); g.setMatrix(null);
    emit(f.world(u + 1.5, y0 + H / 2, 0.6 + W / 2), screenColor(seed), 12, 14);
  }

  // ---------------------------------------------------------------- building
  function genBuilding(lot, r, opts = {}) {
    const { x0, z0, x1, z1 } = lot;
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const c = chunk(cx, cz);
    const near = lot.near;
    const lvl = near < 32 ? 2 : near < 230 ? 1 : 0;
    const seed = r.f() * 100;
    const minWD = Math.min(w, d);
    let H = opts.H;
    if (!H) {
      const k = r.f();
      H = k < 0.32 ? r.range(18, 38) : k < 0.7 ? r.range(38, 85) : k < 0.92 ? r.range(85, 160) : r.range(160, 250);
      if (minWD < 15) H = Math.min(H, r.range(22, 70));
      if (lot.frontRow && r.chance(0.5)) H = Math.min(H, r.range(18, 55));
      H = Math.max(H, 18);
    }
    let type = opts.type || r.weighted([['stack', 4], ['podium', 3], ['res', H < 70 ? 4 : 0.5], ['single', 2]]);
    if (type === 'podium' && minWD < 22) type = 'stack';
    const style = type === 'res' ? 4 : r.weighted([[1, 4], [2, 1.5], [3, 1.6], [4, 1.2], [5, 0.8]]);
    const floorH = type === 'res' ? r.range(2.9, 3.2) : r.range(3.3, 4.2);
    const colW = type === 'res' ? r.range(2.0, 2.6) : style === 3 ? r.range(1.5, 2.2) : r.range(1.8, 3.4);
    const tint = r.pick(FACADE_TINTS).map((v) => v * r.range(0.85, 1.25));
    const shapeKind = opts.shape || r.weighted([['rect', 5], ['chamfer', 2], ['notch', 1.2], ['round', minWD > 20 && H > 60 ? 1.4 : 0], ['rrect', 1.2]]);
    const shape = (inset, kind = shapeKind) => {
      const a = x0 + inset, b = z0 + inset, e = x1 - inset, f2 = z1 - inset; const m = Math.min(e - a, f2 - b);
      if (kind === 'chamfer') return chamferPoly(a, b, e, f2, m * 0.16);
      if (kind === 'notch') return notchPoly(a, b, e, f2, m * 0.14);
      if (kind === 'round') return circlePoly((a + e) / 2, (b + f2) / 2, m / 2, 24);
      if (kind === 'rrect') return roundRectPoly(a, b, e, f2, m * 0.22, 3);
      return rectPoly(a, b, e, f2);
    };
    const neonCol = PALETTE[r.pick(NEON_LIST)];
    // sections
    const secs = [];
    if (type === 'podium') {
      const ph = r.pick([8.5, 12.5, 16.5]);
      secs.push({ poly: rectPoly(x0, z0, x1, z1), y0: 0, y1: ph, style: r.chance(0.5) ? 3 : 1, podium: true });
      const ins = r.range(3, Math.min(8, minWD * 0.25));
      const k2 = H > 120 && r.chance(0.6);
      if (k2) {
        const mid = ph + (H - ph) * r.range(0.55, 0.75);
        secs.push({ poly: shape(ins), y0: ph, y1: mid, style });
        secs.push({ poly: shape(ins + r.range(1.5, 3.5)), y0: mid, y1: H, style });
      } else secs.push({ poly: shape(ins), y0: ph, y1: H, style });
    } else if (type === 'stack') {
      const n = H > 110 ? r.int(2, 4) : H > 45 ? r.int(1, 3) : 1;
      let y = 0, ins = 0;
      for (let i = 0; i < n; i++) {
        const y1 = i === n - 1 ? H : y + (H - y) * r.range(0.45, 0.7);
        const kind = i === 0 && shapeKind === 'round' ? 'rrect' : shapeKind;
        secs.push({ poly: shape(ins, kind), y0: y, y1, style });
        y = y1; ins += r.range(1.2, Math.max(1.3, Math.min(4, minWD * 0.12)));
        if (minWD - ins * 2 < 7) break;
      }
      secs[secs.length - 1].y1 = H;
    } else {
      secs.push({ poly: shape(type === 'res' ? 0 : r.chance(0.5) ? 0 : 0.6, type === 'res' ? 'rect' : shapeKind), y0: 0, y1: H, style });
    }
    obstacles.push({ x0, z0, x1, z1, h: H });

    const g = c.facade;
    const wallInfo = [];
    secs.forEach((sec, si) => {
      const isGround = sec.y0 === 0;
      g.prism(sec.poly, sec.y0, sec.y1, {
        top: true,
        onWall: (i, a, b, L, nx, nz) => {
          if (i < 0) return;
          const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
          const street = inStreet(mx + nx * 3.0, mz + nz * 3.0) && !inStreet(mx - nx * 1.5, mz - nz * 1.5);
          const shop = isGround && street && L > 3.5 ? 1 : 0;
          const baseY = shop ? 4.8 : sec.y0 + (isGround ? 0.4 : 0.0);
          setFacade(g, sec.style, seed + i * 3.1 + si * 11.7, floorH, colW, L, baseY, shop, sec.y1, tint);
          wallInfo.push({ a, b, L, nx, nz, street, shop, sec, si, baseY });
        },
      });
      // ledge at top of section (if not last) / parapet
      const tg = c.trim; tg.setMatrix(null);
      tg.set('color', tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8);
      if (si < secs.length - 1) {
        ringPrism(tg, sec.poly, sec.y1 - 0.25, sec.y1 + 0.45, 0.35, 0.3);
        if (lvl >= 1 && r.chance(0.35)) {
          const pts = offsetPoly(sec.poly, 0.42).map(([x, z]) => new THREE.Vector3(x, sec.y1 + 0.1, z)); pts.push(pts[0].clone());
          neonTube(c.neon, pts, 0.08, neonCol, 4, r.chance(0.3) ? 2 : 0, r.f(), 0.7, 4);
          for (const q of outwardPts(sec.poly, 3, sec.y1 + 0.5, 2)) emit(q, neonCol, 25, 26);
        }
      }
      // intermediate floor bands
      if (lvl >= 1 && r.chance(0.5)) {
        const every = r.int(3, 7) * floorH;
        for (let y = sec.y0 + every; y < sec.y1 - 2; y += every) ringPrism(tg, sec.poly, y - 0.12, y + 0.12, 0.12, 0.05);
      }
      // vertical fins for curtain wall style
      if (lvl >= 1 && (sec.style === 3 || (sec.style === 1 && r.chance(0.4))) && sec.poly.length <= 12 && r.chance(0.6)) {
        const n = sec.poly.length;
        for (let i = 0; i < n; i++) {
          const a = sec.poly[i], b = sec.poly[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 4) continue;
          const ex = (b[0] - a[0]) / L, ez = (b[1] - a[1]) / L; const nx = ez, nz = -ex;
          const f = wallFrameFrom(a, b, nx, nz); tg.setMatrix(f.m);
          const nCols = Math.max(1, Math.floor(L / colW)); const margin = (L - nCols * colW) / 2;
          for (let k = 0; k <= nCols; k += 2) { const uu = margin + k * colW; tg.box(uu - 0.08, uu + 0.08, sec.y0 + (si === 0 ? 5 : 0.5), sec.y1 - 0.5, 0, 0.45); }
          tg.setMatrix(null);
        }
      }
    });
    const top = secs[secs.length - 1];
    const tg = c.trim; tg.setMatrix(null);
    tg.set('color', tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85);
    // crown
    const crown = opts.crown || r.weighted([['parapet', 5], ['stepped', H > 70 ? 2 : 0.3], ['pyramid', H > 90 && top.poly.length <= 12 ? 1 : 0], ['frame', H < 80 && lvl >= 1 ? 1 : 0]]);
    let roofY = H;
    parapet(tg, top.poly, H, 1.1, 0.3);
    if (crown === 'stepped') {
      let ins = 1.5, y = H;
      for (let k = 0; k < r.int(2, 3); k++) {
        const p = offsetPoly(top.poly, -ins); const hh = r.range(2.5, 5);
        const b = polyBounds(p); if (b.x1 - b.x0 < 4) break;
        tg.prism(p, y, y + hh, { top: true });
        const pts = offsetPoly(p, 0.05).map(([x, z]) => new THREE.Vector3(x, y + hh, z)); pts.push(pts[0].clone());
        neonTube(c.neon, pts, 0.1, neonCol, 5, 0, 0, 1, 4);
        y += hh; ins += r.range(1.5, 3);
      }
      const b = polyBounds(top.poly);
      emit(new THREE.Vector3((b.x0 + b.x1) / 2, y + 2, (b.z0 + b.z1) / 2), neonCol, 60, 45);
      roofY = y;
    } else if (crown === 'pyramid') {
      const b = polyBounds(top.poly); const pcx = (b.x0 + b.x1) / 2, pcz = (b.z0 + b.z1) / 2;
      const ph = Math.min(b.x1 - b.x0, b.z1 - b.z0) * r.range(0.5, 1.0);
      const p = offsetPoly(top.poly, -0.6);
      for (let i = 0; i < p.length; i++) {
        const a = p[i], q = p[(i + 1) % p.length];
        const mx = (a[0] + q[0]) / 2 - pcx, mz = (a[1] + q[1]) / 2 - pcz; const ml = Math.hypot(mx, mz) || 1;
        const nn = new THREE.Vector3(mx / ml * ph, ml, mz / ml * ph).normalize();
        const i0 = tg.count;
        tg.vertex(a[0], H + 1.1, a[1], nn.x, nn.y, nn.z, 0, 0); tg.vertex(q[0], H + 1.1, q[1], nn.x, nn.y, nn.z, 1, 0); tg.vertex(pcx, H + 1.1 + ph, pcz, nn.x, nn.y, nn.z, 0.5, 1);
        // winding by check
        const e1 = new THREE.Vector3(q[0] - a[0], 0, q[1] - a[1]), e2 = new THREE.Vector3(pcx - a[0], ph, pcz - a[1]);
        const cr = e1.clone().cross(e2); if (cr.dot(nn) > 0) tg.tri(i0, i0 + 1, i0 + 2); else tg.tri(i0, i0 + 2, i0 + 1);
      }
      const pts = []; for (let i = 0; i <= p.length; i++) { const a = p[i % p.length]; pts.push(new THREE.Vector3(a[0], H + 1.15, a[1])); }
      neonTube(c.neon, pts, 0.1, neonCol, 5, 2, r.f(), 0.6, 4);
      tg.cylinder(pcx, pcz, 0.25, 0.05, H + 1.1 + ph, H + 1.1 + ph + ph * 0.6, 6, false);
      points.push({ p: new THREE.Vector3(pcx, H + 1.1 + ph * 1.6, pcz), c: new THREE.Color(1, 0.05, 0.03), size: 2.2, blink: 1, phase: r.f() });
      roofY = H + 1.1 + ph;
    } else if (crown === 'frame') {
      // rooftop billboard frame facing the most important street side
      const streetWalls = wallInfo.filter((wi) => wi.street && wi.si === secs.length - 1 && wi.L > 8);
      if (streetWalls.length) {
        const wi = r.pick(streetWalls);
        const f = wallFrameFrom(wi.a, wi.b, wi.nx, wi.nz);
        const W = Math.min(wi.L - 2, r.range(8, 16)), Hh = W * r.range(0.4, 0.7);
        const u0 = (wi.L - W) / 2;
        const yb = H + 3;
        tg.setMatrix(f.m); tg.set('color', 0.08, 0.08, 0.09);
        for (let k = 0; k <= 3; k++) { const uu = u0 + k * W / 3; tg.box(uu - 0.12, uu + 0.12, H, yb + Hh, -2.5, -2.26); tg.box(uu - 0.08, uu + 0.08, H, yb, -2.3, -0.4); }
        tg.box(u0, u0 + W, yb - 0.1, yb + 0.1, -2.5, -0.4);
        tg.setMatrix(null);
        billboard(c, { ...f, m: f.m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.9)), world: (u, y, dd) => f.world(u, y, dd - 0.9) }, u0, u0 + W, yb, yb + Hh, r, r.pick([0, 1, 2, 3, 5, 6]), 1.7);
      }
    }
    if (crown !== 'pyramid') roofProps(c, offsetPoly(top.poly, -0.4), H, r, H > 120, neonCol, lvl);
    if (H > 90) points.push({ p: new THREE.Vector3(cx, roofY + 1.5, cz), c: new THREE.Color(1, 0.06, 0.04), size: 1.8, blink: 1, phase: r.f() });

    // building-wide neon: corner strips
    if (lvl >= 1 || H > 100) {
      if (r.chance(0.3) && top.poly.length <= 12) {
        const sec = secs[secs.length - 1];
        const col = neonCol, mode = r.chance(0.3) ? 2 : 0, ph = r.f();
        for (const [x, z] of offsetPoly(sec.poly, 0.1)) neonTube(c.neon, [new THREE.Vector3(x, sec.y0 + 2, z), new THREE.Vector3(x, sec.y1 - 0.5, z)], 0.12, col, 4.5, mode, ph, 0.8, 4);
        for (const q of outwardPts(sec.poly, 2.5, (sec.y0 + sec.y1) / 2, 2)) emit(q, col, 22, 28);
      }
    }
    // searchlights on tall towers
    if (H > 200 && r.chance(0.12) && searchlights.length < 6) searchlights.push({ p: new THREE.Vector3(cx, roofY + 1, cz), phase: r.f() * 6.28, speed: r.range(0.15, 0.35), tilt: r.range(0.25, 0.5), color: r.chance(0.5) ? new THREE.Color(0.7, 0.85, 1.0) : neonCol.clone() });

    // facade dressing per wall
    const billboardBudget = { n: H > 40 ? (lvl === 2 ? 2 : 1) : 0 };
    for (const wi of wallInfo) {
      const { a, b, L, nx, nz, street, sec } = wi;
      const f = wallFrameFrom(a, b, nx, nz);
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const frontNear = street ? pathNearest(samples, mx + nx * 12, mz + nz * 12).d : 999;
      const pathWall = lvl === 2 && street && frontNear < 22;
      if (wi.shop && (pathWall || (lvl >= 1 && r.chance(0.5)))) storefront(c, f, L, r, { floorH, colW }, pathWall);
      if (pathWall) {
        // blade signs
        if (L > 6) {
          let u = r.range(1.2, 4);
          while (u < L - 1.5) {
            if (r.chance(0.65)) {
              const h = r.range(3, 10), p = r.range(1.3, 2.8);
              const y0 = r.range(5.2, 9.5);
              if (y0 + h < sec.y1 - 0.5) bladeSign(c, f, u, y0, h, p, r, true);
            }
            u += r.range(4, 9);
          }
        }
        if (style === 4 || r.chance(0.35)) acUnits(c, f, L, floorH, colW, wi.baseY, sec.y1, r, style === 4 ? 0.3 : 0.12);
        if (style === 4 && r.chance(0.6)) balconies(c, f, L, floorH, colW, wi.baseY, sec.y1, r);
        if (L > 8 && r.chance(0.4) && sec.y1 > 18) fireEscape(c, f, r.range(1, L - 5.5), floorH, wi.baseY - 0.4, sec.y1, r);
        if (r.chance(0.7)) pipes(c, f, L, sec.y1, r);
        if (r.chance(0.6)) facadeCables(c, f, L, r);
        if (r.chance(0.25) && L > 6) holoPanel(c, f, r.range(1, L - 1), r.range(6, 12), r);
      } else if (street && lvl >= 1 && wi.si === 0 && L > 6 && r.chance(0.45)) {
        // a couple of blade signs on other streets
        const nS = r.int(1, 3);
        for (let k = 0; k < nS; k++) { const h = r.range(3, 9), p = r.range(1.3, 2.6), y0 = r.range(5.2, 9); if (y0 + h < sec.y1) bladeSign(c, f, r.range(1, L - 1), y0, h, p, r, false); }
      }
      // billboards on upper walls
      if (billboardBudget.n > 0 && L > 9 && sec.y1 - Math.max(sec.y0, 12) > 14 && (street || H > 100) && r.chance(pathWall ? 0.55 : 0.35)) {
        const W = Math.min(L * r.range(0.5, 0.85), r.range(8, 22));
        const ar = r.weighted([[0.55, 1.4], [1.0, 1], [1.8, 1.6], [2.6, 0.6]]);
        let Hh = Math.min(W * ar, sec.y1 - Math.max(sec.y0, 12) - 3);
        if (Hh > 5) {
          const u0 = r.range(0.5, L - W - 0.5);
          const y0 = r.range(Math.max(sec.y0 + 2, 14), sec.y1 - Hh - 2);
          billboard(c, f, u0, u0 + W, y0, y0 + Hh, r, r.pick([0, 1, 2, 3, 4, 5, 6, 6, 1, 2]), 1.15);
          billboardBudget.n--;
        }
      }
    }
    return { H, secs };
  }

  // ---------------------------------------------------------------- lots
  function subdivide(rect, r, out, depth = 0) {
    const w = rect.x1 - rect.x0, d = rect.z1 - rect.z0;
    const maxS = 34, minS = 13;
    if ((w <= maxS && d <= maxS && (r.chance(0.55) || (w < minS * 2.1 && d < minS * 2.1))) || depth > 6) { out.push(rect); return; }
    if ((w >= d && w >= minS * 2) || d < minS * 2) {
      if (w < minS * 2) { out.push(rect); return; }
      const t = r.range(0.35, 0.65); const xm = rect.x0 + w * t;
      subdivide({ x0: rect.x0, x1: xm, z0: rect.z0, z1: rect.z1 }, r, out, depth + 1);
      subdivide({ x0: xm, x1: rect.x1, z0: rect.z0, z1: rect.z1 }, r, out, depth + 1);
    } else {
      const t = r.range(0.35, 0.65); const zm = rect.z0 + d * t;
      subdivide({ x0: rect.x0, x1: rect.x1, z0: rect.z0, z1: zm }, r, out, depth + 1);
      subdivide({ x0: rect.x0, x1: rect.x1, z0: zm, z1: rect.z1 }, r, out, depth + 1);
    }
  }

  // landmark specs (block coords)
  const LANDMARKS = {
    '-1,-2': { H: 430, kind: 'mega1' },
    '1,0': { H: 340, kind: 'mega2' },
    '0,-4': { H: 290, kind: 'mega3' },
  };
  const landmarkInfo = [];

  for (let bi = GRID.i0; bi <= GRID.i1; bi++) {
    for (let bj = GRID.j0; bj <= GRID.j1; bj++) {
      const br = blockRect(bi, bj);
      const r = new RNG(bi * 7919 + bj * 104729 + 17);
      const lm = LANDMARKS[bi + ',' + bj];
      if (lm) {
        const near = rectPathDist(br.x0, br.z0, br.x1, br.z1);
        const lot = { ...br, near, frontRow: true };
        // podium full block, megatower above
        const res = genMegaTower(lot, r, lm);
        landmarkInfo.push(res);
        continue;
      }
      const lots = [];
      subdivide(br, r, lots);
      for (const lot of lots) {
        const onX0 = Math.abs(lot.x0 - br.x0) < 0.01, onX1 = Math.abs(lot.x1 - br.x1) < 0.01, onZ0 = Math.abs(lot.z0 - br.z0) < 0.01, onZ1 = Math.abs(lot.z1 - br.z1) < 0.01;
        const g = r.chance(0.35) ? r.range(0.8, 1.6) : 0.05;
        const L = { x0: lot.x0 + (onX0 ? 0 : g), x1: lot.x1 - (onX1 ? 0 : g), z0: lot.z0 + (onZ0 ? 0 : g), z1: lot.z1 - (onZ1 ? 0 : g) };
        L.near = rectPathDist(L.x0, L.z0, L.x1, L.z1);
        L.frontRow = onX0 || onX1 || onZ0 || onZ1;
        genBuilding(L, r);
      }
    }
  }

  function genMegaTower(lot, r, spec) {
    const { x0, z0, x1, z1 } = lot; const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const c = chunk(cx, cz);
    const H = spec.H;
    // podium ring of shops (as regular buildings around the block edges)
    const ring = [];
    const depth = 16;
    ring.push({ x0, x1, z0, z1: z0 + depth }, { x0, x1, z0: z1 - depth, z1 }, { x0, x1: x0 + depth, z0: z0 + depth, z1: z1 - depth }, { x0: x1 - depth, x1, z0: z0 + depth, z1: z1 - depth });
    for (const rr of ring) {
      const sub = [];
      const horiz = rr.x1 - rr.x0 > rr.z1 - rr.z0;
      let s = horiz ? rr.x0 : rr.z0; const e = horiz ? rr.x1 : rr.z1;
      while (s < e - 1) { const n = Math.min(e, s + r.range(12, 22)); sub.push(horiz ? { x0: s, x1: e - n < 8 ? e : n, z0: rr.z0, z1: rr.z1 } : { x0: rr.x0, x1: rr.x1, z0: s, z1: e - n < 8 ? e : n }); s = e - n < 8 ? e : n; }
      for (const L of sub) { L.near = rectPathDist(L.x0, L.z0, L.x1, L.z1); L.frontRow = true; genBuilding(L, r, { H: r.range(14, 30), type: r.chance(0.5) ? 'res' : 'single', shape: 'rect', crown: 'parapet' }); }
    }
    // tower core
    const g = c.facade, tg = c.trim, ng = c.neon;
    const seed = r.f() * 100;
    const tint = [0.1, 0.11, 0.13];
    const ix0 = x0 + depth + 1, ix1 = x1 - depth - 1, iz0 = z0 + depth + 1, iz1 = z1 - depth - 1;
    const icx = (ix0 + ix1) / 2, icz = (iz0 + iz1) / 2;
    const sections = [];
    const neonCol = spec.kind === 'mega2' ? PALETTE.cyan : spec.kind === 'mega3' ? PALETTE.orange : PALETTE.magenta;
    if (spec.kind === 'mega1') {
      sections.push({ poly: chamferPoly(ix0 - 8, iz0 - 8, ix1 + 8, iz1 + 8, 8), y0: 0, y1: 40, style: 3 });
      sections.push({ poly: chamferPoly(ix0 - 4, iz0 - 4, ix1 + 4, iz1 + 4, 9), y0: 40, y1: 210, style: 1 });
      sections.push({ poly: chamferPoly(ix0 + 2, iz0 + 2, ix1 - 2, iz1 - 2, 10), y0: 210, y1: 330, style: 3 });
      sections.push({ poly: circlePoly(icx, icz, (ix1 - ix0) / 2 - 6, 28), y0: 330, y1: H, style: 2 });
    } else if (spec.kind === 'mega2') {
      sections.push({ poly: notchPoly(ix0 - 6, iz0 - 6, ix1 + 6, iz1 + 6, 9), y0: 0, y1: 160, style: 2 });
      sections.push({ poly: notchPoly(ix0 - 2, iz0 - 2, ix1 + 2, iz1 + 2, 10), y0: 160, y1: 270, style: 3 });
      sections.push({ poly: roundRectPoly(ix0 + 4, iz0 + 4, ix1 - 4, iz1 - 4, 8, 4), y0: 270, y1: H, style: 1 });
    } else {
      sections.push({ poly: roundRectPoly(ix0 - 6, iz0 - 6, ix1 + 6, iz1 + 6, 12, 4), y0: 0, y1: 190, style: 5 });
      sections.push({ poly: roundRectPoly(ix0, iz0, ix1, iz1, 10, 4), y0: 190, y1: H, style: 3 });
    }
    sections.forEach((sec, si) => {
      g.prism(sec.poly, sec.y0, sec.y1, { top: true, onWall: (i, a, b, L) => { if (i < 0) return; setFacade(g, sec.style, seed + i * 3.1 + si * 7, 4.0, 2.4, L, sec.y0 + (si === 0 ? 0.5 : 0), 0, sec.y1, tint); } });
      tg.set('color', 0.08, 0.08, 0.09);
      ringPrism(tg, sec.poly, sec.y1 - 0.4, sec.y1 + 1.2, 0.8, 0.5);
      const pts = offsetPoly(sec.poly, 0.85).map(([x, z]) => new THREE.Vector3(x, sec.y1 + 0.4, z)); pts.push(pts[0].clone());
      neonTube(ng, pts, 0.25, neonCol, 5, 0, 0, 1, 5);
      // vertical light strips at corners
      if (sec.poly.length <= 12) for (const [x, z] of offsetPoly(sec.poly, 0.25)) neonTube(ng, [new THREE.Vector3(x, sec.y0 + 3, z), new THREE.Vector3(x, sec.y1 - 1, z)], 0.22, si % 2 ? PALETTE.cyan : neonCol, 4, 3, r.f(), 0.15, 4);
      for (const q of outwardPts(sec.poly, 7, sec.y1, 4)) emit(q, neonCol, 160, 80);
      // giant vertical screens on faces
      if (si === 1 || (spec.kind === 'mega3' && si === 0)) {
        const n = sec.poly.length;
        for (let i = 0; i < n; i++) {
          const a = sec.poly[i], b = sec.poly[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 20) continue;
          const ex = (b[0] - a[0]) / L, ez = (b[1] - a[1]) / L;
          const f = wallFrameFrom(a, b, ez, -ex);
          const W = Math.min(L * 0.55, 30), Hh = W * r.range(1.6, 2.4);
          if (r.chance(0.8)) billboard(c, f, (L - W) / 2, (L + W) / 2, sec.y0 + 25, Math.min(sec.y0 + 25 + Hh, sec.y1 - 8), r, r.pick([1, 2, 5, 6, 4]), 1.7);
        }
      }
    });
    const top = sections[sections.length - 1];
    // crown: stacked halo rings + spire
    const tb = polyBounds(top.poly); const rad = (tb.x1 - tb.x0) / 2;
    tg.set('color', 0.09, 0.09, 0.1);
    let y = H;
    for (let k = 0; k < 4; k++) {
      const rr = rad * (1 - k * 0.2);
      tg.cylinder(icx, icz, rr, rr * 0.92, y, y + 5, 24, true);
      const pts = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; pts.push(new THREE.Vector3(icx + Math.cos(a) * (rr + 0.3), y + 2.5, icz + Math.sin(a) * (rr + 0.3))); }
      neonTube(ng, pts, 0.3, k % 2 ? PALETTE.cyan : neonCol, 5, 2, k * 0.25, 0.5, 5);
      y += 7;
    }
    tg.cylinder(icx, icz, 1.6, 0.2, y, y + 70, 8, false);
    for (let k = 0; k < 6; k++) points.push({ p: new THREE.Vector3(icx, y + 10 + k * 10, icz), c: new THREE.Color(1, 0.05, 0.03), size: 2.5, blink: 1, phase: k * 0.12 });
    // halo rings floating
    for (let k = 0; k < 2; k++) {
      const rr = rad * (1.6 + k * 0.5), yy = H - 40 - k * 35;
      const pts = []; for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2; pts.push(new THREE.Vector3(icx + Math.cos(a) * rr, yy + Math.sin(a * 3) * 1.5, icz + Math.sin(a) * rr)); }
      neonTube(ng, pts, 0.35, k ? PALETTE.cyan : neonCol, 4.5, 2, k * 0.5, 0.4, 5);
    }
    searchlights.push({ p: new THREE.Vector3(icx + 5, H + 1, icz), phase: 0, speed: 0.22, tilt: 0.3, color: new THREE.Color(0.75, 0.85, 1) });
    searchlights.push({ p: new THREE.Vector3(icx - 5, H + 1, icz), phase: 3.1, speed: 0.22, tilt: 0.35, color: neonCol.clone() });
    obstacles.push({ x0: ix0 - 8, z0: iz0 - 8, x1: ix1 + 8, z1: iz1 + 8, h: y + 70 });
    return { center: new THREE.Vector3(icx, 0, icz), H, radius: rad, color: neonCol };
  }

  // ---------------------------------------------------------------- far skyline
  {
    const r = new RNG(99);
    const cxC = 0, czC = -228;
    let placed = 0;
    for (let tries = 0; tries < 2400 && placed < 190; tries++) {
      const a = r.f() * Math.PI * 2, d = r.range(620, 1700);
      const x = cxC + Math.cos(a) * d, z = czC + Math.sin(a) * d;
      if (x > -480 && x < 480 && z > -820 && z < 360) continue;
      const s = r.range(26, 70);
      let ok = true;
      for (const o of obstacles) { if (x + s / 2 > o.x0 - 6 && x - s / 2 < o.x1 + 6 && z + s / 2 > o.z0 - 6 && z - s / 2 < o.z1 + 6) { ok = false; break; } }
      if (!ok) continue;
      const H = r.range(120, 260) * (d > 1100 ? 1.6 : 1.0) * (r.chance(0.15) ? 1.8 : 1);
      genBuilding({ x0: x - s / 2, x1: x + s / 2, z0: z - s * 0.4, z1: z + s * 0.4, near: 9999, frontRow: false }, r, { H, type: 'stack' });
      placed++;
    }
  }

  // ---------------------------------------------------------------- street furniture & spanning structures
  {
    const r = new RNG(4242);
    // street lamps along streets near the path region
    const lampSpacing = 22;
    const pushLamp = (x, z, ax, az) => {
      // ax,az: arm direction toward road center
      const c = chunk(x, z);
      const g = c.props; g.setMatrix(null);
      g.set('color', 0.09, 0.09, 0.1);
      g.cylinder(x, z, 0.14, 0.1, CURB_H, 7.6, 6, false);
      g.box(x - 0.2, x + 0.2, CURB_H, 1.0, z - 0.2, z + 0.2, 'b');
      const hx = x + ax * 2.6, hz = z + az * 2.6;
      // arm
      const pts = [new THREE.Vector3(x, 7.4, z), new THREE.Vector3(x + ax * 1.2, 7.9, z + az * 1.2), new THREE.Vector3(hx, 7.8, hz)];
      g.tube(pts, 0.07, 5);
      g.box(hx - 0.45, hx + 0.45, 7.62, 7.95, hz - 0.45, hz + 0.45);
      const warm = r.chance(0.35);
      const col = warm ? new THREE.Color(1.0, 0.62, 0.3) : new THREE.Color(0.65, 0.85, 1.0);
      neonBox(c.neon, hx - 0.4, hx + 0.4, 7.56, 7.62, hz - 0.4, hz + 0.4, col, 6, r.chance(0.04) ? 1 : 0, r.f(), 1);
      lamps.push({ p: new THREE.Vector3(hx, 7.55, hz), c: col });
      emit(new THREE.Vector3(hx, 7.0, hz), col, 55, 20);
    };
    for (let bi = GRID.i0; bi <= GRID.i1 + 1; bi++) {
      const x = bi * PITCH;
      for (let z = GRID.j0 * PITCH; z < (GRID.j1 + 1) * PITCH; z += lampSpacing) {
        const lz = ((z % PITCH) + PITCH) % PITCH; if (lz < STREET / 2 + 3 || lz > PITCH - STREET / 2 - 3) continue;
        if (pathNearest(samples, x, z).d > 260) continue;
        pushLamp(x - ROAD_HALF - 0.6, z, 1, 0); pushLamp(x + ROAD_HALF + 0.6, z + lampSpacing / 2, -1, 0);
      }
    }
    for (let bj = GRID.j0; bj <= GRID.j1 + 1; bj++) {
      const z = bj * PITCH;
      for (let x = GRID.i0 * PITCH; x < (GRID.i1 + 1) * PITCH; x += lampSpacing) {
        const lx = ((x % PITCH) + PITCH) % PITCH; if (lx < STREET / 2 + 3 || lx > PITCH - STREET / 2 - 3) continue;
        if (pathNearest(samples, x, z).d > 260) continue;
        pushLamp(x, z - ROAD_HALF - 0.6, 0, 1); pushLamp(x + lampSpacing / 2, z + ROAD_HALF + 0.6, 0, -1);
      }
    }

    // cables & lantern strings across the low avenue segment (x = 0)
    for (let z = 104; z > -215; z -= r.range(5, 11)) {
      const lz = ((z % PITCH) + PITCH) % PITCH; if (lz < STREET / 2 + 2 || lz > PITCH - STREET / 2 - 2) continue;
      const c = chunk(0, z); const g = c.props; g.setMatrix(null);
      const n = r.int(1, 4);
      const yb = r.range(8.5, 15);
      for (let k = 0; k < n; k++) {
        const y0 = yb + r.range(-0.6, 0.8), y1 = yb + r.range(-0.6, 0.8), sag = r.range(0.6, 2.2);
        const zz0 = z + r.range(-1, 1), zz1 = z + r.range(-1.5, 1.5);
        const pts = [];
        for (let q = 0; q <= 16; q++) { const t = q / 16; pts.push(new THREE.Vector3(-15 + 30 * t, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t), zz0 + (zz1 - zz0) * t)); }
        if (pts.some((p) => pathDistance(samples, p.x, p.y, p.z) < 2.2)) continue;
        g.set('color', 0.015, 0.015, 0.02);
        g.tube(pts, r.range(0.02, 0.05), 4);
        if (k === 0 && r.chance(0.3)) {
          // lantern string
          const lc = r.chance(0.7) ? new THREE.Color(1.0, 0.16, 0.05) : new THREE.Color(1.0, 0.5, 0.12);
          const L = []; for (let q = 1; q < 16; q += 1.5) { const t = q / 16; L.push(new THREE.Vector3(-15 + 30 * t, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t) - 0.45, zz0 + (zz1 - zz0) * t)); }
          for (const p of L) {
            if (pathDistance(samples, p.x, p.y, p.z) < 2.2) continue;
            c.neon.setMatrix(null); c.neon.set('aCol', lc.r, lc.g, lc.b); c.neon.set('aNeon', 1.8, 0, r.f(), 1);
            c.neon.lathe(p.x, p.z, [[0.0, p.y - 0.35], [0.2, p.y - 0.28], [0.27, p.y - 0.1], [0.27, p.y + 0.08], [0.2, p.y + 0.25], [0.0, p.y + 0.32]], 8);
            g.set('color', 0.03, 0.03, 0.03); g.cylinder(p.x, p.z, 0.12, 0.12, p.y + 0.3, p.y + 0.38, 6, true); g.cylinder(p.x, p.z, 0.12, 0.12, p.y - 0.42, p.y - 0.34, 6, true);
          }
          emit(new THREE.Vector3(0, y0 - 1, (zz0 + zz1) / 2), lc, 40, 18);
        }
      }
    }
    // heavy cable bundles across high canyon on avenue x=114 and cross streets
    for (const [xa, za, alongZ] of [[PITCH, 0, true], [0, -PITCH * 3, false], [PITCH, -PITCH * 2, true]]) {
      for (let q = 0; q < 14; q++) {
        const s = r.range(-PITCH * 1.4, PITCH * 1.4);
        const x = alongZ ? xa : xa + s, z = alongZ ? za + s : za;
        const lx = alongZ ? ((z % PITCH) + PITCH) % PITCH : ((x % PITCH) + PITCH) % PITCH;
        if (lx < STREET / 2 + 2 || lx > PITCH - STREET / 2 - 2) continue;
        const y = r.pick([r.range(41, 52), r.range(70, 84), r.range(14, 18)]);
        const c = chunk(x, z); const g = c.props; g.setMatrix(null); g.set('color', 0.015, 0.015, 0.02);
        for (let k = 0; k < r.int(2, 5); k++) {
          const sag = r.range(1, 3.5), dy = r.range(-0.8, 0.8), off = r.range(-1.2, 1.2);
          const pts = [];
          for (let i = 0; i <= 18; i++) { const t = i / 18; const a = -15 + 30 * t; pts.push(alongZ ? new THREE.Vector3(x + a, y + dy - sag * 4 * t * (1 - t), z + off) : new THREE.Vector3(x + off, y + dy - sag * 4 * t * (1 - t), z + a)); }
          if (pts.some((p) => pathDistance(samples, p.x, p.y, p.z) < 3.5)) continue;
          g.tube(pts, r.range(0.04, 0.09), 4);
        }
      }
    }
    // skybridges
    for (let k = 0; k < 26; k++) {
      const alongZ = r.chance(0.5);
      const bi = r.int(-2, 2), bj = r.int(-5, 1);
      const x = alongZ ? bi * PITCH : bi * PITCH + r.range(STREET / 2 + 8, PITCH - STREET / 2 - 8);
      const z = alongZ ? bj * PITCH + r.range(STREET / 2 + 8, PITCH - STREET / 2 - 8) : bj * PITCH;
      const yb = r.pick(BRIDGE_BANDS) + r.range(-0.5, 0.8);
      // clearance from camera path
      const pn = pathNearest(samples, x, z);
      if (pn.d < 22 && Math.abs(pn.p.y - (yb + 2.5)) < 9) continue;
      const c = chunk(x, z);
      const f = alongZ ? { m: frameMatrix(x - 15.5, 0, z, 1, 0, 0, 1) } : { m: frameMatrix(x, 0, z - 15.5, 0, 1, 1, 0) };
      const tg = c.trim; tg.setMatrix(f.m);
      tg.set('color', 0.1, 0.1, 0.12);
      tg.box(0, 31, yb, yb + 0.6, -2.8, 2.8);
      tg.box(0, 31, yb + 4.2, yb + 4.8, -2.8, 2.8);
      for (let u = 0; u <= 31; u += 3.1) { tg.box(u - 0.12, u + 0.12, yb + 0.6, yb + 4.2, -2.75, -2.55); tg.box(u - 0.12, u + 0.12, yb + 0.6, yb + 4.2, 2.55, 2.75); }
      tg.set('color', 0.02, 0.025, 0.035);
      tg.box(0, 31, yb + 0.6, yb + 4.2, -2.6, 2.6, 'tb');
      const ng = c.neon; ng.setMatrix(f.m);
      const col = PALETTE[r.pick(NEON_LIST)];
      neonBox(ng, 0, 31, yb + 0.6, yb + 0.75, -2.62, -2.58, col, 4, 3, r.f(), 0.3);
      neonBox(ng, 0, 31, yb + 0.6, yb + 0.75, 2.58, 2.62, col, 4, 3, r.f(), 0.3);
      neonBox(ng, 0, 31, yb + 3.9, yb + 4.0, -2.65, 2.65, new THREE.Color(1, 0.85, 0.7), 2.0, 0);
      tg.setMatrix(null); ng.setMatrix(null);
      const wp = new THREE.Vector3(15.5, yb + 2, 0).applyMatrix4(f.m);
      emit(wp, col, 50, 25);
    }
    // traffic signal poles at intersections near the path
    for (let bi = -1; bi <= 2; bi++) for (let bj = -4; bj <= 2; bj++) {
      const x = bi * PITCH, z = bj * PITCH;
      if (pathNearest(samples, x, z).d > 120) continue;
      for (const [sx, sz] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) {
        if (!r.chance(0.6)) continue;
        const px = x + sx * (ROAD_HALF + 1.2), pz = z + sz * (ROAD_HALF + 1.2);
        const c = chunk(px, pz); const g = c.props; g.setMatrix(null); g.set('color', 0.08, 0.08, 0.09);
        g.cylinder(px, pz, 0.15, 0.12, CURB_H, 6.5, 6, false);
        const ax = -sx, az = 0;
        g.box(Math.min(px, px + ax * 5), Math.max(px, px + ax * 5), 6.2, 6.4, pz - 0.08, pz + 0.08);
        const hx = px + ax * 4.5;
        g.box(hx - 0.3, hx + 0.3, 5.1, 6.2, pz - 0.3, pz + 0.3);
        const ph = r.f();
        for (const [yy, cc, md] of [[5.95, new THREE.Color(1, 0.05, 0.05), 0], [5.65, new THREE.Color(1, 0.6, 0.05), 0], [5.35, new THREE.Color(0.1, 1, 0.5), 0]]) {
          neonBox(c.neon, hx - 0.12, hx + 0.12, yy - 0.12, yy + 0.12, pz - sz * 0.32 - 0.02, pz - sz * 0.32 + 0.02, cc, 4, 4, ph + yy, 0.08);
        }
        // holographic pedestrian signal (abstract pictogram)
        neonIcon(c.neon, 'chevrons', px, 3.2, pz, 0, 1, 0.5, new THREE.Color(0.2, 1, 0.8), 4, 3, ph);
      }
    }
    // steam from manholes along the path
    for (let i = 0; i < 40; i++) {
      const sIdx = Math.floor(r.f() * samples.length); const s = samples[sIdx];
      if (s.y > 30) continue;
      steam.push({ p: new THREE.Vector3(s.x + r.sign() * r.range(4, 9), 0.1, s.z + r.range(-6, 6)), s: r.range(0.6, 1.1) });
    }
  }

  // ---------------------------------------------------------------- finalize meshes
  return { chunks, emitters, obstacles, lamps, beams, steam, points, searchlights, landmarks: landmarkInfo };
}
