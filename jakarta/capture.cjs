// usage: node capture.cjs <html> <outdir> <frameStart> <frameEnd> [fps] [w] [h] [extraQuery]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [html, dir, f0, f1] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5]];
  const fps = +(process.argv[6] || 30), W = +(process.argv[7] || 1920), H = +(process.argv[8] || 1080), extra = process.argv[9] || '';
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  await page.goto('file://' + path.resolve(html) + `?capture=1&w=${W}&h=${H}${extra}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const t0 = Date.now();
  for (let i = f0; i < f1; i++) {
    await page.evaluate((t) => window.__render(t), i / fps);
    await page.screenshot({ path: `${dir}/f_${String(i).padStart(4, '0')}.png` });
    if ((i - f0) % 15 === 0) console.log('frame', i, ((Date.now() - t0) / 1000).toFixed(1) + 's', errs.length ? errs.slice(0, 5) : '');
  }
  await browser.close();
  console.log('done', ((Date.now() - t0) / 1000).toFixed(1) + 's', errs.slice(0, 10));
})();
