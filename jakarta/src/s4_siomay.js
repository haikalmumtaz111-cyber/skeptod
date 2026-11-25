// Shot 4: steaming pot of siomay on a wooden table
import * as THREE from 'three';
import { V3, canvasTex, rng, lerp, shake, lumpy, noiseColors, makeParticles, glow, bokehTex, easeInOut, TAU, mergeGeometries } from './lib.js';

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1c130d');
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(36, ctx.W / ctx.H, 0.01, 30);
  const r = rng(41);

  // wood table
  const wood = canvasTex(1024, 1024, (c, w, h) => {
    const planks = 5, pw = w / planks;
    for (let p = 0; p < planks; p++) {
      const base = ['#7a4f2d', '#6c4426', '#83552f', '#704727', '#7d5130'][p];
      c.fillStyle = base; c.fillRect(p * pw, 0, pw, h);
      for (let i = 0; i < 90; i++) {
        c.strokeStyle = `rgba(${r() < 0.5 ? '40,22,10' : '160,110,70'},${0.08 + r() * 0.18})`;
        c.lineWidth = 1 + r() * 3;
        c.beginPath(); const x = p * pw + r() * pw;
        c.moveTo(x, 0);
        for (let y = 0; y <= h; y += 64) c.lineTo(x + Math.sin(y * 0.01 + i) * 6, y);
        c.stroke();
      }
      c.fillStyle = 'rgba(20,10,5,0.8)'; c.fillRect(p * pw, 0, 4, h);
    }
  }, { repeat: true });
  wood.repeat.set(2, 2);
  const table = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.5, metalness: 0 }));
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  // lights
  scene.add(new THREE.HemisphereLight('#ffe9cf', '#2a1a10', 0.35));
  const key = new THREE.SpotLight('#ffe2b8', 3.2, 4, 0.7, 0.6, 1.5);
  key.position.set(-0.7, 1.4, 0.4); key.target.position.set(0, 0.05, 0);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0002; key.shadow.radius = 4;
  scene.add(key, key.target);
  const rimL = new THREE.DirectionalLight('#bcd6ff', 0.9); rimL.position.set(0.8, 0.6, -1.2); scene.add(rimL);
  const fill = new THREE.PointLight('#ff9a50', 0.12, 2); fill.position.set(0.5, 0.3, 0.6); scene.add(fill);

  // steel pot
  const prof = [[0, 0.004], [0.13, 0.004], [0.148, 0.014], [0.158, 0.04], [0.161, 0.105], [0.171, 0.114], [0.172, 0.122], [0.165, 0.124], [0.157, 0.118], [0.153, 0.105], [0.15, 0.04], [0.14, 0.018], [0.12, 0.012], [0, 0.012]].map(([x, y]) => new THREE.Vector2(x, y));
  const steel = new THREE.MeshStandardMaterial({ color: '#d4d9de', metalness: 1, roughness: 0.2 });
  const pot = new THREE.Mesh(new THREE.LatheGeometry(prof, 96), steel);
  pot.castShadow = true; pot.receiveShadow = true;
  scene.add(pot);
  for (const s of [-1, 1]) {
    const hdl = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.0055, 10, 24, Math.PI), steel);
    hdl.position.set(s * 0.17, 0.098, 0); hdl.rotation.set(0, s > 0 ? 0 : Math.PI, -Math.PI / 2 * s * 0 ); hdl.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    hdl.castShadow = true; scene.add(hdl);
  }
  // broth surface
  const broth = new THREE.Mesh(new THREE.CircleGeometry(0.152, 48), new THREE.MeshStandardMaterial({ color: '#8a6a3a', roughness: 0.15, metalness: 0.1 }));
  broth.rotation.x = -Math.PI / 2; broth.position.y = 0.055; scene.add(broth);

  // food
  const mk = (geo, c1, c2, f, rough = 0.55) => ({ geo: noiseColors(geo, c1, c2, f, r() * 10), mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough }) });
  const siomayGeo = () => { const g = lumpy(new THREE.CylinderGeometry(0.02, 0.023, 0.026, 18, 4), 0.0022, 110, r() * 9); return g; };
  const types = [
    { n: 18, make: () => mk(siomayGeo(), '#cfc49b', '#a49870', 90), carrot: true },
    { n: 8, make: () => mk(lumpy(new THREE.BoxGeometry(0.042, 0.03, 0.036, 3, 3, 3), 0.0016, 120, r() * 9), '#f2ead6', '#d9cdb0', 80, 0.45) },
    { n: 7, make: () => mk(lumpy(new THREE.BoxGeometry(0.04, 0.032, 0.036, 3, 3, 3), 0.0025, 110, r() * 9), '#c5863f', '#8e5523', 70, 0.5) },
    { n: 8, make: () => { const g = new THREE.SphereGeometry(0.0185, 24, 16); g.scale(1, 1.32, 1); return { geo: g, mat: new THREE.MeshStandardMaterial({ color: '#f7f4ee', roughness: 0.28 }) }; } },
    { n: 7, make: () => mk(lumpy(new THREE.IcosahedronGeometry(0.022, 3), 0.004, 60, r() * 9), '#e6c75c', '#c49a3a', 60, 0.5) },
    { n: 7, make: () => mk(lumpy(new THREE.CylinderGeometry(0.019, 0.019, 0.042, 16, 5), 0.0032, 95, r() * 9), '#b5d06e', '#6f9a3c', 70, 0.5) },
    { n: 5, make: () => mk(lumpy(new THREE.CylinderGeometry(0.021, 0.021, 0.022, 20, 2), 0.0028, 140, r() * 9), '#76ad40', '#4f7f2a', 50, 0.4) },
  ];
  const placed = [];
  const carrotM = new THREE.MeshStandardMaterial({ color: '#f06a24', roughness: 0.4 });
  const order = [];
  types.forEach((t, i) => { for (let k = 0; k < t.n; k++) order.push(i); });
  order.sort(() => r() - 0.5);
  for (const ti of order) {
    let p = null;
    for (let tries = 0; tries < 60; tries++) {
      const a = r() * TAU, rad = Math.sqrt(r()) * 0.125;
      const cand = new V3(Math.cos(a) * rad, 0, Math.sin(a) * rad);
      const layer = placed.filter((q) => q.distanceTo(cand) < 0.034).length;
      if (layer > 1) continue;
      cand.y = 0.065 + 0.035 * (1 - (rad / 0.125) ** 2) + layer * 0.022;
      p = cand; break;
    }
    if (!p) continue;
    placed.push(p);
    const { geo, mat } = types[ti].make();
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(p);
    m.rotation.set((r() - 0.5) * 1.2, r() * TAU, (r() - 0.5) * 1.2);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    if (types[ti].carrot) { const cr = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 6), carrotM); cr.position.set(0, 0.014, 0); m.add(cr); }
  }

  // peanut sauce bowl + spoon + iced tea
  const bowlProf = [[0, 0.002], [0.05, 0.002], [0.07, 0.02], [0.078, 0.038], [0.074, 0.039], [0.066, 0.022], [0.048, 0.008], [0, 0.008]].map(([x, y]) => new THREE.Vector2(x, y));
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(bowlProf, 48), new THREE.MeshStandardMaterial({ color: '#f1ede4', roughness: 0.25 }));
  bowl.position.set(0.3, 0, 0.13); bowl.castShadow = true; scene.add(bowl);
  const sauce = new THREE.Mesh(new THREE.CircleGeometry(0.066, 40), new THREE.MeshStandardMaterial({ color: '#7a3e18', roughness: 0.2 }));
  sauce.rotation.x = -Math.PI / 2; sauce.position.set(0.3, 0.028, 0.13); scene.add(sauce);
  const sauceSwirl = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.028, 32), new THREE.MeshStandardMaterial({ color: '#4a1f0a', roughness: 0.2 }));
  sauceSwirl.rotation.x = -Math.PI / 2; sauceSwirl.position.set(0.31, 0.0285, 0.125); scene.add(sauceSwirl);
  const spoon = new THREE.Group();
  const sh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.003, 0.012), steel); sh.position.x = 0.075; spoon.add(sh);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 8), steel); head.scale.set(1.3, 0.2, 1); spoon.add(head);
  spoon.position.set(0.2, 0.006, 0.26); spoon.rotation.y = -0.5; scene.add(spoon);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.033, 0.13, 32, 1, true), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.05, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  glass.position.set(-0.27, 0.065, -0.18); scene.add(glass);
  const tea = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.031, 0.1, 32), new THREE.MeshStandardMaterial({ color: '#9a3c0c', roughness: 0.1, transparent: true, opacity: 0.85, emissive: '#3a0e00', emissiveIntensity: 0.5 }));
  tea.position.set(-0.27, 0.052, -0.18); scene.add(tea);
  for (let i = 0; i < 4; i++) { const ice = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: '#e8f4ff', roughness: 0.05, transparent: true, opacity: 0.7 })); ice.position.set(-0.27 + (r() - 0.5) * 0.03, 0.095 + r() * 0.01, -0.18 + (r() - 0.5) * 0.03); ice.rotation.set(r(), r(), r()); scene.add(ice); }

  // background bokeh (street lights far away)
  for (let i = 0; i < 18; i++) {
    const b = glow(['#ffb35a', '#ffd08a', '#9fd0ff', '#ff7a4a'][i % 4], 0.5 + r() * 0.6, 0.15 + r() * 0.25, bokehTex());
    b.position.set((r() - 0.5) * 3, 0.25 + r() * 0.6, -1.4 - r() * 1.2);
    scene.add(b);
  }

  // steam
  const steam = makeParticles({ count: 70, life: 3.2, spread: new V3(0.26, 0.02, 0.26), vel: new V3(0.01, 0.075, 0), swirl: 0.05, size: [0.06, 0.22], color: '#ffffff', opacity: 0.14, puff: true, seed: 4 });
  steam.position.set(0, 0.11, 0);
  scene.add(steam);

  return {
    scene, camera,
    grade: { exposure: 0.95, bloom: 0.3, threshold: 1.0, sat: 1.2, contrast: 1.05, tone: 0.8, vig: 0.7 },
    update(lt, t) {
      const u = Math.min(lt / 3.8, 1), e = easeInOut(u);
      const a = lerp(0.35, 0.75, e), rad = lerp(0.58, 0.46, e), hgt = lerp(0.44, 0.36, e);
      const s = shake(lt, 0.002, 7);
      camera.position.set(Math.sin(a) * rad + s.x, hgt + s.y, Math.cos(a) * rad);
      camera.lookAt(0.015, 0.07, 0);
      steam.userData.update(t, camera, ctx.H);
    },
  };
}
