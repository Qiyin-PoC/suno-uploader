const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const backend = path.join(root, "backend", "backend.exe");
const download = path.join(root, "backend", "suno_download_cli.exe");

function run(executable, args, extraEnv = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...extraEnv },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}

test("5.0.4 上传 worker 暴露 token 准备和超时参数", () => {
  const result = run(backend, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--prepare-suno-token/);
  assert.match(result.stdout, /--auth-timeout-sec/);
  assert.match(result.stdout, /--resume-policy/);
  assert.match(result.stdout, /--lyrics-mode/);
});

test("5.0.4 下载 worker 只提供 MP3/WAV", () => {
  const result = run(download, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--format \{mp3,wav\}/);
  assert.doesNotMatch(result.stdout, /m4a/);
});

test("上传历史命令在空数据目录安全退出", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-worker-"));
  const result = run(backend, ["--history"], { GAOBAI_APP_DATA: directory, GAOBAI_PROJECT_ROOT: root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(directory, { recursive: true, force: true });
});
