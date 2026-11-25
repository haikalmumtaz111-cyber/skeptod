// Bundles the scene (three.js included) into one standalone HTML file.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const wres = await build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const workerSrc = wres.outputFiles[0].text;

const res = await build({
  entryPoints: ['src/main.js'],
  define: { __WORKER_SRC__: JSON.stringify(workerSrc) },
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  banner: { js: '/*! three.js r169 | MIT License | https://threejs.org */' },
});
let js = res.outputFiles[0].text;
if (/<\/script/i.test(js)) js = js.replace(/<\/script/gi, '<\\/script');
const tpl = readFileSync('src/index.html', 'utf8');
const html = tpl.replace('/*__BUNDLE__*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/volcanic-eruption.html', html);
console.log('dist/volcanic-eruption.html', (html.length / 1024).toFixed(0) + ' KB');
