// Shared GLSL: atmosphere/fog, wind, noise. Patches three.js fog chunks globally.
import * as THREE from 'three';
import { SUN_DIR } from './world.js';

export const U = {
  time: { value: 0 },
  flicker: { value: 1 },
};

const sd = SUN_DIR.map((v) => v.toFixed(5)).join(',');

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm3(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<3;i++){ s+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5;} return s/0.875; }
float fbm5(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2); a*=0.5;} return s/0.96875; }
`;

export const ATMO_GLSL = /* glsl */ `
const vec3 SUN_DIR = vec3(${sd});
vec3 skyBase(vec3 dir){
  float y = max(dir.y, 0.0);
  vec2 hd = normalize(dir.xz + vec2(1e-5));
  vec2 hs = normalize(SUN_DIR.xz);
  float s = dot(hd, hs) * 0.5 + 0.5;
  float k = pow(s, 2.6);
  vec3 away = vec3(0.64, 0.46, 0.62);
  vec3 toward = vec3(2.05, 0.92, 0.38);
  vec3 hz = mix(away, toward, k);
  vec3 mid = mix(vec3(0.30, 0.25, 0.50), vec3(0.75, 0.42, 0.40), k * k);
  vec3 zen = vec3(0.07, 0.10, 0.29);
  vec3 col = mix(hz, mid, smoothstep(0.0, 0.2, y));
  col = mix(col, zen, smoothstep(0.16, 0.8, y));
  float sa = max(dot(dir, SUN_DIR), 0.0);
  col += vec3(1.5, 0.62, 0.20) * pow(sa, 6.0) * 0.85;
  col += vec3(2.0, 1.0, 0.45) * pow(sa, 48.0) * 1.6;
  return col;
}
vec3 fogColorDir(vec3 dir){
  vec3 d = dir; d.y = max(d.y * 0.6, 0.0);
  float down = mix(0.62, 1.0, smoothstep(-0.3, 0.02, dir.y));
  vec3 c = skyBase(normalize(d)) * 0.9 * down;
  c *= 1.0 - 0.22 * pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(SUN_DIR.x, 0.0, SUN_DIR.z))), 0.0), 3.0);
  float sa = max(dot(dir, SUN_DIR), 0.0);
  return mix(c, c * vec3(0.8, 0.78, 0.82), (1.0 - smoothstep(-0.05, 0.1, dir.y)) * (1.0 - sa));
}
vec3 applyFog(vec3 col, vec3 wpos){
  vec3 dv = wpos - cameraPosition;
  float dist = length(dv);
  vec3 dir = dv / max(dist, 1e-3);
  float b = 0.011;
  float h0 = cameraPosition.y;
  float dy = dv.y;
  float fh = abs(dy) > 0.5 ? (exp(-b * h0) - exp(-b * (h0 + dy))) / (b * dy) : exp(-b * h0);
  float f = 1.0 - exp(-dist * 0.00078 * fh);
  float mist = (1.0 - exp(-dist * 0.0028)) * exp(-max(wpos.y - 0.5, 0.0) * 0.25) * 0.2;
  f = clamp(f + mist * (1.0 - f), 0.0, 1.0);
  f += (1.0 - f) * (1.0 - exp(-max(dist - 1200.0, 0.0) * 0.00028)) * 0.55;
  return mix(col, fogColorDir(dir), f);
}
`;

export const WIND_GLSL = /* glsl */ `
uniform float uTime;
vec3 windOffset(vec3 wp, float w, float ph){
  if (w <= 0.0) return vec3(0.0);
  float t = uTime;
  vec2 wd = vec2(0.89, 0.45);
  float gust = 0.55 + 0.45 * sin(t * 0.42 + wp.x * 0.021 + wp.z * 0.013) * sin(t * 0.27 + wp.z * 0.031 + 1.3);
  float sway = sin(t * 1.35 + ph + wp.x * 0.05) * 0.65 + sin(t * 2.45 + ph * 1.7 + wp.z * 0.09) * 0.25;
  float flut = sin(t * 6.3 + ph * 3.1 + wp.y * 2.0) * 0.08;
  vec3 o = vec3(wd.x, 0.0, wd.y) * (gust * 0.55 + sway * 0.45 + flut) * w;
  o += vec3(-wd.y, 0.0, wd.x) * sin(t * 1.1 + ph * 2.3) * 0.18 * w;
  o.y = -0.15 * abs(o.x + o.z) + flut * 0.4 * w;
  return o;
}
`;

const WIND_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
#ifdef WIND_LOCAL_H
  float wWeight = aWind.x * pow(clamp(transformed.y * WIND_LOCAL_H, 0.0, 1.5), 2.0);
#else
  float wWeight = aWind.x;
#endif
mvPosition.xyz += windOffset(mvPosition.xyz, wWeight, aWind.y);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;
const WIND_WORLDPOS = /* glsl */ `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    worldPosition = instanceMatrix * worldPosition;
  #endif
  worldPosition.xyz += windOffset(worldPosition.xyz, wWeight, aWind.y);
  worldPosition = modelMatrix * worldPosition;
#endif
`;

// Patch a built-in material for wind sway. aWind attribute: (weight, phase).
// If localH is given, weight is scaled by (local y / height)^2 (for instanced stems).
export function windify(mat, { localH = 0, extraVertex = '', extraFragment = null, extraUniforms = null, key = '' } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    sh.uniforms.uTime = U.time;
    if (extraUniforms) Object.assign(sh.uniforms, extraUniforms);
    let decl = WIND_GLSL + '\nattribute vec2 aWind;\n';
    if (localH) decl = `#define WIND_LOCAL_H ${(1 / localH).toFixed(6)}\n` + decl;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + decl + extraVertex)
      .replace('#include <project_vertex>', WIND_PROJECT)
      .replace('#include <worldpos_vertex>', WIND_WORLDPOS);
    if (extraFragment) extraFragment(sh);
    if (prev) prev(sh, r);
  };
  mat.customProgramCacheKey = () => 'wind_' + key + '_' + localH + '_' + mat.type;
  return mat;
}

export function windDepthMaterial(opts = {}) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...(opts.mat || {}) });
  return windify(m, opts);
}

let patched = false;
export function patchFogChunks() {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = `#ifdef USE_FOG\n varying vec3 vFogWorld;\n#endif\n`;
  C.fog_vertex = `#ifdef USE_FOG\n vFogWorld = cameraPosition + (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;\n#endif\n`;
  C.fog_pars_fragment = `#ifdef USE_FOG\n uniform vec3 fogColor;\n varying vec3 vFogWorld;\n ${ATMO_GLSL}\n#endif\n`;
  C.fog_fragment = `#ifdef USE_FOG\n gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vFogWorld);\n#endif\n`;
}
