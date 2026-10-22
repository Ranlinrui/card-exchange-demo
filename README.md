# 可配置卡密服务 · 独立演示分享版

这是一个可以本机运行的订单与交付演示：客户选商品、保存查询码、提交付款申报，商家人工核实到账后才调用配置好的上游脚本。默认使用虚构商品、不可付款的演示图和合成交付，不连接任何供方。

**静态收款码不能自动确认到账。** 客户点击“我已付款”只进入待核款；商家仍须在自己的收款渠道确认实际到账并填写相同金额。

本仓库不包含其他业务系统的供应商、API、运营网址、账号、历史订单或 Git 历史。别人使用时需要配置自己的资源，不能直接获得任何现成经营渠道。

- [图解项目介绍](docs/project-introduction.html)：可双击离线打开，10 张示意图。
- [文字版项目介绍](docs/project-introduction.md)
- [自有网页自动化配置](docs/upstream-automation.md)
- [接口约定](API_CONTRACT.md)、[分享边界](SHARING_POLICY.md)、[验证记录](docs/validation.md)

## 1. 本机启动

基础流程需要 Python 3.10 或更新版本。后端使用标准库 HTTP 与 SQLite，另安装 `cryptography==43.0.3` 保护本地敏感字段；基础模拟演示不需要 Node.js、浏览器自动化或任何外部账号。

在项目根目录执行，以下命令适用于 macOS / Linux：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python server.py
```

浏览器打开 `http://127.0.0.1:8787`。购买页是 `/`，凭码查单是 `/track`，商家入口是 `/merchant`。本地演示管理员口令为 `demo-only-change-me`；只用于默认回环地址的演示。服务启动时不会打印口令。

`.env` 按 `KEY=value` 读取，不执行 shell，不展开命令或变量。修改端口时同时修改 `PORT` 和 `PUBLIC_ORIGIN`，浏览器使用与 `PUBLIC_ORIGIN` 完全一致的地址，避免写操作被同源检查拒绝。`HOST`、`PORT`、`PUBLIC_ORIGIN`、`ADMIN_PASSWORD`、`DEMO_DATA_DIR` 也可由启动进程环境覆盖。

## 2. 走一遍演示

1. 选“示例兑换码”或“示例账号与动态口令”，填写虚构的接收账号 ID；不要填写真实密码或验证码。
2. 创建订单后立即复制保存订单号和本单查询码。查询码只返回一次，离开页面后不能找回；请勿发给别人。
3. 演示图不能付款。演练时填写虚构付款参考，点击“我已付款，提交核款申请”。这一步不会触发采购。
4. 到商家入口登录，找到该订单。**仅在模拟演练中**，可按示例金额演练核款操作；真正接入后必须先查真实收款记录，再输入到账金额并勾选确认。
5. 商家确认后后台提交一次模拟上游，约一秒后查询原单得到合成交付。客户凭订单号和查询码查看结果；账号商品会展示合成账号信息与本地动态验证码。

演示账号使用保留域名 `example.invalid`，密码为合成文本，动态验证码种子来自 RFC 6238 公开测试向量。这些数据不能登录任何真实账号，也不能用于保护真实业务。

## 3. 改成自己的商品与收款码

先复制商品模板：

```sh
cp config/products.example.json config/products.json
```

商品文件是 JSON 数组，每条只能包含 `id`、`name`、`price_cents`、`currency`、`kind`、`target_label` 六个字段。金额 `price_cents` 是整数分，例如 `100` 表示 1.00 元；`kind` 只支持 `code` 或 `account`。已创建订单会冻结当时商品名称与金额，不随后续配置变化。

自己的二维码只能放在 `assets/private/`，例如 `assets/private/my-qr.png`，再在 `.env` 设置 `PAYMENT_QR_FILE=assets/private/my-qr.png`。可用格式为 PNG、JPG、JPEG、WebP、SVG。二维码通过固定路径 `/assets/payment-qr` 提供，客户不能指定文件路径。

**模拟模式拒绝使用私人二维码**，避免真实收款后交付虚构商品。只有自有上游已准备并验收，才按下一节显式切到 `custom` 并配置自己的二维码；本项目始终不自动识别到账、不接第三方支付通知、不自动退款。

## 4. 接自己的上游脚本

“上游”就是你自己的进货或交付来源。项目提供两种起点：

| 方式 | 随仓库提供 | 使用者需要补什么 |
| --- | --- | --- |
| Python 脚本 | `adapters/custom_adapter.py` | 自己获授权的调用方式、凭据读取、按原单查询与真实交付判断 |
| 网页自动化 | `adapters/browser_adapter.cjs` | 自己的网站地址、控件定位规则、账号与原单查询规则；详见[自动化说明](docs/upstream-automation.md) |

Python 方式可先复制模板到已忽略的个人脚本位置：

```sh
cp adapters/custom_adapter.py adapters/local_upstream.py
```

模板本身只返回“需本人配置”，不会自动供货。完成自己的实现后，在 `.env` 设置：

```text
ADMIN_PASSWORD=replace-with-your-own-strong-password
UPSTREAM_MODE=custom
UPSTREAM_SCRIPT=adapters/local_upstream.py
ALLOW_LIVE_UPSTREAM=true
PAYMENT_QR_FILE=assets/private/my-qr.png
```

示例口令文字应替换为本人新设的至少 12 位密码。脚本必须是 `adapters/` 目录直接下的固定 `.py` 或 `.cjs` 文件；客户不能传脚本、网址或命令。浏览器模板则使用 `UPSTREAM_SCRIPT=adapters/browser_adapter.cjs`，私有配置放 `adapters/private/browser.json`。

后端以固定子进程运行脚本，不使用 shell；stdin 是一份 JSON，stdout 只能是一个 JSON 对象，字段见[接口约定](API_CONTRACT.md)。只有明确的 `succeeded` 与完整且类型匹配的 `delivery` 才会交付。点击按钮、页面跳转、请求受理或等待付款都不等于交付成功。

浏览器自动化额外需要 Node.js 18+、自己安装的 Chrome 和 `puppeteer-core`：

```sh
npm install --ignore-scripts --package-lock=false
```

Chrome 路径、可选模块路径和私有浏览器配置通过环境变量传入，实际值由本人填写，不写入公开源码。独立运行模板或由后端调用的详细步骤见[自有网页自动化配置](docs/upstream-automation.md)。默认模拟模式不会调用这份自有脚本。

当前网页模板只支持传统的整页表单导航，不支持 AJAX（不刷新整页的局部请求）；页面脚本主动发起连接、网页后台任务（Worker）与持续连接（WebSocket）均被禁止。使用这些机制的自有网站需要本人另行适配、验证，不能直接套用模板。详细支持范围见自动化说明。

## 5. 不确定结果怎么处理

| 屏幕状态 | 含义与处理 |
| --- | --- |
| 待付款 | 还没提交核款申请，不采购 |
| 待核款 | 客户已申报，商家还需核对真实到账 |
| 排队 / 提交中 / 处理中 | 已确认核款；固定关联本地订单号处理 |
| 完成 | 已取得完整交付内容，可凭本单查询码查看 |
| 结果待核实 | 超时、进程中断或上游说不清；商家只能查询原单，不重新采购 |
| 失败 | 上游明确失败；本人核对处理，本项目不自动退款 |

提交前先记录固定商家订单号和提交意图；重启时处于“提交中”的订单会转为“结果待核实”，不会再次提交。处理中只做有限次数查询。真实上游若不能可靠按商家订单号查询原单，就不能直接依赖此模板完成真实采购。

## 6. 本地数据与分享边界

运行后会在 `data/` 生成 SQLite 数据库和随机 `local.key`。目标值、付款参考、上游参考号与交付信息加密后落库；查询码只存摘要。**数据库和密钥需一起妥善保管，丢失密钥无法解密原数据。** 这不是备份工具，项目没有自动备份或密钥恢复功能。

以下内容只保留在使用者本地，不放入分享提交：`.env`、`data/`、`assets/private/`、`adapters/private/`、`adapters/local_*`、`config/products.json`、私人浏览器资料和运行日志。公开前按[分享边界](SHARING_POLICY.md)复核实际文件，不能只依靠忽略规则。

默认监听本机地址。若自行改为其他监听地址，服务会拒绝默认口令；对外运行所需的 HTTPS、访问入口和实际环境验证由使用者自行配置，本项目未对任何公网部署作验证。

## 7. 检查与验证

基础后端检查不会访问真实上游：

```sh
python -m unittest discover -s tests -v
```

测试自己创建临时项目根与数据库，不读使用者 `.env`。可选的浏览器页面检查和本机虚构上游检查，需要先安装上文的 Node 依赖，再配置本人浏览器路径。下面的 Chrome 路径是提示文字，请替换为本人机器上的实际值；不要将实际路径写入分享源码：

```sh
export CHROME_PATH='填写你自己的Chrome可执行文件路径'
export CHROME_BIN="$CHROME_PATH"
export DEMO_TEST_PYTHON="$(command -v python)"
export PYTHON="$DEMO_TEST_PYTHON"
node tests/test_browser.cjs
node tests/test_browser_adapter.cjs
```

这两份测试使用不同环境名：页面测试读取 `CHROME_BIN`（也支持 `PUPPETEER_EXECUTABLE_PATH`）与 `DEMO_TEST_PYTHON`；上游模板测试读取 `CHROME_PATH` 与 `PYTHON`。如果 Puppeteer 安装在项目之外，可另外通过 `GC_PUPPETEER_MODULE` 传入本人本机模块路径；项目内正常安装无需填写。

已执行范围与结果请看[验证记录](docs/validation.md)。本地虚构网页跑通只能证明模板在该演练站工作，不能证明任何真实网站的页面、登录或交付已适配。
