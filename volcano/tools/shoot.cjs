// Usage: node tools/shoot.cjs out_dir t1 t2 ... [--w=1280 --h=720 --frames=3]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const args = process.argv.slice(2);
  const opts = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const s = a.slice(2); const i = s.indexOf('='); return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)]; }));
  const pos = args.filter(a => !a.startsWith('--'));
  const out = pos[0];
  const times = pos.slice(1).length ? pos.slice(1) : ['0'];
  fs.mkdirSync(out, { recursive: true });
  const W = +(opts.w || 1280), H = +(opts.h || 720), FR = +(opts.frames || 3);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const file = 'file://' + path.resolve(__dirname, '../dist/volcanic-eruption.html');
  for (const t of times) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const logs = [];
    page.on('console', m => logs.push(m.type() + ': ' + m.text()));
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    const t0 = Date.now();
    await page.goto(file + '?test&frames=' + FR + '&t=' + t + (opts.extra ? '&' + opts.extra : ''));
    try {
      await page.waitForFunction((n) => window.__volcano && window.__volcano.frames >= n, FR, { timeout: 240000, polling: 500 });
    } catch (e) { logs.push('timeout waiting for frames'); }
    const info = await page.evaluate(() => window.__volcano && window.__volcano.frames);
    await page.screenshot({ path: path.join(out, `t${t}.png`) });
    console.log(`t=${t} frames=${info} time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const l of logs.slice(0, 40)) console.log('  ' + l);
    await page.close();
  }
  await browser.close();
})();
