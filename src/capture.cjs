const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [start, secs, fps, dir, W, H] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5], +(process.argv[6]||1920), +(process.argv[7]||1080)];
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`file:///home/user/skeptod/pirate-ship.html?capture=1&t=${start}`);
  await page.waitForFunction(() => typeof window.__step === 'function');
  // pre-roll: let spray/particles and springs settle
  for (let i = 0; i < 45; i++) await page.evaluate((d) => window.__step(d), 1 / fps);
  const n = Math.round(secs * fps);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((d) => window.__step(d), 1 / fps);
    await page.screenshot({ path: `${dir}/f_${String(i).padStart(4, '0')}.png` });
    if (i % 30 === 0) console.log('frame', i, '/', n, ((Date.now() - t0) / 1000).toFixed(0) + 's', errs.length ? errs : '');
  }
  await browser.close();
  console.log('done', errs);
})();
