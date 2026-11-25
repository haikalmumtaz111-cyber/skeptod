import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const V3 = THREE.Vector3;
export const TAU = Math.PI * 2;

export function rng(seed) {
  let s = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t) => t * t * t;

// smooth pseudo-handheld motion, deterministic in t
export function shake(t, amp, seed = 0) {
  return new V3(
    (Math.sin(t * 1.1 + seed) * 0.5 + Math.sin(t * 2.3 + seed * 1.7) * 0.3 + Math.sin(t * 5.7 + seed * 0.3) * 0.2) * amp,
    (Math.sin(t * 1.3 + seed * 2.1) * 0.5 + Math.sin(t * 2.9 + seed * 0.9) * 0.3 + Math.sin(t * 6.3 + seed * 1.3) * 0.2) * amp,
    (Math.sin(t * 0.9 + seed * 3.1) * 0.5 + Math.sin(t * 2.1 + seed * 0.4) * 0.5) * amp * 0.5
  );
}

// ---------------------------------------------------------------- JS noise
function h3(x, y, z) { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (a, b, d) => h3(xi + a, yi + b, zi + d);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
export function fbm3(x, y, z, oct = 3) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2.1; a *= 0.5; } return s / (1 - Math.pow(0.5, oct)); }

// displace a geometry outward along its radial direction with value noise
export function lumpy(geo, amp, freq, seed = 0, center = new V3()) {
  let g = geo.toNonIndexed ? geo : geo;
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new V3(), d = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm3(v.x * freq + seed * 3.7, v.y * freq + seed * 1.3, v.z * freq - seed * 2.1, 3) * 2 - 1;
    d.copy(v).sub(center);
    if (d.lengthSq() < 1e-12) d.set(0, 1, 0);
    d.normalize();
    v.addScaledVector(d, n * amp);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// vertex colours from a noise blend between two colours
export function noiseColors(geo, c1, c2, freq, seed = 0, bias = 0, sharp = 1) {
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  const a = new THREE.Color(c1), b = new THREE.Color(c2), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const n = fbm3(p.getX(i) * freq + seed, p.getY(i) * freq, p.getZ(i) * freq - seed, 3);
    const t = clamp((n - 0.5 + bias) * sharp + 0.5);
    c.copy(a).lerp(b, t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export { mergeGeometries, mergeVertices };

// ---------------------------------------------------------------- textures
export function canvasTex(w, h, draw, { srgb = true, repeat = false, mips = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = mips;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function speckle(ctx, w, h, n, colors, rmin, rmax, seed = 1, alpha = 1) {
  const r = rng(seed);
  ctx.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    const rad = lerp(rmin, rmax, r());
    ctx.beginPath(); ctx.arc(r() * w, r() * h, rad, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

let _dot = null, _bokeh = null;
export function dotTex() {
  if (!_dot) _dot = canvasTex(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, { srgb: false });
  return _dot;
}
export function bokehTex() {
  if (!_bokeh) _bokeh = canvasTex(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 60);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.82, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.93, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, { srgb: false });
  return _bokeh;
}
export function glow(color, intensity, size, tex = dotTex()) {
  const m = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(color).multiplyScalar(intensity), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}
// flat additive glow lying on the ground (wet reflections)
export function groundGlow(color, intensity, w, l) {
  const m = new THREE.MeshBasicMaterial({ map: dotTex(), color: new THREE.Color(color).multiplyScalar(intensity), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, l), m);
  p.rotation.x = -Math.PI / 2;
  return p;
}

export function toonGradient(steps = [0.35, 0.7, 1.0]) {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((s, i) => { const v = Math.round(s * 255); data.set([v, v, v, 255], i * 4); });
  const t = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export function addOutline(mesh, th, color = '#2a1a14') {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + normal * ${th.toFixed(6)};`);
  };
  const o = new THREE.Mesh(mesh.geometry, m);
  mesh.add(o);
  return o;
}

export function capsuleBetween(a, b, r, mat) {
  const d = new V3().subVectors(b, a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 8, 16), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
  return m;
}

// ---------------------------------------------------------------- GLSL
export const NOISE = /* glsl */`
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
 return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<6;i++){s+=a*vnoise(p);p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2);a*=.5;}return s;}
float fbm3o(vec2 p){float s=0.,a=.5;for(int i=0;i<3;i++){s+=a*vnoise(p);p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2);a*=.5;}return s/.875;}
`;

// ---------------------------------------------------------------- sky
export function makeSky(o) {
  const C = (c) => new THREE.Color(c);
  const u = {
    uTop: { value: C(o.top) }, uMid: { value: C(o.mid) }, uHor: { value: C(o.hor) }, uGround: { value: C(o.ground || o.hor) },
    uSunDir: { value: (o.sunDir || new V3(0, 0.3, -1)).clone().normalize() }, uSunCol: { value: C(o.sunCol || '#ffffff') },
    uSunGlow: { value: o.sunGlow ?? 0.5 }, uSunDisk: { value: o.sunDisk ?? 0 },
    uCover: { value: o.cover ?? 0.5 }, uScale: { value: o.cloudScale ?? 1 }, uLit: { value: C(o.cloudLit || '#ffffff') },
    uShade: { value: C(o.cloudShade || '#8899aa') }, uRim: { value: o.rim ?? 0.5 }, uAmt: { value: o.cloudAmt ?? 1 },
    uTime: { value: 0 }, uSpeed: { value: o.speed ?? 0.01 }, uFlash: { value: 0 }, uBright: { value: o.bright ?? 1 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms: u, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: NOISE + /* glsl */`
uniform vec3 uTop,uMid,uHor,uGround,uSunDir,uSunCol,uLit,uShade; uniform float uSunGlow,uSunDisk,uCover,uScale,uRim,uAmt,uTime,uSpeed,uFlash,uBright;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir); float h = d.y;
  vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.2, h));
  col = mix(col, uTop, smoothstep(0.2, 0.8, h));
  col = mix(col, uGround, smoothstep(0.0, -0.06, h));
  float sd = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(sd, 5.) * uSunGlow * 0.35 + pow(sd, 48.) * uSunGlow * 0.8 + smoothstep(0.9994, 0.9997, sd) * uSunDisk);
  if (h > -0.02 && uAmt > 0.) {
    vec2 p = d.xz / (max(h,0.) + 0.09) * uScale + vec2(uTime * uSpeed, uTime * uSpeed * 0.37);
    float n = fbm(p);
    float n2 = fbm(p - uSunDir.xz * 0.35);
    float a = smoothstep(uCover, uCover + 0.05, n) * smoothstep(-0.02, 0.1, h) * uAmt;
    float body = smoothstep(uCover, uCover + 0.32, n);
    float lightSide = clamp(0.55 + (n - n2) * 4.0, 0., 1.);
    vec3 cc = mix(uLit, uShade, body * (1.0 - lightSide * 0.55));
    float rim = 1. - smoothstep(uCover + 0.0, uCover + 0.07, n);
    cc += uSunCol * rim * uRim * (0.35 + pow(sd, 3.) * 2.5);
    cc = mix(cc, uHor, smoothstep(0.12, 0.0, h) * 0.75);
    cc *= 1. + uFlash * 3.;
    col = mix(col, cc, a);
  }
  col *= uBright;
  gl_FragColor = vec4(col, 1.);
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), m);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.userData.update = (t, cam) => { u.uTime.value = t; mesh.position.copy(cam.position); mesh.scale.setScalar(cam.far * 0.92); };
  mesh.userData.u = u;
  return mesh;
}

// ---------------------------------------------------------------- rain
export function makeRain({ count = 6000, box = [40, 30, 40], speed = 25, len = 0.8, color = '#cfe0ff', opacity = 0.35, wind = [0.12, 0.04], additive = false, seed = 7 } = {}) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 6), sd = new Float32Array(count * 8);
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const s = [r(), r(), r(), r()];
    for (let k = 0; k < 2; k++) { sd.set(s, (i * 2 + k) * 4); pos[(i * 2 + k) * 3 + 1] = k; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 4));
  const u = { uTime: { value: 0 }, uSpeed: { value: speed }, uLen: { value: len }, uBox: { value: new V3(...box) }, uCam: { value: new V3() }, uWind: { value: new THREE.Vector2(...wind) }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } };
  const m = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */`
uniform float uTime,uSpeed,uLen; uniform vec3 uBox,uCam; uniform vec2 uWind; attribute vec4 aSeed; varying float vA;
void main(){
  vec3 b = uBox; float sp = uSpeed * (0.8 + aSeed.w * 0.4);
  vec3 p;
  p.x = mod(aSeed.x * b.x - uCam.x, b.x) - b.x * .5 + uCam.x;
  p.z = mod(aSeed.z * b.z - uCam.z, b.z) - b.z * .5 + uCam.z;
  p.y = mod(aSeed.y * b.y - uTime * sp - uCam.y, b.y) - b.y * .5 + uCam.y;
  vec3 dir = normalize(vec3(uWind.x, -1., uWind.y));
  p -= dir * position.y * uLen * (0.6 + aSeed.w * 0.8);
  vA = 1. - position.y * 0.85;
  float dist = length(p - uCam);
  vA *= (1. - smoothstep(b.x * 0.3, b.x * 0.5, dist)) * smoothstep(0.3, 1.5, dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
}`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(uColor, uOpacity * vA); }`,
  });
  const mesh = new THREE.LineSegments(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.userData.update = (t, cam) => { u.uTime.value = t; u.uCam.value.copy(cam.position); };
  mesh.userData.u = u;
  return mesh;
}

// ---------------------------------------------------------------- particles (steam / smoke / sparks)
export function makeParticles(o) {
  const n = o.count, g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), sd = new Float32Array(n * 4), r = rng(o.seed || 3);
  for (let i = 0; i < n * 4; i++) sd[i] = r();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 4));
  const col = o.color instanceof V3 ? o.color : (() => { const c = new THREE.Color(o.color); return new V3(c.r, c.g, c.b).multiplyScalar(o.intensity ?? 1); })();
  const u = {
    uTime: { value: 0 }, uLife: { value: o.life }, uSpread: { value: o.spread }, uVel: { value: o.vel }, uSwirl: { value: o.swirl || 0 },
    uS0: { value: o.size[0] }, uS1: { value: o.size[1] }, uPx: { value: 1000 }, uColor: { value: col }, uOpacity: { value: o.opacity },
    uGrav: { value: o.grav || 0 }, uPuff: { value: o.puff ? 1 : 0 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */`
uniform float uTime,uLife,uSwirl,uS0,uS1,uPx,uGrav; uniform vec3 uSpread,uVel; attribute vec4 aSeed; varying float vA; varying vec4 vS;
void main(){
  float age = fract(uTime / uLife + aSeed.w);
  float tt = age * uLife;
  vec3 p = (aSeed.xyz - .5) * uSpread;
  vec3 v = uVel * (0.7 + aSeed.y * 0.6);
  p += v * tt;
  p.y -= uGrav * tt * tt * 0.5;
  p.x += sin(tt * 2.1 + aSeed.x * 40.) * uSwirl * age + sin(tt * 5.3 + aSeed.z * 17.) * uSwirl * 0.3;
  p.z += cos(tt * 1.7 + aSeed.z * 30.) * uSwirl * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = mix(uS0, uS1, age) * (0.7 + aSeed.x * 0.6) * uPx / max(-mv.z, 0.01);
  vA = smoothstep(0., 0.15, age) * (1. - smoothstep(0.45, 1., age));
  vS = aSeed;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uColor; uniform float uOpacity, uPuff; varying float vA; varying vec4 vS;
void main(){
  vec2 c = gl_PointCoord - .5; float d = length(c);
  float a = 1. - smoothstep(0.0, 0.5, d);
  a = a * a;
  if (uPuff > 0.5) { a *= 0.55 + 0.45 * sin(c.x * 9. + vS.x * 30.) * sin(c.y * 8. + vS.y * 20.); }
  gl_FragColor = vec4(uColor, max(a, 0.) * vA * uOpacity);
}`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.userData.update = (t, cam, H) => { u.uTime.value = t; u.uPx.value = H / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)); };
  pts.userData.u = u;
  return pts;
}

// ---------------------------------------------------------------- buildings
export function windowTex(seed, { cols = 10, rows = 24, lit = 0.4, facade = '#2a2f3a', glass = '#141a26', litA = '#ffd9a1', litB = '#d9ecff', warm = 0.7, day = false, mullion = 0.12 } = {}) {
  const W = 512, H = 1024, r = rng(seed);
  const cells = [];
  for (let j = 0; j < rows; j++) {
    const floorLit = lit * (0.4 + r() * 1.2);
    for (let i = 0; i < cols; i++) cells.push({ i, j, on: r() < floorLit, warm: r() < warm, k: 0.6 + r() * 0.4, g: r() });
  }
  const cw = W / cols, ch = H / rows;
  const draw = (emi) => (c) => {
    c.fillStyle = emi ? '#000' : facade; c.fillRect(0, 0, W, H);
    for (const e of cells) {
      const x = e.i * cw + cw * mullion, y = e.j * ch + ch * 0.16, w = cw * (1 - 2 * mullion), h = ch * 0.66;
      if (e.on) {
        c.fillStyle = e.warm ? litA : litB;
        c.globalAlpha = emi ? e.k : 1;
        c.fillRect(x, y, w, h);
        c.globalAlpha = 1;
      } else if (!emi) {
        if (day) {
          const g = c.createLinearGradient(x, y, x + w, y + h);
          g.addColorStop(0, '#9fc0dd'); g.addColorStop(0.5 + e.g * 0.3, glass); g.addColorStop(1, glass);
          c.fillStyle = g;
        } else c.fillStyle = glass;
        c.fillRect(x, y, w, h);
      }
    }
  };
  const map = canvasTex(W, H, draw(false), { repeat: true });
  const emi = canvasTex(W, H, draw(true), { repeat: true });
  return { map, emi, cols, rows };
}

// box building with uv scaled so windows have consistent real size; returns geometry (base at y=0)
export function buildingGeo(w, h, d, tex, cellW = 3.4, cellH = 3.8, seed = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv, r = rng(seed);
  const ou = Math.floor(r() * tex.cols) / tex.cols, ov = Math.floor(r() * tex.rows) / tex.rows;
  for (let f = 0; f < 6; f++) {
    const fw = f < 2 ? d : w;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 2 || f === 3) { uv.setXY(i, 0.001, 0.001); continue; }
      uv.setXY(i, ou + uv.getX(i) * fw / (cellW * tex.cols), ov + uv.getY(i) * h / (cellH * tex.rows));
    }
  }
  g.translate(0, h / 2, 0);
  return g;
}

// ---------------------------------------------------------------- trees (instanced lumps)
export function makeTrees(list, { seed = 1, leaf = ['#3f7a2f', '#4f8f36', '#2f6527', '#5a9a3a'], trunk = '#5a4334', gradient, lumps = 8, toon = true } = {}) {
  const r = rng(seed);
  const leafGeo = lumpy(new THREE.IcosahedronGeometry(1, 2), 0.18, 1.6, seed);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.9, 1, 7);
  trunkGeo.translate(0, 0.5, 0);
  const lm = toon ? new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: gradient || toonGradient([0.45, 0.75, 1.0]) }) : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
  const tm = new THREE.MeshStandardMaterial({ color: trunk, roughness: 0.9 });
  const leaves = new THREE.InstancedMesh(leafGeo, lm, list.length * lumps);
  const trunks = new THREE.InstancedMesh(trunkGeo, tm, list.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new V3(), P = new V3(), C = new THREE.Color();
  let li = 0;
  list.forEach((t, ti) => {
    const s = t.s, th = t.h ?? s * 1.4;
    M.compose(P.set(t.x, t.y || 0, t.z), Q.identity(), S.set(s * 0.12, th, s * 0.12));
    trunks.setMatrixAt(ti, M);
    for (let k = 0; k < lumps; k++) {
      const a = r() * TAU, rr = r() * s * 0.75;
      P.set(t.x + Math.cos(a) * rr, (t.y || 0) + th + (r() - 0.25) * s * 0.7, t.z + Math.sin(a) * rr);
      const sc = s * (0.45 + r() * 0.35);
      Q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
      M.compose(P, Q, S.set(sc, sc * 0.85, sc));
      leaves.setMatrixAt(li, M);
      C.set(leaf[Math.floor(r() * leaf.length)]);
      leaves.setColorAt(li, C);
      li++;
    }
  });
  leaves.castShadow = true; leaves.receiveShadow = true; trunks.castShadow = true;
  const g = new THREE.Group();
  g.add(leaves, trunks);
  return g;
}

// ---------------------------------------------------------------- grass clump (merged blades, vertex coloured)
export function grassGeo(n, radius, height, seed = 1, base = '#2f5a1f', tip = '#9cc75a') {
  const r = rng(seed), pos = [], col = [];
  const cb = new THREE.Color(base), ct = new THREE.Color(tip), c = new THREE.Color();
  const seg = 4;
  for (let b = 0; b < n; b++) {
    const a = r() * TAU, rr = Math.sqrt(r()) * radius;
    const x0 = Math.cos(a) * rr, z0 = Math.sin(a) * rr;
    const h = height * (0.5 + r() * 0.7), w = 0.005 + r() * 0.007;
    const yaw = r() * TAU, bend = (r() * 0.6 + 0.2) * h;
    const dx = Math.cos(yaw), dz = Math.sin(yaw), px = -dz, pz = dx;
    const pts = [];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg, y = t * h, off = bend * t * t;
      const ww = w * (1 - t * 0.92);
      pts.push([x0 + dx * off - px * ww, y, z0 + dz * off - pz * ww, x0 + dx * off + px * ww, y, z0 + dz * off + pz * ww, t]);
    }
    for (let s = 0; s < seg; s++) {
      const A = pts[s], B = pts[s + 1];
      const quad = [[A[0], A[1], A[2], A[6]], [A[3], A[4], A[5], A[6]], [B[0], B[1], B[2], B[6]], [A[3], A[4], A[5], A[6]], [B[3], B[4], B[5], B[6]], [B[0], B[1], B[2], B[6]]];
      for (const q of quad) { pos.push(q[0], q[1], q[2]); c.copy(cb).lerp(ct, q[3]); col.push(c.r, c.g, c.b); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// wind sway for any standard material (bends by height)
export function addSway(mat, amp = 0.05, freq = 2, hScale = 1) {
  const uT = { value: 0 };
  mat.onBeforeCompile = (s) => {
    s.uniforms.uSwayT = uT;
    s.vertexShader = 'uniform float uSwayT;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      { vec4 wp0 = modelMatrix * vec4(position,1.);
        float k = position.y * ${hScale.toFixed(3)};
        transformed.x += sin(uSwayT*${freq.toFixed(2)} + wp0.x*2.1 + wp0.z*1.3) * ${amp.toFixed(4)} * k * k;
        transformed.z += cos(uSwayT*${(freq * 0.8).toFixed(2)} + wp0.z*1.7) * ${(amp * 0.6).toFixed(4)} * k * k; }`);
  };
  return uT;
}
