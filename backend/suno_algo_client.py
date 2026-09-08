from __future__ import annotations

import base64
import gzip
import json
import os
import socket
import struct
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple


class AlgoError(RuntimeError):
    pass


ENVELOPE_STEP_MS = 10
ENVELOPE_RMS_MS = 50
DEFAULT_TIMEOUT = 25
DEFAULT_RETRIES = 1
DEFAULT_ALGO_API_URL = ""


def algo_mode() -> str:
    mode = os.environ.get("GAOBAI_ALGO_MODE", "auto").strip().lower()
    if mode not in {"auto", "remote", "local"}:
        return "auto"
    return mode


def remote_enabled() -> bool:
    return algo_mode() in {"auto", "remote"}


def _api_base() -> str:
    explicit = os.environ.get("GAOBAI_ALGO_API_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    if DEFAULT_ALGO_API_URL:
        return DEFAULT_ALGO_API_URL.rstrip("/")
    raise AlgoError("未配置远端切片算法服务器")


def _license_key() -> str:
    # 内部使用版：不再读取授权码
    return ""


def _machine_id() -> str:
    # 内部使用版：不再读取授权设备ID，回退到主机名
    return socket.gethostname()


def _auth_fields() -> Dict[str, Any]:
    return {
        "license_key": _license_key(),
        "machine_id": _machine_id(),
        "machine_label": socket.gethostname(),
    }


def extract_envelope(values: Sequence[float], rate: int,
                     step_ms: int = ENVELOPE_STEP_MS,
                     rms_ms: int = ENVELOPE_RMS_MS) -> Tuple[List[float], List[float], Dict[str, Any]]:
    n = len(values)
    if n <= 0:
        raise AlgoError("empty audio values")
    step = max(1, int(step_ms / 1000.0 * rate))
    half = max(1, int(rms_ms / 1000.0 * rate) // 2)
    rms_env: List[float] = []
    abs_env: List[float] = []
    for center in range(0, n, step):
        a = max(0, center - half)
        b = min(n, center + half)
        chunk = values[a:b]
        if chunk:
            rms_env.append((sum(float(v) * float(v) for v in chunk) / len(chunk)) ** 0.5)
        else:
            rms_env.append(0.0)
        abs_env.append(abs(float(values[min(center, n - 1)])))
    return rms_env, abs_env, {
        "step_ms": step_ms,
        "rms_ms": rms_ms,
        "rate": int(rate),
        "duration_sec": float(n / rate),
        "num_samples": len(rms_env),
        "envelope_dtype": "f4",
    }


def _encode_float_list(values: Sequence[float]) -> str:
    raw = b"".join(struct.pack("<f", float(v)) for v in values)
    return base64.b64encode(gzip.compress(raw, compresslevel=6)).decode("ascii")


def _post_json(path: str, body: Dict[str, Any],
               timeout: int = DEFAULT_TIMEOUT,
               retries: int = DEFAULT_RETRIES) -> Dict[str, Any]:
    url = _api_base() + path
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    last_error: Optional[BaseException] = None
    for attempt in range(max(1, retries + 1)):
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "QiyinSunoUploader/5.0.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                obj = json.loads(raw) if raw else {}
                if not obj.get("ok"):
                    raise AlgoError(obj.get("message") or "remote algorithm error")
                return obj
        except AlgoError:
            raise
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", "replace")
                obj = json.loads(raw)
                raise AlgoError(obj.get("message") or f"HTTP {exc.code}")
            except AlgoError:
                raise
            except Exception:
                last_error = exc
        except Exception as exc:
            last_error = exc
        if attempt < retries:
            time.sleep(0.6 * (attempt + 1))
    raise AlgoError(f"无法连接远端切片算法服务器：{last_error}")


def remote_split_plan(values: Sequence[float], rate: int,
                      target_sec: float, max_sec: float,
                      search_sec: float, overlap_sec: float) -> Tuple[List[float], Dict[str, Any]]:
    rms_env, abs_env, meta = extract_envelope(values, rate)
    body = {
        **_auth_fields(),
        "rms_b64": _encode_float_list(rms_env),
        "abs_b64": _encode_float_list(abs_env),
        "meta": meta,
        "params": {
            "target_sec": float(target_sec),
            "max_sec": float(max_sec),
            "search_sec": float(search_sec),
            "overlap_sec": float(overlap_sec),
        },
    }
    resp = _post_json("/api/algo/cut", body, timeout=20, retries=1)
    cuts = [float(x) for x in (resp.get("cuts") or [])]
    _validate_cuts(cuts, meta["duration_sec"], max_sec)
    return cuts, resp


def remote_recut(values: Sequence[float], rate: int, overlap_sec: float) -> Dict[str, Any]:
    rms_env, abs_env, meta = extract_envelope(values, rate)
    body = {
        **_auth_fields(),
        "rms_b64": _encode_float_list(rms_env),
        "abs_b64": _encode_float_list(abs_env),
        "meta": meta,
        "params": {"overlap_sec": float(overlap_sec)},
    }
    return _post_json("/api/algo/recut", body, timeout=30)


def remote_can_retry(status_payload: Dict[str, Any], seg_duration_sec: float,
                     min_sec: float, max_depth: int, depth: int) -> Dict[str, Any]:
    body = {
        **_auth_fields(),
        "status_payload": status_payload or {},
        "seg_duration_sec": float(seg_duration_sec),
        "min_sec": float(min_sec),
        "max_depth": int(max_depth),
        "depth": int(depth),
    }
    return _post_json("/api/algo/can_retry", body, timeout=15)


def _validate_cuts(cuts: List[float], duration_sec: float, max_sec: float) -> None:
    if not cuts or len(cuts) < 2:
        raise AlgoError(f"server returned too few cuts: {cuts}")
    if abs(cuts[0]) > 0.001:
        raise AlgoError(f"first cut must be 0.0, got {cuts[0]}")
    if abs(cuts[-1] - duration_sec) > 0.08:
        raise AlgoError(f"last cut must be duration ({duration_sec:.3f}), got {cuts[-1]:.3f}")
    for i in range(1, len(cuts)):
        if cuts[i] <= cuts[i - 1]:
            raise AlgoError(f"cuts not strictly increasing at {i}: {cuts[i-1]} >= {cuts[i]}")
        if cuts[i] - cuts[i - 1] > max_sec + 0.15:
            raise AlgoError(f"segment {i} too long: {cuts[i] - cuts[i-1]:.3f} > {max_sec}")
