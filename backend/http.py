"""Small same-origin JSON HTTP interface and fixed static asset routes."""
import hmac
import json
import mimetypes
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from .core import SafeError, Store


class Application:
    def __init__(self, config, start_worker=True):
        self.config = config
        self.store = Store(config)
        self.sessions = {}
        self.attempts = {}
        self.session_lock = threading.Lock()
        self.stop = threading.Event()
        self.worker = None
        if start_worker:
            self.worker = threading.Thread(target=self.run_worker, daemon=True)
            self.worker.start()

    def run_worker(self):
        while not self.stop.is_set():
            try:
                busy = self.store.process_once()
            except Exception:
                # Persisted submitting intents are never blindly submitted again.
                busy = False
            self.stop.wait(0.1 if busy else 0.25)

    def close(self):
        self.stop.set()
        if self.worker:
            self.worker.join(timeout=10)
        self.store.close()

    def authenticate(self, handler, data=None):
        cookie = SimpleCookie()
        try:
            cookie.load(handler.headers.get('Cookie', ''))
            token = cookie['merchant_session'].value if 'merchant_session' in cookie else ''
        except Exception:
            token = ''
        with self.session_lock:
            session = self.sessions.get(token)
            if not session or session['expires'] <= time.time():
                self.sessions.pop(token, None)
                raise SafeError('商家会话已失效，请重新登录', 401)
            if data is not None and (not isinstance(data.get('csrf_token'), str) or not hmac.compare_digest(data['csrf_token'], session['csrf'])):
                raise SafeError('操作校验失败，请刷新后重试', 403)
        return token

    def login(self, handler, data):
        ip = handler.client_address[0]
        now = time.time()
        with self.session_lock:
            self.attempts = {key: record for key, record in self.attempts.items() if now - record[0] < 60}
            started, count = self.attempts.get(ip, (now, 0))
            if count >= 10:
                raise SafeError('登录尝试过多，请稍后再试', 429)
            password = data.get('password')
            if not isinstance(password, str) or not hmac.compare_digest(password.encode(), self.config.password.encode()):
                self.attempts[ip] = (started, count + 1)
                raise SafeError('管理员密码无效', 401)
            self.attempts.pop(ip, None)
            self.sessions = {key: record for key, record in self.sessions.items() if record['expires'] > now}
            if len(self.sessions) > 100:
                self.sessions.clear()
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[token] = {'csrf': csrf, 'expires': now + 3600}
        cookie = f'merchant_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600'
        if self.config.origin.startswith('https://'):
            cookie += '; Secure'
        return {'csrf_token': csrf}, cookie

    def handler_class(self):
        app = self

        class Handler(BaseHTTPRequestHandler):
            server_version = 'LocalDemo/1.0'
            sys_version = ''

            def log_message(self, *args):
                pass

            def send_bytes(self, status, body, content_type='application/json; charset=utf-8', cookie=None):
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Frame-Options', 'DENY')
                self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
                if cookie:
                    self.send_header('Set-Cookie', cookie)
                self.end_headers()
                self.wfile.write(body)

            def send_json(self, value, status=200, cookie=None):
                self.send_bytes(status, json.dumps(value, ensure_ascii=False).encode(), cookie=cookie)

            def body_json(self):
                if self.headers.get('Origin') != app.config.origin:
                    raise SafeError('仅允许本站发起操作', 403)
                if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
                    raise SafeError('请使用JSON请求', 415)
                length = self.headers.get('Content-Length', '')
                if not length.isdecimal() or int(length) > 16384:
                    raise SafeError('请求大小无效', 413)
                self.connection.settimeout(10)
                try:
                    value = json.loads(self.rfile.read(int(length)))
                except (ValueError, OSError):
                    raise SafeError('请求JSON无效')
                if not isinstance(value, dict):
                    raise SafeError('请求JSON必须为对象')
                return value

            def do_GET(self):
                try:
                    path = urlsplit(self.path).path
                    if path == '/api/health':
                        return self.send_json({'ok': True, 'mode': app.config.mode})
                    if path == '/api/catalog':
                        return self.send_json({'shop_name': app.config.shop_name, 'mode': app.config.mode, 'payment_qr_url': '/assets/payment-qr', 'products': app.config.products})
                    if path == '/api/merchant/orders':
                        app.authenticate(self)
                        return self.send_json(app.store.list_orders())
                    if path == '/assets/payment-qr':
                        file = app.config.qr
                    else:
                        routes = {'/': 'index.html', '/index.html': 'index.html', '/track': 'track.html', '/track.html': 'track.html', '/merchant': 'merchant.html', '/merchant.html': 'merchant.html', '/styles.css': 'styles.css', '/app.js': 'app.js', '/totp.js': 'totp.js'}
                        if path not in routes:
                            raise SafeError('页面不存在', 404)
                        file = app.config.root / 'public' / routes[path]
                    if not file.is_file():
                        raise SafeError('资源尚未配置', 404)
                    self.send_bytes(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                except SafeError as error:
                    self.send_json({'error': str(error)}, error.status)
                except Exception:
                    self.send_json({'error': '服务暂时不可用，请稍后重试'}, 500)

            def do_POST(self):
                try:
                    data = self.body_json()
                    path = urlsplit(self.path).path
                    if path == '/api/orders':
                        return self.send_json(app.store.create(data), 201)
                    if path == '/api/orders/lookup':
                        return self.send_json(app.store.lookup(data))
                    if path == '/api/orders/payment':
                        return self.send_json(app.store.payment(data))
                    if path == '/api/merchant/login':
                        value, cookie = app.login(self, data)
                        return self.send_json(value, cookie=cookie)
                    if path.startswith('/api/merchant/'):
                        token = app.authenticate(self, data)
                        if path == '/api/merchant/logout':
                            with app.session_lock:
                                app.sessions.pop(token, None)
                            return self.send_json({'ok': True}, cookie='merchant_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
                        match = re.fullmatch(r'/api/merchant/orders/(DEMO-[a-f0-9]{24})/(confirm|query)', path)
                        if match:
                            result = app.store.confirm(match[1], data) if match[2] == 'confirm' else app.store.query(match[1])
                            return self.send_json(result)
                    raise SafeError('接口不存在', 404)
                except SafeError as error:
                    self.send_json({'error': str(error)}, error.status)
                except Exception:
                    self.send_json({'error': '服务暂时不可用，请稍后重试'}, 500)

        return Handler


def create_server(config, start_worker=True):
    app = Application(config, start_worker)
    try:
        server = ThreadingHTTPServer((config.host, config.port), app.handler_class())
        server.daemon_threads = True
        return server, app
    except Exception:
        app.close()
        raise
