# Issue 50 UI review evidence

These screenshots were captured from the real Electron application and its
production renderer bundle. The app opened a synthetic encrypted SCPEFE
document through the native addon, entered edit mode, and displayed the actual
password-administration workflow. No mock renderer or visual mockup was used.

All displayed values are synthetic. The test profile was `Review User
<reviewer@example.test>` on `Review Workstation`; password inputs contain only
purpose-made review phrases and are masked in the UI.

## Screenshots

- [`password-workflows.png`](password-workflows.png) shows the shared password
  guidance on the password-change and invitation workflows before input.
- [`password-workflows-validation.png`](password-workflows-validation.png)
  shows immediate independence feedback when the proposed replacement equals
  the current password.
- [`invitation-password-policy.png`](invitation-password-policy.png) shows the
  invitation workflow rejecting a predictable manually entered temporary
  passphrase while preserving the field and least-privilege permission
  defaults.

The images were captured through Chromium DevTools `Page.captureScreenshot`
from Electron running under Xvfb. Missing host libraries were downloaded as
Ubuntu packages and extracted into a user-owned temporary directory; the host
OS was not modified. The successful capture process ran in a transient systemd
user scope with `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`, and
`TasksMax=256`. It completed in 5.03 seconds with maximum RSS 24,880 KiB and
zero swaps.

The post-picker New-document dialog could not be captured in this Linux review
environment because the real GTK save picker did not accept the automated
synthetic destination under Xvfb. The three screenshots above are from the
working real application and cover the reviewable password-change and
invitation changes; no replacement mockup was created for the blocked picker
flow.
