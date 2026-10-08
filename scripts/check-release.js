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
  "electron/main/main.js": "7281d9b97a9ea5a5f46e47ca6c7642ee6ac382fdf7023120d936f413598bde80",
  "electron/main/preload.js": "ebccf3d9470d91f370cde71ff73fbde2a4fa9979f5a0c781818534cd13327ea1",
  "electron/main/account-session-v2.js": "65ff62fd5337d1cae50aef8166ba748996d63f27ddb8e6866dd6977774c5437e",
  "electron/main/suno-accounts.js": "7177ea05bf4c16b6ac1d52d6c7d3be023fd408102bde468996c6a482c711465a",
  "electron/main/suno-download.js": "bc925f17cef253a9b3b94400b2efcacca73511b79783040366f4c1a5b0420ab0",
  "electron/main/execution-grant.js": "bfd25524e18a51b8da1cb0123cfacc7e3f9cdb82af1d90511f1ab70cf3a6c40f",
  "electron/main/legal-notice.js": "4232896ae6d3e07d00802a818630c13b46cbebb2f0366eacd070e9e5a9199961",
  "electron/main/renderer-security.js": "87dead9388ff0870a4070473fa6d1aad15c7b94a16b855bfb5cd41bfdeebd8e4",
  "electron/main/suno-extension-refresh.js": "ac800d0b015715ee0c0099252bb73ca39946d23b074040c03b669da010c57555",
  "electron/main/task-authorization-broker.js": "faf43b31f043e0e3f09ceb4a7c97d89f32a00194e6ee95daea032db282cd8447",
  "electron/main/upload-preparation.js": "0b71a0168975d13be4a045ef538cea07099e83b4c70a08b8a6def457c0faff5d",
  "electron/main/worker-integrity.js": "8d0ed83ab082352cd17383caf7dd9169a75dbb87c0efb1373b523cebfecb8784",
  "electron/main/worker-manifest.json": "c77d15f3f56c1476de6774ca7fecd898fef918f27accf8534f987fbd2166ac2c",
  "electron/renderer/styles.css": "8befddd906de3d1279518ef3fec35016b3730c82643b3ab8b9892c8fc056e062",
  "electron/renderer/suno-accounts.js": "85874fe6842016ccf1ee603643bfa9ea98eed4cdc667ec444a1962398f3b2abb",
  "electron/renderer/suno-download.css": "e2f046731b769911eba2470d61603881f6a8e958717069a743d1e3835f7897d8",
  "electron/renderer/suno-download.js": "4cbc11e3d871d2f98622f4913b901e1dde6d40953c994fd2d17b7632576cccf5"
};
for (const [relative, expected] of Object.entries(sourceBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少 5.0.4 源文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 不再是 5.0.4 对标原代码`);
}

const extensionBaseline = {
  "suno-login-extension/background.js": "bcd4dd233a3620ce0f36c88367fa0515ba6c3b07a2100e9e43abbddf4750bce0",
  "suno-login-extension/manifest.json": "fff4bbf61c8941f72650e2429f0e93bb3c3da8deb745663b45f7cae9f0cedd21",
  "suno-login-extension/popup.html": "95f339d9a1622fa81b4840761a2148359ee16e8cc99c321b4ddac3a3dc3e8866",
  "suno-login-extension/popup.js": "a411d688c87bf432635beb9a363b82d8760257375aa77bfa1dcc37cb2abc08f3",
  "suno-login-extension/使用说明.txt": "f7b3eac033ef7d5456077f9ca7a4a987567bce864b7ee3668b6e9a8380287676"
};
for (const [relative, expected] of Object.entries(extensionBaseline)) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少协议 2 扩展文件 ${relative}`);
  else if (sha256(relative) !== expected) fail(`${relative} 与 5.0.4 协议 2 扩展不一致`);
}

const workerManifest = JSON.parse(read("electron/main/worker-manifest.json").toString("utf8"));
for (const name of ["backend.exe", "suno_download_cli.exe"]) {
  const relative = `backend/${name}`;
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少 worker ${relative}`);
  else if (sha256(relative) !== workerManifest.workers[name]) fail(`${name} 与 worker manifest 不匹配`);
}

const html = read("electron/renderer/index.html").toString("utf8");
const navPanels = [...html.matchAll(/class="nav-item(?: active)?"[^>]*data-panel="([^"]+)"/g)].map((match) => match[1]);
const expectedPanels = ["uploadPage", "downloadPage", "historyPage"];
if (JSON.stringify(navPanels) !== JSON.stringify(expectedPanels)) fail(`侧栏必须仅有三个板块，实际为 ${navPanels.join(", ")}`);
if (!html.includes("Content-Security-Policy")) fail("缺少 5.0.4 CSP");
if (!html.includes('value="mp3"') || !html.includes('value="wav"')) fail("下载板块缺少 MP3/WAV");
if (html.includes('name="sunoDownloadFormat" value="m4a"')) fail("对标 5.0.4 下载板块不应增加未包含的 m4a 选项");

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

if (!process.exitCode) console.log(`发布检查通过：${Object.keys(sourceBaseline).length} 个 5.0.4 源文件、5 个扩展文件、2 个 worker、${jsFiles.length} 个 JS 语法检查。`);
