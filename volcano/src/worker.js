// Terrain worker: computes heightmap rows, far-mesh heights and the rock texture
import { heightRows, meshRows } from './height.js';
import { rockData } from './texgen.js';

self.onmessage = (e) => {
  const { id, job, a, b } = e.data;
  let out;
  if (job === 'h') out = heightRows(a, b);
  else if (job === 'm') out = meshRows(a, b);
  else out = rockData();
  self.postMessage({ id, out }, [out.buffer]);
};
