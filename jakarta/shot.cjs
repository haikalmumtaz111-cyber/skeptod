// usage: node shot.cjs <html> <out.png> <t1,t2,...> [w] [h] [extraQuery]  -> renders specific times, tiles them
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [html, out, ts] = [process.argv[2], process.argv[3], process.argv[4].split(',').map(Number)];
  const W = +(process.argv[5] || 960), H = +(process.argv[6] || 540), extra = process.argv[7] || '';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  await page.goto('file://' + path.resolve(html) + `?capture=1&w=${W}&h=${H}${extra}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 }).catch(() => {});
  const t0 = Date.now();
  for (let i = 0; i < ts.length; i++) {
    await page.evaluate((t) => window.__render(t), ts[i]);
    await page.screenshot({ path: out.replace('.png', `_${i}.png`) });
  }
  console.log('ms/frame', ((Date.now() - t0) / ts.length).toFixed(0), errs.slice(0, 8));
  await browser.close();
})();
