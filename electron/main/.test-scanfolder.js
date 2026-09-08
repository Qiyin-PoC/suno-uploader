// 集成测试 - scanFolder 目录扫描
const fs = require("fs");
const path = require("path");
const os = require("os");

// 模拟 main.js 的 scanFolder
const AUDIO_EXT_SET = new Set([
  "kgm", "kgma", "vpr", "kgg",
  "ncm", "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8",
  "qmcflac", "qmcogg", "qmcra", "qmcwma", "tkm",
  "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma", "mmp4",
  "mflac", "mgg", "mflac0", "mflac1", "mflach", "mgg0", "mgg1", "mggl",
  "ofl_en", "joox", "xm", "x2m", "x3m", "kwm", "tm0", "tm2", "tm3", "tm6", "uc",
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "alac", "ape", "wma", "dff"
]);

function scanFolder(folderPath) {
  const out = [];
  const MAX_DEPTH = 4;
  const walk = (cur, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { return; }
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
  } catch (_) { return []; }
  return out;
}

// 构造测试目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-"));
fs.writeFileSync(path.join(tmpRoot, "song1.mp3"), "fake");
fs.writeFileSync(path.join(tmpRoot, "song2.mgg"), "fake");
fs.writeFileSync(path.join(tmpRoot, "readme.txt"), "fake");
fs.mkdirSync(path.join(tmpRoot, "subdir"));
fs.writeFileSync(path.join(tmpRoot, "subdir", "deep1.flac"), "fake");
fs.mkdirSync(path.join(tmpRoot, "subdir", "sub2"));
fs.writeFileSync(path.join(tmpRoot, "subdir", "sub2", "deep2.ogg"), "fake");
fs.mkdirSync(path.join(tmpRoot, ".hidden"));
fs.writeFileSync(path.join(tmpRoot, ".hidden", "should_skip.mp3"), "fake");
fs.mkdirSync(path.join(tmpRoot, "subdir", "deep3"));
fs.mkdirSync(path.join(tmpRoot, "subdir", "deep3", "deep4"));
fs.mkdirSync(path.join(tmpRoot, "subdir", "deep3", "deep4", "deep5"));
fs.writeFileSync(path.join(tmpRoot, "subdir", "deep3", "deep4", "deep5", "deep6.wav"), "fake"); // 深度 5,应跳过

const result = scanFolder(tmpRoot);
console.log("找到", result.length, "个音频:");
for (const f of result) console.log(" -", f);

// 验证
const expected = [
  path.join(tmpRoot, "song1.mp3"),
  path.join(tmpRoot, "song2.mgg"),
  path.join(tmpRoot, "subdir", "deep1.flac"),
  path.join(tmpRoot, "subdir", "sub2", "deep2.ogg"),
];
if (result.length !== expected.length) {
  console.error("FAIL: 应找到", expected.length, "实际", result.length);
  process.exit(1);
}
for (const e of expected) {
  if (!result.includes(e)) {
    console.error("FAIL: 缺少", e);
    process.exit(1);
  }
}
console.log("PASS: scanFolder 集成测试通过");

// 清理
try { fs.rmSync(tmpRoot, { recursive: true }); } catch (_) {}