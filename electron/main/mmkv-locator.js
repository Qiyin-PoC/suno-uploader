// mmkv-locator.js
// QQ 音乐 MMKV 数据库智能定位 + 软链管理
// 设计文档: docs/superpowers/specs/2026-06-21-mmkv-locator-design.md
// 实施计划: docs/superpowers/plans/2026-06-21-mmkv-locator.md
// 解码器鲁棒性: docs/superpowers/specs/2026-06-22-decoder-robust-design.md

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

module.exports = {
  // 4 策略扫描入口 (Task 4)
  locateMmkvCandidates,
  // NTFS junction + 复制降级 (Task 5)
  createMmkvSymlink,
  removeMmkvSymlink,
  // 工具 (Task 2)
  expandStandardPaths,
  isMmkvCandidate,
  findMmkvInDir,
  dedupeByPath,
  matchFailureKeywords,
  // 持久化 (Task 6)
  loadDirPrefsExtended,
  saveDirPrefsExtended,
  loadPreflight,
  // 解码器鲁棒性 - 预检
  unlockerPrecheck,
};

// ─────────────────────────────────────────────────────────────────
// Task 2: 纯函数工具
// ─────────────────────────────────────────────────────────────────

/**
 * 展开标准 QQ 音乐安装路径模板
 * 替换环境变量占位符 %LOCALAPPDATA% / %APPDATA% / %USERPROFILE%
 */
function expandStandardPaths() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const userProfile = process.env.USERPROFILE || home;
  return [
    path.join(localAppData, "Tencent", "QQMusic"),
    path.join(localAppData, "Tencent", "QQMusicMini"),
    path.join(roaming, "Tencent", "QQMusic"),
    path.join(userProfile, "Documents", "QQMusic"),
    path.join(home, "Music", "QQMusic"),
    // UWP 沙盒路径(WindowsApps 下 TencentLimited.QQMusic_*)
    path.join(localAppData, "Packages"),
  ];
}

/**
 * 判断一个文件是否是 MMKV 候选
 * 规则:文件名包含 mmkvstreamencryptid / mmkv*.dat / vault*.dat,且大小 >= 4KB
 */
function isMmkvCandidate(file) {
  if (!file || typeof file !== "string") return false;
  const base = path.basename(file).toLowerCase();
  let okName = false;
  if (base.includes("mmkvstreamencryptid")) okName = true;
  else if (base.startsWith("mmkv") && base.endsWith(".dat")) okName = true;
  else if (base.includes("vault") && base.endsWith(".dat")) okName = true;
  if (!okName) return false;
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size >= 4096;
  } catch (_) {
    return false;
  }
}

/**
 * 在目录中递归查找 MMKV 候选(深度 3,文件名过滤)
 */
function findMmkvInDir(dir, source) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const MAX_DEPTH = 3;
  const walk = (cur, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        if (ent.isFile()) {
          if (isMmkvCandidate(full)) {
            const st = fs.statSync(full);
            out.push({
              path: full,
              source,
              mtime: st.mtimeMs,
              size: st.size,
            });
          }
        } else if (ent.isDirectory()) {
          // UWP 沙盒路径特殊处理:TencentLimited.QQMusic_*\AC\...
          if (cur.endsWith("Packages") && ent.name.toLowerCase().includes("qqmusic")) {
            walk(full, depth + 1);
          } else if (depth < MAX_DEPTH) {
            walk(full, depth + 1);
          }
        }
      } catch (_) {
        // skip EPERM/EBUSY 等
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 按 path 去重,保留优先级最高的 source(standard > registry > process > heuristic > user)
 */
function dedupeByPath(candidates) {
  const sourcePriority = { standard: 0, registry: 1, process: 2, heuristic: 3, user: 4 };
  const map = new Map();
  for (const c of candidates) {
    const key = path.normalize(c.path).toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, c);
      continue;
    }
    const cur = sourcePriority[c.source] ?? 99;
    const prev = sourcePriority[existing.source] ?? 99;
    if (cur < prev) map.set(key, c);
  }
  return Array.from(map.values());
}

/**
 * 检测解锁失败消息是否需要触发 MMKV 引导
 */
const FAILURE_KEYWORDS = [
  "mmkv vault not loaded",
  "vault not loaded",
  "key not found",
  "mmkv not found",
  "qq音乐密钥",
  "请先打开qq音乐",
  // um.exe 最终报错的兜底关键词
  "no any decoder can resolve the file",
  "no any decoder",
  "try decode failed",
  "decoder can resolve",
];

function matchFailureKeywords(message) {
  if (!message || typeof message !== "string") return false;
  const lower = message.toLowerCase();
  return FAILURE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

// ─────────────────────────────────────────────────────────────────
// Task 3: 注册表 + 进程探测
// ─────────────────────────────────────────────────────────────────

/**
 * spawn 同步执行 reg.exe 查询注册表键值
 * 返回匹配的所有值
 */
function queryRegistryValue(keyPath, valueName) {
  if (process.platform !== "win32") return "";
  try {
    const r = spawnSync("reg.exe", [
      "query",
      keyPath,
      "/v",
      valueName,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (r.status !== 0 || !r.stdout) return "";
    const lines = r.stdout.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/\s+REG_SZ\s+(.+)$/);
      if (m) return m[1].trim();
      const m2 = line.match(/\s+REG_EXPAND_SZ\s+(.+)$/);
      if (m2) return m2[1].trim();
    }
  } catch (_) {}
  return "";
}

/**
 * 用 reg.exe 列出某注册表键下的所有子键名
 */
function queryRegistrySubKeys(keyPath) {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync("reg.exe", [
      "query",
      keyPath,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(HKEY_[A-Z_\\]+)\s*$/);
      if (m) out.push(m[1]);
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * 查询 QQ 音乐可能的安装目录(从注册表)
 */
async function queryRegistry() {
  if (process.platform !== "win32") return [];
  const candidates = [];
  const keys = [
    "HKCU\\Software\\Tencent\\QQMusic",
    "HKCU\\Software\\Tencent\\QQMusicMini",
    "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQMusic",
    "HKLM\\SOFTWARE\\Tencent\\QQMusic",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQMusic",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQMusic",
  ];
  const valueNames = ["InstallLocation", "InstallPath", "DisplayIcon", "UninstallString"];
  for (const key of keys) {
    for (const v of valueNames) {
      const raw = queryRegistryValue(key, v);
      if (!raw) continue;
      // 去掉 /uninstall.exe 这种后缀
      let dir = raw.replace(/\\uninstall\.exe$/i, "").replace(/\\QQMusic\.exe$/i, "");
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        candidates.push(...findMmkvInDir(dir, "registry"));
      }
    }
    // Uninstall 区下可能有 TencentLimited.QQMusic* 子键
    if (key.endsWith("Uninstall")) {
      const subs = queryRegistrySubKeys(key);
      for (const sub of subs) {
        if (!sub.toLowerCase().includes("qqmusic")) continue;
        const loc = queryRegistryValue(sub, "InstallLocation") || queryRegistryValue(sub, "DisplayIcon");
        if (!loc) continue;
        let dir = loc.replace(/\\uninstall\.exe$/i, "").replace(/\\QQMusic\.exe$/i, "");
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          candidates.push(...findMmkvInDir(dir, "registry"));
        }
      }
    }
  }
  return candidates;
}

/**
 * 通过 tasklist 探测正在运行的 QQMusic.exe
 */
async function findQqMusicProcess() {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("tasklist", [
      "/FI", "IMAGENAME eq QQMusic.exe",
      "/FO", "CSV",
      "/NH",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    // 输出: "QQMusic.exe","1234","Console","1","123,456 K"
    const m = r.stdout.match(/"([^"]+)"/);
    if (!m) return null;
    const pid = m[1];
    // 用 wmic 查 PID 对应的 exe 路径
    const r2 = spawnSync("wmic.exe", [
      "process", "where", `ProcessId=${pid}`,
      "get", "ExecutablePath", "/format:list",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (r2.status !== 0 || !r2.stdout) return null;
    const m2 = r2.stdout.match(/ExecutablePath=(.+)/);
    if (!m2) return null;
    return m2[1].trim();
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Task 4: 4 策略整合入口
// ─────────────────────────────────────────────────────────────────

/**
 * 主入口:4 策略扫描 QQ 音乐 MMKV 候选
 * 策略 1: 标准路径扫描
 * 策略 2: 注册表查询
 * 策略 3: 进程探测
 * 策略 4: 全盘启发式(默认关闭,太慢)
 */
async function locateMmkvCandidates(opts = {}) {
  const { enableHeuristic = false, maxCandidates = 20 } = opts;
  const all = [];

  // 策略 1: 标准路径
  try {
    for (const dir of expandStandardPaths()) {
      all.push(...findMmkvInDir(dir, "standard"));
    }
  } catch (_) {
    // 忽略
  }

  // 策略 2: 注册表
  try {
    all.push(...await queryRegistry());
  } catch (_) {}

  // 策略 3: 进程探测
  try {
    const exe = await findQqMusicProcess();
    if (exe) {
      const dir = path.dirname(exe);
      all.push(...findMmkvInDir(dir, "process"));
    }
  } catch (_) {}

  // 策略 4: 全盘启发式扫描(可选,极慢)
  if (enableHeuristic) {
    // 留口子:可在 C:\\Users / D:\\ 扫描 *.dat 大小 > 4KB 且文件名匹配
    // 当前不实现,避免影响用户体验
  }

  // 去重 + 排序 (mtime desc)
  const deduped = dedupeByPath(all).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return deduped.slice(0, maxCandidates);
}

// ─────────────────────────────────────────────────────────────────
// Task 5: NTFS junction + 复制降级
// ─────────────────────────────────────────────────────────────────

/**
 * 在 vaultDir 创建指向 originalPath 的链接
 * 策略顺序:
 *   1) 硬链接 (Windows/macOS/Linux 都支持,不需要管理员权限,QQ 音乐更新密钥自动同步)
 *   2) 符号链接 (需要 SeCreateSymbolicLinkPrivilege,Windows 普通用户大多不可用)
 *   3) 物理复制 (兜底,QQ 音乐更新密钥后需要重新调用本函数)
 * 函数名保留 createMmkvSymlink 是为了兼容上层 IPC 接口命名
 */
function createMmkvSymlink(originalPath, vaultDir) {
  if (!originalPath) throw new Error("originalPath 不能为空");
  if (!fs.existsSync(originalPath)) throw new Error("原文件不存在: " + originalPath);
  fs.mkdirSync(vaultDir, { recursive: true });
  const linkPath = path.join(vaultDir, "MMKVStreamEncryptId");

  // 清理旧的链接/复制(用 lstat 检测,避免 stat 跟随链接)
  try {
    const lst = fs.lstatSync(linkPath);
    if (lst.isSymbolicLink() || lst.isFile()) {
      fs.unlinkSync(linkPath);
    } else if (lst.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (_) {
    // 不存在就忽略
  }

  const errors = [];

  // 策略 1: 硬链接(Windows / Linux / macOS 都支持,无需特殊权限)
  try {
    fs.linkSync(originalPath, linkPath);
    if (fs.existsSync(linkPath)) return { linkPath, method: "hardlink" };
    errors.push("linkSync 后 existsSync 返回 false");
  } catch (e) {
    errors.push("hardlink: " + e.message);
  }

  // 策略 2: 符号链接(Windows 上普通用户可能 EPERM)
  try {
    fs.symlinkSync(originalPath, linkPath, "file");
    if (fs.existsSync(linkPath)) return { linkPath, method: "symlink" };
    errors.push("symlink 后 existsSync 返回 false");
  } catch (e) {
    errors.push("symlink: " + e.message);
  }

  // 策略 3: 物理复制(兜底)
  try {
    fs.copyFileSync(originalPath, linkPath);
    return { linkPath, method: "copy" };
  } catch (e) {
    errors.push("copy: " + e.message);
    throw new Error("所有方法均失败: " + errors.join(" | "));
  }
}

/**
 * 删除 vault 中的链接/复制文件
 */
function removeMmkvSymlink(vaultDir) {
  const linkPath = path.join(vaultDir, "MMKVStreamEncryptId");
  try {
    fs.unlinkSync(linkPath);
    return true;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Task 6: 持久化辅助函数
// ─────────────────────────────────────────────────────────────────

/**
 * 读取 dir_prefs.json 的扩展字段(不影响 main.js 的现有字段)
 */
function loadDirPrefsExtended(dirPrefsFile) {
  const out = {
    vaultDir: "",
    currentLink: null,
    lastScanAt: 0,
    lastScanResults: [],
    onboardingShown: false,
    onboardingChoice: null,
    failurePromptDismissedAt: 0,
  };
  try {
    if (!fs.existsSync(dirPrefsFile)) return out;
    let raw = fs.readFileSync(dirPrefsFile, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const prefs = JSON.parse(raw);
    if (prefs && prefs.mmkvLocator) {
      const m = prefs.mmkvLocator;
      out.vaultDir = m.vaultDir || "";
      out.currentLink = m.currentLink || null;
      out.lastScanAt = m.lastScanAt || 0;
      out.lastScanResults = Array.isArray(m.lastScanResults) ? m.lastScanResults : [];
      out.onboardingShown = !!m.onboardingShown;
      out.onboardingChoice = m.onboardingChoice || null;
      out.failurePromptDismissedAt = m.failurePromptDismissedAt || 0;
    }
  } catch (_) {}
  return out;
}

/**
 * 写入 dir_prefs.json 的扩展字段(保留 main.js 的现有字段)
 */
function saveDirPrefsExtended(dirPrefsFile, ext) {
  let prefs = {};
  try {
    if (fs.existsSync(dirPrefsFile)) {
      let raw = fs.readFileSync(dirPrefsFile, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      prefs = JSON.parse(raw);
    }
  } catch (_) {}
  prefs.mmkvLocator = {
    vaultDir: ext.vaultDir !== undefined ? ext.vaultDir : (prefs.mmkvLocator?.vaultDir || ""),
    currentLink: ext.currentLink !== undefined ? ext.currentLink : (prefs.mmkvLocator?.currentLink || null),
    lastScanAt: ext.lastScanAt !== undefined ? ext.lastScanAt : (prefs.mmkvLocator?.lastScanAt || 0),
    lastScanResults: ext.lastScanResults !== undefined ? ext.lastScanResults : (prefs.mmkvLocator?.lastScanResults || []),
    onboardingShown: ext.onboardingShown !== undefined ? ext.onboardingShown : (prefs.mmkvLocator?.onboardingShown || false),
    onboardingChoice: ext.onboardingChoice !== undefined ? ext.onboardingChoice : (prefs.mmkvLocator?.onboardingChoice || null),
    failurePromptDismissedAt: ext.failurePromptDismissedAt !== undefined ? ext.failurePromptDismissedAt : (prefs.mmkvLocator?.failurePromptDismissedAt || 0),
  };
  fs.writeFileSync(dirPrefsFile, JSON.stringify(prefs, null, 2), "utf8");
}

/**
 * 读取 mmkv_preflight.json(NSIS 安装器写)
 */
function loadPreflight(preflightFile) {
  try {
    if (!fs.existsSync(preflightFile)) return { detected: false, candidates: [] };
    let raw = fs.readFileSync(preflightFile, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const data = JSON.parse(raw);
    return {
      detected: !!data.detected,
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      scanTime: data.scanTime || 0,
    };
  } catch (_) {
    return { detected: false, candidates: [] };
  }
}

// ─────────────────────────────────────────────────────────────────
// 解码器鲁棒性 - 综合预检(健康检查 + 解密前置条件)
// ─────────────────────────────────────────────────────────────────
async function unlockerPrecheck(opts = {}) {
  const { fileExt = "" } = opts;
  const isCex = /\.(mgg|mflac)/i.test(fileExt);
  if (!isCex) return { ok: true, skipped: true, reason: "非 CEX 格式,不需要 MMKV" };

  // 1) QQ 音乐是否在跑
  let qqExe = null;
  try {
    qqExe = await findQqMusicProcess();
  } catch (_) {}
  if (!qqExe) {
    const err = new Error(
      "❌ 解密前置条件不满足:未检测到 QQMusic.exe 进程。\n" +
      "   修复步骤:\n" +
      "     1. 打开 QQ 音乐 PC 客户端并登录\n" +
      "     2. 播放一次该歌曲(让 MMKV 落盘)\n" +
      "     3. 保持 QQ 音乐后台运行(不要关闭)\n" +
      "     4. 重新点击「开始转换」"
    );
    err.code = "QQMUSIC_NOT_RUNNING";
    throw err;
  }

  // 2) MMKV 路径是否配置且有效
  const dirPrefsFile = (typeof opts.dirPrefsFile === "string") ? opts.dirPrefsFile : "";
  let mmkvFile = "";
  if (dirPrefsFile) {
    try {
      const ext2 = loadDirPrefsExtended(dirPrefsFile);
      mmkvFile = ext2.currentLink && ext2.currentLink.linkPath ? ext2.currentLink.linkPath : "";
    } catch (_) {}
  }
  if (!mmkvFile) {
    const err = new Error(
      "❌ 解密前置条件不满足:MMKV 数据库未配置。\n" +
      "   修复步骤:\n" +
      "     1. 打开设置 → MMKV 高级选项\n" +
      "     2. 点击「🔍 自动搜索」按钮\n" +
      "     3. 或点击「📁 手动指定」选择 QQ 音乐 MMKV 文件"
    );
    err.code = "MMKV_NOT_CONFIGURED";
    throw err;
  }
  if (!fs.existsSync(mmkvFile)) {
    const err = new Error(
      `❌ 解密前置条件不满足:MMKV 路径失效 (${mmkvFile})。\n` +
      "   可能原因:QQ 音乐被卸载或路径变动。\n" +
      "   修复步骤:\n" +
      "     1. 打开设置 → MMKV 高级选项\n" +
      "     2. 点击「🔍 自动搜索」重新定位"
    );
    err.code = "MMKV_PATH_INVALID";
    throw err;
  }

  return { ok: true, qqMusicExe: qqExe, mmkvFile };
}