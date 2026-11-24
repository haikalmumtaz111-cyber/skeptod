// Landscape constants and the analytic height function (shared by main thread and workers)
import { noise2, noise3, fbm2, ridged2, smoothstep, angDiff } from './noise.js';

export const V = {
  RIM_R: 360,        // crater rim radius
  RIM_H: 2000,       // rim height
  FLOOR_H: 1800,     // lava lake level inside the crater
  BREACH: -1.95,     // azimuth of the breached rim notch (atan2(z, x))
  HM: 7000,          // half extent of the detailed heightmap
  N: 1152,           // heightmap resolution
  GRID: 1100,        // terrain mesh grid resolution
};
V.CELL = (2 * V.HM) / V.N;

const CONES = [
  // x, z, height, radius
  [2950, 2050, 270, 520],
  [-3600, 2400, 210, 460],
  [1800, -4200, 180, 400],
  [-4550, -1700, 150, 360],
  [4900, -2600, 120, 320],
  [-1500, 5100, 170, 390],
  [5900, 1600, 100, 300],
];

export function terrainHeight(x, z) {
  const r0 = Math.hypot(x, z);
  const th0 = Math.atan2(z, x);

  const wx = x + 450 * fbm2(x * 0.0002 + 11.3, z * 0.0002 - 4.1, 3);
  const wz = z + 450 * fbm2(x * 0.0002 - 7.7, z * 0.0002 + 9.2, 3);
  const r = Math.hypot(wx, wz);
  const th = Math.atan2(wz, wx);
  const ca = Math.cos(th), sa = Math.sin(th);
  const a1 = noise3(ca * 1.5 + 3.1, sa * 1.5 - 1.7, 3.7);
  const a2 = noise3(ca * 4.2 - 2.3, sa * 4.2 + 0.4, 9.1);
  const breach = Math.exp(-Math.pow(angDiff(th, V.BREACH) / 0.22, 2));
  const rimR = V.RIM_R * (1 + 0.14 * a1 + 0.1 * breach);
  const rimH = V.RIM_H + 120 * a1 + 55 * a2 - 220 * breach;

  let h;
  if (r < rimR) {
    const q = r / rimR;
    const s = smoothstep(0.4, 1.0, q);
    h = V.FLOOR_H + (rimH - V.FLOOR_H) * Math.pow(s, 1.5);
    h += 10 * noise2(x * 0.025, z * 0.025) * s;
  } else {
    const rr = r - rimR;
    const topH = V.RIM_H + (rimH - V.RIM_H) * Math.exp(-rr / 850);
    let prof = 0.62 * Math.exp(-rr / 1750) + 0.38 * Math.exp(-rr / 5000);
    prof *= 1 + 0.08 * noise3(ca * 2.4, sa * 2.4, r * 0.00028) * smoothstep(0, 1800, rr);
    h = topH * prof;
    const gStr = smoothstep(30, 800, rr) * (1 - smoothstep(3400, 8200, r));
    if (gStr > 0.001) {
      const n1 = noise3(ca * 7.0, sa * 7.0, r * 0.00046 + 1.3);
      const n2 = noise3(ca * 18.0 + 5, sa * 18.0, r * 0.00115 + 7.1);
      const g1 = 1 - Math.abs(n1), g2 = 1 - Math.abs(n2);
      const g = g1 * g1 * g1 + 0.5 * g2 * g2 * g2;
      h -= gStr * g * (60 + 0.03 * rr);
    }
    h += 16 * noise2(x * 0.01, z * 0.01) * Math.exp(-rr / 600);
  }

  for (let k = 0; k < CONES.length; k++) {
    const c = CONES[k];
    const dx = x - c[0], dz = z - c[1];
    const d2 = dx * dx + dz * dz;
    if (d2 < c[3] * c[3]) {
      const q = Math.sqrt(d2) / c[3];
      let ch = c[2] * Math.pow(1 - q, 1.8);
      const cq = q / 0.2;
      if (cq < 1) ch -= c[2] * 0.32 * (1 - cq * cq);
      h += ch;
    }
  }

  const low = 30 * fbm2(x * 0.00025 + 3.3, z * 0.00025 - 2.2, 4) + 10 * fbm2(x * 0.0019, z * 0.0019, 3);
  h += low * smoothstep(2000, 7000, r0);
  if (r0 < 15000) {
    h += (18 * fbm2(x * 0.0036, z * 0.0036, 4) + 4.5 * noise2(x * 0.02, z * 0.02)) * (1 - smoothstep(9000, 15000, r0));
  }

  if (r0 > 8000) {
    const corridor = 1 - 0.8 * Math.exp(-Math.pow(angDiff(th0, -1.62) / 0.42, 2));
    const foothill = smoothstep(8500, 17000, r0) * 260 * (0.55 + 0.45 * fbm2(x * 0.0004, z * 0.0004, 4));
    let mnt = 0;
    const m = smoothstep(12500, 29000, r0);
    if (m > 0) {
      const rg = ridged2(x * 0.0001 + 4.4, z * 0.0001 - 1.9, 5);
      mnt = m * 1700 * rg * rg * 1.8;
    }
    h += (foothill + mnt) * corridor;
  }
  return h;
}

export function warpCoord(u) {
  const a = Math.abs(u);
  return Math.sign(u) * (7000 * a + 39000 * Math.pow(a, 9));
}

// true where bilinear heightmap sampling is valid
export function insideHM(x, z) {
  const fx = (x + V.HM) / V.CELL - 0.5, fz = (z + V.HM) / V.CELL - 0.5;
  return fx >= 0 && fz >= 0 && fx < V.N - 1 && fz < V.N - 1;
}

// heightmap rows [j0, j1)
export function heightRows(j0, j1) {
  const N = V.N, HM = V.HM, cell = V.CELL;
  const out = new Float32Array((j1 - j0) * N);
  for (let j = j0; j < j1; j++) {
    const z = -HM + (j + 0.5) * cell;
    const o = (j - j0) * N;
    for (let i = 0; i < N; i++) out[o + i] = terrainHeight(-HM + (i + 0.5) * cell, z);
  }
  return out;
}

// mesh grid rows [j0, j1): heights only for vertices outside the heightmap (NaN inside)
export function meshRows(j0, j1) {
  const n = V.GRID + 1;
  const out = new Float32Array((j1 - j0) * n);
  for (let j = j0; j < j1; j++) {
    const z = warpCoord(-1 + (2 * j) / V.GRID);
    for (let i = 0; i < n; i++) {
      const x = warpCoord(-1 + (2 * i) / V.GRID);
      out[(j - j0) * n + i] = insideHM(x, z) ? NaN : terrainHeight(x, z);
    }
  }
  return out;
}
