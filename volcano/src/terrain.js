// Volcano landscape: heightmap assembly, lava flow tracing, channel carving,
// terrain mesh and GPU lookup textures.
import * as THREE from 'three';
import { noise2, smoothstep, clamp, mulberry32, pnoise2 } from './noise.js';
import { V, terrainHeight, warpCoord, heightRows, meshRows } from './height.js';
import { rockData } from './texgen.js';

export { V, terrainHeight, warpCoord };

// ---------------------------------------------------------------------------
// Parallel generation with inline workers (falls back to the main thread)
export async function generateHeights(workerSrc) {
  const N = V.N, n = V.GRID + 1;
  const hm = new Float32Array(N * N);
  const far = new Float32Array(n * n);
  let rock = null;
  const jobs = [];
  const hc = 12, mc = 8;
  for (let k = 0; k < hc; k++) jobs.push({ job: 'h', a: Math.floor((k * N) / hc), b: Math.floor(((k + 1) * N) / hc) });
  for (let k = 0; k < mc; k++) jobs.push({ job: 'm', a: Math.floor((k * n) / mc), b: Math.floor(((k + 1) * n) / mc) });
  jobs.push({ job: 'r' });
  const put = (j, out) => {
    if (j.job === 'h') hm.set(out, j.a * N);
    else if (j.job === 'm') far.set(out, j.a * n);
    else rock = out;
  };
  const runLocal = () => {
    for (const j of jobs) put(j, j.job === 'h' ? heightRows(j.a, j.b) : j.job === 'm' ? meshRows(j.a, j.b) : rockData());
  };
  let workers = [];
  try {
    if (workerSrc && typeof Worker !== 'undefined') {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
      const nw = Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4));
      for (let k = 0; k < nw; k++) workers.push(new Worker(url));
    }
  } catch (e) { workers = []; }
  if (workers.length) {
    try {
      await new Promise((resolve, reject) => {
        let next = 0, done = 0;
        const timer = setTimeout(() => reject(new Error('worker timeout')), 30000);
        const feed = (w) => {
          if (next >= jobs.length) return;
          const id = next++;
          w.postMessage({ id, ...jobs[id] });
        };
        for (const w of workers) {
          w.onmessage = (e) => {
            put(jobs[e.data.id], e.data.out);
            if (++done === jobs.length) { clearTimeout(timer); resolve(); } else feed(w);
          };
          w.onerror = (e) => { clearTimeout(timer); reject(e); };
          feed(w);
        }
      });
    } catch (e) {
      runLocal();
    }
    workers.forEach((w) => w.terminate());
  } else {
    runLocal();
  }
  return { hm, far, rock };
}

export function makeSampler(hm) {
  const N = V.N, HM = V.HM, cell = V.CELL;
  return function sample(x, z) {
    const fx = (x + HM) / cell - 0.5, fz = (z + HM) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return terrainHeight(x, z);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i = iz * N + ix;
    const a = hm[i], b = hm[i + 1], c = hm[i + N], d = hm[i + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

// ---------------------------------------------------------------------------
// Lava flows: steepest-descent tracing with inertia, meandering and branching.
function traceFlow(sample, x, z, dx, dz, o, out, depth) {
  const pts = o.prefix ? o.prefix.slice() : [];
  const step = 7;
  let s = o.s0 || 0;
  const sEnd = s + o.maxLen;
  let stall = 0;
  const seed = o.seed;
  const rnd = o.rnd;
  const lim = V.HM - 80;
  while (s < sEnd) {
    const e = 14;
    const gx = (sample(x + e, z) - sample(x - e, z)) / (2 * e);
    const gz = (sample(x, z + e) - sample(x, z - e)) / (2 * e);
    const gl = Math.hypot(gx, gz);
    let tx = dx, tz = dz;
    if (gl > 1e-4) {
      const k = 1 - o.inertia;
      tx = dx * o.inertia + (-gx / gl) * k;
      tz = dz * o.inertia + (-gz / gl) * k;
    }
    const m = noise2(x * 0.0035 + seed, z * 0.0035 - seed) * 0.05;
    const cm = Math.cos(m), sm = Math.sin(m);
    const nx = tx * cm - tz * sm, nz = tx * sm + tz * cm;
    const nl = Math.hypot(nx, nz) || 1;
    dx = nx / nl; dz = nz / nl;
    x += dx * step; z += dz * step; s += step;
    const t = (s - (o.s0 || 0)) / o.maxLen;
    let w = o.w0 + (o.w1 - o.w0) * Math.pow(t, 0.85);
    w *= 1 + 0.22 * noise2(s * 0.004, seed * 3.1);
    if (gl < 0.03) stall += step; else stall = Math.max(0, stall - step * 2);
    w *= 1 + Math.min(stall / 500, 1.4);
    if (Math.abs(x) > lim || Math.abs(z) > lim) break;
    pts.push(x, z, s, w, dx, dz);
    if (stall > 700) break;
    if (depth < 2 && o.branch > 0 && s - (o.s0 || 0) > 600 && rnd() < o.branch * step) {
      const sign = rnd() < 0.5 ? -1 : 1;
      const ang = sign * (0.3 + rnd() * 0.45);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      traceFlow(sample, x, z, dx * ca - dz * sa, dx * sa + dz * ca, {
        ...o, prefix: null, s0: s, maxLen: (sEnd - s) * (0.35 + rnd() * 0.4),
        w0: w * 0.6, w1: o.w1 * 0.65, branch: o.branch * 0.5, seed: seed + 7.7 + depth,
      }, out, depth + 1);
    }
  }
  out.push({ pts, active: o.active, id: out.length });
}

export function traceLava(sample) {
  const rnd = mulberry32(4242);
  const flows = [];
  const B = V.BREACH;
  const polar = (a, r) => [Math.cos(a) * r, Math.sin(a) * r];

  // spillway from the lava lake through the breach notch
  const prefix = [];
  for (let r = V.RIM_R * 0.2; r < V.RIM_R * 1.1; r += 7) {
    const [x, z] = polar(B, r);
    prefix.push(x, z, (r - V.RIM_R * 0.2) * 0.4, 46 + r * 0.04, Math.cos(B), Math.sin(B));
  }
  {
    const [x, z] = polar(B, V.RIM_R * 1.1);
    traceFlow(sample, x, z, Math.cos(B), Math.sin(B), {
      prefix, s0: 120, maxLen: 7400, w0: 58, w1: 260, inertia: 0.85, branch: 0.00024,
      seed: 1.3, rnd, active: true,
    }, flows, 0);
  }
  // fountain-fed flows spilling from the upper cone on other flanks
  const others = [
    [B + 1.25, 5400, 34, 170, 260],
    [B + 2.55, 4600, 30, 160, 420],
    [B - 1.45, 5600, 38, 190, 300],
    [B + 3.55, 3700, 26, 140, 560],
    [B - 0.62, 3200, 24, 120, 650],
  ];
  others.forEach((f, k) => {
    const [x, z] = polar(f[0], V.RIM_R + 25);
    traceFlow(sample, x, z, Math.cos(f[0]), Math.sin(f[0]), {
      s0: f[4], maxLen: f[1], w0: f[2], w1: f[3], inertia: 0.8, branch: 0.0002,
      seed: 3.7 + k * 5.1, rnd, active: true,
    }, flows, 0);
  });
  // flank fissure vent feeding a flow
  const fa = B + 1.9;
  const fissure = [];
  for (let r = 1300; r < 2050; r += 6) {
    const a = fa + 0.05 * Math.sin(r * 0.008);
    const [x, z] = polar(a, r);
    fissure.push(x, z, 300 + (r - 1300) * 0.2, 10 + 4 * Math.sin(r * 0.03) ** 2, Math.cos(a), Math.sin(a));
  }
  flows.push({ pts: fissure, active: true, id: flows.length, fissure: true });
  {
    const [x, z] = polar(fa, 2050);
    traceFlow(sample, x, z, Math.cos(fa), Math.sin(fa), {
      s0: 420, maxLen: 4300, w0: 28, w1: 170, inertia: 0.8, branch: 0.00018, seed: 21.1, rnd, active: true,
    }, flows, 0);
  }
  // old, cooled flows from previous eruptions
  const old = [
    [B + 0.55, 1900, 7800, 75, 380],
    [B + 2.0, 2700, 7000, 65, 330],
    [B - 2.2, 2200, 7800, 85, 420],
    [B + 3.0, 3200, 6000, 65, 290],
    [B - 1.0, 2800, 6200, 60, 310],
  ];
  old.forEach((f, k) => {
    const [x, z] = polar(f[0], f[1]);
    traceFlow(sample, x, z, Math.cos(f[0]), Math.sin(f[0]), {
      s0: 0, maxLen: f[2], w0: f[3], w1: f[4], inertia: 0.86, branch: 0.00026,
      seed: 40 + k * 3.3, rnd, active: false,
    }, flows, 0);
  });
  return flows;
}

// Rasterise flows (as capsule segments) into a nearest-flow field on the heightmap grid.
export function rasterLava(flows) {
  const N = V.N, HM = V.HM, cell = V.CELL;
  const F = {
    nd: new Float32Array(N * N).fill(9),
    s: new Float32Array(N * N),
    dx: new Float32Array(N * N),
    dz: new Float32Array(N * N),
    w: new Float32Array(N * N),
    act: new Uint8Array(N * N),
  };
  const order = flows.slice().sort((a, b) => (a.active === b.active ? 0 : a.active ? 1 : -1));
  const STRIDE = 3;
  for (const f of order) {
    const p = f.pts;
    const np = p.length / 6;
    for (let k = 0; k < np - 1; k += STRIDE) {
      const k2 = Math.min(np - 1, k + STRIDE);
      const a = k * 6, b = k2 * 6;
      const ax = p[a], az = p[a + 1], bx = p[b], bz = p[b + 1];
      const wa = p[a + 3], wb = p[b + 3];
      const R = Math.max(wa, wb) * 2.2 + cell * 2;
      const ex = bx - ax, ez = bz - az;
      const el2 = ex * ex + ez * ez || 1;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + HM) / cell));
      const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + R + HM) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R + HM) / cell));
      const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + R + HM) / cell));
      for (let j = j0; j <= j1; j++) {
        const tz = -HM + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const tx = -HM + (i + 0.5) * cell;
          let t = ((tx - ax) * ex + (tz - az) * ez) / el2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + ex * t - tx, pz = az + ez * t - tz;
          const w = wa + (wb - wa) * t;
          const nd = Math.sqrt(px * px + pz * pz) / w;
          const id = j * N + i;
          let better = nd < F.nd[id];
          if (f.active && !F.act[id] && nd < 1.3) better = true;
          if (better) {
            F.nd[id] = nd;
            F.s[id] = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
            F.dx[id] = p[a + 4] + (p[b + 4] - p[a + 4]) * t;
            F.dz[id] = p[a + 5] + (p[b + 5] - p[a + 5]) * t;
            F.w[id] = w;
            F.act[id] = f.active ? 1 : 0;
          }
        }
      }
    }
  }
  return F;
}

export function carveLava(hm, F) {
  const N = V.N, HM = V.HM, cell = V.CELL;
  for (let j = 0; j < N; j++) {
    const z = -HM + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const id = j * N + i;
      const nd = F.nd[id];
      if (nd > 1.7) continue;
      const x = -HM + (i + 0.5) * cell;
      const r = Math.hypot(x, z);
      const inCrater = 1 - smoothstep(V.RIM_R * 0.9, V.RIM_R * 1.25, r);
      const w = F.w[id];
      const thick = (F.act[id] ? 3.5 : 6) + w * 0.035;
      let dh = thick * (1 - smoothstep(0.62, 1.08, nd));
      dh += 0.7 * thick * Math.exp(-Math.pow((nd - 1.0) / 0.2, 2));
      hm[id] += dh * (1 - inCrater);
    }
  }
}

function boxBlur(src, N, rad, passes) {
  const a = src.slice();
  const b = new Float32Array(N * N);
  const inv = 1 / (2 * rad + 1);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < N; j++) {
      const row = j * N;
      let acc = 0;
      for (let i = -rad; i <= rad; i++) acc += a[row + Math.min(N - 1, Math.max(0, i))];
      for (let i = 0; i < N; i++) {
        b[row + i] = acc * inv;
        acc += a[row + Math.min(N - 1, i + rad + 1)] - a[row + Math.max(0, i - rad)];
      }
    }
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let j = -rad; j <= rad; j++) acc += b[Math.min(N - 1, Math.max(0, j)) * N + i];
      for (let j = 0; j < N; j++) {
        a[j * N + i] = acc * inv;
        acc += b[Math.min(N - 1, j + rad + 1) * N + i] - b[Math.max(0, j - rad) * N + i];
      }
    }
  }
  return a;
}

// Build GPU lookup textures from heightmap and lava field.
export function buildTextures(hm, F, floatLinear) {
  const N = V.N, HM = V.HM, cell = V.CELL;
  const lava = new Float32Array(N * N * 4);
  const H = N >> 1;
  const cov = new Float32Array(H * H);
  const near = new Float32Array(H * H);
  const oldm = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = -HM + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const id = j * N + i;
      const nd = Math.min(F.nd[id], 9);
      const act = F.act[id];
      lava[id * 4] = nd;
      lava[id * 4 + 1] = act ? F.s[id] * 0.001 : -1 - F.s[id] * 0.001;
      lava[id * 4 + 2] = F.dx[id];
      lava[id * 4 + 3] = F.dz[id];
      oldm[id] = act ? 0 : 1 - smoothstep(0.75, 1.05, nd);
      if ((i & 1) === 0 && (j & 1) === 0) {
        const x = -HM + (i + 0.5) * cell;
        const hid = (j >> 1) * H + (i >> 1);
        const r = Math.hypot(x, z);
        const lake = 1 - smoothstep(V.RIM_R * 0.3, V.RIM_R * 0.48, r);
        const c = act ? (1 - smoothstep(0.7, 1.0, nd)) : 0;
        const temp = 0.3 + 0.7 * Math.exp(-F.s[id] / 3000);
        cov[hid] = Math.max(c * temp, lake * 1.3);
        near[hid] = act && nd < 2.2 ? 1 - smoothstep(1.0, 2.2, nd) : 0;
      }
    }
  }
  const gNear = boxBlur(cov, H, 5, 3);
  const gBroad = boxBlur(cov, H, 20, 3);
  const scorch = boxBlur(near, H, 3, 2);
  const heat = new Uint8Array(N * N * 4);
  const bl = (arr, i, j) => {
    const fx = Math.min(H - 1.001, Math.max(0, i * 0.5 - 0.25)), fz = Math.min(H - 1.001, Math.max(0, j * 0.5 - 0.25));
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, k = iz * H + ix;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - tz) + (arr[k + H] * (1 - tx) + arr[k + H + 1] * tx) * tz;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const id = j * N + i;
      heat[id * 4] = clamp(bl(gNear, i, j) * 2.6, 0, 1) * 255;
      heat[id * 4 + 1] = clamp(Math.sqrt(bl(gBroad, i, j) * 9), 0, 1) * 255;
      heat[id * 4 + 2] = oldm[id] * 255;
      heat[id * 4 + 3] = clamp(bl(scorch, i, j) * 1.8, 0, 1) * 255;
    }
  }

  // normal + curvature map from the heightmap
  const nrm = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const jm = Math.max(0, j - 1) * N, jp = Math.min(N - 1, j + 1) * N;
    const jm3 = Math.max(0, j - 3) * N, jp3 = Math.min(N - 1, j + 3) * N;
    for (let i = 0; i < N; i++) {
      const id = j * N + i;
      const l = hm[j * N + Math.max(0, i - 1)], r = hm[j * N + Math.min(N - 1, i + 1)];
      const d = hm[jm + i], u = hm[jp + i];
      const nx = -(r - l) / (2 * cell), nz = -(u - d) / (2 * cell);
      const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nrm[id * 4] = (nx * il * 0.5 + 0.5) * 255;
      nrm[id * 4 + 1] = (il * 0.5 + 0.5) * 255;
      nrm[id * 4 + 2] = (nz * il * 0.5 + 0.5) * 255;
      const l2 = hm[j * N + Math.max(0, i - 3)], r2 = hm[j * N + Math.min(N - 1, i + 3)];
      const lap = (l2 + r2 + hm[jm3 + i] + hm[jp3 + i] - 4 * hm[id]) / (9 * cell * cell);
      nrm[id * 4 + 3] = clamp(0.5 + lap * 60, 0, 1) * 255;
    }
  }

  const mk = (data, type, fmt, filter) => {
    const t = new THREE.DataTexture(data, N, N, fmt, type);
    t.magFilter = filter; t.minFilter = filter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  let lavaTex;
  if (floatLinear) {
    lavaTex = mk(lava, THREE.FloatType, THREE.RGBAFormat, THREE.LinearFilter);
  } else {
    const half = new Uint16Array(lava.length);
    for (let k = 0; k < lava.length; k++) half[k] = THREE.DataUtils.toHalfFloat(lava[k]);
    lavaTex = mk(half, THREE.HalfFloatType, THREE.RGBAFormat, THREE.LinearFilter);
  }
  const heatTex = mk(heat, THREE.UnsignedByteType, THREE.RGBAFormat, THREE.LinearFilter);
  const normalTex = mk(nrm, THREE.UnsignedByteType, THREE.RGBAFormat, THREE.LinearFilter);
  const heightTex = mk(hm, THREE.FloatType, THREE.RedFormat, THREE.NearestFilter);
  return { lavaTex, heatTex, normalTex, heightTex };
}

// Points on active lava (for embers and fumes)
export function lavaPoints(flows, sample, count, rnd) {
  const pool = [];
  for (const f of flows) {
    if (!f.active) continue;
    const p = f.pts;
    for (let k = 0; k < p.length; k += 6 * 4) {
      const s = p[k + 2];
      const temp = 0.35 + 0.65 * Math.exp(-s / 3000);
      pool.push([p[k], p[k + 1], p[k + 3], temp, p[k + 4], p[k + 5], s]);
    }
  }
  const out = [];
  const totalW = pool.reduce((a, b) => a + b[3], 0);
  for (let n = 0; n < count; n++) {
    let t = rnd() * totalW, k = 0;
    while (t > pool[k][3] && k < pool.length - 1) { t -= pool[k][3]; k++; }
    const q = pool[k];
    const x = q[0] + (rnd() - 0.5) * q[2] * 1.2, z = q[1] + (rnd() - 0.5) * q[2] * 1.2;
    out.push({ x, y: sample(x, z), z, temp: q[3], w: q[2], dx: q[4], dz: q[5], s: q[6] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terrain mesh: warped grid dense around the volcano, sparse toward the horizon.
export function buildTerrainGeometry(sample, far) {
  const G = V.GRID, n = G + 1;
  const warp = new Float32Array(n);
  for (let i = 0; i < n; i++) warp[i] = warpCoord(-1 + (2 * i) / G);
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const z = warp[j];
    for (let i = 0; i < n; i++) {
      const x = warp[i];
      const k = (j * n + i) * 3;
      const fh = far ? far[j * n + i] : NaN;
      pos[k] = x; pos[k + 1] = Number.isNaN(fh) ? sample(x, z) : fh; pos[k + 2] = z;
    }
  }
  const nor = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
      const a = (j * n + i0) * 3, b = (j * n + i1) * 3, c = (j0 * n + i) * 3, d = (j1 * n + i) * 3;
      const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1];
      const fz = pos[d + 2] - pos[c + 2], fy = pos[d + 1] - pos[c + 1];
      const nx = -fz * ey, ny = fz * ex, nz = -fy * ex;
      const l = Math.hypot(nx, ny, nz) || 1;
      const k = (j * n + i) * 3;
      nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
    }
  }
  const idx = new Uint32Array(G * G * 6);
  let t = 0;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if ((i + j) & 1) { idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d; }
      else { idx[t++] = a; idx[t++] = c; idx[t++] = d; idx[t++] = a; idx[t++] = d; idx[t++] = b; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80000);
  return geo;
}

// ---------------------------------------------------------------------------
// Tileable noise texture (RGBA): R fbm, G low-freq, B cell edges, A cell distance.
export function buildNoiseTexture() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const rnd = mulberry32(99);
  const cellPts = (P) => {
    const pts = new Float32Array(P * P * 2);
    for (let k = 0; k < P * P; k++) { pts[k * 2] = rnd(); pts[k * 2 + 1] = rnd(); }
    return pts;
  };
  const W1 = 8, W2 = 16;
  const p1 = cellPts(W1), p2 = cellPts(W2);
  const worley = (u, v, P, pts) => {
    const x = u * P, y = v * P;
    const cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 9, f2 = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy;
      const wx = ((gx % P) + P) % P, wy = ((gy % P) + P) % P;
      const k = (wy * P + wx) * 2;
      const dx = gx + pts[k] - x, dy = gy + pts[k + 1] - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = i / S, v = j / S;
      let f = 0, a = 0.5, per = 8, n = 0;
      for (let o = 0; o < 5; o++) {
        f += a * pnoise2(u * per + o * 0.37, v * per + o * 0.71, per, per);
        n += a; a *= 0.5; per *= 2;
      }
      f /= n;
      const g = pnoise2(u * 4, v * 4, 4, 4);
      const [a1, a2] = worley(u, v, W1, p1);
      const [b1] = worley(u, v, W2, p2);
      const k = (j * S + i) * 4;
      data[k] = clamp(f * 0.5 + 0.5, 0, 1) * 255;
      data[k + 1] = clamp(g * 0.5 + 0.5, 0, 1) * 255;
      data[k + 2] = clamp((a2 - a1) * 1.6, 0, 1) * 255;
      data[k + 3] = clamp(b1 * 1.1, 0, 1) * 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export function buildRockTexture(data) {
  const S = 512;
  const t = new THREE.DataTexture(data || rockData(S), S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
