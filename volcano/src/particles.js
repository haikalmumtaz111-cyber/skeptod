// Particle systems: sorted volumetric smoke sprites (CPU sim), incandescent
// streak particles (fountain, bombs, sparks) and stateless GPU embers.
import * as THREE from 'three';
import { V } from './terrain.js';
import { COMMON, ATMOS, LAVA_RAMP as LAVA } from './shaders.js';
import { noise2, mulberry32 } from './noise.js';

const rnd = mulberry32(2024);
const R = (a, b) => a + (b - a) * rnd();
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export const GRAVITY = 46;
export const WIND = new THREE.Vector3(0.74, 0, 0.67).normalize();
export function windSpeed(h) { return 9 + Math.max(h, 0) * 0.0062; }

// ---------------------------------------------------------------------------
// Smoke sprite atlas (4x4 cauliflower puffs with normals) generated on the GPU
export function buildSmokeAtlas(renderer, size = 2048) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      vec4 hash41(float p){ vec4 p4 = fract(vec4(p)*vec4(0.1031,0.1030,0.0973,0.1099)); p4 += dot(p4, p4.wzxy+33.33); return fract((p4.xxyz+p4.yzzw)*p4.zywx); }
      float hash13(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y)*p3.z); }
      float vnoise(vec3 p){
        vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hash13(i), hash13(i+vec3(1,0,0)), f.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a*vnoise(p); p = p*2.07 + 0.31; a *= 0.5; } return s; }
      float puff(vec2 uv, float seed){
        vec2 w = vec2(fbm(vec3(uv*2.2, seed)), fbm(vec3(uv*2.2 + 7.3, seed + 3.1))) - 0.5;
        uv += w * 0.22;
        float h = -1.0;
        for (int i = 0; i < 18; i++){
          vec4 r = hash41(seed*17.13 + float(i)*3.71);
          vec2 c = i == 0 ? vec2(0.0, -0.05) : (r.xy - 0.5) * vec2(1.15, 1.05);
          float rad = i == 0 ? 0.46 : mix(0.13, 0.36, r.z * r.z);
          float lc = length(c);
          if (lc + rad > 0.92) c *= max(0.0, 0.92 - rad) / max(lc, 1e-3);
          vec2 d = uv - c;
          float z = rad*rad - dot(d, d);
          if (z > 0.0) h = max(h, sqrt(z) * (0.9 + 0.2*r.w));
        }
        float n = fbm(vec3(uv*4.0, seed*1.7)) - 0.5;
        float n2 = fbm(vec3(uv*11.0, seed*2.3 + 5.0)) - 0.5;
        float n3 = fbm(vec3(uv*27.0, seed*3.1 + 9.0)) - 0.5;
        return h + n*0.22 + n2*0.09 + n3*0.04;
      }
      void main(){
        vec2 cell = floor(vUv * 4.0);
        vec2 uv = fract(vUv * 4.0) * 2.0 - 1.0;
        float seed = cell.x + cell.y * 4.0 + 1.0;
        float e = 2.0 / ${(size / 4).toFixed(1)};
        float h = puff(uv, seed);
        float hx = puff(uv + vec2(e, 0.0), seed);
        float hy = puff(uv + vec2(0.0, e), seed);
        vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 2.2));
        float edge = 1.0 - smoothstep(0.7, 0.98, length(uv));
        float dens = smoothstep(-0.02, 0.3, h) * edge;
        dens *= 0.75 + 0.25 * smoothstep(0.35, 0.65, fbm(vec3(uv*6.0, seed*4.1 + 2.0)));
        float thick = clamp(h / 0.55, 0.0, 1.0);
        gl_FragColor = vec4(n.xy * 0.5 + 0.5, thick, dens);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const sc = new THREE.Scene();
  sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.setRenderTarget(rt);
  renderer.render(sc, cam);
  renderer.setRenderTarget(null);
  mat.dispose();
  quad.geometry.dispose();
  rt.texture.anisotropy = 4;
  return rt.texture;
}

// ---------------------------------------------------------------------------
const SMOKE_VERT = /* glsl */ `
${COMMON}
${ATMOS}
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uSkyAmb;
uniform vec3 uCraterPos;
uniform vec3 uCraterCol;
uniform vec3 uBoltPos;
uniform vec3 uBoltCol;
uniform vec3 uPlumePos;
uniform vec3 uPlumeCol;
attribute vec4 iPos;
attribute vec4 iPar;
attribute vec4 iLit;
varying vec2 vUv;
varying vec2 vCellUv;
varying float vSeed;
varying vec2 vRot;
varying float vAlpha;
varying float vViewZ;
varying float vSize;
varying vec3 vAlb;
varying vec3 vAmb;
varying vec3 vMoonD;
varying vec3 vMoonC;
varying vec3 vCrD;
varying vec3 vCrC;
varying vec3 vBoD;
varying vec3 vBoC;
varying vec3 vUpD;
varying vec3 vLavaC;
varying vec3 vEmis;
varying vec4 vFog;
void main(){
  vec3 wp = iPos.xyz;
  float size = iPos.w;
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  float cs = cos(iPar.x), sn = sin(iPar.x);
  vec2 c = position.xy;
  vp.xy += vec2(c.x*cs - c.y*sn, c.x*sn + c.y*cs) * size;
  gl_Position = projectionMatrix * vp;
  float v = iPar.w;
  vec2 cell = vec2(mod(v, 4.0), floor(v / 4.0));
  vec2 lc0 = clamp(c + 0.5, 0.004, 0.996);
  vUv = (cell + lc0) / 4.0;
  vCellUv = lc0 + iPar.w * 0.37;
  vSeed = fract(iPar.w * 0.131 + iPos.x * 0.0001);
  vRot = vec2(cs, sn);
  vViewZ = -vp.z;
  vSize = size;
  // fade sprites that get too close to the camera
  float camFade = smoothstep(size * 0.15, size * 0.9, vViewZ);
  vAlpha = iPar.y * camFade;
  if (vAlpha < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat3 vm = mat3(viewMatrix);
  float shade = iLit.y;
  float tint = iLit.z;
  vAlb = mix(vec3(0.115, 0.104, 0.096), vec3(0.42, 0.41, 0.40), tint);
  vAmb = uSkyAmb * (0.5 + 0.7 * shade) * 1.1;
  vMoonD = vm * uMoonDir;
  vMoonC = uMoonCol * shade * 0.75;
  vec3 lc = uCraterPos - wp;
  float dc = length(lc);
  vCrD = vm * (lc / dc);
  vec3 lp = uPlumePos - wp;
  float dp = length(lp);
  vCrC = uCraterCol * 0.85 / (1.0 + dc*dc / (950.0*950.0)) + uPlumeCol * 0.9 / (1.0 + dp*dp / (2300.0*2300.0));
  vec3 lb = uBoltPos - wp;
  float db = length(lb);
  vBoD = vm * (lb / max(db, 1.0));
  vBoC = uBoltCol * 0.7 * exp(-db / 750.0);
  vUpD = vm * vec3(0.0, -1.0, 0.0);
  vLavaC = vec3(1.0, 0.3, 0.06) * iLit.x * 5.0;
  vEmis = vec3(1.0, 0.3, 0.05) * iPar.z * 4.5;
  vFog = atmosphere(wp);
}
`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform vec2 uNearFar;
varying vec2 vUv;
varying vec2 vRot;
varying float vAlpha;
varying float vViewZ;
varying float vSize;
varying vec3 vAlb;
varying vec3 vAmb;
varying vec3 vMoonD;
varying vec3 vMoonC;
varying vec3 vCrD;
varying vec3 vCrC;
varying vec3 vBoD;
varying vec3 vBoC;
varying vec3 vUpD;
varying vec3 vLavaC;
varying vec3 vEmis;
varying vec4 vFog;
float viewZ(float d){
  float n = uNearFar.x, f = uNearFar.y;
  return (n * f) / ((f - n) * d - f);
}
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vCellUv;
varying float vSeed;
void main(){
  vec2 wob = (texture(uNoise, vCellUv * 0.35 + vec2(vSeed, uTime * 0.025)).rg - 0.5) * 0.05;
  vec4 tx = texture(uAtlas, vUv + wob);
  float dens = tx.a;
  float a = dens * vAlpha;
  if (a < 0.002) discard;
  float sceneZ = -viewZ(texture(uDepth, gl_FragCoord.xy / uRes).r);
  float soft = clamp((sceneZ - vViewZ) / (vSize * 0.3 + 20.0), 0.0, 1.0);
  a *= soft;
  if (a < 0.002) discard;
  vec2 nxy = tx.rg * 2.0 - 1.0;
  nxy = vec2(nxy.x * vRot.x - nxy.y * vRot.y, nxy.x * vRot.y + nxy.y * vRot.x);
  vec3 N = normalize(vec3(nxy * 0.6, 1.0));
  float thick = tx.b;
  float occl = 0.75 + 0.25 * thick;
  vec3 L = vAmb * occl;
  L += vMoonC * max((dot(N, vMoonD) + 0.35) / 1.35, 0.0);
  L += vCrC * (max((dot(N, vCrD) + 0.5) / 1.5, 0.0) + (1.0 - thick) * 0.6 * max(-vCrD.z, 0.0));
  L += vBoC * (0.35 + 0.65 * (1.0 - thick));
  L += vLavaC * max((dot(N, vUpD) + 0.6) / 1.6, 0.0);
  vec3 col = vAlb * L + vEmis * (0.35 + thick);
  col = col * vFog.a + vFog.rgb;
  gl_FragColor = vec4(col * a, a);
}
`;

// type ids
const PLUME = 0, FUME = 1, TRAIL = 2, PDC = 3, DUST = 4;

export class SmokeSystem {
  constructor(cap, sample, heatData, lavaPts) {
    this.cap = cap;
    this.sample = sample;
    this.heat = heatData;
    this.lavaPts = lavaPts;
    this.n = 0;
    const F = () => new Float32Array(cap);
    Object.assign(this, {
      type: new Uint8Array(cap), x: F(), y: F(), z: F(), cx: F(), cz: F(), vx: F(), vy: F(), vz: F(),
      ang: F(), angV: F(), rf: F(), hn: F(), tu: F(), age: F(), life: F(), s0: F(), rot: F(), rotV: F(), jx: F(), jz: F(),
      vari: F(), heatv: F(), alpha: F(), seed: F(), lift: F(), size: F(), shade: F(), under: F(), eff: F(),
    });
    this.depth = new Float32Array(cap);
    this.order = new Uint32Array(cap);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aLit = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iPar', this.aPar);
    g.setAttribute('iLit', this.aLit);
    g.instanceCount = 0;
    this.geo = g;
  }

  makeMesh(uniforms) {
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    return this.mesh;
  }

  spawn(type) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.type[i] = type;
    this.age[i] = 0;
    this.seed[i] = rnd() * 1000;
    this.rot[i] = rnd() * Math.PI * 2;
    this.rotV[i] = R(-0.12, 0.12);
    this.vari[i] = Math.floor(rnd() * 16);
    this.heatv[i] = 0;
    this.shade[i] = 1;
    this.under[i] = 0;
    return i;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (const k of SmokeSystem.FIELDS) this[k][i] = this[k][j];
  }

  emitPlume(intensity, jet = 1, lateral = 0) {
    const i = this.spawn(PLUME);
    if (i < 0) return;
    const ja = rnd() * Math.PI * 2;
    this.jx[i] = Math.cos(ja) * lateral;
    this.jz[i] = Math.sin(ja) * lateral;
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * V.RIM_R * 0.42;
    this.cx[i] = Math.cos(a) * rr * 0.5;
    this.cz[i] = Math.sin(a) * rr * 0.5;
    this.y[i] = V.FLOOR_H + R(10, 60);
    this.vy[i] = R(280, 520) * (0.6 + 0.5 * intensity) * jet;
    this.ang[i] = a;
    this.angV[i] = R(-0.08, 0.08);
    this.rf[i] = Math.sqrt(rnd());
    this.hn[i] = R(7200, 9400) * (0.85 + 0.15 * intensity);
    this.tu[i] = -1;
    this.life[i] = R(62, 82);
    this.s0[i] = R(0.7, 1.3);
    this.heatv[i] = R(0.6, 1.0) * Math.min(1.3, intensity);
    this.alpha[i] = R(0.55, 0.8);
  }

  emitFume() {
    const i = this.spawn(FUME);
    if (i < 0) return;
    let x, z, y;
    if (rnd() < 0.25) {
      const a = rnd() * Math.PI * 2, r = V.RIM_R * R(0.85, 1.3);
      x = Math.cos(a) * r; z = Math.sin(a) * r; y = this.sample(x, z) + 10;
    } else {
      const p = this.lavaPts[Math.floor(rnd() * this.lavaPts.length)];
      x = p.x + R(-0.4, 0.4) * p.w; z = p.z + R(-0.4, 0.4) * p.w; y = p.y + 4;
    }
    this.x[i] = x; this.z[i] = z; this.y[i] = y;
    this.vx[i] = 0; this.vz[i] = 0; this.vy[i] = R(14, 34);
    this.life[i] = R(12, 20);
    this.s0[i] = R(40, 80);
    this.alpha[i] = R(0.22, 0.4);
  }

  emitTrail(x, y, z, vx, vy, vz, s) {
    const i = this.spawn(TRAIL);
    if (i < 0) return;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = vx * 0.08; this.vy[i] = vy * 0.08 + 6; this.vz[i] = vz * 0.08;
    this.life[i] = R(3, 5.5);
    this.s0[i] = s;
    this.alpha[i] = R(0.35, 0.6);
    this.heatv[i] = 0.35;
  }

  emitDust(x, y, z, s) {
    const i = this.spawn(DUST);
    if (i < 0) return;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = R(-8, 8); this.vy[i] = R(8, 20); this.vz[i] = R(-8, 8);
    this.life[i] = R(4, 7);
    this.s0[i] = s;
    this.alpha[i] = R(0.4, 0.65);
    this.heatv[i] = 0.2;
  }

  emitPDC(angle) {
    const i = this.spawn(PDC);
    if (i < 0) return;
    const a = angle + R(-0.22, 0.22);
    const r = V.RIM_R * R(1.0, 1.35);
    this.x[i] = Math.cos(a) * r; this.z[i] = Math.sin(a) * r;
    const sp = R(70, 150);
    this.vx[i] = Math.cos(a) * sp; this.vz[i] = Math.sin(a) * sp;
    this.lift[i] = R(0, 60);
    this.vy[i] = 0;
    this.life[i] = R(28, 40);
    this.s0[i] = R(0.85, 1.3);
    this.alpha[i] = R(0.8, 1.0);
    this.heatv[i] = R(0.25, 0.45);
  }

  heatAt(x, z) {
    const N = V.N, HM = V.HM;
    const u = ((x + HM) / (2 * HM)) * N, v = ((z + HM) / (2 * HM)) * N;
    if (u < 0 || v < 0 || u >= N || v >= N) return 0;
    const id = ((v | 0) * N + (u | 0)) * 4;
    return (this.heat[id] * 1.0 + this.heat[id + 1] * 0.35) / 255;
  }

  update(dt, t, intensity) {
    const sample = this.sample;
    const wx = WIND.x, wz = WIND.z;
    for (let i = 0; i < this.n; i++) {
      const age = (this.age[i] += dt);
      if (age > this.life[i]) { this.kill(i); i--; continue; }
      const sd = this.seed[i];
      const typ = this.type[i];
      const lf = age / this.life[i];
      if (typ === PLUME) {
        let y = this.y[i];
        const h = y - V.RIM_H;
        const hn = this.hn[i];
        const rf = this.rf[i];
        let target;
        if (h < hn) target = 430 * (1 - 0.8 * Math.min(h / hn, 1)) * (1 - 0.38 * rf * rf);
        else target = -35;
        if (this.tu[i] < 0 && h > hn * 0.92) this.tu[i] = 0;
        if (this.tu[i] >= 0) this.tu[i] += dt;
        this.vy[i] += (target - this.vy[i]) * (1 - Math.exp(-0.75 * dt));
        y += this.vy[i] * dt;
        this.y[i] = y;
        const ws = windSpeed(h);
        const jd = Math.exp(-0.9 * dt);
        this.jx[i] *= jd; this.jz[i] *= jd;
        this.cx[i] += (wx * ws + this.jx[i]) * dt;
        this.cz[i] += (wz * ws + this.jz[i]) * dt;
        this.ang[i] += this.angV[i] * dt;
        const hh = Math.max(h, 0);
        const colR = 230 + 0.25 * Math.min(hh, hn);
        let rad = colR;
        const tu = this.tu[i];
        if (tu > 0) rad += 520 * Math.sqrt(tu) * (0.6 + 0.4 * rf);
        rad *= rf;
        const eddy = 1 + 0.3 * Math.sin(hh * 0.0011 - t * 0.55 + this.ang[i] * 2 + 1.3) + 0.18 * Math.sin(hh * 0.0027 - t * 0.9 + this.ang[i] * 3 + sd);
        rad *= eddy;
        const ca = Math.cos(this.ang[i]), sa = Math.sin(this.ang[i]);
        // umbrella spreads mostly downwind into an anvil
        const along = ca * wx + sa * wz;
        const stretch = tu > 0 ? 1 + Math.min(tu / 18, 1) * (along > 0 ? 1.6 * along : 0.55 * along) : 1;
        const tA = 40 + rad * 0.12;
        const tx = Math.sin(t * 0.37 + sd) * tA + Math.sin(t * 0.13 + sd * 2.1 + y * 0.002) * tA;
        const tz = Math.cos(t * 0.29 + sd * 1.7) * tA + Math.cos(t * 0.17 + sd * 0.7 + y * 0.0017) * tA;
        this.x[i] = this.cx[i] + ca * rad * stretch + tx;
        this.z[i] = this.cz[i] + sa * rad * stretch + tz;
        let size = (130 + 0.72 * colR) * this.s0[i];
        if (tu > 0) size *= 1 + Math.min(tu * 0.04, 0.9);
        this.size[i] = size;
        const fadeIn = Math.min(age / 1.15, 1) * Math.min(age / 1.15, 1);
        const fadeOut = 1 - Math.max(0, (lf - 0.72) / 0.28);
        this.shade[i] = Math.min(1, 0.25 + 0.75 * rf * rf + Math.max(0, (h - hn * 0.75) / (hn * 0.5)) * 0.6);
        this.heatv[i] *= Math.exp(-dt * 1.1);
        this.under[i] = h < 1800 ? this.heatAt(this.x[i], this.z[i]) * Math.exp(-Math.max(h, 0) / 600) * 0.5 : 0;
        this.rot[i] += this.rotV[i] * dt * (200 / (size + 100));
        this.eff[i] = this.alpha[i] * fadeIn * fadeOut;
      } else if (typ === PDC) {
        const x = this.x[i], z = this.z[i];
        const e = 20;
        const gx = (sample(x + e, z) - sample(x - e, z)) / (2 * e);
        const gz = (sample(x, z + e) - sample(x, z - e)) / (2 * e);
        this.vx[i] += -gx * 85 * dt;
        this.vz[i] += -gz * 85 * dt;
        const damp = Math.exp(-0.16 * dt);
        this.vx[i] *= damp; this.vz[i] *= damp;
        const sp = Math.hypot(this.vx[i], this.vz[i]);
        this.x[i] += (this.vx[i] + Math.sin(t * 0.5 + sd) * 15) * dt;
        this.z[i] += (this.vz[i] + Math.cos(t * 0.43 + sd) * 15) * dt;
        const size = (230 + 1250 * Math.pow(lf, 0.65)) * this.s0[i];
        this.vy[i] += ((6 + 22 * (1 - Math.min(sp / 200, 1))) - this.vy[i]) * (1 - Math.exp(-0.5 * dt));
        this.lift[i] += this.vy[i] * dt;
        this.y[i] = sample(this.x[i], this.z[i]) + size * 0.22 + this.lift[i];
        this.size[i] = size;
        this.shade[i] = 0.35 + 0.3 * Math.min(1, this.lift[i] / 500);
        this.heatv[i] *= Math.exp(-dt * 0.35);
        this.under[i] = this.heatAt(this.x[i], this.z[i]) * 0.25;
        this.rot[i] += this.rotV[i] * dt * 0.4;
        const fin = Math.min(age / 0.4, 1), fout = 1 - Math.max(0, (lf - 0.6) / 0.4);
        this.eff[i] = this.alpha[i] * fin * fout;
      } else {
        // fumes, trails, dust: buoyant puffs drifting with wind
        const h = this.y[i];
        const ws = typ === FUME ? 0.45 * windSpeed(h - 1000) : 0.6 * windSpeed(h - 800);
        this.vy[i] *= Math.exp(-0.25 * dt);
        if (typ === FUME) this.vy[i] += 4 * dt;
        this.x[i] += (this.vx[i] + wx * ws + Math.sin(t * 0.6 + sd) * 6) * dt;
        this.z[i] += (this.vz[i] + wz * ws + Math.cos(t * 0.5 + sd) * 6) * dt;
        this.y[i] += this.vy[i] * dt;
        this.vx[i] *= Math.exp(-0.6 * dt); this.vz[i] *= Math.exp(-0.6 * dt);
        const grow = typ === FUME ? 6.5 : typ === TRAIL ? 4.5 : 3.5;
        this.size[i] = this.s0[i] * (1 + grow * Math.pow(lf, 0.6));
        this.shade[i] = 0.75;
        this.heatv[i] *= Math.exp(-dt * 1.5);
        this.under[i] = this.heatAt(this.x[i], this.z[i]) * (typ === FUME ? 0.9 : 0.4) * Math.exp(-Math.max(0, h - this.sample(this.x[i], this.z[i])) / 500);
        this.rot[i] += this.rotV[i] * dt;
        const fin = Math.min(age / 0.8, 1), fout = 1 - lf;
        this.eff[i] = this.alpha[i] * fin * fout * fout;
      }
    }
  }

  // Sort back-to-front for the camera and upload instance data
  upload(camera) {
    const n = this.n;
    const e = camera.matrixWorldInverse.elements;
    const P = this.aPos.array, Q = this.aPar.array, L = this.aLit.array;
    const eff = this.eff;
    const keys = this.depth;
    const ord = this.order;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const vz = e[2] * this.x[i] + e[6] * this.y[i] + e[10] * this.z[i] + e[14];
      if (vz > this.size[i] * 0.5 || eff[i] < 0.004) continue; // behind camera or invisible
      keys[i] = vz;
      ord[m++] = i;
    }
    const idx = Array.from(ord.subarray(0, m));
    idx.sort((a, b) => keys[a] - keys[b]);
    for (let k = 0; k < m; k++) {
      const i = idx[k];
      const o = k * 4;
      P[o] = this.x[i]; P[o + 1] = this.y[i]; P[o + 2] = this.z[i]; P[o + 3] = this.size[i];
      Q[o] = this.rot[i]; Q[o + 1] = eff[i]; Q[o + 2] = this.heatv[i]; Q[o + 3] = this.vari[i];
      const typ = this.type[i];
      L[o] = this.under[i]; L[o + 1] = this.shade[i];
      L[o + 2] = typ === FUME ? 0.75 : typ === DUST ? 0.15 : 0.0;
      L[o + 3] = 0;
    }
    for (const a of [this.aPos, this.aPar, this.aLit]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, m * 4);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = m;
  }
}
SmokeSystem.FIELDS = ['type', 'x', 'y', 'z', 'cx', 'cz', 'vx', 'vy', 'vz', 'ang', 'angV', 'rf', 'hn', 'tu', 'age', 'life', 's0', 'rot', 'rotV', 'jx', 'jz', 'vari', 'heatv', 'alpha', 'seed', 'lift', 'size', 'shade', 'under', 'eff'];

// ---------------------------------------------------------------------------
// Incandescent streak particles (screen-space motion-blurred quads)
export const STREAK_VERT_COMMON = /* glsl */ `
uniform vec2 uRes;
uniform float uShutter;
uniform float uMinEnergy;
varying vec2 vLoc;
varying float vLen;
varying float vW;
varying float vEnergy;
// builds a pixel-space capsule from p0 (head) to p1 (tail)
bool streakQuad(vec3 p0, vec3 p1, float worldSize, out vec4 clip){
  vec4 c0 = projectionMatrix * viewMatrix * vec4(p0, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(p1, 1.0);
  if (c0.w < 2.0 || c1.w < 2.0) { clip = vec4(2.0, 2.0, 2.0, 1.0); return false; }
  vec2 h = uRes * 0.5;
  vec2 s0 = c0.xy / c0.w * h, s1 = c1.xy / c1.w * h;
  float sizePx = worldSize * projectionMatrix[1][1] * h.y / c0.w;
  float w = max(sizePx, 1.25);
  vEnergy = max(min(sizePx * sizePx / (w * w), 1.0), uMinEnergy);
  vec2 d = s1 - s0;
  float len = length(d);
  if (len > 160.0) { d *= 160.0 / len; len = 160.0; }
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float along = position.x, side = position.y;
  vec2 pix = mix(s0 - dir * w * 2.0, s0 + d + dir * w * 2.0, along) + nrm * side * w * 2.0;
  float wz = mix(c0.w, c1.w, along);
  float zz = mix(c0.z / c0.w, c1.z / c1.w, along);
  clip = vec4(pix / h * wz, zz * wz, wz);
  vLoc = vec2(mix(-w * 2.0, len + w * 2.0, along), side * w * 2.0);
  vLen = len;
  vW = w;
  return true;
}
`;

export const STREAK_FRAG_COMMON = /* glsl */ `
varying vec2 vLoc;
varying float vLen;
varying float vW;
varying float vEnergy;
float streakMask(){
  float u = vLoc.x;
  float d = length(vec2(u - clamp(u, 0.0, vLen), vLoc.y));
  float core = exp(-d * d / (0.22 * vW * vW)) + 0.08 * exp(-d * d / (1.6 * vW * vW));
  float tail = mix(1.0, 0.35, clamp(u / max(vLen, 1.0), 0.0, 1.0));
  return core * tail * vEnergy * (vW / (vW + vLen * 0.35));
}
`;

const GLOW_VERT = /* glsl */ `
${COMMON}
${ATMOS}
${LAVA}
${STREAK_VERT_COMMON}
uniform float uGlowMul;
uniform float uShutterMul;
attribute vec4 iPos;
attribute vec4 iVel;
varying vec3 vCol;
varying float vDepthV;
void main(){
  vec4 clip;
  vec3 p0 = iPos.xyz;
  float camD = distance(p0, uCamPos);
  float sm = mix(1.0, uShutterMul, smoothstep(700.0, 4500.0, camD));
  vec3 p1 = p0 - iVel.xyz * uShutter * sm;
  if (!streakQuad(p0, p1, iPos.w, clip)) { gl_Position = clip; vCol = vec3(0.0); return; }
  gl_Position = clip;
  vec4 at = atmosphere(p0);
  vCol = lavaRamp(iVel.w) * at.a * uGlowMul;
  vDepthV = -(viewMatrix * vec4(p0, 1.0)).z;
}
`;

const GLOW_FRAG = /* glsl */ `
${STREAK_FRAG_COMMON}
uniform sampler2D uDepth;
uniform sampler2D uSmoke;
uniform vec2 uNearFar;
uniform vec2 uRes;
uniform float uManualDepth;
varying vec3 vCol;
varying float vDepthV;
void main(){
  float m = streakMask();
  if (m < 0.002) discard;
  if (uManualDepth > 0.5) {
    vec2 uv = gl_FragCoord.xy / uRes;
    float d = texture(uDepth, uv).r;
    float n = uNearFar.x, f = uNearFar.y;
    float sz = -(n * f) / ((f - n) * d - f);
    if (vDepthV > sz + 2.0) discard;
    m *= 1.0 - 0.6 * texture(uSmoke, uv).a;
  }
  gl_FragColor = vec4(vCol * m, 1.0);
}
`;

export function streakGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const FOUNT = 0, BOMB = 1, SPARK = 2, SPATTER = 3;

export class GlowSystem {
  constructor(cap, sample, smoke, inner) {
    this.cap = cap; this.n = 0; this.sample = sample; this.smoke = smoke; this.inner = inner;
    const F = () => new Float32Array(cap);
    Object.assign(this, {
      type: new Uint8Array(cap), state: new Uint8Array(cap), x: F(), y: F(), z: F(), vx: F(), vy: F(), vz: F(),
      size: F(), temp: F(), age: F(), life: F(), cool: F(), bounce: F(), trail: F(),
    });
    const g = streakGeometry();
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iVel', this.aVel);
    g.instanceCount = 0;
    this.geo = g;
  }
  makeMesh(uniforms) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms, uManualDepth: { value: this.inner ? 0 : 1 }, uGlowMul: { value: this.inner ? 0.32 : 1.0 },
        uShutterMul: { value: this.inner ? 2.2 : 4.5 }, uMinEnergy: { value: this.inner ? 0.0 : 0.3 },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthTest: this.inner,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    return this.mesh;
  }
  spawn(type) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.type[i] = type; this.state[i] = 0; this.age[i] = 0; this.bounce[i] = 0; this.trail[i] = 0;
    return i;
  }
  kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (const k of GlowSystem.FIELDS) this[k][i] = this[k][j];
  }
  emitFountain(intensity, boost = 1) {
    const i = this.spawn(FOUNT);
    if (i < 0) return;
    const vent = rnd() < 0.6 ? [18, -12] : [-40, 30];
    this.x[i] = vent[0] + R(-14, 14); this.z[i] = vent[1] + R(-14, 14); this.y[i] = V.FLOOR_H + 2;
    const wide = rnd() < 0.16;
    const spread = wide ? 0.42 : 0.17;
    const th = Math.abs(gauss()) * spread, ph = rnd() * Math.PI * 2;
    const sp = R(110, 245) * (0.65 + 0.45 * intensity) * boost;
    this.vx[i] = Math.sin(th) * Math.cos(ph) * sp;
    this.vz[i] = Math.sin(th) * Math.sin(ph) * sp;
    this.vy[i] = Math.cos(th) * sp;
    this.size[i] = R(2.5, 8);
    this.temp[i] = R(1.0, 1.3);
    this.cool[i] = R(0.07, 0.14);
    this.life[i] = 30;
  }
  emitBomb(intensity, boost = 1) {
    const i = this.spawn(BOMB);
    if (i < 0) return;
    const a = rnd() * Math.PI * 2, rr = rnd() * V.RIM_R * 0.35;
    this.x[i] = Math.cos(a) * rr; this.z[i] = Math.sin(a) * rr; this.y[i] = V.FLOOR_H + 20;
    const th = Math.abs(gauss()) * 0.42 + 0.03, ph = rnd() * Math.PI * 2;
    const sp = R(170, 420) * boost * (0.75 + 0.3 * intensity);
    this.vx[i] = Math.sin(th) * Math.cos(ph) * sp;
    this.vz[i] = Math.sin(th) * Math.sin(ph) * sp;
    this.vy[i] = Math.cos(th) * sp;
    this.size[i] = R(6, 13) * (rnd() < 0.15 ? 1.8 : 1);
    this.temp[i] = R(1.0, 1.2);
    this.cool[i] = R(0.02, 0.05);
    this.life[i] = 45;
    this.trail[i] = this.size[i] > 11 ? 1 : 0;
  }
  emitSpark(x, y, z, s) {
    const i = this.spawn(SPARK);
    if (i < 0) return;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    const th = rnd() * 1.2, ph = rnd() * Math.PI * 2, sp = R(25, 95) * s;
    this.vx[i] = Math.sin(th) * Math.cos(ph) * sp;
    this.vz[i] = Math.sin(th) * Math.sin(ph) * sp;
    this.vy[i] = Math.cos(th) * sp;
    this.size[i] = R(1.2, 3.2);
    this.temp[i] = R(0.85, 1.1);
    this.cool[i] = R(0.4, 0.8);
    this.life[i] = R(0.7, 1.8);
  }
  update(dt, t) {
    const sample = this.sample;
    for (let i = 0; i < this.n; i++) {
      const age = (this.age[i] += dt);
      const typ = this.type[i];
      if (age > this.life[i] || this.temp[i] < 0.12) { this.kill(i); i--; continue; }
      this.temp[i] -= this.cool[i] * dt;
      const st = this.state[i];
      if (st === 0) {
        // ballistic flight
        const drag = typ === SPARK ? 0.6 : typ === FOUNT ? 0.05 : 0.025;
        const d = Math.exp(-drag * dt);
        this.vx[i] *= d; this.vz[i] *= d; this.vy[i] *= d;
        this.vy[i] -= GRAVITY * dt * (typ === SPARK ? 0.6 : 1);
        this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
        if (typ === BOMB && this.trail[i] > 0 && this.smoke && this.temp[i] > 0.75 && rnd() < dt * 2.2) {
          this.smoke.emitTrail(this.x[i], this.y[i], this.z[i], this.vx[i], this.vy[i], this.vz[i], this.size[i] * 2.6);
        }
        if (this.vy[i] < 0) {
          const g = sample(this.x[i], this.z[i]);
          if (this.y[i] < g + this.size[i] * 0.3) {
            this.y[i] = g + this.size[i] * 0.3;
            const r = Math.hypot(this.x[i], this.z[i]);
            if (typ === FOUNT) {
              if (r < V.RIM_R * 0.55) { this.kill(i); i--; continue; }
              this.state[i] = 1; this.type[i] = SPATTER;
              this.vx[i] = this.vy[i] = this.vz[i] = 0;
              this.cool[i] = R(0.18, 0.32);
              this.size[i] *= 1.6;
            } else if (typ === SPARK) {
              this.kill(i); i--; continue;
            } else {
              // bomb impact: bounce, sparks and dust
              if (r < V.RIM_R * 0.5) { this.kill(i); i--; continue; }
              const e = 10;
              const nx = -(sample(this.x[i] + e, this.z[i]) - sample(this.x[i] - e, this.z[i])) / (2 * e);
              const nz = -(sample(this.x[i], this.z[i] + e) - sample(this.x[i], this.z[i] - e)) / (2 * e);
              const nl = Math.hypot(nx, 1, nz);
              const NX = nx / nl, NY = 1 / nl, NZ = nz / nl;
              const vn = this.vx[i] * NX + this.vy[i] * NY + this.vz[i] * NZ;
              const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
              if (this.bounce[i] === 0 && this.smoke) {
                this.smoke.emitDust(this.x[i], this.y[i], this.z[i], this.size[i] * 4);
                const ns = 5 + Math.floor(rnd() * 8);
                for (let k = 0; k < ns; k++) this.emitSpark(this.x[i], this.y[i] + 2, this.z[i], Math.min(1.5, sp / 200));
              }
              this.bounce[i]++;
              if (sp > 45 && this.bounce[i] < 4) {
                this.vx[i] = (this.vx[i] - 2 * vn * NX) * 0.42;
                this.vy[i] = (this.vy[i] - 2 * vn * NY) * 0.32;
                this.vz[i] = (this.vz[i] - 2 * vn * NZ) * 0.42;
              } else {
                this.state[i] = 2; // rolling
                this.vy[i] = 0;
              }
            }
          }
        }
      } else if (st === 2) {
        // rolling / sliding down the slope
        const e = 10, x = this.x[i], z = this.z[i];
        const gx = (sample(x + e, z) - sample(x - e, z)) / (2 * e);
        const gz = (sample(x, z + e) - sample(x, z - e)) / (2 * e);
        this.vx[i] += -gx * 70 * dt; this.vz[i] += -gz * 70 * dt;
        const d = Math.exp(-1.3 * dt);
        this.vx[i] *= d; this.vz[i] *= d;
        this.x[i] += this.vx[i] * dt; this.z[i] += this.vz[i] * dt;
        const g = sample(this.x[i], this.z[i]);
        this.vy[i] = (g + this.size[i] * 0.4 - this.y[i]) / Math.max(dt, 1e-3);
        this.y[i] = g + this.size[i] * 0.4;
        if (Math.hypot(this.vx[i], this.vz[i]) < 2) { this.state[i] = 1; this.vx[i] = this.vz[i] = 0; this.vy[i] = 0; }
      }
    }
  }
  upload() {
    const P = this.aPos.array, Q = this.aVel.array;
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      P[o] = this.x[i]; P[o + 1] = this.y[i]; P[o + 2] = this.z[i]; P[o + 3] = this.size[i];
      Q[o] = this.vx[i]; Q[o + 1] = this.vy[i]; Q[o + 2] = this.vz[i]; Q[o + 3] = this.temp[i];
    }
    for (const a of [this.aPos, this.aVel]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * 4);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.n;
  }
}
GlowSystem.FIELDS = ['type', 'state', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'size', 'temp', 'age', 'life', 'cool', 'bounce', 'trail'];

// ---------------------------------------------------------------------------
// Stateless GPU embers. kind 0: crater sparks, 1: lava-river embers, 2: ambient around the camera
const EMBER_VERT = /* glsl */ `
${COMMON}
${ATMOS}
${LAVA}
${STREAK_VERT_COMMON}
uniform vec3 uWind;
uniform float uIntensity;
uniform sampler2D uHeat;
uniform float uHM;
attribute vec4 iSeed;
attribute vec4 iOrigin;
varying vec3 vCol;
varying float vDepthV;
float windSpd(float h){ return 9.0 + max(h, 0.0) * 0.0062; }
void main(){
  float kind = iOrigin.w;
  float life = kind < 0.5 ? mix(2.5, 6.0, iSeed.y) : kind < 1.5 ? mix(3.0, 7.5, iSeed.y) : mix(7.0, 13.0, iSeed.y);
  float tt = uTime + iSeed.x * life;
  float cyc = floor(tt / life);
  float age = tt - cyc * life;
  vec4 r = hash41(iSeed.z * 1000.0 + cyc * 13.17);
  vec4 r2 = hash41(iSeed.w * 777.0 + cyc * 7.31);
  vec3 p, v;
  float temp = 0.9, bright = 1.0, size = mix(1.4, 3.6, r.w);
  float sw = sin(uTime * (1.3 + r.x) + r.y * 30.0), cw = cos(uTime * (1.1 + r.z) + r.w * 30.0);
  if (kind < 0.5) {
    vec3 o = vec3((r.x - 0.5) * RIM_R * 0.8, FLOOR_H + 10.0, (r.y - 0.5) * RIM_R * 0.8);
    vec3 v0 = vec3((r2.x - 0.5) * 120.0, mix(110.0, 330.0, r2.y) * (0.6 + 0.5 * uIntensity), (r2.z - 0.5) * 120.0);
    vec3 a = vec3(0.0, -26.0, 0.0);
    p = o + v0 * age + 0.5 * a * age * age;
    float ws = windSpd(p.y - RIM_H);
    p += uWind * ws * age * age * 0.25 + vec3(sw, 0.0, cw) * 25.0 * age;
    v = v0 + a * age + uWind * ws * age * 0.5;
    temp = mix(1.15, 0.45, age / life);
    size *= 1.15;
  } else if (kind < 1.5) {
    vec3 o = iOrigin.xyz + vec3((r.x - 0.5) * 60.0, 2.0, (r.y - 0.5) * 60.0);
    vec3 v0 = vec3((r2.x - 0.5) * 30.0, mix(18.0, 60.0, r2.y), (r2.z - 0.5) * 30.0);
    p = o + v0 * age + vec3(0.0, 3.0, 0.0) * age * age;
    p += uWind * 12.0 * age + vec3(sw, 0.0, cw) * 10.0 * age;
    v = v0 + uWind * 12.0;
    temp = mix(1.05, 0.4, age / life);
  } else {
    float B = 900.0;
    vec3 base = vec3(r.x, r.y, r.z) * B;
    vec3 drift = uWind * 18.0 * uTime + vec3(sw * 20.0, -6.0 * uTime, cw * 20.0);
    p = uCamPos + mod(base + drift - uCamPos + B * 0.5, B) - B * 0.5;
    v = uWind * 18.0 + vec3(0.0, -6.0, 0.0);
    vec2 huv = p.xz / (2.0 * uHM) + 0.5;
    vec4 ht = texture(uHeat, huv);
    float hot = clamp(ht.r * 2.0 + ht.g, 0.0, 1.0);
    temp = mix(0.45, 0.95, hot) * (r2.x < 0.3 ? 1.0 : 0.75);
    bright = smoothstep(0.03, 0.45, hot) * (0.6 + 0.4 * sw);
    size = mix(0.6, 2.2, r.w);
    age = life * 0.5;
  }
  float fade = smoothstep(0.0, 0.08, age / life) * (1.0 - smoothstep(0.65, 1.0, age / life));
  fade *= smoothstep(30.0, 260.0, distance(p, uCamPos));
  float flick = 0.65 + 0.35 * sin(uTime * (9.0 + r.z * 14.0) + r.x * 40.0);
  vec4 clip;
  if (!streakQuad(p, p - v * uShutter, size, clip)) { gl_Position = clip; vCol = vec3(0.0); return; }
  gl_Position = clip;
  vec4 at = atmosphere(p);
  vCol = lavaRamp(temp) * fade * flick * bright * at.a * (kind < 0.5 ? 0.6 : 1.0);
  vDepthV = -(viewMatrix * vec4(p, 1.0)).z;
}
`;

export function buildEmbers(uniforms, lavaPts, counts, inner) {
  const total = counts[0] + counts[1] + counts[2];
  const g = streakGeometry();
  const seeds = new Float32Array(total * 4);
  const orig = new Float32Array(total * 4);
  let k = 0;
  for (let kind = 0; kind < 3; kind++) {
    for (let n = 0; n < counts[kind]; n++, k++) {
      seeds[k * 4] = rnd(); seeds[k * 4 + 1] = rnd(); seeds[k * 4 + 2] = rnd(); seeds[k * 4 + 3] = rnd();
      if (kind === 1) {
        const p = lavaPts[Math.floor(rnd() * lavaPts.length)];
        orig[k * 4] = p.x; orig[k * 4 + 1] = p.y; orig[k * 4 + 2] = p.z;
      }
      orig[k * 4 + 3] = kind;
    }
  }
  g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(orig, 4));
  g.instanceCount = total;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uManualDepth: { value: inner ? 0 : 1 }, uMinEnergy: { value: 0 } },
    vertexShader: EMBER_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthTest: inner,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}
