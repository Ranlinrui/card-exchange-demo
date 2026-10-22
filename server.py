#!/usr/bin/env python3
"""Run the standalone sharing demo with local configuration."""
from pathlib import Path
from backend.config import Config
from backend.http import create_server


def main():
    try:
        config = Config(Path(__file__).resolve().parent)
        server, app = create_server(config)
    except Exception:
        raise SystemExit('启动失败：请检查本地配置、依赖及端口；配置规则见README。')
    print(f'本地演示服务已启动：{config.origin}（模式：{config.mode}）', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()


if __name__ == '__main__':
    main()
