# Windows 开发交接（2026-09-09）

## 目标和基线

把已经在 Mac 上验证的 Tauri 轻量版交付成可安装、可使用的 Windows x64 软件。
主入口是 `tauri-preview/`，保留 Electron 便于追溯旧功能，不要求把旧的解密、分离、编辑模块全部迁移。
业务范围：期音账号授权、Suno 登录、批量上传、批量下载、文字歌词转换、上传记录。

Mac 本体目前仍为 x64、macOS 26 QA 包；Apple 芯片上 Chrome 使用 ARM64 原生启动，修复了被 x64 worker 启动为转译进程导致的明显卡顿。
这不代表已有 ARM64 原生客户端，也不代表 Windows 验证通过。

## 从哪里改

- `tauri-preview/ui/index.html` / `app.js` / `style.css`：中文界面、账号交互、多选与队列结果。
- `tauri-preview/ui/batch.js`：顺序队列与下载链接校验。失败重试不会重新执行成功项，队列仅驻留内存。
- `tauri-preview/src-tauri/src/main.rs`：选择文件、Task 参数、账号请求、每首授权、worker 生命周期与取消、结果过滤。
- `tauri-preview/worker.py`：冻结 Python 的命令分发与自检。
- `tauri-preview/build_runtime.py`：PyInstaller 冻结和 FFmpeg 装入；必须在 Windows 构建 Windows runtime。
- `tauri-preview/package_windows.py` / `src-tauri/tauri.windows.conf.json`：Windows x64 构建、自检与当前用户 NSIS 安装器。
- `backend/backend.py`：上传及浏览器会话；`browser_launch.py` 只处理 Mac 原生架构选择，Windows 保留既有启动方式。
- `backend/suno_download_cli.py` / `suno_download_jobs.py`：下载、转换、另存与取消。
- `backend/lyrics_local.py`：不带声调拼音及同音替换；输入是文字，不是音频。
- `licensing/app.py` / `store.py` / `admin.py` / `payments.py`：服务端账号、到期、设备及支付。

## 第一轮建议工作顺序

1. 按 WINDOWS-TEST.md 在 Windows x64 配置 Python 3.14、Node 24、Rust MSVC、C++ Build Tools 与独立 FFmpeg；先跑源码测试，再跑 package_windows.py。
2. 使用单独的本机测试数据库启动账号服务，注册自己的测试账号并由管理员开通。不要依赖交接机器的数据库或测试密码。
3. 安装生成的 NSIS 包，以非管理员用户完成基础功能和批量验收；保留截图、退出码、脱敏日志及安装包 SHA256。
4. 优先修复路径、权限、浏览器发现、WebView2 和 worker/FFmpeg 退出清理问题。不要通过跳过会员授权来让测试通过。
5. 再做正式 HTTPS 账号联机、签名、更新、凭据保护。支付和正式销售需单独验收。

## Windows 本地账号服务

从仓库根目录，在 PowerShell 中运行（依赖安装见 WINDOWS-TEST.md）：

```powershell
$env:QIYIN_DATABASE = 'data/windows-qa.sqlite3'
$env:QIYIN_PRICE_FEN = '0'
.venv\Scripts\python.exe -m uvicorn licensing.app:create_app --factory --host 127.0.0.1 --port 18870
```

另一个窗口打开安装版，在界面用邮箱注册账号，密码至少 12 位，然后运行：

```powershell
.venv\Scripts\python.exe -m licensing.admin --database data/windows-qa.sqlite3 grant tester@example.com --days 30 --reason windows-acceptance
```

用自己注册的邮箱替换示例地址。管理员预置账号可以是用户名；公开注册仍要求邮箱和较长密码。
客户端不内置账号、密码、管理员权限或付费开通逻辑。Tauri 的期音会话只保存在 Rust 内存，重启需重新登录。
本机和云端测试数据库互相独立，不会同步账号更改。

## 云端服务现状

测试站在 `http://172.203.225.147/uploader/`，包含下载页和账号 API；`/` 是另一个人声工作台，不要覆盖。
服务与代理布局见 `deploy/test-server/README.md`；SSH 凭据由负责人通过私密渠道提供，不在仓库。
云端 HTTP 子路径只是测试入口。Rust `trusted_origin` 只允许根路径的 HTTPS，或显式 QA 构建的 loopback HTTP。
正式联机应配置专用 HTTPS origin，或正确实现完整子路径支持（客户端、代理、API 都需要匹配）；不能只把界面网址填进去，更不能放宽成任意 HTTP 地址。

## 已验证与未验证

| 项目 | 当前证据 |
|---|---|
| Mac 安装版登录/授权 | UI 登录成功，上传/下载/歌词授权接口通过 |
| Suno 登录 | 原生 Chrome 加载与会话在线校验成功 |
| 批量上传 | 两个自制 12 秒音频连续成功并返回歌曲链接 |
| 批量下载 | 上述两首 MP3 连续成功，48 kHz 双声道、12.0135 秒，完整解码通过 |
| 拼音 | 实际输出 `ni hao shi jie`，无声调；不做语音识别 |
| 重试/取消队列语义 | Node 回归通过；Windows 真实进程取消仍需验收 |
| Windows 安装与 GUI | 未测，不得填写通过 |
| WAV/原始音频批量、100 首压测 | 本轮未测；此前单首下载结果不能代替批量验收 |
| 真实支付 | 商户未配置，未完成真实交易验收 |

## 发售前缺口

- Windows 平台矩阵、普通权限安装/卸载/重启、中文及空格路径、浏览器登录、缺少 WebView2 的处理。
- 正式账号 HTTPS 接入与可运营的管理员流程；当前包绑定本机测试账号服务。
- 微信/支付宝真实商户、支付回调与查单、退款/续费/异常订单运营流程。
- 应用签名、Mac 公证、Windows 信任提示、自动更新签名和发布源。
- Suno 凭据仍由 Python 保存在应用数据目录，需要迁移到系统凭据保护；日志继续脱敏。
- 队列持久化与异常中断后的去重/恢复；不能在不核对远端状态时承诺“重试绝不重复上传”。
- 第三方 FFmpeg/LAME/Python 依赖许可证与源码提供义务、Suno 平台使用方式的正式产品审查。
- 更友好的错误、账号状态和结果交互；当前仍使用轻量验证版名称和版本号。

## 交付 Windows 的完成标准

提供可下载的 Windows x64 安装包、SHA256、构建提交号和测试环境；附逐项验收表和已知问题。
至少真实完成两首批量上传、两首批量下载及文件解码；验证无授权/到期阻断、停止/重试、卸载。
GitHub Actions 构建成功只代表构建与自动自检，不等于 Windows 桌面安装和业务链路验收成功。
