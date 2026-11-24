import * as esbuild from 'esbuild';
import fs from 'fs';

const minify = !process.argv.includes('--dev');
const res = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify,
  target: ['es2020'],
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;overscroll-behavior:none}canvas{display:block;position:fixed;inset:0;cursor:grab;outline:none;-webkit-user-select:none;user-select:none}canvas:active{cursor:grabbing}</style>
</head>
<body>
<script>
${js}
</script>
</body>
</html>
`;
fs.writeFileSync('index.html', html);
console.log('index.html', (html.length / 1024).toFixed(1) + ' KB');
