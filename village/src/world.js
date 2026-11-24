// World definition: river courses, terrain height function, village layout.
import { RNG, fbm2, ridged2, softRidge2, simplex2, clamp, lerp, smoothstep } from './noise.js';

export const SUN_AZ = (45 * Math.PI) / 180; // west of north
export const SUN_EL = (11 * Math.PI) / 180;
export const SUN_DIR = [
  -Math.sin(SUN_AZ) * Math.cos(SUN_EL),
  Math.sin(SUN_EL),
  -Math.cos(SUN_AZ) * Math.cos(SUN_EL),
];

export const FUJI_AZ = (-5 * Math.PI) / 180;
export const FUJI = { x: -Math.sin(5 * Math.PI / 180) * 3400, z: -20 - Math.cos(5 * Math.PI / 180) * 3400, H: 640, R: 2300 };
export const WATER_Y = 0;
export const UPPER_Y = 12;
export const LAND_Y = 1.35;

// ---------- river polylines ----------
const LOWER_CTRL = [
  [-4, -99, 9], [-3, -90, 10.5], [1, -76, 8], [8, -58, 6.6], [11, -40, 6.6],
  [8, -20, 6.6], [1, -3, 6.6], [-5, 15, 6.6], [-8, 33, 6.6], [-5, 51, 6.6],
  [3, 68, 7], [12, 86, 7.6], [18, 108, 8.2], [22, 140, 9], [27, 190, 10],
  [34, 260, 11], [42, 360, 12], [50, 520, 13], [56, 800, 14],
];
const UPPER_CTRL = [
  [-4, -100.5, 4.2], [-5, -112, 4.5], [-12, -132, 5], [-9, -160, 5.2],
  [2, -195, 5.5], [10, -240, 6], [4, -300, 6], [-10, -380, 6], [-20, -520, 6], [-30, -800, 6],
];

function catmull(ctrl, step) {
  const out = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(n - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const segs = Math.max(2, Math.ceil(len / step));
    for (let s = 0; s < segs; s++) {
      const t = s / segs, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), lerp(p1[2], p2[2], t)]);
    }
  }
  out.push(ctrl[n - 1].slice());
  return out;
}

export const LOWER = catmull(LOWER_CTRL, 1.0); // z increasing
export const UPPER = catmull(UPPER_CTRL, 1.5); // z decreasing

// precompute tangents + cumulative length
function prep(pl) {
  let acc = 0;
  for (let i = 0; i < pl.length; i++) {
    const a = pl[Math.max(0, i - 1)], b = pl[Math.min(pl.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    pl[i].tx = dx / l; pl[i].tz = dz / l;
    if (i > 0) acc += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
    pl[i].s = acc;
  }
}
prep(LOWER); prep(UPPER);

// nearest point on a z-monotonic polyline using binary search + local scan
function nearestOn(pl, x, z, zInc) {
  let lo = 0, hi = pl.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    const pz = pl[m][1];
    if ((zInc && pz < z) || (!zInc && pz > z)) lo = m; else hi = m;
  }
  let best = 1e9, bi = lo, bt = 0;
  const test = (i) => {
    const a = pl[i], b = pl[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez || 1;
    let t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + ex * t, pz = a[1] + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bi = i; bt = t; }
  };
  for (let i = lo; i < pl.length - 1; i++) {
    if (Math.abs(pl[i][1] - z) > best + 2) break;
    test(i);
  }
  for (let i = lo - 1; i >= 0; i--) {
    if (Math.abs(pl[i + 1][1] - z) > best + 2) break;
    test(i);
  }
  const a = pl[bi], b = pl[Math.min(bi + 1, pl.length - 1)];
  return {
    d: best,
    hw: lerp(a[2], b[2], bt),
    x: lerp(a[0], b[0], bt), z: lerp(a[1], b[1], bt),
    tx: lerp(a.tx, b.tx, bt), tz: lerp(a.tz, b.tz, bt),
    s: lerp(a.s, b.s, bt),
  };
}

export function lowerRiver(x, z) { return nearestOn(LOWER, x, z, true); }
export function upperRiver(x, z) { return nearestOn(UPPER, x, z, false); }

export function riverXAt(z) {
  const pl = z > -100 ? LOWER : UPPER;
  const inc = z > -100;
  let lo = 0, hi = pl.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if ((inc && pl[m][1] < z) || (!inc && pl[m][1] > z)) lo = m; else hi = m;
  }
  const a = pl[lo], b = pl[hi];
  const t = clamp((z - a[1]) / (b[1] - a[1] || 1), 0, 1);
  return lerp(a[0], b[0], t);
}
export function riverTangentAt(z) {
  const r = lowerRiver(riverXAt(z), z);
  return [r.tx, r.tz];
}

// cliff line (waterfall escarpment)
export function cliffZ(x) {
  return -99.5 + 2.2 * Math.sin(x * 0.045 + 0.6) + 1.2 * simplex2(x * 0.08, 3.1);
}

// ---------- base height (no layout pads) ----------
function walledness(z) {
  // stone embankment walls in the village core
  return smoothstep(-74, -66, z) * (1 - smoothstep(60, 68, z));
}

export function baseHeight(x, z) {
  const rx = riverXAt(clamp(z, -790, 790));
  const dx = x - rx;
  // gentle village land
  let h = LAND_Y + 0.35 * fbm2(x * 0.018, z * 0.018, 3) + 0.12 * simplex2(x * 0.09, z * 0.09);

  // valley sides: east hills start sooner than west
  const east = smoothstep(44, 125, dx);
  const west = smoothstep(62, 150, -dx);
  const hillN = fbm2(x * 0.0065 + 11, z * 0.0065 - 7, 5);
  const hillR = Math.pow(softRidge2(x * 0.004 + 3, z * 0.004 + 9, 4), 2.0);
  h += east * (26 + 22 * hillN + 30 * hillR) + west * (22 + 20 * hillN + 34 * hillR);

  // north: plateau above the waterfall
  const cz = cliffZ(x);
  const plateau = smoothstep(cz + 1.6, cz - 1.8, z);
  h += plateau * (UPPER_Y - LAND_Y + 1.2 + 0.6 * simplex2(x * 0.05, z * 0.05));

  // big distant mountains
  const r = Math.hypot(x, z + 20);
  const big = smoothstep(380, 1100, r);
  if (big > 0) {
    const ang = Math.atan2(x, -(z + 20)); // 0 = north, negative = west
    const adiff = (a0) => { let d = Math.abs(ang - a0); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
    const sunGap = 1 - 0.62 * (1 - smoothstep(0.1, 0.55, adiff(-SUN_AZ)));
    const fujiGap = 1 - 0.78 * (1 - smoothstep(0.08, 0.42, adiff(FUJI_AZ)));
    const gap = Math.min(sunGap, fujiGap);
    const south = 1 - 0.55 * smoothstep(0.5, 1, Math.cos(ang - Math.PI) );
    h += big * gap * south * (50 + 230 * Math.pow(softRidge2(x * 0.00085 - 5, z * 0.00085 + 2, 4), 2.0) + 45 * fbm2(x * 0.0022, z * 0.0022, 3));
  }

  // river carving
  if (z > cz - 1) {
    const R = lowerRiver(x, z);
    if (R.d < R.hw + 8) {
      const w = walledness(z);
      const bed = -1.55 + 0.35 * simplex2(x * 0.15, z * 0.15) + 0.3 * smoothstep(0, R.hw, R.d) ;
      // natural sloping bank vs steep walled bank
      const bankIn = lerp(R.hw - 3.5, R.hw - 0.9, w);
      const bankOut = lerp(R.hw + 4.5, R.hw + 0.35, w);
      const k = smoothstep(bankIn, bankOut, R.d);
      const shaped = lerp(bed, h, w > 0.5 ? k : Math.pow(k, 0.8));
      h = shaped;
    }
  }
  if (z < cz + 3) {
    const U = upperRiver(x, z);
    if (U.d < U.hw + 6) {
      const k = smoothstep(U.hw - 1.5, U.hw + 4, U.d);
      const bedU = UPPER_Y - 1.4 + 0.25 * simplex2(x * 0.2, z * 0.2);
      const hh = lerp(bedU, h, k);
      // blend only on plateau side
      const pm = smoothstep(cz + 2.5, cz - 0.5, z);
      h = lerp(h, Math.min(h, hh), pm);
    }
  }
  return h;
}

// ---------- layout ----------
export const layout = {
  houses: [], pads: [], sakura: [], weeping: [], pines: [], maples: [], greenTrees: [],
  stoneLanterns: [], hangingLanterns: [], torii: [], bridges: [], rocks: [],
  temple: null, pagoda: null, shrine: null, gate: null, bell: null,
  pond: null, paths: [], keep: [], fences: [], benches: [],
  steppingStones: [], toriiPath: null, boats: [], teahouse: null,
};

function addPad(p) { layout.pads.push(p); }
function rectPad(x, z, w, d, rot, h, blend = 2.5) { addPad({ type: 'rect', x, z, w, d, rot, h, blend }); }

const rng = new RNG(20261124);

function inKeep(x, z, r) {
  for (const k of layout.keep) if (Math.hypot(x - k.x, z - k.z) < k.r + r) return true;
  return false;
}

function buildLayout() {
  // ---- temple precinct (raised terrace, west/north) ----
  const TT = { x: -52, z: -52, w: 46, d: 52, h: 4.2 };
  layout.terrace = TT;
  rectPad(TT.x, TT.z, TT.w, TT.d, 0, TT.h, 1.2);
  layout.temple = { x: -60, z: -60, rot: Math.PI / 2, w: 19, d: 15, y: TT.h };
  layout.pagoda = { x: -38, z: -36, y: TT.h };
  layout.bell = { x: -38, z: -71, y: TT.h };
  layout.gate = { x: -30.5, z: -46, rot: Math.PI / 2, y: TT.h };
  layout.keep.push({ x: TT.x, z: TT.z, r: 34 });
  // steps from terrace down toward the river
  layout.steps = { x0: -29, x1: -22, z: -46, w: 6, hTop: TT.h, hBot: LAND_Y + 0.15 };
  rectPad(-24.5, -46, 7, 8, 0, LAND_Y + 0.1, 2);

  // ---- arched bridge + approach ----
  const zb = -40, rxb = riverXAt(zb);
  layout.bridges.push({ type: 'arch', x: rxb, z: zb, len: 22, w: 3.2, rot: 0, rise: 2.6 });
  layout.keep.push({ x: rxb + 14, z: zb, r: 6 }, { x: rxb - 14, z: zb, r: 6 });
  layout.torii.push({ x: -12, z: -42.5, rot: Math.PI / 2, s: 1.25, big: true });
  layout.paths.push({ pts: [[rxb - 11, zb], [-12, -42.5], [-22, -46]], w: 3.4, kind: 'stone' });
  for (let i = 0; i < 4; i++) {
    const x = -4 - i * 5.0;
    const t = (x - (rxb - 11)) / (-22 - (rxb - 11));
    const z = lerp(zb, -46, Math.max(0, t));
    layout.stoneLanterns.push({ x, z: z - 2.8, s: 1 }, { x, z: z + 2.8, s: 1 });
  }

  // ---- flat wooden bridge ----
  const zf = 33, rxf = riverXAt(zf);
  layout.bridges.push({ type: 'flat', x: rxf, z: zf, len: 20, w: 2.6, rot: 0 });
  layout.keep.push({ x: rxf + 13, z: zf, r: 5.5 }, { x: rxf - 13, z: zf, r: 5.5 });
  // small plank bridge downstream
  const zs = 64, rxs = riverXAt(zs);
  layout.bridges.push({ type: 'plank', x: rxs, z: zs, len: 19, w: 1.8, rot: -0.35 });
  layout.keep.push({ x: rxs + 12, z: zs - 4, r: 4.5 }, { x: rxs - 12, z: zs + 4, r: 4.5 });

  // ---- teahouse at east end of arched bridge ----
  layout.teahouse = { x: rxb + 21, z: zb - 9, rot: -Math.PI / 2 + 0.1 };
  layout.keep.push({ x: rxb + 21, z: zb - 9, r: 6 });

  // ---- torii path up the east hill to a shrine ----
  const tp = [[44, 10], [54, 6.5], [64, 2], [73, -3.5], [81, -9]];
  layout.toriiPath = { pts: tp };
  layout.keep.push({ x: 46, z: 10, r: 7 });
  layout.shrine = { x: 89, z: -14.5, rot: -Math.PI / 2 - 0.55 };

  // ---- pond garden ----
  layout.pond = { x: -40, z: -11, rx: 10, rz: 6.5, rot: 0.3 };
  layout.keep.push({ x: -40, z: -11, r: 13 });

  // ---- houses ----
  const rows = [
    { off: 19.5, z0: -68, z1: 72, side: 1, types: ['machiya', 'machiya', 'riverside', 'riverside', 'machiya'] },
    { off: 42, z0: -60, z1: 68, side: 1, types: ['machiya', 'minka', 'kura', 'machiya'] },
    { off: -19.5, z0: 6, z1: 74, side: -1, types: ['machiya', 'riverside', 'machiya', 'riverside'] },
    { off: -42, z0: 10, z1: 70, side: -1, types: ['minka', 'machiya', 'kura', 'machiya'] },
  ];
  for (const row of rows) {
    let z = row.z0;
    let prevHalf = 0;
    while (z < row.z1) {
      const type = rng.pick(row.types);
      const dims = houseDims(type);
      z += prevHalf + dims.w / 2 + rng.range(1.6, 3.6);
      if (z > row.z1) break;
      const rx = riverXAt(z);
      const [tx, tz] = riverTangentAt(z);
      const fx = row.side > 0 ? -tz : tz, fz = row.side > 0 ? tx : -tx;
      const rot = Math.atan2(fx, fz);
      const x = rx + row.off + (row.side > 0 ? dims.d / 2 - 5 : -(dims.d / 2 - 5));
      if (inKeep(x, z, Math.max(dims.w, dims.d) * 0.45)) { prevHalf = 3; continue; }
      if (row.side > 0 && row.off > 30 && z > 1 && z < 19) { prevHalf = 3; continue; }
      addHouse(type, x, z, rot, dims);
      prevHalf = dims.w / 2;
    }
  }
  // farmhouses further west / south
  const farms = [[-74, 22, 0.4], [-70, 48, -0.2], [-82, -6, 0.9], [-60, 70, 0.1], [-88, 34, 0.6]];
  for (const [x, z, r] of farms) {
    const type = rng.chance(0.35) ? 'kura' : 'minka';
    const dims = houseDims(type);
    addHouse(type, x, z, Math.PI / 2 + r, dims);
  }
  // a few houses on north-east near the bamboo
  const ne = [[36, -76, -1.4], [52, -60, -1.7], [28, -86, -1.2]];
  for (const [x, z, r] of ne) {
    const dims = houseDims('minka');
    if (!inKeep(x, z, 6)) addHouse('minka', x, z, r, dims);
  }

  // ---- sakura ----
  const sak = [];
  for (const side of [1, -1]) {
    for (let z = -66; z <= 74; z += rng.range(10, 13.5)) {
      const rx = riverXAt(z);
      const x = rx + side * (11.2 + rng.range(-0.6, 0.8));
      if (side < 0 && z < -10 && z > -75) { /* temple bank: fewer, wilder */ if (rng.chance(0.45)) continue; }
      let skip = false;
      for (const b of layout.bridges) if (Math.abs(z - b.z) < 5.5) skip = true;
      if (skip) continue;
      sak.push({ x, z, s: rng.range(0.85, 1.15), seed: rng.int(1, 1e6), tint: rng.range(0, 1) });
    }
  }
  // around temple + garden + scattered
  const extra = [
    [-30, -30, 1.15], [-46, -74, 1.0], [-70, -40, 1.1], [-28, -66, 0.95], [-52, -12, 1.0],
    [-30, -4, 0.9], [34, -54, 1.05], [30, -24, 0.9], [36, 14, 1.0], [58, 22, 1.2],
    [62, -14, 1.1], [-22, 82, 1.1], [28, 86, 1.0], [-56, 52, 1.05], [-84, 10, 1.1],
    [-12, -86, 1.05], [14, -88, 1.0], [-20, -78, 0.95], [-62, 28, 0.9], [74, 12, 1.1],
    [50, -36, 0.95], [-80, -60, 1.1],
  ];
  for (const [x, z, s] of extra) sak.push({ x, z, s, seed: rng.int(1, 1e6), tint: rng.range(0, 1) });
  layout.sakura = sak.filter((t) => !treeBlocked(t.x, t.z, 2.2));
  layout.weeping = [
    { x: -42, z: -58, s: 1.1, seed: 77 },
    { x: -33, z: -20, s: 1.0, seed: 91 },
    { x: 26, z: -32, s: 0.95, seed: 133 },
  ];
  layout.pines = [
    { x: -27, z: -58, s: 1.0, seed: 5 }, { x: -48, z: -4, s: 1.1, seed: 6 },
    { x: -66, z: -76, s: 1.2, seed: 7 }, { x: -2, z: -78, s: 0.9, seed: 8 },
    { x: 24, z: 44, s: 0.95, seed: 9 }, { x: -35, z: -28, s: 0.8, seed: 10 },
  ].filter((t) => !treeBlocked(t.x, t.z, 1.5));
  layout.maples = [
    [-50, -20, 0.9, 1], [-31, -11, 0.7, 1], [-62, -32, 1.0, 0], [40, -40, 0.9, 1],
    [-14, 46, 0.8, 0], [18, 20, 0.8, 1], [-70, 14, 1.0, 0], [66, -30, 1.0, 1], [-24, -86, 0.9, 1],
  ].map(([x, z, s, red]) => ({ x, z, s, red, seed: rng.int(1, 1e6) })).filter((t) => !treeBlocked(t.x, t.z, 1.5));

  // stone lanterns along promenades and pond
  for (const side of [1, -1]) {
    for (let z = -58; z <= 66; z += 24) {
      const rx = riverXAt(z);
      const x = rx + side * 9.4;
      let skip = false;
      for (const b of layout.bridges) if (Math.abs(z - b.z) < 4) skip = true;
      if (!skip && !(side < 0 && z < -10)) layout.stoneLanterns.push({ x, z, s: 0.85 });
    }
  }
  layout.stoneLanterns.push({ x: -31, z: -16, s: 1.1, kind: 'yukimi' }, { x: -48, z: -4.5, s: 0.9 });
  // on terrace in front of hall
  layout.stoneLanterns.push({ x: -49, z: -55.5, s: 1.3, terrace: true }, { x: -49, z: -64.5, s: 1.3, terrace: true });
  layout.stoneLanterns.push({ x: -36, z: -49.5, s: 1.0, terrace: true }, { x: -36, z: -42.5, s: 1.0, terrace: true });

  // stepping stones across the waterfall pool
  for (let i = 0; i < 11; i++) {
    const t = i / 10;
    const x = lerp(-11.5, 11.5, t) + Math.sin(i * 1.7) * 0.4;
    const z = -79.5 + Math.sin(t * Math.PI) * 1.8 + Math.cos(i * 2.3) * 0.3;
    layout.steppingStones.push({ x, z, r: 0.75 + 0.15 * Math.sin(i * 3.1), rot: i * 1.3 });
  }
  // boats moored on the river
  layout.boats.push({ x: riverXAt(8) + 4.2, z: 8, rot: 0.12 }, { x: riverXAt(48) - 4.0, z: 48, rot: -0.08 });

  // keep pond and paths free of grass etc. handled by mask
}

function treeBlocked(x, z, r) {
  for (const h of layout.houses) {
    const dx = x - h.x, dz = z - h.z;
    const c = Math.cos(-h.rot), s = Math.sin(-h.rot);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    if (Math.abs(lx) < h.w / 2 + r && Math.abs(lz) < h.d / 2 + r) return true;
  }
  const T = layout.terrace;
  if (Math.abs(x - T.x) < T.w / 2 - 1 && Math.abs(z - T.z) < T.d / 2 - 1) {
    // inside terrace: avoid buildings
    if (Math.hypot(x - layout.pagoda.x, z - layout.pagoda.z) < 7) return true;
    if (Math.abs(x - layout.temple.x) < 11 && Math.abs(z - layout.temple.z) < 12) return true;
  }
  return false;
}

function houseDims(type) {
  switch (type) {
    case 'machiya': return { w: rng.range(6.2, 7.8), d: rng.range(9, 11.5), stories: 2 };
    case 'riverside': return { w: rng.range(8, 10), d: rng.range(8, 9.5), stories: 2 };
    case 'minka': return { w: rng.range(11, 14), d: rng.range(8, 9.5), stories: 1 };
    case 'kura': return { w: rng.range(5, 6.2), d: rng.range(6.5, 8), stories: 2 };
    default: return { w: 8, d: 8, stories: 1 };
  }
}

function addHouse(type, x, z, rot, dims) {
  const y = Math.max(LAND_Y, baseHeight(x, z));
  layout.houses.push({ type, x, z, rot, w: dims.w, d: dims.d, stories: dims.stories, y, seed: rng.int(1, 1e9) });
  rectPad(x, z, dims.w + 1.6, dims.d + 1.6, rot, y, 2.5);
}

buildLayout();

// ---------- final height with pads ----------
export function height(x, z) {
  let h = baseHeight(x, z);
  for (const p of layout.pads) {
    const dx = x - p.x, dz = z - p.z;
    if (Math.abs(dx) > p.w + p.d + p.blend && Math.abs(dz) > p.w + p.d + p.blend) continue;
    const c = Math.cos(-p.rot), s = Math.sin(-p.rot);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const ox = Math.abs(lx) - p.w / 2, oz = Math.abs(lz) - p.d / 2;
    const sd = Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
    if (sd > p.blend) continue;
    const m = 1 - smoothstep(0, p.blend, sd);
    h = lerp(h, p.h, m);
  }
  // terrace stone walls are vertical-ish: sharpen
  // torii path ramp
  const tp = layout.toriiPath.pts;
  const tr = pathRamp(x, z);
  if (tr) h = lerp(h, tr.h, tr.m);
  // pond carve
  const P = layout.pond;
  {
    const dx = x - P.x, dz = z - P.z;
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const e = Math.hypot(lx / P.rx, lz / P.rz) + 0.12 * simplex2(x * 0.3, z * 0.3);
    if (e < 1.5) {
      const k = smoothstep(0.55, 1.12, e);
      h = lerp(-0.9, h, k);
    }
  }
  return h;
}

// torii path: ramp following the polyline, heights interpolated from base terrain at ends
let rampCache = null;
function pathRamp(x, z) {
  if (!rampCache) {
    const pts = layout.toriiPath.pts;
    const hs = pts.map(([px, pz]) => baseHeight(px, pz));
    // monotonic smooth ramp
    const h0 = Math.max(LAND_Y, hs[0]);
    const h1 = Math.max(h0 + 4, hs[hs.length - 1] + 0.5);
    let total = 0; const cum = [0];
    for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(total); }
    rampCache = { pts, cum, total, h0, h1 };
    layout.toriiPath.h0 = h0; layout.toriiPath.h1 = h1; layout.toriiPath.total = total; layout.toriiPath.cum = cum;
  }
  const { pts, cum, total, h0, h1 } = rampCache;
  if (x < pts[0][0] - 10 || x > pts[pts.length - 1][0] + 14) return null;
  let best = 1e9, bs = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    let t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2; t = clamp(t, 0, 1);
    const d = Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
    if (d < best) { best = d; bs = cum[i] + t * Math.sqrt(l2); }
  }
  // shrine plateau at end
  const S = layout.shrine;
  const ds = Math.hypot(x - S.x, z - S.z);
  const u = bs / total;
  let h = lerp(h0, h1, u * u * (3 - 2 * u) * 0.35 + u * 0.65);
  let m = 1 - smoothstep(2.4, 6.5, best);
  if (ds < 18) { const ms = 1 - smoothstep(6.5, 17, ds); if (ms > m) { m = ms; h = h1; } }
  if (m <= 0) return null;
  return { h, m };
}
export function toriiPathHeight(s) {
  pathRamp(0, 0);
  const { total, h0, h1 } = rampCache;
  const u = clamp(s / total, 0, 1);
  return lerp(h0, h1, u * u * (3 - 2 * u) * 0.35 + u * 0.65);
}

// ---------- cached heightfield for fast queries ----------
export const HF = { x0: -260, z0: -300, size: 1, nx: 521, nz: 621, data: null };
export function buildHeightfield() {
  const { x0, z0, size, nx, nz } = HF;
  const d = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) d[j * nx + i] = height(x0 + i * size, z0 + j * size);
  HF.data = d;
}
export function hAt(x, z) {
  const { x0, z0, size, nx, nz, data } = HF;
  const fx = (x - x0) / size, fz = (z - z0) / size;
  if (fx < 0 || fz < 0 || fx >= nx - 1 || fz >= nz - 1) return height(x, z);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = data[j * nx + i], b = data[j * nx + i + 1], c = data[(j + 1) * nx + i], e = data[(j + 1) * nx + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
}
export function waterAt(x, z) {
  // returns water surface height or null
  const cz = cliffZ(x);
  const h = hAt(x, z);
  if (z > cz) return h < WATER_Y - 0.02 ? WATER_Y : null;
  return h < UPPER_Y - 0.02 ? UPPER_Y : null;
}
export function flowAt(x, z) {
  const cz = cliffZ(x);
  if (z > cz) {
    // pond: still
    const P = layout.pond;
    if (Math.hypot(x - P.x, z - P.z) < 14) return [0.05 * Math.sin(z), 0.05 * Math.cos(x)];
    const R = lowerRiver(x, z);
    const sp = R.s < 30 ? 1.6 : 1.05;
    const edge = clamp(1 - Math.pow(R.d / (R.hw + 0.01), 2), 0.15, 1);
    return [R.tx * sp * edge, R.tz * sp * edge];
  }
  const U = upperRiver(x, z);
  // upper flows towards the cliff (reverse of polyline direction)
  return [-U.tx * 1.4, -U.tz * 1.4];
}
