# Authenticated diagnostic golden reports

These frozen JSON reports describe the corresponding CC0 deterministic
`draft-v3/valid/*-container.hex` fixtures, authenticated with the public test
password. They cover baseline history, a pruned checkpoint and event head,
foreign merge links, a provisional delta, and owner/invitation/view-only/recovery
slots with an active editing lease. Unicode and quotes exercise JSON escaping.

The test compares compact serialization of these checked-in objects byte for
byte with both the CLI and the public C API. It separately verifies opt-in
content and omission for unavailable or foreign bodies. Do not regenerate
these expectations as part of tests: review intentional contract changes
against the format specification and update the affected fixtures explicitly.
