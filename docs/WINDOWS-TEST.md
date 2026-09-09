# Windows 预览版验收

目前没有 Windows 实测通过的结论，也没有可发布的 Windows 安装包。
2026-09-08 检查：本机 Parallels 的 OpenClaw 注册项指向未挂载的外接盘，状态 invalid；
GitHub 连接查询 Qiyin-PoC 未返回可访问仓库，因此尚未启动云端流水线。

## 构建机准备

使用 Windows x64、x64 Python 3.14、Node 24、Rust MSVC x64 和 Visual Studio C++ Build Tools。
构建前安装项目依赖，并提供经过来源和许可证检查的独立 Windows FFmpeg。
不可复制 Mac 的 runtime 到 Windows。下面操作从仓库根目录执行：

```powershell
py -3.14 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/requirements.txt -r tauri-preview/requirements-build.txt -r licensing/requirements.txt pytest
npm ci
npm test
.venv\Scripts\python.exe -m pytest -q
$env:QIYIN_PREVIEW_FFMPEG = 'C:\实际路径\ffmpeg.exe'
.venv\Scripts\python.exe tauri-preview/package_windows.py
```

脚本构建冻结引擎，在只保留 Windows 系统路径的环境中验证音频切片、变速、中文路径、拼音与韩文，
运行 Rust 测试，然后生成当前用户安装的 NSIS 包和包含校验值的构建报告。
缺少 WebView2 时安装器需要联网下载。构建成功不代表安装和界面验收成功。
此包仅连接本机测试账号服务 18870；不连接 Ubuntu 的 HTTP 8081 服务。

## 实际安装验收（逐项留证）

- 标准用户安装、首次启动、缺少 WebView2 时的提示和安装；记录安装体积。
- 本地账号服务启动后，注册、登录、未开通阻断、授权生效、到期/撤销、退出、设备上限。
- 中文及带空格的文件和目录选择、六种歌词处理、历史记录。
- MP3/WAV/原格式真实下载，检查文件内容和时长。
- 任务取消、关窗口、退出进程后无残余 worker 或 FFmpeg；退出不影响其他软件。
- Suno 浏览器登录、已获用户授权的 12 秒合成音频上传；无法登录则标记未测。
- 重装、卸载、重启；记录用户数据保留情况。

Windows ARM 上运行 x64 包的结果应单独标注，不能替代原生 x64 Windows 的结论。
每项记录系统版本、安装包 SHA256、实际结果及失败日志；不得将未测项记为通过。

官方依据：https://v2.tauri.app/distribute/windows-installer/

## 云端执行入口

当前源码的 `.github/workflows/windows-preview.yml` 直接 checkout 仓库，不需要源码 ZIP。
在 GitHub Actions 选择 Windows preview acceptance，选择交接分支后手动 Run workflow。
自动构建会运行 Windows Server 2022 x64 上的测试、冻结引擎自检与 NSIS 打包；结果下载为
`windows-preview-internal-qa` artifact，保留 3 天。还需 Windows 10/11 普通用户桌面验收。
早期远端试验分支可能残留 ZIP 解压版 workflow；请使用本次交接分支中的直接 checkout 版本。

批量验收新增：两首及多首上传、两条及多条链接下载、重复链接去重、无效输入、某项失败继续、
只重试失败项、停止后不启动下一项、重新授权失败暂停、同名文件不覆盖。100 首上限需要单独测试。
