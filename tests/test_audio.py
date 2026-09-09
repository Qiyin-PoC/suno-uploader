import math
import os
import shutil
import struct
import sys
import wave
from pathlib import Path

import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from audio_splitter import split_audio, source_file_identity, require_unchanged_source


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='ffmpeg unavailable')
def test_real_audio_split_and_source_mutation(tmp_path,monkeypatch):
    monkeypatch.setenv('GAOBAI_ALGO_MODE','local')
    source=tmp_path/'中文 空格音频.wav'
    rate=16000
    with wave.open(str(source),'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(b''.join(struct.pack('<h',int(5000*math.sin(2*math.pi*440*i/rate))) for i in range(rate*12)))
    identity=source_file_identity(source)
    segments,metadata=split_audio(source,tmp_path/'segments',target_sec=5,max_sec=5.5)
    assert len(segments)>=3
    for segment in segments:
        assert Path(segment.path).exists()
        with wave.open(str(segment.path),'rb') as wav:
            assert 0 < wav.getnframes()/wav.getframerate() <= 5.7
    assert source_file_identity(source)==identity
    source.write_bytes(b'changed')
    with pytest.raises(RuntimeError): require_unchanged_source(source,identity)
