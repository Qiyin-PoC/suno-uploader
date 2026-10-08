const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const python = path.join(root, "python-embed", "python.exe");
const entry = path.join(root, "electron", "engine", "entry.py");

function run(args) {
  return spawnSync(python, [entry, ...args], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}

const lastEvent = (stdout) => {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
};

test("未移植的组件返回明确的平台提示，而不是把参数交给后端解析", () => {
  const result = run(["unsupported", "audio_editor"]);
  assert.notEqual(result.status, 0);
  const event = lastEvent(result.stdout);
  // 必须同时带 type 与 status：download 侧只接受带 status 的行，否则会把失败静默丢弃。
  assert.equal(event.type, "failed");
  assert.equal(event.status, "failed");
  assert.match(event.message, /audio_editor/);
  assert.match(event.message, /macOS/);
  // 音频编辑器一类调用方直接把 stderr 展示给用户。
  assert.match(result.stderr, /audio_editor/);
});

test("未知模式被拒绝，不会被当成 backend 执行", () => {
  const result = run(["definitely-not-a-mode"]);
  assert.notEqual(result.status, 0);
  assert.equal(lastEvent(result.stdout).type, "failed");
});

test("引擎只接受已冻结的模式，未移植组件一律不进入后端", () => {
  for (const mode of ["audio_editor", "uvr_worker", "kugou_unlocker", "qqmusic_frida_unlocker"]) {
    const result = run([mode]);
    assert.notEqual(result.status, 0, `${mode} 不应被引擎接受`);
    assert.notEqual(lastEvent(result.stdout), null, `${mode} 应输出失败事件`);
  }
});
