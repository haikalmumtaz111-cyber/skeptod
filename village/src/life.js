// Animated life: falling petals, water ripples, dust motes, fireflies, mist, spray,
// chimney smoke, birds, koi and swaying paper lanterns.
import * as THREE from 'three';
import { RNG, clamp, simplex2 } from './noise.js';
import { hAt, waterAt, flowAt, layout, LOWER, riverXAt, WATER_Y, SUN_DIR } from './world.js';
import { sakuraClusters } from './vegetation.js';
import { ATMO_GLSL, U } from './shaders.js';

const V3 = THREE.Vector3;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new V3(), tmpP = new V3(), tmpA = new V3();

export function windAt(x, y, z, t) {
  const g = 0.65 + 0.35 * Math.sin(t * 0.42 + x * 0.021 + z * 0.013) * Math.sin(t * 0.27 + z * 0.031 + 1.3);
  const wx = 1.25 * g + 0.45 * Math.sin(t * 0.9 + y * 0.7 + z * 0.11);
  const wz = 0.62 * g + 0.4 * Math.cos(t * 0.77 + x * 0.09);
  return [wx, wz];
}

// ---------------- ripples ----------------
class Ripples {
  constructor() {
    this.N = 140;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.aRip = new Float32Array(this.N * 2);
    g.setAttribute('aRip', new THREE.InstancedBufferAttribute(this.aRip, 2));
    const m = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec2 aRip; varying vec2 vUv; varying float vAge; varying float vStr;
        void main(){ vUv = uv; vAge = aRip.x; vStr = aRip.y; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vAge; varying float vStr;
        void main(){
          float r = length(vUv - 0.5) * 2.0;
          float ring = exp(-pow((r - vAge) * 16.0, 2.0)) + 0.55 * exp(-pow((r - vAge * 0.62) * 20.0, 2.0));
          float a = ring * (1.0 - vAge) * (1.0 - vAge) * vStr * step(r, 1.0);
          gl_FragColor = vec4(vec3(1.0, 0.82, 0.66) * a * 0.55, 0.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(g, m, this.N);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.items = [];
    for (let i = 0; i < this.N; i++) this.items.push({ x: 0, y: -100, z: 0, age: 1, life: 1, size: 1, str: 0 });
    this.cursor = 0;
    this.mesh.layers.set(2);
  }
  spawn(x, y, z, size = 1, str = 1, life = 1.8) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.N;
    Object.assign(it, { x, y: y + 0.03, z, age: 0, life, size, str });
  }
  update(dt) {
    for (let i = 0; i < this.N; i++) {
      const it = this.items[i];
      it.age = Math.min(1, it.age + dt / it.life);
      tmpM.makeScale(it.size * 2, 1, it.size * 2).setPosition(it.x, it.age >= 1 ? -1000 : it.y, it.z);
      this.mesh.setMatrixAt(i, tmpM);
      this.aRip[i * 2] = it.age; this.aRip[i * 2 + 1] = it.str;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aRip.needsUpdate = true;
  }
}

// ---------------- falling petals ----------------
class Petals {
  constructor(T, ripples) {
    this.N = 3000;
    this.ripples = ripples;
    const g = new THREE.PlaneGeometry(1, 1, 2, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setZ(i, x * x * 0.35); }
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ map: T.petal, alphaTest: 0.35, side: THREE.DoubleSide, color: new THREE.Color(1.0, 0.9, 0.93), emissive: new THREE.Color(0.55, 0.3, 0.34) });
    this.mesh = new THREE.InstancedMesh(g, m, this.N);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(2);
    this.rng = new RNG(99);
    this.s = [];
    for (let i = 0; i < this.N; i++) {
      const st = { p: new V3(), v: new V3(), axis: new V3(), ang: 0, spin: 0, mode: 0, timer: 0, size: 0.07, ph: 0, flow: [0, 0], flowT: 0, yaw: 0, scale: 1 };
      this.s.push(st);
    }
    this.camPos = new V3(0, 30, 60);
    for (let i = 0; i < this.N; i++) { this.spawn(this.s[i], true); }
  }
  spawn(st, initial = false) {
    const r = this.rng;
    const cam = this.camPos;
    if (r.next() < 0.5 && sakuraClusters.length) {
      let best = null, bd = 1e9;
      for (let k = 0; k < 5; k++) {
        const c = sakuraClusters[Math.floor(r.next() * sakuraClusters.length)];
        const d = Math.hypot(c.x - cam.x, c.z - cam.z);
        if (d < bd) { bd = d; best = c; }
      }
      st.p.set(best.x + r.gauss() * best.r, best.y + r.gauss() * best.r * 0.5, best.z + r.gauss() * best.r);
      if (initial) st.p.y -= r.range(0, best.y - hAt(best.x, best.z));
    } else {
      const a = r.range(0, Math.PI * 2), d = r.range(2.5, 30);
      const x = cam.x + Math.cos(a) * d - 8, z = cam.z + Math.sin(a) * d - 4;
      const g = hAt(x, z);
      st.p.set(x, Math.max(g + 2, cam.y + r.range(-6, 10)), z);
      if (st.p.y > g + 22) st.p.y = g + r.range(4, 18);
    }
    st.v.set(0, -0.6, 0);
    st.axis.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
    st.ang = r.range(0, 6.28); st.spin = r.range(2, 6) * r.sign();
    st.mode = 0; st.timer = 0; st.size = r.range(0.09, 0.14); st.ph = r.range(0, 100); st.scale = 1;
    st.fall = r.range(0.55, 0.95);
  }
  update(dt, t, cam) {
    this.camPos.copy(cam);
    const r = this.rng;
    for (let i = 0; i < this.N; i++) {
      const st = this.s[i];
      const p = st.p;
      if (st.mode === 0) {
        const [wx, wz] = windAt(p.x, p.y, p.z, t);
        const flutter = Math.sin(t * 3.1 + st.ph) * 0.5;
        st.v.x += (wx + flutter * 0.6 - st.v.x) * Math.min(1, dt * 1.6);
        st.v.z += (wz + Math.cos(t * 2.3 + st.ph) * 0.5 - st.v.z) * Math.min(1, dt * 1.6);
        st.v.y = -st.fall + Math.sin(t * 2.7 + st.ph * 1.3) * 0.35;
        p.addScaledVector(st.v, dt);
        st.ang += st.spin * dt;
        const g = hAt(p.x, p.z);
        const w = waterAt(p.x, p.z);
        if (w !== null && p.y <= w + 0.02) {
          st.mode = 1; p.y = w + 0.012; st.timer = r.range(18, 32);
          st.flow = flowAt(p.x, p.z); st.flowT = 0.6; st.yaw = r.range(0, 6.28);
          if (Math.hypot(p.x - cam.x, p.z - cam.z) < 70) this.ripples.spawn(p.x, w, p.z, 0.55, 0.7, 1.6);
        } else if (p.y <= g + 0.03) {
          st.mode = 2; p.y = g + 0.02; st.timer = r.range(4, 9); st.yaw = r.range(0, 6.28);
        }
        if (Math.hypot(p.x - cam.x, p.z - cam.z) > 170 || p.y < -5) this.spawn(st);
      } else if (st.mode === 1) {
        st.flowT -= dt;
        if (st.flowT <= 0) { st.flow = flowAt(p.x, p.z); st.flowT = 0.6; }
        p.x += (st.flow[0] * 0.85 + Math.sin(t + st.ph) * 0.05) * dt;
        p.z += (st.flow[1] * 0.85 + Math.cos(t * 0.8 + st.ph) * 0.05) * dt;
        const w = waterAt(p.x, p.z);
        st.yaw += dt * 0.3;
        if (w === null) { st.mode = 2; st.timer = 3; p.y = hAt(p.x, p.z) + 0.02; }
        else p.y = w + 0.012 + Math.sin(t * 2 + st.ph) * 0.004;
        st.timer -= dt;
        if (st.timer < 1) st.scale = Math.max(0, st.timer);
        if (st.timer <= 0) this.spawn(st);
      } else {
        st.timer -= dt;
        if (st.timer < 1) st.scale = Math.max(0, st.timer);
        if (st.timer <= 0) this.spawn(st);
      }
      if (st.mode === 0) {
        tmpQ.setFromAxisAngle(st.axis, st.ang);
      } else {
        tmpQ.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, st.yaw));
      }
      const dc = p.distanceTo(cam);
      const near = dc < 2.2 ? Math.max(0, (dc - 0.8) / 1.4) : 1;
      const s = st.size * st.scale * near;
      tmpM.compose(p, tmpQ, tmpS.set(s, s * 1.1, s));
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------- dust motes & fireflies (points) ----------------
function dustMotes(T) {
  const N = 1600, S = 70;
  const rng = new RNG(5);
  const pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = rng.range(0, S); pos[i * 3 + 1] = rng.range(0, S * 0.5); pos[i * 3 + 2] = rng.range(0, S); seed[i] = rng.next(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: U.time, uTex: { value: T.dot }, uS: { value: S }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uS; uniform float uPR; attribute float aSeed; varying float vA; varying float vSun;
      ${ATMO_GLSL}
      void main(){
        vec3 p = position;
        p += vec3(sin(uTime * 0.21 + aSeed * 40.0) * 2.0 + uTime * 0.55, sin(uTime * 0.33 + aSeed * 17.0) * 1.2, cos(uTime * 0.18 + aSeed * 23.0) * 2.0 + uTime * 0.28);
        vec3 c = cameraPosition;
        p.xz = mod(p.xz - c.xz + uS * 0.5, uS) - uS * 0.5 + c.xz;
        p.y = mod(p.y - c.y + uS * 0.25, uS * 0.5) - uS * 0.25 + c.y;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = length(p - c);
        vA = (1.0 - smoothstep(uS * 0.3, uS * 0.48, d)) * smoothstep(0.5, 2.0, d);
        vSun = pow(max(dot(normalize(p - c), SUN_DIR), 0.0), 4.0);
        gl_PointSize = clamp((0.05 + aSeed * 0.05) * 900.0 * uPR / -mv.z, 1.0, 14.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; varying float vA; varying float vSun;
      void main(){
        float t = texture2D(uTex, gl_PointCoord).r;
        vec3 c = vec3(1.0, 0.72, 0.42) * (0.25 + vSun * 2.6);
        gl_FragColor = vec4(c * t * vA * 0.55, 0.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.layers.set(2);
  return pts;
}

function fireflies(T) {
  const rng = new RNG(77);
  const items = [];
  for (let i = 0; i < 220; i++) {
    let x, z, y;
    if (i < 150) {
      const p = LOWER[rng.int(4, 200)];
      const side = rng.sign();
      const off = p[2] + rng.range(0.5, 5);
      x = p[0] - p.tz * side * off; z = p[1] + p.tx * side * off;
    } else {
      x = rng.range(44, 96); z = rng.range(-94, -38);
    }
    y = hAt(x, z) + rng.range(0.4, 2.6);
    if (y < 0.3) y = 0.4 + rng.range(0, 1.5);
    items.push(x, y, z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(items, 3));
  const seeds = new Float32Array(items.length / 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: U.time, uTex: { value: T.dot }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uPR; attribute float aSeed; varying float vB;
      void main(){
        vec3 p = position;
        float s = aSeed * 60.0;
        p += vec3(sin(uTime * 0.31 + s) * 1.4 + sin(uTime * 0.71 + s * 2.0) * 0.4, sin(uTime * 0.45 + s * 1.3) * 0.5, cos(uTime * 0.27 + s * 0.7) * 1.4);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float blink = pow(max(sin(uTime * (0.9 + aSeed) + s), 0.0), 6.0);
        vB = blink * (1.0 - smoothstep(60.0, 140.0, -mv.z));
        gl_PointSize = clamp(0.22 * 700.0 * uPR / -mv.z, 1.5, 16.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; varying float vB;
      void main(){ float t = texture2D(uTex, gl_PointCoord).r; gl_FragColor = vec4(vec3(0.85, 1.0, 0.35) * t * vB * 3.0, 0.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.layers.set(2);
  return p;
}

// ---------------- billboards: mist, spray, smoke ----------------
class Billboards {
  constructor(T, N, { additive = false, lit = true } = {}) {
    this.N = N;
    const g = new THREE.PlaneGeometry(1, 1);
    this.aP = new Float32Array(N * 3); this.aD = new Float32Array(N * 4); this.aC = new Float32Array(N * 3);
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(this.aP, 3));
    g.setAttribute('aD', new THREE.InstancedBufferAttribute(this.aD, 4));
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(this.aC, 3));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: T.puff }, uTime: U.time },
      vertexShader: /* glsl */ `
        attribute vec3 aP; attribute vec4 aD; attribute vec3 aC;
        varying vec2 vUv; varying float vA; varying vec3 vC; varying vec3 vWP;
        void main(){
          vUv = uv; vA = aD.y; vC = aC;
          vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 u = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float cs = cos(aD.z), sn = sin(aD.z);
          vec2 c = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
          vec3 wp = aP + (r * c.x + u * c.y) * aD.x;
          vWP = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; varying vec2 vUv; varying float vA; varying vec3 vC; varying vec3 vWP;
        ${ATMO_GLSL}
        void main(){
          float t = texture2D(uTex, vUv).a;
          vec3 V = normalize(vWP - cameraPosition);
          float fw = pow(max(dot(V, SUN_DIR), 0.0), 3.0);
          vec3 col = vC * (0.75 + fw * 1.8);
          col = applyFog(col, vWP);
          float a = t * vA * smoothstep(3.0, 16.0, distance(cameraPosition, vWP));
          gl_FragColor = vec4(col * a, ${additive ? '0.0' : 'a'});
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.InstancedMesh(g, m, N);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }
  set(i, x, y, z, size, alpha, rot, c) {
    this.aP[i * 3] = x; this.aP[i * 3 + 1] = y; this.aP[i * 3 + 2] = z;
    this.aD[i * 4] = size; this.aD[i * 4 + 1] = alpha; this.aD[i * 4 + 2] = rot;
    this.aC[i * 3] = c[0]; this.aC[i * 3 + 1] = c[1]; this.aC[i * 3 + 2] = c[2];
  }
  commit() {
    const a = this.mesh.geometry.attributes;
    a.aP.needsUpdate = true; a.aD.needsUpdate = true; a.aC.needsUpdate = true;
  }
}

class Atmos {
  constructor(T, foot, smokeSources, ripples) {
    this.rng = new RNG(31);
    this.ripples = ripples;
    this.foot = foot;
    this.smokeSrc = smokeSources.slice(0, 9);
    this.mistN = 70; this.sprayN = 60; this.smokeN = this.smokeSrc.length * 12;
    this.bb = new Billboards(T, this.mistN + this.sprayN + this.smokeN);
    this.mist = []; this.spray = []; this.smoke = [];
    const r = this.rng;
    for (let i = 0; i < this.mistN; i++) {
      const p = LOWER[r.int(0, 230)];
      this.mist.push({ s: p.s, off: r.range(-1, 1), y: r.range(0.5, 2.6), size: r.range(7, 15), a: r.range(0.05, 0.11), rot: r.range(0, 6.28) });
    }
    for (let i = 0; i < this.sprayN; i++) this.spray.push(this.newSpray(true));
    for (let k = 0; k < this.smokeSrc.length; k++) for (let i = 0; i < 12; i++) this.smoke.push({ src: k, age: i / 12, life: 9 + r.range(-1, 2), rot: r.range(0, 6.28), dx: 0, dz: 0, dy: 0 });
    this.mesh = this.bb.mesh;
    this.mesh.layers.set(2);
    this.lowerByS = LOWER;
  }
  newSpray(initial) {
    const r = this.rng;
    return { x: this.foot.x + r.range(-4.5, 4.5), y: r.range(0, 1), z: this.foot.z + r.range(-1, 2.5), vy: r.range(1.2, 3.2), vx: r.range(-0.6, 0.6), vz: r.range(0.3, 1.4), age: initial ? r.next() : 0, life: r.range(2.2, 3.8), size: r.range(2, 5), rot: r.range(0, 6.28) };
  }
  pointAtS(s) {
    const L = this.lowerByS;
    let lo = 0, hi = L.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m].s < s) lo = m; else hi = m; }
    return L[lo];
  }
  update(dt, t) {
    let k = 0;
    const bb = this.bb;
    for (const m of this.mist) {
      m.s += dt * 0.45;
      if (m.s > 235) m.s -= 235;
      const p = this.pointAtS(m.s);
      const x = p[0] - p.tz * m.off * p[2] * 0.7, z = p[1] + p.tx * m.off * p[2] * 0.7;
      const fade = Math.min(1, m.s / 8) * Math.min(1, (235 - m.s) / 8);
      bb.set(k++, x, m.y + Math.sin(t * 0.2 + m.rot) * 0.3, z, m.size, m.a * fade, m.rot + t * 0.02, [0.95, 0.85, 0.9]);
    }
    for (let i = 0; i < this.spray.length; i++) {
      const s = this.spray[i];
      s.age += dt / s.life;
      if (s.age >= 1) { this.spray[i] = this.newSpray(false); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vy *= 1 - dt * 0.3;
      const a = Math.sin(s.age * Math.PI) * 0.3;
      bb.set(k++, s.x, s.y, s.z, s.size * (0.6 + s.age), a, s.rot + s.age, [1.0, 0.97, 0.95]);
    }
    for (const s of this.smoke) {
      s.age += dt / s.life;
      if (s.age >= 1) { s.age -= 1; s.dx = s.dz = s.dy = 0; }
      const src = this.smokeSrc[s.src];
      const [wx, wz] = windAt(src.x, src.y, src.z, t);
      const a = s.age;
      const x = src.x + wx * a * s.life * 0.5 + Math.sin(a * 6 + s.rot) * 0.4;
      const z = src.z + wz * a * s.life * 0.5;
      const y = src.y + a * s.life * 0.55;
      const alpha = Math.sin(Math.min(1, a * 4) * Math.PI * 0.5) * (1 - a) * 0.22;
      bb.set(k++, x, y, z, 0.6 + a * 4.5, alpha, s.rot + a * 1.5, [0.75, 0.7, 0.75]);
    }
    while (k < bb.N) bb.set(k++, 0, -1000, 0, 0, 0, 0, [0, 0, 0]);
    bb.commit();
    // waterfall pool ripples
    if (this.rng.next() < dt * 9) this.ripples.spawn(this.foot.x + this.rng.range(-6, 6), WATER_Y, this.foot.z + this.rng.range(0, 6), this.rng.range(0.8, 1.8), 0.8, 1.4);
    // stepping stones & rising fish
    if (this.rng.next() < dt * 2) {
      const s = layout.steppingStones[this.rng.int(0, layout.steppingStones.length - 1)];
      this.ripples.spawn(s.x + this.rng.range(-0.6, 0.6), WATER_Y, s.z + 0.9, this.rng.range(0.6, 1.0), 0.6, 1.5);
    }
    if (this.rng.next() < dt * 0.8) {
      const p = LOWER[this.rng.int(30, 200)];
      this.ripples.spawn(p[0] + this.rng.range(-3, 3), WATER_Y, p[1] + this.rng.range(-3, 3), this.rng.range(0.8, 1.4), 0.9, 2.2);
    }
  }
}

// ---------------- birds ----------------
class Birds {
  constructor() {
    this.N = 18;
    const g = new THREE.BufferGeometry();
    const v = [
      0, 0, 0.35, -0.07, 0, -0.3, 0.07, 0, -0.3, // body
      0, 0, 0.12, -0.9, 0.05, -0.05, 0, 0, -0.12, // left wing
      0, 0, 0.12, 0, 0, -0.12, 0.9, 0.05, -0.05, // right wing
      0, 0, -0.25, -0.15, 0, -0.5, 0.15, 0, -0.5, // tail
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    this.phase = new Float32Array(this.N);
    const rng = new RNG(12);
    for (let i = 0; i < this.N; i++) this.phase[i] = rng.range(0, 6.28);
    g.setAttribute('aPh', new THREE.InstancedBufferAttribute(this.phase, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: U.time },
      vertexShader: /* glsl */ `
        uniform float uTime; attribute float aPh; varying vec3 vWP;
        void main(){
          vec3 p = position;
          float f = sin(uTime * 9.0 + aPh);
          p.y += f * abs(p.x) * 0.55;
          p.x *= 1.0 - 0.15 * abs(f);
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vWP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vWP;
        ${ATMO_GLSL}
        void main(){ gl_FragColor = vec4(applyFog(vec3(0.03, 0.025, 0.035), vWP), 1.0); }`,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(g, m, this.N);
    this.mesh.frustumCulled = false;
    this.b = [];
    for (let i = 0; i < this.N; i++) this.b.push({ off: new V3(rng.range(-12, 12), rng.range(-4, 4), rng.range(-10, 10)), sp: rng.range(0.9, 1.1), s: rng.range(1.1, 1.6) });
  }
  update(dt, t) {
    const R = 170;
    for (let i = 0; i < this.N; i++) {
      const b = this.b[i];
      const a = t * 0.055 * b.sp + i * 0.004;
      const cx = -20 + Math.cos(a) * R + Math.sin(a * 2.0) * 30;
      const cz = -90 + Math.sin(a) * R * 0.6;
      const cy = 78 + Math.sin(a * 3 + i) * 5;
      tmpP.set(cx + b.off.x, cy + b.off.y, cz + b.off.z);
      const a2 = a + 0.01;
      tmpA.set(-20 + Math.cos(a2) * R + Math.sin(a2 * 2.0) * 30 + b.off.x, cy + b.off.y, -90 + Math.sin(a2) * R * 0.6 + b.off.z);
      const dir = tmpA.sub(tmpP).normalize();
      tmpQ.setFromUnitVectors(new V3(0, 0, 1), dir);
      tmpM.compose(tmpP, tmpQ, tmpS.set(b.s, b.s, b.s));
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------- koi ----------------
class Koi {
  constructor(ripples) {
    this.ripples = ripples;
    const body = new THREE.SphereGeometry(1, 14, 8);
    body.scale(0.11, 0.07, 0.36);
    const tail = new THREE.BufferGeometry();
    tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.3, -0.14, 0, -0.55, 0.14, 0, -0.55], 3));
    tail.computeVertexNormals();
    body.deleteAttribute('uv');
    const g = new THREE.BufferGeometry();
    const bp = body.toNonIndexed();
    const all = [...bp.attributes.position.array, ...tail.attributes.position.array];
    g.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ roughness: 0.4, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += sin(position.z * 9.0 - uTime * 7.0) * 0.06 * (0.4 - position.z);');
    };
    const rng = new RNG(3);
    this.N = 9;
    this.mesh = new THREE.InstancedMesh(g, m, this.N);
    const cols = [[1.0, 0.32, 0.04], [0.95, 0.92, 0.88], [0.9, 0.15, 0.08], [1.0, 0.6, 0.1], [0.95, 0.92, 0.88], [1.0, 0.32, 0.04], [0.15, 0.13, 0.12], [1.0, 0.45, 0.1], [0.9, 0.15, 0.08]];
    this.f = [];
    for (let i = 0; i < this.N; i++) {
      this.mesh.setColorAt(i, new THREE.Color(...cols[i]));
      this.f.push({ r: rng.range(0.25, 0.85), sp: rng.range(0.12, 0.25) * rng.sign(), ph: rng.range(0, 6.28), s: rng.range(1.3, 2.0), d: rng.range(0.18, 0.35) });
    }
    this.mesh.layers.set(2);
  }
  update(dt, t) {
    const P = layout.pond;
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    for (let i = 0; i < this.N; i++) {
      const f = this.f[i];
      const a = t * f.sp + f.ph;
      const rr = f.r + 0.12 * Math.sin(t * 0.3 + f.ph);
      const lx = Math.cos(a) * rr * P.rx * 0.75, lz = Math.sin(a) * rr * P.rz * 0.75;
      const x = P.x + lx * c - lz * s, z = P.z + lx * s + lz * c;
      const a2 = a + 0.05 * Math.sign(f.sp);
      const lx2 = Math.cos(a2) * rr * P.rx * 0.75, lz2 = Math.sin(a2) * rr * P.rz * 0.75;
      const x2 = P.x + lx2 * c - lz2 * s, z2 = P.z + lx2 * s + lz2 * c;
      tmpP.set(x, WATER_Y - f.d, z);
      tmpA.set(x2 - x, 0, z2 - z).normalize();
      tmpQ.setFromUnitVectors(new V3(0, 0, 1), tmpA);
      tmpM.compose(tmpP, tmpQ, tmpS.set(f.s, f.s, f.s));
      this.mesh.setMatrixAt(i, tmpM);
      if (Math.random() < dt * 0.04) this.ripples.spawn(x, WATER_Y, z, 0.7, 0.8, 1.8);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------- paper lanterns (chochin) ----------------
class Lanterns {
  constructor(T, anchors) {
    this.anchors = anchors;
    const ribs = [];
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = -0.5 + t;
      const r = Math.sin(Math.PI * (0.12 + 0.76 * t)) * 0.34 * (1 + 0.035 * Math.cos(t * Math.PI * 2 * 7));
      ribs.push(new THREE.Vector2(r, y));
    }
    const body = new THREE.LatheGeometry(ribs, 16);
    const capT = new THREE.CylinderGeometry(0.13, 0.15, 0.09, 16); capT.translate(0, 0.5, 0);
    const capB = new THREE.CylinderGeometry(0.15, 0.13, 0.08, 16); capB.translate(0, -0.5, 0);
    const cord = new THREE.CylinderGeometry(0.01, 0.01, 0.3, 4); cord.translate(0, 0.65, 0);
    [capT, capB, cord].forEach((g) => g.deleteAttribute('uv'));
    body.deleteAttribute('uv');
    const mergeG = [body, capT, capB, cord].map((g) => g.index ? g.toNonIndexed() : g);
    const g = new THREE.BufferGeometry();
    const pos = [], nor = [];
    const groups = [];
    let start = 0;
    mergeG.forEach((mg, k) => {
      pos.push(...mg.attributes.position.array); nor.push(...mg.attributes.normal.array);
      const cnt = mg.attributes.position.count;
      groups.push([start, cnt, k === 0 ? 0 : 1]);
      start += cnt;
    });
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    groups.forEach(([s, c, m]) => g.addGroup(s, c, m));
    const paper = new THREE.MeshBasicMaterial({ color: 0xffffff });
    paper.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vLy;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLy = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLy;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat rib = 0.8 + 0.2 * smoothstep(0.0, 0.25, abs(fract(vLy * 14.0) - 0.5));\nfloat ends = 1.0 - smoothstep(0.3, 0.5, abs(vLy)) * 0.55;\ndiffuseColor.rgb *= rib * ends * uFlick;');
      sh.uniforms.uFlick = U.flicker;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uFlick;');
    };
    const rim = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.015, 0.012), roughness: 0.5 });
    this.mesh = new THREE.InstancedMesh(g, [paper, rim], anchors.length);
    const cols = [new THREE.Color(5.0, 0.9, 0.35), new THREE.Color(5.0, 3.4, 1.6), new THREE.Color(5.2, 2.2, 0.6)];
    const rng = new RNG(8);
    anchors.forEach((a, i) => {
      this.mesh.setColorAt(i, cols[a.color].clone().multiplyScalar(rng.range(0.8, 1.1)));
      a.ph = rng.range(0, 6.28);
      a.len = 0.42 * a.s;
    });
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }
  update(dt, t) {
    const e = new THREE.Euler();
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      const [wx, wz] = windAt(a.x, a.y, a.z, t);
      const ax = Math.sin(t * 1.7 + a.ph) * 0.05 + wz * 0.04;
      const az = -Math.sin(t * 1.3 + a.ph * 1.3) * 0.06 - wx * 0.04;
      e.set(ax, 0, az);
      tmpQ.setFromEuler(e);
      const s = a.s;
      const L = a.len + 0.5 * s;
      tmpP.set(0, -L, 0).applyQuaternion(tmpQ).add(tmpA.set(a.x, a.y, a.z));
      tmpM.compose(tmpP, tmpQ, tmpS.set(s, s * 1.15, s));
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export function buildLife(T, { foot, smokeSources, hanging }) {
  const ripples = new Ripples();
  const petals = new Petals(T, ripples);
  const atmos = new Atmos(T, foot, smokeSources, ripples);
  const birds = new Birds();
  const koi = new Koi(ripples);
  const lanterns = new Lanterns(T, hanging);
  const dust = dustMotes(T);
  const ff = fireflies(T);
  const group = new THREE.Group();
  group.add(ripples.mesh, petals.mesh, atmos.mesh, birds.mesh, koi.mesh, lanterns.mesh, dust, ff);
  return {
    group,
    setPR(pr) { dust.material.uniforms.uPR.value = pr; ff.material.uniforms.uPR.value = pr; },
    update(dt, t, cam) {
      petals.update(dt, t, cam);
      ripples.update(dt);
      atmos.update(dt, t);
      birds.update(dt, t);
      koi.update(dt, t);
      lanterns.update(dt, t);
    },
  };
}
