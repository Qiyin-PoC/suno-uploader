const { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, nativeImage, session, safeStorage, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const mmkvLocator = require("./mmkv-locator");
const { installSunoDownload } = require("./suno-download");
const { SunoAccounts } = require("./suno-accounts");
const { CommercialClient } = require("./commercial-client");
const { pythonExecutable } = require("./runtime-paths");
const { ACTIVE_QUEUE_STATUSES, PersistentUploadBatchQueue, VALID_SPEEDS } = require("./upload-batch-queue");

const APP_DISPLAY_NAME = "期音科技";
const APP_VERSION_LABEL = "V5.0.0";
let commercialClient;
function getCommercialClient() {
  if (!commercialClient) {
    const config = require('../commercial-config.json');
    commercialClient = new CommercialClient({dataDir:app.getPath('userData'),
      baseUrl:(!app.isPackaged && process.env.QIYIN_LICENSE_URL) || config.apiOrigin,
      packaged:app.isPackaged, safeStorage});
  }
  return commercialClient;
}
// Only the trusted local main frame may invoke privileged desktop APIs.
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(channel, async (event, ...args) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('不可信的调用来源');
  }
  if (/^(unlocker|mmkv|selfcheck|separation|editor):/.test(channel)) return {ok:false, message:'当前版本仅提供 Suno 上传、下载及歌词功能'};
  try { return await handler(event, ...args); }
  catch (error) { writeLog(`操作失败: ${channel}`, 'warn'); return {ok:false, valid:false, message:'操作失败，请检查运行环境或稍后重试'}; }
});

app.setName(APP_DISPLAY_NAME);

// ===== Win10/Win11 兼容性：必须设置 AppUserModelId =====
// 未设置会导致 Win11 24H2+/Build 26200 上系统托盘图标不显示
// （任务栏"显示所有图标"开关关闭时直接看不见），同时影响任务栏分组。
// 必须在 ready 之前调用，且使用稳定 ID（不要用中文字符串）。
app.setAppUserModelId("com.qiyin.suno.uploader");

// ===== 閿欒鏃ュ織绯荤粺 =====
const logDir = path.join(app.getPath("userData"), "logs");
const logFile = path.join(logDir, "app.log");
function ensureLogDir() {
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
}
function writeLog(message, level = "info") {
  ensureLogDir();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, line, "utf8");
  } catch (_) {}
  // Limit log file size to 5 MB.
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > 5 * 1024 * 1024) {
      const backup = logFile + ".bak";
      try { fs.unlinkSync(backup); } catch (_) {}
      fs.renameSync(logFile, backup);
    }
  } catch (_) {}
}
// Global uncaught exception logging.
process.on("uncaughtException", (err) => {
  writeLog(`鏈崟鑾峰紓甯? ${err.stack || err.message}`, "error");
});
process.on("unhandledRejection", (reason) => {
  writeLog(`鏈鐞嗙殑 Promise 鎷掔粷: ${reason}`, "error");
});

// Startup logging.
writeLog(`应用启动 - ${APP_DISPLAY_NAME} ${APP_VERSION_LABEL}`);
writeLog(`Electron ${process.versions.electron}, Node ${process.versions.node}, platform ${process.platform} ${process.arch}`);
writeLog(`用户数据目录: ${app.getPath("userData")}`);

// ===== 单实例锁 =====
// 防止用户看不到托盘后重复点击 EXE 启动多个进程，
// 第二个进程启动时聚焦已有主窗口而不是再开一个。
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  // 已有实例在跑，直接退出本次启动
  writeLog("检测到已有实例运行，本次启动自动退出");
  app.quit();
}

let mainWindow = null;
let currentJob = null;
let uploadCancelFile = "";
let uploadStopRequested = false;
let uploadBatchQueue = null;
let uploadBatchAdvanceTimer = null;
// Deliberately session-only: a fresh manual Suno login can start two uploads
// without repeating the network preflight.  Restarting the app resets it.
let sunoOperation = false;
let sunoAccounts = null;
function getSunoAccounts() {
  if (!sunoAccounts) sunoAccounts = new SunoAccounts(app.getPath("userData"));
  return sunoAccounts;
}
function sunoEnv(id) { return getSunoAccounts().env(id || getSunoAccounts().selectedId, resolvedSunoWorkDir()); }
function emitSunoAccounts() { send("suno:accounts-event", getSunoAccounts().snapshot()); }
app.on("before-quit", () => { sunoAccounts?.stopPairing().catch(() => {}); });
let separationJob = null;
let separationCancelRequested = false;
let separationDownloadJob = null;
let gpuRuntimeDownloadJob = null;
let gpuRuntimeInstallCancelled = false;
let editorJob = null;
let editorPreviewJob = null;
const editorBpmCache = new Map();
let unlockerJob = null;
let unlockerLastFolder = "";
let unlockerLastOutputDir = "";
let editorExportDir = "";
let sunoWorkDir = "";
let unlockerLastMmkvPath = "";
let appTray = null;
let trayUsable = false; // ensureTray() 真正创建出可见托盘时为 true
let isQuitting = false;
// 默认改为 "exit"：Win11 24H2+ 托盘图标经常不可见（即使 new Tray() 不抛错），
// 默认 minimize 会让用户"按了关闭按钮就再也找不到窗口"。
// 想用托盘的用户可以从右上角"设置"按钮主动切到 "ask" 或 "minimize"。
let closeBehavior = "exit"; // ask | minimize | exit
let lastCloseChoice = null; // minimize | exit

// 鎸佷箙鍖栫洰褰曢€夋嫨鍋忓ソ
const dirPrefsFile = path.join(app.getPath("userData"), "dir_prefs.json");
const vaultDir = path.join(app.getPath("userData"), "vault");
const preflightFile = path.join(app.getPath("userData"), "mmkv_preflight.json");
function loadDirPrefs() {
  try {
    if (fs.existsSync(dirPrefsFile)) {
      let raw = fs.readFileSync(dirPrefsFile, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const prefs = JSON.parse(raw);
      if (prefs.unlockerFolder) unlockerLastFolder = prefs.unlockerFolder;
      if (prefs.unlockerOutputDir) unlockerLastOutputDir = prefs.unlockerOutputDir;
      if (prefs.unlockerMmkvPath) unlockerLastMmkvPath = prefs.unlockerMmkvPath;
      if (prefs.editorExportDir) editorExportDir = prefs.editorExportDir;
      if (prefs.sunoWorkDir) sunoWorkDir = prefs.sunoWorkDir;
    }
  } catch (_) {}
}
function saveDirPrefs() {
  try {
    let existing = {};
    if (fs.existsSync(dirPrefsFile)) {
      let raw = fs.readFileSync(dirPrefsFile, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      existing = JSON.parse(raw) || {};
    }
    fs.writeFileSync(dirPrefsFile, JSON.stringify({
      ...existing,
      unlockerFolder: unlockerLastFolder,
      unlockerOutputDir: unlockerLastOutputDir,
      unlockerMmkvPath: unlockerLastMmkvPath,
      editorExportDir,
      sunoWorkDir,
    }), "utf8");
  } catch (_) {}
}

function resolvedEditorExportDir() {
  return editorExportDir || path.join(app.getPath("userData"), "edits");
}

function resolvedSunoWorkDir() {
  return sunoWorkDir || path.join(app.getPath("userData"), "derived", "auto_recut_run");
}

// 关闭偏好持久化
const closePrefsFile = path.join(app.getPath("userData"), "close_preference.json");
function loadClosePrefs() {
  try {
    if (!fs.existsSync(closePrefsFile)) return;
    let raw = fs.readFileSync(closePrefsFile, "utf8");
    // 去掉 PowerShell Set-Content -Encoding UTF8 留下的 BOM，否则 JSON.parse 会失败
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    writeLog(`loadClosePrefs: raw=${JSON.stringify(raw)}`);
    const prefs = JSON.parse(raw);
    writeLog(`loadClosePrefs: parsed=${JSON.stringify(prefs)} trayUsable=${trayUsable}`);
    // Win11 24H2+ 上即使 new Tray() 成功，托盘图标也可能不可见。
    // 之前的版本默认 ask + 上次选 minimize 会让用户"按关闭就再也找不到窗口"。
    // 这里强制把 minimize 重置成 exit，保证用户点关闭按钮一定退出。
    if (prefs.lastChoice === "minimize" || prefs.behavior === "minimize") {
      writeLog("Win11 24H2+ 托盘不可靠，重置 minimize → exit");
      prefs.lastChoice = "exit";
      prefs.behavior = "exit";
      try { fs.writeFileSync(closePrefsFile, JSON.stringify(prefs, null, 2), "utf8"); } catch (e) { writeLog(`重置保存失败: ${e.message}`, "error"); }
    }
    // 托盘构造失败的兜底
    if (!trayUsable) {
      writeLog("托盘构造失败，重置为 exit");
      prefs.behavior = "exit";
      prefs.lastChoice = "exit";
    }
    if (prefs.behavior === "minimize" || prefs.behavior === "exit" || prefs.behavior === "ask") {
      closeBehavior = prefs.behavior;
    }
    if (prefs.lastChoice === "minimize" || prefs.lastChoice === "exit") {
      lastCloseChoice = prefs.lastChoice;
    }
    writeLog(`loadClosePrefs: end closeBehavior=${closeBehavior} lastCloseChoice=${lastCloseChoice}`);
  } catch (e) {
    writeLog(`loadClosePrefs 出错: ${e.message}`, "error");
  }
}
function saveClosePrefs() {
  try {
    fs.writeFileSync(closePrefsFile, JSON.stringify({
      behavior: closeBehavior,
      lastChoice: lastCloseChoice,
    }), "utf8");
  } catch (_) {}
}

// 关闭策略处理：决定窗口隐藏到托盘还是真正退出
async function handleCloseRequest(event) {
  if (isQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Win11 24H2+ 托盘图标经常不可见（即使 new Tray() 成功也不显示）。
  // 一旦走 minimize，用户就再也找不到窗口。所以 Win11 + 默认 minimize 直接走 exit。
  if (!trayUsable || (process.platform === "win32" && closeBehavior === "minimize" && !isTrayReallyVisible())) {
    writeLog("托盘不可靠或 Win11 上 minimize 强制走 exit");
    lastCloseChoice = "exit";
    saveClosePrefs();
    isQuitting = true;
    if (appTray) {
      try { appTray.destroy(); } catch (_) {}
      appTray = null;
    }
    if (event) event.preventDefault();
    app.quit();
    return;
  }

  // 兼容旧逻辑：托盘构造失败的兜底
  if (!trayUsable) {
    writeLog("托盘不可用，关闭按钮按直接退出处理");
    lastCloseChoice = "exit";
    saveClosePrefs();
    isQuitting = true;
    if (appTray) {
      try { appTray.destroy(); } catch (_) {}
      appTray = null;
    }
    if (event) event.preventDefault();
    app.quit();
    return;
  }

  let action = closeBehavior;
  if (action === "ask") {
    if (lastCloseChoice) {
      action = lastCloseChoice;
    } else {
      action = await askCloseBehavior();
    }
  }

  if (action === "minimize") {
    if (event) event.preventDefault();
    ensureTray();
    if (mainWindow.isVisible()) mainWindow.hide();
    lastCloseChoice = "minimize";
    saveClosePrefs();
    return;
  }

  if (action === "exit") {
    lastCloseChoice = "exit";
    saveClosePrefs();
    isQuitting = true;
    if (appTray) {
      try { appTray.destroy(); } catch (_) {}
      appTray = null;
    }
    if (event) event.preventDefault();
    app.quit();
    return;
  }

  // 兜底：默认直接退出
  isQuitting = true;
  if (event) event.preventDefault();
  app.quit();
}

// 简单判断托盘是否真的可见：Win11 24H2+ 上这个判断不靠谱，
// 所以现在 handleCloseRequest 直接对 minimize 强制走 exit，不依赖这个函数。
// 保留它只是为了向后兼容。
function isTrayReallyVisible() {
  return trayUsable;
}

async function askCloseBehavior() {
  // 加 30s 超时：若用户没及时响应，按"直接退出"处理，避免窗口被"隐藏到无托盘状态"
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 30000));
  const dialogPromise = dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["最小化到托盘", "直接退出"],
    defaultId: lastCloseChoice === "minimize" ? 0 : 1,
    cancelId: lastCloseChoice === "minimize" ? 0 : 1,
    title: "关闭软件",
    message: "您希望如何关闭软件？",
    detail: "选择后，软件会记住您的选择。下次关闭时自动按同样方式处理。您也可以在右上角「设置」中修改。",
    noLink: true
  }).then((r) => ({ response: r.response }));
  const result = await Promise.race([dialogPromise, timeoutPromise]);
  if (result && result.__timeout) {
    writeLog("关闭对话框超时，按直接退出处理", "warn");
    return "exit";
  }
  if (result.response === 0) return "minimize";
  return "exit";
}

function ensureTray() {
  if (appTray) return;
  try {
    // 托盘图标优先级：logo.png > logo-source.png > sidebar-cat.png
    // 即使第一次没复制 logo.png 也能找到备选
    const assetsDir = path.join(projectRoot(), "assets");
    const candidates = ["logo.png", "logo-source.png", "sidebar-cat.png"];
    let image = nativeImage.createEmpty();
    let usedIcon = "";
    for (const name of candidates) {
      const p = path.join(assetsDir, name);
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          image = img;
          usedIcon = name;
          break;
        }
      }
    }
    // Windows 托盘推荐 16x16 或 32x32；logo.png 是 2184x2248 太大，
    // 缩放成 32x32 让 Windows 渲染时清晰
    if (process.platform === "win32" && !image.isEmpty()) {
      const small = image.resize({ width: 32, height: 32, quality: "best" });
      if (!small.isEmpty()) image = small;
    }
    appTray = new Tray(image);
    const contextMenu = Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showMainWindowFromTray() },
      { label: "隐藏主窗口", click: () => { if (mainWindow && mainWindow.isVisible()) mainWindow.hide(); } },
      { type: "separator" },
      { label: `关于 ${APP_DISPLAY_NAME}`, click: () => showAboutFromTray() },
      { type: "separator" },
      { label: "彻底退出", click: () => quitApp() }
    ]);
    appTray.setToolTip(`${APP_DISPLAY_NAME} · Suno歌曲上传器`);
    appTray.setContextMenu(contextMenu);
    appTray.on("double-click", () => showMainWindowFromTray());
    appTray.on("click", () => showMainWindowFromTray());
    trayUsable = true;
    writeLog(`系统托盘已创建（图标: ${usedIcon}）`);
  } catch (error) {
    writeLog(`托盘初始化失败：${error.message}`, "warn");
    appTray = null;
    trayUsable = false;
  }
}

function showAboutFromTray() {
  // 复用 IPC 的 app:showAbout 处理（先显示主窗口再触发）
  showMainWindowFromTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:show-about");
  }
}

function showMainWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function setCloseBehaviorAndQuit(behavior) {
  closeBehavior = behavior;
  lastCloseChoice = behavior;
  saveClosePrefs();
  quitApp();
}

function quitApp() {
  isQuitting = true;
  if (appTray) {
    try { appTray.destroy(); } catch (_) {}
    appTray = null;
  }
  app.quit();
}

function projectRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");
}

function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  return `${process.platform}-${arch}`;
}

function executableName(baseName) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function vendorExecutable(toolName, baseName, options = {}) {
  const root = projectRoot();
  const exe = executableName(baseName);
  const names = [exe, baseName, `${baseName}.exe`];
  const envPath = options.envPath ? String(process.env[options.envPath] || "").trim() : "";
  const envVendor = options.envVendor ? String(process.env[options.envVendor] || "").trim() : "";
  const roots = [
    envVendor,
    path.join(root, "vendor", toolName),
    path.join(__dirname, "..", "..", "vendor", toolName),
  ].filter(Boolean);

  if (envPath && fs.existsSync(envPath)) return envPath;

  for (const base of roots) {
    for (const name of names) {
      const candidates = [
        path.join(base, platformKey(), name),
        path.join(base, name),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function backendExecutable() {
  const root = projectRoot();
  if (app.isPackaged) {
    const candidate = path.join(root, "backend", "backend.exe");
    if (fs.existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }
  const command = pythonExecutable(root, {packaged:app.isPackaged});
  return {
    command,
    prefixArgs: [path.join(root, "backend", "backend.py")]
  };
}

function pythonScriptExecutable(scriptName) {
  const root = projectRoot();
  // 用内置 python-embed 跑 backend/*.py（便于支持"原始源 m4a"等新格式，依赖已内置）
  const command = pythonExecutable(root, {packaged:app.isPackaged});
  return { command, prefixArgs: [path.join(root, "backend", scriptName + ".py")] };
}

function backendEnv(extra = {}) {
  const root = projectRoot();
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    GAOBAI_APP_DATA: app.getPath("userData"),
    GAOBAI_PROJECT_ROOT: root,
    GAOBAI_FFMPEG_VENDOR: path.join(root, "vendor", "ffmpeg"),
    GAOBAI_UVR_MODEL_DIR: path.join(root, "vendor", "uvr", "models", "VRArch_models"),
    ...sunoEnv(),
    ...extra
  };
}

function ffmpegExecutable() {
  return vendorExecutable("ffmpeg", "ffmpeg", {
    envPath: "GAOBAI_FFMPEG_EXE",
    envVendor: "GAOBAI_FFMPEG_VENDOR",
  }) || "ffmpeg";
}

// unlock-music CLI (vendor/um/um.exe).
function umExecutable() {
  return vendorExecutable("um", "um", {
    envPath: "GAOBAI_UM_EXE",
    envVendor: "GAOBAI_UM_VENDOR",
  });
}

function fridaServerExecutable() {
  return vendorExecutable("frida", "frida-server", {
    envPath: "GAOBAI_FRIDA_SERVER",
    envVendor: "GAOBAI_FRIDA_VENDOR",
  });
}

function qmcWasmBundlePath() {
  const root = projectRoot();
  const candidates = [
    path.join(root, "vendor", "qmcwasm", "QmcWasmBundle.js"),
    path.join(__dirname, "..", "..", "vendor", "qmcwasm", "QmcWasmBundle.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function looksLikeAudio(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf.slice(0, 4).toString("ascii") === "OggS") return true;
  if (buf.slice(0, 4).toString("ascii") === "fLaC") return true;
  if (buf.slice(0, 3).toString("ascii") === "ID3") return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  if (buf.slice(0, 4).toString("ascii") === "RIFF") return true;
  return false;
}

function readUtf16LeAsciiTag(buffer, offset, maxBytes) {
  const bytes = [];
  for (let i = 0; i < maxBytes; i += 2) {
    const value = buffer[offset + i];
    if (!value) break;
    bytes.push(value);
  }
  return Buffer.from(bytes).toString("utf8");
}

function readMusicExInfo(inputFile) {
  try {
    const fd = fs.openSync(inputFile, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < 208) return null;
      const tail = Buffer.alloc(16);
      fs.readSync(fd, tail, 0, 16, stat.size - 16);
      if (tail.slice(8, 16).toString("ascii") !== "musicex\u0000") return null;
      const tagSize = tail.readUInt32LE(0);
      const tagVersion = tail.readUInt32LE(4);
      if (tagVersion !== 1 || tagSize < 0xc0 || stat.size < tagSize + 16) return { tagSize, tagVersion };
      const body = Buffer.alloc(tagSize);
      fs.readSync(fd, body, 0, tagSize, stat.size - tagSize - 16);
      return {
        tagSize,
        tagVersion,
        songId: body.readUInt32LE(0),
        mediaId: readUtf16LeAsciiTag(body, 0x0c, 30 * 2),
        mediaFileName: readUtf16LeAsciiTag(body, 0x48, 50 * 2),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
}

const QMC_WASM_OUTPUT_EXT = {
  ".mgg": ".ogg", ".mgg0": ".ogg", ".mgg1": ".ogg", ".mggl": ".ogg",
  ".mflac": ".flac", ".mflac0": ".flac", ".mflac1": ".flac", ".mflach": ".flac",
  ".qmcflac": ".flac", ".qmcogg": ".ogg",
  ".qmc0": ".mp3", ".qmc3": ".mp3", ".qmc2": ".ogg", ".qmc4": ".ogg", ".qmc6": ".ogg", ".qmc8": ".ogg",
};

async function decryptQmcWithWasm(inputFile) {
  const ext = path.extname(inputFile).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(QMC_WASM_OUTPUT_EXT, ext)) return null;
  const bundlePath = qmcWasmBundlePath();
  if (!bundlePath) {
    writeLog("qmcwasm: 未找到 vendor/qmcwasm/QmcWasmBundle.js,跳过");
    return null;
  }

  // WASM bundle 完整性检查(可能被杀毒破坏)
  try {
    const stat = fs.statSync(bundlePath);
    if (stat.size < 1024) {
      writeLog(`qmcwasm: bundle 文件大小异常 (${stat.size} bytes),可能已损坏`, "warn");
      return null;
    }
  } catch (e) {
    writeLog(`qmcwasm: 检查 bundle 文件失败: ${e.message}`, "warn");
    return null;
  }

  // Node 版本检查
  try {
    const nodeMajor = Number((process.versions.node || "0").split(".")[0]);
    if (nodeMajor < 16 || nodeMajor > 22) {
      writeLog(`qmcwasm: Node 版本 ${process.versions.node} 不在 16-22 范围内,跳过`, "warn");
      return null;
    }
  } catch (_) {}

  try {
    const QmcCryptoModule = require(bundlePath);
    const qmc = await QmcCryptoModule();
    const qmcBuf = fs.readFileSync(inputFile);
    const blockLimit = 2 * 1024 * 1024;
    const p = qmc._malloc(blockLimit);
    try {
      const preSize = Math.min(blockLimit, qmcBuf.length);
      qmc.writeArrayToMemory(qmcBuf.slice(-preSize), p);
      const tailSize = qmc.preDec(p, preSize, ext);
      if (tailSize < 0) throw new Error(qmc.getErr ? qmc.getErr() : "QMC WASM 预解密失败");

      const parts = [];
      let offset = 0;
      let remaining = qmcBuf.length - tailSize;
      while (remaining > 0) {
        const blockSize = Math.min(blockLimit, remaining);
        qmc.writeArrayToMemory(qmcBuf.slice(offset, offset + blockSize), p);
        const written = qmc.decBlob(p, blockSize, offset);
        parts.push(Buffer.from(qmc.HEAPU8.slice(p, p + written)));
        offset += blockSize;
        remaining -= blockSize;
      }
      const data = Buffer.concat(parts);
      return { data, ext: QMC_WASM_OUTPUT_EXT[ext] || ".bin" };
    } finally {
      qmc._free(p);
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    writeLog(`qmcwasm: 解码失败 ${msg}`, "warn");
    return { error: msg };
  }
}

function safeNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

const UNLOCKER_TARGET_FORMATS = new Set(["original", "mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"]);
const OPEN_AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".alac", ".ape", ".wma", ".dff", ".mp4"]);

function isOpenAudioFile(filePath) {
  return OPEN_AUDIO_EXTS.has(path.extname(String(filePath || "")).toLowerCase());
}

function normalizeUnlockerTargetFormat(format) {
  const next = String(format || "mp3").trim().toLowerCase();
  return UNLOCKER_TARGET_FORMATS.has(next) ? next : "mp3";
}

function uniqueOutputPath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const parsed = path.parse(targetPath);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}_${Date.now()}${parsed.ext}`);
}

function ffmpegAudioArgs(format, quality) {
  switch (format) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", String(Math.max(0, Math.min(9, Math.round(quality))))];
    case "wav":
      return ["-c:a", "pcm_s16le", "-ar", "44100"];
    case "flac":
      return ["-c:a", "flac"];
    case "ogg":
      return ["-c:a", "libvorbis", "-q:a", "5"];
    case "m4a":
    case "aac":
      return ["-c:a", "aac", "-b:a", "192k"];
    case "opus":
      return ["-c:a", "libopus", "-b:a", "160k"];
    default:
      return [];
  }
}

function transcodeUnlockedAudio(srcPath, sourceFile, outputDir, targetFormat, quality, sendLog) {
  const format = normalizeUnlockerTargetFormat(targetFormat);
  if (format === "original") return Promise.resolve(srcPath);

  const srcExt = path.extname(srcPath).replace(/^\./, "").toLowerCase();
  if (srcExt === format) return Promise.resolve(srcPath);

  const baseName = path.basename(sourceFile, path.extname(sourceFile));
  const finalPath = uniqueOutputPath(path.join(outputDir, `${baseName}.${format}`));
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", srcPath,
    ...ffmpegAudioArgs(format, quality),
    "-map_metadata", "0",
    finalPath
  ];

  if (typeof sendLog === "function") {
    sendLog(`[ffmpeg] ${path.basename(srcPath)} -> ${path.basename(finalPath)}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, {
      cwd: projectRoot(),
      env: backendEnv(),
      windowsHide: true,
    });
    let stderr = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => { stderr += text; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(finalPath)) {
        reject(new Error((stderr || "").trim() || `ffmpeg exited ${code}`));
        return;
      }
      try {
        if (path.resolve(srcPath) !== path.resolve(finalPath) && path.dirname(srcPath) === outputDir) {
          fs.unlinkSync(srcPath);
        }
      } catch (_) {}
      resolve(finalPath);
    });
  });
}

function createWindow() {
  const {width, height} = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(818, height),
    minWidth: Math.min(1020, width),
    minHeight: Math.min(680, height),
    resizable: true,
    frame: false,
    backgroundColor: "#f7fbff",
    title: "期音科技 · Suno歌曲上传器",
    icon: path.join(projectRoot(), "assets", "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    handleCloseRequest(event);
  });
  mainWindow.on("closed", () => {
    if (currentJob) {
      try { currentJob.kill(); } catch (_) {}
      currentJob = null;
    }
    if (separationJob) {
      try { separationJob.kill(); } catch (_) {}
      separationJob = null;
    }
    if (editorJob) {
      try { editorJob.kill(); } catch (_) {}
      editorJob = null;
    }
    if (unlockerJob) {
      try { unlockerJob.kill(); } catch (_) {}
      unlockerJob = null;
    }
    if (appTray) {
      try { appTray.destroy(); } catch (_) {}
      appTray = null;
      trayUsable = false;
    }
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sanitizeBackendEvent(event) {
  if (!event || typeof event !== "object") return event;
  const message = String(event.message || "");
  if (event.type !== "log" && event.type !== "status") return event;
  if (/\[login\].*(暂未拿到|href=|__clerk_handshake|meta=|runtime probe|cdp-network|token=|cookies=)/i.test(message)) {
    return { ...event, type: "log", message: "暂未获取到登录的Suno，正在获取中....." };
  }
  if (/\[login\].*(捕获到|token 校验结果|token_valid|status=200|已获取Suno登录信息|已登录)/i.test(message)) {
    return { ...event, type: "log", message: "已获取Suno登录信息，已登录！" };
  }
  return event;
}

function runBackend(args, options = {}) {
  const spec = backendExecutable();
  const child = spawn(spec.command, [...spec.prefixArgs, ...args], {
    cwd: projectRoot(),
    env: backendEnv(options.env || {}),
    windowsHide: true
  });

  let buffer = "";
  const emitText = (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      writeLog(`[backend] ${sanitizeBackendEvent({ type: "log", message: line }).message || line}`);
      try {
        const event = sanitizeBackendEvent(JSON.parse(line));
        if (event && event.type === "failed") child._backendFailed = true;
        if (event && event.type === "auth_required") child._backendAuthRequired = event;
        if (typeof options.onEvent === "function") {
          try { options.onEvent(event, child); } catch (_) {}
        }
        if (options.eventChannel) send(options.eventChannel, event);
      } catch (_) {
        const event = sanitizeBackendEvent({ type: "log", message: line });
        if (options.eventChannel) send(options.eventChannel, event);
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", emitText);
  child.stderr.on("data", (text) => {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim() && options.eventChannel) {
        send(options.eventChannel, sanitizeBackendEvent({ type: "log", level: "warn", message: line }));
      }
    }
  });

  child.on("error", (error) => {
    writeLog(`后端进程启动失败: ${error.message}`, "error");
    if (options.eventChannel) send(options.eventChannel, { type: "log", level: "error", message: `进程启动失败: ${error.message}` });
  });

  return child;
}

function runBackendJson(args, options = {}) {
  return new Promise((resolve, reject) => {
    const spec = backendExecutable();
    const child = spawn(spec.command, [...spec.prefixArgs, ...args], {
      cwd: projectRoot(),
      env: backendEnv(options.env || {}),
      windowsHide: true
    });
    if (options.input !== undefined) child.stdin.end(JSON.stringify(options.input));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => { stdout += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `backend exited ${code}`));
        return;
      }
      const lines = stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || "{}";
      try {
        resolve(JSON.parse(last));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function requireActiveLicense(featureCode) {
  const result = await getCommercialClient().authorize(featureCode);
  send('commercial:event', result);
  return result;
}

async function prepareSunoTokenForUpload(skipNetworkPreflight, accountId) {
  const env = sunoEnv(accountId);
  const localArgs = skipNetworkPreflight ? ["--check-login-token-local"] : ["--check-login-token"];
  try {
    const initial = await runBackendJson(localArgs, { env });
    if (initial && initial.loggedIn) return { ok: true, skipNetworkPreflight };
  } catch (error) {
    writeLog(`Suno 登录预检异常: ${error.message}`, "warn");
  }

  // A saved token may be stale or absent while the dedicated Suno browser is
  // still signed in.  Recover silently before asking the user to log in again.
  try {
    const recovered = await runBackendJson(["--recover-suno-token", "--token-recovery-attempts", "4"], { env });
    if (recovered && recovered.loggedIn) return { ok: true, recovered: true, skipNetworkPreflight: false };
    return { ok: false, reason: recovered && recovered.reason ? recovered.reason : "未获取到有效 Suno Token" };
  } catch (error) {
    return { ok: false, reason: error.message || "Suno Token 校验失败" };
  }
}

function buildChineseMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: `关于 ${APP_DISPLAY_NAME}`, role: "about" },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => { isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做", accelerator: "Shift+CmdOrCtrl+Z", role: "redo" },
        { type: "separator" },
        { label: "剪切", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "全选", accelerator: "CmdOrCtrl+A", role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "强制重新加载", accelerator: "Shift+CmdOrCtrl+R", role: "forceReload" },
        { label: "开发者工具", accelerator: "F12", role: "toggleDevTools" },
        { type: "separator" },
        { label: "放大", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
        { label: "缩小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { label: "重置缩放", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { type: "separator" },
        { label: "全屏", accelerator: "F11", role: "togglefullscreen" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: APP_DISPLAY_NAME,
              detail: `版本 ${APP_VERSION_LABEL}\n期音科技\n\n基于 Electron + Python，支持音频剪辑、伴奏/人声分离、音频解锁和 Suno 上传。`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
app.whenReady().then(() => {
  // 仅在拿到单实例锁的情况下初始化窗口/托盘
  if (!singleInstanceLock) {
    writeLog("未持有单实例锁，跳过窗口初始化");
    return;
  }
  loadDirPrefs();
  createWindow();
  // 软件启动后立即在系统托盘显示图标（不只有关闭时才出现）
  ensureTray();
  buildChineseMenu();
  loadClosePrefs();
  // 内部使用版：不初始化官网账号会话，不做账号自动登录/权益同步
  app.on("second-instance", () => {
    writeLog("检测到第二次启动，聚焦已有主窗口");
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      ensureTray();
    }
  });

  app.on("acti" + "vate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });


});

app.on("window-all-closed", () => {
  writeLog("所有窗口已关闭，应用退出");
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  pauseUploadBatchForShutdown();
  // Closing the app only marks this device offline after the server timeout.
  // Explicit account logout is the only action that unbinds the device.

});

installSunoDownload({
  app, ipcMain, dialog, shell,
  getWindow: () => mainWindow,
  executable: () => pythonScriptExecutable("suno_download_cli"),
  ffmpeg: ffmpegExecutable,
  env: backendEnv,
  authorize: () => requireActiveLicense("suno_download", "歌曲下载"),
});

ipcMain.handle("audio:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要上传的音频",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "m4a", "flac", "aac", "ogg", "oga", "opus", "ape", "wma"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("audio:pick-multiple", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要排队上传的歌曲",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "m4a", "flac", "aac", "ogg", "oga", "opus", "ape", "wma"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("audio:read-file", async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.promises.readFile(filePath);
});

ipcMain.handle("file:exists", async (_event, filePath) => {
  if (!filePath) return false;
  try {
    return fs.statSync(String(filePath)).isFile();
  } catch (_) {
    return false;
  }
});

ipcMain.handle("file:url", async (_event, filePath) => {
  if (!filePath) return "";
  return pathToFileURL(filePath).toString();
});

ipcMain.handle("soundtouch:processor-url", async () => {
  const processorPath = path.join(projectRoot(), "vendor", "soundtouchjs", "soundtouch-processor.js");
  if (!fs.existsSync(processorPath)) return "";
  return pathToFileURL(processorPath).toString();
});

ipcMain.handle("soundtouch:module-url", async () => {
  const modulePath = path.join(projectRoot(), "vendor", "soundtouchjs", "SoundTouchNode.js");
  if (!fs.existsSync(modulePath)) return "";
  return pathToFileURL(modulePath).toString();
});

ipcMain.handle("soundtouch:processor-source", async () => {
  const processorPath = path.join(projectRoot(), "vendor", "soundtouchjs", "soundtouch-processor.js");
  if (!fs.existsSync(processorPath)) return "";
  return fs.promises.readFile(processorPath, "utf8");
});

ipcMain.handle("file:save-copy", async (_event, payload = {}) => {
  const sourcePath = payload.sourcePath || "";
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, message: "源文件不存在" };
  }
  const defaultName = payload.defaultName || path.basename(sourcePath);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出音频文件",
    defaultPath: defaultName,
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  await fs.promises.copyFile(sourcePath, result.filePath);
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle("workspace:get-paths", async () => {
  const paths = {
    editorExportDir: resolvedEditorExportDir(),
    sunoWorkDir: resolvedSunoWorkDir(),
  };
  for (const target of Object.values(paths)) {
    try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  }
  return { ok: true, ...paths };
});

ipcMain.handle("workspace:pick-path", async (_event, payload = {}) => {
  const kind = payload.kind === "suno" ? "suno" : "editor";
  const current = kind === "suno" ? resolvedSunoWorkDir() : resolvedEditorExportDir();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === "suno" ? "选择 Suno 切片保存目录" : "选择可视化音频导出目录",
    defaultPath: current,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  const selected = path.resolve(result.filePaths[0]);
  fs.mkdirSync(selected, { recursive: true });
  if (kind === "suno") sunoWorkDir = selected;
  else editorExportDir = selected;
  saveDirPrefs();
  return {
    ok: true,
    editorExportDir: resolvedEditorExportDir(),
    sunoWorkDir: resolvedSunoWorkDir(),
  };
});

ipcMain.handle("window:minimize", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { ok: true };
});

ipcMain.handle("window:maximize", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle("window:close", async () => {
  await handleCloseRequest();
  return { ok: true, behavior: closeBehavior, lastChoice: lastCloseChoice };
});

// 防御性 IPC：renderer 可以直接要求主进程强制退出。
// 用于一些异常路径（比如 close handler 没走通），让前端有一个"彻底退出"的最终逃生通道。
ipcMain.handle("app:force-quit", async () => {
  writeLog("renderer 请求 force-quit", "warn");
  isQuitting = true;
  if (appTray) {
    try { appTray.destroy(); } catch (_) {}
    appTray = null;
  }
  // 杀光所有子进程（backend / uvr / audio_editor / unlocker）
  for (const [name, job] of [
    ["currentJob", currentJob],
    ["separationJob", separationJob],
    ["editorJob", editorJob],
    ["editorPreviewJob", editorPreviewJob],
    ["unlockerJob", unlockerJob],
  ]) {
    if (job) {
      try { job.kill(); } catch (_) {}
    }
  }
  app.quit();
  return { ok: true };
});

ipcMain.handle("prefs:get-close", async () => ({
  behavior: closeBehavior,
  lastChoice: lastCloseChoice
}));

ipcMain.handle("prefs:set-close", async (_event, payload = {}) => {
  const behavior = payload && payload.behavior;
  const lastChoice = payload && payload.lastChoice;
  if (behavior === "ask" || behavior === "minimize" || behavior === "exit") {
    closeBehavior = behavior;
  }
  if (lastChoice === "minimize" || lastChoice === "exit") {
    lastCloseChoice = lastChoice;
  } else if (behavior === "minimize" || behavior === "exit") {
    lastCloseChoice = behavior;
  }
  saveClosePrefs();
  return { ok: true, behavior: closeBehavior, lastChoice: lastCloseChoice };
});

ipcMain.handle("app:showAbout", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "关于",
    message: APP_DISPLAY_NAME,
    detail: `版本 ${APP_VERSION_LABEL}\n发布日期：2026-09-06\n期音科技\n\n基于 Electron + Python\n支持音频剪辑、升降调、变速不变调、伴奏/人声分离、开放音频格式转换、一键上传 Suno`
  });
  return { ok: true };
});

ipcMain.handle("app:showSettings", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const buttons = ["每次询问", "最小化到托盘", "直接退出"];
  const labels = ["ask", "minimize", "exit"];
  const currentIdx = labels.indexOf(closeBehavior);
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons,
    defaultId: currentIdx >= 0 ? currentIdx : 0,
    cancelId: 2,
    title: "软件设置",
    message: "关闭按钮行为",
    detail: `当前：${closeBehavior === "ask" ? "每次询问" : closeBehavior === "minimize" ? "最小化到托盘" : "直接退出"}\n\n点击「每次询问」会在每次关闭时弹窗。\n点击「最小化到托盘」会隐藏到右下角托盘图标，点击托盘恢复。\n点击「直接退出」会彻底退出软件。`,
    noLink: true
  });
  if (result.response >= 0 && result.response < labels.length) {
    closeBehavior = labels[result.response];
    if (closeBehavior !== "ask") {
      lastCloseChoice = closeBehavior;
    }
    saveClosePrefs();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("prefs:close-updated", { behavior: closeBehavior, lastChoice: lastCloseChoice });
    }
    return { ok: true, behavior: closeBehavior, lastChoice: lastCloseChoice };
  }
  return { ok: false };
});

ipcMain.handle("suno:accounts", () => ({ok:true, ...getSunoAccounts().snapshot()}));
ipcMain.handle("suno:select-account", async (_event, id) => {
  if (currentJob || sunoOperation || isUploadBatchActive()) return {ok:false,message:"请等待当前任务结束或暂停队列后再切换账号。"};
  await getSunoAccounts().stopPairing();
  try { const state=getSunoAccounts().select(id); emitSunoAccounts(); return {ok:true,...state}; }
  catch(error) {return {ok:false,message:error.message};}
});
ipcMain.handle("suno:extension-start", async () => {
  if (currentJob || sunoOperation || isUploadBatchActive()) return {ok:false,message:"请先停止当前任务。"};
  const accounts=getSunoAccounts();
  return accounts.startPairing(accounts.selectedId, async (id,payload) => {
    if (currentJob || sunoOperation || isUploadBatchActive()) return {ok:false};
    sunoOperation=true;
    const env=sunoEnv(id);
    const temporary=`${env.GAOBAI_SUNO_TOKEN_FILE}.pair-${crypto.randomUUID()}`;
    try {
      const result=await runBackendJson(["--import-suno-token"],{
        env:{...env,GAOBAI_SUNO_TOKEN_FILE:temporary},input:payload,
      });
      if (result.ok) {
        if (accounts.pairing?.id !== id || !accounts.pairing.secret) return {ok:false};
        fs.renameSync(temporary,env.GAOBAI_SUNO_TOKEN_FILE);
        emitSunoAccounts();
        send("suno:accounts-event",{...accounts.snapshot(),connectedId:id});
      }
      return result;
    } finally {try {fs.unlinkSync(temporary);} catch {} sunoOperation=false;}
  });
});
ipcMain.handle("suno:extension-cancel", async () => { await getSunoAccounts().stopPairing(); return {ok:true}; });
ipcMain.handle("suno:extension-folder", async () => {
  const folder=app.isPackaged ? path.join(process.resourcesPath,"suno-login-extension") : path.join(projectRoot(),"suno-login-extension");
  const error=await shell.openPath(folder);
  return {ok:!error,message:error};
});
ipcMain.handle("app:login", async () => {
  if (currentJob || sunoOperation || isUploadBatchActive()) return {ok:false,message:"已有任务正在运行，请暂停队列后登录。"};
  sunoOperation=true;
  const id=getSunoAccounts().selectedId;
  try {
    await getSunoAccounts().stopPairing();
    const loginJob=runBackend(["--login-only"],{eventChannel:"backend:event",env:sunoEnv(id),
      onEvent:event=>{ if(event) event.loginPhase=true; if(event?.type==="result" && event.loginOk) emitSunoAccounts(); }});
    currentJob=loginJob;
    loginJob.on("close",()=>{if(currentJob===loginJob)currentJob=null;emitSunoAccounts();send("backend:event",{type:"idle"});});
    return {ok:true,accountId:id};
  } finally {sunoOperation=false;}
});
ipcMain.handle("app:logout", async () => {
  if (currentJob || sunoOperation || isUploadBatchActive()) return {ok:false,message:"请等待当前任务结束或暂停队列后退出账号。"};
  sunoOperation=true;
  const id=getSunoAccounts().selectedId;
  try {
    await getSunoAccounts().stopPairing();
    const result=await runBackendJson(["--logout-suno"],{env:sunoEnv(id)});
    emitSunoAccounts();
    return result;
  } catch(error) {return {ok:false,message:"退出清理未完成，请关闭该账号的登录浏览器后重试。"};}
  finally {sunoOperation=false;}
});

ipcMain.handle("app:check-login-status", async () => {
  const accountId=getSunoAccounts().selectedId;
  try {
    const result = await runBackendJson(["--check-login-token"],{env:sunoEnv(accountId)});
    if (result && result.loggedIn) {
      writeLog(`检测到有效的 Suno 登录令牌，source=${result.tokenSource || "unknown"}`);
      return { accountId, loggedIn: true, tokenSource: result.tokenSource || "已保存", tokenCheck: result.tokenCheck || null };
    }
    writeLog(`Suno 登录令牌不可用：${result && result.reason ? result.reason : "unknown"}`, "warn");
    return { accountId, loggedIn: false, reason: result && result.reason ? result.reason : "token_invalid", tokenCheck: result && result.tokenCheck ? result.tokenCheck : null };
  } catch (error) {
    writeLog(`检查登录状态失败: ${error.message}`, "error");
    return { accountId, loggedIn: false, reason: error.message || "check_failed" };
  }
});

async function unlockerGetPrefs() {
  let mmkvPath = unlockerLastMmkvPath || "";
  // 兜底:如果用户没手动设置 MMKV 路径,但 vault 有链接,自动用链接
  if (!mmkvPath) {
    try {
      const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
      if (ext.currentLink && ext.currentLink.linkPath && fs.existsSync(ext.currentLink.linkPath)) {
        mmkvPath = ext.currentLink.linkPath;
      }
    } catch (_) {}
  }
  return {
    outputDir: unlockerLastOutputDir || "",
    mmkvPath,
  };
}
ipcMain.handle("unlocker:get-prefs", unlockerGetPrefs);

// ── MMKV 智能定位 IPC ──
ipcMain.handle("mmkv:locate", async (_event, payload) => {
  try {
    const force = !!(payload && payload.forceRescan);
    const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
    // 5 分钟内不重复扫描
    if (!force && ext.lastScanAt && Date.now() - ext.lastScanAt < 300000) {
      return { ok: true, candidates: ext.lastScanResults };
    }
    const candidates = await mmkvLocator.locateMmkvCandidates();
    mmkvLocator.saveDirPrefsExtended(dirPrefsFile, {
      lastScanAt: Date.now(),
      lastScanResults: candidates,
    });
    writeLog(`mmkv:locate 完成, 找到 ${candidates.length} 个候选`);
    return { ok: true, candidates };
  } catch (e) {
    writeLog("mmkv:locate 失败: " + e.message, "error");
    return { ok: false, error: e.message, candidates: [] };
  }
});

ipcMain.handle("mmkv:link", async (_event, payload) => {
  try {
    const originalPath = payload && payload.originalPath;
    if (!originalPath) return { ok: false, error: "originalPath 不能为空" };
    if (!fs.existsSync(originalPath)) return { ok: false, error: "原文件不存在: " + originalPath };

    const r = mmkvLocator.createMmkvSymlink(originalPath, vaultDir);
    mmkvLocator.saveDirPrefsExtended(dirPrefsFile, {
      vaultDir,
      currentLink: {
        linkPath: r.linkPath,
        originalPath,
        createdAt: Date.now(),
        source: "user",
        method: r.method,
      },
      onboardingShown: true,
      onboardingChoice: "linked",
    });
    // 同步到主进程的 unlockerLastMmkvPath
    unlockerLastMmkvPath = r.linkPath;
    saveDirPrefs();
    writeLog(`MMKV 链接成功: ${originalPath} -> ${r.linkPath} (${r.method})`);
    return { ok: true, linkPath: r.linkPath, method: r.method };
  } catch (e) {
    writeLog("mmkv:link 失败: " + e.message, "error");
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("mmkv:list", async () => {
  const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
  return { ok: true, items: ext.currentLink ? [ext.currentLink] : [] };
});

ipcMain.handle("mmkv:status", async () => {
  const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
  const preflight = mmkvLocator.loadPreflight(preflightFile);
  // 检查当前链接是否还活着
  let linked = false;
  if (ext.currentLink && ext.currentLink.linkPath) {
    try {
      linked = fs.existsSync(ext.currentLink.linkPath);
    } catch (_) {
      linked = false;
    }
  }
  return {
    ok: true,
    linked,
    linkPath: ext.currentLink ? ext.currentLink.linkPath : "",
    originalPath: ext.currentLink ? ext.currentLink.originalPath : "",
    vaultDir: ext.vaultDir || vaultDir,
    preflightResult: preflight,
    onboardingShown: ext.onboardingShown,
    onboardingChoice: ext.onboardingChoice,
    failurePromptDismissedAt: ext.failurePromptDismissedAt,
  };
});

ipcMain.handle("mmkv:unlink", async () => {
  try {
    const ok = mmkvLocator.removeMmkvSymlink(vaultDir);
    mmkvLocator.saveDirPrefsExtended(dirPrefsFile, {
      currentLink: null,
    });
    unlockerLastMmkvPath = "";
    saveDirPrefs();
    writeLog("MMKV 链接已移除");
    return { ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 渲染层标记 onboarding 已显示 / 跳过 / 失败引导被关闭
ipcMain.handle("mmkv:set-onboarding-state", async (_event, payload) => {
  const ext = {};
  if (payload && typeof payload.onboardingShown === "boolean") ext.onboardingShown = payload.onboardingShown;
  if (payload && payload.onboardingChoice) ext.onboardingChoice = payload.onboardingChoice;
  if (payload && typeof payload.failurePromptDismissedAt === "number") ext.failurePromptDismissedAt = payload.failurePromptDismissedAt;
  mmkvLocator.saveDirPrefsExtended(dirPrefsFile, ext);
  return { ok: true };
});

// ── 失败引导:命中 mmkv 关键词时通知渲染层弹引导框 ──
function maybeEmitMmkvFailurePrompt(lastMessage) {
  if (!mmkvLocator.matchFailureKeywords(lastMessage)) return;
  const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
  // 24h 内不重复弹
  if (ext.failurePromptDismissedAt && Date.now() - ext.failurePromptDismissedAt < 86400000) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mmkv:fail-request", { message: lastMessage });
  }
}

async function unlockerPickMmkv() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 QQ 音乐 MMKV 数据库文件",
    defaultPath: unlockerLastMmkvPath || undefined,
    properties: ["openFile"],
    filters: [
      { name: "MMKV 鏂囦欢", extensions: ["*"] },
      { name: "鍏ㄩ儴鏂囦欢", extensions: ["*"] },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    unlockerLastMmkvPath = result.filePaths[0];
    saveDirPrefs();
  }
  return result.canceled ? "" : result.filePaths[0];
}
ipcMain.handle("unlocker:pickMmkv", unlockerPickMmkv);

// unlock-music Node.js 瑙ｅ瘑鍣紙澶勭悊 ncm / qmc / mflac / mgg / tkm / kwm / xm 绛夋牸寮忥級
async function unlockerUmStart(_event, payload) {
  const license = await requireActiveLicense("audio_unlock", "音频格式转换/解锁");
  if (!license.ok) return license;
  const files = Array.isArray(payload && payload.files) ? payload.files.filter(Boolean) : [];
  const outputDir = (payload && payload.outputDir) || "";
  let mmkvPath = (payload && payload.mmkvPath) || "";
  // 兜底:如果用户没传 MMKV 路径,但 vault 有当前链接,自动用链接传给 um.exe
  if (!mmkvPath) {
    try {
      const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
      if (ext.currentLink && ext.currentLink.linkPath && fs.existsSync(ext.currentLink.linkPath)) {
        mmkvPath = ext.currentLink.linkPath;
        writeLog(`[mmkv fallback] 使用 vault 链接: ${mmkvPath}`);
      }
    } catch (_) {}
  }
  const mmkvKey = (payload && payload.mmkvKey) || "";

  // ── 解密前置条件自检(解码器鲁棒性) ──
  const firstExt = files.length ? path.extname(files[0]) : "";
  try {
    const pre = await mmkvLocator.unlockerPrecheck({ fileExt: firstExt, dirPrefsFile });
    if (pre && !pre.skipped) {
      writeLog(`[precheck] QQMusic=${pre.qqMusicExe}, MMKV=${pre.mmkvFile}`);
    }
  } catch (preErr) {
    // 非致命:仅打印日志,仍允许后续解码尝试(让用户能看到具体错误信息)
    send("unlocker:event", { type: "log", level: "warn", message: "[precheck] " + preErr.message });
    writeLog(`[precheck] 警告: ${preErr.message.split("\n")[0]}`, "warn");
  }
  const targetFormat = normalizeUnlockerTargetFormat(payload && payload.format);
  const targetQuality = safeNumber(payload && payload.quality, 2);
  if (files.length === 0) return { ok: false, message: "请先选择文件" };
  if (!outputDir) return { ok: false, message: "请选择输出目录" };
  fs.mkdirSync(outputDir, { recursive: true });

  // Persist the MMKV path for the next run.
  if (mmkvPath && mmkvPath !== unlockerLastMmkvPath) {
    unlockerLastMmkvPath = mmkvPath;
    saveDirPrefs();
  }

  const umBin = umExecutable();
  if (!umBin) {
    const msg = "未找到 um.exe（vendor/um/um.exe），请重新打包或手动放入。";
    send("unlocker:event", { type: "log", message: msg, level: "error" });
    send("unlocker:event", { type: "failed" });
    return { ok: false, message: msg };
  }

  // Warn early for MusicEx containers when no MMKV path was provided.
  const probableCexExts = new Set([".mgg", ".mflac"]);
  const hasCexCandidate = files.some(f => probableCexExts.has(path.extname(f).toLowerCase()));
  if (hasCexCandidate && !mmkvPath) {
    send("unlocker:event", {
      type: "log",
      level: "warn",
      message: "[提示] .mgg/.mflac 可能需要指定 QQ 音乐 MMKV 数据库，否则可能提示 mmkv vault not loaded。"
    });
  }

  let success = 0, failure = 0;
  const results = [];

  // 閰风嫍 kgg / kgma / vpr 鐩存帴璧?kgg-dec.exe锛堟瘮 Python 涓浆蹇€佽法骞冲彴涓€鑷达級
function kggDecryptor() {
  if (kggDecryptor._cached) return kggDecryptor._cached;
  const candidate = vendorExecutable("kgg", "kgg-dec", {
    envPath: "GAOBAI_KGG_DEC",
    envVendor: "GAOBAI_KGG_VENDOR",
  }) || vendorExecutable("kgg", "kgg_dec", {
    envPath: "GAOBAI_KGG_DEC",
    envVendor: "GAOBAI_KGG_VENDOR",
  });
  if (candidate) kggDecryptor._cached = candidate;
  return candidate;
}

const KGG_EXTS = new Set([".kgg", ".kgm", ".kgma", ".vpr", ".kgm.flac", ".vpr.flac"]);

function runQQMusicFrida(inputFile, outputDir) {
  return new Promise((resolve) => {
    const fridaServer = fridaServerExecutable();
    if (!fridaServer) { resolve({ code: -1, output: null, message: "未找到 vendor/frida/frida-server.exe" }); return; }
    let spec = pythonScriptExecutable("qqmusic_frida_unlocker");
    // Fall back to the Python script if the packaged exe is not present.
    if (app.isPackaged && !fs.existsSync(spec.command)) {
      const scriptPath = path.join(projectRoot(), "python", "qqmusic_frida_unlocker.py");
      spec = { command: process.env.GAOBAI_PYTHON || "python", prefixArgs: [scriptPath] };
    }
    const args = [
      ...spec.prefixArgs,
      "--input", inputFile,
      "--output-dir", outputDir,
      "--frida-server", fridaServer,
    ];
    const child = spawn(spec.command, args, {
      cwd: projectRoot(),
      env: backendEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let lastMessage = "";
    let output = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          send("unlocker:event", evt);
          if (evt.type === "result" && Array.isArray(evt.items)) {
            const okItem = evt.items.find(x => x && x.success && x.output);
            if (okItem) output = okItem.output;
          }
          if (evt.message) lastMessage = evt.message;
        } catch (_) {
          lastMessage = line.trim();
          send("unlocker:event", { type: "log", message: line.trim() });
        }
      }
    });
    child.stderr.on("data", (text) => {
      const msg = String(text).trim();
      if (msg) {
        lastMessage = msg;
        send("unlocker:event", { type: "log", level: "error", message: msg });
      }
    });
    child.on("error", (err) => resolve({ code: -1, output: null, message: err.message }));
    child.on("close", (code) => {
      // 某些版本的 qqmusic_frida_unlocker.exe 会成功输出文件，但 stdout 因编码/缓冲没有给出 JSON result。
      // 这时日志会出现「成功 1 / 失败 0」（乱码显示为 ɣɹ 1 / ʧ 0），但 output 仍为 null。
      // 兜底：退出码为 0 时按输入文件名在 outputDir 里找 .ogg/.flac 输出。
      if (code === 0 && (!output || !fs.existsSync(output))) {
        try {
          const stem = path.basename(inputFile, path.extname(inputFile));
          const candidates = fs.readdirSync(outputDir)
            .filter((f) => {
              const ext = path.extname(f).toLowerCase();
              return (ext === ".ogg" || ext === ".flac" || ext === ".mp3" || ext === ".wav" || ext === ".m4a") &&
                (f.startsWith(stem) || f.includes(stem) || stem.includes(path.basename(f, ext)));
            })
            .map((f) => path.join(outputDir, f))
            .filter((p) => {
              try { return fs.statSync(p).size > 1024; } catch (_) { return false; }
            })
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          if (candidates.length) {
            output = candidates[0];
            lastMessage = `Frida 已产出文件: ${path.basename(output)}`;
            send("unlocker:event", { type: "log", level: "info", message: `[qqmusic-frida] 检测到输出文件：${output}` });
          }
        } catch (e) {
          send("unlocker:event", { type: "log", level: "warn", message: `[qqmusic-frida] 输出扫描失败：${e.message}` });
        }
      }
      resolve({ code, output, message: lastMessage });
    });
  });
}

function runKggDec(inputFile) {
  return new Promise((resolve) => {
    const bin = kggDecryptor();
    if (!bin) { resolve({ code: -1, output: null, message: "鏈壘鍒?vendor/kgg/kgg-dec.exe" }); return; }
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "kgg-dec-"));
    const child = spawn(bin, ["--suffix", "_dec", inputFile], { cwd: tmpDir, windowsHide: true });
    let stderrBuf = "";
    child.stdout && child.stdout.setEncoding("utf8");
    child.stderr && child.stderr.setEncoding("utf8");
    child.stderr && child.stderr.on("data", (text) => { stderrBuf += text; });
    child.on("error", (err) => resolve({ code: -1, output: null, message: err.message }));
    child.on("close", (code) => {
      // kgg-dec 鍦?cwd 杈撳嚭 <鍘熷悕>_dec<鍘熸墿灞?锛屾壘鍒版柊鏂囦欢
      try {
        const stem = path.basename(inputFile, path.extname(inputFile));
        const files = fs.readdirSync(tmpDir);
        const out = files.find(f => f.startsWith(stem) && (f.endsWith(".flac") || f.endsWith(".mp3") || f.endsWith(".ogg") || f.endsWith(".wav") || f.endsWith(".m4a")));
        if (out) resolve({ code: 0, output: path.join(tmpDir, out), message: "" });
        else resolve({ code: code || 1, output: null, message: stderrBuf.split(/\r?\n/).filter(Boolean).slice(-1)[0] || "kgg-dec 未产出文件" });
      } catch (e) {
        resolve({ code: -1, output: null, message: e.message });
      }
    });
  });
}

const runOne = (file) => new Promise((resolve) => {
    const before = new Set();
    try {
      for (const name of fs.readdirSync(outputDir)) before.add(name);
    } catch (_) {}

    let stderrBuf = "";
    let logBuf = "";
    const args = ["-i", file, "-o", outputDir, "--overwrite"];
    if (mmkvPath) {
      args.push("--qmc-mmkv", mmkvPath);
      if (mmkvKey) args.push("--qmc-mmkv-key", mmkvKey);
    }
    const child = spawn(umBin, args, {
      cwd: projectRoot(),
      windowsHide: true,
    });
    child.stdout && child.stdout.setEncoding("utf8");
    child.stderr && child.stderr.setEncoding("utf8");
    if (child.stderr) {
      child.stderr.on("data", (text) => {
        stderrBuf += text;
        logBuf += text;
        for (const line of String(text).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          // um.exe 鐢?zap 鍐欏甫棰滆壊鐨?INFO/WARN/ERROR 鏃ュ織鍒?stdout/stderr锛?          // 杩欓噷鍙寫鍑烘湁鐢ㄧ殑浜虹被鍙鐗囨鍙嶉缁?UI銆?          send("unlocker:event", { type: "log", message: `[um] ${t}` });
        }
      });
    }
    if (child.stdout) {
      child.stdout.on("data", (text) => {
        logBuf += text;
        for (const line of String(text).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          send("unlocker:event", { type: "log", message: `[um] ${t}` });
        }
      });
    }
    child.on("error", (err) => {
      resolve({ code: -1, message: err.message });
    });
    child.on("close", (code) => {
      let produced = null;
      try {
        const baseStem = path.basename(file, path.extname(file)).toLowerCase();
        for (const name of fs.readdirSync(outputDir)) {
          if (before.has(name)) continue;
          if (name.toLowerCase().startsWith(baseStem)) { produced = path.join(outputDir, name); break; }
        }
      } catch (_) {}
      // um.exe 有时会成功转换但目标文件已存在或 stdout/stderr 里只给 destination，
      // 这时 above 的“新增文件扫描”会漏掉，导致成功被误判失败。
      if (!produced) {
        try {
          const combined = String(logBuf || stderrBuf || "");
          const destMatch = combined.match(/"destination"\s*:\s*"((?:\\\\|\\"|[^"])*)"/);
          if (destMatch && destMatch[1]) {
            const dest = destMatch[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
            if (fs.existsSync(dest)) produced = dest;
          }
        } catch (_) {}
      }
      resolve({ code, output: produced, stderr: stderrBuf, log: logBuf });
    });
  });

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    // 收集每个解码器步骤的失败原因(用于最终汇总)
    const fileAttempts = [];
    send("unlocker:event", {
      type: "status", stage: "processing",
      index: fi + 1, total: files.length, current: file,
      message: `[um解密] (${fi+1}/${files.length}) ${path.basename(file)}`
    });
    send("unlocker:event", { type: "log", message: `[um解密] 开始处理： ${path.basename(file)}` });

    const extLower = path.extname(file).toLowerCase();

    if (isOpenAudioFile(file)) {
      try {
        const finalFile = await transcodeUnlockedAudio(
          file, file, outputDir, targetFormat, targetQuality,
          (m) => send("unlocker:event", { type: "log", message: m })
        );
        results.push({ source: file, output: finalFile, success: true });
        success++;
        send("unlocker:event", { type: "log", message: `[ffmpeg鐩磋浆] OK: ${path.basename(file)} -> ${path.basename(finalFile)}` });
        continue;
      } catch (err) {
        results.push({ source: file, success: false, message: err.message });
        failure++;
        send("unlocker:event", { type: "log", level: "error", message: `[ffmpeg直转] 失败: ${path.basename(file)} - ${err.message}` });
        continue;
      }
    }

    if (extLower === ".mgg" || extLower === ".mflac") {
      const fridaServer = fridaServerExecutable();
      let fridaSpec = pythonScriptExecutable("qqmusic_frida_unlocker");
      if (app.isPackaged && !fs.existsSync(fridaSpec.command)) {
        fridaSpec = { command: process.env.GAOBAI_PYTHON || "python", prefixArgs: [path.join(projectRoot(), "python", "qqmusic_frida_unlocker.py")] };
      }
      send("unlocker:event", { type: "log", level: "info", message: `[qqmusic-frida] start: ${path.basename(file)}` });
      send("unlocker:event", { type: "log", level: "info", message: `[qqmusic-frida] exe: ${fridaSpec.command} (exists=${fs.existsSync(fridaSpec.command)})` });
      send("unlocker:event", { type: "log", level: "info", message: `[qqmusic-frida] frida-server: ${fridaServer || "未找到"} (exists=${!!fridaServer})` });
      const fridaR = await runQQMusicFrida(file, outputDir);
      if (fridaR.code === 0 && fridaR.output && fs.existsSync(fridaR.output)) {
        let finalFile = fridaR.output;
        try {
          finalFile = await transcodeUnlockedAudio(
            fridaR.output, file, outputDir, targetFormat, targetQuality,
            (m) => send("unlocker:event", { type: "log", message: m })
          );
        } catch (transcodeErr) {
          send("unlocker:event", { type: "log", level: "warn",
            message: `[qqmusic-frida] 已解出 ${path.basename(fridaR.output)}，ffmpeg 转码失败：${transcodeErr.message}` });
        }
        results.push({ source: file, output: finalFile, success: true });
        success++;
        send("unlocker:event", { type: "log", message: `[qqmusic-frida] final: ${path.basename(file)} -> ${path.basename(finalFile)}` });
        continue;
      }
      // 收集 frida 失败原因(用于最终汇总)
      const fridaFail = `[qqmusic-frida] ${fridaR.message || "退出码 " + fridaR.code}`;
      fileAttempts.push({ step: "Frida 注入", message: fridaFail });
      send("unlocker:event", { type: "log", level: "warn",
        message: `[qqmusic-frida] ${path.basename(file)} 解密失败：${fridaR.message}；尝试 qmcwasm/um.exe` });
    }

    // 閰风嫍绯诲垪 (kgg/kgma/vpr) 浼樺厛璧?kgg-dec.exe
    if (KGG_EXTS.has(path.extname(file).toLowerCase())) {
      const kggR = await runKggDec(file);
      if (kggR.code === 0 && kggR.output && fs.existsSync(kggR.output)) {
        let finalFile = kggR.output;
        try {
          finalFile = await transcodeUnlockedAudio(
            kggR.output, file, outputDir, targetFormat, targetQuality,
            (m) => send("unlocker:event", { type: "log", message: m })
          );
        } catch (transcodeErr) {
          send("unlocker:event", { type: "log", level: "warn",
            message: `[kgg-dec] 已解出 ${path.basename(kggR.output)}，ffmpeg 转码失败：${transcodeErr.message}` });
        }
        results.push({ source: file, output: finalFile, success: true });
        success++;
        send("unlocker:event", { type: "log", message: `[kgg-dec] OK: ${path.basename(file)} -> ${path.basename(finalFile)}` });
        continue;
      }
      send("unlocker:event", { type: "log", level: "warn",
        message: `[kgg-dec] ${path.basename(file)} 解码失败：${kggR.message}；尝试 um.exe` });
    }

    // Try qmcwasm first, then fall back to um.exe.
    try {
      // 涓嶈鍥犱负妫€娴嬪埌 MusicEx 灏辨彁鍓嶅け璐ャ€俢wo.cc/music 鐨勬祻瑙堝櫒璺緞鑳藉鐞嗛儴鍒?      // .mgg/.mflac锛屽繀椤诲厛灏濊瘯 web/qmcwasm 瑙ｇ爜锛涘彧鏈夎緭鍑轰笉鏄湁鏁堥煶棰戞椂鎵嶅洖閫€銆?      const wasmResult = await decryptQmcWithWasm(file);
      if (wasmResult && wasmResult.data) {
        const outFile = path.join(outputDir, `${path.basename(file, path.extname(file))}${wasmResult.ext}`);
        fs.writeFileSync(outFile, wasmResult.data);
        let finalFile = outFile;
        try {
          finalFile = await transcodeUnlockedAudio(
            outFile,
            file,
            outputDir,
            targetFormat,
            targetQuality,
            (message) => send("unlocker:event", { type: "log", message })
          );
        } catch (transcodeErr) {
          send("unlocker:event", {
            type: "log",
            level: "warn",
            message: `[qmcwasm] 已输出 ${path.basename(outFile)}，但 ffmpeg 转码失败：${transcodeErr.message}。`
          });
        }
        results.push({ source: file, output: finalFile, success: true });
        success++;
        send("unlocker:event", { type: "log", message: `[qmcwasm] OK: ${path.basename(file)} -> ${path.basename(finalFile)}` });
        continue;
      }
      if (wasmResult && wasmResult.error) {
        throw new Error(wasmResult.error);
      }
      // wasm 没产出
      fileAttempts.push({ step: "qmcwasm", message: "解码未产出(可能格式不被 wasm 支持)" });
    } catch (err) {
      fileAttempts.push({ step: "qmcwasm", message: err.message || String(err) });
      send("unlocker:event", { type: "log", level: "warn", message: `[qmcwasm] ${path.basename(file)} 解码失败：${err.message}；尝试回退到 um.exe` });
    }

    send("unlocker:event", { type: "log", level: "info", message: `[um] fallback/start: ${path.basename(file)}` });
    const r = await runOne(file);
    if (r.code === 0 && r.output && fs.existsSync(r.output)) {
      try {
        const finalFile = await transcodeUnlockedAudio(
          r.output,
          file,
          outputDir,
          targetFormat,
          targetQuality,
          (message) => send("unlocker:event", { type: "log", message })
        );
      results.push({ source: file, output: finalFile, success: true });
      success++;
      send("unlocker:event", { type: "log", message: `[um] final: ${path.basename(file)} -> ${path.basename(finalFile)}` });
      r.output = finalFile;
      send("unlocker:event", { type: "log", message: `[um解密] OK: ${path.basename(file)} -> ${path.basename(r.output)}` });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        results.push({ source: file, success: false, message: msg });
        failure++;
        send("unlocker:event", { type: "log", message: `[ffmpeg] failed: ${path.basename(file)} - ${msg}`, level: "error" });
        writeLog(`um ffmpeg transcode failed ${file}: ${msg}`, "error");
      }
    } else {
      const combinedLog = String(r.log || r.stderr || "");
      const jsonErrorMatch = combinedLog.match(/"error"\s*:\s*"([^"]+)"/g);
      const lastJsonError = jsonErrorMatch && jsonErrorMatch.length
        ? jsonErrorMatch[jsonErrorMatch.length - 1].replace(/^.*"error"\s*:\s*"/, "").replace(/"$/, "")
        : "";
      const cleanLastLine = combinedLog
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(-1)[0] || "";
      // 错误信息改造:用 parseUmError 转为可执行清单
      const rawMsg = r.message || lastJsonError || cleanLastLine || `um.exe 退出码 ${r.code}`;
      const msg = parseUmError(rawMsg, path.basename(file));
      // 收集 um.exe 失败原因,用于综合汇总
      fileAttempts.push({ step: "um.exe", message: rawMsg });
      // 综合最终错误信息(列出所有尝试步骤)
      const finalMsg = fileAttempts.length > 1
        ? buildComprehensiveError(fileAttempts, file, msg)
        : msg;
      results.push({ source: file, success: false, message: finalMsg });
      failure++;
      send("unlocker:event", { type: "log", message: `[um解密] 失败: ${path.basename(file)} - ${msg}`, level: "error" });
      writeLog(`um瑙ｅ瘑失败 ${file}: ${msg}`, "error");
    }
  }

  send("unlocker:event", {
    type: "status", stage: "finished",
    success, failure, total: success + failure,
    message: `完成：成功 ${success} / 失败 ${failure}`,
  });
  send("unlocker:event", {
    type: "result", success, failure, total: success + failure,
    items: results, output_dir: outputDir
  });
  const lastFailure = results.filter(x => !x.success).slice(-1)[0];
  send("unlocker:event", success > 0
    ? { type: "done" }
    : { type: "failed", message: lastFailure && lastFailure.message ? lastFailure.message : "全部文件解密失败" }
  );

  // 失败引导:命中 mmkv 关键词时,通知渲染层弹引导框(只对 .mgg/.mflac 的失败生效)
  if (failure > 0) {
    const hasCex = files.some(f => /\.(mgg|mflac)$/i.test(f));
    if (hasCex && lastFailure && lastFailure.message) {
      maybeEmitMmkvFailurePrompt(lastFailure.message);
    }
  }

  return { ok: success > 0, message: lastFailure && lastFailure.message ? lastFailure.message : "" };
}
ipcMain.handle("unlocker:um-start", unlockerUmStart);

// ─────────────────────────────────────────────────────────────────
// 解码器鲁棒性 - 自检 + 一键修复 IPC
// 设计文档: docs/superpowers/specs/2026-06-22-decoder-robust-design.md
// ─────────────────────────────────────────────────────────────────

/**
 * 解析 um.exe 输出的错误信息,转为可执行清单
 */
function parseUmError(stderr, fileName) {
  const text = String(stderr || "");
  if (/mmkv vault not loaded/i.test(text)) {
    return (
      `❌ ${fileName} 解密失败:MMKV vault 未加载。\n` +
      `   可能原因:\n` +
      `     1. 该歌曲未在 QQ 音乐中播放过(最常见)\n` +
      `     2. MMKV 路径配置错误,请在设置中确认\n` +
      `     3. MMKV 文件被 QQ 音乐独占,请重启 QQ 音乐\n` +
      `   已自动 fallback 到 vault 链接,如仍失败请在设置中重新配置 MMKV`
    );
  }
  if (/no any decoder can resolve/i.test(text)) {
    return (
      `❌ ${fileName} 解密失败:所有解码器都无法识别此文件格式。\n` +
      `   可能原因:\n` +
      `     1. 这是 QQ 音乐 v20+ 加密的 .mgg/.mflac,需要 Frida 注入\n` +
      `     2. 请确认 QQ 音乐客户端已打开\n` +
      `     3. 如使用 v18/v19 旧客户端,需要配置 MMKV 路径`
    );
  }
  return text || `um.exe 解码失败`;
}

/**
 * 综合所有尝试步骤的失败信息,让用户一眼看到每个解码器为什么失败
 */
function buildComprehensiveError(attempts, fullPath, lastMsg) {
  const fileName = path.basename(fullPath);
  const lines = [];
  lines.push(`❌ ${fileName} 全部解码器都失败。`);
  lines.push("");
  lines.push("尝试历史:");
  for (const a of attempts) {
    const short = (a.message || "").split("\n")[0].slice(0, 160);
    lines.push(`  ✗ ${a.step}: ${short}`);
  }
  lines.push("");
  const fridaAttempt = attempts.find((a) => /frida/i.test(a.step));
  const wasmAttempt = attempts.find((a) => /qmcwasm/i.test(a.step));
  const umAttempt = attempts.find((a) => /um\.exe|um/i.test(a.step));
  if (fridaAttempt) lines.push(`Frida 注入失败原因: ${(fridaAttempt.message || "未知").split("\n")[0]}`);
  if (wasmAttempt) lines.push(`qmcwasm 失败原因: ${(wasmAttempt.message || "未知").split("\n")[0]}`);
  if (umAttempt) lines.push(`um.exe 失败原因: ${(umAttempt.message || "未知").split("\n")[0]}`);
  lines.push("");
  lines.push("下一步建议:");
  // 根据具体失败原因给出针对性建议
  const has = (kw) => attempts.some((a) => (a.message || "").includes(kw));
  if (has("frida") || has("No module") || has("ProcessNotFound") || attempts.find((a) => a.step === "Frida 注入")) {
    lines.push("  • 打开 QQ 音乐 PC 客户端 v20+ 并播放一次该歌曲");
    lines.push("  • 确认 frida-server 已启动，并检查 vendor/frida/ 文件是否完整");
  }
  if (has("mmkv vault not loaded") || has("vault not loaded")) {
    lines.push("  • 在设置 → MMKV 高级选项里点击「🔍 自动搜索」");
    lines.push("  • 在 QQ 音乐里播放一次该歌曲(让 MMKV 落盘)");
  }
  if (has("no any decoder")) {
    lines.push("  • 这可能是 QQ 音乐未支持的格式,请用最新客户端重新下载");
  }
  lines.push("");
  lines.push("请根据以上建议检查配置后重新尝试。");
  lines.push("");
  lines.push("--- 最后一条错误详情 ---");
  lines.push(lastMsg);
  return lines.join("\n");
}

/**
 * 跑健康检查,返回结构化报告
 */
async function runUnlockerSelfCheck(sampleFile) {
  const items = [];

  // 1. frida 检测(启动时只能从前一次缓存读;首次解密时再深检)
  items.push({
    id: "check.frida_installed",
    name: "frida 模块",
    status: "unknown",
    message: "启动时未知,首次解密时检测",
    fixable: true,
    fixId: "fix.install_frida",
    fixLabel: "🔧 自动安装",
    requiresRestart: true,
    antivirusWarning: false,
  });

  // 2. wasm bundle
  let wasmOk = false, wasmMsg = "", wasmPath = "";
  try {
    const bundlePath = qmcWasmBundlePath();
    wasmPath = bundlePath || "";
    if (!bundlePath) {
      wasmMsg = "vendor/qmcwasm/QmcWasmBundle.js 不存在";
    } else {
      const stat = fs.statSync(bundlePath);
      if (stat.size < 1024) wasmMsg = `文件大小异常 (${stat.size} bytes),可能下载不完整或被杀毒破坏`;
      else { wasmOk = true; wasmMsg = `${(stat.size/1024).toFixed(1)} KB,正常`; }
    }
  } catch (e) { wasmMsg = e.message; }
  items.push({
    id: "check.wasm_bundle",
    name: "qmcwasm Bundle",
    status: wasmOk ? "ok" : "fail",
    message: wasmMsg,
    fixable: !wasmOk,
    fixId: wasmOk ? null : "fix.locate_wasm",
    fixLabel: "📂 打开文件位置",
    filePath: wasmPath,
    requiresRestart: false,
    antivirusWarning: !wasmOk,
  });

  // 3. um.exe
  let umOk = false, umMsg = "", umPath = "";
  try {
    const umBin = umExecutable();
    umPath = umBin || path.join(projectRoot(), "vendor", "um", "um.exe");
    if (umBin) { umOk = true; umMsg = `已就绪`; }
    else umMsg = "vendor/um/um.exe 缺失(可能被杀毒隔离)";
  } catch (e) { umMsg = e.message; }
  items.push({
    id: "check.um_executable",
    name: "um.exe",
    status: umOk ? "ok" : "fail",
    message: umMsg,
    fixable: !umOk,
    fixId: umOk ? null : "fix.locate_um",
    fixLabel: "📂 打开文件位置",
    filePath: umPath,
    requiresRestart: false,
    antivirusWarning: !umOk,
  });

  // 4. Node 版本
  const nodeMajor = Number((process.versions.node || "0").split(".")[0]);
  const nodeOk = nodeMajor >= 16 && nodeMajor <= 22;
  items.push({
    id: "check.node_version",
    name: "Node.js 版本",
    status: nodeOk ? "ok" : "fail",
    message: `当前 v${process.versions.node} ${nodeOk ? "(兼容)" : "(不兼容,需 16-22)"}`,
    fixable: false,
    fixId: null,
    fixLabel: "升级 Node",
    requiresRestart: false,
    antivirusWarning: false,
  });

  // 5. QQ 音乐是否在跑
  let qqExe = null;
  try { qqExe = await findQqMusicProcess(); } catch (_) {}
  items.push({
    id: "check.qqmusic_running",
    name: "QQ 音乐客户端",
    status: qqExe ? "ok" : "warn",
    message: qqExe ? `已运行: ${qqExe}` : "未运行(仅 .mgg/.mflac 解密需要)",
    fixable: !qqExe,
    fixId: qqExe ? null : "fix.open_qqmusic",
    fixLabel: "打开 QQ 音乐",
    requiresRestart: false,
    antivirusWarning: false,
  });

  // 6. MMKV 路径是否配置
  const ext = mmkvLocator.loadDirPrefsExtended(dirPrefsFile);
  const mmkvFile = ext.currentLink && ext.currentLink.linkPath ? ext.currentLink.linkPath : "";
  const mmkvExists = mmkvFile && fs.existsSync(mmkvFile);
  items.push({
    id: "check.mmkv_path_configured",
    name: "MMKV 数据库",
    status: mmkvExists ? "ok" : (mmkvFile ? "fail" : "warn"),
    message: mmkvExists ? `已配置: ${mmkvFile}` : (mmkvFile ? `路径失效: ${mmkvFile}` : "未配置"),
    fixable: !mmkvExists,
    fixId: !mmkvExists ? "fix.search_mmkv" : null,
    fixLabel: "🔍 自动搜索",
    requiresRestart: false,
    antivirusWarning: false,
  });

  return {
    items,
    summary: {
      ok: items.filter(i => i.status === "ok").length,
      fail: items.filter(i => i.status === "fail").length,
      warn: items.filter(i => i.status === "warn").length,
    },
  };
}

// 6 个修复操作
async function fixInstallFrida() {
  const toolPython = path.join(projectRoot(), "vendor", "python", "python.exe");
  const sysPython = process.env.GAOBAI_PYTHON || "python";
  const py = fs.existsSync(toolPython) ? toolPython : sysPython;

  return new Promise((resolve) => {
    const child = spawn(py, ["-m", "pip", "install", "frida", "frida-tools"], {
      cwd: projectRoot(),
      windowsHide: true,
    });
    let stderr = "", stdout = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          requiresRestart: true,
          message: "frida 安装成功!但 qqmusic_frida_unlocker.exe 启动时已 import frida,需重启本应用才能加载新的 frida 模块。",
          output: stdout.slice(-200),
        });
      } else {
        resolve({ ok: false, message: `pip install 失败(code ${code}): ${stderr.slice(-300)}` });
      }
    });
    child.on("error", (e) => resolve({ ok: false, message: `spawn 失败: ${e.message}` }));
  });
}

async function fixOpenQqMusic() {
  const url = "https://y.qq.com/download/pc/";
  try {
    await shell.openExternal(url);
    return { ok: true, message: "已打开 QQ 音乐下载页;安装后请手动启动客户端" };
  } catch (e) {
    return { ok: false, message: `打开失败: ${e.message}` };
  }
}

async function fixSearchMmkv() {
  try {
    const candidates = await mmkvLocator.locateMmkvCandidates();
    if (!candidates.length) {
      return { ok: false, message: "未找到候选 MMKV 数据库。请确认 QQ 音乐已登录并播放过歌曲,或手动指定路径。" };
    }
    const chosen = candidates[0];
    const r = mmkvLocator.createMmkvSymlink(chosen.path, vaultDir);
    mmkvLocator.saveDirPrefsExtended(dirPrefsFile, {
      vaultDir,
      currentLink: {
        linkPath: r.linkPath,
        originalPath: chosen.path,
        createdAt: Date.now(),
        source: "auto-fix",
        method: r.method,
      },
      onboardingShown: true,
      onboardingChoice: "auto-fix",
    });
    unlockerLastMmkvPath = r.linkPath;
    saveDirPrefs();
    return {
      ok: true,
      message: `已自动启用: ${chosen.path} (${r.method})`,
      linkPath: r.linkPath,
    };
  } catch (e) {
    return { ok: false, message: `搜索失败: ${e.message}` };
  }
}

async function fixResetMmkv() {
  const ok = mmkvLocator.removeMmkvSymlink(vaultDir);
  mmkvLocator.saveDirPrefsExtended(dirPrefsFile, { currentLink: null });
  unlockerLastMmkvPath = "";
  saveDirPrefs();
  return { ok, message: ok ? "旧链接已删除" : "未找到旧链接" };
}

async function fixLocateFile(relativePath) {
  try {
    const fullPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectRoot(), relativePath);
    if (!fs.existsSync(fullPath)) {
      return {
        ok: false,
        message: `文件不存在: ${fullPath}\n可能已被杀毒软件隔离,请检查杀毒软件的"恢复区"或"隔离区"。`,
      };
    }
    shell.showItemInFolder(fullPath);
    return {
      ok: true,
      message: `已在资源管理器中打开: ${fullPath}\n\n⚠ 如果文件不在这里,可能被杀毒软件隔离:\n  1. 360: 设置 → 杀毒 → 恢复区\n  2. 火绒: 防护中心 → 信任区 / 隔离区\n  3. Windows Defender: 病毒威胁防护 → 保护历史记录 → 操作 → 还原\n  4. 卡巴斯基: 检测到的威胁 → 还原`,
    };
  } catch (e) {
    return { ok: false, message: `打开失败: ${e.message}` };
  }
}

// IPC 注册
ipcMain.handle("selfcheck:run", async () => {
  try {
    return await runUnlockerSelfCheck();
  } catch (e) {
    writeLog(`selfcheck:run 失败: ${e.message}`, "error");
    return { ok: false, error: e.message, items: [], summary: { ok: 0, fail: 0, warn: 0 } };
  }
});

ipcMain.handle("selfcheck:fix", async (_event, payload) => {
  const fixId = payload && payload.fixId;
  try {
    switch (fixId) {
      case "fix.install_frida":  return await fixInstallFrida();
      case "fix.open_qqmusic":   return await fixOpenQqMusic();
      case "fix.search_mmkv":    return await fixSearchMmkv();
      case "fix.reset_mmkv":     return await fixResetMmkv();
      case "fix.locate_wasm":    return await fixLocateFile("vendor/qmcwasm/QmcWasmBundle.js");
      case "fix.locate_um":      return await fixLocateFile("vendor/um/um.exe");
      default: return { ok: false, message: `未知 fix: ${fixId}` };
    }
  } catch (e) {
    writeLog(`selfcheck:fix ${fixId} 失败: ${e.message}`, "error");
    return { ok: false, message: e.message };
  }
});

function getUploadBatchQueue() {
  if (!uploadBatchQueue) {
    uploadBatchQueue = new PersistentUploadBatchQueue(
      path.join(app.getPath("userData"), "upload_batch_queue.json"),
    );
  }
  return uploadBatchQueue;
}

function uploadBatchSnapshot() {
  return getUploadBatchQueue().snapshot();
}

function emitUploadBatchState(type = "state", extra = {}) {
  const payload = { type, queue: uploadBatchSnapshot(), ...extra };
  send("upload:batch-event", payload);
  return payload.queue;
}

function clearUploadBatchAdvanceTimer() {
  if (uploadBatchAdvanceTimer) clearTimeout(uploadBatchAdvanceTimer);
  uploadBatchAdvanceTimer = null;
}

function pauseUploadBatchForShutdown() {
  clearUploadBatchAdvanceTimer();
  if (!uploadBatchQueue) return;
  const queue = uploadBatchQueue;
  const currentItemId = String(queue.state.currentItemId || "");
  if (currentItemId) {
    queue.updateItem(currentItemId, {
      status: "pending",
      progress: 0,
      message: "软件重启后等待继续",
      error: "",
    }, false);
  }
  if (ACTIVE_QUEUE_STATUSES.has(queue.state.status) || currentItemId) {
    queue.state.status = "paused";
    queue.state.currentItemId = "";
    queue.state.pauseRequested = false;
    queue.save();
  }
}

function isUploadBatchActive() {
  return ACTIVE_QUEUE_STATUSES.has(getUploadBatchQueue().state.status);
}

function validBatchItems(items) {
  const seen = new Set();
  const output = [];
  for (const source of Array.isArray(items) ? items : []) {
    const audioPath = String(source?.audioPath || "").trim();
    const key = process.platform === "win32" ? audioPath.toLowerCase() : audioPath;
    if (!audioPath || seen.has(key) || !fs.existsSync(audioPath) || !isOpenAudioFile(audioPath)) continue;
    seen.add(key);
    output.push({
      id: String(source?.id || crypto.randomUUID()),
      audioPath,
      accountId: getSunoAccounts().id(source?.accountId || getSunoAccounts().selectedId),
      accountUserId: String(source?.accountUserId || getSunoAccounts().info(source?.accountId || getSunoAccounts().selectedId).userId),
      title: String(source?.title || path.basename(audioPath, path.extname(audioPath))).trim(),
      speed: VALID_SPEEDS.has(source?.speed) ? source.speed : "onbeat2x",
      status: ["completed", "failed"].includes(source?.status) ? source.status : "pending",
      progress: source?.status === "completed" ? 100 : 0,
      resultUrl: String(source?.resultUrl || ""),
      error: String(source?.error || ""),
      elapsedSec: Math.max(0, Number(source?.elapsedSec) || 0),
    });
  }
  return output;
}

function updateUploadBatchFromBackend(event, itemId) {
  if (!event || !itemId) return;
  const queue = getUploadBatchQueue();
  const item = queue.state.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const patch = {};
  if (event.type === "status") {
    patch.status = "uploading";
    patch.message = String(event.message || "上传中");
    if (event.progress !== undefined) patch.progress = Number(event.progress) || 0;
  } else if (event.type === "progress") {
    const total = Math.max(1, Number(event.total) || 1);
    const submitted = Math.max(0, Number(event.submitted) || 0);
    const done = Math.max(0, Number(event.done) || 0);
    patch.status = "uploading";
    patch.progress = Math.min(92, 30 + Math.round((submitted / total) * 25) + Math.round((done / total) * 37));
    patch.message = `提交 ${submitted}/${total} · 完成 ${done}/${total}`;
    patch.elapsedSec = Math.max(0, Number(event.elapsed_sec) || item.elapsedSec || 0);
  } else if (event.type === "result" && !event.loginOk) {
    patch.status = "completed";
    patch.progress = 100;
    patch.message = "上传完成";
    patch.resultUrl = String(event.songUrl || event.url || "");
    patch.elapsedSec = Math.max(0, Number(event.elapsedSec || event.elapsed_sec || item.elapsedSec) || 0);
    patch.completedAt = new Date().toISOString();
  } else if (event.type === "auth_required") {
    patch.status = "waiting_login";
    patch.message = "等待重新登录 Suno";
    patch.error = String(event.message || "Suno Token 已失效");
    queue.state.status = "waiting_login";
    queue.state.pauseRequested = false;
  } else if (event.type === "failed") {
    patch.status = "failed";
    patch.message = "上传失败";
    patch.error = String(event.message || (event.code !== undefined ? `退出码 ${event.code}` : "上传任务失败"));
    patch.completedAt = new Date().toISOString();
  }
  if (Object.keys(patch).length) {
    queue.updateItem(itemId, patch, false);
    queue.save();
    emitUploadBatchState("item-updated", { itemId });
  }
}

async function launchUploadTask(payload = {}, options = {}) {
  if (sunoOperation) return {ok:false,message:"账号正在处理登录或验证，请稍候。"};
  sunoOperation=true;
  try { return await launchUploadTaskImpl(payload, options); }
  finally { sunoOperation=false; }
}
async function launchUploadTaskImpl(payload = {}, options = {}) {
  const accountId=getSunoAccounts().id(payload.accountId || getSunoAccounts().selectedId);
  await getSunoAccounts().stopPairing();
  { // Re-authorize every queue item, including resumed batches.
    const license = await requireActiveLicense("suno_upload", "上传 Suno", { forceOnline: true });
    if (!license.ok) return license;
  }
  if (currentJob) return { ok: false, message: "已有任务正在运行" };
  if (!payload.audioPath || !fs.existsSync(payload.audioPath) || !isOpenAudioFile(payload.audioPath)) {
    return { ok: false, code: "audio_not_found", message: "上传音频不存在或格式不受支持。" };
  }

  const auth = await prepareSunoTokenForUpload(false, accountId);
  if (!auth.ok) {
    writeLog(`Suno Token 不可用，未创建上传任务: ${auth.reason || "unknown"}`, "warn");
    return {
      ok: false,
      code: "suno_login_required",
      message: "Suno 未完成登录，未获取到任何有效的 Suno 密钥。请尝试更换 Suno 账号或切换网络代理后重新登录。",
    };
  }

  const account=getSunoAccounts().info(accountId);
  if (!account.userId || (payload.accountUserId && payload.accountUserId !== account.userId)) {
    return {ok:false,code:"suno_login_required",message:`账号 ${accountId} 与任务绑定的 Suno 账号不一致，请登录原账号或重新添加任务。`};
  }
  if (options.batchItemId) getUploadBatchQueue().updateItem(options.batchItemId,{accountUserId:account.userId},false);
  const requestedResumePolicy = options.forceNew
    ? "new"
    : String(payload.resumePolicy || "").toLowerCase();
  if (!requestedResumePolicy) {
    try {
      const candidate = await runBackendJson([
        "--resume-candidate",
        "--source", payload.audioPath,
        "--speed", payload.speed || "fast",
      ], {env:sunoEnv(accountId)});
      if (candidate && candidate.candidate) {
        return { ok: false, code: "resume_decision_required", candidate: candidate.candidate };
      }
    } catch (error) {
      writeLog(`旧上传任务检查失败，将创建新项目: ${error.message}`, "warn");
    }
  }

  const batchItemId = String(options.batchItemId || "");
  writeLog(`${batchItemId ? `[批量 ${batchItemId}] ` : ""}开始上传 ${payload.audioPath}, 标题: ${payload.title || "(空)"}, 速度: ${payload.speed}`);
  const args = [
    "--source", payload.audioPath,
    "--title", payload.title || "",
    "--speed", payload.speed || "fast",
    "--resume-policy", requestedResumePolicy === "resume" ? "resume" : (requestedResumePolicy === "new" ? "new" : "auto"),
  ];
  const cancelDir = path.join(app.getPath("userData"), "runtime");
  try { fs.mkdirSync(cancelDir, { recursive: true }); } catch (_) {}
  uploadCancelFile = path.join(cancelDir, `upload-cancel-${Date.now()}.flag`);
  try { fs.unlinkSync(uploadCancelFile); } catch (_) {}
  uploadStopRequested = false;
  const uploadEnv = { ...sunoEnv(accountId), GAOBAI_CANCEL_FILE: uploadCancelFile };
  if (auth.skipNetworkPreflight && !auth.recovered) uploadEnv.GAOBAI_SKIP_SUNO_TOKEN_PRECHECK = "1";

  let job = null;
  job = runBackend(args, {
    eventChannel: "backend:event",
    env: uploadEnv,
    onEvent: (event) => {
      if (!batchItemId || !event || typeof event !== "object") return;
      event.batchMode = true;
      event.batchItemId = batchItemId;
      updateUploadBatchFromBackend(event, batchItemId);
    },
  });
  job._batchItemId = batchItemId;
  currentJob = job;


  job.on("close", (code) => {
    if (uploadStopRequested) {
      writeLog("上传任务已由用户停止");
    } else if (code !== 0) {
      writeLog(`上传任务异常退出，代码: ${code}`, "error");
      const failedEvent = { type: "failed", code };
      if (batchItemId) {
        failedEvent.batchMode = true;
        failedEvent.batchItemId = batchItemId;
        updateUploadBatchFromBackend(failedEvent, batchItemId);
      }
      send("backend:event", failedEvent);
    } else if (job._backendAuthRequired) {
      writeLog("Suno 登录恢复失败，上传任务已释放，等待用户重新登录", "warn");
    } else if (job._backendFailed) {
      writeLog("上传任务失败结束");
    } else {
      writeLog("上传任务正常结束");
    }
    if (currentJob === job) currentJob = null;
    if (typeof options.onClose === "function") {
      try { options.onClose({ code, job, stopped: uploadStopRequested }); } catch (error) {
        writeLog(`批量队列收尾失败: ${error.message || error}`, "error");
      }
    }
  });
  return { ok: true, batchItemId };
}

function finishUploadBatchItem(itemId, outcome = {}) {
  const queue = getUploadBatchQueue();
  const item = queue.state.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  if (isQuitting) {
    queue.updateItem(itemId, {
      status: "pending",
      progress: 0,
      message: "软件重启后等待继续",
      error: "",
    }, false);
    queue.state.status = "paused";
    queue.state.currentItemId = "";
    queue.state.pauseRequested = false;
    queue.save();
    return;
  }
  queue.state.currentItemId = "";

  if (queue.state.status === "cancelled") {
    if (!["completed", "failed"].includes(item.status)) {
      queue.updateItem(itemId, { status: "cancelled", message: "队列已停止", completedAt: new Date().toISOString() }, false);
    }
  } else if (item.status === "waiting_login" || outcome.job?._backendAuthRequired) {
    queue.updateItem(itemId, { status: "waiting_login", message: "等待重新登录 Suno" }, false);
    queue.state.status = "waiting_login";
  } else if (!["completed", "failed"].includes(item.status)) {
    queue.updateItem(itemId, {
      status: "failed",
      message: "上传任务未正常完成",
      error: outcome.stopped ? "任务已停止" : `后端退出码 ${outcome.code ?? "unknown"}`,
      completedAt: new Date().toISOString(),
    }, false);
  }

  if (queue.state.status === "pausing" || queue.state.pauseRequested) {
    queue.state.status = "paused";
    queue.state.pauseRequested = false;
  } else if (queue.state.status === "running" && !queue.nextPending()) {
    queue.state.status = "completed";
  }
  queue.save();
  emitUploadBatchState(queue.state.status === "completed" ? "completed" : "item-finished", { itemId });

  if (queue.state.status === "running") {
    clearUploadBatchAdvanceTimer();
    uploadBatchAdvanceTimer = setTimeout(() => {
      uploadBatchAdvanceTimer = null;
      startNextUploadBatchItem().catch((error) => {
        writeLog(`启动下一首批量歌曲失败: ${error.message || error}`, "error");
      });
    }, 3000);
  }
}

async function startNextUploadBatchItem() {
  const queue = getUploadBatchQueue();
  if (queue.state.status !== "running" || currentJob) return uploadBatchSnapshot();
  const item = queue.nextPending();
  if (!item) {
    queue.updateQueue({ status: "completed", currentItemId: "", pauseRequested: false });
    return emitUploadBatchState("completed");
  }

  queue.state.currentItemId = item.id;
  queue.updateItem(item.id, {
    status: "preparing",
    progress: 2,
    message: "正在校验并创建新项目",
    error: "",
    startedAt: new Date().toISOString(),
  }, false);
  queue.save();
  emitUploadBatchState("item-started", { itemId: item.id });

  const result = await launchUploadTask(item, {
    batchItemId: item.id,
    forceNew: true,
    licenseChecked: true,
    onClose: (outcome) => finishUploadBatchItem(item.id, outcome),
  });
  if (result.ok) return uploadBatchSnapshot();

  queue.state.currentItemId = "";
  if (result.code === "suno_login_required") {
    queue.updateItem(item.id, {
      status: "waiting_login",
      message: "等待重新登录 Suno",
      error: result.message || "Suno Token 已失效",
    }, false);
    queue.state.status = "waiting_login";
  } else {
    queue.updateItem(item.id, {
      status: "failed",
      message: "未能启动上传",
      error: result.message || "上传启动失败",
      completedAt: new Date().toISOString(),
    }, false);
    if (!queue.nextPending()) queue.state.status = "completed";
  }
  queue.save();
  emitUploadBatchState(queue.state.status === "completed" ? "completed" : "item-finished", {
    itemId: item.id,
    error: result.message || "",
  });
  if (queue.state.status === "running") {
    uploadBatchAdvanceTimer = setTimeout(() => {
      uploadBatchAdvanceTimer = null;
      startNextUploadBatchItem().catch(() => {});
    }, 3000);
  }
  return uploadBatchSnapshot();
}

ipcMain.handle("upload:start", async (_event, payload) => {
  if (isUploadBatchActive()) return { ok: false, message: "批量上传队列正在运行" };
  return launchUploadTask(payload);
});

ipcMain.handle("upload:batch-state", async () => ({ ok: true, queue: uploadBatchSnapshot() }));

ipcMain.handle("upload:batch-save", async (_event, payload = {}) => {
  const queue = getUploadBatchQueue();
  if (ACTIVE_QUEUE_STATUSES.has(queue.state.status) || currentJob?._batchItemId) {
    return { ok: false, message: "队列运行中，暂时不能修改歌曲顺序。" };
  }
  const items = validBatchItems(payload.items);
  const snapshot = queue.replace(items);
  emitUploadBatchState("saved");
  return { ok: true, queue: snapshot };
});

ipcMain.handle("upload:batch-start", async (_event, payload = {}) => {
  if (currentJob) return { ok: false, message: "已有任务正在运行" };
  const license = await requireActiveLicense("suno_upload", "批量上传 Suno", { forceOnline: true });
  if (!license.ok) return license;
  const queue = getUploadBatchQueue();
  if (Array.isArray(payload.items)) {
    const items = validBatchItems(payload.items);
    if (items.length) queue.replace(items);
  }
  if (!queue.state.items.length) return { ok: false, message: "请先添加要上传的歌曲。" };

  queue.state.items.forEach((item) => {
    if (["failed", "cancelled", "waiting_login"].includes(item.status)) {
      item.status = "pending";
      item.progress = 0;
      item.message = "等待上传";
      item.error = "";
    }
  });
  if (!queue.nextPending()) return { ok: false, message: "队列中没有等待上传的歌曲。" };
  queue.updateQueue({ status: "running", pauseRequested: false, currentItemId: "" });
  emitUploadBatchState("started");
  setImmediate(() => startNextUploadBatchItem().catch((error) => {
    writeLog(`批量上传启动失败: ${error.message || error}`, "error");
  }));
  return { ok: true, queue: uploadBatchSnapshot() };
});

ipcMain.handle("upload:batch-pause", async () => {
  const queue = getUploadBatchQueue();
  clearUploadBatchAdvanceTimer();
  if (currentJob?._batchItemId) {
    queue.updateQueue({ status: "pausing", pauseRequested: true });
  } else {
    queue.updateQueue({ status: "paused", pauseRequested: false });
  }
  emitUploadBatchState("paused-requested");
  return { ok: true, queue: uploadBatchSnapshot() };
});

ipcMain.handle("upload:batch-resume", async () => {
  const queue = getUploadBatchQueue();
  if (currentJob) return { ok: false, message: "已有任务正在运行" };
  const license = await requireActiveLicense("suno_upload", "继续批量上传 Suno", { forceOnline: true });
  if (!license.ok) return license;
  const waiting = queue.state.items.find((item) => item.status === "waiting_login");
  if (waiting) {
    queue.updateItem(waiting.id, { status: "pending", progress: 0, message: "等待重新上传", error: "" }, false);
  }
  if (!queue.nextPending()) return { ok: false, message: "队列中没有可以继续的歌曲。" };
  queue.updateQueue({ status: "running", pauseRequested: false, currentItemId: "" });
  emitUploadBatchState("resumed");
  setImmediate(() => startNextUploadBatchItem().catch(() => {}));
  return { ok: true, queue: uploadBatchSnapshot() };
});

ipcMain.handle("upload:batch-retry-item", async (_event, payload = {}) => {
  const queue = getUploadBatchQueue();
  if (ACTIVE_QUEUE_STATUSES.has(queue.state.status) || currentJob) {
    return { ok: false, message: "请先暂停队列，再重试单首歌曲。" };
  }
  const snapshot = queue.retryItem(String(payload.itemId || ""));
  emitUploadBatchState("item-retried", { itemId: String(payload.itemId || "") });
  return { ok: true, queue: snapshot };
});

ipcMain.handle("upload:batch-cancel", async () => {
  const queue = getUploadBatchQueue();
  clearUploadBatchAdvanceTimer();
  queue.state.status = "cancelled";
  queue.state.pauseRequested = false;
  queue.state.items.forEach((item) => {
    if (item.status === "pending") {
      item.status = "cancelled";
      item.message = "队列已停止";
      item.completedAt = new Date().toISOString();
    }
  });
  queue.save();
  if (currentJob?._batchItemId) {
    uploadStopRequested = true;
    if (uploadCancelFile) {
      try { fs.writeFileSync(uploadCancelFile, String(Date.now()), "utf8"); } catch (_) {}
    }
    if (process.platform === "win32" && currentJob.pid) {
      spawn("taskkill", ["/pid", String(currentJob.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { currentJob.kill("SIGTERM"); } catch (_) {}
    }
  }
  emitUploadBatchState("cancelled");
  return { ok: true, queue: uploadBatchSnapshot() };
});

ipcMain.handle("upload:clear-segments", async (_event, payload = {}) => {
  if (currentJob) return { ok: false, message: "上传进行中，不能清除切片" };
  const workDir = payload && payload.workDir ? String(payload.workDir) : "";
  const args = ["--clear-segments"];
  if (workDir) args.push(workDir);
  try {
    return await runBackendJson(args);
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});

ipcMain.handle("job:stop", async () => {
  if (!currentJob) return { ok: true };
  const job = currentJob;
  uploadStopRequested = true;
  try {
    if (uploadCancelFile) {
      try { fs.writeFileSync(uploadCancelFile, String(Date.now()), "utf8"); } catch (_) {}
    }
    if (process.platform === "win32" && job.pid) {
      spawn("taskkill", ["/pid", String(job.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { job.kill("SIGTERM"); } catch (_) {}
    }
    currentJob = null;
    send("backend:event", {
      type: "cancelled",
      message: "已终止当前上传任务。下次上传同一音频将尝试续传，必要时会自动重新开始。"
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle("history:list", async () => runBackendJson(["--history"]));
ipcMain.handle("history:clear", async () => runBackendJson(["--clear-history"]));

ipcMain.handle("lyrics:process", async (_event, payload) => {
  const license = await requireActiveLicense("lyrics_process", "歌词处理");
  if (!license.ok) return license;
  return runBackendJson(["--lyrics-mode", payload.mode, "--lyrics", payload.text || ""]);
});

for (const channel of ['license:check','license:status','license:startup-verify','account:status']) {
  ipcMain.handle(channel, () => getCommercialClient().status());
}
ipcMain.handle('account:submit-login', (_event, payload) => getCommercialClient().login(payload));
ipcMain.handle('account:register', (_event, payload) => getCommercialClient().register(payload));
ipcMain.handle('account:logout', () => getCommercialClient().logout());
ipcMain.handle('account:login', () => { send('commercial:open', {}); return {ok:true}; });
ipcMain.handle('commercial:plans', () => getCommercialClient().call('/v1/plans'));
ipcMain.handle('commercial:order', async (_event, payload) => {
  const result = await getCommercialClient().call('/v1/orders', {plan:'standard', provider:payload?.provider});
  if (!result.ok) return result;
  const qrImage = await require('qrcode').toDataURL(result.qr, {width:256, margin:2});
  return {...result, qrImage};
});
ipcMain.handle('commercial:order-status', (_event, id) => getCommercialClient().call('/v1/orders/'+encodeURIComponent(String(id))));
for (const channel of ['account:login-preferences','account:send-email-code','account:reset-password','account:avatar-source','account:open-profile','account:open-store','app:register','update:check','update:mark-seen','announcements:list','announcements:mark-read']) {
  ipcMain.handle(channel, () => ({ok:false, message:'请使用期音账号管理；密码找回请联系管理员'}));
}

const UVR_RECOMMENDED_MODELS = [
  {
    filename: "4_HP-Vocal-UVR.pth",
    label: "4_HP-Vocal-UVR（默认快速）",
    shortLabel: "4_HP-Vocal-UVR",
    builtIn: true,
    default: true,
    quality: "快速",
    note: "包内默认小模型，速度快，适合普通伴奏/人声分离。"
  },
  {
    filename: "UVR-MDX-NET-Inst_HQ_4.onnx",
    label: "UVR-MDX-NET Inst HQ 4（高质量推荐）",
    shortLabel: "Inst HQ 4",
    quality: "高质量",
    note: "推荐高质量伴奏/人声分离，速度会比默认模型慢。"
  },
  {
    filename: "UVR-MDX-NET-Inst_HQ_3.onnx",
    label: "UVR-MDX-NET Inst HQ 3（高质量备用）",
    shortLabel: "Inst HQ 3",
    quality: "高质量",
    note: "高质量备用模型，适合与 HQ 4 对比效果。"
  },
  {
    filename: "Kim_Vocal_2.onnx",
    label: "Kim Vocal 2（人声提取备用）",
    shortLabel: "Kim Vocal 2",
    quality: "人声",
    note: "偏向人声提取，可作为人声更干净的备用方案。"
  },
  {
    filename: "UVR-MDX-NET-Voc_FT.onnx",
    label: "UVR-MDX-NET Voc FT（人声干净度备用）",
    shortLabel: "Voc FT",
    quality: "人声",
    note: "偏向人声干净度，可用于对比人声效果。"
  }
];

function uvrBuiltInModelDir() {
  return path.join(projectRoot(), "vendor", "uvr", "models", "VRArch_models");
}

function uvrUserModelDir() {
  return path.join(app.getPath("userData"), "uvr_models");
}

function safeModelByFilename(filename) {
  return UVR_RECOMMENDED_MODELS.find((item) => item.filename === filename) || null;
}

function uvrInstalledPath(model) {
  const userPath = path.join(uvrUserModelDir(), model.filename);
  if (fs.existsSync(userPath) && !userPath.endsWith(".part")) return userPath;
  const builtInPath = path.join(uvrBuiltInModelDir(), model.filename);
  if (fs.existsSync(builtInPath)) return builtInPath;
  return "";
}

function uvrModelList() {
  try { fs.mkdirSync(uvrUserModelDir(), { recursive: true }); } catch (_) {}
  return UVR_RECOMMENDED_MODELS.map((model) => {
    const installedPath = uvrInstalledPath(model);
    const source = installedPath
      ? (installedPath.startsWith(uvrUserModelDir()) ? "user" : "builtin")
      : "";
    let size = 0;
    if (installedPath) {
      try { size = fs.statSync(installedPath).size; } catch (_) {}
    }
    return {
      ...model,
      installed: Boolean(installedPath),
      installedPath,
      modelDir: installedPath ? path.dirname(installedPath) : "",
      source,
      size
    };
  });
}

const UVR_GPU_RUNTIME_FILENAME = process.platform === "win32" ? "uvr_worker_gpu.exe" : "uvr_worker_gpu";
const UVR_GPU_RUNTIME_DIRNAME = "gpu-v406";
const UVR_GPU_ARCHIVE_FILENAME = "悸风喵核Studio-NVIDIA-GPU加速组件-V4.0.6-x64.zip";
const UVR_GPU_ARCHIVE_SHA256 = "A37059BD92F448FF96BB971981CBCFCE32136EC729F8E1153973003BF4ECA9ED";
const UVR_GPU_ARCHIVE_MIN_BYTES = 3_000_000_000;
const UVR_GPU_DOWNLOAD_URLS = [];

function uvrGpuRuntimeDir() {
  return path.join(app.getPath("userData"), "uvr_runtime");
}

function uvrGpuRuntimePath() {
  const candidates = [
    path.join(uvrGpuRuntimeDir(), UVR_GPU_RUNTIME_DIRNAME, UVR_GPU_RUNTIME_FILENAME),
    path.join(path.dirname(process.execPath), "uvr_worker_gpu", UVR_GPU_RUNTIME_FILENAME),
    path.join(path.dirname(process.execPath), UVR_GPU_RUNTIME_FILENAME),
    path.join(projectRoot(), "backend", UVR_GPU_RUNTIME_FILENAME),
    path.join(projectRoot(), "dist", "uvr_worker_gpu", UVR_GPU_RUNTIME_FILENAME),
    path.join(projectRoot(), "dist", UVR_GPU_RUNTIME_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      const size = fs.statSync(candidate).size;
      const directoryRuntime = fs.existsSync(path.join(path.dirname(candidate), "_internal"));
      if ((directoryRuntime && size > 100 * 1024) || size > 50 * 1024 * 1024) return candidate;
    } catch (_) {}
  }
  return "";
}

function localGpuRuntimeArchive() {
  const explicit = String(process.env.GAOBAI_GPU_RUNTIME_ARCHIVE || "").trim();
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  const candidates = [
    explicit,
    portableDir ? path.join(portableDir, UVR_GPU_ARCHIVE_FILENAME) : "",
    path.join(path.dirname(process.execPath), UVR_GPU_ARCHIVE_FILENAME),
    path.resolve(path.dirname(process.execPath), "..", UVR_GPU_ARCHIVE_FILENAME),
    path.join(app.getPath("downloads"), UVR_GPU_ARCHIVE_FILENAME),
    path.join(projectRoot(), UVR_GPU_ARCHIVE_FILENAME),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).size >= UVR_GPU_ARCHIVE_MIN_BYTES; } catch (_) { return false; }
  }) || "";
}

function gpuRuntimeArchiveDownloadPath() {
  return path.join(uvrGpuRuntimeDir(), "downloads", UVR_GPU_ARCHIVE_FILENAME);
}

function sendGpuRuntimeEvent(status, payload = {}) {
  send("separation:event", {
    type: "gpu-runtime-download",
    status,
    ...payload,
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function downloadGpuRuntimeArchive(url, targetPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      gpuRuntimeDownloadJob = null;
      reject(error);
    };
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const partPath = `${targetPath}.part`;
    const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    const parsed = new URL(url);
    const lib = parsed.protocol === "http:" ? http : https;
    const headers = { "User-Agent": "QiyinSunoUploader/5.0.0" };
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    const req = lib.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 6) {
        res.resume();
        finishResolve(downloadGpuRuntimeArchive(new URL(res.headers.location, url).toString(), targetPath, redirectCount + 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finishReject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const append = existing > 0 && res.statusCode === 206;
      const downloadedBefore = append ? existing : 0;
      const responseBytes = Number(res.headers["content-length"]) || 0;
      const total = responseBytes ? downloadedBefore + responseBytes : 0;
      let downloaded = downloadedBefore;
      let lastProgressAt = 0;
      const out = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
      gpuRuntimeDownloadJob = { req, out, partPath };
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt < 250 && downloaded < total) return;
        lastProgressAt = now;
        sendGpuRuntimeEvent("progress", {
          downloaded,
          total,
          percent: total > 0 ? Math.min(99, Math.round(downloaded / total * 100)) : 0,
          message: "正在下载 NVIDIA GPU 加速组件",
        });
      });
      res.on("error", (error) => {
        try { out.destroy(); } catch (_) {}
        finishReject(error);
      });
      res.on("aborted", () => {
        try { out.destroy(); } catch (_) {}
        finishReject(new Error("GPU component download connection was interrupted"));
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => {
        gpuRuntimeDownloadJob = null;
        try {
          const size = fs.statSync(partPath).size;
          if (size < UVR_GPU_ARCHIVE_MIN_BYTES) throw new Error("GPU组件下载文件不完整");
          try { fs.unlinkSync(targetPath); } catch (_) {}
          fs.renameSync(partPath, targetPath);
          finishResolve(targetPath);
        } catch (error) {
          finishReject(error);
        }
      }));
      out.on("error", (error) => {
        finishReject(error);
      });
    });
    gpuRuntimeDownloadJob = { req, partPath };
    req.on("error", (error) => {
      finishReject(error);
    });
    req.setTimeout(120000, () => req.destroy(new Error("GPU组件下载连接超时")));
  });
}

async function extractGpuRuntimeArchive(archivePath) {
  const runtimeRoot = uvrGpuRuntimeDir();
  const extractDir = path.join(runtimeRoot, "gpu-extract.part");
  const targetDir = path.join(runtimeRoot, UVR_GPU_RUNTIME_DIRNAME);
  await fs.promises.rm(extractDir, { recursive: true, force: true });
  await fs.promises.mkdir(extractDir, { recursive: true });
  sendGpuRuntimeEvent("extracting", { message: "正在安装 NVIDIA GPU 加速组件" });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("tar.exe", ["-xf", archivePath, "-C", extractDir], { windowsHide: true });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => { stderr += text; });
      gpuRuntimeDownloadJob = { child, extractDir };
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `解压退出代码 ${code}`)));
    });
  } catch (error) {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
    throw error;
  } finally {
    gpuRuntimeDownloadJob = null;
  }
  const extractedDir = path.join(extractDir, "uvr_worker_gpu");
  const executable = path.join(extractedDir, UVR_GPU_RUNTIME_FILENAME);
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(extractedDir, "_internal"))) {
    throw new Error("GPU组件压缩包结构不完整");
  }
  sendGpuRuntimeEvent("verifying", { message: "正在验证 CUDA 运行环境" });
  const info = await runExecutableJson(executable, ["--device-info"], 120000);
  if (!info.cudaAvailable) throw new Error("当前电脑没有可用的 NVIDIA CUDA 环境");
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.rename(extractedDir, targetDir);
  await fs.promises.rm(extractDir, { recursive: true, force: true });
  await fs.promises.rm(path.join(runtimeRoot, "gpu"), { recursive: true, force: true });
  return { ...info, runtimePath: path.join(targetDir, UVR_GPU_RUNTIME_FILENAME) };
}

async function installGpuRuntimeAutomatically() {
  gpuRuntimeInstallCancelled = false;
  const existingRuntime = uvrGpuRuntimePath();
  if (existingRuntime) {
    const info = await runExecutableJson(existingRuntime, ["--device-info"], 120000);
    return { ok: true, alreadyInstalled: true, ...info, runtimePath: existingRuntime };
  }
  fs.mkdirSync(uvrGpuRuntimeDir(), { recursive: true });
  try {
    const disk = fs.statfsSync(uvrGpuRuntimeDir());
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (freeBytes < 9_000_000_000) throw new Error("安装GPU组件至少需要9GB可用磁盘空间");
  } catch (error) {
    if (/至少需要9GB/.test(String(error.message || ""))) throw error;
  }
  let archivePath = localGpuRuntimeArchive();
  let downloadedArchive = false;
  if (!archivePath) {
    const targetPath = gpuRuntimeArchiveDownloadPath();
    const errors = [];
    for (const url of UVR_GPU_DOWNLOAD_URLS) {
      try {
        sendGpuRuntimeEvent("starting", { message: "正在连接 GPU 组件下载服务器" });
        archivePath = await downloadGpuRuntimeArchive(url, targetPath);
        downloadedArchive = true;
        break;
      } catch (error) {
        if (/用户取消/.test(String(error.message || ""))) {
          return { ok: false, cancelled: true, message: "GPU组件下载已取消" };
        }
        errors.push(error.message || String(error));
      }
    }
    if (!archivePath) throw new Error(`GPU组件下载失败：${errors.join("；")}`);
  } else {
    sendGpuRuntimeEvent("starting", { message: "正在读取 GPU 加速组件" });
  }
  sendGpuRuntimeEvent("verifying", { message: "正在校验 GPU 组件完整性" });
  const hash = await sha256File(archivePath);
  if (hash !== UVR_GPU_ARCHIVE_SHA256) {
    if (downloadedArchive) try { fs.unlinkSync(archivePath); } catch (_) {}
    throw new Error("GPU组件完整性校验失败，请重新下载");
  }
  const result = await extractGpuRuntimeArchive(archivePath);
  if (downloadedArchive) try { fs.unlinkSync(archivePath); } catch (_) {}
  sendGpuRuntimeEvent("complete", {
    percent: 100,
    gpuName: result.gpuName || "NVIDIA GPU",
    message: "GPU加速组件安装完成",
  });
  return { ok: true, ...result };
}

function runExecutableJson(executable, args = [], timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot(),
      env: backendEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error("GPU 组件检测超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => { stdout += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const result = JSON.parse(lines[lines.length - 1] || "{}");
        if (code !== 0 || !result.ok) throw new Error(result.message || stderr.trim() || `退出代码 ${code}`);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function detectVideoControllers() {
  if (process.platform !== "win32") return [];
  const script = [
    "Get-CimInstance Win32_VideoController",
    "Select-Object Name,AdapterRAM,DriverVersion",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text) => { stdout += text; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`GPU 检测退出代码 ${code}`)));
    });
    const parsed = JSON.parse(String(result || "[]"));
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((item) => ({
      name: String(item.Name || "未知显卡"),
      memory: Number(item.AdapterRAM || 0),
      driverVersion: String(item.DriverVersion || ""),
      nvidia: /nvidia/i.test(String(item.Name || "")),
    }));
  } catch (error) {
    writeLog(`显卡检测失败: ${error.message}`, "warn");
    return [];
  }
}

async function separationDeviceStatus() {
  const controllers = await detectVideoControllers();
  const gpuRuntime = uvrGpuRuntimePath();
  return {
    ok: true,
    modes: ["auto", "cuda", "cpu"],
    controllers,
    hasNvidiaGpu: controllers.some((item) => item.nvidia),
    gpuRuntimeInstalled: Boolean(gpuRuntime),
    gpuRuntimePath: gpuRuntime,
  };
}

function directModelSources(filename) {
  const encoded = encodeURIComponent(filename);
  return [
    {
      name: "HF-Mirror",
      url: `https://hf-mirror.com/Blane187/all_public_uvr_models/resolve/main/${encoded}`,
      type: "direct"
    },
    {
      name: "CNB",
      url: `https://cnb.cool/vjhfjyf/all_public_uvr_models/-/blob/main/${encoded}`,
      type: "cnb"
    },
    {
      name: "HuggingFace",
      url: `https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/${encoded}`,
      type: "direct"
    }
  ];
}

function requestText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.get(url, { headers: { "User-Agent": "QiyinSunoUploader/5.0.0" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
        res.resume();
        resolve(requestText(new URL(res.headers.location, url).toString(), redirectCount + 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("请求超时"));
    });
  });
}

async function resolveCnbModelUrl(source, filename) {
  const html = await requestText(source.url);
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hrefRegex = new RegExp(`href=["']([^"']*(?:raw|download)[^"']*${escaped}[^"']*)["']`, "i");
  const match = html.match(hrefRegex);
  if (match && match[1]) {
    return new URL(match[1].replace(/&amp;/g, "&"), source.url).toString();
  }
  return `https://cnb.cool/vjhfjyf/all_public_uvr_models/-/raw/main/${encodeURIComponent(filename)}`;
}

function downloadFileWithResume(url, targetPath, sourceName, filename) {
  return new Promise((resolve, reject) => {
    const partPath = `${targetPath}.part`;
    const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    const parsed = new URL(url);
    const lib = parsed.protocol === "http:" ? http : https;
    const headers = { "User-Agent": "QiyinSunoUploader/5.0.0" };
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    const req = lib.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(downloadFileWithResume(new URL(res.headers.location, url).toString(), targetPath, sourceName, filename));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const contentType = String(res.headers["content-type"] || "").toLowerCase();
      if (contentType.includes("text/html")) {
        res.resume();
        reject(new Error("下载源返回 HTML 页面"));
        return;
      }
      const append = existing > 0 && res.statusCode === 206;
      const downloadedBefore = append ? existing : 0;
      const totalHeader = Number(res.headers["content-length"]) || 0;
      const total = totalHeader ? downloadedBefore + totalHeader : 0;
      let downloaded = downloadedBefore;
      const out = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
      separationDownloadJob = { req, partPath, out };
      send("separation:event", {
        type: "model-download",
        status: "source",
        model: filename,
        source: sourceName,
        message: `正在从 ${sourceName} 下载模型`
      });
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          send("separation:event", {
            type: "model-download",
            status: "progress",
            model: filename,
            source: sourceName,
            downloaded,
            total,
            percent: Math.min(99, Math.round((downloaded / total) * 100))
          });
        }
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          try {
            const stats = fs.statSync(partPath);
            if (stats.size < 1024 * 1024) {
              throw new Error("模型文件小于 1MB，疑似下载失败");
            }
            fs.renameSync(partPath, targetPath);
            separationDownloadJob = null;
            resolve({ ok: true, path: targetPath, size: stats.size });
          } catch (error) {
            separationDownloadJob = null;
            reject(error);
          }
        });
      });
      out.on("error", (error) => {
        separationDownloadJob = null;
        reject(error);
      });
    });
    separationDownloadJob = { req, partPath };
    req.on("error", (error) => {
      separationDownloadJob = null;
      reject(error);
    });
    req.setTimeout(120000, () => {
      req.destroy(new Error("下载超时"));
    });
  });
}

async function downloadUvrModel(filename) {
  const model = safeModelByFilename(filename);
  if (!model || model.builtIn) {
    return { ok: false, message: "该模型不需要下载或不在白名单内" };
  }
  const installed = uvrInstalledPath(model);
  if (installed) {
    return { ok: true, alreadyInstalled: true, model: { ...model, installedPath: installed, modelDir: path.dirname(installed) } };
  }
  const targetDir = uvrUserModelDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, model.filename);
  const sources = directModelSources(model.filename);
  const errors = [];
  for (const source of sources) {
    try {
      const url = source.type === "cnb" ? await resolveCnbModelUrl(source, model.filename) : source.url;
      const result = await downloadFileWithResume(url, targetPath, source.name, model.filename);
      send("separation:event", {
        type: "model-download",
        status: "complete",
        model: model.filename,
        source: source.name,
        percent: 100,
        message: `${model.label} 下载完成`
      });
      return { ok: true, model: { ...model, installedPath: result.path, modelDir: targetDir, size: result.size } };
    } catch (error) {
      if (String(error.message || "").includes("用户取消下载")) {
        try { fs.unlinkSync(`${targetPath}.part`); } catch (_) {}
        return { ok: false, cancelled: true, message: "模型下载已取消" };
      }
      errors.push(`${source.name}: ${error.message}`);
      send("separation:event", {
        type: "model-download",
        status: "retry",
        model: model.filename,
        source: source.name,
        message: `${source.name} 下载失败，尝试下一个源：${error.message}`
      });
    }
  }
  try { fs.unlinkSync(`${targetPath}.part`); } catch (_) {}
  return { ok: false, message: `模型下载失败：${errors.join("；")}` };
}

ipcMain.handle("separation:models", async () => ({
  ok: true,
  models: uvrModelList(),
  defaultModel: "4_HP-Vocal-UVR.pth",
  userModelDir: uvrUserModelDir(),
  builtInModelDir: uvrBuiltInModelDir()
}));

ipcMain.handle("separation:download-model", async (_event, payload = {}) => {
  if (separationDownloadJob) return { ok: false, message: "已有模型正在下载" };
  return downloadUvrModel(String(payload.filename || ""));
});
ipcMain.handle('account:devices', () => getCommercialClient().call('/v1/devices'));
ipcMain.handle('account:unbind-device', (_event, payload) => getCommercialClient().call('/v1/devices/'+encodeURIComponent(String(payload?.devicePublicId)), undefined, 'DELETE'));

ipcMain.handle("separation:devices", async () => separationDeviceStatus());

ipcMain.handle("separation:install-gpu-runtime", async () => {
  if (separationJob) return { ok: false, message: "请等待当前分离任务结束后再安装 GPU 组件" };
  if (gpuRuntimeDownloadJob) return { ok: false, message: "GPU组件正在下载安装" };
  try {
    const result = await installGpuRuntimeAutomatically();
    writeLog(`GPU 分离组件安装完成: ${result.gpuName || result.runtimePath}`);
    return result;
  } catch (error) {
    if (gpuRuntimeInstallCancelled || /用户取消/.test(String(error.message || ""))) {
      sendGpuRuntimeEvent("cancelled", { message: "GPU组件下载安装已取消" });
      return { ok: false, cancelled: true, message: "GPU组件下载安装已取消" };
    }
    writeLog(`GPU 分离组件安装失败: ${error.message}`, "error");
    sendGpuRuntimeEvent("error", { message: error.message || "GPU组件安装失败" });
    return { ok: false, message: `GPU 组件安装失败：${error.message}` };
  }
});

function launchSeparationWorker(task, useGpu, allowCpuFallback) {
  const gpuRuntime = useGpu ? uvrGpuRuntimePath() : "";
  const spec = useGpu
    ? { command: gpuRuntime, prefixArgs: [] }
    : pythonScriptExecutable("uvr_worker");
  const child = spawn(spec.command, [
    ...spec.prefixArgs,
    "--source", task.sourcePath,
    "--model-filename", task.model.filename,
    "--model-label", task.model.label,
    "--model-dir", path.dirname(task.installedPath),
    "--device", useGpu ? "cuda" : "cpu",
  ], {
    cwd: projectRoot(),
    env: backendEnv(),
    windowsHide: true,
  });
  separationJob = child;
  child._separationError = "";
  child._separationResult = false;

  const emitLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const level = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "info";
      writeLog(`[separation:${event.type || "event"}] ${event.message || line}`, level);
      if (event.type === "error") child._separationError = String(event.message || "GPU 分离失败");
      if (event.type === "result") child._separationResult = true;
      const suppressForFallback = useGpu && allowCpuFallback && (
        event.type === "error" || (event.type === "log" && event.level === "error")
      );
      if (!suppressForFallback) send("separation:event", event);
    } catch (_) {
      writeLog(`[separation:stdout] ${line}`);
      send("separation:event", { type: "log", message: line });
    }
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(emitLine);
  });
  child.stderr.on("data", (text) => {
    String(text).split(/\r?\n/).forEach((line) => {
      const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
      if (!clean || /^\d+%\|/.test(clean)) return;
      writeLog(`[separation:stderr] ${clean}`, "warn");
    });
  });
  child.on("error", (error) => {
    child._separationError = error.message || String(error);
    writeLog(`[separation:spawn] ${child._separationError}`, "error");
  });
  child.on("close", (code) => {
    if (buffer.trim()) emitLine(buffer);
    const failed = code !== 0 || Boolean(child._separationError) || !child._separationResult;
    writeLog(
      `[separation:close] ${useGpu ? "GPU" : "CPU"} worker exited with code ${code}, result=${child._separationResult}`,
      failed ? "error" : "info"
    );
    if (separationJob === child) separationJob = null;
    if (separationCancelRequested) return;
    if (failed && useGpu && allowCpuFallback) {
      const reason = child._separationError || `GPU 组件退出代码 ${code}`;
      writeLog(`GPU 分离失败，自动回退 CPU: ${reason}`, "warn");
      send("separation:event", {
        type: "device-fallback",
        from: "cuda",
        to: "cpu",
        reason,
        message: "GPU 加速不可用，已自动切换 CPU 继续处理",
      });
      launchSeparationWorker(task, false, false);
      return;
    }
    if (failed && !child._separationError) {
      send("separation:event", { type: "failed", code, message: `${useGpu ? "GPU" : "CPU"} 分离进程异常结束` });
    }
  });
}

ipcMain.handle("separation:start", async (_event, payload) => {
  if (separationJob) return { ok: false, message: "已有分离任务正在运行" };
  if (!payload || !payload.sourcePath) return { ok: false, message: "请先选择音频" };
  const requestedModel = safeModelByFilename(payload.modelFilename || "4_HP-Vocal-UVR.pth") || UVR_RECOMMENDED_MODELS[0];
  const installedPath = uvrInstalledPath(requestedModel);
  if (!installedPath) return { ok: false, message: "该分离模型尚未下载，请先点击下载模型。" };

  const requestedDevice = ["auto", "cuda", "cpu"].includes(payload.deviceMode) ? payload.deviceMode : "auto";
  const gpuRuntime = uvrGpuRuntimePath();
  if (requestedDevice === "cuda" && !gpuRuntime) {
    return { ok: false, code: "gpu_runtime_required", message: "尚未安装 NVIDIA GPU 加速组件" };
  }
  const useGpu = requestedDevice === "cuda" || (requestedDevice === "auto" && Boolean(gpuRuntime));
  separationCancelRequested = false;
  launchSeparationWorker({
    sourcePath: payload.sourcePath,
    model: requestedModel,
    installedPath,
  }, useGpu, useGpu);
  return { ok: true, requestedDevice, activeDevice: useGpu ? "cuda" : "cpu" };
});

ipcMain.handle("separation:cancel", async () => {
  if (gpuRuntimeDownloadJob) {
    const job = gpuRuntimeDownloadJob;
    gpuRuntimeInstallCancelled = true;
    gpuRuntimeDownloadJob = null;
    try { if (job.req) job.req.destroy(new Error("用户取消GPU组件下载")); } catch (_) {}
    try { if (job.out) job.out.destroy(); } catch (_) {}
    try { if (job.child) job.child.kill(); } catch (_) {}
    try { if (job.extractDir) fs.rmSync(job.extractDir, { recursive: true, force: true }); } catch (_) {}
    sendGpuRuntimeEvent("cancelled", { message: "GPU组件下载安装已取消" });
    return { ok: true };
  }
  if (separationDownloadJob) {
    const job = separationDownloadJob;
    separationDownloadJob = null;
    try { if (job.req) job.req.destroy(new Error("用户取消下载")); } catch (_) {}
    try { if (job.out) job.out.destroy(); } catch (_) {}
    try { if (job.partPath) fs.unlinkSync(job.partPath); } catch (_) {}
    send("separation:event", { type: "model-download", status: "cancelled", message: "模型下载已取消" });
    return { ok: true };
  }
  if (!separationJob) return { ok: true };
  try {
    separationCancelRequested = true;
    separationJob.kill();
    separationJob = null;
    send("separation:event", { type: "cancelled" });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle("editor:preview-window", async (_event, payload) => {
  const license = await requireActiveLicense("audio_editor_preview", "音频剪辑预览");
  if (!license.ok) return license;
  if (!payload || !payload.sourcePath || !fs.existsSync(payload.sourcePath)) {
    return { ok: false, message: "请先选择要预览的音频" };
  }

  if (editorPreviewJob) {
    try { editorPreviewJob.kill(); } catch (_) {}
    editorPreviewJob = null;
  }

  const start = Math.max(0, safeNumber(payload.start, 0));
  const end = Math.max(start + 0.25, safeNumber(payload.end, start + 10));
  const duration = Math.max(0.25, end - start);
  const fadeIn = Math.max(0, Math.min(duration / 2, safeNumber(payload.fadeIn, 0)));
  const fadeOut = Math.max(0, Math.min(duration / 2, safeNumber(payload.fadeOut, 0)));
  const volume = Math.max(0.05, Math.min(3, safeNumber(payload.volume, 1)));
  const pitchSemitones = Math.max(-12, Math.min(12, safeNumber(payload.pitch, 0)));
  const pitchCents = Math.max(-100, Math.min(100, safeNumber(payload.cents, 0)));
  const tempoRatio = Math.max(0.5, Math.min(2, safeNumber(payload.tempo, 1)));
  const totalSemitones = pitchSemitones + pitchCents / 100;
  const sourceStat = fs.statSync(payload.sourcePath);
  const cacheDir = path.join(app.getPath("userData"), "editor-preview-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheKey = crypto.createHash("sha1").update(JSON.stringify({
    sourcePath: path.resolve(payload.sourcePath),
    sourceSize: sourceStat.size,
    sourceMtime: Math.round(sourceStat.mtimeMs),
    start: start.toFixed(3),
    end: end.toFixed(3),
    fadeIn: fadeIn.toFixed(3),
    fadeOut: fadeOut.toFixed(3),
    volume: volume.toFixed(3),
    pitch: totalSemitones.toFixed(3),
    tempo: tempoRatio.toFixed(3),
  })).digest("hex");
  const outputPath = path.join(cacheDir, `${cacheKey}.wav`);
  if (fs.existsSync(outputPath)) {
    return { ok: true, outputPath, outputDir: cacheDir, start, end, duration, cached: true, pitch: totalSemitones, tempo: tempoRatio };
  }

  const spec = pythonScriptExecutable("audio_editor");
  const args = [
    ...spec.prefixArgs,
    "--source", payload.sourcePath,
    "--output", outputPath,
    "--start", start.toFixed(3),
    "--end", end.toFixed(3),
    "--fade-in", fadeIn.toFixed(3),
    "--fade-out", fadeOut.toFixed(3),
    "--volume", volume.toFixed(3),
    "--pitch", totalSemitones.toFixed(3),
    "--tempo", tempoRatio.toFixed(3),
  ];

  writeLog(`瀹炴椂棰勮绐楀彛: source=${payload.sourcePath}, start=${start}, end=${end}, volume=${volume}, pitch=${totalSemitones}, tempo=${tempoRatio}`);
  return new Promise((resolve) => {
    const child = spawn(spec.command, args, {
      cwd: projectRoot(),
      env: backendEnv(),
      windowsHide: true,
    });
    editorPreviewJob = child;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => { stdout += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    child.on("error", (error) => {
      if (editorPreviewJob === child) editorPreviewJob = null;
      resolve({ ok: false, message: error.message });
    });
    child.on("close", (code) => {
      if (editorPreviewJob === child) editorPreviewJob = null;
      if (stdout.trim()) writeLog(`preview audio_editor stdout: ${stdout.trim()}`);
      if (stderr.trim()) writeLog(`preview audio_editor stderr: ${stderr.trim()}`, "error");
      if (code !== 0 || !fs.existsSync(outputPath)) {
        resolve({ ok: false, message: stderr.trim() || stdout.trim() || `audio_editor exited ${code}` });
        return;
      }
      resolve({ ok: true, outputPath, outputDir: cacheDir, start, end, duration, log: stdout.trim(), stderr: stderr.trim(), pitch: totalSemitones, tempo: tempoRatio });
    });
  });
});

ipcMain.handle("editor:detect-bpm", async (_event, payload = {}) => {
  const sourcePath = String(payload.sourcePath || "");
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, message: "请选择可读取的音频文件" };
  }
  const stat = fs.statSync(sourcePath);
  const cacheKey = `${path.resolve(sourcePath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  if (editorBpmCache.has(cacheKey)) {
    return { ok: true, bpm: editorBpmCache.get(cacheKey), cached: true };
  }
  const spec = pythonScriptExecutable("audio_editor");
  const args = [...spec.prefixArgs, "--source", sourcePath, "--detect-bpm"];
  writeLog(`BPM 自动分析: source=${sourcePath}`);
  return new Promise((resolve) => {
    const child = spawn(spec.command, args, {
      cwd: projectRoot(),
      env: backendEnv(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, message: "BPM 分析超时，可手动输入 BPM" });
    }, 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => { stdout += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    child.on("error", (error) => finish({ ok: false, message: error.message }));
    child.on("close", (code) => {
      if (settled) return;
      const result = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .map((line) => {
          try { return JSON.parse(line); } catch (_) { return null; }
        })
        .find((event) => event?.type === "result");
      const bpm = Number(result?.bpm);
      if (code !== 0 || !result?.ok || !Number.isFinite(bpm)) {
        writeLog(`BPM 分析失败: source=${sourcePath}, stderr=${stderr.trim()}, stdout=${stdout.trim()}`, "error");
        finish({ ok: false, message: result?.error || stderr.trim() || "未能识别歌曲 BPM" });
        return;
      }
      editorBpmCache.set(cacheKey, bpm);
      writeLog(`BPM 分析完成: source=${sourcePath}, bpm=${bpm}`);
      finish({ ok: true, bpm, cached: false });
    });
  });
});

ipcMain.handle("editor:export", async (_event, payload) => {
  const license = await requireActiveLicense("audio_editor_export", "音频剪辑导出");
  if (!license.ok) return license;
  if (editorJob) return { ok: false, message: "已有音频剪辑任务正在运行" };
  if (!payload || !payload.sourcePath || !fs.existsSync(payload.sourcePath)) {
    return { ok: false, message: "请先选择要剪辑的音频" };
  }

  const fallbackStart = Math.max(0, safeNumber(payload.start, 0));
  const fallbackEnd = Math.max(fallbackStart + 0.1, safeNumber(payload.end, fallbackStart + 30));
  const requestedSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = requestedSegments
    .map((segment) => {
      const start = Math.max(0, safeNumber(segment?.start, -1));
      const end = Math.max(start, safeNumber(segment?.end, -1));
      return end - start >= 0.001 ? { start, end } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  if (!segments.length) segments.push({ start: fallbackStart, end: fallbackEnd });
  const start = segments[0].start;
  const end = segments.at(-1).end;
  const duration = Math.max(0.001, segments.reduce((total, segment) => total + (segment.end - segment.start), 0));
  const fadeIn = Math.max(0, Math.min(duration / 2, safeNumber(payload.fadeIn, 0)));
  const fadeOut = Math.max(0, Math.min(duration / 2, safeNumber(payload.fadeOut, 0)));
  const volume = Math.max(0.05, Math.min(3, safeNumber(payload.volume, 1)));
  const pitchSemitones = Math.max(-12, Math.min(12, safeNumber(payload.pitch, 0)));
  const pitchCents = Math.max(-100, Math.min(100, safeNumber(payload.cents, 0)));
  const tempoRatio = Math.max(0.5, Math.min(2, safeNumber(payload.tempo, 1)));
  const base = path.basename(payload.sourcePath, path.extname(payload.sourcePath)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "") + "_" + Math.random().toString(36).slice(2, 8);
  const outputDir = path.join(app.getPath("userData"), "edits", stamp);
  writeLog(`剪辑预览/导出参数: source=${payload.sourcePath}, segments=${JSON.stringify(segments)}, volume=${volume}, pitch=${pitchSemitones}, cents=${pitchCents}, totalPitch=${pitchSemitones + pitchCents / 100}, tempo=${tempoRatio}`);
  const outputPath = path.join(outputDir, `${base}_clip.wav`);
  fs.mkdirSync(outputDir, { recursive: true });

  const totalSemitones = pitchSemitones + pitchCents / 100;
  const needTransform = Math.abs(totalSemitones) > 0.001 || tempoRatio !== 1;
  const useEditorWorker = needTransform || segments.length > 1;

  if (useEditorWorker) {
    const spec = pythonScriptExecutable("audio_editor");
    const args = [
      ...spec.prefixArgs,
      "--source", payload.sourcePath,
      "--output", outputPath,
      "--start", start.toFixed(3),
      "--end", end.toFixed(3),
      "--segments-json", JSON.stringify(segments),
      "--fade-in", fadeIn.toFixed(3),
      "--fade-out", fadeOut.toFixed(3),
      "--volume", volume.toFixed(3),
      "--pitch", totalSemitones.toFixed(3),
      "--tempo", tempoRatio.toFixed(3),
    ];
    return new Promise((resolve) => {
      editorJob = spawn(spec.command, args, {
        cwd: projectRoot(),
        env: backendEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      editorJob.stdout.setEncoding("utf8");
      editorJob.stderr.setEncoding("utf8");
      editorJob.stdout.on("data", (text) => {
        stdout += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            send("editor:event", event);
          } catch (_) {
            send("editor:event", { type: "log", message: trimmed });
          }
        }
      });
      editorJob.stderr.on("data", (text) => { stderr += text; });
      editorJob.on("error", (error) => {
        editorJob = null;
        resolve({ ok: false, message: error.message });
      });
      editorJob.on("close", (code) => {
        editorJob = null;
        if (stdout.trim()) writeLog(`audio_editor stdout: ${stdout.trim()}`);
        if (stderr.trim()) writeLog(`audio_editor stderr: ${stderr.trim()}`, "error");
        if (code !== 0 || !fs.existsSync(outputPath)) {
          resolve({ ok: false, message: stderr.trim() || stdout.trim() || `audio_editor exited ${code}` });
          return;
        }
        resolve({ ok: true, outputPath, outputDir, start, end, duration, log: stdout.trim(), stderr: stderr.trim(), pitch: totalSemitones, tempo: tempoRatio });
      });
    });
  }

  const filters = [`volume=${volume.toFixed(3)}`];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);

  const args = [
    "-y",
    "-ss", start.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", payload.sourcePath,
    "-af", filters.join(","),
    "-c:a", "pcm_s16le",
    outputPath
  ];

  return new Promise((resolve) => {
    send("editor:event", { type: "status", message: "正在剪辑音频", progress: 15 });
    editorJob = spawn(ffmpegExecutable(), args, {
      cwd: projectRoot(),
      env: backendEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    editorJob.stderr.setEncoding("utf8");
    editorJob.stderr.on("data", (text) => { stderr += text; });
    editorJob.on("error", (error) => {
      editorJob = null;
      resolve({ ok: false, message: error.message });
    });
    editorJob.on("close", (code) => {
      editorJob = null;
      if (code !== 0 || !fs.existsSync(outputPath)) {
        resolve({ ok: false, message: stderr.trim() || `ffmpeg exited ${code}` });
        return;
      }
      send("editor:event", { type: "status", message: "剪辑处理完成", progress: 100 });
      resolve({ ok: true, outputPath, outputDir, start, end, duration });
    });
  });
});

ipcMain.handle("editor:export-project", async (_event, payload = {}) => {
  const license = await requireActiveLicense("audio_editor_export", "多轨歌曲导出");
  if (!license.ok) return license;
  if (editorJob) return { ok: false, message: "已有音频编辑任务正在运行" };
  const tracks = Array.isArray(payload.tracks) ? payload.tracks.slice(0, 32) : [];
  const exportStart = Math.max(0, safeNumber(payload?.exportRange?.start, 0));
  const exportEndValue = Number(payload?.exportRange?.end);
  const hasExportRange = Number.isFinite(exportEndValue) && exportEndValue > exportStart + 0.001;
  const exportEnd = hasExportRange ? exportEndValue : Number.POSITIVE_INFINITY;
  const cleanTracks = tracks.map((track, trackIndex) => ({
    id: String(track?.id || `track_${trackIndex + 1}`),
    name: String(track?.name || `轨道 ${trackIndex + 1}`).slice(0, 80),
    muted: Boolean(track?.muted),
    gain: Math.max(0, Math.min(1.5, safeNumber(track?.gain, 1))),
    pan: Math.max(-1, Math.min(1, safeNumber(track?.pan, 0))),
    clips: (Array.isArray(track?.clips) ? track.clips : []).slice(0, 200).map((clip) => {
      const sourcePath = String(clip?.sourcePath || "");
      const sourceStart = Math.max(0, safeNumber(clip?.sourceStart, 0));
      const sourceEnd = Math.max(sourceStart + 0.001, safeNumber(clip?.sourceEnd, sourceStart + 0.001));
      return {
        sourcePath,
        sourceStart,
        sourceEnd,
        timelineStart: Math.max(0, safeNumber(clip?.timelineStart, 0)),
        gain: Math.max(0, Math.min(3, safeNumber(clip?.gain, 1))),
        pitch: Math.max(-12, Math.min(12, safeNumber(clip?.pitch, 0))),
        cents: Math.max(-100, Math.min(100, safeNumber(clip?.cents, 0))),
        tempo: Math.max(0.5, Math.min(2, safeNumber(clip?.tempo, 1))),
      };
    }).filter((clip) => clip.sourcePath && fs.existsSync(clip.sourcePath))
  }));
  if (hasExportRange) {
    cleanTracks.forEach((track) => {
      track.clips = track.clips.flatMap((clip) => {
        const timelineEnd = clip.timelineStart + (clip.sourceEnd - clip.sourceStart) / clip.tempo;
        const overlapStart = Math.max(exportStart, clip.timelineStart);
        const overlapEnd = Math.min(exportEnd, timelineEnd);
        if (overlapEnd - overlapStart < 0.001) return [];
        const trimStart = (overlapStart - clip.timelineStart) * clip.tempo;
        const trimmedSourceStart = clip.sourceStart + trimStart;
        return [{
          ...clip,
          sourceStart: trimmedSourceStart,
          sourceEnd: trimmedSourceStart + (overlapEnd - overlapStart) * clip.tempo,
          timelineStart: overlapStart - exportStart,
        }];
      });
    });
  }
  const audibleClips = cleanTracks.filter((track) => !track.muted).flatMap((track) => track.clips);
  if (!audibleClips.length) return { ok: false, message: "工程里没有可导出的音频片段" };
  if (audibleClips.length > 200) return { ok: false, message: "单个工程最多支持 200 个音频片段" };

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputDir = resolvedEditorExportDir();
  const rawProjectName = String(payload.projectName || "音频工程").replace(/\.[^.]+$/, "");
  const projectName = rawProjectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 80) || "音频工程";
  const outputFormat = String(payload.outputFormat || "wav").toLowerCase() === "mp3" ? "mp3" : "wav";
  const sampleRate = Number(payload.sampleRate) === 48000 ? 48000 : 44100;
  const requestedOutputName = String(payload.outputName || "").replace(/\.(?:wav|mp3)$/i, "");
  let outputName = requestedOutputName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 80);
  if (!outputName) outputName = `${projectName}_混音_${stamp}`;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(outputName)) outputName = `_${outputName}`;
  const outputPath = uniqueOutputPath(path.join(outputDir, `${outputName}.${outputFormat}`));
  fs.mkdirSync(outputDir, { recursive: true });
  const projectJson = JSON.stringify({ tracks: cleanTracks });
  const jobDir = path.join(app.getPath("userData"), "editor-jobs", `multitrack_${stamp}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const projectPath = path.join(jobDir, "project.json");
  fs.writeFileSync(projectPath, projectJson, "utf8");
  const duration = audibleClips.reduce((end, clip) => Math.max(end, clip.timelineStart + (clip.sourceEnd - clip.sourceStart) / clip.tempo), 0);
  const spec = pythonScriptExecutable("audio_editor");
  const args = [
    ...spec.prefixArgs,
    "--output", outputPath,
    "--project-file", projectPath,
    "--output-format", outputFormat,
    "--sample-rate", String(sampleRate)
  ];
  writeLog(`多轨工程导出: tracks=${cleanTracks.length}, clips=${audibleClips.length}, duration=${duration.toFixed(3)}, range=${hasExportRange ? `${exportStart.toFixed(3)}-${exportEnd.toFixed(3)}` : "full"}, format=${outputFormat}, sample_rate=${sampleRate}, file=${outputName}`);
  return new Promise((resolve) => {
    send("editor:event", { type: "status", message: "正在准备混音工程", progress: 12 });
    editorJob = spawn(spec.command, args, {
      cwd: projectRoot(),
      env: backendEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    editorJob.stdout.setEncoding("utf8");
    editorJob.stderr.setEncoding("utf8");
    editorJob.stdout.on("data", (text) => {
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try { send("editor:event", JSON.parse(trimmed)); }
        catch (_) { send("editor:event", { type: "log", message: trimmed }); }
      });
    });
    editorJob.stderr.on("data", (text) => { stderr += text; });
    editorJob.on("error", (error) => {
      editorJob = null;
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
      resolve({ ok: false, message: error.message });
    });
    editorJob.on("close", (code) => {
      editorJob = null;
      if (stdout.trim()) writeLog(`audio_editor project stdout: ${stdout.trim()}`);
      if (stderr.trim()) writeLog(`audio_editor project stderr: ${stderr.trim()}`, "error");
      if (code !== 0 || !fs.existsSync(outputPath)) {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
        resolve({ ok: false, message: stderr.trim() || stdout.trim() || `audio_editor exited ${code}` });
        return;
      }
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
      send("editor:event", { type: "status", message: "混音文件已写入导出目录", progress: 100 });
      resolve({ ok: true, outputPath, outputDir, duration, clips: audibleClips.length, outputFormat, sampleRate, outputName });
    });
  });
});

ipcMain.handle("editor:cancel", async () => {
  if (editorJob) {
    try { editorJob.kill(); } catch (_) {}
    editorJob = null;
    send("editor:event", { type: "cancelled" });
    return { ok: true };
  }
  return { ok: false, message: "no editor job" };
});

ipcMain.handle("open:url", async (_event, url) => {
  try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return {ok:false}; }
  catch { return {ok:false}; }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("open:path", async (_event, targetPath) => {
  if (!targetPath) return { ok: false };
  const statsPath = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()
    ? path.dirname(targetPath)
    : targetPath;
  const result = await shell.openPath(statsPath);
  return { ok: !result, message: result };
});

// --------------------------------------------------------------------------- //
// 闊抽瑙ｅ瘑 + 杞爜锛坘ugou_unlocker.py锛?// --------------------------------------------------------------------------- //

async function unlockerPickFiles() {
  writeLog("[DEBUG] unlockerPickFiles 被调用");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择音频文件",
    defaultPath: unlockerLastFolder || undefined,
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "音频文件",
        extensions: [
          "kgm", "kgma", "vpr", "kgg",
          "ncm", "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8",
          "qmcflac", "qmcogg", "qmcra", "qmcwma", "tkm",
          "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma", "mmp4",
          "mflac", "mgg", "mflac0", "mflac1", "mflach", "mgg0", "mgg1", "mggl",
          "ofl_en", "joox", "xm", "x2m", "x3m", "kwm", "tm0", "tm2", "tm3", "tm6", "uc",
          "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "alac", "ape", "wma", "dff", "mp4"
        ]
      },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    unlockerLastFolder = path.dirname(result.filePaths[0]);
    saveDirPrefs();
  }
  return result.canceled ? [] : result.filePaths;
}
ipcMain.handle("unlocker:pickFiles", unlockerPickFiles);

async function unlockerPickFolder() {
  writeLog("[DEBUG] unlockerPickFolder 被调用");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择包含音频的文件夹",
    defaultPath: unlockerLastFolder || undefined,
    properties: ["openDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    unlockerLastFolder = result.filePaths[0];
    saveDirPrefs();
  }
  return result.canceled ? "" : result.filePaths[0];
}
ipcMain.handle("unlocker:pickFolder", unlockerPickFolder);

// 递归扫描目录中的音频文件(深度 4,跳过隐藏目录)
const AUDIO_EXT_SET = new Set([
  "kgm", "kgma", "vpr", "kgg",
  "ncm", "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8",
  "qmcflac", "qmcogg", "qmcra", "qmcwma", "tkm",
  "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma", "mmp4",
  "mflac", "mgg", "mflac0", "mflac1", "mflach", "mgg0", "mgg1", "mggl",
  "ofl_en", "joox", "xm", "x2m", "x3m", "kwm", "tm0", "tm2", "tm3", "tm6", "uc",
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "alac", "ape", "wma", "dff"
]);

async function unlockerScanFolder(_event, folderPath) {
  writeLog(`[DEBUG] unlockerScanFolder 被调用, path=${folderPath}`);
  if (!folderPath || typeof folderPath !== "string") return [];
  const out = [];
  const MAX_DEPTH = 4;
  const walk = (cur, depth) => {
    if (depth >= MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") || ent.name === "System Volume Information") continue;
      const full = path.join(cur, ent.name);
      try {
        if (ent.isFile()) {
          const ext = path.extname(ent.name).slice(1).toLowerCase();
          if (AUDIO_EXT_SET.has(ext)) out.push(full);
        } else if (ent.isDirectory()) {
          walk(full, depth + 1);
        }
      } catch (_) {}
    }
  };
  try {
    const st = fs.statSync(folderPath);
    if (!st.isDirectory()) return [];
    walk(folderPath, 0);
  } catch (_) {
    return [];
  }
  return out;
}
ipcMain.handle("unlocker:scan-folder", unlockerScanFolder);

async function unlockerPickOutputDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择输出目录",
    defaultPath: unlockerLastOutputDir || undefined,
    properties: ["openDirectory", "createDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    unlockerLastOutputDir = result.filePaths[0];
    saveDirPrefs();
  }
  return result.canceled ? "" : result.filePaths[0];
}
ipcMain.handle("unlocker:pickOutputDir", unlockerPickOutputDir);

async function unlockerStart(_event, payload) {
  const license = await requireActiveLicense("audio_unlock", "音频格式转换/解锁");
  if (!license.ok) return license;
  if (unlockerJob) return { ok: false, message: "已有解密任务正在运行" };
  const files = Array.isArray(payload && payload.files) ? payload.files.filter(Boolean) : [];
  const outputDir = (payload && payload.outputDir) || "";
  const format = (payload && payload.format) || "mp3";
  const quality = safeNumber(payload && payload.quality, 2);

  if (files.length === 0) return { ok: false, message: "请先选择需要处理的文件" };
  if (!outputDir) return { ok: false, message: "请选择输出目录" };

  // Auto-detect KGG decryptor from vendor/kgg/
  let kggDecPath = "";
  kggDecPath = kggDecryptor() || "";

  const spec = pythonScriptExecutable("kugou_unlocker");
  const args = [...spec.prefixArgs];
  for (const file of files) {
    args.push("--input", file);
  }
  args.push("--output-dir", outputDir);
  args.push("--format", format);
  args.push("--quality", String(Math.max(0, Math.min(9, Math.round(quality)))));
  if (kggDecPath) {
    args.push("--kgg-dec", kggDecPath);
  }

  unlockerJob = spawn(spec.command, args, {
    cwd: projectRoot(),
    env: backendEnv(),
    windowsHide: true
  });

  let buffer = "";
  unlockerJob.stdout.setEncoding("utf8");
  unlockerJob.stderr.setEncoding("utf8");
  unlockerJob.stdout.on("data", (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        send("unlocker:event", JSON.parse(line));
      } catch (_) {
        send("unlocker:event", { type: "log", message: line });
      }
    }
  });
  unlockerJob.stderr.on("data", (text) => {
    String(text).split(/\r?\n/).forEach((line) => {
      if (line.trim()) send("unlocker:event", { type: "log", level: "warn", message: line });
    });
  });
  unlockerJob.on("close", (code) => {
    if (code !== 0) {
      send("unlocker:event", { type: "failed", code });
    } else {
      send("unlocker:event", { type: "done" });
    }
    unlockerJob = null;
  });

  return { ok: true };
}
ipcMain.handle("unlocker:start", unlockerStart);

async function unlockerCancel() {
  if (!unlockerJob) return { ok: true };
  try {
    unlockerJob.kill();
    unlockerJob = null;
    send("unlocker:event", { type: "cancelled" });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
ipcMain.handle("unlocker:cancel", unlockerCancel);

// ===== 闊抽鏍煎紡杞崲 (converter:*) 鍒悕閫氶亾 =====
// Keep unlocker:* and expose converter:* aliases over the same event stream.
const _converterAlias = {
  "converter:pickFiles":     unlockerPickFiles,
  "converter:pickFolder":    unlockerPickFolder,
  "converter:pickOutputDir": unlockerPickOutputDir,
  "converter:pickMmkv":      unlockerPickMmkv,
  "converter:start":         unlockerStart,
  "converter:um-start":      unlockerUmStart,
  "converter:cancel":        unlockerCancel,
  "converter:get-prefs":     unlockerGetPrefs,
};
for (const [channel, fn] of Object.entries(_converterAlias)) {
  ipcMain.handle(channel, fn);
}


