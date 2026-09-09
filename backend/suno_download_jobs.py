"""Independent Suno download jobs, local conversion, and no-clobber saving.

Only the native directory chooser may supply ``set_output_directory``. This
module deliberately has no HTTP, upload, account, or licence dependencies.
Progress is a percentage of the current phase; None means indeterminate.
"""

from __future__ import annotations

import math
import os
import re
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Callable


MAX_SOURCE_BYTES = 80 * 1024 * 1024
MAX_DURATION_SECONDS = 12 * 60
MAX_OUTPUT_BYTES = 250 * 1024 * 1024
FFMPEG_TIMEOUT_SECONDS = 180.0
COPY_CHUNK_BYTES = 1024 * 1024
_SAVED_CLEANUP_WARNING = "文件已保存，但下载临时文件未完全清理；已保存的歌曲不受影响。"
_DEMUXERS = {"mp3": "mp3", "wav": "wav", "flac": "flac", "ogg": "ogg",
             "m4a": "mov", "mp4": "mov", "aac": "aac"}
_ERRORS = {
    "BUSY": "正在处理一首歌曲，请完成或取消后再试。",
    "CLOSED": "下载服务已关闭，请重新打开软件。",
    "LICENSE_REQUIRED": "下载组件未就绪，请重新打开软件后重试。",
    "DOWNLOAD_UNAVAILABLE": "下载没有启动，请稍后重试。",
    "INVALID_FORMAT": "请选择 MP3 或 WAV 格式。",
    "INVALID_URL": "请粘贴有效的 Suno 歌曲链接。",
    "UNSUPPORTED_URL": "仅支持 Suno 歌曲链接。",
    "UNSAFE_URL": "该链接无法安全访问，请重新复制 Suno 歌曲链接。",
    "NOT_FOUND": "没有找到这首歌曲，请检查链接是否正确。",
    "UNAVAILABLE": "这首歌曲暂时无法下载，请确认它已公开并已生成完成。",
    "NETWORK_ERROR": "网络连接失败，请稍后重试。",
    "NETWORK_TIMEOUT": "下载超时，请检查网络后重试。",
    "TASK_TIMEOUT": "本次下载等待过久，已停止，请检查网络后重试。",
    "TASK_REQUEST_LIMIT": "本次下载请求次数已达上限，已停止，请稍后重试。",
    "AUDIO_CANDIDATE_LIMIT": "未能在本次检查范围内找到可用音频，请确认歌曲链接后重试。",
    "NETWORK_BUSY": "上一次网络连接仍在结束，请稍后重试；无需反复点击下载。",
    "PROXY_CONFIGURATION_INVALID": "当前代理配置无法用于下载，请检查系统或环境代理设置。",
    "PROXY_UNSUPPORTED": "当前代理类型不受下载支持，请检查系统或环境代理设置。",
    "RATE_LIMITED": "请求过于频繁，请稍后再试。",
    "TIMEOUT": "下载超时，请检查网络后重试。",
    "SOURCE_TOO_LARGE": "歌曲文件超过 80 MB，暂不支持下载。",
    "TOO_LARGE": "歌曲文件超过 80 MB，暂不支持下载。",
    "TOO_LONG": "歌曲超过 12 分钟，暂不支持下载。",
    "INVALID_AUDIO": "未获取到可用的音频，请检查歌曲链接后重试。",
    "FFMPEG_MISSING": "缺少音频处理组件，请重新安装最新版期音科技。",
    "COMPONENT_MISSING": "缺少音频处理组件，请重新安装最新版期音科技。",
    "MP3_ENCODER_MISSING": "缺少 MP3 转换组件，请重新安装最新版期音科技，或先选择 WAV。",
    "CONVERSION_FAILED": "音频转换失败，请重新下载或选择另一种格式。",
    "CONVERSION_TIMEOUT": "音频处理超时，请稍后重试。",
    "OUTPUT_TOO_LARGE": "转换后的文件超过 250 MB，暂不支持保存。",
    "VERIFY_FAILED": "音频校验未通过，请重新下载。",
    "SAVE_FAILED": "文件保存失败，请检查目标文件夹权限和磁盘剩余空间，或改存本机“下载”文件夹。",
    "TEMP_FAILED": "无法创建下载临时文件，请检查磁盘剩余空间。",
    "CLEANUP_FAILED": "下载已停止，但临时文件清理失败，请重新打开软件后重试。",
    "CANCELLED": "已取消下载。",
    "STALE_JOB": "该下载任务已结束，请刷新后再试。",
    "ALREADY_SAVED": "文件已保存，正在完成收尾。",
    "DOWNLOAD_FAILED": "下载失败，请检查歌曲链接后重试。",
}


class _JobError(Exception):
    def __init__(self, code: str):
        self.code = code if code in _ERRORS else "DOWNLOAD_FAILED"
        super().__init__(_ERRORS[self.code])


def _public_error(code) -> str:
    """Translate only recognized codes; never pass arbitrary resolver messages."""
    if not isinstance(code, str):
        return "DOWNLOAD_FAILED"
    if code in _ERRORS:
        return code
    aliases = {
        "INVALID_SUNO_URL": "INVALID_URL", "UNSUPPORTED_SUNO_LINK": "UNSUPPORTED_URL",
        "SONG_ID_MISMATCH": "INVALID_AUDIO", "REQUEST_TIMEOUT": "NETWORK_TIMEOUT",
        "AUDIO_NOT_FOUND": "UNAVAILABLE", "AUDIO_TOO_LONG": "TOO_LONG",
        "AUDIO_TOO_LARGE": "SOURCE_TOO_LARGE", "CRYPTO_UNAVAILABLE": "COMPONENT_MISSING",
    }
    if code in aliases:
        return aliases[code]
    if code in {"AUDIO_CONTAINER_INCOMPLETE", "AUDIO_METADATA_INVALID",
                "AUDIO_CONTAINER_UNSUPPORTED", "DECRYPTED_AUDIO_INVALID"}:
        return "INVALID_AUDIO"
    if code in {"RIGHTS_RESPONSE_INVALID", "RIGHTS_MISSING", "LICENSE_BASE64_INVALID",
                "DOWNLOAD_LICENSE_MISSING", "DOWNLOAD_LICENSE_INVALID", "DOWNLOAD_LICENSE_UNWRAP_FAILED"}:
        return "UNAVAILABLE"
    match = re.fullmatch(r"(PAGE|AUDIO|RIGHTS)_HTTP_(\d{3})", code)
    if match:
        status = int(match[2])
        if status == 429:
            return "RATE_LIMITED"
        if status == 404:
            return "NOT_FOUND"
        if status in {401, 403}:
            return "UNAVAILABLE"
        return "NETWORK_ERROR"
    match = re.fullmatch(r"(PAGE|AUDIO|RIGHTS)_(REDIRECT_NOT_ALLOWED|REDIRECT_POLICY_VIOLATION|"
                         r"URL_NOT_ALLOWED|LENGTH_INVALID|LENGTH_MISMATCH|TOO_LARGE|EMPTY|"
                         r"IDLE_TIMEOUT|CONTENT_ENCODING_INVALID|CONTENT_TYPE_INVALID)", code)
    if match:
        suffix = match[2]
        if suffix == "IDLE_TIMEOUT":
            return "NETWORK_TIMEOUT"
        if suffix in {"REDIRECT_NOT_ALLOWED", "REDIRECT_POLICY_VIOLATION", "URL_NOT_ALLOWED"}:
            return "UNSAFE_URL"
        if suffix == "TOO_LARGE" and match[1] == "AUDIO":
            return "SOURCE_TOO_LARGE"
        return "INVALID_AUDIO"
    return "DOWNLOAD_FAILED"


def _default_downloader(source_url, **kwargs):
    # Both package imports in tests and the desktop's engine sys.path work.
    try:
        from .suno_download import download
    except ImportError:
        from suno_download import download
    return download(source_url, **kwargs)


def download_support_event(code, phase="", http_status=None, *, support_id="", occurred_at="") -> dict:
    """Construct diagnostics exclusively from enums, never resolver text/URLs."""
    code = _public_error(code)
    phases = {"authorizing": "校验软件授权", "starting": "启动下载",
              "resolving": "解析歌曲", "downloading": "下载音频", "converting": "转换音频",
              "encoding": "生成 MP3", "verifying": "校验音频", "saving": "保存文件",
              "cancelling": "取消与清理"}
    phase = phase if isinstance(phase, str) and phase in phases else "resolving"
    http_status = http_status if isinstance(http_status, int) and not isinstance(http_status, bool) and 100 <= http_status <= 599 else None
    category = {401: "authentication_required", 403: "access_denied", 409: "conflict",
                404: "not_found", 429: "rate_limited"}.get(http_status, "http_error" if http_status else "unknown")
    actions = ["检查歌曲链接和网络后重试", "仍失败时复制排障信息给智能客服"]
    if code == "LICENSE_REQUIRED":
        category = "local_authorization_rejected"
        actions = ["检查期音科技安装是否完整后重试", "仍失败时复制排障信息给客服"]
    elif code == "CANCELLED":
        actions = ["需要时重新开始下载"]
    elif http_status == 403:
        actions = ["平台拒绝本次访问，具体原因和恢复时间尚未确认", "确认歌曲可用；不要反复重试"]
    elif http_status == 429 or code == "RATE_LIMITED":
        actions = ["平台暂时限制请求，恢复时间尚未确认，请勿反复重试"]
    elif code in {"SAVE_FAILED", "TEMP_FAILED", "CLEANUP_FAILED"}:
        actions = ["检查目标文件夹权限和磁盘剩余空间", "仍失败时复制排障信息给智能客服"]
    elif code in {"CONVERSION_FAILED", "VERIFY_FAILED", "CONVERSION_TIMEOUT"}:
        actions = ["重新下载或选择另一种格式", "仍失败时复制排障信息给智能客服"]
    elif code in {"PROXY_CONFIGURATION_INVALID", "PROXY_UNSUPPORTED"}:
        actions = ["检查系统或环境代理设置；软件不会自动修改网络配置"]
    elif code == "NETWORK_BUSY":
        actions = ["等待上次网络工作结束后重试，不要反复点击"]
    return {
        "source": "download", "status": "cancelled" if code == "CANCELLED" else "failed",
        "time": occurred_at if isinstance(occurred_at, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", occurred_at) else time.strftime("%Y-%m-%d %H:%M:%S"),
        "supportId": support_id if isinstance(support_id, str) and re.fullmatch(r"DL-\d{8}-[A-F0-9]{6}", support_id) else "DL-" + time.strftime("%m%d%H%M") + "-" + uuid.uuid4().hex[:6].upper(),
        "errorCode": code, "phase": phase, "stage": "Suno 下载 / " + phases[phase],
        "message": _ERRORS[code], "actions": actions,
        "retryable": http_status not in {401, 403} and code not in {"FFMPEG_MISSING", "COMPONENT_MISSING", "MP3_ENCODER_MISSING"},
        "httpStatus": http_status, "httpCategory": category,
        "httpSource": "local_api" if phase in {"authorizing", "starting"} else "remote_download" if http_status else "unknown",
        "resolved": False,
    }


def _safe_title(value) -> str:
    value = unicodedata.normalize("NFKC", value if isinstance(value, str) else "")
    value = "".join(ch for ch in value if unicodedata.category(ch) not in {"Cc", "Cf", "Cs"})
    value = re.sub(r'[<>:"/\\|?*]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    # Leave room for extension, a collision suffix, and common filesystem limits.
    value = value[:80]
    while len(value.encode("utf-8")) > 180:
        value = value[:-1]
    if not value or value.upper().split(".")[0] in {
        "CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        return "Suno歌曲"
    return value


class DownloadManager:
    """Own exactly one job until its subprocess and temporary files are gone."""

    def __init__(self, work_root: Path, output_dir: Path, ffmpeg: Callable[[], Path],
                 downloader: Callable | None = None, event_callback: Callable | None = None):
        self._work_root = Path(work_root).expanduser().absolute()
        self._output_dir = Path(output_dir).expanduser().absolute()
        self._ffmpeg = ffmpeg
        self._downloader = downloader or _default_downloader
        self._event_callback = event_callback
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen | None = None
        self._closed = False
        self._published = False
        self._state = self._empty_state()

    def _empty_state(self) -> dict:
        return {"ok": True, "jobId": "", "status": "idle", "running": False,
                "phase": "idle", "message": "粘贴 Suno 歌曲链接即可下载。",
                "title": "", "format": "mp3", "receivedBytes": 0,
                "totalBytes": None, "progress": None, "indeterminate": True,
                "filename": "", "outputDirectory": str(self._output_dir),
                "errorCode": "", "warningCode": "", "warningMessage": "", "supportId": "", "supportEvent": {}}

    def _record_event(self, code, phase, http_status=None):
        event = download_support_event(code, phase, http_status)
        self._state.update(supportId=event["supportId"], supportEvent=event)
        if self._event_callback:
            try:
                self._event_callback(dict(event))
            except Exception:
                pass  # The safe event remains available in the job snapshot.

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _rejected(self, code: str) -> dict:
        # Do not replace the running job's state with a stale command's error.
        return {**self._state, "ok": False, "errorCode": code, "message": _ERRORS[code]}

    def record_start_failure(self, code: str, *, http_status: int) -> dict:
        """The backend calls this while it still owns the start reservation."""
        with self._lock:
            if self._state["running"]:
                return self._rejected("BUSY")
            code = code if code in {"LICENSE_REQUIRED", "DOWNLOAD_UNAVAILABLE"} else "DOWNLOAD_UNAVAILABLE"
            self._state = {**self._empty_state(), "status": "failed", "phase": "failed",
                           "errorCode": code, "message": _ERRORS[code], "failedBeforeStart": True}
            self._record_event(code, "authorizing" if code == "LICENSE_REQUIRED" else "starting", http_status)
            return {**self._state, "ok": False}

    def start(self, url: str, format: str) -> dict:
        with self._lock:
            if self._closed:
                return self._rejected("CLOSED")
            if self._state["running"]:
                return self._rejected("BUSY")
            if not isinstance(format, str) or format not in {"mp3", "wav", "m4a"}:
                return self._rejected("INVALID_FORMAT")
            job_id = uuid.uuid4().hex
            self._cancel = threading.Event()
            self._published = False
            self._state = {**self._empty_state(), "jobId": job_id, "running": True,
                           "status": "running", "phase": "resolving", "format": format,
                           "message": "正在解析歌曲链接…"}
            self._thread = threading.Thread(target=self._run,
                                            args=(job_id, url, format, self._cancel, self._output_dir),
                                            name=f"suno-download-{job_id[:8]}", daemon=False)
            try:
                self._thread.start()
            except Exception:
                self._state.update(status="failed", running=False, phase="failed",
                                   errorCode="DOWNLOAD_FAILED", message=_ERRORS["DOWNLOAD_FAILED"])
                self._record_event("DOWNLOAD_FAILED", "resolving")
                self._thread = None
                return self._rejected("DOWNLOAD_FAILED")
            return dict(self._state)

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            if not job_id or job_id != self._state["jobId"] or not self._state["running"]:
                return self._rejected("STALE_JOB")
            if self._published:
                return self._rejected("ALREADY_SAVED")
            self._cancel.set()
            self._state.update(phase="cancelling", message="正在取消并清理临时文件…",
                               progress=None, indeterminate=True)
            return dict(self._state)

    def set_output_directory(self, path: Path) -> dict:
        """Only trusted native chooser IPC may provide this path, never webpage input."""
        with self._lock:
            if self._closed:
                return self._rejected("CLOSED")
            if self._state["running"]:
                return self._rejected("BUSY")
            try:
                directory = Path(path).expanduser()
                if not directory.is_absolute() or not directory.is_dir():
                    return self._rejected("SAVE_FAILED")
                self._output_dir = directory
                self._state["outputDirectory"] = str(directory)
                return dict(self._state)
            except (TypeError, ValueError, OSError):
                return self._rejected("SAVE_FAILED")

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            if not self._published:
                self._cancel.set()
            thread = self._thread
        # The downloader contract requires bounded network I/O and cooperation
        # with cancel_event. Joining also covers conversion and final cleanup.
        if thread is not None and thread is not threading.current_thread():
            thread.join()

    @staticmethod
    def _check_cancel(cancel_event: threading.Event) -> None:
        if cancel_event.is_set():
            raise _JobError("CANCELLED")

    def _update(self, job_id: str, **values) -> None:
        with self._lock:
            if self._state["jobId"] == job_id and not self._cancel.is_set():
                self._state.update(values)

    def _run(self, job_id: str, url: str, format: str,
             cancel_event: threading.Event, output_dir: Path) -> None:
        scratch: Path | None = None
        partial: Path | None = None
        saved: Path | None = None
        error_code = ""
        http_status = None

        def on_status(_message):
            # Resolver text is not a user-visible error channel: URLs and raw
            # transport exceptions must never reach the customer or logs.
            self._check_cancel(cancel_event)

        def on_progress(received, total):
            self._check_cancel(cancel_event)
            if isinstance(received, bool) or not isinstance(received, int) or received < 0:
                return
            if received > MAX_SOURCE_BYTES:
                raise _JobError("SOURCE_TOO_LARGE")
            total = total if isinstance(total, int) and not isinstance(total, bool) and total > 0 else None
            if total is not None and total > MAX_SOURCE_BYTES:
                raise _JobError("SOURCE_TOO_LARGE")
            progress = min(99.0, round(received / total * 100, 1)) if total else None
            self._update(job_id, phase="downloading", message="正在下载歌曲…",
                         receivedBytes=received, totalBytes=total,
                         progress=progress, indeterminate=progress is None)

        try:
            self._check_cancel(cancel_event)
            result = self._downloader(url, cancel_event=cancel_event,
                                      on_status=on_status, on_progress=on_progress)
            self._check_cancel(cancel_event)
            if not isinstance(result, dict):
                raise _JobError("INVALID_AUDIO")
            audio = result.get("audio")
            if not isinstance(audio, bytes) or not audio:
                raise _JobError("INVALID_AUDIO")
            if len(audio) > MAX_SOURCE_BYTES:
                raise _JobError("SOURCE_TOO_LARGE")
            container = result.get("container")
            if container not in _DEMUXERS:
                raise _JobError("INVALID_AUDIO")
            info = result.get("media_info") or {}
            duration = info.get("durationSeconds") if isinstance(info, dict) else None
            if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                    or not math.isfinite(duration) or duration <= 0):
                duration = None
            if duration and duration > MAX_DURATION_SECONDS:
                raise _JobError("TOO_LONG")
            title = _safe_title(result.get("title"))
            self._update(job_id, title=title, phase="converting", message="正在转换音频…",
                         receivedBytes=len(audio), progress=None, indeterminate=True)
            try:
                ffmpeg = Path(self._ffmpeg())
                if not ffmpeg.is_file() or (os.name != "nt" and not os.access(ffmpeg, os.X_OK)):
                    raise _JobError("FFMPEG_MISSING")
            except Exception:
                raise _JobError("FFMPEG_MISSING") from None
            try:
                self._work_root.mkdir(parents=True, exist_ok=True)
                scratch = Path(tempfile.mkdtemp(prefix="suno-download-", dir=self._work_root))
                source = scratch / "source.audio"
                with source.open("xb") as stream:
                    stream.write(audio)
                del audio, result
            except OSError:
                raise _JobError("TEMP_FAILED") from None
            if format == "m4a":
                # 原始源：直接保存解密后的原始音频（不转码，最保真，保留 Suno Opus 编码质量）
                original_ext = container if container in _DEMUXERS else "m4a"
                converted = scratch / f"source_original.{original_ext}"
                shutil.copy(source, converted)
                self._update(job_id, phase="converting", message="正在保存原始源…",
                             progress=None, indeterminate=True)
            else:
                pcm = scratch / "converted.wav"
                args = self._input_args(ffmpeg, source, _DEMUXERS[container])
                args += ["-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
                         "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", "-f", "wav",
                         "-n", str(pcm)]
                self._run_ffmpeg(args, cancel_event, job_id, duration, pcm, "CONVERSION_FAILED")
                converted = pcm
                if format == "mp3":
                    converted = scratch / "converted.mp3"
                    self._update(job_id, phase="encoding", message="正在生成 MP3 文件…",
                                 progress=None, indeterminate=True)
                    self._encode_mp3(pcm, converted, cancel_event, job_id)
            self._check_cancel(cancel_event)
            self._update(job_id, phase="verifying", message="正在校验音频完整性…",
                         progress=None, indeterminate=True)
            verify = self._input_args(ffmpeg, converted, _DEMUXERS[container if format == "m4a" else format])
            verify += ["-map", "0:a:0", "-vn", "-sn", "-dn", "-f", "null", "-"]
            decoded_seconds = self._run_ffmpeg(verify, cancel_event, job_id, duration,
                                               converted, "VERIFY_FAILED")
            if decoded_seconds <= 0:
                raise _JobError("VERIFY_FAILED")
            self._check_cancel(cancel_event)
            self._update(job_id, phase="saving", message="正在保存文件…",
                         progress=None, indeterminate=True)
            try:
                output_dir.mkdir(parents=True, exist_ok=True)
                fd, name = tempfile.mkstemp(prefix=".suno-download-", suffix=".partial", dir=output_dir)
                partial = Path(name)
                with os.fdopen(fd, "wb") as target, converted.open("rb") as source_stream:
                    while chunk := source_stream.read(COPY_CHUNK_BYTES):
                        self._check_cancel(cancel_event)
                        target.write(chunk)
                    target.flush()
                    os.fsync(target.fileno())
                saved_extension = original_ext if format == "m4a" else format
                for number in range(1, 10001):
                    filename = f"{title}{'' if number == 1 else f' ({number})'}.{saved_extension}"
                    candidate = output_dir / filename
                    # Commit and cancellation have a single linearization point.
                    with self._lock:
                        self._check_cancel(cancel_event)
                        try:
                            if os.name == "nt":
                                # Windows rename is an atomic no-clobber publish on the
                                # same volume and also works on ExFAT, where hard links do not.
                                os.rename(partial, candidate)
                                partial = None
                            else:
                                os.link(partial, candidate)
                        except FileExistsError:
                            continue
                        saved = candidate
                        self._published = True
                    break
                else:
                    raise _JobError("SAVE_FAILED")
            except OSError:
                raise _JobError("SAVE_FAILED") from None
        except BaseException as exc:
            # Never include str(exc), URLs, FFmpeg stderr, or exception reprs.
            raw_code = getattr(exc, "code", "DOWNLOAD_FAILED")
            error_code = _public_error(raw_code)
            match = re.fullmatch(r"(?:PAGE|AUDIO|RIGHTS)_HTTP_(\d{3})", raw_code) if isinstance(raw_code, str) else None
            http_status = int(match[1]) if match else None
            if cancel_event.is_set() and saved is None:
                error_code = "CANCELLED"
        finally:
            cleanup_failed = False
            if partial is not None:
                cleanup_failed = not self._cleanup_temporary(partial, directory=False)
            if scratch is not None:
                scratch_cleaned = self._cleanup_temporary(scratch, directory=True)
                cleanup_failed = cleanup_failed or not scratch_cleaned
            with self._lock:
                if self._state["jobId"] == job_id:
                    if saved is not None:
                        self._state.update(status="succeeded", phase="done", message="下载完成，文件已保存。",
                                           filename=saved.name, savedPath=str(saved), errorCode="",
                                           warningCode="CLEANUP_FAILED" if cleanup_failed else "",
                                           warningMessage=_SAVED_CLEANUP_WARNING if cleanup_failed else "",
                                           progress=100.0, indeterminate=False)
                        if self._event_callback:
                            try:
                                self._event_callback({"status": "succeeded"})
                            except Exception:
                                pass
                    else:
                        if cleanup_failed:
                            error_code = "CLEANUP_FAILED"
                        error_code = error_code or "DOWNLOAD_FAILED"
                        status = "cancelled" if error_code == "CANCELLED" else "failed"
                        self._record_event(error_code, self._state.get("phase"), http_status)
                        self._state.update(status=status, phase=status, message=_ERRORS[error_code],
                                           errorCode=error_code, progress=None, indeterminate=True)
                    self._state["running"] = False

    @staticmethod
    def _cleanup_temporary(path: Path, *, directory: bool) -> bool:
        # Only the exact mkstemp/mkdtemp paths owned by this job are supplied.
        # Retry once, without scanning siblings or deleting a parent directory.
        for _attempt in range(2):
            try:
                if directory:
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
                return True
            except FileNotFoundError:
                # A missing child can abort rmtree while its root still exists.
                # Only consider the operation complete if our target is gone.
                try:
                    path.lstat()
                except FileNotFoundError:
                    return True
                except OSError:
                    pass
            except OSError:
                pass
        return False

    @staticmethod
    def _input_args(ffmpeg: Path, source: Path, demuxer: str) -> list[str]:
        # Forced, finite audio demuxers reject playlists even if their extension
        # or resolver metadata claims that they are audio. No network protocol
        # is permitted in input files or nested media references.
        return [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
                "-progress", "pipe:1", "-nostats", "-protocol_whitelist", "file,pipe",
                "-format_whitelist", demuxer, "-f", demuxer, "-i", str(source)]

    def _encode_mp3(self, pcm: Path, output: Path, cancel_event: threading.Event, job_id: str) -> None:
        try:
            ffmpeg = Path(self._ffmpeg())
        except Exception:
            raise _JobError("FFMPEG_MISSING") from None
        args = self._input_args(ffmpeg, pcm, "wav")
        args += ["-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
                 "-ac", "2", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "192k",
                 "-f", "mp3", "-n", str(output)]
        self._run_ffmpeg(args, cancel_event, job_id, None, output, "MP3_ENCODER_MISSING")

    @staticmethod
    def _stop_process(process: subprocess.Popen) -> None:
        if process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                process.wait()
        else:
            process.wait()

    def _run_ffmpeg(self, args: list[str], cancel_event: threading.Event, job_id: str,
                    duration: float | None, output: Path, failure_code: str) -> float:
        self._check_cancel(cancel_event)
        process: subprocess.Popen | None = None
        output_queue: queue.Queue[bytes | None] = queue.Queue()
        reader_thread: threading.Thread | None = None
        decoded_seconds = 0.0
        pending = b""
        deadline = time.monotonic() + FFMPEG_TIMEOUT_SECONDS
        try:
            try:
                process_options = {"start_new_session": True}
                if os.name == "nt":
                    process_options = {"creationflags": (
                        getattr(subprocess, "CREATE_NO_WINDOW", 0)
                        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    )}
                process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, **process_options)
            except OSError:
                raise _JobError("FFMPEG_MISSING") from None
            with self._lock:
                self._process = process
            def read_output():
                try:
                    while True:
                        line = process.stdout.readline()
                        if not line:
                            break
                        output_queue.put(line)
                finally:
                    output_queue.put(None)

            reader_thread = threading.Thread(target=read_output, name="ffmpeg-progress", daemon=True)
            reader_thread.start()
            output_closed = False
            while True:
                self._check_cancel(cancel_event)
                if time.monotonic() > deadline:
                    raise _JobError("CONVERSION_TIMEOUT")
                if output.exists() and output.stat().st_size > MAX_OUTPUT_BYTES:
                    raise _JobError("OUTPUT_TOO_LARGE")
                try:
                    chunk = output_queue.get(timeout=0.05)
                except queue.Empty:
                    chunk = b""
                if chunk is None:
                    output_closed = True
                elif chunk:
                    pending += chunk
                    if len(pending) > 65536:
                        raise _JobError(failure_code)
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if line.startswith(b"out_time_us="):
                            try:
                                elapsed = max(0.0, int(line.split(b"=", 1)[1]) / 1_000_000)
                            except ValueError:
                                continue
                            decoded_seconds = max(decoded_seconds, elapsed)
                            # MP3 adds encoder padding; the source-to-PCM pass
                            # enforces the actual duration at one-sample precision.
                            padding = 0.1 if failure_code == "VERIFY_FAILED" and output.suffix == ".mp3" else 1 / 48000
                            if decoded_seconds > MAX_DURATION_SECONDS + padding:
                                raise _JobError("TOO_LONG")
                            if duration:
                                self._update(job_id, progress=min(99.0, round(elapsed / duration * 100, 1)),
                                             indeterminate=False)
                if process.poll() is not None and output_closed:
                    break
            if process.wait() != 0:
                raise _JobError(failure_code)
            if not output.is_file() or not 0 < output.stat().st_size <= MAX_OUTPUT_BYTES:
                raise _JobError("OUTPUT_TOO_LARGE" if output.exists() else failure_code)
            return decoded_seconds
        finally:
            if process is not None:
                try:
                    self._stop_process(process)
                finally:
                    if reader_thread is not None:
                        reader_thread.join(timeout=1)
                    if process.stdout is not None:
                        process.stdout.close()
                    with self._lock:
                        if self._process is process:
                            self._process = None
