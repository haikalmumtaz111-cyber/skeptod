// Shared GLSL chunks and the terrain / sky / object shaders.
import { V } from './terrain.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const COMMON = /* glsl */ `
#define PI 3.14159265
#define RIM_R ${f(V.RIM_R)}
#define RIM_H ${f(V.RIM_H)}
#define FLOOR_H ${f(V.FLOOR_H)}
uniform float uTime;
uniform sampler2D uNoise;
float hash11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec4 hash41(float p){ vec4 p4 = fract(vec4(p)*vec4(0.1031,0.1030,0.0973,0.1099)); p4 += dot(p4, p4.wzxy+33.33); return fract((p4.xxyz+p4.yzzw)*p4.zywx); }
float tnoise(vec2 p){ return texture(uNoise, p).r; }
float sat(float x){ return clamp(x, 0.0, 1.0); }
`;

export const ATMOS = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uFogCol;
uniform vec2 uFogParams;
uniform vec3 uGlowPos;
uniform vec3 uGlowCol;
uniform vec3 uGlow2Pos;
uniform vec3 uGlow2Col;
// single scattering of a point light along a ray, localised by exp(-h/R)
float airlight(vec3 ro, vec3 rd, float D, vec3 S, float R){
  vec3 q = ro - S;
  float b = dot(rd, q);
  float h2 = max(dot(q,q) - b*b, 400.0);
  float h = sqrt(h2);
  return (atan((D + b)/h) - atan(b/h)) / h * exp(-h / R);
}
// returns inscattered light (rgb) and transmittance (a)
vec4 atmosphere(vec3 P){
  vec3 rd = P - uCamPos;
  float D = length(rd);
  rd /= max(D, 1e-3);
  float k = uFogParams.y;
  float fy = k * rd.y * D;
  float od = uFogParams.x * exp(-k * max(uCamPos.y, -200.0)) * D * (abs(fy) > 1e-4 ? (1.0 - exp(-fy)) / fy : 1.0);
  float T = exp(-od);
  vec3 col = uFogCol * (1.0 - T);
  col += uGlowCol * airlight(uCamPos, rd, D, uGlowPos, 2600.0);
  col += uGlow2Col * airlight(uCamPos, rd, D, uGlow2Pos, 1600.0);
  return vec4(col, T);
}
`;

export const LIGHTING = /* glsl */ `
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uCraterPos;
uniform vec3 uCraterCol;
uniform vec3 uPlumePos;
uniform vec3 uPlumeCol;
uniform vec3 uBoltPos;
uniform vec3 uBoltCol;
uniform sampler2D uHeat;
uniform sampler2D uBake;
uniform float uHM;
const vec3 LAVA_LIGHT = vec3(1.0, 0.32, 0.06);
vec3 pointLight(vec3 P, vec3 N, vec3 Lp, vec3 col, float rad, float wrap){
  vec3 L = Lp - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  float ndl = max((dot(N, L) + wrap) / (1.0 + wrap), 0.0);
  return col * ndl / (1.0 + d2 / (rad*rad));
}
vec2 heightUV(vec3 P){ return P.xz / (2.0*uHM) + 0.5; }
float insideHM(vec2 uv){ vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, 0.025, min(e.x, e.y)); }
// diffuse irradiance from every light in the scene
vec3 sceneIrradiance(vec3 P, vec3 N, float shadow, float ao, vec4 heat){
  vec3 irr = uMoonCol * max(dot(N, uMoonDir), 0.0) * shadow;
  irr += mix(uGroundAmb, uSkyAmb, N.y*0.5 + 0.5) * ao;
  irr += pointLight(P, N, uCraterPos, uCraterCol, 700.0, 0.25);
  irr += pointLight(P, N, uPlumePos, uPlumeCol, 3200.0, 0.35) * (0.35 + 0.65*ao);
  irr += pointLight(P, N, uBoltPos, uBoltCol, 2600.0, 0.4);
  irr += LAVA_LIGHT * (heat.r * 5.5 + heat.g * 1.1) * (0.45 + 0.55*max(N.y, 0.0)) * (0.5 + 0.5*ao);
  return irr;
}
`;

export const LAVA_RAMP = /* glsl */ `
vec3 lavaRamp(float t){
  t = max(t, 0.0);
  vec3 c = mix(vec3(0.0), vec3(0.30, 0.012, 0.0), smoothstep(0.02, 0.25, t));
  c = mix(c, vec3(1.0, 0.085, 0.004), smoothstep(0.2, 0.5, t));
  c = mix(c, vec3(1.0, 0.36, 0.03), smoothstep(0.45, 0.78, t));
  c = mix(c, vec3(1.0, 0.70, 0.26), smoothstep(0.74, 1.02, t));
  c = mix(c, vec3(1.0, 0.92, 0.70), smoothstep(1.02, 1.45, t));
  return c * (10.0 * pow(t, 2.5) + 0.25 * t);
}
`;

export const LAVA = LAVA_RAMP + /* glsl */ `
// x: crust raft field (fbm), y: crack network inside rafts
vec2 lavaPattern(vec2 p){
  float f = texture(uNoise, p / 230.0 + 0.31).r * 0.5 + texture(uNoise, p / 87.0 + 0.77).r * 0.32 + texture(uNoise, p / 29.0 + 0.13).r * 0.18;
  float e = texture(uNoise, p / 52.0).b;
  float e2 = texture(uNoise, p / 17.0 + 0.4).b;
  float w1 = fwidth(e) * 1.2, w2 = fwidth(e2) * 1.2;
  // cracks fade out once they get thinner than a pixel
  float cr = (1.0 - smoothstep(0.0, 0.07 + w1, e)) * 0.8 * (1.0 - smoothstep(0.03, 0.12, w1));
  cr += (1.0 - smoothstep(0.0, 0.05 + w2, e2)) * 0.45 * (1.0 - smoothstep(0.03, 0.12, w2));
  return vec2(f, cr);
}
// nd: normalised distance from flow centre, s: distance from vent, dir: flow direction
void lavaShade(vec3 P, float nd, float s, vec2 dir, float speedMul, out vec3 emis, out float cov, out float crust){
  float en = texture(uNoise, P.xz / 85.0).r;
  cov = 1.0 - smoothstep(0.72, 1.0, nd + (en - 0.5) * 0.38);
  emis = vec3(0.0); crust = 0.0;
  if (cov <= 0.0) return;
  float coolT = smoothstep(120.0, 4600.0, s);
  float speed = mix(30.0, 7.0, coolT) * (1.0 - 0.7*nd*nd) * speedMul;
  const float cyc = 3.2;
  float ph0 = fract(uTime / cyc), ph1 = fract(uTime / cyc + 0.5);
  float wb = abs(2.0 * ph0 - 1.0);
  vec2 p0 = P.xz - dir * speed * cyc * ph0;
  vec2 p1 = P.xz - dir * speed * cyc * ph1 + vec2(37.1, 11.7);
  vec2 n = mix(lavaPattern(p0), lavaPattern(p1), wb);
  // more crust downstream and toward the cooler margins
  float th = mix(0.66, 0.43, coolT) - 0.1 * smoothstep(0.55, 1.0, nd);
  float fw = fwidth(n.x);
  crust = smoothstep(th - 0.035 - fw, th + 0.05 + fw, n.x);
  float crack = clamp(n.y, 0.0, 1.0) * crust;
  float T = mix(0.93, 0.64, coolT);
  T *= 0.88 + 0.16 * sin(s * 0.011 - uTime * 2.4 + en * 5.0);
  T *= mix(1.0, 0.86, nd * nd);
  float hot = smoothstep(th + 0.02, th - 0.14, n.x);
  T += hot * 0.12 * (1.0 - coolT);
  float edgeHot = smoothstep(0.55, 0.84, nd) * (1.0 - smoothstep(0.86, 1.0, nd));
  float t = T * (1.0 - crust * mix(0.62, 0.95, coolT)) + crack * mix(0.5, 0.38, coolT) + edgeHot * 0.16 * (1.0 - 0.5*coolT);
  emis = lavaRamp(t) * cov;
  crust *= cov * (1.0 - crack * 0.6);
}
`;

// -------------------------------------------------------------------------
export const terrainVert = /* glsl */ `
varying vec3 vPos;
varying vec3 vNrm;
void main(){
  vPos = position;
  vNrm = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
${COMMON}
${ATMOS}
${LIGHTING}
${LAVA}
uniform sampler2D uRock;
uniform sampler2D uLava;
uniform sampler2D uNrmMap;
uniform float uIntensity;
varying vec3 vPos;
varying vec3 vNrm;

vec3 detailNormal(vec3 P, vec3 N, float scale, float strength){
  vec3 w = pow(abs(N), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec2 nx = texture(uRock, P.zy * scale).rg * 2.0 - 1.0;
  vec2 ny = texture(uRock, P.xz * scale).rg * 2.0 - 1.0;
  vec2 nz = texture(uRock, P.xy * scale).rg * 2.0 - 1.0;
  vec3 t = vec3(0.0, nx.y, nx.x) * w.x + vec3(ny.x, 0.0, ny.y) * w.y + vec3(nz.x, nz.y, 0.0) * w.z;
  return normalize(N + t * strength);
}

void main(){
  vec3 P = vPos;
  vec2 huv = heightUV(P);
  float inside = insideHM(huv);
  vec4 nm = texture(uNrmMap, huv);
  vec3 Ng = normalize(mix(normalize(vNrm), normalize(nm.xyz * 2.0 - 1.0), inside));
  float curv = mix(0.5, nm.a, inside);
  vec4 lv = inside > 0.0 ? texture(uLava, huv) : vec4(9.0, 0.0, 0.0, 0.0);
  vec4 ht = texture(uHeat, huv) * inside;
  vec4 bk = mix(vec4(1.0, 1.0, 0.5, 1.0), texture(uBake, huv), inside);
  float shadow = bk.r, ao = bk.g;

  float r = length(P.xz);
  float dist = length(P - uCamPos);
  float slope = 1.0 - Ng.y;

  vec3 N = detailNormal(P, Ng, 1.0/95.0, 0.6 * (1.0 - smoothstep(2500.0, 14000.0, dist)));
  N = detailNormal(P, N, 1.0/17.0, 0.45 * (1.0 - smoothstep(250.0, 2600.0, dist)));

  float rh = texture(uRock, P.xz / 95.0).a;
  float n1 = texture(uNoise, P.xz / 2100.0).r;
  float n2 = texture(uNoise, P.xz / 300.0).r;
  float n3 = texture(uNoise, P.xz / 47.0).r;

  vec3 ash = vec3(0.064, 0.056, 0.048);
  vec3 scoria = vec3(0.085, 0.042, 0.03);
  vec3 basalt = vec3(0.033, 0.032, 0.034);
  vec3 soil = vec3(0.065, 0.052, 0.038);
  vec3 veg = vec3(0.026, 0.042, 0.018);
  vec3 sulfur = vec3(0.34, 0.27, 0.05);

  vec3 alb = ash * (0.7 + 0.5 * n2) * (0.85 + 0.3 * n3);
  alb = mix(alb, scoria, smoothstep(0.45, 0.72, n1) * (1.0 - smoothstep(2000.0, 5600.0, r)) * 0.75);
  float rockMask = smoothstep(0.34, 0.62, slope + (0.5 - curv) * 0.9 + (rh - 0.5) * 0.35);
  alb = mix(alb, basalt * (0.75 + 0.5 * rh), rockMask);
  alb *= mix(1.0, 0.72, smoothstep(0.52, 0.72, curv));

  float lowland = smoothstep(4600.0, 7800.0, r) * (1.0 - smoothstep(1500.0, 2300.0, P.y + n2 * 300.0));
  float vegMask = lowland * (1.0 - smoothstep(0.1, 0.32, slope)) * smoothstep(0.40, 0.58, n1 + n2 * 0.35) * (1.0 - ht.a) * (1.0 - ht.b);
  alb = mix(alb, mix(veg, soil, smoothstep(0.3, 0.7, n2)) * (0.8 + 0.4 * n3), vegMask);
  float far = smoothstep(10000.0, 19000.0, r);
  vec3 mnt = mix(vec3(0.055, 0.052, 0.054), vec3(0.03, 0.045, 0.024), smoothstep(0.35, 0.7, n1) * (1.0 - smoothstep(0.25, 0.5, slope)));
  alb = mix(alb, mnt * (0.8 + 0.4 * n2), far * (1.0 - vegMask));
  float snow = smoothstep(2300.0, 2900.0, P.y + n2 * 380.0) * (1.0 - smoothstep(0.2, 0.45, slope)) * far;
  alb = mix(alb, vec3(0.2, 0.21, 0.24) * (0.8 + 0.3*n3), snow * 0.6);

  float rimZone = 1.0 - smoothstep(RIM_R * 1.0, RIM_R * 2.6, r);
  alb = mix(alb, scoria * 1.4, rimZone * 0.55);
  alb = mix(alb, sulfur * (0.6 + 0.6 * n3), rimZone * smoothstep(0.6, 0.74, texture(uNoise, P.xz / 130.0).r) * 0.75);
  alb = mix(alb, vec3(0.02, 0.019, 0.022) * (0.7 + 0.7 * rh), ht.b);
  alb = mix(alb, vec3(0.022, 0.018, 0.016), ht.a * 0.85);

  vec3 irr = sceneIrradiance(P, N, shadow, ao, ht);
  vec3 col = alb * irr;

  // specular glint (glassy basalt / crust) from the eruption light
  vec3 V = normalize(uCamPos - P);
  vec3 Lc = normalize(uCraterPos - P);
  vec3 H = normalize(Lc + V);
  float dc = length(uCraterPos - P);
  float glossy = 0.03 + 0.12 * ht.b + 0.08 * rockMask;
  col += uCraterCol * glossy * pow(max(dot(N, H), 0.0), 40.0) / (1.0 + dc*dc/(900.0*900.0));

  // --- active lava
  vec3 emis = vec3(0.0);
  float cov = 0.0, crust = 0.0;
  if (lv.r < 1.2 && lv.g > -0.5) {
    vec2 dir = lv.ba;
    float dl = length(dir);
    dir = dl > 0.01 ? dir / dl : normalize(P.xz + 0.001);
    lavaShade(P, lv.r, lv.g * 1000.0, dir, 1.0, emis, cov, crust);
  }
  // crater lava lake
  float q = r / RIM_R;
  float lake = (1.0 - smoothstep(0.34, 0.5, q + (n3 - 0.5) * 0.12)) * (1.0 - smoothstep(FLOOR_H + 6.0, FLOOR_H + 30.0, P.y));
  if (lake > 0.0) {
    float a = 0.5 + 0.3 * sin(uTime * 0.13);
    vec2 rd = normalize(P.xz + 0.001);
    vec2 dir = vec2(rd.x * cos(a) - rd.y * sin(a), rd.x * sin(a) + rd.y * cos(a));
    vec3 e2; float c2, k2;
    lavaShade(P, q * 1.3, 60.0 + q * 200.0, dir, 0.35, e2, c2, k2);
    // fountain vents
    float vent = 0.0;
    vent += exp(-dot(P.xz - vec2(18.0, -12.0), P.xz - vec2(18.0, -12.0)) / 900.0);
    vent += exp(-dot(P.xz - vec2(-40.0, 30.0), P.xz - vec2(-40.0, 30.0)) / 700.0);
    e2 += lavaRamp(1.25) * vent * (0.7 + 0.3 * sin(uTime * 9.0));
    emis = mix(emis, e2 * (0.9 + 0.25 * uIntensity), lake);
    cov = max(cov, lake * c2);
    crust = mix(crust, k2, lake);
  }
  // glowing cracks on the upper cone and inner crater walls
  float crackZone = (1.0 - smoothstep(RIM_R * 0.9, RIM_R * 3.4, r)) * smoothstep(0.38, 0.62, texture(uNoise, P.xz / 900.0 + 0.2).g + rimZone * 0.3);
  crackZone += (1.0 - smoothstep(RIM_R * 0.45, RIM_R * 0.95, r)) * 0.9;
  if (crackZone > 0.01 && cov < 0.99) {
    float e = texture(uNoise, P.xz / 64.0).b;
    float e2 = texture(uNoise, P.xz / 23.0 + 0.5).b;
    float fe = fwidth(e) * 1.2, fe2 = fwidth(e2) * 1.2;
    float crack = (1.0 - smoothstep(0.015, 0.07 + fe, e)) * (1.0 - smoothstep(0.04, 0.15, fe));
    crack += 0.6 * (1.0 - smoothstep(0.01, 0.05 + fe2, e2)) * (1.0 - smoothstep(0.04, 0.15, fe2));
    crack = max(crack, 0.18);
    float flick = 0.75 + 0.25 * sin(uTime * 1.7 + n2 * 20.0);
    emis += lavaRamp(0.58 + 0.15 * n3) * crack * crackZone * flick * (1.0 - cov) * 0.8;
  }

  vec3 crustCol = vec3(0.028, 0.024, 0.022) * irr + lavaRamp(0.35) * 0.15 * crust;
  col = mix(col, crustCol, cov * crust);
  col = mix(col, vec3(0.0), cov * (1.0 - crust));
  col += emis;

  vec4 at = atmosphere(P);
  col = col * at.a + at.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------------------
// Instanced scenery (rocks, trees): vertex colours, terrain-consistent lighting
export const propVert = /* glsl */ `
attribute vec3 color;
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vCol;
void main(){
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vCol = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const propFrag = /* glsl */ `
${COMMON}
${ATMOS}
${LIGHTING}
${LAVA}
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vCol;
void main(){
  vec3 P = vPos;
  vec2 huv = heightUV(P);
  float inside = insideHM(huv);
  vec4 ht = texture(uHeat, huv) * inside;
  vec4 bk = mix(vec4(1.0, 1.0, 0.5, 1.0), texture(uBake, huv), inside);
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  float n = texture(uNoise, P.xz / 37.0 + P.y / 53.0).r;
  vec3 alb = vCol * (0.75 + 0.5 * n);
  vec3 irr = sceneIrradiance(P, N, bk.r, bk.g * 0.85, ht);
  vec3 col = alb * irr;
  // smouldering where touched by lava heat
  col += lavaRamp(0.45) * smoothstep(0.55, 0.95, ht.a) * smoothstep(0.6, 0.2, n) * 0.25;
  vec4 at = atmosphere(P);
  gl_FragColor = vec4(col * at.a + at.rgb, 1.0);
}
`;

// -------------------------------------------------------------------------
export const skyVert = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

export const skyFrag = /* glsl */ `
${COMMON}
${ATMOS}
uniform vec3 uMoonDir;
uniform vec3 uWind;
uniform float uIntensity;
uniform float uFlash;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 zen = vec3(0.0045, 0.0068, 0.0145);
  vec3 hor = vec3(0.030, 0.031, 0.041);
  vec3 col = mix(hor, zen, pow(sat(y), 0.42));
  vec2 dxz = normalize(d.xz + 1e-5);
  vec2 sd = normalize(uMoonDir.xz);
  float az = max(dot(dxz, sd), 0.0);
  col += vec3(0.10, 0.032, 0.012) * pow(az, 5.0) * exp(-max(y, 0.0) * 10.0);
  col += vec3(0.018, 0.012, 0.022) * pow(az, 2.0) * exp(-max(y, 0.0) * 3.5);
  // stars
  vec3 sp = d * 380.0;
  vec3 cell = floor(sp);
  float sh = hash12(cell.xy + cell.z * 17.13);
  float star = step(0.9965, sh) * smoothstep(0.08, 0.5, y) * (0.6 + 0.4 * sin(uTime * (2.0 + sh * 6.0) + sh * 50.0));
  float sd2 = length(fract(sp) - 0.5);
  col += vec3(0.8, 0.85, 1.0) * star * smoothstep(0.35, 0.0, sd2) * 0.35;
  // moon
  float md = dot(d, normalize(uMoonDir));
  col += vec3(0.9, 0.92, 1.0) * smoothstep(0.99955, 0.99975, md) * 2.2;
  col += vec3(0.05, 0.06, 0.085) * pow(max(md, 0.0), 180.0);
  col += vec3(0.02, 0.024, 0.034) * pow(max(md, 0.0), 8.0);
  // high cloud deck
  float hy = max(y + 0.06, 0.012);
  vec2 cuv = d.xz / hy * 0.11 + uWind.xz * uTime * 0.0016;
  float c = texture(uNoise, cuv * 0.6).r * 0.55 + texture(uNoise, cuv * 1.7 + 0.3).r * 0.3 + texture(uNoise, cuv * 4.3 + 0.7).r * 0.15;
  // the distal ash cloud is thicker downwind
  float downwind = max(dot(dxz, normalize(uWind.xz)), 0.0);
  c += downwind * 0.18 * smoothstep(-0.02, 0.25, y);
  float cm = smoothstep(0.43, 0.72, c) * smoothstep(-0.03, 0.12, y);
  vec3 toV = normalize(uGlowPos + vec3(0.0, 2500.0, 0.0) - uCamPos);
  float prox = max(dot(d, toV), 0.0);
  vec3 ccol = vec3(0.007, 0.0078, 0.011) * (0.6 + 0.8 * c);
  ccol += vec3(0.09, 0.022, 0.006) * pow(prox, 16.0) * (0.6 + 0.5 * uIntensity) * (0.4 + c);
  ccol += vec3(0.022, 0.024, 0.03) * pow(max(md, 0.0), 6.0);
  ccol += vec3(0.08, 0.085, 0.12) * uFlash * pow(prox, 4.0) * c;
  col = mix(col, ccol, cm * 0.92);
  vec4 at = atmosphere(uCamPos + d * 70000.0);
  col = col * at.a + at.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------------------
// GPU bake: soft terrain shadows toward the key light + horizon-based AO
export const bakeFrag = /* glsl */ `
#define PI 3.14159265
uniform sampler2D uHeight;
uniform float uN;
uniform float uHM;
uniform vec3 uLight;
varying vec2 vUv;
float H(vec2 xz){
  vec2 f = (xz + uHM) / (2.0*uHM) * uN - 0.5;
  vec2 i = floor(f);
  vec2 t = f - i;
  ivec2 c = ivec2(clamp(i, vec2(0.0), vec2(uN - 2.0)));
  float a = texelFetch(uHeight, c, 0).r;
  float b = texelFetch(uHeight, c + ivec2(1, 0), 0).r;
  float d = texelFetch(uHeight, c + ivec2(0, 1), 0).r;
  float e = texelFetch(uHeight, c + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(d, e, t.x), t.y);
}
void main(){
  vec2 xz = (vUv - 0.5) * 2.0 * uHM;
  float h0 = H(xz) + 3.0;
  vec2 ld = normalize(uLight.xz);
  float tanE = uLight.y / length(uLight.xz);
  float sh = 1.0;
  float t = 10.0;
  for (int i = 0; i < 72; i++) {
    vec2 q = xz + ld * t;
    if (abs(q.x) > uHM || abs(q.y) > uHM) break;
    float dh = h0 + t * tanE - H(q);
    sh = min(sh, dh / (t * 0.045) + 0.0);
    t *= 1.085;
    t += 4.0;
  }
  sh = smoothstep(0.0, 1.0, sh);
  float occ = 0.0;
  for (int k = 0; k < 12; k++) {
    float a = float(k) * PI / 6.0 + 0.3;
    vec2 dir = vec2(cos(a), sin(a));
    float mx = 0.0;
    float s = 12.0;
    for (int j = 0; j < 12; j++) {
      vec2 q = xz + dir * s;
      float sl = (H(q) - h0) / s;
      mx = max(mx, sl);
      s *= 1.38;
    }
    occ += mx / sqrt(1.0 + mx*mx);
  }
  float ao = 1.0 - occ / 12.0;
  gl_FragColor = vec4(sh, ao * ao, 0.0, 1.0);
}
`;

export const fullscreenVert = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
