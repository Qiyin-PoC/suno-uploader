# 期音 Suno 上传器 · Windows 开发交接

桌面音乐工具：批量上传音频到 Suno、批量下载歌曲、歌词文字转换，以及独立的期音账号授权后端。

**接手 Windows 开发请先读 [Windows 交接说明](docs/WINDOWS-HANDOFF.md)，再按 [构建与验收](docs/WINDOWS-TEST.md) 操作。**

## 现在做到了什么

当前实际交付客户端是 `tauri-preview/`：Tauri 2 + Rust 窗口与任务管理 + 冻结 Python 引擎 + FFmpeg。`electron/` 是保留的旧客户端，不是这轮 Windows 轻量版的主开发入口。

- Mac 安装版已真实验证：期音登录、Suno 登录、两首合成音频连续上传、两首 MP3 连续下载并完整解码。
- 上传可多选音频，下载每行一个 Suno 歌曲链接，每批最多 100 首，逐首执行；有进度、结果、失败重试、停止和继续未完成项。100 首满量未压测，退出后队列不保留。
- 歌词工具接受文字；中文拼音不带声调。不包含音频识别歌词。另有同音字替换和有限的外语/方言规则工具。
- `licensing/` 提供注册、登录、服务端到期/设备限制及每项任务授权；有微信/支付宝支付适配代码，但真实商户、支付回调、定价和生产联调尚未完成。
- Windows 构建脚本、NSIS 配置和 GitHub Actions 已提供，**还没有 Windows 安装、界面或真实 Suno 上传验收结果**。

## 尚缺什么

1. Windows x64 原生构建、普通用户安装及卸载、WebView2、Chrome/Edge、中文路径、任务退出清理和真实批量任务验收。
2. 正式 HTTPS 账号服务与客户端联机。当前 Mac/Windows QA 构建绑定本机 `http://127.0.0.1:18870`；公开测试网页的 HTTP 子路径不能直接作为生产客户端账号地址。
3. 支付商户配置、真实支付和退款/续费运营流程、正式定价；不能把支付模拟测试视作可收款。
4. 签名、公证、自动更新源、Suno 凭据安全存储、完整发布合规与第三方许可证清单。
5. 队列持久化、崩溃恢复和异常中断后避免重复上传；目前重试前需要核对远端曲库。

**这是开发验证版，不是可直接销售的正式版本。** 详细结果以 [测试记录](docs/TEST-REPORT.md) 最新章节为准；历史章节不能作为当前全部功能通过的结论。测试密码、商户密钥、数据库、运行时和安装包不纳入源码提交。

## 目录

| 路径 | 用途 |
|---|---|
| `tauri-preview/` | 轻量桌面端、冻结引擎构建、Mac/Windows 打包 |
| `backend/` | Suno 上传、下载、歌词、音频处理 |
| `licensing/` | 账号授权、支付适配、服务器管理命令 |
| `deploy/` | 账号服务与测试下载站部署参考 |
| `.github/workflows/` | 跨平台测试与 Windows 安装包构建 |
| `tests/` | Python/JS 回归测试 |
| `electron/` | 旧客户端和遗留功能；不要误当作本轮主交付 |

以下命令主要针对旧 Electron 开发入口；Windows 轻量版使用上面的专门交接文档。

## 本地开发

Node.js >= 22.12，Python >= 3.12，ffmpeg 已安装。开发环境建议使用隔离目录。

```sh
npm ci
npm run setup:electron
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt -r licensing/requirements.txt pytest
QIYIN_DATABASE=data/dev.sqlite3 .venv/bin/python -m uvicorn licensing.app:create_app --factory --host 127.0.0.1 --port 18870
```

另一个终端启动桌面端（仅开发版允许本机 HTTP）：

```sh
QIYIN_LICENSE_URL=http://127.0.0.1:18870 npm start -- --user-data-dir=/tmp/qiyin-dev
```

Windows PowerShell 使用 `.venv\Scripts\python.exe` / `.venv\Scripts\pip.exe`；环境变量使用 `$env:QIYIN_LICENSE_URL='http://127.0.0.1:18870'`。开发模式自动查找 `.venv`，也可设置 `QIYIN_PYTHON`。发行版不接受这些环境变量覆盖授权域名或 Python。

先在桌面端注册测试账号，然后给本地账号开通：

```sh
.venv/bin/python -m licensing.admin --database data/dev.sqlite3 grant test@example.com --days 30 --reason local-development
```

## 测试

```sh
npm test
.venv/bin/python -m pytest -q
# 另行启动本地服务后，运行真实 HTTP 集成测试：
QIYIN_TEST_URL=http://127.0.0.1:18870 node --test tests/http-client.integration.test.js
```

`tests/test_licensing.py` 中的支付为本地生成 RSA 密钥的模拟，不是支付平台沙箱或真实交易。

## 桌面打包

将正式 HTTPS 域名填入 `electron/commercial-config.json` 的 `apiOrigin`。
准备当前目标平台的可分发 Python（含 backend/requirements.txt 中的库）与 ffmpeg：

```text
python-embed/win32-x64/python.exe
python-embed/darwin-arm64/bin/python3
python-embed/darwin-x64/bin/python3
python-embed/linux-x64/bin/python3
vendor/ffmpeg/<平台-架构>/ffmpeg[.exe]
```

这些运行时必须能在无开发环境的干净机器运行，不能把本机带绝对路径的 `.venv` 直接复制作为发行运行时。

```sh
npm run check:package -- darwin arm64
npm run dist -- --mac --arm64
# 在对应目标系统验证 Windows / Linux 构建
npm run dist -- --win --x64
npm run dist -- --linux --x64
```

构建前置检查会拒绝未配置域名或缺少平台运行时的发布，防止打出打不开或无法鉴权的包。签名证书、公证和自动更新尚未配置。
