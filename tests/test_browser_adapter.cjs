#!/usr/bin/env node
'use strict';
// Only local loopback services are started. Requires the operator's own Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const example = JSON.parse(fs.readFileSync(path.join(root, 'adapters/browser.example.json'), 'utf8'));
const privateDir = path.join(root, 'adapters/private');
fs.mkdirSync(privateDir, {recursive: true});
const configPath = path.join(privateDir, `browser-test-${process.pid}.json`);
let passed = 0;
let activeTest = 'local mock startup';
const services = [];
function start(...flags) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [path.join(root, 'tools/mock-upstream/server.py'), '--port', '0', ...flags], {stdio: ['ignore', 'pipe', 'pipe']});
    services.push(child);
    const timer = setTimeout(() => reject(new Error('local mock startup timed out')), 5000);
    child.once('error', reject);
    child.once('exit', code => { if (code) reject(new Error('local mock startup failed')); });
    child.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
}
function configure(origin, change = () => {}) {
  const config = structuredClone(example);
  config.timeoutMs = 1800;
  config.allowedHosts = [new URL(origin).host];
  for (const section of ['login', 'create', 'query']) config[section].url = origin + '/' + section;
  change(config);
  fs.writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
}
function run(input, env = {}) {
  const child = spawnSync(process.execPath, [path.join(root, 'adapters/browser_adapter.cjs')], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 18000, maxBuffer: 32768,
    env: {...process.env, UPSTREAM_BROWSER_CONFIG: configPath, DEMO_UPSTREAM_USERNAME: 'demo-user', DEMO_UPSTREAM_PASSWORD: 'demo-only-password', ...env}
  });
  assert.equal(child.error, undefined, 'adapter must exit before deadline');
  assert.equal(child.status, 0, 'adapter exits normally with a structured result');
  assert.equal(child.stdout.trim().split('\n').length, 1, 'exactly one stdout JSON result');
  assert.equal(child.stderr, '', 'no raw browser errors or credentials on stderr');
  const output = JSON.parse(child.stdout);
  assert.ok(['processing', 'succeeded', 'failed', 'unknown', 'not_found', 'action_required'].includes(output.status));
  assert.ok(!child.stdout.includes('demo-only-password') && !child.stdout.includes('SYNTHETIC-TARGET'), 'no credential/target output');
  return output;
}
function check(name, body) { activeTest = name; body(); passed++; process.stdout.write(`PASS ${name}\n`); }
async function count(origin) {
  const result = await fetch(origin + '/__test/stats');
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(typeof data.orders, 'number');
  return data.orders;
}
async function main() {
  const origin = await start();
  configure(origin);
  const input = {operation: 'submit', merchant_order_id: 'TEST-CODE-001', product: {id: 'demo-code', kind: 'code'}, target: 'SYNTHETIC-TARGET', upstream_reference: ''};
  const first = run(input);
  check('submit returns processing and a reference', () => {
    assert.equal(first.status, 'processing'); assert.ok(first.reference.startsWith('SYNTHETIC-')); assert.equal(first.delivery, undefined);
  });
  const repeated = run(input);
  check('same merchant order returns original reference', () => {
    assert.equal(repeated.status, 'succeeded'); assert.equal(repeated.reference, first.reference);
  });
  const repeatedCount = await count(origin);
  check('repeated submission creates one order', () => { assert.equal(repeatedCount, 1); });
  check('query returns synthetic code delivery', () => {
    const output = run({...input, operation: 'query'});
    assert.equal(output.status, 'succeeded'); assert.equal(output.delivery.kind, 'code'); assert.ok(output.delivery.text.startsWith('DEMO-'));
  });
  check('query missing order returns not_found without creation', () => {
    assert.equal(run({...input, operation: 'query', merchant_order_id: 'MISSING'}).status, 'not_found');
  });
  const account = {...input, merchant_order_id: 'TEST-ACCOUNT-001', product: {id: 'demo-account', kind: 'account'}};
  run(account);
  check('account delivery uses reserved domain and public RFC seed', () => {
    const output = run({...account, operation: 'query'});
    assert.equal(output.status, 'succeeded'); assert.equal(output.delivery.email, 'demo@example.invalid');
    assert.equal(output.delivery.totp_secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
  check('backend custom invokes browser subprocess for submit and query', () => {
    const code = `
import json, tempfile
from pathlib import Path
from backend.config import Config
from backend.core import Store
with tempfile.TemporaryDirectory(prefix='fictional-browser-backend-') as temporary:
    config = Config(Path.cwd(), {'UPSTREAM_MODE':'custom','UPSTREAM_SCRIPT':'adapters/browser_adapter.cjs','ALLOW_LIVE_UPSTREAM':'true','ADMIN_PASSWORD':'synthetic-local-admin-only','DEMO_DATA_DIR':temporary})
    store = Store(config)
    created = store.create({'product_id':'demo-code','target':'SYNTHETIC-TARGET'})
    oid = created['order']['id']
    store.db.execute('UPDATE orders SET merchant_order_id=? WHERE id=?', ('BACKEND-SYNTHETIC-001', oid))
    store.db.commit()
    first = store.call_adapter(store.get(oid), 'submit')
    second = store.call_adapter(store.get(oid), 'query')
    assert first.get('status') == 'processing'
    assert second.get('status') == 'succeeded'
    assert first.get('reference') == second.get('reference')
    assert second.get('delivery', {}).get('kind') == 'code'
    store.db.close()
print('backend custom local integration passed')
`;
    const result = spawnSync(process.env.PYTHON || 'python3', ['-c', code], {cwd: root, encoding: 'utf8', timeout: 25000,
      env: {...process.env, UPSTREAM_BROWSER_CONFIG: configPath, DEMO_UPSTREAM_USERNAME: 'demo-user', DEMO_UPSTREAM_PASSWORD: 'demo-only-password'}});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, 'backend custom must obtain processing then delivery');
    assert.equal(result.stdout.trim(), 'backend custom local integration passed');
  });
  check('wrong account is rejected safely', () => { assert.equal(run(input, {DEMO_UPSTREAM_PASSWORD: 'wrong'}).error_code, 'LOGIN_FAILED'); });
  configure(origin, config => { config.create.targetSelector = '#missing-selector'; });
  check('missing selector does not create', () => { assert.equal(run({...input, merchant_order_id: 'MISSING-SELECTOR'}).error_code, 'SELECTOR_MISSING'); });
  assert.equal(await count(origin), 3);
  configure(origin, config => { config.allowedHosts = ['localhost:1']; });
  check('host outside exact allowlist is rejected', () => { assert.equal(run(input).error_code, 'URL_NOT_ALLOWED'); });
  configure(origin, config => { config.login.url = 'http://example.invalid/login'; config.allowedHosts.push('example.invalid'); });
  check('non-loopback HTTP URL is rejected before browsing', () => { assert.equal(run(input).error_code, 'URL_NOT_ALLOWED'); });
  configure(origin, config => { config.login.url = origin.replace('://', '://user:password@') + '/login'; });
  check('URL userinfo is rejected', () => { assert.equal(run(input).error_code, 'URL_NOT_ALLOWED'); });
  configure(origin);
  check('payload URLs cannot override local config', () => {
    const output = run({...input, operation: 'query', url: 'https://example.invalid/evil', selectors: {submit: '#evil'}});
    assert.equal(output.status, 'succeeded');
  });
  check('unknown page status is never guessed as success', () => {
    configure(origin, config => { config.result.statusMap = {not_found: 'not_found'}; });
    assert.equal(run({...input, operation: 'query'}).status, 'unknown');
  });
  const captchaOrigin = await start('--captcha');
  configure(captchaOrigin);
  check('captcha requires manual action without bypass', () => {
    const output = run(input); assert.equal(output.status, 'action_required'); assert.equal(output.error_code, 'CAPTCHA_REQUIRED');
  });
  assert.equal(await count(captchaOrigin), 0);
  const uncertainOrigin = await start('--query-unknown');
  configure(uncertainOrigin);
  check('uncertain preflight query never submits', () => { assert.equal(run(input).status, 'unknown'); });
  assert.equal(await count(uncertainOrigin), 0);
  const timeoutOrigin = await start('--submit-no-result');
  configure(timeoutOrigin);
  check('submit result timeout stays unknown', () => {
    const output = run(input); assert.equal(output.status, 'unknown'); assert.equal(output.error_code, 'RESULT_TIMEOUT');
  });
  assert.equal(await count(timeoutOrigin), 1);
  check('query recovers original order after timeout', () => { assert.equal(run({...input, operation: 'query'}).status, 'succeeded'); });
  assert.equal(await count(timeoutOrigin), 1);
  const resourceOrigin = await start('--external-resource');
  configure(resourceOrigin);
  check('disallowed external subresource is aborted', () => { assert.equal(run(input).error_code, 'URL_NOT_ALLOWED'); });
  const staleOrigin = await start('--query-no-navigation');
  configure(staleOrigin);
  check('stale not_found before async query never authorizes submit', () => {
    const output = run(input); assert.equal(output.status, 'unknown'); assert.equal(output.error_code, 'RESULT_TIMEOUT');
  });
  const staleStats = await (await fetch(staleOrigin + '/__test/stats')).json();
  check('stale query creates no order and preserves existing order', () => { assert.equal(staleStats.orders, 1); assert.equal(staleStats.create_posts, 0); });
  const sink = await start();
  // Positive control proves the separate local sink can observe handshakes.
  await new Promise((resolve, reject) => {
    const request = http.get(sink + '/synthetic-socket', {headers: {Connection: 'Upgrade', Upgrade: 'websocket'}}, response => { response.resume(); response.on('end', resolve); });
    request.on('error', reject);
  });
  assert.equal((await (await fetch(sink + '/__test/stats')).json()).websocket_handshakes, 1);
  for (const mode of ['page', 'iframe', 'worker']) {
    const socketOrigin = await start('--websocket-port', new URL(sink).port, '--socket-mode', mode);
    configure(socketOrigin);
    const output = run(input);
    const socketStats = await (await fetch(socketOrigin + '/__test/stats')).json();
    const sinkStats = await (await fetch(sink + '/__test/stats')).json();
    if (output.status !== 'unknown' || output.error_code !== 'URL_NOT_ALLOWED' || sinkStats.websocket_handshakes !== 1 || socketStats.create_posts !== 0) {
      process.stdout.write(JSON.stringify({case: mode, status: output.status, error_code: output.error_code,
        additional_handshakes: sinkStats.websocket_handshakes - 1, create_posts: socketStats.create_posts}) + '\n');
    }
    check(`${mode} WebSocket cannot reach disallowed local sink or create order`, () => {
      assert.equal(output.status, 'unknown'); assert.equal(output.error_code, 'URL_NOT_ALLOWED');
      assert.equal(sinkStats.websocket_handshakes, 1, 'zero additional handshakes after positive control');
      assert.equal(socketStats.create_posts, 0);
    });
  }
  process.stdout.write(`RESULT ${passed} passed, 0 failed; local loopback only\n`);
}
main().catch(() => { process.stderr.write(`FAIL ${activeTest}; no upstream details logged\n`); process.exitCode = 1; }).finally(() => {
  for (const child of services) child.kill('SIGTERM');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
});
