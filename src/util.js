import * as THREE from 'three';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed) { this.r = mulberry32(seed | 0); }
  f() { return this.r(); }
  range(a, b) { return a + (b - a) * this.r(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this.r()); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  chance(p) { return this.r() < p; }
  sign() { return this.r() < 0.5 ? -1 : 1; }
  weighted(items) { // [[value, weight], ...]
    let tot = 0; for (const it of items) tot += it[1];
    let x = this.r() * tot;
    for (const it of items) { x -= it[1]; if (x <= 0) return it[0]; }
    return items[items.length - 1][0];
  }
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Geometry accumulator. Keeps a "current state" for custom attributes that is
 * written with each vertex, and an optional transform matrix.
 */
export class Geo {
  constructor(attrs = {}) {
    this.attrDefs = attrs; // name -> itemSize
    this.pos = []; this.nor = []; this.uv = []; this.idx = [];
    this.extra = {};
    this.state = {};
    for (const k in attrs) { this.extra[k] = []; this.state[k] = new Array(attrs[k]).fill(0); }
    this.matrix = null; this.nmatrix = null; this.flip = false;
    this.count = 0;
  }
  set(name, ...vals) { const s = this.state[name]; for (let i = 0; i < s.length; i++) s[i] = vals[i] ?? 0; return this; }
  setColor(c) { const s = this.state.color; s[0] = c.r; s[1] = c.g; s[2] = c.b; return this; }
  setMatrix(m) {
    if (!m) { this.matrix = null; this.nmatrix = null; this.flip = false; return this; }
    this.matrix = m.clone(); this.nmatrix = new THREE.Matrix3().getNormalMatrix(m); this.flip = m.determinant() < 0; return this;
  }
  vertex(x, y, z, nx, ny, nz, u, v) {
    if (this.matrix) {
      _v.set(x, y, z).applyMatrix4(this.matrix); x = _v.x; y = _v.y; z = _v.z;
      _n.set(nx, ny, nz).applyMatrix3(this.nmatrix).normalize(); nx = _n.x; ny = _n.y; nz = _n.z;
    }
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v);
    for (const k in this.state) { const s = this.state[k], a = this.extra[k]; for (let i = 0; i < s.length; i++) a.push(s[i]); }
    return this.count++;
  }
  tri(a, b, c) { if (this.flip) this.idx.push(a, c, b); else this.idx.push(a, b, c); }
  // quad from 4 points (arrays [x,y,z]) with desired normal; auto-fixes winding
  quad(p0, p1, p2, p3, n, uvs) {
    _e1.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    _e2.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
    _c.crossVectors(_e1, _e2);
    const flip = _c.x * n[0] + _c.y * n[1] + _c.z * n[2] < 0;
    uvs = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const a = this.vertex(p0[0], p0[1], p0[2], n[0], n[1], n[2], uvs[0][0], uvs[0][1]);
    const b = this.vertex(p1[0], p1[1], p1[2], n[0], n[1], n[2], uvs[1][0], uvs[1][1]);
    const c = this.vertex(p2[0], p2[1], p2[2], n[0], n[1], n[2], uvs[2][0], uvs[2][1]);
    const d = this.vertex(p3[0], p3[1], p3[2], n[0], n[1], n[2], uvs[3][0], uvs[3][1]);
    if (flip) { this.tri(a, c, b); this.tri(a, d, c); } else { this.tri(a, b, c); this.tri(a, c, d); }
  }
  // axis aligned box in current (local) frame. skip: string of faces to skip e.g. 'b' bottom, 't' top, 'n' -z, 's' +z, 'w' -x, 'e' +x
  box(x0, x1, y0, y1, z0, z1, skip = '', uvScale = 1) {
    const s = uvScale;
    if (!skip.includes('s')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [[x0 * s, y0 * s], [x1 * s, y0 * s], [x1 * s, y1 * s], [x0 * s, y1 * s]]);
    if (!skip.includes('n')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [[-x1 * s, y0 * s], [-x0 * s, y0 * s], [-x0 * s, y1 * s], [-x1 * s, y1 * s]]);
    if (!skip.includes('e')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [[-z1 * s, y0 * s], [-z0 * s, y0 * s], [-z0 * s, y1 * s], [-z1 * s, y1 * s]]);
    if (!skip.includes('w')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [[z0 * s, y0 * s], [z1 * s, y0 * s], [z1 * s, y1 * s], [z0 * s, y1 * s]]);
    if (!skip.includes('t')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]]);
    if (!skip.includes('b')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [[x0 * s, z0 * s], [x1 * s, z0 * s], [x1 * s, z1 * s], [x0 * s, z1 * s]]);
  }
  // box from center/size
  boxc(cx, cy, cz, sx, sy, sz, skip = '') { this.box(cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2, skip); }
  // cylinder along local Y from y0 to y1
  cylinder(cx, cz, r0, r1, y0, y1, seg = 8, caps = true, a0 = 0) {
    const base = this.count;
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * Math.PI * 2; const ca = Math.cos(a), sa = Math.sin(a);
      const slope = (r0 - r1) / Math.max(1e-4, (y1 - y0));
      const nl = Math.hypot(1, slope);
      this.vertex(cx + ca * r0, y0, cz + sa * r0, ca / nl, slope / nl, sa / nl, i / seg * 2 * Math.PI * r0, y0);
      this.vertex(cx + ca * r1, y1, cz + sa * r1, ca / nl, slope / nl, sa / nl, i / seg * 2 * Math.PI * r0, y1);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      this.tri(a, b, d); this.tri(a, d, c);
    }
    if (caps) {
      if (r1 > 0) { const c = this.vertex(cx, y1, cz, 0, 1, 0, 0, 0); const s = this.count; for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI * 2; this.vertex(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0, Math.cos(a) * r1, Math.sin(a) * r1); } for (let i = 0; i < seg; i++) this.tri(c, s + i + 1, s + i); }
      if (r0 > 0) { const c = this.vertex(cx, y0, cz, 0, -1, 0, 0, 0); const s = this.count; for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI * 2; this.vertex(cx + Math.cos(a) * r0, y0, cz + Math.sin(a) * r0, 0, -1, 0, Math.cos(a) * r0, Math.sin(a) * r0); } for (let i = 0; i < seg; i++) this.tri(c, s + i, s + i + 1); }
    }
  }
  // lathe around local Y through (cx,cz); profile = [[r,y],...] bottom to top
  lathe(cx, cz, profile, seg = 12) {
    const base = this.count; const n = profile.length;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2; const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < n; j++) {
        const [r, y] = profile[j];
        const jp = profile[Math.max(0, j - 1)], jn = profile[Math.min(n - 1, j + 1)];
        let dr = jn[0] - jp[0], dy = jn[1] - jp[1];
        let nx = dy, ny = -dr; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
        this.vertex(cx + ca * r, y, cz + sa * r, ca * nx, ny, sa * nx, i / seg, j / (n - 1));
      }
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < n - 1; j++) {
      const a = base + i * n + j, b = a + 1, c = a + n, d = c + 1;
      this.tri(a, b, d); this.tri(a, d, c);
    }
  }
  // tube along world/local points (array of Vector3)
  tube(pts, radius, rseg = 5, radiusFn = null) {
    const base = this.count; const n = pts.length;
    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i === 0) T.subVectors(pts[1], pts[0]); else if (i === n - 1) T.subVectors(pts[n - 1], pts[n - 2]); else T.subVectors(pts[i + 1], pts[i - 1]);
      T.normalize();
      if (i === 0) { N.crossVectors(T, Math.abs(T.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize(); }
      else { N.sub(T.clone().multiplyScalar(N.dot(T))).normalize(); }
      B.crossVectors(T, N).normalize();
      const r = radiusFn ? radiusFn(i / (n - 1)) : radius;
      for (let j = 0; j <= rseg; j++) {
        const a = (j / rseg) * Math.PI * 2; const ca = Math.cos(a), sa = Math.sin(a);
        const nx = N.x * ca + B.x * sa, ny = N.y * ca + B.y * sa, nz = N.z * ca + B.z * sa;
        this.vertex(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz, j / rseg, i / (n - 1));
      }
    }
    const rs = rseg + 1;
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < rseg; j++) {
      const a = base + i * rs + j, b = a + 1, c = a + rs, d = c + 1;
      this.tri(a, d, c); this.tri(a, b, d);
    }
  }
  // extruded polygon (xz, CCW positive area) between y0,y1 in current frame
  prism(poly, y0, y1, opts = {}) {
    const n = poly.length;
    const top = opts.top !== false, bottom = !!opts.bottom;
    let area = 0; for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const sgn = area >= 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1]; const L = Math.hypot(ex, ez); if (L < 1e-4) continue;
      const nx = sgn * ez / L, nz = -sgn * ex / L;
      if (opts.onWall) opts.onWall(i, a, b, L, nx, nz);
      const u0 = opts.uOffset ? opts.uOffset(i) : 0;
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [nx, 0, nz], [[u0, y0], [u0 + L, y0], [u0 + L, y1], [u0, y1]]);
    }
    if (opts.onWall) opts.onWall(-1);
    const capFan = (y, ny) => {
      // ear-clipping-free: fan from centroid works for star-shaped polys (ours are)
      let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
      const c = this.vertex(cx, y, cz, 0, ny, 0, cx, cz);
      const s = this.count;
      for (let i = 0; i < n; i++) this.vertex(poly[i][0], y, poly[i][1], 0, ny, 0, poly[i][0], poly[i][1]);
      for (let i = 0; i < n; i++) {
        const a = s + i, b = s + (i + 1) % n;
        // ensure facing ny
        const pa = poly[i], pb = poly[(i + 1) % n];
        const cr = (pa[0] - cx) * (pb[1] - cz) - (pb[0] - cx) * (pa[1] - cz); // y component of cross(a-c, b-c) negated
        // cross((ax,0,az),(bx,0,bz)).y = az*bx - ax*bz = -cr
        const facingUp = -cr > 0;
        if ((ny > 0) === facingUp) this.tri(c, a, b); else this.tri(c, b, a);
      }
    };
    if (top) capFan(y1, 1);
    if (bottom) capFan(y0, -1);
  }
  // append a THREE.BufferGeometry (indexed or not) using the current state
  addGeometry(geom) {
    const p = geom.attributes.position, n = geom.attributes.normal, uv = geom.attributes.uv;
    const base = this.count;
    for (let i = 0; i < p.count; i++) {
      this.vertex(p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (geom.index) { const ix = geom.index.array; for (let i = 0; i < ix.length; i += 3) this.tri(base + ix[i], base + ix[i + 1], base + ix[i + 2]); }
    else for (let i = 0; i < p.count; i += 3) this.tri(base + i, base + i + 1, base + i + 2);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.extra) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k], this.attrDefs[k]));
    const IndexArr = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArr(this.idx), 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  get empty() { return this.count === 0; }
}

// Offset a convex-ish polygon outward by d (miter)
export function offsetPoly(poly, d) {
  const n = poly.length; const out = [];
  let area = 0; for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], c = poly[i], q = poly[(i + 1) % n];
    let e1x = c[0] - p[0], e1z = c[1] - p[1]; let l1 = Math.hypot(e1x, e1z); e1x /= l1; e1z /= l1;
    let e2x = q[0] - c[0], e2z = q[1] - c[1]; let l2 = Math.hypot(e2x, e2z); e2x /= l2; e2z /= l2;
    const n1x = sgn * e1z, n1z = -sgn * e1x, n2x = sgn * e2z, n2z = -sgn * e2x;
    let mx = n1x + n2x, mz = n1z + n2z; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const cosHalf = mx * n1x + mz * n1z; const k = d / Math.max(0.3, cosHalf);
    out.push([c[0] + mx * k, c[1] + mz * k]);
  }
  return out;
}

export function rectPoly(x0, z0, x1, z1) { return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }
export function chamferPoly(x0, z0, x1, z1, c) {
  return [[x0 + c, z0], [x1 - c, z0], [x1, z0 + c], [x1, z1 - c], [x1 - c, z1], [x0 + c, z1], [x0, z1 - c], [x0, z0 + c]];
}
export function roundRectPoly(x0, z0, x1, z1, r, seg = 3) {
  const pts = []; const cs = [[x1 - r, z0 + r, -Math.PI / 2], [x1 - r, z1 - r, 0], [x0 + r, z1 - r, Math.PI / 2], [x0 + r, z0 + r, Math.PI]];
  for (const [cx, cz, a0] of cs) for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return pts;
}
export function circlePoly(cx, cz, r, seg = 20) {
  const pts = []; for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } return pts;
}
export function notchPoly(x0, z0, x1, z1, k) {
  return [[x0 + k, z0], [x1 - k, z0], [x1 - k, z0 + k], [x1, z0 + k], [x1, z1 - k], [x1 - k, z1 - k], [x1 - k, z1], [x0 + k, z1], [x0 + k, z1 - k], [x0, z1 - k], [x0, z0 + k], [x0 + k, z0 + k]];
}

// Frame matrix: local x along t, y up, z along n, origin o
export function frameMatrix(ox, oy, oz, tx, tz, nx, nz) {
  const m = new THREE.Matrix4();
  m.set(tx, 0, nx, ox,
        0, 1, 0, oy,
        tz, 0, nz, oz,
        0, 0, 0, 1);
  return m;
}

export const PALETTE = {
  magenta: new THREE.Color(1.0, 0.12, 0.55),
  pink: new THREE.Color(1.0, 0.3, 0.75),
  cyan: new THREE.Color(0.1, 0.85, 1.0),
  blue: new THREE.Color(0.2, 0.45, 1.0),
  violet: new THREE.Color(0.55, 0.25, 1.0),
  orange: new THREE.Color(1.0, 0.45, 0.1),
  amber: new THREE.Color(1.0, 0.68, 0.22),
  red: new THREE.Color(1.0, 0.08, 0.12),
  green: new THREE.Color(0.25, 1.0, 0.45),
  lime: new THREE.Color(0.7, 1.0, 0.15),
  white: new THREE.Color(0.85, 0.9, 1.0),
  teal: new THREE.Color(0.0, 1.0, 0.75),
};
export const NEON_LIST = ['magenta', 'pink', 'cyan', 'blue', 'violet', 'orange', 'amber', 'red', 'green', 'teal', 'cyan', 'magenta', 'pink'];
