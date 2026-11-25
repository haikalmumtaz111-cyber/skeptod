// Shot 3: hand holding a phone on the platform, background blurred
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { V3, canvasTex, rng, lerp, shake, capsuleBetween, addOutline, toonGradient, TAU } from './lib.js';

function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }

export default function (ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, ctx.W / ctx.H, 0.01, 50);
  const r = rng(31);

  // blurred platform background painted on canvas
  const bg = canvasTex(1600, 900, (c, w, h) => {
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const t = tmp.getContext('2d');
    let g = t.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f3efe6'); g.addColorStop(0.32, '#d9d3c6'); g.addColorStop(0.36, '#a9a49a'); g.addColorStop(0.6, '#bdb7ad'); g.addColorStop(1, '#d6d0c4');
    t.fillStyle = g; t.fillRect(0, 0, w, h);
    // windows / daylight
    for (let i = 0; i < 7; i++) { t.fillStyle = 'rgba(255,252,240,0.9)'; t.fillRect(i * 250 - 40, 40, 170, 200); }
    // bench
    t.fillStyle = '#b6824a'; t.fillRect(820, 330, 700, 46); t.fillRect(820, 300, 700, 22);
    t.fillStyle = '#6d5236'; t.fillRect(850, 376, 26, 120); t.fillRect(1460, 376, 26, 120);
    t.fillStyle = '#b07b44'; t.fillRect(-60, 350, 520, 40);
    // floor reflections
    g = t.createLinearGradient(0, 420, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.0)'); g.addColorStop(0.4, 'rgba(255,250,235,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0.0)');
    t.fillStyle = g; t.fillRect(0, 420, w, h - 420);
    // yellow tactile line
    t.fillStyle = '#e2b62c';
    t.beginPath(); t.moveTo(0, 690); t.lineTo(w, 560); t.lineTo(w, 610); t.lineTo(0, 760); t.fill();
    // people blobs
    for (let i = 0; i < 3; i++) { t.fillStyle = ['#5a6478', '#8a7a6a', '#6a6a70'][i]; const x = 120 + i * 300 + r() * 80; t.fillRect(x, 150 + r() * 40, 70, 300); t.beginPath(); t.arc(x + 35, 135, 30, 0, TAU); t.fill(); }
    c.filter = 'blur(22px)';
    c.drawImage(tmp, 0, 0);
    c.filter = 'none';
    // bokeh highlights
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * h * 0.5, rad = 14 + r() * 30;
      const gg = c.createRadialGradient(x, y, 0, x, y, rad);
      gg.addColorStop(0, 'rgba(255,250,230,0.25)'); gg.addColorStop(0.85, 'rgba(255,250,230,0.35)'); gg.addColorStop(1, 'rgba(255,250,230,0)');
      c.fillStyle = gg; c.beginPath(); c.arc(x, y, rad, 0, TAU); c.fill();
    }
  });
  const bgM = new THREE.MeshBasicMaterial({ map: bg, color: new THREE.Color(0.74, 0.72, 0.7) });
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.03), bgM);
  bgMesh.position.set(0, 0, -3);
  scene.add(bgMesh);

  scene.add(new THREE.HemisphereLight('#fff6e6', '#6a6f78', 0.9));
  const key = new THREE.DirectionalLight('#fff0dc', 1.7); key.position.set(-1.5, 2, 1.5); scene.add(key);
  const rim = new THREE.DirectionalLight('#d8ecff', 1.3); rim.position.set(1.5, 0.6, -1.4); scene.add(rim);
  scene.environment = ctx.envTex; scene.environmentIntensity = 0.6;

  // screen texture
  const screen = canvasTex(660, 1420, (c, w, h) => {
    let g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#26355f'); g.addColorStop(0.45, '#8f5a7e'); g.addColorStop(0.75, '#f0a067'); g.addColorStop(1, '#ffd29a');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    // skyline silhouette with Monas
    c.fillStyle = '#2a2140';
    c.beginPath(); c.moveTo(0, h);
    let x = 0;
    while (x < w) { const bw = 30 + r() * 60, bh = 80 + r() * 200; c.lineTo(x, h - bh); c.lineTo(x + bw, h - bh); x += bw; }
    c.lineTo(w, h); c.fill();
    c.fillRect(w * 0.62, h - 520, 26, 420); c.fillRect(w * 0.62 - 14, h - 530, 54, 16);
    c.beginPath(); c.moveTo(w * 0.62 + 13, h - 590); c.quadraticCurveTo(w * 0.62 + 36, h - 545, w * 0.62 + 13, h - 530); c.quadraticCurveTo(w * 0.62 - 8, h - 550, w * 0.62 + 13, h - 590); c.fillStyle = '#ffcf6a'; c.fill();
    c.fillStyle = '#2a2140'; c.fillRect(w * 0.62 - 70, h - 110, 166, 30);
    // status bar
    c.fillStyle = '#fff'; c.font = '600 30px Inter'; c.fillText('17.42', 44, 62);
    c.fillRect(w - 110, 40, 56, 26); c.fillRect(w - 52, 47, 5, 12);
    c.font = '500 28px Inter'; c.fillText('4G', w - 170, 64);
    // clock
    c.textAlign = 'center';
    c.font = '500 34px Inter'; c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillText('Rabu, 25 November', w / 2, 210);
    c.font = '200 190px Inter'; c.fillStyle = '#fff'; c.fillText('17.42', w / 2, 400);
    c.font = '500 28px Inter'; c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillText('Jakarta  26°  ·  hujan ringan', w / 2, 460);
    c.textAlign = 'left';
    // notifications
    const card = (y, col, icon, app, ttl, body, time) => {
      c.fillStyle = 'rgba(255,255,255,0.78)'; rr(c, 34, y, w - 68, 170, 34); c.fill();
      c.fillStyle = col; rr(c, 60, y + 30, 64, 64, 16); c.fill();
      c.fillStyle = '#fff'; c.font = '800 24px Inter'; c.textAlign = 'center'; c.fillText(icon, 92, y + 71); c.textAlign = 'left';
      c.fillStyle = '#555'; c.font = '500 22px Inter'; c.fillText(app, 144, y + 48); c.fillText(time, w - 150, y + 48);
      c.fillStyle = '#111'; c.font = '700 27px Inter'; c.fillText(ttl, 144, y + 86);
      c.fillStyle = '#222'; c.font = '400 25px Inter'; c.fillText(body, 144, y + 124);
    };
    card(540, '#d7232e', 'KRL', 'COMMUTER LINE', 'Kereta tujuan Bogor', 'Tiba di jalur 3, 2 menit lagi', 'baru saja');
    card(730, '#2e9e5a', 'Ibu', 'PESAN', 'Ibu', 'udah di stasiun? jgn lupa makan', '3 mnt lalu');
    card(920, '#e27b1f', 'Rp', 'DOMPET', 'Saldo kartu', 'Sisa saldo Rp23.500', '1 jam lalu');
    // bottom
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.arc(110, h - 130, 48, 0, TAU); c.fill(); c.beginPath(); c.arc(w - 110, h - 130, 48, 0, TAU); c.fill();
    c.fillStyle = '#fff'; rr(c, w / 2 - 110, h - 40, 220, 10, 5); c.fill();
    // rounded mask
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = '#000'; rr(c, 0, 0, w, h, 70); c.fill();
    c.globalCompositeOperation = 'destination-over';
    c.fillStyle = '#05070a'; c.fillRect(0, 0, w, h);
  });

  const phone = new THREE.Group();
  const PW = 0.0715, PH = 0.1475, PD = 0.0082;
  const body = new THREE.Mesh(new RoundedBoxGeometry(PW, PH, PD, 5, 0.0085), new THREE.MeshStandardMaterial({ color: '#2a2f38', metalness: 0.7, roughness: 0.28 }));
  phone.add(body);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(PW - 0.0035, PH - 0.0035), new THREE.MeshBasicMaterial({ map: screen, color: new THREE.Color(0.78, 0.78, 0.8) }));
  scr.position.z = PD / 2 + 0.0002;
  phone.add(scr);
  // glare streak on glass
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(PW * 0.5, PH * 1.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.18, 0.18, 0.2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  glare.position.set(-0.012, 0.01, PD / 2 + 0.0005); glare.rotation.z = -0.6; glare.scale.y = 0.5;

  // stylised hand (cel shaded + ink outline)
  const grad = toonGradient([0.62, 0.84, 1.0]);
  const skin = new THREE.MeshToonMaterial({ color: '#e3a47e', gradientMap: grad });
  const sleeveM = new THREE.MeshToonMaterial({ color: '#2d3a5c', gradientMap: grad });
  const hand = new THREE.Group();
  const OUT = 0.0011, INK = '#5a2f22';
  const part = (m) => { addOutline(m, OUT, INK); hand.add(m); return m; };
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), skin); palm.scale.set(0.043, 0.056, 0.016); palm.position.set(0.008, -0.05, -0.018); part(palm);
  const thenar = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), skin); thenar.scale.set(0.02, 0.03, 0.016); thenar.position.set(0.033, -0.074, -0.004); part(thenar);
  part(capsuleBetween(new V3(0.016, -0.09, -0.022), new V3(0.075, -0.24, -0.035), 0.027, skin));
  part(capsuleBetween(new V3(0.08, -0.215, -0.04), new V3(0.15, -0.42, -0.06), 0.04, sleeveM));
  // thumb on the right edge, over the glass
  const th1 = part(capsuleBetween(new V3(0.034, -0.072, -0.004), new V3(0.043, -0.043, 0.006), 0.0115, skin));
  const thumbTip = new THREE.Group(); hand.add(thumbTip);
  thumbTip.position.set(0.043, -0.043, 0.006);
  const th2 = capsuleBetween(new V3(0, 0, 0), new V3(-0.007, 0.026, 0.004), 0.0102, skin); addOutline(th2, OUT, INK); thumbTip.add(th2);
  const nail = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshToonMaterial({ color: '#f2c4b0', gradientMap: grad }));
  nail.scale.set(0.006, 0.008, 0.002); nail.position.set(-0.0065, 0.024, 0.013); thumbTip.add(nail);
  // fingers wrapping the left edge
  for (let k = 0; k < 4; k++) {
    const y = 0.022 - k * 0.0235, rr0 = k === 3 ? 0.0072 : 0.0086;
    const a = new V3(-0.004, y, -0.02), b = new V3(-0.036, y + 0.003, -0.013), c = new V3(-0.0405, y + 0.005, 0.0012 - k * 0.0006);
    part(capsuleBetween(a, b, rr0, skin));
    part(capsuleBetween(b, c, rr0 * 0.93, skin));
  }
  phone.add(hand);
  scene.add(phone);

  return {
    scene, camera,
    grade: { exposure: 0.95, bloom: 0.25, threshold: 1.0, sat: 1.12, contrast: 1.02, tone: 0.8, vig: 0.5 },
    update(lt, t) {
      const s = shake(lt, 0.004, 5);
      camera.position.set(s.x, s.y, 0.02 - lt * 0.012);
      camera.lookAt(s.x * 0.3, s.y * 0.3, -1);
      phone.position.set(0.012, -0.004, -0.4);
      phone.rotation.set(-0.22 + Math.sin(lt * 0.9) * 0.02, 0.28 + Math.sin(lt * 0.6) * 0.03, 0.14);
      // thumb scroll
      const sc = Math.max(0, Math.sin((lt - 0.9) * 2.2)) * (lt > 0.9 && lt < 3.0 ? 1 : 0);
      thumbTip.rotation.set(-sc * 0.25, 0, sc * 0.3);
      bgMesh.position.x = -0.04 + lt * 0.02;
    },
  };
}
