# Authenticated container diagnostic JSON, version 1

`scpefe-diagnostic inspect PATH [--password-stdin] [--include-content]` calls
`scpefe_container_diagnostic_json` through `scpefe_container_diagnostic_v1`.
`struct_size` and `abi_version` follow the public C ABI's versioning rules.
The API borrows encrypted bytes, password bytes, and `scpefe_revision_limits_v1`
only for the duration of the call. It creates no document session or editing
lease and never changes the target. Only revised-v3 envelopes are currently
readable by the native core.

The core authenticates a password wrapper and the entire payload, validates all
records and graph links, reconstructs and verifies retained content hashes, and
checks the content type before serializing any semantic output. The report
does not prove that the inspected replica is the newest one.

Success is compact UTF-8 JSON followed by a newline in the CLI. Field order is
deterministic; identifiers and hashes use lowercase hexadecimal. Golden files
under `tests/vectors/diagnostic` freeze representative reports and their order.
There are no raw CBOR, ciphertext, password, key, or KDF intermediate fields.

| Field | Meaning |
| --- | --- |
| `status`, `diagnostic_version` | `"ok"` and diagnostic schema version `1`. |
| `envelope` | Container format version `3`, total/header/slot/wrapper/payload ciphertext byte counts, slot count, Argon2id v1.3 (version `19`) and cost parameters, XChaCha20-Poly1305-IETF parameters, and BLAKE2b-256 hash algorithm. These describe validated declarations, not a second CLI parser. |
| `document_id`, `content_type` | Authenticated document identity and immutable `"plain_text"` or `"csv"` content type. |
| `authenticated_slot_id` | Slot opened by the supplied password, including invitation and recovery slots. |
| `password_slots` | Envelope order; index, slot and management IDs, role (`owner`, `ordinary`, `recovery`), effective permission bits as booleans, metadata claim flag (`must_be_changed`), and decrypted display name/email. Recovery identities may be empty. |
| `password_slots[].effective_must_be_changed` | OR of metadata and wrapper claim flags for the authenticated slot; `true` when another slot's metadata requires it; `false` for owner/recovery; otherwise `null` because another password's wrapper claim flag cannot be read. |
| `screen_lock` | `"client_local"`: screen privacy is client state and is not persisted in the container. Inspection does not acquire Edit mode. |
| `editing_lease` | Active flag, session ID, heartbeat counter, holder time/duration in milliseconds, holder identity, and device. The report does not infer expiry from the inspecting machine's clock. |
| `revision_graph` | `schema: "container-v3"`, structured-record `format_version: 1`, `validation: "valid"`, head/content-head IDs, record count, encoded graph bytes, mandatory feature IDs (currently empty), optional extension encoded bytes (zero if absent), and revisions in stored causal order. Unknown optional extension values are not interpreted or emitted. |
| `revision_graph.revisions[]` | ID; original `kind` (`0` baseline, `1` delta, `2` event); current `storage` (`0` event, `1` full body, `2` delta, `3` checkpoint, `4` pruned, `5` foreign metadata); actor slot/name/email, client name/email, device, timestamp; provisional/sealed/foreign/text-availability flags; previous head, content parent, merge sources, resolved-by; content hash and original body digest; record and current body CBOR byte counts; event type/detail, affected slot, activity status, and compaction cutoff/retained-delta count. |

Absent individual parent links, resolved-by IDs, original body digests, event
affected slots, activity status, and compaction fields are `null`. Empty
collections are `[]`; absent identity/event strings are `""`. Activity status
values are `0` attempted, `1` observed success, `2` observed failure. A zero
body-byte count means no stored body, including event and pruned records.

The sole conditional field is `revision_graph.revisions[].content`. It is
omitted by default. With `include_content == 1` / `--include-content`, it is
present only for reconstructable canonical non-event revisions. Pruned,
foreign, and event records omit it even when requested. Historical content can
be sensitive even if it is absent from the current document.

Failure returns a nonzero `scpefe_status`. The CLI emits only
`{"status":"error","code":N}` on stderr (plus an interactive terminal prompt),
with no partial report on stdout. Argument errors also follow this contract.
The core does not modify caller output on any failure. A size probe or short
buffer returns `BUFFER_TOO_SMALL`, sets `output_size` to bytes excluding NUL,
and writes nothing. Success requires capacity greater than that size. Other
errors set `output_size` to zero. Probes authenticate and validate too.

Encrypted input has a 33 MiB hard cap. Decrypted graph allocation and structural
limits come from the request; output has a separate 32 MiB hard cap, including
escaped/expanded historical content but excluding NUL. Limit failures emit no
partial output. Callers own returned JSON and should clear sensitive output
buffers when finished. The core and CLI clear their owned password, decrypted
graph, and diagnostic buffers on completion; OS terminal/pipe buffers and
caller copies remain outside their control.

Consumers should tolerate additive fields. Incompatible field or omission-rule
changes require a new `diagnostic_version`.
