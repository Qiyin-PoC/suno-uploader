import struct
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from browser_launch import browser_executable_command, supports_arm64


def test_universal_browser_launches_natively_from_translated_worker(tmp_path):
    binary = tmp_path / 'Chrome'
    binary.write_bytes(struct.pack('>II', 0xCAFEBABE, 2) +
                      struct.pack('>IIIII', 0x01000007, 3, 48, 100, 0) +
                      struct.pack('>IIIII', 0x0100000C, 0, 148, 100, 0))
    with patch('browser_launch.sys.platform', 'darwin'), patch(
        'browser_launch.subprocess.check_output', return_value='1\n'
    ):
        assert browser_executable_command(binary) == ['/usr/bin/arch', '-arm64', str(binary)]
    with patch('browser_launch.sys.platform', 'darwin'), patch(
        'browser_launch.subprocess.check_output', return_value='0\n'
    ):
        assert browser_executable_command(binary) == [str(binary)]


def test_intel_only_and_non_mac_are_preserved(tmp_path):
    binary = tmp_path / 'browser'
    binary.write_bytes(struct.pack('<II', 0xFEEDFACF, 0x01000007))
    with patch('browser_launch.sys.platform', 'darwin'), patch(
        'browser_launch.subprocess.check_output', return_value='1\n'
    ):
        assert browser_executable_command(binary) == [str(binary)]
    with patch('browser_launch.sys.platform', 'win32'), patch(
        'browser_launch.subprocess.check_output', side_effect=AssertionError('must not run')
    ):
        assert browser_executable_command(binary) == [str(binary)]


def test_thin_arm_and_invalid_headers(tmp_path):
    binary = tmp_path / 'browser'
    binary.write_bytes(struct.pack('<II', 0xFEEDFACF, 0x0100000C))
    assert supports_arm64(binary)
    for data in (b'', b'bad', struct.pack('>II', 0xCAFEBABE, 200), struct.pack('>II', 0xCAFEBABE, 1)):
        binary.write_bytes(data)
        assert not supports_arm64(binary)
