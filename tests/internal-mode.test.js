const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main/main.js"), "utf8");
const download = fs.readFileSync(path.join(root, "electron/main/suno-download.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("上传、批量上传和歌词处理不再要求官网账号权益", () => {
  assert.doesNotMatch(main, /requireActiveLicense\(["']suno_upload["']/);
  assert.doesNotMatch(main, /requireActiveLicense\(["']lyrics_process["']/);
  assert.doesNotMatch(main, /createTaskAuthorization\(["']suno_upload["']/);
  assert.doesNotMatch(main, /上传任务缺少独立授权/);
  assert.match(main, /spawnBackendProcess\(\{/);
});

test("下载使用内部免授权后端并保留 m4a", () => {
  assert.match(main, /authorize:\s*async \(\) => \(\{ ok: true \}\)/);
  assert.doesNotMatch(main, /createTaskAuthorization:\s*\(\) => createTaskAuthorization\(["']suno_download["']\)/);
  assert.match(download, /\["mp3", "wav", "m4a"\]/);
});

test("正式包包含 Python 运行时和内部后端源码", () => {
  const resources = JSON.stringify(pkg.build?.extraResources || []);
  assert.match(resources, /python-embed/);
  assert.match(resources, /"from":"backend"/);
  assert.match(resources, /\*\*\/\*\.py/);
  assert.match(main, /bundledPythonExecutable\("backend"\)/);
  assert.match(main, /pythonScriptExecutable\("suno_download_cli"\)/);
});
