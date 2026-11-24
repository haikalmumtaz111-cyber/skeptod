import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// deterministic random
let seed = 1337;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const rr = (a, b) => a + (b - a) * rnd();

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.5, 40000);

// ---------------------------------------------------------------- environment constants
const SUN_DIR = new V3(-0.62, 0.075, -0.78).normalize();
const SUN_COLOR = new THREE.Color(1.0, 0.6, 0.34);
const FOG_COLOR = new THREE.Color(0.66, 0.42, 0.44);
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00052);

// waves: [angle deg (travel dir, from +Z toward +X), wavelength, steepness]
const WAVE_DEF = [
  [28, 74, 0.075], [52, 44, 0.085], [8, 31, 0.085], [196, 21, 0.08],
  [166, 14, 0.075], [218, 9.2, 0.07], [146, 6.1, 0.06], [188, 3.9, 0.05],
];
const WAVES = WAVE_DEF.map(([ang, wl, st]) => {
  const a = ang * Math.PI / 180;
  return new THREE.Vector4(Math.sin(a), Math.cos(a), st, wl);
});

function waveDisp(x, z, t, out) {
  let dx = 0, dy = 0, dz = 0;
  for (const w of WAVES) {
    const k = 2 * Math.PI / w.w;
    const c = Math.sqrt(9.81 / k);
    const f = k * (w.x * x + w.y * z - c * t);
    const a = w.z / k;
    const cf = Math.cos(f);
    dx += w.x * a * cf; dz += w.y * a * cf; dy += a * Math.sin(f);
  }
  out.x = dx; out.y = dy; out.z = dz;
  return out;
}
const _wd = new V3();
function waterHeight(x, z, t) {
  let px = x, pz = z;
  for (let i = 0; i < 3; i++) { waveDisp(px, pz, t, _wd); px = x - _wd.x; pz = z - _wd.z; }
  return waveDisp(px, pz, t, _wd).y;
}

// ---------------------------------------------------------------- GLSL shared
const GLSL_NOISE = /* glsl */`
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1.0,0.0)),u.x), mix(hash12(i+vec2(0.0,1.0)),hash12(i+vec2(1.0,1.0)),u.x),u.y); }
float fbm3(vec2 p){ float s=0.0; float a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<3;i++){ s+=a*vnoise(p); p=m*p; a*=0.5; } return s; }
float fbm5(vec2 p){ float s=0.0; float a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ s+=a*vnoise(p); p=m*p; a*=0.5; } return s; }
`;

const GLSL_SKY = /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
vec3 skyBase(vec3 d){
  float y = max(d.y, 0.0);
  vec2 hz = normalize(d.xz + 1e-5);
  vec2 sz = normalize(uSunDir.xz);
  float az = dot(hz, sz)*0.5+0.5;
  float azs = pow(az, 3.0);
  vec3 zenith = vec3(0.030,0.055,0.17);
  vec3 upper = mix(vec3(0.16,0.15,0.36), vec3(0.42,0.22,0.30), azs);
  vec3 horizon = mix(vec3(0.74,0.38,0.42), vec3(1.45,0.58,0.22), azs);
  vec3 c = mix(horizon, upper, smoothstep(0.0, 0.25, pow(y,0.8)));
  c = mix(c, zenith, smoothstep(0.18, 0.9, y));
  float cs = max(dot(d, uSunDir), 0.0);
  c += vec3(1.4,0.55,0.20)*pow(cs, 5.0)*0.55;
  c += vec3(2.4,1.05,0.40)*pow(cs, 60.0)*0.7;
  c += vec3(4.0,2.2,0.9)*pow(cs, 600.0)*1.4;
  // haze band near horizon
  c = mix(c, horizon*1.05, (1.0-smoothstep(0.0,0.05,y))*0.35);
  return c;
}
vec4 skyClouds(vec3 d, bool hq){
  if(d.y <= 0.002) return vec4(0.0);
  vec2 uv = d.xz/(d.y+0.07);
  uv *= 0.55;
  uv += vec2(uTime*0.0035, -uTime*0.0012);
  float n;
  vec2 su = vec2(uv.x*0.45 + uv.y*0.2, uv.y*1.3 - uv.x*0.25);
  if(hq){
    vec2 q = vec2(fbm5(su*0.7), fbm5(su*0.7+vec2(5.2,1.3)));
    n = fbm5(su + q*1.3);
  } else {
    vec2 q = vec2(fbm3(su*0.7), fbm3(su*0.7+vec2(5.2,1.3)));
    n = fbm3(su + q*1.3);
  }
  float dens = smoothstep(0.47, 0.76, n);
  float fadeH = smoothstep(0.004, 0.09, d.y);
  dens *= fadeH * (1.0 - 0.55*smoothstep(0.35, 0.95, d.y));
  float cs = max(dot(d, uSunDir), 0.0);
  float edge = 1.0 - smoothstep(0.47, 0.95, n);
  vec3 dark = mix(vec3(0.10,0.07,0.14), vec3(0.42,0.20,0.26), smoothstep(0.35,0.0,d.y));
  vec3 lit = vec3(2.6,1.05,0.42);
  float glow = pow(cs, 3.0)*1.2 + pow(cs, 14.0)*2.5;
  vec3 col = dark + lit*edge*(0.18 + glow) + vec3(0.9,0.35,0.32)*0.25*edge;
  return vec4(col, dens);
}
vec3 skyFull(vec3 d, bool hq){
  vec3 c = skyBase(d);
  vec4 cl = skyClouds(d, hq);
  c = mix(c, cl.rgb, cl.a*0.92);
  return c;
}
`;

// ---------------------------------------------------------------- sky dome
const skyUniforms = { uSunDir: { value: SUN_DIR }, uTime: { value: 0 } };
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: GLSL_NOISE + GLSL_SKY + /* glsl */`
  varying vec3 vDir;
  void main(){
    vec3 d = normalize(vDir);
    vec3 dd = vec3(d.x, max(d.y, 0.0), d.z);
    vec3 c = skyFull(normalize(dd), true);
    // sun disc
    float cs = dot(d, uSunDir);
    vec4 cl = skyClouds(normalize(dd), true);
    float disc = smoothstep(0.99955, 0.99975, cs);
    c += vec3(22.0,11.0,4.5)*disc*(1.0-cl.a*0.85);
    gl_FragColor = vec4(c, 1.0);
  }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(30000, 64, 32), skyMat);
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

// ---------------------------------------------------------------- ocean
const oceanUniforms = {
  uSunDir: { value: SUN_DIR }, uTime: { value: 0 },
  uWaves: { value: WAVES },
  uShipPos: { value: new THREE.Vector2() }, uShipFwd: { value: new THREE.Vector2(0, -1) },
  uSunCol: { value: new V3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(3.0) },
  uShipSpeed: { value: 7.0 },
};
const GLSL_OCEAN_COMMON = /* glsl */`
uniform vec4 uWaves[8];
uniform vec2 uShipPos;
uniform vec2 uShipFwd;
vec2 shipLocal(vec2 p){
  vec2 d = p - uShipPos;
  vec2 rgt = vec2(-uShipFwd.y, uShipFwd.x);
  return vec2(dot(d, rgt), -dot(d, uShipFwd));
}
float hullHalf(float lz){
  float t = clamp((13.0 - lz)/26.0, 0.0, 1.0);
  float hb;
  if(t > 0.52){ float k=(t-0.52)/0.48; hb = 3.7*pow(max(0.0, 1.0-k*k), 0.55); }
  else { float k=(0.52-t)/0.52; hb = 3.7*(1.0-0.32*k*k); }
  return hb*0.88;
}
float hullDist(vec2 l){
  float hb = hullHalf(l.y);
  float dz = max(max(l.y-13.0, -13.3-l.y), 0.0);
  return length(vec2(max(abs(l.x)-hb, 0.0), dz));
}
float wakeHeight(vec2 l){
  float h = 0.0;
  float sb = l.y + 13.0;
  if(sb > 0.0){
    float arm = 1.3 + sb*0.36;
    float w = 0.9 + sb*0.035;
    float dx = abs(l.x) - arm;
    h += 0.42*exp(-dx*dx/(w*w))*exp(-sb/150.0)*(0.55+0.45*sin(sb*0.6));
    // diverging wavelets inside the V
    float inside = smoothstep(arm, arm*0.4, abs(l.x));
    h += 0.10*inside*sin(sb*0.9 - abs(l.x)*1.4)*exp(-sb/90.0);
    float ss = l.y - 13.0;
    if(ss > 0.0){
      h += 0.16*sin(ss*0.42)*exp(-l.x*l.x/(30.0+ss*1.5))*exp(-ss/80.0)*smoothstep(0.0,6.0,ss);
    }
  }
  float hd = hullDist(l);
  h += 0.55*exp(-pow((l.y+11.5)/3.5, 2.0))*exp(-hd*hd/5.0);
  return h;
}
`;
const oceanMat = new THREE.ShaderMaterial({
  uniforms: oceanUniforms,
  fog: false,
  vertexShader: GLSL_OCEAN_COMMON + /* glsl */`
  uniform float uTime;
  varying vec3 vWorld; varying vec2 vGrid;
  void main(){
    vec4 wp = modelMatrix*vec4(position,1.0);
    vec2 p = wp.xz;
    float dist = length(p - cameraPosition.xz);
    vec3 disp = vec3(0.0);
    for(int i=0;i<8;i++){
      vec4 w = uWaves[i];
      float k = 6.2831853/w.w;
      float c = sqrt(9.81/k);
      float fade = clamp(w.w/(0.07*dist+0.001) - 1.0, 0.0, 1.0);
      float f = k*(dot(w.xy, p) - c*uTime);
      float a = w.z/k*fade;
      float cf = cos(f);
      disp.x += w.x*a*cf; disp.z += w.y*a*cf; disp.y += a*sin(f);
    }
    vec2 l = shipLocal(p);
    disp.y += wakeHeight(l);
    wp.xyz += disp;
    vGrid = p; vWorld = wp.xyz;
    gl_Position = projectionMatrix*viewMatrix*wp;
  }`,
  fragmentShader: GLSL_NOISE + GLSL_SKY + GLSL_OCEAN_COMMON + /* glsl */`
  uniform vec3 uSunCol;
  varying vec3 vWorld; varying vec2 vGrid;
  void main(){
    vec2 p = vGrid;
    float dist = length(vWorld - cameraPosition);
    vec3 N = vec3(0.0, 1.0, 0.0);
    float crest = 0.0;
    float hgt = 0.0;
    for(int i=0;i<8;i++){
      vec4 w = uWaves[i];
      float k = 6.2831853/w.w;
      float c = sqrt(9.81/k);
      float fade = clamp(w.w*9.0/dist, 0.0, 1.0);
      float f = k*(dot(w.xy, p) - c*uTime);
      float wa = w.z*fade;
      float cf = cos(f); float sf = sin(f);
      N.x -= w.x*wa*cf; N.z -= w.y*wa*cf; N.y -= wa*sf*0.6;
      crest += wa*sf*step(8.0, w.w);
      hgt += sf*w.z/k;
    }
    // detail ripples
    float dfade = exp(-dist/55.0);
    vec2 g = vec2(0.0);
    const int ND = 6;
    vec3 dd[ND];
    dd[0]=vec3(0.80,0.60,2.3); dd[1]=vec3(-0.35,0.94,1.65); dd[2]=vec3(0.95,-0.31,1.18);
    dd[3]=vec3(-0.71,-0.70,0.86); dd[4]=vec3(0.20,-0.98,0.61); dd[5]=vec3(-0.97,0.24,0.43);
    for(int i=0;i<ND;i++){
      float k = 6.2831853/dd[i].z;
      float om = sqrt(9.81*k);
      float f = k*dot(dd[i].xy, p) - om*uTime + float(i)*1.7;
      g += dd[i].xy*0.055*cos(f);
    }
    float nn = vnoise(p*0.9 + uTime*0.25) - vnoise(p*0.9 + vec2(0.37,0.0) + uTime*0.25);
    float nm = vnoise(p*0.9 + uTime*0.25) - vnoise(p*0.9 + vec2(0.0,0.37) + uTime*0.25);
    g += vec2(nn, nm)*0.12;
    N.xz -= g*dfade;
    // wake normal
    vec2 l = shipLocal(vWorld.xz);
    if(abs(l.x) < 140.0 && l.y > -40.0 && l.y < 400.0){
      float e = 0.35;
      float h0 = wakeHeight(l);
      float hx = wakeHeight(l+vec2(e,0.0));
      float hz = wakeHeight(l+vec2(0.0,e));
      vec2 gl = vec2(hx-h0, hz-h0)/e;
      vec2 rgt = vec2(-uShipFwd.y, uShipFwd.x);
      vec2 gw = rgt*gl.x - uShipFwd*gl.y;
      N.xz -= gw;
    }
    N = normalize(N);

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = uSunDir;
    float NdL = max(dot(N, L), 0.0);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.002;
    R = normalize(R);
    vec3 refl = skyFull(R, false)*0.82;
    float NdV = max(dot(N, V), 0.0);
    float F = 0.02 + 0.98*pow(1.0 - NdV, 5.0);
    F = mix(F, 1.0, 0.0);

    vec3 deep = vec3(0.005, 0.024, 0.040);
    vec3 sssCol = vec3(0.04, 0.26, 0.24);
    float sss = pow(clamp(dot(V, -normalize(L + N*0.55)), 0.0, 1.0), 3.0);
    float hfac = clamp(hgt*0.35 + 0.55, 0.0, 1.5);
    vec3 amb = vec3(0.30, 0.27, 0.42);
    vec3 body = deep*(amb*1.4 + uSunCol*NdL*0.25) + sssCol*(sss*uSunCol*0.45*hfac + vec3(0.03)*hfac);
    vec3 col = mix(body, refl, F);

    float rough = smoothstep(30.0, 2500.0, dist);
    float sp = max(dot(R, L), 0.0);
    col += uSunCol*(pow(sp, mix(1600.0, 700.0, rough))*mix(40.0, 7.0, rough) + pow(sp, 240.0)*0.22*(1.0-rough*0.6));

    // foam
    vec2 wp = vWorld.xz;
    float nf = fbm3(wp*0.32 + vec2(uTime*0.03, 0.0));
    float nf2 = vnoise(wp*1.7 - vec2(0.0, uTime*0.12));
    float ffade = exp(-dist/600.0);
    float foamAmt = 0.0;
    // whitecaps
    foamAmt += smoothstep(0.22, 0.5, crest)*0.9;
    // ship foam
    float hd = hullDist(l);
    float contact = exp(-hd/0.75)*(0.45 + 0.6*smoothstep(-2.0, -11.0, l.y));
    foamAmt += contact*1.25;
    float sb = l.y + 13.0;
    if(sb > 0.0){
      float arm = 1.3 + sb*0.36;
      float w = 0.6 + sb*0.05;
      float dx = (abs(l.x) - arm)/w;
      foamAmt += exp(-dx*dx)*exp(-sb/110.0)*0.72;
      float inside = smoothstep(arm, arm*0.3, abs(l.x));
      foamAmt += inside*0.18*exp(-sb/70.0);
    }
    float ss = l.y - 12.0;
    if(ss > -3.0){
      float s0 = max(ss, 0.0);
      float W = 2.4 + s0*0.075;
      vec2 rgt = vec2(-uShipFwd.y, uShipFwd.x);
      float streak = vnoise(vec2(dot(wp, rgt)*0.9, dot(wp, uShipFwd)*0.07));
      foamAmt += exp(-pow(l.x/W, 2.0))*exp(-s0/200.0)*0.95*smoothstep(-3.0, 1.5, ss)*(0.35+0.75*streak);
    }
    float nf3 = vnoise(wp*4.3 + vec2(uTime*0.2, -uTime*0.1));
    float pattern = nf*0.55 + nf2*0.3 + nf3*0.15;
    foamAmt = min(foamAmt, 0.97);
    float foam = smoothstep(1.0 - foamAmt, 1.0 - foamAmt + 0.13, pattern);
    foam *= 0.55 + 0.45*smoothstep(0.3, 0.7, nf2);
    foam *= ffade;
    vec3 foamCol = vec3(0.92, 0.93, 0.95)*(amb*0.9 + uSunCol*(NdL*0.55 + 0.12));
    col = mix(col, foamCol, clamp(foam, 0.0, 1.0)*0.92);

    // aerial perspective to horizon
    vec3 vd = normalize(vWorld - cameraPosition);
    vec3 hz = skyBase(normalize(vec3(vd.x, 0.0, vd.z)));
    float fog = 1.0 - exp(-dist*0.00042);
    col = mix(col, hz, fog);
    gl_FragColor = vec4(col, 1.0);
  }`,
});

function makeOceanGeometry() {
  const seg = 384;
  const radii = [0];
  let r = 0.4;
  while (r < 12000) { radii.push(r); r *= (r < 2 ? 1.25 : 1.0165); }
  const pos = new Float32Array(radii.length * seg * 3);
  let k = 0;
  for (const rad of radii) {
    for (let j = 0; j < seg; j++) {
      const a = j / seg * Math.PI * 2;
      pos[k++] = Math.cos(a) * rad; pos[k++] = 0; pos[k++] = Math.sin(a) * rad;
    }
  }
  const idx = [];
  for (let i = 0; i < radii.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j, b = i * seg + (j + 1) % seg, c = (i + 1) * seg + j, d = (i + 1) * seg + (j + 1) % seg;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
const ocean = new THREE.Mesh(makeOceanGeometry(), oceanMat);
ocean.frustumCulled = false;
scene.add(ocean);

// ---------------------------------------------------------------- lights
const sunLight = new THREE.DirectionalLight(new THREE.Color(1.0, 0.64, 0.40), 3.2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -26; sunLight.shadow.camera.right = 26;
sunLight.shadow.camera.top = 30; sunLight.shadow.camera.bottom = -18;
sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 200;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.03;
scene.add(sunLight); scene.add(sunLight.target);
const hemi = new THREE.HemisphereLight(new THREE.Color(0.45, 0.40, 0.66), new THREE.Color(0.10, 0.11, 0.14), 0.9);
scene.add(hemi);

// environment map from the sky
{
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), skyMat.clone());
  envSky.material.uniforms = skyUniforms;
  envScene.add(envSky);
  const lower = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.06, 0.08), side: THREE.BackSide }));
  envScene.add(lower);
  const rt = pm.fromScene(envScene, 0.02);
  scene.environment = rt.texture;
  scene.environmentIntensity = 0.55;
}

// ---------------------------------------------------------------- canvas textures
function canvasTex(w, h, draw, srgb = true, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}
const rgb = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

function grain(ctx, x, y, w, h, base, n, vertical, alpha = 0.12) {
  for (let i = 0; i < n; i++) {
    const dark = rnd() < 0.6;
    const v = dark ? 0.55 + rnd() * 0.3 : 1.1 + rnd() * 0.25;
    ctx.strokeStyle = rgb(base[0] * v, base[1] * v, base[2] * v, alpha * rnd());
    ctx.lineWidth = 0.5 + rnd() * 1.6;
    ctx.beginPath();
    const off = rnd() * (vertical ? w : h);
    const amp = rnd() * 2.5, fr = rr(0.005, 0.03), ph = rnd() * 6;
    if (vertical) {
      for (let s = 0; s <= h; s += 8) { const xx = x + off + Math.sin(s * fr + ph) * amp; s === 0 ? ctx.moveTo(xx, y + s) : ctx.lineTo(xx, y + s); }
    } else {
      for (let s = 0; s <= w; s += 8) { const yy = y + off + Math.sin(s * fr + ph) * amp; s === 0 ? ctx.moveTo(x + s, yy) : ctx.lineTo(x + s, yy); }
    }
    ctx.stroke();
  }
}

// planks texture: horizontal planks (for hull), returns [color, bump]
function plankSet(w, h, plankPx, colorFn, opts = {}) {
  const tex = canvasTex(w, h, (ctx) => {
    for (let y = 0; y < h; y += plankPx) {
      let x = -rnd() * 260;
      while (x < w) {
        const len = rr(200, 320);
        const base = colorFn(h - y - plankPx / 2);
        const v = 0.82 + rnd() * 0.3;
        const col = [base[0] * v, base[1] * v, base[2] * v];
        ctx.fillStyle = rgb(...col);
        ctx.fillRect(x, y, len, plankPx);
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, len, plankPx); ctx.clip();
        grain(ctx, x, y, len, plankPx, col, 10, false, opts.grainAlpha || 0.25);
        ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, 2, plankPx);
        if (rnd() < 0.5) { ctx.fillStyle = 'rgba(20,12,6,0.6)'; ctx.beginPath(); ctx.arc(x + 6, y + plankPx * 0.3, 1.5, 0, 7); ctx.arc(x + 6, y + plankPx * 0.7, 1.5, 0, 7); ctx.fill(); }
        x += len;
      }
      ctx.fillStyle = 'rgba(8,5,3,0.75)'; ctx.fillRect(0, y, w, 2);
    }
    if (opts.post) opts.post(ctx, w, h);
  });
  const bump = canvasTex(w, h, (ctx) => {
    ctx.fillStyle = '#909090'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) { ctx.fillStyle = `rgba(${rnd() < 0.5 ? 255 : 0},${0},${0},0)`; }
    for (let y = 0; y < h; y += plankPx) {
      ctx.fillStyle = '#202020'; ctx.fillRect(0, y, w, 2);
      const g = ctx.createLinearGradient(0, y, 0, y + plankPx);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0.15)');
      ctx.fillStyle = g; ctx.fillRect(0, y + 2, w, plankPx - 2);
      grain(ctx, 0, y, w, plankPx, [140, 140, 140], 14, false, 0.3);
    }
  }, false);
  return [tex, bump];
}

// Hull: u along length (8m per tile), v = (y+3)/9
const HULL_TEX_H = 2048, HULL_TEX_W = 1024;
const yToPx = (y) => (6 - y) / 9 * HULL_TEX_H;
const hullColorAt = (py) => {
  const y = py / HULL_TEX_H * 9 - 3; // py measured from bottom
  if (y < -0.05) return [70, 40, 30];
  if (y < 0.55) return [52, 34, 22];
  if (y < 0.85) return [22, 16, 12];
  if (y < 1.85) return [96, 58, 32];
  if (y < 2.02) return [150, 104, 40];
  if (y < 3.3) return [48, 30, 20];
  if (y < 3.45) return [150, 104, 40];
  return [64, 40, 26];
};
const [hullTex, hullBump] = plankSet(HULL_TEX_W, HULL_TEX_H, 50, hullColorAt, {
  grainAlpha: 0.22,
  post: (ctx, w, h) => {
    // water staining and grime
    for (let i = 0; i < 90; i++) {
      const x = rnd() * w, y0 = yToPx(rr(0.8, 3.5)), len = rr(40, 220);
      const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
      g.addColorStop(0, 'rgba(10,8,6,0.0)'); g.addColorStop(0.3, 'rgba(10,8,6,0.18)'); g.addColorStop(1, 'rgba(10,8,6,0)');
      ctx.fillStyle = g; ctx.fillRect(x, y0, rr(3, 12), len);
    }
    // waterline grime
    const g2 = ctx.createLinearGradient(0, yToPx(0.6), 0, yToPx(-0.3));
    g2.addColorStop(0, 'rgba(30,40,30,0)'); g2.addColorStop(0.6, 'rgba(30,45,35,0.45)'); g2.addColorStop(1, 'rgba(20,30,25,0.6)');
    ctx.fillStyle = g2; ctx.fillRect(0, yToPx(0.6), w, yToPx(-0.3) - yToPx(0.6));
  },
});
hullTex.wrapT = hullBump.wrapT = THREE.ClampToEdgeWrapping;

const [deckTex, deckBump] = plankSet(1024, 1024, 46, () => [150, 112, 74], { grainAlpha: 0.3 });
// deck texture planks run along u; we map u along ship length.

const woodTex = canvasTex(256, 1024, (ctx, w, h) => {
  ctx.fillStyle = rgb(92, 60, 36); ctx.fillRect(0, 0, w, h);
  grain(ctx, 0, 0, w, h, [92, 60, 36], 160, true, 0.35);
});
const darkWoodTex = canvasTex(256, 1024, (ctx, w, h) => {
  ctx.fillStyle = rgb(48, 30, 18); ctx.fillRect(0, 0, w, h);
  grain(ctx, 0, 0, w, h, [60, 38, 22], 160, true, 0.4);
});
const bulkTex = canvasTex(512, 512, (ctx, w, h) => {
  const pw = 32;
  for (let x = 0; x < w; x += pw) {
    const v = 0.85 + rnd() * 0.25;
    const col = [110 * v, 46 * v, 30 * v];
    ctx.fillStyle = rgb(...col); ctx.fillRect(x, 0, pw, h);
    grain(ctx, x, 0, pw, h, col, 8, true, 0.3);
    ctx.fillStyle = 'rgba(10,5,3,0.7)'; ctx.fillRect(x, 0, 2, h);
  }
});

const sailTex = canvasTex(512, 512, (ctx, w, h) => {
  ctx.fillStyle = rgb(232, 218, 188); ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.9;
  }
  ctx.putImageData(img, 0, 0);
  // cloth panels
  for (let x = 0; x < w; x += 42) {
    ctx.fillStyle = 'rgba(120,95,60,0.35)'; ctx.fillRect(x, 0, 2, h);
    ctx.fillStyle = 'rgba(255,250,235,0.25)'; ctx.fillRect(x + 2, 0, 1, h);
    const v = rnd() * 0.08;
    ctx.fillStyle = `rgba(110,85,50,${v})`; ctx.fillRect(x, 0, 42, h);
  }
  // reef bands
  for (const yy of [0.16, 0.3]) {
    ctx.fillStyle = 'rgba(120,95,60,0.35)'; ctx.fillRect(0, yy * h, w, 5);
    for (let x = 12; x < w; x += 22) { ctx.fillStyle = 'rgba(70,50,30,0.6)'; ctx.fillRect(x, yy * h + 1, 2, 8); }
  }
  // patches
  for (let i = 0; i < 4; i++) {
    const px = rr(40, w - 120), py = rr(120, h - 120), pw = rr(30, 70), ph = rr(30, 60);
    ctx.fillStyle = `rgba(${rr(180, 215)},${rr(160, 190)},${rr(120, 150)},0.9)`; ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = 'rgba(90,70,40,0.6)'; ctx.setLineDash([3, 3]); ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4); ctx.setLineDash([]);
  }
  // grime at foot and edges
  let g = ctx.createLinearGradient(0, h * 0.55, 0, h);
  g.addColorStop(0, 'rgba(90,70,45,0)'); g.addColorStop(1, 'rgba(90,70,45,0.45)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 25; i++) {
    const x = rnd() * w, y = rnd() * h, r = rr(10, 60);
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(100,80,50,0.12)'); gg.addColorStop(1, 'rgba(100,80,50,0)');
    ctx.fillStyle = gg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.strokeStyle = 'rgba(80,60,35,0.8)'; ctx.lineWidth = 6; ctx.strokeRect(0, 0, w, h);
}, true, false);

const flagTex = canvasTex(512, 320, (ctx, w, h) => {
  ctx.fillStyle = '#0b0a0a'; ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) { const n = rnd() * 16; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  const cx = w * 0.45, cy = h * 0.45;
  ctx.fillStyle = '#e8e2d2'; ctx.strokeStyle = '#e8e2d2';
  // crossed bones
  ctx.lineCap = 'round'; ctx.lineWidth = 20;
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(cx - 120, cy + 10 + s * 70); ctx.lineTo(cx + 120, cy + 10 - s * 70); ctx.stroke();
    for (const e of [[-120, 10 + s * 70], [120, 10 - s * 70]]) {
      ctx.beginPath(); ctx.arc(cx + e[0] - 6, cy + e[1] - 10, 15, 0, 7); ctx.arc(cx + e[0] + 6, cy + e[1] + 10, 15, 0, 7); ctx.fill();
    }
  }
  // skull
  ctx.beginPath(); ctx.ellipse(cx, cy - 20, 62, 66, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(cx - 36, cy + 20, 72, 44);
  ctx.fillStyle = '#0b0a0a';
  ctx.beginPath(); ctx.ellipse(cx - 24, cy - 14, 16, 19, 0.2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + 24, cy - 14, 16, 19, -0.2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx - 9, cy + 22); ctx.lineTo(cx + 9, cy + 22); ctx.fill();
  for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * 13 - 2, cy + 40, 4, 24);
  // wear
  for (let i = 0; i < 12; i++) { ctx.fillStyle = 'rgba(0,0,0,0.9)'; ctx.beginPath(); ctx.arc(w - rr(0, 30), rnd() * h, rr(4, 18), 0, 7); ctx.fill(); }
}, true, false);

const crateTex = canvasTex(256, 256, (ctx, w, h) => {
  for (let y = 0; y < h; y += 42) {
    const v = 0.8 + rnd() * 0.3; const col = [130 * v, 92 * v, 56 * v];
    ctx.fillStyle = rgb(...col); ctx.fillRect(0, y, w, 42); grain(ctx, 0, y, w, 42, col, 8, false, 0.3);
    ctx.fillStyle = 'rgba(15,8,4,0.8)'; ctx.fillRect(0, y, w, 2);
  }
  ctx.fillStyle = rgb(80, 52, 30); ctx.fillRect(0, 0, w, 22); ctx.fillRect(0, h - 22, w, 22); ctx.fillRect(0, 0, 22, h); ctx.fillRect(w - 22, 0, 22, h);
  ctx.strokeStyle = 'rgba(15,8,4,0.8)'; ctx.lineWidth = 3; ctx.strokeRect(22, 22, w - 44, h - 44);
  ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(Math.PI / 4); ctx.fillStyle = rgb(80, 52, 30); ctx.fillRect(-160, -11, 320, 22); ctx.restore();
});
const gratingTex = canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = '#0a0705'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = rgb(120, 86, 52);
  for (let i = 0; i < 8; i++) { ctx.fillRect(i * 32 + 4, 0, 14, h); }
  ctx.fillStyle = rgb(105, 74, 44);
  for (let i = 0; i < 8; i++) { ctx.fillRect(0, i * 32 + 4, w, 10); }
});
const windowTex = canvasTex(128, 192, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h * 0.6, 5, w / 2, h * 0.6, h * 0.7);
  g.addColorStop(0, '#ffd890'); g.addColorStop(1, '#c85a18');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1a0f08';
  ctx.fillRect(0, 0, w, 10); ctx.fillRect(0, h - 10, w, 10); ctx.fillRect(0, 0, 10, h); ctx.fillRect(w - 10, 0, 10, h);
  ctx.fillRect(w / 2 - 4, 0, 8, h);
  for (let i = 1; i < 4; i++) ctx.fillRect(0, i * h / 4 - 3, w, 6);
}, true, false);

// ---------------------------------------------------------------- materials
const M = {
  hull: new THREE.MeshStandardMaterial({ map: hullTex, bumpMap: hullBump, bumpScale: 1.2, roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide }),
  deck: new THREE.MeshStandardMaterial({ map: deckTex, bumpMap: deckBump, bumpScale: 0.8, roughness: 0.85 }),
  wood: new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.75 }),
  darkWood: new THREE.MeshStandardMaterial({ map: darkWoodTex, roughness: 0.7 }),
  bulk: new THREE.MeshStandardMaterial({ map: bulkTex, roughness: 0.7, side: THREE.DoubleSide }),
  rope: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.11, 0.075, 0.045), roughness: 0.95 }),
  ropeLight: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.33, 0.21), roughness: 0.95 }),
  iron: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.06, 0.06, 0.065), roughness: 0.42, metalness: 0.85 }),
  gold: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.95, 0.66, 0.28), roughness: 0.32, metalness: 1.0 }),
  black: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.015, 0.012), roughness: 0.9 }),
  red: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.34, 0.04, 0.025), roughness: 0.65 }),
  sail: new THREE.MeshStandardMaterial({ map: sailTex, roughness: 0.92, side: THREE.DoubleSide }),
  flag: new THREE.MeshStandardMaterial({ map: flagTex, roughness: 0.95, side: THREE.DoubleSide }),
  crate: new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.85 }),
  grating: new THREE.MeshStandardMaterial({ map: gratingTex, roughness: 0.85 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1.0, 0.55, 0.2), emissiveIntensity: 9.0, roughness: 0.3 }),
  window: new THREE.MeshStandardMaterial({ map: windowTex, emissiveMap: windowTex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 2.2, roughness: 0.4 }),
  doorDark: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.05, 0.03, 0.02), roughness: 0.8 }),
};
M.hull.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    if(!gl_FrontFacing){ diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32,0.045,0.03)*0.9, 0.82); }`);
};
const sunViewDir = { value: new V3() };
const sunColU = { value: new V3(1.0, 0.6, 0.32).multiplyScalar(2.6) };
const addTranslucency = (mat, amt) => {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunV = sunViewDir; sh.uniforms.uSunC = sunColU;
    sh.fragmentShader = 'uniform vec3 uSunV; uniform vec3 uSunC;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float bl = max(-dot(normal, uSunV), 0.0);
        float fs = pow(max(dot(normalize(-vViewPosition), uSunV), 0.0), 5.0);
        totalEmissiveRadiance += diffuseColor.rgb * uSunC * bl * (0.12 + 1.1*fs) * ${amt.toFixed(2)};
      }`);
  };
};
addTranslucency(M.sail, 1.0);
addTranslucency(M.flag, 0.4);

// ---------------------------------------------------------------- tube batch (ropes, spars, rails)
class TubeBatch {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.idx = []; }
  add(points, r, radial = 4, uvScale = 1) {
    const n = points.length; if (n < 2) return;
    const base = this.pos.length / 3;
    let prevN = null;
    let acc = 0;
    const tng = new V3(), nrm = new V3(), bin = new V3();
    for (let i = 0; i < n; i++) {
      const p = points[i];
      tng.subVectors(points[Math.min(i + 1, n - 1)], points[Math.max(i - 1, 0)]).normalize();
      if (!prevN) {
        const a = Math.abs(tng.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
        nrm.crossVectors(tng, a).normalize();
      } else {
        nrm.copy(prevN).addScaledVector(tng, -prevN.dot(tng)).normalize();
      }
      prevN = nrm.clone();
      bin.crossVectors(tng, nrm);
      if (i > 0) acc += p.distanceTo(points[i - 1]);
      const rad = typeof r === 'function' ? r(i / (n - 1)) : r;
      for (let j = 0; j <= radial; j++) {
        const a = j / radial * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const nx = nrm.x * c + bin.x * s, ny = nrm.y * c + bin.y * s, nz = nrm.z * c + bin.z * s;
        this.pos.push(p.x + nx * rad, p.y + ny * rad, p.z + nz * rad);
        this.nor.push(nx, ny, nz);
        this.uv.push(j / radial, acc * uvScale);
      }
    }
    const R = radial + 1;
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = base + i * R + j, b = base + i * R + j + 1, c = base + (i + 1) * R + j + 1, d = base + (i + 1) * R + j;
      this.idx.push(a, b, d, b, c, d);
    }
  }
  line(p0, p1, r, radial = 4, segs = 1) {
    const pts = []; for (let i = 0; i <= segs; i++) pts.push(new V3().lerpVectors(p0, p1, i / segs));
    this.add(pts, r, radial);
  }
  rope(p0, p1, sag, r, segs = 8, radial = 4) {
    const pts = [];
    for (let i = 0; i <= segs; i++) { const t = i / segs; const p = new V3().lerpVectors(p0, p1, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); }
    this.add(pts, r, radial);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

// ---------------------------------------------------------------- hull definition
const L = 26, HALF = L / 2, BEAM = 7.4;
const zAt = (t) => HALF - t * L;
function halfBeam(t) {
  if (t > 0.52) { const k = (t - 0.52) / 0.48; return BEAM / 2 * Math.pow(Math.max(0, 1 - k * k), 0.55); }
  const k = (0.52 - t) / 0.52; return BEAM / 2 * (1 - 0.32 * k * k);
}
function sheer(t) {
  return 2.6 + 2.15 * (1 - smooth(0.235, 0.33, t)) + 0.35 * clamp(1 - t / 0.235, 0, 1)
    + 0.9 * smooth(0.79, 0.88, t) + 0.6 * Math.pow(smooth(0.88, 1.0, t), 2);
}
function depth(t) {
  let d = 2.5;
  if (t > 0.68) { const k = (t - 0.68) / 0.32; d *= 1 - 0.78 * k * k; }
  if (t < 0.12) { const k = (0.12 - t) / 0.12; d *= 1 - 0.28 * k; }
  return d;
}
const secShape = (a) => Math.pow(Math.sin(a * Math.PI / 2), 0.5) * (1 - 0.09 * smooth(0.62, 1, a));
function hullPt(t, a, side) {
  const d = depth(t), sh = sheer(t);
  const y = -d + (sh + d) * a;
  const x = side * halfBeam(t) * secShape(a);
  let z = zAt(t);
  z -= 1.9 * smooth(0.72, 1.0, t) * a * a;
  z += 0.75 * (1 - smooth(0.0, 0.05, t)) * a;
  return new V3(x, y, z);
}
function aAtY(t, y) { const d = depth(t), sh = sheer(t); return (y + d) / (sh + d); }
function hullAtY(t, y, side, out = 0) {
  const a = clamp(aAtY(t, y), 0, 1);
  const p = hullPt(t, a, side); p.x += side * out; return p;
}
function hullNormal(t, a, side) {
  const e = 0.002;
  const pt = hullPt(Math.min(1, t + e), a, side).sub(hullPt(Math.max(0, t - e), a, side));
  const pa = hullPt(t, Math.min(1, a + e), side).sub(hullPt(t, Math.max(0, a - e), side));
  const n = new V3().crossVectors(pt, pa).normalize();
  if (n.x * side < 0) n.negate();
  return n;
}

const ship = new THREE.Group();      // yaw + position
const shipTilt = new THREE.Group();  // heave/pitch/roll
ship.add(shipTilt);
scene.add(ship);
const castAll = (o, cast = true, recv = true) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = cast; m.receiveShadow = recv; } }); return o; };

function buildHull() {
  const NS = 120, NA = 30, W = 2 * NA + 1;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    for (let j = 0; j < W; j++) {
      const side = j < NA ? -1 : 1; const a = Math.abs(j - NA) / NA;
      const p = hullPt(t, a, j === NA ? 1 : side);
      pos.push(p.x, p.y, p.z);
      uv.push(-p.z / 8, (p.y + 3) / 9);
    }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < W - 1; j++) {
    const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, d = i * W + j + 1;
    idx.push(a, b, d, b, c, d);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // orientation check: a port vertex mid-ship should have normal.x < 0
  const nAttr = g.getAttribute('normal');
  const test = (NS / 2) * W + Math.floor(NA / 2);
  if (nAttr.getX(test) > 0) {
    for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  const hull = new THREE.Mesh(g, M.hull);
  shipTilt.add(castAll(hull));

  // transom
  const tp = [], tuv = [], tidx = [];
  const ring = [];
  for (let j = 0; j < W; j++) { const side = j < NA ? -1 : 1; const a = Math.abs(j - NA) / NA; ring.push(hullPt(0, a, side)); }
  const ctr = new V3(); ring.forEach((p) => ctr.add(p)); ctr.multiplyScalar(1 / ring.length);
  tp.push(ctr.x, ctr.y, ctr.z); tuv.push(ctr.x / 8, (ctr.y + 3) / 9);
  ring.forEach((p) => { tp.push(p.x, p.y, p.z); tuv.push(p.x / 8, (p.y + 3) / 9); });
  for (let j = 0; j < W - 1; j++) tidx.push(0, j + 1, j + 2);
  tidx.push(0, W, 1);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
  tg.setIndex(tidx); tg.computeVertexNormals();
  if (tg.getAttribute('normal').getZ(0) < 0) { for (let k = 0; k < tidx.length; k += 3) { const tmp = tidx[k + 1]; tidx[k + 1] = tidx[k + 2]; tidx[k + 2] = tmp; } tg.setIndex(tidx); tg.computeVertexNormals(); }
  shipTilt.add(castAll(new THREE.Mesh(tg, M.hull)));
}
buildHull();

// decks
const DECK_MAIN = 1.75, DECK_QTR = 3.95, DECK_FC = 2.95;
function buildDeck(t0, t1, y, n) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const t = lerp(t0, t1, i / n);
    for (const side of [-1, 1]) {
      const p = hullAtY(t, y, side);
      p.x -= side * 0.1; p.y = y;
      pos.push(p.x, p.y, p.z); uv.push(-p.z / 6, p.x / 6 + 0.5);
    }
  }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  if (g.getAttribute('normal').getY(0) < 0) { for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; } g.setIndex(idx); g.computeVertexNormals(); }
  const m = new THREE.Mesh(g, M.deck); m.receiveShadow = true; m.castShadow = true;
  shipTilt.add(m);
}
buildDeck(0.004, 0.25, DECK_QTR, 20);
buildDeck(0.235, 0.875, DECK_MAIN, 40);
buildDeck(0.86, 0.985, DECK_FC, 14);

function buildBulkhead(t, y0, y1, facing) {
  const pos = [], uv = [], idx = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const y = lerp(y0, y1, i / n);
    for (const side of [-1, 1]) {
      const p = hullAtY(t, y, side); p.x -= side * 0.08; p.y = y; p.z = zAt(t);
      pos.push(p.x, p.y, p.z); uv.push(p.x / 3, y / 3);
    }
  }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, M.bulk); castAll(m);
  shipTilt.add(m);
  return zAt(t);
}
const zQtr = buildBulkhead(0.25, DECK_MAIN - 0.05, DECK_QTR, -1);
const zFc = buildBulkhead(0.86, DECK_MAIN - 0.05, DECK_FC, 1);

// doors & windows on the quarterdeck bulkhead
{
  for (const x of [-1.6, 1.6]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.75, 0.08), M.doorDark);
    door.position.set(x, DECK_MAIN + 0.875, zQtr - 0.05); shipTilt.add(door);
    const fr = new TubeBatch();
    const zz = zQtr - 0.1;
    fr.add([new V3(x - 0.5, DECK_MAIN, zz), new V3(x - 0.5, DECK_MAIN + 1.8, zz), new V3(x, DECK_MAIN + 2.0, zz), new V3(x + 0.5, DECK_MAIN + 1.8, zz), new V3(x + 0.5, DECK_MAIN, zz)], 0.05, 6);
    shipTilt.add(new THREE.Mesh(fr.build(), M.gold));
  }
  for (const x of [-0.45, 0.45]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.65), M.window);
    w.position.set(x, DECK_MAIN + 1.25, zQtr - 0.06); w.rotation.y = Math.PI; shipTilt.add(w);
  }
}

// moldings, wales, cap rails
{
  const gold = new TubeBatch(), black = new TubeBatch(), cap = new TubeBatch();
  const levelLine = (y, side, out) => {
    const pts = [];
    for (let i = 0; i <= 140; i++) {
      const t = i / 140;
      const a = aAtY(t, y);
      if (a < 0 || a > 1) continue;
      const p = hullPt(t, a, side);
      const n = hullNormal(t, a, side);
      p.addScaledVector(n, out);
      pts.push(p);
    }
    return pts;
  };
  for (const side of [-1, 1]) {
    gold.add(levelLine(1.93, side, 0.02), 0.07, 6);
    gold.add(levelLine(3.38, side, 0.02), 0.06, 6);
    black.add(levelLine(0.58, side, 0.04), 0.1, 6);
    black.add(levelLine(0.82, side, 0.04), 0.1, 6);
    black.add(levelLine(1.12, side, 0.02), 0.06, 6);
    const top = [];
    for (let i = 0; i <= 160; i++) { const t = i / 160 * 0.995; const p = hullPt(t, 1, side); p.y += 0.04; top.push(p); }
    cap.add(top, 0.11, 6);
  }
  // transom top rail
  const tt = [];
  for (let i = 0; i <= 20; i++) { const s = -1 + 2 * i / 20; const p = hullPt(0, 1, 1); p.x *= s; p.y += 0.05; tt.push(p); }
  cap.add(tt, 0.11, 6);
  // stem / cutwater
  const stem = [];
  for (let i = 0; i <= 20; i++) { const a = i / 20; const p = hullPt(1, a, 1); p.z -= 0.05; stem.push(p); }
  cap.add(stem, 0.18, 8);
  shipTilt.add(castAll(new THREE.Mesh(gold.build(), M.gold)));
  shipTilt.add(castAll(new THREE.Mesh(black.build(), M.black)));
  shipTilt.add(castAll(new THREE.Mesh(cap.build(), M.darkWood)));
}

// stern windows & transom decoration
const lanternLights = [];
{
  const tz = (y) => hullAtY(0, y, 1).z + 0.06;
  const ws = [-1.7, -0.85, 0, 0.85, 1.7];
  for (const x of ws) {
    const y = 3.05;
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.95), M.window);
    const z = tz(y);
    w.position.set(x, y, z); w.rotation.x = -0.12; shipTilt.add(w);
  }
  const deco = new TubeBatch();
  const z1 = tz(2.45), z2 = tz(3.65);
  deco.line(new V3(-2.25, 2.45, z1 + 0.04), new V3(2.25, 2.45, z1 + 0.04), 0.07, 6);
  deco.line(new V3(-2.35, 3.65, z2 + 0.04), new V3(2.35, 3.65, z2 + 0.04), 0.07, 6);
  for (const x of [-2.15, -1.28, -0.43, 0.43, 1.28, 2.15]) deco.line(new V3(x, 2.45, z1 + 0.05), new V3(x, 3.65, z2 + 0.05), 0.05, 6);
  shipTilt.add(castAll(new THREE.Mesh(deco.build(), M.gold)));
  const balc = new TubeBatch();
  const zb = tz(2.3) + 0.5;
  balc.line(new V3(-2.3, 2.85, zb), new V3(2.3, 2.85, zb), 0.05, 6);
  for (let x = -2.3; x <= 2.31; x += 0.32) balc.line(new V3(x, 2.25, zb - 0.05), new V3(x, 2.85, zb), 0.03, 5);
  shipTilt.add(castAll(new THREE.Mesh(balc.build(), M.darkWood)));
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 0.7), M.darkWood);
  shelf.position.set(0, 2.22, zb - 0.28); shipTilt.add(castAll(shelf));
}

// ---------------------------------------------------------------- cannons
const cannonGeo = (() => {
  const prof = [[0, -0.2], [0.05, -0.19], [0.065, -0.15], [0.03, -0.1], [0.04, -0.06], [0.17, -0.02], [0.2, 0.05], [0.2, 0.14],
  [0.175, 0.18], [0.165, 0.6], [0.18, 0.63], [0.18, 0.68], [0.15, 0.71], [0.14, 1.45], [0.158, 1.48], [0.158, 1.53], [0.13, 1.56],
  [0.12, 1.98], [0.145, 2.03], [0.15, 2.12], [0.085, 2.12], [0.085, 2.0], [0, 2.0]];
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 20);
})();
function makeCarriageCannon() {
  const g = new THREE.Group();
  const cheekG = new THREE.BoxGeometry(0.12, 0.42, 1.3);
  for (const s of [-1, 1]) { const c = new THREE.Mesh(cheekG, M.red); c.position.set(s * 0.26, 0.38, 0.1); g.add(c); }
  const bed = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 1.3), M.red); bed.position.set(0, 0.2, 0.1); g.add(bed);
  const wheelG = new THREE.CylinderGeometry(0.17, 0.17, 0.1, 14);
  for (const s of [-1, 1]) for (const z of [-0.4, 0.55]) { const w = new THREE.Mesh(wheelG, M.darkWood); w.rotation.z = Math.PI / 2; w.position.set(s * 0.34, 0.17, z); g.add(w); }
  const b = new THREE.Mesh(cannonGeo, M.iron); b.rotation.x = -Math.PI / 2 + 0.03; b.position.set(0, 0.62, 0.55); g.add(b);
  return castAll(g);
}
{
  // gunports along the hull with protruding barrels
  const lidG = new THREE.BoxGeometry(0.66, 0.62, 0.07);
  const portG = new THREE.PlaneGeometry(0.62, 0.58);
  const frameB = new TubeBatch();
  const barrels = [];
  for (const side of [-1, 1]) {
    for (const t of [0.31, 0.385, 0.46, 0.535, 0.61, 0.685]) {
      const y = 1.42;
      const a = aAtY(t, y);
      const p = hullPt(t, a, side);
      const n = hullNormal(t, a, side);
      const grp = new THREE.Group();
      grp.position.copy(p).addScaledVector(n, 0.02);
      grp.lookAt(grp.position.clone().add(n));
      const port = new THREE.Mesh(portG, M.black); grp.add(port);
      const hinge = new THREE.Group(); hinge.position.set(0, 0.31, 0.02); hinge.rotation.x = -1.95; grp.add(hinge);
      const lid = new THREE.Mesh(lidG, M.red); lid.position.set(0, -0.31, 0.035); hinge.add(lid);
      const b = new THREE.Mesh(cannonGeo, M.iron); b.rotation.x = Math.PI / 2; b.position.set(0, -0.05, -1.25); grp.add(b);
      barrels.push(b);
      shipTilt.add(castAll(grp));
      // frame
      grp.updateMatrixWorld(true);
      const corners = [[-0.34, -0.32], [0.34, -0.32], [0.34, 0.32], [-0.34, 0.32], [-0.34, -0.32]].map(([x, yy]) => new V3(x, yy, 0.03).applyMatrix4(grp.matrix));
      frameB.add(corners, 0.04, 4);
    }
  }
  shipTilt.add(castAll(new THREE.Mesh(frameB.build(), M.darkWood)));
  // deck guns
  for (const side of [-1, 1]) {
    for (const t of [0.4, 0.52, 0.64]) {
      const c = makeCarriageCannon();
      const p = hullAtY(t, DECK_MAIN + 0.3, side);
      c.position.set(p.x - side * 1.15, DECK_MAIN, p.z);
      c.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      shipTilt.add(c);
    }
  }
  // bow chasers on the forecastle
  for (const s of [-1, 1]) {
    const c = makeCarriageCannon();
    c.position.set(s * 0.8, DECK_FC, zAt(0.93) + 0.2);
    c.rotation.y = Math.PI + s * 0.12;
    shipTilt.add(c);
  }
}

// ---------------------------------------------------------------- masts, yards, sails, rigging
const spars = new TubeBatch();
const ropes = new TubeBatch();
const ropesL = new TubeBatch();
const ironB = new TubeBatch();
const sails = [];

const deckYAt = (t) => (t < 0.25 ? DECK_QTR : t > 0.86 ? DECK_FC : DECK_MAIN);
const MASTS = [
  { t: 0.765, h: 22, r: 0.32, yards: [[7.8, 15.0], [13.8, 11.4], [18.6, 7.6]], course: true },
  { t: 0.5, h: 26, r: 0.38, yards: [[8.8, 17.4], [16.0, 13.4], [21.6, 9.2]], course: true },
  { t: 0.15, h: 17, r: 0.27, yards: [[10.0, 9.4], [14.2, 6.6]], course: false },
];
const BRACE = 0.16;
const yardEnds = [];

class Sail {
  constructor(nx, ny, restFn, mat = M.sail) {
    this.nx = nx; this.ny = ny; this.restFn = restFn;
    const g = new THREE.PlaneGeometry(1, 1, nx, ny);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.base = []; this.dir = []; this.amt = []; this.uvs = [];
    const uvA = g.getAttribute('uv');
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / ny;
      const r = restFn(u, v);
      this.base.push(r.p); this.dir.push(r.d); this.amt.push(r.a);
      uvA.setXY(j * (nx + 1) + i, u, 1 - v);
    }
    this.phase = rnd() * 10;
    this.update(0);
    shipTilt.add(this.mesh);
    sails.push(this);
  }
  update(t) {
    const pa = this.geo.getAttribute('position');
    const breathe = 1 + 0.07 * Math.sin(t * 1.35 + this.phase) + 0.03 * Math.sin(t * 3.1 + this.phase * 2);
    const nx = this.nx;
    for (let k = 0; k < this.base.length; k++) {
      const i = k % (nx + 1), j = Math.floor(k / (nx + 1));
      const u = i / nx, v = j / this.ny;
      const b = this.base[k], d = this.dir[k], a = this.amt[k];
      const fl = 0.07 * Math.sin(u * 8.0 + v * 5.0 - t * 7.5 + this.phase) * Math.min(1, a * 2.5 + 0.15)
        + 0.04 * Math.sin(u * 15 - v * 9 - t * 11.0 + this.phase);
      const off = a * breathe + fl * (0.4 + v);
      pa.setXYZ(k, b.x + d.x * off, b.y + d.y * off, b.z + d.z * off);
    }
    pa.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

function squareSail(tl, tr, bl, br, bulge, fwd) {
  return new Sail(14, 12, (u, v) => {
    const top = new V3().lerpVectors(tl, tr, u), bot = new V3().lerpVectors(bl, br, u);
    const p = new V3().lerpVectors(top, bot, v);
    p.y += Math.sin(Math.PI * u) * 0.35 * v * v; // foot roach
    const pu = Math.pow(Math.sin(Math.PI * u), 0.8) * 0.85 + 0.15;
    const pv = Math.sin(Math.PI * Math.min(v, 1) * 0.72);
    return { p, d: fwd, a: bulge * pu * pv };
  });
}

MASTS.forEach((ms, mi) => {
  const z = zAt(ms.t) + 0;
  const y0 = deckYAt(ms.t);
  const H = ms.h;
  ms.z = z; ms.y0 = y0;
  // lower mast
  const lowTop = y0 + H * 0.56;
  spars.add([new V3(0, y0 - 0.5, z), new V3(0, lowTop + 0.9, z)], (s) => ms.r * (1 - 0.22 * s), 14, 0.5);
  const topY = y0 + H * 0.82;
  spars.add([new V3(0, lowTop - 0.6, z + 0.05), new V3(0, topY + 0.8, z + 0.05)], (s) => ms.r * 0.62 * (1 - 0.3 * s), 12, 0.5);
  spars.add([new V3(0, topY - 0.5, z + 0.08), new V3(0, y0 + H, z + 0.08)], (s) => ms.r * 0.38 * (1 - 0.45 * s), 10, 0.5);
  // fighting top platform
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(ms.r * 5.2, ms.r * 4.6, 0.18, 24), M.darkWood);
  plat.position.set(0, lowTop, z + 0.15); plat.scale.set(1, 1, 0.85); shipTilt.add(castAll(plat));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(ms.r * 5.1, 0.06, 6, 28), M.wood);
  rim.rotation.x = Math.PI / 2; rim.position.set(0, lowTop + 0.35, z + 0.15); rim.scale.set(1, 0.85, 1); shipTilt.add(rim);
  for (let k = 0; k < 14; k++) {
    const a = k / 14 * Math.PI * 2;
    spars.add([new V3(Math.cos(a) * ms.r * 5.1, lowTop, z + 0.15 + Math.sin(a) * ms.r * 5.1 * 0.85), new V3(Math.cos(a) * ms.r * 5.1, lowTop + 0.35, z + 0.15 + Math.sin(a) * ms.r * 5.1 * 0.85)], 0.025, 4);
  }
  // crosstrees at topmast head
  spars.line(new V3(-ms.r * 3, topY, z + 0.08), new V3(ms.r * 3, topY, z + 0.08), 0.06, 5);
  spars.line(new V3(0, topY, z - ms.r * 2), new V3(0, topY, z + ms.r * 2.5), 0.06, 5);
  // truck
  const truck = new THREE.Mesh(new THREE.SphereGeometry(ms.r * 0.45, 10, 8), M.gold);
  truck.position.set(0, y0 + H + 0.05, z + 0.08); shipTilt.add(truck);
  // iron bands on lower mast
  for (let k = 0; k < 6; k++) {
    const yy = y0 + 1.2 + k * (H * 0.5 / 6);
    const band = new THREE.Mesh(new THREE.TorusGeometry(ms.r * (1 - 0.22 * (yy - y0) / (H * 0.56)) + 0.015, 0.03, 5, 16), M.iron);
    band.rotation.x = Math.PI / 2; band.position.set(0, yy, z); shipTilt.add(band);
  }

  // yards
  const ends = [];
  ms.yards.forEach(([hy, len], yi) => {
    const y = y0 + hy;
    const c = Math.cos(BRACE), s = Math.sin(BRACE);
    const zc = z - 0.55;
    const half = len / 2;
    const L0 = new V3(-half * c, y, zc + half * s);
    const R0 = new V3(half * c, y, zc - half * s);
    const pts = []; for (let k = 0; k <= 8; k++) pts.push(new V3().lerpVectors(L0, R0, k / 8));
    spars.add(pts, (q) => (0.2 - 0.06 * yi) * (0.55 + 0.45 * Math.sin(Math.PI * q)), 8, 0.5);
    // footrope
    const fpL = L0.clone().lerp(R0, 0.03), fpR = R0.clone().lerp(L0, 0.03);
    const fps = [];
    for (let k = 0; k <= 12; k++) { const q = k / 12; const p = new V3().lerpVectors(fpL, fpR, q); p.y -= 0.85 * (0.5 + 2 * q * (1 - q)); p.z -= 0.1; fps.push(p); }
    ropesL.add(fps, 0.025, 4);
    // lifts
    const head = new V3(0, y + (yi === ms.yards.length - 1 ? 2.2 : 3.4), z + 0.05);
    ropes.line(L0.clone().lerp(R0, 0.02), head, 0.03, 4);
    ropes.line(R0.clone().lerp(L0, 0.02), head, 0.03, 4);
    // parrel to mast
    ironB.line(new V3(0, y, z - 0.2), new V3(0, y, zc), 0.07, 6);
    ends.push({ L: L0, R: R0, y, len, zc });
  });
  yardEnds.push(ends);

  // square sails
  const fwd = new V3(-Math.sin(BRACE), 0, -Math.cos(BRACE)).normalize();
  for (let k = 0; k < ends.length; k++) {
    const top = ends[k];
    const tl = top.L.clone().lerp(top.R, 0.04).add(new V3(0, -0.15, -0.12));
    const tr = top.R.clone().lerp(top.L, 0.04).add(new V3(0, -0.15, -0.12));
    let bl, br;
    if (k === 0) {
      if (!ms.course) continue;
      const by = y0 + 2.6;
      bl = new V3(tl.x * 1.06, by, tl.z + 0.4); br = new V3(tr.x * 1.06, by, tr.z + 0.4);
    } else {
      const bot = ends[k - 1];
      bl = bot.L.clone().lerp(bot.R, 0.06).add(new V3(0, 0.2, -0.1));
      br = bot.R.clone().lerp(bot.L, 0.06).add(new V3(0, 0.2, -0.1));
    }
    const h = tl.y - bl.y;
    const s = squareSail(tl, tr, bl, br, h * 0.2 + 0.4, fwd);
    s.corners = { bl, br };
    if (k === 0) {
      // sheets to the deck edge
      for (const [pc, side] of [[bl, -1], [br, 1]]) {
        const anchor = hullAtY(clamp(ms.t - 0.14, 0, 1), sheer(ms.t - 0.14) - 0.05, side);
        ropes.rope(pc.clone().add(new V3(0, 0, -1.2)), anchor, 0.25, 0.03, 8, 4);
      }
    }
  }
});

// Mizzen spanker (fore-and-aft)
{
  const ms = MASTS[2];
  const z = ms.z, y0 = ms.y0;
  const gaffEnd = new V3(0, y0 + 9.4, z + 6.6);
  const gaffStart = new V3(0, y0 + 7.6, z + 0.35);
  const boomStart = new V3(0, y0 + 1.6, z + 0.35);
  const boomEnd = new V3(0, y0 + 1.9, z + 8.9);
  spars.line(gaffStart, gaffEnd, 0.11, 8, 4);
  spars.line(boomStart, boomEnd, 0.13, 8, 4);
  const side = new V3(-1, 0, 0);
  new Sail(12, 10, (u, v) => {
    const top = new V3().lerpVectors(gaffStart, gaffEnd, u).add(new V3(0, -0.15, 0));
    const bot = new V3().lerpVectors(boomStart, boomEnd, u).add(new V3(0, 0.15, 0));
    const p = new V3().lerpVectors(top, bot, v);
    const a = 0.9 * Math.sin(Math.PI * u) * (0.35 + 0.65 * Math.sin(Math.PI * v)) * (1 - 0.3 * u);
    return { p, d: side, a };
  });
  ropes.line(gaffEnd, new V3(0, y0 + ms.h * 0.82, z), 0.03, 4);
  ropes.rope(boomEnd, new V3(-0.9, DECK_QTR + 0.6, zAt(0.01)), 0.1, 0.035, 6, 4);
}

// bowsprit + jibs
const bowTip = hullPt(1, 0.92, 1); // stem head
{
  const start = new V3(0, bowTip.y - 0.4, bowTip.z + 3.2);
  const dir = new V3(0, Math.sin(0.33), -Math.cos(0.33));
  const end = start.clone().addScaledVector(dir, 10.5);
  spars.add([start, end], (s) => 0.32 * (1 - 0.45 * s), 12, 0.5);
  const jbStart = end.clone().addScaledVector(dir, -2.2).add(new V3(0, 0.25, 0));
  const jbEnd = end.clone().addScaledVector(dir, 6.2).add(new V3(0, 0.3, 0));
  spars.add([jbStart, jbEnd], (s) => 0.16 * (1 - 0.4 * s), 8, 0.5);
  // spritsail yard
  spars.line(new V3(-4.2, end.y - 1.2, end.z + 1.5), new V3(4.2, end.y - 1.2, end.z + 1.5), 0.1, 6, 6);
  // bobstay & bowsprit shrouds
  ropes.line(end.clone().addScaledVector(dir, -0.3), hullPt(1, 0.35, 1), 0.05, 5);
  for (const s of [-1, 1]) ropes.line(end.clone().addScaledVector(dir, -1.0), hullPt(0.95, 0.75, s), 0.04, 4);
  // martingale
  const dolph = end.clone().add(new V3(0, -1.8, 0.3));
  spars.line(end.clone().add(new V3(0, -0.1, 0)), dolph, 0.06, 5);
  ropes.line(jbEnd, dolph, 0.03, 4);
  ropes.line(dolph, hullPt(0.97, 0.6, 1), 0.035, 4);

  const fm = MASTS[0];
  const foreTop = new V3(0, fm.y0 + fm.h * 0.56 + 0.4, fm.z - 0.1);
  const foreTopmast = new V3(0, fm.y0 + fm.h * 0.82 + 0.5, fm.z);
  ropes.line(foreTop, end.clone().addScaledVector(dir, -0.5), 0.06, 5);
  ropes.line(foreTopmast, jbEnd.clone().addScaledVector(dir, -0.4), 0.045, 5);
  ropes.line(new V3(0, fm.y0 + fm.h - 0.5, fm.z), jbEnd, 0.035, 4);
  // jibs
  const jibs = [
    [foreTopmast.clone().lerp(jbEnd, 0.12), jbEnd.clone().addScaledVector(dir, -0.6), new V3(-0.4, foreTop.y - 3.5, fm.z - 6.0)],
    [foreTop.clone().lerp(end, 0.18), end.clone().addScaledVector(dir, -1.0), new V3(-0.3, fm.y0 + 3.5, fm.z - 3.0)],
  ];
  for (const [head, tack, clew] of jibs) {
    const sd = new V3(-1, 0, 0);
    new Sail(10, 10, (u, v) => {
      // u along luff (head->tack), v toward clew
      const luff = new V3().lerpVectors(head, tack, u);
      const leech = new V3().lerpVectors(head, clew, u);
      const p = new V3().lerpVectors(luff, leech, v);
      const a = 1.25 * Math.sin(Math.PI * v) * Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.85 + 0.08)), 0.7) * (0.3 + 0.7 * u);
      return { p, d: sd, a };
    });
    ropes.rope(clew, hullAtY(0.8, sheer(0.8), -1), 0.2, 0.025, 6, 4);
  }
  // spritsail
  const ss = new V3(-4.0, end.y - 1.3, end.z + 1.4), se = new V3(4.0, end.y - 1.3, end.z + 1.4);
  squareSail(ss, se, new V3(-4.2, end.y - 4.3, end.z + 0.6), new V3(4.2, end.y - 4.3, end.z + 0.6), 0.9, new V3(0, -0.15, -1).normalize());
}

// shrouds, ratlines, stays, backstays
MASTS.forEach((ms, mi) => {
  const z = ms.z, y0 = ms.y0, H = ms.h;
  const lowTop = y0 + H * 0.56;
  const topY = y0 + H * 0.82;
  for (const side of [-1, 1]) {
    const shroudPts = [];
    const offs = mi === 2 ? [-0.3, 0.45, 1.2] : [-0.7, 0.05, 0.8, 1.55];
    for (const dz of offs) {
      const t = clamp(ms.t - dz / L, 0, 1);
      const chain = hullAtY(t, sheer(t) - 0.35, side, 0.55);
      const head = new V3(side * ms.r * 1.1, lowTop - 0.15, z + 0.1);
      ropes.line(chain, head, 0.045, 5);
      shroudPts.push([chain, head]);
      // deadeyes and chain plates
      const de = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), M.darkWood);
      de.scale.set(0.5, 1, 1); de.position.copy(chain); shipTilt.add(de);
      ironB.line(chain, hullAtY(t, sheer(t) - 1.6, side, 0.05), 0.03, 4);
    }
    // channel (plank outside hull)
    {
      const tA = clamp(ms.t + 1.2 / L, 0, 1), tB = clamp(ms.t - 1.9 / L, 0, 1);
      const pa = hullAtY(tA, sheer(tA) - 0.4, side, 0.3), pb = hullAtY(tB, sheer(tB) - 0.4, side, 0.3);
      spars.line(pa, pb, 0.1, 4);
    }
    // ratlines
    const n = Math.floor((lowTop - y0 - 1.8) / 0.48);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const pts = shroudPts.map(([a, b]) => new V3().lerpVectors(a, b, f));
      if (pts[0].distanceTo(pts[pts.length - 1]) < 0.2) continue;
      ropesL.add(pts, 0.018, 3);
    }
    // topmast shrouds
    const tOffs = [-0.3, 0.3, 0.9];
    const tsh = [];
    for (const dz of tOffs) {
      const a = new V3(side * ms.r * 4.6, lowTop + 0.1, z + 0.15 + dz);
      const b = new V3(side * ms.r * 0.7, topY - 0.1, z + 0.08);
      ropes.line(a, b, 0.03, 4);
      tsh.push([a, b]);
    }
    for (let k = 1; k < 9; k++) { const f = k / 9; ropesL.add(tsh.map(([a, b]) => new V3().lerpVectors(a, b, f)), 0.014, 3); }
    // futtock shrouds
    ropes.line(new V3(side * ms.r * 4.6, lowTop + 0.1, z + 0.4), new V3(side * ms.r * 1.05, lowTop - 2.2, z + 0.1), 0.03, 4);
    // backstays from topmast head / topgallant head
    for (const [hy, dz] of [[topY + 0.2, 3.2], [y0 + H - 0.4, 4.3]]) {
      const t = clamp(ms.t - dz / L, 0, 1);
      ropes.line(new V3(side * 0.12, hy, z + 0.08), hullAtY(t, sheer(t) - 0.35, side, 0.5), 0.035, 4);
    }
  }
  // stays forward
  if (mi > 0) {
    const fwdMast = MASTS[mi - 1];
    ropes.line(new V3(0, lowTop + 0.3, z - 0.1), new V3(0, fwdMast.y0 + 1.0, fwdMast.z + 0.3), 0.07, 5);
    ropes.line(new V3(0, topY + 0.4, z), new V3(0, fwdMast.y0 + fwdMast.h * 0.56 + 0.5, fwdMast.z + 0.2), 0.045, 4);
    ropes.line(new V3(0, y0 + H - 0.4, z), new V3(0, fwdMast.y0 + fwdMast.h * 0.82 + 0.2, fwdMast.z + 0.1), 0.03, 4);
  }
  // braces: yard ends to the next mast aft (or hull)
  yardEnds[mi].forEach((e, yi) => {
    for (const [p, side] of [[e.L, -1], [e.R, 1]]) {
      let target;
      if (mi < 2) { const am = MASTS[mi + 1]; target = new V3(side * 0.4, am.y0 + am.h * (0.3 + 0.18 * yi), am.z); }
      else { target = hullAtY(0.02, sheer(0.02) - 0.1, side); }
      ropes.rope(p, target, 0.25 + yi * 0.1, 0.022, 8, 3);
    }
  });
});
// rope coils & pin rails
const ropeCoilGeo = new THREE.TorusGeometry(0.32, 0.06, 6, 16);
{
  for (const side of [-1, 1]) {
    for (const t of [0.36, 0.44, 0.58, 0.7]) {
      const p = hullAtY(t, DECK_MAIN, side); p.x -= side * 0.55; p.y = DECK_MAIN + 0.05;
      for (let k = 0; k < 3; k++) { const c = new THREE.Mesh(ropeCoilGeo, M.ropeLight); c.rotation.x = Math.PI / 2; c.position.set(p.x, p.y + k * 0.09, p.z); c.scale.setScalar(1 - k * 0.12); shipTilt.add(c); }
    }
    // pin rail
    const pa = hullAtY(0.44, DECK_MAIN + 0.6, side), pb = hullAtY(0.56, DECK_MAIN + 0.6, side);
    pa.x -= side * 0.22; pb.x -= side * 0.22;
    spars.line(pa, pb, 0.06, 5);
    for (let k = 0; k <= 8; k++) { const p = new V3().lerpVectors(pa, pb, k / 8); spars.line(p.clone().add(new V3(0, -0.15, 0)), p.clone().add(new V3(0, 0.25, 0)), 0.025, 4); }
  }
}

// railings on quarterdeck and forecastle fronts
{
  const rail = new TubeBatch();
  const baluster = new THREE.LatheGeometry([[0, 0], [0.06, 0], [0.06, 0.05], [0.035, 0.12], [0.06, 0.32], [0.03, 0.55], [0.04, 0.68], [0.04, 0.75], [0, 0.75]].map(([a, b]) => new THREE.Vector2(a, b)), 8);
  const bals = [];
  const makeRail = (t, y, zOff) => {
    const w = hullAtY(t, y, 1).x - 0.2;
    const zz = zAt(t) + zOff;
    rail.line(new V3(-w, y + 0.8, zz), new V3(w, y + 0.8, zz), 0.07, 6);
    rail.line(new V3(-w, y + 0.04, zz), new V3(w, y + 0.04, zz), 0.06, 6);
    for (let x = -w; x <= w + 0.01; x += 0.3) {
      if (Math.abs(x) < 0.7 && t < 0.5) continue; // gap for stairs
      const b = new THREE.Mesh(baluster, M.wood); b.position.set(x, y + 0.04, zz); bals.push(b);
    }
  };
  makeRail(0.25, DECK_QTR, 0.05);
  makeRail(0.86, DECK_FC, -0.05);
  // ladder to quarterdeck
  for (let k = 0; k < 8; k++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.3), M.wood);
    st.position.set(0, DECK_MAIN + 0.25 + k * 0.27, zQtr - 1.6 + k * 0.2);
    shipTilt.add(castAll(st));
  }
  for (const s of [-0.62, 0.62]) rail.line(new V3(s, DECK_MAIN, zQtr - 1.75), new V3(s, DECK_QTR + 0.05, zQtr + 0.05), 0.05, 5);
  const merged = mergeGeometries(bals.map((b) => { b.updateMatrix(); return baluster.clone().applyMatrix4(b.matrix); }));
  shipTilt.add(castAll(new THREE.Mesh(merged, M.wood)));
  shipTilt.add(castAll(new THREE.Mesh(rail.build(), M.darkWood)));
}

// ---------------------------------------------------------------- deck furniture
function lathe(points, seg, mat) { return new THREE.Mesh(new THREE.LatheGeometry(points.map(([a, b]) => new THREE.Vector2(a, b)), seg), mat); }
{
  // wheel
  const wheelG = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 8, 32), M.wood); wheelG.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 12), M.gold); hub.rotation.x = Math.PI / 2; wheelG.add(hub);
  const sp = new TubeBatch();
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * Math.PI * 2;
    sp.add([new V3(0, 0, 0), new V3(Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0), new V3(Math.cos(a) * 0.86, Math.sin(a) * 0.86, 0)], (s) => 0.03 * (1.2 - s * 0.4), 5);
  }
  wheelG.add(new THREE.Mesh(sp.build(), M.wood));
  wheelG.position.set(0, DECK_QTR + 1.15, zAt(0.205));
  shipTilt.add(castAll(wheelG));
  for (const s of [-0.18, 0.18]) {
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.15, 0.5), M.darkWood);
    ped.position.set(0, DECK_QTR + 0.57, zAt(0.205) + s * 1.8 + (s > 0 ? -0.15 : 0.15)); shipTilt.add(castAll(ped));
  }
  const binn = lathe([[0, 0], [0.28, 0], [0.25, 0.9], [0.3, 1.0], [0.2, 1.2], [0, 1.25]], 12, M.darkWood);
  binn.position.set(0, DECK_QTR, zAt(0.205) - 1.3); shipTilt.add(castAll(binn));
  // capstan
  const cap = lathe([[0, 0], [0.55, 0], [0.5, 0.1], [0.36, 0.25], [0.32, 0.75], [0.48, 0.85], [0.5, 1.0], [0, 1.02]], 16, M.wood);
  cap.position.set(0, DECK_MAIN, zAt(0.4)); shipTilt.add(castAll(cap));
  const bars = new TubeBatch();
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI; bars.line(new V3(Math.cos(a) * -1.5, 0.92, Math.sin(a) * -1.5), new V3(Math.cos(a) * 1.5, 0.92, Math.sin(a) * 1.5), 0.045, 5); }
  const bm = new THREE.Mesh(bars.build(), M.wood); bm.position.copy(cap.position); shipTilt.add(castAll(bm));
  // hatches
  for (const [t, w, l] of [[0.6, 2.2, 2.6], [0.69, 1.6, 1.5], [0.32, 1.6, 1.6]]) {
    const coam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.35, l + 0.3), M.darkWood);
    coam.position.set(0, DECK_MAIN + 0.17, zAt(t)); shipTilt.add(castAll(coam));
    const gr = new THREE.Mesh(new THREE.PlaneGeometry(w, l), M.grating);
    gr.rotation.x = -Math.PI / 2; gr.position.set(0, DECK_MAIN + 0.36, zAt(t)); gr.material.map.repeat.set(1, 1); shipTilt.add(gr);
  }
  // barrels
  const barrelG = new THREE.LatheGeometry([[0, 0], [0.3, 0], [0.37, 0.25], [0.4, 0.45], [0.37, 0.65], [0.3, 0.9], [0, 0.9]].map(([a, b]) => new THREE.Vector2(a, b)), 14);
  const hoopG = new THREE.TorusGeometry(0.385, 0.018, 4, 20);
  const placeBarrel = (x, y, z, lying = false, rot = 0) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(barrelG, M.wood));
    for (const [hy, s] of [[0.12, 0.83], [0.32, 0.99], [0.58, 0.99], [0.78, 0.83]]) { const h = new THREE.Mesh(hoopG, M.iron); h.rotation.x = Math.PI / 2; h.position.y = hy; h.scale.setScalar(s); g.add(h); }
    g.position.set(x, y, z); g.rotation.y = rot;
    if (lying) { g.rotation.z = Math.PI / 2; g.position.y += 0.4; }
    shipTilt.add(castAll(g));
  };
  placeBarrel(-2.1, DECK_MAIN, zAt(0.73)); placeBarrel(-2.45, DECK_MAIN, zAt(0.715)); placeBarrel(-2.0, DECK_MAIN, zAt(0.705)); placeBarrel(-2.3, DECK_MAIN + 0.9, zAt(0.72));
  placeBarrel(2.2, DECK_MAIN, zAt(0.29)); placeBarrel(1.6, DECK_MAIN, zAt(0.285), true, 0.3);
  placeBarrel(-1.8, DECK_QTR, zAt(0.05)); placeBarrel(-1.4, DECK_QTR, zAt(0.07));
  // crates
  const crateG = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  for (const [x, y, z, r] of [[2.0, DECK_MAIN + 0.4, zAt(0.74), 0.1], [2.1, DECK_MAIN + 1.2, zAt(0.745), 0.4], [2.6, DECK_MAIN + 0.4, zAt(0.715), -0.2], [-1.9, DECK_MAIN + 0.4, zAt(0.3), 0.2], [1.6, DECK_QTR + 0.4, zAt(0.06), 0.5]]) {
    const c = new THREE.Mesh(crateG, M.crate); c.position.set(x, y, z); c.rotation.y = r; shipTilt.add(castAll(c));
  }
  // ship's bell
  const bell = lathe([[0, 0.5], [0.12, 0.48], [0.16, 0.3], [0.22, 0.02], [0.24, 0], [0.2, 0], [0, 0.05]], 16, M.gold);
  bell.position.set(0, DECK_FC + 1.2, zAt(0.865) - 0.4); shipTilt.add(bell);
  const belf = new TubeBatch();
  belf.add([new V3(-0.5, DECK_FC, zAt(0.865) - 0.4), new V3(-0.5, DECK_FC + 1.8, zAt(0.865) - 0.4), new V3(0.5, DECK_FC + 1.8, zAt(0.865) - 0.4), new V3(0.5, DECK_FC, zAt(0.865) - 0.4)], 0.06, 6);
  shipTilt.add(castAll(new THREE.Mesh(belf.build(), M.darkWood)));
  // anchors at catheads
  for (const s of [-1, 1]) {
    const t = 0.9;
    const p = hullAtY(t, 2.5, s, 0.35);
    const ag = new THREE.Group();
    const ab = new TubeBatch();
    ab.line(new V3(0, 0, 0), new V3(0, -2.2, 0), 0.07, 6);
    const arc = []; for (let k = 0; k <= 12; k++) { const a = Math.PI * (0.15 + 0.7 * k / 12); arc.push(new V3(Math.cos(a) * 0.9, -2.2 + 0.9 - Math.sin(a) * 0.9 - 0.0, 0)); }
    ab.add(arc, 0.07, 6);
    ab.line(new V3(-0.9, 0.0, 0), new V3(0.9, 0.0, 0), 0.06, 6);
    const am = new THREE.Mesh(ab.build(), M.iron);
    ag.add(am);
    for (const e of [arc[0], arc[arc.length - 1]]) { const fl = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 4), M.iron); fl.position.copy(e); fl.rotation.z = e.x > 0 ? -2.3 : 2.3; ag.add(fl); }
    ag.position.copy(p); ag.position.y += 0.3; ag.rotation.y = s * 1.2; ag.rotation.z = s * 0.25;
    shipTilt.add(castAll(ag));
    const cat = hullAtY(t - 0.01, sheer(t) - 0.2, s, 0.0);
    spars.line(cat, cat.clone().add(new V3(s * 1.1, 0.25, -0.3)), 0.13, 6);
  }
  // figurehead / beak ornaments
  const scroll = new TubeBatch();
  for (const s of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 20; k++) { const t = 0.9 + 0.1 * k / 20; const p = hullAtY(t, 2.75 + 0.6 * k / 20, s, 0.06); pts.push(p); }
    scroll.add(pts, 0.06, 5);
  }
  shipTilt.add(new THREE.Mesh(scroll.build(), M.gold));
}

// lanterns
function makeLantern(scale, light) {
  const g = new THREE.Group();
  const base = lathe([[0, 0], [0.2, 0], [0.22, 0.06], [0.16, 0.12], [0, 0.12]], 8, M.iron);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.42, 8), M.glass); glass.position.y = 0.33;
  const top = lathe([[0, 0.54], [0.2, 0.54], [0.22, 0.58], [0.06, 0.82], [0.04, 0.9], [0.07, 0.95], [0, 1.0]], 8, M.gold);
  g.add(base, glass, top);
  const bars = new TubeBatch();
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; bars.line(new V3(Math.cos(a) * 0.17, 0.1, Math.sin(a) * 0.17), new V3(Math.cos(a) * 0.19, 0.56, Math.sin(a) * 0.19), 0.012, 3); }
  g.add(new THREE.Mesh(bars.build(), M.iron));
  g.scale.setScalar(scale);
  if (light) {
    const pl = new THREE.PointLight(new THREE.Color(1.0, 0.6, 0.28), 6, 14, 1.6);
    pl.position.y = 0.35; g.add(pl); lanternLights.push(pl);
  }
  return g;
}
{
  const sternTop = hullPt(0, 1, 1);
  const ln = [[0, 1.6, 0.3, true], [-2.1, 1.25, 0.35, false], [2.1, 1.25, 0.35, true]];
  for (const [x, sc, dz, li] of ln) {
    const l = makeLantern(sc, li);
    l.position.set(x, sternTop.y + 0.55, sternTop.z + dz);
    shipTilt.add(l);
    const pole = new TubeBatch();
    pole.line(new V3(x, sternTop.y, sternTop.z + dz - 0.2), new V3(x, sternTop.y + 0.56, sternTop.z + dz), 0.05, 5);
    shipTilt.add(new THREE.Mesh(pole.build(), M.iron));
  }
  const ml = makeLantern(0.9, true); ml.position.set(0.55, DECK_MAIN + 3.2, MASTS[1].z + 0.1); shipTilt.add(ml);
  const fl = makeLantern(0.8, false); fl.position.set(0, bowTip.y + 0.3, bowTip.z + 1.0); shipTilt.add(fl);
}

// finalize batches
shipTilt.add(castAll(new THREE.Mesh(spars.build(), M.wood)));
shipTilt.add(castAll(new THREE.Mesh(ropes.build(), M.rope), true, false));
shipTilt.add(castAll(new THREE.Mesh(ropesL.build(), M.rope), true, false));
shipTilt.add(castAll(new THREE.Mesh(ironB.build(), M.iron)));

// flag
const flag = (() => {
  const mm = MASTS[1];
  const top = new V3(0, mm.y0 + mm.h - 0.35, mm.z + 0.08);
  const W = 3.2, Hh = 2.0;
  return new Sail(16, 10, (u, v) => ({ p: new V3(-0.15 * u, top.y - v * Hh, top.z - 0.12 - u * W), d: new V3(1, 0, 0), a: 0 }), M.flag);
})();
flag.update = function (t) {
  const pa = this.geo.getAttribute('position');
  for (let k = 0; k < this.base.length; k++) {
    const i = k % (this.nx + 1), j = Math.floor(k / (this.nx + 1));
    const u = i / this.nx, v = j / this.ny;
    const b = this.base[k];
    const w = Math.sin(u * 6.5 - t * 9.0 + v * 0.8) * 0.32 * u + Math.sin(u * 13 - t * 15) * 0.06 * u;
    const dz = -Math.sin(u * 6.5 - t * 9.0) * 0.08 * u;
    pa.setXYZ(k, b.x - 0.5 * u + w, b.y - 0.25 * u * u + 0.08 * Math.sin(u * 4 - t * 6) * u, b.z + dz);
  }
  pa.needsUpdate = true; this.geo.computeVertexNormals();
};

// ---------------------------------------------------------------- distant islands
const islands = [];
{
  const hash3 = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
  const noise3 = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    let r = 0;
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
      const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
      r += w * hash3(ix + dx, iy + dy, iz + dz);
    }
    return r;
  };
  const fbm = (x, y, z) => { let s = 0, a = 0.5; for (let i = 0; i < 5; i++) { s += a * noise3(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; } return s; };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false });
  const defs = [
    [-520, -900, 260, 95, 1], [640, -1500, 380, 140, 2], [-900, -2100, 420, 120, 3], [420, -650, 160, 55, 4], [-300, -2900, 600, 170, 5], [1100, -2600, 500, 130, 6],
  ];
  for (const [x, z, w, h, s] of defs) {
    const g = new THREE.IcosahedronGeometry(1, 5);
    const p = g.getAttribute('position');
    const cols = [];
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const n = fbm(vx * 1.6 + s * 7, vy * 1.6, vz * 1.6 + s * 3);
      const r = 0.65 + n * 0.75;
      let yy = vy * r;
      yy = yy > 0 ? Math.pow(yy, 1.25) * (1 + 0.6 * noise3(vx * 3 + s, 0, vz * 3)) : yy * 0.2;
      p.setXYZ(i, vx * r, yy, vz * r);
      const hN = clamp(yy, 0, 1);
      const rock = 0.5 + 0.3 * noise3(vx * 8, vy * 8, vz * 8);
      const green = hN > 0.15 ? smooth(0.15, 0.45, hN) * (1 - smooth(0.7, 1.0, hN) * 0.6) : 0;
      cols.push(lerp(0.12 * rock, 0.05, green), lerp(0.1 * rock, 0.09, green), lerp(0.09 * rock, 0.05, green));
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.scale.set(w, h, w * 0.7);
    m.position.set(x, -h * 0.05, z);
    m.rotation.y = s;
    scene.add(m);
    islands.push(m);
  }
}

// ---------------------------------------------------------------- seagulls
const gulls = [];
{
  const bodyG = new THREE.SphereGeometry(0.12, 8, 6); bodyG.scale(1, 0.9, 2.6);
  const wingShape = (s) => {
    const g = new THREE.BufferGeometry();
    const v = [0, 0, -0.12, 0, 0, 0.12, s * 0.55, 0.02, 0.1, s * 0.55, 0.02, -0.14, s * 1.1, 0.0, 0.0, s * 1.1, 0, -0.18];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
    g.computeVertexNormals();
    return g;
  };
  const wm = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
  const bm = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.8 });
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(bodyG, bm));
    const wl = new THREE.Group(), wr = new THREE.Group();
    wl.add(new THREE.Mesh(wingShape(-1), wm)); wr.add(new THREE.Mesh(wingShape(1), wm));
    g.add(wl, wr);
    g.scale.setScalar(1.3);
    scene.add(g);
    gulls.push({ g, wl, wr, r: rr(18, 40), h: rr(22, 36), sp: rr(0.25, 0.45) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, fl: rr(7, 9), off: new V3(rr(-6, 6), 0, rr(-10, 10)) });
  }
}

// ---------------------------------------------------------------- spray particles
const MAXP = 1400;
const pPos = new Float32Array(MAXP * 3), pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pSize = new Float32Array(MAXP);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(MAXP), 1));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
const pMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 600 }, uCol: { value: new V3(1.0, 0.82, 0.7) } },
  transparent: true, depthWrite: false,
  vertexShader: /* glsl */`attribute float aLife; attribute float aSize; uniform float uScale; varying float vL;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vL = aLife; gl_PointSize = aSize*uScale/max(-mv.z,0.1)*(0.6+0.6*(1.0-aLife)); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: /* glsl */`uniform vec3 uCol; varying float vL;
    void main(){ vec2 c = gl_PointCoord-0.5; float d = length(c); float a = smoothstep(0.5, 0.05, d)*vL*0.7; if(a<0.01) discard; gl_FragColor = vec4(uCol*1.25, a); }`,
});
const spray = new THREE.Points(pGeo, pMat);
spray.frustumCulled = false;
scene.add(spray);
let pNext = 0;
function emit(pos, vel, life, size) {
  const i = pNext; pNext = (pNext + 1) % MAXP;
  pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y; pPos[i * 3 + 2] = pos.z;
  pVel[i * 3] = vel.x; pVel[i * 3 + 1] = vel.y; pVel[i * 3 + 2] = vel.z;
  pLife[i] = life; pMax[i] = life; pSize[i] = size;
}

// ---------------------------------------------------------------- post-processing
const rtSize = new THREE.Vector2();
renderer.getDrawingBufferSize(rtSize);
const composerRT = new THREE.WebGLRenderTarget(rtSize.x, rtSize.y, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerRT);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(rtSize.x / 2, rtSize.y / 2), 0.3, 0.5, 1.4);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const gradePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(rtSize.x, rtSize.y) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec2 q = vUv - 0.5;
      float ca = dot(q,q)*0.0025;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + q*ca*2.0).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - q*ca*2.0).b;
      float l = dot(c, vec3(0.299,0.587,0.114));
      c = mix(c, c*vec3(0.88,0.96,1.10), (1.0-smoothstep(0.0,0.5,l))*0.45);
      c = mix(c, c*vec3(1.06,1.0,0.90), smoothstep(0.4,1.0,l)*0.35);
      c = mix(vec3(l), c, 1.1);
      c = (c-0.5)*1.04+0.5;
      float v = smoothstep(1.05, 0.25, length(q*vec2(uRes.x/uRes.y, 1.0)*0.95));
      c *= mix(0.55, 1.0, v);
      c += (h(vUv*uRes + fract(uTime*7.3)*100.0)-0.5)*0.022;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(gradePass);

// ---------------------------------------------------------------- camera director
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 26;
controls.maxDistance = 220;
controls.maxPolarAngle = Math.PI * 0.53;
controls.minPolarAngle = 0.22;
controls.enablePan = false;
controls.enabled = true;
let userActive = false, lastInput = -1e9, blend = 1;
const blendFrom = { pos: new V3(), tgt: new V3() };
controls.addEventListener('start', () => { userActive = true; lastInput = clockTime; });
controls.addEventListener('change', () => { if (userActive) lastInput = clockTime; });
controls.addEventListener('end', () => { lastInput = clockTime; });
renderer.domElement.addEventListener('wheel', () => { userActive = true; lastInput = clockTime; }, { passive: true });

const SHOTS = [
  // [camera offset (ship local, yaw only), look offset]
  [[-44, 8, 20], [0, 9, -1]],
  [[-48, 4.5, -16], [0, 10, 0]],
  [[-20, 3.2, -50], [0, 8.5, -4]],
  [[16, 6.5, -50], [0, 9, 0]],
  [[47, 12, -8], [0, 10, 2]],
  [[36, 24, 40], [0, 6, 4]],
  [[4, 11, 62], [0, 8, 0]],
  [[-30, 5, 46], [0, 9, 0]],
];
const camCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new V3(...s[0])), true, 'centripetal');
const lookCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new V3(...s[1])), true, 'centripetal');
const CYCLE = 84;

// ---------------------------------------------------------------- simulation state
const shipState = { pos: new V3(0, 0, 0), yaw: 0, speed: 7.2, heave: 0, pitch: 0, roll: 0, vHeave: 0, vPitch: 0, vRoll: 0 };
let clockTime = 0;
const prevShipPos = new V3();
const tmpV = new V3(), tmpV2 = new V3();

function shipToWorldYaw(local, out) {
  const c = Math.cos(shipState.yaw), s = Math.sin(shipState.yaw);
  out.set(local.x * c + local.z * s, local.y, -local.x * s + local.z * c).add(shipState.pos);
  return out;
}

function updateShip(dt, t) {
  shipState.yaw = 0.035 * Math.sin(t * 0.11) + 0.02 * Math.sin(t * 0.23 + 1.0);
  const fwd = tmpV.set(-Math.sin(shipState.yaw), 0, -Math.cos(shipState.yaw));
  shipState.speed = 7.2 + 0.5 * Math.sin(t * 0.17);
  shipState.pos.addScaledVector(fwd, shipState.speed * dt);
  // sample water
  const sample = (lx, lz) => { shipToWorldYaw(tmpV2.set(lx, 0, lz), tmpV2); return waterHeight(tmpV2.x, tmpV2.z, t); };
  const hb = sample(0, -10.5), hs = sample(0, 10.5), hp = sample(-3.2, 0), hsb = sample(3.2, 0), hc = sample(0, 0);
  const tHeave = (hb + hs + hp + hsb + hc * 2) / 6 + 0.05;
  const tPitch = Math.atan2(hb - hs, 21) * 0.85;
  const tRoll = Math.atan2(hsb - hp, 6.4) * 0.55 + 0.045 + 0.015 * Math.sin(t * 0.7);
  const spring = (cur, vel, target, k, d) => { const a = (target - cur) * k - vel * d; vel += a * dt; cur += vel * dt; return [cur, vel]; };
  [shipState.heave, shipState.vHeave] = spring(shipState.heave, shipState.vHeave, tHeave, 14, 5.5);
  [shipState.pitch, shipState.vPitch] = spring(shipState.pitch, shipState.vPitch, tPitch, 10, 4.2);
  [shipState.roll, shipState.vRoll] = spring(shipState.roll, shipState.vRoll, tRoll, 7, 2.6);
  ship.position.copy(shipState.pos);
  ship.rotation.y = shipState.yaw;
  shipTilt.position.y = shipState.heave;
  shipTilt.rotation.set(shipState.pitch, 0, shipState.roll);
  oceanUniforms.uShipPos.value.set(shipState.pos.x, shipState.pos.z);
  oceanUniforms.uShipFwd.value.set(fwd.x, fwd.z);
}

const _e = new V3(), _ev = new V3();
let emitAcc = 0;
function updateSpray(dt, t) {
  shipTilt.updateMatrixWorld(true);
  const fwd = new V3(-Math.sin(shipState.yaw), 0, -Math.cos(shipState.yaw));
  const rate = 160 + 900 * clamp(-shipState.vPitch * 6 + (-shipState.vHeave) * 1.5, 0, 1.2);
  emitAcc += rate * dt;
  while (emitAcc > 1) {
    emitAcc -= 1;
    const side = rnd() < 0.5 ? -1 : 1;
    const along = rr(-12.6, -8.0);
    const t0 = clamp((HALF - along) / L, 0, 1);
    const hw = halfBeam(t0) * 0.88;
    _e.set(side * (hw + 0.15), rr(-0.1, 0.4), along).applyMatrix4(shipTilt.matrixWorld);
    const right = new V3(Math.cos(shipState.yaw), 0, -Math.sin(shipState.yaw)).multiplyScalar(side);
    _ev.copy(fwd).multiplyScalar(shipState.speed * rr(0.55, 0.9)).addScaledVector(right, rr(1.5, 4.5)).add(new V3(0, rr(1.5, 5.0), 0));
    emit(_e, _ev, rr(0.7, 1.5), rr(0.4, 1.1));
  }
  // stern churn mist
  if (rnd() < dt * 40) {
    _e.set(rr(-2, 2), 0.2, HALF + rr(0, 3)).applyMatrix4(shipTilt.matrixWorld);
    _ev.copy(fwd).multiplyScalar(shipState.speed * 0.3).add(new V3(rr(-1, 1), rr(0.5, 1.5), rr(-1, 1)));
    emit(_e, _ev, rr(0.8, 1.6), rr(0.6, 1.4));
  }
  const lifeA = pGeo.getAttribute('aLife');
  for (let i = 0; i < MAXP; i++) {
    if (pLife[i] <= 0) { lifeA.array[i] = 0; continue; }
    pLife[i] -= dt;
    pVel[i * 3 + 1] -= 9.81 * dt;
    const drag = Math.exp(-1.2 * dt);
    pVel[i * 3] *= drag; pVel[i * 3 + 2] *= drag;
    pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    if (pPos[i * 3 + 1] < -0.8) pLife[i] = 0;
    lifeA.array[i] = Math.max(0, pLife[i] / pMax[i]);
  }
  lifeA.needsUpdate = true;
  pGeo.getAttribute('position').needsUpdate = true;
}

function updateCamera(dt, t) {
  const delta = tmpV.subVectors(shipState.pos, prevShipPos);
  const idle = clockTime - lastInput;
  // cinematic pose
  const u = (t / CYCLE) % 1;
  const lo = camCurve.getPoint(u), lk = lookCurve.getPoint(u);
  lo.x += Math.sin(t * 0.53) * 0.8; lo.y += Math.sin(t * 0.71) * 0.5 + shipState.heave * 0.4;
  lk.y += Math.sin(t * 0.37) * 0.4;
  const cinePos = shipToWorldYaw(lo, new V3());
  const cineTgt = shipToWorldYaw(lk, new V3());
  cineTgt.y += shipState.heave * 0.6;

  if (userActive) {
    camera.position.add(delta);
    controls.target.copy(shipState.pos).add(new V3(0, 9 + shipState.heave * 0.5, 0));
    controls.update();
    if (idle > 7) { userActive = false; blend = 0; blendFrom.pos.copy(camera.position).sub(shipState.pos); blendFrom.tgt.copy(controls.target).sub(shipState.pos); }
  } else {
    if (blend < 1) {
      blend = Math.min(1, blend + dt / 3.0);
      const e = blend * blend * (3 - 2 * blend);
      camera.position.copy(blendFrom.pos).add(shipState.pos).lerp(cinePos, e);
      controls.target.copy(blendFrom.tgt).add(shipState.pos).lerp(cineTgt, e);
    } else {
      camera.position.copy(cinePos);
      controls.target.copy(cineTgt);
    }
    camera.lookAt(controls.target);
  }
  // keep camera above the waves
  const wh = waterHeight(camera.position.x, camera.position.z, t);
  if (camera.position.y < wh + 1.6) camera.position.y = wh + 1.6;
  if (!userActive) camera.lookAt(controls.target);
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let started = false;
const startTime = performance.now();
const urlT = parseFloat(new URLSearchParams(location.search).get('t') || '0');
let simTime = urlT;
// warm up so the scene starts in motion
for (let i = 0; i < 30; i++) { updateShip(1 / 30, simTime + i / 30); }
simTime += 1; clockTime = simTime;
prevShipPos.copy(shipState.pos);

const CAPTURE = new URLSearchParams(location.search).has('capture');
function frame() {
  step(Math.min(clock.getDelta(), 1 / 20));
  requestAnimationFrame(frame);
}
function step(dt) {
  simTime += dt; clockTime = simTime;
  const t = simTime;
  prevShipPos.copy(shipState.pos);
  updateShip(dt, t);
  for (const s of sails) s.update(t);
  updateSpray(dt, t);
  updateCamera(dt, t);

  // gulls
  for (const gl of gulls) {
    const a = t * gl.sp + gl.ph;
    const c = shipState.pos;
    gl.g.position.set(c.x + Math.cos(a) * gl.r + gl.off.x, gl.h + Math.sin(t * 0.6 + gl.ph) * 2.0, c.z + Math.sin(a) * gl.r + gl.off.z);
    const dir = new V3(-Math.sin(a) * gl.sp, 0, Math.cos(a) * gl.sp).normalize();
    dir.addScaledVector(new V3(-Math.sin(shipState.yaw), 0, -Math.cos(shipState.yaw)), shipState.speed / Math.max(2, Math.abs(gl.sp) * gl.r));
    gl.g.lookAt(gl.g.position.clone().add(dir));
    gl.g.rotation.z += (gl.sp > 0 ? -0.35 : 0.35);
    const flap = Math.sin(t * gl.fl + gl.ph);
    const glide = smooth(-0.2, 0.6, Math.sin(t * 0.4 + gl.ph));
    const ang = lerp(flap * 0.6, 0.08, glide);
    gl.wl.rotation.z = -ang; gl.wr.rotation.z = ang;
  }

  // islands recycle
  for (const isl of islands) {
    const rel = isl.position.z - shipState.pos.z;
    if (rel > 1500) isl.position.z -= 4200;
  }

  // ocean & sky follow camera
  ocean.position.set(camera.position.x, 0, camera.position.z);
  sky.position.copy(camera.position);
  oceanUniforms.uTime.value = t;
  skyUniforms.uTime.value = t;
  gradePass.uniforms.uTime.value = t;

  // sun shadow follows ship
  sunLight.target.position.copy(shipState.pos).add(new V3(0, 8, 0));
  sunLight.position.copy(sunLight.target.position).addScaledVector(SUN_DIR, 90);
  sunViewDir.value.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);

  // lantern flicker
  lanternLights.forEach((l, i) => { l.intensity = 5.5 + Math.sin(t * 13 + i * 2) * 0.6 + Math.sin(t * 29 + i) * 0.4; });
  M.glass.emissiveIntensity = 8.5 + Math.sin(t * 17) * 0.8;

  camera.updateMatrixWorld();
  sunViewDir.value.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
  composer.render();
  if (!started) { started = true; document.getElementById('veil').style.opacity = '0'; }
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 58 : 40;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  renderer.getDrawingBufferSize(rtSize);
  gradePass.uniforms.uRes.value.set(rtSize.x, rtSize.y);
  pMat.uniforms.uScale.value = rtSize.y / (2 * Math.tan(camera.fov * Math.PI / 360));
}
window.addEventListener('resize', onResize);
onResize();
if (CAPTURE) {
  const veil = document.getElementById('veil'); veil.style.transition = 'none'; veil.style.display = 'none';
  window.__step = (dt) => { step(dt); return simTime; };
} else {
  requestAnimationFrame(frame);
}
window.__scene = { scene, camera, renderer, shipState };
