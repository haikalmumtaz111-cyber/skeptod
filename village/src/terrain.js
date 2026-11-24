// Terrain mesh with warped grid (dense in the village, sparse far away) + ground mask.
import * as THREE from 'three';
import { layout, height, riverXAt, LOWER, LAND_Y, cliffZ, UPPER_Y, baseHeight } from './world.js';
import { simplex2, smoothstep, clamp } from './noise.js';
import { NOISE_GLSL } from './shaders.js';

export const MASK = { x0: -170, z0: -180, size: 340, res: 1024, data: null, tex: null };

export function buildGroundMask() {
  const R = MASK.res;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = R; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, R, R); return [c, x]; };
  const [cR, xR] = mk(), [cG, xG] = mk(), [cB, xB] = mk();
  const P = (x, z) => [((x - MASK.x0) / MASK.size) * R, ((z - MASK.z0) / MASK.size) * R];
  const S = (m) => (m / MASK.size) * R;
  const line = (ctx, pts, w, a = 1, blur = 0) => {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = S(w); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (blur) ctx.filter = `blur(${S(blur)}px)`;
    ctx.beginPath();
    pts.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); });
    ctx.stroke(); ctx.restore();
  };
  const rect = (ctx, x, z, w, d, rot, a = 1, blur = 0) => {
    ctx.save();
    if (blur) ctx.filter = `blur(${S(blur)}px)`;
    const [px, pz] = P(x, z);
    ctx.translate(px, pz); ctx.rotate(rot);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(-S(w) / 2, -S(d) / 2, S(w), S(d));
    ctx.restore();
  };
  const along = (off, z0, z1, step = 3) => {
    const pts = [];
    for (let z = z0; z <= z1; z += step) pts.push([riverXAt(z) + off, z]);
    return pts;
  };
  // promenades (gravel) on top of the embankments
  line(xG, along(9.7, -68, 64), 2.6, 0.75, 0.4);
  line(xG, along(-9.7, -12, 64), 2.6, 0.75, 0.4);
  line(xR, along(-9.7, -70, -12), 2.0, 0.6, 0.6);
  // streets (packed earth)
  line(xR, along(30.5, -68, 76), 4.6, 1, 0.6);
  line(xR, along(-30.5, -6, 76), 4.2, 1, 0.6);
  // cross alleys
  for (const z of [-40, -14, 12, 33, 52]) {
    line(xR, [[riverXAt(z) + 9, z], [riverXAt(z) + 31, z]], 2.6, 0.9, 0.5);
  }
  for (const z of [33, 52, 20]) line(xR, [[riverXAt(z) - 9, z], [riverXAt(z) - 31, z]], 2.6, 0.9, 0.5);
  // farm lanes
  line(xR, [[riverXAt(22) - 31, 22], [-74, 22], [-82, -6]], 2.2, 0.8, 0.6);
  line(xR, [[riverXAt(48) - 31, 48], [-70, 48], [-88, 34]], 2.2, 0.8, 0.6);
  line(xR, [[riverXAt(68) - 31, 68], [-60, 70]], 2.2, 0.8, 0.6);
  // temple terrace gravel
  const T = layout.terrace;
  rect(xG, T.x, T.z, T.w - 0.6, T.d - 0.6, 0, 0.95, 0.2);
  // approach
  const ap = layout.paths[0].pts;
  line(xG, ap, 3.8, 1, 0.3);
  rect(xG, -25, -46, 7, 7, 0, 1, 0.3);
  // north-east lanes
  line(xR, [[riverXAt(-58) + 31, -58], [52, -60], [36, -76], [28, -86]], 2.4, 0.85, 0.6);
  // pond garden path
  const pd = layout.pond;
  {
    const pts = [];
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.2) {
      const lx = Math.cos(a) * (pd.rx + 3.2), lz = Math.sin(a) * (pd.rz + 3.0);
      const c = Math.cos(pd.rot), s = Math.sin(pd.rot);
      pts.push([pd.x + lx * c - lz * s, pd.z + lx * s + lz * c]);
    }
    line(xG, pts.slice(8, 26), 1.6, 0.8, 0.3);
    line(xR, [[riverXAt(-12) - 9, -12], [pd.x + 12, -10]], 1.6, 0.6, 0.4);
  }
  // torii path + shrine plateau
  line(xG, layout.toriiPath.pts, 3.0, 1, 0.3);
  line(xR, [[riverXAt(10) + 31, 10], layout.toriiPath.pts[0]], 3.0, 0.9, 0.5);
  rect(xG, layout.shrine.x, layout.shrine.z, 13, 13, -layout.shrine.rot, 0.9, 1.0);
  // natural pebble beaches
  for (const [z0, z1] of [[-99, -70], [62, 160]]) {
    const pts = [];
    for (const p of LOWER) if (p[1] >= z0 && p[1] <= z1) pts.push(p);
    for (const side of [1, -1]) {
      const sp = pts.map((p) => [p[0] - p.tz * side * (p[2] + 0.8), p[1] + p.tx * side * (p[2] + 0.8)]);
      line(xG, sp, 3.2, 0.55, 0.8);
    }
  }
  // house footprints (no grass)
  for (const h of layout.houses) rect(xB, h.x, h.z, h.w + 1.4, h.d + 1.4, -h.rot, 1, 0.5);
  rect(xB, T.x, T.z, T.w, T.d, 0, 1, 0);
  rect(xB, layout.teahouse.x, layout.teahouse.z, 9, 9, -layout.teahouse.rot, 1, 0.6);

  // combine
  const dR = xR.getImageData(0, 0, R, R).data, dG = xG.getImageData(0, 0, R, R).data, dB = xB.getImageData(0, 0, R, R).data;
  const data = new Uint8Array(R * R * 4);
  for (let i = 0; i < R * R; i++) {
    data[i * 4] = dR[i * 4]; data[i * 4 + 1] = dG[i * 4]; data[i * 4 + 2] = dB[i * 4]; data[i * 4 + 3] = 255;
  }
  MASK.data = data;
  const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat);
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  MASK.tex = tex;
  return tex;
}

export function maskAt(x, z) {
  const R = MASK.res;
  const u = Math.floor(((x - MASK.x0) / MASK.size) * R), v = Math.floor(((z - MASK.z0) / MASK.size) * R);
  if (u < 0 || v < 0 || u >= R || v >= R) return [0, 0, 0];
  const i = (v * R + u) * 4;
  return [MASK.data[i] / 255, MASK.data[i + 1] / 255, MASK.data[i + 2] / 255];
}

const CX = 0, CZ = -15;
function warp(u, A = 125, E = 1750) {
  const B = E - A;
  return A * u + B * Math.pow(Math.abs(u), 7) * Math.sign(u);
}

export function forestAmount(x, z, h) {
  // forest canopy on hillsides, away from the village floor
  const rx = riverXAt(clamp(z, -790, 790));
  const dx = Math.abs(x - rx);
  const hill = smoothstep(LAND_Y + 4, LAND_Y + 13, h) * smoothstep(40, 62, dx);
  const north = smoothstep(-104, -112, z) * smoothstep(UPPER_Y + 1, UPPER_Y + 6, h);
  const f = Math.max(hill, north);
  const breakup = smoothstep(-0.55, -0.1, simplex2(x * 0.012, z * 0.012));
  return f * breakup * (1 - smoothstep(260, 420, h));
}

export function buildTerrain(maskTex) {
  const N = 560;
  const n1 = N + 1;
  const pos = new Float32Array(n1 * n1 * 3);
  const gnd = new Float32Array(n1 * n1 * 3);
  for (let j = 0; j < n1; j++) {
    const z = CZ + warp(-1 + (2 * j) / N);
    for (let i = 0; i < n1; i++) {
      const x = CX + warp(-1 + (2 * i) / N);
      let h = height(x, z);
      const f = forestAmount(x, z, h);
      const bump = 0.5 + 0.5 * simplex2(x * 0.085, z * 0.085) + 0.3 * simplex2(x * 0.21 + 4, z * 0.21);
      const canopy = f * (2.2 + 3.6 * clamp(bump, 0, 1.3));
      const k = (j * n1 + i) * 3;
      pos[k] = x; pos[k + 1] = h + canopy; pos[k + 2] = z;
      gnd[k] = f; gnd[k + 1] = clamp(bump, 0, 1);
      gnd[k + 2] = z > cliffZ(x) ? 0 : UPPER_Y;
    }
  }
  const idx = new Uint32Array(N * N * 6);
  let q = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1;
    // alternate diagonal for better shape
    if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
    else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aGround', new THREE.BufferAttribute(gnd, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, envMapIntensity: 0.45 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMask = { value: maskTex };
    sh.uniforms.uMaskRect = { value: new THREE.Vector3(MASK.x0, MASK.z0, MASK.size) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aGround;\nvarying vec3 vGround;\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = aGround;\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMask;\nuniform vec3 uMaskRect;\nvarying vec3 vGround;\nvarying vec3 vWP;\nvarying vec3 vWN;\n' + NOISE_GLSL + TERRAIN_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (length(vWP.xz - vec2(0.0, -15.0)) > 1650.0) discard;\nfloat tWet = 0.0;\ndiffuseColor.rgb = terrainColor(vWP, normalize(vWN), vGround, tWet);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, tWet);');
  };
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  return mesh;
}

const TERRAIN_GLSL = /* glsl */ `
vec3 terrainColor(vec3 p, vec3 n, vec3 g, out float wetOut){
  float n1 = fbm3(p.xz * 0.035);
  float n2 = vnoise(p.xz * 0.45);
  float n3 = vnoise(p.xz * 2.7);
  float n4 = vnoise(p.xz * 9.0);
  vec3 grassA = vec3(0.10, 0.23, 0.04);
  vec3 grassB = vec3(0.27, 0.39, 0.07);
  vec3 grass = mix(grassA, grassB, smoothstep(0.25, 0.8, n1));
  grass = mix(grass, vec3(0.40, 0.38, 0.14), smoothstep(0.55, 0.9, n2) * 0.32);
  grass *= 0.8 + 0.25 * n3 + 0.12 * n4;
  vec3 dirt = vec3(0.40, 0.30, 0.20) * (0.82 + 0.25 * n3 + 0.1 * n4);
  vec3 gravel = vec3(0.62, 0.59, 0.53) * (0.84 + 0.22 * n4 + 0.08 * n3);
  vec3 rock = mix(vec3(0.27, 0.25, 0.23), vec3(0.42, 0.39, 0.35), n2) * (0.78 + 0.38 * n4);
  vec3 moss = vec3(0.14, 0.25, 0.06) * (0.8 + 0.4 * n3);
  vec3 forest = mix(vec3(0.045, 0.11, 0.04), vec3(0.12, 0.20, 0.055), n2) * (0.45 + 0.85 * g.y);
  forest = mix(forest, vec3(0.20, 0.26, 0.07), smoothstep(0.75, 0.95, fbm3(p.xz * 0.02 + 7.0)) * 0.5);
  vec3 bed = mix(vec3(0.22, 0.2, 0.14), vec3(0.13, 0.17, 0.08), n2) * (0.6 + 0.6 * n4);
  vec3 c = grass;
  c = mix(c, forest, g.x);
  float slope = 1.0 - n.y;
  vec3 rk = mix(rock, moss, smoothstep(0.55, 0.85, n.y + 0.25 * (n2 - 0.5)));
  float strata = 0.72 + 0.4 * vnoise(vec2((p.x + p.z) * 0.12, p.y * 2.2)) + 0.15 * vnoise(vec2((p.x - p.z) * 0.9, p.y * 7.0));
  strata = mix(strata, 0.95, smoothstep(120.0, 380.0, length(p - cameraPosition)));
  c = mix(c, rk * strata, smoothstep(0.34, 0.58, slope) * (1.0 - g.x * 0.75));
  vec2 muv = (p.xz - uMaskRect.xy) / uMaskRect.z;
  if (muv.x > 0.0 && muv.y > 0.0 && muv.x < 1.0 && muv.y < 1.0) {
    vec4 m = texture2D(uMask, muv);
    float edgeN = (n3 - 0.5) * 0.5;
    c = mix(c, dirt, smoothstep(0.15, 0.6, m.r + edgeN));
    vec3 gv = gravel;
    if (p.y > 3.6 && p.y < 5.0) {
      // raked gravel (karesansui) on the temple terrace
      float rk2 = sin(p.z * 10.0 + sin(p.x * 0.35) * 1.2);
      gv *= 0.9 + 0.13 * smoothstep(-0.2, 0.9, rk2);
    }
    c = mix(c, gv, smoothstep(0.15, 0.6, m.g + edgeN));
    c = mix(c, mix(c, dirt * 0.8, 0.6), m.b * 0.5);
  }
  float wl = g.z;
  float wet = 1.0 - smoothstep(wl - 0.05, wl + 0.6, p.y);
  c = mix(c, c * 0.5, wet * 0.85);
  c = mix(c, bed, 1.0 - smoothstep(wl - 0.5, wl + 0.02, p.y));
  c = mix(c, mix(vec3(0.17, 0.19, 0.17), vec3(0.36, 0.34, 0.36), n2), smoothstep(140.0, 320.0, p.y) * 0.7);
  wetOut = wet * (1.0 - smoothstep(wl - 0.2, wl - 0.6, p.y));
  return c;
}
`;
