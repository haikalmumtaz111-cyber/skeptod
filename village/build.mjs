import * as esbuild from 'esbuild';
import fs from 'node:fs';
const dev = process.argv.includes('--dev');
const res = await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: !dev, write: false,
  target: ['es2020'], legalComments: 'none', logLevel: 'warning',
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = fs.readFileSync('template.html', 'utf8');
const html = tpl.replace('/*__BUNDLE__*/', () => js);
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || '../japanese-village.html';
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
