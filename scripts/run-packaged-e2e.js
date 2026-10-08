"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const executable = path.join(root, "dist", "win-unpacked", "Suno歌曲上传器.exe");
if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
  throw new Error(`缺少打包程序：${executable}，请先运行 electron-builder --dir。`);
}

const port = 19300 + Math.floor(Math.random() * 500);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "suno-packaged-e2e-"));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suno-worker-e2e-"));
const markerDir = path.join(fixtureRoot, "markers");
const tokenDir = path.join(userData, "network");
fs.mkdirSync(tokenDir, { recursive: true });
fs.writeFileSync(path.join(tokenDir, "current_browser_token.json"), JSON.stringify({
  token: "e2e." + "x".repeat(100) + ".token",
  tokenSource: "e2e-controlled",
  loginMethod: "extension",
  captured_at: Math.floor(Date.now() / 1000),
  account: { userId: "e2e-user", username: "e2e" },
}), "utf8");
const backendStub = path.join(fixtureRoot, "backend-stub.py");
const downloadStub = path.join(fixtureRoot, "download-stub.py");
fs.mkdirSync(markerDir);
fs.writeFileSync(backendStub, String.raw`import json, os, pathlib, sys
args = sys.argv[1:]
markers = pathlib.Path(os.environ["GAOBAI_E2E_MARKER_DIR"])
if "--prepare-suno-token" in args:
    print(json.dumps({"ok": True, "loggedIn": True, "code": "ready", "account": {"userId": "e2e-user"}}), flush=True)
elif "--resume-candidate" in args:
    print(json.dumps({"ok": True, "candidate": None}), flush=True)
elif "--source" in args:
    (markers / "upload-source.json").write_text(json.dumps(args), encoding="utf-8")
    print(json.dumps({"type": "result", "songUrl": "https://suno.com/song/e2e-upload", "title": "e2e-temp-audio"}), flush=True)
elif "--lyrics-mode" in args:
    print(json.dumps({"ok": True, "text": "ni hao"}), flush=True)
else:
    print(json.dumps({"ok": True}), flush=True)
`, "utf8");
fs.writeFileSync(downloadStub, String.raw`import json, os, pathlib, sys
args = sys.argv[1:]
markers = pathlib.Path(os.environ["GAOBAI_E2E_MARKER_DIR"])
(markers / "download-worker.json").write_text(json.dumps(args), encoding="utf-8")
filename = "e2e-download." + args[args.index("--format") + 1]
print(json.dumps({"ok": True, "status": "succeeded", "phase": "succeeded", "running": False,
                  "filename": filename, "message": "E2E 下载 worker 已启动"}), flush=True)
`, "utf8");
const e2eEnv = {
  ...process.env,
  GAOBAI_E2E_MODE: "1",
  GAOBAI_E2E_BACKEND_SCRIPT: backendStub,
  GAOBAI_E2E_DOWNLOAD_SCRIPT: downloadStub,
  GAOBAI_E2E_MARKER_DIR: markerDir,
};
const app = spawn(executable, [
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=${port}`,
], { cwd: root, env: e2eEnv, stdio: "ignore", windowsHide: true });

function debugEndpointReady() {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await debugEndpointReady()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("打包程序的 CDP 调试端口未在 30 秒内就绪。");
}

function runPython(script) {
  const result = spawnSync("python", [path.join(root, "tests", script)], {
    cwd: root,
    env: { ...e2eEnv, E2E_CDP_URL: `http://127.0.0.1:${port}`, PYTHONUTF8: "1" },
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} 失败，退出码 ${result.status}`);
}

(async () => {
  try {
    await waitUntilReady();
    runPython("e2e-packaged.py");
    runPython("e2e-internal-mode.py");
    console.log("打包版关键 E2E 通过。");
  } finally {
    if (process.platform === "win32" && app.pid) {
      spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else if (!app.killed) {
      app.kill("SIGTERM");
    }
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
