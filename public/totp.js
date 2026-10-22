(function (scope) {
  'use strict';

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function decodeBase32(value) {
    if (typeof value !== 'string') throw new Error('请输入 Base32 密钥');
    const text = value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]+={0,6}$/.test(text)) throw new Error('密钥格式不正确');
    const content = text.replace(/=+$/, '');
    const remainder = content.length % 8;
    const padding = { 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 }[remainder];
    if (padding === undefined || (text.includes('=') &&
        (text.length % 8 !== 0 || text.length - content.length !== padding))) {
      throw new Error('密钥长度或补位不正确');
    }
    const bytes = new Uint8Array(Math.floor(content.length * 5 / 8));
    let buffer = 0;
    let bits = 0;
    let index = 0;
    for (const char of content) {
      buffer = (buffer << 5) | alphabet.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes[index++] = (buffer >>> bits) & 255;
      }
      buffer &= (1 << bits) - 1;
    }
    if (buffer !== 0) {
      bytes.fill(0);
      throw new Error('密钥尾部补位不正确');
    }
    return bytes;
  }

  async function create(base32, { digits = 6, algorithm = 'SHA-1', period = 30 } = {}) {
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
      throw new Error('验证码位数必须为 6 至 8 位');
    }
    if (!['SHA-1', 'SHA-256', 'SHA-512'].includes(algorithm)) {
      throw new Error('不支持的验证码算法');
    }
    if (!Number.isSafeInteger(period) || period <= 0) throw new Error('周期必须为正整数');
    if (!scope.crypto || !scope.crypto.subtle) {
      throw new Error('当前浏览器不支持安全计算，请使用 HTTPS 页面');
    }
    const bytes = decodeBase32(base32);
    base32 = null;
    const subtle = scope.crypto.subtle;
    let key;
    try {
      key = await subtle.importKey('raw', bytes, { name: 'HMAC', hash: algorithm }, false, ['sign']);
    } finally {
      bytes.fill(0);
    }
    return {
      async at(unixSeconds) {
        if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds) ||
            unixSeconds < 0 || unixSeconds > Number.MAX_SAFE_INTEGER) {
          throw new Error('时间必须为有效的 Unix 秒数');
        }
        let counter = BigInt(Math.floor(unixSeconds / period));
        const message = new Uint8Array(8);
        for (let i = 7; i >= 0; i--) {
          message[i] = Number(counter & 255n);
          counter >>= 8n;
        }
        const digest = new Uint8Array(await subtle.sign('HMAC', key, message));
        const offset = digest[digest.length - 1] & 15;
        const value = ((digest[offset] & 127) * 16777216) +
          (digest[offset + 1] << 16) + (digest[offset + 2] << 8) + digest[offset + 3];
        return String(value % (10 ** digits)).padStart(digits, '0');
      }
    };
  }

  function mount(root) {
    const find = (name) => {
      const element = root.querySelector('[data-totp-' + name + ']');
      if (!element) throw new Error('验证码组件缺少 ' + name + ' 元素');
      return element;
    };
    const input = find('secret');
    const start = find('start');
    const reset = find('clear');
    const code = find('code');
    const copy = find('copy');
    const remaining = find('remaining');
    const message = find('message');
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    code.readOnly = true;
    let revision = 0;
    let active = null;
    let timer = null;
    let renderedCounter = null;
    let pendingCounter = null;

    function clear() {
      revision++;
      active = null;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      renderedCounter = null;
      pendingCounter = null;
      input.value = '';
      code.value = '';
      remaining.textContent = '—';
      message.textContent = '';
      copy.disabled = true;
    }

    async function tick(token) {
      if (token !== revision || !active || doc.visibilityState === 'hidden') return;
      const now = Date.now();
      const counter = Math.floor(now / 30000);
      remaining.textContent = String(30 - Math.floor(now / 1000) % 30);
      if (renderedCounter !== counter) {
        code.value = '';
        copy.disabled = true;
      }
      timer = win.setTimeout(() => tick(token), 1000 - now % 1000);
      if (renderedCounter === counter || pendingCounter === counter) return;
      pendingCounter = counter;
      try {
        const value = await active.at(now / 1000);
        if (token !== revision || !active || doc.visibilityState === 'hidden' ||
            Math.floor(Date.now() / 30000) !== counter) return;
        code.value = value;
        copy.disabled = false;
        renderedCounter = counter;
        message.textContent = '验证码已生成，仅在本页临时使用';
      } catch (_) {
        if (token === revision) {
          clear();
          message.textContent = '验证码计算失败，请重新输入密钥';
        }
      } finally {
        if (token === revision && pendingCounter === counter) pendingCounter = null;
      }
    }

    async function setSecret(secret) {
      clear();
      const token = revision;
      if (doc.visibilityState === 'hidden') {
        secret = null;
        message.textContent = '页面已隐藏，请返回后重新输入密钥';
        return;
      }
      message.textContent = '正在本地计算…';
      try {
        const request = create(secret);
        secret = null;
        const generator = await request;
        if (token !== revision || doc.visibilityState === 'hidden') return;
        active = generator;
        await tick(token);
      } catch (_) {
        secret = null;
        if (token === revision) {
          clear();
          message.textContent = '密钥格式无效或浏览器不支持安全计算，请检查后重试';
        }
      }
    }

    function generate(event) {
      event.preventDefault();
      void setSecret(input.value);
    }
    start.addEventListener('click', generate);
    root.addEventListener('submit', generate);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') generate(event);
    });
    input.addEventListener('input', () => {
      const current = input.value;
      clear();
      input.value = current;
    });
    reset.addEventListener('click', (event) => {
      event.preventDefault();
      clear();
      message.textContent = '密钥和验证码已清除';
    });
    copy.addEventListener('click', async (event) => {
      event.preventDefault();
      if (copy.disabled || !code.value) return;
      const token = revision;
      const value = code.value;
      try {
        await win.navigator.clipboard.writeText(value);
        if (token === revision && code.value === value) message.textContent = '验证码已复制';
      } catch (_) {
        if (token !== revision || code.value !== value) return;
        code.focus();
        code.select();
        message.textContent = '自动复制不可用，已选中验证码，请手动复制';
      }
    });
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') clear();
    });
    win.addEventListener('pagehide', clear);
    clear();
    return { setSecret, clear };
  }

  const api = { create, mount };
  scope.LocalTotp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
