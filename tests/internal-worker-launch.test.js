const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnBackendProcess } = require("../electron/main/backend-process");
const { SunoDownloadBatch } = require("../electron/main/suno-download-batch");

test("内部模式无任务租约也会启动带 --source 的 worker", () => {
  let invocation;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const returned = spawnBackendProcess({
    command: "python.exe",
    args: ["backend.py", "--source", "C:\\music\\song.mp3", "--title", "测试"],
    cwd: "C:\\app",
    env: { PYTHONUTF8: "1" },
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });

  assert.equal(returned, child);
  assert.equal(invocation.command, "python.exe");
  assert.ok(invocation.args.includes("--source"));
  assert.equal(invocation.options.env.GAOBAI_TASK_TOKEN, undefined);
  assert.equal(invocation.options.windowsHide, true);
});

test("有效 Suno URL 与 m4a 会通过批量控制器并传给 worker", async () => {
  let received;
  class WorkerStub {
    constructor(options) {
      this.options = options;
      this.active = null;
      this.outputDirectory = "C:\\Downloads";
    }
    snapshot() {
      return { ok: true, running: false, status: "idle", outputDirectory: this.outputDirectory };
    }
    async start(payload) {
      received = payload;
      this.options.onState({ status: "succeeded", filename: "song.m4a", message: "已保存" });
      return { ok: true, taskId: "stub-task" };
    }
    cancel() { return { ok: true }; }
    setOutputDirectory(directory) { this.outputDirectory = directory; return { ok: true, outputDirectory: directory }; }
    async shutdown() {}
  }
  const normalizeUrl = value => /^https:\/\/suno\.com\/song\/[0-9a-f-]+$/i.test(value) ? value : null;
  const batch = new SunoDownloadBatch({ onState() {} }, WorkerStub, normalizeUrl);
  const result = await batch.start({
    url: "https://suno.com/song/12345678-1234-1234-1234-123456789abc",
    format: "m4a",
  });
  const done = batch.active?.done;
  assert.equal(result.errorCode, undefined);
  assert.equal(result.format, "m4a");
  assert.deepEqual(received, {
    url: "https://suno.com/song/12345678-1234-1234-1234-123456789abc",
    format: "m4a",
  });
  await done;
  assert.equal(batch.snapshot().status, "succeeded");
});
