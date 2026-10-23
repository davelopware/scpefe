"""Check that executable notices exactly match the maintained build inputs."""
from pathlib import Path
import subprocess
import sys

executable, root, sodium_notice = sys.argv[1:]
root = Path(root)
expected = ("SCPEFE\n=======\n" + (root / "LICENSE").read_text()
            + "\nlibsodium\n=========\n" + Path(sodium_notice).read_text()
            + "\nzxcvbn-c\n========\n"
            + (root / "third_party/zxcvbn-c/LICENSE.txt").read_text()).encode()
result = subprocess.run([executable, "--licenses"], capture_output=True, timeout=10)
assert result.returncode == 0 and result.stderr == b"", result.stderr
assert result.stdout == expected, "embedded notices differ from maintained sources"
result = subprocess.run([executable, "--licenses", "unexpected"], capture_output=True, timeout=10)
assert result.returncode != 0 and not result.stdout
print("Embedded project, libsodium and zxcvbn-c notices match their source files")
