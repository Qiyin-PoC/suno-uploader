const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createUploadPreparation } = require("../electron/main/upload-preparation");
const { safeExternalUrl, isRendererDocument } = require("../electron/main/renderer-security");
const { ExecutionGrant, verifyGrant } = require("../electron/main/execution-grant");
const { verifyWorker } = require("../electron/main/worker-integrity");

test("上传准备可主动取消，并清理迟到资源", async () => {
  const preparation = createUploadPreparation(1000);
  let resolveLate;
  const late = new Promise((resolve) => { resolveLate = resolve; });
  let cleaned = false;
  const waiting = preparation.wait(late, async () => { cleaned = true; });
  preparation.cancel();
  await assert.rejects(waiting, (error) => error.code === "upload_cancelled");
  resolveLate({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
  preparation.dispose();
});

test("上传准备按 deadline 超时", async () => {
  const preparation = createUploadPreparation(20);
  await assert.rejects(preparation.wait(new Promise(() => {})), (error) => error.code === "suno_network_error");
  preparation.dispose();
});

test("外链仅允许无账号信息的 HTTP/HTTPS", () => {
  assert.equal(safeExternalUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeExternalUrl("http://example.com/"), "http://example.com/");
  for (const value of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "https://u:p@example.com/", "https://example.com\\x", ""])
    assert.equal(safeExternalUrl(value), "");
});

test("renderer 文档必须是精确本地文件且不能带 query", () => {
  const renderer = path.resolve("electron/renderer/index.html");
  const url = pathToFileURL(renderer).href;
  assert.equal(isRendererDocument(url, renderer), true);
  assert.equal(isRendererDocument(`${url}?x=1`, renderer), false);
  assert.equal(isRendererDocument("https://example.com/", renderer), false);
});

test("ExecutionGrant 拒绝非法 token 并可安全清理", () => {
  assert.throws(() => verifyGrant("invalid", {}), /execution_grant_invalid/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-grant-"));
  const grant = new ExecutionGrant(directory);
  assert.equal(grant.usable({ session_id: "s", device_id: "d" }), false);
  fs.writeFileSync(grant.file, "invalid", "ascii");
  grant.clear();
  assert.equal(fs.existsSync(grant.file), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("worker 完整性接受原版并拒绝篡改文件", () => {
  const original = path.resolve("backend/backend.exe");
  assert.equal(verifyWorker(original), original);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-integrity-"));
  const altered = path.join(directory, "backend.exe");
  fs.copyFileSync(original, altered);
  fs.appendFileSync(altered, Buffer.from([0]));
  assert.throws(() => verifyWorker(altered), /执行组件已被修改/);
  fs.rmSync(directory, { recursive: true, force: true });
});
