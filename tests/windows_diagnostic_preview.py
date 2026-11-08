"""Validate the single-file Windows distribution, independent of shared fixtures."""
import argparse
from contextlib import AbstractContextManager
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import threading

from container_diagnostic_test import PASSWORD, safe_error, vector

SYSTEM_DLLS = {"kernel32.dll", "advapi32.dll", "bcrypt.dll", "crypt32.dll",
               "ws2_32.dll", "user32.dll", "shell32.dll", "ole32.dll", "ntdll.dll"}
EXE_NAME = "scpefe-diagnostic.exe"
MANIFEST_NAME = "preview-manifest.json"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def check_imports(output):
    """Fail closed for unparsed imports, app DLLs and installed runtime DLLs."""
    imports = sorted(set(re.findall(r"^\s*([\w.-]+\.dll)\s*$", output, re.M | re.I)))
    if not imports:
        raise ValueError("No import-table evidence found")
    for dependency in imports:
        name = dependency.lower()
        if name not in SYSTEM_DLLS and not name.startswith("api-ms-win-core-"):
            raise ValueError("Non-system dependency: " + dependency)
    return imports


def verify_download(directory, expected_commit, validated_manifest=None):
    """Bind the downloaded bytes to the validated executable and exact commit."""
    directory = Path(directory)
    manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8-sig"))
    if manifest["source_commit"] != expected_commit:
        raise ValueError("Downloaded preview has the wrong source commit")
    if (manifest["validation"]["result"] != "passed" or manifest["unsigned"] is not True
            or manifest["platform"] != "win-x64" or manifest["executable"] != EXE_NAME):
        raise ValueError("Downloaded preview lacks successful unsigned x64 validation")
    actual = sha256(directory / EXE_NAME)
    if validated_manifest:
        validated = json.loads(Path(validated_manifest).read_text(encoding="utf-8-sig"))
        if (validated["sha256"] != actual or validated["source_commit"] != expected_commit
                or validated["validation"]["result"] != "passed"):
            raise ValueError("Downloaded EXE differs from original validation evidence")
    if manifest["sha256"] != actual:
        raise ValueError("Downloaded EXE differs from the validated EXE")
    if (directory / (EXE_NAME + ".sha256")).read_text().strip() != actual + "  " + EXE_NAME:
        raise ValueError("Downloaded checksum differs from the validated EXE")
    if any(path.suffix.lower() == ".dll" for path in directory.rglob("*")):
        raise ValueError("Unexpected DLL in single-EXE distribution")
    return actual


class TempDllWatcher(AbstractContextManager):
    """Record Windows directory events, including DLLs deleted before exit."""
    def __init__(self, directory):
        self.directory = directory
        self.names = []
        self.errors = []
        self.ready = threading.Event()

    def __enter__(self):
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()
        if not self.ready.wait(10):
            raise RuntimeError("Temporary-directory watcher did not start")
        if self.errors:
            raise RuntimeError(self.errors[0])
        return self

    def _watch(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
            wintypes.DWORD, wintypes.BOOL, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p, ctypes.c_void_p]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        # A synchronous notification reader continuously drains events. A handshake
        # file proves the first read is armed before any diagnostic is started.
        handle = kernel.CreateFileW(str(self.directory), 1, 7, None, 3, 0x02000000, None)
        if handle == wintypes.HANDLE(-1).value:
            self.errors.append("Cannot watch isolated temporary directory")
            self.ready.set()
            return
        try:
            buffer = ctypes.create_string_buffer(65536)
            count = wintypes.DWORD()
            while True:
                if not kernel.ReadDirectoryChangesW(handle, buffer, len(buffer), True,
                                                     1, ctypes.byref(count), None, None):
                    self.errors.append("Temporary-directory observation failed")
                    self.ready.set()
                    return
                if count.value == 0:
                    self.errors.append("Temporary-directory event buffer overflow")
                    self.ready.set()
                    return
                offset = 0
                stop = False
                while True:
                    following, action, length = struct.unpack_from("<III", buffer, offset)
                    name = buffer.raw[offset + 12:offset + 12 + length].decode("utf-16-le")
                    if name == ".watcher-ready":
                        self.ready.set()
                    elif name == ".watcher-stop":
                        stop = True
                    else:
                        self.names.append(name)
                    if not following:
                        break
                    offset += following
                if stop:
                    return
        finally:
            kernel.CloseHandle(handle)

    def __exit__(self, exc_type, exc_value, traceback):
        (self.directory / ".watcher-stop").touch()
        self.thread.join(10)
        if self.thread.is_alive():
            raise RuntimeError("Temporary-directory watcher did not finish")
        if self.errors:
            raise RuntimeError(self.errors[0])
        if any(name.lower().endswith(".dll") for name in self.names):
            raise ValueError("Temporary DLL extraction detected")


def watch_temp(directory):
    """Arm the native watcher through observed events, avoiding startup races."""
    watcher = TempDllWatcher(directory)
    # Keep touching until the watcher observes the filename creation/deletion.
    # The watcher accepts no diagnostic processes before this handshake succeeds.
    def handshake():
        marker = directory / ".watcher-ready"
        for _ in range(100):
            if watcher.ready.wait(.05):
                return
            marker.touch()
            marker.unlink(missing_ok=True)
    threading.Thread(target=handshake, daemon=True).start()
    return watcher


def run_checked(arguments, **kwargs):
    result = subprocess.run(arguments, capture_output=True, timeout=90, **kwargs)
    if result.returncode:
        raise RuntimeError(f"Validation command failed: {arguments[0]}: {result.stderr!r}")
    return result


def validate(executable, repository, sodium_notice, dumpbin, source_commit, output):
    if os.name != "nt":
        raise RuntimeError("Single-EXE runtime validation requires Windows")
    executable, repository = Path(executable).resolve(), Path(repository).resolve()
    original_hash = sha256(executable)
    imports = check_imports(run_checked([dumpbin, "/DEPENDENTS", str(executable)]).stdout.decode())
    # All three locations are outside the checkout, build and dependency outputs.
    with tempfile.TemporaryDirectory(prefix="scpefe-single-exe-") as directory:
        isolated = Path(directory).resolve()
        dependency_root = Path(sodium_notice).resolve().parents[3]
        if isolated.is_relative_to(repository) or isolated.is_relative_to(dependency_root):
            raise ValueError("Runtime isolation must be outside checkout and dependency outputs")
        runtime, working, temporary, inputs = [isolated / name for name in
                                               ("runtime", "working", "temp", "inputs")]
        for path in (runtime, working, temporary, inputs):
            path.mkdir()
        target = runtime / EXE_NAME
        shutil.copyfile(executable, target)
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC"}}
        environment.update(PATH=os.pathsep.join([str(Path(os.environ["SystemRoot"]) / "System32"),
                                                 os.environ["SystemRoot"]]),
                           TEMP=str(temporary), TMP=str(temporary))
        expected_notices = ("SCPEFE\n=======\n" + (repository / "LICENSE").read_text()
            + "\nlibsodium\n=========\n" + Path(sodium_notice).read_text()
            + "\nzxcvbn-c\n========\n" + (repository / "third_party/zxcvbn-c/LICENSE.txt").read_text()).encode()
        with watch_temp(isolated):
            def invoke(*arguments, password=None):
                return run_checked([str(target), *map(str, arguments)], input=password,
                                   cwd=working, env=environment)
            for command in ("health", "version"):
                result = invoke(command)
                report = json.loads(result.stdout)
                assert report["abi_version"] == 2 and result.stderr == b""
                assert result.stdout == json.dumps(report, indent=2).encode() + b"\n"
                assert invoke(command).stdout == result.stdout
                if command == "health":
                    assert report["status"] == "ok" and report["host_monotonic_time_ms"] == 424242
            result = invoke("licenses")
            assert result.stdout == expected_notices and result.stderr == b""
            path = inputs / "snapshot.cbor"
            path.write_bytes(vector(repository, "../draft-v1/valid/snapshot-revision"))
            before = sha256(path)
            report = json.loads(invoke("revision", path).stdout)
            assert report["slot_identity_name"] == "Ada Lovelace" and "content" not in report["snapshot"]
            report = json.loads(invoke("revision", path, "--include-content").stdout)
            assert report["snapshot"]["content"] == "first line\nsecond line" and sha256(path) == before
            path = inputs / "document.scpefe"
            for name in ("baseline", "pruned-checkpoint", "foreign-merge", "provisional", "multi-slot"):
                path.write_bytes(vector(repository, "valid/" + name + "-container"))
                before = sha256(path)
                expected = json.loads((repository / "tests/vectors/diagnostic" / (name + ".json")).read_text())
                result = invoke("inspect", path, "--password-stdin", password=PASSWORD + b"\n")
                assert result.stdout == json.dumps(expected, ensure_ascii=False, indent=2).encode() + b"\n"
                assert result.stderr == b"" and b'"content":' not in result.stdout
                included = invoke("inspect", path, "--password-stdin", "--include-content", password=PASSWORD + b"\n")
                for revision in json.loads(included.stdout)["revision_graph"]["revisions"]:
                    present = revision["kind"] != 2 and not revision["foreign"] and revision["text_available"]
                    assert ("content" in revision) == present
                    if present:
                        assert revision["content"].startswith("alpha\n")
                for emitted in (result.stdout, included.stdout):
                    assert PASSWORD not in emitted and bytes(range(32, 64)).hex().encode() not in emitted
                    assert b"wrapped_key" not in emitted and b"work_journal_key" not in emitted
                assert included.stderr == b"" and sha256(path) == before
            for data, password, code in ((vector(repository, "valid/baseline-container"), b"wrong password\n", 10),
                                         (b"malformed container", PASSWORD + b"\n", 9)):
                path.write_bytes(data)
                before = sha256(path)
                result = subprocess.run([str(target), "inspect", str(path), "--password-stdin"],
                                        input=password, capture_output=True, timeout=15, cwd=working, env=environment)
                safe_error(result, code)
                assert password.strip() not in result.stderr and sha256(path) == before
        assert sorted(p.name for p in runtime.iterdir()) == [EXE_NAME]
        assert not list(working.iterdir()), "Diagnostic created working-directory files"
        assert not list(temporary.rglob("*.dll")), "Temporary DLL remained"
        assert sha256(target) == original_hash and sha256(executable) == original_hash
    manifest = {"tool": "scpefe-diagnostic", "executable": EXE_NAME,
                "source_commit": source_commit, "platform": "win-x64", "configuration": "Release",
                "unsigned": True, "sha256": original_hash,
                "validation": {"result": "passed", "system_imports": imports,
                               "runtime": "EXE only; system PATH; empty working directory; isolated TEMP/TMP",
                               "temporary_dll_extraction": "none (Windows directory events observed)",
                               "checks": ["health", "version", "revision", "licenses", "authenticated golden JSON",
                                          "unchanged inputs", "content omission and opt-in", "safe errors", "secret omission"]}}
    Path(output).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Single-EXE Windows runtime validation passed; SHA-256: " + original_hash)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-download", type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--validated-manifest", type=Path)
    parser.add_argument("--executable")
    parser.add_argument("--repository")
    parser.add_argument("--sodium-notice")
    parser.add_argument("--dumpbin")
    parser.add_argument("--manifest")
    args = parser.parse_args()
    if args.verify_download:
        print("Downloaded EXE matches validated SHA-256: " + verify_download(args.verify_download, args.source_commit, args.validated_manifest))
    else:
        validate(args.executable, args.repository, args.sodium_notice, args.dumpbin, args.source_commit, args.manifest)


if __name__ == "__main__":
    main()
