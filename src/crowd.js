import * as THREE from 'three';
import { Geo, RNG, PALETTE } from './util.js';
import { NOISE, FOG_PARS, POOL_PARS } from './glsl.js';
import { U } from './materials.js';

const common = () => ({ uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash, uPoolPos: U.uPoolPos, uPoolCol: U.uPoolCol });

function personGeo() {
  const g = new Geo({ color: 3, aPart: 1 });
  // legs
  g.set('aPart', -1); g.set('color', 0.03, 0.03, 0.035);
  g.box(-0.16, -0.03, 0.0, 0.86, -0.06, 0.07);
  g.set('aPart', 1);
  g.box(0.03, 0.16, 0.0, 0.86, -0.06, 0.07);
  g.set('aPart', 0);
  // shoes
  g.set('color', 0.02, 0.02, 0.02);
  // coat
  const coat = [[0.06, 0.62], [0.24, 0.66], [0.22, 0.9], [0.19, 1.1], [0.22, 1.36], [0.2, 1.44], [0.09, 1.5], [0.06, 1.53]];
  const cc = [[0.05, 0.05, 0.06], [0.12, 0.08, 0.05], [0.04, 0.06, 0.08], [0.1, 0.1, 0.11], [0.15, 0.03, 0.05]];
  g.set('color', 0.06, 0.06, 0.07);
  g.lathe(0, 0, coat, 10);
  // head
  g.set('color', 0.05, 0.045, 0.045);
  g.lathe(0, 0.01, [[0.0, 1.52], [0.08, 1.55], [0.11, 1.62], [0.1, 1.7], [0.06, 1.75], [0.0, 1.77]], 8);
  // arm up to the umbrella handle
  g.set('color', 0.06, 0.06, 0.07);
  const m = new THREE.Matrix4().makeTranslation(0.17, 1.38, 0.02).multiply(new THREE.Matrix4().makeRotationZ(0.5));
  g.setMatrix(m); g.box(-0.04, 0.04, -0.02, 0.34, -0.05, 0.05); g.setMatrix(null);
  // umbrella canopy (dark translucent look via low albedo) with ribs
  g.set('color', 0.05, 0.06, 0.08);
  const can = [[0.0, 2.22], [0.18, 2.2], [0.4, 2.12], [0.56, 2.02], [0.64, 1.93]];
  g.lathe(0.02, 0.0, can, 16);
  return g;
}

function umbrellaLights() {
  const g = new Geo({ aKind: 1 });
  g.set('aKind', 0);
  g.cylinder(0.02, 0.0, 0.016, 0.016, 1.42, 2.22, 6, false);
  g.set('aKind', 1);
  // glowing rim
  const pts = []; for (let i = 0; i <= 32; i++) { const a = i / 32 * Math.PI * 2; pts.push(new THREE.Vector3(0.02 + Math.cos(a) * 0.645, 1.925, Math.sin(a) * 0.645)); }
  g.tube(pts, 0.012, 4);
  // inner canopy glow ribs
  g.set('aKind', 2);
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2; const rib = [];
    for (let i = 0; i <= 6; i++) { const t = i / 6; const r = 0.64 * t; const y = 2.21 - 0.29 * t * t; rib.push(new THREE.Vector3(0.02 + Math.cos(a) * r, y - 0.012, Math.sin(a) * r)); }
    g.tube(rib, 0.006, 3);
  }
  return g;
}

export function buildCrowd(path) {
  const r = new RNG(55);
  const N = 170;
  const bodyGeo = personGeo().build();
  const lightGeo = umbrellaLights().build();
  const info = new Float32Array(N * 4);
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: common(),
    vertexShader: /* glsl */`
      attribute float aPart; attribute vec3 color; attribute vec4 aW;
      uniform float uTime;
      varying vec3 vCol; varying vec3 vWP; varying vec3 vN;
      void main(){
        vec3 p = position;
        float sw = sin(uTime * aW.y * 5.2 + aW.x) * 0.42 * aPart;
        if (abs(aPart) > 0.5) { float hy = 0.86; float yy = p.y - hy; float zz = p.z; p.y = hy + yy * cos(sw) - zz * sin(sw); p.z = yy * sin(sw) + zz * cos(sw); }
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWP = wp.xyz; vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vCol = color;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec3 vWP; varying vec3 vN;
      ${POOL_PARS}
      ${FOG_PARS}
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWP);
        vec3 irr = poolIrradiance(vWP, N) * 0.6 + vec3(0.03, 0.03, 0.05);
        float rim = pow(1.0 - abs(dot(N, V)), 3.0);
        vec3 c = vCol * irr + poolVolume(vWP) * rim * 0.25;
        c = applyFog(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const lightMat = new THREE.ShaderMaterial({
    uniforms: common(),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aKind; attribute vec4 aW;
      varying vec3 vCol; varying vec3 vWP; varying float vK;
      void main(){
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWP = wp.xyz; vK = aKind;
        vec3 ic = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          ic = instanceColor;
        #endif
        vCol = ic * (aKind < 0.5 ? 7.0 : aKind < 1.5 ? 4.0 : 1.6);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec3 vWP; varying float vK;
      ${FOG_PARS}
      void main(){ gl_FragColor = vec4(applyFogAdd(vCol, vWP, cameraPosition), 1.0); }`,
  });
  const infoAttr = new THREE.InstancedBufferAttribute(info, 4);
  bodyGeo.setAttribute('aW', infoAttr); lightGeo.setAttribute('aW', infoAttr);
  const mesh = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, N);
  mesh.frustumCulled = false; lights.frustumCulled = false;
  mesh.layers.set(2); lights.layers.set(0);
  const cols = [PALETTE.cyan, PALETTE.magenta, PALETTE.pink, PALETTE.white, PALETTE.amber, PALETTE.teal, PALETTE.violet, PALETTE.green];
  const people = [];
  const Z0 = -270, Z1 = 125;
  for (let i = 0; i < N; i++) {
    const side = r.sign();
    const dir = side > 0 ? -1 : 1; // keep right
    const p = { x: side * r.range(12.3, 13.6), z: r.range(Z0, Z1), dir: r.chance(0.8) ? dir : -dir, v: r.range(1.0, 1.6), ph: r.f() * 6.28, sc: r.range(0.92, 1.08) };
    info[i * 4] = p.ph; info[i * 4 + 1] = p.v; info[i * 4 + 2] = 0; info[i * 4 + 3] = 0;
    lights.setColorAt(i, r.pick(cols));
    people.push(p);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), e = new THREE.Euler();
  let lastT = null;
  return {
    mesh, lights,
    update(t, cam) {
      const vis = cam.y < 45 && cam.x > -60 && cam.x < 60;
      mesh.visible = lights.visible = vis;
      const dt = lastT === null ? 0 : Math.min(0.05, t - lastT); lastT = t;
      if (!vis) return;
      for (let i = 0; i < N; i++) {
        const p = people[i];
        p.z += p.dir * p.v * dt;
        if (p.z < Z0) p.z += Z1 - Z0; if (p.z > Z1) p.z -= Z1 - Z0;
        const bob = Math.abs(Math.sin(t * p.v * 5.2 + p.ph)) * 0.035;
        pos.set(p.x, 0.16 + bob, p.z);
        e.set(0, p.dir > 0 ? 0 : Math.PI, Math.sin(t * p.v * 2.6 + p.ph) * 0.025);
        q.setFromEuler(e); s.setScalar(p.sc);
        m.compose(pos, q, s);
        mesh.setMatrixAt(i, m); lights.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true; lights.instanceMatrix.needsUpdate = true;
    },
  };
}
