"""Frozen worker entrypoint; no Python installation is needed by the recipient."""
import json
import multiprocessing
import sys
import backend as uploader
import suno_download_cli


def self_test():
    """Exercise packaged imports and FFmpeg against generated audio, without Suno."""
    import math
    import os
    from pathlib import Path
    import struct
    import tempfile
    import wave
    from audio_splitter import split_audio, speed_change_wav
    import lyrics_multilang
    import lyrics_local
    os.environ['GAOBAI_ALGO_MODE'] = 'local'
    with tempfile.TemporaryDirectory(prefix='qiyin-engine-') as temp:
        root = Path(temp)
        source = root / '中文 音频.wav'
        with wave.open(str(source), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000 * 12)))
        segments, _ = split_audio(source, root / 'segments', target_sec=5, max_sec=5.5)
        assert len(segments) >= 3
        for segment in segments:
            with wave.open(str(segment.path), 'rb') as wav:
                assert 0 < wav.getnframes() / wav.getframerate() <= 5.7
        speed_change_wav(source, root / 'fast.wav', 2)
        assert lyrics_local.process('pinyin', '你好世界') == 'ni hao shi jie'
        assert lyrics_multilang.process_multilang('사랑해 한국!', 'korean-roman') == 'saranghae hanguk!'
        print(json.dumps({'ok': True, 'selfTest': 'audio-split-tempo-pinyin-korean', 'segments': len(segments)}), flush=True)

if __name__ == '__main__':
    multiprocessing.freeze_support()
    mode = sys.argv.pop(1) if len(sys.argv) > 1 else ''
    try:
        if mode == 'self-test':
            self_test()
            raise SystemExit(0)
        if mode == 'download':
            raise SystemExit(suno_download_cli.main())
        if mode != 'backend':
            raise ValueError('未知任务')
        uploader.main()
    except Exception:
        # Backend progress already describes failures; never leak raw credentials.
        print(json.dumps({'type': 'failed', 'message': '任务未完成，请检查 Suno 登录、网络及音频文件。'}), flush=True)
        raise SystemExit(1)
