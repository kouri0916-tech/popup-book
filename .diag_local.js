/* 本地诊断：启动本地静态服务后测试页面 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(8899, async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();

  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url()} :: ${r.failure()?.errorText}`));

  await page.goto('http://localhost:8899/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('[NAV] ' + e.message));
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => ({
    hasTHREE: !!window.THREE,
    hasOrbit: !!(window.THREE && THREE.OrbitControls),
    canvasSize: (() => { const c = document.getElementById('stage3d'); return c ? c.clientWidth + 'x' + c.clientHeight : 'none'; })(),
    welcomeVisible: !document.getElementById('welcome')?.classList.contains('hidden'),
  }));
  console.log('STATE=' + JSON.stringify(state));

  // 测试点击"载入示例画作"完整流程
  const demoResult = await page.evaluate(async () => {
    const btn = document.getElementById('demoBtn');
    if (!btn) return 'NO_DEMO_BTN';
    btn.click();
    await new Promise(r => setTimeout(r, 6000));
    return {
      overlayHidden: document.getElementById('segOverlay')?.classList.contains('hidden'),
      artCount: document.getElementById('artCount')?.textContent,
      stageTitle: document.getElementById('stageTitle')?.textContent,
      welcomeHidden: document.getElementById('welcome')?.classList.contains('hidden'),
    };
  });
  console.log('DEMO_TEST=' + JSON.stringify(demoResult));

  // 测试上传按钮触发文件对话框
  const clickTest = await page.evaluate(() => {
    const input = document.getElementById('fileInput');
    let fired = false;
    input?.addEventListener('click', () => { fired = true; }, { once: true });
    document.getElementById('welcomeUpload')?.click();
    return fired ? 'FILE_DIALOG_TRIGGERED' : 'NO_DIALOG_EVENT';
  });
  console.log('CLICK_TEST=' + clickTest);

  await page.screenshot({ path: 'diag_local.png' });
  console.log('--- CONSOLE ---');
  logs.slice(0, 20).forEach(l => console.log(l));
  await browser.close();
  server.close();
  process.exit(0);
});
