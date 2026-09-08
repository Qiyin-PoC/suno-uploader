from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List


APP_NAME = "Suno歌曲上传器"


def data_dir() -> Path:
    base = os.environ.get("GAOBAI_APP_DATA", "").strip()
    if base:
        root = Path(base)
    else:
        root = Path.home() / ".suno-uploader-app"
    root.mkdir(parents=True, exist_ok=True)
    return root


def history_path() -> Path:
    return data_dir() / "upload_history.json"


def load_items() -> List[Dict[str, Any]]:
    path = history_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return [x for x in raw if isinstance(x, dict)]
        if isinstance(raw, dict) and isinstance(raw.get("items"), list):
            return [x for x in raw["items"] if isinstance(x, dict)]
    except Exception:
        return []
    return []


def save_items(items: List[Dict[str, Any]]) -> None:
    path = history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items[:200], ensure_ascii=False, indent=2), encoding="utf-8")


def add_item(item: Dict[str, Any]) -> Dict[str, Any]:
    record = {
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        **item,
    }
    items = [record] + load_items()
    save_items(items)
    return record


def clear() -> None:
    save_items([])
