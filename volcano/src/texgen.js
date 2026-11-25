// CPU texture generators that run inside workers (no three.js dependency)
import { pnoise2, smoothstep, clamp, mulberry32 } from './noise.js';

// Tileable rock detail: RG = normal xy, B = cavity, A = height
export function rockData(S = 512) {
  const hgt = new Float32Array(S * S);
  const rnd = mulberry32(7);
  const P = 12;
  const pts = new Float32Array(P * P * 2);
  for (let k = 0; k < P * P; k++) { pts[k * 2] = rnd(); pts[k * 2 + 1] = rnd(); }
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = i / S, v = j / S;
      let f = 0, a = 0.5, per = 6, n = 0, w = 1;
      for (let o = 0; o < 6; o++) {
        let r = 1 - Math.abs(pnoise2(u * per + o * 0.3, v * per - o * 0.5, per, per));
        r *= r;
        f += a * r * w; n += a; w = clamp(r * 1.5, 0, 1);
        a *= 0.5; per *= 2;
      }
      f /= n;
      const x = u * P, y = v * P, cx = Math.floor(x), cy = Math.floor(y);
      let f1 = 9, f2 = 9;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox, gy = cy + oy;
        const wx = ((gx % P) + P) % P, wy = ((gy % P) + P) % P;
        const k = (wy * P + wx) * 2;
        const dx = gx + pts[k] - x, dy = gy + pts[k + 1] - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      const edge = smoothstep(0.0, 0.12, f2 - f1);
      hgt[j * S + i] = f * 0.75 + 0.25 * edge + 0.08 * pnoise2(u * 64, v * 64, 64, 64);
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const L = hgt[j * S + ((i - 1 + S) % S)], R = hgt[j * S + ((i + 1) % S)];
      const D = hgt[((j - 1 + S) % S) * S + i], U = hgt[((j + 1) % S) * S + i];
      const h = hgt[j * S + i];
      const nx = (L - R) * 6, ny = (D - U) * 6;
      const l = Math.hypot(nx, ny, 1);
      const cav = clamp(0.5 + (L + R + D + U - 4 * h) * 6, 0, 1);
      const k = (j * S + i) * 4;
      data[k] = (nx / l * 0.5 + 0.5) * 255;
      data[k + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[k + 2] = cav * 255;
      data[k + 3] = clamp(h, 0, 1) * 255;
    }
  }
  return data;
}
