// Opens the page in normal (non-test) mode, lets it run, captures a frame and reports console problems
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const out = process.argv[2], wait = +(process.argv[3] || 20000);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../dist/volcanic-eruption.html'));
  await page.waitForTimeout(wait);
  const st = await page.evaluate(() => ({ frames: window.__volcano.frames, w: document.querySelector('canvas').width, h: document.querySelector('canvas').height, txt: document.body.innerText.trim() }));
  await page.screenshot({ path: out, timeout: 90000 });
  console.log(JSON.stringify(st));
  console.log(logs.filter(l => !/GPU stall/.test(l)).slice(0, 20).join('\n') || 'no console output');
  await browser.close();
})();
