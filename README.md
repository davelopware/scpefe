# SCPEFE

SCPEFE is a storage-neutral, cross-platform application for editing small encrypted text files. A document may live on a local disk, a network share or NAS, or cloud-backed storage; cloud-hosted files are a required capability, not a required location.

The developing requirements and design decisions are recorded in [SPECIFICATION.md](SPECIFICATION.md). Canonical project terminology is defined in [DOMAIN_MODEL.md](DOMAIN_MODEL.md).

## Initial project scope

- Support editing the same encrypted text files across multiple devices and platforms.
- Work equally through ordinary file access with local, network, NAS, and cloud-backed storage; use Google Drive as the first cloud-storage use case.
- Target Windows, Linux, and Android mobile initially.
- Maximise shared code between platforms, ideally through a common core with platform-appropriate user interfaces.
- Allow a user to unlock and edit an encrypted file by entering a password, without having to distribute or manage separate key files.
- Support a small set of per-file password slots for invited viewers/editors, including an optional independent recovery/master password.

The selected direction is a C++20 common core with a React/TypeScript UI, Electron on Windows and Linux, and Capacitor on Android. Security-sensitive format and cryptographic details remain subject to implementation validation and independent expert review before production release.
