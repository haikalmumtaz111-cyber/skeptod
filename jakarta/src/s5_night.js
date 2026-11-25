// Shot 5: Sudirman at blue hour, rain, wet road, towers
import * as THREE from 'three';
import { V3, makeSky, makeRain, canvasTex, rng, lerp, shake, glow, groundGlow, windowTex, buildingGeo, mergeGeometries, easeInOut, speckle } from './lib.js';

export function makeCar(color, r) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: '#10161d', metalness: 0.4, roughness: 0.1 });
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 4.4), paint); b.position.y = 0.6; g.add(b);
  const c = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.3), glass); c.position.set(0, 1.25, -0.2); g.add(c);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 2.0), paint); roof.position.set(0, 1.57, -0.2); g.add(roof);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.12;
  const camera = new THREE.PerspectiveCamera(46, ctx.W / ctx.H, 0.1, 5000);
  scene.fog = new THREE.FogExp2('#2c3355', 0.0014);
  const r = rng(51);

  const sky = makeSky({ top: '#0c1630', mid: '#1f2f58', hor: '#86708a', ground: '#2c3355', sunDir: new V3(-0.4, 0.03, -1), sunCol: '#ff9466', sunGlow: 0.45, cover: 0.44, cloudScale: 0.55, cloudLit: '#5a628c', cloudShade: '#1a2140', rim: 0.25, speed: 0.02 });
  scene.add(sky);
  scene.add(new THREE.HemisphereLight('#5d6fa8', '#1b1a22', 0.35));
  const moonish = new THREE.DirectionalLight('#9fb0ff', 0.4); moonish.position.set(-50, 100, 50); scene.add(moonish);

  // road (wet)
  const asphalt = canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#2a2c31'; c.fillRect(0, 0, w, h); speckle(c, w, h, 6000, ['#33363c', '#24262b', '#3a3d44', '#1d1f23'], 0.6, 2, 5); }, { repeat: true });
  asphalt.repeat.set(10, 300);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(30, 1600), new THREE.MeshStandardMaterial({ map: asphalt, color: '#5a5c62', roughness: 0.12, metalness: 0.35 }));
  road.rotation.x = -Math.PI / 2; road.position.z = -760; scene.add(road);
  const dashM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.7, 0.72) });
  const dashes = [];
  for (let z = 10; z > -900; z -= 9) for (const x of [-4.8, 4.8]) { const d = new THREE.PlaneGeometry(0.14, 3.5); d.rotateX(-Math.PI / 2); d.translate(x, 0.01, z); dashes.push(d); }
  scene.add(new THREE.Mesh(mergeGeometries(dashes), dashM));
  const median = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 1600), new THREE.MeshStandardMaterial({ color: '#5d5f63', roughness: 0.7 }));
  median.position.set(0, 0.15, -760); scene.add(median);
  const walkM = new THREE.MeshStandardMaterial({ color: '#4a4b50', roughness: 0.35, metalness: 0.2 });
  for (const s of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 1600), walkM); w.position.set(s * 19, 0.1, -760); scene.add(w); }

  // towers
  const variants = [
    windowTex(1, { cols: 10, rows: 26, lit: 0.45, facade: '#262b38', glass: '#11182a', warm: 0.75 }),
    windowTex(2, { cols: 8, rows: 22, lit: 0.55, facade: '#1d2230', glass: '#0d1322', warm: 0.35, litB: '#cfe6ff' }),
    windowTex(3, { cols: 14, rows: 30, lit: 0.3, facade: '#30323a', glass: '#161b28', warm: 0.85, mullion: 0.05 }),
  ];
  const geos = [[], [], []];
  const tops = [];
  for (let i = 0; i < 90; i++) {
    let x = (r() - 0.5) * 700, z = -40 - r() * 900;
    if (Math.abs(x) < 30) x += x < 0 ? -32 : 32;
    const far = Math.min(1, -z / 700);
    const w = 18 + r() * 26, d = 18 + r() * 22, h = 30 + r() * (90 + far * 170) * (r() < 0.25 ? 1.6 : 1);
    const v = i % 3, g = buildingGeo(w, h, d, variants[v], 2.0, 3.4, i);
    g.translate(x, 0, z); geos[v].push(g);
    if (h > 150) tops.push(new V3(x, h + 2, z));
  }
  // near street-side buildings lining the road
  for (let i = 0; i < 16; i++) for (const s of [-1, 1]) {
    const w = 16 + r() * 12, h = 18 + r() * 34, v = (i + (s > 0 ? 1 : 0)) % 3;
    const g = buildingGeo(14, h, w, variants[v], 1.6, 3.2, 200 + i * 2 + (s > 0 ? 1 : 0));
    g.translate(s * (31 + r() * 4), 0, -30 - i * 30); geos[v].push(g);
  }
  geos.forEach((gs, v) => {
    const m = new THREE.Mesh(mergeGeometries(gs), new THREE.MeshStandardMaterial({ map: variants[v].map, emissiveMap: variants[v].emi, emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.3, color: '#6a6f80' }));
    scene.add(m);
  });
  // curved glass tower on the right
  const bandTex = canvasTex(64, 512, (c, w, h) => { c.fillStyle = '#0f1626'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 16) { c.fillStyle = '#cfe2ff'; c.fillRect(0, y, w, 3); } }, { repeat: true, srgb: true });
  bandTex.repeat.set(30, 6);
  const curved = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 150, 64, 1, true, Math.PI * 0.9, Math.PI * 1.1), new THREE.MeshStandardMaterial({ color: '#2b3a55', emissiveMap: bandTex, emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.7, side: THREE.DoubleSide }));
  curved.position.set(68, 75, -78); scene.add(curved);
  // rooftop neon sign
  const signTex = canvasTex(1024, 200, (c, w, h) => { c.clearRect(0, 0, w, h); c.font = '800 150px Inter'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ff3b3b'; c.fillText('MERDEKA', w / 2, h / 2 + 6); });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, color: new THREE.Color(1.6, 1.6, 1.6), depthWrite: false }));
  sign.position.set(-62, 132, -150); sign.rotation.y = 0.3; scene.add(sign);
  const signBody = new THREE.Mesh(buildingGeo(42, 128, 30, variants[1], 3.3, 3.8, 77), new THREE.MeshStandardMaterial({ map: variants[1].map, emissiveMap: variants[1].emi, emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.3, color: '#6a6f80' }));
  signBody.position.set(-64, 0, -168); signBody.rotation.y = 0.3; scene.add(signBody);
  const blinkers = tops.map((p) => { const g = glow('#ff2a2a', 4, 6); g.position.copy(p); scene.add(g); return g; });

  // street lamps + wet reflections
  for (let z = -6; z > -520; z -= 26) for (const s of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 9, 6), new THREE.MeshStandardMaterial({ color: '#3a3c40', roughness: 0.6 }));
    pole.position.set(s * 15.5, 4.5, z); scene.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.12, 0.12), pole.material); arm.position.set(s * 14, 9, z); scene.add(arm);
    const g = glow('#ffb36b', 3.2, 4.5); g.position.set(s * 12.6, 8.85, z); scene.add(g);
    const rf = groundGlow('#ffae66', 0.9, 1.6, 16); rf.position.set(s * 12.2, 0.03, z + 7); scene.add(rf);
  }
  // traffic light
  const tl = new THREE.Group();
  const tlm = new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.5, metalness: 0.4 });
  const tp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6.2, 8), tlm); tp.position.y = 3.1; tl.add(tp);
  const tb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.25, 0.32), tlm); tb.position.set(0, 5.3, 0); tl.add(tb);
  const lens = (col, y, on) => { const l = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), new THREE.MeshBasicMaterial({ color: on ? new THREE.Color(col).multiplyScalar(8) : new THREE.Color(col).multiplyScalar(0.08) })); l.position.set(0, y, 0.17); tl.add(l); if (on) { const g = glow(col, 3, 2.4); g.position.set(0, y, 0.3); tl.add(g); } };
  lens('#ff2a1a', 5.7, true); lens('#ffb000', 5.3, false); lens('#18ff6a', 4.9, false);
  tl.position.set(-6.4, 0, -11); scene.add(tl);
  const tlr = groundGlow('#ff3a2a', 1.3, 1.2, 10); tlr.position.set(-6.2, 0.03, -5); scene.add(tlr);

  // traffic
  const cars = [];
  const paints = ['#d9dde2', '#16181c', '#7d8691', '#9b1d22', '#2c3f66', '#c9c3b6'];
  for (let i = 0; i < 26; i++) {
    const away = i % 2 === 0;
    const car = makeCar(paints[i % paints.length], r);
    const lane = away ? -(2.4 + (i % 4 < 2 ? 0 : 4.8)) : 2.4 + (i % 4 < 2 ? 0 : 4.8);
    const lightsCol = away ? '#ff2a20' : '#fff2d8';
    for (const sx of [-0.65, 0.65]) {
      const g = glow(lightsCol, away ? 2.2 : 3, away ? 0.9 : 1.5); g.position.set(sx, 0.75, 2.25); car.add(g);
    }
    const rf = groundGlow(lightsCol, away ? 0.7 : 0.8, 1.8, away ? 7 : 12); rf.position.set(0, -0.0, away ? 5 : 8); car.add(rf);
    scene.add(car);
    cars.push({ car, lane, away, z0: -r() * 500, sp: 9 + r() * 6 });
  }

  const rain = makeRain({ count: 9000, box: [50, 36, 50], speed: 19, len: 0.7, color: '#c8d6ff', opacity: 0.5, wind: [0.18, 0.05], additive: true });
  scene.add(rain);

  return {
    scene, camera,
    grade: { exposure: 0.95, bloom: 0.55, threshold: 0.95, radius: 0.45, sat: 1.15, contrast: 1.06, tone: 1.2, vig: 0.7, lift: [0, 0.005, 0.02] },
    update(lt, t) {
      const u = Math.min(lt / 4.4, 1), e = easeInOut(u);
      const s = shake(lt, 0.03, 9);
      camera.position.set(-1.2 + 1.2 * e + s.x, 1.45 + 1.4 * e + s.y, 8 - 7 * e);
      camera.lookAt(3 + s.x * 10, lerp(14, 48, e), -220);
      for (const c of cars) {
        const span = 540;
        let z = c.away ? c.z0 - c.sp * t : c.z0 + c.sp * t;
        z = ((z % span) + span) % span - span + 20;
        c.car.position.set(c.lane, 0, z);
      }
      const blink = Math.sin(t * 4) > 0.2 ? 1 : 0.15;
      blinkers.forEach((b) => { b.material.opacity = blink; });
      sky.userData.update(t, camera);
      rain.userData.update(t, camera);
    },
  };
}
