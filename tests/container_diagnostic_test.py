"""Exercise authenticated diagnostics through the executable and public C ABI."""
import ctypes as c
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PASSWORD = b"correct horse battery staple"
MAX_CONTAINER = 33 * 1024 * 1024


class Limits(c.Structure):
    _fields_ = [("struct_size", c.c_uint32)] + [
        (name, c.c_size_t) for name in ("max_input_bytes", "max_nesting_depth",
            "max_collection_entries", "max_text_bytes", "max_byte_string_bytes",
            "max_parent_count")]


class Request(c.Structure):
    _fields_ = [("struct_size", c.c_uint32), ("abi_version", c.c_uint32),
        ("bytes", c.c_void_p), ("bytes_size", c.c_size_t),
        ("password", c.c_void_p), ("password_size", c.c_size_t),
        ("limits", c.POINTER(Limits)), ("include_content", c.c_int)]


def vector(root, name):
    lines = (root / "tests/vectors/draft-v3" / (name + ".hex")).read_text().splitlines()
    return bytes.fromhex("".join(line.split("#")[0] for line in lines))


def cli(executable, path, password=PASSWORD + b"\n", flags=(), stdin=True):
    args = [executable, "inspect", str(path), *flags]
    if stdin:
        args.append("--password-stdin")
    result = subprocess.run(args, input=password, capture_output=True, timeout=15,
                            start_new_session=os.name == "posix")
    assert PASSWORD not in result.stdout + result.stderr
    if password.strip():
        assert password.strip() not in result.stdout + result.stderr
    return result


def safe_error(result, code):
    assert result.returncode != 0
    assert result.stdout == b"", result.stdout[:200]
    assert json.loads(result.stderr) == {"status": "error", "code": code}, result.stderr


def api(library, data, password=PASSWORD, include=False, limit=None, change=None,
        error=None):
    """Only public ABI calls: errors must preserve every byte of caller storage."""
    limits = Limits(struct_size=c.sizeof(Limits))
    assert library.scpefe_revision_limits_default(c.byref(limits)) == 0
    if limit:
        setattr(limits, *limit)
    encoded = c.create_string_buffer(data)
    secret = c.create_string_buffer(password)
    request = Request(c.sizeof(Request), 2, c.addressof(encoded), len(data),
                      c.addressof(secret), len(password), c.pointer(limits), include)
    if change:
        setattr(request, *change)
    output = c.create_string_buffer(b"!" * 64, 64)
    size = c.c_size_t(999)
    status = library.scpefe_container_diagnostic_json(c.byref(request), output,
                                                    len(output), c.byref(size))
    assert output.raw == b"!" * 64
    if error is not None:
        assert status == error, (status, error)
        assert size.value == 0
        return
    assert status == 5 and size.value > 64
    output = c.create_string_buffer(size.value + 1)
    assert library.scpefe_container_diagnostic_json(c.byref(request), output,
                                                  len(output), c.byref(size)) == 0
    assert output.raw[size.value:] == b"\0"
    assert PASSWORD not in output.value
    # The caller's inputs are borrowed, never changed by inspection.
    assert encoded.raw[:-1] == data and secret.raw[:-1] == password
    return output.value


def interactive(executable, path, expected, race_library=None):
    if os.name != "posix":
        return  # POSIX PTY mechanics are unavailable on Windows.
    import fcntl
    import pty
    import select
    import signal
    import termios
    import time

    for interrupt in ((True,) if race_library else (False, True)):
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)

        def terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        process = None
        try:
            process = subprocess.Popen([executable, "inspect", str(path)], stdin=slave,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       preexec_fn=terminal, env=dict(os.environ, LD_PRELOAD=race_library)
                                       if race_library else None)
            terminal_output = b""
            deadline = time.monotonic() + 10
            while b"Password: " not in terminal_output:
                assert time.monotonic() < deadline, "terminal prompt did not appear"
                if select.select([master], [], [], .1)[0]:
                    terminal_output += os.read(master, 4096)
            if not race_library:
                hidden = termios.tcgetattr(slave)
                assert not hidden[3] & (termios.ECHO | termios.ECHONL)
            arguments = Path(f"/proc/{process.pid}/cmdline")
            if arguments.exists():
                assert PASSWORD not in arguments.read_bytes()
            if interrupt and not race_library:
                process.send_signal(signal.SIGINT)
            elif not interrupt:
                os.write(master, PASSWORD + b"\n")
            stdout, stderr = process.communicate(timeout=2 if race_library else 15)
            while select.select([master], [], [], .05)[0]:
                terminal_output += os.read(master, 4096)
            assert PASSWORD not in terminal_output + stdout + stderr
            assert termios.tcgetattr(slave) == original, "terminal attributes were not restored"
            if interrupt:
                assert process.returncode != 0 and stdout == b""
                assert json.loads(stderr) == {"status": "error", "code": 3}
            else:
                assert process.returncode == 0, stderr
                assert stdout == expected + b"\n" and stderr == b""
        finally:
            if process and process.poll() is None:
                process.kill()
                process.communicate()
            os.close(master)
            os.close(slave)


def main():
    executable, root, library_path = sys.argv[1:4]
    root = Path(root)
    if len(sys.argv) == 6 and sys.argv[4] == "--interrupt-race":
        with tempfile.TemporaryDirectory(prefix="scpefe-interruption-") as directory:
            path = Path(directory) / "document.scpefe"
            path.write_bytes(vector(root, "valid/baseline-container"))
            interactive(executable, path, None, race_library=sys.argv[5])
        return
    if len(sys.argv) == 5:
        with tempfile.TemporaryDirectory(prefix="scpefe-delegation-") as directory:
            path = Path(directory) / "opaque.scpefe"
            path.write_bytes(b"deliberately not a container")
            environment = dict(os.environ, LD_PRELOAD=sys.argv[4])
            for include in (False, True):
                args = [executable, "inspect", str(path), "--password-stdin"]
                if include:
                    args.append("--include-content")
                result = subprocess.run(args, input=b"delegation password\n", capture_output=True,
                                        env=environment, timeout=10)
                assert result.returncode == 0, result.stderr
                assert json.loads(result.stdout) == {
                    "delegated_to_common_core": True, "content_requested": include}
            environment["SCPEFE_TEST_DIAGNOSTIC_FAILURE"] = "1"
            result = subprocess.run(args, input=b"delegation password\n", capture_output=True,
                                    env=environment, timeout=10)
            safe_error(result, 10)
        return
    library = c.CDLL(library_path)
    library.scpefe_revision_limits_default.argtypes = [c.POINTER(Limits)]
    library.scpefe_container_diagnostic_json.argtypes = [c.POINTER(Request), c.c_void_p,
                                                       c.c_size_t, c.POINTER(c.c_size_t)]
    with tempfile.TemporaryDirectory(prefix="scpefe-diagnostic-") as directory:
        path = Path(directory) / "document.scpefe"
        for name in ("baseline", "pruned-checkpoint", "foreign-merge", "provisional", "multi-slot"):
            data = vector(root, "valid/" + name + "-container")
            path.write_bytes(data)
            result = cli(executable, path)
            assert result.returncode == 0, result.stderr
            expected = json.loads((root / "tests/vectors/diagnostic" / (name + ".json")).read_text())
            golden = json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode()
            # Exact bytes freeze ordering, field names, escaping and omission rules.
            assert result.stdout == golden + b"\n", (name, {
                "json_matches": json.loads(result.stdout) == expected,
                "has_crlf_terminator": result.stdout.endswith(b"\r\n"),
                "expected_bytes": len(golden) + 1,
                "actual_bytes": len(result.stdout),
            })
            assert api(library, data) == golden, name
            assert b'"content":' not in golden
            assert b"alpha" not in golden and b"beta" not in golden
            # Deterministic output and explicit content opt-in, including pruned/foreign omission.
            included = cli(executable, path, flags=("--include-content",))
            assert included.returncode == 0, included.stderr
            assert api(library, data, include=True) + b"\n" == included.stdout
            records = json.loads(included.stdout)["revision_graph"]["revisions"]
            for record in records:
                present = record["kind"] != 2 and not record["foreign"] and record["text_available"]
                assert ("content" in record) == present
                if present:
                    assert record["content"].startswith("alpha\n")
            # Neither raw test document key nor ciphertext is part of the report.
            assert bytes(range(32, 64)).hex().encode() not in included.stdout
            assert b"wrapped_key" not in included.stdout and b"work_journal_key" not in included.stdout

        multi = vector(root, "valid/multi-slot-container")
        for password, index, claim in [(b"invitation test password", 1, True),
                                       (b"reader test password", 2, False),
                                       (b"recovery test password", 3, False)]:
            report = json.loads(api(library, multi, password=password))
            slot = report["password_slots"][index]
            assert report["authenticated_slot_id"] == slot["id"]
            assert slot["effective_must_be_changed"] is claim
            # Other ordinary wrappers cannot be decrypted with this password.
            for other in report["password_slots"]:
                if other["role"] == "ordinary" and other["index"] != index:
                    expected_claim = True if other["must_be_changed"] else None
                    assert other["effective_must_be_changed"] is expected_claim

        base = vector(root, "valid/baseline-container")
        claim_report = json.loads(api(library, vector(root, "valid/wrapper-claim-container"),
                                      password=b"reader test password"))
        assert claim_report["password_slots"][2]["must_be_changed"] is False
        assert claim_report["password_slots"][2]["effective_must_be_changed"] is True
        csv = vector(root, "valid/csv-container")
        path.write_bytes(csv)
        result = cli(executable, path, flags=("--include-content",))
        assert result.returncode == 0 and json.loads(result.stdout)["content_type"] == "csv"
        assert api(library, csv, include=True) + b"\n" == result.stdout
        invalid_csv = vector(root, "invalid/csv-container")
        path.write_bytes(invalid_csv)
        safe_error(cli(executable, path, flags=("--include-content",)), 9)
        api(library, invalid_csv, error=9)
        path.write_bytes(base)
        golden = api(library, base)
        interactive(executable, path, golden)
        for password in (PASSWORD, PASSWORD + b"\r\n"):
            result = cli(executable, path, password=password)
            assert result.returncode == 0 and result.stdout == golden + b"\n"
        for version in (1, 2):
            obsolete = bytearray(base)
            obsolete[7] = version
            path.write_bytes(obsolete)
            safe_error(cli(executable, path), 9)
            api(library, bytes(obsolete), error=9)
        path.write_bytes(base)
        # A pipe without opt-in cannot silently supply the interactive password.
        if os.name == "posix":
            safe_error(cli(executable, path, stdin=False), 3)
        safe_error(cli(executable, path, password=b"wrong password\n"), 10)
        safe_error(cli(executable, path, password=b""), 1)
        safe_error(cli(executable, path, password=b"x" * 4097 + b"\n"), 7)
        safe_error(cli(executable, path, flags=("--password", "do-not-echo-this")), 1)
        safe_error(cli(executable, path, flags=("--include-content", "--include-content")), 1)
        safe_error(cli(executable, Path(directory) / "missing"), 3)

        for name, code in [("dangling-parent", 9), ("incorrect-revision-id", 9),
                           ("reconstruction-hash", 9), ("unknown-required-feature", 8)]:
            data = vector(root, "invalid/" + name + "-container")
            path.write_bytes(data)
            safe_error(cli(executable, path, flags=("--include-content",)), code)
            api(library, data, include=True, error=code)
        damaged = bytearray(base)
        damaged[-1] ^= 1
        for data, code in [(base[:-1], 9), (b"", 9), (b"bad framing", 9),
                           (bytes(damaged), 10)]:
            path.write_bytes(data)
            safe_error(cli(executable, path, flags=("--include-content",)), code)
            api(library, data, include=True, error=code)
        for name, code in [("envelope-slot-count-zero", 9), ("envelope-payload-length-overflow", 9),
                           ("envelope-wrapper-length", 8), ("envelope-missing-content-type", 8),
                           ("envelope-unknown-content-type", 8)]:
            data = vector(root, "invalid/" + name)
            path.write_bytes(data)
            safe_error(cli(executable, path), code)
            api(library, data, error=code)
        with path.open("wb") as oversized:
            oversized.truncate(MAX_CONTAINER + 1)
        safe_error(cli(executable, path), 7)
        api(library, base, password=b"wrong password", error=10)
        for field, value, code in [("abi_version", 999, 2), ("struct_size", 0, 1),
                                   ("include_content", 2, 1), ("bytes_size", MAX_CONTAINER + 1, 7),
                                   ("password_size", 4097, 1), ("limits", None, 1)]:
            api(library, base, change=(field, value), error=code)
        for field in ("max_input_bytes", "max_nesting_depth", "max_collection_entries",
                      "max_text_bytes", "max_byte_string_bytes", "max_parent_count"):
            api(library, vector(root, "valid/foreign-merge-container"), limit=(field, 0), error=7)
        print("Authenticated container diagnostics: golden JSON, API, CLI, privacy, limits and terminal checks passed")


if __name__ == "__main__":
    main()
