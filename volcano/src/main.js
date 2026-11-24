// Massive volcanic eruption: scene assembly, eruption director and render loop
import * as THREE from 'three';
import {
  V, generateHeights, makeSampler, traceLava, rasterLava, carveLava, buildTextures,
  buildTerrainGeometry, buildNoiseTexture, buildRockTexture, lavaPoints,
} from './terrain.js';
import { terrainVert, terrainFrag, skyVert, skyFrag, bakeFrag, fullscreenVert } from './shaders.js';
import { SmokeSystem, GlowSystem, buildSmokeAtlas, buildEmbers, WIND, windSpeed } from './particles.js';
import { Lightning } from './lightning.js';
import { CinematicCamera } from './camera.js';
import { Post } from './post.js';
import { buildProps } from './props.js';
import { noise2, hash1, mulberry32 } from './noise.js';

const params = new URLSearchParams(location.search);
const START_T = parseFloat(params.get('t') || '0');
const TEST = params.has('test');
const TEST_FRAMES = parseInt(params.get('frames') || '3', 10);
const NO_BOLT = params.has('nobolt');
const FORCE_BOLT = params.has('bolt');
const T_INIT = performance.now();
const rnd = mulberry32(5150);

// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: false });
renderer.autoClear = false;
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;
canvas.style.display = 'block';
canvas.style.width = '100vw';
canvas.style.height = '100vh';
canvas.style.touchAction = 'none';
canvas.style.cursor = 'grab';

const floatLinear = renderer.extensions.has('OES_texture_float_linear');

// eslint-disable-next-line no-undef
const WORKER_SRC = typeof __WORKER_SRC__ !== 'undefined' ? __WORKER_SRC__ : null;

(async () => {
// --- landscape -------------------------------------------------------------
const noiseTex = buildNoiseTexture();
const gen = await generateHeights(WORKER_SRC);
if (TEST) console.log('heights', (performance.now() - T_INIT).toFixed(0) + 'ms');
const rockTex = buildRockTexture(gen.rock);
const hm = gen.hm;
const sample = makeSampler(hm);
const flows = traceLava(sample);
const F = rasterLava(flows);
carveLava(hm, F);
const tex = buildTextures(hm, F, floatLinear);
const lavaPts = lavaPoints(flows, sample, 600, rnd);
const terrainGeo = buildTerrainGeometry(sample, gen.far);
if (TEST) console.log('terrain', (performance.now() - T_INIT).toFixed(0) + 'ms');

// key light (cool twilight / moon)
const MOON_DIR = new THREE.Vector3(0.62, 0.56, -0.46).normalize();

// soft shadow + AO bake on the GPU
const bakeRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.UnsignedByteType, depthBuffer: false });
{
  const m = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: bakeFrag,
    uniforms: { uHeight: { value: tex.heightTex }, uN: { value: V.N }, uHM: { value: V.HM }, uLight: { value: MOON_DIR } },
    depthTest: false, depthWrite: false,
  });
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
  const s = new THREE.Scene(); s.add(q);
  renderer.setRenderTarget(bakeRT);
  renderer.render(s, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(null);
  m.dispose();
}
const smokeAtlas = buildSmokeAtlas(renderer, TEST ? 1024 : 2048);

// --- shared uniforms ---------------------------------------------------------
const U = {
  uTime: { value: 0 },
  uNoise: { value: noiseTex },
  uRock: { value: rockTex },
  uLava: { value: tex.lavaTex },
  uHeat: { value: tex.heatTex },
  uNrmMap: { value: tex.normalTex },
  uBake: { value: bakeRT.texture },
  uHM: { value: V.HM },
  uCamPos: { value: new THREE.Vector3() },
  uFogCol: { value: new THREE.Vector3(0.0095, 0.0118, 0.0175) },
  uFogParams: { value: new THREE.Vector2(0.000042, 1 / 2400) },
  uGlowPos: { value: new THREE.Vector3(0, V.FLOOR_H + 250, 0) },
  uGlowCol: { value: new THREE.Vector3() },
  uGlow2Pos: { value: new THREE.Vector3(0, 5000, 0) },
  uGlow2Col: { value: new THREE.Vector3() },
  uMoonDir: { value: MOON_DIR },
  uMoonCol: { value: new THREE.Vector3(0.12, 0.165, 0.3).multiplyScalar(2.5) },
  uSkyAmb: { value: new THREE.Vector3(0.018, 0.028, 0.055) },
  uGroundAmb: { value: new THREE.Vector3(0.012, 0.008, 0.006) },
  uCraterPos: { value: new THREE.Vector3(0, V.FLOOR_H + 140, 0) },
  uCraterCol: { value: new THREE.Vector3() },
  uPlumePos: { value: new THREE.Vector3(0, V.RIM_H + 900, 0) },
  uPlumeCol: { value: new THREE.Vector3() },
  uBoltPos: { value: new THREE.Vector3(0, 5000, 0) },
  uBoltCol: { value: new THREE.Vector3() },
  uIntensity: { value: 1 },
  uWind: { value: WIND },
  uFlash: { value: 0 },
};
const uResFull = { value: new THREE.Vector2(1, 1) };
const uResSmoke = { value: new THREE.Vector2(1, 1) };
const uNearFar = { value: new THREE.Vector2(4, 160000) };
const uShutter = { value: 1 / 30 };

// --- scenes -------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, uNearFar.value.x, uNearFar.value.y);
const mainScene = new THREE.Scene();
const smokeScene = new THREE.Scene();
const outerScene = new THREE.Scene();

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1000, 48, 24),
  new THREE.ShaderMaterial({ uniforms: U, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthTest: false, depthWrite: false }),
);
sky.renderOrder = -10;
sky.frustumCulled = false;
mainScene.add(sky);

const terrain = new THREE.Mesh(terrainGeo, new THREE.ShaderMaterial({ uniforms: U, vertexShader: terrainVert, fragmentShader: terrainFrag }));
terrain.frustumCulled = false;
mainScene.add(terrain);
mainScene.add(buildProps(sample, F, U));

const post = new Post(renderer, noiseTex);
const glowU = { ...U, uRes: uResFull, uShutter, uNearFar, uDepth: { value: post.sceneRT.depthTexture }, uSmoke: { value: post.smokeRT.texture } };
const smokeU = { ...U, uRes: uResSmoke, uNearFar, uDepth: { value: post.sceneRT.depthTexture }, uAtlas: { value: smokeAtlas } };

const smoke = new SmokeSystem(7200, sample, tex.heatTex.image.data, lavaPts);
smokeScene.add(smoke.makeMesh(smokeU));
const fountain = new GlowSystem(6000, sample, null, true);
mainScene.add(fountain.makeMesh(glowU));
const bombs = new GlowSystem(3500, sample, smoke, false);
outerScene.add(bombs.makeMesh(glowU));
mainScene.add(buildEmbers(glowU, lavaPts, [2600, 0, 0], true));
outerScene.add(buildEmbers(glowU, lavaPts, [0, 4200, 2600], false));

// plume axis (wind-bent centreline) tabulated from the rise model
const axisTab = [];
{
  let drift = 0;
  for (let h = 0; h <= 14000; h += 100) {
    axisTab.push(drift);
    const w = 0.83 * 430 * (1 - 0.8 * Math.min(h / 8300, 1));
    drift += windSpeed(h) * (100 / Math.max(w, 60));
  }
}
const axisOut = { x: 0, z: 0 };
function plumeAxis(h) {
  const f = Math.max(0, Math.min(h / 100, axisTab.length - 1.001));
  const i = Math.floor(f);
  const d = axisTab[i] + (axisTab[i + 1] - axisTab[i]) * (f - i);
  axisOut.x = WIND.x * d; axisOut.z = WIND.z * d;
  return axisOut;
}

const lightning = new Lightning(glowU, (h) => ({ ...plumeAxis(h) }), sample);
if (FORCE_BOLT) lightning.next = START_T - 0.01;
outerScene.add(lightning.mesh);

const mainFlow = flows.find((f) => f.active && f.pts.length > 400) || flows[0];
const cine = new CinematicCamera(camera, sample, mainFlow, canvas);
cine.pathTime = START_T;

// --- eruption director ----------------------------------------------------------
const EXP_P = 10.5;
const explosionAt = (k) => ({ k, t: k * EXP_P + hash1(k * 3 + 1) * EXP_P * 0.55 + 2, s: 0.55 + 0.75 * hash1(k * 7 + 2) });
const E = {
  t: START_T - 50,
  intensity: 1, flash: 0, shake: 0, boltBoost: 0, fountBoost: 0,
  nextK: 0, shakes: [], pdc: [], acc: { plume: 0, fume: 0, fount: 0, bomb: 0, pdc: 0 },
};
E.nextK = Math.ceil((E.t - 2) / EXP_P) - 1;
while (explosionAt(E.nextK).t < E.t) E.nextK++;

function baseIntensity(t) {
  return 0.8 + 0.14 * Math.sin(t * 0.31) * Math.sin(t * 0.117 + 1.3) + 0.12 * noise2(t * 0.35, 1.7);
}

function triggerExplosion(ex, camPos) {
  const s = ex.s;
  const nPlume = Math.floor(35 + 55 * s);
  for (let k = 0; k < nPlume; k++) smoke.emitPlume(E.intensity, 1.35 + 0.5 * rnd());
  // cock's-tail jets: dark ash thrown out sideways
  const nJet = Math.floor(30 + 50 * s);
  for (let k = 0; k < nJet; k++) smoke.emitPlume(E.intensity, 0.9 + 0.6 * rnd(), (180 + 260 * rnd()) * s);
  const nb = Math.floor(80 + 190 * s);
  for (let k = 0; k < nb; k++) bombs.emitBomb(E.intensity, 0.95 + 0.4 * s);
  E.flash = Math.max(E.flash, s);
  E.fountBoost = Math.max(E.fountBoost, s);
  E.boltBoost = Math.max(E.boltBoost, s);
  if (camPos) {
    const d = camPos.length();
    E.shakes.push({ t: E.t + d / 2400, s: s * 1.6 / (1 + d / 7000) });
  }
  // every fourth blast collapses part of the column into a pyroclastic flow,
  // sent down a flank seen obliquely from the current viewpoint
  if (((ex.k % 4) + 4) % 4 === 0) {
    const side = hash1(ex.k * 11 + 5) < 0.5 ? -1 : 1;
    const ang = camPos ? Math.atan2(camPos.z, camPos.x) + side * (0.55 + 0.3 * hash1(ex.k)) : hash1(ex.k * 5) * Math.PI * 2;
    E.pdc.push({ t0: E.t, t1: E.t + 7, ang });
  }
}

function step(dt, camPos) {
  E.t += dt;
  const t = E.t;
  // scheduled explosions
  let ex = explosionAt(E.nextK);
  while (ex.t <= t) { triggerExplosion(ex, camPos); E.nextK++; ex = explosionAt(E.nextK); }
  let pulse = 0;
  for (let k = E.nextK - 3; k < E.nextK; k++) {
    const e = explosionAt(k);
    if (t >= e.t) pulse += e.s * Math.exp(-(t - e.t) * 0.7);
  }
  E.intensity = baseIntensity(t) + 0.6 * pulse;
  E.flash *= Math.exp(-dt * 3.2);
  E.fountBoost *= Math.exp(-dt * 0.9);
  E.boltBoost *= Math.exp(-dt * 0.35);
  E.shake *= Math.exp(-dt * 2.6);
  for (let k = E.shakes.length - 1; k >= 0; k--) {
    if (t >= E.shakes[k].t) { E.shake = Math.max(E.shake, E.shakes[k].s); E.shakes.splice(k, 1); }
  }
  const I = E.intensity;
  const A = E.acc;
  A.plume += dt * 50 * (0.6 + 0.55 * I);
  while (A.plume >= 1) { smoke.emitPlume(I, 1); A.plume--; }
  A.fume += dt * 18;
  while (A.fume >= 1) { smoke.emitFume(); A.fume--; }
  A.fount += dt * 430 * (0.45 + 0.7 * I) * (1 + 1.4 * E.fountBoost);
  while (A.fount >= 1) { fountain.emitFountain(I, 1 + 0.35 * E.fountBoost); A.fount--; }
  A.bomb += dt * 5 * I;
  while (A.bomb >= 1) { bombs.emitBomb(I, 0.8); A.bomb--; }
  for (let k = E.pdc.length - 1; k >= 0; k--) {
    const p = E.pdc[k];
    if (t > p.t1) { E.pdc.splice(k, 1); continue; }
    A.pdc += dt * 60;
    while (A.pdc >= 1) { smoke.emitPDC(p.ang); A.pdc--; }
  }
  smoke.update(dt, t, I);
  fountain.update(dt, t);
  bombs.update(dt, t);
}

// pre-warm so the column is fully developed on the first frame
for (let k = 0; k < 50 * 12; k++) step(1 / 12, null);
if (params.has('pdc')) {
  cine.update(0, E.t, 0, plumeAxis);
  const cp = camera.position;
  E.pdc.push({ t0: E.t - 8, t1: E.t, ang: Math.atan2(cp.z, cp.x) + 0.6 });
  for (let k = 0; k < 9 * 12; k++) step(1 / 12, cp);
}

if (TEST) console.log('init', (performance.now() - T_INIT).toFixed(0) + 'ms', 'smoke', smoke.n, 'fountain', fountain.n, 'bombs', bombs.n);

// --- sizing & adaptive resolution ----------------------------------------------
let dynScale = 1;
const basePR = Math.min(window.devicePixelRatio || 1, 1.25);
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const pr = basePR * dynScale;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  const bw = Math.floor(w * pr), bh = Math.floor(h * pr);
  post.setSize(bw, bh);
  uResFull.value.set(post.w, post.h);
  uResSmoke.value.set(post.smokeRT.width, post.smokeRT.height);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
canvas.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
});
canvas.addEventListener('pointerdown', () => { canvas.style.cursor = 'grabbing'; });
window.addEventListener('pointerup', () => { canvas.style.cursor = 'grab'; });

// --- per-frame lighting ---------------------------------------------------------
const tmpV = new THREE.Vector3();
function updateLights(t) {
  const I = E.intensity;
  const flick = 0.82 + 0.12 * noise2(t * 7.0, 0.3) + 0.08 * noise2(t * 21.0, 4.1);
  const fl = E.flash;
  const k = 9.5 * (0.5 + 0.6 * I) * flick + fl * 40;
  U.uCraterCol.value.set(1.0, 0.36, 0.08).multiplyScalar(k);
  const ax = plumeAxis(900);
  U.uPlumePos.value.set(ax.x, V.RIM_H + 900, ax.z);
  U.uPlumeCol.value.set(1.0, 0.33, 0.075).multiplyScalar(3.4 * (0.5 + 0.6 * I) * (0.9 + 0.1 * flick) + fl * 6);
  U.uGlowCol.value.set(1.0, 0.34, 0.075).multiplyScalar(40 * (0.5 + 0.6 * I) * flick + fl * 80);
  const bl = NO_BOLT ? (lightning.mesh.visible = false, 0) : lightning.update(t, I, E.boltBoost);
  U.uBoltPos.value.copy(lightning.center);
  U.uBoltCol.value.set(0.55, 0.65, 1.0).multiplyScalar(bl * 13);
  U.uGlow2Pos.value.copy(lightning.center);
  U.uGlow2Col.value.set(0.55, 0.65, 1.0).multiplyScalar(bl * 45);
  U.uIntensity.value = I;
  U.uFlash.value = Math.min(1, fl * 0.6 + bl * 0.5);
}

// --- render loop -------------------------------------------------------------------
let last = performance.now();
let frames = 0, slowAcc = 0, fastAcc = 0, fpsT = 0;
const startWall = performance.now();
window.__volcano = { frames: 0, ready: false };

function frame(now) {
  let dt = Math.min((now - last) / 1000, 1 / 20);
  if (TEST) dt = 1 / 30;
  last = now;
  // adaptive resolution
  if (!TEST && frames > 30) {
    const ft = (now - (frame.prev || now));
    if (ft > 24) slowAcc += 1; else slowAcc = Math.max(0, slowAcc - 0.5);
    if (ft < 13) fastAcc += 1; else fastAcc = 0;
    if (slowAcc > 20 && dynScale > 0.55) { dynScale = Math.max(0.55, dynScale - 0.1); slowAcc = 0; resize(); }
    if (fastAcc > 120 && dynScale < 1) { dynScale = Math.min(1, dynScale + 0.1); fastAcc = 0; resize(); }
  }
  frame.prev = now;

  const camPos = camera.position;
  step(dt, camPos);
  const t = E.t;
  cine.update(dt, t, E.shake, plumeAxis);
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  U.uTime.value = t;
  U.uCamPos.value.copy(camera.position);
  updateLights(t);
  sky.position.copy(camera.position);

  smoke.upload(camera);
  fountain.upload();
  bombs.upload();

  // crater position on screen for the light shafts
  tmpV.set(0, V.FLOOR_H + 120, 0).project(camera);
  const onScreen = tmpV.z < 1 && Math.abs(tmpV.x) < 1.6 && Math.abs(tmpV.y) < 1.6;
  const fu = post.mFinal.uniforms;
  fu.uSun.value.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5, onScreen ? 1 : 0);
  fu.uTime.value = t;
  fu.uFlash.value = U.uFlash.value;
  fu.uFade.value = TEST ? 1 : Math.min(1, (now - startWall) / 2500);

  // 1) opaque world + embedded glow
  renderer.setRenderTarget(post.sceneRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(mainScene, camera);
  // 2) smoke at reduced resolution
  renderer.setRenderTarget(post.smokeRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(smokeScene, camera);
  // 3) composite + foreground glow
  post.composite();
  renderer.setRenderTarget(post.compRT);
  renderer.render(outerScene, camera);
  // 4) bloom + grade
  post.bloomChain();
  post.final();

  frames++;
  window.__volcano.frames = frames;
  if (frames >= 2) window.__volcano.ready = true;
  if (TEST) {
    console.log('frame', frames, (performance.now() - now).toFixed(0) + 'ms', 'bolt', lightning.count, lightning.light.toFixed(2), lightning.mesh.visible, lightning.geo.instanceCount, lightning.center.x.toFixed(0), lightning.center.y.toFixed(0), lightning.center.z.toFixed(0));
    if (frames >= TEST_FRAMES) return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
