"""Launch installed browsers natively even when the worker runs under Rosetta."""
import struct
import subprocess
import sys


def supports_arm64(path):
    # Read the Mach-O header without requiring Xcode command-line tools.
    try:
        with open(path, 'rb') as binary:
            header = binary.read(8)
            if len(header) != 8:
                return False
            magic, count = struct.unpack('>II', header)
            if magic in (0xCAFEBABE, 0xCAFEBABF):
                if count > 64:
                    return False
                entry_size = 20 if magic == 0xCAFEBABE else 32
                for _ in range(count):
                    entry = binary.read(entry_size)
                    if len(entry) != entry_size:
                        return False
                    if struct.unpack('>I', entry[:4])[0] == 0x0100000C:
                        return True
            elif magic == 0xCFFAEDFE:
                return struct.unpack('<I', header[4:])[0] == 0x0100000C
    except OSError:
        pass
    return False


def browser_executable_command(browser):
    command = [str(browser)]
    if sys.platform != 'darwin':
        return command
    try:
        arm_mac = subprocess.check_output(
            ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'],
            text=True, stderr=subprocess.DEVNULL, timeout=3,
        ).strip() == '1'
        if arm_mac and supports_arm64(browser):
            return ['/usr/bin/arch', '-arm64', *command]
    except (OSError, subprocess.SubprocessError):
        pass
    return command
