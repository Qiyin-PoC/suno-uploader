import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

root = Path(sys.argv[1]).resolve()
ffmpeg = (root / "build" / "macos" / "vendor" / "ffmpeg" / "darwin-arm64" / "ffmpeg"
          if sys.platform == "darwin"
          else root / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe")
sys.path.insert(0, str(root / "backend"))
from suno_download_jobs import DownloadManager  # noqa: E402


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise AssertionError(result.stderr or result.stdout)


with tempfile.TemporaryDirectory(prefix="suno-m4a-fallback-") as temporary:
    temporary = Path(temporary)
    tone = temporary / "tone.wav"
    sample_rate = 8000
    with wave.open(str(tone), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = (struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * index / sample_rate)))
                  for index in range(sample_rate // 4))
        output.writeframes(b"".join(frames))
    fixtures = {
        "mp3": ["-c:a", "libmp3lame", "-f", "mp3"],
        "aac": ["-c:a", "aac", "-f", "adts"],
    }
    for container, encoding in fixtures.items():
        source = temporary / f"source.{container}"
        run([str(ffmpeg), "-v", "error", "-i", str(tone), *encoding, "-y", str(source)])
        output = temporary / f"output-{container}"
        work = temporary / f"work-{container}"

        def downloader(_url, **_kwargs):
            return {
                "audio": source.read_bytes(),
                "container": container,
                "title": f"fallback-{container}",
                "media_info": {"durationSeconds": 0.25},
            }

        manager = DownloadManager(work, output, lambda: ffmpeg, downloader=downloader)
        started = manager.start("https://suno.com/song/e2e-fallback", "m4a")
        if not started.get("running"):
            raise AssertionError(started)
        manager._thread.join(timeout=60)
        if manager._thread.is_alive():
            raise AssertionError(f"{container} 转换线程超时")
        state = manager.snapshot()
        if state.get("status") != "succeeded" or not state.get("filename", "").endswith(".m4a"):
            raise AssertionError(state)
        target = output / state["filename"]
        data = target.read_bytes()
        if b"ftyp" not in data[:64]:
            raise AssertionError(f"{container} 回退结果不是 MP4/M4A 容器")
        run([str(ffmpeg), "-v", "error", "-f", "mov", "-i", str(target),
             "-map", "0:a:0", "-f", "null", "-"])
        manager.shutdown()

print("MP3/AAC 回退均生成可解码的真实 M4A 容器")
