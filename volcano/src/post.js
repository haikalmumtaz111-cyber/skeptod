// HDR render targets, smoke compositing, bloom chain and the final cinematic grade
import * as THREE from 'three';
import { fullscreenVert } from './shaders.js';

const DOWN = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uPrefilter;
varying vec2 vUv;
vec3 s(vec2 o){ return min(texture(uSrc, vUv + o * uTexel).rgb, vec3(80.0)); }
void main(){
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uPrefilter > 0.5) {
    float br = max(col.r, max(col.g, col.b));
    float knee = uThreshold * 0.6;
    float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    rq = rq * rq / (4.0 * knee + 1e-5);
    col *= max(rq, br - uThreshold) / max(br, 1e-5);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;
void main(){
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture(uSrc, vUv - d.xy).rgb;
  s += texture(uSrc, vUv - d.wy).rgb * 2.0;
  s += texture(uSrc, vUv - d.zy).rgb;
  s += texture(uSrc, vUv + d.zw).rgb * 2.0;
  s += texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv + d.xw).rgb * 2.0;
  s += texture(uSrc, vUv + d.zy).rgb;
  s += texture(uSrc, vUv + d.wy).rgb * 2.0;
  s += texture(uSrc, vUv + d.xy).rgb;
  gl_FragColor = vec4(s / 16.0 * uScatter, 1.0);
}
`;

const COMPOSITE = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uSmoke;
varying vec2 vUv;
void main(){
  vec4 s = texture(uSmoke, vUv);
  vec3 c = texture(uScene, vUv).rgb;
  gl_FragColor = vec4(c * (1.0 - s.a) + s.rgb, 1.0);
}
`;

const FINAL = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloomMid;
uniform sampler2D uBloomWide;
uniform sampler2D uNoise;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure;
uniform float uBloomStr;
uniform float uFade;
uniform float uFlash;
uniform vec3 uSun;
uniform float uRays;
varying vec2 vUv;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
vec3 RRTAndODTFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c){
  const mat3 I = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 O = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  return clamp(O * RRTAndODTFit(I * c), 0.0, 1.0);
}
// hybrid Reinhard: near-linear shadows, hue-preserving highlight roll-off
vec3 tonemap(vec3 c){
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float Lt = L * (1.0 + L / 49.0) / (1.0 + L);
  vec3 a = c * (Lt / max(L, 1e-6));
  vec3 b = c * (1.0 + c / 49.0) / (1.0 + c);
  vec3 r = mix(b, a, 0.5);
  float m = max(r.r, max(r.g, r.b));
  if (m > 1.0) r = mix(r / m, vec3(1.0), clamp((m - 1.0) * 0.5, 0.0, 1.0));
  return r;
}
vec3 toSRGB(vec3 c){
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
void main(){
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  // heat shimmer above hot areas
  float hm = dot(texture(uBloomWide, uv - vec2(0.0, 0.03)).rgb, vec3(0.3, 0.5, 0.2));
  hm = clamp(hm * 1.2, 0.0, 1.0);
  vec2 n = vec2(texture(uNoise, uv * vec2(6.0 * aspect, 5.0) + vec2(0.0, -uTime * 0.45)).r,
                texture(uNoise, uv * vec2(5.0 * aspect, 4.2) + vec2(0.37, -uTime * 0.55)).r) - 0.5;
  uv += n * 0.0065 * hm;
  vec2 cc = uv - 0.5;
  float ca = dot(cc, cc) * 0.0045;
  vec3 col;
  col.r = texture(uScene, uv - cc * ca).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv + cc * ca).b;
  col += texture(uBloom, uv).rgb * uBloomStr;
  // radial light shafts from the crater glow
  if (uSun.z > 0.0) {
    vec2 d = (uSun.xy - uv) / 30.0;
    vec2 p = uv + d * hash12(gl_FragCoord.xy + uTime);
    float w = 1.0;
    vec3 gr = vec3(0.0);
    for (int i = 0; i < 30; i++) {
      gr += texture(uBloomMid, p).rgb * w;
      w *= 0.93;
      p += d;
    }
    float fall = 1.0 / (1.0 + dot((uv - uSun.xy) * vec2(aspect, 1.0), (uv - uSun.xy) * vec2(aspect, 1.0)) * 6.0);
    fall *= smoothstep(-0.02, 0.12, uv.y - uSun.y);
    col += gr / 30.0 * uRays * uSun.z * fall * vec3(1.0, 0.75, 0.55);
  }
  col += vec3(0.5, 0.55, 0.7) * uFlash * 0.03;
  col = tonemap(col * uExposure);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col * vec3(0.84, 0.97, 1.2), (1.0 - smoothstep(0.0, 0.12, l)) * 0.35);
  col = mix(col, col * vec3(1.06, 0.98, 0.88), smoothstep(0.2, 0.8, l) * 0.3);
  col = mix(vec3(l), col, 1.08);
  col = toSRGB(clamp(col, 0.0, 1.0));
  // filmic contrast: deeper blacks, gentle shoulder
  col = clamp((col - 0.025) / 0.975, 0.0, 1.0);
  col = col * col * (3.0 - 2.0 * col) * 0.32 + col * 0.68;
  vec2 vq = (vUv - 0.5) * vec2(aspect, 1.0);
  col *= mix(0.5, 1.0, smoothstep(1.2, 0.3, length(vq) * 1.05));
  col += (hash12(vUv * uRes + fract(uTime * 7.13) * 400.0) - 0.5) * 0.022;
  float vis = min(1.0, aspect / 2.0);
  float bar = (1.0 - vis) * 0.5;
  float lb = smoothstep(bar - 0.0015, bar + 0.0015, vUv.y) * smoothstep(bar - 0.0015, bar + 0.0015, 1.0 - vUv.y);
  col *= lb * uFade;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Post {
  constructor(renderer, noiseTex) {
    this.r = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.qs = new THREE.Scene();
    this.qs.add(this.quad);
    const dt = new THREE.DepthTexture(4, 4);
    dt.type = THREE.FloatType;
    const hf = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...hf, depthTexture: dt, depthBuffer: true, stencilBuffer: false, samples: 4 });
    this.smokeRT = new THREE.WebGLRenderTarget(4, 4, { ...hf, depthBuffer: false });
    this.compRT = new THREE.WebGLRenderTarget(4, 4, { ...hf, depthBuffer: false });
    this.levels = 6;
    this.bloom = [];
    for (let i = 0; i < this.levels; i++) this.bloom.push(new THREE.WebGLRenderTarget(4, 4, { ...hf, depthBuffer: false }));

    const mk = (frag, uniforms, blend) => new THREE.ShaderMaterial({
      vertexShader: fullscreenVert, fragmentShader: frag, uniforms,
      depthTest: false, depthWrite: false,
      blending: blend ? THREE.AdditiveBlending : THREE.NoBlending,
      transparent: !!blend,
    });
    this.mComp = mk(COMPOSITE, { uScene: { value: null }, uSmoke: { value: null } });
    this.mDown = mk(DOWN, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.2 }, uPrefilter: { value: 0 } });
    this.mUp = mk(UP, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.85 } }, true);
    this.mFinal = mk(FINAL, {
      uScene: { value: null }, uBloom: { value: null }, uBloomMid: { value: null }, uBloomWide: { value: null },
      uNoise: { value: noiseTex }, uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
      uExposure: { value: 1.1 }, uBloomStr: { value: 0.11 }, uFade: { value: 0 }, uFlash: { value: 0 },
      uSun: { value: new THREE.Vector3() }, uRays: { value: 0.35 },
    });
    this.smokeScale = 0.5;
  }

  setSize(w, h) {
    w = Math.max(4, Math.floor(w)); h = Math.max(4, Math.floor(h));
    this.w = w; this.h = h;
    this.sceneRT.setSize(w, h);
    this.compRT.setSize(w, h);
    this.smokeRT.setSize(Math.max(2, Math.floor(w * this.smokeScale)), Math.max(2, Math.floor(h * this.smokeScale)));
    let bw = w, bh = h;
    for (let i = 0; i < this.levels; i++) {
      bw = Math.max(2, Math.floor(bw / 2)); bh = Math.max(2, Math.floor(bh / 2));
      this.bloom[i].setSize(bw, bh);
    }
    this.mFinal.uniforms.uRes.value.set(w, h);
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.qs, this.cam);
  }

  composite() {
    this.mComp.uniforms.uScene.value = this.sceneRT.texture;
    this.mComp.uniforms.uSmoke.value = this.smokeRT.texture;
    this.pass(this.mComp, this.compRT);
  }

  bloomChain() {
    const d = this.mDown.uniforms;
    let src = this.compRT;
    for (let i = 0; i < this.levels; i++) {
      d.uSrc.value = src.texture;
      d.uTexel.value.set(1 / src.width, 1 / src.height);
      d.uPrefilter.value = i === 0 ? 1 : 0;
      this.pass(this.mDown, this.bloom[i]);
      src = this.bloom[i];
    }
    const u = this.mUp.uniforms;
    for (let i = this.levels - 1; i > 0; i--) {
      const s = this.bloom[i];
      u.uSrc.value = s.texture;
      u.uTexel.value.set(1 / s.width, 1 / s.height);
      this.pass(this.mUp, this.bloom[i - 1]);
    }
  }

  final() {
    const f = this.mFinal.uniforms;
    f.uScene.value = this.compRT.texture;
    f.uBloom.value = this.bloom[0].texture;
    f.uBloomMid.value = this.bloom[1].texture;
    f.uBloomWide.value = this.bloom[3].texture;
    this.pass(this.mFinal, null);
  }
}
