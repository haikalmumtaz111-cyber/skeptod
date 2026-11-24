// Deterministic RNG + fast gradient noise used for terrain generation on the CPU.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERM = new Uint8Array(1024);
const GX = new Float32Array(256);
const GY = new Float32Array(256);
const G3X = new Float32Array(256);
const G3Y = new Float32Array(256);
const G3Z = new Float32Array(256);

(function init() {
  const rnd = mulberry32(1337);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 1024; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    GX[i] = Math.cos(a); GY[i] = Math.sin(a);
    // random unit vectors for 3D
    const z = rnd() * 2 - 1, phi = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    G3X[i] = s * Math.cos(phi); G3Y[i] = s * Math.sin(phi); G3Z[i] = z;
  }
})();

// 2D gradient noise, roughly in [-1, 1]
export function noise2(x, y) {
  const fx = Math.floor(x), fy = Math.floor(y);
  const xf = x - fx, yf = y - fy;
  const xi = fx & 255, yi = fy & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = PERM[xi] + yi, b = PERM[xi + 1] + yi;
  const aa = PERM[a], ab = PERM[a + 1], ba = PERM[b], bb = PERM[b + 1];
  const n00 = GX[aa] * xf + GY[aa] * yf;
  const n10 = GX[ba] * (xf - 1) + GY[ba] * yf;
  const n01 = GX[ab] * xf + GY[ab] * (yf - 1);
  const n11 = GX[bb] * (xf - 1) + GY[bb] * (yf - 1);
  const x1 = n00 + (n10 - n00) * u;
  const x2 = n01 + (n11 - n01) * u;
  return (x1 + (x2 - x1) * v) * 1.414;
}

// periodic 2D gradient noise (period px, py in lattice units)
export function pnoise2(x, y, px, py) {
  const fx = Math.floor(x), fy = Math.floor(y);
  const xf = x - fx, yf = y - fy;
  const x0 = ((fx % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((fy % py) + py) % py, y1 = (y0 + 1) % py;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const aa = PERM[PERM[x0] + y0], ab = PERM[PERM[x0] + y1];
  const ba = PERM[PERM[x1] + y0], bb = PERM[PERM[x1] + y1];
  const n00 = GX[aa] * xf + GY[aa] * yf;
  const n10 = GX[ba] * (xf - 1) + GY[ba] * yf;
  const n01 = GX[ab] * xf + GY[ab] * (yf - 1);
  const n11 = GX[bb] * (xf - 1) + GY[bb] * (yf - 1);
  const a1 = n00 + (n10 - n00) * u;
  const a2 = n01 + (n11 - n01) * u;
  return (a1 + (a2 - a1) * v) * 1.414;
}

// 3D gradient noise, roughly in [-1, 1]
export function noise3(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const xf = x - fx, yf = y - fy, zf = z - fz;
  const xi = fx & 255, yi = fy & 255, zi = fz & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const A = PERM[xi] + yi, B = PERM[xi + 1] + yi;
  const AA = PERM[A] + zi, AB = PERM[A + 1] + zi, BA = PERM[B] + zi, BB = PERM[B + 1] + zi;
  let h;
  h = PERM[AA]; const n000 = G3X[h] * xf + G3Y[h] * yf + G3Z[h] * zf;
  h = PERM[BA]; const n100 = G3X[h] * (xf - 1) + G3Y[h] * yf + G3Z[h] * zf;
  h = PERM[AB]; const n010 = G3X[h] * xf + G3Y[h] * (yf - 1) + G3Z[h] * zf;
  h = PERM[BB]; const n110 = G3X[h] * (xf - 1) + G3Y[h] * (yf - 1) + G3Z[h] * zf;
  h = PERM[AA + 1]; const n001 = G3X[h] * xf + G3Y[h] * yf + G3Z[h] * (zf - 1);
  h = PERM[BA + 1]; const n101 = G3X[h] * (xf - 1) + G3Y[h] * yf + G3Z[h] * (zf - 1);
  h = PERM[AB + 1]; const n011 = G3X[h] * xf + G3Y[h] * (yf - 1) + G3Z[h] * (zf - 1);
  h = PERM[BB + 1]; const n111 = G3X[h] * (xf - 1) + G3Y[h] * (yf - 1) + G3Z[h] * (zf - 1);
  const x00 = n000 + (n100 - n000) * u, x10 = n010 + (n110 - n010) * u;
  const x01 = n001 + (n101 - n001) * u, x11 = n011 + (n111 - n011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 1.6;
}

export function fbm2(x, y, oct) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise2(x * f + i * 17.13, y * f - i * 9.71);
    n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}

// ridged multifractal in [0, 1]
export function ridged2(x, y, oct) {
  let s = 0, a = 0.5, f = 1, w = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    let r = 1 - Math.abs(noise2(x * f + i * 31.7, y * f + i * 11.3));
    r *= r;
    s += r * a * w;
    n += a;
    w = Math.min(1, Math.max(0, r * 1.6));
    a *= 0.5; f *= 2.1;
  }
  return s / n;
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }

export function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// integer hash -> [0,1)
export function hash1(n) {
  let x = Math.imul((n | 0) ^ 0x27d4eb2d, 0x165667b1);
  x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
