/* 诊断线上页面：收集控制台错误、检查关键元素状态、模拟点击上传 */
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();

  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url()} :: ${r.failure()?.errorText}`));

  await page.goto('https://kouri0916-tech.github.io/popup-book/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('[NAV] ' + e.message));
  await page.waitForTimeout(3000);

  // 关键状态
  const state = await page.evaluate(() => ({
    hasTHREE: !!window.THREE,
    hasOrbit: !!(window.THREE && THREE.OrbitControls),
    segOverlayHidden: document.getElementById('segOverlay')?.classList.contains('hidden'),
    welcomeVisible: !document.getElementById('welcome')?.classList.contains('hidden'),
    fileInputExists: !!document.getElementById('fileInput'),
    canvasSize: (() => { const c = document.getElementById('stage3d'); return c ? c.clientWidth + 'x' + c.clientHeight : 'none'; })(),
  }));
  console.log('STATE=' + JSON.stringify(state, null, 1));

  // 模拟点击上传按钮，看文件选择器是否触发
  const clicked = await page.evaluate(() => {
    const btn = document.getElementById('welcomeUpload');
    if (!btn) return 'NO_BUTTON';
    let fired = false;
    const input = document.getElementById('fileInput');
    input?.addEventListener('click', () => { fired = true; }, { once: true });
    btn.click();
    return fired ? 'FILE_DIALOG_TRIGGERED' : 'NO_DIALOG_EVENT';
  });
  console.log('CLICK_TEST=' + clicked);
  await page.waitForTimeout(1000);

  console.log('--- CONSOLE LOGS ---');
  logs.slice(0, 30).forEach(l => console.log(l));

  await page.screenshot({ path: 'diag.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
