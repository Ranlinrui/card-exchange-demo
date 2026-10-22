"""Local configuration only; never execute .env as shell code."""
import ipaddress
import json
import os
from pathlib import Path

DEMO_PASSWORD = 'demo-only-change-me'


def read_env(path):
    result = {}
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            key, sep, value = line.partition('=')
            if not sep or not key.strip().replace('_', '').isalnum():
                raise ValueError('配置格式错误')
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[key.strip()] = value
    return result


class Config:
    def __init__(self, root, overrides=None):
        self.root = Path(root).resolve()
        values = read_env(self.root / '.env')
        for key in ('HOST', 'PORT', 'PUBLIC_ORIGIN', 'DEMO_DATA_DIR', 'ADMIN_PASSWORD'):
            if key in os.environ:
                values[key] = os.environ[key]
        values.update(overrides or {})
        self.host = values.get('HOST', '127.0.0.1')
        self.port = int(values.get('PORT', '8787'))
        self.origin = values.get('PUBLIC_ORIGIN', f'http://{self.host}:{self.port}').rstrip('/')
        self.shop_name = values.get('SHOP_NAME', '示例卡密服务')
        self.password = values.get('ADMIN_PASSWORD', DEMO_PASSWORD)
        if len(self.password) < 12:
            raise ValueError('管理员密码至少12位')
        try:
            loopback = ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            loopback = self.host == 'localhost'
        if not loopback and self.password == DEMO_PASSWORD:
            raise ValueError('公开监听前必须更换演示管理员密码')
        self.mode = values.get('UPSTREAM_MODE', 'mock')
        if self.mode not in ('mock', 'custom'):
            raise ValueError('上游模式无效')
        adapter_root = (self.root / 'adapters').resolve()
        self.script = (self.root / values.get('UPSTREAM_SCRIPT', 'adapters/mock_adapter.py')).resolve()
        if self.script.parent != adapter_root or self.script.suffix not in ('.py', '.cjs') or not self.script.is_file():
            raise ValueError('上游脚本必须在adapters目录中')
        if self.mode == 'mock' and self.script != adapter_root / 'mock_adapter.py':
            raise ValueError('模拟模式只能使用内置模拟脚本')
        if self.mode == 'custom' and (values.get('ALLOW_LIVE_UPSTREAM', '').lower() != 'true' or self.password == DEMO_PASSWORD):
            raise ValueError('自有上游需显式开启并更换演示管理员密码')
        self.data_dir = Path(values.get('DEMO_DATA_DIR', str(self.root / 'data'))).expanduser().resolve()
        qr = (self.root / values.get('PAYMENT_QR_FILE', 'assets/demo-qr.svg')).resolve()
        demo = self.root / 'assets' / 'demo-qr.svg'
        private = self.root / 'assets' / 'private'
        if qr != demo and (not qr.is_relative_to(private) or qr == private):
            raise ValueError('二维码必须位于assets/private目录')
        if qr.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp', '.svg'):
            raise ValueError('二维码文件类型无效')
        if self.mode == 'mock' and qr != demo:
            raise ValueError('模拟模式只能使用内置不可付款演示二维码')
        self.qr = qr
        product_file = self.root / 'config' / 'products.json'
        if not product_file.exists():
            product_file = self.root / 'config' / 'products.example.json'
        self.products = json.loads(product_file.read_text(encoding='utf-8'))
        if not isinstance(self.products, list) or not self.products:
            raise ValueError('商品配置必须是非空数组')
        seen = set()
        for product in self.products:
            if not isinstance(product, dict) or set(product) != {'id', 'name', 'price_cents', 'currency', 'kind', 'target_label'}:
                raise ValueError('商品字段无效')
            if any(not isinstance(product[k], str) or not product[k] or len(product[k]) > 120 for k in ('id', 'name', 'currency', 'kind', 'target_label')):
                raise ValueError('商品文本无效')
            if product['id'] in seen or product['kind'] not in ('code', 'account') or type(product['price_cents']) is not int or not 0 < product['price_cents'] <= 100000000:
                raise ValueError('商品配置无效')
            seen.add(product['id'])
