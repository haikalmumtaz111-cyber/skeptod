import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { patchFogChunks, U, windify } from './shaders.js';
import { buildHeightfield, hAt, SUN_DIR, layout, riverXAt } from './world.js';
import { makeTextures } from './textures.js';
import { buildGroundMask, buildTerrain } from './terrain.js';
import { buildSky, buildMountains } from './sky.js';
import { buildArchitecture, hanging, lights, smokeSources, lanternStrings, C } from './architecture.js';
import { buildWater, buildWaterfall, buildStones } from './river.js';
import { buildVegetation } from './vegetation.js';
import { buildLife } from './life.js';
import { Pipeline } from './post.js';
import { box, cyl, M, mul, segMatrix } from './geom.js';
import { Q } from './quality.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

const params = new URLSearchParams(location.search);
const fixedT = params.has('t') ? parseFloat(params.get('t')) : null;
const freeze = params.has('freeze');
const forcedPR = params.has('pr') ? parseFloat(params.get('pr')) : null;
const maxFrames = params.has('frames') ? parseInt(params.get('frames')) : Infinity;
let frameCount = 0;
const camOverride = params.has('cam') ? params.get('cam').split(',').map(Number) : null;

function archMaterials(T) {
  T.wood.repeat.set(1 / 0.7, 1 / 2.8);
  T.plaster.repeat.set(0.4, 0.4);
  T.stone.repeat.set(0.7, 0.7);
  T.namako.repeat.set(1 / 1.3, 1 / 1.3);
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const roof = std({ vertexColors: true, roughness: 0.42, metalness: 0.15, envMapIntensity: 1.5 });
  roof.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vRUv;\nfloat rh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float course = fract(vRUv.y / 0.27);
        float shadowLine = smoothstep(0.0, 0.22, course) * 0.28 + 0.72;
        vec2 cell = floor(vec2(vRUv.x / 0.29, vRUv.y / 0.27));
        float tv = rh(cell);
        diffuseColor.rgb *= shadowLine * (0.86 + 0.24 * tv);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.9, 1.0, 0.85), step(0.93, rh(cell + 7.0)) * 0.6);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (rh(floor(vec2(vRUv.x / 0.29, vRUv.y / 0.27)) + 3.0) - 0.5) * 0.3, 0.2, 1.0);');
  };
  const shoji = (k) => std({ map: T.shoji, emissiveMap: T.shoji, emissive: new THREE.Color(1.0, 0.56, 0.24), emissiveIntensity: k, roughness: 0.9, side: THREE.DoubleSide });
  const cloth = std({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  cloth.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float wk = pow(1.0 - uv.y, 1.6);
        float ph = position.x * 0.9 + position.z * 0.7;
        transformed.x += sin(uTime * 2.1 + ph) * 0.05 * wk;
        transformed.z += (sin(uTime * 1.6 + ph * 1.3) * 0.07 + 0.04) * wk;`);
  };
  const plaster = std({ map: T.plaster, vertexColors: true, roughness: 0.93, envMapIntensity: 0.5 });
  return {
    wood: std({ map: T.wood, vertexColors: true, roughness: 0.82, envMapIntensity: 0.45 }),
    plaster,
    plasterTri: (() => { const m = plaster.clone(); m.side = THREE.DoubleSide; return m; })(),
    stone: std({ map: T.stone, vertexColors: true, roughness: 0.9, envMapIntensity: 0.45 }),
    roof,
    thatch: std({ map: T.streak, vertexColors: true, roughness: 1.0, envMapIntensity: 0.35 }),
    shojiLit: shoji(1.9),
    shojiDim: shoji(0.35),
    lacquer: std({ vertexColors: true, roughness: 0.42, envMapIntensity: 0.75 }),
    metal: std({ vertexColors: true, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.3 }),
    namako: std({ map: T.namako, roughness: 0.6, envMapIntensity: 0.7 }),
    cloth,
    cloth2: std({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(5.5, 2.8, 1.0) }),
  };
}

// ---------------- camera choreography ----------------
const SHOTS = [
  [[24, 52, 150], [-6, 6, -36]],
  [[8, 22, 82], [-8, 4, 24]],
  [[-3, 8.5, 48], [-2, 3.5, 0]],
  [[3, 7.5, 6], [12, 3.5, -38]],
  [[-4, 10, -22], [-36, 14, -38]],
  [[-16, 21, -16], [-38, 17, -38]],
  [[-24, 25, -50], [-62, 12, -62]],
  [[-3, 11, -58], [-4, 6.5, -98]],
  [[-6, 40, -72], [-30, 52, -420]],
  [[28, 60, -94], [116, 50, -58]],
  [[50, 42, -56], [64, 10, -6]],
  [[36, 21, 28], [72, 9, -2]],
  [[48, 22, 46], [58, 6, -22]],
  [[40, 15, 54], [12, 4, -18]],
  [[50, 46, 112], [2, 6, -28]],
];
const LOOP = 140;

async function main() {
  patchFogChunks();
  const canvas = document.getElementById('c');
  if (!document.createElement('canvas').getContext('webgl2')) throw new Error('WebGL2 unavailable');
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => location.reload());
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setClearColor(0x000000, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 2);
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.3, 14000);
  camera.layers.enable(1); camera.layers.enable(2);

  buildHeightfield();
  await tick();
  const T = makeTextures();
  const maskTex = buildGroundMask();
  await tick();
  scene.add(buildSky());
  scene.add(buildMountains());
  scene.add(buildTerrain(maskTex));
  await tick();

  // architecture
  const b = buildArchitecture();
  // lantern strings across the street
  for (const L of lanternStrings()) {
    if (L.pole) {
      const y = hAt(L.x, L.z);
      b.add('wood', box(0.16, L.h, 0.16), M(L.x, y + L.h / 2, L.z), C.woodD);
      b.add('wood', box(0.5, 0.1, 0.1), M(L.x, y + L.h - 0.3, L.z), C.woodD);
    } else hanging.push(L);
  }
  for (const z of [-26, -6, 22, 44]) {
    const rx = riverXAt(z);
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, x = rx + 27.4 + 6.2 * t;
      pts.push([x, hAt(x, z) + 5.2 - Math.sin(t * Math.PI) * 0.55, z]);
    }
    for (let i = 0; i < 10; i++) { const { m, len } = segMatrix(pts[i], pts[i + 1]); b.add('wood', box(0.025, 0.025, len), m, C.dark); }
  }
  await tick();
  const mats = archMaterials(T);
  const merged = b.merge();
  const archGroup = new THREE.Group();
  for (const [k, g] of merged) {
    const mat = mats[k] || mats.wood;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = !['shojiLit', 'shojiDim', 'glow', 'cloth'].includes(k);
    mesh.receiveShadow = true;
    archGroup.add(mesh);
  }
  scene.add(archGroup);
  await tick();

  const stones = buildStones(T);
  scene.add(stones);
  const water = buildWater(T);
  scene.add(water);
  const fall = buildWaterfall(T);
  scene.add(fall);
  await tick();
  scene.add(buildVegetation(T));
  await tick();
  const life = buildLife(T, { foot: fall.userData.foot, smokeSources, hanging });
  scene.add(life.group);

  // lights
  const sunDir = new THREE.Vector3(...SUN_DIR);
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.64, 0.38), 3.4);
  const center = new THREE.Vector3(0, 0, -15);
  sun.position.copy(center).addScaledVector(sunDir, 400);
  sun.target.position.copy(center);
  sun.castShadow = true;
  const sm = !Q.low && renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  const sc = sun.shadow.camera;
  sc.left = -150; sc.right = 150; sc.top = 130; sc.bottom = -130; sc.near = 50; sc.far = 800;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.56, 0.53, 0.68), new THREE.Color(0.42, 0.32, 0.22), 0.95);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(new THREE.Color(0.62, 0.52, 0.7), 0.65);
  fill.position.set(300, 120, 260);
  scene.add(fill);
  const pls = [];
  lights.filter((l) => !l.small).sort((a, b2) => b2.i - a.i).slice(0, Q.low ? 3 : 5).forEach((l) => {
    const p = new THREE.PointLight(new THREE.Color(1.0, 0.55, 0.22), 26 * l.i, 16, 2);
    p.position.set(l.x, l.y, l.z);
    p.userData.base = 26 * l.i;
    scene.add(p); pls.push(p);
  });

  // environment from the sky
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = buildSky();
  envSky.material.uniforms.uEnv.value = 1;
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.55;

  const pipe = new Pipeline(renderer, scene, camera);
  pipe.hideInReflection.push(water, fall);
  if (Q.low) {
    // phones: skip the planar reflection pass, water reflects the sky gradient instead
    pipe.reflectEnabled = false;
    water.traverse((o) => { if (o.material && o.material.uniforms && o.material.uniforms.uReflOn) o.material.uniforms.uReflOn.value = 0; });
  }

  // ---------- camera ----------
  const posCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new THREE.Vector3(...s[0])), true, 'centripetal', 0.5);
  const dirCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new THREE.Vector3(...s[1]).sub(new THREE.Vector3(...s[0])).normalize()), true, 'catmullrom', 0.5);
  const cine = { t: fixedT !== null ? fixedT : 0 };
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  function cinePose(t, outP, outT) {
    const u = ((t / LOOP) % 1 + 1) % 1;
    posCurve.getPointAt(u, outP);
    // target follows the same normalized parameter along its own curve
    const ut = posCurve.getUtoTmapping(u);
    dirCurve.getPoint(ut, outT);
    outT.normalize().multiplyScalar(40).add(outP);
    // gentle hand-held drift
    outP.x += Math.sin(t * 0.37) * 0.25; outP.y += Math.sin(t * 0.53) * 0.18; outP.z += Math.cos(t * 0.31) * 0.25;
    const g = hAt(outP.x, outP.z);
    if (outP.y < g + 3) outP.y = g + 3;
  }

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.7;
  controls.minDistance = 3;
  controls.maxDistance = 420;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enabled = true;
  let mode = 'cine';
  let lastInput = -1e9, blendStart = 0;
  const userPose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  controls.addEventListener('start', () => {
    if (mode !== 'user') {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const dist = Math.max(10, camPos.distanceTo(camTgt));
      controls.target.copy(camera.position).addScaledVector(fwd, dist);
    }
    mode = 'user';
    lastInput = performance.now();
  });
  let dragging = false;
  controls.addEventListener('start', () => { dragging = true; });
  controls.addEventListener('end', () => { dragging = false; lastInput = performance.now(); });
  canvas.addEventListener('wheel', () => { if (mode !== 'user') { const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion); controls.target.copy(camera.position).addScaledVector(fwd, Math.max(10, camPos.distanceTo(camTgt))); mode = 'user'; } lastInput = performance.now(); }, { passive: true, capture: true });

  // ---------- sizing / adaptive resolution ----------
  const maxPR = forcedPR || Math.min(window.devicePixelRatio || 1, Q.low ? 1.0 : 1.75);
  const minPR = Q.low ? 0.5 : 0.6;
  let pr = forcedPR || Math.min(maxPR, Q.low ? 0.8 : 1.25);
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // portrait screens: widen vertical FOV so the horizontal view does not collapse
    camera.fov = camera.aspect < 1 ? Math.min(72, Math.max(42, 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(29)) / camera.aspect) * THREE.MathUtils.RAD2DEG)) : 42;
    camera.updateProjectionMatrix();
    pipe.setSize(w, h, pr);
    life.setPR(pr);
  }
  addEventListener('resize', resize);
  resize();

  // pre-simulate a few seconds so petals are already drifting when the scene appears
  {
    const p0 = new THREE.Vector3(), t0 = new THREE.Vector3();
    cinePose(cine.t, p0, t0);
    for (let i = 0; i < 70; i++) life.update(0.1, 1000 + (fixedT || 0) - 7 + i * 0.1, p0);
  }
  const clock = new THREE.Clock();
  let simT = fixedT !== null ? fixedT : 0;
  let frames = 0, acc = 0, lastAdapt = 0, fade = 0, fadeStart = 0;
  const overlay = document.getElementById('o');
  const look = new THREE.Matrix4();
  const qTmp = new THREE.Quaternion();
  const pTmp = new THREE.Vector3();

  function frame() {
    if (window.__stop) return;
    const rdt = Math.min(clock.getDelta(), 0.1);
    const dt = freeze ? 0 : rdt;
    simT += dt;
    U.time.value = simT + 1000;
    U.flicker.value = 0.94 + 0.06 * Math.sin(simT * 13.0) * Math.sin(simT * 7.3 + 1.0);
    const now = performance.now();

    if (mode === 'user') {
      controls.update();
      const g = hAt(camera.position.x, camera.position.z);
      if (camera.position.y < g + 1.2) camera.position.y = g + 1.2;
      if (!dragging && now - lastInput > 9000) {
        mode = 'blend'; blendStart = now;
        userPose.p.copy(camera.position); userPose.q.copy(camera.quaternion);
      }
    } else {
      if (!freeze) cine.t += dt;
      cinePose(cine.t, camPos, camTgt);
      if (camOverride) { camPos.set(camOverride[0], camOverride[1], camOverride[2]); camTgt.set(camOverride[3], camOverride[4], camOverride[5]); }
      if (mode === 'blend') {
        const k = THREE.MathUtils.smoothstep((now - blendStart) / 3500, 0, 1);
        look.lookAt(camPos, camTgt, new THREE.Vector3(0, 1, 0));
        qTmp.setFromRotationMatrix(look);
        camera.position.copy(userPose.p).lerp(camPos, k);
        camera.quaternion.copy(userPose.q).slerp(qTmp, k);
        if (k >= 1) mode = 'cine';
      } else {
        camera.position.copy(camPos);
        camera.lookAt(camTgt);
      }
    }
    camera.updateMatrixWorld();
    window.__mode = mode;

    if (pls.length) pls.forEach((p, i) => { p.intensity = p.userData.base * (0.9 + 0.1 * Math.sin(simT * (9 + i) + i)); });
    mats.shojiLit.emissiveIntensity = 1.9 * U.flicker.value;

    life.update(dt, simT + 1000, camera.position);
    renderer.info.reset();
    if (!fadeStart) fadeStart = now;
    fade = freeze ? 1 : Math.min(1, (now - fadeStart) / 1800);
    pipe.render(dt, simT, fade);

    // adaptive resolution
    if (!forcedPR) {
      frames++; acc += rdt;
      if (now - lastAdapt > 2500 && frames > 30) {
        const avg = acc / frames;
        if (avg > 0.026 && pr > minPR) { pr = Math.max(minPR, pr - 0.15); resize(); }
        else if (avg < 0.0145 && pr < maxPR) { pr = Math.min(maxPR, pr + 0.1); resize(); }
        frames = 0; acc = 0; lastAdapt = now;
      }
    }
    frameCount++;
    if (frameCount >= Math.min(maxFrames, 3) && !window.__ready) { window.__ready = true; overlay.style.opacity = '0'; }
    if (frameCount === 1 && params.has('stats')) console.log('first frame ms', (performance.now() - now).toFixed(0));
    if (frameCount === 2 && params.has('stats')) console.log('tris', renderer.info.render.triangles, 'calls', renderer.info.render.calls, 'geoms', renderer.info.memory.geometries);
    if (frameCount < maxFrames) requestAnimationFrame(frame);
    else window.__done = true;
  }
  window.__scene = scene;
  if (params.has('stats')) {
    const rows = [];
    scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints) return;
      const g = o.geometry;
      const tri = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const n = o.isInstancedMesh ? o.count : 1;
      rows.push([o.name || o.material.type + (o.material.customProgramCacheKey ? o.material.customProgramCacheKey() : ''), n, Math.round(tri), Math.round(tri * n), o.castShadow, o.layers.mask]);
    });
    rows.sort((a, b) => b[3] - a[3]);
    console.log('MESHES ' + rows.slice(0, 25).map((r) => r.join(' | ')).join('\n'));
  }
  window.__renderer = renderer;
  // compile shaders without stalling the first frame where the browser supports it
  if (renderer.extensions.has('KHR_parallel_shader_compile')) {
    try { await renderer.compileAsync(scene, camera); } catch (e) { /* compiled on first render instead */ }
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(() => setTimeout(() => {
  main().catch((e) => {
    console.error(e);
    const o = document.getElementById('o');
    if (o) o.classList.add('f');
  });
}, 30));
