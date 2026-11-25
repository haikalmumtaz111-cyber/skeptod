import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { sstep, clamp, lerp } from './lib.js';
import sClouds from './s1_clouds.js';
import sStation from './s2_station.js';
import sPhone from './s3_phone.js';
import sSiomay from './s4_siomay.js';
import sNight from './s5_night.js';
import sCross from './s6_cross.js';
import sSate from './s7_sate.js';
import sMonas from './s8_monas.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const W = +(params.get('w') || 1920), H = +(params.get('h') || 1080);
const ONLY = params.has('only') ? +params.get('only') : -1;
const DURATION = 30;
// scene cut times
const CUTS = [0, 4.0, 8.0, 11.3, 14.7, 18.6, 22.3, 25.9, 30];
const TR = 0.4;

async function start() {
  try { await document.fonts.load('140px "Great Vibes"'); await document.fonts.load('600 40px Inter'); } catch (e) { /* fall back */ }

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const ctx = { renderer, W, H, envTex };

  const makers = [sClouds, sStation, sPhone, sSiomay, sNight, sCross, sSate, sMonas];
  const shots = makers.map((mk, i) => (ONLY < 0 || ONLY === i ? mk(ctx) : null));

  const mkRT = () => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
  const rtA = mkRT(), rtB = mkRT();

  const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(W, H);
  const mixPass = new ShaderPass({
    uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 0 }, uFlash: { value: 0 } },
    vertexShader: VS,
    fragmentShader: `uniform sampler2D tA,tB; uniform float uMix,uFlash; varying vec2 vUv;
      void main(){ vec4 a = texture2D(tA, vUv); vec4 b = texture2D(tB, vUv); gl_FragColor = vec4(mix(a.rgb, b.rgb, uMix) + uFlash, 1.); }`,
  }, 'none');
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.6, 0.55, 0.85);
  const overCanvas = document.createElement('canvas');
  overCanvas.width = W; overCanvas.height = H;
  const octx = overCanvas.getContext('2d');
  const overTex = new THREE.CanvasTexture(overCanvas);
  overTex.minFilter = THREE.LinearFilter; overTex.generateMipmaps = false;
  const grade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, tOver: { value: overTex }, uExposure: { value: 1 }, uSat: { value: 1.1 }, uContrast: { value: 1.05 },
      uTone: { value: 1 }, uVig: { value: 0.6 }, uTime: { value: 0 }, uFade: { value: 0 }, uRes: { value: new THREE.Vector2(W, H) }, uLift: { value: new THREE.Vector3(0, 0, 0) },
    },
    vertexShader: VS,
    fragmentShader: /* glsl */`
uniform sampler2D tDiffuse, tOver; uniform float uExposure,uSat,uContrast,uTone,uVig,uTime,uFade; uniform vec2 uRes; uniform vec3 uLift; varying vec2 vUv;
vec3 aces(vec3 x){ const float a=2.51,b=.03,c=2.43,d=.59,e=.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.,1.); }
float h12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1./2.4)) - .055, step(.0031308, c)); }
void main(){
  vec2 uv = vUv, cc = uv - .5;
  float ca = 0.004 * dot(cc, cc);
  vec3 col = vec3(texture2D(tDiffuse, uv - cc*ca*2.).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv + cc*ca*2.).b);
  col *= uExposure;
  col = aces(col);
  float l = dot(col, vec3(.2126,.7152,.0722));
  col = mix(vec3(l), col, uSat);
  col += (vec3(-0.012, 0.004, 0.03) * (1. - l) + vec3(0.03, 0.012, -0.02) * l) * uTone;
  col += uLift * (1. - l);
  col = clamp(col, 0., 1.);
  col = toSRGB(col);
  col = (col - .5) * uContrast + .5;
  col *= mix(1., smoothstep(1.05, 0.25, length(cc * vec2(1.25, 1.))), uVig);
  vec4 o = texture2D(tOver, uv);
  col = mix(col, o.rgb, o.a);
  col += (h12(uv * uRes + fract(uTime * 7.31) * 517.) - .5) * 0.03;
  col *= 1. - uFade;
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`,
  });
  composer.addPass(mixPass);
  composer.addPass(bloom);
  composer.addPass(grade);

  // ---------------------------------------------------------- overlay text
  const S = H / 1080;
  function caption(t, a, b, t0, t1) {
    const k = sstep(t0, t0 + 0.6, t) * (1 - sstep(t1 - 0.5, t1, t));
    if (k <= 0) return;
    octx.save();
    octx.globalAlpha = k;
    const x = 96 * S, y = H - 120 * S;
    octx.shadowColor = 'rgba(0,0,0,0.55)'; octx.shadowBlur = 14 * S;
    octx.fillStyle = 'rgba(255,255,255,0.9)';
    octx.fillRect(x, y - 30 * S, 3 * S, 62 * S);
    octx.font = `600 ${30 * S}px Inter, sans-serif`;
    octx.fillStyle = '#fff';
    octx.textBaseline = 'middle';
    octx.fillText(a, x + 20 * S + (1 - k) * 12 * S, y - 12 * S);
    octx.font = `400 ${21 * S}px Inter, sans-serif`;
    octx.fillStyle = 'rgba(255,255,255,0.78)';
    octx.fillText(b, x + 20 * S + (1 - k) * 20 * S, y + 19 * S);
    octx.restore();
  }
  function title(t, t0, t1, sub, y = H * 0.47, size = 190, cx = W / 2) {
    const k = sstep(t1 - 0.6, t1, t);
    if (t < t0 || t > t1) return;
    const reveal = sstep(t0, t0 + 1.4, t);
    octx.save();
    octx.globalAlpha = 1 - k;
    octx.font = `${size * S}px "Great Vibes", cursive`;
    octx.textAlign = 'center'; octx.textBaseline = 'middle';
    const tw = octx.measureText('Jakarta').width;
    octx.beginPath();
    octx.rect(cx - tw / 2 - 40 * S, 0, (tw + 80 * S) * reveal, H);
    octx.clip();
    octx.shadowColor = 'rgba(255,255,255,0.75)'; octx.shadowBlur = 28 * S;
    octx.fillStyle = 'rgba(255,255,255,0.96)';
    octx.fillText('Jakarta', cx, y);
    octx.shadowBlur = 0;
    octx.restore();
    const ks = sstep(t0 + 0.9, t0 + 1.7, t) * (1 - k);
    if (ks > 0 && sub) {
      octx.save();
      octx.globalAlpha = ks * 0.85;
      octx.font = `500 ${22 * S}px Inter, sans-serif`;
      octx.textAlign = 'center';
      octx.fillStyle = '#fff';
      octx.shadowColor = 'rgba(0,0,0,0.5)'; octx.shadowBlur = 10 * S;
      octx.letterSpacing = `${8 * S}px`;
      octx.fillText(sub, cx, y + size * 0.62 * S);
      octx.restore();
    }
  }
  function drawOverlay(t) {
    octx.clearRect(0, 0, W, H);
    title(t, 0.6, 3.95, '25 . 11 . 2026');
    caption(t, 'Stasiun Manggarai', '16.52 WIB', 4.5, 7.8);
    caption(t, 'Siomay gerobak', 'Rp15.000, kuah kacang dipisah', 11.7, 14.5);
    caption(t, 'Sudirman', '18.47 WIB  ·  hujan lagi', 15.1, 18.4);
    caption(t, 'Sate Madura', '21.10 WIB', 22.7, 25.6);
    caption(t, 'Monas', 'besok pagi, 06.12 WIB', 26.3, 27.6);
    title(t, 27.5, 30.5, 'sampai ketemu lagi', H * 0.36, 160, W * 0.27);
    overTex.needsUpdate = true;
  }

  // ---------------------------------------------------------- timeline
  function weights(t) {
    const n = CUTS.length - 1, w = [];
    for (let j = 0; j < n; j++) {
      const up = j === 0 ? 1 : sstep(CUTS[j] - TR / 2, CUTS[j] + TR / 2, t);
      const dn = j === n - 1 ? 1 : 1 - sstep(CUTS[j + 1] - TR / 2, CUTS[j + 1] + TR / 2, t);
      w.push(Math.max(0, Math.min(up, dn)));
    }
    return w;
  }
  const g0 = { exposure: 1, bloom: 0.6, threshold: 0.85, radius: 0.55, sat: 1.1, contrast: 1.05, tone: 1, vig: 0.6, lift: [0, 0, 0] };
  function renderShot(i, t, rt) {
    const s = shots[i];
    const lt = t - CUTS[i] + TR / 2;
    s.update(lt, t);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(s.scene, s.camera);
  }

  function frame(t) {
    let w = weights(t);
    if (ONLY >= 0) { w = w.map((_, i) => (i === ONLY ? 1 : 0)); }
    const act = w.map((v, i) => [v, i]).filter((x) => x[0] > 0.0001 && shots[x[1]]).sort((a, b) => a[1] - b[1]);
    if (!act.length) return;
    const A = act[0], B = act[1];
    renderShot(A[1], t, rtA);
    let mix = 0;
    if (B) { renderShot(B[1], t, rtB); mix = B[0] / (A[0] + B[0]); }
    renderer.setRenderTarget(null);
    mixPass.uniforms.tA.value = rtA.texture;
    mixPass.uniforms.tB.value = B ? rtB.texture : rtA.texture;
    mixPass.uniforms.uMix.value = mix;
    mixPass.uniforms.uFlash.value = B ? Math.sin(mix * Math.PI) * 0.06 : 0;
    // blend grade params
    const ga = { ...g0, ...shots[A[1]].grade }, gb = B ? { ...g0, ...shots[B[1]].grade } : ga;
    const L = (k) => lerp(ga[k], gb[k], mix);
    bloom.strength = L('bloom'); bloom.threshold = L('threshold'); bloom.radius = L('radius');
    const U = grade.uniforms;
    U.uExposure.value = L('exposure'); U.uSat.value = L('sat'); U.uContrast.value = L('contrast'); U.uTone.value = L('tone'); U.uVig.value = L('vig');
    U.uLift.value.set(lerp(ga.lift[0], gb.lift[0], mix), lerp(ga.lift[1], gb.lift[1], mix), lerp(ga.lift[2], gb.lift[2], mix));
    U.uTime.value = t;
    U.uFade.value = Math.max(1 - sstep(0, 0.5, t), sstep(DURATION - 0.7, DURATION, t));
    drawOverlay(t);
    composer.render();
  }

  window.__render = (t) => { frame(t); return true; };
  window.__ready = true;

  if (!CAPTURE) {
    const t0 = performance.now() - (parseFloat(params.get('t') || '0') * 1000);
    const loop = () => { frame(((performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop); };
    loop();
  }
}
start();
