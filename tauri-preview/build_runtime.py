"""Build a platform-specific, self-contained preview runtime (not a sales release)."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / 'tauri-preview'
RUNTIME = PREVIEW / 'src-tauri' / 'runtime'
ffmpeg = Path(os.environ.get('QIYIN_PREVIEW_FFMPEG', ''))
if not ffmpeg.is_file():
    raise SystemExit('Set QIYIN_PREVIEW_FFMPEG to a self-contained FFmpeg binary; see build_ffmpeg_macos.sh')
configuration = subprocess.check_output([str(ffmpeg.resolve()), '-version'], text=True)
if '--enable-nonfree' in configuration:
    raise SystemExit('Refusing to bundle a non-redistributable FFmpeg build')
RUNTIME.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--name', 'qiyin-worker', '--paths', str(ROOT / 'backend'),
    '--distpath', str(RUNTIME), '--workpath', str(PREVIEW / '.build'),
    '--specpath', str(PREVIEW / '.build'), '--collect-all', 'pypinyin',
    '--hidden-import', 'socks', str(PREVIEW / 'worker.py')], check=True)
shutil.copy2(ffmpeg, RUNTIME / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg'))
(RUNTIME / 'ffmpeg-build.txt').write_text(configuration)
(RUNTIME / 'assets').mkdir(exist_ok=True)
shutil.copy2(ROOT / 'assets/studio_blank_state_template.json', RUNTIME / 'assets')
shutil.copytree(ROOT / 'suno-login-extension', RUNTIME / 'suno-login-extension', dirs_exist_ok=True)
(RUNTIME / 'build-info.json').write_text(json.dumps({
    'platform': sys.platform, 'arch': platform.machine(), 'python': platform.python_version(),
    'ffmpegSource': 'Explicit self-contained build; see ffmpeg-build.txt', 'previewOnly': True
}, indent=2))
print('Runtime ready:', RUNTIME)
