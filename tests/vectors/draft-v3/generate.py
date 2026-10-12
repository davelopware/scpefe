# SPDX-License-Identifier: CC0-1.0
"""Regenerate the unreleased v3 byte vectors; Python stdlib plus libsodium."""
from __future__ import annotations

import ctypes
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SID = bytes(range(16))
DID = bytes(range(16, 32))
KEY = bytes(range(32, 64))
ZERO = bytes(16)
PASSWORD = b"correct horse battery staple"
PREFIX = {"content": b"SCPEFE-CONTENT-V3\0", "body": b"SCPEFE-BODY-V3\0", "id": b"SCPEFE-REV-ID-V3\0"}


def major(kind: int, number: int) -> bytes:
    assert 0 <= number <= 2**64 - 1
    if number < 24:
        return bytes([kind << 5 | number])
    if number <= 255:
        return bytes([kind << 5 | 24, number])
    if number <= 65535:
        return bytes([kind << 5 | 25]) + number.to_bytes(2, "big")
    if number <= 2**32 - 1:
        return bytes([kind << 5 | 26]) + number.to_bytes(4, "big")
    return bytes([kind << 5 | 27]) + number.to_bytes(8, "big")


def cbor(value) -> bytes:
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if value is None:
        return b"\xf6"
    if isinstance(value, int):
        return major(0, value) if value >= 0 else major(1, -1 - value)
    if isinstance(value, bytes):
        return major(2, len(value)) + value
    if isinstance(value, str):
        data = value.encode("utf-8")
        return major(3, len(data)) + data
    if isinstance(value, list):
        return major(4, len(value)) + b"".join(map(cbor, value))
    if isinstance(value, dict):
        assert all(isinstance(k, int) and k >= 0 for k in value)
        return major(5, len(value)) + b"".join(cbor(k) + cbor(value[k]) for k in sorted(value))
    raise TypeError(type(value))


def hash32(kind: str, data: bytes) -> bytes:
    return hashlib.blake2b(PREFIX[kind] + data, digest_size=32).digest()


def record(meta: dict, storage: int, body=None, **flags) -> dict:
    result = {1: hash32("id", cbor(meta)), 2: meta, 3: storage}
    if body is not None:
        result[4] = body
    if flags.get("provisional"):
        result[5] = True
    if flags.get("resolved_by"):
        result[6] = flags["resolved_by"]
    if flags.get("foreign"):
        result[7] = True
    return result


def metadata(kind: int, content: bytes, previous=None, parent=None, body=None, event=None):
    result = {1: kind, 4: [], 5: 1700000000000 + kind, 6: SID,
              7: "Alice", 8: "alice@example.test", 9: "Alice",
              10: "alice@example.test", 11: "test-device",
              12: hash32("content", content)}
    if previous is not None:
        result[2] = previous
    if parent is not None:
        result[3] = parent
    if body is not None:
        result[13] = hash32("body", cbor(body))
    if event is not None:
        result[14], result[15] = event
    return result


def payload(records: list, head=None, content_head=None, features=None):
    head = head or records[-1][1]
    content_head = content_head or records[-1][1]
    return {1: 1,
            2: [{1: SID, 2: 7, 3: False, 4: 0, 5: bytes(range(64, 80)),
                 6: "Alice", 7: "alice@example.test"}],
            3: {1: SID, 2: "Alice", 3: "alice@example.test"},
            4: {1: False, 2: ZERO, 3: 0, 4: 0, 5: 600000,
                6: "", 7: "", 8: ""},
            5: records, 6: head, 7: content_head, 8: features or []}


def encrypt(key: bytes, nonce: bytes, plain: bytes, aad: bytes) -> bytes:
    sodium = ctypes.CDLL("libsodium.so.23")
    assert sodium.sodium_init() >= 0
    cipher = ctypes.create_string_buffer(len(plain) + 16)
    written = ctypes.c_ulonglong()
    code = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        cipher, ctypes.byref(written), plain, ctypes.c_ulonglong(len(plain)),
        aad, ctypes.c_ulonglong(len(aad)), None, nonce, key)
    assert code == 0 and written.value == len(plain) + 16
    return cipher.raw[:written.value]


def container(clear: bytes) -> bytes:
    sodium = ctypes.CDLL("libsodium.so.23")
    assert sodium.sodium_init() >= 0
    salt, slot_nonce, payload_nonce = bytes(range(80, 96)), bytes(range(96, 120)), bytes(range(120, 144))
    derived = ctypes.create_string_buffer(32)
    assert sodium.crypto_pwhash(derived, ctypes.c_ulonglong(32), PASSWORD,
                                ctypes.c_ulonglong(len(PASSWORD)), salt,
                                ctypes.c_ulonglong(2), ctypes.c_size_t(67108864), 2) == 0
    header = (b"SCPEFE\0\x03" + struct.pack("<IIQQII", 3, 2, 2, 67108864, 1, 1)
              + payload_nonce + struct.pack("<Q", 16 + len(clear) + 16))
    assert len(header) == 72
    slot_aad = b"SCPEFE-slot-v3" + header[:32] + header[36:40] + salt + slot_nonce
    wrapped = encrypt(derived.raw, slot_nonce, KEY + SID + b"\x07\x00", slot_aad)
    assert len(wrapped) == 66
    slot = salt + slot_nonce + struct.pack("<I", 66) + wrapped
    subkey = ctypes.create_string_buffer(32)
    assert sodium.crypto_kdf_derive_from_key(subkey, ctypes.c_size_t(32),
                                             ctypes.c_ulonglong(1), b"SCPSNAP1", KEY) == 0
    encrypted = encrypt(subkey.raw, payload_nonce, DID + clear, header + slot)
    return header + slot + encrypted


def write(name: str, data: bytes) -> dict:
    path = ROOT / (name + ".hex")
    path.parent.mkdir(exist_ok=True)
    path.write_text("# SPDX-License-Identifier: CC0-1.0\n" +
                    "\n".join(data.hex()[i:i + 64] for i in range(0, len(data) * 2, 64)) + "\n")
    return {"path": name + ".hex", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    rows = []
    base_text = b"alpha\n"
    full = [0, len(base_text), base_text]
    base = record(metadata(0, base_text, body=full), 1, full)
    base_payload = payload([base])
    rows.append({**write("valid/baseline-payload", cbor(base_payload)), "expect": "accept; text alpha\\n"})
    rows.append({**write("valid/baseline-container", container(cbor(base_payload))), "expect": "accept with test password; same payload"})

    new_text = b"alpha\nbeta\n"
    delta = [0, len(new_text), [[0, 0, 6], [1, b"beta\n"]]]
    change = record(metadata(1, new_text, base[1], base[1], delta), 2, delta)
    event = record(metadata(2, new_text, change[1], event=("backup-attempted", {4: 0})), 0)
    chain = payload([base, change, event], event[1], change[1])
    rows.append({**write("valid/delta-event", cbor(chain)), "expect": "accept; head event, content head delta; text alpha\\nbeta\\n"})
    prune_base = {**base, 3: 4}
    prune_base.pop(4)
    checkpoint = {**change, 3: 3, 4: [0, len(new_text), new_text]}
    compact = record(metadata(2, new_text, event[1], event=("compaction", {2: change[1], 3: 0})), 0)
    compact_payload = payload([prune_base, checkpoint, event, compact], compact[1], change[1])
    rows.append({**write("valid/pruned-checkpoint", cbor(compact_payload)), "expect": "accept; baseline text unavailable, reconstruct alpha\\nbeta\\n from checkpoint; IDs unchanged"})
    rows.append({**write("valid/pruned-checkpoint-container", container(cbor(compact_payload))),
        "expect": "authenticate saved pruned history with the test password"})

    later_text = b"alpha\nbeta\ngamma\n"
    later_delta = [0, len(later_text), [[0, 0, len(new_text)], [1, b"gamma\n"]]]
    later = record(metadata(1, later_text, compact[1], change[1], later_delta), 2, later_delta)
    later_checkpoint = {**later, 3: 3, 4: [0, len(later_text), later_text]}
    older_checkpoint_pruned = {**change, 3: 4}
    older_checkpoint_pruned.pop(4)
    second_compact = record(metadata(2, later_text, later[1],
        event=("compaction", {2: later[1], 3: 0})), 0)
    repeated_compaction = payload([prune_base, older_checkpoint_pruned, event,
        compact, later_checkpoint, second_compact], second_compact[1], later[1])
    rows.append({**write("valid/repeated-compaction", cbor(repeated_compaction)),
        "expect": "accept; earlier compaction cutoff body was pruned by a later compaction"})

    remote_text = b"alpha\nremote\n"
    remote_delta = [0, len(remote_text), [[0, 0, 6], [1, b"remote\n"]]]
    remote_meta = metadata(1, remote_text, base[1], base[1], remote_delta)
    remote_id = hash32("id", cbor(remote_meta))
    merged_text = b"alpha\nbeta\nremote\n"
    merge_delta = [0, len(merged_text), [[0, 0, len(new_text)], [1, b"remote\n"]]]
    merge_meta = metadata(1, merged_text, change[1], change[1], merge_delta)
    merge_meta[4] = [remote_id]
    merge = record(merge_meta, 2, merge_delta)
    imported = record(remote_meta, 5, resolved_by=merge[1], foreign=True)
    foreign_payload = payload([base, change, imported, merge], merge[1], merge[1])
    rows.append({**write("valid/foreign-merge", cbor(foreign_payload)), "expect": "accept; foreign metadata only with original ID and resolved-by merge; canonical merge text reconstructs"})

    orphan_merge_meta = {**merge_meta, 4: []}
    orphan_merge = record(orphan_merge_meta, 2, merge_delta)
    orphan_import = record(remote_meta, 5, resolved_by=orphan_merge[1], foreign=True)
    rows.append({**write("invalid/orphan-foreign", cbor(payload(
        [base, change, orphan_import, orphan_merge], orphan_merge[1], orphan_merge[1]))),
        "expect": "reject imported metadata not linked to merge source"})
    wrong_compact = record(metadata(2, new_text, event[1],
        event=("compaction", {2: change[1], 3: 1})), 0)
    rows.append({**write("invalid/compaction-count", cbor(payload(
        [prune_base, checkpoint, event, wrong_compact], wrong_compact[1], change[1]))),
        "expect": "reject compaction retained-delta count mismatch"})

    nonminimal = cbor(base_payload).replace(b"\xa8\x01\x01", b"\xa8\x18\x01\x01", 1)
    rows.append({**write("invalid/nonminimal-key", nonminimal), "expect": "reject noncanonical CBOR"})
    duplicate = cbor(base_payload)
    duplicate = b"\xa9" + duplicate[1:] + b"\x01\x01"
    rows.append({**write("invalid/duplicate-key", duplicate), "expect": "reject duplicate CBOR key"})
    bad_time = metadata(0, base_text, body=full)
    bad_time[5] = 2**63
    rows.append({**write("invalid/timestamp-bound", cbor(payload([record(bad_time, 1, full)]))), "expect": "reject timestamp above 2^63-1"})
    bad_parent_meta = metadata(1, new_text, base[1], b"\xff" * 32, delta)
    bad_parent = record(bad_parent_meta, 2, delta)
    rows.append({**write("invalid/dangling-parent", cbor(payload([base, bad_parent], bad_parent[1], bad_parent[1]))), "expect": "reject missing content-parent ID"})
    bad_copy = [0, len(new_text), [[0, 999, 6], [1, b"beta\n"]]]
    bad_copy_node = record(metadata(1, new_text, base[1], base[1], bad_copy), 2, bad_copy)
    rows.append({**write("invalid/delta-out-of-range", cbor(payload([base, bad_copy_node], bad_copy_node[1], bad_copy_node[1]))), "expect": "reject source range beyond parent text"})
    wrong_hash_meta = metadata(1, new_text, base[1], base[1], delta)
    wrong_hash_meta[12] = b"\x00" * 32
    wrong_hash_node = record(wrong_hash_meta, 2, delta)
    rows.append({**write("invalid/reconstruction-hash", cbor(payload([base, wrong_hash_node], wrong_hash_node[1], wrong_hash_node[1]))), "expect": "reject reconstructed content hash mismatch"})
    bad_codec = [1, len(new_text), [[0, 0, 6], [1, b"beta\n"]]]
    bad_codec_node = record(metadata(1, new_text, base[1], base[1], bad_codec), 2, bad_codec)
    rows.append({**write("invalid/unsupported-codec", cbor(payload([base, bad_codec_node], bad_codec_node[1], bad_codec_node[1]))), "expect": "reject unknown delta codec 1"})
    invalid_utf8 = b"\xff"
    utf8_body = [0, 1, invalid_utf8]
    utf8_base = record(metadata(0, invalid_utf8, body=utf8_body), 1, utf8_body)
    rows.append({**write("invalid/text-invalid-utf8", cbor(payload([utf8_base]))), "expect": "reject malformed UTF-8 content"})
    wrong_checkpoint = {**checkpoint, 4: [0, len(new_text), b"alpha\nzeta\n"]}
    rows.append({**write("invalid/checkpoint-content-hash", cbor(payload([prune_base, wrong_checkpoint, event, compact], compact[1], change[1]))), "expect": "reject checkpoint text hash mismatch"})
    wrong_id = {**change, 1: b"\x00" * 32}
    rows.append({**write("invalid/incorrect-revision-id", cbor(payload([base, wrong_id], wrong_id[1], wrong_id[1]))), "expect": "reject ID/preimage hash mismatch"})
    no_anchor = {**checkpoint, 3: 4}
    no_anchor.pop(4)
    rows.append({**write("invalid/pruned-without-anchor", cbor(payload([prune_base, no_anchor, event, compact], compact[1], change[1]))), "expect": "reject missing reconstruction checkpoint"})
    rows.append({**write("invalid/unknown-required-feature", cbor(payload([base], features=[999]))), "expect": "reject unknown required feature"})
    valid_container = container(cbor(base_payload))
    for name, offset, replacement, expected in [
        ("slot-count-zero", 32, struct.pack("<I", 0), "reject slot count bound before KDF"),
        ("payload-length-overflow", 64, b"\xff" * 8, "reject length arithmetic before KDF"),
        ("wrapper-length", 72 + 16 + 24, struct.pack("<I", 65), "reject unsupported wrapper length before KDF")]:
        altered = bytearray(valid_container)
        altered[offset:offset + len(replacement)] = replacement
        rows.append({**write("invalid/envelope-" + name, bytes(altered)), "expect": expected})
    (ROOT / "manifest.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
