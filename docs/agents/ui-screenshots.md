# Actual Electron UI screenshots

Capture review evidence from the real Electron application with synthetic inputs
only. Use the production renderer bundle and native addon; never substitute a
mockup.

1. Build the production renderer and native addon under the resource-safety
   procedure in `resource-safety.md`.
2. Run Electron under Xvfb and capture the rendered page through Chromium
   DevTools Protocol `Page.captureScreenshot`.
3. If required Electron host libraries are absent and system installation is
   unavailable, use `apt download` for the exact packages and extract them with
   `dpkg` into a temporary user-owned directory. Supply the extracted library
   paths through `LD_LIBRARY_PATH`; do not modify the host OS.
4. Run every build, Electron, and screenshot process tree serially inside the
   required transient systemd user scope, with its memory, swap, task, timeout,
   and measurement requirements intact.
5. Remove temporary symlinks, extracted packages, profiles, and generated
   capture assets that are not part of the review evidence.
6. Record native picker or automation limitations beside the evidence. Keep the
   real capture and explain uncovered UI rather than replacing it with a mockup.

See `docs/review/issue-50/README.md` for a worked capture and evidence note.
