# skeptod
## Japanese village scene

`japanese-village.html` is a self-contained real-time 3D scene (Three.js r170 bundled inline, all textures generated procedurally). Open it directly in a desktop browser with WebGL2.

- Drag to orbit, scroll to zoom, right-drag to pan. After ~9 s without input the camera eases back into the cinematic flight.
- Source lives in `village/src`. Rebuild with `cd village && npm install && node build.mjs` (writes `../japanese-village.html`).
