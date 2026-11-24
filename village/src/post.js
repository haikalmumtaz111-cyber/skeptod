import { Q } from './quality.js';
// Post-processing: planar water reflection, god rays, bloom, cinematic grade.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SUN_DIR, WATER_Y } from './world.js';
import { waterUniforms } from './river.js';

const QUAD_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const RAYS_FS = /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uStrength;
varying vec2 vUv;
void main(){
  vec2 delta = (vUv - uSun);
  float dist = length(delta);
  const int N = 48;
  vec2 stepv = delta / float(N) * 0.92;
  vec2 c = vUv;
  float decay = 1.0;
  vec3 acc = vec3(0.0);
  float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
  c -= stepv * jitter;
  for (int i = 0; i < N; i++) {
    c -= stepv;
    float d = texture2D(tDepth, c).r;
    vec3 s = texture2D(tColor, c).rgb;
    float sky = step(0.99999, d);
    float l = max(max(s.r, s.g), s.b);
    acc += s * sky * smoothstep(1.2, 4.0, l) * decay;
    decay *= 0.955;
  }
  acc /= float(N);
  acc *= uStrength * (1.0 - smoothstep(0.2, 1.2, dist));
  gl_FragColor = vec4(acc, 1.0);
}`;

const FINAL_FS = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tRays; uniform float uTime; uniform vec2 uRes; uniform float uExposure; uniform float uFade;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c){
  const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = ACESIn * c; c = RRTAndODTFit(c); c = ACESOut * c; return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float r2 = dot(dc, dc);
  vec2 ca = dc * r2 * 0.006;
  vec3 col;
  col.r = texture2D(tScene, uv - ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv + ca).b;
  col += texture2D(tRays, uv).rgb;
  col *= uExposure;
  // warm the highlights / cool the shadows slightly before tone mapping
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(vec3(0.94, 0.95, 1.06), vec3(1.05, 1.0, 0.93), smoothstep(0.02, 0.6, lum));
  col = aces(col);
  col = toSRGB(col);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col += vec3(0.018, 0.0, 0.04) * (1.0 - l) * (1.0 - l);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
  col = mix(vec3(l), col, 1.1);
  float vig = 1.0 - 0.42 * pow(clamp(r2 * 1.9, 0.0, 1.0), 1.3);
  col *= vig;
  col += (hash(uv * uRes + fract(uTime * 7.13)) - 0.5) * 0.018;
  col *= uFade;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class Pipeline {
  constructor(renderer, scene, camera) {
    this.r = renderer; this.scene = scene; this.camera = camera;
    this.size = new THREE.Vector2(1, 1);
    const hf = THREE.HalfFloatType;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: hf, samples: Q.low ? 2 : 4, depthTexture: new THREE.DepthTexture(1, 1) });
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;
    this.reflRT = new THREE.WebGLRenderTarget(1, 1, { type: hf, samples: 0 });
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, { type: hf });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.65, 0.92);
    this.raysQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uStrength: { value: 0.9 } },
      vertexShader: QUAD_VS, fragmentShader: RAYS_FS, depthTest: false, depthWrite: false,
    }));
    this.finalQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tRays: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uExposure: { value: 1.0 }, uFade: { value: 0 } },
      vertexShader: QUAD_VS, fragmentShader: FINAL_FS, depthTest: false, depthWrite: false,
    }));
    this.virtual = new THREE.PerspectiveCamera();
    this.reflectEnabled = true;
    this.hideInReflection = [];
  }
  setSize(w, h, pr) {
    const W = Math.floor(w * pr), H = Math.floor(h * pr);
    this.size.set(W, H);
    this.sceneRT.setSize(W, H);
    const rs = Q.low ? 0.35 : 0.5;
    this.reflRT.setSize(Math.floor(W * rs), Math.floor(H * rs));
    this.raysRT.setSize(Math.floor(W * rs), Math.floor(H * rs));
    this.bloom.setSize(W, H);
    this.finalQuad.material.uniforms.uRes.value.set(W, H);
    waterUniforms.uRes.value.set(W, H);
  }
  renderReflection() {
    const cam = this.camera, v = this.virtual, r = this.r;
    const normal = new THREE.Vector3(0, 1, 0);
    const planePos = new THREE.Vector3(0, WATER_Y, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    if (camPos.y < WATER_Y + 0.05) return;
    const view = new THREE.Vector3().subVectors(planePos, camPos);
    view.reflect(normal).negate().add(planePos);
    // keep x/z of camera (plane is infinite): mirror y only
    view.set(camPos.x, 2 * WATER_Y - camPos.y, camPos.z);
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = new THREE.Vector3(look.x, 2 * WATER_Y - look.y, look.z);
    v.position.copy(view);
    v.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    v.lookAt(target);
    v.far = cam.far; v.near = cam.near;
    v.updateMatrixWorld();
    v.projectionMatrix.copy(cam.projectionMatrix);
    v.layers.mask = cam.layers.mask;
    v.layers.disable(2);
    const tm = waterUniforms.uTexMat.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);
    // oblique near plane clipping
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePos.clone().add(new THREE.Vector3(0, -0.05, 0)));
    plane.applyMatrix4(v.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = v.projectionMatrix;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1.0,
      (1.0 + pm.elements[10]) / pm.elements[14]);
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1.0; pm.elements[14] = clip.w;
    for (const o of this.hideInReflection) o.visible = false;
    r.setRenderTarget(this.reflRT);
    r.clear();
    r.render(this.scene, v);
    for (const o of this.hideInReflection) o.visible = true;
    waterUniforms.uRefl.value = this.reflRT.texture;
  }
  render(dt, t, fade) {
    const r = this.r;
    r.shadowMap.needsUpdate = true;
    if (this.reflectEnabled) this.renderReflection();
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(this.scene, this.camera);
    // god rays from the sun position on screen
    const sp = new THREE.Vector3(...SUN_DIR).multiplyScalar(4000).add(this.camera.position).project(this.camera);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const facing = fwd.dot(new THREE.Vector3(...SUN_DIR));
    const ru = this.raysQuad.material.uniforms;
    ru.tColor.value = this.sceneRT.texture; ru.tDepth.value = this.sceneRT.depthTexture;
    ru.uSun.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    ru.uStrength.value = 1.15 * THREE.MathUtils.smoothstep(facing, 0.05, 0.6);
    r.setRenderTarget(this.raysRT);
    this.raysQuad.render(r);
    // bloom (adds into sceneRT)
    this.bloom.render(r, null, this.sceneRT, dt, false);
    const fu = this.finalQuad.material.uniforms;
    fu.tScene.value = this.sceneRT.texture; fu.tRays.value = this.raysRT.texture; fu.uTime.value = t; fu.uFade.value = fade;
    r.setRenderTarget(null);
    this.finalQuad.render(r);
  }
}
