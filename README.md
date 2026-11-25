# skeptod
## Japanese village scene

`japanese-village.html` is a self-contained real-time 3D scene (Three.js r170 bundled inline, all textures generated procedurally). Open it directly in a desktop browser with WebGL2.

- Drag to orbit, scroll to zoom, right-drag to pan. After ~9 s without input the camera eases back into the cinematic flight.
- Sound starts on the first click, tap or key press: river, waterfall, wind, rustling sakura and bamboo, birds, frogs, wood creaks and a distant temple bell, all synthesized in code (`village/src/synth.js`) and positioned in 3D around the camera (`village/src/audio.js`). The round button in the bottom-right corner (or the M key) mutes and unmutes.
- 1-minute 1080p renders of the cinematic flight (with soundtrack) are written to `renders/` by the capture hook (`?capture`), and are kept out of git because of their size.
- Source lives in `village/src`. Rebuild with `cd village && npm install && node build.mjs` (writes `../japanese-village.html`).
