"""Bundle using Rust's actual host architecture, not the Node process architecture."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / 'tauri-preview'
NATIVE = PREVIEW / 'src-tauri'
if sys.platform != 'darwin':
    raise SystemExit('This first packaging helper supports macOS only.')
host = re.search(r'^host: (.+)$', subprocess.check_output(['rustc', '-vV'], text=True), re.M)[1]
runtime = json.loads((NATIVE / 'runtime/build-info.json').read_text())
arch = {'aarch64': 'arm64', 'x86_64': 'x86_64'}[host.split('-')[0]]
if runtime['arch'] != arch:
    raise SystemExit(f"Runtime {runtime['arch']} does not match Rust target {host}")
subprocess.run(['cargo', 'build', '--release', '--locked', '--manifest-path', str(NATIVE / 'Cargo.toml')], check=True)
# Cargo's native-host build omits the target triple directory. Tauri uses it when
# --target is explicit; stage only the completed binary there to label the DMG correctly.
stage = NATIVE / 'target' / host / 'release'
stage.mkdir(parents=True, exist_ok=True)
binary = NATIVE / 'target/release/qiyin-tauri-preview'
binary_info = subprocess.check_output(['file', str(binary)], text=True)
if arch not in binary_info:
    raise SystemExit('Unexpected compiled binary architecture')
shutil.copy2(binary, stage / binary.name)
node = os.environ.get('QIYIN_NODE', 'node')
subprocess.run([node, str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--target', host, '--bundles', 'app,dmg'], cwd=PREVIEW, check=True)
print('Preview bundle:', stage / 'bundle')
