from __future__ import annotations

import argparse
import base64
import concurrent.futures as futures
import copy
import email.utils
import json
import math
import mimetypes
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Force UTF-8 stdout for PyInstaller console-less builds
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import history_store
import lyrics_local
from audio_splitter import Segment, source_file_identity, split_audio
from suno_auth import select_verified_token, token_subject, matching_browser_pids, clear_login_files

try:
    import requests
except Exception:  # pragma: no cover
    requests = None


API = "https://studio-api-prod.suno.com"
CDP_PORT = int(os.environ.get("GAOBAI_CDP_PORT", "23922"))
APP_DATA = history_store.data_dir()
PROJECT_ROOT = Path(os.environ.get("GAOBAI_PROJECT_ROOT", Path(__file__).resolve().parents[1]))
TOKEN_FILE = Path(os.environ.get("GAOBAI_SUNO_TOKEN_FILE", APP_DATA / "network" / "current_browser_token.json"))
RUN_BASE = Path(os.environ.get("GAOBAI_SUNO_WORK_DIR", APP_DATA / "derived" / "auto_recut_run")).expanduser().resolve()
SUNO_THROTTLE_MARKER = RUN_BASE / ".last_suno_throttle.json"
BROWSER_PROFILE = Path(os.environ.get("GAOBAI_BROWSER_PROFILE", APP_DATA / "browser-profile")).expanduser()
_CDP_PAGE_ID: Optional[str] = None
_CDP_DISABLED = False
_IS_WINDOWS = sys.platform.startswith("win")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if _IS_WINDOWS else 0


def _connection_reset_like(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(token in text for token in (
        "ssleoferror",
        "eof occurred",
        "connectionerror",
        "protocolerror",
        "remotedisconnected",
        "connection reset",
        "connection aborted",
        "tls",
        "ssl",
    ))


def mark_suno_throttle_event(reason: str) -> None:
    try:
        SUNO_THROTTLE_MARKER.parent.mkdir(parents=True, exist_ok=True)
        SUNO_THROTTLE_MARKER.write_text(json.dumps({
            "ts": time.time(),
            "reason": str(reason or "")[:160],
        }, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def apply_recent_suno_cooldown(client: "SunoClient") -> None:
    try:
        if not SUNO_THROTTLE_MARKER.exists():
            return
        data = json.loads(SUNO_THROTTLE_MARKER.read_text(encoding="utf-8"))
        age = time.time() - float(data.get("ts") or 0)
        if 0 <= age <= 180:
            wait = max(8.0, min(15.0, 15.0 - age * 0.04))
            client.set_throttle_cooldown(wait)
            emit("log", message=f"Suno recent throttle cooldown before next upload: {wait:.0f}s", detail=True)
        try:
            SUNO_THROTTLE_MARKER.unlink()
        except Exception:
            pass
    except Exception:
        pass


def hidden_subprocess_kwargs() -> Dict[str, Any]:
    if not _IS_WINDOWS:
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0
    return {"creationflags": _NO_WINDOW, "startupinfo": startupinfo}


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def require_requests():
    if requests is None:
        raise RuntimeError("缺少 Python 依赖 requests，请先安装 python/requirements.txt")
    return requests


def now_ms() -> int:
    return int(time.time() * 1000)


def browser_token() -> str:
    inner = json.dumps({"timestamp": now_ms()}, separators=(",", ":")).encode("utf-8")
    return json.dumps({"token": base64.b64encode(inner).decode("ascii")}, separators=(",", ":"))


def cdp_base() -> str:
    return f"http://127.0.0.1:{CDP_PORT}"


def cdp_get(path: str) -> Any:
    req = require_requests()
    response = req.get(cdp_base() + path, timeout=3)
    response.raise_for_status()
    return response.json() if response.text else None


def cdp_put(path: str) -> Any:
    req = require_requests()
    response = req.put(cdp_base() + path, timeout=5)
    response.raise_for_status()
    return response.json() if response.text else None


def cdp_alive() -> bool:
    try:
        cdp_get("/json/version")
        return True
    except Exception:
        return False


def write_browser_diagnostic(**data: Any) -> None:
    try:
        path = APP_DATA / "network" / "browser_diagnostic.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts": int(time.time()),
            "cdp_port": CDP_PORT,
            "browser_profile": str(BROWSER_PROFILE),
            "cdp_alive": cdp_alive(),
        }
        payload.update(data)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def browser_candidates() -> List[Path]:
    candidates: List[Path] = []
    if sys.platform.startswith("win"):
        roots = [
            os.environ.get("PROGRAMFILES", ""),
            os.environ.get("PROGRAMFILES(X86)", ""),
            os.environ.get("LOCALAPPDATA", ""),
        ]
        rels = [
            "Microsoft/Edge/Application/msedge.exe",
            "Google/Chrome/Application/chrome.exe",
            "Chromium/Application/chrome.exe",
        ]
        for root in roots:
            if root:
                for rel in rels:
                    candidates.append(Path(root) / rel)
    elif sys.platform == "darwin":
        candidates += [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
    else:
        for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            found = shutil_which(name)
            if found:
                candidates.append(Path(found))
    env_browser = os.environ.get("GAOBAI_BROWSER", "").strip()
    if env_browser:
        candidates.insert(0, Path(env_browser))
    bundled = PROJECT_ROOT / "browser-bin" / "chromium" / ("chrome.exe" if sys.platform.startswith("win") else "chrome")
    candidates.append(bundled)
    out: List[Path] = []
    seen = set()
    for path in candidates:
        try:
            if path.exists():
                key = str(path.resolve()).lower()
                if key not in seen:
                    seen.add(key)
                    out.append(path)
        except Exception:
            continue
    return out


def shutil_which(name: str) -> Optional[str]:
    import shutil
    return shutil.which(name)


def stop_profile_browser_processes(strict: bool = False) -> None:
    if not sys.platform.startswith("win"):
        if strict:
            raise RuntimeError("当前实验版仅支持 Windows 的浏览器退出清理。")
        return
    try:
        result = subprocess.run([
            "powershell", "-NoProfile", "-Command",
            "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|chromium)\\.exe$' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
            **hidden_subprocess_kwargs())
        if result.returncode:
            raise RuntimeError("无法检查 Suno 专用浏览器进程，请关闭该浏览器后重试。")
        rows = json.loads(result.stdout.strip() or '[]')
        if isinstance(rows, dict):
            rows = [rows]
        for pid in matching_browser_pids(rows, BROWSER_PROFILE):
            stopped = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                                     capture_output=True, timeout=15, **hidden_subprocess_kwargs())
            # Confirm the process exited before deleting its browser profile.
            check = subprocess.run(["powershell", "-NoProfile", "-Command",
                f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"],
                capture_output=True, timeout=10, **hidden_subprocess_kwargs())
            if check.returncode:
                raise RuntimeError("Suno 专用浏览器仍在运行，请关闭后再退出账号。")
    except Exception:
        if strict:
            raise


def cdp_pages() -> List[Dict[str, Any]]:
    try:
        pages = cdp_get("/json/list") or []
        return pages if isinstance(pages, list) else []
    except Exception:
        return []


def cdp_new_page(url: str) -> Dict[str, Any]:
    q = urllib.parse.quote(url, safe="")
    last_error: Optional[BaseException] = None
    for opener in (cdp_put, cdp_get):
        try:
            page = opener("/json/new?" + q)
            if isinstance(page, dict):
                return page
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"无法创建 Suno 页面：{last_error}")


def bring_page_to_front(page: Dict[str, Any]) -> None:
    try:
        ws_url = page.get("webSocketDebuggerUrl")
        if ws_url:
            cdp_call_on_ws(ws_url, "Page.bringToFront", {}, timeout=8)
    except Exception:
        pass


def launch_browser(url: str, force_new_page: bool = False, bring_front: bool = True) -> None:
    global _CDP_DISABLED
    if _CDP_DISABLED:
        raise RuntimeError("浏览器调试端口已禁用，请重启软件后重试。")
    if cdp_alive():
        try:
            page = cdp_new_page(url or "https://suno.com/") if force_new_page else pick_suno_page(url)
            if bring_front:
                bring_page_to_front(page)
            return
        except Exception as exc:
            write_browser_diagnostic(
                stage="existing_cdp_page_failed",
                error=str(exc),
                forceNewPage=force_new_page,
            )
            if not force_new_page:
                return
            stop_profile_browser_processes()
            time.sleep(0.5)
    browsers = browser_candidates()
    write_browser_diagnostic(stage="before_launch", candidates=[str(p) for p in browsers])
    if not browsers:
        _CDP_DISABLED = True
        write_browser_diagnostic(stage="no_browser")
        raise RuntimeError("找不到 Chrome、Edge 或 Chromium，请安装浏览器后重试。")
    BROWSER_PROFILE.mkdir(parents=True, exist_ok=True)
    last_error = ""
    for browser in browsers:
        stop_profile_browser_processes()
        time.sleep(0.35)
        cmd = [
            str(browser),
            f"--remote-debugging-port={CDP_PORT}",
            "--remote-allow-origins=*",
            f"--user-data-dir={BROWSER_PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate",
            "--disable-session-crashed-bubble",
            "--new-window",
            url or "https://suno.com/",
        ]
        try:
            subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            write_browser_diagnostic(stage="launched", browser=str(browser), args=cmd)
        except Exception as exc:
            last_error = f"{browser}: {exc}"
            write_browser_diagnostic(stage="launch_failed", browser=str(browser), error=str(exc))
            continue
        deadline = time.time() + 45
        while time.time() < deadline:
            if cdp_alive():
                try:
                    page = pick_suno_page(url)
                    if bring_front:
                        bring_page_to_front(page)
                except Exception:
                    pass
                write_browser_diagnostic(stage="connected", browser=str(browser))
                return
            time.sleep(0.5)
        last_error = f"{browser}: CDP 连接超时"
        write_browser_diagnostic(stage="timeout", browser=str(browser), error=last_error)
    _CDP_DISABLED = True
    write_browser_diagnostic(stage="failed", error=last_error, candidates=[str(p) for p in browsers])
    raise RuntimeError(f"浏览器调试端口未就绪，请关闭后重试。最后错误：{last_error}")


def pick_suno_page(
    url: str = "https://suno.com/",
    *,
    allow_tracked_any_url: bool = False,
    allow_create: bool = True,
) -> Dict[str, Any]:
    global _CDP_PAGE_ID
    pages = [p for p in cdp_pages() if p.get("type") == "page" and p.get("webSocketDebuggerUrl")]
    if _CDP_PAGE_ID:
        for page in pages:
            if page.get("id") == _CDP_PAGE_ID and (allow_tracked_any_url or "suno.com" in (page.get("url") or "")):
                return page
    for page in pages:
        if "suno.com" in (page.get("url") or ""):
            _CDP_PAGE_ID = page.get("id")
            return page
    for page in pages:
        page_url = (page.get("url") or "").lower()
        if page_url in {"about:blank", "chrome://newtab/", ""}:
            _CDP_PAGE_ID = page.get("id")
            try:
                cdp_call_on_ws(page["webSocketDebuggerUrl"], "Page.navigate", {"url": url}, timeout=45)
            except Exception:
                pass
            return page
    if not allow_create:
        raise RuntimeError("Suno 登录页面暂时不可用，请保持当前登录窗口打开")
    page = cdp_new_page(url or "https://suno.com/")
    _CDP_PAGE_ID = page.get("id")
    return page


def cdp_call_on_ws(ws_url: str, method: str, params: Optional[Dict[str, Any]] = None,
                   timeout: int = 30) -> Any:
    try:
        import websocket  # type: ignore
    except Exception as exc:
        raise RuntimeError("缺少 Python 依赖 websocket-client，请先安装 python/requirements.txt") from exc

    ws = websocket.create_connection(ws_url, timeout=max(10, min(timeout, 60)))
    try:
        try:
            ws.settimeout(max(10, min(timeout, 60)))
        except Exception:
            pass
        msg_id = int(time.time() * 1000) % 100_000_000
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}, separators=(",", ":")))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(ws.recv())
            if message.get("id") == msg_id:
                if "error" in message:
                    raise RuntimeError(json.dumps(message.get("error"), ensure_ascii=False))
                return message.get("result")
        raise RuntimeError(f"CDP {method} timeout after {timeout}s")
    finally:
        try:
            ws.close()
        except Exception:
            pass


def cdp_eval(expression: str, *, quiet: bool = False, allow_login_redirect: bool = False) -> Any:
    global _CDP_PAGE_ID
    last_error = ""
    for attempt in range(3):
        if not (allow_login_redirect and cdp_alive()):
            launch_browser("https://suno.com/", bring_front=not quiet)
        try:
            page = pick_suno_page(
                "https://suno.com/",
                allow_tracked_any_url=allow_login_redirect,
                allow_create=not allow_login_redirect,
            )
            if "suno.com" not in (page.get("url") or "") and not allow_login_redirect:
                cdp_call_on_ws(page["webSocketDebuggerUrl"], "Page.navigate", {"url": "https://suno.com/"}, timeout=45)
                time.sleep(2)
                page = pick_suno_page("https://suno.com/")
            result = cdp_call_on_ws(page["webSocketDebuggerUrl"], "Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
                "timeout": 45000,
            }, timeout=65)
            if isinstance(result, dict) and result.get("exceptionDetails"):
                raise RuntimeError(json.dumps(result.get("exceptionDetails"), ensure_ascii=False)[:500])
            rr = (result or {}).get("result") or {}
            if "value" in rr:
                return rr.get("value")
            return rr.get("description")
        except Exception as exc:
            last_error = str(exc)
            if not allow_login_redirect:
                _CDP_PAGE_ID = None
            emit("log", message=f"[auth-reconnect] browser channel retry {attempt + 1}/3: {last_error}")
            time.sleep(2 + attempt * 2)
    raise RuntimeError(last_error or "CDP Runtime.evaluate failed")


def cdp_call(method: str, params: Optional[Dict[str, Any]] = None, timeout: int = 30) -> Any:
    global _CDP_PAGE_ID
    try:
        page = pick_suno_page("https://suno.com/")
        return cdp_call_on_ws(page["webSocketDebuggerUrl"], method, params, timeout)
    except Exception:
        _CDP_PAGE_ID = None
        page = pick_suno_page("https://suno.com/")
        return cdp_call_on_ws(page["webSocketDebuggerUrl"], method, params, timeout)


def cdp_get_suno_cookie_token() -> Dict[str, Any]:
    """用 CDP Network.getCookies 读取 httpOnly __session。Runtime.evaluate 读不到 httpOnly cookie。"""
    try:
        try:
            cdp_call("Network.enable", timeout=8)
        except Exception:
            pass
        result = cdp_call("Network.getCookies", {
            "urls": [
                "https://suno.com/",
                "https://www.suno.com/",
                "https://clerk.suno.com/",
                "https://accounts.suno.com/",
            ]
        }, timeout=15)
        cookies = result.get("cookies", []) if isinstance(result, dict) else []
        names = [str(c.get("name") or "") for c in cookies if isinstance(c, dict)]
        for c in cookies:
            if not isinstance(c, dict):
                continue
            name = str(c.get("name") or "")
            value = str(c.get("value") or "")
            if value and (name == "__session" or name.startswith("__session")):
                return {"token": value, "tokenSource": "cdp-network-cookie", "cookieNames": names}
        return {"token": "", "tokenSource": "", "cookieNames": names}
    except Exception as exc:
        return {"token": "", "tokenSource": "", "cookieError": str(exc)}


TOKEN_RE = re.compile(r"eyJ[A-Za-z0-9_\-]+?\.[A-Za-z0-9_\-]+?\.[A-Za-z0-9_\-]+")


def extract_token(payload: str) -> Optional[str]:
    matches = TOKEN_RE.findall(payload or "")
    if not matches:
        return None
    matches.sort(key=len, reverse=True)
    return matches[0]


def export_suno_token(timeout_sec: int = 600, *, open_login: bool = True,
                      validate: bool = True, max_attempts: Optional[int] = None) -> Dict[str, Any]:
    """Capture a Suno token from the existing browser session.

    Interactive login keeps polling until the user signs in.  Token recovery during
    an upload must be bounded and must never reopen a browser window.
    """
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if open_login:
        launch_browser("https://suno.com/", force_new_page=False)
        emit("status", message="请在打开的浏览器中完成 Suno 登录", progress=15)
        emit("log", message="暂未获取到登录的Suno，正在获取中.....")
    deadline = time.time() + timeout_sec
    last_wait_notice = 0.0
    attempts = 0
    last_reason = ""
    script = """
(async () => {
  const cookie = Object.fromEntries(document.cookie.split(/;\\s*/).filter(Boolean)
    .map(x => { const i = x.indexOf('='); return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))]; }));
  const cookieToken = cookie.__session || Object.entries(cookie).find(([k]) => k.startsWith('__session'))?.[1] || '';
  let clerkToken = '';
  const clerkMeta = { clerk: !!window.Clerk, session: !!window.Clerk?.session, ts: Date.now() };
  try {
    clerkToken = await window.Clerk?.session?.getToken?.() || '';
    clerkMeta.len = clerkToken ? String(clerkToken).length : 0;
  } catch (error) {
    clerkMeta.error = String(error);
  }
  let stored = '';
  let storedMeta = {};
  try {
    stored = localStorage.getItem('codex_suno_token') || '';
    storedMeta = JSON.parse(localStorage.getItem('codex_suno_token_meta') || '{}');
  } catch (error) {}
  const freshStored = stored && storedMeta.ts && (Date.now() - storedMeta.ts < 300000) && !storedMeta.error ? stored : '';
  let projectKeys = [];
  try {
    projectKeys = Object.keys(localStorage)
      .filter(k => k.includes('studio-project-management-project-info'))
      .map(k => [k, localStorage.getItem(k)]);
  } catch (error) {}
  return JSON.stringify({
    account: {userId: window.Clerk?.user?.id || '', username: window.Clerk?.user?.username || '', email: window.Clerk?.user?.primaryEmailAddress?.emailAddress || ''},
    tokenCandidates: [{token:clerkToken,source:'clerk'}, {token:cookieToken,source:'cookie'}, {token:freshStored,source:'localStorage-fresh'}],
    token: clerkToken || cookieToken || freshStored || '',
    tokenSource: clerkToken ? 'clerk' : (cookieToken ? 'cookie' : (freshStored ? 'localStorage-fresh' : '')),
    tokenMeta: clerkMeta,
    deviceId: localStorage.getItem('ajs_anonymous_id') || '',
    projectKeys,
    href: location.href,
    ts: Date.now()
  });
})()
"""
    last_href = ""
    while time.time() < deadline:
        attempts += 1
        try:
            raw = cdp_eval(script, quiet=True, allow_login_redirect=True) or ""
            data = json.loads(raw) if raw else {}
            last_href = data.get("href", "")
            runtime_source = data.get("tokenSource") or ""
            runtime_token = str(data.get("token") or "")
            if (not runtime_token or len(runtime_token) < 80) and "suno.com" in str(last_href):
                cookie_data = cdp_get_suno_cookie_token()
                cookie_token = str(cookie_data.get("token") or "")
                cookie_source = cookie_data.get("tokenSource") or "cdp-network-cookie"
                if cookie_token and len(cookie_token) >= 80:
                    data["token"] = cookie_token
                    data["tokenSource"] = cookie_source
                    data["cookieNames"] = cookie_data.get("cookieNames") or []
                    runtime_token = cookie_token
                    runtime_source = cookie_source
            token = runtime_token
            if token:
                source = runtime_source or "unknown"
                emit("log", message="正在验证 Suno 登录凭证...")
                selected = select_verified_token(data, lambda value: validate_suno_token(value, timeout=20))
                expected_user = os.environ.get("GAOBAI_SUNO_ACCOUNT_USER_ID", "")
                if not open_login and expected_user and selected["account"]["userId"] != expected_user:
                    raise RuntimeError("浏览器中的 Suno 账号已改变，请登录任务原账号后继续。")
                token, source, check = selected["token"], selected["tokenSource"], selected["tokenCheck"]
                ctx = {
                    "token": token,
                    "href": last_href,
                    "captured_at": int(time.time()),
                    "tokenSource": source,
                    "tokenMeta": data.get("tokenMeta") or {},
                    "deviceId": data.get("deviceId") or "",
                    "projectKeys": data.get("projectKeys") or [],
                    "cookieNames": data.get("cookieNames") or [],
                    "tokenCheck": check,
                    "account": selected["account"],
                    "ts": int(time.time() * 1000),
                }
                TOKEN_FILE.write_text(json.dumps(ctx, ensure_ascii=False, indent=2), encoding="utf-8")
                emit("status", message="Suno 登录态已保存" if not validate else "Suno 登录态已保存并校验通过", progress=30)
                emit("log", message="已获取Suno登录信息，已登录！")
                return ctx
            now = time.time()
            if now - last_wait_notice >= 8:
                emit("log", message="暂未获取到登录的Suno，正在获取中.....")
                last_wait_notice = now
        except Exception as exc:
            raw_reason = str(exc)
            if (
                "SecurityError" in raw_reason
                and ("cookie" in raw_reason or "Access is denied for this document" in raw_reason)
            ):
                last_reason = "未获取到 Suno 登录 Token 密钥，建议安装 Google Chrome 浏览器，或者更换网络热点！"
                emit("log", message=last_reason)
            else:
                last_reason = raw_reason
                emit("log", message=f"等待登录中：{raw_reason}")
        if max_attempts is not None and attempts >= max(1, int(max_attempts)):
            break
        time.sleep(2)
    if max_attempts is not None:
        raise RuntimeError(f"未能获取有效 Suno Token（已尝试 {attempts} 次）：{last_reason or '未检测到登录态'}")
    raise RuntimeError(f"等待 Suno 登录超时，最后页面：{last_href}")


def recover_suno_token(max_attempts: int = 4) -> Dict[str, Any]:
    """Bounded, non-interactive recovery for an already-open Suno browser session."""
    return export_suno_token(
        timeout_sec=max(8, int(max_attempts) * 5),
        open_login=False,
        validate=True,
        max_attempts=max(1, int(max_attempts)),
    )


def load_saved_token(max_age_sec: int = 7200) -> Optional[Dict[str, Any]]:
    if not TOKEN_FILE.exists():
        return None
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        token = data.get("token")
        if not token or len(str(token)) < 80:
            return None
        href = str(data.get("href") or "")
        source = str(data.get("tokenSource") or "")
        if source == "storage-jwt" or "__clerk_handshake" in href:
            try:
                TOKEN_FILE.unlink()
            except Exception:
                pass
            return None
        ts = float(data.get("captured_at") or 0)
        if not ts and data.get("ts"):
            ts = float(data.get("ts") or 0) / 1000.0
        if ts and time.time() - ts > max_age_sec:
            return None
        return data
    except Exception:
        return None


def validate_suno_token(token: str, *, timeout: int = 20) -> Dict[str, Any]:
    """轻量校验 Suno token 是否真的可用。

    只判断 token 能否访问一个低成本接口；不能只看本地 token 文件存在，
    否则会出现 UI 显示已登录但上传时才 401 的假登录状态。
    """
    if not token or len(str(token)) < 80:
        return {"ok": False, "reason": "token_missing_or_too_short", "status_code": 0}
    req = require_requests()
    try:
        response = req.get(
            API + "/api/feed/v2?is_liked=false&limit=1&page=0",
            headers=SunoClient(token).headers(False),
            timeout=timeout,
        )
        if response.status_code == 200:
            return {"ok": True, "status_code": 200, "reason": "token_valid"}
        if response.status_code in (401, 403):
            return {"ok": False, "status_code": response.status_code, "reason": "token_unauthorized"}
        return {"ok": False, "status_code": response.status_code, "reason": response.text[:200]}
    except Exception as exc:
        return {"ok": False, "status_code": 0, "reason": f"token_check_error:{exc}"}


def prepare_suno_token(timeout_sec: int = 25) -> Dict[str, Any]:
    """在上传前校验已保存的 Suno 登录态，不引入官网软件权益依赖。"""
    timeout_sec = max(1, min(25, int(timeout_sec or 25)))
    started = time.monotonic()
    deadline = started + timeout_sec
    extension_mode = os.environ.get("GAOBAI_SUNO_LOGIN_METHOD", "").strip().lower() == "extension"
    last_rejected_token = ""
    last_check: Dict[str, Any] = {}

    while True:
        now = time.monotonic()
        ctx = load_saved_token()
        if not ctx:
            # 扩展刷新是异步写入 token 文件；首次缺失时短暂等待。
            if now < min(deadline, started + 2.0):
                time.sleep(min(0.2, max(0.0, deadline - now)))
                continue
            return {"ok": False, "loggedIn": False, "code": "login_required",
                    "reason": "请先登录 Suno 账号。"}

        token = str(ctx.get("token") or "")
        if token == last_rejected_token:
            # 磁盘中可能仍是旧 Token；协议 2 扩展正在刷新时等待内容发生变化。
            if extension_mode and now < deadline:
                time.sleep(min(0.2, max(0.0, deadline - now)))
                continue
            return {"ok": False, "loggedIn": False, "code": "login_required",
                    "reason": "Suno 登录已失效，请重新登录。", "tokenCheck": last_check}

        remaining = max(1, int(deadline - now))
        check = validate_suno_token(token, timeout=min(20, remaining))
        if check.get("ok"):
            account = ctx.get("account") if isinstance(ctx.get("account"), dict) else {}
            expected_user = os.environ.get("GAOBAI_SUNO_ACCOUNT_USER_ID", "").strip()
            actual_user = str(account.get("userId") or "").strip()
            if expected_user and actual_user and actual_user != expected_user:
                return {"ok": False, "loggedIn": False, "code": "account_mismatch",
                        "reason": "saved_token_account_mismatch", "account": account}
            return {"ok": True, "loggedIn": True, "code": "ready", "account": account,
                    "tokenSource": ctx.get("tokenSource") or "saved", "tokenCheck": check,
                    "verifiedAt": int(time.time())}

        status = int(check.get("status_code") or 0)
        if status in (401, 403):
            last_rejected_token, last_check = token, check
            if extension_mode and time.monotonic() < deadline:
                continue
            return {"ok": False, "loggedIn": False, "code": "login_required",
                    "reason": "Suno 登录已失效，请重新登录。", "tokenCheck": check}
        # 限流、服务端故障、超时和其他非鉴权响应都不是掉登录。
        return {"ok": False, "loggedIn": False, "code": "network_error",
                "reason": "Suno 网络暂不可用，请稍后重试。", "tokenCheck": check}


def clean_device_id(value: str) -> str:
    value = str(value or "").strip().strip('"')
    return re.sub(r"[^a-zA-Z0-9-]", "", value)


class SunoThrottleExhausted(RuntimeError):
    def __init__(self, method: str, path: str, attempts: int, retry_after: float = 0.0):
        self.method = method
        self.path = path
        self.attempts = attempts
        self.retry_after = max(0.0, float(retry_after or 0.0))
        super().__init__(f"{method} {path} Suno throttle 429 retry exhausted after {attempts} attempts")


class SunoAuthRequired(RuntimeError):
    """The user must complete Suno login before the upload can safely continue."""


def is_suno_throttle_exhausted(exc: BaseException) -> bool:
    return isinstance(exc, SunoThrottleExhausted) or (
        "429" in str(exc) and "retry exhausted" in str(exc).lower()
    )


def parse_retry_after_seconds(value: Any, now: Optional[float] = None) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return max(0.0, float(text))
    except (TypeError, ValueError):
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        if parsed is None:
            return 0.0
        current = time.time() if now is None else float(now)
        return max(0.0, parsed.timestamp() - current)
    except (TypeError, ValueError, OverflowError):
        return 0.0


def response_retry_after_seconds(response: Any) -> float:
    headers = getattr(response, "headers", {}) or {}
    retry_after = parse_retry_after_seconds(headers.get("Retry-After"))
    if retry_after > 0:
        return retry_after
    for header_name in ("RateLimit-Reset", "X-RateLimit-Reset"):
        raw = str(headers.get(header_name) or "").strip()
        if not raw:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 10_000_000_000:
            value /= 1000.0
        if value > 1_000_000_000:
            value -= time.time()
        if value > 0:
            return value
    return 0.0


class SunoClient:
    def __init__(self, token: str, device_id: str = ""):
        self.token = token
        self.device_id = clean_device_id(device_id)
        self.throttle_cb = None
        self._throttle_until = 0.0
        self._throttle_lock = threading.Lock()
        self._session_lock = threading.Lock()
        self._auth_refresh_lock = threading.Lock()
        self._auth_version = 0
        self._api_gate_lock = threading.Lock()
        self._metrics_lock = threading.Lock()
        self._next_api_at = 0.0
        self._api_attempt_counts: Dict[str, int] = {}
        self._api_429_counts: Dict[str, int] = {}
        self._poll_slots = threading.BoundedSemaphore(3)
        self.auth_interrupted_path: Optional[Path] = None
        req = require_requests()
        self.session = req.Session()

    def headers(self, has_body: bool = False) -> Dict[str, str]:
        headers = {
            "Authorization": "Bearer " + self.token,
            "Browser-Token": browser_token(),
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/studio",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/136.0.0.0 Safari/537.36"
            ),
        }
        if has_body:
            headers["Content-Type"] = "application/json"
        if self.device_id:
            headers["Device-Id"] = self.device_id
        return headers

    def set_throttle_cooldown(self, seconds: float) -> None:
        until = time.time() + max(0.0, float(seconds or 0.0))
        with self._throttle_lock:
            self._throttle_until = max(self._throttle_until, until)
        if seconds and seconds >= 2:
            mark_suno_throttle_event(f"cooldown:{seconds:.1f}s")

    def respect_throttle_cooldown(self) -> None:
        while True:
            with self._throttle_lock:
                wait = self._throttle_until - time.time()
            if wait <= 0:
                return
            time.sleep(min(wait, 1.0))

    def acquire_api_slot(self, min_interval: float = 0.16) -> None:
        with self._api_gate_lock:
            now = time.time()
            wait = self._next_api_at - now
            if wait > 0:
                time.sleep(wait)
            self._next_api_at = time.time() + max(0.0, min_interval) + random.uniform(0.0, 0.08)

    def acquire_poll_slot(self) -> None:
        self._poll_slots.acquire()

    def release_poll_slot(self) -> None:
        try:
            self._poll_slots.release()
        except ValueError:
            pass

    @staticmethod
    def api_metric_key(method: str, path: str) -> str:
        method = str(method or "").upper()
        normalized = str(path or "").split("?", 1)[0]
        if method == "POST" and normalized.rstrip("/") == "/api/uploads/audio":
            return "upload_init"
        if method == "GET" and re.fullmatch(r"/api/uploads/audio/[^/]+/", normalized):
            return "upload_status"
        if normalized.endswith("/upload-finish/"):
            return "upload_finish"
        if normalized.endswith("/initialize-clip/"):
            return "initialize_clip"
        if normalized.endswith("/set_metadata/"):
            return "set_metadata"
        if normalized.startswith("/api/studio/"):
            return "studio"
        return "other"

    def record_api_metric(self, method: str, path: str, throttled: bool = False) -> None:
        key = self.api_metric_key(method, path)
        with self._metrics_lock:
            target = self._api_429_counts if throttled else self._api_attempt_counts
            target[key] = target.get(key, 0) + 1

    def api_metrics(self) -> Dict[str, Dict[str, int]]:
        with self._metrics_lock:
            return {
                "attempts": dict(sorted(self._api_attempt_counts.items())),
                "rateLimited": dict(sorted(self._api_429_counts.items())),
            }

    def reset_session(self, reason: str = "") -> None:
        req = require_requests()
        with self._session_lock:
            old = self.session
            self.session = req.Session()
        try:
            old.close()
        except Exception:
            pass
        if reason:
            emit("log", message=f"Suno connection reset; new session created: {reason}", detail=True)

    def mark_auth_interrupted(self, reason: str) -> None:
        target = self.auth_interrupted_path
        if not target:
            return
        try:
            target.write_text(json.dumps({
                "reason": str(reason or "token_unavailable"),
                "interruptedAt": int(time.time()),
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def api(self, method: str, path: str, body: Any = None, timeout: int = 90,
            max_attempts: int = 10, fast_reconnect: bool = False) -> Any:
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        refreshed_auth = False
        last_status_code = None
        last_retry_after = 0.0

        def signal_throttle(reason: str, *, kind: str, retry_after: float = 0.0) -> None:
            cb = getattr(self, "throttle_cb", None)
            if cb:
                try:
                    cb(
                        reason,
                        kind=kind,
                        method=method.upper(),
                        path=path,
                        retry_after=max(0.0, float(retry_after or 0.0)),
                    )
                except TypeError:
                    try:
                        cb(reason)
                    except Exception:
                        pass
                except Exception:
                    pass

        for attempt in range(max_attempts):
            response = None
            try:
                self.respect_throttle_cooldown()
                poll_request = method.upper() == "GET" and path.startswith("/api/uploads/audio/")
                self.acquire_api_slot(0.30 if poll_request else 0.22)
                with self._session_lock:
                    session = self.session
                auth_version_before_request = self._auth_version
                self.record_api_metric(method, path)
                response = session.request(
                    method,
                    API + path,
                    headers=self.headers(body is not None),
                    data=data,
                    timeout=timeout,
                )
            except require_requests().RequestException as exc:
                if _connection_reset_like(exc):
                    self.reset_session(type(exc).__name__)
                    wait = min(14, 1.2 + attempt * (1.8 if fast_reconnect else 3.0))
                    self.set_throttle_cooldown(wait)
                else:
                    wait = min(30, 2 + attempt * 4)
                signal_throttle(f"网络重试：{type(exc).__name__}", kind="network")
                emit("log", message="上传网络重试中", level="warn")
                emit("log", message=f"网络重试 {attempt + 1}/{max_attempts}：{exc}", detail=True)
                if attempt >= max_attempts - 1:
                    break
                time.sleep(wait)
                continue
            if response.status_code in (401, 403):
                if not refreshed_auth:
                    # Keep the upload task alive while one bounded browser-session
                    # recovery runs.  The lock prevents concurrent workers from
                    # hammering the browser or creating a burst of 401 responses.
                    with self._auth_refresh_lock:
                        if self._auth_version != auth_version_before_request:
                            # Another worker already refreshed the shared token
                            # while this request was in flight.
                            refreshed_auth = True
                            continue
                        emit("log", message="Suno 登录状态失效，正在后台尝试恢复 Token（最多 4 次）...")
                        try:
                            fresh = recover_suno_token(max_attempts=4)
                            self.token = fresh["token"]
                            self.device_id = clean_device_id(fresh.get("deviceId") or self.device_id)
                            self._auth_version += 1
                            refreshed_auth = True
                            emit("log", message="已恢复有效 Suno Token，继续当前上传任务。")
                            time.sleep(0.5)
                            continue
                        except Exception as exc:
                            reason = f"Suno Token 无法恢复：{exc}"
                            self.mark_auth_interrupted(reason)
                            emit("log", level="error", message=f"{reason}。上传任务已停止，请重新登录 Suno。")
                            raise SunoAuthRequired(reason)
                reason = f"Suno 登录状态仍然无效（HTTP {response.status_code}）"
                self.mark_auth_interrupted(reason)
                raise SunoAuthRequired(reason)
            if response.status_code == 429:
                self.record_api_metric(method, path, throttled=True)
                last_status_code = 429
                wait_hdr = response_retry_after_seconds(response)
                last_retry_after = max(last_retry_after, wait_hdr)
                wait = max(wait_hdr, min(45, 2 + attempt * 4))
                signal_throttle("Suno 限流 429", kind="rate_limit", retry_after=wait_hdr)
                self.set_throttle_cooldown(wait)
                emit("log", message="上传网络重试中", level="warn")
                if attempt >= max_attempts - 1:
                    emit("log", message="Suno 限流(429)，交由上传调度器冷却后重试。", detail=True)
                    break
                emit("log", message=f"Suno 限流(429)，等待 {wait:.0f} 秒后重试...", detail=True)
                time.sleep(wait)
                continue
            if response.status_code >= 500 and attempt < 4:
                wait = min(30, 3 + attempt * 3)
                signal_throttle(f"Suno 服务器异常 {response.status_code}", kind="server")
                emit("log", message="上传网络重试中", level="warn")
                emit("log", message=f"Suno 服务器异常({response.status_code})，等待后重试...", detail=True)
                time.sleep(wait)
                continue
            if not response.ok:
                raise RuntimeError(f"{method} {path} -> {response.status_code}: {response.text[:500]}")
            if not response.text:
                return None
            try:
                return response.json()
            except Exception:
                return response.text
        if last_status_code == 429:
            raise SunoThrottleExhausted(method, path, max_attempts, retry_after=last_retry_after)
        raise RuntimeError(f"{method} {path} 重试耗尽")


def s3_upload(url: str, fields: Dict[str, Any], seg: Segment):
    mime = mimetypes.guess_type(seg.fileName)[0] or "audio/wav"
    req = require_requests()
    session = req.Session()
    session.trust_env = False
    with seg.path.open("rb") as file:
        return session.post(
            url,
            data=fields or {},
            files={"file": (seg.fileName, file, mime)},
            headers={"Connection": "close"},
            timeout=(30, 300),
        )

s3_upload_ret = s3_upload  # alias that returns response


class UploadProcessingError(RuntimeError):
    def __init__(self, seg: Segment, status_payload: Dict[str, Any]):
        self.seg = seg
        self.status_payload = status_payload
        super().__init__(f"{seg.fileName} Suno 拒收：{status_payload.get('status')}")


def split_failed_segment(seg: Segment, out_dir: Path) -> List[Segment]:
    return split_failed_segment_smart(seg, out_dir, overlap_sec=0.08, depth=1)


def _local_low_energy_recut(values: List[float], rate: int, overlap_sec: float) -> Dict[str, Any]:
    dur = len(values) / rate
    center = dur / 2.0
    search = max(0.18, min(0.75, dur * 0.22))
    low = max(0.2, center - search)
    high = min(dur - 0.2, center + search)
    if high <= low:
        cut = center
    else:
        step = max(1, int(rate * 0.01))
        half = max(1, int(rate * 0.025))
        best_score = float("inf")
        best_index = int(center * rate)
        for idx in range(int(low * rate), int(high * rate), step):
            a = max(0, idx - half)
            b = min(len(values), idx + half)
            chunk = values[a:b]
            score = sum(v * v for v in chunk) / max(1, len(chunk))
            score += abs(values[min(idx, len(values) - 1)]) * 0.25
            if score < best_score:
                best_score = score
                best_index = idx
        cut = best_index / rate
    ov = min(max(0.0, overlap_sec), max(0.0, (dur / 2.0) - 0.05))
    return {
        "ok": True,
        "cut_sec": cut,
        "overlap_used_sec": ov,
        "rels": [
            {
                "suffix": "a",
                "rel_start": 0.0,
                "rel_end": min(dur, cut + ov),
                "fade_in_inherit_from_parent": True,
                "fade_out_sec": 2 * ov,
            },
            {
                "suffix": "b",
                "rel_start": max(0.0, cut - ov),
                "rel_end": dur,
                "fade_in_sec": 2 * ov,
                "fade_out_inherit_from_parent": True,
            },
        ],
        "algo_version": "local-low-energy-recut-v1",
    }


def split_failed_segment_smart(seg: Segment, out_dir: Path, overlap_sec: float, depth: int) -> List[Segment]:
    """版权拒收后智能细切；远端优先，本地低能量切点兜底。"""
    try:
        from array import array as _array
        from audio_splitter import mono_abs as _mono_abs, read_wav as _read_wav, write_wav as _write_wav

        seg_path = Path(seg.path).expanduser().resolve()
        samples, rate, ch = _read_wav(seg_path)
        values = _mono_abs(samples, ch)
    except Exception as e:
        raise RuntimeError(f"无法读取失败片段音频：{e}")
    total_frames = len(values)
    dur = total_frames / rate
    if dur <= 0.2:
        raise RuntimeError(f"片段太短无法拆分：{seg.fileName} {dur:.2f}s")
    try:
        import suno_algo_client
        if suno_algo_client.remote_enabled():
            plan = suno_algo_client.remote_recut(values, rate, overlap_sec)
            plan_source = "remote"
        else:
            plan = _local_low_energy_recut(values, rate, overlap_sec)
            plan_source = "local"
    except Exception as remote_exc:
        if os.environ.get("GAOBAI_ALGO_MODE", "auto").strip().lower() == "remote":
            raise RuntimeError(f"远端智能细切失败：{remote_exc}")
        plan = _local_low_energy_recut(values, rate, overlap_sec)
        plan["fallback_reason"] = str(remote_exc)[:300]
        plan_source = "local-fallback"
    rels = plan.get("rels") or []
    if len(rels) != 2:
        raise RuntimeError(f"智能细切返回异常：{rels}")

    out_seg_dir = out_dir / "segments"
    out_seg_dir.mkdir(parents=True, exist_ok=True)
    base = Path(seg.fileName).stem
    children: List[Segment] = []
    for rel in rels:
        suffix = str(rel.get("suffix") or ("a" if not children else "b"))
        rel_start = max(0.0, min(dur, float(rel.get("rel_start") or 0.0)))
        rel_end = max(rel_start + 0.02, min(dur, float(rel.get("rel_end") or dur)))
        frame_start = max(0, int(round(rel_start * rate)))
        frame_end = min(total_frames, int(round(rel_end * rate)))
        sample_start = frame_start * ch
        sample_end = frame_end * ch
        child_name = f"{base}_retry{depth}{suffix}_{rel_start:.2f}-{rel_end:.2f}s.wav"
        child_path = out_seg_dir / child_name
        _write_wav(child_path, _array("h", samples[sample_start:sample_end]), rate, ch)
        if suffix == "a":
            fade_in = seg.fadeInSec if rel.get("fade_in_inherit_from_parent") else float(rel.get("fade_in_sec") or 0.0)
            fade_out = float(rel.get("fade_out_sec") or 0.0) * seg.timelineScale
        else:
            fade_in = float(rel.get("fade_in_sec") or 0.0) * seg.timelineScale
            fade_out = seg.fadeOutSec if rel.get("fade_out_inherit_from_parent") else float(rel.get("fade_out_sec") or 0.0)
        children.append(Segment(
            index=f"{seg.index}{suffix}",
            path=child_path,
            fileName=child_name,
            srcStartSec=seg.srcStartSec + rel_start,
            srcEndSec=seg.srcStartSec + rel_end,
            nominalStartSec=seg.nominalStartSec + rel_start,
            nominalEndSec=seg.nominalStartSec + rel_end,
            timelineStartSec=seg.timelineStartSec + rel_start * seg.timelineScale,
            timelineEndSec=seg.timelineStartSec + rel_end * seg.timelineScale,
            duration=rel_end - rel_start,
            fadeInSec=fade_in,
            fadeOutSec=fade_out,
            timelineScale=seg.timelineScale,
        ))
    emit("log", message=f"片段上传失败，正在细切重试：第 {seg.index} 段")
    emit("log", message=f"版权拒收，智能细切({plan_source})：{seg.fileName} → {children[0].fileName}, {children[1].fileName}", detail=True)
    return children


def can_retry_split_error(exc: UploadProcessingError, seg: Segment,
                          min_sec: float, max_depth: int, depth: int) -> bool:
    if seg.duration < min_sec or depth >= max_depth:
        return False
    try:
        import suno_algo_client
        if suno_algo_client.remote_enabled():
            resp = suno_algo_client.remote_can_retry(
                status_payload=exc.status_payload,
                seg_duration_sec=seg.duration,
                min_sec=min_sec,
                max_depth=max_depth,
                depth=depth,
            )
            return bool(resp.get("should_retry"))
    except Exception as remote_exc:
        if os.environ.get("GAOBAI_ALGO_MODE", "auto").strip().lower() == "remote":
            emit("log", level="warn", message=f"远端重试判定失败：{remote_exc}")
            return False
        emit("log", level="warn", message=f"远端重试判定不可用，使用本地规则：{remote_exc}")
    return seg.duration >= min_sec and depth < max_depth


def segment_index_number(value: Any) -> int:
    match = re.match(r"\d+", str(value or ""))
    return int(match.group(0)) if match else 0


def upload_extension(file_name: str) -> str:
    ext = Path(str(file_name or "")).suffix.lower().lstrip(".")
    if re.fullmatch(r"[a-z0-9]{1,8}", ext or ""):
        return ext
    return "wav"


def init_audio_upload(client: SunoClient, seg: Segment) -> Dict[str, Any]:
    body = {
        "extension": upload_extension(seg.fileName),
        "upload_type": "studio_file_upload",
    }
    max_attempts = getattr(client, "upload_init_max_attempts", None)
    if max_attempts:
        return client.api("POST", "/api/uploads/audio/", body, max_attempts=int(max_attempts))
    return client.api("POST", "/api/uploads/audio/", body)


def upload_one(client: SunoClient, seg: Segment, total: int, cancel_path: Optional[Path] = None,
              progress_cb: Optional[Any] = None) -> Dict[str, Any]:
    raise_if_cancelled(cancel_path)
    emit(
        "segment",
        status="start",
        index=seg.index,
        total=total,
        fileName=seg.fileName,
        duration=seg.duration,
        message=f"[upload {seg.index}/{total}] init {seg.fileName} {seg.duration:.2f}s",
        detail=True,
    )
    emit("log", message=f"[upload {seg.index}/{total}] init {seg.fileName} {seg.duration:.2f}s", detail=True)
    emit("status", message=f"上传中｜第 {seg.index} / {total} 段", progress=35 + int(segment_index_number(seg.index) / max(total, 1) * 35))

    if progress_cb:
        try:
            progress_cb("submitted")
        except Exception:
            pass

    init = None
    r = None
    last_err = ""
    for attempt in range(4):
        raise_if_cancelled(cancel_path)
        try:
            init = init_audio_upload(client, seg)
            r = s3_upload_ret(init["url"], init.get("fields") or {}, seg)
            if r.ok or r.status_code == 204:
                break
            last_err = f"{r.status_code} {r.text[:200]}"
            emit("log", message="上传网络重试中", level="warn")
            emit("log", message=f"[upload {seg.index}/{total}] S3 retry {attempt + 1}: {last_err[:120]}", detail=True)
        except Exception as exc:
            if is_suno_throttle_exhausted(exc):
                raise
            last_err = f"{type(exc).__name__}: {exc}"
            emit("log", message="上传网络重试中", level="warn")
            emit("log", message=f"[upload {seg.index}/{total}] S3 retry {attempt + 1}: {last_err}", detail=True)
        if attempt >= 3:
            break
        time.sleep(min(45, 4 + attempt * 6))

    if init is None or r is None:
        raise RuntimeError(f"S3 上传失败 {seg.fileName}: {last_err}")
    if not (r.ok or r.status_code == 204):
        raise RuntimeError(f"S3 上传失败 {seg.fileName}: {last_err}")

    raise_if_cancelled(cancel_path)
    client.api("POST", f"/api/uploads/audio/{init['id']}/upload-finish/", {
        "upload_type": "studio_file_upload",
        "upload_filename": seg.fileName,
    })

    status = None
    for i in range(150):
        raise_if_cancelled(cancel_path)
        try:
            client.acquire_poll_slot()
            try:
                status = client.api("GET", f"/api/uploads/audio/{init['id']}/")
            finally:
                client.release_poll_slot()
        except Exception as exc:
            if i % 5 == 0:
                emit("log", message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: temporary status error {str(exc)[:120]}", detail=True)
            time.sleep(2.4 + random.uniform(0.0, 0.8))
            continue
        state = str(status.get("status") or "")
        if state == "complete" and status.get("s3_id"):
            break
        if re.search(r"failed|rejected|blocked|error", state, re.I):
            raise UploadProcessingError(seg, status)
        if i % 5 == 0:
            emit(
                "segment",
                status="waiting",
                index=seg.index,
                total=total,
                fileName=seg.fileName,
                sunoStatus=state,
                message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: {state}",
                detail=True,
            )
            emit("log", message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: {state}", detail=True)
        time.sleep(2.4 + random.uniform(0.0, 0.8))
    if not status or status.get("status") != "complete":
        raise RuntimeError(f"等待上传完成超时：{seg.fileName}")

    raise_if_cancelled(cancel_path)
    clip_id = None
    try:
        clip = client.api("POST", f"/api/uploads/audio/{init['id']}/initialize-clip/", {})
        clip_id = clip.get("clip_id") or status.get("s3_id")
        try:
            client.api("POST", f"/api/gen/{clip_id}/set_metadata/", {
                "title": Path(seg.fileName).stem,
                "image_url": status.get("image_url"),
                "is_audio_upload_tos_accepted": True,
            })
        except Exception:
            pass
    except Exception as exc:
        emit("log", message=f"片段初始化跳过：{exc}")

    row = {
        "fileName": seg.fileName,
        "path": str(seg.path),
        "duration": seg.duration,
        "clipId": clip_id or status.get("s3_id"),
        "uploadId": init["id"],
        "timelineStartSec": seg.timelineStartSec,
        "timelineEndSec": seg.timelineEndSec,
        "fadeInSec": seg.fadeInSec,
        "fadeOutSec": seg.fadeOutSec,
        "nominalStartSec": seg.nominalStartSec,
        "nominalEndSec": seg.nominalEndSec,
        "imageUrl": status.get("image_url"),
        "tags": status.get("display_tags") or status.get("tags") or "",
        "uploadDuration": seg.duration,
        "timelineScale": seg.timelineScale,
    }
    emit(
        "segment",
        status="complete",
        index=seg.index,
        total=total,
        fileName=seg.fileName,
        uploadId=init["id"],
        clipId=row.get("clipId"),
        message=f"[upload {seg.index}/{total}] complete -> uploadId={init['id']}"
                + (f" clipId={row.get('clipId')}" if row.get("clipId") else ""),
        detail=True,
    )
    emit(
        "log",
        message=f"[upload {seg.index}/{total}] complete -> uploadId={init['id']}"
                + (f" clipId={row.get('clipId')}" if row.get("clipId") else ""),
        detail=True,
    )
    if progress_cb:
        try:
            progress_cb("done")
        except Exception:
            pass
    return row


def prepare_upload(client: SunoClient, seg: Segment, total: int,
                   cancel_path: Optional[Path] = None,
                   progress_cb: Optional[Any] = None) -> Dict[str, Any]:
    raise_if_cancelled(cancel_path)
    emit(
        "segment",
        status="start",
        index=seg.index,
        total=total,
        fileName=seg.fileName,
        duration=seg.duration,
        message=f"[upload {seg.index}/{total}] init {seg.fileName} {seg.duration:.2f}s",
        detail=True,
    )
    emit("log", message=f"[upload {seg.index}/{total}] init {seg.fileName} {seg.duration:.2f}s", detail=True)
    emit("status", message=f"Uploading segment {seg.index} / {total}", progress=35 + int(segment_index_number(seg.index) / max(total, 1) * 35))

    init = None
    r = None
    last_err = ""
    for attempt in range(4):
        raise_if_cancelled(cancel_path)
        try:
            init = init_audio_upload(client, seg)
            r = s3_upload_ret(init["url"], init.get("fields") or {}, seg)
            if r.ok or r.status_code == 204:
                break
            last_err = f"{r.status_code} {r.text[:200]}"
            emit("log", message="Upload network retrying", level="warn")
            emit("log", message=f"[upload {seg.index}/{total}] S3 retry {attempt + 1}: {last_err[:120]}", detail=True)
        except Exception as exc:
            if is_suno_throttle_exhausted(exc):
                raise
            last_err = f"{type(exc).__name__}: {exc}"
            emit("log", message="Upload network retrying", level="warn")
            emit("log", message=f"[upload {seg.index}/{total}] S3 retry {attempt + 1}: {last_err}", detail=True)
        if attempt >= 3:
            break
        time.sleep(min(45, 4 + attempt * 6))

    if init is None or r is None:
        raise RuntimeError(f"S3 upload failed {seg.fileName}: {last_err}")
    if not (r.ok or r.status_code == 204):
        raise RuntimeError(f"S3 upload failed {seg.fileName}: {last_err}")

    raise_if_cancelled(cancel_path)
    client.api("POST", f"/api/uploads/audio/{init['id']}/upload-finish/", {
        "upload_type": "studio_file_upload",
        "upload_filename": seg.fileName,
    })
    emit(
        "segment",
        status="queued",
        index=seg.index,
        total=total,
        fileName=seg.fileName,
        uploadId=init["id"],
        message=f"[upload {seg.index}/{total}] queued -> uploadId={init['id']}",
        detail=True,
    )
    emit("log", message=f"[upload {seg.index}/{total}] queued -> uploadId={init['id']}", detail=True)
    if progress_cb:
        try:
            progress_cb("submitted")
        except Exception:
            pass
    return init


def complete_upload(client: SunoClient, seg: Segment, total: int, init: Dict[str, Any],
                    cancel_path: Optional[Path] = None,
                    progress_cb: Optional[Any] = None,
                    poll_sec: float = 3.2,
                    max_poll: int = 150) -> Dict[str, Any]:
    raise_if_cancelled(cancel_path)
    status = None
    low_request_polling = bool(getattr(client, "low_request_polling", False))
    poll_base_sec = 5.0 if low_request_polling else float(poll_sec or 0.0)
    initial_poll_sec = 8.0 if low_request_polling else max(0.0, min(3.5, poll_base_sec))
    # Most clips need 9-13 seconds. In target mode the status endpoint doubles
    # as a low-frequency readiness check instead of being polled immediately.
    time.sleep(initial_poll_sec)
    for i in range(max_poll):
        raise_if_cancelled(cancel_path)
        try:
            client.acquire_poll_slot()
            try:
                status = client.api("GET", f"/api/uploads/audio/{init['id']}/")
            finally:
                client.release_poll_slot()
        except Exception as exc:
            if i % 5 == 0:
                emit("log", message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: temporary status error {str(exc)[:120]}", detail=True)
            if i < max_poll - 1:
                delay = min(7.0, poll_base_sec + max(0, i - 2) * 0.35)
                time.sleep(delay + random.uniform(0.0, 0.8))
            continue
        state = str(status.get("status") or "")
        if state == "complete" and status.get("s3_id"):
            break
        if re.search(r"failed|rejected|blocked|error", state, re.I):
            raise UploadProcessingError(seg, status)
        if i % 5 == 0:
            emit(
                "segment",
                status="waiting",
                index=seg.index,
                total=total,
                fileName=seg.fileName,
                sunoStatus=state,
                message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: {state}",
                detail=True,
            )
            emit("log", message=f"[upload {seg.index}/{total}] waiting {seg.fileName}: {state}", detail=True)
        if i < max_poll - 1:
            delay = min(7.0, poll_base_sec + max(0, i - 2) * 0.35)
            time.sleep(delay + random.uniform(0.0, 0.8))
    if not status or status.get("status") != "complete":
        raise RuntimeError(f"Timeout waiting for upload processing: {seg.fileName}")

    raise_if_cancelled(cancel_path)
    clip_id = None
    metadata_deferred = bool(getattr(client, "defer_segment_metadata", False))
    try:
        clip = client.api("POST", f"/api/uploads/audio/{init['id']}/initialize-clip/", {})
        clip_id = clip.get("clip_id") or status.get("s3_id")
        if not metadata_deferred:
            try:
                client.api("POST", f"/api/gen/{clip_id}/set_metadata/", {
                    "title": Path(seg.fileName).stem,
                    "image_url": status.get("image_url"),
                    "is_audio_upload_tos_accepted": True,
                })
            except Exception:
                pass
    except Exception as exc:
        emit("log", message=f"Segment initialize skipped: {exc}")

    row = {
        "fileName": seg.fileName,
        "path": str(seg.path),
        "duration": seg.duration,
        "clipId": clip_id or status.get("s3_id"),
        "uploadId": init["id"],
        "timelineStartSec": seg.timelineStartSec,
        "timelineEndSec": seg.timelineEndSec,
        "fadeInSec": seg.fadeInSec,
        "fadeOutSec": seg.fadeOutSec,
        "nominalStartSec": seg.nominalStartSec,
        "nominalEndSec": seg.nominalEndSec,
        "imageUrl": status.get("image_url"),
        "tags": status.get("display_tags") or status.get("tags") or "",
        "uploadDuration": seg.duration,
        "timelineScale": seg.timelineScale,
        "metadataDeferred": metadata_deferred,
    }
    emit(
        "segment",
        status="complete",
        index=seg.index,
        total=total,
        fileName=seg.fileName,
        uploadId=init["id"],
        clipId=row.get("clipId"),
        message=f"[upload {seg.index}/{total}] complete -> uploadId={init['id']}"
                + (f" clipId={row.get('clipId')}" if row.get("clipId") else ""),
        detail=True,
    )
    emit(
        "log",
        message=f"[upload {seg.index}/{total}] complete -> uploadId={init['id']}"
                + (f" clipId={row.get('clipId')}" if row.get("clipId") else ""),
        detail=True,
    )
    if progress_cb:
        try:
            progress_cb("done")
        except Exception:
            pass
    return row


def apply_deferred_segment_metadata(client: SunoClient, rows: List[Dict[str, Any]],
                                    cancel_path: Optional[Path] = None) -> int:
    pending = [row for row in rows if row.get("metadataDeferred") and row.get("clipId")]
    if not pending:
        return 0
    emit("log", level="warn", message=f"渲染需要补齐片段元数据，正在处理 {len(pending)} 段。")
    completed = 0
    for row in pending:
        raise_if_cancelled(cancel_path)
        client.api("POST", f"/api/gen/{row['clipId']}/set_metadata/", {
            "title": Path(str(row.get("fileName") or "audio")).stem,
            "image_url": row.get("imageUrl"),
            "is_audio_upload_tos_accepted": True,
        })
        row["metadataDeferred"] = False
        completed += 1
    return completed


def fetch_clip_by_id(client: SunoClient, clip_id: str, cancel_path: Optional[Path] = None,
                     attempts: int = 24, delay_sec: float = 2.0) -> Optional[Dict[str, Any]]:
    for _ in range(max(1, attempts)):
        raise_if_cancelled(cancel_path)
        feed = client.api("POST", "/api/feed/v3", {
            "filters": {"ids": {"presence": "True", "clipIds": [clip_id]}},
            "limit": 1,
        }, timeout=60)
        clips = feed.get("clips") if isinstance(feed, dict) else []
        if clips:
            return clips[0]
        time.sleep(delay_sec)
    return None


def try_direct_whole_upload(client: SunoClient, source: Path, title: str, out_dir: Path,
                            cancel_path: Optional[Path] = None) -> Dict[str, Any]:
    emit("status", message="尝试整首直传｜优先避免切片和二次演唱", progress=12)
    emit("log", message="整首直传｜正在尝试一次性上传原音频，成功后将跳过切片渲染")
    segment = Segment(
        index=1,
        path=source,
        fileName=source.name,
        srcStartSec=0.0,
        srcEndSec=0.01,
        nominalStartSec=0.0,
        nominalEndSec=0.01,
        timelineStartSec=0.0,
        timelineEndSec=0.01,
        duration=0.01,
        fadeInSec=0.0,
        fadeOutSec=0.0,
    )
    row = upload_one(client, segment, 1, cancel_path=cancel_path)
    clip_id = str(row.get("clipId") or "").strip()
    if not clip_id:
        raise RuntimeError("整首直传已上传，但没有拿到 Suno clipId")
    (out_dir / "direct_upload_row.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("status", message="整首直传已接收｜正在读取 Suno 音频链接", progress=82)
    final_clip = fetch_clip_by_id(client, clip_id, cancel_path=cancel_path)
    if final_clip:
        (out_dir / "direct_upload_clip.json").write_text(json.dumps(final_clip, ensure_ascii=False, indent=2), encoding="utf-8")
    metadata = final_clip.get("metadata") if isinstance(final_clip, dict) and isinstance(final_clip.get("metadata"), dict) else {}
    audio_url = str((final_clip or {}).get("audio_url") or "")
    if not audio_url:
        media_urls = (final_clip or {}).get("media_urls") if isinstance(final_clip, dict) else []
        if isinstance(media_urls, list):
            for media in media_urls:
                if isinstance(media, dict) and media.get("url"):
                    audio_url = str(media.get("url"))
                    break
    if not audio_url:
        raise RuntimeError("整首直传已接收，但 Suno 暂未返回可下载音频链接")
    emit("log", message="整首直传成功｜已跳过切片上传和 Suno 二次渲染")
    return {
        "projectId": None,
        "versionId": None,
        "renderId": clip_id,
        "status": (final_clip or {}).get("status") or "complete",
        "audioUrl": audio_url,
        "songUrl": f"https://suno.com/song/{clip_id}",
        "finalClip": final_clip,
        "clipCount": 1,
        "totalSeconds": float(metadata.get("duration") or 0.0),
        "directUpload": True,
    }


def row_interval(row: Dict[str, Any]) -> tuple[float, float]:
    return (float(row["timelineStartSec"]), float(row["timelineEndSec"]))


def segment_interval(seg: Segment) -> tuple[float, float]:
    return (float(seg.timelineStartSec), float(seg.timelineEndSec))


def intervals_overlap(a: tuple[float, float], b: tuple[float, float], eps: float = 0.02) -> bool:
    return a[0] < b[1] - eps and b[0] < a[1] - eps


def rows_cover_segment(rows: List[Dict[str, Any]], seg: Segment, eps: float = 0.24) -> bool:
    start, end = segment_interval(seg)
    parts = sorted(
        (max(start, a), min(end, b))
        for a, b in (row_interval(row) for row in rows)
        if intervals_overlap((a, b), (start, end), eps=0.02)
    )
    if not parts:
        return False
    cursor = start
    for a, b in parts:
        if a > cursor + eps:
            return False
        cursor = max(cursor, b)
        if cursor >= end - eps:
            return True
    return cursor >= end - eps


def sort_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(rows, key=lambda row: (float(row["timelineStartSec"]), float(row["timelineEndSec"])))


def load_progress_rows(progress_path: Path) -> List[Dict[str, Any]]:
    if not progress_path.exists():
        return []
    try:
        data = json.loads(progress_path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            rows = [row for row in data if isinstance(row, dict) and row.get("uploadId")]
            if rows:
                emit("log", message=f"[resume] loaded {len(rows)} uploaded rows from {progress_path.name}")
            return rows
    except Exception as exc:
        emit("log", level="warn", message=f"[resume] progress ignored: {exc}")
    return []


def upload_all_legacy_active_window(client: SunoClient, segments: List[Segment], concurrency: int, progress_path: Path,
                                    cancel_path: Optional[Path] = None,
                                    progress_cb: Optional[Any] = None,
                                    retry_split_min_sec: float = 0.2,
                                    retry_max_depth: int = 10,
                                    retry_overlap_sec: float = 0.08,
                                    speed_mode: str = "standard") -> List[Dict[str, Any]]:
    raise_if_cancelled(cancel_path)
    rows: List[Dict[str, Any]] = load_progress_rows(progress_path)
    lock = threading.Lock()

    def save_progress() -> None:
        progress_path.write_text(json.dumps(sort_rows(rows), ensure_ascii=False, indent=2), encoding="utf-8")

    total = len(segments)
    initial_total = total
    max_extra_segments = max(6, int(initial_total * 0.5))
    submit_segments: List[Segment] = []
    for seg in segments:
        if rows_cover_segment(rows, seg):
            emit("segment", status="skipped", index=seg.index, total=total, fileName=seg.fileName,
                 message=f"[resume] skip uploaded segment {seg.index}/{total} {seg.fileName}")
            emit("log", message=f"[resume] skip uploaded segment {seg.index}/{total} {seg.fileName}")
            continue
        seg_span = segment_interval(seg)
        kept = [row for row in rows if not intervals_overlap(row_interval(row), seg_span)]
        if len(kept) != len(rows):
            emit("log", message=f"[resume] partial progress discarded for segment {seg.index}/{total} {seg.fileName}")
            rows = kept
        submit_segments.append(seg)

    save_progress()
    if not submit_segments:
        emit("log", message="[resume] all segments already uploaded; continue to assembly/render.")
        return sort_rows(rows)

    completed_before = len(rows)
    failed = 0
    initial_workers = max(1, int(concurrency or 1))
    target_workers = initial_workers
    upload_queue: List[tuple[Segment, int]] = [(seg, 0) for seg in submit_segments]
    emit("log", message=f"上传策略｜mode={speed_mode} concurrency={initial_workers}", detail=True)

    def degrade_to_stable(reason: str) -> None:
        nonlocal target_workers
        if speed_mode == "fast" and target_workers > 1:
            target_workers = 1
            emit("log", level="warn", message="上传网络重试中")
            emit("log", level="warn", message=f"快速模式自动降速｜{reason}｜后续片段改为 1 路稳速上传", detail=True)

    def looks_recoverable_network_error(message: str) -> bool:
        text = message.lower()
        return any(
            token in text
            for token in (
                "s3 upload failed",
                "connection",
                "timeout",
                "timed out",
                "requesttimeout",
                "network",
                "429",
                "重试耗尽",
                "网络重试",
            )
        )

    previous_throttle_cb = getattr(client, "throttle_cb", None)

    def handle_api_throttle(reason: str) -> None:
        degrade_to_stable(reason)
        if previous_throttle_cb:
            try:
                previous_throttle_cb(reason)
            except Exception:
                pass

    if speed_mode == "fast":
        try:
            client.throttle_cb = handle_api_throttle
        except Exception:
            pass

    # Only keep a small active window. This lets fast mode fall back before all
    # remaining segments are already committed to parallel uploads.
    with futures.ThreadPoolExecutor(max_workers=initial_workers) as pool:
        future_map: Dict[futures.Future, tuple[Segment, int]] = {}

        def fill_active_window() -> None:
            while upload_queue and len(future_map) < target_workers:
                next_seg, next_depth = upload_queue.pop(0)
                future_map[pool.submit(upload_one, client, next_seg, total, cancel_path, progress_cb)] = (next_seg, next_depth)
                if upload_queue and target_workers > 1:
                    time.sleep(0.05 + random.random() * 0.1)

        fill_active_window()
        while future_map:
            done, _ = futures.wait(list(future_map.keys()), return_when=futures.FIRST_COMPLETED)
            for fut in done:
                seg, depth = future_map.pop(fut)
                raise_if_cancelled(cancel_path)
                try:
                    row = fut.result()
                    with lock:
                        rows.append(row)
                        save_progress()
                        uploaded = len(rows)
                    emit(
                        "segment",
                        status="saved",
                        index=seg.index,
                        total=total,
                        fileName=seg.fileName,
                        uploaded=uploaded,
                        success=uploaded,
                        failure=failed,
                        message=f"片段上传成功｜第 {seg.index} / {total} 段｜累计成功 {uploaded} / {total}",
                    )
                    emit("log", message=f"片段上传成功｜第 {seg.index} / {total} 段｜{seg.fileName}｜累计成功 {uploaded} / {total}", detail=True)
                    progress = 35 + int((uploaded / max(total, 1)) * 40)
                    emit("status", message=f"片段上传进度｜成功 {uploaded} / {total}", progress=min(progress, 75), detail=True)
                except UploadProcessingError as e:
                    # Suno 内容拒收与并发数无关，不应降速。只做细切重试。
                    if not can_retry_split_error(e, seg, retry_split_min_sec, retry_max_depth, depth):
                        failed += 1
                        emit("segment", status="failed", index=seg.index, total=total,
                             fileName=seg.fileName, success=len(rows), failure=failed,
                             message=f"片段被 Suno 拒收且不可继续细切：{e}")
                        raise
                    emit("log", message=f"片段上传失败，正在细切重试：第 {seg.index} / {total} 段")
                    emit("log", message=f"片段 {seg.index}/{total} 被 Suno 拒收，正在智能细切重试 depth={depth + 1}...", detail=True)
                    try:
                        children = split_failed_segment_smart(seg, progress_path.parent, retry_overlap_sec, depth + 1)
                        total += max(0, len(children) - 1)
                        if progress_cb:
                            progress_cb("total", max(0, len(children) - 1))
                        upload_queue[0:0] = [(child, depth + 1) for child in children]
                    except Exception as split_err:
                        failed += 1
                        emit("segment", status="failed", index=seg.index, total=total,
                             fileName=seg.fileName, success=len(rows), failure=failed,
                             message=f"细切失败：{split_err}")
                        raise
                except Exception as exc:
                    msg = str(exc)
                    if looks_recoverable_network_error(msg) and depth < 3:
                        degrade_to_stable(f"网络或 Suno 临时异常：{msg[:120]}")
                        emit("log", message="上传网络重试中", level="warn")
                        emit("log", message=f"片段 {seg.index}/{total} 网络失败，重试 {depth + 2}/3...", detail=True)
                        time.sleep(4 + depth * 6)
                        upload_queue.insert(0, (seg, depth + 1))
                    else:
                        failed += 1
                        emit(
                            "segment",
                            status="failed",
                            index=seg.index,
                            total=total,
                            fileName=seg.fileName,
                            success=len(rows),
                            failure=failed,
                            message=f"片段上传失败｜第 {seg.index} / {total} 段｜{seg.fileName}｜{exc}",
                        )
                        emit("log", level="error", message=f"片段上传失败｜第 {seg.index} / {total} 段｜{seg.fileName}｜{exc}")
                        raise
                fill_active_window()

    return sort_rows(rows)


def upload_lane_policy(speed_mode: str, max_workers: int) -> Tuple[int, List[Tuple[int, int]]]:
    mode = (speed_mode or "standard").strip().lower()
    max_workers = max(1, int(max_workers or 1))
    if mode == "fast":
        initial = 2
        raw_steps = [(8, 4), (8, 6)]
    elif mode == "experiment":
        initial = 1
        raw_steps = []
    elif mode == "stable":
        initial = 3
        raw_steps = [(5, 4)]
    else:
        initial = 1
        raw_steps = [(5, 2)]

    initial = min(initial, max_workers)
    current = initial
    steps: List[Tuple[int, int]] = []
    for completed, target in raw_steps:
        target = min(target, max_workers)
        if target > current:
            steps.append((completed, target))
            current = target
    return initial, steps


def upload_lane_policy_label(speed_mode: str, max_workers: int) -> str:
    initial, steps = upload_lane_policy(speed_mode, max_workers)
    if not steps:
        return f"mode={speed_mode} fixed concurrency={initial}"
    parts = [f"mode={speed_mode} start {initial}"]
    for completed, target in steps:
        parts.append(f"after {completed} accepted -> {target}")
    return ", ".join(parts) + f", shared max={max_workers}"


class UploadInitGovernor:
    """Pace Suno upload-init requests for the <=55 segment / 15 minute target."""

    def __init__(self, speed_mode: str):
        self.enabled = (speed_mode or "").strip().lower() == "experiment"
        self._lock = threading.Lock()
        self.base_interval_sec = 10.5
        self.interval_sec = self.base_interval_sec
        self.aux_throttle_interval_sec = 11.2
        self.throttle_interval_sec = 12.0
        self.repeated_throttle_interval_sec = 13.2
        self.max_interval_sec = 14.0
        self.aux_hold_sec = 15.0
        self.aux_exhausted_hold_sec = 30.0
        self.throttle_hold_sec = 60.0
        self.repeated_throttle_hold_sec = 85.0
        self._next_submit_at = 0.0
        self._hold_until = 0.0
        self._success_streak = 0
        self._throttle_streak = 0
        self._last_throttle_at = 0.0

    def describe(self) -> str:
        if not self.enabled:
            return "disabled"
        return (
            "init governor: one global init lane, 10.5s base + jitter, no fixed batch hold; "
            "auxiliary 429 -> short hold, upload-init 429 -> adaptive 60/85s hold"
        )

    def before_submit(self, lane: str) -> bool:
        if not self.enabled:
            return True
        with self._lock:
            now = time.time()
            ready_at = max(self._hold_until, self._next_submit_at)
            if now < ready_at:
                return False
            # Reserve the next init slot before the worker starts. This avoids
            # a burst when several upload futures are scheduled in the same loop.
            jitter_low, jitter_high = ((0.45, 0.95) if lane == "patch" else (0.25, 0.85))
            self._next_submit_at = now + self.interval_sec + random.uniform(jitter_low, jitter_high)
            return True

    def record_success(self, lane: str) -> Optional[Dict[str, float]]:
        if not self.enabled:
            return None
        with self._lock:
            event: Dict[str, float] = {}
            self._success_streak += 1
            old = self.interval_sec
            if self.interval_sec > self.base_interval_sec and self._success_streak >= 4:
                self.interval_sec = max(self.base_interval_sec, self.interval_sec - 0.8)
                self._success_streak = 0
            if self._success_streak >= 8:
                self._throttle_streak = 0
            if self.interval_sec != old:
                event["interval_sec"] = self.interval_sec
            return event or None

    def record_aux_throttle(self, retry_after: float = 0.0, exhausted: bool = False) -> Dict[str, float]:
        if not self.enabled:
            return {"hold_sec": max(0.0, float(retry_after or 0.0))}
        with self._lock:
            now = time.time()
            old = self.interval_sec
            self.interval_sec = max(self.interval_sec, self.aux_throttle_interval_sec)
            self._success_streak = 0
            base_hold = self.aux_exhausted_hold_sec if exhausted else self.aux_hold_sec
            hold = max(float(retry_after or 0.0), base_hold) + random.uniform(0.0, 5.0)
            self._hold_until = max(self._hold_until, now + hold)
            self._next_submit_at = max(self._next_submit_at, now + hold)
            return {
                "hold_sec": hold,
                "interval_sec": self.interval_sec,
                "interval_changed": 1.0 if self.interval_sec != old else 0.0,
            }

    def record_throttle(self, reason: str = "", exhausted: bool = False,
                        retry_after: float = 0.0) -> float:
        if not self.enabled:
            return 90.0 if exhausted else 15.0
        with self._lock:
            now = time.time()
            if exhausted and self._last_throttle_at and now - self._last_throttle_at < 3.0:
                return max(0.0, self._hold_until - now)
            if now - self._last_throttle_at > 240.0:
                self._throttle_streak = 0
            self._throttle_streak += 1
            self._last_throttle_at = now
            repeated = self._throttle_streak >= 2
            base_hold = self.repeated_throttle_hold_sec if repeated else self.throttle_hold_sec
            hold = max(float(retry_after or 0.0), base_hold) + random.uniform(5.0, 12.0)
            interval = self.repeated_throttle_interval_sec if repeated else self.throttle_interval_sec
            self.interval_sec = min(self.max_interval_sec, max(self.interval_sec, interval))
            self._success_streak = 0
            self._hold_until = max(self._hold_until, now + hold)
            self._next_submit_at = max(self._next_submit_at, now + hold)
        return hold

    def projected_submit_window_sec(self, segment_count: int) -> float:
        count = max(0, int(segment_count or 0))
        return max(0, count - 1) * (self.base_interval_sec + 0.85)


def upload_all(client: SunoClient, segments: List[Segment], concurrency: int, progress_path: Path,
               cancel_path: Optional[Path] = None,
               progress_cb: Optional[Any] = None,
               retry_split_min_sec: float = 0.2,
               retry_max_depth: int = 10,
               retry_overlap_sec: float = 0.08,
               speed_mode: str = "standard") -> List[Dict[str, Any]]:
    raise_if_cancelled(cancel_path)
    rows: List[Dict[str, Any]] = load_progress_rows(progress_path)
    retry_split_soft_limited = False

    def save_progress() -> None:
        progress_path.write_text(json.dumps(sort_rows(rows), ensure_ascii=False, indent=2), encoding="utf-8")

    def notify_progress(state: str, delta: int = 0) -> None:
        if progress_cb:
            try:
                progress_cb(state, delta)
            except Exception:
                pass

    def can_add_retry_children(additional: int = 1) -> bool:
        nonlocal retry_split_soft_limited
        if total - initial_total + additional <= max_extra_segments:
            return True
        retry_split_soft_limited = True
        emit(
            "log",
            level="warn",
            message=f"Retry split soft limit reached: base={initial_total}, total={total}, maxExtra={max_extra_segments}; continue safely.",
            detail=True,
        )
        return True

    total = len(segments)
    initial_total = total
    max_extra_segments = max(6, int(initial_total * 0.5))
    submit_segments: List[Segment] = []
    for seg in segments:
        if rows_cover_segment(rows, seg):
            emit("segment", status="skipped", index=seg.index, total=total, fileName=seg.fileName,
                 message=f"[resume] skip uploaded segment {seg.index}/{total} {seg.fileName}")
            emit("log", message=f"[resume] skip uploaded segment {seg.index}/{total} {seg.fileName}")
            notify_progress("done")
            continue
        seg_span = segment_interval(seg)
        kept = [row for row in rows if not intervals_overlap(row_interval(row), seg_span)]
        if len(kept) != len(rows):
            emit("log", message=f"[resume] partial progress discarded for segment {seg.index}/{total} {seg.fileName}")
            rows = kept
        submit_segments.append(seg)

    save_progress()
    if not submit_segments:
        emit("log", message="[resume] all segments already uploaded; continue to assembly/render.")
        return sort_rows(rows)

    max_workers = max(1, int(concurrency or 1))
    failed = 0

    def looks_recoverable_network_error(message: str) -> bool:
        text = message.lower()
        return any(token in text for token in (
            "s3 upload failed",
            "connection",
            "timeout",
            "timed out",
            "requesttimeout",
            "network",
            "429",
            "retry",
            "limit",
        ))

    def save_row(row: Dict[str, Any]) -> int:
        rows.append(row)
        save_progress()
        return len(rows)

    def handle_processing_reject(seg: Segment, depth: int, upload_queue: List[tuple[Segment, int]]) -> None:
        nonlocal total, failed
        if not can_retry_split_error(UploadProcessingError(seg, {"status": "rejected"}), seg,
                                     retry_split_min_sec, retry_max_depth, depth) or not can_add_retry_children(1):
            failed += 1
            raise UploadProcessingError(seg, {"status": "rejected"})
        children = split_failed_segment_smart(seg, progress_path.parent, retry_overlap_sec, depth + 1)
        total += max(0, len(children) - 1)
        notify_progress("total", max(0, len(children) - 1))
        upload_queue[0:0] = [(child, depth + 1) for child in children]

    if max_workers <= 1:
        upload_queue: List[tuple[Segment, int]] = [(seg, 0) for seg in submit_segments]
        emit("log", message=f"Upload strategy | mode={speed_mode} concurrency=1", detail=True)
        while upload_queue:
            seg, depth = upload_queue.pop(0)
            raise_if_cancelled(cancel_path)
            try:
                row = upload_one(client, seg, total, cancel_path, progress_cb)
                uploaded = save_row(row)
                emit("segment", status="saved", index=seg.index, total=total, fileName=seg.fileName,
                     uploaded=uploaded, success=uploaded, failure=failed,
                     message=f"Segment accepted {uploaded} / {total}")
                emit("status", message=f"Suno accepted {uploaded} / {total}", progress=min(75, 35 + int((uploaded / max(total, 1)) * 40)), detail=True)
            except UploadProcessingError as exc:
                if depth == 0:
                    emit("log", message=f"[upload {seg.index}/{total}] Suno rejected once; retry original before splitting.", detail=True)
                    time.sleep(2.5 + random.uniform(0.0, 0.8))
                    upload_queue.insert(0, (seg, depth + 1))
                    continue
                if not can_retry_split_error(exc, seg, retry_split_min_sec, retry_max_depth, depth) or not can_add_retry_children(1):
                    failed += 1
                    raise
                children = split_failed_segment_smart(seg, progress_path.parent, retry_overlap_sec, depth + 1)
                total += max(0, len(children) - 1)
                notify_progress("total", max(0, len(children) - 1))
                upload_queue[0:0] = [(child, depth + 1) for child in children]
            except Exception as exc:
                if is_suno_throttle_exhausted(exc):
                    wait = 90
                    client.set_throttle_cooldown(wait)
                    emit("log", level="warn", message=f"[upload {seg.index}/{total}] Suno 429 retry exhausted; cool down {wait}s and retry same chunk.", detail=True)
                    upload_queue.insert(0, (seg, depth))
                    continue
                if looks_recoverable_network_error(str(exc)) and depth < 3:
                    emit("log", message=f"[upload {seg.index}/{total}] network retry whole chunk depth={depth + 1}", detail=True)
                    time.sleep(4 + depth * 6)
                    upload_queue.insert(0, (seg, depth + 1))
                else:
                    failed += 1
                    raise
        return sort_rows(rows)

    initial_lane_limit, lane_steps = upload_lane_policy(speed_mode, max_workers)
    main_queue: List[tuple[Segment, int]] = [(seg, 0) for seg in submit_segments]
    patch_queue: List[tuple[Segment, int]] = []
    process_queue: List[tuple[Segment, int, Dict[str, Any], str]] = []
    main_limit = initial_lane_limit
    patch_limit = initial_lane_limit
    process_workers = min(3, max_workers)
    main_complete_streak = 0
    patch_complete_streak = 0
    main_steps = list(lane_steps)
    patch_steps = list(lane_steps)
    throttle_hold_until = 0.0
    init_governor = UploadInitGovernor(speed_mode)
    previous_throttle_cb = getattr(client, "throttle_cb", None)

    def handle_api_throttle(reason: str, **event: Any) -> None:
        nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak, throttle_hold_until
        if event.get("kind") != "rate_limit":
            if previous_throttle_cb:
                try:
                    previous_throttle_cb(reason, **event)
                except TypeError:
                    previous_throttle_cb(reason)
                except Exception:
                    pass
            return
        if not init_governor.enabled:
            if previous_throttle_cb:
                try:
                    previous_throttle_cb(reason, **event)
                except TypeError:
                    previous_throttle_cb(reason)
                except Exception:
                    pass
            return
        method = str(event.get("method") or "").upper()
        path = str(event.get("path") or "")
        retry_after = float(event.get("retry_after") or 0.0)
        is_upload_init = method == "POST" and path.rstrip("/") == "/api/uploads/audio"
        if is_upload_init:
            hold = init_governor.record_throttle(reason, retry_after=retry_after)
            log_message = (
                f"[experiment] upload-init 429; hold new init for {hold:.0f}s, "
                f"interval={init_governor.interval_sec:.1f}s"
            )
        else:
            hold = init_governor.record_aux_throttle(retry_after=retry_after)["hold_sec"]
            log_message = (
                f"[experiment] auxiliary API 429 ({method} {path}); short init hold {hold:.0f}s, "
                f"interval={init_governor.interval_sec:.1f}s"
            )
        main_limit = initial_lane_limit
        patch_limit = initial_lane_limit
        main_complete_streak = 0
        patch_complete_streak = 0
        throttle_hold_until = max(throttle_hold_until, time.time() + hold)
        emit(
            "log",
            level="warn",
            message=log_message,
            detail=True,
        )
        if previous_throttle_cb:
            try:
                previous_throttle_cb(reason, **event)
            except TypeError:
                previous_throttle_cb(reason)
            except Exception:
                pass

    if init_governor.enabled:
        try:
            client.throttle_cb = handle_api_throttle
        except Exception:
            pass
    emit(
        "log",
        message=f"[pipeline] adaptive lanes: {upload_lane_policy_label(speed_mode, max_workers)}.",
        detail=True,
    )
    if init_governor.enabled:
        emit("log", message=f"[experiment] {init_governor.describe()}", detail=True)

    with futures.ThreadPoolExecutor(max_workers=max_workers) as upload_pool, \
            futures.ThreadPoolExecutor(max_workers=process_workers) as process_pool, \
            futures.ThreadPoolExecutor(max_workers=1) as split_pool:
        upload_pending: Dict[futures.Future, tuple[Segment, int, str]] = {}
        process_pending: Dict[futures.Future, tuple[Segment, int, str]] = {}
        split_pending: Dict[futures.Future, tuple[Segment, int]] = {}

        def lane_pending_count(lane: str) -> int:
            return sum(1 for _, _, pending_lane in upload_pending.values() if pending_lane == lane)

        def process_pending_count(lane: str) -> int:
            return sum(1 for _, _, pending_lane in process_pending.values() if pending_lane == lane)

        def main_active() -> bool:
            return bool(main_queue) or lane_pending_count("main") > 0 or process_pending_count("main") > 0

        def record_lane_success(lane: str) -> None:
            nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak
            if retry_split_soft_limited:
                return
            if lane == "patch":
                if not patch_steps:
                    return
                patch_complete_streak += 1
                needed, target = patch_steps[0]
                if patch_complete_streak >= needed:
                    patch_steps.pop(0)
                    patch_limit = min(target, max_workers)
                    patch_complete_streak = 0
                    emit("log", message=f"[gap-fill] {needed} chunks accepted; raise patch lanes to {patch_limit}.", detail=True)
                return
            if not main_steps:
                return
            main_complete_streak += 1
            needed, target = main_steps[0]
            if main_complete_streak >= needed:
                main_steps.pop(0)
                main_limit = min(target, max_workers)
                main_complete_streak = 0
                emit("log", message=f"[pipeline] {needed} chunks accepted; raise main lanes to {main_limit}.", detail=True)

        def pause_and_requeue_after_throttle(seg: Segment, depth: int, lane: str, reason: BaseException) -> None:
            nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak, throttle_hold_until
            is_upload_init = False
            if init_governor.enabled:
                method = str(getattr(reason, "method", "")).upper()
                path = str(getattr(reason, "path", ""))
                retry_after = float(getattr(reason, "retry_after", 0.0) or 0.0)
                is_upload_init = method == "POST" and path.rstrip("/") == "/api/uploads/audio"
                if is_upload_init:
                    wait = init_governor.record_throttle(
                        str(reason), exhausted=True, retry_after=retry_after
                    )
                else:
                    wait = init_governor.record_aux_throttle(
                        retry_after=retry_after, exhausted=True
                    )["hold_sec"]
            else:
                wait = 90
            main_limit = initial_lane_limit
            patch_limit = initial_lane_limit
            main_complete_streak = 0
            patch_complete_streak = 0
            throttle_hold_until = max(throttle_hold_until, time.time() + wait)
            # The governor already blocks new upload-init calls. Keeping the
            # client-wide cooldown short lets accepted clips finish processing
            # instead of releasing a burst of polls at the end of a long hold.
            if not init_governor.enabled:
                client.set_throttle_cooldown(wait)
            elif not is_upload_init:
                client.set_throttle_cooldown(min(wait, 5.0))
            emit(
                "log",
                level="warn",
                message=f"[pipeline] Suno 429 retry exhausted; hold lanes at {initial_lane_limit} for {wait:.0f}s and retry segment {seg.index}/{total}: {str(reason)[:120]}",
                detail=True,
            )
            (patch_queue if lane == "patch" else main_queue).insert(0, (seg, depth))

        def enqueue_upload(queue: List[tuple[Segment, int]], lane: str, lane_limit: int) -> bool:
            if time.time() < throttle_hold_until:
                return False
            if not queue or len(upload_pending) >= max_workers or lane_pending_count(lane) >= lane_limit:
                return False
            if lane == "patch" and main_active():
                return False
            if not init_governor.before_submit(lane):
                return False
            seg, depth = queue.pop(0)
            upload_pending[upload_pool.submit(
                prepare_upload, client, seg, total, cancel_path, progress_cb
            )] = (seg, depth, lane)
            return True

        def schedule_gap_split(seg: Segment, depth: int, exc: UploadProcessingError) -> None:
            nonlocal failed
            if not can_retry_split_error(exc, seg, retry_split_min_sec, retry_max_depth, depth) or not can_add_retry_children(1):
                failed += 1
                raise exc
            emit(
                "log",
                message=f"[gap-fill] queued recut for segment {seg.index}/{total}, depth={depth + 1}.",
                detail=True,
            )
            split_pending[split_pool.submit(
                split_failed_segment_smart, seg, progress_path.parent, retry_overlap_sec, depth + 1
            )] = (seg, depth)

        while upload_pending or process_pending or split_pending or main_queue or patch_queue or process_queue:
            raise_if_cancelled(cancel_path)
            while True:
                added = False
                added = enqueue_upload(main_queue, "main", main_limit) or added
                added = enqueue_upload(patch_queue, "patch", patch_limit) or added
                if not added:
                    break
            while process_queue and len(process_pending) < process_workers:
                seg, depth, init, lane = process_queue.pop(0)
                process_pending[process_pool.submit(
                    complete_upload, client, seg, total, init, cancel_path, progress_cb, 3.2, 150
                )] = (seg, depth, lane)

            pending = list(upload_pending.keys()) + list(process_pending.keys()) + list(split_pending.keys())
            if not pending:
                time.sleep(0.25)
                continue
            done_set, _ = futures.wait(pending, return_when=futures.FIRST_COMPLETED)
            for fut in done_set:
                if fut in upload_pending:
                    seg, depth, lane = upload_pending.pop(fut)
                    try:
                        init = fut.result()
                        governor_event = init_governor.record_success(lane)
                        if governor_event:
                            if "interval_sec" in governor_event:
                                emit("log", message=f"[experiment] clean submit streak; init interval -> {governor_event['interval_sec']:.1f}s", detail=True)
                        process_queue.append((seg, depth, init, lane))
                    except Exception as exc:
                        if lane == "patch":
                            patch_complete_streak = 0
                        else:
                            main_complete_streak = 0
                        fallback_limit = initial_lane_limit
                        if lane == "patch" and patch_limit != fallback_limit:
                            patch_limit = fallback_limit
                            emit("log", message=f"[gap-fill] submit error; reduce patch lanes to {patch_limit}.", level="warn", detail=True)
                        elif lane != "patch" and main_limit != fallback_limit:
                            main_limit = fallback_limit
                            emit("log", message=f"[pipeline] submit error; reduce main lanes to {main_limit}.", level="warn", detail=True)
                        if is_suno_throttle_exhausted(exc):
                            pause_and_requeue_after_throttle(seg, depth, lane, exc)
                            continue
                        if looks_recoverable_network_error(str(exc)) and depth < 3:
                            emit("log", level="warn", message=f"快速模式自动降速｜网络或 Suno 临时异常：{str(exc)[:120]}", detail=True)
                            emit("log", message=f"[upload {seg.index}/{total}] network retry whole chunk depth={depth + 1}", detail=True)
                            time.sleep(2 + depth * 3)
                            (patch_queue if lane == "patch" else main_queue).append((seg, depth + 1))
                        else:
                            failed += 1
                            raise
                    continue

                if fut in split_pending:
                    parent_seg, parent_depth = split_pending.pop(fut)
                    try:
                        children = fut.result()
                        total += max(0, len(children) - 1)
                        notify_progress("total", max(0, len(children) - 1))
                        patch_queue.extend((child, parent_depth + 1) for child in children)
                        emit(
                            "log",
                            message=f"[gap-fill] recut ready for segment {parent_seg.index}; queued {len(children)} patch chunks.",
                            detail=True,
                        )
                    except Exception:
                        failed += 1
                        raise
                    continue

                seg, depth, lane = process_pending.pop(fut)
                try:
                    row = fut.result()
                    uploaded = save_row(row)
                    emit("segment", status="saved", index=seg.index, total=total, fileName=seg.fileName,
                         uploaded=uploaded, success=uploaded, failure=failed,
                         message=f"Segment accepted {uploaded} / {total}")
                    emit("status", message=f"Suno accepted {uploaded} / {total}", progress=min(75, 40 + int((uploaded / max(total, 1)) * 30)), detail=True)
                    record_lane_success(lane)
                except UploadProcessingError as exc:
                    if lane == "patch":
                        if patch_limit > initial_lane_limit:
                            patch_limit = initial_lane_limit
                            patch_complete_streak = 0
                            emit("log", message=f"[gap-fill] processing error; reduce patch lanes to {initial_lane_limit}.", level="warn", detail=True)
                    elif main_limit > initial_lane_limit:
                        main_limit = initial_lane_limit
                        main_complete_streak = 0
                        emit("log", message=f"[pipeline] processing error; reduce main lanes to {initial_lane_limit}.", level="warn", detail=True)
                    schedule_gap_split(seg, depth, exc)
                except Exception as exc:
                    if lane == "patch":
                        if patch_limit > initial_lane_limit:
                            patch_limit = initial_lane_limit
                            patch_complete_streak = 0
                            emit("log", message=f"[gap-fill] processing network error; reduce patch lanes to {patch_limit}.", level="warn", detail=True)
                    elif main_limit > initial_lane_limit:
                        main_limit = initial_lane_limit
                        main_complete_streak = 0
                        emit("log", message=f"[pipeline] processing network error; reduce main lanes to {main_limit}.", level="warn", detail=True)
                    if is_suno_throttle_exhausted(exc):
                        pause_and_requeue_after_throttle(seg, depth, lane, exc)
                        continue
                    if looks_recoverable_network_error(str(exc)) and depth < 3:
                        emit("log", level="warn", message=f"快速模式自动降速｜网络或 Suno 临时异常：{str(exc)[:120]}", detail=True)
                        emit("log", message=f"[upload {seg.index}/{total}] network retry whole chunk depth={depth + 1}", detail=True)
                        time.sleep(2 + depth * 3)
                        (patch_queue if lane == "patch" else main_queue).append((seg, depth + 1))
                    else:
                        failed += 1
                        raise

    if init_governor.enabled:
        try:
            client.throttle_cb = previous_throttle_cb
        except Exception:
            pass
    return sort_rows(rows)


class SegmentStream:
    def __init__(self, start_threshold: int = 3):
        self.start_threshold = max(1, int(start_threshold or 1))
        self._cond = threading.Condition()
        self._segments: List[Segment] = []
        self._closed = False
        self._error: Optional[BaseException] = None
        self.total_hint = 0

    def add(self, seg: Segment, total_hint: int = 0) -> None:
        with self._cond:
            if total_hint:
                self.total_hint = max(self.total_hint, int(total_hint))
            self._segments.append(seg)
            self._cond.notify_all()

    def close(self, error: Optional[BaseException] = None) -> None:
        with self._cond:
            self._error = error
            self._closed = True
            self._cond.notify_all()

    def wait_ready(self, cancel_path: Optional[Path] = None) -> None:
        with self._cond:
            while len(self._segments) < self.start_threshold and not self._closed and not self._error:
                self._cond.wait(timeout=0.25)
                raise_if_cancelled(cancel_path)
            if self._error:
                raise self._error

    def pop_available(self) -> List[Segment]:
        with self._cond:
            items = self._segments[:]
            self._segments.clear()
            return items

    def wait_for_work(self, timeout: float = 0.25) -> None:
        with self._cond:
            if not self._segments and not self._closed and not self._error:
                self._cond.wait(timeout=timeout)

    @property
    def closed(self) -> bool:
        with self._cond:
            return self._closed

    @property
    def error(self) -> Optional[BaseException]:
        with self._cond:
            return self._error


def upload_all_streaming(client: SunoClient, stream: SegmentStream, concurrency: int, progress_path: Path,
                         cancel_path: Optional[Path] = None,
                         progress_cb: Optional[Any] = None,
                         retry_split_min_sec: float = 0.2,
                         retry_max_depth: int = 10,
                         retry_overlap_sec: float = 0.08,
                         speed_mode: str = "fast") -> Tuple[List[Dict[str, Any]], List[Segment]]:
    raise_if_cancelled(cancel_path)
    rows: List[Dict[str, Any]] = load_progress_rows(progress_path)
    produced_segments: List[Segment] = []
    main_queue: List[tuple[Segment, int]] = []
    patch_queue: List[tuple[Segment, int]] = []
    process_queue: List[tuple[Segment, int, Dict[str, Any], str]] = []
    total = 0
    initial_total = 0
    max_extra_segments = 6
    retry_split_soft_limited = False
    failed = 0
    throttle_retry_counts: Dict[str, int] = {}

    def save_progress() -> None:
        progress_path.write_text(json.dumps(sort_rows(rows), ensure_ascii=False, indent=2), encoding="utf-8")

    def notify_progress(state: str, delta: int = 0) -> None:
        if progress_cb:
            try:
                progress_cb(state, delta)
            except Exception:
                pass

    def can_add_retry_children(additional: int = 1) -> bool:
        nonlocal retry_split_soft_limited
        if total - initial_total + additional <= max_extra_segments:
            return True
        retry_split_soft_limited = True
        emit(
            "log",
            level="warn",
            message=f"Retry split soft limit reached: base={initial_total}, total={total}, maxExtra={max_extra_segments}; continue safely.",
            detail=True,
        )
        return True

    def looks_recoverable_network_error(message: str) -> bool:
        text = message.lower()
        return any(token in text for token in (
            "s3 upload failed",
            "connection",
            "timeout",
            "timed out",
            "requesttimeout",
            "network",
            "429",
            "retry",
            "limit",
        ))

    def save_row(row: Dict[str, Any]) -> int:
        rows.append(row)
        save_progress()
        return len(rows)

    def pull_main_segments() -> None:
        nonlocal total, initial_total, max_extra_segments
        new_items = stream.pop_available()
        if stream.total_hint and stream.total_hint != initial_total:
            old_total = total
            initial_total = max(initial_total, int(stream.total_hint))
            total = max(total, initial_total)
            max_extra_segments = max(6, int(initial_total * 0.5))
            if total > old_total:
                notify_progress("total", total - old_total)
        for seg in new_items:
            produced_segments.append(seg)
            if rows_cover_segment(rows, seg):
                notify_progress("done")
                continue
            main_queue.append((seg, 0))

    stream.wait_ready(cancel_path)
    pull_main_segments()
    save_progress()
    max_workers = max(1, int(concurrency or 1))
    initial_lane_limit, lane_steps = upload_lane_policy(speed_mode, max_workers)
    main_limit = initial_lane_limit
    patch_limit = initial_lane_limit
    process_workers = min(3, max_workers)
    main_complete_streak = 0
    patch_complete_streak = 0
    main_steps = list(lane_steps)
    patch_steps = list(lane_steps)
    throttle_hold_until = 0.0
    init_governor = UploadInitGovernor(speed_mode)
    previous_throttle_cb = getattr(client, "throttle_cb", None)

    def handle_api_throttle(reason: str, **event: Any) -> None:
        nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak, throttle_hold_until
        if event.get("kind") != "rate_limit":
            if previous_throttle_cb:
                try:
                    previous_throttle_cb(reason, **event)
                except TypeError:
                    previous_throttle_cb(reason)
                except Exception:
                    pass
            return
        if init_governor.enabled:
            method = str(event.get("method") or "").upper()
            path = str(event.get("path") or "")
            retry_after = float(event.get("retry_after") or 0.0)
            is_upload_init = method == "POST" and path.rstrip("/") == "/api/uploads/audio"
            if is_upload_init:
                hold = init_governor.record_throttle(reason, retry_after=retry_after)
                log_message = (
                    f"[experiment] upload-init 429; hold new init for {hold:.0f}s, "
                    f"interval={init_governor.interval_sec:.1f}s"
                )
            else:
                hold = init_governor.record_aux_throttle(retry_after=retry_after)["hold_sec"]
                log_message = (
                    f"[experiment] auxiliary API 429 ({method} {path}); short init hold {hold:.0f}s, "
                    f"interval={init_governor.interval_sec:.1f}s"
                )
            main_limit = min(main_limit, initial_lane_limit)
            patch_limit = min(patch_limit, initial_lane_limit)
            main_complete_streak = 0
            patch_complete_streak = 0
            throttle_hold_until = max(throttle_hold_until, time.time() + hold)
            emit(
                "log",
                level="warn",
                message=log_message,
                detail=True,
            )
            if previous_throttle_cb:
                try:
                    previous_throttle_cb(reason, **event)
                except TypeError:
                    previous_throttle_cb(reason)
                except Exception:
                    pass
            return
        main_limit = min(main_limit, initial_lane_limit)
        patch_limit = min(patch_limit, initial_lane_limit)
        main_complete_streak = 0
        patch_complete_streak = 0
        throttle_hold_until = max(throttle_hold_until, time.time() + 15)
        emit("log", level="warn", message=f"[pipeline] Suno throttle; pause new submissions and hold lanes at {initial_lane_limit}: {reason}", detail=True)
        if previous_throttle_cb:
            try:
                previous_throttle_cb(reason, **event)
            except TypeError:
                previous_throttle_cb(reason)
            except Exception:
                pass

    try:
        client.throttle_cb = handle_api_throttle
    except Exception:
        pass

    emit(
        "log",
        message=f"[pipeline] streaming lanes: start after {stream.start_threshold} chunks; main first, gap-fill later; {upload_lane_policy_label(speed_mode, max_workers)}.",
        detail=True,
    )
    if init_governor.enabled:
        emit("log", message=f"[experiment] {init_governor.describe()}", detail=True)

    try:
        with futures.ThreadPoolExecutor(max_workers=max_workers) as upload_pool, \
                futures.ThreadPoolExecutor(max_workers=process_workers) as process_pool, \
                futures.ThreadPoolExecutor(max_workers=1) as split_pool:
            upload_pending: Dict[futures.Future, tuple[Segment, int, str]] = {}
            process_pending: Dict[futures.Future, tuple[Segment, int, str]] = {}
            split_pending: Dict[futures.Future, tuple[Segment, int]] = {}

            def lane_pending_count(lane: str) -> int:
                return sum(1 for _, _, pending_lane in upload_pending.values() if pending_lane == lane)

            def process_pending_count(lane: str) -> int:
                return sum(1 for _, _, pending_lane in process_pending.values() if pending_lane == lane)

            def main_active() -> bool:
                return (
                    not stream.closed
                    or bool(main_queue)
                    or lane_pending_count("main") > 0
                    or process_pending_count("main") > 0
                )

            def record_lane_success(lane: str) -> None:
                nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak
                if retry_split_soft_limited or time.time() < throttle_hold_until:
                    return
                if lane == "patch":
                    if not patch_steps:
                        return
                    patch_complete_streak += 1
                    needed, target = patch_steps[0]
                    if patch_complete_streak >= needed:
                        patch_steps.pop(0)
                        patch_limit = min(target, max_workers)
                        patch_complete_streak = 0
                        emit("log", message=f"[gap-fill] {needed} chunks accepted; raise patch lanes to {patch_limit}.", detail=True)
                    return
                if not main_steps:
                    return
                main_complete_streak += 1
                needed, target = main_steps[0]
                if main_complete_streak >= needed:
                    main_steps.pop(0)
                    main_limit = min(target, max_workers)
                    main_complete_streak = 0
                    emit("log", message=f"[pipeline] {needed} chunks accepted; raise main lanes to {main_limit}.", detail=True)

            def pause_and_requeue_after_throttle(seg: Segment, depth: int, lane: str, reason: BaseException) -> None:
                nonlocal main_limit, patch_limit, main_complete_streak, patch_complete_streak, throttle_hold_until
                retry_key = str(seg.fileName)
                retry_count = throttle_retry_counts.get(retry_key, 0)
                if speed_mode == "onbeat2x" and retry_count >= 5:
                    setattr(reason, "policy_retries_exhausted", True)
                    emit(
                        "log",
                        level="warn",
                        message=f"[pipeline] segment {seg.index}/{total} reached five 429 retries; advance fast-upload tier.",
                        detail=True,
                    )
                    raise reason
                throttle_retry_counts[retry_key] = retry_count + 1
                is_upload_init = False
                if init_governor.enabled:
                    method = str(getattr(reason, "method", "")).upper()
                    path = str(getattr(reason, "path", ""))
                    retry_after = float(getattr(reason, "retry_after", 0.0) or 0.0)
                    is_upload_init = method == "POST" and path.rstrip("/") == "/api/uploads/audio"
                    if is_upload_init:
                        wait = init_governor.record_throttle(
                            str(reason), exhausted=True, retry_after=retry_after
                        )
                    else:
                        wait = init_governor.record_aux_throttle(
                            retry_after=retry_after, exhausted=True
                        )["hold_sec"]
                else:
                    wait = 90
                if speed_mode == "onbeat2x":
                    wait = max(60.0, float(getattr(reason, "retry_after", 0.0) or 0.0))
                main_limit = initial_lane_limit
                patch_limit = initial_lane_limit
                main_complete_streak = 0
                patch_complete_streak = 0
                throttle_hold_until = max(throttle_hold_until, time.time() + wait)
                if not init_governor.enabled:
                    client.set_throttle_cooldown(wait)
                elif not is_upload_init:
                    client.set_throttle_cooldown(min(wait, 5.0))
                emit(
                    "log",
                    level="warn",
                    message=f"[pipeline] Suno 429 retry exhausted; hold lanes at {initial_lane_limit} for {wait}s and retry segment {seg.index}/{total}: {str(reason)[:120]}",
                    detail=True,
                )
                (patch_queue if lane == "patch" else main_queue).insert(0, (seg, depth))

            def enqueue_upload(queue: List[tuple[Segment, int]], lane: str, lane_limit: int) -> bool:
                if time.time() < throttle_hold_until:
                    return False
                if not queue or len(upload_pending) >= max_workers or lane_pending_count(lane) >= lane_limit:
                    return False
                if lane == "patch" and main_active():
                    return False
                if not init_governor.before_submit(lane):
                    return False
                seg, depth = queue.pop(0)
                upload_pending[upload_pool.submit(
                    prepare_upload, client, seg, total, cancel_path, progress_cb
                )] = (seg, depth, lane)
                return True

            def schedule_gap_split(seg: Segment, depth: int, exc: UploadProcessingError) -> None:
                nonlocal failed
                can_split = (
                    seg.duration >= retry_split_min_sec
                    and depth < retry_max_depth
                    if speed_mode == "onbeat2x"
                    else can_retry_split_error(exc, seg, retry_split_min_sec, retry_max_depth, depth)
                )
                if not can_split or not can_add_retry_children(1):
                    failed += 1
                    raise exc
                emit("log", message=f"[gap-fill] hole queued for recut segment {seg.index}/{total}, depth={depth + 1}.", detail=True)
                split_pending[split_pool.submit(
                    split_failed_segment_smart, seg, progress_path.parent, retry_overlap_sec, depth + 1
                )] = (seg, depth)

            while upload_pending or process_pending or split_pending or main_queue or patch_queue or process_queue or not stream.closed:
                raise_if_cancelled(cancel_path)
                pull_main_segments()
                if stream.error:
                    raise stream.error

                while True:
                    added = False
                    added = enqueue_upload(main_queue, "main", main_limit) or added
                    added = enqueue_upload(patch_queue, "patch", patch_limit) or added
                    if not added:
                        break

                while process_queue and len(process_pending) < process_workers:
                    seg, depth, init, lane = process_queue.pop(0)
                    process_pending[process_pool.submit(
                        complete_upload, client, seg, total, init, cancel_path, progress_cb, 3.2, 150
                    )] = (seg, depth, lane)

                pending = list(upload_pending.keys()) + list(process_pending.keys()) + list(split_pending.keys())
                if not pending:
                    stream.wait_for_work(0.25)
                    continue
                done_set, _ = futures.wait(pending, timeout=0.25, return_when=futures.FIRST_COMPLETED)
                if not done_set:
                    continue
                for fut in done_set:
                    if fut in upload_pending:
                        seg, depth, lane = upload_pending.pop(fut)
                        try:
                            init = fut.result()
                            governor_event = init_governor.record_success(lane)
                            if governor_event:
                                if "interval_sec" in governor_event:
                                    emit("log", message=f"[experiment] clean submit streak; init interval -> {governor_event['interval_sec']:.1f}s", detail=True)
                            process_queue.append((seg, depth, init, lane))
                        except Exception as exc:
                            if lane == "patch":
                                patch_complete_streak = 0
                                patch_limit = min(patch_limit, initial_lane_limit)
                            else:
                                main_complete_streak = 0
                                main_limit = min(main_limit, initial_lane_limit)
                            if is_suno_throttle_exhausted(exc):
                                pause_and_requeue_after_throttle(seg, depth, lane, exc)
                                continue
                            if speed_mode == "onbeat2x":
                                if depth < retry_max_depth:
                                    schedule_gap_split(
                                        seg,
                                        depth,
                                        UploadProcessingError(seg, {"status": "error", "reason": str(exc)[:300]}),
                                    )
                                else:
                                    failed += 1
                                    raise
                            elif looks_recoverable_network_error(str(exc)) and depth < 3:
                                emit("log", message=f"[upload {seg.index}/{total}] network retry whole chunk depth={depth + 1}", detail=True)
                                time.sleep(2 + depth * 3)
                                (patch_queue if lane == "patch" else main_queue).append((seg, depth + 1))
                            else:
                                failed += 1
                                raise
                        continue

                    if fut in split_pending:
                        parent_seg, parent_depth = split_pending.pop(fut)
                        try:
                            children = fut.result()
                            old_total = total
                            total += max(0, len(children) - 1)
                            notify_progress("total", total - old_total)
                            patch_queue.extend((child, parent_depth + 1) for child in children)
                            emit("log", message=f"[gap-fill] recut ready for segment {parent_seg.index}; queued {len(children)} patch chunks.", detail=True)
                        except Exception:
                            failed += 1
                            raise
                        continue

                    seg, depth, lane = process_pending.pop(fut)
                    try:
                        row = fut.result()
                        uploaded = save_row(row)
                        emit("segment", status="saved", index=seg.index, total=total, fileName=seg.fileName,
                             uploaded=uploaded, success=uploaded, failure=failed,
                             message=f"Segment accepted {uploaded} / {total}")
                        emit("status", message=f"Suno accepted {uploaded} / {total}", progress=min(75, 40 + int((uploaded / max(total, 1)) * 30)), detail=True)
                        record_lane_success(lane)
                    except UploadProcessingError as exc:
                        if lane == "patch":
                            patch_limit = min(patch_limit, initial_lane_limit)
                            patch_complete_streak = 0
                        else:
                            main_limit = min(main_limit, initial_lane_limit)
                            main_complete_streak = 0
                        schedule_gap_split(seg, depth, exc)
                    except Exception as exc:
                        if lane == "patch":
                            patch_limit = min(patch_limit, initial_lane_limit)
                            patch_complete_streak = 0
                        else:
                            main_limit = min(main_limit, initial_lane_limit)
                            main_complete_streak = 0
                        if is_suno_throttle_exhausted(exc):
                            pause_and_requeue_after_throttle(seg, depth, lane, exc)
                            continue
                        if speed_mode == "onbeat2x":
                            if depth < retry_max_depth:
                                schedule_gap_split(
                                    seg,
                                    depth,
                                    UploadProcessingError(seg, {"status": "error", "reason": str(exc)[:300]}),
                                )
                            else:
                                failed += 1
                                raise
                        elif looks_recoverable_network_error(str(exc)) and depth < 3:
                            emit("log", message=f"[upload {seg.index}/{total}] network retry whole chunk depth={depth + 1}", detail=True)
                            time.sleep(2 + depth * 3)
                            (patch_queue if lane == "patch" else main_queue).append((seg, depth + 1))
                        else:
                            failed += 1
                            raise
    finally:
        try:
            client.throttle_cb = previous_throttle_cb
        except Exception:
            pass

    return sort_rows(rows), produced_segments


def segment_from_manifest(item: Dict[str, Any]) -> Segment:
    return Segment(
        index=item["index"],
        path=Path(str(item["path"])).expanduser(),
        fileName=str(item["fileName"]),
        srcStartSec=float(item["srcStartSec"]),
        srcEndSec=float(item["srcEndSec"]),
        nominalStartSec=float(item["nominalStartSec"]),
        nominalEndSec=float(item["nominalEndSec"]),
        timelineStartSec=float(item["timelineStartSec"]),
        timelineEndSec=float(item["timelineEndSec"]),
        duration=float(item["duration"]),
        fadeInSec=float(item.get("fadeInSec") or 0.0),
        fadeOutSec=float(item.get("fadeOutSec") or 0.0),
        timelineScale=float(item.get("timelineScale") or 1.0),
    )


def load_segments_from_manifest(run_dir: Path) -> tuple[List[Segment], Dict[str, Any]]:
    manifest_path = run_dir / "split_manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    segments = [segment_from_manifest(item) for item in data.get("segments") or [] if isinstance(item, dict)]
    if not segments:
        raise RuntimeError(f"续传切片清单为空：{manifest_path}")
    return segments, data


def project_id_from_run_dir(run_dir: Path) -> Optional[str]:
    project_id_path = run_dir / "project_id.txt"
    if not project_id_path.exists():
        return None
    try:
        project_id = project_id_path.read_text(encoding="utf-8").strip()
        return project_id or None
    except Exception:
        return None


_RUN_DIR_STAMP_RE = re.compile(r"^(\d{8}_\d{6})(?:_\d+)?$")


def run_dir_order_key(run_dir: Path) -> float:
    """Return the run start time without trusting a directory mtime changed by cleanup."""
    match = _RUN_DIR_STAMP_RE.match(run_dir.name)
    if match:
        try:
            return time.mktime(time.strptime(match.group(1), "%Y%m%d_%H%M%S"))
        except (OverflowError, ValueError):
            pass
    try:
        return run_dir.stat().st_ctime
    except OSError:
        return 0.0


def _resolved_run_source(payload: Dict[str, Any]) -> str:
    raw_source = str(payload.get("source") or "").strip()
    if not raw_source:
        return ""
    try:
        return str(Path(raw_source).expanduser().resolve()).lower()
    except Exception:
        return ""


def _resume_segments_available(run_dir: Path, manifest: Dict[str, Any]) -> bool:
    segment_items = [item for item in manifest.get("segments") or [] if isinstance(item, dict)]
    if not segment_items:
        return False
    progress_path = run_dir / "uploaded_rows.progress.json"
    progress_rows: List[Dict[str, Any]] = []
    if progress_path.exists():
        try:
            progress_data = json.loads(progress_path.read_text(encoding="utf-8"))
            if isinstance(progress_data, list):
                progress_rows = [row for row in progress_data if isinstance(row, dict) and row.get("uploadId")]
        except Exception:
            progress_rows = []
    for item in segment_items:
        try:
            segment = segment_from_manifest(item)
        except Exception:
            return False
        if rows_cover_segment(progress_rows, segment):
            continue
        segment_path = Path(str(item.get("path") or ""))
        if not segment_path.is_absolute():
            segment_path = run_dir / segment_path
        if not segment_path.is_file():
            return False
    return True


def find_resume_run(run_base: Path, source: Path,
                    speed_mode: Optional[str] = None,
                    require_auth_interrupted: bool = False) -> Optional[Path]:
    if not run_base.exists():
        return None
    try:
        source_identity = source_file_identity(source.expanduser())
    except OSError:
        return None
    source_resolved = str(source.expanduser().resolve()).lower()
    requested_mode = str(speed_mode or "").strip().lower()
    latest_success_key: Optional[float] = None
    candidates: List[tuple[float, Path, Dict[str, Any]]] = []
    for run_dir in (p for p in run_base.iterdir() if p.is_dir()):
        manifest_path = run_dir / "split_manifest.json"
        progress_path = run_dir / "uploaded_rows.progress.json"
        summary_path = run_dir / "SUCCESS_SUMMARY.json"
        manifest: Dict[str, Any] = {}
        summary: Dict[str, Any] = {}
        try:
            if manifest_path.exists():
                loaded_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(loaded_manifest, dict):
                    manifest = loaded_manifest
            if summary_path.exists():
                loaded_summary = json.loads(summary_path.read_text(encoding="utf-8"))
                if isinstance(loaded_summary, dict):
                    summary = loaded_summary
        except Exception:
            continue
        run_source = _resolved_run_source(manifest) or _resolved_run_source(summary)
        if run_source != source_resolved:
            continue
        order_key = run_dir_order_key(run_dir)
        if summary_path.exists():
            latest_success_key = max(latest_success_key or order_key, order_key)
            continue
        if not manifest:
            continue
        account_user = os.environ.get("GAOBAI_SUNO_ACCOUNT_USER_ID", "")
        if account_user and manifest.get("sunoAccountUserId") != account_user:
            continue
        # Legacy manifests cannot prove that cached chunks belong to this file.
        if any(type(manifest.get(key)) is not int or manifest[key] != value
               for key, value in source_identity.items()):
            continue
        if require_auth_interrupted and not (run_dir / "AUTH_INTERRUPTED.json").exists():
            continue
        manifest_mode = str(manifest.get("uploadMode") or "").strip().lower()
        if manifest_mode and requested_mode and manifest_mode != requested_mode:
            continue
        if progress_path.exists() or project_id_from_run_dir(run_dir):
            candidates.append((order_key, run_dir, manifest))
    for order_key, run_dir, manifest in sorted(candidates, key=lambda item: item[0], reverse=True):
        if latest_success_key is not None and order_key <= latest_success_key:
            continue
        if not _resume_segments_available(run_dir, manifest):
            continue
        return run_dir
    return None


def inspect_auth_resume_candidate(source: Path, speed_mode: str) -> Dict[str, Any]:
    """Return a resumable task only when a previous job stopped for Suno auth."""
    run_dir = find_resume_run(
        RUN_BASE,
        source,
        speed_mode,
        require_auth_interrupted=True,
    )
    if not run_dir:
        return {"ok": True, "candidate": None}
    try:
        manifest = json.loads((run_dir / "split_manifest.json").read_text(encoding="utf-8"))
    except Exception:
        manifest = {}
    try:
        rows = json.loads((run_dir / "uploaded_rows.progress.json").read_text(encoding="utf-8"))
        rows = rows if isinstance(rows, list) else []
    except Exception:
        rows = []
    total = len([item for item in manifest.get("segments") or [] if isinstance(item, dict)])
    completed = len([row for row in rows if isinstance(row, dict) and row.get("uploadId")])
    project_id = project_id_from_run_dir(run_dir)
    can_resume = bool(project_id and total and completed and _resume_segments_available(run_dir, manifest))
    return {
        "ok": True,
        "candidate": {
            "workDir": str(run_dir),
            "projectId": project_id or "",
            "completed": completed,
            "total": total,
            "canResume": can_resume,
            "recommended": can_resume,
            "reason": "已验证项目、切片与已完成片段，可继续旧任务" if can_resume else "旧任务缺少有效项目、切片或完成片段，建议新建项目",
        },
    }


def cancel_file_from_env() -> Optional[Path]:
    raw = os.environ.get("GAOBAI_CANCEL_FILE", "").strip()
    return Path(raw) if raw else None


def raise_if_cancelled(cancel_path: Optional[Path] = None) -> None:
    if cancel_path and cancel_path.exists():
        raise RuntimeError("用户已停止上传，任务已取消。")


def is_cancelled_exception(exc: BaseException) -> bool:
    text = str(exc)
    return "用户已停止上传" in text or "任务已取消" in text or "cancelled" in text.lower()


def create_run_dir() -> Path:
    RUN_BASE.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_dir = RUN_BASE / stamp
    suffix = 1
    while out_dir.exists():
        out_dir = RUN_BASE / f"{stamp}_{suffix:02d}"
        suffix += 1
    out_dir.mkdir(parents=True, exist_ok=False)
    return out_dir


def latest_run_dir(run_base: Path = RUN_BASE) -> Optional[Path]:
    if not run_base.exists():
        return None
    run_dirs = sorted(
        (p for p in run_base.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return run_dirs[0] if run_dirs else None


def resolve_run_dir_arg(value: Optional[str]) -> Path:
    candidate = Path(value).expanduser() if value else latest_run_dir(RUN_BASE)
    if candidate is None:
        raise RuntimeError("没有找到可清理的切片目录")
    root = RUN_BASE.resolve()
    resolved = candidate.resolve()
    if not resolved.is_dir() or not resolved.is_relative_to(root):
        raise RuntimeError("切片目录不在软件运行目录内，已拒绝清理")
    return resolved


def segment_files_for_cleanup(run_dir: Path) -> List[Path]:
    files: List[Path] = []
    manifest_path = run_dir / "split_manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            decoded = manifest.get("decodedWav")
            if decoded:
                files.append(Path(str(decoded)))
            original_decoded = manifest.get("originalDecodedWav")
            if original_decoded:
                files.append(Path(str(original_decoded)))
            for item in manifest.get("segments") or []:
                if isinstance(item, dict) and item.get("path"):
                    files.append(Path(str(item.get("path"))))
        except Exception as exc:
            emit("log", level="warn", message=f"清理旧片段时读取 manifest 失败：{manifest_path}｜{exc}")
    segments_dir = run_dir / "segments"
    if segments_dir.exists():
        files.extend(p for p in segments_dir.rglob("*") if p.is_file())
    safe_files: List[Path] = []
    try:
        root = run_dir.resolve()
    except Exception:
        return safe_files
    for file_path in files:
        try:
            resolved = file_path.expanduser().resolve()
            if resolved.is_file() and resolved.is_relative_to(root):
                safe_files.append(resolved)
        except Exception:
            continue
    return sorted(set(safe_files))


def clear_local_segment_files(run_dir: Path) -> Dict[str, Any]:
    deleted = 0
    for file_path in segment_files_for_cleanup(run_dir):
        try:
            file_path.unlink()
            deleted += 1
        except FileNotFoundError:
            pass
        except Exception:
            continue
    segments_dir = run_dir / "segments"
    try:
        if segments_dir.exists() and not any(segments_dir.iterdir()):
            segments_dir.rmdir()
    except Exception:
        pass
    try:
        segments_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    removed_state = invalidate_unfinished_resume_state(run_dir)
    return {
        "ok": True,
        "workDir": str(run_dir),
        "segmentsDir": str(segments_dir),
        "deleted": deleted,
        "removedState": removed_state,
}


def invalidate_unfinished_resume_state(run_dir: Path) -> List[str]:
    removed_state: List[str] = []
    if (run_dir / "SUCCESS_SUMMARY.json").exists():
        return removed_state
    for name in (
        "split_manifest.json",
        "uploaded_rows.progress.json",
        "speed_restore_state.json",
        "project_id.txt",
    ):
        path = run_dir / name
        try:
            if path.exists():
                path.unlink()
                removed_state.append(name)
        except Exception:
            pass
    return removed_state


def cleanup_old_segment_files(run_base: Path = RUN_BASE, keep_projects: int = 8) -> int:
    if not run_base.exists():
        return 0
    run_dirs = sorted(
        (p for p in run_base.iterdir() if p.is_dir()),
        key=run_dir_order_key,
        reverse=True,
    )
    old_dirs = run_dirs[max(0, keep_projects):]
    deleted = 0
    for run_dir in old_dirs:
        for file_path in segment_files_for_cleanup(run_dir):
            try:
                file_path.unlink()
                deleted += 1
            except FileNotFoundError:
                pass
            except Exception as exc:
                emit("log", level="warn", message=f"旧片段删除失败：{file_path}｜{exc}")
        segments_dir = run_dir / "segments"
        try:
            if segments_dir.exists() and not any(segments_dir.iterdir()):
                segments_dir.rmdir()
        except Exception:
            pass
        invalidate_unfinished_resume_state(run_dir)
    if deleted:
        emit("log", message=f"本地项目超过 {keep_projects} 个，已清理最老项目片段文件 {deleted} 个。")
    return deleted


def create_project(client: SunoClient, title: str) -> str:
    client.reset_session("create-project")
    response = client.api(
        "POST",
        "/api/studio/create-project?title=" + urllib.parse.quote(title, safe=""),
        None,
        timeout=45,
        max_attempts=6,
        fast_reconnect=True,
    )
    project_id = response.get("id") if isinstance(response, dict) else None
    if not project_id:
        raise RuntimeError(f"创建 Studio 项目失败：{response}")
    return project_id


def downbeats_to_warp_markers(downbeats: List[Any]) -> Dict[str, float]:
    cleaned: List[Tuple[float, int]] = []
    for item in downbeats or []:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        try:
            seconds = round(float(item[0]), 4)
            beat_in_bar = int(item[1])
        except (TypeError, ValueError):
            continue
        if math.isfinite(seconds):
            cleaned.append((seconds, beat_in_bar))
    cleaned.sort(key=lambda item: item[0])
    if len(cleaned) < 2:
        raise RuntimeError("Suno 未返回足够的节拍分析点")
    first_downbeat = next((index for index, item in enumerate(cleaned) if item[1] == 1), 0)
    return {f"{seconds:.4f}": float(index - first_downbeat)
            for index, (seconds, _beat_in_bar) in enumerate(cleaned)}


def warp_beat_at_seconds(markers: Dict[str, float], seconds: float) -> float:
    points = sorted((float(key), float(value)) for key, value in markers.items())
    if len(points) < 2:
        return float(seconds)
    target = float(seconds)
    for index in range(1, len(points)):
        left_sec, left_beat = points[index - 1]
        right_sec, right_beat = points[index]
        if target <= right_sec:
            span = right_sec - left_sec
            if abs(span) < 1e-9:
                return right_beat
            return left_beat + (target - left_sec) / span * (right_beat - left_beat)
    left_sec, left_beat = points[-2]
    right_sec, right_beat = points[-1]
    span = right_sec - left_sec
    if abs(span) < 1e-9:
        return right_beat
    return right_beat + (target - right_sec) / span * (right_beat - left_beat)


def warp_markers_bps(markers: Dict[str, float]) -> float:
    points = sorted((float(key), float(value)) for key, value in markers.items())
    if len(points) < 2:
        return 0.0
    seconds = points[-1][0] - points[0][0]
    beats = points[-1][1] - points[0][1]
    return beats / seconds if seconds > 0 and beats > 0 else 0.0


def normalize_onbeat_markers(markers: Dict[str, float], expected_bps: float) -> Tuple[Dict[str, float], float]:
    detected_bps = warp_markers_bps(markers)
    if detected_bps <= 0:
        raise RuntimeError("Suno 节拍分析结果无效")
    factor = float(expected_bps) / detected_bps
    normalized = {key: round(float(value) * factor, 8) for key, value in markers.items()}
    return normalized, detected_bps


def fetch_onbeat_downbeats(client: SunoClient, rows: List[Dict[str, Any]],
                           cancel_path: Optional[Path] = None,
                           max_wait_sec: float = 300.0) -> Dict[str, List[Any]]:
    clip_ids = [str(row.get("clipId") or "").strip() for row in rows]
    if not clip_ids or any(not clip_id for clip_id in clip_ids):
        raise RuntimeError("On Beat 分析缺少已上传片段 clipId")
    pending = list(dict.fromkeys(clip_ids))
    completed: Dict[str, List[Any]] = {}
    deadline = time.monotonic() + max(10.0, float(max_wait_sec))
    last_errors: Dict[str, str] = {}
    while pending and time.monotonic() < deadline:
        raise_if_cancelled(cancel_path)
        next_pending: List[str] = []
        for clip_id in pending:
            raise_if_cancelled(cancel_path)
            try:
                response = client.api(
                    "GET", f"/api/gen/{clip_id}/downbeats",
                    timeout=45, max_attempts=2,
                )
            except Exception as exc:
                last_errors[clip_id] = str(exc)[:180]
                next_pending.append(clip_id)
                continue
            state = str((response or {}).get("state") or "").lower()
            if state == "complete":
                downbeats = (response or {}).get("downbeats") or []
                if len(downbeats) < 2:
                    raise RuntimeError(f"Suno 节拍分析为空：clipId={clip_id}")
                completed[clip_id] = downbeats
            elif state in ("error", "failed", "rejected", "blocked"):
                message = (response or {}).get("error_message") or state
                raise RuntimeError(f"Suno 节拍分析失败：clipId={clip_id}｜{message}")
            else:
                next_pending.append(clip_id)
        pending = next_pending
        emit(
            "status",
            message=f"On Beat 节拍分析｜完成 {len(completed)} / {len(clip_ids)}",
            progress=75,
        )
        if pending:
            time.sleep(3.0)
    if pending:
        detail = last_errors.get(pending[0], "analysis timeout")
        raise RuntimeError(f"Suno On Beat 节拍分析超时：剩余 {len(pending)} 段｜{detail}")
    return completed


def make_clip(row: Dict[str, Any], bps: float, color: str,
              warp_markers: Optional[Dict[str, float]] = None) -> tuple:
    import uuid
    start = float(row["timelineStartSec"]) * bps
    end = float(row["timelineEndSec"]) * bps
    fade_in = float(row.get("fadeInSec") or 0) * bps
    fade_out = float(row.get("fadeOutSec") or 0) * bps
    duration_beats = max(0.01, float(row["duration"]) * bps)
    read_start_beats = 0.0
    loop_end_beats = duration_beats
    warp_enabled = bool(warp_markers)
    if warp_markers:
        read_start_beats = warp_beat_at_seconds(warp_markers, 0.0)
        loop_end_beats = warp_beat_at_seconds(warp_markers, float(row["duration"]))
    marker_hash = "warp_" + uuid.uuid4().hex
    clip = {
        "type": "audio",
        "streaming": False,
        "name": row["fileName"],
        "color": color,
        "amplitude": 1,
        "transposition": 0,
        "readStartBeats": read_start_beats,
        "fadeInBeats": fade_in,
        "fadeOutBeats": fade_out,
        "fadeInCurve": 1,
        "fadeOutCurve": 1,
        "startBeats": start,
        "endBeats": end,
        "loop": {"startBeats": read_start_beats, "endBeats": loop_end_beats, "enabled": False},
        "warp": {"enabled": warp_enabled, "awaitingAnalysis": not warp_enabled, "markersHash": marker_hash},
        "id": str(uuid.uuid4()),
        "clipId": row.get("clipId"),
        "uploadId": None,
        "mute": False,
        "reversed": False,
        "awaitingContentAlignment": False,
    }
    if warp_enabled:
        clip["asset"] = {"type": "clip", "id": row.get("clipId")}
    return clip, marker_hash


def downbeats(bps: float, start: float, end: float) -> List[List[float]]:
    beats: List[List[float]] = []
    cursor = int(start)
    while cursor < int(end):
        beats.append([cursor / bps - start / bps, ((cursor % 4 + 4) % 4) + 1])
        cursor += 1
    return beats


def state_renderability_issues(state: Any) -> List[str]:
    """Detect project states that Suno Studio accepts for saving but fails to render."""
    issues: List[str] = []
    if not isinstance(state, dict):
        return ["state is not an object"]

    tracks = state.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        issues.append("missing tracks")
        return issues

    audio_tracks = [t for t in tracks if isinstance(t, dict) and t.get("type") == "audio"]
    if not audio_tracks:
        issues.append("missing audio track")
        return issues

    timing = state.get("timing")
    if not isinstance(timing, dict):
        issues.append("missing timing")
    else:
        if timing.get("type") != "manual":
            issues.append("timing.type is not manual")
        for key in ("bps", "lockBPS", "firstBeatSeconds", "bpsAutomation"):
            if key not in timing:
                issues.append(f"timing.{key} missing")

    base_track = audio_tracks[0]
    instrument = base_track.get("instrument")
    if not isinstance(instrument, dict) or instrument.get("type") != "song":
        issues.append("audio track instrument missing")
    if not isinstance(base_track.get("eq"), dict):
        issues.append("audio track eq missing")
    if "height" not in base_track:
        issues.append("audio track height missing")
    if base_track.get("routingMode") != "linear":
        issues.append("audio track routingMode missing")
    if not isinstance(base_track.get("signalChain"), list):
        issues.append("audio track signalChain missing")

    return issues


def fallback_project_state(out_dir: Path) -> dict:
    """Load a real Suno Studio state template when API returns an empty project."""
    candidates: List[Path] = [
        PROJECT_ROOT / "assets" / "studio_blank_state_template.json",
        PROJECT_ROOT / "resources" / "assets" / "studio_blank_state_template.json",
        APP_DATA / "evidence" / "studio_blank_state_template.json",
    ]
    if RUN_BASE.exists():
        candidates += sorted(
            RUN_BASE.glob("*/project_before_recut.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        candidates += sorted(
            RUN_BASE.glob("*/save_project_recut_payload.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        candidates += sorted(
            RUN_BASE.glob("*/save_project_payload.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

    last_error = ""
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
            state = data.get("state") if isinstance(data, dict) else None
            issues = state_renderability_issues(state)
            if isinstance(state, dict) and not issues:
                state = copy.deepcopy(state)
                (out_dir / "project_state_template_source.txt").write_text(str(candidate), encoding="utf-8")
                emit("log", message=f"项目无预设轨道，使用 Studio 模板：{candidate}")
                return state
            if isinstance(state, dict) and state.get("tracks"):
                emit("log", level="warn", message=f"跳过不完整 Studio 模板：{candidate}｜{'; '.join(issues)}")
        except Exception as exc:
            last_error = f"{candidate}: {exc}"

    emit("log", level="warn", message=f"找不到可用 Studio 模板，使用简化兜底 state：{last_error}")
    import uuid
    track_id = str(uuid.uuid4())
    return {
        "tracks": [
            {
                "id": track_id,
                "name": "音轨 1",
                "type": "audio",
                "color": "#F45D95",
                "clips": [],
                "solo": False,
                "mute": False,
                "arm": False,
                "instrument": {"type": "song"},
                "eq": {
                    "enabled": True,
                    "band1": {"q": 0.707, "type": "highpass", "enabled": False, "frequency": 60.0, "gain": 0.0},
                    "band2": {"q": 0.707, "type": "lowshelf", "enabled": True, "frequency": 160.0, "gain": 0.0},
                    "band3": {"q": 0.707, "type": "peaking", "enabled": True, "frequency": 450.0, "gain": 0.0},
                    "band4": {"q": 0.707, "type": "peaking", "enabled": True, "frequency": 1200.0, "gain": 0.0},
                    "band5": {"q": 0.707, "type": "highshelf", "enabled": True, "frequency": 3200.0, "gain": 0.0},
                    "band6": {"q": 0.707, "type": "lowpass", "enabled": False, "frequency": 8800.0, "gain": 0.0},
                },
                "amplitude": 1.0,
                "balance": 0.0,
                "routingMode": "linear",
                "signalChain": [],
                "takeLanes": [],
                "clipCreationIntents": [],
                "height": 88.0,
            }
        ],
        "timing": {"type": "manual", "bps": 2.0, "lockBPS": True, "firstBeatSeconds": 0.0, "bpsAutomation": []},
        "markersRegistry": {},
        "sections": {},
        "loop": {"startBeats": 0, "endBeats": 8, "enabled": False},
        "selection": {"focusedArea": "timeline", "focusedTrackId": track_id, "trackIds": [track_id]},
        "routing": {},
        "amplitude": 1.0,
        "masterRoutingMode": "linear",
        "masterSignalChain": [],
        "metronome": {"enabled": False, "amplitude": 1.0},
        "timeSignatureChanges": [{"beatsPerSubdivision": 1.0, "subdivisionsPerBar": 4.0, "startBeats": 0.0}],
        "lyricsCorrectionsByClipId": {},
    }


def assemble_and_render(client: SunoClient, project_id: str, rows: List[Dict[str, Any]],
                        title: str, out_dir: Path, tracks_count: int = 2,
                        cancel_path: Optional[Path] = None,
                        onbeat_bpm: Optional[float] = None,
                        onbeat_speed_ratio: float = 1.0) -> Dict[str, Any]:
    raise_if_cancelled(cancel_path)
    project = client.api("GET", f"/api/studio/project/{project_id}")
    (out_dir / "project_before.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "project_before_recut.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    project_state = project.get("state") if isinstance(project, dict) else None
    state_issues = state_renderability_issues(project_state)
    if isinstance(project_state, dict) and not state_issues:
        state = copy.deepcopy(project_state)
    else:
        if isinstance(project_state, dict) and project_state.get("tracks"):
            reason = "; ".join(state_issues) or "unknown"
            (out_dir / "project_state_rejected.txt").write_text(reason, encoding="utf-8")
            emit("log", level="warn", message=f"项目 state 不完整，改用 Studio 模板：{reason}")
        state = fallback_project_state(out_dir)
        (out_dir / "project_state_fallback.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    onbeat_enabled = onbeat_bpm is not None and float(onbeat_bpm or 0) > 0
    if onbeat_enabled:
        bps = float(onbeat_bpm) / 60.0
        state["timing"] = {
            "type": "manual",
            "bps": bps,
            "lockBPS": True,
            "firstBeatSeconds": 0.0,
            "bpsAutomation": [],
        }
    else:
        bps = float((state.get("timing") or {}).get("bps") or 2.0)
    onbeat_markers: Dict[str, Dict[str, float]] = {}
    onbeat_analysis: Dict[str, Any] = {}
    if onbeat_enabled:
        emit("status", message=f"On Beat｜正在按原曲 {float(onbeat_bpm):.1f} BPM 分析上传片段", progress=75)
        raw_downbeats = fetch_onbeat_downbeats(client, rows, cancel_path=cancel_path)
        expected_source_bps = bps * max(0.01, float(onbeat_speed_ratio or 1.0))
        for row in rows:
            clip_id = str(row.get("clipId") or "")
            markers = downbeats_to_warp_markers(raw_downbeats.get(clip_id) or [])
            normalized, detected_bps = normalize_onbeat_markers(markers, expected_source_bps)
            onbeat_markers[clip_id] = normalized
            onbeat_analysis[clip_id] = {
                "fileName": row.get("fileName"),
                "detectedBpm": round(detected_bps * 60.0, 3),
                "targetUploadBpm": round(expected_source_bps * 60.0, 3),
                "projectBpm": round(float(onbeat_bpm), 3),
                "markerCount": len(normalized),
            }
        (out_dir / "onbeat_analysis.json").write_text(
            json.dumps(onbeat_analysis, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        emit("log", message=f"On Beat 分析完成｜{len(onbeat_markers)} 段｜项目 BPM {float(onbeat_bpm):.1f}")
    base_track = next((t for t in state.get("tracks", []) if t.get("type") == "audio"), state["tracks"][0])
    import uuid
    colors = ["#02AF4A", "#3B82F6", "#A855F7", "#F59E0B"]
    tracks = []
    for i in range(max(1, tracks_count)):
        track = copy.deepcopy(base_track)
        track["id"] = str(uuid.uuid4()) if i else (track.get("id") or str(uuid.uuid4()))
        track["name"] = f"Auto Mix {i + 1}" if tracks_count > 1 else (track.get("name") or "New Track")
        track["color"] = colors[i % len(colors)]
        track["clips"] = []
        track["solo"] = False
        track["mute"] = False
        track["arm"] = False
        if "takeLanes" in track:
            track["takeLanes"] = []
        if "clipCreationIntents" in track:
            track["clipCreationIntents"] = []
        tracks.append(track)
    regs = {}
    for index, row in enumerate(rows):
        track = tracks[index % len(tracks)]
        markers = onbeat_markers.get(str(row.get("clipId") or "")) if onbeat_enabled else None
        clip, marker_hash = make_clip(row, bps, track["color"], warp_markers=markers)
        track["clips"].append(clip)
        regs[marker_hash] = markers or {"0": 0}
    state["tracks"] = tracks
    state["markersRegistry"] = regs
    state["selection"] = {
        **(state.get("selection") or {}),
        "focusedArea": "timeline",
        "focusedTrackId": tracks[0].get("id"),
    }
    total_sec = max(float(row["timelineEndSec"]) for row in rows)
    end_beats = total_sec * bps
    if isinstance(state.get("loop"), dict):
        state["loop"]["startBeats"] = 0
        state["loop"]["endBeats"] = max(8, end_beats)
        state["loop"]["enabled"] = False
    save_payload = {
        "project_id": project_id,
        "state": state,
        "title": project.get("title") or title,
    }
    (out_dir / "save_project_payload.json").write_text(json.dumps(save_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "save_project_recut_payload.json").write_text(json.dumps(save_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("status", message="保存工程｜正在把片段写入 Suno Studio 时间线", progress=78)
    raise_if_cancelled(cancel_path)
    save = client.api("POST", "/api/studio/save-project", save_payload, timeout=120)
    (out_dir / "save_project_response.json").write_text(json.dumps(save, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "save_project_recut_response.json").write_text(json.dumps(save, ensure_ascii=False, indent=2), encoding="utf-8")

    emit("status", message="开始渲染｜正在请求 Suno 导出最终音频", progress=82)
    render_payload = {
        "title": title,
        "lyrics": "",
        "state": state,
        "project_id": project_id,
        "from_studio_project_id": project_id,
        "start_beats": 0,
        "end_beats": end_beats,
        "downbeats": downbeats(bps, 0, end_beats),
        "web_client_pathname": "/studio",
        "export_mode": "rendered_context_window",
    }
    (out_dir / "render_state_recut_payload.json").write_text(json.dumps(render_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    raise_if_cancelled(cancel_path)
    render = client.api("POST", "/api/studio/render-state", render_payload, timeout=180)
    (out_dir / "render_state_recut_response.json").write_text(json.dumps(render, ensure_ascii=False, indent=2), encoding="utf-8")
    render_id = render.get("id") if isinstance(render, dict) else None
    final = None
    if render_id:
        for i in range(120):
            raise_if_cancelled(cancel_path)
            emit("status", message="渲染中｜正在等待 Suno 生成结果", progress=85 + min(i, 10))
            feed = client.api("POST", "/api/feed/v3", {
                "filters": {"ids": {"presence": "True", "clipIds": [render_id]}},
                "limit": 1,
            }, timeout=60)
            clips = feed.get("clips") or []
            if clips:
                final = clips[0]
                emit("log", message=f"[render] poll {i}: {final.get('status')} audio={bool(final.get('audio_url'))}")
                if final.get("status") in ("complete", "error"):
                    break
            time.sleep(5)
        if final:
            (out_dir / "render_clip_recut_final.json").write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    final_id = (final or {}).get("id") or render_id
    final_status = str((final or {}).get("status") or "").lower()
    if final_status and final_status != "complete":
        raise RuntimeError(f"Suno 渲染失败：renderId={final_id} status={final_status}。工程已保存，可打开 https://suno.com/studio 继续检查或手动重新导出。")
    if not (final or {}).get("audio_url"):
        raise RuntimeError(f"Suno 渲染没有生成音频链接：renderId={final_id}")
    return {
        "projectId": project_id,
        "versionId": save.get("version_id"),
        "renderId": final_id,
        "status": (final or {}).get("status"),
        "audioUrl": (final or {}).get("audio_url"),
        "songUrl": f"https://suno.com/song/{final_id}" if final_id else None,
        "finalClip": final,
        "clipCount": len(rows),
        "totalSeconds": total_sec,
        "onBeat": onbeat_enabled,
        "projectBpm": float(onbeat_bpm) if onbeat_enabled else bps * 60.0,
    }


def validate_render_duration(expected_sec: float, actual_sec: float) -> Dict[str, Any]:
    expected = max(0.0, float(expected_sec or 0.0))
    actual = max(0.0, float(actual_sec or 0.0))
    drift = abs(actual - expected)
    tolerance = max(1.0, expected * 0.01)
    return {
        "ok": expected > 0 and actual > 0 and drift <= tolerance,
        "expectedSec": round(expected, 3),
        "actualSec": round(actual, 3),
        "driftSec": round(drift, 3),
        "toleranceSec": round(tolerance, 3),
    }


def download_result_audio(result: Dict[str, Any], out_dir: Path,
                          cancel_path: Optional[Path] = None) -> Optional[str]:
    audio_url = result.get("audioUrl")
    final_id = result.get("renderId")
    if not final_id or not audio_url:
        return None
    raise_if_cancelled(cancel_path)
    emit("status", message="下载结果｜正在保存最终 MP3", progress=97)
    req = require_requests()
    response = req.get(str(audio_url), timeout=180)
    response.raise_for_status()
    prefix = "direct_upload" if result.get("directUpload") else "final_render"
    url_ext = Path(urllib.parse.urlparse(str(audio_url)).path).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{2,6}", url_ext or ""):
        url_ext = ".mp3"
    local_audio = out_dir / f"{prefix}_{final_id}{url_ext}"
    local_audio.write_bytes(response.content)
    return str(local_audio)


# ============================================================
# onbeat2x 分层兜底上传
# Tier 0: 2x 单段
# Tier 1: 4x 单段
# Tier 2: 4x × 6 段(每段可细切 1 次 → 12 段)
# Tier 3: 4x × 12 段(每段可再细切 1 次 → 24 段)
#
# 任意 tier 抛 UploadProcessingError → 升级到下一档。
# 429 限流(SunoThrottleExhausted)不算拒绝,直接外抛。
# ============================================================


def split_params_for_speed_ratio(ratio: float, target_segments: int) -> Dict[str, float]:
    """与 split_params_for_speed 等价的「按数值」版本。"""
    if target_segments <= 1:
        return {
            "target_sec": 12.0,
            "max_sec": 30.0,
            "search_sec": 1.2,
            "overlap_sec": 0.0,
            "source_speed_ratio": float(ratio),
            "target_segments": 1,
        }
    return {
        "target_sec": 30.0,
        "max_sec": 38.0,
        "search_sec": 1.2,
        "overlap_sec": 0.0,
        "source_speed_ratio": float(ratio),
        "target_segments": int(target_segments),
    }


def _cleanup_run_dir_partial(out_dir: Path) -> None:
    """tier 失败后清掉本轮的临时文件,给下一档的写入留出干净起点。"""
    import shutil as _sh
    try:
        for child in out_dir.iterdir():
            if child.is_dir():
                _sh.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink()
                except OSError:
                    pass
    except FileNotFoundError:
        pass


def _tier_upload(
    client: Any,
    source: Path,
    title: str,
    out_dir: Path,
    cancel_path: Optional[Path],
    progress_path: Optional[Path],
    *,
    ratio: float,
    target_segments: int,
    retry_max_depth: int,
    used_tier: int,
) -> Dict[str, Any]:
    """执行单档 tier 的切分 + 上传主流程。"""
    params = split_params_for_speed_ratio(ratio, target_segments)
    segments, manifest = split_audio(
        source,
        out_dir,
        **params,
        on_segment=lambda seg, _: emit(
            "log",
            message=f"分段产出:{seg.fileName}",
            detail=True,
        ),
    )
    manifest["uploadMode"] = "onbeat2x-with-recovery"
    manifest["usedTier"] = used_tier
    (out_dir / "split_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    pp = progress_path or (out_dir / "uploaded_rows.progress.json")
    tier_progress = {
        "total": len(segments),
        "submitted": 0,
        "done": 0,
        "failed": 0,
        "started_at": time.time(),
    }

    def tier_progress_cb(state: str, delta: int = 0) -> None:
        if state in ("submitted", "done", "failed"):
            tier_progress[state] += 1
        elif state == "total" and delta:
            tier_progress["total"] += int(delta)
        emit(
            "progress",
            total=tier_progress["total"],
            submitted=tier_progress["submitted"],
            done=tier_progress["done"],
            failed=tier_progress["failed"],
            elapsed_sec=round(time.time() - tier_progress["started_at"], 2),
        )

    tier_progress_cb("reset")
    rows, produced_segments = upload_all_streaming(
        client,
        _make_segment_stream(segments),
        concurrency=2,
        progress_path=pp,
        cancel_path=cancel_path,
        progress_cb=tier_progress_cb,
        retry_split_min_sec=0.2,
        retry_max_depth=retry_max_depth,
        retry_overlap_sec=0.08,
        speed_mode="onbeat2x",
    )
    return {
        "rows": rows,
        "segments": produced_segments,
        "manifest": manifest,
        "used_tier": used_tier,
        "used_speed_ratio": ratio,
        "target_segments": target_segments,
        "submitted": tier_progress["submitted"],
        "done": tier_progress["done"],
        "failed": tier_progress["failed"],
    }


def _make_segment_stream(segments: List[Segment]) -> Any:
    """把已经完成切分的片段放入完整 SegmentStream 接口。"""
    stream = SegmentStream(start_threshold=1)
    total = len(segments)
    for segment in segments:
        stream.add(segment, total_hint=total)
    stream.close()
    return stream


def upload_with_policy_recovery(
    client: Any,
    source: Path,
    title: str,
    out_dir: Path,
    cancel_path: Optional[Path] = None,
    progress_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Try progressively shorter fast-upload tiers for technical processing failures."""
    tiers: List[Tuple[float, int, int, str]] = [
        (2.0, 1, 0, "2x single segment"),
        (4.0, 1, 0, "4x single segment"),
        (4.0, 6, 1, "4x six segments"),
    ]
    last_error: Optional[BaseException] = None
    for index, (ratio, target_segments, retry_depth, label) in enumerate(tiers):
        throttle_retries = 0
        raise_if_cancelled(cancel_path)
        attempt = index + 1
        status_message = "上传" if attempt == 1 else f"{attempt}次调整上传"
        emit(
            "status",
            message=status_message,
            progress=15 + index * 4,
            uploadAttempt=attempt,
        )
        emit(
            "log",
            message=(
                f"Fast upload tier {index}: {label} "
                f"(ratio={ratio}, segments={target_segments}, retry_depth={retry_depth})"
            ),
            detail=True,
        )
        while True:
            try:
                return _tier_upload(
                    client=client,
                    source=source,
                    title=title,
                    out_dir=out_dir,
                    cancel_path=cancel_path,
                    progress_path=progress_path,
                    ratio=ratio,
                    target_segments=target_segments,
                    retry_max_depth=retry_depth,
                    used_tier=index,
                )
            except SunoThrottleExhausted as exc:
                # Never change speed because of rate limiting: cool down and
                # repeat the same tier up to five times.
                if getattr(exc, "policy_retries_exhausted", False) or throttle_retries >= 5:
                    last_error = exc
                    break
                throttle_retries += 1
                emit("log", level="warn", message="Suno 429: waiting 60 seconds before retrying the same upload.", detail=True)
                client.set_throttle_cooldown(60)
                time.sleep(60)
                continue
            except Exception as exc:
                if is_cancelled_exception(exc):
                    raise
                last_error = exc
                break

        if index >= len(tiers) - 1:
            break
        emit("log", level="warn", message=f"{label} failed; switching to the next fast-upload tier.", detail=True)
        _cleanup_run_dir_partial(out_dir)

    raise last_error if last_error else RuntimeError("Fast upload tiers exhausted")


def split_params_for_speed(speed: str) -> Dict[str, float]:
    mode = (speed or "standard").strip().lower()
    if mode == "onbeat2x":
        return {
            "target_sec": 12.0,
            "max_sec": 30.0,
            "search_sec": 1.2,
            "overlap_sec": 0.0,
            "source_speed_ratio": 2.0,
            "target_segments": 1,
        }
    if mode == "stable":
        # 稳定上传提速：放大切片到 ~8s，减少段数（3分钟歌约 37→22 段），可用环境变量回滚
        target = float(os.environ.get("GAOBAI_STABLE_TARGET_SEC", "8.0") or 8.0)
        return {
            "target_sec": target,
            "max_sec": target + 0.8,
            "search_sec": 1.0,
            "overlap_sec": 0.06,
        }
    if mode in ("fast", "experiment"):
        return {
            "target_sec": 4.8,
            "max_sec": 5.2,
            "search_sec": 1.0,
            "overlap_sec": 0.06,
        }
    return {
        "target_sec": 5.0,
        "max_sec": 5.5,
        "search_sec": 1.0,
        "overlap_sec": 0.08,
    }


def run_upload(source: Path, title: str, speed: str, resume_policy: str = "auto") -> Dict[str, Any]:
    if not source.exists():
        raise RuntimeError(f"源文件不存在：{source}")
    job_started_at = time.time()
    cancel_path = cancel_file_from_env()
    if cancel_path:
        try:
            cancel_path.unlink()
        except FileNotFoundError:
            pass
    title = title.strip() or source.stem
    speed = (speed or "standard").strip().lower()
    if speed not in ("standard", "stable", "experiment", "fast", "onbeat2x"):
        speed = "standard"
    resume_policy = str(resume_policy or "auto").strip().lower()
    if resume_policy == "new":
        resume_dir = None
    elif resume_policy == "resume":
        resume_dir = find_resume_run(RUN_BASE, source, speed, require_auth_interrupted=True)
    else:
        resume_dir = find_resume_run(RUN_BASE, source, speed)
    if resume_dir and speed == "onbeat2x":
        try:
            previous_manifest = json.loads((resume_dir / "split_manifest.json").read_text(encoding="utf-8"))
        except Exception:
            previous_manifest = {}
        if int(previous_manifest.get("targetSegments") or 0) != 1:
            emit("log", message="旧版多段实验任务不再续传，正在创建整首单段上传任务。")
            resume_dir = None
    if resume_dir:
        out_dir = resume_dir
        emit("log", message=f"[resume] continuing previous unfinished run: {out_dir}")
    else:
        out_dir = create_run_dir()
        emit("log", message=f"已创建全新上传项目：{out_dir}")
    emit("workdir", workDir=str(out_dir), segmentsDir=str(out_dir / "segments"))
    try:
        out_dir.touch()
    except Exception:
        pass
    cleanup_old_segment_files(RUN_BASE, keep_projects=8)
    concurrency = 6 if speed == "fast" else (3 if speed == "experiment" else (4 if speed == "stable" else 2))
    if speed == "fast":
        mode_message = "上传模式｜快速自适应：2→4→6 路爬升，遇到 Suno 限流自动冷却并降回 2 路"
    elif speed == "experiment":
        mode_message = "上传模式｜15分钟目标：单初始化闸门，自适应429冷却，最多3路后台处理"
    elif speed == "stable":
        mode_message = "上传模式｜稳定上传：3→4 路爬升 + 大切片，提速上传并控制 Suno 限流风险"
    elif speed == "onbeat2x":
        mode_message = "上传模式｜快速上传：整首音频优化后单段上传"
    else:
        mode_message = "上传模式｜标准稳速：1 路上传"
    emit("log", message=mode_message)
    emit("log", message=f"Upload lane policy | {upload_lane_policy_label(speed, concurrency)}", detail=True)
    raise_if_cancelled(cancel_path)

    ctx = load_saved_token()
    if not ctx:
        raise SunoAuthRequired("未获取到可用的 Suno Token，请重新登录 Suno。")
    skip_preflight = os.environ.get("GAOBAI_SKIP_SUNO_TOKEN_PRECHECK", "0") == "1"
    if skip_preflight:
        emit("log", message="[auth] 刚登录会话：本次上传跳过联网 Token 预检。")
    else:
        check = validate_suno_token(ctx.get("token") or "", timeout=20)
        emit("log", message=f"[auth] 上传前 token 校验：ok={check.get('ok')} status={check.get('status_code')} reason={check.get('reason')}")
        if not check.get("ok"):
            try:
                TOKEN_FILE.unlink()
            except Exception:
                pass
            raise SunoAuthRequired("Suno Token 已失效，请重新登录 Suno。")
    client = SunoClient(ctx["token"], ctx.get("deviceId") or "")
    client.auth_interrupted_path = out_dir / "AUTH_INTERRUPTED.json"
    if speed == "experiment":
        client.upload_init_max_attempts = 1
        client.low_request_polling = True
        client.defer_segment_metadata = True
    apply_recent_suno_cooldown(client)
    raise_if_cancelled(cancel_path)

    if (not resume_dir and speed != "onbeat2x"
            and os.environ.get("GAOBAI_ENABLE_DIRECT_UPLOAD", "0") == "1"):
        try:
            result = try_direct_whole_upload(client, source, title, out_dir, cancel_path=cancel_path)
            local_audio_path = None
            try:
                local_audio_path = download_result_audio(result, out_dir, cancel_path=cancel_path)
            except Exception as exc:
                emit("log", message=f"下载整首直传音频跳过：{exc}")
            elapsed_sec = round(time.time() - job_started_at, 2)
            summary = {
                **result,
                "workDir": str(out_dir),
                "source": str(source),
                "segments": 1,
                "speed": speed,
                "localAudioPath": local_audio_path,
                "elapsedSec": elapsed_sec,
                "apiMetrics": client.api_metrics(),
            }
            (out_dir / "SUCCESS_SUMMARY.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            emit("progress", total=1, done=1, failed=0, elapsed_sec=elapsed_sec)
            emit("result", **summary)
            return summary
        except Exception as exc:
            emit("log", level="warn", message="整首直传未通过｜自动改用切片上传")
            emit("log", level="warn", message=f"整首直传失败：{exc}", detail=True)

    stream: Optional[SegmentStream] = None
    split_thread: Optional[threading.Thread] = None
    split_result: Dict[str, Any] = {}

    if resume_dir and (out_dir / "split_manifest.json").exists():
        emit("status", message="正在读取续传切片", progress=10)
        segments, manifest = load_segments_from_manifest(out_dir)
        emit("log", message=f"总切片数量｜{len(segments)} 段")
        emit("log", message=f"[resume] loaded split manifest with {len(segments)} base segments", detail=True)
    else:
        emit("status", message="正在上传" if speed == "onbeat2x" else "正在切分音频", progress=10)
        if speed == "onbeat2x":
            # The recovery policy owns BPM detection, speed conversion and
            # splitting so the first 2x tier is not generated twice.
            segments = []
            manifest = {}
        elif speed in ("fast", "stable", "experiment"):
            stream = SegmentStream(start_threshold=3)
            split_seen = {"total": False, "count": 0}

            def on_split_segment(seg: Segment, total_hint: int) -> None:
                split_seen["count"] += 1
                if total_hint and not split_seen["total"]:
                    split_seen["total"] = True
                    emit("log", message=f"Total slices: {total_hint}", detail=True)
                    emit("log", message=f"[split] remote marker adaptive target=4.8 max=5.2 total={total_hint}", detail=True)
                stream.add(seg, total_hint)
                if split_seen["count"] == stream.start_threshold:
                    emit("log", message=f"[split] first {stream.start_threshold} chunks ready; upload queue can start.", detail=True)

            def split_worker() -> None:
                try:
                    split_segments, split_manifest = split_audio(
                        source,
                        out_dir,
                        **split_params_for_speed(speed),
                        on_segment=on_split_segment,
                    )
                    split_result["segments"] = split_segments
                    split_result["manifest"] = split_manifest
                    stream.close()
                except BaseException as exc:
                    split_result["error"] = exc
                    stream.close(exc)

            split_thread = threading.Thread(target=split_worker, name="suno-stream-split", daemon=True)
            split_thread.start()
            segments = []
            manifest = {}
            emit("log", message="[split] streaming split started; upload begins after first 3 chunks.", detail=True)
        else:
            segments, manifest = split_audio(source, out_dir, **split_params_for_speed(speed))
            manifest["uploadMode"] = speed
            (out_dir / "split_manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            emit("log", message=f"总切片数量｜{len(segments)} 段")
    raise_if_cancelled(cancel_path)

    recovery_result: Optional[Dict[str, Any]] = None
    onbeat_bpm: Optional[float] = None
    onbeat_ratio = 1.0
    if speed == "onbeat2x" and not resume_dir:
        recovery_result = upload_with_policy_recovery(
            client=client,
            source=source,
            title=title,
            out_dir=out_dir,
            cancel_path=cancel_path,
        )
        rows = recovery_result["rows"]
        segments = recovery_result["segments"]
        manifest = recovery_result["manifest"]
        onbeat_bpm = float(manifest.get("originalBpm") or 0.0)
        onbeat_ratio = float(recovery_result.get("used_speed_ratio") or 2.0)
        if not 40.0 <= onbeat_bpm <= 240.0:
            raise RuntimeError(f"原曲 BPM 自动检测无效：{onbeat_bpm}")
        emit(
            "log",
            message=(
                f"原曲 BPM 检测｜{onbeat_bpm:.1f} BPM｜"
                f"置信度 {float(manifest.get('bpmConfidence') or 0.0):.2f}｜"
                f"上传速度 {onbeat_ratio:.1f}x｜Tier {recovery_result['used_tier']}"
            ),
            detail=True,
        )

    # 上传进度跟踪：用于 emit progress 事件
    upload_state = {
        "total": len(segments),
        "submitted": int((recovery_result or {}).get("submitted") or 0),
        "done": int((recovery_result or {}).get("done") or 0),
        "failed": int((recovery_result or {}).get("failed") or 0),
        "started_at": time.time(),
        "last_emit_at": time.time(),
    }

    def emit_progress(force: bool = False):
        now = time.time()
        # 节流：每 0.4 秒最多一次，强刷（done==total）也发
        if not force and now - upload_state["last_emit_at"] < 0.4:
            return
        upload_state["last_emit_at"] = now
        elapsed = max(0.001, now - upload_state["started_at"])
        emit("progress", **{
            "total": upload_state["total"],
            "submitted": upload_state["submitted"],
            "done": upload_state["done"],
            "failed": upload_state["failed"],
            "elapsed_sec": round(elapsed, 2),
        })

    def progress_cb(state: str, delta: int = 0) -> None:
        if state == "submitted":
            upload_state["submitted"] += 1
            emit_progress()
        elif state == "done":
            upload_state["done"] += 1
            emit_progress()
        elif state == "failed":
            upload_state["failed"] += 1
            emit_progress()
        elif state == "total" and delta:
            upload_state["total"] += int(delta)
            emit_progress(force=True)

    project_id_path = out_dir / "project_id.txt"
    project_id = project_id_from_run_dir(out_dir) if resume_dir else None
    if project_id:
        emit("status", message="正在上传" if speed == "onbeat2x" else "正在复用 Suno Studio 项目", progress=32)
        emit("log", message=f"[resume] using previous Studio project id={project_id}")
    else:
        emit("status", message="正在上传" if speed == "onbeat2x" else "正在创建 Suno Studio 项目", progress=32)
        project_id = create_project(client, title)
        project_id_path.write_text(project_id, encoding="utf-8")
    progress_path = out_dir / "uploaded_rows.progress.json"
    raise_if_cancelled(cancel_path)
    emit(
        "status",
        message="正在上传" if speed == "onbeat2x" else f"正在上传片段｜0 / {len(segments) if segments else '计算中'}",
        progress=34,
    )
    if recovery_result is not None:
        pass
    elif stream is not None:
        rows, produced_segments = upload_all_streaming(
            client,
            stream,
            concurrency,
            progress_path,
            cancel_path,
            progress_cb,
            retry_split_min_sec=0.2,
            retry_max_depth=0 if speed == "onbeat2x" else 10,
            retry_overlap_sec=0.08,
            speed_mode=speed,
        )
        if split_thread:
            split_thread.join(timeout=5)
        if split_result.get("error"):
            raise split_result["error"]
        segments = list(split_result.get("segments") or produced_segments)
        manifest = dict(split_result.get("manifest") or {})
        manifest["uploadMode"] = speed
        (out_dir / "split_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    else:
        rows = upload_all(
            client,
            segments,
            concurrency,
            progress_path,
            cancel_path,
            progress_cb,
            retry_split_min_sec=0.2,
            retry_max_depth=0 if speed == "onbeat2x" else 10,
            retry_overlap_sec=0.08,
            speed_mode=speed,
        )
    raise_if_cancelled(cancel_path)
    (out_dir / "uploaded_rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("log", message=f"全部片段已接收｜{len(rows)} / {len(segments)} 段")
    emit("log", message=f"片段上传全部完成｜成功 {len(rows)} / {len(segments)}｜进度文件：{progress_path}", detail=True)
    raise_if_cancelled(cancel_path)
    emit("status", message="正在渲染" if speed == "onbeat2x" else "正在组装并渲染", progress=76)
    # onbeat2x:onbeat_bpm / onbeat_ratio 已在前面 recovery 路径设好;
    # 其他模式的兜底再算一遍(防止默认值缺失)。
    if speed == "onbeat2x" and onbeat_bpm is None:
        onbeat_bpm = float(manifest.get("originalBpm") or 0.0)
        confidence = float(manifest.get("bpmConfidence") or 0.0)
        if not 40.0 <= onbeat_bpm <= 240.0:
            raise RuntimeError(f"原曲 BPM 自动检测无效：{onbeat_bpm}")
        onbeat_ratio = float(manifest.get("sourceSpeedRatio") or 2.0)
        emit(
            "log",
            message=f"原曲 BPM 检测｜{onbeat_bpm:.1f} BPM｜置信度 {confidence:.2f}｜上传速度 {onbeat_ratio:.1f}x",
        )
    render_options = {
        "cancel_path": cancel_path,
        "onbeat_bpm": onbeat_bpm,
        "onbeat_speed_ratio": onbeat_ratio,
    }
    try:
        result = assemble_and_render(client, project_id, rows, title, out_dir, **render_options)
    except Exception as first_render_error:
        deferred_count = sum(1 for row in rows if row.get("metadataDeferred"))
        if not deferred_count:
            raise
        emit(
            "log",
            level="warn",
            message=f"快速元数据路径渲染未通过，正在补齐 {deferred_count} 段元数据后自动重试。",
        )
        emit("log", level="warn", message=f"首次渲染错误：{first_render_error}", detail=True)
        apply_deferred_segment_metadata(client, rows, cancel_path=cancel_path)
        (out_dir / "uploaded_rows.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        result = assemble_and_render(client, project_id, rows, title, out_dir, **render_options)

    if speed == "onbeat2x":
        expected_duration = float(manifest.get("originalDuration") or 0.0)
        final_clip = result.get("finalClip") if isinstance(result.get("finalClip"), dict) else {}
        metadata = final_clip.get("metadata") if isinstance(final_clip.get("metadata"), dict) else {}
        actual_duration = float(metadata.get("duration") or 0.0)
        duration_validation = validate_render_duration(expected_duration, actual_duration)
        result["durationValidation"] = duration_validation
        result["originalBpm"] = onbeat_bpm
        (out_dir / "duration_validation.json").write_text(
            json.dumps(duration_validation, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if not duration_validation["ok"]:
            raise RuntimeError(
                "快速上传渲染时长校验失败："
                f"预计 {expected_duration:.2f}s，实际 {actual_duration:.2f}s。"
                "工程已保留，可打开 Suno Studio 检查。"
            )
        emit(
            "log",
            message=(
                "快速上传时长校验通过｜"
                f"预计 {expected_duration:.2f}s｜实际 {actual_duration:.2f}s｜"
                f"误差 {duration_validation['driftSec']:.2f}s"
            ),
        )

    # Download final MP3
    local_audio_path = None
    try:
        local_audio_path = download_result_audio(result, out_dir, cancel_path=cancel_path)
    except Exception as exc:
        emit("log", message=f"下载最终 MP3 跳过：{exc}")

    summary = {
        **result,
        "workDir": str(out_dir),
        "source": str(source),
        "segments": len(segments),
        "speed": speed,
        "localAudioPath": local_audio_path,
        "rawAudioPath": local_audio_path,
        "elapsedSec": round(time.time() - job_started_at, 2),
        "apiMetrics": client.api_metrics(),
    }
    (out_dir / "SUCCESS_SUMMARY.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    history_store.add_item({
        "title": title,
        "status": "success",
        "speed": speed,
        "audio": str(source),
        "work_dir": str(out_dir),
        "url": summary.get("songUrl"),
    })
    # 任务成功：最终刷一次进度；Renderer 统一播放应用内成功音效。
    upload_state["done"] = upload_state["total"]
    emit_progress(force=True)
    emit("result", **summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Suno歌曲上传器后端")
    parser.add_argument("--login-only", action="store_true")
    parser.add_argument("--logout-suno", action="store_true")
    parser.add_argument("--import-suno-token", action="store_true")
    parser.add_argument("--check-login-token", action="store_true")
    parser.add_argument("--check-login-token-local", action="store_true")
    parser.add_argument("--prepare-suno-token", action="store_true")
    parser.add_argument("--auth-timeout-sec", type=int, default=25)
    parser.add_argument("--recover-suno-token", action="store_true")
    parser.add_argument("--token-recovery-attempts", type=int, default=4)
    parser.add_argument("--resume-candidate", action="store_true")
    parser.add_argument("--resume-policy", choices=["auto", "resume", "new"], default="auto")
    parser.add_argument("--source")
    parser.add_argument("--title", default="")
    parser.add_argument(
        "--speed",
        choices=["standard", "stable", "experiment", "fast", "onbeat2x"],
        default="standard",
    )
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--clear-history", action="store_true")
    parser.add_argument("--clear-segments", nargs="?", const="", default=None)
    parser.add_argument("--lyrics-mode", choices=["pinyin", "homophone", "cantonese", "english-pron", "korean-roman", "thai-roman"])
    parser.add_argument("--lyrics", default="")
    args = parser.parse_args()

    if args.logout_suno:
        clear_login_files(APP_DATA, BROWSER_PROFILE, TOKEN_FILE,
                          lambda: stop_profile_browser_processes(strict=True))
        print(json.dumps({"ok": True}), flush=True)
        return
    if args.import_suno_token:
        data = json.loads(sys.stdin.read(65537))
        selected = select_verified_token(data, validate_suno_token)
        if not selected["account"]["userId"]:
            raise RuntimeError("无法确认 Suno 账号身份，请重新登录。")
        selected.update({"href": "https://suno.com/", "captured_at": int(time.time()),
                         "ts": int(time.time() * 1000), "projectKeys": []})
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = TOKEN_FILE.with_suffix(".tmp")
        temp.write_text(json.dumps(selected, ensure_ascii=False), encoding="utf-8")
        temp.replace(TOKEN_FILE)
        print(json.dumps({"ok": True, "loggedIn": True, "account": selected["account"]}), flush=True)
        return

    if args.history:
        print(json.dumps({"ok": True, "items": history_store.load_items()}, ensure_ascii=False), flush=True)
        return
    if args.clear_history:
        history_store.clear()
        print(json.dumps({"ok": True, "items": []}, ensure_ascii=False), flush=True)
        return
    if args.clear_segments is not None:
        result = clear_local_segment_files(resolve_run_dir_arg(args.clear_segments or None))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return
    if args.lyrics_mode in ("cantonese", "english-pron", "korean-roman", "thai-roman"):
        import lyrics_multilang
        result_text = lyrics_multilang.process_multilang(args.lyrics, args.lyrics_mode)
        print(json.dumps({"ok": True, "text": result_text}, ensure_ascii=False), flush=True)
        return
    if args.lyrics_mode:
        print(json.dumps({"ok": True, "text": lyrics_local.process(args.lyrics_mode, args.lyrics)}, ensure_ascii=False), flush=True)
        return
    if args.login_only:
        # A login is reported successful only after online credential validation.
        ctx = export_suno_token(validate=True)
        emit("result", loginOk=True, href=ctx.get("href"), tokenSource=ctx.get("tokenSource"), tokenCheck=ctx.get("tokenCheck"))
        return
    if args.recover_suno_token:
        try:
            ctx = recover_suno_token(max_attempts=max(1, min(4, int(args.token_recovery_attempts or 4))))
            print(json.dumps({"ok": True, "loggedIn": True, "tokenSource": ctx.get("tokenSource") or "browser"}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "loggedIn": False, "reason": str(exc)}, ensure_ascii=False), flush=True)
        return
    if args.check_login_token_local:
        ctx = load_saved_token()
        print(json.dumps({
            "ok": bool(ctx),
            "loggedIn": bool(ctx),
            "reason": "token_present" if ctx else "no_saved_token",
            "tokenSource": (ctx or {}).get("tokenSource") or "",
        }, ensure_ascii=False), flush=True)
        return
    if args.check_login_token:
        ctx = load_saved_token()
        if not ctx:
            print(json.dumps({"ok": False, "loggedIn": False, "reason": "no_saved_token"}, ensure_ascii=False), flush=True)
            return
        check = validate_suno_token(ctx.get("token") or "", timeout=20)
        result = {
            "ok": bool(check.get("ok")),
            "loggedIn": bool(check.get("ok")),
            "tokenSource": ctx.get("tokenSource") or "saved",
            "href": ctx.get("href") or "",
            "captured_at": ctx.get("captured_at"),
            "tokenCheck": check,
        }
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return
    if args.prepare_suno_token:
        print(json.dumps(prepare_suno_token(args.auth_timeout_sec), ensure_ascii=False), flush=True)
        return
    if args.resume_candidate:
        if not args.source:
            print(json.dumps({"ok": False, "message": "resume candidate requires --source"}, ensure_ascii=False), flush=True)
            return
        print(json.dumps(
            inspect_auth_resume_candidate(Path(args.source).expanduser().resolve(), args.speed),
            ensure_ascii=False,
        ), flush=True)
        return
    if args.source:
        try:
            run_upload(Path(args.source).expanduser().resolve(), args.title, args.speed, args.resume_policy)
        except SunoAuthRequired as exc:
            history_store.add_item({
                "title": args.title or Path(args.source).stem,
                "status": "auth_required",
                "speed": args.speed,
                "audio": args.source,
                "message": str(exc),
            })
            emit("auth_required", message=str(exc))
            os._exit(0)
        except Exception as exc:
            cancelled = is_cancelled_exception(exc)
            history_store.add_item({
                "title": args.title or Path(args.source).stem,
                "status": "cancelled" if cancelled else "failed",
                "speed": args.speed,
                "audio": args.source,
                "message": str(exc),
            })
            # 友好中文日志输出，不打印 traceback，不向上抛异常
            # （PyInstaller console=False 模式下抛异常会触发系统级 unhandled exception 弹窗）
            emit("log", level="error", message=str(exc))
            emit("cancelled" if cancelled else "failed", message=str(exc))
            os._exit(0)
        return
    parser.print_help()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        # 兜底：任何未捕获的异常都转成中文日志事件，绝不让 Python 默认弹窗出现
        try:
            emit("log", level="error", message=f"程序异常：{exc}")
            emit("failed", message=str(exc))
        except Exception:
            pass
        os._exit(0)
