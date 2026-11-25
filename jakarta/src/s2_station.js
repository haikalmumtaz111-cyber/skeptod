// Shot 2: commuter station, low angle by the rails, train arriving
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { V3, makeSky, canvasTex, rng, lerp, shake, glow, windowTex, buildingGeo, mergeGeometries, makeTrees, grassGeo, addSway, speckle, toonGradient } from './lib.js';

export function makeTrain(nCars = 6) {
  const g = new THREE.Group();
  const L = 19.5, Wd = 2.86, F = 1.15, Hh = 3.0;
  const silver = new THREE.MeshStandardMaterial({ color: '#dfe3e8', metalness: 0.75, roughness: 0.32 });
  const glass = new THREE.MeshStandardMaterial({ color: '#1a232c', metalness: 0.3, roughness: 0.08 });
  const red = new THREE.MeshStandardMaterial({ color: '#d7232e', metalness: 0.3, roughness: 0.4 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#f2c12e', metalness: 0.2, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: '#25272a', metalness: 0.4, roughness: 0.7 });
  const door = new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.7, roughness: 0.35 });
  const roofM = new THREE.MeshStandardMaterial({ color: '#a9adb2', metalness: 0.5, roughness: 0.5 });
  const destTex = canvasTex(256, 64, (c, w, h) => { c.fillStyle = '#120800'; c.fillRect(0, 0, w, h); c.fillStyle = '#ff9a2a'; c.font = 'bold 40px Inter'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('BOGOR', w / 2, h / 2 + 2); });
  const dest = new THREE.MeshBasicMaterial({ map: destTex, color: new THREE.Color(2.2, 2.2, 2.2) });
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(12, 11, 9) });
  const body = new RoundedBoxGeometry(Wd, Hh, L, 3, 0.2);
  const box = (w, h, d, m, x, y, z, parent) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); parent.add(b); b.castShadow = true; return b; };
  for (let i = 0; i < nCars; i++) {
    const car = new THREE.Group();
    car.position.z = -i * (L + 0.6) - L / 2;
    const b = new THREE.Mesh(body, silver); b.position.y = F + Hh / 2; b.castShadow = true; car.add(b);
    box(Wd + 0.02, 0.8, L - 1.2, glass, 0, F + 1.9, 0, car);
    box(Wd + 0.03, 0.14, L - 0.4, red, 0, F + 1.1, 0, car);
    box(Wd + 0.03, 0.06, L - 0.4, yellow, 0, F + 0.95, 0, car);
    for (let d = 0; d < 4; d++) {
      const z = -L / 2 + 2.6 + d * ((L - 5.2) / 3);
      box(Wd + 0.035, 2.0, 1.3, door, 0, F + 1.02, z, car);
      box(Wd + 0.045, 0.75, 0.42, glass, 0, F + 1.55, z - 0.3, car);
      box(Wd + 0.045, 0.75, 0.42, glass, 0, F + 1.55, z + 0.3, car);
    }
    box(Wd - 0.3, 0.7, L - 3, dark, 0, 0.8, 0, car);
    box(2.0, 0.35, 3.2, roofM, 0, F + Hh + 0.12, -L / 4, car);
    box(2.0, 0.35, 3.2, roofM, 0, F + Hh + 0.12, L / 4, car);
    if (i === 0) {
      // cab front
      const fz = L / 2 + 0.05;
      box(Wd - 0.08, 1.15, 0.14, red, 0, F + 0.6, fz, car);
      box(Wd - 0.35, 1.2, 0.1, glass, 0, F + 1.95, fz + 0.02, car);
      const ds = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.26), dest); ds.position.set(0, F + 2.75, fz + 0.09); car.add(ds);
      for (const sx of [-1, 1]) {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), head); hl.position.set(sx * 1.0, F + 0.55, fz + 0.1); car.add(hl);
        const gw = glow('#fff4dc', 2.2, 3.2); gw.position.set(sx * 1.0, F + 0.55, fz + 0.4); car.add(gw);
      }
      const big = glow('#fff1d6', 0.7, 14); big.position.set(0, F + 0.6, fz + 0.8); car.add(big);
      // pantograph
      const pm = new THREE.MeshStandardMaterial({ color: '#3a3a3a', metalness: 0.6, roughness: 0.5 });
      box(1.6, 0.05, 0.05, pm, 0, F + Hh + 1.2, 2, car);
      const a1 = box(0.05, 1.2, 0.05, pm, -0.5, F + Hh + 0.65, 2, car); a1.rotation.z = 0.5;
      const a2 = box(0.05, 1.2, 0.05, pm, 0.5, F + Hh + 0.65, 2, car); a2.rotation.z = -0.5;
    }
    g.add(car);
  }
  return g;
}

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(44, ctx.W / ctx.H, 0.05, 4000);
  scene.fog = new THREE.Fog('#c3d8e6', 140, 1100);

  const sunDir = new V3(0.55, 0.5, -0.65).normalize();
  const sky = makeSky({ top: '#2c6cc4', mid: '#62a3df', hor: '#d2e5ef', sunDir, sunCol: '#fff0d8', sunGlow: 0.6, cover: 0.53, cloudScale: 0.7, cloudLit: '#ffffff', cloudShade: '#a2b4cc', rim: 0.6 });
  scene.add(sky);

  scene.add(new THREE.HemisphereLight('#c9defa', '#5f5244', 0.75));
  const sun = new THREE.DirectionalLight('#fff0da', 2.7);
  sun.position.copy(sunDir).multiplyScalar(120).add(new V3(0, 0, -40));
  sun.target.position.set(0, 0, -40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 80, bottom: -80, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  // ballast ground
  const r = rng(21);
  const ballast = canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#6f675e'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, 9000, ['#8a8277', '#5a534b', '#a39a8c', '#4a443e', '#7d7468', '#6a5f52'], 1.5, 4.5, 3);
  }, { repeat: true });
  ballast.repeat.set(80, 400);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 2000), new THREE.MeshStandardMaterial({ map: ballast, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.z = -700; ground.receiveShadow = true;
  scene.add(ground);

  // tracks
  const sleeperM = new THREE.MeshStandardMaterial({ color: '#8f8b85', roughness: 0.9 });
  const railM = new THREE.MeshStandardMaterial({ color: '#8e8a86', metalness: 0.9, roughness: 0.28 });
  const tracks = [0, 4.7];
  const nS = 1100;
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, 0.14, 0.26), sleeperM, nS * tracks.length);
  const M = new THREE.Matrix4();
  let k = 0;
  for (const tx of tracks) for (let i = 0; i < nS; i++) { M.makeTranslation(tx, 0.07, 30 - i * 0.6); sleepers.setMatrixAt(k++, M); }
  sleepers.receiveShadow = true;
  scene.add(sleepers);
  for (const tx of tracks) for (const s of [-0.75, 0.75]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 700), railM);
    rail.position.set(tx + s, 0.22, -320); rail.receiveShadow = true; scene.add(rail);
  }

  // platform
  const concrete = new THREE.MeshStandardMaterial({ color: '#bdb6aa', roughness: 0.9 });
  const sideTex = canvasTex(1024, 128, (c, w, h) => {
    c.fillStyle = '#a49c8f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) { c.fillStyle = `rgba(60,50,40,${0.05 + r() * 0.12})`; c.fillRect(r() * w, 0, 2 + r() * 20, h); }
    c.fillStyle = '#d8d2c6'; c.fillRect(0, 0, w, 14);
    c.fillStyle = 'rgba(40,35,30,0.35)'; c.fillRect(0, h - 26, w, 26);
  }, { repeat: true });
  sideTex.repeat.set(40, 1);
  const platSide = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.9 });
  const plat = new THREE.Mesh(new THREE.BoxGeometry(10, 1.05, 420), [platSide, platSide, concrete, concrete, concrete, concrete]);
  plat.position.set(-7.25, 0.525, -180); plat.receiveShadow = true; plat.castShadow = true;
  scene.add(plat);
  const yel = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.02, 420), new THREE.MeshStandardMaterial({ color: '#efc426', roughness: 0.7 }));
  yel.position.set(-2.75, 1.06, -180); scene.add(yel);
  const wline = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.021, 420), new THREE.MeshStandardMaterial({ color: '#f4f2ec', roughness: 0.7 }));
  wline.position.set(-2.32, 1.06, -180); scene.add(wline);

  // canopy
  const roofUnder = new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 0.8 });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.25, 240), roofUnder);
  roof.position.set(-6.4, 5.4, -105); roof.castShadow = true; scene.add(roof);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.75, 240), new THREE.MeshStandardMaterial({ color: '#8b4a37', roughness: 0.7 }));
  fascia.position.set(-1.65, 5.35, -105); fascia.castShadow = true; scene.add(fascia);
  const roofTop = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.1, 240), new THREE.MeshStandardMaterial({ color: '#7d4636', roughness: 0.6 }));
  roofTop.position.set(-6.4, 5.58, -105); scene.add(roofTop);
  const colM = new THREE.MeshStandardMaterial({ color: '#dcd8cf', roughness: 0.6 });
  const lampM = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.9, 2.6) });
  const cols = [], lamps = [];
  for (let z = 8; z > -220; z -= 9) {
    const c1 = new THREE.BoxGeometry(0.34, 4.35, 0.34); c1.translate(-3.3, 1.05 + 2.17, z); cols.push(c1);
    const c2 = new THREE.BoxGeometry(0.34, 4.35, 0.34); c2.translate(-9.5, 1.05 + 2.17, z); cols.push(c2);
    const l = new THREE.BoxGeometry(0.16, 0.06, 3.2); l.translate(-4.4, 5.25, z - 4.5); lamps.push(l);
  }
  const colMesh = new THREE.Mesh(mergeGeometries(cols), colM); colMesh.castShadow = true; scene.add(colMesh);
  scene.add(new THREE.Mesh(mergeGeometries(lamps), lampM));

  // signs
  const sign = (txt, bg, fg, w, h, size) => canvasTex(Math.round(w * 200), Math.round(h * 200), (c, cw, ch) => {
    c.fillStyle = bg; c.fillRect(0, 0, cw, ch);
    c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 6; c.strokeRect(10, 10, cw - 20, ch - 20);
    c.fillStyle = fg; c.font = `800 ${size}px Inter`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, cw / 2, ch / 2 + 4);
  });
  const addSign = (tex, w, h, x, y, z, ry = 0, emi = 0.25) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), [colM, colM, colM, colM, new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: emi, roughness: 0.5 }), colM]);
    m.position.set(x, y, z); m.rotation.y = ry; scene.add(m);
    for (const sx of [-0.35, 0.35]) { const rod = new THREE.Mesh(new THREE.BoxGeometry(0.03, 5.3 - y - h / 2, 0.03), colM); rod.position.set(x + sx * w, (5.3 + y + h / 2) / 2, z); scene.add(rod); }
  };
  addSign(sign('MANGGARAI', '#1d5fc2', '#ffffff', 3.4, 0.8, 110), 3.4, 0.8, -3.6, 4.2, 4.5, 0.15);
  addSign(sign('JALUR 3', '#f2c12e', '#1b1b1b', 1.6, 0.5, 64), 1.6, 0.5, -4.6, 4.3, -22);
  addSign(sign('ARAH BOGOR', '#178a52', '#ffffff', 2.2, 0.5, 60), 2.2, 0.5, -4.6, 4.3, -42);
  addSign(sign('MANGGARAI', '#1d5fc2', '#ffffff', 3.0, 0.7, 100), 3.0, 0.7, -4.6, 4.2, -70);
  addSign(sign('JALUR 3', '#f2c12e', '#1b1b1b', 1.6, 0.5, 64), 1.6, 0.5, -4.6, 4.3, -100);

  // boards on platform + people silhouettes
  const boardTex = [sign('INFO', '#f2c12e', '#202020', 1, 1.4, 70), sign('KRL', '#1f8a4c', '#fff', 1, 1.4, 80), sign('PETA', '#2a62c8', '#fff', 1, 1.4, 70)];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.1), new THREE.MeshStandardMaterial({ map: boardTex[i % 3], roughness: 0.6 }));
    m.position.set(-5.6, 2.4, -10 - i * 17); m.rotation.y = Math.PI / 2; scene.add(m);
  }
  const clothes = ['#2d3e63', '#8a2b2b', '#e8e2d4', '#2f2f33', '#5f7f4a', '#c78a2f', '#3b5a8a'];
  for (let i = 0; i < 14; i++) {
    const p = new THREE.Group();
    const bm = new THREE.MeshStandardMaterial({ color: clothes[i % clothes.length], roughness: 0.8 });
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.95, 4, 10), bm); b.position.y = 0.72; b.scale.z = 0.7;
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), new THREE.MeshStandardMaterial({ color: '#3a2a22', roughness: 0.7 })); h.position.y = 1.55;
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.6, 4, 8), new THREE.MeshStandardMaterial({ color: '#2b2b30' })); legs.position.y = 0.0;
    p.add(b, h, legs);
    p.position.set(-3.6 - r() * 4.5, 1.05 + 0.35, -14 - r() * 90);
    p.scale.setScalar(0.95 + r() * 0.15);
    p.traverse((o) => { o.castShadow = true; });
    scene.add(p);
  }

  // catenary
  const poleM = new THREE.MeshStandardMaterial({ color: '#6c675e', roughness: 0.7, metalness: 0.3 });
  const poles = [];
  for (let z = -32; z > -520; z -= 42) {
    const p = new THREE.BoxGeometry(0.32, 7.8, 0.32); p.translate(2.35, 3.9, z); poles.push(p);
    const a = new THREE.BoxGeometry(4.6, 0.16, 0.16); a.translate(0.2, 7.2, z); poles.push(a);
    const p2 = new THREE.BoxGeometry(0.32, 7.8, 0.32); p2.translate(7.1, 3.9, z); poles.push(p2);
    const a2 = new THREE.BoxGeometry(4.0, 0.16, 0.16); a2.translate(5.0, 7.2, z); poles.push(a2);
  }
  const poleMesh = new THREE.Mesh(mergeGeometries(poles), poleM); poleMesh.castShadow = true; scene.add(poleMesh);
  const wireM = new THREE.MeshBasicMaterial({ color: '#2b2b2b' });
  for (const [x, y] of [[0, 6.1], [0, 7.05], [4.7, 6.1], [4.7, 7.05], [2.35, 7.75], [-1.6, 7.0]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 700, 4), wireM);
    w.rotation.x = Math.PI / 2; w.position.set(x, y, -330); scene.add(w);
  }

  // footbridge
  const bridgeM = new THREE.MeshStandardMaterial({ color: '#c9c5bb', roughness: 0.8 });
  const railBlue = new THREE.MeshStandardMaterial({ color: '#4c6f9a', roughness: 0.5, metalness: 0.4 });
  const bz = -150;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(60, 1.0, 5), bridgeM); deck.position.set(0, 10, bz); deck.castShadow = true; scene.add(deck);
  const bars = [];
  for (let x = -30; x <= 30; x += 0.5) { const b = new THREE.BoxGeometry(0.06, 1.2, 0.06); b.translate(x, 11.1, bz + 2.4); bars.push(b); }
  const top = new THREE.BoxGeometry(60, 0.1, 0.1); top.translate(0, 11.7, bz + 2.4); bars.push(top);
  scene.add(new THREE.Mesh(mergeGeometries(bars), railBlue));
  for (const x of [-12, 9]) { const s = new THREE.Mesh(new THREE.BoxGeometry(1.2, 10, 1.2), bridgeM); s.position.set(x, 5, bz); scene.add(s); }

  // city backdrop
  const tx = windowTex(5, { cols: 8, rows: 20, lit: 0, facade: '#e3e0d8', glass: '#4f7495', day: true });
  const tx2 = windowTex(9, { cols: 6, rows: 18, lit: 0, facade: '#c9cfd6', glass: '#3e5f80', day: true });
  const geos = [[], []];
  for (let i = 0; i < 46; i++) {
    const w = 16 + r() * 28, d = 16 + r() * 20, h = 25 + r() * 110 * (r() < 0.3 ? 1.7 : 1);
    let x = (r() - 0.5) * 520, z = -260 - r() * 450;
    if (Math.abs(x) < 25) x += x < 0 ? -30 : 30;
    const v = i % 2, gg = buildingGeo(w, h, d, v ? tx2 : tx, 3.3, 3.8, i);
    gg.translate(x, 0, z); geos[v].push(gg);
  }
  for (let i = 0; i < 12; i++) {
    const w = 14 + r() * 18, h = 12 + r() * 30, gg = buildingGeo(w, h, 14, tx, 3.3, 3.8, 100 + i);
    gg.translate(40 + r() * 80, 0, -40 - i * 22); geos[0].push(gg);
  }
  geos.forEach((gs, v) => { const m = new THREE.Mesh(mergeGeometries(gs), new THREE.MeshStandardMaterial({ map: (v ? tx2 : tx).map, roughness: 0.55, metalness: 0.15 })); scene.add(m); });

  // trees along the right side + behind the platform roof
  const tl = [];
  for (let i = 0; i < 26; i++) tl.push({ x: 12 + r() * 14, z: 4 - i * 9 - r() * 4, s: 2.2 + r() * 1.6, h: 3 + r() * 2 });
  for (let i = 0; i < 26; i++) tl.push({ x: -16 - r() * 16, z: 0 - i * 10 - r() * 5, s: 2.8 + r() * 2, h: 4 + r() * 3 });
  scene.add(makeTrees(tl, { seed: 3, leaf: ['#3e7a2c', '#4f9334', '#2c5f24', '#68a83f'] }));

  // grass tufts close to camera (right foreground)
  const grassM = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
  const sway = addSway(grassM, 0.12, 2.2, 1.6);
  for (const [x, z, n, h] of [[3.15, 9.2, 260, 0.75], [3.6, 6.5, 220, 0.6], [2.9, 4.2, 160, 0.5], [3.4, 1.0, 140, 0.45], [-1.75, 2, 60, 0.3]]) {
    const gm = new THREE.Mesh(grassGeo(n, 0.3, h, Math.round(x * 10 + z), '#24401a', '#86a64e'), grassM);
    gm.position.set(x, 0.05, z); scene.add(gm);
  }
  // weeds between sleepers
  const weeds = new THREE.InstancedMesh(grassGeo(18, 0.12, 0.18, 5), grassM, 80);
  for (let i = 0; i < 80; i++) { M.makeTranslation((r() < 0.5 ? -1.4 : 1.4) + (r() - 0.5) * 0.6, 0.02, 12 - r() * 140); weeds.setMatrixAt(i, M); }
  scene.add(weeds);

  const train = makeTrain(7);
  train.position.x = 0;
  scene.add(train);

  return {
    scene, camera,
    grade: { exposure: 0.88, bloom: 0.3, threshold: 0.95, sat: 1.15, contrast: 1.08, tone: 1, vig: 0.55 },
    update(lt, t) {
      const zf = -72 + 21 * lt - 1.05 * lt * lt;
      train.position.z = zf;
      const s = shake(lt, 0.012, 2);
      camera.position.set(2.32 + s.x, 0.62 + s.y, 12.5 - 0.5 * lt);
      camera.lookAt(-1.4 + s.x * 4, 2.1 + s.y * 4, -40);
      sway.value = t;
      sky.userData.update(t, camera);
    },
  };
}
