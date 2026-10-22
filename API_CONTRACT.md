# 可配置卡密服务：本地演示接口约定

本项目是独立的资源隔离分享版。默认模拟，不包含原系统的供方协议、运营接口、部署资源或凭据。

## 启动与配置

运行入口：`python3 server.py`。默认监听 `127.0.0.1:8787`，数据目录 `data/`；Python 依赖只使用 `requirements.txt` 声明的通用库。

设置来自使用者本地 `.env`，不执行 shell。示例字段：

```text
HOST=127.0.0.1
PORT=8787
PUBLIC_ORIGIN=http://127.0.0.1:8787
SHOP_NAME=示例卡密服务
PAYMENT_QR_FILE=assets/demo-qr.svg
ADMIN_PASSWORD=demo-only-change-me
UPSTREAM_MODE=mock
UPSTREAM_SCRIPT=adapters/mock_adapter.py
ALLOW_LIVE_UPSTREAM=false
```

`data/`、`.env`、真实二维码、用户自建供方配置及浏览器资料不进入 Git。真实二维码必须在 `assets/private/` 内配置，由公开的固定资源路径提供；演示图明确标注不可付款。

## 客户接口

- `GET /api/catalog`：`{shop_name,mode,payment_qr_url,products:[{id,name,price_cents,currency,kind,target_label}]}`。
- `POST /api/orders`：输入 `{product_id,target}`；返回 `{order:{id,product_name,amount_cents,currency,target,state,status_text,delivery:null},lookup_code}`。`lookup_code` 只在创建时返回，服务端只存摘要。
- `POST /api/orders/lookup`：输入 `{id,lookup_code}`；返回 `{order:{id,product_name,amount_cents,currency,target,state,status_text,delivery}}`。
- `POST /api/orders/payment`：输入 `{id,lookup_code,payment_reference}`；只提交核款申请，返回同样的 `{order}`，不得直接标记已付款或触发上游。
- `GET /assets/payment-qr`：按固定配置提供演示图或使用者自备二维码，不接受请求指定路径。
- `GET /api/health`：`{ok:true,mode}`。

金额始终为整数分。创建订单时冻结商品和金额；公开查询必须验证本单查询码。`delivery` 仅 `completed` 时返回：`{kind:"code",text:"DEMO-..."}` 或 `{kind:"account",email:"demo@example.invalid",password:"SYNTHETIC-...",totp_secret:"公开测试用Base32"}`。

## 商家接口

- `POST /api/merchant/login`：`{password}`；返回 `{csrf_token}` 并设置 HttpOnly、SameSite=Strict 会话 Cookie。
- `POST /api/merchant/logout`：`{csrf_token}`；退出。
- `GET /api/merchant/orders`：经 Cookie 鉴权返回 `{orders:[order...]}`，可包含本店客户申报的付款参考号。
- `POST /api/merchant/orders/{id}/confirm`：`{csrf_token,amount_cents,received_confirmed:true}`。必须核实收款并输入相同金额，且仅允许待核款订单进入 `queued`；重复确认不得再次采购。
- `POST /api/merchant/orders/{id}/query`：`{csrf_token}`。只查原上游订单，不重新提交。

所有写请求检查同源 Origin、JSON 类型和大小；商家写请求另检查会话和 CSRF。所有错误统一 `{error:本地安全提示}`，不返回上游网址、凭据、原始日志或堆栈。

## 订单状态

`awaiting_payment → payment_review → queued → submitting → processing → completed`。

失败为 `failed`；提交结果不明确或程序在提交后中断为 `unknown`。上游请求固定绑定本地订单 ID，提交前先记录意图，未知结果不自动再提交，只允许查询原单。`processing` 可有限轮询；超过等待窗口转 `unknown`。本项目不自动退款、不提供强制成功或重新采购按钮。

## 自有上游脚本约定

后端只执行商家配置的固定本地脚本，不接受客户提供命令、脚本路径或目标 URL，不使用 shell 拼接。脚本接收一行 JSON stdin：

```json
{"operation":"submit","merchant_order_id":"DEMO-ORDER","product":{"id":"demo-code","kind":"code"},"target":"示例账号ID","upstream_reference":""}
```

`operation` 是 `submit` 或 `query`。脚本 stdout 只输出一个 JSON：

```json
{"status":"processing","reference":"SYNTHETIC-REF","error_code":""}
```

成功可返回 `status:"succeeded"` 及上述 `delivery`。其余状态可为 `failed`、`unknown`、`not_found`、`action_required`。不得把“点击成功”“请求受理”“已打开支付页”当成功交付。真实网站无法核对原单时必须停在待处理。

默认 `adapters/mock_adapter.py` 仅生成合成数据。另提供 Python 自有适配器模板、可配置 Puppeteer 网页自动化模板及完全虚构的本地上游网页用于演练。用户自行填写自己的网址、选择器和凭据；模板不包含任何真实供方网址、API 路径、专用选择器、支付地址或资源信息。

静态收款码不能自动确认真实到账；商家核实后确认才触发上游。真实模式要求明确开启并更换演示管理员密码，且使用自己的资源配置。
