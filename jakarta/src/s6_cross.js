// Shot 6: crosswalk from above in the rain, umbrellas, cars and motorbikes waiting
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { V3, makeRain, canvasTex, rng, lerp, shake, glow, groundGlow, speckle, makeTrees, NOISE, TAU, mergeGeometries, easeInOut } from './lib.js';

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.35;
  scene.background = new THREE.Color('#2a3036');
  const camera = new THREE.PerspectiveCamera(40, ctx.W / ctx.H, 0.5, 400);
  const r = rng(61);

  scene.add(new THREE.HemisphereLight('#b4c3d6', '#2a2a30', 1.3));
  const dl = new THREE.DirectionalLight('#dfe7f2', 0.9); dl.position.set(-10, 40, 15); dl.castShadow = true;
  dl.shadow.mapSize.set(2048, 2048); Object.assign(dl.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 }); dl.shadow.radius = 6;
  scene.add(dl);

  // asphalt
  const asphalt = canvasTex(1024, 1024, (c, w, h) => {
    c.fillStyle = '#34373c'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, 22000, ['#3d4046', '#2b2e33', '#45484e', '#26282c'], 0.7, 2.2, 8);
    for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(20,22,26,${0.15 + r() * 0.2})`; c.beginPath(); c.ellipse(r() * w, r() * h, 30 + r() * 120, 20 + r() * 60, r() * 3, 0, TAU); c.fill(); }
  }, { repeat: true });
  asphalt.repeat.set(6, 6);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.18, metalness: 0.25 }));
  road.rotation.x = -Math.PI / 2; road.receiveShadow = true; scene.add(road);

  // markings
  const white = new THREE.MeshStandardMaterial({ color: '#e9e8e2', roughness: 0.35 });
  const yellowM = new THREE.MeshStandardMaterial({ color: '#e6b425', roughness: 0.4 });
  const mk = [], yk = [];
  const strip = (w, l, x, z, arr, rot = 0) => { const g = new THREE.PlaneGeometry(w, l); g.rotateX(-Math.PI / 2); g.rotateY(rot); g.translate(x, 0.012, z); arr.push(g); };
  for (let z = -6.6; z <= 6.6; z += 1.0) strip(4.2, 0.52, 0, z, mk);
  strip(0.3, 6.6, 3.2, 3.5, mk); strip(0.3, 6.6, -3.2, -3.5, mk);
  for (let x = 3.6; x < 60; x += 6) strip(3, 0.14, x + 1.5, -3.5, mk);
  for (let x = -3.6; x > -60; x -= 6) strip(3, 0.14, x - 1.5, 3.5, mk);
  strip(56, 0.12, 31.5, -0.1, yk); strip(56, 0.12, 31.5, 0.1, yk);
  strip(56, 0.12, -31.5, -0.1, yk); strip(56, 0.12, -31.5, 0.1, yk);
  // yellow box junction lines (hatched) on one side
  for (let i = 0; i < 6; i++) strip(0.16, 9, -9 - i * 1.6, -3.5, yk, 0.7);
  strip(9.6, 0.16, -13, -0.4, yk); strip(9.6, 0.16, -13, -6.6, yk);
  scene.add(new THREE.Mesh(mergeGeometries(mk), white), new THREE.Mesh(mergeGeometries(yk), yellowM));

  // sidewalks + curb
  const tiles = canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#8d8a84'; c.fillRect(0, 0, w, h); c.strokeStyle = '#6f6c67'; c.lineWidth = 3; for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, h); c.stroke(); c.beginPath(); c.moveTo(0, i * 64); c.lineTo(w, i * 64); c.stroke(); } speckle(c, w, h, 3000, ['#9a968f', '#7e7b75'], 0.5, 1.5, 2); }, { repeat: true });
  tiles.repeat.set(30, 2);
  for (const s of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(120, 0.2, 6), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.4, metalness: 0.1 }));
    sw.position.set(0, 0.1, s * 10); sw.receiveShadow = true; scene.add(sw);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(120, 0.25, 0.3), new THREE.MeshStandardMaterial({ color: s > 0 ? '#d9d6cf' : '#d9d6cf', roughness: 0.6 }));
    curb.position.set(0, 0.12, s * 7.1); scene.add(curb);
    // curb painted black-white segments
    for (let x = -60; x < 60; x += 2) { const p = new THREE.Mesh(new THREE.BoxGeometry(1, 0.26, 0.31), new THREE.MeshStandardMaterial({ color: '#1f2023' })); p.position.set(x, 0.12, s * 7.1); scene.add(p); }
    const green = new THREE.Mesh(new THREE.BoxGeometry(120, 0.3, 20), new THREE.MeshStandardMaterial({ color: '#3d4a37', roughness: 0.9 }));
    green.position.set(0, 0.15, s * 23); scene.add(green);
  }
  // trees on sidewalks
  const tl = [];
  for (let x = -40; x <= 40; x += 11) for (const s of [-1, 1]) if (Math.abs(x) > 4) tl.push({ x: x + r() * 2, z: s * (11.5 + r()), s: 2.4 + r(), h: 3.5 });
  scene.add(makeTrees(tl, { seed: 6, leaf: ['#2f5a2a', '#3e6e31', '#25492a', '#4a7a35'] }));

  // ripples on the wet road
  const rip = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vP; void main(){ vec4 w = modelMatrix*vec4(position,1.); vP = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + /* glsl */`
uniform float uTime; varying vec2 vP;
float layer(vec2 p, float t, float s){
  vec2 cell = floor(p / s); vec2 f = fract(p / s);
  float h = hash12(cell); vec2 c = vec2(hash12(cell + 7.1), hash12(cell + 3.3)) * .6 + .2;
  float ph = fract(t * 1.4 + h);
  float d = length(f - c) * s;
  float rr = ph * 0.35;
  return smoothstep(0.02, 0.0, abs(d - rr)) * (1. - ph) * step(0.55, h);
}
void main(){
  float a = layer(vP, uTime, 0.9) + layer(vP + 13.7, uTime + 0.5, 1.1);
  gl_FragColor = vec4(vec3(0.75, 0.82, 0.95) * a * 0.22, 1.);
}`,
  });
  const rp = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), rip); rp.rotation.x = -Math.PI / 2; rp.position.y = 0.03; scene.add(rp);

  // vehicles
  const car = (color, x, z, dir, len = 4.4) => {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.25 });
    const glass = new THREE.MeshStandardMaterial({ color: '#141a22', metalness: 0.5, roughness: 0.05 });
    const b = new THREE.Mesh(new RoundedBoxGeometry(len, 1.0, 1.85, 3, 0.25), paint); b.position.y = 0.7; g.add(b);
    const c = new THREE.Mesh(new RoundedBoxGeometry(len * 0.5, 0.7, 1.62, 3, 0.2), glass); c.position.set(-0.15, 1.4, 0); g.add(c);
    const roof = new THREE.Mesh(new RoundedBoxGeometry(len * 0.38, 0.1, 1.5, 2, 0.04), paint); roof.position.set(-0.15, 1.76, 0); g.add(roof);
    for (const sz of [-0.62, 0.62]) {
      const h = glow('#fff3dc', 2.4, 1.4); h.position.set(len / 2 + 0.1, 0.75, sz); g.add(h);
      const t = glow('#ff2a20', 1.8, 0.8); t.position.set(-len / 2 - 0.05, 0.8, sz); g.add(t);
    }
    const hr = groundGlow('#fff0d8', 0.6, 5, 3.2); hr.rotation.z = Math.PI / 2; hr.position.set(len / 2 + 2.2, 0.04, 0); g.add(hr);
    g.traverse((o) => { o.castShadow = true; });
    g.position.set(x, 0, z); g.rotation.y = dir;
    scene.add(g); return g;
  };
  // lane z>0 heading -x (stopped at x=3.6), lane z<0 heading +x (stopped at x=-3.6)
  const cols = ['#e9ebee', '#121418', '#8a929b', '#a41e22', '#e9ebee', '#2b4a7a'];
  car(cols[0], 7.0, 2.0, Math.PI); car(cols[1], 12.4, 1.9, Math.PI); car(cols[2], 17.8, 2.1, Math.PI); car(cols[3], 7.3, 5.3, Math.PI);
  car(cols[4], 12.8, 5.4, Math.PI, 4.8); car(cols[5], -7.2, -5.2, 0);
  car('#d9d6cc', -12.6, -5.3, 0); car('#3a3d42', -7.0, -2.0, 0);
  // city bus
  const bus = new THREE.Group();
  const busBody = new THREE.Mesh(new RoundedBoxGeometry(12, 3.1, 2.55, 3, 0.25), new THREE.MeshStandardMaterial({ color: '#1f58b0', metalness: 0.3, roughness: 0.35 }));
  busBody.position.y = 1.9; bus.add(busBody);
  const busRoof = new THREE.Mesh(new RoundedBoxGeometry(11.6, 0.2, 2.3, 2, 0.08), new THREE.MeshStandardMaterial({ color: '#e7e9ec', roughness: 0.5 }));
  busRoof.position.y = 3.48; bus.add(busRoof);
  for (const x of [-3, 1.5]) { const ac = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.35, 1.8, 2, 0.1), new THREE.MeshStandardMaterial({ color: '#b9bdc3', roughness: 0.5 })); ac.position.set(x, 3.7, 0); bus.add(ac); }
  for (const sz of [-0.9, 0.9]) { const h = glow('#fff3dc', 2.4, 1.6); h.position.set(6.1, 0.9, sz); bus.add(h); }
  bus.traverse((o) => { o.castShadow = true; });
  bus.position.set(-14.5, 0, -2.1); scene.add(bus);
  // motorbikes waiting in front of cars, riders in raincoats
  const coats = ['#2fa84f', '#1f6fd1', '#f0c419', '#d63b3b', '#2fa84f', '#7b4fc2', '#2fa84f', '#ff8a1e'];
  const bikes = [];
  const bikeAt = (x, z, dir, i) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new RoundedBoxGeometry(1.9, 0.6, 0.42, 2, 0.15), new THREE.MeshStandardMaterial({ color: '#1d1e22', metalness: 0.4, roughness: 0.4 })); m.position.y = 0.6; g.add(m);
    const coat = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 10), new THREE.MeshStandardMaterial({ color: coats[i % coats.length], roughness: 0.25, metalness: 0.05 })); coat.scale.set(1.15, 0.85, 0.95); coat.position.set(-0.15, 1.25, 0); g.add(coat);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshStandardMaterial({ color: ['#101010', '#f2f2f2', '#2fa84f', '#c0392b'][i % 4], roughness: 0.15, metalness: 0.2 })); helm.position.set(0.15, 1.75, 0); g.add(helm);
    const hl = glow('#fff1d2', 2, 0.9); hl.position.set(1.0, 0.85, 0); g.add(hl);
    g.traverse((o) => { o.castShadow = true; });
    g.position.set(x, 0, z); g.rotation.y = dir;
    scene.add(g); bikes.push(g);
  };
  let bi = 0;
  for (let k = 0; k < 6; k++) bikeAt(3.9 + (k % 3) * 0.9 + (k > 2 ? 2.2 : 0), 0.9 + (k % 3) * 1.9 + (k > 2 ? 0.5 : 0), Math.PI, bi++);
  for (let k = 0; k < 5; k++) bikeAt(-3.9 - (k % 3) * 1.0 - (k > 2 ? 2.4 : 0), -1.0 - (k % 3) * 2.0, 0, bi++);

  // pedestrians with umbrellas
  const umbCols = ['#141414', '#1e2a4a', '#c0262d', '#141414', '#e0b21f', '#2a6a4a', '#1e2a4a', '#7b2a5a', '#141414', '#dcdcdc', '#c0262d', '#1f6fd1', '#141414', '#3b3b3b', '#f08a24', '#141414'];
  const peds = [];
  const umbGeo = new THREE.ConeGeometry(0.62, 0.32, 8, 1, true); umbGeo.translate(0, 0.16, 0);
  for (let i = 0; i < 18; i++) {
    const g = new THREE.Group();
    const col = umbCols[i % umbCols.length];
    const um = new THREE.Mesh(umbGeo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.2, metalness: 0.05, side: THREE.DoubleSide, flatShading: true }));
    um.position.y = 1.85; g.add(um);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), new THREE.MeshStandardMaterial({ color: '#ddd' })); tip.position.y = 2.18; g.add(tip);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.9, 4, 8), new THREE.MeshStandardMaterial({ color: ['#2b2f3a', '#6a5a48', '#e7e2d6', '#3d4f6a'][i % 4], roughness: 0.8 })); body.position.y = 0.85; g.add(body);
    g.traverse((o) => { o.castShadow = true; });
    const dir = i % 2 ? 1 : -1;
    peds.push({ g, x: (r() - 0.5) * 3.4, dir, sp: 1.1 + r() * 0.5, ph: r() * 30, sway: r() * TAU });
    scene.add(g);
  }

  const rain = makeRain({ count: 8000, box: [50, 50, 50], speed: 22, len: 0.9, color: '#d6e2f2', opacity: 0.35, wind: [0.2, 0.08] });
  scene.add(rain);

  return {
    scene, camera,
    grade: { exposure: 0.95, bloom: 0.45, threshold: 0.95, sat: 1.05, contrast: 1.06, tone: 1.2, vig: 0.65, lift: [0, 0.005, 0.015] },
    update(lt, t) {
      const u = Math.min(lt / 4.2, 1), e = easeInOut(u);
      const s = shake(lt, 0.05, 3);
      const ang = lerp(-0.25, 0.05, e);
      camera.position.set(Math.sin(ang) * 15 + s.x, lerp(30, 25, e) + s.y, Math.cos(ang) * 15);
      camera.lookAt(0.5, 0, 0.5);
      for (const p of peds) {
        const span = 30;
        let z = ((p.ph + p.sp * t) % span) - span / 2;
        if (p.dir < 0) z = -z;
        p.g.position.set(p.x + Math.sin(t * 0.7 + p.sway) * 0.15, Math.abs(Math.sin(t * 6 + p.sway)) * 0.04, z);
        p.g.rotation.set(Math.sin(t * 6 + p.sway) * 0.04, t * 0.3 + p.sway, 0);
      }
      bikes.forEach((b, i) => { b.position.y = Math.sin(t * 9 + i) * 0.006; });
      rip.uniforms.uTime.value = t;
      rain.userData.update(t, camera);
    },
  };
}
