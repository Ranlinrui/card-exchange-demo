(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  function message(id, value, error = false) {
    $(id).textContent = value;
    $(id).classList.toggle('error', error);
  }
  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'
    });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '操作未成功，请重试');
    return data;
  }
  const money = (cents, currency = 'CNY') => Number.isSafeInteger(cents)
    ? `${(cents / 100).toFixed(2)} ${currency}` : '金额待核实';
  function summary(root, order, merchant = false) {
    const dl = element('dl');
    const rows = [['订单号', order.id], ['商品', order.product_name], ['订单金额', money(order.amount_cents, order.currency)],
      ['目标账号', order.target], ['当前状态', order.status_text || order.state]];
    if (merchant) rows.push(['付款参考', order.payment_reference || '客户尚未申报']);
    for (const [key, value] of rows) { dl.append(element('dt', key), element('dd', value ?? '—')); }
    root.replaceChildren(dl);
  }
  async function copy(value, success) {
    try { await navigator.clipboard.writeText(value); success('已复制，请妥善保存'); }
    catch (_) { success('浏览器未允许自动复制，请选中输入框内容后手动复制'); }
  }
  let deliveryComponent = null;
  let deliveryRevision = 0;
  function clearDelivery() {
    deliveryRevision++;
    if (deliveryComponent) deliveryComponent.clear();
    deliveryComponent = null;
    if ($('delivery')) $('delivery').replaceChildren();
  }
  function credential(root, label, value, id, secret = true) {
    const row = element('div', undefined, 'secret-row');
    const group = element('div');
    const text = element('label', label); text.htmlFor = id;
    const input = element('input'); input.id = id; input.type = secret ? 'password' : 'text';
    input.readOnly = true; input.autocomplete = 'off'; input.value = value || '';
    const button = element('button', '复制'); button.type = 'button';
    button.addEventListener('click', () => {
      const rev = deliveryRevision;
      void copy(input.value, (msg) => {
        if (rev !== deliveryRevision) return;
        message('lookup-message', msg);
        if (msg.startsWith('浏览器')) { input.focus(); input.select(); }
      });
    });
    group.append(text, input); row.append(group, button); root.append(row);
  }
  async function showDelivery(order) {
    clearDelivery();
    if (order.state !== 'completed' || !order.delivery || document.hidden) return;
    const rev = deliveryRevision;
    const root = $('delivery');
    root.append(element('h3', '交付内容'));
    root.className = 'code-delivery';
    const delivery = order.delivery;
    if (delivery.kind === 'code') credential(root, '卡密', delivery.text, 'delivery-code');
    else if (delivery.kind === 'account') {
      credential(root, '账号邮箱', delivery.email, 'delivery-email', false);
      credential(root, '账号密码', delivery.password, 'delivery-password');
      if (delivery.totp_secret) {
        const widget = element('div');
        const otpLabel = element('label', '动态验证码（本地自动计算）'); otpLabel.htmlFor = 'delivery-otp';
        const otp = element('input'); otp.id = 'delivery-otp'; otp.className = 'otp'; otp.dataset.totpCode = ''; otp.readOnly = true;
        const secret = element('input'); secret.type = 'password'; secret.dataset.totpSecret = ''; secret.hidden = true;
        const start = element('button', '计算'); start.type = 'button'; start.dataset.totpStart = ''; start.hidden = true;
        const clear = element('button', '清除交付信息'); clear.type = 'button'; clear.dataset.totpClear = '';
        const copyButton = element('button', '复制验证码'); copyButton.type = 'button'; copyButton.dataset.totpCopy = '';
        const countdown = element('p'); countdown.append('本周期剩余 ');
        const remaining = element('span', '—'); remaining.dataset.totpRemaining = ''; countdown.append(remaining, ' 秒');
        const info = element('p', undefined, 'help'); info.dataset.totpMessage = '';
        const actions = element('div', undefined, 'actions'); actions.append(copyButton, clear);
        widget.append(otpLabel, otp, secret, start, countdown, actions, info);
        root.append(widget);
        deliveryComponent = window.LocalTotp.mount(widget);
        clear.addEventListener('click', clearDelivery);
        await deliveryComponent.setSecret(delivery.totp_secret);
      }
    }
    if (rev === deliveryRevision) root.append(element('p', '交付内容不会存入浏览器存储。隐藏页面后会清除，请妥善保管。', 'help')); 
  }

  async function shop() {
    let catalog, created = null, lookupCode = '', creating = false, declaring = false, revision = 0;
    try {
      catalog = await api('/api/catalog');
      document.querySelectorAll('[data-shop-name]').forEach((node) => { node.textContent = catalog.shop_name; });
      $('mode').textContent = catalog.mode === 'mock' ? '演示模式 · 请勿付款' : '自有资源模式';
      $('product').replaceChildren();
      for (const product of catalog.products) {
        const option = element('option', product.name); option.value = product.id; $('product').append(option);
      }
      const updatePrice = () => {
        const product = catalog.products.find((item) => item.id === $('product').value);
        $('price').textContent = product ? money(product.price_cents, product.currency) : '暂无可售商品';
        $('target-label').textContent = product ? product.target_label || '目标账号 ID' : '目标账号 ID';
      };
      $('product').disabled = catalog.products.length === 0;
      $('create').disabled = catalog.products.length === 0;
      $('product').addEventListener('change', updatePrice); updatePrice();
      $('payment-qr').src = '/assets/payment-qr';
      $('qr-caption').textContent = catalog.mode === 'mock' ? '演示占位图，不包含付款信息，请勿付款。' : '请使用商家自备收款码，并核对订单金额。';
    } catch (error) { message('shop-message', error.message, true); }
    $('create-form').addEventListener('submit', async (event) => {
      event.preventDefault(); if (creating || !catalog) return;
      creating = true; $('create').disabled = true; message('shop-message', '正在创建订单…');
      const rev = ++revision;
      try {
        const data = await api('/api/orders', { product_id: $('product').value, target: $('target').value.trim() });
        if (rev !== revision) return;
        created = data.order; lookupCode = data.lookup_code;
        $('created-code').value = lookupCode; $('created').hidden = false;
        $('payment-form').hidden = false; $('payment-reference').value = '';
        summary($('created-summary'), created); message('shop-message', '订单已创建，请先复制保存查询凭据');
        message('payment-message', ''); $('created').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) { if (rev === revision) message('shop-message', error.message, true); }
      finally { creating = false; $('create').disabled = false; }
    });
    $('copy-lookup').addEventListener('click', () => {
      if (created && lookupCode) void copy(`订单号：${created.id}\n查询码：${lookupCode}`, (msg) => {
        message('payment-message', msg); if (msg.startsWith('浏览器')) { $('created-code').focus(); $('created-code').select(); }
      });
    });
    $('payment-form').addEventListener('submit', async (event) => {
      event.preventDefault(); if (declaring || !created || !lookupCode) return;
      declaring = true; $('declare-payment').disabled = true; const rev = revision;
      try {
        const data = await api('/api/orders/payment', { id: created.id, lookup_code: lookupCode, payment_reference: $('payment-reference').value.trim() });
        if (rev !== revision) return;
        created = data.order; summary($('created-summary'), created);
        $('payment-form').hidden = true; message('payment-message', '核款申请已提交，等待商家核实；这不表示已经到账。');
      } catch (error) { if (rev === revision) message('payment-message', error.message, true); }
      finally { declaring = false; $('declare-payment').disabled = false; }
    });
    window.addEventListener('pagehide', () => { revision++; lookupCode = ''; created = null; $('created-code').value = ''; });
  }

  function track() {
    let revision = 0, timer = null, pollCount = 0;
    function resetView(clearInputs = false) {
      revision++; if (timer) clearTimeout(timer); timer = null; pollCount = 0;
      clearDelivery(); $('order-summary').replaceChildren(); $('order-result').hidden = true;
      if (clearInputs) { $('order-id').value = ''; $('lookup-code').value = ''; }
    }
    $('order-id').addEventListener('input', () => { resetView(); message('lookup-message', '查单身份已变化，请重新查询'); });
    $('lookup-code').addEventListener('input', () => { resetView(); message('lookup-message', '查单身份已变化，请重新查询'); });
    async function lookup(token, identity) {
      if (token !== revision || document.hidden) return;
      try {
        const data = await api('/api/orders/lookup', identity);
        if (token !== revision || document.hidden) return;
        summary($('order-summary'), data.order); $('order-result').hidden = false;
        await showDelivery(data.order);
        if (token !== revision || document.hidden) return;
        message('lookup-message', data.order.state === 'processing' ? '正在处理，每 5 秒查询一次…' : '已取得本单最新状态');
        if (data.order.state === 'processing') {
          if (++pollCount <= 12) timer = setTimeout(() => { void lookup(token, identity); }, 5000);
          else message('lookup-message', '本次自动查询已结束，可稍后手动查询；请勿重复下单');
        }
      } catch (error) { if (token === revision) { resetView(); message('lookup-message', error.message, true); } }
    }
    $('lookup-form').addEventListener('submit', (event) => {
      event.preventDefault(); resetView();
      const identity = { id: $('order-id').value.trim(), lookup_code: $('lookup-code').value.trim() };
      message('lookup-message', '正在查询…'); void lookup(revision, identity);
    });
    $('clear-identity').addEventListener('click', () => { resetView(true); message('lookup-message', '本页信息已清除'); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { resetView(true); message('lookup-message', '页面隐藏后已清除，请重新输入查询凭据'); }
    });
    window.addEventListener('pagehide', () => resetView(true));
  }

  function merchant() {
    let csrf = '', revision = 0, selected = null, confirming = false;
    const pendingQueries = new Set();
    function clean() {
      revision++; csrf = ''; selected = null; pendingQueries.clear();
      $('merchant-orders').replaceChildren(); $('merchant-panel').hidden = true; $('login-panel').hidden = false;
      $('merchant-password').value = ''; $('received-amount').value = ''; $('received-check').checked = false;
      $('confirm-summary').replaceChildren(); $('confirm-dialog').close();
    }
    async function loadOrders(token = revision) {
      const data = await api('/api/merchant/orders');
      if (token !== revision || !csrf) return;
      const root = $('merchant-orders'); root.replaceChildren();
      if (!data.orders.length) root.append(element('p', '暂无订单', 'muted'));
      for (const order of data.orders) {
        const item = element('article', undefined, 'order-item'); item.dataset.orderId = order.id; item.dataset.orderState = order.state;
        const heading = element('div', undefined, 'order-heading'); heading.append(element('h3', order.product_name), element('span', order.status_text || order.state, 'badge'));
        const info = element('div'); summary(info, order, true); item.append(heading, info);
        const actions = element('div', undefined, 'actions');
        if (order.state === 'payment_review') {
          const confirm = element('button', '核实到账', 'primary'); confirm.type = 'button'; confirm.dataset.action = 'confirm';
          confirm.addEventListener('click', () => {
            if (confirming) return; selected = order; summary($('confirm-summary'), order, true);
            $('received-amount').value = ''; $('received-check').checked = false; message('confirm-message', '');
            $('confirm-dialog').showModal();
          }); actions.append(confirm);
        }
        if (['unknown', 'processing'].includes(order.state)) {
          const query = element('button', '查询原订单'); query.type = 'button'; query.dataset.action = 'query';
          query.addEventListener('click', async () => {
            if (pendingQueries.has(order.id)) return; pendingQueries.add(order.id); query.disabled = true;
            const token = revision;
            try { await api(`/api/merchant/orders/${encodeURIComponent(order.id)}/query`, { csrf_token: csrf });
              if (token === revision) { await loadOrders(token); message('merchant-message', '已查询原订单最新结果'); }
            } catch (error) { if (token === revision) message('merchant-message', error.message, true); }
            finally { pendingQueries.delete(order.id); query.disabled = false; }
          }); actions.append(query);
        }
        item.append(actions); root.append(item);
      }
    }
    $('login-form').addEventListener('submit', async (event) => {
      event.preventDefault(); if ($('login').disabled) return;
      $('login').disabled = true; const token = ++revision;
      try {
        const data = await api('/api/merchant/login', { password: $('merchant-password').value });
        $('merchant-password').value = ''; if (token !== revision) return; csrf = data.csrf_token;
        $('login-panel').hidden = true; $('merchant-panel').hidden = false;
        await loadOrders(token); if (token === revision) message('merchant-message', '登录成功，请先核对自己的收款记录');
      } catch (error) { if (token === revision) { clean(); message('merchant-message', error.message, true); } }
      finally { $('login').disabled = false; }
    });
    $('refresh-orders').addEventListener('click', async () => {
      const token = revision; $('refresh-orders').disabled = true;
      try { await loadOrders(token); if (token === revision) message('merchant-message', '列表已刷新'); }
      catch (error) { if (token === revision) message('merchant-message', error.message, true); }
      finally { $('refresh-orders').disabled = false; }
    });
    $('logout').addEventListener('click', async () => {
      const oldCsrf = csrf; clean(); message('merchant-message', '正在退出…');
      try { await api('/api/merchant/logout', { csrf_token: oldCsrf }); message('merchant-message', '已退出，页面数据已清除'); }
      catch (error) { message('merchant-message', `页面数据已清除；退出请求未完成：${error.message}`, true); }
    });
    $('cancel-confirm').addEventListener('click', () => { if (!confirming) { selected = null; $('confirm-dialog').close(); } });
    $('confirm-dialog').addEventListener('cancel', (event) => { if (confirming) event.preventDefault(); else selected = null; });
    $('confirm-form').addEventListener('submit', async (event) => {
      event.preventDefault(); if (confirming || !selected || !csrf) return;
      const raw = $('received-amount').value.trim();
      if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw)) { message('confirm-message', '请输入有效的到账金额，最多两位小数', true); return; }
      if (!$('received-check').checked) { message('confirm-message', '请先核实真实到账记录并勾选确认', true); return; }
      const [yuan, fraction = ''] = raw.split('.'); const amount = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
      confirming = true; $('confirm-received').disabled = true; $('cancel-confirm').disabled = true;
      const token = revision, orderId = selected.id;
      try {
        await api(`/api/merchant/orders/${encodeURIComponent(orderId)}/confirm`, { csrf_token: csrf, amount_cents: amount, received_confirmed: true });
        if (token !== revision) return; selected = null; $('confirm-dialog').close(); await loadOrders(token);
        if (token === revision) message('merchant-message', '核款确认已提交；以订单实际处理结果为准');
      } catch (error) { if (token === revision) message('confirm-message', error.message, true); }
      finally { confirming = false; $('confirm-received').disabled = false; $('cancel-confirm').disabled = false; }
    });
    window.addEventListener('pagehide', clean);
  }
  if (document.body.dataset.page === 'shop') void shop();
  if (document.body.dataset.page === 'track') track();
  if (document.body.dataset.page === 'merchant') merchant();
})();
