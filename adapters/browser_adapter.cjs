#!/usr/bin/env node
'use strict';

// Generic, opt-in template. All website-specific information comes from the
// operator's fixed local configuration, never from a customer's order payload.
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const STATES = new Set(['processing', 'succeeded', 'failed', 'unknown', 'not_found', 'action_required']);
const ERRORS = new Set(['INVALID_INPUT', 'CONFIG_REQUIRED', 'CONFIG_INVALID', 'URL_NOT_ALLOWED',
  'DEPENDENCY_UNAVAILABLE', 'BROWSER_UNAVAILABLE', 'CREDENTIALS_REQUIRED', 'LOGIN_FAILED',
  'SELECTOR_MISSING', 'CAPTCHA_REQUIRED', 'RESULT_TIMEOUT', 'RESULT_INVALID', 'BROWSER_ERROR', 'ADAPTER_TIMEOUT']);
class AdapterError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new AdapterError(code); }
function string(value, max = 512) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function validateUrl(raw, config) {
  let url;
  try { url = new URL(raw); } catch { fail('URL_NOT_ALLOWED'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !config.allowedHosts.includes(url.host) ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) fail('URL_NOT_ALLOWED');
  return url.href;
}
function configuration() {
  const filename = process.env.UPSTREAM_BROWSER_CONFIG;
  if (!filename) fail('CONFIG_REQUIRED');
  // Keep private operator configuration in the gitignored adapters/private/ tree.
  const privateRoot = fs.realpathSync(path.join(__dirname, 'private'));
  const actual = fs.realpathSync(filename);
  if (!actual.startsWith(privateRoot + path.sep)) fail('CONFIG_INVALID');
  let config;
  try { config = JSON.parse(fs.readFileSync(actual, 'utf8')); } catch { fail('CONFIG_INVALID'); }
  if (!Array.isArray(config.allowedHosts) || !config.allowedHosts.length ||
      config.allowedHosts.some(h => !string(h) || h.includes('/') || h.includes('@') || h.includes('*')) ||
      typeof config.headless !== 'boolean' || !Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 200 || config.timeoutMs > 60000) fail('CONFIG_INVALID');
  const required = {
    login: ['url', 'usernameSelector', 'passwordSelector', 'submitSelector', 'successSelector', 'errorSelector', 'captchaSelector'],
    create: ['url', 'productSelector', 'targetSelector', 'merchantRefSelector', 'submitSelector'],
    query: ['url', 'merchantRefSelector', 'submitSelector'],
    result: ['rootSelector', 'statusSelector', 'statusAttribute', 'referenceSelector']
  };
  for (const [section, keys] of Object.entries(required)) {
    if (!config[section] || keys.some(key => !string(config[section][key]))) fail('CONFIG_INVALID');
  }
  if (!['select', 'input'].includes(config.create.productControl) || !config.result.statusMap ||
      Object.values(config.result.statusMap).some(status => !STATES.has(status)) ||
      !config.result.delivery || typeof config.result.delivery !== 'object') fail('CONFIG_INVALID');
  for (const section of ['login', 'create', 'query']) validateUrl(config[section].url, config);
  return config;
}
async function readInput() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 16384) fail('INVALID_INPUT');
  }
  let input;
  try { input = JSON.parse(data); } catch { fail('INVALID_INPUT'); }
  if (!input || !['submit', 'query'].includes(input.operation) || !string(input.merchant_order_id, 128) ||
      !input.product || !string(input.product.id, 128) || !['code', 'account'].includes(input.product.kind) ||
      !string(input.target, 1000) || (input.upstream_reference !== undefined &&
      (typeof input.upstream_reference !== 'string' || input.upstream_reference.length > 512))) fail('INVALID_INPUT');
  return input;
}
async function automate(input, config) {
  if (!process.env.DEMO_UPSTREAM_USERNAME || !process.env.DEMO_UPSTREAM_PASSWORD) fail('CREDENTIALS_REQUIRED');
  let puppeteer;
  try { puppeteer = require(process.env.GC_PUPPETEER_MODULE || 'puppeteer-core'); }
  catch { fail('DEPENDENCY_UNAVAILABLE'); }
  let browser;
  let blocked = false;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    if (browser) void browser.close().catch(() => {});
  }, 45000);
  try {
    try {
      browser = await puppeteer.launch({headless: config.headless,
        ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
        args: ['--disable-extensions', '--disable-background-networking']});
    } catch { fail('BROWSER_UNAVAILABLE'); }
    const guard = async page => {
      await page.setBypassServiceWorker(true);
      await page.setCacheEnabled(false);
      // Chromium enforces this on document responses, including frames;
      // replacing window.WebSocket alone would be bypassable by another realm.
      const session = await page.createCDPSession();
      await session.send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
      await session.send('Audits.enable');
      session.on('Audits.issueAdded', event => {
        const directive = event.issue?.details?.contentSecurityPolicyIssueDetails?.violatedDirective || '';
        if (event.issue?.code === 'ContentSecurityPolicyIssue' &&
            ['connect-src', 'worker-src'].some(name => directive.startsWith(name))) blocked = true;
      });
      session.on('Fetch.requestPaused', async event => {
        try {
          if (event.responseStatusCode) {
            const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400 &&
              (event.responseHeaders || []).some(header => header.name.toLowerCase() === 'location');
            if (event.resourceType === 'Document' && !redirect && ![204, 205, 304].includes(event.responseStatusCode)) {
              const response = await session.send('Fetch.getResponseBody', {requestId: event.requestId});
              if (Buffer.byteLength(response.body) > 8 * 1024 * 1024) throw new Error('document limit');
              // Fulfill with the same body: merely continuing with changed headers
              // did not apply CSP in the tested Chromium. Never log page contents.
              const headers = (event.responseHeaders || []).filter(header =>
                !['content-length', 'content-encoding'].includes(header.name.toLowerCase()));
              headers.push({name: 'Content-Security-Policy', value: "connect-src 'none'; worker-src 'none'"});
              await session.send('Fetch.fulfillRequest', {requestId: event.requestId,
                responseCode: event.responseStatusCode, responseHeaders: headers,
                body: response.base64Encoded ? response.body : Buffer.from(response.body).toString('base64')});
            } else {
              await session.send('Fetch.continueResponse', {requestId: event.requestId});
            }
          } else {
            validateUrl(event.request.url, config);
            await session.send('Fetch.continueRequest', {requestId: event.requestId, interceptResponse: true});
          }
        } catch {
          blocked = true;
          await session.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'BlockedByClient'}).catch(() => {});
        }
      });
      page.setDefaultTimeout(config.timeoutMs);
      page.setDefaultNavigationTimeout(config.timeoutMs);
    };
    // New isolated browser, no user's profile, cookies or TLS bypass settings.
    const page = await browser.newPage();
    await guard(page);
    page.on('console', message => {
      // Worker CSP violations are reported through the owning page's console.
      // Inspect only the fixed directive marker; never print console contents.
      if (message.type() === 'error' && ["connect-src 'none'", "worker-src 'none'"].some(marker => message.text().includes(marker))) blocked = true;
    });
    await page.exposeFunction('__demoConnectionBlocked', () => { blocked = true; });
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('securitypolicyviolation', event => {
        if (['connect-src', 'worker-src'].includes(event.effectiveDirective)) void window.__demoConnectionBlocked();
      }, true);
    });
    await page.evaluateOnNewDocument(() => { window.open = () => null; });
    browser.on('targetcreated', async target => {
      if (target.type() === 'page') {
        const popup = await target.page().catch(() => null);
        if (popup && popup !== page) { blocked = true; await popup.close().catch(() => {}); }
      }
    });
    const check = async () => {
      if (blocked) fail('URL_NOT_ALLOWED');
      if (await page.$(config.login.captchaSelector)) fail('CAPTCHA_REQUIRED');
    };
    const go = async url => {
      await page.goto(validateUrl(url, config), {waitUntil: 'domcontentloaded'});
      await check();
    };
    const fill = async (selector, value, select = false) => {
      await check();
      const element = await page.$(selector);
      if (!element) fail('SELECTOR_MISSING');
      if (select) {
        const selected = await page.select(selector, value);
        if (!selected.length) fail('RESULT_INVALID');
      } else {
        await element.click({clickCount: 3});
        await element.press('Backspace');
        await element.type(value);
      }
    };
    const click = async selector => {
      await check();
      if (!(await page.$(selector))) fail('SELECTOR_MISSING');
      await page.click(selector);
    };
    const navigateForm = async selector => {
      try {
        // A visible pre-existing result is not evidence of this form's result.
        // This template supports traditional document navigation, never AJAX.
        const [response] = await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), click(selector)]);
        // history.pushState/hash changes also emit navigation but load no document.
        if (!response || !response.request().isNavigationRequest()) fail('RESULT_TIMEOUT');
      } catch (error) {
        await check();
        if (error instanceof AdapterError) throw error;
        fail('RESULT_TIMEOUT');
      }
      await check();
    };
    const read = async (selector, attribute) => {
      if (!selector) return '';
      const element = await page.$(selector);
      if (!element) return '';
      return element.evaluate((el, attr) => (attr ? el.getAttribute(attr) || '' : el.textContent || '').trim(), attribute);
    };
    const result = async () => {
      try { await page.waitForSelector(config.result.rootSelector, {visible: true}); }
      catch { await check(); fail('RESULT_TIMEOUT'); }
      await check();
      const raw = await read(config.result.statusSelector, config.result.statusAttribute);
      const status = Object.prototype.hasOwnProperty.call(config.result.statusMap, raw) ? config.result.statusMap[raw] : 'unknown';
      const reference = (await read(config.result.referenceSelector)).slice(0, 512);
      const output = {status, reference, error_code: ''};
      if (status === 'succeeded') {
        const d = config.result.delivery;
        const kind = await read(d.kindSelector);
        const delivery = kind === 'code' ? {kind, text: await read(d.textSelector)} :
          {kind, email: await read(d.emailSelector), password: await read(d.passwordSelector), totp_secret: await read(d.totpSecretSelector)};
        if (!['code', 'account'].includes(kind) || kind !== input.product.kind ||
            Object.values(delivery).some(value => !string(value, 16000))) fail('RESULT_INVALID');
        output.delivery = delivery;
      }
      return output;
    };
    await go(config.login.url);
    await fill(config.login.usernameSelector, process.env.DEMO_UPSTREAM_USERNAME);
    await fill(config.login.passwordSelector, process.env.DEMO_UPSTREAM_PASSWORD);
    await navigateForm(config.login.submitSelector);
    try {
      await page.waitForFunction((success, error, captcha) => document.querySelector(success) ||
        document.querySelector(error) || document.querySelector(captcha), {timeout: config.timeoutMs},
      config.login.successSelector, config.login.errorSelector, config.login.captchaSelector);
    } catch { await check(); fail('LOGIN_FAILED'); }
    await check();
    if (await page.$(config.login.errorSelector) || !(await page.$(config.login.successSelector))) fail('LOGIN_FAILED');
    // Always reconcile by the immutable merchant order ID before creating.
    await go(config.query.url);
    await fill(config.query.merchantRefSelector, input.merchant_order_id);
    if (config.query.referenceSelector) await fill(config.query.referenceSelector, input.upstream_reference || '');
    await navigateForm(config.query.submitSelector);
    const prior = await result();
    if (input.operation === 'query' || prior.status !== 'not_found') return prior;
    await go(config.create.url);
    await fill(config.create.productSelector, input.product.id, config.create.productControl === 'select');
    await fill(config.create.targetSelector, input.target);
    await fill(config.create.merchantRefSelector, input.merchant_order_id);
    // From here, an uncertain outcome must never be treated as safe to retry.
    await navigateForm(config.create.submitSelector);
    const created = await result();
    return created.status === 'not_found' ? {status: 'unknown', reference: '', error_code: 'RESULT_INVALID'} : created;
  } catch (error) {
    const code = deadlineExceeded ? 'ADAPTER_TIMEOUT' :
      (ERRORS.has(error.code) ? error.code : (blocked ? 'URL_NOT_ALLOWED' : 'BROWSER_ERROR'));
    return {status: code === 'CAPTCHA_REQUIRED' ? 'action_required' : 'unknown',
      reference: input.upstream_reference || '', error_code: code};
  } finally {
    clearTimeout(deadline);
    if (browser) await browser.close().catch(() => {});
  }
}
async function main() {
  try {
    const input = await readInput();
    let config;
    try { config = configuration(); }
    catch (error) { fail(ERRORS.has(error.code) ? error.code : 'CONFIG_INVALID'); }
    return await automate(input, config);
  } catch (error) {
    return {status: 'unknown', reference: '', error_code: ERRORS.has(error.code) ? error.code : 'BROWSER_ERROR'};
  }
}
main().then(output => { process.stdout.write(JSON.stringify(output) + '\n'); });
