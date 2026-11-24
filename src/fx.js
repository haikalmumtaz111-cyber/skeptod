import * as THREE from 'three';
import { NOISE, FOG_PARS, POOL_PARS } from './glsl.js';
import { U } from './materials.js';
import { RNG } from './util.js';

const common = () => ({ uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash });

// ------------------------------------------------------------------ volumetric beams
export function makeBeamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uInten: { value: 1 }, uFarFade: { value: 1 } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vWP; varying vec3 vN; varying float vT; varying vec3 vCol;
      void main(){
        vec4 wp = instanceMatrix * vec4(position, 1.0);
        wp = modelMatrix * wp;
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vT = -position.y;
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uInten; uniform float uFarFade;
      varying vec3 vWP; varying vec3 vN; varying float vT; varying vec3 vCol;
      ${NOISE}
      ${FOG_PARS}
      void main(){
        vec3 V = normalize(cameraPosition - vWP);
        float facing = abs(dot(normalize(vN), V));
        float edge = pow(facing, 3.2);
        float fall = pow(1.0 - clamp(vT, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.04, vT);
        float dust = 0.65 + 0.35 * vnoise(vec2(vWP.x * 1.5 + vWP.z * 1.5, vWP.y * 0.6 + uTime * 9.0));
        float camD = length(cameraPosition - vWP);
        float near = smoothstep(0.8, 6.0, camD) * mix(1.0, smoothstep(120.0, 30.0, camD), uFarFade);
        vec3 c = vCol * edge * fall * dust * near * uInten;
        c = applyFogAdd(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}
export function coneGeometry(seg = 20) {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, seg, 6, true);
  g.translate(0, -0.5, 0); // apex at 0, base at -1
  return g;
}

export function buildLampBeams(lamps) {
  const geo = coneGeometry(18);
  const mat = makeBeamMaterial(); mat.uniforms.uInten.value = 0.09;
  const mesh = new THREE.InstancedMesh(geo, mat, lamps.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color();
  lamps.forEach((l, i) => {
    s.set(2.9, 7.5, 2.9);
    m.compose(l.p, q.identity(), s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.copy(l.c));
  });
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  return mesh;
}

export class Searchlights {
  constructor(list) {
    this.list = list;
    const geo = coneGeometry(16);
    const mat = makeBeamMaterial(); mat.uniforms.uInten.value = 0.16; mat.uniforms.uFarFade.value = 0;
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    list.forEach((l, i) => this.mesh.setColorAt(i, c.copy(l.color)));
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
  }
  update(t) {
    this.list.forEach((l, i) => {
      const yaw = l.phase + t * l.speed;
      const tilt = l.tilt + Math.sin(t * l.speed * 1.7 + l.phase) * 0.12;
      // cone extends along -Y; rotate so -Y points up and outward
      this._e.set(Math.PI - tilt, yaw, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._s.set(11, 1000, 11);
      this._m.compose(l.p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ glowing point lights (aviation, distant traffic)
export function makePointsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uPx: { value: 800 } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec4 aInfo; // size, blink mode, phase, unused
      uniform float uTime; uniform float uPx;
      varying vec3 vCol; varying float vB; varying vec3 vWP;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
        vec4 mv = viewMatrix * wp;
        float b = 1.0;
        if (aInfo.y > 0.5 && aInfo.y < 1.5) b = smoothstep(0.0, 0.05, fract(uTime * 0.6 + aInfo.z)) * (1.0 - smoothstep(0.12, 0.3, fract(uTime * 0.6 + aInfo.z)));
        else if (aInfo.y > 1.5) b = 0.3 + 0.7 * step(0.5, fract(uTime * 1.2 + aInfo.z));
        vB = b; vCol = aCol;
        float dist = -mv.z;
        gl_PointSize = clamp(aInfo.x * uPx / dist, 2.0, 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vB; varying vec3 vWP;
      ${FOG_PARS}
      void main(){
        vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
        float a = exp(-r * 4.0) + 0.6 * exp(-r * 18.0);
        vec3 c = vCol * a * vB * 4.0;
        c = mix(applyFogAdd(c, vWP, cameraPosition), c, 0.25);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

export function buildPoints(list) {
  const pos = [], col = [], info = [];
  for (const p of list) { pos.push(p.p.x, p.p.y, p.p.z); col.push(p.c.r, p.c.g, p.c.b); info.push(p.size, p.blink, p.phase, 0); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  const pts = new THREE.Points(g, makePointsMaterial());
  pts.frustumCulled = false;
  return pts;
}

// distant traffic rivers
export function buildTrafficStreams() {
  const r = new RNG(777);
  const N = 14, per = 90;
  const a0 = [], a1 = [], info = [], col = [], pos = [];
  for (let s = 0; s < N; s++) {
    const ang = r.f() * Math.PI * 2; const d = r.range(650, 1300);
    const cx = Math.cos(ang) * d, cz = -228 + Math.sin(ang) * d;
    const dir = ang + Math.PI / 2 + r.range(-0.4, 0.4);
    const len = r.range(900, 1600); const y = r.range(70, 260);
    const sx = cx - Math.cos(dir) * len / 2, sz = cz - Math.sin(dir) * len / 2;
    const ex = cx + Math.cos(dir) * len / 2, ez = cz + Math.sin(dir) * len / 2;
    for (let k = 0; k < per; k++) {
      const back = k % 2;
      const off = (back ? 3 : -3);
      const nx = -Math.sin(dir) * off, nz = Math.cos(dir) * off;
      pos.push(0, 0, 0);
      if (back) { a0.push(ex + nx, y + 2, ez + nz); a1.push(sx + nx, y + 2, sz + nz); col.push(1.0, 0.12, 0.08); }
      else { a0.push(sx + nx, y, sz + nz); a1.push(ex + nx, y, ez + nz); col.push(0.85, 0.9, 1.0); }
      info.push(r.f(), 30 + r.f() * 20, len, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(a0, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(a1, 3));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uPx: { value: 800 } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aA; attribute vec3 aB; attribute vec3 aCol; attribute vec4 aInfo;
      uniform float uTime; uniform float uPx;
      varying vec3 vCol; varying vec3 vWP;
      void main(){
        float t = fract(aInfo.x + uTime * aInfo.y / aInfo.z);
        vec3 p = mix(aA, aB, t);
        vWP = p; vCol = aCol * smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.95, t);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(1.4 * uPx / -mv.z, 1.5, 10.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec3 vWP;
      ${FOG_PARS}
      void main(){
        vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
        vec3 c = vCol * exp(-r * 5.0) * 3.0;
        c = mix(applyFogAdd(c, vWP, cameraPosition), c, 0.2);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
  return pts;
}

// ------------------------------------------------------------------ steam
export function buildSteam(list) {
  const per = 10;
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
  const origin = [], info = [];
  list.forEach((s, i) => { for (let k = 0; k < per; k++) { origin.push(s.p.x, s.p.y, s.p.z); info.push(k / per + Math.random() * 0.05, s.s, Math.random(), i); } });
  g.setAttribute('aO', new THREE.InstancedBufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aI', new THREE.InstancedBufferAttribute(new Float32Array(info), 4));
  g.instanceCount = list.length * per;
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uPoolPos: U.uPoolPos, uPoolCol: U.uPoolCol }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aO; attribute vec4 aI;
      uniform float uTime;
      varying vec2 vUv; varying float vA; varying vec3 vCol; varying vec3 vWP; varying float vSeed;
      ${POOL_PARS}
      ${FOG_PARS}
      void main(){
        float life = fract(uTime * 0.12 + aI.x);
        float sz = aI.y * (1.2 + life * 5.0);
        vec3 c = aO + vec3(sin(life * 3.0 + aI.z * 6.0) * 1.2 + life * 2.5, life * 9.0 * aI.y, cos(life * 2.0 + aI.z * 5.0) * 0.8);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float rot = aI.z * 6.28 + life * 1.5;
        vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * position.xy;
        vec3 p = c + (right * q.x + up * q.y) * sz;
        vWP = c; vUv = uv; vSeed = aI.z;
        float cd = length(cameraPosition - c);
        vA = sin(life * 3.14159) * 0.12 * smoothstep(70.0, 25.0, cd) * smoothstep(1.0, 4.0, cd);
        vCol = vec3(0.03, 0.03, 0.05) + poolVolume(c) * 0.8 + fogColorAt(vec3(0.0, 0.0, 1.0), c.y) * 0.5;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv; varying float vA; varying vec3 vCol; varying vec3 vWP; varying float vSeed;
      ${NOISE}
      ${FOG_PARS}
      void main(){
        vec2 p = vUv * 2.0 - 1.0; float r = length(p);
        float n = fbm(vUv * 3.0 + vSeed * 10.0 + uTime * 0.1);
        float a = smoothstep(1.0, 0.1, r) * (0.35 + 0.9 * n) * vA;
        vec3 c = vCol * a;
        c = applyFogAdd(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.layers.set(1);
  return mesh;
}
