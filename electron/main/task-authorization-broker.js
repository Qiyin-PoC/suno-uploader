const crypto = require("node:crypto");
const http = require("node:http");
const { performance } = require("node:perf_hooks");

const FEATURES = new Set(["suno_upload", "suno_download"]);
const ACTIONS = new Set(["acquire", "renew", "release"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const LEASE = /^[0-9a-f]{32}$/;
const MAX_BODY = 8192;
const MAX_CAPABILITIES = 16;
const MAX_IN_FLIGHT = 4;

class TaskAuthorizationError extends Error {
  constructor(code, message, status = 403) { super(message); this.code = code; this.status = status; }
}
function failure(code, message, status = 403) { return new TaskAuthorizationError(code, message, status); }
function bucket(capacity) { return { capacity, tokens: capacity, at: performance.now() }; }
function take(bucketValue) {
  const now = performance.now();
  bucketValue.tokens = Math.min(bucketValue.capacity, bucketValue.tokens + (now - bucketValue.at) * bucketValue.capacity / 60000);
  bucketValue.at = now;
  if (bucketValue.tokens < 1) return false;
  bucketValue.tokens -= 1;
  return true;
}

// This loopback broker holds website credentials in the main process only. A worker
// gets one random capability, restricted to one feature, task and website session.
class TaskAuthorizationBroker {
  constructor({ getSession, requestTask, maxCapabilities = MAX_CAPABILITIES }) {
    this.getSession = getSession;
    this.requestTask = requestTask;
    this.maxCapabilities = Math.min(MAX_CAPABILITIES, Math.max(1, maxCapabilities));
    this.capabilities = new Map();
    this.globalBucket = bucket(32);
    this.inFlight = 0;
    this.closed = false;
    this.server = null;
    this.startPromise = null;
    this.rejectStart = null;
  }

  async start() {
    if (this.closed) throw failure("task_broker_closed", "任务授权服务已关闭，请重新启动软件。");
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.rejectStart = reject;
      const server = this.server = http.createServer({ maxHeaderSize: 4096 }, (request, response) => {
        this.handle(request, response).catch(() => this.respond(response, 503, { ok: false, reason_code: "task_service_unavailable", message: "任务授权暂时不可用，请稍后重试。" }));
      });
      server.maxHeadersCount = 12;
      server.maxConnections = 32;
      server.headersTimeout = 5000;
      server.requestTimeout = 5000;
      server.keepAliveTimeout = 1;
      server.setTimeout(8000, socket => socket.destroy());
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.rejectStart = null;
        if (this.closed) { server.close(); reject(failure("task_broker_closed", "任务授权服务已关闭，请重新启动软件。")); return; }
        server.unref(); resolve(server.address().port);
      });
    }).catch(error => { this.startPromise = null; throw error; });
    return this.startPromise;
  }

  async register(feature) {
    if (!FEATURES.has(feature)) throw failure("task_feature_invalid", "这个功能不能申请上传下载任务授权。");
    const session = this.getSession();
    if (!session) throw failure("account_not_logged_in", "请先登录官网账号后重试。");
    this.invalidateSessions();
    if (this.capabilities.size >= this.maxCapabilities) throw failure("task_local_limit", "正在处理的任务较多，请等待已有任务结束。", 429);
    // Reserve synchronously before awaiting listen, so concurrent launches cannot
    // exceed the cap. Inactive/closed registrations are removed immediately.
    const secret = crypto.randomBytes(32);
    const token = secret.toString("base64url");
    const id = crypto.createHash("sha256").update(secret).digest("hex");
    const record = { id, secret, session, feature, active: true, taskId: "", lease: null,
      pending: null, cache: null, bucket: bucket(8), cleanup: null };
    this.capabilities.set(id, record);
    try {
      const port = await this.start();
      if (!this.isCurrent(record)) throw failure("session_changed", "官网账号已变更，请重新开始任务。");
      return { env: { GAOBAI_TASK_PORT: String(port), GAOBAI_TASK_TOKEN: token },
        close: () => this.revoke(record) };
    } catch (error) { await this.revoke(record); throw error; }
  }

  isCurrent(record) { return !this.closed && record.active && this.getSession() === record.session; }

  invalidateSessions() {
    for (const record of this.capabilities.values()) if (!this.isCurrent(record)) void this.revoke(record);
  }

  async revoke(record) {
    if (record.cleanup) return record.cleanup;
    record.active = false;
    this.capabilities.delete(record.id);
    record.cleanup = (async () => {
      if (record.pending) { try { await record.pending.promise; } catch {} }
      const lease = record.lease;
      record.cache = null;
      record.lease = null;
      if (!lease || this.getSession() !== record.session || this.inFlight >= MAX_IN_FLIGHT) return;
      this.inFlight++;
      try {
        await this.requestTask(record.session, { action: "release", feature: record.feature,
          task_id: record.taskId, nonce: crypto.randomBytes(32).toString("base64url"),
          lease_id: lease.lease_id, seq: lease.seq + 1 });
      } catch { /* A dead worker's lease is bounded by the server TTL. */ }
      finally { this.inFlight--; }
    })();
    return record.cleanup;
  }

  respond(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    const encoded = JSON.stringify(body);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(encoded), "Cache-Control": "no-store", "Connection": "close" });
    response.end(encoded);
  }

  async handle(request, response) {
    const port = this.server?.address()?.port;
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin || request.headers["sec-fetch-site"]) {
      request.resume(); return this.respond(response, 403, { ok: false, reason_code: "task_origin_invalid" });
    }
    if (request.method !== "POST" || request.url !== "/task") {
      request.resume(); return this.respond(response, 404, { ok: false, reason_code: "task_route_invalid" });
    }
    const raw = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || "")?.[1] || "";
    const secret = Buffer.from(raw, "base64url");
    const id = crypto.createHash("sha256").update(secret).digest("hex");
    const record = this.capabilities.get(id);
    const validSecret = secret.length === 32 && raw === secret.toString("base64url") && crypto.timingSafeEqual(secret, record?.secret || Buffer.alloc(32));
    if (!record || !validSecret || !this.isCurrent(record)) {
      if (record) void this.revoke(record);
      request.resume(); return this.respond(response, 401, { ok: false, reason_code: "task_capability_invalid", message: "任务授权已失效，请重新开始任务。" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "") || request.headers["content-encoding"]) {
      request.resume(); return this.respond(response, 415, { ok: false, reason_code: "task_content_invalid" });
    }
    try {
      const body = await this.readBody(request);
      const result = await this.dispatch(record, body);
      this.respond(response, 200, result);
    } catch (error) {
      this.respond(response, error.status || 503, { ok: false, reason_code: error.code || "task_service_unavailable",
        message: error instanceof TaskAuthorizationError ? error.message : "任务授权连接暂时不可用，请稍后重试。" });
    }
  }

  readBody(request) {
    if (Number(request.headers["content-length"] || 0) > MAX_BODY) {
      request.resume(); return Promise.reject(failure("task_request_too_large", "任务授权请求过大。", 413));
    }
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [], settled = false;
      const finish = (error, body) => {
        if (settled) return;
        settled = true; clearTimeout(timer); chunks = [];
        if (error) reject(error); else resolve(body);
      };
      const timer = setTimeout(() => { finish(failure("task_request_timeout", "任务授权请求超时，请重试。", 408)); request.resume(); }, 3000);
      request.on("data", chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY) return finish(failure("task_request_too_large", "任务授权请求过大。", 413));
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (settled) return;
        try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); finish(null, value); }
        catch { finish(failure("task_request_invalid", "任务授权请求无效。", 400)); }
      });
      request.on("error", () => finish(failure("task_request_invalid", "任务授权请求中断。", 400)));
      request.on("aborted", () => finish(failure("task_request_invalid", "任务授权请求中断。", 400)));
    });
  }

  validate(record, value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["action", "feature", "task_id", "nonce", "lease_id", "seq"].includes(key)) ||
      !ACTIONS.has(value.action) || value.feature !== record.feature || typeof value.task_id !== "string" || !UUID.test(value.task_id) ||
      typeof value.nonce !== "string" || !NONCE.test(value.nonce) || Buffer.from(value.nonce, "base64url").toString("base64url") !== value.nonce ||
      !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 1000000 ||
      (value.action === "acquire" ? value.seq !== 0 || Boolean(value.lease_id) : !LEASE.test(value.lease_id || "") || value.seq === 0)) {
      throw failure("task_request_invalid", "任务授权参数无效。", 400);
    }
    if (record.taskId && record.taskId !== value.task_id) throw failure("task_scope_invalid", "这次任务授权不能用于其他任务。");
    if (!record.taskId && value.action !== "acquire") throw failure("task_not_started", "请先开始一个新的任务。");
    if (record.lease && value.action !== "acquire" && record.lease.lease_id !== value.lease_id) throw failure("task_scope_invalid", "任务授权与当前任务不匹配。");
    return { action: value.action, feature: value.feature, task_id: value.task_id, nonce: value.nonce,
      ...(value.action === "acquire" ? {} : { lease_id: value.lease_id }), seq: value.seq };
  }

  async dispatch(record, value) {
    if (!this.isCurrent(record)) throw failure("session_changed", "官网账号已变更，请重新开始任务。");
    const body = this.validate(record, value);
    const key = JSON.stringify(body);
    if (record.pending) {
      if (record.pending.key === key) return record.pending.promise;
      throw failure("task_request_pending", "正在验证当前任务，请稍后重试。", 429);
    }
    if (record.cache?.key === key && performance.now() - record.cache.at < 10000) return record.cache.result;
    if (this.inFlight >= MAX_IN_FLIGHT || !take(record.bucket) || !take(this.globalBucket)) throw failure("task_request_limited", "任务授权请求较频繁，请稍后重试。", 429);
    record.taskId = body.task_id;
    this.inFlight++;
    const promise = (async () => {
      const result = await this.requestTask(record.session, body);
      // Save only cleanup information before checking the session. A late reply
      // must never be delivered to a worker after logout, replacement or close.
      const grant = result?.task_grant;
      if (result?.ok && grant && typeof grant.token === "string" && grant.token.length <= 6144 &&
        LEASE.test(grant.lease_id || "") && Number.isSafeInteger(grant.seq) && grant.seq === body.seq &&
        Number.isSafeInteger(grant.expires_at) && Number.isSafeInteger(grant.renew_after) && grant.renew_after > 0 && grant.renew_after <= 60) {
        record.lease = { lease_id: grant.lease_id, seq: grant.seq };
      } else if (result?.ok && body.action === "release" && result.released === true) record.lease = null;
      else if (result?.ok) throw failure("task_response_invalid", "任务授权响应无效，请更新软件后重试。", 502);
      if (!this.isCurrent(record)) throw failure("session_changed", "官网账号已变更，请重新开始任务。");
      if (!result?.ok) throw failure(result?.reason_code || "task_authorization_denied", result?.message || "任务授权未通过，请检查官网账号权益。", result?.status || 403);
      const output = body.action === "release" ? { ok: true, released: true } : { ok: true, task_grant: {
        token: grant.token, lease_id: grant.lease_id, seq: grant.seq, expires_at: grant.expires_at, renew_after: grant.renew_after,
      } };
      record.cache = { key, result: output, at: performance.now() };
      return output;
    })().finally(() => { record.pending = null; this.inFlight--; });
    record.pending = { key, promise };
    return promise;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectStart?.(failure("task_broker_closed", "任务授权服务已关闭，请重新启动软件。"));
    this.rejectStart = null;
    const cleanups = [...this.capabilities.values()].map(record => this.revoke(record));
    this.server?.close();
    this.server?.closeAllConnections?.();
    await Promise.allSettled(cleanups);
  }
}

module.exports = { TaskAuthorizationBroker, TaskAuthorizationError, MAX_BODY, MAX_CAPABILITIES, MAX_IN_FLIGHT };
