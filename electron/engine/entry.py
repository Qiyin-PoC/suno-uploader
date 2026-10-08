"""macOS/Windows 打包用的统一冻结入口。

Electron 主进程通过第一个位置参数选择任务：

    backend      上传 / 下载 / 歌词 / 历史后端（对应 backend/backend.py）
    download     公开链接下载 CLI（对应 backend/suno_download_cli.py）
    unsupported  未移植到当前平台的组件（第二个参数为组件名），用于给出明确提示

冻结后目标机器不再需要安装 Python，也不需要 python-embed 桥接脚本。

两个模式的消费者不同，事件协议也不同：
  - backend  由 electron/main/main.js 消费，按 type 字段分派事件；
  - download 由 electron/main/suno-download.js 消费，其 acceptLine() 只接受带
    status ∈ {running,succeeded,failed,cancelled} 的行。

因此失败事件同时带上 type 与 status，否则 download 场景会把它静默丢弃，
用户只会看到通用的「下载组件意外退出」。
"""
from __future__ import annotations

import json
import multiprocessing
import sys


def _emit(payload: dict) -> None:
    """按 NDJSON 输出一个事件；输出失败不再向上抛，避免掩盖真实原因。"""
    try:
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        pass


def _fail(message: str, mode: str = "") -> int:
    """输出同时满足两种协议的失败事件，并在 stderr 留一份可读文案。

    部分调用方（如音频编辑器的预览/导出）把 stderr 直接当作展示给用户的信息，
    所以这里必须写 stderr，否则用户只能看到「组件意外退出」。
    """
    event = {
        "type": "failed",
        "status": "failed",
        "phase": "failed",
        "ok": False,
        "running": False,
        "message": message,
    }
    if mode == "download":
        event["errorCode"] = "DOWNLOAD_START_FAILED"
    _emit(event)
    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:
        pass
    return 1


def run() -> int:
    multiprocessing.freeze_support()
    mode = sys.argv.pop(1) if len(sys.argv) > 1 else ""

    if mode == "backend":
        import backend
        backend.main()
        return 0
    if mode == "download":
        import suno_download_cli
        return suno_download_cli.main()
    if mode == "unsupported":
        # 该组件没有冻进引擎（音频编辑器 / 人声分离 / 各类解锁器）。
        # 明确说明平台不支持，而不是让参数流到 backend 的 argparse 里报英文 usage。
        name = sys.argv[1] if len(sys.argv) > 1 else "该功能"
        return _fail(f"{name} 暂不支持当前平台（macOS）。")
    return _fail("未知任务模式")


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except SystemExit:
        raise
    except Exception as exc:
        # 注意：backend.py 的兜底写在它自己的 __main__ 分支里，
        # 被 import 调用时不会生效，所以这里是组件级失败的最后一道保护。
        # 透出真实异常，与 Windows 版的「程序异常：<原因>」保持一致，
        # 避免把组件加载失败误报成账号或网络问题。
        mode = next((a for a in sys.argv[1:] if not a.startswith("-")), "")
        raise SystemExit(_fail(f"组件异常：{exc}", mode))
