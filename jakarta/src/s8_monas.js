// Shot 8: the national monument on a bright morning, framed by trees
import * as THREE from 'three';
import { V3, makeSky, canvasTex, rng, lerp, shake, makeTrees, speckle, TAU, easeInOut, fbm3, toonGradient, addSway, grassGeo } from './lib.js';

function frustum(rTop, rBot, h, y, mat) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, 4, 1);
  g.rotateY(Math.PI / 4);
  const m = new THREE.Mesh(g, mat);
  m.position.y = y + h / 2;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(42, ctx.W / ctx.H, 0.5, 6000);
  scene.fog = new THREE.Fog('#bcd6ea', 400, 2600);
  const r = rng(81);

  const sunDir = new V3(-0.55, 0.42, -0.5).normalize();
  const sky = makeSky({ top: '#2265c9', mid: '#5fa6ea', hor: '#d7ecf6', sunDir, sunCol: '#fff2d6', sunGlow: 0.7, cover: 0.5, cloudScale: 0.42, cloudLit: '#ffffff', cloudShade: '#9fb3d6', rim: 0.7, speed: 0.015 });
  scene.add(sky);
  scene.add(new THREE.HemisphereLight('#cfe4ff', '#5d6b3a', 0.8));
  const sun = new THREE.DirectionalLight('#fff0d6', 2.4);
  sun.position.copy(sunDir).multiplyScalar(300); sun.target.position.set(0, 40, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 160, bottom: -60, near: 10, far: 800 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  // ground: lawn + plaza
  const lawn = canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#5f9a3a'; c.fillRect(0, 0, w, h); speckle(c, w, h, 9000, ['#6aa842', '#558c33', '#76b34c', '#4d8230'], 0.8, 2.5, 4); }, { repeat: true });
  lawn.repeat.set(120, 120);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ map: lawn, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const pave = canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#b8b2a5'; c.fillRect(0, 0, w, h); c.strokeStyle = '#9d9689'; c.lineWidth = 2; for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, h); c.stroke(); c.beginPath(); c.moveTo(0, i * 64); c.lineTo(w, i * 64); c.stroke(); } }, { repeat: true });
  pave.repeat.set(16, 16);
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(130, 0.4, 130), new THREE.MeshStandardMaterial({ map: pave, roughness: 0.7 }));
  plaza.position.y = 0.2; plaza.receiveShadow = true; scene.add(plaza);
  const path = new THREE.Mesh(new THREE.PlaneGeometry(10, 400), new THREE.MeshStandardMaterial({ map: pave, roughness: 0.7 }));
  path.rotation.x = -Math.PI / 2; path.position.set(0, 0.05, 260); scene.add(path);

  // monument
  const marble = new THREE.MeshStandardMaterial({ color: '#f1ece1', roughness: 0.55 });
  const marbleShade = new THREE.MeshStandardMaterial({ color: '#e2dccf', roughness: 0.6 });
  const gold = new THREE.MeshStandardMaterial({ color: '#ffc94f', metalness: 1, roughness: 0.22, emissive: '#5a3500', emissiveIntensity: 0.4 });
  const mon = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(46, 3, 46), marbleShade); base.position.y = 1.9; base.castShadow = base.receiveShadow = true; mon.add(base);
  const base2 = new THREE.Mesh(new THREE.BoxGeometry(42, 5, 42), marble); base2.position.y = 5.9; base2.castShadow = base2.receiveShadow = true; mon.add(base2);
  mon.add(frustum(31, 22, 8.5, 8.4, marble));
  const rim = new THREE.Mesh(new THREE.BoxGeometry(44.5, 0.8, 44.5), marbleShade); rim.position.y = 17.2; rim.castShadow = true; mon.add(rim);
  mon.add(frustum(4.1, 6.1, 97, 17.6, marble));
  mon.add(frustum(7.6, 4.0, 3.2, 112.5, marble));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(11, 2.4, 11), marble); deck.position.y = 116.9; deck.castShadow = true; mon.add(deck);
  mon.add(frustum(2.2, 3.4, 2.4, 118.1, marbleShade));
  // flame
  const fpts = [];
  const prof = [[0, 0], [2.4, 0.4], [2.9, 1.8], [2.7, 3.8], [2.2, 6], [1.6, 8.5], [1.0, 11], [0.45, 13], [0, 14.5]];
  const curve = new THREE.SplineCurve(prof.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const p of curve.getPoints(40)) fpts.push(new THREE.Vector2(Math.max(p.x, 0.001), p.y));
  const fg = new THREE.LatheGeometry(fpts, 48);
  const pp = fg.attributes.position, v = new V3();
  for (let i = 0; i < pp.count; i++) {
    v.fromBufferAttribute(pp, i);
    const y = v.y, th = Math.atan2(v.z, v.x), rad = Math.hypot(v.x, v.z);
    const k = y / 14.5;
    const nr = rad * (1 + 0.38 * Math.sin(th * 5 + y * 0.9) * k + 0.15 * (fbm3(v.x * 0.5, y * 0.4, v.z * 0.5) - 0.5));
    const tw = th + y * 0.14;
    v.set(Math.cos(tw) * nr + Math.sin(k * 2.2) * 0.9 * k, y, Math.sin(tw) * nr);
    pp.setXYZ(i, v.x, v.y, v.z);
  }
  fg.computeVertexNormals();
  const flame = new THREE.Mesh(fg, gold); flame.position.y = 120.4; flame.castShadow = true; mon.add(flame);
  scene.add(mon);

  // lamp posts around plaza
  const lampM = new THREE.MeshStandardMaterial({ color: '#2d3a3a', roughness: 0.5, metalness: 0.4 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6, 6), lampM); p.position.set(Math.cos(a) * 60, 3, Math.sin(a) * 60); scene.add(p);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshStandardMaterial({ color: '#f4f2ea' })); h.position.set(Math.cos(a) * 60, 6.2, Math.sin(a) * 60); scene.add(h);
  }
  // tiny people on plaza
  for (let i = 0; i < 40; i++) {
    const a = r() * TAU, d = 30 + r() * 30;
    const p = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.0, 3, 6), new THREE.MeshStandardMaterial({ color: ['#e8e2d4', '#c0392b', '#2c3e70', '#f0c419', '#2fa84f', '#222'][i % 6] }));
    p.position.set(Math.cos(a) * d, 1.2, Math.sin(a) * d); scene.add(p);
  }

  // park trees (rings) + city far away
  const tl = [];
  for (let i = 0; i < 110; i++) {
    const a = r() * TAU, d = 90 + r() * 260;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.abs(x - 15) < 16 && z > 80) continue;
    tl.push({ x, z, s: 5 + r() * 4, h: 5 + r() * 4 });
  }
  scene.add(makeTrees(tl, { seed: 8, leaf: ['#3f7d2c', '#4f9334', '#2e6626', '#64a83e', '#3a7330'] }));
  const cityM = new THREE.MeshStandardMaterial({ color: '#b9c6d3', roughness: 0.8 });
  for (let i = 0; i < 60; i++) {
    const a = r() * TAU, d = 700 + r() * 600, h = 40 + r() * 160, w = 20 + r() * 40;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), cityM); b.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d); scene.add(b);
  }

  // foreground framing trees (close to camera, cel shaded leaves)
  const grad = toonGradient([0.4, 0.72, 1.0]);
  const fgLeaf = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: grad });
  const swayU = addSway(fgLeaf, 0.02, 1.4, 0.15);
  const leafGeo = new THREE.IcosahedronGeometry(1, 1);
  const fgTrees = new THREE.Group();
  const leafCols = ['#2f6a25', '#3f8030', '#4f9a36', '#6cb446', '#285a22'];
  const clusters = [[-26, 22, 156, 13], [34, 26, 150, 14], [-18, 30, 168, 9], [26, 32, 166, 8]];
  const Mx = new THREE.Matrix4(), C = new THREE.Color();
  const total = clusters.length * 90;
  const leaves = new THREE.InstancedMesh(leafGeo, fgLeaf, total);
  let li = 0;
  for (const [cx, cy, cz, cs] of clusters) {
    for (let k = 0; k < 90; k++) {
      const a = r() * TAU, b = Math.acos(2 * r() - 1), rr = cs * Math.cbrt(r());
      const p = new V3(cx + Math.sin(b) * Math.cos(a) * rr, cy + Math.cos(b) * rr * 0.6, cz + Math.sin(b) * Math.sin(a) * rr * 0.6);
      const s = 0.9 + r() * 1.6;
      Mx.compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new V3(s, s * 0.45, s));
      leaves.setMatrixAt(li, Mx); C.set(leafCols[Math.floor(r() * leafCols.length)]); leaves.setColorAt(li, C); li++;
    }
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.0, cy + 2, 8), new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 0.9 }));
    trunk.position.set(cx + (cx < 0 ? -4 : 4), (cy + 2) / 2 - 2, cz); fgTrees.add(trunk);
  }
  leaves.castShadow = true;
  fgTrees.add(leaves);
  scene.add(fgTrees);
  // flower bed in the near foreground
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 6, 4), new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: grad }), 500);
  for (let i = 0; i < 500; i++) {
    Mx.makeTranslation(lerp(-20, 50, r()), 0.45 + r() * 0.3, 168 + r() * 14);
    flowers.setMatrixAt(i, Mx); C.set(['#e8344a', '#ffd23a', '#ff7aa8', '#ffffff', '#ff8a2a'][Math.floor(r() * 5)]); flowers.setColorAt(i, C);
  }
  scene.add(flowers);
  const bush = new THREE.InstancedMesh(leafGeo, fgLeaf, 160);
  for (let i = 0; i < 160; i++) {
    const s = 0.8 + r() * 1.3;
    Mx.compose(new V3(lerp(-40, 60, r()), 0.4, 165 + r() * 20), new THREE.Quaternion(), new V3(s * 1.4, s * 0.8, s));
    bush.setMatrixAt(i, Mx); C.set(leafCols[Math.floor(r() * leafCols.length)]); bush.setColorAt(i, C);
  }
  scene.add(bush);

  // birds
  const birds = [];
  const wingM = new THREE.MeshBasicMaterial({ color: '#2a2d33', side: THREE.DoubleSide, fog: true });
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Group();
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.3, 0, 0, 0.3, 1.6, 0, 0], 3));
    const L = new THREE.Mesh(wg, wingM), R = new THREE.Mesh(wg, wingM); R.scale.x = -1;
    g.add(L, R);
    g.scale.setScalar(1.2);
    birds.push({ g, L, R, ph: r() * TAU, off: new V3((r() - 0.5) * 30, 75 + r() * 25, (r() - 0.5) * 30) });
    scene.add(g);
  }

  return {
    scene, camera,
    grade: { exposure: 0.88, bloom: 0.3, threshold: 1.0, sat: 1.18, contrast: 1.04, tone: 0.9, vig: 0.55 },
    update(lt, t) {
      const u = Math.min(lt / 4.6, 1), e = easeInOut(u);
      const s = shake(lt, 0.15, 13);
      camera.position.set(lerp(14, 8, e) + s.x, lerp(3, 12, e) + s.y, lerp(205, 190, e));
      camera.lookAt(0, lerp(58, 66, e), 0);
      swayU.value = t;
      fgTrees.rotation.z = Math.sin(t * 0.9) * 0.004;
      for (const b of birds) {
        const p = b.off.clone().add(new V3(-60 + lt * 14, Math.sin(lt * 1.3 + b.ph) * 1.5, 40));
        b.g.position.copy(p);
        b.g.rotation.y = -0.3;
        const f = Math.sin(t * 11 + b.ph) * 0.6;
        b.L.rotation.z = f; b.R.rotation.z = -f;
      }
      sky.userData.update(t, camera);
    },
  };
}
