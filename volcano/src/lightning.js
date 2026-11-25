// Volcanic lightning: branching bolts inside the ash column (instanced screen-space segments)
import * as THREE from 'three';
import { V } from './terrain.js';
import { COMMON, ATMOS } from './shaders.js';
import { streakGeometry } from './particles.js';
import { mulberry32 } from './noise.js';

const rnd = mulberry32(777);

const VERT = /* glsl */ `
${COMMON}
${ATMOS}
uniform vec2 uRes;
uniform float uFlashI;
attribute vec4 iA;
attribute vec4 iB;
varying vec2 vLoc;
varying float vLen;
varying float vW;
varying float vI;
varying float vDepthV;
void main(){
  vDepthV = -(viewMatrix * vec4(mix(iA.xyz, iB.xyz, position.x), 1.0)).z;
  vec4 c0 = projectionMatrix * viewMatrix * vec4(iA.xyz, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(iB.xyz, 1.0);
  if (c0.w < 2.0 || c1.w < 2.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vI = 0.0; return; }
  vec2 h = uRes * 0.5;
  vec2 s0 = c0.xy / c0.w * h, s1 = c1.xy / c1.w * h;
  float wpx = iA.w * projectionMatrix[1][1] * h.y / min(c0.w, c1.w);
  float core = max(wpx, 0.9);
  float w = core * 7.0;
  vec2 d = s1 - s0;
  float len = max(length(d), 1e-3);
  vec2 dir = d / len, nrm = vec2(-dir.y, dir.x);
  float along = position.x, side = position.y;
  vec2 pix = mix(s0 - dir * w, s1 + dir * w, along) + nrm * side * w;
  float wz = mix(c0.w, c1.w, along);
  float zz = mix(c0.z / c0.w, c1.z / c1.w, along);
  gl_Position = vec4(pix / h * wz, zz * wz, wz);
  vLoc = vec2(mix(-w, len + w, along), side * w);
  vLen = len;
  vW = core;
  vec4 at = atmosphere(mix(iA.xyz, iB.xyz, 0.5));
  vI = iB.w * uFlashI * (0.35 + 0.65 * at.a) * min(wpx / 0.9 + 0.5, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uDepth;
uniform sampler2D uSmoke;
uniform vec2 uNearFar;
uniform vec2 uRes;
varying vec2 vLoc;
varying float vLen;
varying float vW;
varying float vI;
varying float vDepthV;
void main(){
  if (vI <= 0.001) discard;
  vec2 suv = gl_FragCoord.xy / uRes;
  float dd = texture(uDepth, suv).r;
  float n = uNearFar.x, f = uNearFar.y;
  float sz = -(n * f) / ((f - n) * dd - f);
  if (vDepthV > sz + 5.0) discard;
  float veil = 1.0 - 0.75 * texture(uSmoke, suv).a;
  float u = vLoc.x;
  float d = length(vec2(u - clamp(u, 0.0, vLen), vLoc.y)) / vW;
  float core = exp(-d * d * 1.3);
  float glow = exp(-d * d * 0.07);
  vec3 c = vec3(0.72, 0.8, 1.0) * (core * 9.0 + glow * 0.9) * vI * veil;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Lightning {
  constructor(uniforms, plumeAxis, sample) {
    this.cap = 700;
    this.axis = plumeAxis;
    this.sample = sample;
    const g = streakGeometry();
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.instanceCount = 0;
    this.geo = g;
    this.flashU = { value: 0 };
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uFlashI: this.flashU },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.next = -1;
    this.start = -10;
    this.dur = 0.5;
    this.pulses = [];
    this.center = new THREE.Vector3(0, 4000, 0);
    this.light = 0;
    this.count = 0;
  }

  addSeg(a, b, w, i) {
    if (this.count >= this.cap) return;
    const o = this.count * 4;
    const A = this.aA.array, B = this.aB.array;
    A[o] = a.x; A[o + 1] = a.y; A[o + 2] = a.z; A[o + 3] = w;
    B[o] = b.x; B[o + 1] = b.y; B[o + 2] = b.z; B[o + 3] = i;
    this.count++;
  }

  bolt(a, b, disp, depth, w, inten, branch) {
    if (depth === 0) { this.addSeg(a, b, w, inten); return; }
    const m = a.clone().add(b).multiplyScalar(0.5);
    m.x += (rnd() - 0.5) * disp; m.y += (rnd() - 0.5) * disp * 0.6; m.z += (rnd() - 0.5) * disp;
    this.bolt(a, m, disp * 0.5, depth - 1, w, inten, branch);
    this.bolt(m, b, disp * 0.5, depth - 1, w, inten, branch);
    if (branch > 0 && depth > 2 && rnd() < 0.32) {
      const dir = m.clone().sub(a);
      const len = dir.length() * (0.6 + rnd() * 0.8);
      dir.normalize();
      dir.x += (rnd() - 0.5) * 1.3; dir.y += (rnd() - 0.5) * 0.8 - 0.25; dir.z += (rnd() - 0.5) * 1.3;
      dir.normalize().multiplyScalar(len);
      this.bolt(m, m.clone().add(dir), disp * 0.45, depth - 2, w * 0.55, inten * 0.55, branch - 1);
    }
  }

  strike(t, intensity) {
    this.count = 0;
    const h1 = 450 + rnd() * rnd() * 5200;
    const c1 = this.axis(h1);
    const r1 = (180 + 0.18 * h1) * 0.7;
    const a = new THREE.Vector3(c1.x + (rnd() - 0.5) * 2 * r1, h1 + V.RIM_H, c1.z + (rnd() - 0.5) * 2 * r1);
    let b;
    if (rnd() < 0.4 && h1 < 3200) {
      // strike the upper flank
      const ang = rnd() * Math.PI * 2, rr = 500 + rnd() * 1500;
      const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
      b = new THREE.Vector3(x, this.sample(x, z) + 5, z);
    } else {
      const h2 = Math.max(250, h1 + (rnd() - 0.5) * 2600);
      const c2 = this.axis(h2);
      const r2 = (180 + 0.18 * h2) * 0.8;
      b = new THREE.Vector3(c2.x + (rnd() - 0.5) * 2 * r2, h2 + V.RIM_H, c2.z + (rnd() - 0.5) * 2 * r2);
    }
    const len = a.distanceTo(b);
    this.bolt(a, b, len * 0.33, 7, 3.5 + rnd() * 2, 1, 3);
    for (const at of [this.aA, this.aB]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, this.count * 4);
      at.needsUpdate = true;
    }
    this.geo.instanceCount = this.count;
    this.center.copy(a).add(b).multiplyScalar(0.5);
    this.start = t;
    this.dur = 0.35 + rnd() * 0.35;
    this.pulses = [0];
    const np = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < np; k++) this.pulses.push(0.05 + rnd() * (this.dur - 0.1));
    this.strength = 0.6 + rnd() * 0.6;
  }

  update(t, intensity, boost) {
    if (this.next < 0) this.next = t + 3 + rnd() * 4;
    if (t >= this.next) {
      this.strike(t, intensity);
      const rate = 0.07 + 0.08 * intensity + boost * 0.55;
      this.next = t + (-Math.log(1 - rnd()) / rate) + 0.4;
    }
    const e = t - this.start;
    let f = 0;
    if (e >= 0 && e < this.dur) {
      for (const p of this.pulses) {
        const d = e - p;
        if (d >= 0) f = Math.max(f, Math.exp(-d * 22));
      }
      f *= this.strength;
    }
    this.light = f;
    this.flashU.value = f;
    this.mesh.visible = f > 0.01;
    return f;
  }
}
