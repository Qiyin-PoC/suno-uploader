#!/usr/bin/env python3
"""Windows native bridge for the independent Suno download module.

The Electron main process owns the output-directory chooser and cancellation file. This
process emits only one-line JSON snapshots; raw URLs, platform responses,
licence values and FFmpeg stderr are never returned to the UI.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
import sys
import time

# Windows embeddable Python uses python311._pth and does not automatically
# add the launched script's directory. Match the established upload entrypoint.
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

_BOOTSTRAP_ERROR = False
try:
    from suno_download import normalize_source_url
    from suno_download_jobs import DownloadManager
except Exception:
    # Report a fixed JSON result even when a bundled component cannot import.
    # Never expose raw import errors, local paths or other exception text.
    _BOOTSTRAP_ERROR = True


POLL_SECONDS = 0.12


def _force_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def _emit(state: dict) -> str:
    wire = json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    print(wire, flush=True)
    return wire


def _failure(code: str, message: str, *, cancelled: bool = False) -> int:
    _emit({"ok": False, "status": "cancelled" if cancelled else "failed",
           "phase": "cancelled" if cancelled else "failed", "running": False,
           "errorCode": code, "message": message, "progress": None,
           "indeterminate": False})
    return 2 if cancelled else 3


def _paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    root = Path(os.environ.get("GAOBAI_PROJECT_ROOT") or Path(__file__).resolve().parents[1]).resolve()
    output = Path(args.output_dir).expanduser().resolve()
    work = Path(args.work_root).expanduser().resolve() if args.work_root else root / "derived" / "suno_download"
    configured = args.ffmpeg or "ffmpeg"
    resolved = shutil.which(configured)
    ffmpeg = Path(resolved or configured).expanduser().resolve()
    cancel = Path(args.cancel_file).expanduser().resolve()
    return output, work, ffmpeg, cancel


def run(args: argparse.Namespace) -> int:
    output, work, ffmpeg, cancel_file = _paths(args)
    manager = DownloadManager(work, output, lambda: ffmpeg)
    last_wire = ""
    try:
        if not output.is_dir():
            state = manager.snapshot()
            state.update(ok=False, status="failed", phase="failed", running=False,
                         errorCode="SAVE_FAILED",
                         message="文件保存失败，请检查目标文件夹权限和磁盘剩余空间，或改存本机“下载”文件夹。")
            _emit(state)
            return 3
        if not normalize_source_url(args.url):
            state = manager.snapshot()
            state.update(ok=False, status="failed", phase="failed", running=False,
                         errorCode="INVALID_URL", message="请粘贴有效的 Suno 歌曲链接。")
            _emit(state)
            return 3
        if cancel_file.is_file():
            return _failure("CANCELLED", "已取消下载。", cancelled=True)
        # Electron main checks the current account entitlement before spawning.
        state = manager.start(args.url.strip(), args.format)
        last_wire = _emit(state)
        job_id = str(state.get("jobId") or "")
        cancel_requested = False
        while state.get("running"):
            if not cancel_requested and cancel_file.is_file():
                cancel_requested = True
                state = manager.cancel(job_id)
            else:
                time.sleep(POLL_SECONDS)
                state = manager.snapshot()
            wire = json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            if wire != last_wire:
                last_wire = _emit(state)
        if json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True) != last_wire:
            _emit(state)
        return 0 if state.get("status") == "succeeded" else 2 if state.get("status") == "cancelled" else 3
    except KeyboardInterrupt:
        state = manager.snapshot()
        if state.get("running"):
            manager.cancel(str(state.get("jobId") or ""))
        return _failure("CANCELLED", "已取消下载。", cancelled=True)
    finally:
        manager.shutdown()
        try:
            cancel_file.unlink(missing_ok=True)
        except OSError:
            pass


class _ArgumentError(Exception):
    pass


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's default error includes the original argument values.
        raise _ArgumentError()


def build_parser() -> argparse.ArgumentParser:
    parser = _SafeArgumentParser(description="期音科技 Windows 下载模块")
    parser.add_argument("--url", required=True)
    parser.add_argument("--format", choices=("mp3", "wav", "m4a"), default="mp3")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--cancel-file", required=True)
    parser.add_argument("--work-root", default="")
    parser.add_argument("--ffmpeg", default="")
    return parser


def main() -> int:
    _force_utf8_stdio()
    if _BOOTSTRAP_ERROR:
        return _failure("DOWNLOAD_COMPONENT_FAILED", "下载组件加载失败，请重新安装最新版期音科技后重试。")
    try:
        return run(build_parser().parse_args())
    except _ArgumentError:
        return _failure("DOWNLOAD_ARGUMENTS_INVALID", "下载参数无效，请重新选择格式和保存文件夹。")
    except SystemExit as exc:
        if exc.code == 0:
            return 0
        return _failure("DOWNLOAD_ARGUMENTS_INVALID", "下载参数无效，请重新选择格式和保存文件夹。")
    except KeyboardInterrupt:
        return _failure("CANCELLED", "已取消下载。", cancelled=True)
    except Exception:
        return _failure("DOWNLOAD_START_FAILED", "下载未能完成，请检查保存文件夹和软件授权后重试。")


if __name__ == "__main__":
    raise SystemExit(main())
