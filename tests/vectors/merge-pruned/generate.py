"""Regenerate two valid divergent replicas whose shared merge base is pruned."""

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "draft-v3" / "generate.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("draft_v3_vectors", SOURCE)
vectors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vectors)

base_text = b"alpha\n"
base_body = [0, len(base_text), base_text]
base = vectors.record(vectors.metadata(0, base_text, body=base_body), 1, base_body)
shared_text = b"alpha\ncommon\n"
shared_delta = [0, len(shared_text), [[0, 0, 6], [1, b"common\n"]]]
shared = vectors.record(vectors.metadata(1, shared_text, base[1], base[1],
                                         shared_delta), 2, shared_delta)
event = vectors.record(vectors.metadata(2, shared_text, shared[1],
                                        event=("backup-attempted", {4: 0})), 0)
compact = vectors.record(vectors.metadata(2, shared_text, event[1],
                                          event=("compaction", {2: shared[1], 3: 0})), 0)
pruned_base = {**base, 3: 4}
pruned_base.pop(4)
pruned_shared = {**shared, 3: 4}
pruned_shared.pop(4)

for name, suffix in (("local", b"local\n"), ("target", b"target\n")):
    text = shared_text + suffix
    delta = [0, len(text), [[0, 0, len(shared_text)], [1, suffix]]]
    later = vectors.record(vectors.metadata(1, text, compact[1], shared[1], delta),
                           3, [0, len(text), text])
    second = vectors.record(vectors.metadata(2, text, later[1],
                                             event=("compaction", {2: later[1], 3: 0})), 0)
    graph = vectors.payload([pruned_base, pruned_shared, event, compact, later, second],
                            second[1], later[1])
    encrypted = vectors.container(vectors.cbor(graph))
    hex_lines = [encrypted[i:i + 32].hex() for i in range(0, len(encrypted), 32)]
    (ROOT / f"{name}.hex").write_text("\n".join(hex_lines) + "\n")
