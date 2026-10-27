import sys
import threading
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "backend"))
import suno_download as module  # noqa: E402

song_id = "e6488fe3-4ce2-4b34-ab4a-04b77bf31fe7"
source_url = f"https://suno.com/song/{song_id}"
page = f'<html><head><link rel="canonical" href="{source_url}"><title>线路回退测试 | Suno</title></head></html>'.encode()
original_inspect = module.inspect_audio
module.inspect_audio = lambda _audio: {
    "valid": True,
    "signature": True,
    "container": "mp3",
    "durationSeconds": 1.0,
    "error": "",
}


class FallbackDownloader(module._Downloader):
    def __init__(self, fail_all=False):
        super().__init__()
        self.audio_calls = []
        self.fail_all = fail_all

    def _fetch(self, url, *, kind, **_kwargs):
        if kind == "PAGE":
            return page, source_url
        if kind != "AUDIO":
            raise AssertionError(kind)
        self.audio_calls.append(url)
        if self.fail_all or len(self.audio_calls) == 1:
            raise module.DownloadError("NETWORK_ERROR")
        return b"controlled-audio" * 64, url


try:
    downloader = FallbackDownloader()
    result = downloader.download(source_url, cancel_event=threading.Event())
    if result.get("container") != "mp3" or len(downloader.audio_calls) != 2:
        raise AssertionError({"result": result, "audioCalls": downloader.audio_calls})
    if "cloudfront.net" not in downloader.audio_calls[0] or "cdn1.suno.ai" not in downloader.audio_calls[1]:
        raise AssertionError(downloader.audio_calls)

    failed = FallbackDownloader(fail_all=True)
    try:
        failed.download(source_url, cancel_event=threading.Event())
    except module.DownloadError as exc:
        if exc.code != "NETWORK_ERROR":
            raise AssertionError(exc.code)
    else:
        raise AssertionError("所有音频线路失败时没有保留 NETWORK_ERROR")
finally:
    module.inspect_audio = original_inspect

print("主音频线路网络失败时会切换备用 CDN，全部失败仍保留网络错误")
