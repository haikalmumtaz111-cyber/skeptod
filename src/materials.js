import * as THREE from 'three';
import { NOISE, FOG_PARS, POOL_PARS } from './glsl.js';

export const U = {
  uTime: { value: 0 },
  uFogLow: { value: new THREE.Color(0.05, 0.03, 0.078) },
  uFogHigh: { value: new THREE.Color(0.012, 0.026, 0.052) },
  uFogDensity: { value: 0.0048 },
  uFogHeight: { value: 70 },
  uFlash: { value: 0 },
  uPoolPos: { value: Array.from({ length: 12 }, () => new THREE.Vector4(0, -1000, 0, 1)) },
  uPoolCol: { value: Array.from({ length: 12 }, () => new THREE.Vector3()) },
};

function commonUniforms() {
  return { uTime: U.uTime, uFogLow: U.uFogLow, uFogHigh: U.uFogHigh, uFogDensity: U.uFogDensity, uFogHeight: U.uFogHeight, uFlash: U.uFlash };
}

const FACADE_FRAG = /* glsl */`
vec3 facadeEmissive = vec3(0.0);
{
  vec3 N = normalize(vWN);
  float style = floor(vWin.x + 0.5);
  float seed = vWin.y;
  float floorH = vWin.z;
  float colW = vWin.w;
  float wallLen = vWall.x;
  float baseY = vWall.y;
  float shop = vWall.z;
  float topY = vWall.w;
  float y = vWP.y;
  vec3 base = diffuseColor.rgb;
  float rough = 0.5;
  float metal = 0.2;
  float hseed = fract(seed * 0.6180339);
  float camDist = length(vWP - cameraPosition);
  float lodF = smoothstep(90.0, 320.0, camDist);
  if (abs(N.y) < 0.5) {
    float u = vUv.x;
    vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)));
    // cladding panels
    vec2 pc = vec2(u / max(colW, 0.5), (y - baseY) / max(floorH, 0.5));
    vec2 pid = floor(pc); vec2 pf = fract(pc);
    float pv = hash12(pid + seed);
    base *= 0.8 + 0.35 * pv;
    float seam = smoothstep(0.0, 0.025, pf.x) * smoothstep(0.0, 0.025, 1.0 - pf.x) * smoothstep(0.0, 0.05, pf.y) * smoothstep(0.0, 0.05, 1.0 - pf.y);
    base *= mix(0.45, 1.0, seam);
    // rain streaks and grime
    float streak = vnoise(vec2(u * 2.3 + seed * 13.0, y * 0.045 - seed));
    float streak2 = mix(vnoise(vec2(u * 9.0 + seed * 3.0, y * 0.12)), 0.5, smoothstep(40.0, 160.0, camDist));
    base *= 0.7 + 0.4 * streak * (0.7 + 0.3 * streak2);
    rough = mix(0.16, 0.5, smoothstep(0.25, 0.75, streak2));
    metal = 0.25 + 0.3 * pv;
    float grimeLow = smoothstep(6.0, 0.0, y - baseY);
    base *= 1.0 - 0.35 * grimeLow;
    if (style > 0.5) {
      float nCols = max(1.0, floor(wallLen / colW));
      float margin = (wallLen - nCols * colW) * 0.5;
      float cu = (u - margin) / colW;
      float col = floor(cu);
      float fy = (y - baseY) / floorH;
      float flr = floor(fy);
      vec2 cell = vec2(fract(cu), fract(fy));
      float inGrid = step(0.0, col) * step(col, nCols - 1.0) * step(0.0, flr) * step(y, topY - 0.9) * step(baseY + 0.4, y);
      vec4 wr;
      if (style < 1.5) wr = vec4(0.14, 0.86, 0.22, 0.84);
      else if (style < 2.5) wr = vec4(-0.01, 1.01, 0.3, 0.8);
      else if (style < 3.5) wr = vec4(0.035, 0.965, 0.12, 0.97);
      else if (style < 4.5) wr = vec4(0.27, 0.73, 0.3, 0.8);
      else wr = vec4(0.4, 0.6, 0.06, 0.94);
      float wx = step(wr.x, cell.x) * step(cell.x, wr.y) * step(wr.z, cell.y) * step(cell.y, wr.w);
      // frame band around window
      float fr = step(wr.x - 0.03, cell.x) * step(cell.x, wr.y + 0.03) * step(wr.z - 0.035, cell.y) * step(cell.y, wr.w + 0.035);
      float isWin = wx * inGrid;
      if (fr * inGrid > 0.5 && isWin < 0.5) { base = vec3(0.13, 0.14, 0.16); metal = 0.85; rough = 0.25; }
      if (style > 1.5 && style < 3.5) { // continuous glass: subtle mullions
        float ml = step(0.985, fract(cu * (style < 2.5 ? 2.0 : 1.0)));
        if (ml > 0.5 && isWin > 0.5) { isWin = 0.0; base = vec3(0.1); metal = 0.9; rough = 0.3; }
      }
      if (isWin > 0.5) {
        vec2 wid = vec2(col, flr) + seed * 17.0;
        float r = hash12(wid);
        float floorLit = hash12(vec2(flr * 1.37, seed * 3.1));
        float litP = 0.24 + 0.42 * fract(seed * 7.13);
        float lit = step(r, litP * (floorLit > 0.4 ? 1.35 : 0.3));
        float cr = hash12(wid + 7.3);
        vec3 wc = cr < 0.46 ? vec3(1.0, 0.55, 0.24) : (cr < 0.78 ? vec3(1.0, 0.8, 0.58) : (cr < 0.93 ? vec3(0.55, 0.75, 1.0) : (cr < 0.965 ? vec3(1.0, 0.25, 0.65) : vec3(0.2, 0.85, 1.0))));
        float inten = mix(0.35, 1.9, hash12(wid + 3.1));
        vec3 V = normalize(vWP - cameraPosition);
        vec3 tv = vec3(dot(V, T), V.y, dot(V, N));
        float ww = max((wr.y - wr.x) * colW, 0.3), wh = max((wr.w - wr.z) * floorH, 0.3);
        if (style > 1.5 && style < 3.5) ww = colW * (style < 2.5 ? 1.0 : 1.0);
        vec2 lc = vec2(clamp((cell.x - wr.x) / (wr.y - wr.x), 0.0, 1.0), clamp((cell.y - wr.z) / (wr.w - wr.z), 0.0, 1.0));
        float roomD = 1.1;
        vec3 d = vec3(tv.x / ww, tv.y / wh, tv.z / ww);
        d.z = min(d.z, -1e-3);
        float tx = d.x > 0.0 ? (1.0 - lc.x) / max(d.x, 1e-4) : lc.x / max(-d.x, 1e-4);
        float ty = d.y > 0.0 ? (1.0 - lc.y) / max(d.y, 1e-4) : lc.y / max(-d.y, 1e-4);
        float tz = roomD / -d.z;
        float t = min(min(tx, ty), tz);
        vec3 hp = vec3(lc, 0.0) + d * t;
        float shade;
        if (tz <= tx && tz <= ty) {
          shade = 0.85;
          // furniture silhouette on the back wall
          float fx = hash12(wid + 21.0);
          float furn = smoothstep(0.02, 0.0, hp.y - (0.3 + 0.25 * fx)) * smoothstep(0.0, 0.02, hp.x - (0.15 + 0.3 * fx)) * smoothstep(0.0, 0.02, (0.55 + 0.4 * fx) - hp.x);
          shade *= 1.0 - 0.55 * furn * (1.0 - lodF);
          shade *= 0.85 + 0.3 * hp.y;
        } else if (ty < tx) {
          shade = d.y > 0.0 ? 1.35 : 0.28;
        } else {
          shade = 0.55;
        }
        shade *= mix(1.0, 0.55, clamp(-hp.z / roomD, 0.0, 1.0));
        vec3 room = wc * inten * shade * lit;
        float blind = hash12(wid + 11.0);
        if (blind > 0.55) {
          float cover = step(1.0 - (blind - 0.55) * 2.2, lc.y);
          float sf = lc.y * wh * 3.0;
          float stripes = mix(0.6 + 0.4 * smoothstep(0.3, 0.5, abs(fract(sf) - 0.5) * 2.0), 0.8, clamp(fwidth(sf) * 1.5, 0.0, 1.0));
          room = mix(room, wc * inten * lit * 0.5 * stripes, cover);
        }
        room = mix(room, wc * inten * lit * 0.75, lodF);
        float tvf = step(0.965, hash12(wid + 5.0));
        room *= mix(1.0, 0.55 + 0.45 * sin(uTime * 11.0 + r * 40.0) * sin(uTime * 4.3 + r * 9.0), tvf);
        facadeEmissive += room;
        base = vec3(0.015, 0.018, 0.024);
        rough = 0.05; metal = 0.0;
      }
    }
    // storefront zone
    float shopZone = step(0.5, shop) * step(y, 4.6) * step(0.17, y);
    if (shopZone > 0.5) {
      float sw = 3.4;
      float bu = u / sw; float bay = floor(bu); float bx = fract(bu);
      float bh = hash12(vec2(bay, seed * 5.0));
      vec3 sc = bh < 0.25 ? vec3(1.0, 0.2, 0.6) : (bh < 0.45 ? vec3(0.2, 0.8, 1.0) : (bh < 0.7 ? vec3(1.0, 0.7, 0.35) : (bh < 0.85 ? vec3(0.5, 0.3, 1.0) : vec3(0.3, 1.0, 0.6))));
      base = vec3(0.08, 0.08, 0.09); metal = 0.7; rough = 0.3;
      float pane = step(0.05, bx) * step(bx, 0.95) * step(0.3, y) * step(y, 3.45);
      float band = step(0.05, bx) * step(bx, 0.95) * step(3.62, y) * step(y, 4.42);
      if (pane > 0.5) {
        if (bh > 0.78) {
          float corr = 0.65 + 0.35 * sin(y * 46.0);
          base = vec3(0.2, 0.21, 0.23) * corr; rough = 0.35; metal = 0.75;
          float gap = smoothstep(0.75, 0.3, y);
          facadeEmissive += sc * gap * 1.5;
        } else {
          vec3 V = normalize(vWP - cameraPosition);
          float vx = dot(V, T), vz = dot(V, N);
          float dd = 2.6 / max(-vz, 0.08);
          vec2 hp = vec2(u + vx * dd, y + V.y * dd);
          float shelfY = fract(hp.y * 1.35);
          float shelf = step(0.88, shelfY);
          vec2 item = floor(vec2(hp.x * 4.0, hp.y * 1.35));
          float ih = hash12(item + bay);
          vec3 ic = mix(sc, vec3(1.0, 0.9, 0.8), ih * 0.6) * (0.4 + 0.8 * ih) * step(0.25, shelfY) * step(shelfY, 0.8) * step(0.25, ih);
          float floorG = smoothstep(1.4, 0.2, hp.y);
          vec3 room = sc * 0.35 + ic * 0.9 + vec3(1.0, 0.95, 0.9) * shelf * 0.7 + sc * floorG * 0.4;
          room *= 1.6;
          facadeEmissive += room * (0.75 + 0.25 * step(0.5, fract(hp.x * 0.5)));
          base = vec3(0.01); rough = 0.04; metal = 0.0;
        }
      } else if (band > 0.5) {
        float bb = hash12(vec2(bay, seed * 9.0));
        if (bb < 0.75) {
          float v = (y - 3.62) / 0.8;
          float pat = 0.65 + 0.35 * step(0.5, fract(bx * 3.0 + bb * 5.0));
          float edge = 1.0 - smoothstep(0.38, 0.5, abs(v - 0.5));
          facadeEmissive += sc * 2.6 * pat * edge * (0.85 + 0.15 * sin(uTime * 3.0 + bay));
          base = vec3(0.02);
        }
      }
    }
  } else {
    // roofs and ledges tops: wet tar with puddles
    float n = fbm3(vWP.xz * 0.25 + seed);
    base *= 0.55 + 0.6 * n;
    float pud = smoothstep(0.48, 0.56, fbm3(vWP.xz * 0.11 + seed * 3.0));
    rough = mix(0.45, 0.04, pud); metal = 0.1;
    base *= mix(1.0, 0.4, pud);
  }
  // neon wash from street level
  float gsel = fract(seed * 3.731);
  vec3 glowC = gsel < 0.33 ? vec3(1.0, 0.15, 0.55) : (gsel < 0.66 ? vec3(0.1, 0.6, 1.0) : vec3(1.0, 0.45, 0.15));
  float wash = exp(-max(y, 0.0) / 9.0) * 1.2 + exp(-max(y, 0.0) / 40.0) * 0.12;
  facadeEmissive += base * glowC * wash * step(abs(N.y), 0.5);
  diffuseColor.rgb = base;
  roughnessFactor = rough;
  metalnessFactor = metal;
}
`;

const STD_FRAG = /* glsl */`
{
  float n = vnoise(vWP.xz * 1.3 + vWP.y * 0.7);
  roughnessFactor = clamp(roughnessFactor * (0.55 + 0.7 * n), 0.04, 1.0);
}
`;

export function patchStandard(mat, kind) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, commonUniforms());
    const facade = kind === 'facade';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vWP; varying vec3 vWN;
${facade ? 'attribute vec4 aWin; attribute vec4 aWall; flat varying vec4 vWin; flat varying vec4 vWall;' : ''}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  vec4 wpos4 = vec4(transformed, 1.0);
  vec3 wn3 = objectNormal;
  #ifdef USE_INSTANCING
    wpos4 = instanceMatrix * wpos4;
    wn3 = mat3(instanceMatrix) * wn3;
  #endif
  wpos4 = modelMatrix * wpos4; vWP = wpos4.xyz;
  vWN = normalize(mat3(modelMatrix) * wn3);
  ${facade ? 'vWin = aWin; vWall = aWall;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWP; varying vec3 vWN;
uniform float uTime;
${facade ? 'flat varying vec4 vWin; flat varying vec4 vWall;' : ''}
${NOISE}
${FOG_PARS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
${facade ? FACADE_FRAG : kind === 'std' ? STD_FRAG : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${facade ? 'totalEmissiveRadiance += facadeEmissive;' : ''}`)
      .replace('#include <fog_fragment>', `gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP, cameraPosition);`);
  };
  mat.customProgramCacheKey = () => 'cp_' + kind;
  return mat;
}

export function makeFacadeMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.9 });
  m.defines = { USE_UV: '' };
  return patchStandard(m, 'facade');
}
export function makeTrimMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial(Object.assign({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.55, envMapIntensity: 1.0 }, opts));
  return patchStandard(m, 'std');
}

// --- Neon tubes ------------------------------------------------------------
export function makeNeonMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({}, commonUniforms()),
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec4 aNeon;
      uniform float uTime;
      varying vec3 vCol; varying float vB; varying vec3 vWP; varying vec3 vN;
      float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
        float m = aNeon.y; float ph = aNeon.z; float sp = aNeon.w;
        float b = 1.0;
        if (m < 0.5) b = 0.95 + 0.05 * sin(uTime * 90.0 + ph * 10.0);
        else if (m < 1.5) {
          float burst = step(0.72, h11(floor(uTime * 1.7 + ph * 13.0)));
          float n = h11(floor(uTime * 19.0) + ph * 101.0);
          b = mix(1.0, 0.08 + 0.92 * step(0.5, n), burst);
        }
        else if (m < 2.5) b = 0.6 + 0.4 * sin(uTime * sp * 2.0 + ph * 6.283);
        else if (m < 3.5) b = 0.12 + 0.88 * smoothstep(0.35, 0.65, fract(ph - uTime * sp));
        else b = 0.12 + 0.88 * step(0.45, fract(uTime * sp + ph));
        vB = b * aNeon.x;
        vCol = aCol;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vB; varying vec3 vWP; varying vec3 vN;
      ${FOG_PARS}
      void main(){
        vec3 V = normalize(cameraPosition - vWP);
        float core = abs(dot(normalize(vN), V));
        vec3 c = vCol * vB * (0.5 + 0.8 * core);
        c += vec3(1.0, 0.95, 0.95) * vB * pow(core, 4.0) * 0.45;
        c = applyFog(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// --- Animated screens / billboards (no text, abstract only) -----------------
const SCREEN_FUNCS = /* glsl */`
vec3 npal(float t, float s){
  vec3 a = vec3(1.0, 0.1, 0.6), b = vec3(0.1, 0.85, 1.0), c = vec3(1.0, 0.55, 0.1), d = vec3(0.55, 0.2, 1.0);
  float k = fract(s * 3.17);
  vec3 c1 = k < 0.25 ? a : (k < 0.5 ? b : (k < 0.75 ? c : d));
  vec3 c2 = k < 0.25 ? b : (k < 0.5 ? d : (k < 0.75 ? a : b));
  return mix(c1, c2, clamp(t, 0.0, 1.0));
}
float sdHex(vec2 p, float r){ const vec3 k = vec3(-0.866025404,0.5,0.577350269); p = abs(p); p -= 2.0*min(dot(k.xy,p),0.0)*k.xy; p -= vec2(clamp(p.x, -k.z*r, k.z*r), r); return length(p)*sign(p.y); }
float sdBox2(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,0.0)) + min(max(d.x,d.y),0.0); }
vec3 screenContent(vec2 uv, float mode, float seed, float aspect, float t){
  vec3 col = vec3(0.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float m = floor(mode + 0.5);
  if (m < 0.5) { // equalizer bars
    float nb = 14.0 + floor(fract(seed * 7.0) * 10.0);
    float bx = floor(uv.x * nb); float fx = fract(uv.x * nb);
    float hgt = 0.15 + 0.75 * (0.5 + 0.5 * sin(t * (2.0 + hash11(bx + seed) * 4.0) + bx * 0.7)) * (0.6 + 0.4 * vnoise(vec2(bx * 0.5, t * 3.0)));
    float bar = step(0.12, fx) * step(fx, 0.88) * step(uv.y, hgt);
    float seg = step(0.3, fract(uv.y * 22.0));
    col = npal(uv.y, seed) * bar * seg * 1.4 + npal(1.0 - uv.y, seed) * 0.08;
  } else if (m < 1.5) { // iris rings
    float r = length(p); float a = atan(p.y, p.x);
    float rings = smoothstep(0.02, 0.0, abs(fract(r * 6.0 - t * 0.6) - 0.5) - 0.18);
    float arcs = step(0.5, fract(a / 6.283 * 8.0 + t * 0.25 * sign(fract(r * 3.0) - 0.5)));
    float iris = smoothstep(0.2, 0.17, r) * (0.6 + 0.4 * sin(a * 24.0 + t * 2.0));
    float pupil = smoothstep(0.075, 0.06, r + 0.015 * sin(t * 3.0));
    col = npal(r * 1.6, seed) * (rings * arcs * smoothstep(0.75, 0.2, r) * 1.3 + iris * 1.6) * (1.0 - pupil) + vec3(1.0) * pupil * 0.05;
  } else if (m < 2.5) { // plasma
    vec2 q = p * 3.0;
    float v = sin(q.x + t) + sin(q.y * 1.3 - t * 0.8) + sin((q.x + q.y) * 0.8 + t * 1.3) + sin(length(q + vec2(sin(t * 0.3), cos(t * 0.4)) * 2.0) * 2.0);
    v = v * 0.25 + 0.5;
    col = npal(v, seed) * (0.5 + 1.0 * smoothstep(0.4, 0.9, v));
    float circ = smoothstep(0.42, 0.4, length(p)) - smoothstep(0.36, 0.34, length(p));
    col += vec3(1.0) * circ * 0.8;
  } else if (m < 3.5) { // chevrons
    vec2 q = vec2(p.x * 2.0, p.y * 2.0);
    float c = fract(q.y * 1.5 + abs(q.x) * 1.2 - t * 1.2);
    float chev = step(0.55, c);
    col = npal(fract(q.y * 0.3 - t * 0.2), seed) * chev * 1.2 * smoothstep(1.0, 0.6, abs(q.x) / aspect);
    col += npal(0.3, seed) * 0.08;
  } else if (m < 4.5) { // hex grid pulse
    vec2 q = p * 7.0; vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5;
    vec2 a = mod(q, r) - h; vec2 b = mod(q - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b; vec2 id = q - g;
    float d = sdHex(g, 0.42);
    float wave = 0.5 + 0.5 * sin(length(id) * 0.8 - t * 3.0 + seed * 10.0);
    col = npal(wave, seed) * (smoothstep(0.04, 0.0, abs(d)) * 1.3 + smoothstep(0.0, -0.3, d) * wave * 0.6);
  } else if (m < 5.5) { // flowing wave lines
    float acc = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float yy = 0.5 + 0.28 * sin(uv.x * (4.0 + fi) + t * (1.0 + fi * 0.3) + fi * 1.7) * sin(t * 0.37 + fi);
      acc += smoothstep(0.018, 0.0, abs(uv.y - yy)) * (0.6 + 0.4 * sin(fi + t));
    }
    col = npal(uv.x, seed) * acc * 1.6 + npal(uv.y, seed + 0.3) * 0.06;
  } else if (m < 6.5) { // rotating diamond product shot
    float a = t * 0.8; mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 q = R * p; float d = abs(q.x) + abs(q.y * 1.4) - 0.3;
    float edge = smoothstep(0.015, 0.0, abs(d));
    float facets = step(0.0, -d) * (0.4 + 0.6 * step(0.0, q.x * q.y));
    float glow = exp(-abs(d) * 9.0);
    col = npal(0.5 + 0.5 * sin(a), seed) * (edge * 2.0 + facets * 0.7 + glow * 0.4);
    col += npal(uv.y, seed + 0.5) * 0.12 * (1.0 - uv.y);
  } else { // gradient panel with stripes
    float s = step(0.5, fract(uv.x * 5.0 + uv.y * 2.0 - t * 0.3));
    col = npal(uv.y + 0.1 * sin(t + uv.x * 3.0), seed) * (0.75 + 0.25 * s);
  }
  return col;
}
`;

export function makeScreenMaterial(holo = false) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({}, commonUniforms()),
    transparent: holo,
    depthWrite: !holo,
    blending: holo ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: holo ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: /* glsl */`
      attribute vec4 aSign;
      varying vec2 vUv; flat varying vec4 vSign; varying vec3 vWP;
      void main(){
        vUv = uv; vSign = aSign;
        vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv; flat varying vec4 vSign; varying vec3 vWP;
      ${NOISE}
      ${FOG_PARS}
      ${SCREEN_FUNCS}
      void main(){
        float mode = vSign.x, seed = vSign.y, aspect = vSign.z, inten = vSign.w;
        float t = uTime * (0.8 + fract(seed * 13.0) * 0.6) + seed * 50.0;
        vec2 uv = vUv;
        // glitch bands
        float gb = step(0.93, hash12(vec2(floor(uv.y * 18.0), floor(uTime * 6.0 + seed * 9.0))));
        float gOn = step(0.85, hash11(floor(uTime * 1.3 + seed * 31.0)));
        uv.x += gb * gOn * (hash11(floor(uTime * 20.0) + seed) - 0.5) * 0.15;
        vec3 c = screenContent(uv, mode, seed, aspect, t);
        // chroma split during glitch
        c.r *= 1.0 + gb * gOn * 0.8;
        float scan = 0.8 + 0.2 * sin(vUv.y * 420.0 / max(aspect, 0.5));
        c *= scan;
        // pixel grid
        vec2 pg = fract(vUv * vec2(aspect, 1.0) * 70.0);
        c *= 0.72 + 0.28 * step(0.18, pg.x) * step(0.18, pg.y);
        // border glow
        float bd = min(min(vUv.x, 1.0 - vUv.x) * aspect, min(vUv.y, 1.0 - vUv.y));
        c += npal(0.2, seed) * smoothstep(0.035, 0.0, bd) * 0.8;
        c *= inten;
        // occasional brightness pulse
        c *= 0.9 + 0.1 * sin(uTime * 1.7 + seed * 20.0);
        ${holo ? `
        float flick = 0.75 + 0.25 * step(0.2, hash11(floor(uTime * 24.0) + seed));
        float hscan = 0.55 + 0.45 * step(0.5, fract(vWP.y * 6.0 - uTime * 2.0));
        c *= flick * hscan;
        float edgeFade = smoothstep(0.0, 0.08, min(vUv.x, 1.0 - vUv.x)) * smoothstep(0.0, 0.08, min(vUv.y, 1.0 - vUv.y));
        c *= edgeFade;
        ` : ''}
        c = ${holo ? 'applyFogAdd' : 'applyFog'}(c, vWP, cameraPosition);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// --- Environment map for wet reflections -----------------------------------
export function makeEnvMap(renderer) {
  const scene = new THREE.Scene();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const room = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vP; void main(){ vec3 d = normalize(vP); float h = d.y;
      vec3 c = mix(vec3(0.09,0.035,0.08), vec3(0.015,0.02,0.05), smoothstep(-0.1, 0.6, h));
      c += vec3(0.3,0.08,0.2) * pow(max(0.0, 1.0 - abs(h)), 8.0);
      c = mix(c, vec3(0.01,0.008,0.012), smoothstep(-0.05, -0.4, h));
      gl_FragColor = vec4(c, 1.0); }`,
  }));
  scene.add(room);
  const add = (color, x, y, z, sx, sy, sz, inten) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(inten) }));
    m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.lookAt(0, y, 0); scene.add(m);
  };
  const r = new (class { constructor() { this.s = 7; } f() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; } })();
  const cols = [0xff1a8c, 0x19d9ff, 0xff7a1a, 0x8a3dff, 0xff2a3a, 0x40ffa0];
  for (let i = 0; i < 60; i++) {
    const a = r.f() * Math.PI * 2, d = 18 + r.f() * 20;
    const big = r.f() < 0.3;
    add(cols[Math.floor(r.f() * cols.length)], Math.cos(a) * d, -2 + r.f() * 22, Math.sin(a) * d, big ? 3 + r.f() * 5 : 0.4, big ? 2 + r.f() * 4 : 3 + r.f() * 9, 0.3, big ? 2.5 : 5);
  }
  // warm windows grid
  for (let i = 0; i < 160; i++) {
    const a = r.f() * Math.PI * 2, d = 30 + r.f() * 12;
    add(r.f() < 0.7 ? 0xffb066 : 0x9fc8ff, Math.cos(a) * d, r.f() * 30, Math.sin(a) * d, 0.8, 0.6, 0.2, 1.2);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  return rt.texture;
}
