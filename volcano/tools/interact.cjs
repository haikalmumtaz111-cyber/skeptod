// Drags the view with the mouse and scrolls, then captures a frame
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../dist/volcanic-eruption.html') + '?test&frames=6&t=30&nobolt');
  await page.waitForFunction(() => window.__volcano && window.__volcano.frames >= 1, null, { timeout: 120000 });
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) await page.mouse.move(640 - i * 40, 360 + i * 8);
  await page.mouse.up();
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => window.__volcano.frames >= 6, null, { timeout: 120000 });
  await page.screenshot({ path: out });
  console.log('frames', await page.evaluate(() => window.__volcano.frames), 'errors', logs.filter(l => !/GPU stall/.test(l)));
  await browser.close();
})();
