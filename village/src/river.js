// Water surfaces (river, upper stream, pond), waterfall, embankments and rocks.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { LOWER, UPPER, layout, hAt, height, WATER_Y, UPPER_Y, LAND_Y, lowerRiver, cliffZ, riverXAt } from './world.js';
import { RNG, fbm3, clamp, smoothstep } from './noise.js';
import { ATMO_GLSL, NOISE_GLSL, U } from './shaders.js';
import { srgb } from './geom.js';

export const waterUniforms = {
  uTime: U.time,
  uNormal: { value: null },
  uFoamTex: { value: null },
  uRefl: { value: null },
  uTexMat: { value: new THREE.Matrix4() },
  uReflOn: { value: 1 },
  uRes: { value: new THREE.Vector2(1, 1) },
};

const WATER_VS = /* glsl */ `
attribute float aDepth;
attribute vec2 aFlow;
attribute float aFoam;
uniform mat4 uTexMat;
varying vec3 vWP; varying float vDepth; varying vec2 vFlow; varying vec4 vRefl; varying float vFoam;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz; vDepth = aDepth; vFlow = aFlow; vFoam = aFoam;
  vRefl = uTexMat * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WATER_FS = /* glsl */ `
uniform sampler2D uNormal; uniform sampler2D uFoamTex; uniform sampler2D uRefl;
uniform float uTime; uniform float uReflOn;
varying vec3 vWP; varying float vDepth; varying vec2 vFlow; varying vec4 vRefl; varying float vFoam;
${ATMO_GLSL}
vec3 nrm(vec2 uv){ vec3 n = texture2D(uNormal, uv).xyz * 2.0 - 1.0; return vec3(n.x, n.z, n.y); }
void main(){
  vec2 flow = vFlow;
  float sp = length(flow);
  float cyc = 0.22;
  float p0 = fract(uTime * cyc), p1 = fract(uTime * cyc + 0.5);
  float wgt = abs(1.0 - 2.0 * p0);
  vec2 base = vWP.xz;
  vec2 o0 = flow * p0 / cyc, o1 = flow * p1 / cyc;
  vec3 nA = nrm((base - o0) * 0.16) * 0.6 + nrm((base - o0) * 0.47 + 0.3) * 0.4;
  vec3 nB = nrm((base - o1) * 0.16 + 0.5) * 0.6 + nrm((base - o1) * 0.47 + 0.8) * 0.4;
  vec3 n = mix(nA, nB, wgt);
  // still-water ripples drift
  vec3 nC = nrm(base * 0.09 + vec2(uTime * 0.013, uTime * 0.009));
  n = normalize(n + nC * 0.5);
  float strength = 0.22 + 0.4 * clamp(sp, 0.0, 1.6);
  vec3 N = normalize(vec3(n.x * strength, 1.0, n.z * strength));
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  F = clamp(F * 1.1, 0.0, 1.0);
  vec3 R = reflect(-V, N);
  vec3 refl;
  if (uReflOn > 0.5) {
    vec2 ruv = vRefl.xy / vRefl.w + N.xz * 0.045;
    refl = texture2D(uRefl, clamp(ruv, 0.001, 0.999)).rgb;
  } else {
    vec3 rr = R; rr.y = abs(rr.y);
    refl = skyBase(rr) * 0.85;
  }
  // sun glints
  float sd = max(dot(R, SUN_DIR), 0.0);
  vec3 sunC = vec3(2.4, 1.35, 0.6);
  vec3 spec = sunC * (pow(sd, 900.0) * 60.0 + pow(sd, 90.0) * 0.8);
  // water body
  float d = vDepth;
  vec3 shallow = vec3(0.12, 0.17, 0.11);
  vec3 deep = vec3(0.012, 0.045, 0.05);
  vec3 body = mix(shallow, deep, smoothstep(0.0, 1.8, d));
  // warm in-scatter from the low sun
  body += vec3(0.08, 0.045, 0.02) * (1.0 - smoothstep(0.0, 1.2, d));
  float T = exp(-d * 1.35);
  // foam
  vec2 fuv = (base - mix(o0, o1, step(0.5, wgt)) * 1.0) * 0.32;
  float fn = texture2D(uFoamTex, fuv).r * 0.6 + texture2D(uFoamTex, fuv * 2.3 + 0.37).r * 0.4;
  float shore = smoothstep(0.16, 0.0, d) * (0.5 + 0.5 * fn);
  float foam = clamp(max(shore * 0.75, vFoam) * smoothstep(0.35, 0.75, fn + vFoam * 0.35), 0.0, 1.0);
  vec3 foamC = vec3(0.95, 0.86, 0.78) * 0.95;
  vec3 col = body * (1.0 - F) * (1.0 - T) + refl * F + spec * (1.0 - foam);
  float a = 1.0 - (1.0 - F) * T;
  col = mix(col, foamC, foam * 0.85);
  a = mix(a, 1.0, foam * 0.85);
  // fog
  vec3 dv = vWP - cameraPosition;
  vec3 fogged = applyFog(col / max(a, 0.001), vWP);
  float dist = length(dv);
  float fa = 1.0 - exp(-dist * 0.0008);
  a = mix(a, 1.0, fa);
  gl_FragColor = vec4(fogged * a, a);
}`;

export function waterMaterial(reflOn = true) {
  const u = { ...waterUniforms, uReflOn: { value: reflOn ? 1 : 0 } };
  const m = new THREE.ShaderMaterial({
    uniforms: u, vertexShader: WATER_VS, fragmentShader: WATER_FS,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return m;
}

// Ribbon water along a polyline
function ribbon(pl, y, from, to, step, across, flowSign, foamFn) {
  const rows = [];
  for (let i = from; i <= to; i += step) rows.push(pl[Math.min(i, pl.length - 1)]);
  const nA = across;
  const pos = [], dep = [], flw = [], fm = [];
  for (const p of rows) {
    const nx = -p.tz, nz = p.tx;
    const W = p[2] + 3.5;
    for (let k = 0; k <= nA; k++) {
      const u = -1 + (2 * k) / nA;
      const x = p[0] + nx * u * W, z = p[1] + nz * u * W;
      pos.push(x, y, z);
      const h = hAt(x, z);
      const dd = Math.max(0, y - h);
      dep.push(dd);
      const edge = clamp(1 - Math.pow(Math.abs(u) * W / (p[2] + 0.5), 2), 0.12, 1);
      const sp = flowSign * edge;
      flw.push(p.tx * sp, p.tz * sp);
      fm.push(foamFn ? foamFn(x, z, dd) : 0);
    }
  }
  const idx = [];
  for (let r = 0; r < rows.length - 1; r++) for (let k = 0; k < nA; k++) {
    const a = r * (nA + 1) + k, b = a + 1, c = a + nA + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flw, 2));
  g.setAttribute('aFoam', new THREE.Float32BufferAttribute(fm, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const foamSpots = []; // {x,z,r,k}

function foamAt(x, z, dep) {
  let f = 0;
  for (const s of foamSpots) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r) f = Math.max(f, (1 - d / s.r) * s.k);
  }
  // waterfall plunge
  const dw = Math.hypot(x + 4, z + 97.5);
  f = Math.max(f, clamp(1 - dw / 9, 0, 1) * 1.0);
  return f;
}

export function buildWater(T) {
  waterUniforms.uNormal.value = T.waterNormal;
  waterUniforms.uFoamTex.value = T.foam;
  const group = new THREE.Group();
  // lower river (fine up to z=160, then coarse)
  let iEnd = LOWER.findIndex((p) => p[1] > 170);
  if (iEnd < 0) iEnd = LOWER.length - 1;
  const g1 = ribbon(LOWER, WATER_Y, 0, iEnd, 1, 22, 1.0, foamAt);
  const g2 = ribbon(LOWER, WATER_Y, iEnd, LOWER.length - 1, 6, 10, 1.1, null);
  const matL = waterMaterial(true);
  const m1 = new THREE.Mesh(g1, matL), m2 = new THREE.Mesh(g2, matL);
  m1.renderOrder = 2; m2.renderOrder = 2;
  group.add(m1, m2);
  // upper river
  const g3 = ribbon(UPPER, UPPER_Y, 0, UPPER.length - 1, 2, 12, -1.4, (x, z, d) => (z > -104 ? clamp((z + 106) / 5, 0, 1) * 0.8 : 0));
  const m3 = new THREE.Mesh(g3, waterMaterial(false));
  m3.renderOrder = 2;
  group.add(m3);
  // pond
  const P = layout.pond;
  const pg = new THREE.CircleGeometry(1, 48, 0, Math.PI * 2);
  pg.rotateX(-Math.PI / 2);
  const pp = pg.attributes.position;
  const dep = [], flw = [], fm = [];
  for (let i = 0; i < pp.count; i++) {
    let x = pp.getX(i) * (P.rx + 2.5), z = pp.getZ(i) * (P.rz + 2.5);
    const c = Math.cos(-P.rot), s = Math.sin(-P.rot);
    const wx = P.x + x * c + z * s, wz = P.z - x * s + z * c;
    pp.setXYZ(i, wx, WATER_Y, wz);
    dep.push(Math.max(0, WATER_Y - hAt(wx, wz)));
    flw.push(0, 0); fm.push(0);
  }
  pg.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
  pg.setAttribute('aFlow', new THREE.Float32BufferAttribute(flw, 2));
  pg.setAttribute('aFoam', new THREE.Float32BufferAttribute(fm, 1));
  const m4 = new THREE.Mesh(pg, matL);
  m4.renderOrder = 2;
  group.add(m4);
  group.name = 'water';
  return group;
}

// ---------- waterfall ----------
const FALL_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vWP = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const FALL_FS = /* glsl */ `
uniform sampler2D uStreak; uniform float uTime; uniform float uLayer;
varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
${ATMO_GLSL}
void main(){
  float v = vUv.y; // 0 top -> 1 bottom
  float speed = 0.9 + uLayer * 0.25;
  float vv = pow(v, 0.7) * 2.2 - uTime * speed;
  float s1 = texture2D(uStreak, vec2(vUv.x * 2.0 + uLayer * 0.37, vv)).r;
  float s2 = texture2D(uStreak, vec2(vUv.x * 5.0 + 0.2, vv * 1.7 - uTime * 0.4)).r;
  float s = s1 * 0.65 + s2 * 0.45;
  float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
  float a = clamp(s * 1.25 - 0.18, 0.0, 1.0) * edge;
  a *= smoothstep(0.0, 0.04, v);
  a = mix(a, a * 0.6 + 0.25 * edge, smoothstep(0.75, 1.0, v));
  vec3 V = normalize(cameraPosition - vWP);
  float back = pow(max(dot(-V, SUN_DIR), 0.0), 3.0);
  vec3 lit = vec3(1.0, 0.86, 0.74) * (0.55 + 0.45 * s) + vec3(1.6, 0.8, 0.35) * back * 0.8;
  lit = mix(lit * vec3(0.55, 0.7, 0.75), lit, s);
  lit *= 1.0 + smoothstep(0.85, 1.0, v) * 0.4;
  vec3 col = applyFog(lit, vWP);
  a *= 0.92 - uLayer * 0.25;
  gl_FragColor = vec4(col * a, a);
}`;

export function buildWaterfall(T) {
  const group = new THREE.Group();
  const top = UPPER[0];
  const x0 = top[0], zLip = cliffZ(x0) - 1.6;
  for (let layer = 0; layer < 3; layer++) {
    const nu = 16, nv = 28;
    const pos = [], uv = [], idx = [];
    const vx = 1.6 + layer * 0.35;
    const fallT = Math.sqrt((2 * (UPPER_Y + 0.2)) / 9.8);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const t = v * fallT;
      const y = UPPER_Y + 0.05 - 0.5 * 9.8 * t * t;
      const z = zLip + vx * t + layer * 0.12;
      const widthHalf = 3.6 + v * 1.6 + layer * 0.2;
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const x = x0 + (u - 0.5) * 2 * widthHalf + Math.sin(u * 9 + layer) * 0.12 * v;
        pos.push(x, Math.max(y, -0.1), z + Math.sin(u * 13.0 + layer * 2.0) * 0.18 * (0.3 + v));
        uv.push(u, v);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.ShaderMaterial({
      uniforms: { uStreak: { value: T.streak }, uTime: U.time, uLayer: { value: layer } },
      vertexShader: FALL_VS, fragmentShader: FALL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 3 + layer;
    group.add(mesh);
  }
  group.userData.foot = new THREE.Vector3(x0, 0, zLip + 2.6);
  return group;
}

// ---------- rocks & stones ----------
function rockGeometry(seed, detail = 3, squash = 0.7) {
  const rng = new RNG(seed * 977 + 13);
  const pts = [];
  const n = 22 + detail * 7;
  for (let i = 0; i < n; i++) {
    const u = rng.range(-1, 1), th = rng.range(0, Math.PI * 2), r = Math.sqrt(1 - u * u);
    const v = new THREE.Vector3(r * Math.cos(th), u, r * Math.sin(th));
    v.multiplyScalar(rng.range(0.74, 1.08));
    v.x *= rng.range(0.9, 1.15);
    v.y *= squash;
    if (v.y < -0.28) v.y = -0.28 + (v.y + 0.28) * 0.25;
    pts.push(v);
  }
  const g = new ConvexGeometry(pts);
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

function stoneBlockGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
  g.deleteAttribute('uv');
  const m = mergeVertices(g);
  const p = m.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // round edges (superellipsoid-ish)
    const v = new THREE.Vector3(x, y, z);
    const s = new THREE.Vector3(Math.sign(x), Math.sign(y), Math.sign(z));
    const k = 0.35;
    const ax = Math.abs(x) * 2, ay = Math.abs(y) * 2, az = Math.abs(z) * 2;
    const r = Math.pow(Math.pow(ax, 4) + Math.pow(ay, 4) + Math.pow(az, 4), 0.25);
    v.multiplyScalar(1 / Math.max(r, 0.001));
    v.lerp(new THREE.Vector3(x, y, z), 0.45);
    const n = fbm3(x * 3, y * 3, z * 3, 2) * 0.06;
    p.setXYZ(i, v.x * (1 + n), v.y * (1 + n), v.z * (1 + n));
  }
  m.computeVertexNormals();
  m.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.count * 2), 2));
  return m;
}

const ROCK_GLSL_PARS = /* glsl */ `
varying vec3 vRWP; varying vec3 vRWN;
`;
export function rockMaterial(T, mossAmt = 1) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, map: T.stone, envMapIntensity: 0.7 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMoss = { value: mossAmt };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROCK_GLSL_PARS)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 rwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          rwp = instanceMatrix * rwp;
          vRWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vRWN = normalize(mat3(modelMatrix) * objectNormal);
        #endif
        vRWP = (modelMatrix * rwp).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMoss;\n' + ROCK_GLSL_PARS + NOISE_GLSL)
      .replace('#include <map_fragment>', `
        vec3 rp = vRWP; vec3 rn = normalize(vRWN);
        vec3 bw = pow(abs(rn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 tx = texture2D(map, rp.zy * 0.45).rgb * bw.x + texture2D(map, rp.xz * 0.45).rgb * bw.y + texture2D(map, rp.xy * 0.45).rgb * bw.z;
        diffuseColor.rgb *= tx;
        float mn = fbm3(rp.xz * 1.7 + rp.y);
        float moss = smoothstep(0.3, 0.68, rn.y + (mn - 0.5) * 0.8) * uMoss;
        moss *= 1.0 - smoothstep(-0.2, 0.25, rp.y) * 0.0;
        vec3 mossC = mix(vec3(0.13, 0.24, 0.05), vec3(0.32, 0.42, 0.1), mn);
        diffuseColor.rgb = mix(diffuseColor.rgb, mossC, moss);
        float wetLine = 1.0 - smoothstep(0.0, 0.35, rp.y - (rp.z > -99.0 ? 0.0 : 12.0));
        diffuseColor.rgb *= 1.0 - wetLine * 0.45;
      `);
  };
  return m;
}

export function buildStones(T) {
  const group = new THREE.Group();
  const rng = new RNG(808);
  const blockG = stoneBlockGeometry();
  const blocks = [];
  // embankment walls along the walled river section
  for (const side of [1, -1]) {
    let acc = 0;
    for (let i = 0; i < LOWER.length - 1; i++) {
      const p = LOWER[i];
      if (p[1] < -67 || p[1] > 61) continue;
      const q = LOWER[i + 1];
      acc += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    // walk along the polyline at even spacing
    const pts = LOWER.filter((p) => p[1] >= -67 && p[1] <= 61);
    let s = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push([s, l, i]); s += l; }
    const courses = 6;
    for (let c = 0; c < courses; c++) {
      let u = (c % 2) * 0.35;
      while (u < s) {
        const len = rng.range(0.55, 0.95);
        const um = u + len / 2;
        const sg = seg.find((q) => um >= q[0] && um <= q[0] + q[1]) || seg[seg.length - 1];
        const i = sg[2], t = (um - sg[0]) / sg[1];
        const a = pts[i - 1], b = pts[i];
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const tx = a.tx, tz = a.tz;
        const hw = a[2];
        const nx = -tz * side, nz = tx * side;
        const y = -1.05 + c * 0.44 + rng.range(-0.03, 0.03);
        const batter = (courses - c) * 0.07;
        const off = hw - 0.45 + batter * 0.6;
        let skip = false;
        for (const B of layout.bridges) if (Math.abs(z - B.z) < B.w / 2 + 0.6 && B.type !== 'plank') skip = c > 3 && false;
        if (!skip) blocks.push({ x: x + nx * off, y, z: z + nz * off, rot: Math.atan2(tx, tz), sx: len, sy: rng.range(0.4, 0.5), sz: rng.range(0.55, 0.8), c: rng.range(0.8, 1.15) });
        u += len + 0.03;
      }
    }
    // coping stones on top
    let u = 0;
    while (u < s) {
      const len = rng.range(0.9, 1.5);
      const um = u + len / 2;
      const sg = seg.find((q) => um >= q[0] && um <= q[0] + q[1]) || seg[seg.length - 1];
      const i = sg[2], t = (um - sg[0]) / sg[1];
      const a = pts[i - 1], b = pts[i];
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const nx = -a.tz * side, nz = a.tx * side;
      const off = a[2] - 0.05;
      blocks.push({ x: x + nx * off, y: LAND_Y - 0.05, z: z + nz * off, rot: Math.atan2(a.tx, a.tz), sx: len, sy: 0.24, sz: 0.85, c: rng.range(0.9, 1.1) });
      u += len + 0.04;
    }
  }
  // temple terrace retaining walls (battered ishigaki)
  const TT = layout.terrace;
  const edges = [
    [TT.x - TT.w / 2, TT.z + TT.d / 2, TT.x + TT.w / 2, TT.z + TT.d / 2, 0, 1],
    [TT.x + TT.w / 2, TT.z + TT.d / 2, TT.x + TT.w / 2, TT.z - TT.d / 2, 1, 0],
    [TT.x + TT.w / 2, TT.z - TT.d / 2, TT.x - TT.w / 2, TT.z - TT.d / 2, 0, -1],
    [TT.x - TT.w / 2, TT.z - TT.d / 2, TT.x - TT.w / 2, TT.z + TT.d / 2, -1, 0],
  ];
  for (const [x0, z0, x1, z1, nx, nz] of edges) {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / L, dz = (z1 - z0) / L;
    const rot = Math.atan2(dx, dz);
    for (let c = 0; c < 10; c++) {
      let u = (c % 2) * 0.4;
      const y = LAND_Y - 0.6 + c * 0.42;
      if (y > TT.h + 0.1) break;
      while (u < L) {
        const len = rng.range(0.7, 1.2);
        const um = u + len / 2;
        const x = x0 + dx * um, z = z0 + dz * um;
        // skip the stair opening on the east side
        const ground = hAt(x + nx * 2.0, z + nz * 2.0);
        if (!(nx === 1 && Math.abs(z - layout.steps.z) < layout.steps.w / 2 + 0.2) && y > ground - 0.6) {
          const batter = (TT.h - y) * 0.16;
          blocks.push({ x: x + nx * (batter + 0.15), y, z: z + nz * (batter + 0.15), rot, sx: len, sy: rng.range(0.38, 0.46), sz: 0.7, c: rng.range(0.75, 1.15) });
        }
        u += len + 0.04;
      }
    }
  }
  // stone paving (ishidatami) along the temple approach and the teahouse lane
  const pave = (pts, width) => {
    let total = 0; const seg = [];
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push([total, l, i]); total += l; }
    let row = 0;
    for (let u = 0.3; u < total - 0.2; u += 0.62) {
      const sg = seg.find((q2) => u >= q2[0] && u <= q2[0] + q2[1]) || seg[seg.length - 1];
      const i = sg[2], t = (u - sg[0]) / sg[1];
      const a = pts[i - 1], b2 = pts[i];
      const x = a[0] + (b2[0] - a[0]) * t, z = a[1] + (b2[1] - a[1]) * t;
      const dx = (b2[0] - a[0]) / sg[1], dz = (b2[1] - a[1]) / sg[1];
      const rot = Math.atan2(dx, dz);
      let w = -width / 2 + (row % 2) * 0.3;
      while (w < width / 2 - 0.15) {
        const sw = Math.min(rng.range(0.45, 0.85), width / 2 - w);
        const cx = x + (-dz) * (w + sw / 2) * -1, cz = z + dx * (w + sw / 2) * -1;
        const gy = hAt(cx, cz);
        blocks.push({ x: cx, y: gy + 0.02, z: cz, rot, sx: sw - 0.05, sy: 0.14, sz: 0.56, c: rng.range(0.85, 1.12) });
        w += sw;
      }
      row++;
    }
  };
  pave(layout.paths[0].pts, 3.0);
  {
    const zb = layout.bridges[0].z, rxb = layout.bridges[0].x;
    pave([[rxb + 11.2, zb], [rxb + 29, zb]], 2.4);
  }
  const stoneMat = rockMaterial(T, 0.55);
  const im = new THREE.InstancedMesh(blockG, stoneMat, blocks.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();
  blocks.forEach((s, i) => {
    e.set(rng.range(-0.04, 0.04), s.rot + rng.range(-0.05, 0.05), rng.range(-0.04, 0.04));
    q.setFromEuler(e);
    m4.compose(v.set(s.x, s.y, s.z), q, sc.set(s.sx, s.sy, s.sz));
    im.setMatrixAt(i, m4);
    const base = srgb('#9a948a');
    col.setRGB(base[0] * s.c, base[1] * s.c * 0.99, base[2] * s.c * 0.97);
    im.setColorAt(i, col);
  });
  im.castShadow = true; im.receiveShadow = true;
  group.add(im);

  // natural rocks: waterfall cliff, pool, natural banks, garden, hills
  const rockGs = [rockGeometry(1, 3, 0.75), rockGeometry(2, 3, 0.9), rockGeometry(3, 3, 0.6), rockGeometry(4, 2, 0.8)];
  const rocks = [[], [], [], []];
  const addRock = (x, y, z, s, sy = 1, mossK = 1) => {
    rocks[rng.int(0, 3)].push({ x, y, z, s, sy, ry: rng.range(0, 6.28), rx: rng.range(-0.2, 0.2), c: rng.range(0.75, 1.15) * mossK });
  };
  // cliff face boulders
  for (let i = 0; i < 130; i++) {
    const x = rng.range(-40, 34);
    if (Math.abs(x + 4) < 4.4) continue;
    const cz = cliffZ(x);
    const y = Math.pow(rng.next(), 0.8) * (UPPER_Y + 1.4) - 0.8;
    const z = cz - 1.2 + (1 - y / UPPER_Y) * 2.8 + rng.range(-0.7, 1.0);
    const big = y < 3 ? rng.range(1.4, 3.0) : rng.range(0.9, 2.4);
    addRock(x, y, z, big, rng.range(0.65, 1.15));
  }
  // flanking the waterfall
  for (const sx of [-1, 1]) for (let k = 0; k < 7; k++) {
    const x = -4 + sx * rng.range(4.5, 7.5);
    const y = k * 1.8 - 0.5;
    addRock(x, y, cliffZ(x) - 0.8 + (k < 3 ? 1.5 : 0), rng.range(1.6, 2.6), 0.9);
  }
  // pool rocks + natural banks
  for (let i = 0; i < LOWER.length; i += 2) {
    const p = LOWER[i];
    const natural = p[1] < -68 || p[1] > 62;
    if (!natural || p[1] > 240) continue;
    for (const side of [1, -1]) {
      if (!rng.chance(0.55)) continue;
      const off = p[2] + rng.range(-1.2, 1.8);
      const x = p[0] - p.tz * side * off, z = p[1] + p.tx * side * off;
      const h = hAt(x, z);
      addRock(x, h - 0.2, z, rng.range(0.35, 1.3), rng.range(0.6, 1.0));
    }
  }
  // a few mid-stream boulders with foam
  for (const [x, z, s] of [[-8, -86, 1.3], [5, -90, 1.1], [3, -70, 0.9], [-1, -64, 0.7], [16, 96, 1.0], [22, 122, 1.2], [9, 80, 0.8]]) {
    addRock(x, -0.6, z, s, 0.9);
    foamSpots.push({ x, z, r: s * 2.2, k: 0.7 });
  }
  // garden rocks around pond
  const P = layout.pond;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const lx = Math.cos(a) * (P.rx + rng.range(-0.6, 0.6)), lz = Math.sin(a) * (P.rz + rng.range(-0.6, 0.6));
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    const x = P.x + lx * c - lz * s, z = P.z + lx * s + lz * c;
    addRock(x, hAt(x, z) - 0.15, z, rng.range(0.4, 1.1), rng.range(0.6, 1.0));
  }
  // tobi-ishi stepping stones through the garden
  for (let i = 0; i < 16; i++) {
    const a = -0.4 + i * 0.16;
    const lx = Math.cos(a + Math.PI * 0.5) * (P.rx + 3.4) + Math.sin(i * 2.1) * 0.35, lz = Math.sin(a + Math.PI * 0.5) * (P.rz + 3.2);
    const c = Math.cos(P.rot), s = Math.sin(P.rot);
    const x = P.x + lx * c - lz * s, z = P.z + lx * s + lz * c;
    rocks[3].push({ x, y: hAt(x, z) - 0.05, z, s: rng.range(0.38, 0.5), sy: 0.28, ry: rng.range(0, 6.28), rx: 0, c: 1.1 });
  }
  // dry garden rocks on the temple terrace (karesansui)
  for (const [x, z, s] of [[-44, -40, 1.4], [-42.5, -41.8, 0.8], [-46, -38, 0.6], [-40, -68, 1.2], [-41.5, -69.5, 0.7]]) addRock(x, layout.terrace.h - 0.2, z, s, 0.8, 0.6);
  // hill boulders
  for (let i = 0; i < 90; i++) {
    const x = rng.range(-150, 150), z = rng.range(-160, 140);
    const rx = riverXAt(z);
    if (Math.abs(x - rx) < 45) continue;
    const h = hAt(x, z);
    if (h < LAND_Y + 2) continue;
    addRock(x, h - 0.3, z, rng.range(0.8, 2.4), rng.range(0.6, 1.0));
  }
  const rmat = rockMaterial(T, 1.0);
  rocks.forEach((arr, k) => {
    if (!arr.length) return;
    const mesh = new THREE.InstancedMesh(rockGs[k], rmat, arr.length);
    arr.forEach((r, i) => {
      e.set(r.rx, r.ry, rng.range(-0.15, 0.15));
      q.setFromEuler(e);
      m4.compose(v.set(r.x, r.y, r.z), q, sc.set(r.s * rng.range(0.85, 1.25), r.s * r.sy, r.s * rng.range(0.85, 1.25)));
      mesh.setMatrixAt(i, m4);
      const b = srgb('#c2bbad');
      col.setRGB(b[0] * r.c, b[1] * r.c, b[2] * r.c * 0.97);
      mesh.setColorAt(i, col);
    });
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  });

  // stepping stones
  const ss = layout.steppingStones;
  const sg = new THREE.CylinderGeometry(1, 1.08, 1, 10, 1);
  const sm = new THREE.InstancedMesh(rockGeometry(9, 2, 0.5), rockMaterial(T, 0.35), ss.length);
  ss.forEach((s, i) => {
    q.setFromEuler(e.set(0, s.rot, 0));
    m4.compose(v.set(s.x, 0.0, s.z), q, sc.set(s.r, 0.55, s.r * 0.85));
    sm.setMatrixAt(i, m4);
    col.setRGB(0.62, 0.6, 0.56);
    sm.setColorAt(i, col);
    foamSpots.push({ x: s.x, z: s.z, r: s.r * 1.9, k: 0.55 });
  });
  sm.castShadow = true; sm.receiveShadow = true;
  group.add(sm);
  // foam around bridge piers
  for (const B of layout.bridges) {
    const piers = B.type === 'arch' ? [-0.62, -0.25, 0.25, 0.62] : B.type === 'flat' ? [-0.5, 0, 0.5] : [-0.6, -0.2, 0.2, 0.6];
    for (const u of piers) {
      const lx = u * B.len / 2;
      for (const sz of [-1, 1]) {
        const lz = sz * (B.w / 2 - 0.2);
        const c = Math.cos(B.rot), s = Math.sin(B.rot);
        foamSpots.push({ x: B.x + lx * c + lz * s, z: B.z - lx * s + lz * c, r: 1.1, k: 0.5 });
      }
    }
  }
  return group;
}
