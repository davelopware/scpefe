"""Regression checks for distribution validation failing closed."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from windows_diagnostic_preview import (EXE_NAME, MANIFEST_NAME, check_imports,
                                        sha256, verify_download, watch_temp)


class PreviewValidationTest(unittest.TestCase):
    def test_imports_reject_runtime_even_if_installed(self):
        for dependency in ("scpefe.dll", "libsodium.dll", "VCRUNTIME140.dll", "ucrtbase.dll",
                           "api-ms-win-crt-runtime-l1-1-0.dll", "unknown.dll"):
            with self.subTest(dependency=dependency), self.assertRaisesRegex(ValueError, "Non-system"):
                check_imports("    KERNEL32.dll\n    " + dependency + "\n")
        with self.assertRaisesRegex(ValueError, "No import-table"):
            check_imports("dumpbin failed to emit any dependencies")
        self.assertEqual(check_imports("    ADVAPI32.dll\n    KERNEL32.dll\n"),
                         ["ADVAPI32.dll", "KERNEL32.dll"])

    def test_download_rejects_altered_bytes_metadata_and_companions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = directory / EXE_NAME
            executable.write_bytes(b"validated executable bytes")
            digest = sha256(executable)
            manifest = {"source_commit": "a" * 40, "validation": {"result": "passed"},
                        "unsigned": True, "platform": "win-x64", "executable": EXE_NAME, "sha256": digest}
            (directory / MANIFEST_NAME).write_text(json.dumps(manifest))
            checksum = directory / (EXE_NAME + ".sha256")
            checksum.write_text(digest + "  " + EXE_NAME + "\n")
            self.assertEqual(verify_download(directory, "a" * 40), digest)
            with self.assertRaisesRegex(ValueError, "wrong source commit"):
                verify_download(directory, "b" * 40)
            executable.write_bytes(b"replacement after validation")
            with self.assertRaisesRegex(ValueError, "differs from the validated EXE"):
                verify_download(directory, "a" * 40)
            executable.write_bytes(b"validated executable bytes")
            checksum.write_text("0" * 64 + "  " + EXE_NAME)
            with self.assertRaisesRegex(ValueError, "checksum differs"):
                verify_download(directory, "a" * 40)
            checksum.write_text(digest + "  " + EXE_NAME)
            (directory / "scpefe.dll").touch()
            with self.assertRaisesRegex(ValueError, "Unexpected DLL"):
                verify_download(directory, "a" * 40)
            (directory / "scpefe.dll").unlink()
            manifest["validation"]["result"] = "skipped"
            (directory / MANIFEST_NAME).write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "lacks successful"):
                verify_download(directory, "a" * 40)

    def test_download_is_bound_to_original_validation_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / EXE_NAME).write_bytes(b"replacement executable")
            digest = sha256(directory / EXE_NAME)
            manifest = {"source_commit": "a" * 40, "validation": {"result": "passed"},
                        "unsigned": True, "platform": "win-x64", "executable": EXE_NAME, "sha256": digest}
            (directory / MANIFEST_NAME).write_text(json.dumps(manifest))
            (directory / (EXE_NAME + ".sha256")).write_text(digest + "  " + EXE_NAME)
            # Even coordinated replacement of EXE + downloaded checksum + manifest
            # cannot replace the original pre-publication validation evidence.
            manifest["sha256"] = "0" * 64
            original = directory / "original-validation.json"
            original.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "original validation evidence"):
                verify_download(directory, "a" * 40, original)

    @unittest.skipUnless(os.name == "nt", "Windows directory notifications")
    def test_temporary_dll_deleted_before_exit_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaisesRegex(ValueError, "Temporary DLL extraction"):
                with watch_temp(directory):
                    nested = directory / "extraction"
                    nested.mkdir()
                    dll = nested / "runtime.DLL"
                    dll.write_bytes(b"ephemeral DLL")
                    dll.unlink()
                    nested.rmdir()
            self.assertFalse(list(directory.rglob("*.dll")))

    @unittest.skipUnless(os.name == "nt", "Windows directory notifications")
    def test_temporary_non_dll_data_is_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with watch_temp(directory):
                (directory / "scratch.txt").write_text("ordinary scratch data")


if __name__ == "__main__":
    unittest.main()
