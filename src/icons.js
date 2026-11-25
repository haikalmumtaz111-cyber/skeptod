// Abstract neon pictograms (no letters / numerals). Each icon is a list of strokes;
// a stroke is { pts: [[x,y],...], closed }. Coordinates roughly in [-0.5, 0.5].

function arc(cx, cy, r, a0, a1, n, sx = 1, sy = 1) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push([cx + Math.cos(a) * r * sx, cy + Math.sin(a) * r * sy]); }
  return pts;
}
const TAU = Math.PI * 2;

export const ICONS = {
  ring: () => [{ pts: arc(0, 0, 0.45, 0, TAU, 28), closed: false }],
  rings: () => [{ pts: arc(0, 0, 0.46, 0, TAU, 28) }, { pts: arc(0, 0, 0.26, 0, TAU, 20) }],
  heart: () => {
    const pts = [];
    for (let i = 0; i <= 36; i++) {
      const t = (i / 36) * TAU;
      const x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([x / 36, y / 36 + 0.05]);
    }
    return [{ pts }];
  },
  bolt: () => [{ pts: [[0.12, 0.5], [-0.22, -0.02], [0.04, -0.02], [-0.12, -0.5], [0.26, 0.08], [0.0, 0.08], [0.12, 0.5]] }],
  glass: () => [
    { pts: [[-0.38, 0.42], [0.38, 0.42], [0.0, 0.0], [-0.38, 0.42]] },
    { pts: [[0.0, 0.0], [0.0, -0.36]] },
    { pts: [[-0.22, -0.4], [0.22, -0.4]] },
    { pts: arc(0.22, 0.42, 0.1, 0, TAU, 12) },
  ],
  arrow: () => [{ pts: [[-0.45, 0], [0.38, 0]] }, { pts: [[0.12, 0.26], [0.42, 0], [0.12, -0.26]] }],
  eye: () => [
    { pts: arc(0, -0.35, 0.6, Math.PI * 0.22, Math.PI * 0.78, 16) },
    { pts: arc(0, 0.35, 0.6, -Math.PI * 0.22, -Math.PI * 0.78, 16) },
    { pts: arc(0, 0, 0.13, 0, TAU, 14) },
  ],
  star: () => {
    const pts = [];
    for (let i = 0; i <= 10; i++) { const a = Math.PI / 2 + (i / 10) * TAU; const r = i % 2 ? 0.2 : 0.48; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
    return [{ pts }];
  },
  diamond: () => [{ pts: [[0, 0.48], [0.32, 0], [0, -0.48], [-0.32, 0], [0, 0.48]] }, { pts: [[0, 0.24], [0.16, 0], [0, -0.24], [-0.16, 0], [0, 0.24]] }],
  triangle: () => [{ pts: [[0, 0.45], [0.42, -0.35], [-0.42, -0.35], [0, 0.45]] }],
  wave: () => { const pts = []; for (let i = 0; i <= 30; i++) { const x = -0.45 + 0.9 * i / 30; pts.push([x, Math.sin(i / 30 * TAU * 1.5) * 0.22]); } return [{ pts }]; },
  moon: () => [{ pts: [...arc(0, 0, 0.44, Math.PI * 0.35, Math.PI * 1.65, 20), ...arc(0.16, 0, 0.36, Math.PI * 1.5, Math.PI * 0.5, 16)] }],
  drop: () => { const pts = []; for (let i = 0; i <= 28; i++) { const t = i / 28 * TAU; const r = 0.3; pts.push([Math.sin(t) * r * Math.sin(t / 2) * 1.2, -Math.cos(t) * 0.45]); } return [{ pts }]; },
  bowl: () => [
    { pts: [...arc(0, 0.0, 0.42, Math.PI, TAU, 18), [-0.42, 0.0]] },
    { pts: [[-0.05, 0.08], [0.32, 0.5]] },
    { pts: [[0.08, 0.06], [0.44, 0.42]] },
    { pts: [[-0.16, -0.48], [0.16, -0.48]] },
  ],
  cat: () => [
    { pts: [...arc(0, -0.08, 0.36, -Math.PI * 0.12, Math.PI * 1.12, 22)] },
    { pts: [[-0.35, 0.02], [-0.32, 0.45], [-0.1, 0.26]] },
    { pts: [[0.35, 0.02], [0.32, 0.45], [0.1, 0.26]] },
    { pts: arc(-0.13, -0.05, 0.05, 0, TAU, 8) },
    { pts: arc(0.13, -0.05, 0.05, 0, TAU, 8) },
  ],
  chevrons: () => [{ pts: [[-0.4, 0.3], [0, -0.05], [0.4, 0.3]] }, { pts: [[-0.4, 0.0], [0, -0.35], [0.4, 0.0]] }],
  hexagon: () => { const pts = []; for (let i = 0; i <= 6; i++) { const a = i / 6 * TAU + Math.PI / 6; pts.push([Math.cos(a) * 0.46, Math.sin(a) * 0.46]); } return [{ pts }, { pts: arc(0, 0, 0.18, 0, TAU, 14) }]; },
  planet: () => [{ pts: arc(0, 0, 0.3, 0, TAU, 22) }, { pts: arc(0, 0, 0.5, 0, TAU, 26, 1, 0.28) }],
  spiral: () => { const pts = []; for (let i = 0; i <= 40; i++) { const t = i / 40; const a = t * TAU * 2.2; pts.push([Math.cos(a) * 0.47 * t, Math.sin(a) * 0.47 * t]); } return [{ pts }]; },
};
export const ICON_NAMES = Object.keys(ICONS);
