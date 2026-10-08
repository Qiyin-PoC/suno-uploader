const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const fail = (message) => { console.error(`检查失败：${message}`); process.exitCode = 1; };
const read = (relative) => fs.readFileSync(path.join(root, relative));
const sha256 = (relative) => crypto.createHash("sha256").update(read(relative)).digest("hex");

const pkg = JSON.parse(read("package.json").toString("utf8"));
if (pkg.version !== "5.0.4") fail(`package 版本应为 5.0.4，实际为 ${pkg.version}`);
if (pkg.devDependencies?.electron !== "31.7.7") fail("Electron 必须与对标软件一致为 31.7.7");

const sourceBaseline = {
  "electron/main/account-session-v2.js": "65ff62fd5337d1cae50aef8166ba748996d63f27ddb8e6866dd6977774c5437e",
  "electron/main/suno-accounts.js": "7177ea05bf4c16b6ac1d52d6c7d3be023fd408102bde468996c6a482c711465a",
  "electron/main/execution-grant.js": "bfd25524e18a51b8da1cb0123cfacc7e3f9cdb82af1d90511f1ab70cf3a6c40f",
  "electron/main/legal-notice.js": "dc213dd04be0a5063046dd050c9179abd5a6e59d8858336d3d8efc8156a7b4cd",
  "electron/main/renderer-security.js": "87dead9388ff0870a4070473fa6d1aad15c7b94a16b855bfb5cd41bfdeebd8e4",
  "electron/main/suno-extension-refresh.js": "ac800d0b015715ee0c0099252bb73ca39946d23b074040c03b669da010c57555",
  "electron/main/task-authorization-broker.js": "faf43b31f043e0e3f09ceb4a7c97d89f32a00194e6ee95daea032db282cd8447",
  "electron/main/upload-preparation.js": "0b71a0168975d13be4a045ef538cea07099e83b4c70a08b8a6def457c0faff5d",
  "electron/main/worker-integrity.js": "8d0ed83ab082352cd17383caf7dd9169a75dbb87c0efb1373b523cebfecb8784",
  "electron/main/worker-manifest.json": "c77d15f3f56c1476de6774ca7fecd898fef918f27accf8534f987fbd2166ac2c"
};
for (const [relative, expected] of Object.entries(sourceBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少冻结后端源文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 偏离冻结后端源代码基线`);
}

const internalRuntimeBaseline = {
  "electron/main/main.js": "57d02aca6010f58e77f915f3114c5e83cc0cd0aa43adf44c5b80d4dc0f35f9cc",
  "electron/main/suno-download.js": "56b7cc3e7c2124cf96846e9d6643d7b0d5e090686c2b266cfee9bca196da0d05",
  "electron/main/suno-download-batch.js": "9b0c79144af5519e631f93d53ea0144c78f3e1550a62569cce9cb7129f07a9c6",
  "electron/main/backend-process.js": "b611deb0265ab1c8ec51c9d73c691926a4bcdab841024048d62b9acc2a8b2e18",
  "backend/backend.py": "87756d147fd367a35144a03b5353feb55422e0a3ec2178a26d1d840ba1950c0a",
  "backend/suno_download_cli.py": "713a962ac44b3088c38a0c718e3fc146451219cc64aaab6809b5feb4dbd5756c",
  "backend/suno_download_jobs.py": "d75f1b0dae230063ff4204c16282d9a3615db4bb42eca15e10e08abcef7e4ff8",
  "python-embed/python.exe": "4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a"
};
for (const [relative, expected] of Object.entries(internalRuntimeBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少内部免授权运行文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 偏离已验证的内部免授权运行基线`);
}
const mainSource = read("electron/main/main.js").toString("utf8");
if (mainSource.includes('requireActiveLicense("suno_upload"')) fail("上传仍然要求官网账号权益");
if (mainSource.includes('createTaskAuthorization("suno_upload"')) fail("上传仍然申请官网任务租约");
if (!mainSource.includes('authorize: async () => ({ ok: true })')) fail("下载没有切换为内部免授权模式");
if (!JSON.stringify(pkg.build?.extraResources || []).includes("python-embed")) fail("发布包没有包含内部 Python 运行时");

const qiyinUiBaseline = {
  "electron/main/preload.js": "bda8810a8ba815edbaf5de5e0b1435fedf8586c4863932f0fce375e4e896c85f",
  "electron/renderer/app.js": "063cfa481a5f8476ae23b219e4dea0fccb4815cebfdd0366f69e8f3073d1b83c",
  "electron/renderer/styles.css": "0bf0a411975ffe074fb8312d8112b944779adbe0ba79072410d4b7c4b7fe7e79",
  "electron/renderer/suno-accounts.js": "afb1bcc5a20c97fd95070f41ec7a5cc3d473db71a29fe63d743b12f1661892b4",
  "electron/renderer/suno-download.css": "cfc91b35901f286c2db8c21e3b9e6514efc135b7d0eaa93e73bfab102c245a3c",
  "electron/renderer/suno-download.js": "4cbc11e3d871d2f98622f4913b901e1dde6d40953c994fd2d17b7632576cccf5"
};
for (const [relative, expected] of Object.entries(qiyinUiBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少期音 UI 文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 不再是迁移前期音 UI 原文件`);
}

const extensionBaseline = {
  "suno-login-extension/background.js": "59ba56c63eb2597f97b1f770d39c274c7ffe5ec2e9a8895625db9352ffc159e9",
  "suno-login-extension/manifest.json": "ee1077b653ae0e6adc0e2144b9359ddf6d4817f210ef4028d5b8874dca42be27",
  "suno-login-extension/popup.html": "93e891e176437a816dee1c35edf572494d7e08dfb2f6be1a7611a9f45532da9d",
  "suno-login-extension/popup.js": "a411d688c87bf432635beb9a363b82d8760257375aa77bfa1dcc37cb2abc08f3",
  "suno-login-extension/使用说明.txt": "4ac08da803bb498c64b30e4dbfddcb4d263201e33f819b7216e7c3b05feee5ef"
};
for (const [relative, expected] of Object.entries(extensionBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少协议 2 扩展文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 与冻结的协议 2 扩展基线不一致`);
}

const workerManifest = JSON.parse(read("electron/main/worker-manifest.json").toString("utf8"));
for (const name of ["backend.exe", "suno_download_cli.exe"]) {
  const relative = `backend/${name}`;
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少参考 worker ${relative}`);
  else if (sha256(relative) !== workerManifest.workers[name]) fail(`${name} 与 worker manifest 不匹配`);
}
const embeddedPython = path.join(root, "python-embed", "python.exe");
const uploadHelp = spawnSync(embeddedPython, [path.join(root, "backend", "backend.py"), "--help"], { encoding: "utf8" });
if (uploadHelp.status !== 0 || !/--resume-policy/.test(uploadHelp.stdout) || !/--lyrics-mode/.test(uploadHelp.stdout)) fail("内部上传后端 CLI 不完整");
const downloadHelp = spawnSync(embeddedPython, [path.join(root, "backend", "suno_download_cli.py"), "--help"], { encoding: "utf8" });
if (downloadHelp.status !== 0 || !/\{mp3,wav,m4a\}/.test(downloadHelp.stdout)) fail("内部下载后端缺少 MP3/WAV/m4a");

const html = read("electron/renderer/index.html").toString("utf8");
const navPanels = [...html.matchAll(/class="nav-item(?: active)?"[^>]*data-panel="([^"]+)"/g)].map((match) => match[1]);
const expectedPanels = ["uploadPage", "downloadPage", "historyPage"];
if (JSON.stringify(navPanels) !== JSON.stringify(expectedPanels)) fail(`侧栏必须仅有三个板块，实际为 ${navPanels.join(", ")}`);
if (!html.includes("Content-Security-Policy")) fail("缺少内容安全策略 CSP");
const uiHtml = html.replace(/    <meta http-equiv="Content-Security-Policy"[^\r\n]*\r?\n/, "");
const uiHtmlHash = crypto.createHash("sha256").update(Buffer.from(uiHtml, "utf8")).digest("hex");
if (uiHtmlHash !== "daeb8216a47c29b2c41d42ba0590ab00eec655349aebc2b420565e8b3e9be986") fail("index.html 不再是迁移前期音 UI（除安全 CSP 外）");
if (!html.includes("期音科技 · Suno 歌曲上传器")) fail("窗口标题不再是原期音品牌");
for (const format of ["mp3", "wav", "m4a"]) if (!html.includes(`value="${format}"`)) fail(`原期音下载界面缺少 ${format}`);

const manifest = JSON.parse(read("suno-login-extension/manifest.json").toString("utf8"));
if (manifest.version !== "5.0.4") fail("浏览器扩展版本必须是 5.0.4");
for (const permission of ["storage", "alarms"]) if (!manifest.permissions?.includes(permission)) fail(`协议 2 扩展缺少 ${permission} 权限`);

const jsFiles = [];
for (const base of ["electron", "suno-login-extension"]) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) jsFiles.push(full);
    }
  };
  walk(path.join(root, base));
}
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) fail(`JavaScript 语法错误：${path.relative(root, file)}\n${result.stderr}`);
}

if (!process.exitCode) console.log(`发布检查通过：${Object.keys(sourceBaseline).length} 个冻结后端文件、${Object.keys(internalRuntimeBaseline).length} 个内部免授权运行文件、${Object.keys(qiyinUiBaseline).length} 个原期音 UI 文件、5 个扩展文件、2 个参考 worker、${jsFiles.length} 个 JS 语法检查。`);
