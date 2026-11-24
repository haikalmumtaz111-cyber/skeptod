import * as THREE from 'three';
import { clamp, smooth } from './util.js';

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'KeyF']);

export class CameraRig {
  constructor(camera, path, dom, obstacles) {
    this.cam = camera; this.path = path; this.obstacles = obstacles;
    this.s = 0; this.paused = false;
    this.userYawT = 0; this.userPitchT = 0; this.userYaw = 0; this.userPitch = 0;
    this.fov = camera.fov; this.fovT = camera.fov; this.baseFov = camera.fov;
    this.mode = 'cine';
    this.free = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, vel: new THREE.Vector3() };
    this.keys = new Set();
    this.lastInput = -1e9; this.lastMoveKey = -1e9;
    this.dragging = false; this.pointers = new Map(); this.pinch = 0;
    this.roll = 0; this.prevBaseYaw = null;
    this.look = new THREE.Vector3(0, 0, -1);
    this.fade = 1; this.cut = null;
    this.pois = [];
    this.time = 0;
    this._p = new THREE.Vector3(); this._a = new THREE.Vector3(); this._d = new THREE.Vector3(); this._e = new THREE.Euler();
    this.bind(dom);
  }
  bind(dom) {
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragging = true; this.lastInput = this.time;
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    dom.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      this.lastInput = this.time;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.fovT = clamp(this.fovT - (d - this.pinch) * 0.08, 26, 80); this.pinch = d; return;
      }
      const k = 0.0032 * (this.fov / 60);
      if (this.mode === 'free') { this.free.yaw -= dx * k; this.free.pitch = clamp(this.free.pitch - dy * k, -1.45, 1.45); }
      else { this.userYawT = clamp(this.userYawT - dx * k, -2.4, 2.4); this.userPitchT = clamp(this.userPitchT - dy * k, -0.9, 0.9); }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); if (!this.pointers.size) this.dragging = false; this.lastInput = this.time; };
    dom.addEventListener('pointerup', up); dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => { e.preventDefault(); this.fovT = clamp(this.fovT + e.deltaY * 0.025, 26, 80); this.lastInput = this.time; }, { passive: false });
    dom.addEventListener('dblclick', () => { this.fovT = this.baseFov; this.userYawT = 0; this.userPitchT = 0; });
    window.addEventListener('keydown', (e) => {
      if (MOVE_KEYS.has(e.code)) {
        e.preventDefault();
        this.keys.add(e.code); this.lastMoveKey = this.time; this.lastInput = this.time;
        if (this.mode === 'cine' && !this.cut) this.enterFree();
      } else if (e.code === 'Space') { e.preventDefault(); this.paused = !this.paused; }
      else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.add('Shift');
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); if (e.code.startsWith('Shift')) this.keys.delete('Shift'); });
    window.addEventListener('blur', () => this.keys.clear());
  }
  enterFree() {
    this.mode = 'free';
    const c = this.cam;
    this.free.pos.copy(c.position);
    const d = this._d.set(0, 0, -1).applyQuaternion(c.quaternion);
    this.free.yaw = Math.atan2(-d.x, -d.z); this.free.pitch = Math.asin(clamp(d.y, -1, 1));
    this.free.vel.set(0, 0, 0);
    this.userYawT = this.userYaw = 0; this.userPitchT = this.userPitch = 0;
  }
  cinePose(s, t, outPos, outDir) {
    const L = this.path.length; const c = this.path.curve;
    const u = ((s % L) + L) % L / L;
    c.getPointAt(u, outPos);
    c.getPointAt(((u + 18 / L) % 1 + 1) % 1, this._a);
    outDir.subVectors(this._a, outPos).normalize();
    return outPos;
  }
  update(dt, t) {
    this.time = t;
    const c = this.cam;
    // cut transitions
    if (this.cut) {
      this.cut.t += dt;
      if (this.cut.phase === 0) { this.fade = 1 - smooth(0, 0.45, this.cut.t); if (this.cut.t >= 0.45) { this.cut.phase = 1; this.cut.t = 0; this.mode = 'cine'; this.free.vel.set(0, 0, 0); } }
      else { this.fade = smooth(0, 0.8, this.cut.t); if (this.cut.t >= 0.8) { this.cut = null; this.fade = 1; } }
    }
    this.fov += (this.fovT - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(c.fov - this.fov) > 0.01) { c.fov = this.fov; c.updateProjectionMatrix(); }

    if (this.mode === 'free') {
      const f = this.free;
      const fwd = this._d.set(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
      const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
      const want = new THREE.Vector3();
      const k = this.keys;
      if (k.has('KeyW') || k.has('ArrowUp')) want.add(fwd);
      if (k.has('KeyS') || k.has('ArrowDown')) want.sub(fwd);
      if (k.has('KeyD') || k.has('ArrowRight')) want.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) want.sub(right);
      if (k.has('KeyE') || k.has('KeyR')) want.y += 1;
      if (k.has('KeyQ') || k.has('KeyF')) want.y -= 1;
      if (want.lengthSq() > 0) { want.normalize().multiplyScalar(k.has('Shift') ? 48 : 16); this.lastMoveKey = t; }
      f.vel.lerp(want, Math.min(1, dt * 4));
      f.pos.addScaledVector(f.vel, dt);
      this.collide(f.pos);
      c.position.copy(f.pos);
      this._e.set(f.pitch, f.yaw, 0, 'YXZ'); c.quaternion.setFromEuler(this._e);
      if (t - Math.max(this.lastMoveKey, this.lastInput) > 14 && !this.cut) this.cut = { phase: 0, t: 0 };
      return;
    }

    if (!this.paused) {
      const y = this.cinePose(this.s, t, this._p, this._d).y;
      const v = 11.5 + 8 * smooth(10, 100, y);
      this.s += v * dt;
    }
    const P = this.cinePose(this.s, t, this._p, this._d);
    const D = this._d.clone();
    // attention: blend toward points of interest
    let best = 0; const target = new THREE.Vector3();
    for (const poi of this.pois) {
      const pp = poi.get(t); const to = pp.clone().sub(P); const dist = to.length(); to.divideScalar(dist);
      const w = smooth(poi.far, poi.near, dist) * smooth(-0.2, 0.35, to.dot(D)) * poi.w;
      if (w > best) { best = w; target.copy(to); }
    }
    this.attW = (this.attW || 0) + (best - (this.attW || 0)) * Math.min(1, dt * 1.2);
    if (!this.attDir) this.attDir = target.clone();
    if (best > 0.001) this.attDir.lerp(target, Math.min(1, dt * 2)).normalize();
    D.lerp(this.attDir, this.attW).normalize();
    let baseYaw = Math.atan2(-D.x, -D.z);
    let basePitch = Math.asin(clamp(D.y, -1, 1)) * (0.55 + 0.45 * this.attW);
    // authored drift & attitude
    const s = this.s;
    baseYaw += 0.16 * Math.sin(s * 0.0085 + 0.5) + 0.07 * Math.sin(s * 0.021 + 1.7);
    basePitch += (1 - this.attW) * (0.14 - 0.3 * smooth(10, 105, P.y)) * 0.8;
    basePitch += 0.035 * Math.sin(s * 0.013 + 2.0);
    // bank into turns
    if (this.prevBaseYaw === null) this.prevBaseYaw = baseYaw;
    let dy = baseYaw - this.prevBaseYaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    this.prevBaseYaw = baseYaw;
    const rollT = clamp(-dy / Math.max(dt, 1e-3) * 0.12, -0.08, 0.08);
    this.roll += (rollT - this.roll) * Math.min(1, dt * 2.0);
    // user look offsets
    const idle = t - this.lastInput;
    if (!this.dragging && idle > 3.0) { const k = Math.min(1, dt * 0.9); this.userYawT -= this.userYawT * k; this.userPitchT -= this.userPitchT * k; }
    this.userYaw += (this.userYawT - this.userYaw) * Math.min(1, dt * 7);
    this.userPitch += (this.userPitchT - this.userPitch) * Math.min(1, dt * 7);
    // handheld micro motion
    const hy = 0.0035 * Math.sin(t * 1.13) + 0.0018 * Math.sin(t * 2.71 + 1.0);
    const hp = 0.0025 * Math.sin(t * 1.57 + 0.3) + 0.0012 * Math.sin(t * 3.1);
    c.position.copy(P);
    c.position.y += 0.08 * Math.sin(t * 0.9);
    this._e.set(clamp(basePitch + this.userPitch + hp, -1.45, 1.45), baseYaw + this.userYaw + hy, this.roll, 'YXZ');
    c.quaternion.setFromEuler(this._e);
  }
  collide(p) {
    p.y = clamp(p.y, 1.6, 700);
    for (const o of this.obstacles) {
      const m = 1.2;
      if (p.x > o.x0 - m && p.x < o.x1 + m && p.z > o.z0 - m && p.z < o.z1 + m && p.y < o.h + m) {
        const dx0 = p.x - (o.x0 - m), dx1 = o.x1 + m - p.x, dz0 = p.z - (o.z0 - m), dz1 = o.z1 + m - p.z, dyy = o.h + m - p.y;
        const mn = Math.min(dx0, dx1, dz0, dz1, dyy);
        if (mn === dx0) p.x = o.x0 - m; else if (mn === dx1) p.x = o.x1 + m; else if (mn === dz0) p.z = o.z0 - m; else if (mn === dz1) p.z = o.z1 + m; else p.y = o.h + m;
      }
    }
  }
}
