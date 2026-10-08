const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { TaskAuthorizationBroker } = require("../electron/main/task-authorization-broker");

function postTask(env, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: Number(env.GAOBAI_TASK_PORT),
      path: "/task",
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GAOBAI_TASK_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": encoded.length,
      },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.end(encoded);
  });
}

const nonce = () => crypto.randomBytes(32).toString("base64url");

test("任务 broker 完成 acquire/renew/release 且绑定 feature/task/session", async () => {
  const session = { session_id: "session-1", device_id: "device-1" };
  const leaseId = "a".repeat(32);
  const calls = [];
  const broker = new TaskAuthorizationBroker({
    getSession: () => session,
    requestTask: async (_session, body) => {
      calls.push(body);
      if (body.action === "release") return { ok: true, released: true };
      return { ok: true, task_grant: { token: `grant-${body.seq}`, lease_id: leaseId, seq: body.seq, expires_at: 4102444800, renew_after: 1 } };
    },
  });
  const registration = await broker.register("suno_download");
  const taskId = crypto.randomUUID();
  const acquire = await postTask(registration.env, { action: "acquire", feature: "suno_download", task_id: taskId, nonce: nonce(), seq: 0 });
  assert.equal(acquire.status, 200);
  assert.equal(acquire.body.task_grant.lease_id, leaseId);
  const renew = await postTask(registration.env, { action: "renew", feature: "suno_download", task_id: taskId, nonce: nonce(), lease_id: leaseId, seq: 1 });
  assert.equal(renew.status, 200);
  assert.equal(renew.body.task_grant.seq, 1);
  const release = await postTask(registration.env, { action: "release", feature: "suno_download", task_id: taskId, nonce: nonce(), lease_id: leaseId, seq: 2 });
  assert.equal(release.status, 200);
  assert.equal(release.body.released, true);
  assert.deepEqual(calls.map((call) => call.action), ["acquire", "renew", "release"]);
  await registration.close();
  await broker.close();
});

test("任务 broker 拒绝错误 feature、错误 token 和跨任务重放", async () => {
  const session = { session_id: "session-2", device_id: "device-2" };
  const leaseId = "b".repeat(32);
  const broker = new TaskAuthorizationBroker({
    getSession: () => session,
    requestTask: async (_session, body) => ({ ok: true, task_grant: { token: "grant", lease_id: leaseId, seq: body.seq, expires_at: 4102444800, renew_after: 1 } }),
  });
  await assert.rejects(() => broker.register("other"), (error) => error.code === "task_feature_invalid");
  const registration = await broker.register("suno_upload");
  const invalidTokenEnv = { ...registration.env, GAOBAI_TASK_TOKEN: "x".repeat(43) };
  const invalid = await postTask(invalidTokenEnv, { action: "acquire", feature: "suno_upload", task_id: crypto.randomUUID(), nonce: nonce(), seq: 0 });
  assert.equal(invalid.status, 401);
  const firstTask = crypto.randomUUID();
  const acquired = await postTask(registration.env, { action: "acquire", feature: "suno_upload", task_id: firstTask, nonce: nonce(), seq: 0 });
  assert.equal(acquired.status, 200);
  const replay = await postTask(registration.env, { action: "renew", feature: "suno_upload", task_id: crypto.randomUUID(), nonce: nonce(), lease_id: leaseId, seq: 1 });
  assert.equal(replay.status, 403);
  await registration.close();
  await broker.close();
});
