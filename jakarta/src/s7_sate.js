// Shot 7: sate on a charcoal grill at night, smoke and sparks
import * as THREE from 'three';
import { V3, canvasTex, rng, lerp, shake, lumpy, noiseColors, makeParticles, glow, bokehTex, NOISE, TAU, easeInOut, mergeGeometries } from './lib.js';

export default function (ctx) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#07080c');
  scene.environment = ctx.envTex;
  scene.environmentIntensity = 0.25;
  const camera = new THREE.PerspectiveCamera(34, ctx.W / ctx.H, 0.01, 30);
  const r = rng(71);

  scene.add(new THREE.HemisphereLight('#4a5a85', '#1a0d06', 0.25));
  const ember = new THREE.PointLight('#ff7a2a', 0.09, 1.4, 1.2); ember.position.set(0, 0.07, 0); scene.add(ember);
  const ember2 = new THREE.PointLight('#ff5a1a', 0.06, 1.0, 1.3); ember2.position.set(0.3, 0.08, 0.02); scene.add(ember2);
  const ember3 = new THREE.PointLight('#ff8a3a', 0.06, 1.0, 1.3); ember3.position.set(-0.3, 0.08, -0.02); scene.add(ember3);
  const key = new THREE.DirectionalLight('#ffd7a8', 0.7); key.position.set(-0.6, 1.2, 0.8); scene.add(key);
  const rimL = new THREE.DirectionalLight('#8fb2ff', 1.0); rimL.position.set(0.5, 0.6, -1.2); scene.add(rimL);

  // grill trough
  const metal = new THREE.MeshStandardMaterial({ color: '#3b2f28', roughness: 0.75, metalness: 0.5 });
  const GL = 1.1, GW = 0.2, GH = 0.12;
  const parts = [];
  const bx = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  bx(GL, 0.006, GW, 0, 0.003, 0);
  bx(GL, GH, 0.006, 0, GH / 2, GW / 2); bx(GL, GH, 0.006, 0, GH / 2, -GW / 2);
  bx(0.006, GH, GW, GL / 2, GH / 2, 0); bx(0.006, GH, GW, -GL / 2, GH / 2, 0);
  bx(GL + 0.02, 0.01, 0.02, 0, GH, GW / 2); bx(GL + 0.02, 0.01, 0.02, 0, GH, -GW / 2);
  const grill = new THREE.Mesh(mergeGeometries(parts), metal);
  scene.add(grill);
  // cart table below + top
  const cart = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 0.9), new THREE.MeshStandardMaterial({ color: '#5a3a22', roughness: 0.6 }));
  cart.position.set(0.3, -0.02, 0.1); scene.add(cart);

  // ember bed + charcoal lumps share an animated glowing shader
  const emberU = { uTime: { value: 0 } };
  const emberMat = (lumps) => new THREE.ShaderMaterial({
    uniforms: emberU,
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix * ${lumps ? 'instanceMatrix *' : ''} vec4(position,1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + /* glsl */`
uniform float uTime; varying vec3 vW; varying vec3 vN;
void main(){
  vec2 p = vW.xz * 38. + vec2(vW.y * 20.);
  float n = fbm(p + vec2(0., uTime * 0.4));
  float c = smoothstep(0.42, 0.72, fbm(p * 1.6 - vec2(uTime * 0.2, uTime * 0.1)));
  float flick = 0.75 + 0.25 * sin(uTime * 7. + n * 20.);
  vec3 coal = vec3(0.035, 0.03, 0.028) * (0.6 + 0.6 * max(vN.y, 0.));
  vec3 hot = mix(vec3(3.2, 0.55, 0.06), vec3(5.5, 2.2, 0.5), c) * flick;
  vec3 col = mix(coal, hot, c * smoothstep(0.3, 0.6, n) * ${lumps ? '1.1' : '1.4'});
  gl_FragColor = vec4(col, 1.);
}`,
  });
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(GL - 0.02, GW - 0.02), emberMat(false));
  bed.rotation.x = -Math.PI / 2; bed.position.y = 0.04; scene.add(bed);
  const lumpGeo = lumpy(new THREE.DodecahedronGeometry(0.018, 1), 0.005, 80, 2);
  const N = 120, lumps = new THREE.InstancedMesh(lumpGeo, emberMat(true), N);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new V3();
  for (let i = 0; i < N; i++) {
    Q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
    const sc = 0.7 + r() * 0.8;
    M.compose(new V3((r() - 0.5) * (GL - 0.06), 0.045 + r() * 0.02, (r() - 0.5) * (GW - 0.05)), Q, S.set(sc, sc * 0.7, sc));
    lumps.setMatrixAt(i, M);
  }
  scene.add(lumps);

  // skewers with glazed meat
  const bamboo = new THREE.MeshStandardMaterial({ color: '#9c7a48', roughness: 0.8 });
  const meatMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.45 });
  const stickGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 0.36, 6); stickGeo.rotateX(Math.PI / 2);
  const meatGeos = [];
  const skewers = [];
  for (let i = 0; i < 15; i++) {
    const x = -0.46 + i * 0.066 + (r() - 0.5) * 0.008;
    const sk = new THREE.Group();
    sk.position.set(x, GH + 0.012, 0.03);
    sk.rotation.y = (r() - 0.5) * 0.12;
    const st = new THREE.Mesh(stickGeo, bamboo); sk.add(st);
    for (let k = 0; k < 4; k++) {
      const z = -0.075 + k * 0.034;
      let g = lumpy(new THREE.BoxGeometry(0.022, 0.019, 0.024, 4, 4, 4), 0.0055, 150, i * 10 + k);
      g = noiseColors(g, '#a3521f', '#2e1005', 160, i + k, 0.06, 2.8);
      g.rotateZ((r() - 0.5) * 0.5); g.rotateY((r() - 0.5) * 0.4);
      g.translate(0, 0.001, z);
      meatGeos.push(g);
      const m = new THREE.Mesh(g, meatMat); sk.add(m);
    }
    scene.add(sk);
    skewers.push(sk);
  }

  // smoke + sparks
  const smoke = makeParticles({ count: 110, life: 3.4, spread: new V3(GL, 0.02, 0.18), vel: new V3(0.03, 0.16, -0.02), swirl: 0.07, size: [0.06, 0.38], color: '#d6b8a0', opacity: 0.09, puff: true, seed: 9 });
  smoke.position.set(0, 0.16, 0); scene.add(smoke);
  const sparks = makeParticles({ count: 70, life: 1.4, spread: new V3(GL * 0.9, 0.01, 0.15), vel: new V3(0.02, 0.42, 0), swirl: 0.12, size: [0.006, 0.003], color: new V3(7, 2.6, 0.5), opacity: 1, additive: true, seed: 5 });
  sparks.position.set(0, 0.1, 0); scene.add(sparks);

  // background: warung lights bokeh, hanging bulb
  for (let i = 0; i < 22; i++) {
    const b = glow(['#ffb35a', '#ffd08a', '#7fd6ff', '#ff6a4a', '#b0ff9a'][i % 5], 0.18 + r() * 0.25, 0.06 + r() * 0.12, bokehTex());
    b.position.set(-1.2 + r() * 3, 0.1 + r() * 0.8, -1.2 - r() * 1.5); scene.add(b);
  }
  const bulb = glow('#ffc27a', 2.2, 0.35); bulb.position.set(-0.55, 0.72, -0.5); scene.add(bulb);
  const bulbL = new THREE.PointLight('#ffb26a', 0.15, 3); bulbL.position.copy(bulb.position); scene.add(bulbL);

  return {
    scene, camera,
    grade: { exposure: 0.95, bloom: 0.55, threshold: 1.0, radius: 0.4, sat: 1.22, contrast: 1.08, tone: 1.1, vig: 0.8 },
    update(lt, t) {
      const u = Math.min(lt / 4, 1), e = easeInOut(u);
      const s = shake(lt, 0.0025, 11);
      camera.position.set(lerp(-0.46, -0.22, e) + s.x, lerp(0.2, 0.215, e) + s.y, lerp(0.28, 0.25, e));
      camera.lookAt(lerp(-0.2, 0.04, e), 0.125, -0.01);
      emberU.uTime.value = t;
      ember.intensity = 0.09 + Math.sin(t * 9) * 0.012 + Math.sin(t * 23) * 0.006;
      skewers.forEach((sk, i) => { sk.rotation.z = Math.sin(t * 0.8 + i) * 0.03; });
      smoke.userData.update(t, camera, ctx.H);
      sparks.userData.update(t, camera, ctx.H);
    },
  };
}
