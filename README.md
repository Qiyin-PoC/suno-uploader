# Suno 歌曲上传器 V5.0.4

本项目仅保留三个业务板块，

1. **Suno 歌曲上传**：切片拼接、单曲/批量上传、稳定/快速模式、歌词处理、多账号。
2. **上传历史**：记录、搜索、过滤、统计与清理。
3. **Suno 歌曲下载**：MP3 / WAV，支持每批最多 100 条链接。

## 5.0.4 更新

- 官网账号与软件权益重新闭环。
- Ed25519 短时 `ExecutionGrant`。
- 上传/下载独立任务授权与 loopback capability broker。
- Suno 浏览器扩展协议 2：约 30 秒刷新、浏览器/软件重启恢复、休眠恢复、账号绑定、防旧 token 覆盖。
- 45 秒上传准备 deadline、`AbortSignal`、准备阶段取消、后端慢启动提示和超时终止。
- IPC sender/main frame 校验、导航/webview/window.open 防护、HTTP(S) 外链过滤、CSP。
- Worker SHA-256 完整性校验与 JWT 日志脱敏。

## 运行要求

- Windows 10/11 x64。
- 正常联网。
- 有效的官网账号及对应软件权益。
- Chrome 或 Edge 120+（使用扩展协议 2 时）。
- 最终免安装包不需要安装 Node.js、Python 或 ffmpeg。

## 源码与运行组件

```text
electron/              Electron 31.7.7 主进程、preload 和 renderer
backend/               5.0.4 上传与下载 worker EXE
vendor/ffmpeg/         内置 ffmpeg
suno-login-extension/  5.0.4 / protocol 2 浏览器扩展
assets/                运行图标与界面资源
scripts/               发布一致性检查
tests/                 安全、任务授权、队列和打包界面测试
```

正式包使用与 5.0.4 manifest 匹配的：

- `backend/backend.exe`
- `backend/suno_download_cli.exe`

## 安装依赖

```powershell
npm install
```

项目锁定 Electron `31.7.7`，与对标程序实际运行时一致。

## 检查和测试

```powershell
npm run check
npm test
```

`npm run check` 会验证：

- 版本与 Electron 运行时；
- 17 个直接复用的 5.0.4 源文件 SHA-256；
- 协议 2 扩展文件 SHA-256；
- 上传/下载 worker 与 manifest；
- 侧栏严格只有上传、下载、历史；
- CSP、MP3/WAV 选项和 JavaScript 语法。

## 构建免安装版

```powershell
npm run pack   # dist/win-unpacked
npm run dist   # dist/Suno歌曲上传器-V5.0.4-免安装版.zip
```

ZIP 是正式免安装交付：完整解压后运行 `Suno歌曲上传器.exe`，不要只复制主 EXE。浏览器扩展位于解压目录的 `resources/suno-login-extension`。

## 使用步骤

### 1. 登录官网账号

打开左下角账号菜单，登录官网账号并完成软件权益验证。上传、下载任务会获取短时 ExecutionGrant 和独立任务租约。

### 2. 连接 Suno

- 选择账号 1/2/3。
- 点击扩展登录。
- 在 Chrome/Edge 中加载 `resources/suno-login-extension`。
- 输入配对码并保持原 Suno 账号页面可访问。

扩展协议 2 会自动刷新连接，并在浏览器、软件重启或系统休眠后尝试恢复。

### 3. 上传

选择单曲或批量音频，设置速度与歌词后开始上传。暂停或取消可终止尚未完成的准备阶段和上传 worker。

### 4. 下载

进入“Suno歌曲下载”，每行粘贴一个链接，选择 MP3 或 WAV，然后开始下载。

## 数据位置

应用名称和数据协议与 5.0.4 对齐，默认数据目录：

```text
%APPDATA%\悸风喵核 Studio
```

## 合规说明

- 上传、下载均使用登录账号对应的服务权限。
- 请遵守 Suno 服务条款和相关版权规定。
- 只处理本人拥有权利或已经获得授权的音频。
- 商业授权声明以应用内及 5.0.4 随附说明为准。
