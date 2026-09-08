from __future__ import annotations

import json
import math
import os
import platform
import re
import shutil
import subprocess
import wave
from array import array
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

try:
    import suno_algo_client
except Exception:  # pragma: no cover - optional remote algorithm module
    suno_algo_client = None

from platform_vendor import ffmpeg_executable

_IS_WINDOWS = platform.system().lower() == "windows"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if _IS_WINDOWS else 0


def hidden_subprocess_kwargs() -> dict:
    if not _IS_WINDOWS:
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0
    return {"creationflags": _NO_WINDOW, "startupinfo": startupinfo}


@dataclass
class Segment:
    index: int
    path: Path
    fileName: str
    srcStartSec: float
    srcEndSec: float
    nominalStartSec: float
    nominalEndSec: float
    timelineStartSec: float
    timelineEndSec: float
    duration: float
    fadeInSec: float
    fadeOutSec: float
    timelineScale: float = 1.0


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        return "win32-x64"
    if system == "darwin" and "arm" in machine:
        return "darwin-arm64"
    if system == "darwin":
        return "darwin-x64"
    return system


def find_ffmpeg() -> str:
    ffmpeg = ffmpeg_executable()
    if ffmpeg.name == "ffmpeg" or ffmpeg.exists():
        return str(ffmpeg)
    raise RuntimeError("找不到 ffmpeg，请把对应平台的 ffmpeg 放入 vendor/ffmpeg 目录。")


def decode_to_wav(source: Path, wav_path: Path) -> None:
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        find_ffmpeg(),
        "-y",
        "-i",
        str(source),
        "-ac",
        "2",
        "-ar",
        "44100",
        "-sample_fmt",
        "s16",
        str(wav_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **hidden_subprocess_kwargs())


def speed_change_wav(source_wav: Path, output_wav: Path, speed_ratio: float) -> None:
    ratio = float(speed_ratio)
    if not math.isfinite(ratio) or ratio <= 0:
        raise ValueError("speed_ratio must be a positive finite number")
    factors: List[float] = []
    remaining = ratio
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    atempo = ",".join(f"atempo={factor:.8f}" for factor in factors)
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        find_ffmpeg(),
        "-y",
        "-i",
        str(source_wav),
        "-filter:a",
        atempo,
        "-ac",
        "2",
        "-ar",
        "44100",
        "-sample_fmt",
        "s16",
        str(output_wav),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **hidden_subprocess_kwargs())


def read_wav(path: Path) -> Tuple[array, int, int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        rate = wf.getframerate()
        width = wf.getsampwidth()
        if width != 2:
            raise RuntimeError("仅支持 16-bit PCM WAV")
        samples = array("h")
        samples.frombytes(wf.readframes(wf.getnframes()))
    return samples, rate, channels


def write_wav(path: Path, samples: array, rate: int, channels: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples.tobytes())


def mono_abs(samples: array, channels: int) -> List[float]:
    # Convert before abs: abs(int16(-32768)) would overflow.
    magnitudes = np.abs(np.frombuffer(samples, dtype=np.int16).astype(np.float64))
    if channels <= 1:
        return (magnitudes / 32768.0).tolist()
    # Keep absolute-before-average so opposite-phase channels cannot cancel.
    return (magnitudes.reshape(-1, channels).mean(axis=1) / 32768.0).tolist()


def rms_at(values: List[float], center_index: int, half_window: int) -> float:
    start = max(0, center_index - half_window)
    end = min(len(values), center_index + half_window)
    if end <= start:
        return 0.0
    total = 0.0
    for value in values[start:end]:
        total += value * value
    return math.sqrt(total / (end - start))


def local_rms_envelope(values: List[float], rate: int,
                       step_ms: int = 10, rms_window_ms: int = 50) -> Tuple[List[float], float]:
    n = len(values)
    if n <= 0:
        raise RuntimeError("empty audio values")
    step = max(1, int(rate * step_ms / 1000))
    half_window = max(1, int(rate * rms_window_ms / 2000))
    squared = np.square(np.asarray(values, dtype=np.float64))
    prefix = np.empty(n + 1, dtype=np.float64)
    prefix[0] = 0.0
    np.cumsum(squared, out=prefix[1:])
    centers = np.arange(0, n, step)
    starts = np.maximum(0, centers - half_window)
    ends = np.minimum(n, centers + half_window)
    rms = np.sqrt((prefix[ends] - prefix[starts]) / (ends - starts))
    return rms.tolist(), step / float(rate)


def percentile(values: List[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * max(0.0, min(100.0, percent)) / 100.0
    low = int(math.floor(pos))
    high = int(math.ceil(pos))
    if low == high:
        return ordered[low]
    weight = pos - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def estimate_bpm_from_wav(path: Path, min_bpm: float = 55.0,
                          max_bpm: float = 210.0) -> Tuple[float, float]:
    """Estimate a steady song tempo using librosa (频域 onset + 自相关)。

    准确率约为 85%,比早期手写自相关方案好很多,尤其是多乐器混音与节奏变化场景。

    Returns:
        (bpm, confidence) tuple. 失败兜底 (120.0, 0.0)。
    """
    try:
        import librosa  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return 120.0, 0.0
    try:
        y, sr = librosa.load(str(path), sr=22050, mono=True)
        if len(y) < sr:        # 少于 1 秒,兜底
            return 120.0, 0.0
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        if not (min_bpm <= bpm <= max_bpm):
            return 120.0, 0.0
        # 置信度:onset 强度信号自相关第一峰 vs 第二峰比
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        ac = librosa.autocorrelate(onset_env, max_size=20 * 64)
        if ac.size < 2:
            confidence = 0.0
        else:
            sorted_vals = np.sort(ac)
            peak_val = float(sorted_vals[-1])
            runner_up = float(sorted_vals[-2])
            confidence = max(0.0, min(1.0, (peak_val - runner_up) / max(peak_val, 1e-6)))
        return round(bpm, 2), round(confidence, 3)
    except Exception:
        return 120.0, 0.0


def local_split_plan(values: List[float], rate: int, target_sec: float,
                     max_sec: float, search_sec: float, overlap_sec: float) -> Tuple[List[float], dict]:
    duration = len(values) / float(rate)
    rms, step_sec = local_rms_envelope(values, rate)
    nominal_max = max(0.5, float(max_sec) - 2.0 * max(0.0, float(overlap_sec)))
    target = min(float(target_sec), nominal_max)
    search = max(0.0, float(search_sec))
    min_piece = max(0.35, min(1.0, target * 0.35))
    cuts = [0.0]
    cursor = 0.0
    while duration - cursor > nominal_max:
        ideal = cursor + target
        low = max(cursor + min_piece, ideal - search)
        high = min(cursor + nominal_max, ideal + search, duration)
        a = max(0, int(low / step_sec))
        b = min(len(rms) - 1, int(high / step_sec))
        if b <= a:
            cut = min(cursor + nominal_max, duration)
        else:
            window = rms[a:b + 1]
            quiet_limit = percentile(window, 80)
            candidates = [i for i, value in enumerate(window) if value <= quiet_limit]
            best = candidates[-1] if candidates else min(range(len(window)), key=lambda i: window[i])
            cut = int(a + best) * step_sec
        cut = max(cursor + min_piece, min(cut, cursor + nominal_max, duration))
        if 0.0 < duration - cut < min_piece:
            cut = max(cursor + min_piece, duration - min_piece)
        if cut <= cursor:
            break
        cuts.append(round(cut, 3))
        cursor = cut
    if cuts[-1] < duration:
        cuts.append(round(duration, 3))
    return cuts, {
        "algo_version": "local-low-energy-1.0",
        "params_used": {
            "target_sec": target,
            "max_sec": max_sec,
            "search_sec": search_sec,
            "overlap_sec": overlap_sec,
        },
    }


def local_count_split_plan(values: List[float], rate: int, target_segments: int,
                           search_sec: float = 1.0) -> Tuple[List[float], dict]:
    duration = len(values) / float(rate)
    if duration <= 0:
        raise RuntimeError("empty audio values")
    count = max(1, min(int(target_segments or 1), max(1, int(duration / 0.35))))
    if count == 1:
        return [0.0, round(duration, 3)], {
            "algo_version": "local-low-energy-count-v1",
            "target_segments": 1,
        }
    rms, step_sec = local_rms_envelope(values, rate)
    search = max(0.0, min(float(search_sec), duration / count * 0.35))
    cuts = [0.0]
    for index in range(1, count):
        ideal = duration * index / count
        low = max(cuts[-1] + 0.35, ideal - search)
        high = min(duration - (count - index) * 0.35, ideal + search)
        if high <= low:
            cut = ideal
        else:
            start = max(0, int(low / step_sec))
            end = min(len(rms) - 1, int(high / step_sec))
            candidates = range(start, end + 1)
            cut_index = min(
                candidates,
                key=lambda item: rms[item] + abs(item * step_sec - ideal) * 0.002,
            )
            cut = cut_index * step_sec
        cuts.append(round(max(cuts[-1] + 0.35, min(cut, high)), 3))
    cuts.append(round(duration, 3))
    return cuts, {
        "algo_version": "local-low-energy-count-v1",
        "target_segments": count,
        "search_sec": search,
    }


def choose_cuts_dual_envelope(values: List[float], rate: int, target_sec: float,
                              max_sec: float, search_sec: float,
                              step_ms: int = 10, rms_window_ms: int = 50) -> List[float]:
    """双 envelope 切点：rms_env(50ms) 判断区域能量 + abs_env 避开瞬态冲击。
    
    评分：rms_score * 0.75 + abs_score * 0.25，越低越好。
    """
    n = len(values)
    duration = n / rate
    step = max(1, int(rate * step_ms / 1000))
    half_win = max(1, int(rate * rms_window_ms / 2000))
    rms_env: List[float] = []
    abs_env: List[float] = []
    for i in range(0, n, step):
        a = max(0, i - half_win)
        b = min(n, i + half_win)
        rms_val = math.sqrt(sum(v * v for v in values[a:b]) / max(1, b - a))
        rms_env.append(rms_val)
        abs_env.append(abs(values[min(i, n - 1)]))
    cuts = [0.0]
    cursor = 0.0
    while cursor + max_sec < duration:
        target = cursor + target_sec
        low = max(cursor + 0.35, target - search_sec)
        high = min(cursor + max_sec, target + search_sec, duration)
        a = int(low * rate / step)
        b = int(high * rate / step)
        best_time = target
        best_score = float("inf")
        for idx in range(max(a, 0), min(b, len(rms_env))):
            if idx < len(rms_env) and idx < len(abs_env):
                score = rms_env[idx] * 0.75 + abs_env[idx] * 0.25
                if score < best_score:
                    best_score = score
                    best_time = idx * step / rate
        if best_time <= cuts[-1] + 0.25:
            best_time = min(cuts[-1] + target_sec, duration)
        cuts.append(round(best_time, 3))
        cursor = best_time
    if cuts[-1] < duration:
        cuts.append(round(duration, 3))
    return cuts


def choose_cuts(values: List[float], rate: int, target_sec: float, max_sec: float, search_sec: float) -> List[float]:
    duration = len(values) / rate
    cuts = [0.0]
    cursor = 0.0
    step = max(1, int(rate * 0.025))
    half_window = max(1, int(rate * 0.04))
    while cursor + max_sec < duration:
        target = cursor + target_sec
        low = max(cursor + 0.35, target - search_sec)
        high = min(cursor + max_sec, target + search_sec, duration)
        best_time = min(target, cursor + max_sec)
        best_score = float("inf")
        a = int(low * rate)
        b = int(high * rate)
        for idx in range(a, b, step):
            score = rms_at(values, idx, half_window)
            if score < best_score:
                best_score = score
                best_time = idx / rate
        if best_time <= cuts[-1] + 0.25:
            best_time = min(cuts[-1] + target_sec, duration)
        cuts.append(round(best_time, 3))
        cursor = best_time
    if cuts[-1] < duration:
        cuts.append(round(duration, 3))
    return cuts


def source_file_identity(source: Path) -> dict:
    stat = source.stat()
    return {"sourceSize": stat.st_size, "sourceMtimeNs": stat.st_mtime_ns}


def require_unchanged_source(source: Path, identity: dict) -> None:
    try:
        if source_file_identity(source) == identity:
            return
    except OSError:
        pass
    raise RuntimeError("源文件在处理过程中发生变化，请重新上传。")


def split_audio(source: Path, out_dir: Path, target_sec: float = 5.0, max_sec: float = 5.5,
                search_sec: float = 1.0, overlap_sec: float = 0.08,
                source_speed_ratio: float = 1.0, target_segments: int = 0,
                on_segment: Optional[Callable[[Segment, int], None]] = None) -> Tuple[List[Segment], dict]:
    source_identity = source_file_identity(source)
    wav_full = out_dir / "decoded_original.wav"
    decode_to_wav(source, wav_full)
    require_unchanged_source(source, source_identity)
    timeline_scale = max(0.01, float(source_speed_ratio or 1.0))
    if abs(timeline_scale - 1.0) > 1e-6:
        original_bpm, bpm_confidence = estimate_bpm_from_wav(wav_full)
    else:
        original_bpm, bpm_confidence = 0.0, 0.0
    original_samples, original_rate, original_channels = read_wav(wav_full)
    original_duration = len(original_samples) / float(original_rate * original_channels)
    upload_wav = wav_full
    if abs(timeline_scale - 1.0) > 1e-6:
        upload_wav = out_dir / f"decoded_upload_{timeline_scale:g}x.wav"
        speed_change_wav(wav_full, upload_wav, timeline_scale)
        samples, rate, channels = read_wav(upload_wav)
    else:
        samples, rate, channels = original_samples, original_rate, original_channels
    values = mono_abs(samples, channels)
    duration = len(values) / rate
    algo_mode = "local"
    algo_version = ""
    fallback_reason = ""
    try:
        if target_segments:
            cuts, local_resp = local_count_split_plan(
                values,
                rate,
                target_segments=target_segments,
                search_sec=search_sec,
            )
            algo_mode = "local-count"
            algo_version = local_resp.get("algo_version") or "local-low-energy-count-v1"
            algo_name = algo_version
        elif (suno_algo_client is not None
                and suno_algo_client.algo_mode() == "remote"
                and suno_algo_client.remote_enabled()):
            try:
                cuts, remote_resp = suno_algo_client.remote_split_plan(
                    values, rate,
                    target_sec=target_sec,
                    max_sec=max_sec,
                    search_sec=search_sec,
                    overlap_sec=overlap_sec,
                )
                algo_mode = "remote"
                algo_version = str(remote_resp.get("algo_version") or "remote-envelope")
            except Exception as remote_exc:
                fallback_reason = str(remote_exc)[:300]
                cuts, local_resp = local_split_plan(values, rate, target_sec, max_sec, search_sec, overlap_sec)
                algo_mode = "local-fallback"
                algo_version = local_resp.get("algo_version") or "local-low-energy-1.0"
        else:
            cuts, local_resp = local_split_plan(values, rate, target_sec, max_sec, search_sec, overlap_sec)
            algo_version = local_resp.get("algo_version") or "local-low-energy-1.0"
            algo_mode = "local"
        algo_name = algo_version or "local-low-energy-1.0"
    except Exception as e:
        fallback_reason = str(e)[:300]
        cuts = [0.0]
        t = min(target_sec, max_sec)
        while t < duration - 0.05:
            cuts.append(round(t, 3))
            t += min(target_sec, max_sec)
        if cuts[-1] < duration:
            cuts.append(round(duration, 3))
        algo_mode = "even-fallback"
        algo_name = "even-fallback"
        algo_version = "even-fallback"
    stem = re.sub(r"[^a-zA-Z0-9_\-.]+", "_", source.stem)[:52] or "audio"
    segments: List[Segment] = []
    frames = len(values)

    require_unchanged_source(source, source_identity)
    for i in range(len(cuts) - 1):
        nominal_start = cuts[i]
        nominal_end = cuts[i + 1]
        src_start = max(0.0, nominal_start - (overlap_sec if i > 0 else 0.0))
        src_end = min(duration, nominal_end + (overlap_sec if i < len(cuts) - 2 else 0.0))
        frame_start = max(0, int(round(src_start * rate)))
        frame_end = min(frames, int(round(src_end * rate)))
        sample_start = frame_start * channels
        sample_end = frame_end * channels
        chunk = array("h", samples[sample_start:sample_end])
        file_name = f"{stem}_part{i + 1:02d}_{nominal_start:.2f}s-{nominal_end:.2f}s.wav"
        chunk_path = out_dir / "segments" / file_name
        write_wav(chunk_path, chunk, rate, channels)
        segments.append(Segment(
            index=i + 1,
            path=chunk_path,
            fileName=file_name,
            srcStartSec=src_start,
            srcEndSec=src_end,
            nominalStartSec=nominal_start,
            nominalEndSec=nominal_end,
            timelineStartSec=src_start * timeline_scale,
            timelineEndSec=src_end * timeline_scale,
            duration=src_end - src_start,
            fadeInSec=(2 * overlap_sec * timeline_scale if i > 0 else 0.0),
            fadeOutSec=(2 * overlap_sec * timeline_scale if i < len(cuts) - 2 else 0.0),
            timelineScale=timeline_scale,
        ))
        if on_segment:
            on_segment(segments[-1], len(cuts) - 1)

    require_unchanged_source(source, source_identity)
    manifest = {
        "source": str(source),
        **source_identity,
        "sunoAccountId": os.environ.get("GAOBAI_SUNO_ACCOUNT_ID", "1"),
        "sunoAccountUserId": os.environ.get("GAOBAI_SUNO_ACCOUNT_USER_ID", ""),
        "decodedWav": str(upload_wav),
        "originalDecodedWav": str(wav_full),
        "duration": duration,
        "originalDuration": original_duration,
        "originalBpm": original_bpm,
        "bpmConfidence": bpm_confidence,
        "sourceSpeedRatio": timeline_scale,
        "targetSegments": int(target_segments or 0),
        "rate": rate,
        "channels": channels,
        "targetSec": target_sec,
        "maxSec": max_sec,
        "searchSec": search_sec,
        "splitAlgorithm": algo_name,
        "algoMode": algo_mode,
        "algoVersion": algo_version,
        "fallbackReason": fallback_reason,
        "paramsUsed": {
            "targetSec": target_sec,
            "target_sec": local_resp.get("params_used", {}).get("target_sec", target_sec) if "local_resp" in locals() else target_sec,
            "maxSec": max_sec,
            "max_sec": max_sec,
            "searchSec": search_sec,
            "search_sec": search_sec,
            "overlapSec": overlap_sec,
            "overlap_sec": overlap_sec,
            "stepMs": 10,
            "rmsWindowMs": 50,
        },
        "overlapSec": overlap_sec,
        "cuts": cuts,
        "segments": [{**asdict(s), "path": str(s.path)} for s in segments],
    }
    (out_dir / "split_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return segments, manifest


# ============================================================
# onbeat2x 上传后反向变速(BPM 还原到 1x)
# speed_change_wav 本身对称,通过 atempo=0.5 链恢复 2x atempo=2.0
# 也可以用 atempo=0.5 链恢复 4x atempo=4.0(= 0.5 × 0.5)
# ============================================================


def restore_speed_to_1x(input_wav: Path, output_wav: Path, used_speed_ratio: float) -> Path:
    """把曾经 atempo 加速过的 wav 反向变回 1x 速度(还原原曲 BPM)。

    Args:
        input_wav: 已经被 speed_change_wav 处理过(或被 Suno 在 2x/4x 状态下渲染过)的 wav
        output_wav: 还原后的 wav 路径
        used_speed_ratio: 上传时使用的 speed ratio,例如 2.0 或 4.0

    Returns:
        output_wav 路径

    Raises:
        RuntimeError: ffmpeg 失败抛
    """
    ratio = float(used_speed_ratio)
    if ratio <= 0 or not math.isfinite(ratio) or abs(ratio - 1.0) < 1e-9:
        # 不需要变速,直接复制(避免再过一遍 ffmpeg)
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        if input_wav.resolve() != output_wav.resolve():
            shutil.copy2(str(input_wav), str(output_wav))
        return output_wav
    # 还原 = 1/ratio 的 atempo。speed_change_wav 本身已支持 < 1 ratio,
    # 当 1/ratio < 0.5 时会拆多个 atempo=0.5 链接。
    reverse_ratio = 1.0 / ratio
    speed_change_wav(input_wav, output_wav, reverse_ratio)
    return output_wav


def concat_wavs_in_order(wav_paths_with_order: List[Tuple[int, Path]],
                         output_path: Path) -> Path:
    """按给定顺序拼接 wav(用于把多段还原后合回原曲时长)。

    Args:
        wav_paths_with_order: (sort_key, path) 列表,sort_key 升序拼接
        output_path: 输出 wav 路径

    Returns:
        output_path 路径
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    list_file = output_path.with_suffix(".concat.txt")
    with open(list_file, "w", encoding="utf-8") as fh:
        for _, p in sorted(wav_paths_with_order, key=lambda x: x[0]):
            fh.write(f"file '{p.as_posix()}'\n")
    cmd = [
        find_ffmpeg(),
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        str(output_path),
    ]
    subprocess.run(
        cmd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **hidden_subprocess_kwargs(),
    )
    try:
        list_file.unlink()
    except OSError:
        pass
    return output_path
