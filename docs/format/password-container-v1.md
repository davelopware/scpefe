# Password container envelope version 1

Status: implementation milestone format; independent cryptographic and format
review remains required before production release.

The version-1 password container is one self-contained byte sequence. All
integers are unsigned little-endian values. Offsets and sizes are bytes.

| Offset | Size | Meaning |
|---:|---:|---|
| 0 | 8 | Magic `53 43 50 45 46 45 00 01` |
| 8 | 4 | Envelope version (`1`) |
| 12 | 4 | Password KDF (`2`, Argon2id v1.3) |
| 16 | 8 | Argon2id operations limit (`2`) |
| 24 | 8 | Argon2id memory limit (`67108864`) |
| 32 | 16 | Random owner-slot salt |
| 48 | 4 | Owner-slot AEAD (`1`, XChaCha20-Poly1305-IETF) |
| 52 | 24 | Random owner-slot nonce |
| 76 | 4 | Snapshot AEAD (`1`, XChaCha20-Poly1305-IETF) |
| 80 | 24 | Random snapshot nonce |
| 104 | 4 | Wrapped owner-slot ciphertext length (`65`) |
| 108 | 8 | Encrypted snapshot payload length |
| 116 | 65 | Wrapped owner-slot ciphertext and authentication tag |
| 181 | variable | Encrypted snapshot payload and authentication tag |

The complete 116-byte header is authenticated as additional data by both AEAD
operations. The owner password derives a 256-bit wrapping key directly through
Argon2id. The wrapped owner-slot plaintext is the random 256-bit document key,
a random 128-bit slot ID, and the owner permission byte (`0x07`: edit, add
passwords, and remove passwords).

The snapshot key is derived from the document key with Libsodium `crypto_kdf`,
subkey ID `1`, and context `SCPSNAP1`. Its plaintext is a random permanent
128-bit document ID followed by one canonical snapshot revision record. Thus
the document ID, slot ID, permissions, revision metadata, and document text are
not visible before successful authentication.

Passwords enter `libscpefe` only as caller-owned byte spans. The container API
does not accept passwords through command-line arguments or emit them through
diagnostics. Sensitive intermediate key buffers are explicitly cleared after
use.
