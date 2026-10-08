const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { ExecutionGrant } = require("./execution-grant");

const execFileAsync = promisify(execFile);
const DEVICE_HASH_PREFIX = "jfmhstudio:v2:";
const TERMINAL_REASONS = new Set([
  "session_expired",
  "session_replaced",
  "device_mismatch",
  "device_revoked",
  "entitlement_expired",
]);
const MAX_HEARTBEAT_FAILURES = 6;

function parseServerTime(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  return Date.parse(normalized);
}

function computeDeviceId(machineId) {
  return crypto.createHash("sha256").update(`${DEVICE_HASH_PREFIX}${String(machineId)}`, "utf8").digest("hex");
}

function unwrapPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return { ...payload, ...payload.data };
  }
  return payload;
}

function apiReason(payload, fallback = "session_service_unavailable") {
  const body = unwrapPayload(payload);
  return String(body.reason_code || body.error_code || body.code || fallback).trim() || fallback;
}

function parseLoginSession(payload, device) {
  const body = unwrapPayload(payload);
  const session = body.session && typeof body.session === "object" ? body.session : {};
  const tokens = body.tokens && typeof body.tokens === "object" ? body.tokens : {};
  const entitlement = body.entitlement && typeof body.entitlement === "object"
    ? body.entitlement
    : (session.entitlement && typeof session.entitlement === "object" ? session.entitlement : {});
  const user = body.user && typeof body.user === "object"
    ? body.user
    : (body.account && typeof body.account === "object" ? body.account : {});
  const result = {
    protocol_version: 2,
    session_id: String(body.session_id || session.id || session.session_id || "").trim(),
    session_token: String(body.session_token || tokens.session_token || session.token || session.session_token || "").trim(),
    access_token: String(body.access_token || tokens.access_token || body.token || "").trim(),
    heartbeat_interval: Math.max(10, Number(body.heartbeat_interval || session.heartbeat_interval || 30) || 30),
    session_timeout: Math.max(30, Number(body.session_timeout || session.session_timeout || 100) || 100),
    entitlement,
    user,
    device_id: device.device_id,
    device_name: device.device_name,
    created_at: new Date().toISOString(),
  };
  if (!result.session_id || !result.session_token || !result.access_token) {
    throw new Error("V2 login response is missing session credentials");
  }
  return result;
}

function activeEntitlement(entitlement) {
  if (!entitlement || typeof entitlement !== "object") return false;
  if (Object.keys(entitlement).length === 0) return false;
  if (entitlement.status && !["active", "valid", "enabled"].includes(String(entitlement.status).toLowerCase())) return false;
  if (entitlement.is_permanent === true || entitlement.is_lifetime === true) return true;
  const expiresAt = entitlement.expires_at || entitlement.expire_at || null;
  if (!expiresAt) return false;
  const expiresMs = parseServerTime(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

function requestJson(baseUrl, pathname, options = {}) {
  const bodyBuffer = options.body ? Buffer.from(JSON.stringify(options.body), "utf8") : null;
  const timeoutMs = Number(options.timeoutMs || 3000);
  return new Promise((resolve, reject) => {
    let deadline;
    const request = https.request(`${baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(bodyBuffer ? { "Content-Type": "application/json", "Content-Length": bodyBuffer.length } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
    }, (response) => {
      let text = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (options.maxResponseBytes && bytes > options.maxResponseBytes) {
          response.destroy(); request.destroy(new Error("response_too_large")); return;
        }
        text += chunk;
      });
      response.on("error", (error) => { clearTimeout(deadline); reject(error); });
      response.on("end", () => {
        clearTimeout(deadline);
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { message: text }; }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          body,
        });
      });
    });
    if (options.absoluteTimeout) deadline = setTimeout(() => request.destroy(new Error("request_timeout")), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request_timeout")));
    request.on("error", (error) => { clearTimeout(deadline); reject(error); });
    if (bodyBuffer) request.write(bodyBuffer);
    request.end();
  });
}

async function readMachineId(platform = process.platform) {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("reg.exe", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ], { windowsHide: true, encoding: "utf8", timeout: 3000 });
    const match = String(stdout).match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
    if (match && match[1].trim()) return match[1].trim();
  }
  if (platform === "darwin") {
    const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const match = String(stdout).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
    if (match && match[1].trim()) return match[1].trim();
  }
  throw new Error("hardware_id_unavailable");
}

function platformLabel(platform = process.platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return platform;
}

function platformVersion(platform = process.platform, release = os.release()) {
  if (platform === "win32") {
    const build = Number(String(release).split(".")[2] || 0);
    return build >= 22000 ? "11" : "10";
  }
  return String(release || "");
}

class AccountSessionV2 {
  constructor(options) {
    this.app = options.app;
    this.safeStorage = options.safeStorage;
    this.apiBase = options.apiBase;
    this.appVersion = options.appVersion;
    this.appId = options.appId || "jfmhstudio";
    this.onState = options.onState || (() => {});
    this.log = options.log || (() => {});
    this.request = options.request || requestJson;
    this.authFile = path.join(this.app.getPath("userData"), "account_auth.bin");
    this.loginPreferencesFile = path.join(this.app.getPath("userData"), "account_login_preferences.bin");
    this.deviceFallbackFile = path.join(this.app.getPath("userData"), "device_identity.bin");
    this.session = null;
    this.device = null;
    this.failureCount = 0;
    this.connectionStatus = "offline";
    this.reasonCode = "account_not_logged_in";
    this.heartbeatTimer = null;
    this.heartbeatInFlight = null;
    this.initializePromise = null;
    this.executionGrant = new ExecutionGrant(this.app.getPath("userData"));
    this.executionRequested = false;
  }

  readEncrypted(filePath) {
    // 先判断文件是否存在，再去问钥匙串：没有凭据时不应该触发授权弹窗。
    // macOS 上 isEncryptionAvailable() 会真的访问钥匙串，而 ad-hoc 签名的
    // cdhash 每次构建都不同，系统会反复弹「允许／始终允许」的授权框。
    if (!fs.existsSync(filePath)) return "";
    if (!this.safeStorage.isEncryptionAvailable()) return "";
    return this.safeStorage.decryptString(fs.readFileSync(filePath));
  }

  writeEncrypted(filePath, value) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.safeStorage.encryptString(String(value)));
  }

  loadSession() {
    try {
      const raw = this.readEncrypted(this.authFile).trim();
      if (!raw.startsWith("{")) return null;
      const value = JSON.parse(raw);
      return value && value.protocol_version === 2 && value.session_id && value.session_token ? value : null;
    } catch (error) {
      this.log(`V2 session load failed: ${error.message || error}`, "warn");
      return null;
    }
  }

  saveSession() {
    if (!this.session) return;
    this.writeEncrypted(this.authFile, JSON.stringify(this.session));
  }

  clearSession() {
    this.executionGrant.clear();
    this.executionRequested = false;
    this.session = null;
    try { fs.unlinkSync(this.authFile); } catch (_) {}
  }

  loadLoginPreferences() {
    try {
      const raw = this.readEncrypted(this.loginPreferencesFile).trim();
      if (!raw.startsWith("{")) return null;
      const value = JSON.parse(raw);
      const email = String(value?.email || "").trim().toLowerCase();
      if (!email) return null;
      return {
        email,
        password: String(value?.password || ""),
        rememberPassword: Boolean(value?.rememberPassword && value?.password),
        autoLogin: Boolean(value?.autoLogin && value?.rememberPassword && value?.password),
      };
    } catch (error) {
      this.log(`Account login preferences load failed: ${error.message || error}`, "warn");
      return null;
    }
  }

  saveLoginPreferences({ email, password, rememberPassword, autoLogin }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) return;
    const shouldRemember = Boolean(rememberPassword && password);
    this.writeEncrypted(this.loginPreferencesFile, JSON.stringify({
      version: 1,
      email: normalizedEmail,
      password: shouldRemember ? String(password) : "",
      rememberPassword: shouldRemember,
      autoLogin: Boolean(shouldRemember && autoLogin),
      updatedAt: new Date().toISOString(),
    }));
  }

  getLoginFormPreferences() {
    const preferences = this.loadLoginPreferences();
    return preferences || { email: "", password: "", rememberPassword: false, autoLogin: false };
  }

  getAutoLoginCredentials() {
    const preferences = this.loadLoginPreferences();
    if (!preferences?.autoLogin || !preferences.password) return null;
    return { email: preferences.email, password: preferences.password };
  }

  clearLoginPreferences({ keepEmail = false } = {}) {
    const email = keepEmail ? this.loadLoginPreferences()?.email : "";
    if (email) {
      this.writeEncrypted(this.loginPreferencesFile, JSON.stringify({
        version: 1,
        email,
        password: "",
        rememberPassword: false,
        autoLogin: false,
        updatedAt: new Date().toISOString(),
      }));
      return;
    }
    try { fs.unlinkSync(this.loginPreferencesFile); } catch (_) {}
  }

  async getDevice() {
    if (this.device) return this.device;
    let machineId = "";
    try {
      machineId = await readMachineId();
    } catch (_) {
      try { machineId = this.readEncrypted(this.deviceFallbackFile).trim(); } catch (_) {}
      if (!machineId) {
        machineId = crypto.randomUUID();
        this.writeEncrypted(this.deviceFallbackFile, machineId);
      }
    }
    this.device = {
      device_id: computeDeviceId(machineId),
      device_name: os.hostname() || "Unknown device",
      os: platformLabel(),
      os_version: platformVersion(),
    };
    return this.device;
  }

  publicState() {
    const entitlement = this.session?.entitlement || {};
    const loggedIn = Boolean(this.session?.session_id && this.session?.session_token);
    const entitlementValid = activeEntitlement(entitlement);
    const valid = loggedIn && entitlementValid && this.connectionStatus !== "blocked";
    return {
      ok: true,
      protocol_version: 2,
      loggedIn,
      valid,
      reason_code: valid ? "account_entitlement_valid" : this.reasonCode,
      connection_status: this.connectionStatus,
      heartbeat_failures: this.failureCount,
      session_id: this.session?.session_id || "",
      user: this.session?.user || null,
      entitlement,
      device_limit: Number(entitlement.device_limit || 0),
      expires_at: entitlement.expires_at || entitlement.expire_at || null,
      is_permanent: Boolean(entitlement.is_permanent || entitlement.is_lifetime),
    };
  }

  emit() {
    this.onState(this.publicState());
  }

  async initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      this.executionGrant.clear();
      await this.getDevice();
      this.session = this.loadSession();
      if (!this.session) return this.publicState();
      this.connectionStatus = "reconnecting";
      this.reasonCode = "account_reconnecting";
      this.emit();
      await this.heartbeat();
      if (this.session) this.scheduleHeartbeat();
      return this.publicState();
    })();
    return this.initializePromise;
  }

  async login(email, password) {
    const device = await this.getDevice();
    const response = await this.request(this.apiBase, "/auth/login", {
      method: "POST",
      timeoutMs: 10000,
      body: {
        email,
        password,
        app_id: this.appId,
        device_id: device.device_id,
        device_name: device.device_name,
        os: device.os,
        os_version: device.os_version,
        app_version: this.appVersion,
        protocol_version: 2,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason_code: apiReason(response.body, [401, 422].includes(response.status) ? "invalid_credentials" : "session_service_unavailable"),
        message: response.body?.message || "Login failed",
        details: response.body,
      };
    }
    this.stopHeartbeat();
    this.executionGrant.clear();
    this.session = parseLoginSession(response.body, device);
    this.failureCount = 0;
    this.connectionStatus = "online";
    this.reasonCode = activeEntitlement(this.session.entitlement) ? "account_entitlement_valid" : "membership_required";
    this.saveSession();
    const heartbeat = await this.heartbeat();
    if (this.session) this.scheduleHeartbeat();
    const state = this.publicState();
    return {
      ok: Boolean(this.session && state.valid),
      heartbeat,
      state,
      reason_code: state.valid ? "" : (heartbeat?.reason_code || state.reason_code),
      message: state.valid ? "" : "Session verification failed",
    };
  }

  applyServerPayload(payload) {
    if (!this.session) return;
    const body = unwrapPayload(payload);
    if (body.entitlement && typeof body.entitlement === "object") {
      this.session.entitlement = { ...(this.session.entitlement || {}), ...body.entitlement };
    }
    if (body.user && typeof body.user === "object") this.session.user = body.user;
    this.session.last_heartbeat_at = new Date().toISOString();
    this.saveSession();
  }

  block(reasonCode, clear = false) {
    this.failureCount = Math.max(this.failureCount, 3);
    this.connectionStatus = "blocked";
    this.reasonCode = reasonCode || "session_expired";
    this.stopHeartbeat();
    if (clear) this.clearSession();
    this.emit();
  }

  async heartbeat() {
    if (!this.session) return { ok: false, reason_code: "account_not_logged_in" };
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    this.heartbeatInFlight = (async () => {
      const current = this.session;
      const requestGrant = this.executionRequested && !this.executionGrant.usable(current, 300);
      try {
        const response = await this.request(this.apiBase, "/session/heartbeat", {
          method: "POST",
          timeoutMs: 3000,
          token: current.session_token,
          body: { session_id: current.session_id, device_id: current.device_id,
            ...(requestGrant ? {execution_grant:true} : {}) },
        });
        if (this.session !== current) return {ok:false, reason_code:"session_changed"};
        if (response.ok) {
          if (requestGrant) {
            const grant = unwrapPayload(response.body).execution_grant;
            if (!grant) throw new Error("execution_grant_missing");
            this.executionGrant.accept(grant, current);
          }
          this.failureCount = 0;
          this.connectionStatus = "online";
          this.reasonCode = "account_entitlement_valid";
          this.applyServerPayload(response.body);
          this.emit();
          return { ok: true };
        }
        const reason = apiReason(response.body, response.status === 401 ? "session_expired" : "session_service_unavailable");
        if ([401, 403].includes(response.status) || TERMINAL_REASONS.has(reason)) {
          this.block(reason, true);
          return { ok: false, reason_code: reason, terminal: true };
        }
        this.failureCount += 1;
      } catch (error) {
        if (this.session !== current) return {ok:false, reason_code:"session_changed"};
        this.failureCount += 1;
        this.log(`V2 heartbeat failed (${this.failureCount}): ${error.message || error}`, "warn");
      }
      if (this.failureCount >= MAX_HEARTBEAT_FAILURES) {
        this.connectionStatus = "blocked";
        this.reasonCode = "session_service_unavailable";
      } else {
        this.connectionStatus = "reconnecting";
        this.reasonCode = "account_reconnecting";
      }
      this.emit();
      return { ok: false, reason_code: this.reasonCode, failures: this.failureCount };
    })().finally(() => { this.heartbeatInFlight = null; });
    return this.heartbeatInFlight;
  }

  async ensureExecutionGrant(feature) {
    if (!this.session || this.connectionStatus === "blocked") return {ok:false, reason_code:"account_not_logged_in"};
    this.executionRequested = true;
    if (!this.executionGrant.usable(this.session, 30, feature)) {
      // An existing heartbeat may have started before a paid action requested a grant.
      if (this.heartbeatInFlight) await this.heartbeatInFlight;
      if (!this.executionGrant.usable(this.session, 30, feature)) await this.heartbeat();
    }
    return this.executionGrant.usable(this.session, 0, feature)
      ? {ok:true} : {ok:false, reason_code:"execution_grant_required", message:"功能授权暂时无法验证，请联网并重新登录官网账号后重试。"};
  }

  taskAuthorizationSession() {
    return this.session?.session_id && this.session?.session_token && this.session?.device_id &&
      this.connectionStatus !== "blocked" ? this.session : null;
  }

  async requestExecutionTask(current, body) {
    if (!current || this.taskAuthorizationSession() !== current) return { ok: false, status: 401, reason_code: "session_changed" };
    // Only the main process selects the HTTPS website and supplies its session
    // token. Neither the native child nor the loopback request can override them.
    const endpoint = new URL(this.apiBase);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return { ok: false, status: 503, reason_code: "task_endpoint_invalid" };
    try {
      const response = await this.request(this.apiBase, "/execution/task", {
        method: "POST", timeoutMs: 6000, absoluteTimeout: true, maxResponseBytes: 16384,
        token: current.session_token,
        body: { ...body, session_id: current.session_id, device_id: current.device_id },
      });
      if (this.taskAuthorizationSession() !== current) return { ok: false, status: 401, reason_code: "session_changed" };
      const payload = unwrapPayload(response.body);
      if (response.ok && payload.ok !== false) return { ok: true, task_grant: payload.task_grant, released: payload.released };
      const reason = apiReason(payload, "task_authorization_denied");
      if (response.status === 401 || TERMINAL_REASONS.has(reason)) this.block(reason, true);
      return { ok: false, status: response.status || 503, reason_code: reason,
        message: response.status === 429 ? "正在处理的任务较多，请稍后重试。" : "任务授权未通过，请检查官网账号权益或重新登录。" };
    } catch {
      return { ok: false, status: 503, reason_code: "task_service_unavailable", message: "任务授权连接暂时不可用，请检查网络后重试。" };
    }
  }

  scheduleHeartbeat() {
    this.stopHeartbeat();
    if (!this.session) return;
    const baseSeconds = Number(this.session.heartbeat_interval || 30);
    const jitterSeconds = crypto.randomInt(-5, 6);
    const delayMs = Math.max(10000, (baseSeconds + jitterSeconds) * 1000);
    this.heartbeatTimer = setTimeout(async () => {
      await this.heartbeat();
      if (this.session) this.scheduleHeartbeat();
    }, delayMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async logout() {
    const current = this.session;
    this.stopHeartbeat();
    if (current) {
      try {
        const response = await this.request(this.apiBase, "/auth/logout", {
          method: "POST",
          timeoutMs: 3000,
          token: current.session_token,
          body: { session_id: current.session_id, device_id: current.device_id },
        });
        if (this.session !== current) return {ok: false, reason_code: "session_changed"};
        if (!response.ok && ![401, 403].includes(response.status)) {
          const reason = apiReason(response.body, "session_service_unavailable");
          this.connectionStatus = "reconnecting";
          this.reasonCode = reason;
          this.emit();
          this.scheduleHeartbeat();
          return { ok: false, reason_code: reason, message: response.body?.message || "Logout failed" };
        }
      } catch (error) {
        if (this.session !== current) return {ok: false, reason_code: "session_changed"};
        this.log(`V2 logout request failed: ${error.message || error}`, "warn");
        this.connectionStatus = "reconnecting";
        this.reasonCode = "session_service_unavailable";
        this.emit();
        this.scheduleHeartbeat();
        return { ok: false, reason_code: "session_service_unavailable", message: "Logout request failed" };
      }
    }
    this.clearSession();
    this.failureCount = 0;
    this.connectionStatus = "offline";
    this.reasonCode = "account_logged_out";
    this.emit();
    return { ...this.publicState(), ok: true };
  }

  async listDevices() {
    if (!this.session) return { ok: false, reason_code: "account_not_logged_in" };
    const current = this.session;
    const response = await this.request(this.apiBase, `/devices?session_id=${encodeURIComponent(current.session_id)}`, {
      token: current.session_token,
      timeoutMs: 3000,
    });
    if (this.session !== current) return {ok: false, reason_code: "session_changed"};
    if (!response.ok) {
      const reason = apiReason(response.body, "session_service_unavailable");
      if ([401, 403].includes(response.status)) this.block(reason, true);
      return { ok: false, reason_code: reason, message: response.body?.message || "Unable to load devices" };
    }
    const body = unwrapPayload(response.body);
    const devices = Array.isArray(body.devices)
      ? body.devices
      : (Array.isArray(body.items) ? body.items : (Array.isArray(response.body?.data) ? response.body.data : []));
    return { ok: true, devices, device_limit: Number(body.device_limit || this.session.entitlement?.device_limit || 0) };
  }

  async unbindDevice(devicePublicId) {
    if (!this.session) return { ok: false, reason_code: "account_not_logged_in" };
    const current = this.session;
    const safeId = encodeURIComponent(String(devicePublicId || "").trim());
    if (!safeId) return { ok: false, reason_code: "invalid_device" };
    const response = await this.request(this.apiBase, `/devices/${safeId}/unbind`, {
      method: "POST",
      token: current.session_token,
      timeoutMs: 3000,
      body: { session_id: current.session_id },
    });
    if (this.session !== current) return {ok: false, reason_code: "session_changed"};
    if (!response.ok) {
      const reason = apiReason(response.body, "session_service_unavailable");
      if ([401, 403].includes(response.status)) this.block(reason, true);
      return { ok: false, reason_code: reason, message: response.body?.message || "Unable to unbind device" };
    }
    return { ok: true };
  }
}

module.exports = {
  AccountSessionV2,
  activeEntitlement,
  apiReason,
  computeDeviceId,
  parseLoginSession,
  platformVersion,
  unwrapPayload,
};
