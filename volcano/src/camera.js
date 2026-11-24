// Cinematic camera path (closed Catmull-Rom loop) + gentle user orbit override
import * as THREE from 'three';
import { V } from './terrain.js';
import { noise2 } from './noise.js';

export class CinematicCamera {
  constructor(camera, sample, mainFlow, dom) {
    this.camera = camera;
    this.sample = sample;
    this.segDur = 9.5;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    // pick two stations along the main lava river for the close flyby
    const pts = mainFlow.pts;
    const at = (s) => {
      let best = 0, bd = 1e9;
      for (let k = 0; k < pts.length; k += 6) { const d = Math.abs(pts[k + 2] - s); if (d < bd) { bd = d; best = k; } }
      return { x: pts[best], z: pts[best + 1], dx: pts[best + 4], dz: pts[best + 5], w: pts[best + 3] };
    };
    const a = at(2600), b = at(3900), c = at(4900);
    const side = (q, off, up, fwd = 0) => {
      const nx = -q.dz, nz = q.dx;
      const x = q.x + nx * off + q.dx * fwd, z = q.z + nz * off + q.dz * fwd;
      return P(x, sample(x, z) + up, z);
    };
    const onRiver = (q, ahead, up) => {
      const x = q.x + q.dx * ahead, z = q.z + q.dz * ahead;
      return P(x, sample(x, z) + up, z);
    };

    const keys = [
      // wide establishing shot, low on the plain
      { p: P(-1600, 380, -11800), t: P(0, 3100, 0), fov: 50 },
      // slow push in
      { p: P(-1100, 520, -9400), t: P(0, 2900, 0), fov: 48 },
      { p: P(900, 950, -7400), t: P(0, 2500, 0), fov: 46 },
      // swing around the eastern flank
      { p: P(5400, 1500, -6200), t: P(0, 2200, 0), fov: 46 },
      { p: P(8400, 1700, -1600), t: P(0, 2100, 0), fov: 46 },
      // low angle, the towering column overhead
      { p: P(6600, 900, 4600), t: P(600, 5200, 900), fov: 55 },
      // northern and western flanks
      { p: P(1200, 1350, 9000), t: P(0, 2100, 0), fov: 46 },
      { p: P(-7600, 1500, 5200), t: P(0, 1900, 0), fov: 46 },
      // drop down onto the main lava river
      { p: side(c, -750, 560, 450), t: onRiver(b, 0, 40), fov: 48 },
      { p: side(b, -340, 240), t: onRiver(a, -150, 20), fov: 52 },
      // rise up to the erupting crater (upwind side)
      { p: side(a, -300, 380, -1000), t: P(0, V.FLOOR_H + 60, 0), fov: 50 },
      { p: P(-1050, 3450, -850), t: P(0, V.FLOOR_H + 40, 0), fov: 50 },
      // pull back out
      { p: P(-5200, 1700, -12500), t: P(0, 3600, 0), fov: 46 },
    ];
    this.keys = keys;
    this.posCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.p), true, 'catmullrom', 0.5);
    this.tgtCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.t), true, 'catmullrom', 0.5);
    this.duration = keys.length * this.segDur;

    // user interaction (orbit offsets that ease back to the cinematic path)
    this.yaw = 0; this.pitch = 0; this.zoom = 1;
    this.lastInput = -100;
    this.dragging = false;
    this.paused = false;
    this.pathTime = 0;
    if (dom) this.bind(dom);
    this.tmpP = new THREE.Vector3();
    this.tmpT = new THREE.Vector3();
  }

  bind(dom) {
    let lx = 0, ly = 0;
    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true; lx = e.clientX; ly = e.clientY;
      dom.setPointerCapture(e.pointerId);
      this.lastInput = performance.now() / 1000;
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.yaw -= dx * 0.004;
      this.pitch = Math.max(-0.6, Math.min(0.75, this.pitch + dy * 0.003));
      this.lastInput = performance.now() / 1000;
    });
    const up = () => { this.dragging = false; this.lastInput = performance.now() / 1000; };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.35, Math.min(2.5, this.zoom * Math.exp(e.deltaY * 0.0012)));
      this.lastInput = performance.now() / 1000;
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') this.paused = !this.paused;
    });
  }

  fovAt(u) {
    const n = this.keys.length;
    const f = u * n;
    const i = Math.floor(f), t = f - i;
    const k = (j) => this.keys[((j % n) + n) % n].fov;
    const p0 = k(i - 1), p1 = k(i), p2 = k(i + 1), p3 = k(i + 2);
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  update(dt, time, shake, plumeAxis) {
    if (!this.paused) this.pathTime += dt;
    const u = ((this.pathTime % this.duration) + this.duration) % this.duration / this.duration;
    const pos = this.posCurve.getPoint(u, this.tmpP);
    const tgt = this.tgtCurve.getPoint(u, this.tmpT);
    let fov = this.fovAt(u);

    // ease user offsets back to the path after a few idle seconds
    const now = performance.now() / 1000;
    if (!this.dragging && now - this.lastInput > 5) {
      const k = 1 - Math.exp(-dt * 0.6);
      this.yaw += (0 - this.yaw) * k;
      this.pitch += (0 - this.pitch) * k;
      this.zoom += (1 - this.zoom) * k;
    }
    const off = pos.clone().sub(tgt);
    if (Math.abs(this.yaw) > 1e-4 || Math.abs(this.pitch) > 1e-4 || Math.abs(this.zoom - 1) > 1e-4) {
      const r = off.length() * this.zoom;
      let th = Math.atan2(off.z, off.x) + this.yaw;
      let ph = Math.asin(Math.max(-0.99, Math.min(0.99, off.y / off.length()))) + this.pitch;
      ph = Math.max(-0.35, Math.min(1.35, ph));
      off.set(Math.cos(th) * Math.cos(ph) * r, Math.sin(ph) * r, Math.sin(th) * Math.cos(ph) * r);
    }
    pos.copy(tgt).add(off);

    // keep out of the dense lower column
    const h = pos.y - V.RIM_H;
    if (h > -200 && h < 9000) {
      const c = plumeAxis(Math.max(h, 0));
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const rr = Math.hypot(dx, dz);
      const minR = 420 + 0.24 * Math.max(h, 0);
      if (rr < minR) {
        const s = minR / Math.max(rr, 1);
        pos.x = c.x + dx * s; pos.z = c.z + dz * s;
      }
    }
    // keep above ground
    const g = this.sample(pos.x, pos.z) + 45;
    if (pos.y < g) pos.y = g;

    // handheld drift + eruption shake
    const dist = pos.distanceTo(tgt);
    const hx = noise2(time * 0.21, 3.1) * 0.0045 + noise2(time * 0.9, 7.7) * 0.0012;
    const hy = noise2(time * 0.19, 9.4) * 0.0035 + noise2(time * 0.83, 1.9) * 0.0010;
    const sx = noise2(time * 23.0, 5.5) * shake, sy = noise2(time * 21.0, 2.2) * shake;
    tgt.x += (hx + sx * 0.004) * dist;
    tgt.y += (hy + sy * 0.004) * dist;
    pos.x += sx * 6; pos.y += sy * 6;

    this.camera.position.copy(pos);
    this.camera.lookAt(tgt);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    return { pos, tgt };
  }
}
