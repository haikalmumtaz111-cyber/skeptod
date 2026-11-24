import * as THREE from 'three';
import { Geo } from './util.js';
import { GRID, PITCH, STREET, SIDEWALK, CURB_H, blockRect } from './layout.js';
import { NOISE, FOG_PARS, POOL_PARS } from './glsl.js';
import { U } from './materials.js';

export class PlanarReflection {
  constructor(w, h) {
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
    });
    this.cam = new THREE.PerspectiveCamera();
    this.cam.layers.set(0);
    this.textureMatrix = new THREE.Matrix4();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._pos = new THREE.Vector3();
    this._cpos = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._look = new THREE.Vector3(0, 0, -1);
    this._target = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
  }
  setSize(w, h) { this.rt.setSize(w, h); }
  render(renderer, scene, camera) {
    const normal = this._normal; const rp = this._pos.set(0, 0, 0);
    this._cpos.setFromMatrixPosition(camera.matrixWorld);
    const view = this._view.subVectors(rp, this._cpos);
    if (view.dot(normal) > 0) return;
    view.reflect(normal).negate(); view.add(rp);
    this._rot.extractRotation(camera.matrixWorld);
    const look = this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._cpos);
    const target = this._target.subVectors(rp, look); target.reflect(normal).negate(); target.add(rp);
    const vc = this.cam;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(normal);
    vc.lookAt(target);
    vc.far = camera.far; vc.near = camera.near;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // oblique clip plane
    this._plane.setFromNormalAndCoplanarPoint(normal, rp);
    this._plane.applyMatrix4(vc.matrixWorldInverse);
    const cp = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = vc.projectionMatrix; const q = this._q;
    q.x = (Math.sign(cp.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(cp.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0; q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    cp.multiplyScalar(2.0 / cp.dot(q));
    pm.elements[2] = cp.x; pm.elements[6] = cp.y; pm.elements[10] = cp.z + 1.0 - 0.003; pm.elements[14] = cp.w;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevRT);
  }
}

const STREET_FRAG = /* glsl */`
uniform sampler2D tReflect;
uniform float uTime;
uniform float uReflOn;
varying vec3 vWP; varying vec4 vRC; varying float vSurf;
${NOISE}
${FOG_PARS}
${POOL_PARS}
#define PITCH ${PITCH.toFixed(1)}
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    vec2 q = p * (1.0 + fl * 0.37) + fl * vec2(3.7, 1.3);
    vec2 cell = floor(q); vec2 f = fract(q);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = hash22(cell + o + fl * 17.0);
      vec2 c = o + h - f;
      float ph = fract(t * (0.8 + h.x * 0.6) + h.y);
      float d = length(c);
      float ring = d - ph * 0.85;
      float w = sin(clamp(ring * 28.0, -3.1416, 3.1416)) * smoothstep(0.11, 0.0, abs(ring)) * (1.0 - ph) * (1.0 - ph);
      acc += (c / max(d, 1e-3)) * w;
    }
  }
  return acc;
}
vec3 sampleRefl(vec2 uv, float rough){
  float lod = rough * 5.5;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -3; i <= 3; i++) {
    float o = float(i) / 3.0;
    float w = 1.0 - abs(o) * 0.55;
    acc += textureLod(tReflect, uv + vec2(o * rough * 0.006, o * rough * 0.07), lod).rgb * w; ws += w;
  }
  return acc / ws;
}
void main(){
  vec2 xz = vWP.xz;
  float lx = mod(xz.x + PITCH * 0.5, PITCH) - PITCH * 0.5;
  float lz = mod(xz.y + PITCH * 0.5, PITCH) - PITCH * 0.5;
  float ax = abs(lx), az = abs(lz);
  bool inAve = ax < 15.0, inCross = az < 15.0;
  float surf = vSurf;
  vec3 albedo; float rough; float puddle; vec3 emis = vec3(0.0);
  float markMask = 0.0;
  if (surf < 0.5) {
    float n1 = fbm(xz * 0.3);
    float n3 = vnoise(xz * 21.0);
    albedo = vec3(0.04, 0.042, 0.048) * (0.65 + 0.6 * n1) * (0.8 + 0.4 * n3);
    // repaired patches
    vec2 pc = floor(xz / vec2(4.3, 2.7)); float pr = hash12(pc);
    if (pr > 0.86) albedo *= 0.6;
    // cracks
    float cr = abs(vnoise(xz * 0.9) - 0.5);
    albedo *= 0.75 + 0.25 * smoothstep(0.0, 0.03, cr);
    float across, along; bool seg = false;
    if (inAve && !inCross) { across = lx; along = xz.y; seg = true; }
    else if (inCross && !inAve) { across = lz; along = xz.x; seg = true; }
    vec3 paint = vec3(0.0);
    if (seg) {
      float aa = abs(across);
      float wear = smoothstep(0.25, 0.6, vnoise(xz * 1.7));
      float center = (step(0.12, aa) * step(aa, 0.26));
      float dash = step(abs(aa - 3.7), 0.08) * step(0.45, fract(along / 7.0));
      float edge = step(abs(aa - 9.9), 0.09);
      paint += vec3(0.55, 0.38, 0.05) * center + vec3(0.5) * (dash + edge);
      markMask = (center + dash + edge) * wear;
      // LED studs
      float sAlong = fract(along / 7.0) * 7.0;
      float stud = smoothstep(0.1, 0.05, length(vec2(aa - 3.7, sAlong - 1.4)));
      emis += vec3(0.1, 0.85, 1.0) * stud * 6.0;
      // drains
      float dr = step(abs(aa - 10.15), 0.25) * step(abs(mod(along, 17.0) - 8.0), 0.5);
      albedo = mix(albedo, vec3(0.015) * (0.5 + 0.5 * step(0.5, fract(along * 8.0))), dr);
      // manholes
      float mAlong = mod(along + 4.0, 23.0) - 11.5;
      float md = length(vec2(aa - 5.6, mAlong));
      float mh = step(md, 0.62);
      albedo = mix(albedo, vec3(0.07, 0.065, 0.06) * (0.7 + 0.3 * step(0.5, fract((xz.x + xz.y) * 5.0))), mh);
      albedo *= 1.0 - 0.7 * smoothstep(0.03, 0.0, abs(md - 0.62));
    } else if (inAve && inCross) {
      // junction box crosshatch
      float d1 = step(0.93, fract((lx + lz) / 2.6)), d2 = step(0.93, fract((lx - lz) / 2.6));
      float inBox = step(ax, 9.5) * step(az, 9.5);
      paint += vec3(0.5, 0.36, 0.05) * max(d1, d2) * inBox;
      markMask = max(d1, d2) * inBox * smoothstep(0.2, 0.6, vnoise(xz * 1.3));
    }
    // crosswalks
    float cw = 0.0;
    if (inAve && !inCross && az > 15.6 && az < 19.8 && ax < 10.2) cw = step(0.5, fract(lx / 1.25));
    if (inCross && !inAve && ax > 15.6 && ax < 19.8 && az < 10.2) cw = step(0.5, fract(lz / 1.25));
    paint += vec3(0.55) * cw; markMask = max(markMask, cw * smoothstep(0.2, 0.55, vnoise(xz * 2.1)));
    albedo = mix(albedo, paint, clamp(markMask, 0.0, 1.0));
    float gut = 0.0;
    if (seg) gut = smoothstep(7.5, 10.5, abs(inAve && !inCross ? lx : lz));
    puddle = smoothstep(0.5, 0.58, fbm(xz * 0.075 + 3.1) + 0.22 * gut + 0.08 * fbm3(xz * 0.6));
    rough = mix(0.32, 0.5, n3) * (1.0 - 0.3 * markMask);
  } else if (surf < 1.5) {
    // sidewalk tiles
    vec2 tq = xz / 0.8; vec2 tid = floor(tq); vec2 tf = fract(tq);
    float th = hash12(tid);
    float gap = smoothstep(0.0, 0.05, tf.x) * smoothstep(0.0, 0.05, 1.0 - tf.x) * smoothstep(0.0, 0.05, tf.y) * smoothstep(0.0, 0.05, 1.0 - tf.y);
    albedo = vec3(0.085, 0.085, 0.095) * (0.75 + 0.45 * th) * mix(0.45, 1.0, gap);
    albedo *= 0.8 + 0.3 * vnoise(xz * 3.0);
    puddle = smoothstep(0.55, 0.62, fbm(xz * 0.16 + 7.0)) * 0.9;
    rough = mix(0.25, 0.45, th);
  } else {
    albedo = vec3(0.15, 0.15, 0.16) * (0.8 + 0.3 * vnoise(xz * 4.0));
    puddle = 0.0; rough = 0.3;
  }
  vec2 rip = ripples(xz * 2.6, uTime * 1.5);
  float ripAmt = mix(0.05, 0.3, puddle) * (0.35 + 0.65 * (1.0 - smoothstep(10.0, 45.0, length(cameraPosition - vWP))));
  float bfade = 1.0 - smoothstep(15.0, 60.0, length(cameraPosition - vWP));
  vec2 bump = vec2(vnoise(xz * 9.0) - 0.5, vnoise(xz * 9.0 + 5.3) - 0.5) * (1.0 - puddle) * 0.3 * bfade;
  vec3 N = normalize(vec3(-rip.x * ripAmt + bump.x, 1.0, -rip.y * ripAmt + bump.y));
  vec3 V = normalize(cameraPosition - vWP);
  float NdV = max(dot(N, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - NdV, 5.0);
  vec2 ruv = vRC.xy / vRC.w + N.xz * (0.012 + 0.016 * (1.0 - puddle));
  float r = mix(rough, 0.03, puddle);
  vec3 refl = sampleRefl(ruv, r) * uReflOn;
  float reflAmt = mix(0.18 + 0.55 * fres, 0.45 + 0.55 * fres, puddle);
  // direct lighting from light pool
  vec3 irr = poolIrradiance(vWP + vec3(0.0, 0.05, 0.0), N);
  vec3 amb = vec3(0.016, 0.014, 0.03) + vec3(0.3, 0.32, 0.45) * uFlash * 0.2;
  vec3 col = albedo * (1.0 - puddle * 0.6) * (amb + irr);
  // glossy highlights from pool lights
  for (int i = 0; i < POOL_N; i++) {
    vec3 L = uPoolPos[i].xyz - vWP; float d2 = dot(L, L); float d = sqrt(d2); L /= d;
    vec3 H = normalize(L + V);
    float sp = pow(max(dot(N, H), 0.0), mix(40.0, 400.0, puddle));
    float win = clamp(1.0 - d / uPoolPos[i].w, 0.0, 1.0);
    col += uPoolCol[i] * sp * win * win / (d2 + 1.0) * fres * 6.0;
  }
  col += refl * reflAmt;
  col += emis;
  col = applyFog(col, vWP, cameraPosition);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildStreet() {
  const uniforms = Object.assign({
    tReflect: { value: null }, uReflMatrix: { value: new THREE.Matrix4() }, uReflOn: { value: 1 },
  }, {
    uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash, uPoolPos: U.uPoolPos, uPoolCol: U.uPoolCol,
  });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSurf;
      uniform mat4 uReflMatrix;
      varying vec3 vWP; varying vec4 vRC; varying float vSurf;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz; vSurf = aSurf;
        vRC = uReflMatrix * vec4(wp.x, 0.0, wp.z, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: STREET_FRAG,
  });
  const g = new Geo({ aSurf: 1 });
  // ground plane (tessellated coarsely for precision)
  g.set('aSurf', 0);
  const S = 2600, N = 26; const ox = -100, oz = -250;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x0 = ox - S + (2 * S * i) / N, x1 = ox - S + (2 * S * (i + 1)) / N;
    const z0 = oz - S + (2 * S * j) / N, z1 = oz - S + (2 * S * (j + 1)) / N;
    g.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, 1, 0]);
  }
  // sidewalks
  for (let bi = GRID.i0; bi <= GRID.i1; bi++) for (let bj = GRID.j0; bj <= GRID.j1; bj++) {
    const b = blockRect(bi, bj);
    const x0 = b.x0 - SIDEWALK, x1 = b.x1 + SIDEWALK, z0 = b.z0 - SIDEWALK, z1 = b.z1 + SIDEWALK;
    g.set('aSurf', 1);
    g.quad([x0, CURB_H, z0], [x1, CURB_H, z0], [x1, CURB_H, z1], [x0, CURB_H, z1], [0, 1, 0]);
    g.set('aSurf', 2);
    g.quad([x0, 0, z0], [x1, 0, z0], [x1, CURB_H, z0], [x0, CURB_H, z0], [0, 0, -1]);
    g.quad([x1, 0, z1], [x0, 0, z1], [x0, CURB_H, z1], [x1, CURB_H, z1], [0, 0, 1]);
    g.quad([x0, 0, z1], [x0, 0, z0], [x0, CURB_H, z0], [x0, CURB_H, z1], [-1, 0, 0]);
    g.quad([x1, 0, z0], [x1, 0, z1], [x1, CURB_H, z1], [x1, CURB_H, z0], [1, 0, 0]);
  }
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.layers.set(1);
  mesh.frustumCulled = false;
  return { mesh, mat };
}
