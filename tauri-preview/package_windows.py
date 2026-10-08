"""Build and smoke-test the x64 Windows preview on an actual Windows host.

Requires the project dependencies and an explicitly supplied standalone FFmpeg.
This creates a local-account QA build, not a production release.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / 'tauri-preview'
NATIVE = PREVIEW / 'src-tauri'


def main():
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise SystemExit('Run with x64 Python on Windows; Mac checks cannot replace Windows tests.')
    host = subprocess.check_output(['rustc', '-vV'], text=True)
    if 'host: x86_64-pc-windows-msvc' not in host:
        raise SystemExit('Install the x86_64-pc-windows-msvc Rust toolchain.')
    env = os.environ.copy()
    env['QIYIN_LOCAL_PREVIEW'] = '1'
    env['QIYIN_TAURI_LICENSE_URL'] = 'http://127.0.0.1:18870'
    subprocess.run([sys.executable, str(PREVIEW / 'build_runtime.py')], check=True, env=env)
    runtime = NATIVE / 'runtime'
    # Do not let an installed developer Python or FFmpeg hide packaging errors.
    clean = env.copy()
    clean['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32')
    clean.pop('PYTHONHOME', None)
    clean.pop('PYTHONPATH', None)
    clean['GAOBAI_FFMPEG_EXE'] = str(runtime / 'ffmpeg.exe')
    smoke = subprocess.run([str(runtime / 'qiyin-worker/qiyin-worker.exe'), 'self-test'],
                           env=clean, capture_output=True, text=True, timeout=180, check=True)
    results = [json.loads(line) for line in smoke.stdout.splitlines() if line.startswith('{')]
    if not any(item.get('ok') is True and item.get('segments', 0) >= 3 for item in results):
        raise SystemExit('Frozen worker did not report successful audio and lyrics checks.')
    subprocess.run(['cargo', 'test', '--locked', '--manifest-path', str(NATIVE / 'Cargo.toml')],
                   check=True, env=env)
    subprocess.run([os.environ.get('QIYIN_NODE', 'node'),
                    str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js'), 'build',
                    '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis',
                    '--config', str(NATIVE / 'tauri.windows.conf.json')],
                   cwd=PREVIEW, env=env, check=True)
    bundles = list((NATIVE / 'target/x86_64-pc-windows-msvc/release/bundle/nsis').glob('*-setup.exe'))
    if len(bundles) != 1:
        raise SystemExit('Expected exactly one NSIS installer; inspect build output.')
    output = ROOT / 'dist/windows-preview'
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / 'Qiyin-Preview-0.1.0-windows-x64-setup.exe'
    shutil.copy2(bundles[0], artifact)
    report = {'platform': platform.platform(), 'python': platform.python_version(),
              'installer': artifact.name, 'bytes': artifact.stat().st_size,
              'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
              'frozenWorker': results, 'rustTests': 'passed',
              'accountService': 'http://127.0.0.1:18870',
              'installationAndUI': 'NOT TESTED', 'realSunoUpload': 'NOT TESTED'}
    (output / 'build-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
