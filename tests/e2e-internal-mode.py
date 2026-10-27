import json
import os
import tempfile
import time
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP_URL = os.environ.get("E2E_CDP_URL", "http://127.0.0.1:9337")
MARKERS = Path(os.environ["GAOBAI_E2E_MARKER_DIR"])
OUTPUT = Path(__file__).parent / "artifacts"
OUTPUT.mkdir(exist_ok=True)

fd, audio_name = tempfile.mkstemp(prefix="suno-e2e-", suffix=".wav")
os.close(fd)
audio_path = Path(audio_name)
with wave.open(str(audio_path), "wb") as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(8000)
    audio.writeframes(b"\x00\x00" * 8000)


def wait_for_file(path: Path, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
        time.sleep(0.1)
    raise AssertionError(f"受控 worker 没有写入启动标记：{path}")


try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        pages = [page for context in browser.contexts for page in context.pages if page.url.startswith("file:")]
        if not pages:
            raise AssertionError("未找到 Electron 页面")
        page = pages[0]
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        upload = page.evaluate("""async ({audioPath}) => window.gaobai.startUpload({
          audioPath, title: 'e2e-temp-audio', speed: 'fast', accountId: '1'
        })""", {"audioPath": str(audio_path)})
        if not upload.get("ok"):
            raise AssertionError(f"真实临时音频未启动内部上传 worker：{upload}")
        upload_args = wait_for_file(MARKERS / "upload-source.json")
        if "--source" not in upload_args or "--resume-policy" not in upload_args or str(audio_path) not in upload_args:
            raise AssertionError(f"上传 worker 参数异常：{upload_args}")

        batch = page.evaluate("async () => window.gaobai.startUploadBatch({items: []})")
        if batch.get("needActivate") or "官网账号" in str(batch.get("message", "")):
            raise AssertionError(f"批量上传仍要求官网账号：{batch}")

        lyrics = page.evaluate("async () => window.gaobai.processLyrics({mode: 'pinyin', text: '你好'})")
        if not lyrics.get("ok"):
            raise AssertionError(f"歌词处理未进入内部后端：{lyrics}")

        valid_url = "https://suno.com/song/12345678-1234-1234-1234-123456789abc"
        download = page.evaluate("async ({url}) => window.gaobai.startSunoDownload({url, format: 'm4a'})", {"url": valid_url})
        if not download.get("ok"):
            raise AssertionError(f"有效 URL + m4a 未启动下载 worker：{download}")
        download_args = wait_for_file(MARKERS / "download-worker.json")
        if "--url" not in download_args or "--format" not in download_args or "m4a" not in download_args:
            raise AssertionError(f"下载 worker 参数异常：{download_args}")
        deadline = time.time() + 10
        state = download
        while state.get("running") and time.time() < deadline:
            time.sleep(0.1)
            state = page.evaluate("async () => window.gaobai.getSunoDownloadState()")
        if state.get("status") != "succeeded":
            raise AssertionError(f"受控下载 worker 没有成功结束：{state}")

        page.screenshot(path=str(OUTPUT / "internal-no-website-auth.png"), full_page=True)
        print({"upload": upload, "uploadWorker": upload_args, "batch": batch,
               "lyricsOk": lyrics.get("ok"), "download": state, "downloadWorker": download_args})
        browser.close()
finally:
    audio_path.unlink(missing_ok=True)
