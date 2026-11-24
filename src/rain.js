import * as THREE from 'three';
import { NOISE, FOG_PARS, POOL_PARS } from './glsl.js';
import { U } from './materials.js';
import { PITCH, STREET, SIDEWALK, CURB_H } from './layout.js';

const common = () => ({ uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash, uPoolPos: U.uPoolPos, uPoolCol: U.uPoolCol });

export function buildRain(count = 34000) {
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index; g.setAttribute('position', quad.attributes.position);
  const off = new Float32Array(count * 3), rnd = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { off[i * 3] = Math.random(); off[i * 3 + 1] = Math.random(); off[i * 3 + 2] = Math.random(); rnd[i * 2] = Math.random(); rnd[i * 2 + 1] = Math.random(); }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 2));
  g.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(64, 44, 64) }, uWind: { value: new THREE.Vector3(2.2, 0, 1.1) }, uPx: { value: 800 } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aOff; attribute vec2 aRnd;
      uniform vec3 uCam; uniform float uTime; uniform vec3 uBox; uniform vec3 uWind; uniform float uPx;
      varying float vA; varying vec3 vCol; varying vec2 vUv; varying vec3 vWP;
      ${POOL_PARS}
      ${FOG_PARS}
      void main(){
        float speed = 13.0 + aRnd.x * 5.0;
        vec3 vel = vec3(uWind.x, -speed, uWind.z);
        vec3 p = aOff * uBox + vel * uTime;
        vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 wp = uCam + rel;
        float len = speed * (0.03 + aRnd.y * 0.02);
        vec3 dir = normalize(vel);
        vec3 toCam = cameraPosition - wp;
        float dist = length(toCam);
        vec3 side = normalize(cross(dir, toCam / max(dist, 1e-3)));
        float minW = dist * 1.6 / uPx;
        float w = max(0.006, minW);
        vec3 pos = wp - dir * (position.y * len) + side * position.x * w;
        vWP = wp;
        float fade = smoothstep(0.6, 3.0, dist) * (1.0 - smoothstep(uBox.x * 0.35, uBox.x * 0.5, dist));
        fade *= step(0.0, wp.y);
        vA = fade * (0.006 / w) * (0.6 + 0.4 * aRnd.y);
        vec3 lit = poolVolume(wp);
        vCol = vec3(0.16, 0.18, 0.24) + lit * 1.6 + fogColorAt(normalize(-toCam), wp.y) * 1.2 + vec3(0.6, 0.65, 0.9) * uFlash;
        vUv = vec2(position.x + 0.5, position.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vA; varying vec3 vCol; varying vec2 vUv; varying vec3 vWP;
      void main(){
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float along = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
        float a = across * along * vA;
        gl_FragColor = vec4(vCol * a * 0.45, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.layers.set(1);
  mesh.renderOrder = 10;
  return mesh;
}

export function buildSplashes(count = 2600) {
  const quad = new THREE.PlaneGeometry(1, 1); quad.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index; g.setAttribute('position', quad.attributes.position); g.setAttribute('uv', quad.attributes.uv);
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { rnd[i * 4] = Math.random(); rnd[i * 4 + 1] = Math.random(); rnd[i * 4 + 2] = Math.random() * 1000; rnd[i * 4 + 3] = Math.random(); }
  g.setAttribute('aR', new THREE.InstancedBufferAttribute(rnd, 4));
  g.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uCam: { value: new THREE.Vector3() } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec4 aR;
      uniform vec3 uCam; uniform float uTime;
      varying vec2 vUv; varying float vLife; varying vec3 vCol; varying float vA; varying vec3 vWP; varying float vSeed;
      ${NOISE}
      ${POOL_PARS}
      ${FOG_PARS}
      #define PITCH ${PITCH.toFixed(1)}
      void main(){
        float T = 0.42 + aR.w * 0.2;
        float k = uTime / T + aR.x;
        float life = fract(k); float cyc = floor(k);
        vec2 h = hash22(vec2(aR.z, cyc));
        float R = 34.0;
        vec3 wp = vec3(uCam.x + (h.x - 0.5) * R * 2.0, 0.0, uCam.z + (h.y - 0.5) * R * 2.0);
        float lx = mod(wp.x + PITCH * 0.5, PITCH) - PITCH * 0.5;
        float lz = mod(wp.z + PITCH * 0.5, PITCH) - PITCH * 0.5;
        float ax = abs(lx), az = abs(lz);
        float onRoad = step(ax, ${(STREET / 2 - SIDEWALK).toFixed(2)}) + step(az, ${(STREET / 2 - SIDEWALK).toFixed(2)});
        float onWalk = step(ax, ${(STREET / 2).toFixed(2)}) + step(az, ${(STREET / 2).toFixed(2)});
        float vis = step(0.5, onWalk);
        wp.y = onRoad > 0.5 ? 0.0 : ${CURB_H.toFixed(2)};
        float size = (0.22 + aR.y * 0.26);
        vec3 toCam = cameraPosition - wp; float dist = length(toCam);
        vec3 tc = normalize(vec3(toCam.x, 0.0, toCam.z));
        vec3 side = vec3(-tc.z, 0.0, tc.x);
        vec3 pos = wp + side * position.x * size * 2.0 + vec3(0.0, position.y * size * 1.1, 0.0) + tc * 0.02;
        vUv = vec2(position.x, position.y);
        vLife = life; vSeed = aR.y + cyc * 0.37;
        vA = vis * smoothstep(R, R * 0.6, dist) * smoothstep(0.5, 2.0, dist) * (1.0 - smoothstep(18.0, 40.0, uCam.y));
        vCol = vec3(0.22, 0.24, 0.3) + poolVolume(wp + vec3(0.0, 0.3, 0.0)) * 2.0 + fogColorAt(vec3(0.0, 0.0, 1.0), 1.0) * 1.5;
        vWP = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying float vLife; varying vec3 vCol; varying float vA; varying vec3 vWP; varying float vSeed;
      ${FOG_PARS}
      void main(){
        float t = vLife;
        vec2 p = vec2(vUv.x * 2.0, vUv.y * 1.1);
        // ground ring
        float rr = length(vec2(p.x, (p.y - 0.04) * 5.0));
        float ring = smoothstep(0.06, 0.0, abs(rr - (0.15 + t * 0.85))) * (1.0 - t) * step(p.y, 0.2);
        // crown droplets
        float drops = 0.0;
        for (int i = 0; i < 7; i++) {
          float fi = float(i);
          float a = (fi / 6.0 - 0.5) * 1.9 + sin(vSeed * 13.0 + fi) * 0.15;
          float vx = sin(a) * (0.55 + 0.3 * fract(vSeed * 7.0 + fi * 0.31));
          float vy = cos(a) * (1.4 + 0.6 * fract(vSeed * 3.0 + fi * 0.71));
          vec2 c = vec2(vx * t, vy * t - 2.2 * t * t);
          if (c.y < 0.0) continue;
          vec2 d = p - c; d.y *= 0.6;
          drops += smoothstep(0.045, 0.0, length(d)) * (1.0 - t * 0.7);
        }
        // central jet early
        float jet = smoothstep(0.05, 0.0, abs(p.x)) * step(p.y, 0.9 * sin(min(t * 3.0, 3.14159))) * step(t, 0.35) * 0.6;
        float a = (ring * 0.9 + drops + jet) * vA;
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.layers.set(1);
  mesh.renderOrder = 11;
  return mesh;
}

// Far rain curtains: cylinders around the camera with streak noise
export function buildRainCurtains() {
  const group = new THREE.Group();
  const mats = [];
  for (const [R, inten] of [[26, 0.07], [55, 0.055], [110, 0.045]]) {
    const geo = new THREE.CylinderGeometry(R, R, 260, 64, 1, true);
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(common(), { uR: { value: R }, uI: { value: inten } }),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying vec3 vWP; varying vec2 vC;
        uniform float uR;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
          float ang = atan(position.z, position.x);
          vC = vec2(ang * uR, wp.y);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform float uI; uniform float uR;
        varying vec3 vWP; varying vec2 vC;
        ${NOISE}
        ${FOG_PARS}
        void main(){
          vec2 q = vec2(vC.x * 3.0 + vC.y * 0.12, vC.y * 0.22 + uTime * 3.2);
          float n = vnoise(q);
          float n2 = vnoise(vec2(q.x * 1.7 + 13.0, q.y * 1.4 + uTime * 1.1));
          float s = pow(n, 10.0) * 1.6 + pow(n2, 12.0) * 1.6 + 0.05;
          vec3 V = normalize(vWP - cameraPosition);
          vec3 fc = fogColorAt(V, vWP.y);
          vec3 c = (fc * 2.4 + vec3(0.05, 0.05, 0.08) + vec3(0.5, 0.55, 0.8) * uFlash) * s * uI;
          float hf = smoothstep(-2.0, 6.0, vWP.y);
          // fade towards top/bottom of view
          c *= hf * (1.0 - smoothstep(0.5, 0.95, abs(V.y)));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    mats.push(mat);
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 9; m.layers.set(1);
    group.add(m);
  }
  return group;
}
