"""Temporary-database and local-only HTTP checks. No external service is used."""
import http.client
import json
import os
import shutil
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.config import Config, DEMO_PASSWORD, read_env
from backend.core import SafeError, Store
from backend.http import create_server

ROOT = Path(__file__).resolve().parents[1]


def isolated_root(directory):
    root = Path(directory) / 'app'
    for relative in ('adapters/mock_adapter.py', 'adapters/custom_adapter.py', 'config/products.example.json'):
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    return root


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = isolated_root(self.temp.name)
        self.config = Config(self.root, {'DEMO_DATA_DIR': str(Path(self.temp.name) / 'data')})
        self.store = Store(self.config)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def order(self, product='demo-code'):
        result = self.store.create({'product_id': product, 'target': 'SYNTHETIC-TARGET'})
        return {'id': result['order']['id'], 'lookup_code': result['lookup_code']}

    def queue(self, order):
        self.store.payment(dict(order, payment_reference='SYNTHETIC-REFERENCE'))
        self.store.confirm(order['id'], {'amount_cents': 100, 'received_confirmed': True})

    def test_unpaid_never_submits_and_payment_only_reviews(self):
        order = self.order()
        with patch.object(self.store, 'call_adapter') as call:
            self.assertFalse(self.store.process_once())
            self.store.payment(dict(order, payment_reference='REFERENCE'))
            self.assertFalse(self.store.process_once())
            call.assert_not_called()
        self.assertEqual(self.store.lookup(order)['order']['state'], 'payment_review')

    def test_confirmation_requires_matching_amount_and_received(self):
        order = self.order()
        self.store.payment(order)
        for data in ({'amount_cents': 99, 'received_confirmed': True}, {'amount_cents': 100, 'received_confirmed': False}, {'amount_cents': True, 'received_confirmed': True}):
            with self.assertRaises(SafeError):
                self.store.confirm(order['id'], data)
        self.assertEqual(self.store.lookup(order)['order']['state'], 'payment_review')

    def test_repeated_confirmation_does_not_purchase_twice(self):
        order = self.order()
        self.queue(order)
        with self.assertRaises(SafeError):
            self.store.confirm(order['id'], {'amount_cents': 100, 'received_confirmed': True})
        with patch.object(self.store, 'call_adapter', return_value={'status': 'unknown'}) as call:
            self.assertTrue(self.store.process_once())
            self.assertFalse(self.store.process_once())
            self.assertEqual(call.call_count, 1)

    def test_lookup_code_is_bound_to_own_order(self):
        first, second = self.order(), self.order()
        with self.assertRaises(SafeError):
            self.store.lookup({'id': first['id'], 'lookup_code': second['lookup_code']})
        with self.assertRaises(SafeError):
            self.store.payment({'id': first['id'], 'lookup_code': second['lookup_code']})
        self.assertEqual(self.store.lookup(first)['order']['target'], 'SYNTHETIC-TARGET')

    def test_unknown_only_queries_original_order_and_never_resubmits(self):
        order = self.order()
        self.queue(order)
        with patch.object(self.store, 'call_adapter', return_value={'status': 'unknown'}) as call:
            self.store.process_once()
            self.assertFalse(self.store.process_once())
            self.store.query(order['id'])
            self.assertEqual([entry.args[1] for entry in call.call_args_list], ['submit', 'query'])
            self.assertEqual(call.call_args.args[0]['merchant_order_id'], order['id'])

    def test_restart_turns_submitting_to_unknown_without_submit(self):
        order = self.order()
        self.queue(order)
        self.store.db.execute("UPDATE orders SET state='submitting',merchant_order_id=id WHERE id=?", (order['id'],))
        self.store.db.commit()
        self.store.close()
        self.store = Store(self.config)
        with patch.object(self.store, 'call_adapter') as call:
            self.assertFalse(self.store.process_once())
            call.assert_not_called()
        self.assertEqual(self.store.lookup(order)['order']['state'], 'unknown')

    def test_sensitive_values_are_encrypted_and_lookup_is_hash_only(self):
        order = self.order()
        self.queue(order)
        with patch.object(self.store, 'call_adapter', return_value={'status': 'succeeded', 'delivery': {'kind': 'code', 'text': 'SYNTHETIC-SECRET'}}):
            self.store.process_once()
        raw = (self.config.data_dir / 'orders.sqlite3').read_bytes()
        for secret in (b'SYNTHETIC-TARGET', b'SYNTHETIC-REFERENCE', b'SYNTHETIC-SECRET', order['lookup_code'].encode()):
            self.assertNotIn(secret, raw)
        self.assertEqual(stat.S_IMODE((self.config.data_dir / 'local.key').stat().st_mode), 0o600)
        self.assertEqual(self.store.lookup(order)['order']['delivery']['text'], 'SYNTHETIC-SECRET')

    def test_non_success_or_extra_delivery_fields_never_complete(self):
        for output in ({'status': 'processing', 'delivery': {'kind': 'code', 'text': 'BAD'}}, {'status': 'succeeded', 'delivery': {'kind': 'code', 'text': 'BAD', 'url': 'invalid'}}, {'status': 'not_found'}):
            order = self.order()
            self.queue(order)
            with patch.object(self.store, 'call_adapter', return_value=output):
                self.store.process_once()
            result = self.store.lookup(order)['order']
            self.assertNotEqual(result['state'], 'completed')
            self.assertIsNone(result['delivery'])
            self.store.db.execute("UPDATE orders SET state='unknown' WHERE id=?", (order['id'],))
            self.store.db.commit()

    def test_polling_is_bounded(self):
        order = self.order()
        self.queue(order)
        with patch.object(self.store, 'call_adapter', return_value={'status': 'processing'}) as call:
            self.store.process_once()
            for _ in range(5):
                self.store.db.execute('UPDATE orders SET next_poll=0 WHERE id=?', (order['id'],))
                self.store.db.commit()
                self.store.process_once()
            self.assertEqual(call.call_count, 6)
            self.assertFalse(self.store.process_once())
        self.assertEqual(self.store.lookup(order)['order']['state'], 'unknown')

    def test_actual_mock_subprocess_completes_code_and_account(self):
        for product in ('demo-code', 'demo-account'):
            order = self.order(product)
            self.store.payment(order)
            self.store.confirm(order['id'], {'amount_cents': 100 if product == 'demo-code' else 200, 'received_confirmed': True})
            self.store.process_once()
            self.store.db.execute('UPDATE orders SET next_poll=0 WHERE id=?', (order['id'],))
            self.store.db.commit()
            self.store.process_once()
            result = self.store.lookup(order)['order']
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(result['delivery']['kind'], 'code' if product == 'demo-code' else 'account')

    def test_adapter_timeout_is_unknown(self):
        order = self.order()
        self.queue(order)
        import subprocess
        with patch('backend.core.subprocess.run', side_effect=subprocess.TimeoutExpired('mock', 8)):
            self.store.process_once()
        self.assertEqual(self.store.lookup(order)['order']['state'], 'unknown')

    def test_qr_paths_and_mock_script_are_constrained(self):
        for qr in ('../outside.svg', '/etc/passwd', 'assets/private/../../outside.png', 'assets/private/code.html'):
            with self.assertRaises(ValueError):
                Config(self.root, {'PAYMENT_QR_FILE': qr})
        Config(self.root, {'PAYMENT_QR_FILE': 'assets/private/my-qr.png', 'UPSTREAM_MODE': 'custom', 'UPSTREAM_SCRIPT': 'adapters/custom_adapter.py', 'ALLOW_LIVE_UPSTREAM': 'true', 'ADMIN_PASSWORD': 'a-new-strong-password'})
        with self.assertRaises(ValueError):
            Config(self.root, {'PAYMENT_QR_FILE': 'assets/private/my-qr.png'})
        with self.assertRaises(ValueError):
            Config(self.root, {'UPSTREAM_SCRIPT': 'adapters/custom_adapter.py'})
        with self.assertRaises(ValueError):
            Config(self.root, {'UPSTREAM_MODE': 'custom', 'UPSTREAM_SCRIPT': '../outside.py'})

    def test_custom_mode_requires_two_opt_ins(self):
        base = {'UPSTREAM_MODE': 'custom', 'UPSTREAM_SCRIPT': 'adapters/custom_adapter.py'}
        for extra in ({}, {'ALLOW_LIVE_UPSTREAM': 'true'}, {'ADMIN_PASSWORD': 'a-new-strong-password'}):
            with self.assertRaises(ValueError):
                Config(self.root, dict(base, **extra))
        Config(self.root, dict(base, ALLOW_LIVE_UPSTREAM='true', ADMIN_PASSWORD='a-new-strong-password'))

    def test_public_host_requires_changed_password_and_origin_derives_port(self):
        with self.assertRaises(ValueError):
            Config(self.root, {'HOST': '0.0.0.0'})
        public = Config(self.root, {'HOST': '0.0.0.0', 'PORT': '9876', 'ADMIN_PASSWORD': 'a-new-strong-password'})
        self.assertEqual(public.origin, 'http://0.0.0.0:9876')
        local = Config(self.root, {'PORT': '9877'})
        self.assertEqual(local.origin, 'http://127.0.0.1:9877')

    def test_env_parser_never_executes_shell(self):
        path = Path(self.temp.name) / 'test.env'
        path.write_text('VALUE=$(touch should-not-exist)\nQUOTED="some value"\n')
        values = read_env(path)
        self.assertEqual(values['VALUE'], '$(touch should-not-exist)')
        self.assertEqual(values['QUOTED'], 'some value')
        self.assertFalse((Path(self.temp.name) / 'should-not-exist').exists())


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = isolated_root(self.temp.name)
        self.config = Config(self.root, {'PORT': '0', 'PUBLIC_ORIGIN': 'http://127.0.0.1:8787', 'DEMO_DATA_DIR': self.temp.name})
        self.server, self.app = create_server(self.config, start_worker=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.app.close()
        self.temp.cleanup()

    def request(self, path, data=None, origin=True, cookie=None, raw=None, content_type='application/json'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': content_type}
        if origin:
            headers['Origin'] = self.config.origin if origin is True else origin
        if cookie or self.cookie:
            headers['Cookie'] = cookie or self.cookie
        connection.request('POST' if data is not None or raw is not None else 'GET', path, body=raw if raw is not None else json.dumps(data) if data is not None else None, headers=headers)
        response = connection.getresponse()
        status, body, response_headers = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, json.loads(body), response_headers

    def login(self):
        status, body, headers = self.request('/api/merchant/login', {'password': DEMO_PASSWORD})
        self.assertEqual(status, 200)
        self.cookie = headers['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        return body['csrf_token']

    def test_origin_and_json_and_size_validation(self):
        for origin in (False, 'https://other.invalid'):
            self.assertEqual(self.request('/api/orders', {}, origin=origin)[0], 403)
        self.assertEqual(self.request('/api/orders', raw='{}', content_type='text/plain')[0], 415)
        self.assertEqual(self.request('/api/orders', raw='x' * 17000)[0], 413)
        self.assertEqual(self.request('/api/orders', raw='invalid')[0], 400)
        self.assertEqual(self.request('/api/orders', raw='[]')[0], 400)

    def test_expired_session_and_csrf_are_rejected(self):
        self.assertEqual(self.request('/api/merchant/orders')[0], 401)
        csrf = self.login()
        self.assertEqual(self.request('/api/merchant/logout', {'csrf_token': 'wrong'})[0], 403)
        self.assertEqual(self.request('/api/merchant/orders')[0], 200)
        with self.app.session_lock:
            for session in self.app.sessions.values():
                session['expires'] = time.time() - 1
        self.assertEqual(self.request('/api/merchant/orders')[0], 401)
        self.assertEqual(self.request('/api/merchant/logout', {'csrf_token': csrf})[0], 401)

    def test_http_flow_and_logout(self):
        status, catalog, _ = self.request('/api/catalog')
        self.assertEqual(status, 200)
        self.assertEqual(catalog['mode'], 'mock')
        status, created, _ = self.request('/api/orders', {'product_id': 'demo-code', 'target': 'SYNTHETIC'})
        self.assertEqual(status, 201)
        order = {'id': created['order']['id'], 'lookup_code': created['lookup_code']}
        self.assertEqual(self.request('/api/orders/payment', dict(order, payment_reference='SYNTHETIC'))[1]['order']['state'], 'payment_review')
        csrf = self.login()
        endpoint = '/api/merchant/orders/' + order['id'] + '/confirm'
        self.assertEqual(self.request(endpoint, {'csrf_token': csrf, 'amount_cents': 100, 'received_confirmed': True})[1]['order']['state'], 'queued')
        self.assertEqual(self.request(endpoint, {'csrf_token': csrf, 'amount_cents': 100, 'received_confirmed': True})[0], 409)
        self.assertEqual(self.request('/api/merchant/logout', {'csrf_token': csrf})[0], 200)
        self.assertEqual(self.request('/api/merchant/orders')[0], 401)

    def test_login_throttle_and_fixed_qr_route(self):
        for _ in range(10):
            self.assertEqual(self.request('/api/merchant/login', {'password': 'bad'})[0], 401)
        self.assertEqual(self.request('/api/merchant/login', {'password': 'bad'})[0], 429)
        self.assertEqual(self.request('/assets/private/secret.png')[0], 404)
        self.assertEqual(self.request('/../.env')[0], 404)


if __name__ == '__main__':
    unittest.main()
