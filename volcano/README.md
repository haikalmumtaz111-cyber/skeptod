# Massive Volcanic Eruption

A cinematic, real-time 3D night eruption that runs from a single file:
`dist/volcanic-eruption.html`. Open it in a desktop browser with WebGL2
(Chrome, Edge, Firefox, Safari). No server or network is needed.

## What's in the scene

- Procedural stratovolcano (2 km rim, breached crater, erosion gullies,
  parasitic cones) on a 1.2M-vertex terrain that fades out to distant ranges.
- Lava rivers traced by steepest descent from the crater and a flank fissure.
  The surface is shaded with a flow map, so crust rafts drift and crack, the
  margins stay incandescent and pulses travel downstream. The rivers light
  the ground around them.
- Ash column built from about 5,000 sorted, normal-mapped smoke sprites. The
  sprites rise, entrain, bend downwind and spread into an anvil. Lava light
  shades the base orange and moonlight picks out the top.
- Scheduled explosions with side jets, showers of incandescent bombs that
  bounce and roll down the slopes, a lava fountain with spatter, ember
  fields, and pyroclastic flows that hug the ground.
- Volcanic lightning in the column, with flashes that light the smoke and
  the terrain.
- HDR pipeline: MSAA scene, half-resolution smoke composite, single-scatter
  glow, bloom, light shafts, heat shimmer, tone mapping, grading, grain and
  letterbox.
- A 123-second closed camera loop: an establishing shot, a push in, an orbit,
  a low angle under the column, a flyby over the lava river and a pass over
  the crater.

## Controls

- Drag to orbit away from the cinematic path. The wheel zooms. After a few
  idle seconds the camera eases back onto the path.
- Space pauses or resumes the camera path. The eruption keeps going.
- Double-click toggles fullscreen.

## Building

```
npm install
node build.mjs        # writes dist/volcanic-eruption.html (three.js bundled inline)
```

The terrain worker is bundled separately and inlined as a Blob URL. If the
browser blocks workers, generation falls back to the main thread.

## Testing

`tools/shoot.cjs` renders frames in headless Chromium at fixed path times, for
example `node tools/shoot.cjs out 0 38 85 --frames=2`. Query flags it uses:
`test`, `t=<seconds>`, `frames=<n>`, `nobolt`, `bolt`, `pdc`,
`cam=x,y,z,tx,ty,tz`. `tools/interact.cjs` tests mouse orbiting.
`tools/realtime.cjs` runs the page in normal mode and reports console output.
