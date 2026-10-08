"""Build a separately identified, account-free Mac experience edition."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
config = root / 'src-tauri/tauri.experience.conf.json'
env = os.environ.copy()
env['QIYIN_FREE_EXPERIENCE'] = '1'
env['QIYIN_LOCAL_PREVIEW'] = '0'
env['QIYIN_TAURI_LICENSE_URL'] = ''
env['QIYIN_TAURI_BUNDLE_CONFIG'] = str(config)
env['TAURI_CONFIG'] = json.dumps(json.loads(config.read_text()))
subprocess.run([sys.executable, str(root / 'package_macos.py')], env=env, check=True)
