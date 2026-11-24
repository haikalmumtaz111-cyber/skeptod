// Geometry helpers: metric-UV primitives, a merge-by-material builder, tubes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export function M(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}
export function mul(a, b) { return new THREE.Matrix4().multiplyMatrices(a, b); }

// Box with UV in meters; V runs along the longer side of each face (wood grain).
const boxCache = new Map();
export function box(w, h, d) {
  const key = `${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}`;
  let g = boxCache.get(key);
  if (g) return g;
  g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // face order: px, nx, py, ny, pz, nz ; dims (u,v): (d,h),(d,h),(w,d),(w,d),(w,h),(w,h)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f];
    const swap = du > dv;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      const u = uv.getX(i), v = uv.getY(i);
      if (swap) uv.setXY(i, v * dv, u * du); else uv.setXY(i, u * du, v * dv);
    }
  }
  boxCache.set(key, g);
  return g;
}

export function cyl(rt, rb, h, seg = 8, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rt + rb);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  return g;
}

export function lathe(points, seg = 12) {
  const g = new THREE.LatheGeometry(points.map((p) => new THREE.Vector2(p[0], p[1])), seg);
  return g;
}

export function quad(w, h) {
  return new THREE.PlaneGeometry(w, h);
}

// Builder: accumulates transformed geometries per material key, then merges.
export class Builder {
  constructor() { this.parts = new Map(); }
  add(key, geo, matrix, color = [1, 1, 1], extra = null) {
    const g = geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = color[0]; col[i * 3 + 1] = color[1]; col[i * 3 + 2] = color[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.index) {
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    for (const k of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color', 'aWind'].includes(k)) g.deleteAttribute(k);
    }
    if (extra && extra.wind) {
      const w = new Float32Array(n * 2);
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const r = extra.wind(pos.getX(i), pos.getY(i), pos.getZ(i));
        w[i * 2] = r[0]; w[i * 2 + 1] = r[1];
      }
      g.setAttribute('aWind', new THREE.BufferAttribute(w, 2));
    }
    let arr = this.parts.get(key);
    if (!arr) { arr = []; this.parts.set(key, arr); }
    arr.push(g);
    return g;
  }
  merge() {
    const out = new Map();
    for (const [k, arr] of this.parts) {
      // ensure consistent attribute sets
      const hasWind = arr.some((g) => g.attributes.aWind);
      if (hasWind) {
        for (const g of arr) if (!g.attributes.aWind) g.setAttribute('aWind', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      for (const g of arr) if (g.index.array instanceof Uint16Array) g.setIndex(new THREE.BufferAttribute(new Uint32Array(g.index.array), 1));
      const m = mergeGeometries(arr, false);
      m.computeBoundingSphere();
      out.set(k, m);
    }
    return out;
  }
}

// Box spanning two points (length along the segment); width horizontal, height ~vertical.
const _up = new THREE.Vector3(0, 1, 0);
export function segMatrix(p0, p1, up = _up) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  const m = new THREE.Matrix4().lookAt(a, b, up);
  m.setPosition(mid);
  return { m, len };
}

// Generalized tube along a polyline with per-point radius.
export function tube(points, radii, radial = 7, uvScale = 1) {
  const n = points.length;
  const pos = [], nor = [], uv = [], idx = [];
  const T = [], N = [], B = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // initial normal
  let nrm = new THREE.Vector3(0, 0, 1);
  if (Math.abs(T[0].dot(nrm)) > 0.9) nrm.set(1, 0, 0);
  nrm = new THREE.Vector3().crossVectors(T[0], nrm).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(T[i - 1], T[i]);
      const s = axis.length();
      if (s > 1e-6) {
        axis.normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(T[i - 1].dot(T[i]), -1, 1));
        nrm.applyAxisAngle(axis, ang);
      }
    }
    N.push(nrm.clone());
    B.push(new THREE.Vector3().crossVectors(T[i], nrm).normalize());
  }
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) len += points[i].distanceTo(points[i - 1]);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const dx = N[i].x * c + B[i].x * s, dy = N[i].y * c + B[i].y * s, dz = N[i].z * c + B[i].z * s;
      const r = radii[i];
      pos.push(points[i].x + dx * r, points[i].y + dy * r, points[i].z + dz * r);
      nor.push(dx, dy, dz);
      uv.push((j / radial) * 2 * Math.PI * Math.max(r, 0.05) * uvScale, len * uvScale);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Grid surface from a parametric function f(s,t)->[x,y,z,u,v]
export function paramSurface(ns, nt, f, flip = false) {
  const pos = new Float32Array((ns + 1) * (nt + 1) * 3);
  const uv = new Float32Array((ns + 1) * (nt + 1) * 2);
  let k = 0, q = 0;
  for (let j = 0; j <= nt; j++) {
    for (let i = 0; i <= ns; i++) {
      const r = f(i / ns, j / nt);
      pos[k++] = r[0]; pos[k++] = r[1]; pos[k++] = r[2];
      uv[q++] = r[3] || 0; uv[q++] = r[4] || 0;
    }
  }
  const idx = [];
  for (let j = 0; j < nt; j++) for (let i = 0; i < ns; i++) {
    const a = j * (ns + 1) + i, b = a + 1, c = a + ns + 1, d = c + 1;
    if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Simple polygon (convex fan) in a plane given 3D points
export function fan(points, normal) {
  const pos = [], nor = [], uv = [], idx = [];
  for (const p of points) { pos.push(p[0], p[1], p[2]); nor.push(normal[0], normal[1], normal[2]); uv.push(p[3] || 0, p[4] || 0); }
  // auto-orient winding to match the requested normal
  const a = points[0], b = points[1], c = points[2];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const flip = cx * normal[0] + cy * normal[1] + cz * normal[2] < 0;
  for (let i = 1; i < points.length - 1; i++) { if (flip) idx.push(0, i + 1, i); else idx.push(0, i, i + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function srgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
export function scaleC(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
export function mixC(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
