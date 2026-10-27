const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const python = path.join(root, "python-embed", "python.exe");
const backend = path.join(root, "backend", "backend.py");
const download = path.join(root, "backend", "suno_download_cli.py");

function run(script, args, extraEnv = {}) {
  return spawnSync(python, [script, ...args], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...extraEnv },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}

test("内部上传后端保留续传、速度和歌词参数且不要求官网任务租约", () => {
  const result = run(backend, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--resume-policy \{auto,resume,new\}/);
  assert.match(result.stdout, /--speed \{standard,stable,experiment,fast,onbeat2x\}/);
  assert.match(result.stdout, /--lyrics-mode/);
  const source = fs.readFileSync(backend, "utf8");
  assert.doesNotMatch(source, /GAOBAI_TASK_(?:PORT|TOKEN)/);
  assert.doesNotMatch(source, /ExecutionGrant/);
});

test("嵌入式 Python 接受主进程实际使用的 Token 预检参数", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "token-preflight-"));
  const result = run(backend, ["--prepare-suno-token", "--auth-timeout-sec", "1"], {
    GAOBAI_APP_DATA: directory,
    GAOBAI_PROJECT_ROOT: root,
    GAOBAI_SUNO_TOKEN_FILE: path.join(directory, "missing-token.json"),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.deepEqual(
    { ok: payload.ok, loggedIn: payload.loggedIn, code: payload.code },
    { ok: false, loggedIn: false, code: "login_required" },
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Token 预检会等待扩展刷新并区分登录失效与网络错误", () => {
  const result = run(path.join(root, "tests", "token-preflight.py"), [root]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.refreshRetry, "ready");
  assert.deepEqual(payload.networkStatuses, [429, 500, 503]);
  assert.equal(payload.unauthorized, "login_required");
});

test("内部下载后端提供 MP3、WAV 和 m4a 且不要求官网任务租约", () => {
  const result = run(download, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--format \{mp3,wav,m4a\}/);
  const source = fs.readFileSync(download, "utf8");
  assert.doesNotMatch(source, /GAOBAI_TASK_(?:PORT|TOKEN)/);
  assert.doesNotMatch(source, /ExecutionGrant/);
});

test("主音频线路网络失败时会切换备用 CDN", () => {
  const result = run(path.join(root, "tests", "download-network-fallback.py"), [root]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /切换备用 CDN/);
});

test("MP3 和 ADTS AAC 回退会生成可解码的真实 m4a 容器", () => {
  const result = run(path.join(root, "tests", "m4a-fallback.py"), [root]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /真实 M4A 容器/);
});

test("上传历史命令在空数据目录安全退出", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-worker-"));
  const result = run(backend, ["--history"], { GAOBAI_APP_DATA: directory, GAOBAI_PROJECT_ROOT: root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(directory, { recursive: true, force: true });
});
