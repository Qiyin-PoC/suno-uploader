# 期音科技 · Suno 歌曲上传器

本项目仅保留三个业务板块：

1. **Suno 歌曲上传**：支持单曲/批量上传、断点续传、速度模式、歌词处理和多账号。
2. **上传历史**：查看、搜索、筛选和清理上传记录。
3. **Suno 歌曲下载**：支持 MP3、WAV、m4a，每批最多 100 条链接。

Windows 内部版不要求额外的网站账号或软件权益。上传仍需连接使用者自己的 Suno 账号；公开歌曲链接下载不要求登录 Suno。

## 运行要求

- Windows 10/11 x64。
- 上传功能需要 Chrome 或 Edge 120+ 及仓库内的 Suno 登录助手。
- 下载功能需要正常联网。
- 免安装包已经包含 Electron、Python 运行时和 FFmpeg。

## 项目结构

```text
electron/              Electron 主进程、preload 和原期音界面
backend/               上传、历史、歌词及下载 Python 后端
python-embed/          Windows 嵌入式 Python 运行时
vendor/ffmpeg/         内置 FFmpeg
suno-login-extension/  Suno 登录助手（协议 2）
tauri-preview/         Mac 体验版与跨平台预览实现
scripts/               发布检查和打包版 E2E
tests/                 单元、集成、FFmpeg 与打包版测试
```

## 安装依赖

```powershell
npm install
```

## 检查和测试

```powershell
npm test
npm run check
```

测试覆盖：

- 内部 Python Token 预检与扩展刷新竞态；
- 无网站任务租约的上传 worker 启动；
- 上传准备取消和 deadline；
- 有效 Suno URL 与 m4a 批量下载；
- MP3/AAC 回退生成真实、可解码的 M4A 容器；
- 原期音三个界面板块、CSP 和 IPC 安全边界；
- 打包程序中的真实 Python 进程启动路径。

## 构建 Windows 免安装版

```powershell
npm run pack   # dist/win-unpacked
npm run dist   # dist/ 下生成免安装 ZIP
```

`pack` 和 `dist` 会依次运行自动测试、发布一致性检查、Electron 打包以及打包版 E2E。完整解压后运行 `Suno歌曲上传器.exe`，不要只复制主程序。

## 使用步骤

### 连接 Suno 并上传

1. 在软件中选择账号 1/2/3 并启动扩展登录。
2. 在 Chrome 或 Edge 中加载 `resources/suno-login-extension`。
3. 完成配对并保持对应 Suno 账号可用。
4. 选择单曲或批量音频，设置速度、歌词和续传策略后开始上传。

### 下载歌曲

进入“Suno 歌曲下载”，每行粘贴一个有效的 Suno 歌曲链接，选择 MP3、WAV 或 m4a 后开始下载。

## Mac 免账号体验版

`codex/mac-account-free-master` 分支包含 Mac 体验版。进入源码根目录执行：

```bash
python3 tauri-preview/package_experience_macos.py
```

体验版不连接额外的网站账号授权服务，上传仍需要使用者自己的 Suno 登录。构建要求 macOS 26+；完整限制与验收记录见 [docs/ACCOUNT-FREE-EXPERIENCE.md](docs/ACCOUNT-FREE-EXPERIENCE.md)。

## 合规说明

请遵守 Suno 服务条款和相关版权规定，只处理本人拥有权利或已经获得授权的音频。
