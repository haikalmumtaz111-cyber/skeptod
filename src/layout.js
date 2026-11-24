import * as THREE from 'three';

export const BLOCK = 84;
export const STREET = 30;
export const PITCH = BLOCK + STREET; // 114
export const SIDEWALK = 4.5;
export const ROAD_HALF = STREET / 2 - SIDEWALK; // 10.5
export const CURB_H = 0.16;
export const GRID = { i0: -4, i1: 3, j0: -7, j1: 3 };

export function blockRect(i, j) {
  return { x0: i * PITCH + STREET / 2, x1: (i + 1) * PITCH - STREET / 2, z0: j * PITCH + STREET / 2, z1: (j + 1) * PITCH - STREET / 2 };
}

// Camera loop ---------------------------------------------------------------
function cornerPts(cx, cy, cz, din, dout, R, out, n = 6) {
  const sx = cx - din[0] * R, sz = cz - din[1] * R;
  const ex = cx + dout[0] * R, ez = cz + dout[1] * R;
  for (let i = 0; i <= n; i++) {
    const t = i / n; const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.push(new THREE.Vector3(a * sx + b * cx + c * ex, cy, a * sz + b * cz + c * ez));
  }
}

export function buildCameraPath() {
  const P = [];
  const v = (x, y, z) => P.push(new THREE.Vector3(x, y, z));
  // Segment A: avenue x=0 heading -z, street level
  v(0.5, 15, 86); v(-1.5, 8.5, 62); v(-2.2, 5.6, 34); v(-1.0, 4.8, 2); v(1.6, 4.6, -36); v(2.4, 5.0, -72);
  v(0.8, 5.4, -100); v(-1.8, 5.2, -128); v(-2.4, 6.2, -158); v(-0.6, 9.5, -190); v(1.4, 16, -222);
  v(1.6, 24, -256); v(0.4, 32, -292); v(0, 37, -318);
  cornerPts(0, 40, -PITCH * 3, [0, -1], [1, 0], 11, P, 5);
  // Segment B: cross street z=-342 heading +x
  v(36, 45, -342.5); v(62, 49, -341); v(88, 53, -342.5);
  cornerPts(PITCH, 56, -PITCH * 3, [1, 0], [0, 1], 11, P, 5);
  // Segment C: avenue x=114 heading +z, climbing high then descending
  v(114.5, 64, -310); v(113, 80, -272); v(115.5, 96, -232); v(114, 108, -192); v(112.5, 111, -152);
  v(114.5, 102, -112); v(116, 84, -72); v(114, 64, -32); v(112, 48, 8); v(113.5, 38, 46); v(114, 31, 82);
  cornerPts(PITCH, 28, PITCH, [0, 1], [-1, 0], 11, P, 5);
  // Segment D: cross street z=114 heading -x
  v(84, 26, 114.5); v(56, 24, 113); v(28, 21, 114.5);
  cornerPts(0, 19, PITCH, [-1, 0], [0, -1], 11, P, 5);
  // remove points too close to each other
  const Q = [];
  for (const p of P) { if (!Q.length || Q[Q.length - 1].distanceTo(p) > 2.5) Q.push(p); }
  if (Q[0].distanceTo(Q[Q.length - 1]) < 2.5) Q.pop();
  const curve = new THREE.CatmullRomCurve3(Q, true, 'centripetal');
  curve.arcLengthDivisions = 4000;
  const length = curve.getLength();
  const samples = curve.getSpacedPoints(Math.ceil(length / 3));
  return { curve, length, samples };
}

// Minimum distance from point to sampled camera path
export function pathDistance(samples, x, y, z) {
  let best = 1e9;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]; const dx = s.x - x, dy = s.y - y, dz = s.z - z;
    const d = dx * dx + dy * dy + dz * dz; if (d < best) best = d;
  }
  return Math.sqrt(best);
}
export function pathDistanceXZ(samples, x, z) {
  let best = 1e9;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]; const dx = s.x - x, dz = s.z - z;
    const d = dx * dx + dz * dz; if (d < best) best = d;
  }
  return Math.sqrt(best);
}
// path height near xz (closest sample)
export function pathNearest(samples, x, z) {
  let best = 1e9, bi = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]; const dx = s.x - x, dz = s.z - z;
    const d = dx * dx + dz * dz; if (d < best) { best = d; bi = i; }
  }
  return { d: Math.sqrt(best), p: samples[bi] };
}
