const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PersistentUploadBatchQueue, normalizeState } = require("../electron/main/upload-batch-queue");

test("批量队列去重、持久化并在重启后回到暂停状态", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "upload-queue-"));
  const file = path.join(directory, "queue.json");
  let id = 0;
  const options = { idFactory: () => `id-${++id}`, now: () => "2026-01-01T00:00:00.000Z" };
  const queue = new PersistentUploadBatchQueue(file, options);
  const state = queue.replace([
    { audioPath: "C:\\music\\A.mp3", title: "" },
    { audioPath: "C:\\music\\A.mp3", title: "重复" },
    { audioPath: "C:\\music\\B.wav", speed: "stable" },
  ]);
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].title, "A");
  assert.equal(state.items[1].speed, "stable");
  queue.updateQueue({ status: "running", currentItemId: state.items[0].id }, false);
  queue.updateItem(state.items[0].id, { status: "uploading", progress: 52 });
  const reloaded = new PersistentUploadBatchQueue(file, options).snapshot();
  assert.equal(reloaded.status, "paused");
  assert.equal(reloaded.currentItemId, "");
  assert.equal(reloaded.items[0].status, "pending");
  assert.equal(reloaded.items[0].progress, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("损坏队列文件安全回退为空队列", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "upload-queue-corrupt-"));
  const file = path.join(directory, "queue.json");
  fs.writeFileSync(file, "{broken", "utf8");
  const queue = new PersistentUploadBatchQueue(file);
  assert.equal(queue.snapshot().status, "idle");
  assert.deepEqual(queue.snapshot().items, []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("非法速度和状态会标准化", () => {
  const state = normalizeState({ status: "bad", items: [{ audioPath: "x.mp3", speed: "fast", status: "bad" }] }, () => "id");
  assert.equal(state.status, "ready");
  assert.equal(state.items[0].speed, "onbeat2x");
  assert.equal(state.items[0].status, "pending");
});

test("界面只暴露上传、下载、历史三个导航板块", () => {
  const html = fs.readFileSync(path.resolve("electron/renderer/index.html"), "utf8");
  const panels = [...html.matchAll(/class="nav-item(?: active)?"[^>]*data-panel="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, ["uploadPage", "downloadPage", "historyPage"]);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /value="mp3"/);
  assert.match(html, /value="wav"/);
  assert.match(html, /name="sunoDownloadFormat" value="m4a"/);
  assert.match(html, /<title>期音科技 · Suno 歌曲上传器<\/title>/);
});
