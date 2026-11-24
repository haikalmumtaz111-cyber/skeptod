import * as THREE from 'three';
import { Geo } from './util.js';
import { patchStandard, makeNeonMaterial, makeScreenMaterial } from './materials.js';

// Slow advertising airship circling the skyline
export class Blimp {
  constructor() {
    const body = new Geo({ color: 3 });
    const neon = new Geo({ aCol: 3, aNeon: 4 });
    const screen = new Geo({ aSign: 4 });
    const L = 70, R = 12;
    // hull (lathe along local Y, then rotated to Z)
    const prof = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; const y = -L / 2 + t * L; const r = R * Math.pow(Math.sin(Math.PI * t), 0.62) * (t > 0.5 ? 1 : 0.92 + 0.08 * t * 2); prof.push([Math.max(r, 0.01), y]); }
    const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    body.set('color', 0.16, 0.16, 0.18);
    body.setMatrix(rot); body.lathe(0, 0, prof, 28); body.setMatrix(null);
    // fins
    body.set('color', 0.1, 0.1, 0.11);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const m = new THREE.Matrix4().makeRotationZ(a);
      body.setMatrix(m); body.box(-0.4, 0.4, R * 0.5, R * 1.45, -L / 2 + 1, -L / 2 + 13); body.setMatrix(null);
    }
    // gondola
    body.set('color', 0.08, 0.08, 0.09);
    body.box(-3, 3, -R - 3.2, -R + 0.8, -10, 12);
    neon.set('aCol', 1.0, 0.75, 0.45); neon.set('aNeon', 2.5, 0, 0, 1);
    for (let z = -8; z < 11; z += 2.2) { neon.box(-3.05, -3.0, -R - 1.8, -R - 0.9, z, z + 1.4); neon.box(3.0, 3.05, -R - 1.8, -R - 0.9, z, z + 1.4); }
    // running lights along the hull
    neon.set('aCol', 0.1, 0.85, 1.0); neon.set('aNeon', 4, 3, 0, 0.25);
    const pts = []; for (let i = 0; i <= 30; i++) { const t = 0.08 + 0.84 * i / 30; const y = -L / 2 + t * L; const r = R * Math.pow(Math.sin(Math.PI * t), 0.62); pts.push(new THREE.Vector3(0, r + 0.15, y)); }
    neon.tube(pts, 0.25, 5);
    neon.set('aCol', 1.0, 0.1, 0.5); neon.set('aNeon', 4, 0, 0, 1);
    const p2 = pts.map((p) => new THREE.Vector3(0, -p.y - 0.3, p.z)); neon.tube(p2, 0.2, 5);
    // big side screens (curved approximation: two flat panels per side)
    for (const side of [-1, 1]) {
      screen.set('aSign', side > 0 ? 2 : 5, 37.5 + side, 2.6, 1.3);
      const x = side * (R * 0.985 + 0.3), h = 8.5, w = 34;
      screen.quad([x, -h / 2, -w / 2], [x, -h / 2, w / 2], [x, h / 2, w / 2], [x, h / 2, -w / 2], [side, 0, 0], side > 0 ? [[1, 0], [0, 0], [0, 1], [1, 1]] : [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const bm = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.35, envMapIntensity: 1.2 }), 'veh');
    this.group = new THREE.Group();
    this.group.add(new THREE.Mesh(body.build(), bm), new THREE.Mesh(neon.build(), makeNeonMaterial()), new THREE.Mesh(screen.build(), makeScreenMaterial(false)));
    this.group.traverse((o) => { o.frustumCulled = false; });
    this.lights = [new THREE.Vector3(0, R + 1, -L / 2 + 8), new THREE.Vector3(0, -R - 3.5, 0)];
  }
  update(t) {
    const a = t * 0.014 + 1.3, Rr = 480;
    const cx = 60, cz = -240;
    this.group.position.set(cx + Math.cos(a) * Rr, 300 + Math.sin(t * 0.05) * 6, cz + Math.sin(a) * Rr * 0.83);
    const dx = -Math.sin(a), dz = Math.cos(a) * 0.83;
    this.group.rotation.set(0, Math.atan2(dx, dz), Math.sin(t * 0.3) * 0.02);
  }
}
