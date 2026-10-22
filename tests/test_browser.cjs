'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require(process.env.GC_PUPPETEER_MODULE || 'puppeteer-core');
const root = path.resolve(__dirname, '..');
const password = 'SYNTHETIC-BROWSER-TEST-PASSWORD';
const qa = path.join('/tmp', 'card-exchange-demo-qa');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
(async () => {
  const port = process.env.PORT ? Number(process.env.PORT) : await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-demo-browser-'));
  fs.mkdirSync(qa, { recursive: true });
  // Force local mock config even when the user's own .env enables a custom adapter.
  const bootstrap = [
    'from pathlib import Path', 'from backend.config import Config', 'from backend.http import create_server',
    `c=Config(Path.cwd(), {'UPSTREAM_MODE':'mock','UPSTREAM_SCRIPT':'adapters/mock_adapter.py','PAYMENT_QR_FILE':'assets/demo-qr.svg','ALLOW_LIVE_UPSTREAM':'false'})`,
    's,a=create_server(c)', 's.serve_forever()'
  ].join('\n');
  const child = spawn(process.env.DEMO_TEST_PYTHON || 'python3', ['-c', bootstrap], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin, DEMO_DATA_DIR: dataDir, ADMIN_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serviceError = '';
  child.stderr.on('data', (chunk) => { serviceError += chunk.toString(); });
  let browser;
  const pageErrors = [], unexpectedNetwork = [], consoleErrors = [];
  const geometry = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const r = await fetch(`${origin}/api/health`); if (r.ok) break; } catch (_) {}
      if (child.exitCode !== null) throw new Error(`Local test server failed: ${serviceError}`);
      if (attempt === 99) throw new Error('Local test server did not become ready');
      await sleep(100);
    }
    const executablePath = process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) throw new Error('Set CHROME_BIN to a locally installed Chromium browser executable');
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 1280, height: 900 } });
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) consoleErrors.push(msg.text());
    });
    await page.setRequestInterception(true);
    let interceptor = null;
    page.on('request', (request) => {
      if (!request.url().startsWith(origin + '/') && request.url() !== 'about:blank') { unexpectedNetwork.push(request.url()); return request.abort(); }
      if (interceptor && interceptor(request)) return;
      void request.continue();
    });
    async function api(endpoint, body) {
      return page.evaluate(async (endpoint, body) => {
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
      }, endpoint, body);
    }
    async function fill(selector, value) {
      await page.$eval(selector, (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    }
    async function create(productId, target) {
      await page.goto(origin, { waitUntil: 'networkidle0' });
      await page.select('#product', productId); await fill('#target', target);
      const response = page.waitForResponse((r) => r.url() === origin + '/api/orders' && r.request().method() === 'POST');
      await page.click('#create'); const result = await (await response).json();
      await page.waitForSelector('#created:not([hidden])'); return result;
    }
    async function lookup(order) {
      await page.goto(origin + '/track', { waitUntil: 'networkidle0' });
      await fill('#order-id', order.order.id); await fill('#lookup-code', order.lookup_code); await page.click('#lookup');
    }
    async function geometryCheck(label) {
      const metrics = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const overflowing = Array.from(document.querySelectorAll('main *,header *,dialog[open] *')).filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && (box.right > width + 1 || box.left < -1);
        }).map((node) => node.id || node.tagName).slice(0, 12);
        return { viewport: width, documentWidth: document.documentElement.scrollWidth, overflowing };
      });
      geometry.push({ label, ...metrics });
      check(metrics.documentWidth <= metrics.viewport && metrics.overflowing.length === 0, `No horizontal overflow: ${label} ${JSON.stringify(metrics)}`);
    }
    const first = await create('demo-account', 'SYNTHETIC-TARGET-ID');
    check(first.order.state === 'awaiting_payment' && first.lookup_code.length > 20, 'Account order and one-time lookup code created');
    check(await page.$eval('#created-code', (node) => node.type) === 'password', 'Lookup code masked');
    check((await page.$eval('#mode', (node) => node.textContent)).includes('请勿付款'), 'Mock mode prominent warning');
    const qr = await fetch(origin + '/assets/payment-qr').then((response) => response.text());
    check(qr.includes('请勿付款') && qr.includes('此图不包含支付信息'), 'Non-payable demo image');
    await fill('#payment-reference', 'SYNTHETIC-REFERENCE'); await page.click('#declare-payment');
    await page.waitForFunction(() => document.querySelector('#payment-message').textContent.includes('核款申请已提交'));
    let inspected = await api('/api/orders/lookup', { id: first.order.id, lookup_code: first.lookup_code });
    check(inspected.data.order.state === 'payment_review' && inspected.data.order.delivery === null, 'Payment declaration does not purchase');
    const second = await create('demo-code', 'OTHER-SYNTHETIC-ID');
    const cross = await api('/api/orders/lookup', { id: first.order.id, lookup_code: second.lookup_code });
    check(cross.status >= 400 && !cross.data.order, 'Other order lookup code rejected');
    const crossPay = await api('/api/orders/payment', { id: first.order.id, lookup_code: second.lookup_code, payment_reference: 'INVALID-CROSS-ORDER' });
    check(crossPay.status >= 400 && !crossPay.data.order, 'Other order payment authorization rejected');
    await page.goto(origin + '/merchant', { waitUntil: 'networkidle0' });
    await fill('#merchant-password', password); await page.click('#login');
    await page.waitForSelector('#merchant-panel:not([hidden])');
    const firstSelector = `[data-order-id="${first.order.id}"]`;
    await page.waitForSelector(firstSelector + ' [data-action="confirm"]');
    await page.click(firstSelector + ' [data-action="confirm"]');
    check(await page.$eval('#confirm-summary', (node) => node.textContent.includes('SYNTHETIC-REFERENCE') && node.textContent.includes('2.00')), 'Confirmation displays amount and customer reference');
    check(await page.$eval('#received-amount', (node) => node.value) === '', 'Received amount requires manual entry');
    await fill('#received-amount', '0.01'); await page.click('#received-check'); await page.click('#confirm-received');
    await page.waitForFunction(() => document.querySelector('#confirm-message').classList.contains('error') && document.querySelector('#confirm-message').textContent.length > 0);
    inspected = await api('/api/orders/lookup', { id: first.order.id, lookup_code: first.lookup_code });
    check(inspected.data.order.state === 'payment_review', 'Wrong amount leaves order unpurchased');
    await page.setViewport({ width: 390, height: 844 }); await geometryCheck('merchant-confirm-mobile');
    await page.screenshot({ path: path.join(qa, 'merchant-confirm-mobile.png'), fullPage: true });
    await fill('#received-amount', '2.00');
    let confirms = 0;
    const countConfirm = (request) => { if (request.url().endsWith(`/${first.order.id}/confirm`)) confirms++; };
    page.on('request', countConfirm);
    await page.$eval('#confirm-received', (button) => { button.click(); button.click(); });
    await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
    // Refresh promptly while the real worker moves queued -> processing.
    // Waiting for a stale queued list to update itself would miss the query window.
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await page.$(firstSelector + ' [data-action="query"]')) break;
      await page.click('#refresh-orders');
      await page.waitForFunction(() => !document.querySelector('#refresh-orders').disabled);
      await sleep(40);
    }
    await page.waitForSelector(firstSelector + ' [data-action="query"]', { timeout: 500 });
    await page.click(firstSelector + ' [data-action="query"]');
    await page.waitForFunction((selector) => document.querySelector(selector).dataset.orderState === 'completed', {}, firstSelector);
    check(confirms === 1, 'Repeated confirmation click sends one request');
    page.off('request', countConfirm);
    await geometryCheck('merchant-list-mobile');
    await page.screenshot({ path: path.join(qa, 'merchant-list-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 900 }); await geometryCheck('merchant-desktop');
    await page.screenshot({ path: path.join(qa, 'merchant-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await page.click('#logout');
    await page.waitForFunction(() => document.querySelector('#merchant-message').textContent.includes('已退出'));
    check(await page.$eval('#merchant-orders', (node) => node.children.length) === 0, 'Logout clears order data');
    const loggedOut = await api('/api/merchant/orders'); check(loggedOut.status === 401, 'Logout invalidates merchant session');
    await lookup(first);
    await page.waitForSelector('#delivery-password');
    await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('#delivery-otp').value));
    check(await page.$eval('#delivery-password', (node) => node.type) === 'password', 'Delivered password masked');
    check(await page.$eval('#delivery-email', (node) => node.value) === 'demo@example.invalid', 'Synthetic account delivered');
    const otp = await page.evaluate(async () => ({ generated: document.querySelector('#delivery-otp').value, expected: await (await LocalTotp.create('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).at(Date.now() / 1000) }));
    check(otp.generated === otp.expected, 'Automatic account OTP matches current RFC computation');
    const rfc = await page.evaluate(async () => (await LocalTotp.create('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { digits: 8 })).at(59));
    check(rfc === '94287082', 'RFC6238 known test vector');
    await geometryCheck('track-account-mobile'); await page.screenshot({ path: path.join(qa, 'track-account-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 900 }); await geometryCheck('track-desktop');
    await page.screenshot({ path: path.join(qa, 'track-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), query: location.search }));
    check(storage.local.length === 0 && storage.session.length === 0 && storage.query === '', 'No secret browser storage or URL query');
    await fill('#order-id', second.order.id);
    check(await page.$('#delivery-password') === null && await page.$('#delivery-otp') === null, 'Identity change removes credentials and OTP');
    await fill('#lookup-code', first.lookup_code); await page.click('#lookup');
    await page.waitForFunction(() => document.querySelector('#lookup-message').classList.contains('error'));
    check(await page.$('#delivery-password') === null, 'Cross-order failure cannot retain previous account');
    await lookup(first); await page.waitForSelector('#delivery-password');
    // Exercise actual browser visibility changes by putting another tab in front.
    const foreground = await browser.newPage(); await foreground.bringToFront();
    await page.waitForFunction(() => !document.querySelector('#delivery-password'), { timeout: 5000 });
    check(await page.$eval('#lookup-code', (node) => node.value) === '', 'Hidden page clears identity and account');
    await foreground.close(); await page.bringToFront();
    // Hold a real response in transit; changing identity must invalidate it.
    let held;
    interceptor = (request) => {
      if (request.url().endsWith('/api/orders/lookup')) { held = request; return true; } return false;
    };
    await fill('#order-id', first.order.id); await fill('#lookup-code', first.lookup_code); await page.click('#lookup');
    for (let i = 0; !held && i < 50; i++) await sleep(20);
    check(Boolean(held), 'In-flight lookup captured');
    await fill('#order-id', second.order.id);
    await held.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: { ...first.order, state: 'completed', delivery: { kind: 'account', email: 'stale@example.invalid', password: 'SYNTHETIC-STALE', totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } } }) });
    interceptor = null; await sleep(150);
    check(await page.$('#delivery-password') === null, 'Revision check rejects stale lookup response');
    // Long unbroken and markup-looking values must remain text and fit a 390px screen.
    const longText = 'SYNTHETIC'.repeat(20);
    interceptor = (request) => {
      if (request.url().endsWith('/api/orders/lookup')) {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: { ...first.order, product_name: '<img src=x onerror=alert(1)>' + longText, target: longText, status_text: longText, state: 'completed', delivery: { kind: 'account', email: longText + '@example.invalid', password: longText, totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } } }) }); return true;
      } return false;
    };
    await fill('#order-id', first.order.id); await fill('#lookup-code', first.lookup_code); await page.click('#lookup'); await page.waitForSelector('#delivery-password');
    check(await page.$$eval('#order-summary img', (nodes) => nodes.length) === 0, 'Untrusted strings rendered as text');
    await geometryCheck('long-account-mobile'); await page.screenshot({ path: path.join(qa, 'long-account-mobile.png'), fullPage: true });
    interceptor = null;
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    check(await page.$('#delivery-password') === null && await page.$eval('#lookup-code', (node) => node.value) === '', 'Pagehide clears identity and delivery');
    // Accelerate only the five-second poll timer; preserve the actual bounded loop.
    let polls = 0;
    await page.evaluate(() => {
      window.originalTimeoutForTest = window.setTimeout;
      window.setTimeout = (handler, delay, ...args) => window.originalTimeoutForTest(handler, delay === 5000 ? 5 : delay, ...args);
    });
    interceptor = (request) => {
      if (request.url().endsWith('/api/orders/lookup')) {
        polls++;
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: { ...first.order, state: 'processing', status_text: '演示处理中', delivery: null } }) }); return true;
      } return false;
    };
    await fill('#order-id', first.order.id); await fill('#lookup-code', first.lookup_code); await page.click('#lookup');
    await page.waitForFunction(() => document.querySelector('#lookup-message').textContent.includes('自动查询已结束'));
    await sleep(100);
    check(polls === 13, 'Processing stops after initial lookup plus 12 automatic polls');
    await page.evaluate(() => { window.setTimeout = window.originalTimeoutForTest; delete window.originalTimeoutForTest; });
    interceptor = (request) => {
      if (request.url().endsWith('/api/orders/lookup')) {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: { ...second.order, state: 'completed', status_text: '交付完成', delivery: { kind: 'code', text: 'DEMO-SYNTHETIC-CODE' } } }) }); return true;
      } return false;
    };
    await fill('#order-id', second.order.id); await fill('#lookup-code', second.lookup_code); await page.click('#lookup');
    await page.waitForSelector('#delivery-code');
    check(await page.$eval('#delivery-code', (node) => node.value) === 'DEMO-SYNTHETIC-CODE', 'Code delivery is available only in completed view');
    interceptor = null;
    // Synthetic unknown state exposes only original-order query, never repurchase/refund/success.
    await page.goto(origin + '/merchant', { waitUntil: 'networkidle0' });
    interceptor = (request) => {
      if (request.url().endsWith('/api/merchant/orders') && request.method() === 'GET') {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: [{ ...first.order, state: 'unknown', status_text: '结果待核查', payment_reference: longText, target: longText, delivery: null }] }) }); return true;
      } return false;
    };
    await fill('#merchant-password', password); await page.click('#login'); await page.waitForSelector('[data-action="query"]');
    const actions = await page.$$eval('.order-item button', (nodes) => nodes.map((node) => node.textContent));
    check(actions.length === 1 && actions[0] === '查询原订单', 'Unknown state offers only original-order query');
    await geometryCheck('unknown-merchant-mobile'); await page.screenshot({ path: path.join(qa, 'unknown-merchant-mobile.png'), fullPage: true });
    interceptor = null;
    await page.goto(origin, { waitUntil: 'networkidle0' }); await geometryCheck('shop-mobile');
    await page.screenshot({ path: path.join(qa, 'shop-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 900 }); await geometryCheck('shop-desktop');
    await page.screenshot({ path: path.join(qa, 'shop-desktop.png'), fullPage: true });
    check(pageErrors.length === 0 && consoleErrors.length === 0, `No JavaScript/CSP errors: ${JSON.stringify([...pageErrors, ...consoleErrors])}`);
    check(unexpectedNetwork.length === 0, 'Browser requested local resources only');
    fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify({ checks, geometry, pageErrors, consoleErrors, unexpectedNetworkCount: unexpectedNetwork.length }, null, 2));
    console.log(JSON.stringify({ passed: checks, geometry, screenshots: qa, externalRequests: unexpectedNetwork.length }, null, 2));
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); } });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
