import * as THREE from 'three';
import { buildCameraPath } from './layout.js';
import { buildCity } from './city.js';
import { U, makeFacadeMaterial, makeTrimMaterial, makeNeonMaterial, makeScreenMaterial, makeEnvMap } from './materials.js';
import { buildStreet, PlanarReflection } from './street.js';
import { buildSky, Lightning } from './sky.js';
import { buildRain, buildSplashes, buildRainCurtains } from './rain.js';
import { buildLampBeams, Searchlights, buildPoints, buildTrafficStreams, buildSteam } from './fx.js';
import { Traffic } from './vehicles.js';
import { Koi, HoloSculpture } from './holo.js';
import { Post } from './post.js';
import { CameraRig } from './camera.js';
import { LIGHT_POOL_N } from './glsl.js';
import { buildCrowd } from './crowd.js';
import { Blimp } from './blimp.js';

const params = new URLSearchParams(location.search);
const FIXED_RES = params.has('fixed');
const STATIC_CAM = params.has('cam') ? params.get('cam').split(',').map(parseFloat) : null;
const MAXF = params.has('maxf') ? parseInt(params.get('maxf')) : 0;

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x000000, 1);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.25, 6000);
camera.layers.enable(1); camera.layers.enable(2);

// ---------------------------------------------------------------- world
const path = buildCameraPath();
const city = buildCity(path);

const env = makeEnvMap(renderer);
scene.environment = env;
scene.environmentIntensity = 0.45;

const facadeMat = makeFacadeMaterial();
const trimMat = makeTrimMaterial();
const neonMat = makeNeonMaterial();
const screenMat = makeScreenMaterial(false);
const holoMat = makeScreenMaterial(true);
for (const c of city.chunks.values()) {
  const add = (geo, mat, layer = 0, order = 0) => {
    if (geo.empty) return; const m = new THREE.Mesh(geo.build(), mat); m.layers.set(layer); m.renderOrder = order; m.matrixAutoUpdate = false; scene.add(m);
  };
  add(c.facade, facadeMat); add(c.trim, trimMat); add(c.props, trimMat, 2); add(c.neon, neonMat); add(c.screen, screenMat); add(c.holo, holoMat, 0, 5);
}

const street = buildStreet();
scene.add(street.mesh);
const reflection = new PlanarReflection(2, 2);
street.mat.uniforms.tReflect.value = reflection.rt.texture;
street.mat.uniforms.uReflMatrix.value = reflection.textureMatrix;

const sky = buildSky();
scene.add(sky.mesh);
const lightning = new Lightning();
if (params.has('flash')) lightning.next = 0;

const rain = buildRain();
const splashes = buildSplashes();
const curtains = buildRainCurtains();
scene.add(rain, splashes, curtains);

scene.add(buildLampBeams(city.lamps));
const search = new Searchlights(city.searchlights);
search.mesh.layers.set(1);
scene.add(search.mesh);
const points = buildPoints(city.points); scene.add(points);
const streams = buildTrafficStreams(); scene.add(streams);
const steam = buildSteam(city.steam); scene.add(steam);

const traffic = new Traffic(scene);

const lm = city.landmarks.find((l) => l.H > 400) || city.landmarks[0];
const koi = new Koi(new THREE.Vector3(lm.center.x + 4, 0, lm.center.z), 62, 78);
scene.add(koi.group);
const sculpt = new HoloSculpture(new THREE.Vector3(0, 40, -114));
scene.add(sculpt.group);

const blimp = new Blimp();
scene.add(blimp.group);
const crowd = buildCrowd(path);
scene.add(crowd.mesh, crowd.lights);

// debug toggles (no visual UI)
const OFF = new Set((params.get('off') || '').split(',').filter(Boolean));
const reg = { rain, splashes, curtains, search: search.mesh, points, streams, steam, koi: koi.group, sculpt: sculpt.group, crowd: crowd.mesh, crowdl: crowd.lights, street: street.mesh, sky: sky.mesh };
for (const k of OFF) if (reg[k]) reg[k].visible = false;
scene.traverse((o) => {
  if (!o.isMesh) return;
  const m = o.material;
  if (OFF.has('facade') && m === facadeMat) o.visible = false;
  if (OFF.has('trim') && m === trimMat) o.visible = false;
  if (OFF.has('neon') && m === neonMat) o.visible = false;
  if (OFF.has('screen') && m === screenMat) o.visible = false;
  if (OFF.has('holo') && m === holoMat) o.visible = false;
  if (OFF.has('beams') && o.isInstancedMesh && m.uniforms && m.uniforms.uInten) o.visible = false;
});
if (OFF.has('traffic')) traffic.types.forEach((t) => { t.bodyMesh.visible = t.lightMesh.visible = t.beamMesh.visible = false; });

// lights
const hemi = new THREE.HemisphereLight(new THREE.Color(0.24, 0.3, 0.5), new THREE.Color(0.28, 0.12, 0.24), 0.32);
scene.add(hemi);
const moon = new THREE.DirectionalLight(new THREE.Color(0.55, 0.65, 1.0), 0.55);
moon.position.set(-0.45, 1, 0.35); scene.add(moon); scene.add(moon.target);

// ---------------------------------------------------------------- light pool
class LightPool {
  constructor(emitters, n) {
    this.em = emitters; this.slots = [];
    for (let i = 0; i < n; i++) { const l = new THREE.PointLight(0xffffff, 0, 10, 2); scene.add(l); this.slots.push({ l, e: null, f: 0 }); }
    this.top = []; this.scale = 2.2;
  }
  update(cp, dir, dt) {
    const N = this.slots.length; const best = []; // {e, s}
    for (const e of this.em) {
      const dx = e.p.x - cp.x, dy = e.p.y - cp.y, dz = e.p.z - cp.z; const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 260 * 260) continue;
      const d = Math.sqrt(d2); const fw = (dx * dir.x + dy * dir.y + dz * dir.z) / (d + 1e-3);
      const s = e.i * Math.min(e.r, 60) / (d2 + 30) * (1 + 1.2 * Math.max(0, fw));
      if (best.length < N || s > best[best.length - 1].s) {
        best.push({ e, s }); best.sort((a, b) => b.s - a.s); if (best.length > N) best.pop();
      }
    }
    const want = new Set(best.map((b) => b.e));
    for (const sl of this.slots) {
      if (sl.e && !want.has(sl.e)) { sl.f -= dt * 2.5; if (sl.f <= 0) { sl.f = 0; sl.e = null; } }
      else if (sl.e) sl.f = Math.min(1, sl.f + dt * 2.5);
    }
    for (const b of best) {
      if (this.slots.some((sl) => sl.e === b.e)) continue;
      const free = this.slots.find((sl) => !sl.e); if (!free) break;
      free.e = b.e; free.f = 0;
    }
    this.slots.forEach((sl, i) => {
      const pp = U.uPoolPos.value[i], pc = U.uPoolCol.value[i];
      if (!sl.e) { sl.l.intensity = 0; pp.set(0, -1000, 0, 1); pc.set(0, 0, 0); return; }
      const e = sl.e; const k = sl.f * sl.f * (3 - 2 * sl.f);
      sl.l.position.copy(e.p); sl.l.color.copy(e.c); sl.l.intensity = e.i * k * this.scale; sl.l.distance = e.r;
      pp.set(e.p.x, e.p.y, e.p.z, e.r); pc.set(e.c.r, e.c.g, e.c.b).multiplyScalar(e.i * k * this.scale);
    });
  }
}
const pool = new LightPool(city.emitters, LIGHT_POOL_N);

// ---------------------------------------------------------------- camera / post
const rig = new CameraRig(camera, path, canvas, city.obstacles);
rig.pois.push({ get: () => sculpt.group.position, far: 150, near: 70, w: 0.42 });
rig.pois.push({ get: () => koi.fish[0].mesh.position.clone().add(new THREE.Vector3(0, 0, 0)), far: 190, near: 90, w: 0.32 });
if (params.has('s')) rig.s = parseFloat(params.get('s'));

const post = new Post(renderer);
if (params.has('nandebug')) { post.final.defines = { NANDEBUG: 1 }; post.final.needsUpdate = true; }
let pixelRatio = Math.min(devicePixelRatio || 1, 1.25);
if (params.has('pr')) pixelRatio = parseFloat(params.get('pr'));
const maxRatio = Math.min(devicePixelRatio || 1, 1.5);
let reflScale = 0.5;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const bw = Math.floor(w * pixelRatio), bh = Math.floor(h * pixelRatio);
  post.setSize(bw, bh);
  reflection.setSize(Math.max(2, Math.floor(bw * reflScale)), Math.max(2, Math.floor(bh * reflScale)));
}
function setReflScale(k) { if (k === reflScale) return; reflScale = k; const bw = Math.floor(innerWidth * pixelRatio), bh = Math.floor(innerHeight * pixelRatio); reflection.setSize(Math.max(2, Math.floor(bw * k)), Math.max(2, Math.floor(bh * k))); }
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop
let time = params.has('t') ? parseFloat(params.get('t')) : 0;
let last = performance.now();
let fadeIn = params.has('nofade') ? 1 : 0;
const ft = []; let lastAdapt = 0;
const camDir = new THREE.Vector3();
window.__rig = rig;
window.__stats = { frames: 0, avg: 0, pr: pixelRatio, build: performance.now() };

function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (!(dt > 0)) dt = 1 / 60;
  const rdt = dt;
  dt = Math.min(dt, 1 / 20);
  if (params.has('step')) dt = parseFloat(params.get('step'));
  time += dt;
  U.uTime.value = time;
  lightning.update(time, dt, sky.mat);
  rig.update(dt, time);
  if (params.has('follow')) {
    const v = traffic.vehicles[parseInt(params.get('follow'))];
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(new THREE.Matrix4().makeRotationY(v.prevYaw || 0))));
    const side = parseFloat(params.get('side') || '0');
    camera.position.copy(v.pos).addScaledVector(fwd, -9 + side * 9).add(new THREE.Vector3(side * 6, 2.2, 0));
    camera.lookAt(v.pos.clone().add(new THREE.Vector3(0, 0.6, 0)));
  }
  if (STATIC_CAM) { camera.position.set(STATIC_CAM[0], STATIC_CAM[1], STATIC_CAM[2]); camera.rotation.set(STATIC_CAM[4] || 0, STATIC_CAM[3] || 0, 0, 'YXZ'); if (STATIC_CAM[5]) { camera.fov = STATIC_CAM[5]; camera.updateProjectionMatrix(); } }
  camera.updateMatrixWorld();
  camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  pool.update(camera.position, camDir, dt);
  traffic.update(dt, time, camera.position);
  koi.update(time); sculpt.update(time); blimp.update(time);
  search.update(time);
  if (!OFF.has("crowd")) crowd.update(time, camera.position);
  sky.mesh.position.copy(camera.position);
  curtains.position.set(camera.position.x, camera.position.y, camera.position.z);
  const pxScale = (post.h || innerHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  rain.material.uniforms.uCam.value.copy(camera.position);
  rain.material.uniforms.uPx.value = pxScale;
  splashes.material.uniforms.uCam.value.copy(camera.position);
  points.material.uniforms.uPx.value = pxScale; streams.material.uniforms.uPx.value = pxScale;
  hemi.intensity = 0.32 + U.uFlash.value * 1.2;
  moon.intensity = 0.55 + U.uFlash.value * 2.5;

  if (camera.position.y > 42) setReflScale(0.34); else if (camera.position.y < 34) setReflScale(0.5);
  renderer.info.reset();
  reflection.render(renderer, scene, camera);
  renderer.setRenderTarget(post.sceneRT);
  renderer.clear();
  renderer.render(scene, camera);
  fadeIn = Math.min(1, fadeIn + dt / 2.5);
  post.render(time, fadeIn * fadeIn * rig.fade);

  // adaptive resolution
  ft.push(rdt * 1000); if (ft.length > 90) ft.shift();
  window.__stats.frames++; window.__stats.tris = renderer.info.render.triangles; window.__stats.calls = renderer.info.render.calls; window.__stats.avg = ft.reduce((a, b) => a + b, 0) / ft.length; window.__stats.pr = pixelRatio;
  if (!FIXED_RES && now - lastAdapt > 2000 && ft.length >= 60) {
    const avg = window.__stats.avg;
    let np = pixelRatio;
    if (avg > 24 && pixelRatio > 0.6) np = Math.max(0.6, pixelRatio - 0.1);
    else if (avg < 13.5 && pixelRatio < maxRatio) np = Math.min(maxRatio, pixelRatio + 0.05);
    if (np !== pixelRatio) { pixelRatio = np; resize(); ft.length = 0; }
    lastAdapt = now;
  }
  if (MAXF && window.__stats.frames >= MAXF) { window.__stats.done = true; return; }
  requestAnimationFrame(frame);
}
renderer.compile(scene, camera);
requestAnimationFrame((n) => { last = n; frame(n); });
