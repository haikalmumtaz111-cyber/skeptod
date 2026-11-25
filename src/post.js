import * as THREE from 'three';

const VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function rt(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({ type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false }, opts));
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(tri, null); this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.sceneRT = rt(2, 2, { depthBuffer: true, samples: 4 });
    this.mips = [];
    this.levels = 6;
    this.mkMaterials();
  }
  mkMaterials() {
    this.prefilter = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.3 }, uKnee: { value: 0.7 } },
      vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; varying vec2 vUv;
        vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
        void main(){
          vec3 c = s(vec2(0.0)) * 0.25 + (s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0))) * 0.1875;
          if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
          c = min(c, vec3(60.0));
          float br = max(c.r, max(c.g, c.b));
          float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee); rq = rq * rq / (4.0 * uKnee + 1e-4);
          float w = max(rq, br - uThreshold) / max(br, 1e-4);
          gl_FragColor = vec4(c * w, 1.0);
        }`,
    });
    this.down = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
        vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
        void main(){
          vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
          vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0)), f = s(vec2(2.0, 0.0));
          vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
          vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
          vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.up = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } },
      vertexShader: VS, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius; varying vec2 vUv;
        vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
        void main(){
          vec3 col = s(vec2(0.0)) * 4.0 + (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0 + (s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0)));
          gl_FragColor = vec4(col / 16.0, 1.0);
        }`,
    });
    this.hblur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 } },
      vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStep; varying vec2 vUv;
        void main(){
          vec3 acc = vec3(0.0); float ws = 0.0;
          for (int i = -7; i <= 7; i++) { float fi = float(i); float w = exp(-fi * fi / 18.0); acc += texture2D(tSrc, vUv + vec2(fi * uStep * uTexel.x, 0.0)).rgb * w; ws += w; }
          gl_FragColor = vec4(acc / ws, 1.0);
        }`,
    });
    this.final = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tStreak: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() },
        uExposure: { value: 1.0 }, uFade: { value: 0 }, uBloom: { value: 0.42 }, uStreak: { value: 0.3 }, uFlash: { value: 0 },
      },
      vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene, tBloom, tStreak; uniform float uTime, uExposure, uFade, uBloom, uStreak, uFlash; uniform vec2 uRes;
        varying vec2 vUv;
        float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
        vec3 acesFitted(vec3 c){
          const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          c = ACESInputMat * c; c = RRTAndODTFit(c); c = ACESOutputMat * c; return clamp(c, 0.0, 1.0);
        }
        vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
        void main(){
          vec2 uv = vUv; vec2 dc = uv - 0.5;
          float ca = 0.0024 * dot(dc, dc) * 4.0;
          vec3 col;
          col.r = texture2D(tScene, uv - dc * ca).r;
          col.g = texture2D(tScene, uv).g;
          col.b = texture2D(tScene, uv + dc * ca).b;
          #ifdef NANDEBUG
          vec3 raw = texture2D(tScene, uv).rgb;
          if (any(isnan(raw)) || any(isinf(raw))) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
          #endif
          vec3 bloom = texture2D(tBloom, uv).rgb;
          vec3 streak = texture2D(tStreak, uv).rgb;
          col += bloom * uBloom + streak * vec3(0.35, 0.55, 1.0) * uStreak;
          col *= uExposure;
          // pre-tonemap grading: cool shadows, warm-magenta highlights
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(col * vec3(0.92, 1.0, 1.12), col * vec3(1.06, 0.97, 1.02), smoothstep(0.02, 0.6, lum));
          col = acesFitted(col * 1.1);
          col = toSRGB(col);
          // lift blacks slightly toward deep blue
          col = col * 0.965 + vec3(0.006, 0.008, 0.02);
          // subtle S-curve
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
          // saturation boost
          float l2 = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(l2), col, 1.12);
          // vignette
          float vig = 1.0 - smoothstep(0.35, 1.05, length(dc * vec2(1.25, 1.0)) * 1.25);
          col *= mix(0.55, 1.0, vig);
          // grain
          float gr = h12(uv * uRes + fract(uTime * 7.31) * 413.0) - 0.5;
          col += gr * 0.03 * (1.0 - l2 * 0.6);
          col *= uFade;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`,
    });
  }
  setSize(w, h) {
    this.w = w; this.h = h;
    this.sceneRT.setSize(w, h);
    for (const m of this.mips) m.dispose();
    this.mips = [];
    let mw = Math.floor(w / 2), mh = Math.floor(h / 2);
    for (let i = 0; i < this.levels; i++) { this.mips.push(rt(mw, mh)); mw = Math.max(1, Math.floor(mw / 2)); mh = Math.max(1, Math.floor(mh / 2)); }
    if (this.streakA) { this.streakA.dispose(); this.streakB.dispose(); }
    this.streakA = rt(Math.floor(w / 4), Math.floor(h / 8));
    this.streakB = rt(Math.floor(w / 4), Math.floor(h / 8));
    this.final.uniforms.uRes.value.set(w, h);
  }
  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }
  render(time, fade) {
    const r = this.renderer;
    const prevAuto = r.autoClear; r.autoClear = false;
    // bloom chain
    const p = this.prefilter;
    p.uniforms.tSrc.value = this.sceneRT.texture; p.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
    this.pass(p, this.mips[0]);
    for (let i = 1; i < this.levels; i++) {
      const src = this.mips[i - 1];
      this.down.uniforms.tSrc.value = src.texture; this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass(this.down, this.mips[i]);
    }
    for (let i = this.levels - 2; i >= 0; i--) {
      const src = this.mips[i + 1];
      this.up.uniforms.tSrc.value = src.texture; this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass(this.up, this.mips[i]);
    }
    // anamorphic streaks
    this.down.uniforms.tSrc.value = this.mips[1].texture; this.down.uniforms.uTexel.value.set(1 / this.mips[1].width, 1 / this.mips[1].height);
    this.pass(this.down, this.streakA);
    let a = this.streakA, b = this.streakB;
    for (const st of [1, 3, 9]) {
      this.hblur.uniforms.tSrc.value = a.texture; this.hblur.uniforms.uTexel.value.set(1 / a.width, 1 / a.height); this.hblur.uniforms.uStep.value = st;
      this.pass(this.hblur, b); const t = a; a = b; b = t;
    }
    const f = this.final;
    f.uniforms.tScene.value = this.sceneRT.texture; f.uniforms.tBloom.value = this.mips[0].texture; f.uniforms.tStreak.value = a.texture;
    f.uniforms.uTime.value = time; f.uniforms.uFade.value = fade;
    this.pass(f, null);
    r.autoClear = prevAuto;
  }
}
