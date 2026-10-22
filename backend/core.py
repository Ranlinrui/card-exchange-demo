"""Single-process order store and bounded upstream processing."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
from cryptography.fernet import Fernet

TEXT = {'awaiting_payment': '请扫码付款后提交核款申请', 'payment_review': '等待商家核实到账', 'queued': '已核款，等待处理', 'submitting': '正在提交上游', 'processing': '上游处理中', 'completed': '交付完成', 'failed': '处理失败，请联系商家', 'unknown': '结果待核实，商家需查询原单'}


class SafeError(Exception):
    def __init__(self, text, status=400):
        super().__init__(text)
        self.status = status


class Store:
    def __init__(self, config):
        self.config = config
        config.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        keyfile = config.data_dir / 'local.key'
        try:
            fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(Fernet.generate_key())
        os.chmod(keyfile, 0o600)
        self.crypto = Fernet(keyfile.read_bytes())
        self.lock = threading.RLock()
        self.db = sqlite3.connect(config.data_dir / 'orders.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('''CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, lookup_hash TEXT NOT NULL, product TEXT NOT NULL,
          target TEXT NOT NULL, state TEXT NOT NULL, payment_reference TEXT,
          merchant_order_id TEXT, upstream_reference TEXT, delivery TEXT,
          polls INTEGER NOT NULL DEFAULT 0, next_poll REAL NOT NULL DEFAULT 0,
          created REAL NOT NULL)''')
        self.db.execute("UPDATE orders SET state='unknown' WHERE state='submitting'")
        self.db.commit()
        os.chmod(config.data_dir / 'orders.sqlite3', 0o600)

    def seal(self, value):
        return self.crypto.encrypt(value.encode()).decode()

    def unseal(self, value):
        return self.crypto.decrypt(value.encode()).decode() if value else ''

    def get(self, oid):
        row = self.db.execute('SELECT * FROM orders WHERE id=?', (oid,)).fetchone()
        if row is None:
            raise SafeError('订单或查询码无效', 404)
        return row

    def authorized(self, data):
        oid, code = data.get('id'), data.get('lookup_code')
        if not isinstance(oid, str) or not isinstance(code, str) or len(code) > 200:
            raise SafeError('订单或查询码无效', 404)
        row = self.get(oid)
        if not hmac.compare_digest(row['lookup_hash'], hashlib.sha256(code.encode()).hexdigest()):
            raise SafeError('订单或查询码无效', 404)
        return row

    def public(self, row, merchant=False):
        product = json.loads(row['product'])
        result = dict(id=row['id'], product_name=product['name'], amount_cents=product['price_cents'], currency=product['currency'], target=self.unseal(row['target']), state=row['state'], status_text=TEXT[row['state']], delivery=None)
        if row['state'] == 'completed':
            result['delivery'] = json.loads(self.unseal(row['delivery']))
        if merchant:
            result['payment_reference'] = self.unseal(row['payment_reference'])
        return result

    def create(self, data):
        target = data.get('target')
        product = next((p for p in self.config.products if p['id'] == data.get('product_id')), None)
        if product is None or not isinstance(target, str) or not target.strip() or len(target) > 200:
            raise SafeError('请选择有效商品并填写目标账号（最多200字）')
        oid, code = 'DEMO-' + secrets.token_hex(12), secrets.token_urlsafe(24)
        with self.lock:
            self.db.execute('INSERT INTO orders(id,lookup_hash,product,target,state,created) VALUES(?,?,?,?,?,?)', (oid, hashlib.sha256(code.encode()).hexdigest(), json.dumps(product, ensure_ascii=False), self.seal(target.strip()), 'awaiting_payment', time.time()))
            self.db.commit()
            return {'order': self.public(self.get(oid)), 'lookup_code': code}

    def lookup(self, data):
        with self.lock:
            return {'order': self.public(self.authorized(data))}

    def payment(self, data):
        reference = data.get('payment_reference', '')
        if not isinstance(reference, str) or len(reference) > 200:
            raise SafeError('付款参考号最多200字')
        with self.lock:
            row = self.authorized(data)
            if row['state'] == 'awaiting_payment':
                self.db.execute("UPDATE orders SET state='payment_review',payment_reference=? WHERE id=? AND state='awaiting_payment'", (self.seal(reference.strip()), row['id']))
                self.db.commit()
            return {'order': self.public(self.get(row['id']))}

    def confirm(self, oid, data):
        with self.lock:
            row = self.get(oid)
            product = json.loads(row['product'])
            if data.get('received_confirmed') is not True or type(data.get('amount_cents')) is not int or data['amount_cents'] != product['price_cents']:
                raise SafeError('请核实实际到账并输入订单相同金额')
            if row['state'] != 'payment_review':
                raise SafeError('订单已处理或尚未申请核款', 409)
            self.db.execute("UPDATE orders SET state='queued' WHERE id=? AND state='payment_review'", (oid,))
            self.db.commit()
            return {'order': self.public(self.get(oid), True)}

    def list_orders(self):
        with self.lock:
            return {'orders': [self.public(row, True) for row in self.db.execute('SELECT * FROM orders ORDER BY created DESC LIMIT 500')]}

    def call_adapter(self, row, operation):
        request = {'operation': operation, 'merchant_order_id': row['merchant_order_id'], 'product': json.loads(row['product']), 'target': self.unseal(row['target']), 'upstream_reference': self.unseal(row['upstream_reference'])}
        runner = sys.executable if self.config.script.suffix == '.py' else 'node'
        # The subprocess gets no server/admin environment variables or cookie data.
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'en_US.UTF-8', 'PYTHONIOENCODING': 'utf-8'}
        try:
            from .config import read_env
            local_values = read_env(self.config.root / '.env')
            for key in ('UPSTREAM_BROWSER_CONFIG', 'DEMO_UPSTREAM_USERNAME', 'DEMO_UPSTREAM_PASSWORD', 'CHROME_PATH', 'GC_PUPPETEER_MODULE'):
                value = os.environ.get(key, local_values.get(key))
                if value is not None:
                    env[key] = value
            # Browser adapter closes itself at 45s; leave 5s for structured cleanup.
            timeout = 50 if self.config.script.suffix == '.cjs' else 8
            result = subprocess.run([runner, str(self.config.script)], input=json.dumps(request), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout, cwd=self.config.root, env=env, shell=False)
            if result.returncode or len(result.stdout) > 65536:
                return {'status': 'unknown'}
            output = json.loads(result.stdout)
            return output if isinstance(output, dict) else {'status': 'unknown'}
        except (OSError, ValueError, subprocess.SubprocessError):
            return {'status': 'unknown'}

    def clean_delivery(self, delivery, kind):
        fields = {'code': {'kind', 'text'}, 'account': {'kind', 'email', 'password', 'totp_secret'}}[kind]
        if not isinstance(delivery, dict) or set(delivery) != fields or delivery.get('kind') != kind:
            return None
        if any(not isinstance(v, str) or not v or len(v) > 4000 for v in delivery.values()):
            return None
        if kind == 'account':
            secret = delivery['totp_secret']
            if not re.fullmatch(r'[A-Z2-7]{16,128}={0,6}', secret):
                return None
            try:
                base64.b32decode(secret + '=' * ((-len(secret)) % 8))
            except ValueError:
                return None
        return delivery

    def apply_result(self, oid, output):
        with self.lock:
            row = self.get(oid)
            if row['state'] == 'completed':
                return
            status = output.get('status')
            state, delivery = 'unknown', None
            if status == 'succeeded':
                delivery = self.clean_delivery(output.get('delivery'), json.loads(row['product'])['kind'])
                state = 'completed' if delivery else 'unknown'
            elif status == 'failed':
                state = 'failed'
            elif status == 'processing' and row['polls'] < 5:
                state = 'processing'
            reference = output.get('reference')
            if not isinstance(reference, str) or len(reference) > 500:
                reference = ''
            self.db.execute('UPDATE orders SET state=?,upstream_reference=?,delivery=?,next_poll=? WHERE id=?', (state, self.seal(reference) if reference else row['upstream_reference'], self.seal(json.dumps(delivery)) if delivery else None, time.time() + 1, oid))
            self.db.commit()

    def process_once(self):
        with self.lock:
            row = self.db.execute("SELECT * FROM orders WHERE state='queued' OR (state='processing' AND next_poll<=?) ORDER BY created LIMIT 1", (time.time(),)).fetchone()
            if row is None:
                return False
            operation = 'submit' if row['state'] == 'queued' else 'query'
            if operation == 'submit':
                self.db.execute("UPDATE orders SET state='submitting',merchant_order_id=id WHERE id=? AND state='queued'", (row['id'],))
            else:
                self.db.execute('UPDATE orders SET polls=polls+1,next_poll=? WHERE id=?', (time.time() + 10, row['id']))
            self.db.commit()
            row = self.get(row['id'])
        self.apply_result(row['id'], self.call_adapter(row, operation))
        return True

    def query(self, oid):
        with self.lock:
            row = self.get(oid)
            if row['state'] not in ('unknown', 'processing') or not row['merchant_order_id']:
                raise SafeError('此订单当前无需查询原单', 409)
        self.apply_result(oid, self.call_adapter(row, 'query'))
        with self.lock:
            return {'order': self.public(self.get(oid), True)}

    def close(self):
        with self.lock:
            self.db.close()
