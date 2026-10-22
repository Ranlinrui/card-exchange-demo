# 使用自己的上游网页自动化

分享版默认使用 `UPSTREAM_MODE=mock`，不会连接供方。这里提供的是一套通用网页操作模板，所有路径、表单和商品均为全新虚构示例，不含任何真实供方或原系统 API。真实收款仍需商家核实到账，核款通过后才允许采购；模板没有自动确认真实付款的能力。

## 先在本机演练

需要 Python 3、Node.js 18 或更新版本、自己安装的 Chrome，以及通用依赖 `puppeteer-core`。可以在项目根运行 `npm install --no-save --package-lock=false puppeteer-core`。依赖使用常规 `require('puppeteer-core')` 解析，也可用环境变量 `GC_PUPPETEER_MODULE` 指向使用者本机安装的模块。不要把自己机器的绝对路径写进分享源码。

```sh
python3 tools/mock-upstream/server.py
```

另开终端，复制公开示例到被 Git 忽略的私人目录：

```sh
mkdir -p adapters/private
cp adapters/browser.example.json adapters/private/browser.json
chmod 600 adapters/private/browser.json
export UPSTREAM_BROWSER_CONFIG="$PWD/adapters/private/browser.json"
export CHROME_PATH="/你自己的Chrome可执行文件路径"
export DEMO_UPSTREAM_USERNAME='demo-user'
export DEMO_UPSTREAM_PASSWORD='demo-only-password'
```

这两个账号值只用于虚构本机演练站。真实账号只能由使用者通过自己的环境变量注入，不写进 JSON、源码、终端日志或报告；真实密码可用终端隐藏输入方式设置。脚本不会读取原系统的任何账号、Cookie 或浏览器资料。

```sh
printf '%s\n' '{"operation":"submit","merchant_order_id":"DEMO-LOCAL-001","product":{"id":"demo-code","kind":"code"},"target":"合成演练目标","upstream_reference":""}' | node adapters/browser_adapter.cjs
```

首单返回 `processing` 和虚构单号；将 `operation` 改为 `query` 后，返回 `succeeded` 与合成交付。再次提交同一 `merchant_order_id` 会查回原单，不再创建。本机演练站只在 `127.0.0.1:8766` 监听，订单存内存，重启清空；不能用来承载真实订单或证明真实库存。

演示的成品号使用保留域名 `example.invalid`，密码是合成文本，二次验证码种子是 RFC 6238 公开测试种子，均不能作为真实账号使用。

## 换成你自己的站点

只有站点所有者或获明确授权的人可以适配。修改 `adapters/private/browser.json`，不要修改公开示例为真实资源，也不要将私有配置、二维码或账号提交到 Git。

| 配置 | 怎么填 |
| --- | --- |
| `allowedHosts` | 精确填写允许访问的主机和端口，如 `orders.your-domain.example`；不支持通配符。页面引用的图片、字体和脚本域名也要逐个确认后加入。 |
| `login.url`、`create.url`、`query.url` | 你自己的登录、创建订单和按商家订单号查询页面。HTTPS 为必需；只有本机回环地址可用 HTTP。URL 不允许夹带用户名和密码。 |
| `usernameSelector`、`passwordSelector`、`submitSelector` | 页面输入框、按钮的 CSS 选择器，即浏览器定位某个控件的规则。示例 `#demo-username` 仅存在于虚构站。 |
| `successSelector`、`errorSelector`、`captchaSelector` | 分别定位明确的登录完成标记、登录错误标记、验证码或人工验证标记。验证码出现就返回 `action_required`，交给本人处理。2FA 同样应配置成需人工处理的标记，不实现绕过。 |
| `create.productSelector`、`productControl` | 商品控件位置和类型，类型只支持 `select` 或 `input`。本地商品 `product.id` 必须与自有页面选项值一致。 |
| `targetSelector`、`merchantRefSelector` | 接收目标与商家固定订单号的输入框。目标只填表，不可成为导航网址。 |
| `query.merchantRefSelector` | 必须能按商家订单号找原单。查不到和查询失败必须有明确区别。可选 `referenceSelector` 用于输入原上游单号。 |
| `result.rootSelector`、`statusSelector`、`statusAttribute` | 结果区域和明确状态字段。示例读取 `data-status`，不从任意网页文字猜“成功”。 |
| `result.statusMap` | 将站点明确状态映射到约定白名单；未映射值只能是 `unknown`。只有实际取得交付时才映射 `succeeded`。 |
| `result.delivery` | 卡密或成品号的专用字段选择器。成功必须取得与商品类型一致的完整交付，否则回到 `unknown`。 |
| `headless`、`timeoutMs` | 是否隐藏浏览器窗口及等待时间，等待范围 200–60000 毫秒。 |

本模板只支持传统表单提交后打开一个完整的新页面。登录、查单、创建都会等待本次表单的页面导航完成，之后才读取新页面结果；页面上预先显示的“查无此单”不能授权创建订单。AJAX 页面（不刷新页面、在后台请求数据后局部更新）需要使用者自行适配并验证本次完成信号，不能直接使用本模板。

不支持导入真实浏览器 profile、不忽略 TLS 证书错误、不破解验证码、2FA 或站点访问控制。自动化窗口弹窗会被阻止；需要弹窗支付或额外人工确认的站点，应由使用者修改自己的适配脚本并单独验收。

普通页面导航、重定向和子资源请求按固定配置的域名白名单拦截。另通过浏览器网络层给响应追加 `Content-Security-Policy: connect-src 'none'; worker-src 'none'`：由 Chromium 自身禁止 WebSocket、fetch、XHR、EventSource、sendBeacon 等页面主动连接，并禁止启动 Worker，不依赖覆盖 `window.WebSocket`。这也会阻止白名单站点的 AJAX 和 Worker，因此模板限定为传统表单。检测到该连接策略被触发时，返回 `unknown` / `URL_NOT_ALLOWED`，不会继续创建。此机制是本模板支持的页面操作边界，不承诺将任意恶意网页、浏览器后台流量或所有浏览器功能封装成完整网络沙箱；使用者只能配置自己有权操作的站点。

只有商家本人明确开启以下配置后，后端才会调用自有脚本：

```text
UPSTREAM_MODE=custom
UPSTREAM_SCRIPT=adapters/browser_adapter.cjs
ALLOW_LIVE_UPSTREAM=true
```

同时需要替换演示管理员密码，按项目启动说明设置。脚本需要 `UPSTREAM_BROWSER_CONFIG`、`DEMO_UPSTREAM_USERNAME`、`DEMO_UPSTREAM_PASSWORD`、`CHROME_PATH` 等环境变量由启动后端的进程继承。客户请求不能设置脚本路径、URL、选择器或浏览器配置。适配真实页面后，必须由本人验证实际页面结构、原单查询准确性、防重复能力和交付结果；演练通过不代表任何真实站点已验证或一定可用。

## 不明确时如何处理

`submit` 先登录并查原单：查到则返回原单；明确 `not_found` 才创建；`unknown`、超时、登录失败、验证码或页面变化都停止。创建后等待结果超时也返回 `unknown`。后端之后只能查原单，不重新采购。商家订单号是固定关联依据，真实站点若不能可靠按此字段核对原单，本模板不适合直接启用。

标准输出只有一行 JSON，错误使用枚举 `error_code`，不会输出网页 HTML、截图、目标值、登录密码或上游原始错误。业务交付通过 `delivery` 返回给后端属于必要输出，调用方也应避免记录该内容。浏览器任务最多运行 45 秒，超时关闭本次独立浏览器并返回 `unknown`；后端子进程保留至 50 秒，给清理和结构化输出留出时间。无论成功或异常，最后都会关闭本次独立浏览器。

## 本机验证

先按项目主说明安装 `requirements.txt` 中的后端依赖；配置好自己安装的 Chrome 和模块路径后运行。若 Python 在虚拟环境中，可激活虚拟环境，或通过 `PYTHON` 指定自己的解释器路径：

```sh
node tests/test_browser_adapter.cjs
```

测试自动启动临时端口的本机虚构站，不访问外网，涵盖重复订单、查询交付、登录错误、缺失控件、域名限制、非本机 HTTP、URL 夹带口令、验证码、查询不明确、提交结果超时与外部子资源拦截；同时通过后端 `custom` 的真实子进程调用验证提交和查询。新增的反例用预先存在的 `not_found` 节点加延迟局部更新，证明没有本次页面导航就不能创建；另设白名单外的第二个本机接收端，先用阳性对照证明它能统计 WebSocket 握手，再验证普通页面、同源 iframe 和 Worker 均不能增加握手或创建订单。测试配置仅写入 `adapters/private/`，结束清除本次生成的文件；后端集成仅在系统临时目录生成合成订单并随即清除，不生成截图，也不读取任何真实供方资料。
