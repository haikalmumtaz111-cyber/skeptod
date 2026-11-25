import * as THREE from 'three';
import { NOISE, FOG_PARS } from './glsl.js';
import { U } from './materials.js';

export function buildSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash, uBoltPos: { value: new THREE.Vector3(0, 0, -1) } },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uBoltPos;
      varying vec3 vDir;
      ${NOISE}
      ${FOG_PARS}
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 horizon = fogColorAt(d, 40.0);
        vec3 zen = vec3(0.006, 0.008, 0.02);
        vec3 col = mix(horizon, zen, smoothstep(-0.02, 0.55, h));
        if (h > -0.05) {
          float hh = max(h, 0.0) + 0.04;
          vec2 p = d.xz / hh * 0.9;
          vec2 wind = vec2(uTime * 0.012, uTime * 0.004);
          float n = fbm(p * 0.9 + wind);
          float n2 = fbm(p * 2.3 - wind * 1.7 + n * 1.5);
          float dens = smoothstep(0.32, 0.85, n * 0.65 + n2 * 0.5);
          // underlit by the city: warm magenta near horizon, cold toward zenith
          vec3 under = mix(vec3(0.16, 0.045, 0.12), vec3(0.03, 0.035, 0.08), smoothstep(0.0, 0.45, h));
          under *= 0.55 + 0.6 * n2;
          // lightning illumination localized around the bolt direction
          float lit = pow(max(dot(d, normalize(uBoltPos)), 0.0), 6.0);
          under += vec3(0.55, 0.6, 0.95) * uFlash * (0.25 + 1.4 * lit) * (0.4 + n2);
          float fade = smoothstep(-0.03, 0.12, h);
          col = mix(col, under, dens * fade * 0.92);
          // darker gaps
          col *= 1.0 - (1.0 - dens) * 0.25 * fade;
        }
        col += vec3(0.4, 0.45, 0.7) * uFlash * 0.05;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, mat };
}

export class Lightning {
  constructor() { this.next = 9 + Math.random() * 8; this.t = -1; this.seq = []; }
  update(time, dt, skyMat) {
    if (time > this.next && this.t < 0) {
      this.t = 0; this.next = time + 14 + Math.random() * 18;
      const a = Math.random() * Math.PI * 2;
      skyMat.uniforms.uBoltPos.value.set(Math.cos(a), 0.25 + Math.random() * 0.3, Math.sin(a));
      this.seq = [[0, 0.07, 1.0], [0.11, 0.16, 0.5], [0.22, 0.38, 0.85], [0.45, 0.52, 0.3]].map(([a0, a1, k]) => [a0, a1, k * (0.6 + Math.random() * 0.5)]);
    }
    let f = 0;
    if (this.t >= 0) {
      this.t += dt;
      for (const [a0, a1, k] of this.seq) if (this.t >= a0 && this.t <= a1 + 0.25) { const x = this.t <= a1 ? 1 : 1 - (this.t - a1) / 0.25; f = Math.max(f, k * x); }
      if (this.t > 1.2) this.t = -1;
    }
    U.uFlash.value = f;
  }
}
