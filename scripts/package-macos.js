#!/usr/bin/env node
"use strict";

/**
 * 基于 PC 端（Electron）代码构建 macOS arm64 安装包。
 *
 * 与 Windows 版本的差异，以及本脚本负责补齐的部分：
 *   1. Windows 免安装包依赖 python-embed/ 与 vendor/ffmpeg/win32-x64/*.exe，
 *      这些二进制在 macOS 上不存在，因此这里用 PyInstaller 把 backend 冻结成
 *      自带运行时的 qiyin-engine（一个可执行文件同时承载 backend / download 两种模式）。
 *   2. ffmpeg 必须是可重定位的自包含构建。Homebrew 版本链接了 17 个
 *      /opt/homebrew 下的 dylib，复制到别的机器会无法启动。
 *      请先用 scripts/build-ffmpeg-macos.sh 生成。
 *      注意该构建带 --disable-network，只能处理本地文件：
 *      后端必须自己下载音频后再交给 ffmpeg，绝不能把 URL 直接传给 ffmpeg。
 *   3. macOS 上 arm64 二进制必须带签名才能执行。electron-builder 的 identity:null
 *      只会跳过签名，因此这里用 @electron/osx-sign 做逐层 ad-hoc 签名
 *      （不用 codesign --deep，Apple 明确不建议用 --deep 做分发签名）。
 *
 * 关于 Gatekeeper：ad-hoc 签名无法通过 spctl 评估，这是没有 Developer ID
 * 证书时的固有限制，不是构建错误。因此 dmg 内附带中文安装说明与一键安装脚本。
 *
 * 用法：node scripts/package-macos.js   （或 npm run dist:mac）
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build", "macos");
const ENGINE_DIST = path.join(BUILD, "engine");
const ENGINE_BIN = path.join(ENGINE_DIST, "qiyin-engine", "qiyin-engine");
const FFMPEG = path.join(BUILD, "vendor", "ffmpeg", "darwin-arm64", "ffmpeg");
const ICON = path.join(BUILD, "icon.icns");
const ICONSET = path.join(BUILD, "icon.iconset");
const LOGO = path.join(ROOT, "assets", "logo.png");
const PYTHON = path.join(ROOT, ".venv", "bin", "python");
const DIST = path.join(ROOT, "dist-mac");

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const PRODUCT = "Suno歌曲上传器";
const APP_NAME = `${PRODUCT}.app`;
const DMG_OUT = path.join(BUILD, `${PRODUCT}-V${VERSION}-arm64.dmg`);

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...options });

const capture = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT });

const step = (text) => console.log(`\n\u25b6 ${text}`);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 列出 Mach-O 依赖中非系统库的部分，含 @rpath / @loader_path 形式。 */
function nonSystemDependencies(binary) {
  return capture("otool", ["-L", binary])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean)
    .filter((lib) => !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/Library/"));
}

function preflight() {
  step("检查前置条件");
  if (process.platform !== "darwin") throw new Error("该脚本只能在 macOS 上运行");
  if (process.arch !== "arm64") throw new Error(`需要 arm64 主机，当前为 ${process.arch}`);
  if (!fs.existsSync(PYTHON)) throw new Error(`缺少 Python 虚拟环境：${PYTHON}`);
  if (!fs.existsSync(LOGO)) throw new Error(`缺少应用图标源文件：${LOGO}`);
  if (!fs.existsSync(FFMPEG)) {
    throw new Error(
      `缺少自包含 ffmpeg：${FFMPEG}\n` +
        "请先执行：bash scripts/build-ffmpeg-macos.sh\n" +
        "（Homebrew 的 ffmpeg 依赖 /opt/homebrew 下的 dylib，不可直接分发）",
    );
  }
  const deps = nonSystemDependencies(FFMPEG);
  if (deps.length > 0) {
    throw new Error(`ffmpeg 存在非系统动态库依赖，无法分发：\n  ${deps.join("\n  ")}`);
  }
  // 上传入口允许选择 .ape / .wma，ffmpeg 必须能解码，否则这两种格式会静默失败。
  for (const format of ["ape", "asf"]) {
    const demuxers = capture(FFMPEG, ["-hide_banner", "-demuxers"]);
    if (!new RegExp(`^\\s*D\\s+${format}\\b`, "m").test(demuxers)) {
      throw new Error(
        `ffmpeg 缺少 ${format} 解复用器，.ape/.wma 上传会失败。\n` +
          "请用 bash scripts/build-ffmpeg-macos.sh 重新构建。",
      );
    }
  }
  console.log("  ✓ 平台、Python、自包含 ffmpeg（含 ape/asf）均就绪");
}

/** 从 assets/logo.png 生成 icon.icns，保证图标可重建而非依赖手工放置。 */
function generateIcon() {
  step("生成应用图标");
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  const specs = [
    [16, "16x16"], [32, "16x16@2x"], [32, "32x32"], [64, "32x32@2x"],
    [128, "128x128"], [256, "128x128@2x"], [256, "256x256"],
    [512, "256x256@2x"], [512, "512x512"], [1024, "512x512@2x"],
  ];
  for (const [size, name] of specs) {
    execFileSync("sips", ["-z", String(size), String(size), LOGO, "--out", path.join(ICONSET, `icon_${name}.png`)], { stdio: "ignore" });
  }
  run("iconutil", ["-c", "icns", ICONSET, "-o", ICON]);
  fs.rmSync(ICONSET, { recursive: true, force: true });
  console.log(`  ✓ ${path.relative(ROOT, ICON)}`);
}

function buildEngine() {
  step("冻结后端引擎（PyInstaller）");
  fs.rmSync(ENGINE_DIST, { recursive: true, force: true });
  run(PYTHON, [
    "-m", "PyInstaller",
    "--noconfirm", "--clean", "--onedir",
    "--name", "qiyin-engine",
    "--paths", path.join(ROOT, "backend"),
    "--distpath", ENGINE_DIST,
    "--workpath", path.join(BUILD, ".build"),
    "--specpath", path.join(BUILD, ".build"),
    "--collect-all", "pypinyin",
    "--hidden-import", "socks",
    "--hidden-import", "backend",
    "--hidden-import", "suno_download_cli",
    path.join(ROOT, "electron", "engine", "entry.py"),
  ]);
  if (!capture("file", [ENGINE_BIN]).includes("arm64")) {
    throw new Error("引擎不是 arm64 架构");
  }
  console.log(`  ✓ ${path.relative(ROOT, ENGINE_BIN)}  sha256=${sha256(ENGINE_BIN).slice(0, 16)}…`);
}

function buildApp() {
  step("打包 Electron 应用");
  // 先清空输出目录：残留的旧 productName 会让 findApp 签名并打进 dmg 的是另一个 .app。
  fs.rmSync(DIST, { recursive: true, force: true });
  run(path.join(ROOT, "node_modules", ".bin", "electron-builder"), [
    "--config", "electron-builder.mac.json", "--mac",
  ], { env: { ...process.env, ELECTRON_GET_USE_PROXY: "1" } });
  const app = findApp();
  console.log(`  ✓ ${path.relative(ROOT, app)}`);
  return app;
}

function findApp() {
  const dir = path.join(DIST, "mac-arm64");
  if (!fs.existsSync(dir)) throw new Error(`未找到打包输出目录：${dir}`);
  const apps = fs.readdirSync(dir).filter((entry) => entry.endsWith(".app"));
  if (apps.length !== 1) {
    throw new Error(`打包输出中预期恰好一个 .app，实际 ${apps.length} 个：${apps.join(", ")}`);
  }
  return path.join(dir, apps[0]);
}

async function signApp(app) {
  step("Ad-hoc 逐层签名（arm64 必需）");
  // 用 @electron/osx-sign 自底向上签内层 dylib / framework / helper，再签主包。
  // 不使用 codesign --deep：它生成的签名缺少稳定的 identifier/team 语义，
  // 内层文件一旦变动就可能整体失效，而 arm64 上签名失效表现为无提示闪退。
  const { signAsync } = require("@electron/osx-sign");
  // identityValidation:false 让 osx-sign 跳过钥匙串身份查找，直接以 "-" 做 ad-hoc 签名；
  // 否则它会去查找 Developer ID 并抛 "No identity found for signing."。
  await signAsync({
    app,
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    // 必须跳过内置 PyInstaller 运行时：它自带一套自洽的 ad-hoc 签名
    //（主可执行与 _internal/Python.framework 共享同一签名标识）。
    // 一旦被重签，框架标识会被改成 org.python.python 并带上 hardened runtime，
    // 引擎随后 dlopen Python 动态库时会被 library validation 以
    // "mapping process and mapped file have different Team IDs" 拒绝，
    // 表现为引擎完全无法启动（上传/下载/歌词/历史全部失效）。
    ignore: [/\/engine\//],
    // 其余组件同样不启用 hardened runtime：本包是 ad-hoc 签名，
    // 启用它只会让库校验更严格而没有收益。
    // 注意 hardenedRuntime 必须放在 optionsForFile 里——osx-sign 逐文件合并的是它的返回值，
    // 顶层同名字段不会生效。
    optionsForFile: () => ({ hardenedRuntime: false }),
  });

  run("codesign", ["--verify", "--strict", "--verbose=2", app]);
  // 抽查内层关键组件确实带签名（主包 seal 不覆盖 Resources 下的独立可执行文件）。
  for (const nested of [
    path.join(app, "Contents", "Resources", "engine", "qiyin-engine"),
    path.join(app, "Contents", "Resources", "vendor", "ffmpeg", "darwin-arm64", "ffmpeg"),
  ]) {
    if (fs.existsSync(nested)) capture("codesign", ["--verify", "--strict", nested]);
  }
  console.log("  ✓ 主包与内层组件签名校验通过");
}

/**
 * 端到端确认内置引擎真的能启动。
 *
 * 这一步不是形式主义：签名一旦覆盖到 Resources/engine，引擎内部的
 * Python.framework 就会与主可执行失去签名关联，app 仍能"签名有效"、
 * 也能正常启动界面，但任何后端调用都会失败。只有真正运行一次引擎才能发现。
 */
function verifyEngine(app) {
  step("验证内置引擎可运行");
  const engine = path.join(app, "Contents", "Resources", "engine", "qiyin-engine");
  if (!fs.existsSync(engine)) throw new Error(`内置引擎缺失：${engine}`);
  let output = "";
  try {
    output = capture(engine, ["backend", "--history"]);
  } catch (error) {
    throw new Error(
      "内置引擎无法启动（签名很可能破坏了它的 Python 运行时）：\n" +
        `${(error.stdout || "") + (error.stderr || "")}`.trim(),
    );
  }
  if (!/"ok"\s*:\s*true/.test(output)) {
    throw new Error(`内置引擎返回了异常结果：${output.trim().slice(0, 200)}`);
  }
  console.log("  ✓ 引擎可加载 Python 运行时并正常返回");
}

function gatekeeperReport(app) {
  step("Gatekeeper 评估（预期结果）");
  let verdict = "unknown";
  try {
    capture("spctl", ["-a", "-t", "exec", "-vv", app]);
    verdict = "accepted";
  } catch (error) {
    verdict = `${error.stdout || ""}${error.stderr || ""}`.trim() || "rejected";
  }
  if (verdict === "accepted") {
    console.log("  ✓ 系统接受该应用");
  } else {
    console.log(`  ! 系统不接受（${verdict.split("\n")[0]}）`);
    console.log("    这是 ad-hoc 签名的预期结果：没有 Developer ID 证书就无法通过 Gatekeeper。");
    console.log("    dmg 内已附带安装说明与一键安装脚本，指导用户首次放行。");
  }
}

const INSTALL_NOTE = `Suno歌曲上传器 macOS 版（arm64）安装说明
==========================================

本安装包为 ad-hoc 签名、未做 Apple 公证，因此首次打开时 macOS 会拦截一次。
这不是文件损坏，按下面任一方式操作即可正常使用。


方式一：一键安装（推荐）
------------------------
双击本窗口内的「一键安装.command」。
它会自动把应用复制到「应用程序」、解除系统对下载文件的隔离标记并启动。
如果提示无法打开，请右键该文件 → 打开 → 在弹窗中再次点击「打开」。


方式二：手动安装
----------------
1. 把「Suno歌曲上传器.app」拖到右侧的 Applications 文件夹。
2. 在「应用程序」里右键点击它 → 选择「打开」。
3. 在弹出的对话框中再次点击「打开」。
   注意：直接双击会失败，必须走一次右键「打开」。

若已双击失败过，可前往
「系统设置 → 隐私与安全性」，在底部点击「仍要打开」。


系统要求
--------
- Apple 芯片（arm64）。本包不支持 Intel Mac。


功能说明
--------
可用：Suno 歌曲上传、上传历史、Suno 歌曲下载、歌词处理。
需要：上传功能需在 Chrome 或 Edge 120+ 中加载同目录内的
      suno-login-extension 登录助手，并登录自己的 Suno 账号。
不可用：音频编辑器、人声分离、QQ音乐/酷狗等解锁功能（Windows 专用组件，
        未随本平台提供）。


数据位置
--------
~/Library/Application Support/悸风喵核 Studio
（与旧版本保持一致，以便延续已有账号、历史与下载设置）
`;

const INSTALL_SCRIPT = `#!/bin/sh
# Suno歌曲上传器 一键安装
# 作用：把应用复制到「应用程序」，解除隔离标记并启动。
# 仅在本机执行，不联网、不上传任何数据。

set -e
cd "$(dirname "$0")"

APP="Suno歌曲上传器.app"
TARGET="/Applications/$APP"

if [ ! -d "$APP" ]; then
  echo "未找到 $APP，请确认本文件与本应用在同一窗口内。"
  exit 1
fi

echo "正在安装到「应用程序」…"
rm -rf "$TARGET"
cp -R "$APP" /Applications/

echo "正在解除系统隔离标记…"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "安装完成，正在启动…"
open "$TARGET"
`;

function buildDmg(app) {
  step("制作 dmg");
  const stage = path.join(BUILD, "dmg-stage");
  const rw = path.join(BUILD, "suno-rw.dmg");
  const mnt = path.join(BUILD, "mnt");
  const volumeName = PRODUCT;

  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(rw, { force: true });
  fs.rmSync(mnt, { recursive: true, force: true });
  fs.rmSync(DMG_OUT, { force: true });

  // 用显式挂载点，而不是根据卷名推断 /Volumes/<名称>。
  // 否则当同名卷已挂载（例如用户刚打开 dmg 还没推出）时，hdiutil 会挂到
  // "/Volumes/xxx 1"，导致 SetFile 作用到旧卷、detach 卸载掉用户的卷，
  // 并使 convert 处理一个仍处于挂载状态的可写镜像。
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(mnt, { recursive: true });

  let attached = false;
  try {
    run("cp", ["-R", app, stage]);
    fs.symlinkSync("/Applications", path.join(stage, "Applications"));
    fs.copyFileSync(ICON, path.join(stage, ".VolumeIcon.icns"));
    fs.writeFileSync(path.join(stage, "安装说明.txt"), INSTALL_NOTE, "utf8");
    const script = path.join(stage, "一键安装.command");
    fs.writeFileSync(script, INSTALL_SCRIPT, "utf8");
    fs.chmodSync(script, 0o755);

    run("hdiutil", [
      "create", "-srcfolder", stage, "-volname", volumeName,
      "-fs", "HFS+", "-format", "UDRW", "-ov", rw,
    ]);
    run("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, rw]);
    attached = true;
    run("SetFile", ["-a", "C", mnt]);
  } finally {
    // detach 单独兜住异常：否则它抛错会替换掉 try 块里的真实异常，报出误导性信息。
    if (attached) {
      try {
        run("hdiutil", ["detach", "-force", mnt]);
      } catch (error) {
        console.warn(`  ! 卸载 ${mnt} 失败，请手动执行 hdiutil detach "${mnt}"`);
      }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(mnt, { recursive: true, force: true });
  }

  try {
    run("hdiutil", [
      "convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", DMG_OUT,
    ]);
  } finally {
    fs.rmSync(rw, { force: true });
  }

  const size = (fs.statSync(DMG_OUT).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${path.relative(ROOT, DMG_OUT)} (${size} MB)`);
}

/**
 * 对最终 dmg 做端到端验收。
 *
 * 两点必须坚持：
 *  1. 用显式挂载点。默认挂载点由卷名推导，当同名卷已存在时 hdiutil 会挂到
 *     "/Volumes/xxx 1"，于是验收读到的其实是上一次的旧卷——这会导致把坏包
 *     当成好包，或反过来，是最难察觉的一类误判。
 *  2. 挂载后真的跑一次内置引擎。签名与 app 启动都正常、但引擎加载不了 Python
 *     运行时，是完全可能出现的组合（而且界面能打开，只有后端调用失败）。
 */
function verifyDmg() {
  step("验收 dmg");
  const mnt = path.join(BUILD, "verify-mnt");
  fs.rmSync(mnt, { recursive: true, force: true });
  fs.mkdirSync(mnt, { recursive: true });
  let attached = false;
  try {
    run("hdiutil", ["verify", DMG_OUT]);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, DMG_OUT]);
    attached = true;

    const app = path.join(mnt, APP_NAME);
    if (!fs.existsSync(app)) throw new Error(`dmg 内缺少 ${APP_NAME}`);
    run("codesign", ["--verify", "--strict", app]);

    const engine = path.join(app, "Contents", "Resources", "engine", "qiyin-engine");
    if (!fs.existsSync(engine)) throw new Error("dmg 内缺少内置引擎");
    const output = capture(engine, ["backend", "--history"]);
    if (!/"ok"\s*:\s*true/.test(output)) {
      throw new Error(`dmg 内引擎无法正常运行：${output.trim().slice(0, 200)}`);
    }
    for (const extra of ["安装说明.txt", "一键安装.command"]) {
      if (!fs.existsSync(path.join(mnt, extra))) throw new Error(`dmg 内缺少 ${extra}`);
    }
    console.log("  ✓ 镜像校验、签名、内置引擎与说明文件均通过");
  } finally {
    if (attached) {
      try {
        run("hdiutil", ["detach", "-force", mnt]);
      } catch (error) {
        console.warn(`  ! 卸载 ${mnt} 失败，请手动执行 hdiutil detach "${mnt}"`);
      }
    }
    fs.rmSync(mnt, { recursive: true, force: true });
  }
}

async function main() {
  preflight();
  generateIcon();
  buildEngine();
  const app = buildApp();
  await signApp(app);
  verifyEngine(app);
  gatekeeperReport(app);
  buildDmg(app);
  verifyDmg();
  console.log(`\n完成：${DMG_OUT}`);
  console.log("提示：本包为 ad-hoc 签名，未经 Apple 公证，首次打开需按说明放行一次。");
}

main().catch((error) => {
  console.error(`\n构建失败：${error.message}`);
  process.exit(1);
});
