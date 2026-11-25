// Shared GLSL chunks

export const NOISE = /* glsl */`
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<3;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
`;

// Height fog + view dependent glow. Requires uniforms declared via FOG_PARS
export const FOG_PARS = /* glsl */`
uniform vec3 uFogLow;
uniform vec3 uFogHigh;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFlash;
vec3 fogColorAt(vec3 dir, float h){
  float t = clamp(h / 220.0, 0.0, 1.0);
  vec3 c = mix(uFogLow, uFogHigh, sqrt(t));
  // glow toward the horizon that hosts the brightest district
  float g = pow(max(0.0, 1.0 - abs(dir.y)), 6.0);
  c += vec3(0.08, 0.02, 0.06) * g;
  c += vec3(0.35, 0.38, 0.55) * uFlash * 0.25;
  return c;
}
vec3 safeCol(vec3 c){ return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : min(c, vec3(4000.0)); }
float fogAmount(vec3 wp, vec3 camPos){
  vec3 d = wp - camPos; float dist = length(d);
  float k = 1.0 / uFogHeight;
  float h0 = camPos.y; float dy = d.y;
  float fogAmt;
  float dens0 = exp(-max(h0, -10.0) * k);
  if (abs(dy) > 0.01) {
    float dens1 = exp(-max(wp.y, -10.0) * k);
    fogAmt = uFogDensity * dist * (dens0 - dens1) / (k * dy);
  } else {
    fogAmt = uFogDensity * dist * dens0;
  }
  fogAmt += dist * 0.00045;
  return 1.0 - exp(-max(fogAmt, 0.0));
}
vec3 applyFog(vec3 col, vec3 wp, vec3 camPos){
  col = safeCol(col);
  vec3 d = wp - camPos; vec3 dir = d / max(length(d), 1e-3);
  float f = fogAmount(wp, camPos);
  return mix(col, fogColorAt(dir, wp.y * 0.5 + camPos.y * 0.5), f);
}
// for additive / emissive-only blends: fade out instead of turning into fog colour
vec3 applyFogAdd(vec3 col, vec3 wp, vec3 camPos){
  return safeCol(col) * (1.0 - fogAmount(wp, camPos));
}
`;

export const FOG_UNIFORMS = (shared) => ({
  uFogLow: shared.uFogLow, uFogHigh: shared.uFogHigh, uFogDensity: shared.uFogDensity, uFogHeight: shared.uFogHeight, uFlash: shared.uFlash,
});

export const LIGHT_POOL_N = 12;
export const POOL_PARS = /* glsl */`
#define POOL_N ${LIGHT_POOL_N}
uniform vec4 uPoolPos[POOL_N];   // xyz pos, w = range
uniform vec3 uPoolCol[POOL_N];   // color * intensity
vec3 poolIrradiance(vec3 p, vec3 n){
  vec3 acc = vec3(0.0);
  for(int i=0;i<POOL_N;i++){
    vec3 L = uPoolPos[i].xyz - p; float d2 = dot(L,L); float r = uPoolPos[i].w;
    float d = sqrt(d2); L /= max(d,1e-3);
    float win = clamp(1.0 - pow(d / r, 4.0), 0.0, 1.0); win *= win;
    acc += uPoolCol[i] * max(dot(n, L), 0.0) * win / (d2 + 1.0);
  }
  return acc;
}
vec3 poolVolume(vec3 p){
  vec3 acc = vec3(0.0);
  for(int i=0;i<POOL_N;i++){
    vec3 L = uPoolPos[i].xyz - p; float d2 = dot(L,L); float r = uPoolPos[i].w;
    float win = clamp(1.0 - d2 / (r*r), 0.0, 1.0);
    acc += uPoolCol[i] * win / (d2 + 4.0);
  }
  return acc;
}
`;
