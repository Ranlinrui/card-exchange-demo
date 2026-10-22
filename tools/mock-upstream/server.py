#!/usr/bin/env python3
"""Fictional loopback-only website for the browser adapter. No upstream APIs."""
import argparse
import html
import json
import secrets
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class DemoSite(ThreadingHTTPServer):
    def __init__(self, port, captcha=False, query_unknown=False, external_resource=False, submit_no_result=False,
                 websocket_port=0, socket_mode='page', query_no_navigation=False):
        super().__init__(("127.0.0.1", port), Handler)
        self.orders = {}
        self.sessions = set()
        self.captcha = captcha
        self.query_unknown = query_unknown
        self.external_resource = external_resource
        self.submit_no_result = submit_no_result
        self.websocket_port = websocket_port
        self.socket_mode = socket_mode
        self.query_no_navigation = query_no_navigation
        self.create_posts = 0
        self.websocket_handshakes = 0
        if query_no_navigation:
            self.orders['TEST-CODE-001'] = {'kind': 'code', 'reference': 'SYNTHETIC-EXISTING', 'status': 'completed'}


def escape(value):
    return html.escape(str(value), quote=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Do not log targets, form bodies, cookies or fictional passwords.

    def page(self, content, status=200, cookie=None):
        resource = '<img src="https://example.invalid/never-load.png" alt="">' if self.server.external_resource else ""
        if self.server.websocket_port:
            if self.server.socket_mode == 'page':
                resource += f'<script>new WebSocket("ws://127.0.0.1:{self.server.websocket_port}/synthetic-socket")</script>'
            elif self.server.socket_mode == 'worker':
                resource += '<script>new Worker("/synthetic-socket-worker.js")</script>'
            elif self.server.socket_mode == 'iframe' and self.path != '/synthetic-socket-frame':
                resource += '<iframe src="/synthetic-socket-frame" title="合成连接测试"></iframe>'
        payload = ('''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>虚构上游演练站</title>
<style>body{font:16px system-ui;background:#fff;color:#17212d;max-width:700px;margin:40px auto;padding:0 20px;overflow-wrap:anywhere}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:9px;max-width:100%;box-sizing:border-box}button{background:#165cbb;color:#fff;border:0;border-radius:5px}aside{background:#f2f5f8;padding:16px}nav{margin:20px 0}pre{white-space:pre-wrap}</style>
<h1>虚构上游演练站</h1><aside>只有示例商品和合成数据，不连接真实供方，不收款。内存订单重启即清空。</aside>'''
                   + content + resource + '</html>').encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def authenticated(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie.get("demo_session") and cookie["demo_session"].value in self.server.sessions
        except Exception:
            return False

    def home(self):
        return '<p id="demo-session">虚构账号已登录</p><nav><a href="/create">创建示例订单</a> · <a href="/query">查询示例订单</a></nav>'

    def result(self, order=None, status="not_found"):
        if order:
            status = order["status"]
        ref = order["reference"] if order else ""
        body = self.home() + f'<section id="demo-result" data-status="{escape(status)}"><h2>演练结果：{escape(status)}</h2><p id="demo-reference">{escape(ref)}</p>'
        if status == "completed":
            kind = order["kind"]
            body += f'<p id="demo-delivery-kind">{kind}</p>'
            if kind == "code":
                body += '<p id="demo-delivery-text">DEMO-SYNTHETIC-NOT-REDEEMABLE</p>'
            else:
                body += '<p id="demo-delivery-email">demo@example.invalid</p><p id="demo-delivery-password">SYNTHETIC-NOT-A-REAL-ACCOUNT</p><p id="demo-delivery-totp">GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ</p>'
        return body + '</section>'

    def do_GET(self):
        route = urlparse(self.path).path
        if route in ('/synthetic-socket', '/synthetic-worker-socket', '/synthetic-frame-socket'):
            if self.headers.get('Upgrade', '').lower() == 'websocket':
                self.server.websocket_handshakes += 1
            self.page('<p>合成本机连接计数器</p>', 426)
            return
        if route == '/synthetic-socket-worker.js':
            payload = f'new WebSocket("ws://127.0.0.1:{self.server.websocket_port}/synthetic-worker-socket")'.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if route == '/synthetic-socket-frame':
            self.page(f'<script>new WebSocket("ws://127.0.0.1:{self.server.websocket_port}/synthetic-frame-socket")</script>')
            return
        if route == "/__test/stats":
            # Local QA counter; never returns order identifiers or targets.
            payload = json.dumps({"orders": len(self.server.orders), "create_posts": self.server.create_posts,
                                  "websocket_handshakes": self.server.websocket_handshakes}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if route == "/login":
            captcha = '<p data-demo-captcha>演练验证码：应交给人工处理</p>' if self.server.captcha else ""
            self.page(captcha + '''<form method="post" action="/login">
<label>虚构用户名 <input id="demo-username" name="username" autocomplete="off"></label>
<label>虚构密码 <input id="demo-password" name="password" type="password" autocomplete="off"></label>
<button id="demo-login">登录演练账号</button></form>''')
            return
        if not self.authenticated():
            self.page('<p id="demo-login-error">请先登录演练账号</p>', 401)
            return
        if route == "/create":
            self.page(self.home() + '''<form method="post" action="/create">
<label>示例商品 <select id="demo-product" name="product"><option value="demo-code">虚构卡密</option><option value="demo-account">虚构成品号</option></select></label>
<label>示例目标 <input id="demo-target" name="target"></label>
<label>商家订单号 <input id="demo-merchant-ref" name="merchant_ref"></label>
<button id="demo-create">创建虚构订单</button></form>''')
        elif route == "/query":
            stale = self.result(status='not_found') if self.server.query_no_navigation else ''
            async_script = '''<script>document.querySelector('form').addEventListener('submit', event => {
event.preventDefault(); history.pushState({}, '', '#synthetic-query-pending');
setTimeout(() => document.querySelector('#demo-result').setAttribute('data-status', 'completed'), 700);
});</script>''' if self.server.query_no_navigation else ''
            self.page(self.home() + '''<form method="post" action="/query">
<label>商家订单号 <input id="demo-query-merchant-ref" name="merchant_ref"></label>
<label>虚构上游单号 <input id="demo-query-reference" name="reference"></label>
<button id="demo-query">查询原单</button></form>''' + stale + async_script)
        else:
            self.page(self.home())

    def do_POST(self):
        origin = self.headers.get("Origin")
        expected = f"http://127.0.0.1:{self.server.server_port}"
        if origin and origin != expected:
            self.page("<p>只接受本机演练页面提交</p>", 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16384:
                raise ValueError()
            values = parse_qs(self.rfile.read(length).decode(), keep_blank_values=True)
            field = lambda name: values.get(name, [""])[0]
        except (ValueError, UnicodeError):
            self.page("<p>无效演练输入</p>", 400)
            return
        route = urlparse(self.path).path
        if route == "/login":
            if field("username") != "demo-user" or field("password") != "demo-only-password":
                self.page('<p id="demo-login-error">演练账号错误</p>', 401)
                return
            token = secrets.token_urlsafe(24)
            self.server.sessions.add(token)
            self.page(self.home(), cookie=f"demo_session={token}; HttpOnly; SameSite=Strict; Path=/")
            return
        if not self.authenticated():
            self.page('<p id="demo-login-error">请先登录演练账号</p>', 401)
            return
        merchant_ref = field("merchant_ref")
        if route == "/query":
            if self.server.query_unknown:
                self.page(self.result(status="unknown"))
                return
            order = self.server.orders.get(merchant_ref)
            if order:
                order["status"] = "completed"
            self.page(self.result(order))
        elif route == "/create":
            self.server.create_posts += 1
            if not merchant_ref or field("product") not in ("demo-code", "demo-account") or not field("target"):
                self.page(self.result(status="failed"), 400)
                return
            # One thread changes the in-memory map at a time, so retries cannot duplicate.
            if not hasattr(self.server, "order_lock"):
                self.page(self.result(status="failed"), 500)
                return
            with self.server.order_lock:
                if merchant_ref not in self.server.orders:
                    self.server.orders[merchant_ref] = {"kind": "account" if field("product") == "demo-account" else "code",
                                                       "reference": "SYNTHETIC-" + secrets.token_hex(6), "status": "processing"}
                order = self.server.orders[merchant_ref]
            self.page(self.home() if self.server.submit_no_result else self.result(order))
        else:
            self.page("<p>不存在的演练页面</p>", 404)


def main():
    import threading
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--captcha", action="store_true")
    parser.add_argument("--query-unknown", action="store_true")
    parser.add_argument("--external-resource", action="store_true")
    parser.add_argument("--submit-no-result", action="store_true")
    parser.add_argument("--websocket-port", type=int, default=0)
    parser.add_argument("--socket-mode", choices=('page', 'worker', 'iframe'), default='page')
    parser.add_argument("--query-no-navigation", action="store_true")
    args = parser.parse_args()
    site = DemoSite(args.port, args.captcha, args.query_unknown, args.external_resource, args.submit_no_result,
                    args.websocket_port, args.socket_mode, args.query_no_navigation)
    site.order_lock = threading.Lock()
    print(f"Fictional demo only: http://127.0.0.1:{site.server_port}", flush=True)
    try:
        site.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        site.server_close()


if __name__ == "__main__":
    main()
