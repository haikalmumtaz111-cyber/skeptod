// Sky dome (sunset gradient, sun, animated clouds), distant mountain ring, snow-capped volcano.
import * as THREE from 'three';
import { ATMO_GLSL, NOISE_GLSL, U } from './shaders.js';
import { baseHeight, FUJI } from './world.js';
import { simplex2, fbm2, ridged2, softRidge2, clamp, smoothstep } from './noise.js';

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position * 5000.0 + cameraPosition, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}`;

const SKY_FS = /* glsl */ `
uniform float uTime; uniform float uEnv;
varying vec3 vDir;
${ATMO_GLSL}
${NOISE_GLSL}
float cloudField(vec2 p, float t){
  vec2 w = vec2(t * 0.0035, t * 0.0012);
  float n = fbm5(p * 1.3 + w);
  float d = fbm5(p * 3.1 + w * 1.8 + n * 0.8);
  return n * 0.7 + d * 0.38;
}
void main(){
  vec3 dir = normalize(vDir);
  vec3 col = skyBase(dir);
  float sd = dot(dir, SUN_DIR);
  float sa = max(sd, 0.0);
  if (dir.y > 0.0) {
    // stretched altocumulus / streak clouds on a plane
    vec2 uv = dir.xz / (dir.y + 0.06);
    mat2 rot = mat2(0.86, 0.5, -0.5, 0.86);
    vec2 cuv = rot * uv * vec2(0.55, 1.6) * 0.55;
    float c = cloudField(cuv, uTime);
    float cov = smoothstep(0.52, 0.82, c);
    float cl = cloudField(cuv + (rot * SUN_DIR.xz) * 0.05, uTime);
    float lit = clamp((c - cl) * 4.0 + 0.55, 0.0, 1.0);
    vec3 cDark = mix(vec3(0.24, 0.17, 0.32), vec3(0.62, 0.30, 0.32), pow(sa, 2.0));
    vec3 cLit = mix(vec3(1.25, 0.55, 0.45), vec3(3.2, 1.55, 0.6), pow(sa, 3.0));
    vec3 cc = mix(cDark, cLit, lit);
    cc += vec3(3.0, 1.5, 0.6) * pow(sa, 20.0) * (1.0 - cov) * 2.0;
    float fade = smoothstep(0.0, 0.1, dir.y) * (1.0 - smoothstep(0.55, 0.95, dir.y) * 0.6);
    // high wispy cirrus
    vec2 ciuv = rot * uv * vec2(0.2, 2.2) * 0.35 + vec2(uTime * 0.002, 0.0);
    float ci = smoothstep(0.55, 0.9, fbm5(ciuv * 2.0)) * 0.55;
    vec3 ciC = mix(vec3(0.9, 0.5, 0.55), vec3(2.6, 1.3, 0.55), pow(sa, 2.0));
    col = mix(col, ciC, ci * fade * 0.6);
    col = mix(col, cc, cov * fade * 0.92);
    // sun disk
    float disk = smoothstep(0.99962, 0.99978, sd);
    col += vec3(36.0, 21.0, 10.0) * disk * (1.0 - cov * 0.85) * (1.0 - uEnv * 0.95);
  } else {
    vec3 g = mix(vec3(0.16, 0.14, 0.12), vec3(0.1, 0.12, 0.08), smoothstep(0.0, -0.3, dir.y));
    col = mix(fogColorDir(dir), g, uEnv * smoothstep(0.0, -0.15, dir.y));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildSky() {
  const g = new THREE.SphereGeometry(1, 96, 48);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: U.time, uEnv: { value: 0 } },
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}

export function buildMountains() {
  const group = new THREE.Group();
  // ring beyond the terrain mesh, same height function for continuity
  const NA = 720, NR = 46;
  const r0 = 1640, r1 = 7600;
  const pos = [], col = [];
  const cx = 0, cz = -15;
  for (let j = 0; j <= NR; j++) {
    const t = j / NR;
    const r = r0 * Math.pow(r1 / r0, t);
    for (let i = 0; i <= NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const x = cx + Math.sin(a) * r, z = cz - Math.cos(a) * r;
      let h = baseHeight(x, z);
      // extra far range layering
      h += smoothstep(2500, 5200, r) * (80 + 300 * Math.pow(softRidge2(x * 0.0008 + 3, z * 0.0008 - 1, 4), 2.4));
      const ang = a > Math.PI ? a - 2 * Math.PI : a;
      const dF = Math.abs(ang - Math.atan2(FUJI.x, -(FUJI.z + 15)));
      h *= 1 - 0.55 * (1 - smoothstep(0.05, 0.3, dF)) * smoothstep(2600, 3600, r);
      pos.push(x, h - (j === 0 ? 2 : 0), z);
      const rock = clamp((h - 220) / 260, 0, 1);
      const n = 0.5 + 0.5 * simplex2(x * 0.004, z * 0.004);
      const base = [0.07 + 0.03 * n, 0.12 + 0.04 * n, 0.07];
      const rc = [0.3, 0.29, 0.3];
      const snow = smoothstep(560, 700, h + 60 * simplex2(x * 0.01, z * 0.01));
      let c = [base[0] + (rc[0] - base[0]) * rock, base[1] + (rc[1] - base[1]) * rock, base[2] + (rc[2] - base[2]) * rock];
      c = [c[0] + (0.9 - c[0]) * snow, c[1] + (0.9 - c[1]) * snow, c[2] + (0.92 - c[2]) * snow];
      col.push(c[0], c[1], c[2]);
    }
  }
  const idx = [];
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * (NA + 1) + i, b = a + 1, c = a + NA + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const ring = new THREE.Mesh(g, mat);
  ring.name = 'mountains';
  group.add(ring);

  // the great volcano
  const F = FUJI;
  const NAf = 256, NRf = 64;
  const fp = [], fc = [];
  for (let j = 0; j <= NRf; j++) {
    const t = j / NRf; // 0 top -> 1 base
    for (let i = 0; i <= NAf; i++) {
      const a = (i / NAf) * Math.PI * 2;
      const rr = t * F.R;
      const ridges = 1 + 0.04 * Math.sin(a * 23) * t + 0.03 * simplex2(Math.cos(a) * 4, Math.sin(a) * 4 + t * 3) * t;
      let h = F.H * Math.pow(1 - t, 1.75) * ridges;
      if (t < 0.035) h = F.H * Math.pow(1 - 0.035, 1.75) - (0.035 - t) * 260; // crater lip
      const x = F.x + Math.sin(a) * rr, z = F.z + Math.cos(a) * rr;
      fp.push(x, h - 30, z);
      const sn = smoothstep(0.42, 0.3, t + 0.09 * simplex2(Math.cos(a) * 6, Math.sin(a) * 6) + 0.05 * Math.sin(a * 37));
      const lower = [0.11, 0.13, 0.13];
      const mid = [0.22, 0.2, 0.22];
      const k = smoothstep(0.9, 0.45, t);
      let c = [lower[0] + (mid[0] - lower[0]) * k, lower[1] + (mid[1] - lower[1]) * k, lower[2] + (mid[2] - lower[2]) * k];
      c = [c[0] + (0.95 - c[0]) * sn, c[1] + (0.95 - c[1]) * sn, c[2] + (0.97 - c[2]) * sn];
      fc.push(...c);
    }
  }
  const fi = [];
  for (let j = 0; j < NRf; j++) for (let i = 0; i < NAf; i++) {
    const a = j * (NAf + 1) + i, b = a + 1, c = a + NAf + 1, d = c + 1;
    fi.push(a, c, b, b, c, d);
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fg.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
  fg.setIndex(fi);
  fg.computeVertexNormals();
  const fuji = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.6 }));
  fuji.name = 'fuji';
  group.add(fuji);
  return group;
}
