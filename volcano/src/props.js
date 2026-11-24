// Scattered volcanic boulders, outcrops, conifers and burnt trees (instanced)
import * as THREE from 'three';
import { V } from './terrain.js';
import { noise3, fbm2, mulberry32, smoothstep } from './noise.js';
import { propVert, propFrag } from './shaders.js';

const rnd = mulberry32(31337);

function rockGeometry(seed, detail = 2) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const sx = 0.8 + rnd() * 0.5, sy = 0.45 + rnd() * 0.35, sz = 0.8 + rnd() * 0.5;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = noise3(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6 - seed) * 0.28 + noise3(v.x * 4 + seed, v.y * 4, v.z * 4) * 0.09;
    v.multiplyScalar(1 + n);
    // flatten facets a little for a fractured look
    v.set(v.x * sx, v.y * sy, v.z * sz);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const cols = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = 0.8 + rnd() * 0.25;
    cols[i * 3] = 0.05 * t; cols[i * 3 + 1] = 0.046 * t; cols[i * 3 + 2] = 0.044 * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

function merge(parts) {
  let count = 0;
  const flat = parts.map(({ geo, color, jitter }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    count += g.attributes.position.count;
    return { g, color, jitter };
  });
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0;
  for (const { g, color, jitter } of flat) {
    const p = g.attributes.position;
    if (jitter) {
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = noise3(x * 0.7 + 3, y * 0.7, z * 0.7) * jitter;
        p.setXYZ(i, x * (1 + n), y + n * 0.3, z * (1 + n));
      }
    }
    g.computeVertexNormals();
    const nn = g.attributes.normal;
    for (let i = 0; i < p.count; i++, o++) {
      pos[o * 3] = p.getX(i); pos[o * 3 + 1] = p.getY(i); pos[o * 3 + 2] = p.getZ(i);
      nor[o * 3] = nn.getX(i); nor[o * 3 + 1] = nn.getY(i); nor[o * 3 + 2] = nn.getZ(i);
      const t = 0.85 + 0.3 * rnd();
      col[o * 3] = color[0] * t; col[o * 3 + 1] = color[1] * t; col[o * 3 + 2] = color[2] * t;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function conifer() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.45, 5, 5, 1);
  trunk.translate(0, 2.5, 0);
  parts.push({ geo: trunk, color: [0.035, 0.024, 0.016] });
  const layers = 5;
  for (let k = 0; k < layers; k++) {
    const t = k / (layers - 1);
    const rad = 3.4 * (1 - t * 0.72);
    const h = 4.2 * (1 - t * 0.3);
    const c = new THREE.ConeGeometry(rad, h, 7, 1, true);
    c.rotateY(rnd() * Math.PI);
    c.translate(0, 3.2 + k * 2.3 + h * 0.5, 0);
    parts.push({ geo: c, color: [0.018, 0.034, 0.016], jitter: 0.22 });
  }
  return merge(parts);
}

function deadTree() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.15, 0.42, 12, 5, 3);
  trunk.translate(0, 6, 0);
  parts.push({ geo: trunk, color: [0.022, 0.019, 0.017], jitter: 0.15 });
  const nb = 5;
  for (let k = 0; k < nb; k++) {
    const len = 2.5 + rnd() * 3;
    const b = new THREE.CylinderGeometry(0.05, 0.14, len, 4, 1);
    b.translate(0, len * 0.5, 0);
    b.rotateZ(0.6 + rnd() * 0.7);
    b.rotateY(rnd() * Math.PI * 2);
    b.translate(0, 5 + k * 1.3 + rnd(), 0);
    parts.push({ geo: b, color: [0.02, 0.018, 0.016] });
  }
  return merge(parts);
}

export function buildProps(sample, F, uniforms) {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: propVert,
    fragmentShader: propFrag,
    side: THREE.DoubleSide,
  });
  const N = V.N, HM = V.HM, cell = V.CELL;
  const lavaAt = (x, z) => {
    const i = Math.floor((x + HM) / cell), j = Math.floor((z + HM) / cell);
    if (i < 0 || j < 0 || i >= N || j >= N) return { nd: 9, act: 0 };
    const id = j * N + i;
    return { nd: F.nd[id], act: F.act[id] };
  };
  const slopeAt = (x, z) => {
    const e = 12;
    const gx = (sample(x + e, z) - sample(x - e, z)) / (2 * e);
    const gz = (sample(x, z + e) - sample(x, z - e)) / (2 * e);
    return Math.hypot(gx, gz);
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();

  // --- rocks
  // level of detail by size class: small boulders, medium blocks, large outcrops
  const rockGeos = [rockGeometry(1.3, 1), rockGeometry(7.9, 1), rockGeometry(15.2, 2), rockGeometry(22.7, 2), rockGeometry(31.1, 3), rockGeometry(44.4, 3)];
  const rockLists = rockGeos.map(() => []);
  let cls = 0;
  const tryRock = (rMin, rMax, smin, smax, sink) => {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lv = lavaAt(x, z);
    if (lv.act && lv.nd < 1.4) return;
    const sc = smin * Math.pow(smax / smin, rnd());
    const y = sample(x, z) - sc * sink;
    e.set((rnd() - 0.5) * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6);
    q.setFromEuler(e);
    s.set(sc * (0.8 + rnd() * 0.4), sc * (0.7 + rnd() * 0.6), sc * (0.8 + rnd() * 0.4));
    p.set(x, y, z);
    m4.compose(p, q, s);
    rockLists[cls * 2 + (rnd() < 0.5 ? 0 : 1)].push(m4.clone());
  };
  cls = 0; for (let k = 0; k < 5200; k++) tryRock(V.RIM_R * 1.3, 8800, 2, 9, 0.3);
  cls = 1; for (let k = 0; k < 1100; k++) tryRock(V.RIM_R * 1.5, 7000, 10, 34, 0.35);
  cls = 2; for (let k = 0; k < 170; k++) tryRock(1100, 8000, 40, 130, 0.45);
  // boulders lining the main lava river banks
  rockGeos.forEach((g, i) => {
    const list = rockLists[i];
    const im = new THREE.InstancedMesh(g, mat, list.length);
    list.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
  });

  // --- trees
  const pine = conifer(), dead = deadTree();
  const pines = [], deads = [];
  let tries = 0;
  while ((pines.length < 9000 || deads.length < 1400) && tries < 120000) {
    tries++;
    const a = rnd() * Math.PI * 2, r = 3800 + Math.pow(rnd(), 0.7) * 14500;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const forest = fbm2(x * 0.00045 + 5.1, z * 0.00045 - 3.3, 4) + 0.15 * smoothstep(5000, 11000, r);
    const lv = lavaAt(x, z);
    const nearLava = lv.act ? 1 - smoothstep(1.2, 5.5, lv.nd) : 0;
    const onOld = !lv.act && lv.nd < 1.1;
    if (onOld) continue;
    if (lv.act && lv.nd < 1.5) continue;
    const isDead = nearLava > 0.2 || (r < 5400 && rnd() < 0.5);
    if (!isDead && forest < 0.08) continue;
    if (isDead && deads.length >= 1400) continue;
    if (!isDead && pines.length >= 9000) continue;
    const sl = slopeAt(x, z);
    if (sl > 0.42) continue;
    const y = sample(x, z);
    if (y > 1650) continue;
    const sc = (isDead ? 1.0 : 1.2) * (0.75 + rnd() * 0.7);
    e.set((rnd() - 0.5) * 0.08, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.08);
    q.setFromEuler(e);
    s.set(sc, sc * (0.85 + rnd() * 0.3), sc);
    p.set(x, y - 0.5, z);
    m4.compose(p, q, s);
    (isDead ? deads : pines).push(m4.clone());
  }
  for (const [geo, list] of [[pine, pines], [dead, deads]]) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
  }
  return group;
}
