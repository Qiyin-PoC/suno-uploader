import argparse
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from suno_download_cli import _paths

def test_download_resolves_ffmpeg_command_on_path(tmp_path,monkeypatch):
    exe=tmp_path/'ffmpeg';exe.write_text('test');exe.chmod(0o755)
    monkeypatch.setattr('suno_download_cli.shutil.which',lambda name:str(exe) if name=='ffmpeg' else None)
    args=argparse.Namespace(output_dir=str(tmp_path),work_root=str(tmp_path/'work'),ffmpeg='ffmpeg',cancel_file=str(tmp_path/'cancel'))
    assert _paths(args)[2]==exe.resolve()
