import * as esbuild from 'esbuild';
import fs from 'fs';
const out = process.argv[2];
const r = await esbuild.build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sunset Corsair</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#000;}
canvas{display:block;width:100vw;height:100vh;touch-action:none;cursor:grab;}
canvas:active{cursor:grabbing;}
#veil{position:fixed;inset:0;background:#000;pointer-events:none;transition:opacity 2.2s ease;z-index:2;}
</style>
</head>
<body>
<div id="veil"></div>
<script>${js}</script>
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length/1024).toFixed(0)+'KB');
