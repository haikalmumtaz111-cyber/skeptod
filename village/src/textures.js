// Procedural canvas textures (no external assets)
import * as THREE from 'three';
import { RNG, fbm2, simplex2, clamp } from './noise.js';

function cnv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function tex(c, { srgb = true, repeat = true, mips = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
function pixels(w, h, fn) {
  const c = cnv(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn(x, y, out);
      const i = (y * w + x) * 4;
      d[i] = clamp(out[0], 0, 255); d[i + 1] = clamp(out[1], 0, 255); d[i + 2] = clamp(out[2], 0, 255); d[i + 3] = clamp(out[3], 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// tileable noise via torus mapping
function tnoise(x, y, w, h, freq, oct = 4) {
  const a = (x / w) * Math.PI * 2, b = (y / h) * Math.PI * 2;
  const r = freq / (Math.PI * 2);
  // 4D torus approximated by two 2D noises
  const n1 = fbm2(Math.cos(a) * r + 17.3, Math.sin(a) * r + Math.cos(b) * r * 0.37, oct);
  const n2 = fbm2(Math.sin(b) * r - 5.1, Math.cos(b) * r + Math.sin(a) * r * 0.29, oct);
  return (n1 + n2) * 0.5;
}

export function makeTextures() {
  const T = {};

  // ---------- wood grain (grain along V) ----------
  T.wood = tex(pixels(256, 512, (x, y, o) => {
    const u = x / 256, v = y / 512;
    const warp = fbm2(u * 3, v * 0.8, 3) * 2.2;
    const ring = Math.sin((u * 18 + warp) * Math.PI * 2);
    const fine = simplex2(x * 0.9, y * 0.02) * 0.5 + simplex2(x * 2.3, y * 0.05) * 0.3;
    const big = fbm2(u * 2, v * 2, 3);
    let g = 0.8 + 0.07 * ring + 0.06 * fine + 0.08 * big;
    // plank seams across u
    const seam = Math.abs(((u * 4) % 1) - 0.5) > 0.485 ? 0.6 : 1;
    g *= seam;
    o[0] = g * 255; o[1] = g * 246; o[2] = g * 232;
  }));

  // ---------- plaster ----------
  T.plaster = tex(pixels(256, 256, (x, y, o) => {
    const n = tnoise(x, y, 256, 256, 6, 4);
    const f = simplex2(x * 0.3, y * 0.3) * 0.5;
    const g = 0.93 + 0.05 * n + 0.015 * f;
    o[0] = g * 255; o[1] = g * 250; o[2] = g * 240;
  }));

  // ---------- stone ----------
  T.stone = tex(pixels(256, 256, (x, y, o) => {
    const n = tnoise(x, y, 256, 256, 5, 5);
    const m = tnoise(x + 50, y + 90, 256, 256, 18, 3);
    const speck = simplex2(x * 0.9, y * 0.9) > 0.55 ? 0.08 : 0;
    const g = 0.72 + 0.16 * n + 0.07 * m + speck;
    o[0] = g * 250; o[1] = g * 248; o[2] = g * 242;
  }));

  // ---------- sakura bark (horizontal lenticels) ----------
  const rngB = new RNG(9);
  {
    const c = pixels(128, 256, (x, y, o) => {
      const n = fbm2(x * 0.05, y * 0.012, 4);
      const g = 0.55 + 0.25 * n + 0.1 * simplex2(x * 0.2, y * 0.6);
      o[0] = g * 255; o[1] = g * 240; o[2] = g * 235;
    });
    const ctx = c.getContext('2d');
    for (let i = 0; i < 260; i++) {
      const x = rngB.range(0, 128), y = rngB.range(0, 256), w = rngB.range(4, 16);
      ctx.fillStyle = `rgba(${200 + rngB.range(0, 40)},${185 + rngB.range(0, 30)},${170},${rngB.range(0.25, 0.55)})`;
      ctx.fillRect(x, y, w, rngB.range(1, 2.2));
      ctx.fillRect(x - 128, y, w, 1.5);
    }
    T.bark = tex(c);
  }

  // ---------- pine / generic bark (vertical plates) ----------
  T.barkRough = tex(pixels(128, 256, (x, y, o) => {
    const cell = Math.abs(simplex2(x * 0.08, y * 0.025));
    const n = fbm2(x * 0.04, y * 0.02, 4);
    const g = 0.45 + 0.35 * Math.pow(cell, 0.5) + 0.12 * n;
    o[0] = g * 255; o[1] = g * 235; o[2] = g * 220;
  }));

  // ---------- sakura blossom cluster card ----------
  T.blossom = blossomTexture(512, 1);
  T.blossomWeep = blossomTexture(512, 2);

  // ---------- generic leaves ----------
  T.leaves = leafTexture(256, 'broad');
  T.maple = leafTexture(256, 'maple');
  T.bambooLeaves = leafTexture(256, 'bamboo');
  T.pineNeedles = leafTexture(256, 'pine');

  // ---------- single falling petal ----------
  {
    const c = cnv(64, 64);
    const ctx = c.getContext('2d');
    ctx.translate(32, 34);
    const g = ctx.createRadialGradient(0, 20, 2, 0, 0, 34);
    g.addColorStop(0, '#f28fb0'); g.addColorStop(0.45, '#fbd3e1'); g.addColorStop(1, '#fff5f8');
    ctx.fillStyle = g;
    petalPath(ctx, 26, 24);
    ctx.fill();
    T.petal = tex(c, { repeat: false });
  }

  // ---------- soft dot ----------
  {
    const c = cnv(64, 64);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    T.dot = tex(c, { repeat: false, srgb: false });
  }

  // ---------- mist / smoke puff ----------
  {
    const c = pixels(128, 128, (x, y, o) => {
      const dx = (x - 64) / 64, dy = (y - 64) / 64;
      const r = Math.sqrt(dx * dx + dy * dy);
      const n = fbm2(x * 0.04, y * 0.04, 4) * 0.5 + 0.5;
      let a = clamp(1 - r, 0, 1);
      a = Math.pow(a, 1.6) * (0.45 + 0.75 * n);
      o[0] = 255; o[1] = 255; o[2] = 255; o[3] = clamp(a, 0, 1) * 255;
    });
    T.puff = tex(c, { repeat: false, srgb: false });
  }

  // ---------- shoji paper + kumiko grid (UV 0..1 per panel) ----------
  {
    const W = 128, H = 256;
    const c = pixels(W, H, (x, y, o) => {
      const n = simplex2(x * 0.15, y * 0.15) * 0.03 + simplex2(x * 0.03, y * 0.03) * 0.03;
      const g = 0.95 + n;
      o[0] = g * 255; o[1] = g * 246; o[2] = g * 226;
    });
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3b2a1c';
    const cols = 3, rows = 6;
    for (let i = 1; i < cols; i++) ctx.fillRect((i * W) / cols - 1.5, 0, 3, H);
    for (let j = 1; j < rows; j++) ctx.fillRect(0, (j * H) / rows - 1.5, W, 3);
    // lower solid wainscot (koshi-ita)
    ctx.fillStyle = '#4a3523';
    ctx.fillRect(0, H * 0.86, W, H * 0.14);
    ctx.fillStyle = '#2a1d13';
    ctx.fillRect(0, 0, W, 5); ctx.fillRect(0, H - 5, W, 5); ctx.fillRect(0, 0, 5, H); ctx.fillRect(W - 5, 0, 5, H);
    T.shoji = tex(c, { repeat: false });
  }

  // ---------- namako wall (kura) ----------
  {
    const S = 256;
    const c = pixels(S, S, (x, y, o) => {
      const u = (x + y) / S * 4, v = (x - y + S) / S * 4;
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      const line = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
      const n = simplex2(x * 0.1, y * 0.1) * 0.04;
      if (line < 0.08) {
        const k = 1 - line / 0.08;
        const g = 0.82 + 0.12 * k + n;
        o[0] = g * 255; o[1] = g * 252; o[2] = g * 245;
      } else {
        const g = 0.2 + n + 0.04 * simplex2(x * 0.02, y * 0.02);
        o[0] = g * 255; o[1] = g * 260; o[2] = g * 275;
      }
    });
    T.namako = tex(c);
  }

  // ---------- bamboo culm (U around, V along height; one node per V unit) ----------
  T.bamboo = tex(pixels(64, 256, (x, y, o) => {
    const v = y / 256;
    const stripe = 0.04 * Math.sin(x * 0.6) + 0.03 * simplex2(x * 0.3, y * 0.01);
    let g = 0.8 + stripe + 0.06 * Math.sin(v * Math.PI);
    let r = 0.55, gg = 0.72, b = 0.32;
    const node = Math.abs(v - 0.02);
    if (node < 0.025) { const k = 1 - node / 0.025; g += 0.18 * k; r += 0.1 * k; }
    if (v > 0.03 && v < 0.06) g -= 0.15;
    o[0] = r * g * 255; o[1] = gg * g * 255; o[2] = b * g * 255;
  }));

  // ---------- flower atlas 2x2: iris, nanohana, white, azalea ----------
  T.flowers = flowerAtlas(256);

  // ---------- water normal (tileable) ----------
  T.waterNormal = waterNormal(256);

  // ---------- foam / streak noise ----------
  T.foam = tex(pixels(256, 256, (x, y, o) => {
    const n = tnoise(x, y, 256, 256, 9, 4);
    const m = tnoise(x + 40, y + 70, 256, 256, 24, 3);
    const g = clamp((n * 0.5 + 0.5) * 1.3 - 0.35 + m * 0.25, 0, 1);
    o[0] = o[1] = o[2] = g * 255;
  }), { srgb: false });
  T.streak = tex(pixels(128, 256, (x, y, o) => {
    const a = (x / 128) * Math.PI * 2;
    const n = fbm2(Math.cos(a) * 3 + 1, Math.sin(a) * 3 + y * 0.004, 4);
    const m = fbm2(Math.cos(a) * 10, Math.sin(a) * 10 + y * 0.02, 3);
    const g = clamp(0.5 + 0.8 * n + 0.3 * m, 0, 1);
    o[0] = o[1] = o[2] = g * 255;
  }), { srgb: false });

  return T;
}

function petalPath(ctx, len, wid) {
  // sakura petal: obovate with notch at tip (tip points up, -y)
  ctx.beginPath();
  ctx.moveTo(0, len * 0.55);
  ctx.bezierCurveTo(wid * 0.55, len * 0.3, wid * 0.62, -len * 0.45, wid * 0.22, -len * 0.62);
  ctx.quadraticCurveTo(wid * 0.08, -len * 0.6, 0, -len * 0.46);
  ctx.quadraticCurveTo(-wid * 0.08, -len * 0.6, -wid * 0.22, -len * 0.62);
  ctx.bezierCurveTo(-wid * 0.62, -len * 0.45, -wid * 0.55, len * 0.3, 0, len * 0.55);
  ctx.closePath();
}

function blossomTexture(S, variant) {
  const c = cnv(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(variant * 101 + 7);
  const flowers = [];
  const N = variant === 2 ? 150 : 115;
  for (let i = 0; i < N; i++) {
    // distribute in a soft irregular blob (variant 2: elongated vertical strand)
    let x, y;
    if (variant === 2) {
      x = S * 0.5 + rng.gauss() * S * 0.13;
      y = rng.range(S * 0.05, S * 0.95);
    } else {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * S * 0.4;
      x = S * 0.5 + Math.cos(a) * r; y = S * 0.5 + Math.sin(a) * r * 0.92;
    }
    flowers.push({ x, y, r: rng.range(S * 0.028, S * 0.046), rot: rng.range(0, 7), depth: rng.next(), bud: rng.chance(0.08) });
  }
  flowers.sort((a, b) => a.depth - b.depth);
  // a few twig hints
  ctx.strokeStyle = 'rgba(70,40,40,0.9)';
  ctx.lineWidth = S * 0.008;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    const x0 = S * 0.5 + rng.range(-0.25, 0.25) * S, y0 = S * 0.5 + rng.range(-0.25, 0.25) * S;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + rng.range(-0.2, 0.2) * S, y0 + rng.range(-0.2, 0.2) * S);
    ctx.stroke();
  }
  const palettes = [
    ['#fff4f7', '#fbd9e4', '#f2a9c2'],
    ['#fde7ee', '#f7c2d3', '#e98bab'],
    ['#ffffff', '#fbe4ec', '#f4b8cb'],
    ['#fbdbe6', '#f3abc4', '#dd7397'],
  ];
  for (const f of flowers) {
    const shade = 0.72 + 0.28 * f.depth;
    const pal = palettes[Math.floor(rng.next() * palettes.length)];
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    ctx.globalAlpha = 1;
    if (f.bud) {
      ctx.fillStyle = pal[2];
      ctx.beginPath(); ctx.ellipse(0, 0, f.r * 0.45, f.r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      continue;
    }
    for (let p = 0; p < 5; p++) {
      ctx.save();
      ctx.rotate((p / 5) * Math.PI * 2);
      ctx.translate(0, -f.r * 0.55);
      const g = ctx.createLinearGradient(0, f.r * 0.6, 0, -f.r * 0.6);
      g.addColorStop(0, mulColor(pal[2], shade));
      g.addColorStop(0.45, mulColor(pal[1], shade));
      g.addColorStop(1, mulColor(pal[0], shade));
      ctx.fillStyle = g;
      petalPath(ctx, f.r * 1.15, f.r * 1.0);
      ctx.fill();
      ctx.restore();
    }
    // center + stamens
    ctx.fillStyle = mulColor('#c2406a', shade);
    ctx.beginPath(); ctx.arc(0, 0, f.r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = mulColor('#f7d27a', shade);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(Math.cos(a) * f.r * 0.3, Math.sin(a) * f.r * 0.3, f.r * 0.06, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function mulColor(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function leafTexture(S, kind) {
  const c = cnv(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(kind.length * 31 + 3);
  const N = kind === 'pine' ? 70 : kind === 'bamboo' ? 34 : 120;
  const items = [];
  for (let i = 0; i < N; i++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * S * 0.38;
    items.push({ x: S / 2 + Math.cos(a) * r, y: S / 2 + Math.sin(a) * r, rot: rng.range(0, 7), d: rng.next(), s: rng.range(0.8, 1.2) });
  }
  items.sort((a, b) => a.d - b.d);
  for (const it of items) {
    const sh = 0.6 + 0.4 * it.d;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rot);
    if (kind === 'broad') {
      const l = S * 0.07 * it.s, w = S * 0.04 * it.s;
      ctx.fillStyle = `rgb(${(110 + 60 * it.d) * sh | 0},${(165 + 50 * it.d) * sh | 0},${(70 + 20 * it.d) * sh | 0})`;
      ctx.beginPath(); ctx.ellipse(0, 0, w, l, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(40,70,20,0.35)`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -l); ctx.lineTo(0, l); ctx.stroke();
    } else if (kind === 'maple') {
      const l = S * 0.06 * it.s;
      ctx.fillStyle = `rgb(${(255) * sh | 0},${(255) * sh | 0},${(255) * sh | 0})`;
      for (let p = 0; p < 5; p++) {
        ctx.save(); ctx.rotate(((p - 2) / 5) * Math.PI * 1.1);
        ctx.beginPath(); ctx.ellipse(0, -l * 0.5, l * 0.18, l * 0.55, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    } else if (kind === 'bamboo') {
      for (let p = 0; p < 4; p++) {
        ctx.save(); ctx.rotate(p * 0.5 - 0.7);
        const l = S * 0.13 * it.s, w = S * 0.016 * it.s;
        const g = 0.6 + 0.4 * it.d;
        ctx.fillStyle = `rgb(${(120 * g) | 0},${(170 * g) | 0},${(70 * g) | 0})`;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(w * 1.5, l * 0.4, 0, l);
        ctx.quadraticCurveTo(-w * 1.5, l * 0.4, 0, 0);
        ctx.fill();
        ctx.restore();
      }
    } else if (kind === 'pine') {
      ctx.strokeStyle = `rgb(${(60 + 40 * it.d) * sh | 0},${(110 + 40 * it.d) * sh | 0},${(60 + 20 * it.d) * sh | 0})`;
      ctx.lineWidth = 1.3;
      for (let p = 0; p < 16; p++) {
        const a = (p / 16) * Math.PI * 2;
        const l = S * 0.06 * it.s;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l * 0.6); ctx.stroke();
      }
    }
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function flowerAtlas(S) {
  const c = cnv(S * 2, S * 2);
  const ctx = c.getContext('2d');
  const rng = new RNG(55);
  const cell = (ix, iy, fn) => { ctx.save(); ctx.translate(ix * S, iy * S); ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip(); fn(); ctx.restore(); };
  const stem = (x, y0, y1, w = 3) => { ctx.strokeStyle = '#4f7a2c'; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); };
  // iris (purple)
  cell(0, 0, () => {
    ctx.fillStyle = '#4c7a2a';
    for (let i = 0; i < 7; i++) { // sword leaves
      const x = S * 0.5 + rng.range(-0.25, 0.25) * S;
      ctx.beginPath(); ctx.moveTo(x - 5, S); ctx.quadraticCurveTo(x + rng.range(-20, 20), S * 0.5, x + rng.range(-12, 12), S * rng.range(0.25, 0.45)); ctx.lineTo(x + 5, S); ctx.fill();
    }
    for (let k = 0; k < 2; k++) {
      const x = S * (0.38 + k * 0.26), y = S * (0.2 + k * 0.08);
      stem(x, y + 20, S);
      for (let p = 0; p < 3; p++) {
        ctx.save(); ctx.translate(x, y + 10); ctx.rotate((p / 3) * Math.PI * 2 + 0.5);
        const g = ctx.createLinearGradient(0, 0, 0, 40);
        g.addColorStop(0, '#f3d25a'); g.addColorStop(0.25, '#6d3fb0'); g.addColorStop(1, '#3d2386');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 22, 13, 24, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#8a66cf';
      ctx.beginPath(); ctx.ellipse(x, y - 8, 7, 18, 0, 0, Math.PI * 2); ctx.fill();
    }
  });
  // nanohana (yellow rapeseed)
  cell(1, 0, () => {
    for (let k = 0; k < 6; k++) {
      const x = S * rng.range(0.2, 0.8), y = S * rng.range(0.12, 0.45);
      stem(x, y, S, 3);
      for (let f = 0; f < 14; f++) {
        const fx = x + rng.gauss() * 16, fy = y + rng.gauss() * 14;
        ctx.fillStyle = rng.chance(0.5) ? '#ffd21c' : '#ffe55c';
        for (let p = 0; p < 4; p++) { ctx.beginPath(); ctx.ellipse(fx + Math.cos(p * 1.57) * 4, fy + Math.sin(p * 1.57) * 4, 4, 4, 0, 0, 7); ctx.fill(); }
      }
    }
    ctx.fillStyle = '#5c8a30';
    for (let i = 0; i < 6; i++) { const x = S * rng.range(0.2, 0.8); ctx.beginPath(); ctx.ellipse(x, S * 0.8, 14, 30, rng.range(-0.5, 0.5), 0, 7); ctx.fill(); }
  });
  // small white flowers
  cell(0, 1, () => {
    ctx.fillStyle = '#5a8a34';
    for (let i = 0; i < 18; i++) { const x = S * rng.range(0.1, 0.9); ctx.beginPath(); ctx.ellipse(x, S * rng.range(0.6, 0.95), 5, 22, rng.range(-0.6, 0.6), 0, 7); ctx.fill(); }
    for (let k = 0; k < 9; k++) {
      const x = S * rng.range(0.15, 0.85), y = S * rng.range(0.2, 0.6);
      stem(x, y, S, 2);
      ctx.fillStyle = '#fbfbf4';
      for (let p = 0; p < 8; p++) { ctx.save(); ctx.translate(x, y); ctx.rotate(p * 0.785); ctx.beginPath(); ctx.ellipse(0, 9, 4, 9, 0, 0, 7); ctx.fill(); ctx.restore(); }
      ctx.fillStyle = '#f5c934'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    }
  });
  // azalea (magenta)
  cell(1, 1, () => {
    for (let k = 0; k < 16; k++) {
      const x = S * rng.range(0.12, 0.88), y = S * rng.range(0.12, 0.88);
      const col = rng.pick(['#e2387a', '#f05a92', '#d42b6a', '#f78fb5']);
      for (let p = 0; p < 5; p++) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(p * 1.2566);
        ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 11, 8, 12, 0, 0, 7); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#8f1847'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function waterNormal(S) {
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    // sum of periodic waves (tileable) + tileable noise
    v += 0.5 * tnoise(x, y, S, S, 7, 4);
    v += 0.25 * tnoise(x + 13, y + 7, S, S, 15, 3);
    hgt[y * S + x] = v;
  }
  const c = cnv(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const k = 6.0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = hgt[y * S + ((x - 1 + S) % S)], r = hgt[y * S + ((x + 1) % S)];
    const u = hgt[((y - 1 + S) % S) * S + x], d = hgt[((y + 1) % S) * S + x];
    let nx = (l - r) * k, ny = (u - d) * k, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * S + x) * 4;
    img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
