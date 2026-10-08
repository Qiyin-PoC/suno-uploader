# 免期音账号体验版

用户明确要求给他人试用的独立构建。没有期音账号登录、会员到期或设备数量控制，上传、下载、歌词和历史入口无需联系 licensing 服务。Suno 上传仍需使用者正常登录自己的 Suno 账号，不包含任何人的 Suno 会话或凭据。

Mac 应用名 Qiyin Experience，bundle identifier 为 com.qiyin.suno.experience，与原版分开保存用户数据。原版默认继续要求账号授权；体验版使用编译时 QIYIN_FREE_EXPERIENCE=1，不是运行时开关。

已有正确架构的 runtime 时，在根目录执行：

```sh
python3 tauri-preview/package_experience_macos.py
```

完整重建先按 tauri-preview/README.md 安装依赖并构建 runtime。脚本设置独立 Tauri 配置和编译标记，随后调用现有 Mac 打包流程。其他人无需搭建账号后端。

当前构建仍要求 macOS 26，x64 版本在 Apple 芯片上需 Rosetta。尚未完成 Developer ID 签名和公证；首次运行可能需要使用者在系统设置中确认。它不是正式商业收费包。

## 2026-09-16 验收

独立 app 在本机成功显示，期音登录入口隐藏，无 token/账号服务器即可完成“你好世界 / 音乐让我们相遇”到无声调拼音的真实 worker 转换。JavaScript 测试 16 通过、1 跳过；默认商业构建与免账号构建 Rust 测试均为 6 通过。批量上传下载沿用现有实现，本次没有重新执行真实 Suno 上传。

本机编译工具更新后，x64 Python/Rust 调用 ARM-only CLT 需使用临时 ARM clang/ar 包装器；Node 也需显式以 arm64 执行以匹配安装的 Tauri CLI。编译成功后的 app 经原生 hdiutil 制作为标准 DMG（含 Applications 链接和使用说明），避免当前环境的 bundle_dmg.sh 失败。上述临时包装器不是接收电脑的必需依赖。
