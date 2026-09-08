const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function normalizeSunoUrl(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > 4096 || /[\x00-\x20\x7f\\]/.test(text)) return "";
  // Check the original authority too: URL() normalizes explicit :443 ports.
  if (!/^https:\/\/(?:www\.)?suno\.com\//i.test(text)) return "";
  try {
    const url = new URL(text);
    if (!/^\/(song|s)\/[a-zA-Z0-9_-]{6,128}\/?$/i.test(url.pathname)) return "";
    url.hostname = "suno.com";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

class SunoDownloadController {
  constructor({ dataDir, defaultOutputDir, executable, ffmpeg, env, authorize, onState, spawnProcess = spawn }) {
    Object.assign(this, { dataDir, executable, ffmpeg, env, authorize, onState, spawnProcess });
    this.active = null;
    this.closed = false;
    this.outputDirectory = defaultOutputDir;
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, "suno-download-prefs.json"), "utf8"));
      if (path.isAbsolute(prefs.outputDirectory) && fs.statSync(prefs.outputDirectory).isDirectory()) {
        this.outputDirectory = prefs.outputDirectory;
      }
    } catch { /* First launch uses the system Downloads folder. */ }
    this.state = { ok: true, taskId: "", status: "idle", phase: "idle", running: false,
      message: "粘贴 Suno 歌曲链接，保存为 MP3 或 WAV。", outputDirectory: this.outputDirectory,
      filename: "", progress: null, indeterminate: false, format: "mp3" };
  }

  snapshot() { return { ...this.state }; }

  publish(update) {
    this.state = { ...this.state, ...update, outputDirectory: this.outputDirectory };
    this.onState?.(this.snapshot());
    return this.snapshot();
  }

  reject(message, errorCode) { return { ok: false, message, errorCode }; }

  setOutputDirectory(directory) {
    if (this.active || this.closed) return this.reject("请先等待当前下载结束。", "BUSY");
    try {
      if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error();
      fs.mkdirSync(this.dataDir, { recursive: true });
      const prefs = path.join(this.dataDir, "suno-download-prefs.json");
      fs.writeFileSync(prefs + ".tmp", JSON.stringify({ outputDirectory: directory }), "utf8");
      fs.renameSync(prefs + ".tmp", prefs);
      this.outputDirectory = directory;
      return this.publish({ filename: "", status: "idle", phase: "idle", message: "保存位置已更新。" });
    } catch { return this.reject("无法使用这个文件夹，请重新选择。", "SAVE_FAILED"); }
  }

  async start(payload = {}) {
    if (this.active || this.closed) return this.reject("已有下载正在处理，请稍候。", "BUSY");
    payload = payload || {};
    const url = normalizeSunoUrl(payload.url);
    if (!url) return this.reject("请粘贴有效的 Suno 歌曲链接。", "INVALID_URL");
    if (!["mp3", "wav", "m4a"].includes(payload.format)) return this.reject("请选择 MP3、WAV 或原始源。", "INVALID_FORMAT");
    const task = { id: crypto.randomUUID(), child: null, cancelled: false, terminal: null, settled: false };
    task.done = new Promise((resolve) => { task.resolve = resolve; });
    // Reserve before awaiting authorization so double clicks cannot start two children.
    this.active = task;
    this.publish({ ok: true, taskId: task.id, jobId: "", status: "running", phase: "authorizing",
      running: true, needActivate: false, format: payload.format, filename: "", title: "", errorCode: "", warningMessage: "",
      supportId: "", receivedBytes: 0, totalBytes: null, progress: null, indeterminate: true,
      message: "正在检查软件权益…" });
    try {
      const license = await this.authorize();
      if (task.cancelled || this.closed) return this.finish(task, this.cancelledState());
      if (!license?.ok) return this.finish(task, { ...license, status: "failed", phase: "failed", running: false });
      fs.mkdirSync(this.outputDirectory, { recursive: true });
      task.workRoot = path.join(this.dataDir, "suno-download", task.id);
      fs.mkdirSync(task.workRoot, { recursive: true });
      task.cancelFile = path.join(task.workRoot, "cancel.request");
      const exe = this.executable();
      const args = [...exe.prefixArgs, "--url", url, "--format", payload.format,
        "--output-dir", this.outputDirectory, "--work-root", task.workRoot,
        "--cancel-file", task.cancelFile, "--ffmpeg", this.ffmpeg()];
      task.child = this.spawnProcess(exe.command, args, {
        windowsHide: true, shell: false, env: this.env(), stdio: ["ignore", "pipe", "pipe"],
      });
      let pending = "";
      const acceptLine = (line) => {
        try {
          const next = JSON.parse(line);
          if (!next || typeof next !== "object" || !["running", "succeeded", "failed", "cancelled"].includes(next.status)) return;
          if (next.running === false) task.terminal = next;
          else if (!task.cancelled && this.active === task) this.publish({ ...next, taskId: task.id });
        } catch { /* Only structured snapshots are customer-visible. */ }
      };
      task.child.stdout.setEncoding("utf8");
      task.child.stdout.on("data", (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          acceptLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 65536) pending = "";
      });
      task.child.stderr.resume(); // Drain, but never expose URLs, rights or FFmpeg stderr.
      task.child.on("error", () => this.finish(task, this.failedState("下载组件无法启动，请重新安装最新版软件。")));
      task.child.on("close", (code) => {
        if (pending.trim()) acceptLine(pending);
        const terminal = task.terminal;
        this.finish(task, terminal && (code === 0 || terminal.status !== "succeeded") ? terminal
          : task.cancelled ? this.cancelledState() : this.failedState("下载组件意外退出，请重试。"));
      });
      return this.snapshot();
    } catch {
      return this.finish(task, task.cancelled ? this.cancelledState() : this.failedState("下载未能启动，请检查保存位置后重试。"));
    }
  }

  failedState(message) { return { ok: false, status: "failed", phase: "failed", message, errorCode: "DOWNLOAD_START_FAILED" }; }
  cancelledState() { return { ok: false, status: "cancelled", phase: "cancelled", message: "已取消下载。", errorCode: "CANCELLED" }; }

  finish(task, terminal) {
    if (task.settled) return this.snapshot();
    task.settled = true;
    clearTimeout(task.killTimer);
    if (task.cancelFile) { try { fs.unlinkSync(task.cancelFile); } catch {} }
    if (task.workRoot) { try { fs.rmdirSync(task.workRoot); } catch {} } // Only remove an empty, owned job directory.
    if (this.active === task) {
      this.active = null;
      this.publish({ ...terminal, taskId: task.id, running: false, indeterminate: false });
    }
    task.resolve();
    return this.snapshot();
  }

  cancel(taskId) {
    const task = this.active;
    if (!task || task.id !== taskId) return this.reject("这次下载已经结束。", "STALE_JOB");
    if (task.cancelled) return this.snapshot();
    if (task.cancelFile) {
      try { fs.writeFileSync(task.cancelFile, "cancel", "utf8"); } catch {
        return this.reject("暂时无法取消，请稍后重试。", "CANCEL_FAILED");
      }
    }
    task.cancelled = true;
    this.publish({ phase: "cancelling", message: "正在取消并清理临时文件…", progress: null, indeterminate: true });
    task.killTimer = setTimeout(() => {
      if (!task.child) return this.finish(task, this.cancelledState());
      if (process.platform === "win32" && task.child.pid) {
        const killer = spawn("taskkill", ["/PID", String(task.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => task.child.kill());
      } else task.child.kill("SIGKILL");
    }, 15000);
    task.killTimer.unref?.();
    return this.snapshot();
  }

  async shutdown() {
    this.closed = true;
    if (!this.active) return;
    const task = this.active;
    this.cancel(task.id);
    await task.done;
  }
}

function installSunoDownload({ app, ipcMain, dialog, shell, getWindow, executable, ffmpeg, env, authorize }) {
  const {SunoDownloadBatch} = require("./suno-download-batch");
  const controller = new SunoDownloadBatch({
    dataDir: app.getPath("userData"), defaultOutputDir: app.getPath("downloads"), executable, ffmpeg, env, authorize,
    onState: (state) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send("suno-download:event", state);
    },
  }, SunoDownloadController, normalizeSunoUrl);
  ipcMain.handle("suno-download:state", () => controller.snapshot());
  ipcMain.handle("suno-download:start", (_event, payload) => controller.start(payload));
  ipcMain.handle("suno-download:cancel", (_event, taskId) => controller.cancel(taskId));
  ipcMain.handle("suno-download:pick-directory", async () => {
    if (controller.active) return controller.reject("下载过程中不能更改保存位置。", "BUSY");
    const result = await dialog.showOpenDialog(getWindow(), { title: "选择歌曲保存位置",
      defaultPath: controller.outputDirectory, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? controller.snapshot() : controller.setOutputDirectory(result.filePaths[0]);
  });
  ipcMain.handle("suno-download:reveal", async () => {
    const state = controller.snapshot();
    if (state.running || !state.filename || path.basename(state.filename) !== state.filename) {
      return controller.reject("还没有下载完成的歌曲。", "NO_RESULT");
    }
    const target = path.join(state.outputDirectory, state.filename);
    if (!fs.existsSync(target)) return controller.reject("文件已被移动或删除。", "FILE_MISSING");
    shell.showItemInFolder(target);
    return { ok: true };
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (!controller.active) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    controller.shutdown().finally(() => app.quit());
  });
  return controller;
}

module.exports = { normalizeSunoUrl, SunoDownloadController, installSunoDownload };
