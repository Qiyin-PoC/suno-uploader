const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const QUEUE_STATUSES = new Set([
  "idle",
  "ready",
  "running",
  "pausing",
  "paused",
  "waiting_login",
  "completed",
  "cancelled",
]);
const ITEM_STATUSES = new Set([
  "pending",
  "preparing",
  "uploading",
  "completed",
  "failed",
  "cancelled",
  "waiting_login",
]);
const ACTIVE_QUEUE_STATUSES = new Set(["running", "pausing"]);
const VALID_SPEEDS = new Set(["stable", "onbeat2x"]);

function cleanTitle(value, audioPath) {
  const title = String(value || "").trim();
  if (title) return title.slice(0, 180);
  // 队列里的路径可能来自 Windows（反斜杠分隔）。先归一为 / 再取文件名，
  // 避免在非 Windows 平台上把整条路径当成文件名（"C:\music\A" 而非 "A"）。
  const normalized = String(audioPath || "").replace(/\\/g, "/");
  return path.basename(normalized).replace(/\.[^.]+$/, "").slice(0, 180);
}

function normalizeItem(item = {}, index = 0, idFactory = () => crypto.randomUUID()) {
  const audioPath = String(item.audioPath || "").trim();
  const status = ITEM_STATUSES.has(item.status) ? item.status : "pending";
  return {
    id: String(item.id || idFactory()),
    audioPath,
    accountId: ["1","2","3"].includes(String(item.accountId)) ? String(item.accountId) : "1",
    accountUserId: String(item.accountUserId || ""),
    title: cleanTitle(item.title, audioPath),
    speed: VALID_SPEEDS.has(item.speed) ? item.speed : "onbeat2x",
    status,
    progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
    message: String(item.message || ""),
    resultUrl: String(item.resultUrl || ""),
    error: String(item.error || ""),
    elapsedSec: Math.max(0, Number(item.elapsedSec) || 0),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
  };
}

function emptyState() {
  return {
    version: 1,
    id: "",
    status: "idle",
    currentItemId: "",
    pauseRequested: false,
    items: [],
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeState(value, idFactory = () => crypto.randomUUID()) {
  const source = value && typeof value === "object" ? value : {};
  const items = Array.isArray(source.items)
    ? source.items.map((item, index) => normalizeItem(item, index, idFactory))
    : [];
  let status = QUEUE_STATUSES.has(source.status) ? source.status : (items.length ? "ready" : "idle");
  let currentItemId = String(source.currentItemId || "");

  // A process cannot survive an app restart. Preserve its work as pending and
  // require an explicit resume so reopening the app never starts uploads.
  if (ACTIVE_QUEUE_STATUSES.has(status) || currentItemId) {
    items.forEach((item) => {
      if (["preparing", "uploading"].includes(item.status)) {
        item.status = "pending";
        item.progress = 0;
        item.message = "软件重启后等待继续";
      }
    });
    status = items.some((item) => item.status === "pending") ? "paused" : status;
    currentItemId = "";
  }

  items.sort((left, right) => left.order - right.order);
  items.forEach((item, index) => { item.order = index; });
  return {
    version: 1,
    id: String(source.id || ""),
    status,
    currentItemId,
    pauseRequested: false,
    items,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

class PersistentUploadBatchQueue {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.fs = options.fs || fs;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.now = options.now || (() => new Date().toISOString());
    this.state = emptyState();
    this.load();
  }

  load() {
    try {
      if (!this.fs.existsSync(this.filePath)) return this.snapshot();
      const raw = this.fs.readFileSync(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw), this.idFactory);
      this.save();
    } catch (_) {
      this.state = emptyState();
    }
    return this.snapshot();
  }

  save() {
    const updatedAt = this.now();
    this.state.updatedAt = updatedAt;
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    this.fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), "utf8");
    this.fs.renameSync(temporary, this.filePath);
    return this.snapshot();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  replace(items) {
    const seen = new Set();
    const normalized = [];
    for (const item of Array.isArray(items) ? items : []) {
      const next = normalizeItem(item, normalized.length, this.idFactory);
      if (!next.audioPath) continue;
      const key = process.platform === "win32" ? next.audioPath.toLowerCase() : next.audioPath;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(next);
    }
    const now = this.now();
    this.state = {
      version: 1,
      id: normalized.length ? this.idFactory() : "",
      status: normalized.length ? "ready" : "idle",
      currentItemId: "",
      pauseRequested: false,
      items: normalized,
      createdAt: normalized.length ? now : null,
      updatedAt: now,
    };
    return this.save();
  }

  updateQueue(patch = {}, save = true) {
    this.state = { ...this.state, ...patch };
    return save ? this.save() : this.snapshot();
  }

  updateItem(itemId, patch = {}, save = true) {
    const item = this.state.items.find((candidate) => candidate.id === itemId);
    if (!item) return this.snapshot();
    Object.assign(item, patch);
    item.progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
    if (!ITEM_STATUSES.has(item.status)) item.status = "pending";
    return save ? this.save() : this.snapshot();
  }

  nextPending() {
    return this.state.items.find((item) => item.status === "pending") || null;
  }

  retryItem(itemId) {
    const item = this.state.items.find((candidate) => candidate.id === itemId);
    if (!item || !["failed", "cancelled", "waiting_login"].includes(item.status)) return this.snapshot();
    Object.assign(item, {
      status: "pending",
      progress: 0,
      message: "等待上传",
      error: "",
      resultUrl: "",
      elapsedSec: 0,
      startedAt: null,
      completedAt: null,
    });
    if (!ACTIVE_QUEUE_STATUSES.has(this.state.status)) this.state.status = "ready";
    return this.save();
  }
}

module.exports = {
  ACTIVE_QUEUE_STATUSES,
  PersistentUploadBatchQueue,
  VALID_SPEEDS,
  emptyState,
  normalizeItem,
  normalizeState,
};
