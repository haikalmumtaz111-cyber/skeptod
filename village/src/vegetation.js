// Vegetation: sakura (incl. weeping), pines, maples, bamboo, forests, grass, flowers.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tube, srgb } from './geom.js';
import { RNG, simplex2, fbm3, clamp, smoothstep } from './noise.js';
import { layout, hAt, LAND_Y, riverXAt, LOWER, waterAt, cliffZ, UPPER_Y } from './world.js';
import { maskAt, forestAmount } from './terrain.js';
import { windify, windDepthMaterial, NOISE_GLSL } from './shaders.js';

const V3 = THREE.Vector3;
export const sakuraClusters = []; // for petal spawning: {x,y,z,r}

// ---------- foliage card material (spherical normals, translucency, wind) ----------
function foliageMaterial(map, { alphaTest = 0.5, transl = 1.0, key = 'fol', tint = [1, 1, 1], spec = 0 } = {}) {
  const m = new THREE.MeshLambertMaterial({ map, alphaTest, side: THREE.DoubleSide, color: new THREE.Color(...tint) });
  windify(m, {
    key,
    extraVertex: 'attribute vec3 aNrm;\n',
    extraFragment: (sh) => {
      sh.uniforms.uTransl = { value: transl };
      sh.vertexShader = sh.vertexShader.replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalMatrix * aNrm;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTransl;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
        .replace('#include <opaque_fragment>', `
          #ifdef USE_FOG
          vec3 Vw = normalize(cameraPosition - vFogWorld);
          float bk = pow(max(dot(-Vw, SUN_DIR), 0.0), 3.0);
          float up = clamp(dot(normalize(vNormal), normalize((viewMatrix * vec4(0.0,1.0,0.0,0.0)).xyz)) * 0.5 + 0.5, 0.0, 1.0);
          outgoingLight += diffuseColor.rgb * vec3(1.0, 0.62, 0.42) * (bk * 1.4 + 0.12) * uTransl;
          outgoingLight *= 0.82 + 0.3 * up;
          #endif
          #include <opaque_fragment>`);
    },
  });
  m.alphaToCoverage = true;
  return m;
}
function foliageDepth(map, key) {
  return windDepthMaterial({ key: key + 'D', mat: { map, alphaTest: 0.5 } });
}

// card geometry: unit quad, pivot at center
const cardGeo = new THREE.PlaneGeometry(1, 1);

class CardSet {
  constructor() { this.items = []; }
  add(pos, nrm, size, wind, phase, color, faceDir = null, rng, stretch = 1) {
    this.items.push({ pos, nrm, size, wind, phase, color, faceDir, stretch, r: rng.next(), r2: rng.next(), r3: rng.next() });
  }
  build(mat, depth, castShadow = true) {
    const n = this.items.length;
    const g = cardGeo.clone();
    const aN = new Float32Array(n * 3), aW = new Float32Array(n * 2);
    const mesh = new THREE.InstancedMesh(g, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3(), col = new THREE.Color();
    const z = new V3(0, 0, 1);
    this.items.forEach((it, i) => {
      // orientation: random, biased to face outward
      const dir = it.faceDir ? it.faceDir.clone() : it.nrm.clone().add(new V3(it.r - 0.5, it.r2 - 0.5, it.r3 - 0.5).multiplyScalar(1.6)).normalize();
      q.setFromUnitVectors(z, dir);
      const roll = new THREE.Quaternion().setFromAxisAngle(dir, it.r * Math.PI * 2);
      if (!it.faceDir) q.premultiply(roll);
      m4.compose(it.pos, q, s.set(it.size, it.size * it.stretch, it.size));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.setRGB(it.color[0], it.color[1], it.color[2]));
      aN[i * 3] = it.nrm.x; aN[i * 3 + 1] = it.nrm.y; aN[i * 3 + 2] = it.nrm.z;
      aW[i * 2] = it.wind; aW[i * 2 + 1] = it.phase;
    });
    g.setAttribute('aNrm', new THREE.InstancedBufferAttribute(aN, 3));
    g.setAttribute('aWind', new THREE.InstancedBufferAttribute(aW, 2));
    mesh.castShadow = castShadow; mesh.receiveShadow = true;
    if (depth) mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false;
    return mesh;
  }
}

// ---------- branch skeleton ----------
function perpBasis(d) {
  const a = Math.abs(d.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const u = new V3().crossVectors(d, a).normalize();
  const w = new V3().crossVectors(d, u).normalize();
  return [u, w];
}

function growTree(rng, o) {
  const branches = [], tips = [];
  const grow = (start, dir, len, rad, depth, along = 0) => {
    const segs = depth === 0 ? 6 : 5;
    const pts = [start.clone()], radii = [rad];
    let p = start.clone(), d = dir.clone();
    for (let i = 1; i <= segs; i++) {
      d.add(new V3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(o.gnarl));
      d.y += o.upBias[depth] || 0;
      // outward tendency
      const out = new V3(p.x, 0, p.z);
      if (out.lengthSq() > 0.01 && depth > 0) d.addScaledVector(out.normalize(), o.outward);
      d.normalize();
      p = p.clone().addScaledVector(d, len / segs);
      pts.push(p);
      radii.push(rad * (1 - (o.taper * i) / segs));
    }
    branches.push({ pts, radii, depth });
    if (depth >= o.maxDepth) { tips.push({ p, d: d.clone(), depth }); return; }
    if (depth >= o.clusterDepth) tips.push({ p: pts[3].clone(), d: d.clone(), depth, mid: true });
    const n = depth === 0 ? rng.int(o.limbs[0], o.limbs[1]) : rng.int(2, 3);
    const [u, w] = perpBasis(d);
    const az0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const az = az0 + (k / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const tilt = depth === 0 ? rng.range(o.tilt0[0], o.tilt0[1]) : rng.range(0.35, 0.75);
      const cd = d.clone().multiplyScalar(Math.cos(tilt)).add(u.clone().multiplyScalar(Math.cos(az) * Math.sin(tilt))).add(w.clone().multiplyScalar(Math.sin(az) * Math.sin(tilt))).normalize();
      const startAt = depth === 0 ? p : pts[rng.int(Math.max(2, segs - 2), segs)];
      grow(startAt, cd, len * rng.range(o.lenK[0], o.lenK[1]), radii[radii.length - 1] * 0.95 * (n > 2 ? 0.8 : 0.9), depth + 1);
    }
  };
  const lean = new V3(rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)).normalize();
  grow(new V3(0, -0.3, 0), lean, o.trunkLen, o.trunkR, 0);
  return { branches, tips };
}

function branchesToGeometry(branches, base, swayH, phase) {
  const geos = [];
  for (const b of branches) {
    const radial = b.depth === 0 ? 10 : b.depth === 1 ? 7 : 5;
    const g = tube(b.pts, b.radii, radial, 1);
    geos.push(g);
  }
  const g = mergeGeometries(geos, false);
  // wind weights by height
  const p = g.attributes.position;
  const w = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), r = Math.hypot(p.getX(i), p.getZ(i));
    const k = clamp(y / swayH, 0, 1.3);
    w[i * 2] = k * k * 0.35 + r * 0.02 * k;
    w[i * 2 + 1] = phase;
  }
  g.setAttribute('aWind', new THREE.BufferAttribute(w, 2));
  g.applyMatrix4(base);
  return g;
}

// ---------- sakura ----------
function buildSakura(T, cards, barkGeos, t, rng, weeping = false) {
  const s = t.s;
  const y = hAt(t.x, t.z);
  const base = new THREE.Matrix4().compose(new V3(t.x, y, t.z), new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), rng.range(0, 6.28)), new V3(s, s, s));
  const phase = rng.range(0, 6.28);
  const o = weeping
    ? { gnarl: 0.18, upBias: [0.05, 0.12, 0.0, -0.1], outward: 0.25, taper: 0.5, maxDepth: 3, clusterDepth: 9, limbs: [4, 5], tilt0: [0.6, 0.95], lenK: [0.65, 0.8], trunkLen: 3.6, trunkR: 0.34 }
    : { gnarl: 0.22, upBias: [0.02, 0.05, 0.0, -0.02, -0.04], outward: 0.18, taper: 0.45, maxDepth: 4, clusterDepth: 2, limbs: [3, 5], tilt0: [0.75, 1.05], lenK: [0.62, 0.8], trunkLen: 2.3, trunkR: 0.3 };
  const sk = growTree(rng, { ...o });
  const lens = sk.branches.length;
  barkGeos.push(branchesToGeometry(sk.branches, base, 7, phase));
  // blossom palette per tree
  const pink = t.tint === undefined ? rng.next() : t.tint;
  const tintA = weeping ? [1.0, 0.78, 0.86] : pink > 0.6 ? [1.0, 0.86, 0.9] : pink > 0.25 ? [1.0, 0.93, 0.95] : [1.0, 0.98, 0.98];
  const center = new V3(0, weeping ? 3.5 : 4.6, 0).applyMatrix4(base);
  if (!weeping) {
    for (const tip of sk.tips) {
      const cr = (tip.mid ? 0.75 : 1.05) * rng.range(0.85, 1.25);
      const cp = tip.p.clone().addScaledVector(tip.d, 0.3).applyMatrix4(base);
      sakuraClusters.push({ x: cp.x, y: cp.y, z: cp.z, r: cr * s });
      const nc = tip.mid ? 7 : 12;
      for (let k = 0; k < nc; k++) {
        const off = new V3(rng.gauss(), rng.gauss() * 0.75, rng.gauss()).multiplyScalar(cr * s * 0.55);
        const pos = cp.clone().add(off);
        const nrm = pos.clone().sub(center).normalize().lerp(off.clone().normalize(), 0.35).normalize();
        const shade = 0.82 + 0.18 * clamp((pos.y - center.y) / 3 + 0.5, 0, 1);
        const col = [tintA[0] * shade, tintA[1] * shade, tintA[2] * shade];
        const hgt = clamp((pos.y - y) / (7 * s), 0, 1.3);
        cards.add(pos, nrm, rng.range(0.85, 1.25) * s, 0.35 * hgt * hgt + 0.08, phase, col, null, rng);
      }
    }
  } else {
    // drooping strands from the ends of branches
    const tips = sk.tips;
    for (const tip of tips) {
      const p0 = tip.p.clone();
      const nStr = 5;
      for (let k = 0; k < nStr; k++) {
        const pts = [], radii = [];
        let p = p0.clone().add(new V3(rng.range(-0.5, 0.5), rng.range(-0.2, 0.2), rng.range(-0.5, 0.5)));
        const outDir = new V3(p.x, 0, p.z).normalize();
        const L = rng.range(2.6, Math.max(2.8, p.y - 0.9));
        let d = outDir.clone().multiplyScalar(0.6).add(new V3(0, 0.3, 0)).normalize();
        for (let i = 0; i <= 7; i++) {
          pts.push(p.clone()); radii.push(0.03 * (1 - i / 9));
          d.y -= 0.32; d.normalize();
          p = p.clone().addScaledVector(d, L / 7);
        }
        const g = tube(pts, radii, 3, 1);
        const pw = new Float32Array(g.attributes.position.count * 2);
        for (let i = 0; i < pw.length / 2; i++) { pw[i * 2] = 0.55; pw[i * 2 + 1] = phase + k; }
        g.setAttribute('aWind', new THREE.BufferAttribute(pw, 2));
        g.applyMatrix4(base);
        barkGeos.push(g);
        for (let i = 1; i < pts.length; i++) {
          const pos = pts[i].clone().applyMatrix4(base);
          const nrm = pos.clone().sub(center).setY(0).normalize().add(new V3(0, 0.25, 0)).normalize();
          const shade = 0.8 + 0.2 * (1 - i / pts.length);
          const col = [tintA[0] * shade, tintA[1] * shade, tintA[2] * shade];
          const face = nrm.clone().add(new V3(rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4))).setY(0).normalize();
          cards.add(pos, nrm, rng.range(0.75, 1.0) * s, 0.55 + i * 0.03, phase + k, col, face, rng, 1.25);
          if (i % 2 === 0) sakuraClusters.push({ x: pos.x, y: pos.y, z: pos.z, r: 0.6 * s });
        }
      }
      // also a puff at the tip
      const cp = tip.p.clone().applyMatrix4(base);
      for (let k = 0; k < 4; k++) {
        const off = new V3(rng.gauss(), rng.gauss() * 0.6, rng.gauss()).multiplyScalar(0.5 * s);
        const pos = cp.clone().add(off);
        cards.add(pos, pos.clone().sub(center).normalize(), rng.range(0.8, 1.1) * s, 0.3, phase, tintA, null, rng);
      }
    }
  }
  return center;
}

// ---------- pine (cloud-pruned pads) ----------
function buildPine(T, cards, barkGeos, padGeos, t, rng) {
  const s = t.s;
  const y = hAt(t.x, t.z);
  const base = new THREE.Matrix4().compose(new V3(t.x, y, t.z), new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), rng.range(0, 6.28)), new V3(s, s, s));
  const phase = rng.range(0, 6.28);
  const branches = [];
  // leaning, twisting trunk
  const tpts = [], trad = [];
  let p = new V3(0, -0.3, 0);
  const leanDir = new V3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize();
  for (let i = 0; i <= 8; i++) {
    tpts.push(p.clone()); trad.push(0.34 * (1 - i / 11));
    const bend = Math.sin(i * 0.8) * 0.35;
    p = p.clone().add(new V3(leanDir.x * (0.35 + bend), 0.85, leanDir.z * (0.35 + bend)));
  }
  branches.push({ pts: tpts, radii: trad, depth: 0 });
  const pads = [];
  for (let i = 3; i <= 8; i++) {
    const n = i === 8 ? 1 : rng.int(1, 2);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, Math.PI * 2);
      const len = i === 8 ? 0.3 : rng.range(1.4, 2.8) * (1 - i / 14);
      const st = tpts[i];
      const end = st.clone().add(new V3(Math.cos(a) * len, rng.range(0.1, 0.5), Math.sin(a) * len));
      const mid = st.clone().lerp(end, 0.5).add(new V3(0, -0.25, 0));
      branches.push({ pts: [st, mid, end], radii: [trad[i] * 0.55, trad[i] * 0.35, 0.05], depth: 2 });
      pads.push({ p: end, r: rng.range(1.0, 1.6) * (i === 8 ? 1.2 : 1) });
    }
  }
  barkGeos.push(branchesToGeometry(branches, base, 7, phase));
  for (const pd of pads) {
    const cp = pd.p.clone().applyMatrix4(base);
    // solid core pad
    let core = new THREE.IcosahedronGeometry(1, 2);
    core.deleteAttribute('uv'); core.deleteAttribute('normal');
    core = mergeVertices(core);
    const cpp = core.attributes.position;
    const sd = rng.range(0, 50);
    for (let k = 0; k < cpp.count; k++) {
      const x = cpp.getX(k), y = cpp.getY(k), z = cpp.getZ(k);
      const f = 1 + 0.25 * fbm3(x * 2.2 + sd, y * 2.2, z * 2.2, 3);
      cpp.setXYZ(k, x * f, y * f, z * f);
    }
    core.scale(pd.r * s * 0.85, pd.r * s * 0.3, pd.r * s * 0.85);
    core.translate(cp.x, cp.y + 0.02, cp.z);
    core.computeVertexNormals();
    if (false) padGeos.push(core);
    for (let k = 0; k < 40; k++) {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * pd.r * s;
      const pos = cp.clone().add(new V3(Math.cos(a) * r, rng.range(0.05, 0.3) * s, Math.sin(a) * r));
      const nrm = new V3(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
      const face = new V3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).normalize();
      cards.add(pos, nrm, rng.range(0.75, 1.1) * s, 0.12, phase, [0.62, 0.78, 0.6], rng.next() < 0.6 ? face : null, rng);
    }
  }
}

// ---------- maple / generic broadleaf ----------
function buildLeafTree(T, cards, barkGeos, t, rng, colors) {
  const s = t.s;
  const y = hAt(t.x, t.z);
  const base = new THREE.Matrix4().compose(new V3(t.x, y, t.z), new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), rng.range(0, 6.28)), new V3(s, s, s));
  const phase = rng.range(0, 6.28);
  const sk = growTree(rng, { gnarl: 0.2, upBias: [0.05, 0.08, 0.04, 0.0], outward: 0.12, taper: 0.5, maxDepth: 3, clusterDepth: 2, limbs: [3, 4], tilt0: [0.5, 0.85], lenK: [0.6, 0.8], trunkLen: 2.4, trunkR: 0.2 });
  barkGeos.push(branchesToGeometry(sk.branches, base, 6, phase));
  const center = new V3(0, 4, 0).applyMatrix4(base);
  for (const tip of sk.tips) {
    const cp = tip.p.clone().applyMatrix4(base);
    const cr = rng.range(0.8, 1.2) * s;
    for (let k = 0; k < 10; k++) {
      const off = new V3(rng.gauss(), rng.gauss() * 0.7, rng.gauss()).multiplyScalar(cr * 0.6);
      const pos = cp.clone().add(off);
      const nrm = pos.clone().sub(center).normalize();
      const c = colors[rng.int(0, colors.length - 1)];
      cards.add(pos, nrm, rng.range(0.8, 1.15) * s, 0.3, phase, c, null, rng);
    }
  }
}

export function buildVegetation(T) {
  const group = new THREE.Group();
  const rng = new RNG(4242);
  const blossoms = new CardSet();
  const weepCards = new CardSet();
  const pineCards = new CardSet();
  const mapleCards = new CardSet();
  const leafCards = new CardSet();
  const barkSakura = [], barkPine = [], barkOther = [], pinePads = [];
  for (const t of layout.sakura) buildSakura(T, blossoms, barkSakura, t, new RNG(t.seed));
  for (const t of layout.weeping) buildSakura(T, weepCards, barkSakura, t, new RNG(t.seed), true);
  for (const t of layout.pines) buildPine(T, pineCards, barkPine, pinePads, t, new RNG(t.seed));
  for (const t of layout.maples) {
    const cols = t.red ? [[0.75, 0.12, 0.08], [0.85, 0.2, 0.1], [0.6, 0.08, 0.07]] : [[0.45, 0.68, 0.18], [0.55, 0.75, 0.2], [0.4, 0.6, 0.15]];
    buildLeafTree(T, mapleCards, barkOther, t, new RNG(t.seed), cols);
  }
  // generic green trees near village edges
  const greens = [];
  for (let i = 0; i < 46; i++) {
    const x = rng.range(-110, 110), z = rng.range(-95, 110);
    const rx = riverXAt(z);
    const dx = Math.abs(x - rx);
    if (dx < 48 || dx > 85) continue;
    const mk = maskAt(x, z);
    if (mk[2] > 0.1 || mk[0] > 0.2 || mk[1] > 0.2) continue;
    let nearPath = false;
    for (const p of layout.toriiPath.pts) if (Math.hypot(x - p[0], z - p[1]) < 7) nearPath = true;
    if (nearPath) continue;
    const h = hAt(x, z);
    if (h > LAND_Y + 12) continue;
    greens.push({ x, z, s: rng.range(0.9, 1.3), seed: rng.int(1, 1e6) });
  }
  for (const t of greens) buildLeafTree(T, leafCards, barkOther, t, new RNG(t.seed), [[0.32, 0.5, 0.14], [0.26, 0.44, 0.12], [0.4, 0.56, 0.16]]);

  // bark meshes
  const barkMat = windify(new THREE.MeshStandardMaterial({ map: T.bark, color: new THREE.Color('#6a5452'), roughness: 0.9 }), { key: 'barkS' });
  const roughMat = windify(new THREE.MeshStandardMaterial({ map: T.barkRough, color: new THREE.Color('#6b5a4a'), roughness: 0.95 }), { key: 'barkR' });
  const addBark = (geos, mat, key) => {
    if (!geos.length) return;
    const g = mergeGeometries(geos.map((x) => { const y = x.index ? x : x; return y; }), false);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    m.customDepthMaterial = windDepthMaterial({ key });
    group.add(m);
  };
  addBark(barkSakura, barkMat, 'bS');
  addBark([...barkPine, ...barkOther], roughMat, 'bR');
  if (pinePads.length) {
    const pg = mergeGeometries(pinePads, false);
    const pmat = new THREE.MeshLambertMaterial({ color: new THREE.Color('#2f5228') });
    pmat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + NOISE_GLSL)
        .replace('#include <color_fragment>', `#include <color_fragment>
          #ifdef USE_FOG
          diffuseColor.rgb *= 0.55 + 0.8 * vnoise(vFogWorld.xz * 7.0 + vFogWorld.y * 5.0);
          #endif`);
    };
    const pm = new THREE.Mesh(pg, pmat);
    pm.castShadow = true; pm.receiveShadow = true;
    group.add(pm);
  }

  const blossomMat = foliageMaterial(T.blossom, { key: 'blossom', transl: 1.1 });
  group.add(blossoms.build(blossomMat, foliageDepth(T.blossom, 'blossom')));
  const weepMat = foliageMaterial(T.blossomWeep, { key: 'weep', transl: 1.1 });
  group.add(weepCards.build(weepMat, foliageDepth(T.blossomWeep, 'weep')));
  group.add(pineCards.build(foliageMaterial(T.pineNeedles, { key: 'pine', transl: 0.4 }), foliageDepth(T.pineNeedles, 'pine')));
  group.add(mapleCards.build(foliageMaterial(T.maple, { key: 'maple', transl: 1.3 }), foliageDepth(T.maple, 'maple')));
  group.add(leafCards.build(foliageMaterial(T.leaves, { key: 'leaf', transl: 0.9 }), foliageDepth(T.leaves, 'leaf')));

  group.add(buildPetalCarpet(T, rng));
  group.add(buildBamboo(T, rng));
  group.add(buildForest(T, rng));
  const grass = buildGrass(T, rng);
  grass.layers.set(2);
  group.add(grass);
  const flowers = buildFlowers(T, rng);
  flowers.layers.set(2);
  group.add(flowers);
  group.add(buildShrubs(T, rng));
  // ferns and hanging greenery on the waterfall cliff
  const ferns = new CardSet();
  for (let i = 0; i < 260; i++) {
    const x = rng.range(-42, 36);
    if (Math.abs(x + 4) < 5) continue;
    const top = rng.next() < 0.35;
    const y = top ? UPPER_Y + rng.range(-0.6, 0.8) : rng.range(0.5, UPPER_Y);
    const z = cliffZ(x) - 1.0 + (1 - y / UPPER_Y) * 2.8 + rng.range(0.4, 1.8);
    const nrm = new V3(rng.range(-0.3, 0.3), 0.6, 1).normalize();
    const g = rng.range(0.75, 1.1);
    ferns.add(new V3(x, y, z), nrm, rng.range(1.1, 2.2), 0.18, rng.range(0, 6), [0.55 * g, 0.8 * g, 0.4 * g], null, rng);
  }
  group.add(ferns.build(foliageMaterial(T.bambooLeaves, { key: 'fern', transl: 1.0 }), null, false));
  return group;
}

// fallen petals on the ground beneath sakura
function buildPetalCarpet(T, rng) {
  const items = [];
  for (const t of [...layout.sakura, ...layout.weeping]) {
    const n = 220;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.pow(rng.next(), 0.7) * 6.5 * t.s;
      const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
      const h = hAt(x, z);
      if (h < 0.05) continue;
      items.push([x, h + 0.025, z, rng.range(0, 6.28), rng.range(0.6, 1.2)]);
    }
  }
  const g = new THREE.PlaneGeometry(0.09, 0.09);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ map: T.petal, alphaTest: 0.4, color: new THREE.Color(1, 0.92, 0.95) });
  const mesh = new THREE.InstancedMesh(g, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), s = new V3();
  items.forEach((it, i) => {
    q.setFromAxisAngle(new V3(0, 1, 0), it[3]);
    m4.compose(v.set(it[0], it[1], it[2]), q, s.set(it[4], 1, it[4]));
    mesh.setMatrixAt(i, m4);
  });
  mesh.receiveShadow = true;
  mesh.layers.set(2);
  return mesh;
}

// ---------- bamboo groves ----------
function buildBamboo(T, rng) {
  const group = new THREE.Group();
  const culms = [];
  const areas = [
    { x0: 42, x1: 98, z0: -96, z1: -36, n: 640 },
    { x0: -100, x1: -76, z0: -95, z1: -30, n: 330 },
    { x0: 56, x1: 92, z0: 20, z1: 48, n: 230 },
  ];
  for (const A of areas) {
    for (let i = 0; i < A.n; i++) {
      const x = rng.range(A.x0, A.x1), z = rng.range(A.z0, A.z1);
      if (simplex2(x * 0.05, z * 0.05) < -0.35) continue;
      let blocked = false;
      for (const h of layout.houses) if (Math.hypot(x - h.x, z - h.z) < Math.max(h.w, h.d) * 0.75 + 1) blocked = true;
      if (Math.hypot(x - layout.shrine.x, z - layout.shrine.z) < 9) blocked = true;
      for (const p of layout.toriiPath.pts) if (Math.hypot(x - p[0], z - p[1]) < 3.5) blocked = true;
      if (blocked) continue;
      const h = hAt(x, z);
      if (h < 0.4) continue;
      culms.push({ x, z, y: h - 0.2, H: rng.range(10, 16), r: rng.range(1.15, 1.75), lx: rng.range(-0.06, 0.06), lz: rng.range(-0.06, 0.06), ph: rng.range(0, 6.28) });
    }
  }
  const cg = new THREE.CylinderGeometry(0.055, 0.07, 1, 7, 10, true);
  cg.translate(0, 0.5, 0);
  const uv = cg.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 34);
  const aW = new Float32Array(culms.length * 2);
  const mat = windify(new THREE.MeshStandardMaterial({ map: T.bamboo, roughness: 0.55, color: new THREE.Color(1, 1, 1) }), { key: 'bamboo', localH: 1 });
  const mesh = new THREE.InstancedMesh(cg, mat, culms.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new V3(), s = new V3(), col = new THREE.Color();
  culms.forEach((c, i) => {
    q.setFromEuler(e.set(c.lx, rng.range(0, 6.28), c.lz));
    m4.compose(v.set(c.x, c.y, c.z), q, s.set(c.r, c.H, c.r));
    mesh.setMatrixAt(i, m4);
    const k = rng.range(0.75, 1.1);
    mesh.setColorAt(i, col.setRGB(k, k * rng.range(0.95, 1.05), k * 0.9));
    aW[i * 2] = 0.9; aW[i * 2 + 1] = c.ph;
  });
  cg.setAttribute('aWind', new THREE.InstancedBufferAttribute(aW, 2));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.customDepthMaterial = windDepthMaterial({ key: 'bambooD', localH: 1 });
  group.add(mesh);
  // leaves
  const cards = new CardSet();
  for (const c of culms) {
    const n = 18;
    for (let k = 0; k < n; k++) {
      const t = rng.range(0.4, 1.02);
      const p = new V3(c.x + c.lx * c.H * t, c.y + c.H * t, c.z + c.lz * c.H * t);
      const a = rng.range(0, Math.PI * 2), r = rng.range(0.3, 1.3) * (1.2 - t * 0.5);
      p.x += Math.cos(a) * r; p.z += Math.sin(a) * r;
      const nrm = new V3(Math.cos(a), 0.5, Math.sin(a)).normalize();
      const w = 0.9 * t * t;
      cards.add(p, nrm, rng.range(1.5, 2.3), w, c.ph, [0.62 * rng.range(0.85, 1.1), 0.8, 0.5], null, rng);
    }
  }
  group.add(cards.build(foliageMaterial(T.bambooLeaves, { key: 'bleaf', transl: 1.2 }), foliageDepth(T.bambooLeaves, 'bleaf')));
  return group;
}

// ---------- distant forest (card crowns) ----------
function colorize(g, c) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function buildForest(T, rng) {
  const group = new THREE.Group();
  const trees = [];
  const tries = 24000;
  for (let i = 0; i < tries; i++) {
    const r = 60 + Math.pow(rng.next(), 1.35) * 600;
    const a = rng.range(0, Math.PI * 2);
    const x = Math.sin(a) * r, z = -15 - Math.cos(a) * r;
    const h = hAt(x, z);
    const f = forestAmount(x, z, h);
    if (f < 0.22 || rng.next() > f) continue;
    const bump = 0.5 + 0.5 * simplex2(x * 0.085, z * 0.085) + 0.3 * simplex2(x * 0.21 + 4, z * 0.21);
    const canopy = f * (2.2 + 3.6 * clamp(bump, 0, 1.3));
    const y = h + canopy * 0.45;
    const kind = simplex2(x * 0.02 + 40, z * 0.02) + rng.range(-0.5, 0.5);
    const cedar = kind > 0.15;
    const pink = !cedar && rng.next() < 0.1;
    trees.push({ x, y, z, s: rng.range(9, 15) * (cedar ? 1.2 : 1), cedar, pink, ph: rng.range(0, 6.28) });
  }
  // trunks
  const tg = new THREE.CylinderGeometry(0.5, 1, 1, 5, 1, true);
  tg.translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: new THREE.Color(0.2, 0.14, 0.1) }), trees.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), sc = new V3();
  trees.forEach((t, i) => {
    m4.compose(v.set(t.x, t.y - 1.5, t.z), q.identity(), sc.set(0.03 * t.s, (t.cedar ? 0.55 : 0.45) * t.s + 1.5, 0.03 * t.s));
    trunks.setMatrixAt(i, m4);
  });
  trunks.receiveShadow = true;
  group.add(trunks);
  const broad = new CardSet(), cedar = new CardSet(), pink = new CardSet();
  for (const t of trees) {
    const s = t.s;
    if (t.cedar) {
      const y0 = t.y + 0.28 * s, y1 = t.y + 1.18 * s;
      const n = 12;
      for (let k = 0; k < n; k++) {
        const u = (k + rng.next()) / n;
        const a = rng.range(0, Math.PI * 2);
        const rad = (0.27 * (1 - u) + 0.04) * s;
        const pos = new V3(t.x + Math.cos(a) * rad * 0.75, y0 + u * (y1 - y0), t.z + Math.sin(a) * rad * 0.75);
        const nrm = new V3(Math.cos(a), 0.55, Math.sin(a)).normalize();
        const k2 = rng.range(0.8, 1.15);
        cedar.add(pos, nrm, (0.4 * (1 - u * 0.55)) * s * rng.range(0.85, 1.1), 0.05 * u, t.ph, [0.42 * k2, 0.56 * k2, 0.5 * k2], null, rng);
      }
    } else {
      const c = new V3(t.x, t.y + 0.64 * s, t.z);
      const R = 0.3 * s;
      const n = 13;
      const tint = rng.next() < 0.12 ? [1.0, 1.0, 0.6] : [0.62 * rng.range(0.85, 1.1), 0.72, 0.6 * rng.range(0.85, 1.1)];
      for (let k = 0; k < n; k++) {
        const d = new V3(rng.gauss(), rng.gauss() * 0.75, rng.gauss()).normalize().multiplyScalar(R * rng.range(0.35, 0.95));
        const pos = c.clone().add(d);
        const nrm = d.clone().add(new V3(0, 0.35 * R, 0)).normalize();
        const k2 = rng.range(0.85, 1.1);
        (t.pink ? pink : broad).add(pos, nrm, 0.5 * s * rng.range(0.8, 1.1), 0.06, t.ph, t.pink ? [1.0 * k2, 0.9 * k2, 0.93 * k2] : [tint[0] * k2, tint[1] * k2, tint[2] * k2], null, rng);
      }
    }
  }
  const add = (set, map, key, transl) => {
    if (!set.items.length) return;
    const m = set.build(foliageMaterial(map, { key, transl }), null, false);
    m.castShadow = false;
    group.add(m);
  };
  add(broad, T.leaves, 'fBroad', 0.55);
  add(cedar, T.leaves, 'fCedar', 0.35);
  add(pink, T.blossom, 'fPink', 0.8);
  return group;
}

// ---------- grass ----------
function grassClump(rng) {
  const pos = [], col = [], idx = [];
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0, 0.12);
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const h = rng.range(0.55, 1.0), w = rng.range(0.025, 0.045);
    const lean = rng.range(0.1, 0.35), la = rng.range(0, Math.PI * 2);
    const lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
    const px = -Math.sin(la) * w, pz = Math.cos(la) * w;
    const i0 = pos.length / 3;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz);
    pos.push(bx - px * 0.7 + lx * 0.35, h * 0.55, bz - pz * 0.7 + lz * 0.35, bx + px * 0.7 + lx * 0.35, h * 0.55, bz + pz * 0.7 + lz * 0.35);
    pos.push(bx + lx, h, bz + lz);
    const g = rng.range(0.85, 1.1);
    col.push(0.35 * g, 0.42 * g, 0.3 * g, 0.35 * g, 0.42 * g, 0.3 * g);
    col.push(0.75 * g, 0.85 * g, 0.55 * g, 0.75 * g, 0.85 * g, 0.55 * g);
    col.push(1.0 * g, 1.05 * g, 0.65 * g);
    idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2, i0 + 2, i0 + 3, i0 + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const n = new Float32Array(pos.length);
  for (let i = 0; i < n.length; i += 3) { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setIndex(idx);
  return g;
}

function buildGrass(T, rng) {
  const items = [];
  const N = 80000;
  for (let i = 0; i < N && items.length < 36000; i++) {
    const x = rng.range(-120, 125), z = rng.range(-98, 120);
    const h = hAt(x, z);
    if (h < 0.08) continue;
    const rx = riverXAt(z);
    if (Math.abs(x - rx) > 95) continue;
    const m = maskAt(x, z);
    if (m[0] + m[1] + m[2] > 0.25) continue;
    if (h > LAND_Y + 10) continue;
    // denser near water and tree bases
    const dens = 0.45 + 0.55 * smoothstep(0.6, -0.2, simplex2(x * 0.08, z * 0.08));
    if (rng.next() > dens) continue;
    // avoid steep
    const hx = hAt(x + 0.5, z) - h, hz = hAt(x, z + 0.5) - h;
    if (Math.hypot(hx, hz) > 0.45) continue;
    // avoid temple terrace interior + waterfall cliff
    items.push([x, h - 0.03, z, rng.range(0.6, 1.25), rng.range(0, 6.28)]);
  }
  const geo = mergeGeometries([grassClump(rng)], false);
  const mat = windify(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
    key: 'grass', localH: 1,
    extraFragment: (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
        .replace('#include <opaque_fragment>', `
          #ifdef USE_FOG
          vec3 Vg = normalize(cameraPosition - vFogWorld);
          float bkg = pow(max(dot(-Vg, SUN_DIR), 0.0), 3.0);
          outgoingLight += diffuseColor.rgb * vec3(1.0, 0.7, 0.35) * bkg * 0.9;
          #endif
          #include <opaque_fragment>`);
    },
  });
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), s = new V3(), col = new THREE.Color();
  const aW = new Float32Array(items.length * 2);
  const gA = new THREE.Color(0.22, 0.36, 0.09), gB = new THREE.Color(0.42, 0.5, 0.14);
  items.forEach((it, i) => {
    q.setFromAxisAngle(new V3(0, 1, 0), it[4]);
    m4.compose(v.set(it[0], it[1], it[2]), q, s.set(it[3], it[3] * rng.range(0.8, 1.2), it[3]));
    mesh.setMatrixAt(i, m4);
    const t = 0.5 + 0.5 * simplex2(it[0] * 0.03, it[2] * 0.03);
    col.copy(gA).lerp(gB, t).multiplyScalar(rng.range(0.85, 1.1));
    mesh.setColorAt(i, col);
    aW[i * 2] = 0.55; aW[i * 2 + 1] = rng.range(0, 6.28);
  });
  geo.setAttribute('aWind', new THREE.InstancedBufferAttribute(aW, 2));
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- flowers ----------
function buildFlowers(T, rng) {
  const items = [];
  const add = (x, z, type, s) => {
    const h = hAt(x, z);
    if (h < 0.1) return;
    items.push({ x, y: h, z, type, s, ry: rng.range(0, 6.28) });
  };
  // irises along natural banks and pond
  for (let i = 0; i < LOWER.length; i += 1) {
    const p = LOWER[i];
    if (p[1] > 180) break;
    const walled = p[1] > -68 && p[1] < 62;
    for (const side of [1, -1]) {
      if (rng.next() > (walled ? 0.18 : 0.55)) continue;
      const off = walled ? p[2] + 1.2 + rng.range(0, 1.5) : p[2] + rng.range(0.8, 3.5);
      add(p[0] - p.tz * side * off, p[1] + p.tx * side * off, 0, rng.range(0.7, 1.0));
    }
  }
  const P = layout.pond;
  for (let i = 0; i < 40; i++) {
    const a = rng.range(0, Math.PI * 2);
    const lx = Math.cos(a) * (P.rx + rng.range(0.5, 2.2)), lz = Math.sin(a) * (P.rz + rng.range(0.5, 2.2));
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    add(P.x + lx * c - lz * s, P.z + lx * s + lz * c, 0, rng.range(0.7, 1.0));
  }
  // nanohana fields
  const fields = [{ x: -55, z: 92, rx: 22, rz: 12 }, { x: 44, z: 110, rx: 18, rz: 10 }, { x: -66, z: 64, rx: 10, rz: 7 }];
  for (const F of fields) {
    for (let i = 0; i < 900; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next());
      const x = F.x + Math.cos(a) * r * F.rx, z = F.z + Math.sin(a) * r * F.rz;
      if (maskAt(x, z)[2] > 0.2 || maskAt(x, z)[0] > 0.4) continue;
      add(x, z, 1, rng.range(0.8, 1.2));
    }
  }
  // wildflowers scattered
  for (let i = 0; i < 2600; i++) {
    const x = rng.range(-110, 110), z = rng.range(-95, 110);
    const m = maskAt(x, z);
    if (m[0] + m[1] + m[2] > 0.2) continue;
    if (simplex2(x * 0.06, z * 0.06) < 0.2) continue;
    if (hAt(x, z) > LAND_Y + 6) continue;
    add(x, z, 2, rng.range(0.5, 0.8));
  }
  // cross-quad geometry with atlas offset per instance
  const q1 = new THREE.PlaneGeometry(1, 1); q1.translate(0, 0.5, 0);
  const q2 = q1.clone(); q2.rotateY(Math.PI / 2);
  const geo = mergeGeometries([q1, q2], false);
  const aA = new Float32Array(items.length * 2), aW = new Float32Array(items.length * 2);
  const mat = windify(new THREE.MeshLambertMaterial({ map: T.flowers, alphaTest: 0.45, side: THREE.DoubleSide }), {
    key: 'flowers', localH: 1, extraVertex: 'attribute vec2 aAtlas;\n',
    extraFragment: (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * 0.5 + aAtlas;');
    },
  });
  mat.alphaToCoverage = true;
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), s = new V3();
  const atl = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];
  items.forEach((it, i) => {
    q.setFromAxisAngle(new V3(0, 1, 0), it.ry);
    const sz = it.s * (it.type === 1 ? 0.9 : it.type === 0 ? 0.85 : 0.45);
    m4.compose(v.set(it.x, it.y - 0.02, it.z), q, s.set(sz, sz, sz));
    mesh.setMatrixAt(i, m4);
    aA[i * 2] = atl[it.type][0]; aA[i * 2 + 1] = atl[it.type][1];
    aW[i * 2] = 0.5; aW[i * 2 + 1] = rng.range(0, 6.28);
  });
  geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(aA, 2));
  geo.setAttribute('aWind', new THREE.InstancedBufferAttribute(aW, 2));
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- shrubs (pruned azaleas & boxwood) ----------
function buildShrubs(T, rng) {
  const items = [];
  const addShrub = (x, z, s, azalea) => { const h = hAt(x, z); if (h > 0.2) items.push({ x, y: h, z, s, azalea }); };
  for (const H of layout.houses) {
    if (!rng.chance(0.65)) continue;
    const c = Math.cos(H.rot), s = Math.sin(H.rot);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-H.w / 2, H.w / 2), lz = H.d / 2 + rng.range(1.2, 2.2);
      addShrub(H.x + lx * c + lz * s, H.z - lx * s + lz * c, rng.range(0.6, 1.1), rng.chance(0.5));
    }
  }
  const P = layout.pond;
  for (let i = 0; i < 16; i++) {
    const a = rng.range(0, Math.PI * 2);
    const lx = Math.cos(a) * (P.rx + rng.range(2.5, 5)), lz = Math.sin(a) * (P.rz + rng.range(2.5, 5));
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    addShrub(P.x + lx * c - lz * s, P.z + lx * s + lz * c, rng.range(0.7, 1.4), rng.chance(0.6));
  }
  const TT = layout.terrace;
  for (let i = 0; i < 18; i++) {
    const x = TT.x + TT.w / 2 - rng.range(1.5, 3.5), z = TT.z + rng.range(-TT.d / 2 + 2, TT.d / 2 - 2);
    if (Math.abs(z - layout.steps.z) < 5) continue;
    items.push({ x, y: TT.h, z, s: rng.range(0.7, 1.1), azalea: rng.chance(0.5) });
  }
  let g = new THREE.IcosahedronGeometry(1, 2);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = 1 + 0.12 * fbm3(x * 2.5, y * 2.5, z * 2.5, 3);
    p.setXYZ(i, x * f, Math.max(y * f * 0.9, -0.35), z * f);
  }
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, color: 0xffffff, map: T.leaves });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSP = position * 3.0;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSP;')
      .replace('#include <map_fragment>', `
        vec3 bwt = abs(normalize(vSP)); bwt /= (bwt.x+bwt.y+bwt.z);
        vec4 lt = texture2D(map, vSP.zy*0.5)*bwt.x + texture2D(map, vSP.xz*0.5)*bwt.y + texture2D(map, vSP.xy*0.5)*bwt.z;
        diffuseColor.rgb *= mix(vec3(0.55), lt.rgb * 1.6, 0.7);
      `);
  };
  const mesh = new THREE.InstancedMesh(g, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), s = new V3(), col = new THREE.Color();
  const azC = [new THREE.Color(1.3, 0.25, 0.55), new THREE.Color(1.35, 0.5, 0.75), new THREE.Color(1.2, 0.3, 0.7)];
  items.forEach((it, i) => {
    q.setFromAxisAngle(new V3(0, 1, 0), rng.range(0, 6.28));
    m4.compose(v.set(it.x, it.y + it.s * 0.3, it.z), q, s.set(it.s * 1.15, it.s * 0.95, it.s * 1.1));
    mesh.setMatrixAt(i, m4);
    if (it.azalea) col.copy(azC[rng.int(0, 2)]).multiplyScalar(0.9);
    else col.setRGB(0.3, 0.52, 0.16).multiplyScalar(rng.range(0.8, 1.2));
    mesh.setColorAt(i, col);
  });
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
