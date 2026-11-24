import * as THREE from 'three';
import { Geo, RNG, clamp, PALETTE } from './util.js';
import { PITCH, ROAD_HALF } from './layout.js';
import { LANE_ALTS } from './city.js';
import { FOG_PARS } from './glsl.js';
import { U, patchStandard } from './materials.js';
import { makeBeamMaterial, coneGeometry } from './fx.js';

// ------------------------------------------------------------------ modelling helpers
function loft(sections, segs = 18) {
  const pos = [], idx = [], uv = [];
  const ns = sections.length;
  for (let i = 0; i < ns; i++) {
    const s = sections[i]; const mid = (s.yb + s.yt) / 2, hh = (s.yt - s.yb) / 2; const e = 2 / s.n;
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2; const c = Math.cos(th), sn = Math.sin(th);
      const x = s.hw * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = mid + hh * Math.sign(sn) * Math.pow(Math.abs(sn), e);
      pos.push(x, y, s.z); uv.push(k / segs, i / (ns - 1));
    }
  }
  const rs = segs + 1;
  for (let i = 0; i < ns - 1; i++) for (let k = 0; k < segs; k++) {
    const a = i * rs + k, b = a + 1, c = a + rs, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  // caps
  for (const [i, flip] of [[0, true], [ns - 1, false]]) {
    const s = sections[i]; const ci = pos.length / 3; pos.push(0, (s.yb + s.yt) / 2, s.z); uv.push(0.5, 0.5);
    for (let k = 0; k < segs; k++) { const a = i * rs + k, b = a + 1; if (flip) idx.push(ci, b, a); else idx.push(ci, a, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function podMatrix(x, y, z, sc = 1) {
  return new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(sc, sc, sc));
}

function L(g, type, p1 = 0, p2 = 0) { g.set('aLight', type, p1, p2, 0); }

function addTrail(lg, x, y, z) {
  L(lg, 5, 0, z);
  lg.quad([x - 0.07, y, z], [x + 0.07, y, z], [x + 0.07, y, z - 1], [x - 0.07, y, z - 1], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  lg.quad([x, y - 0.06, z], [x, y + 0.06, z], [x, y + 0.06, z - 1], [x, y - 0.06, z - 1], [1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
}

function buildCoupe(police = false) {
  const b = new Geo({ color: 3 }), lg = new Geo({ aLight: 4 });
  b.set('color', 1, 1, 1);
  b.addGeometry(loft([
    { z: -2.55, hw: 0.8, yb: 0.42, yt: 0.86, n: 5 }, { z: -2.38, hw: 0.98, yb: 0.28, yt: 0.98, n: 4 },
    { z: -1.3, hw: 1.04, yb: 0.22, yt: 1.0, n: 3.6 }, { z: 0.2, hw: 1.02, yb: 0.2, yt: 0.95, n: 3.6 },
    { z: 1.4, hw: 0.95, yb: 0.24, yt: 0.78, n: 3.2 }, { z: 2.15, hw: 0.75, yb: 0.3, yt: 0.62, n: 3 }, { z: 2.62, hw: 0.4, yb: 0.38, yt: 0.52, n: 3 },
  ], 22));
  b.set('color', 0.015, 0.017, 0.025);
  b.addGeometry(loft([
    { z: -1.5, hw: 0.55, yb: 0.9, yt: 0.97, n: 3 }, { z: -0.9, hw: 0.75, yb: 0.92, yt: 1.36, n: 3 }, { z: 0.15, hw: 0.79, yb: 0.92, yt: 1.42, n: 3 },
    { z: 0.95, hw: 0.71, yb: 0.88, yt: 1.18, n: 3 }, { z: 1.5, hw: 0.48, yb: 0.8, yt: 0.86, n: 3 },
  ], 18));
  // thruster pods
  b.set('color', 0.06, 0.06, 0.07);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.setMatrix(podMatrix(sx * 1.13, 0.42, sz * 1.5));
    b.lathe(0, 0, [[0.0, -0.62], [0.24, -0.58], [0.33, -0.4], [0.34, 0.25], [0.27, 0.52], [0.0, 0.6]], 12);
    b.setMatrix(null);
    lg.setMatrix(podMatrix(sx * 1.13, 0.42, sz * 1.5));
    L(lg, 3); lg.cylinder(0, 0, 0.22, 0.22, -0.66, -0.6, 12, true);
    lg.setMatrix(null);
    L(lg, 3); lg.cylinder(sx * 1.13, sz * 1.5, 0.2, 0.2, 0.06, 0.1, 10, true);
  }
  // spoiler
  b.set('color', 0.05, 0.05, 0.06);
  b.box(-1.0, 1.0, 1.08, 1.14, -2.62, -2.22);
  b.box(-0.55, -0.48, 0.9, 1.08, -2.5, -2.3); b.box(0.48, 0.55, 0.9, 1.08, -2.5, -2.3);
  // lights
  L(lg, 0); lg.box(-0.72, -0.34, 0.52, 0.6, 2.12, 2.34); lg.box(0.34, 0.72, 0.52, 0.6, 2.12, 2.34);
  L(lg, 2); lg.box(-0.3, 0.3, 0.44, 0.47, 2.56, 2.66);
  L(lg, 1); lg.box(-0.88, 0.88, 0.66, 0.73, -2.6, -2.5);
  L(lg, 2); lg.box(-1.06, -1.0, 0.22, 0.27, -1.7, 1.6); lg.box(1.0, 1.06, 0.22, 0.27, -1.7, 1.6);
  addTrail(lg, -0.7, 0.69, -2.6); addTrail(lg, 0.7, 0.69, -2.6);
  if (police) {
    b.set('color', 0.05, 0.05, 0.06); b.box(-0.55, 0.55, 1.4, 1.48, -0.3, 0.3);
    L(lg, 4, 0); lg.box(-0.52, -0.05, 1.48, 1.6, -0.22, 0.22);
    L(lg, 4, 1); lg.box(0.05, 0.52, 1.48, 1.6, -0.22, 0.22);
  }
  return { body: b, lights: lg, beam: { z: 2.5, y: 0.56, r: 3.5, len: 26 }, half: 2.6 };
}

function buildVan() {
  const b = new Geo({ color: 3 }), lg = new Geo({ aLight: 4 });
  b.set('color', 1, 1, 1);
  b.addGeometry(loft([
    { z: -2.8, hw: 1.0, yb: 0.35, yt: 1.6, n: 7 }, { z: -2.6, hw: 1.08, yb: 0.25, yt: 1.7, n: 6 }, { z: 1.2, hw: 1.08, yb: 0.25, yt: 1.7, n: 6 },
    { z: 2.2, hw: 1.04, yb: 0.28, yt: 1.25, n: 5 }, { z: 2.8, hw: 0.9, yb: 0.35, yt: 0.8, n: 4 }, { z: 3.0, hw: 0.7, yb: 0.42, yt: 0.62, n: 4 },
  ], 22));
  b.set('color', 0.015, 0.017, 0.025);
  b.addGeometry(loft([{ z: 1.15, hw: 1.0, yb: 1.05, yt: 1.62, n: 6 }, { z: 1.9, hw: 1.03, yb: 1.0, yt: 1.42, n: 5 }, { z: 2.55, hw: 0.95, yb: 0.92, yt: 1.08, n: 4 }], 18));
  b.set('color', 0.015, 0.017, 0.025);
  b.box(-1.1, 1.1, 1.0, 1.35, -2.3, 0.9);
  b.set('color', 0.06, 0.06, 0.07);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.setMatrix(podMatrix(sx * 1.25, 0.45, sz * 1.8, 1.1));
    b.lathe(0, 0, [[0.0, -0.6], [0.26, -0.55], [0.34, -0.38], [0.35, 0.28], [0.28, 0.5], [0.0, 0.58]], 12);
    b.setMatrix(null);
    L(lg, 3); lg.cylinder(sx * 1.25, sz * 1.8, 0.24, 0.24, 0.06, 0.1, 10, true);
  }
  b.set('color', 0.05, 0.05, 0.06); b.box(-0.45, 0.45, 1.7, 1.78, -0.5, 0.5);
  L(lg, 2); lg.box(-0.4, 0.4, 1.78, 1.98, -0.42, 0.42);
  L(lg, 0); lg.box(-0.85, -0.4, 0.62, 0.72, 2.75, 2.92); lg.box(0.4, 0.85, 0.62, 0.72, 2.75, 2.92);
  L(lg, 1); lg.box(-1.0, -0.75, 0.5, 1.4, -2.84, -2.76); lg.box(0.75, 1.0, 0.5, 1.4, -2.84, -2.76);
  L(lg, 2); lg.box(-1.1, -1.08, 0.3, 0.34, -2.4, 2.2); lg.box(1.08, 1.1, 0.3, 0.34, -2.4, 2.2);
  addTrail(lg, -0.88, 0.95, -2.85); addTrail(lg, 0.88, 0.95, -2.85);
  return { body: b, lights: lg, beam: { z: 2.9, y: 0.67, r: 4, len: 26 }, half: 3.0 };
}

function buildHauler() {
  const b = new Geo({ color: 3 }), lg = new Geo({ aLight: 4 });
  b.set('color', 1, 1, 1);
  // cab
  b.addGeometry(loft([
    { z: 2.0, hw: 1.5, yb: 0.6, yt: 3.0, n: 6 }, { z: 3.6, hw: 1.5, yb: 0.6, yt: 2.8, n: 5 }, { z: 4.5, hw: 1.3, yb: 0.8, yt: 2.0, n: 4 }, { z: 4.9, hw: 0.9, yb: 1.0, yt: 1.6, n: 4 },
  ], 20));
  b.set('color', 0.015, 0.017, 0.025);
  b.addGeometry(loft([{ z: 3.4, hw: 1.42, yb: 2.0, yt: 2.78, n: 5 }, { z: 4.2, hw: 1.3, yb: 1.75, yt: 2.25, n: 4 }, { z: 4.55, hw: 1.1, yb: 1.6, yt: 1.9, n: 4 }], 16));
  // container with ribs
  b.set('color', 0.55, 0.55, 0.58);
  b.box(-1.65, 1.65, 0.4, 3.4, -6.5, 1.9);
  b.set('color', 0.25, 0.25, 0.27);
  for (let z = -6.3; z < 1.9; z += 0.55) { b.box(-1.72, -1.65, 0.45, 3.35, z, z + 0.14, 'n'); b.box(1.65, 1.72, 0.45, 3.35, z, z + 0.14, 'n'); }
  b.box(-1.7, 1.7, 3.4, 3.5, -6.55, 1.95);
  // thruster nacelles underneath
  b.set('color', 0.06, 0.06, 0.07);
  for (const sz of [-5.2, -2.2, 0.8, 3.4]) for (const sx of [-1, 1]) {
    b.cylinder(sx * 1.25, sz, 0.55, 0.5, 0.0, 0.42, 12, true);
    L(lg, 3); lg.cylinder(sx * 1.25, sz, 0.45, 0.45, -0.04, 0.0, 12, true);
  }
  L(lg, 0); lg.box(-1.2, -0.5, 1.15, 1.3, 4.6, 4.75); lg.box(0.5, 1.2, 1.15, 1.3, 4.6, 4.75);
  L(lg, 1); lg.box(-1.6, 1.6, 0.6, 0.75, -6.62, -6.55);
  L(lg, 6); for (const sx of [-1, 1]) for (let z = -6.2; z < 1.9; z += 2.0) lg.box(sx * 1.73 - 0.05, sx * 1.73 + 0.05, 3.3, 3.45, z, z + 0.25);
  L(lg, 2); lg.box(-1.7, 1.7, 3.5, 3.58, 1.75, 1.95);
  addTrail(lg, -1.3, 0.68, -6.62); addTrail(lg, 1.3, 0.68, -6.62);
  return { body: b, lights: lg, beam: { z: 4.7, y: 1.2, r: 5, len: 30 }, half: 6.6 };
}

function buildBike() {
  const b = new Geo({ color: 3 }), lg = new Geo({ aLight: 4 });
  b.set('color', 1, 1, 1);
  b.addGeometry(loft([
    { z: -1.3, hw: 0.2, yb: 0.55, yt: 0.8, n: 3 }, { z: -0.9, hw: 0.32, yb: 0.4, yt: 0.95, n: 3 }, { z: 0.3, hw: 0.36, yb: 0.35, yt: 0.95, n: 3 }, { z: 1.1, hw: 0.28, yb: 0.42, yt: 0.85, n: 3 }, { z: 1.45, hw: 0.12, yb: 0.55, yt: 0.68, n: 3 },
  ], 14));
  b.set('color', 0.03, 0.03, 0.035);
  // rider silhouette
  b.addGeometry(loft([{ z: -0.6, hw: 0.2, yb: 0.9, yt: 1.2, n: 2.5 }, { z: -0.2, hw: 0.24, yb: 0.92, yt: 1.45, n: 2.5 }, { z: 0.2, hw: 0.2, yb: 1.0, yt: 1.42, n: 2.5 }, { z: 0.45, hw: 0.12, yb: 1.1, yt: 1.3, n: 2.5 }], 10));
  b.set('color', 0.06, 0.06, 0.07);
  for (const sz of [-1.0, 1.1]) {
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, 0.5, sz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
    b.lathe(0, 0, [[0.0, -0.22], [0.35, -0.2], [0.42, 0.0], [0.35, 0.2], [0.0, 0.22]], 14);
    b.setMatrix(null);
    lg.setMatrix(new THREE.Matrix4().makeTranslation(0, 0.5, sz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
    L(lg, 2); lg.lathe(0, 0, [[0.43, -0.05], [0.45, 0.0], [0.43, 0.05]], 18);
    lg.setMatrix(null);
  }
  L(lg, 0); lg.box(-0.1, 0.1, 0.62, 0.7, 1.4, 1.5);
  L(lg, 1); lg.box(-0.15, 0.15, 0.66, 0.72, -1.33, -1.28);
  addTrail(lg, 0, 0.69, -1.33);
  return { body: b, lights: lg, beam: { z: 1.45, y: 0.66, r: 2.5, len: 20 }, half: 1.5 };
}

// ------------------------------------------------------------------ materials
function makeLightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec4 aLight; attribute vec4 aInst;
      uniform float uTime;
      varying vec3 vCol; varying vec3 vWP;
      void main(){
        vec3 p = position; float type = aLight.x;
        vec3 ic = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          ic = instanceColor;
        #endif
        vec3 col;
        if (type < 0.5) col = vec3(0.85, 0.92, 1.0) * 14.0;
        else if (type < 1.5) col = vec3(1.0, 0.04, 0.03) * 9.0;
        else if (type < 2.5) col = ic * 5.0;
        else if (type < 3.5) col = mix(vec3(0.35, 0.6, 1.0), ic, 0.35) * (6.0 + 1.5 * sin(uTime * 37.0 + aInst.y * 20.0));
        else if (type < 4.5) { float s = step(0.5, fract(uTime * 2.6 + aInst.y)); float s2 = step(0.5, fract(uTime * 10.0)); col = aLight.y < 0.5 ? vec3(1.0, 0.02, 0.03) * 14.0 * s * s2 : vec3(0.05, 0.2, 1.0) * 14.0 * (1.0 - s) * s2; }
        else if (type < 5.5) {
          float Lr = clamp(aInst.x * 0.11, 0.0, 6.0);
          p.z = aLight.z - uv.y * Lr;
          col = vec3(1.0, 0.05, 0.04) * 2.2 * pow(1.0 - uv.y, 1.5);
        }
        else col = vec3(1.0, 0.45, 0.05) * 7.0 * step(0.55, fract(uTime * 1.3 + aInst.y));
        vCol = col;
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec3 vWP;
      ${FOG_PARS}
      void main(){
        vec3 c = applyFogAdd(vCol, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// ------------------------------------------------------------------ traffic
const NODE_I = [-3, 4], NODE_J = [-6, 2];
const R_TURN = 11;

export class Traffic {
  constructor(scene) {
    this.rng = new RNG(2024);
    const bodyMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.28, envMapIntensity: 1.4 }), 'veh');
    const lightMat = makeLightsMaterial();
    const beamMat = makeBeamMaterial(); beamMat.uniforms.uInten.value = 0.07;
    const cone = coneGeometry(14);
    const defs = [
      { name: 'coupe', model: buildCoupe(false), count: 110, speed: [26, 40], paints: [[0.6, 0.62, 0.66], [0.08, 0.08, 0.09], [0.5, 0.05, 0.08], [0.06, 0.2, 0.45], [0.75, 0.75, 0.78], [0.35, 0.3, 0.05], [0.1, 0.3, 0.28]] },
      { name: 'van', model: buildVan(), count: 50, speed: [22, 32], paints: [[0.8, 0.55, 0.05], [0.85, 0.85, 0.85], [0.75, 0.28, 0.04], [0.12, 0.14, 0.16]] },
      { name: 'police', model: buildCoupe(true), count: 10, speed: [38, 48], paints: [[0.04, 0.05, 0.08], [0.8, 0.82, 0.85]] },
      { name: 'hauler', model: buildHauler(), count: 22, speed: [16, 22], paints: [[0.6, 0.6, 0.6], [0.5, 0.35, 0.1], [0.2, 0.25, 0.3]] },
      { name: 'bike', model: buildBike(), count: 30, speed: [32, 46], paints: [[0.8, 0.1, 0.3], [0.1, 0.6, 0.8], [0.9, 0.9, 0.9], [0.1, 0.1, 0.1]] },
    ];
    this.types = [];
    this.vehicles = [];
    const accents = [PALETTE.cyan, PALETTE.magenta, PALETTE.pink, PALETTE.blue, PALETTE.violet, PALETTE.teal, PALETTE.orange];
    let total = 0;
    for (const d of defs) {
      const bodyGeo = d.model.body.build();
      const lightGeo = d.model.lights.build();
      const inst = new Float32Array(d.count * 4);
      const instAttr = new THREE.InstancedBufferAttribute(inst, 4); instAttr.setUsage(THREE.DynamicDrawUsage);
      lightGeo.setAttribute('aInst', instAttr);
      const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, d.count);
      const lightMesh = new THREE.InstancedMesh(lightGeo, lightMat, d.count);
      const beamMesh = new THREE.InstancedMesh(cone, beamMat, d.count);
      for (const m of [bodyMesh, lightMesh, beamMesh]) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
      beamMesh.layers.set(1);
      scene.add(bodyMesh, lightMesh, beamMesh);
      const t = { def: d, bodyMesh, lightMesh, beamMesh, instAttr, model: d.model };
      this.types.push(t);
      const c = new THREE.Color();
      for (let i = 0; i < d.count; i++) {
        const p = this.rng.pick(d.paints); c.setRGB(p[0], p[1], p[2]);
        bodyMesh.setColorAt(i, c);
        const ac = d.name === 'police' ? PALETTE.blue : this.rng.pick(accents);
        lightMesh.setColorAt(i, ac);
        beamMesh.setColorAt(i, new THREE.Color(0.75, 0.85, 1.0));
        const v = this.spawn(t, i);
        this.vehicles.push(v); total++;
      }
    }
    // parked hover cars along the low avenue
    this.parked = [];
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler(); this._p = new THREE.Vector3();
    this._beamLocal = new THREE.Matrix4();
    this._tmp = new THREE.Matrix4();
  }
  nodePos(i, j, out) { return out.set(i * PITCH, 0, j * PITCH); }
  spawn(t, idx) {
    const r = this.rng;
    const v = { t, idx, speed: r.range(...t.def.speed), phase: r.f() * 100, dodge: 0, roll: 0, pitch: 0, yaw: 0, prevYaw: null, curSpeed: 0 };
    v.base = v.speed;
    v.alt = r.pick(LANE_ALTS);
    if (t.def.name === 'hauler') v.alt = r.pick([66, 88, 100, 126]);
    v.laneOff = r.chance(0.5) ? 3.6 : 7.2;
    if (t.def.name === 'hauler') v.laneOff = 4.2;
    v.i = r.int(NODE_I[0] + 1, NODE_I[1] - 1); v.j = r.int(NODE_J[0] + 1, NODE_J[1] - 1);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    v.dir = r.pick(dirs);
    this.startLeg(v);
    v.s = r.f() * v.curve.len;
    v.pos = new THREE.Vector3();
    return v;
  }
  right(d) { return [-d[1], d[0]]; }
  startLeg(v) {
    const d = v.dir, rr = this.right(d);
    const N0 = [v.i * PITCH, v.j * PITCH], N1 = [(v.i + d[0]) * PITCH, (v.j + d[1]) * PITCH];
    const p0 = new THREE.Vector3(N0[0] + d[0] * R_TURN + rr[0] * v.laneOff, v.alt, N0[1] + d[1] * R_TURN + rr[1] * v.laneOff);
    const p1 = new THREE.Vector3(N1[0] - d[0] * R_TURN + rr[0] * v.laneOff, v.alt, N1[1] - d[1] * R_TURN + rr[1] * v.laneOff);
    v.curve = { kind: 'line', p0, p1, len: p0.distanceTo(p1), y0: v.alt, y1: v.alt };
    v.key = `${v.i},${v.j},${d[0]},${d[1]},${v.laneOff},${v.alt}`;
  }
  startTurn(v) {
    const r = this.rng; const d = v.dir;
    const ni = v.i + d[0], nj = v.j + d[1];
    const opts = [];
    const cand = [[d, 6], [[-d[1], d[0]], 2], [[d[1], -d[0]], 2]];
    for (const [nd, w] of cand) {
      const ti = ni + nd[0], tj = nj + nd[1];
      if (ti < NODE_I[0] || ti > NODE_I[1] || tj < NODE_J[0] || tj > NODE_J[1]) continue;
      opts.push([nd, w]);
    }
    const nd = opts.length ? r.weighted(opts) : [-d[0], -d[1]];
    let nAlt = v.alt;
    if (r.chance(0.3)) {
      const k = LANE_ALTS.indexOf(v.alt); const kk = clamp(k + r.sign(), 0, LANE_ALTS.length - 1); nAlt = LANE_ALTS[kk];
      if (v.t.def.name === 'hauler' && nAlt < 60) nAlt = v.alt;
    }
    const N = new THREE.Vector3(ni * PITCH, 0, nj * PITCH);
    const r1 = this.right(d), r2 = this.right(nd);
    const p0 = v.curve.p1.clone();
    const p1 = new THREE.Vector3(N.x + nd[0] * R_TURN + r2[0] * v.laneOff, nAlt, N.z + nd[1] * R_TURN + r2[1] * v.laneOff);
    let c;
    if (nd[0] === d[0] && nd[1] === d[1]) c = p0.clone().add(p1).multiplyScalar(0.5);
    else if (nd[0] === -d[0] && nd[1] === -d[1]) c = new THREE.Vector3(N.x + d[0] * R_TURN * 1.5, v.alt, N.z + d[1] * R_TURN * 1.5);
    else c = new THREE.Vector3(N.x + r1[0] * v.laneOff + r2[0] * v.laneOff, v.alt, N.z + r1[1] * v.laneOff + r2[1] * v.laneOff);
    // approximate bezier length
    let len = 0; const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let k = 0; k <= 10; k++) { this.bez(p0, c, p1, k / 10, b); if (k) len += a.distanceTo(b); a.copy(b); }
    v.curve = { kind: 'bez', p0, c, p1, len: Math.max(len, 1), y0: v.alt, y1: nAlt };
    v.i = ni; v.j = nj; v.dir = nd; v.alt = nAlt;
    v.key = null;
  }
  bez(p0, c, p1, t, out) {
    const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
    return out.set(a * p0.x + b * c.x + d * p1.x, a * p0.y + b * c.y + d * p1.y, a * p0.z + b * c.z + d * p1.z);
  }
  evalCurve(v, s, out) {
    const cv = v.curve; const t = clamp(s / cv.len, 0, 1);
    if (cv.kind === 'line') out.lerpVectors(cv.p0, cv.p1, t);
    else this.bez(cv.p0, cv.c, cv.p1, t, out);
    const st = t * t * (3 - 2 * t);
    out.y = cv.y0 + (cv.y1 - cv.y0) * st;
    return out;
  }
  update(dt, time, camPos) {
    dt = Math.min(dt, 0.05);
    // car following on straight legs
    const groups = new Map();
    for (const v of this.vehicles) { if (v.curve.kind === 'line') { let g = groups.get(v.key); if (!g) { g = []; groups.set(v.key, g); } g.push(v); } v.limit = v.base; }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => b.s - a.s);
      for (let k = 1; k < g.length; k++) {
        const lead = g[k - 1], v = g[k]; const gap = lead.s - v.s - lead.t.model.half - v.t.model.half;
        if (gap < 14) v.limit = Math.min(v.limit, Math.max(0, lead.curSpeed * (gap < 4 ? 0.7 : 1.0)));
      }
    }
    const P = this._p; const ahead = this._ahead || (this._ahead = new THREE.Vector3());
    for (const v of this.vehicles) {
      const turnSlow = v.curve.kind === 'bez' ? 0.8 : 1.0;
      const target = Math.min(v.limit, v.base * turnSlow);
      v.curSpeed += (target - v.curSpeed) * Math.min(1, dt * 1.5);
      v.s += v.curSpeed * dt;
      let guard = 0;
      while (v.s >= v.curve.len && guard++ < 3) {
        v.s -= v.curve.len;
        if (v.curve.kind === 'line') this.startTurn(v); else this.startLeg(v);
      }
      this.evalCurve(v, v.s, P);
      this.evalCurve(v, v.s + 2.0, ahead);
      const dx = ahead.x - P.x, dz = ahead.z - P.z, dy = ahead.y - P.y;
      const yaw = Math.atan2(dx, dz);
      if (v.prevYaw === null) v.prevYaw = yaw;
      let dyaw = yaw - v.prevYaw; while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yawRate = dyaw / Math.max(dt, 1e-3);
      v.prevYaw = yaw;
      const targetRoll = clamp(-yawRate * v.curSpeed * 0.022, -0.75, 0.75);
      v.roll += (targetRoll - v.roll) * Math.min(1, dt * 4);
      const targetPitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)) * 0.9, -0.5, 0.5) - Math.min(0.06, (v.curSpeed - v.base * 0.9) * 0.0);
      v.pitch += (targetPitch - v.pitch) * Math.min(1, dt * 3);
      // dodge the camera
      const dc = P.distanceTo(camPos);
      const dodgeT = dc < 12 ? (12 - dc) * 0.9 * (P.y >= camPos.y ? 1 : -1) : 0;
      v.dodge += (dodgeT - v.dodge) * Math.min(1, dt * 3);
      P.y += v.dodge + Math.sin(time * 1.3 + v.phase) * 0.18;
      v.pos.copy(P);
      this._e.set(v.pitch, yaw, v.roll, 'YXZ');
      this._q.setFromEuler(this._e);
      this._m.compose(P, this._q, this._s);
      const t = v.t;
      t.bodyMesh.setMatrixAt(v.idx, this._m);
      t.lightMesh.setMatrixAt(v.idx, this._m);
      const bm = t.model.beam;
      this._beamLocal.makeTranslation(0, bm.y, bm.z).multiply(this._tmp.makeRotationX(-Math.PI / 2 + 0.12)).multiply(this._tmp.makeScale(bm.r, bm.len, bm.r * 0.65));
      t.beamMesh.setMatrixAt(v.idx, this._tmp.multiplyMatrices(this._m, this._beamLocal));
      const ia = t.instAttr.array; ia[v.idx * 4] = v.curSpeed; ia[v.idx * 4 + 1] = v.phase;
    }
    for (const t of this.types) { t.bodyMesh.instanceMatrix.needsUpdate = true; t.lightMesh.instanceMatrix.needsUpdate = true; t.beamMesh.instanceMatrix.needsUpdate = true; t.instAttr.needsUpdate = true; }
  }
}
