# 商业化部署与运营

## 收费路径

桌面端注册期音账号 → 后端按服务端价格创建订单 → 支付平台生成订单二维码 → 客户扫码 → 后端校验官方签名、收款主体、订单号和金额 → 数据库事务同时记录付款和延长授权 → 桌面端查询自己的订单并刷新权益。

客户端不能决定金额、授权天数、是否已付款；也没有“提交截图即开通”的接口。个人静态收款码可以收款，但本系统无法仅据收款码自动核实订单到账。试卖时可由管理员人工对账后执行 grant；自动支付仍需商户接口。

### 微信

按公司或个体工商户等实际主体申请商户号、认证适用的 AppID 并绑定，申请 Native 支付权限。准备商户 API 私钥及序列号、API v3 密钥、微信支付公钥及公钥 ID。当前实现支持直接商户模式、微信支付公钥模式；不支持服务商／特约商户字段或平台证书轮换模式。

- [官方 Native 接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015614538)
- [官方 Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)

### 支付宝

使用符合实际经营场景的商家主体，申请当面付中扫码支付能力，配置应用 AppID、卖家 ID、应用 RSA2 私钥和支付宝公钥。当前实现使用普通公钥模式；证书模式需另行适配。经营类目及申请材料以商户平台审核要求为准。

- [官方 alipay.trade.precreate 接口](https://developer.alibaba.com/docs/api.htm?apiId=862&docType=4)
- [官方通知验签与业务核对说明](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/async-notify-verify.html)

密钥应由商户管理员在自己的电脑／服务器安全配置，不放入聊天、Git、客户端、前端页面或应用安装包。

## 单服务器部署

1. 准备 Linux 服务器、Docker Compose、解析至服务器的域名，开放 80/443。
2. 复制 `deploy/.env.example` 为 `deploy/.env`，设置真实域名、价格（整数分）、套餐天数和商户参数。默认价格 0 禁止售卖；30 天、2 台设备是实现默认值，正式销售前需确认。
3. 将商户私钥和平台公钥存入 `deploy/secrets/`；按 `.env` 的文件名配置。私钥／目录仅服务器管理员和容器 UID 10001 可读，不给其他用户读权限。
4. `docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build`。
5. 检查 `https://你的域名/health`、TLS、重启持久化和备份恢复，再配置桌面端正式域名。

Caddy 管理 HTTPS；API 不向主机发布端口，只经 Caddy 转发。API 信任该专用 Docker 网络里的代理，Caddy 覆盖 X-Forwarded-For 为真实连接来源。不要把 API 端口另外公开，也不要把不可信容器加入这个网络。

SQLite 适合首版单节点运营。数据卷 `licensing-data` 保存用户、会话、设备、订单、审计日志和限流计数。多服务器部署前迁移到共享数据库，不要复制成多个互不一致的 SQLite 实例。

## 管理操作

管理命令在服务器上通过已认证的 SSH 执行，无公网管理员接口。

```sh
# 容器内默认读取 QIYIN_DATABASE
# 以下省略 compose 的 -f / --env-file 参数，可先进入 deploy 目录

docker compose exec api python -m licensing.admin inspect customer@example.com
docker compose exec api python -m licensing.admin grant customer@example.com --days 30 --reason '线下到账单号-xxx'
docker compose exec api python -m licensing.admin revoke customer@example.com --reason '退款已完成'
docker compose exec api python -m licensing.admin disable customer@example.com --reason '暂停使用'
docker compose exec api python -m licensing.admin enable customer@example.com --reason '恢复使用'
docker compose exec api python -m licensing.admin reset-password customer@example.com --reason '客服核验已完成'
docker compose exec api python -m licensing.admin reconcile 服务器订单号
```

- `grant` 从当前有效期或当前时间（取较晚者）延长。人工授予前自行核对到账，不信任截图。
- `revoke` 撤销账号全部当前权益；不是按订单退款，也不会向支付平台退款。
- `disable` 和重置密码会撤销全部会话和设备绑定。
- `reconcile` 向官方查单、验证平台响应后幂等补单。用于支付成功但通知丢失；下单超时的订单也保留为 unknown 供核对。
- 自动退款、退款回调和按订单扣回部分期限未实现。首版退款需商户平台人工办理，再核对账号权益并撤销／调整，保留审计原因。
- 邮箱当前仅是登录名，未接邮件验证和自助找回；管理员必须核验购买记录等信息后重置密码。

备份时使用 SQLite backup API 或停止服务后备份完整数据卷，不能只复制运行中的主数据库文件而遗漏 WAL。定期在另一台测试环境恢复备份，检查用户与订单能否一致恢复。

## 上线前必须完成的真实验证

- 商户审批、准确的经营场景、实际价格与套餐天数；两支付渠道各完成一笔授权的真实小额支付、漏通知补单和退款操作。
- 微信公钥 ID／公钥匹配，商户密钥安全保存；支付宝选用与应用配置一致的公钥模式。
- 回调公网可达、服务器时间同步；回调失败可被监控，定期对账，服务／数据库／磁盘告警。
- Windows、macOS、Linux 各自干净机器的安装包；Python 和 ffmpeg 全部依赖、签名与 macOS 公证。
- 用获准的 Suno 测试账号和音频完成登录、上传、下载、断点续传、账号切换、网络中断测试。当前没有进行真实 Suno 上传，也没有消费积分。

## 防篡改边界

后端是订单与权益的唯一权威，正规桌面端每次启动付费操作都联网核验。核心切片和上传逻辑仍在客户电脑，本地 Python 入口没有独立商业鉴权，具备修改代码能力的人可能绕开客户端检查。当前不能宣称“绝对防破解”；若商业目标需要更强的收费强制性，应把不可替代的核心能力迁移至服务端，再结合发行签名、升级机制和服务端额度控制。不要把客户端软件锁等同于不可绕过的服务端业务控制。
