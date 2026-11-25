// Shot 1: falling through storm clouds toward the city, title card
import * as THREE from 'three';
import { V3, makeSky, makeRain, canvasTex, rng, NOISE, lerp, easeInOut, shake, TAU } from './lib.js';

export default function (ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, ctx.W / ctx.H, 1, 9000);
  scene.fog = new THREE.FogExp2('#5b7177', 0.00055);

  const sky = makeSky({ top: '#3a5560', mid: '#6b858b', hor: '#9fb2b1', ground: '#33464a', sunDir: new V3(0.2, 0.5, -1), sunCol: '#fff1dc', sunGlow: 0.5, cover: 0.46, cloudScale: 0.5, cloudLit: '#c7d3d2', cloudShade: '#4c636a', rim: 0.4 });
  scene.add(sky);

  // city seen far below through the gaps
  const r = rng(11);
  const city = canvasTex(2048, 2048, (c, w, h) => {
    c.fillStyle = '#26332f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const x = r() * w, y = r() * h, s = 6 + r() * 34;
      c.fillStyle = ['#2f3d39', '#3a4744', '#22302c', '#46504c', '#30403a', '#3d4a3a'][Math.floor(r() * 6)];
      c.fillRect(x, y, s, s * (0.5 + r()));
    }
    c.strokeStyle = '#59605a'; c.lineWidth = 5;
    for (let i = 0; i < 26; i++) { c.beginPath(); const y = r() * h; c.moveTo(0, y); c.lineTo(w, y + (r() - 0.5) * 300); c.stroke(); }
    for (let i = 0; i < 26; i++) { c.beginPath(); const x = r() * w; c.moveTo(x, 0); c.lineTo(x + (r() - 0.5) * 300, h); c.stroke(); }
    c.strokeStyle = '#6b6c63'; c.lineWidth = 12;
    c.beginPath(); c.moveTo(0, h * 0.3); c.bezierCurveTo(w * 0.4, h * 0.2, w * 0.6, h * 0.8, w, h * 0.7); c.stroke();
  }, { repeat: true });
  city.repeat.set(3, 3);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshBasicMaterial({ map: city, color: '#8a9a9c' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const lights = canvasTex(2048, 2048, (c, w, h) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      c.fillStyle = r() < 0.7 ? '#ffc98a' : '#d6ecff';
      c.globalAlpha = 0.3 + r() * 0.7;
      c.fillRect(r() * w, r() * h, 1 + r() * 1.5, 1 + r() * 1.5);
    }
  }, { repeat: true });
  lights.repeat.set(5, 5);
  const gl = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshBasicMaterial({ map: lights, color: new THREE.Color('#ffffff').multiplyScalar(1.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  gl.rotation.x = -Math.PI / 2; gl.position.y = 1;
  scene.add(gl);

  // cloud layers
  const layers = [];
  const LAYERS = [
    { y: 520, cover: 0.6, lit: '#d9e3e2', shade: '#6b8288' },
    { y: 450, cover: 0.58, lit: '#cfdbdb', shade: '#5f777d' },
    { y: 380, cover: 0.56, lit: '#c5d2d2', shade: '#566e74' },
    { y: 320, cover: 0.57, lit: '#b9c8c9', shade: '#4d646a' },
    { y: 260, cover: 0.55, lit: '#adbdbf', shade: '#465c62' },
    { y: 200, cover: 0.58, lit: '#9fb1b3', shade: '#3f545a' },
    { y: 140, cover: 0.62, lit: '#92a5a8', shade: '#3a4e53' },
  ];
  LAYERS.forEach((L, i) => {
    const u = { uTime: { value: 0 }, uSeed: { value: i * 1.37 + 0.3 }, uCover: { value: L.cover }, uLit: { value: new THREE.Color(L.lit) }, uShade: { value: new THREE.Color(L.shade) }, uCam: { value: new V3() }, uFlash: { value: 0 } };
    const m = new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: NOISE + /* glsl */`
uniform float uTime,uSeed,uCover,uFlash; uniform vec3 uLit,uShade,uCam; varying vec3 vW;
void main(){
  vec2 p = vW.xz * 0.0021 + vec2(uSeed * 7.3, uSeed * 3.1) + vec2(uTime * 0.012, uTime*0.004);
  float n = fbm(p);
  float n2 = fbm(p * 2.6 + 3.1);
  float d = n * 0.78 + n2 * 0.22;
  float a = smoothstep(uCover, uCover + 0.1, d);
  float body = smoothstep(uCover, uCover + 0.28, d);
  float sh = fbm(p + vec2(0.05, 0.08));
  vec3 col = mix(uLit * 1.1, uShade, body * (0.55 + 0.45 * smoothstep(0.4, 0.7, sh)));
  float edge = a * (1. - smoothstep(uCover + 0.02, uCover + 0.12, d));
  col += uLit * edge * 0.45;
  col *= 1. + uFlash * 2.2;
  float dy = abs(uCam.y - vW.y);
  a *= smoothstep(6., 45., dy);
  a *= 1. - smoothstep(1500., 2600., length(vW.xz - uCam.xz));
  gl_FragColor = vec4(col, a * 0.94);
}`,
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), m);
    p.rotation.x = -Math.PI / 2;
    p.position.y = L.y;
    p.renderOrder = 1;
    scene.add(p);
    layers.push({ p, u });
  });

  // light shafts: big soft additive cones angled through the gaps
  const shaftMat = new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0.07 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uO; varying vec2 vUv; void main(){ float a = sin(vUv.x*3.14159) * smoothstep(0.,0.4,vUv.y) * smoothstep(1.,0.6,vUv.y); gl_FragColor = vec4(vec3(1.,0.97,0.9)*uO*a, 1.); }`,
  });
  const rs = rng(4);
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(60 + rs() * 80, 700), shaftMat);
    s.position.set((rs() - 0.5) * 700, 250, -200 - rs() * 700);
    s.rotation.set(0, rs() * TAU, 0.35);
    s.renderOrder = 2;
    scene.add(s);
  }

  const rain = makeRain({ count: 7000, box: [140, 140, 140], speed: 75, len: 5.5, color: '#e4eef0', opacity: 0.32, wind: [0.25, 0.1] });
  scene.add(rain);

  return {
    scene, camera,
    grade: { exposure: 0.92, bloom: 0.35, threshold: 0.85, sat: 1.0, contrast: 1.12, tone: 1.3, vig: 0.75, lift: [0.0, 0.01, 0.02] },
    update(lt, t) {
      const u = Math.min(lt / 4.4, 1), e = easeInOut(u) * 0.75 + u * 0.25;
      const pos = new V3(lerp(-60, 40, u), lerp(640, 165, e), lerp(260, -260, u));
      pos.add(shake(lt, 2.5, 1));
      camera.position.copy(pos);
      const pitch = lerp(-1.32, -0.62, easeInOut(u));
      const look = pos.clone().add(new V3(0.12, Math.sin(pitch), -Math.cos(pitch)));
      camera.lookAt(look);
      camera.rotateZ(Math.sin(lt * 0.5) * 0.04 + 0.05);
      const flash = Math.exp(-Math.pow((lt - 2.35) / 0.05, 2)) + 0.55 * Math.exp(-Math.pow((lt - 2.58) / 0.04, 2));
      for (const L of layers) { L.u.uTime.value = t; L.u.uCam.value.copy(camera.position); L.u.uFlash.value = flash; L.p.position.x = camera.position.x; L.p.position.z = camera.position.z; }
      sky.userData.u.uFlash.value = flash;
      sky.userData.update(t, camera);
      rain.userData.update(t, camera);
    },
  };
}
