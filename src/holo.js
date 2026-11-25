import * as THREE from 'three';
import { NOISE, FOG_PARS } from './glsl.js';
import { U } from './materials.js';

const common = () => ({ uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash });

// ----------------------------------------------------------------- koi geometry (local: tail at z=0, head at z=1, unit length)
function koiGeometry() {
  const pos = [], nrm = [], tz = [], kind = [], idx = [];
  const segs = 18, rings = 40;
  const prof = (t) => {
    const a = Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.97 + 0.035)), 0.7);
    const tailTaper = 0.3 + 0.7 * Math.min(1, t * 2.2);
    return 0.1 * a * tailTaper;
  };
  const pushV = (x, y, z, nx, ny, nz, k) => { pos.push(x, y, z); nrm.push(nx, ny, nz); tz.push(z); kind.push(k); return pos.length / 3 - 1; };
  for (let i = 0; i <= rings; i++) {
    const t = i / rings; const r = prof(t);
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2; const c = Math.cos(a), s = Math.sin(a);
      pushV(c * r * 0.72, s * r, t, c, s * 0.72, 0, 0);
    }
  }
  const rs = segs + 1;
  for (let i = 0; i < rings; i++) for (let k = 0; k < segs; k++) { const a = i * rs + k, b = a + 1, c = a + rs, d = c + 1; idx.push(a, b, d, a, d, c); }
  const fin = (pts, k) => { const base = pos.length / 3; for (const p of pts) pushV(p[0], p[1], p[2], 1, 0, 0, k); for (let i = 1; i < pts.length - 1; i++) idx.push(base, base + i, base + i + 1); };
  // tail fin (two lobes)
  fin([[0, 0.0, 0.04], [0, 0.03, 0.0], [0, 0.16, -0.16], [0, 0.11, -0.2], [0, 0.04, -0.12], [0, 0.0, -0.09]], 1);
  fin([[0, 0.0, 0.04], [0, 0.0, -0.09], [0, -0.04, -0.12], [0, -0.11, -0.2], [0, -0.16, -0.16], [0, -0.03, 0.0]], 1);
  // dorsal fin
  fin([[0, 0.07, 0.35], [0, 0.13, 0.42], [0, 0.135, 0.55], [0, 0.1, 0.66], [0, 0.085, 0.7]], 2);
  // pectoral fins
  for (const sx of [-1, 1]) fin([[sx * 0.06, -0.04, 0.74], [sx * 0.2, -0.09, 0.62], [sx * 0.22, -0.08, 0.7], [sx * 0.07, -0.03, 0.8]], 2);
  // pelvic fins
  for (const sx of [-1, 1]) fin([[sx * 0.05, -0.06, 0.48], [sx * 0.13, -0.12, 0.4], [sx * 0.12, -0.1, 0.48]], 2);
  // whiskers
  for (const sx of [-1, 1]) fin([[sx * 0.03, -0.02, 0.99], [sx * 0.09, -0.06, 1.06], [sx * 0.092, -0.055, 1.065], [sx * 0.032, -0.015, 0.995]], 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  g.setIndex(idx);
  return g;
}

function holoMaterial(colA, colB) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(common(), { uColA: { value: colA }, uColB: { value: colB }, uScale: { value: 30 }, uPhase: { value: 0 }, uSwim: { value: 1 }, uGain: { value: 1.25 } }),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aKind;
      uniform float uTime; uniform float uScale; uniform float uPhase; uniform float uSwim;
      varying vec3 vWP; varying vec3 vN; varying vec3 vL; varying float vK;
      void main(){
        vec3 p = position;
        float t = p.z;
        float w = sin(t * 7.0 - uTime * 6.0 * uSwim + uPhase) * 0.06 * pow(max(1.0 - t, 0.0), 1.4) + sin(uTime * 1.3 + uPhase) * 0.012;
        p.x += w;
        vL = position; vK = aKind;
        vec4 wp = modelMatrix * vec4(p * uScale, 1.0);
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uColA; uniform vec3 uColB; uniform float uPhase; uniform float uGain;
      varying vec3 vWP; varying vec3 vN; varying vec3 vL; varying float vK;
      ${NOISE}
      ${FOG_PARS}
      void main(){
        vec3 V = normalize(cameraPosition - vWP);
        float fres = 1.0 - abs(dot(normalize(vN), V));
        float t = vL.z;
        vec3 c = mix(uColA, uColB, smoothstep(0.1, 0.95, t));
        // koi patches
        float spots = smoothstep(0.55, 0.62, vnoise(vL.zy * vec2(9.0, 14.0) + vec2(uPhase, 0.0)));
        c = mix(c, vec3(1.0, 0.55, 0.35), spots * 0.45 * step(vK, 0.5));
        // scales lattice
        float rings = smoothstep(0.08, 0.0, abs(fract(t * 46.0) - 0.5) - 0.42);
        float body = vK < 0.5 ? (0.08 + 0.85 * pow(fres, 2.5) + 0.3 * rings) : (0.3 + 0.5 * smoothstep(0.3, 0.0, abs(fract(length(vL.yz) * 40.0) - 0.5)));
        float scan = 0.65 + 0.35 * step(0.45, fract(vWP.y * 1.4 - uTime * 3.0));
        float flick = 0.85 + 0.15 * step(0.15, hash11(floor(uTime * 20.0) + uPhase));
        float glitch = step(0.96, hash12(vec2(floor(vWP.y * 2.0), floor(uTime * 8.0))));
        c *= body * scan * flick * (1.0 + glitch * 1.2) * uGain;
        c = applyFogAdd(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

export class Koi {
  constructor(center, rx, rz) {
    this.center = center; this.rx = rx; this.rz = rz;
    const geo = koiGeometry();
    this.fish = [];
    const cols = [[new THREE.Color(0.1, 0.8, 1.0), new THREE.Color(1.0, 0.25, 0.6)], [new THREE.Color(1.0, 0.45, 0.1), new THREE.Color(1.0, 0.15, 0.4)]];
    this.group = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const mat = holoMaterial(cols[i][0], cols[i][1]);
      mat.uniforms.uScale.value = i ? 24 : 30; mat.uniforms.uPhase.value = i * 2.3;
      const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 12;
      this.group.add(m);
      this.fish.push({ mesh: m, off: i * 0.55, y: i ? 70 : 62, scale: i ? 24 : 30 });
    }
    this._p = new THREE.Vector3(); this._a = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
  }
  pos(th, y, out) { return out.set(this.center.x + Math.cos(th) * this.rx, y + Math.sin(th * 2.0) * 8, this.center.z + Math.sin(th) * this.rz); }
  update(t) {
    for (const f of this.fish) {
      const th = -t * 0.11 - f.off;
      this.pos(th, f.y, this._p); this.pos(th - 0.02, f.y, this._a);
      const dx = this._a.x - this._p.x, dy = this._a.y - this._p.y, dz = this._a.z - this._p.z;
      const yaw = Math.atan2(dx, dz); const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
      this._e.set(pitch, yaw, 0.25, 'YXZ');
      f.mesh.quaternion.setFromEuler(this._e);
      // position so that the fish's middle follows the path
      f.mesh.position.copy(this._p).addScaledVector(new THREE.Vector3(dx, dy, dz).normalize(), -f.scale * 0.5);
    }
  }
}

// ----------------------------------------------------------------- floating holographic sculpture over an intersection
export class HoloSculpture {
  constructor(pos) {
    this.group = new THREE.Group(); this.group.position.copy(pos);
    const mk = (geo, a, b, sc) => {
      const mat = holoMaterial(a, b); mat.uniforms.uScale.value = sc; mat.uniforms.uSwim.value = 0;
      geo.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count).fill(0), 1));
      const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 12; this.group.add(m); return m;
    };
    this.knot = mk(new THREE.TorusKnotGeometry(0.5, 0.11, 220, 16, 2, 3), new THREE.Color(1.0, 0.2, 0.7), new THREE.Color(0.2, 0.8, 1.0), 9);
    this.core = mk(new THREE.IcosahedronGeometry(0.3, 1), new THREE.Color(0.3, 0.9, 1.0), new THREE.Color(1.0, 0.6, 0.2), 9);
    // projector rings beneath
    const ringGeo = new THREE.TorusGeometry(0.6, 0.012, 6, 64); ringGeo.rotateX(Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < 3; i++) { const r = mk(ringGeo.clone(), new THREE.Color(0.2, 0.9, 1.0), new THREE.Color(0.2, 0.9, 1.0), 9 + i * 2.5); r.position.y = -7 - i * 1.6; this.rings.push(r); }
  }
  update(t) {
    this.knot.rotation.set(t * 0.21, t * 0.33, 0);
    this.core.rotation.set(-t * 0.5, t * 0.4, t * 0.2);
    this.group.position.y += 0;
    this.rings.forEach((r, i) => { r.rotation.y = t * (0.5 + i * 0.3); r.scale.setScalar(1 + 0.05 * Math.sin(t * 2 + i)); });
  }
}
