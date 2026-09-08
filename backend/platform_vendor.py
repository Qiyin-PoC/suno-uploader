from __future__ import annotations

import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Iterable


def project_root() -> Path:
    env_root = os.environ.get("GAOBAI_PROJECT_ROOT", "").strip()
    if env_root:
        return Path(env_root).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parents[1]
    return Path(__file__).resolve().parent.parent


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} or "arm" in machine else "x64"
    if system == "windows":
        return f"win32-{arch}"
    if system == "darwin":
        return f"darwin-{arch}"
    if system == "linux":
        return f"linux-{arch}"
    return f"{sys.platform}-{arch}"


def executable_names(base_name: str) -> list[str]:
    if sys.platform == "win32":
        return [f"{base_name}.exe", base_name]
    return [base_name, f"{base_name}.exe"]


def vendor_executable(
    tool_name: str,
    base_names: str | Iterable[str],
    *,
    env_path: str | None = None,
    env_vendor: str | None = None,
    allow_path: bool = True,
) -> Path | None:
    explicit = os.environ.get(env_path or "", "").strip() if env_path else ""
    if explicit:
        path = Path(explicit).expanduser()
        if path.exists():
            return path

    names: list[str] = []
    raw_names = [base_names] if isinstance(base_names, str) else list(base_names)
    for raw in raw_names:
        for name in executable_names(raw):
            if name not in names:
                names.append(name)

    roots: list[Path] = []
    vendor_override = os.environ.get(env_vendor or "", "").strip() if env_vendor else ""
    if vendor_override:
        roots.append(Path(vendor_override).expanduser())
    root = project_root()
    roots.extend([
        root / "vendor" / tool_name,
        Path(__file__).resolve().parent.parent / "vendor" / tool_name,
    ])

    key = platform_key()
    for base in roots:
        for name in names:
            for candidate in (base / key / name, base / name):
                if candidate.exists():
                    return candidate

    if allow_path:
        for name in names:
            found = shutil.which(name)
            if found:
                return Path(found)
    return None


def ffmpeg_executable() -> Path:
    found = vendor_executable(
        "ffmpeg",
        "ffmpeg",
        env_path="GAOBAI_FFMPEG_EXE",
        env_vendor="GAOBAI_FFMPEG_VENDOR",
    )
    if found:
        return found
    return Path("ffmpeg")


def kgg_decryptor() -> Path | None:
    return vendor_executable(
        "kgg",
        ["kgg-dec", "kgg_dec"],
        env_path="GAOBAI_KGG_DEC",
        env_vendor="GAOBAI_KGG_VENDOR",
        allow_path=False,
    )
