import * as esbuild from 'esbuild';
import fs from 'fs';
const out = process.argv[2] || 'jakarta.html';
const r = await esbuild.build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const font = fs.readFileSync('node_modules/@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2').toString('base64');
const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jakarta</title>
<style>
@font-face{font-family:"Great Vibes";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400;}
html,body{margin:0;height:100%;overflow:hidden;background:#000;}
canvas{display:block;width:100vw;height:100vh;object-fit:contain;}
</style>
</head>
<body>
<script>${js}</script>
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + 'KB');
