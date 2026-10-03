# Issue 97 UI review evidence

These screenshots come from the real Electron application with its production
renderer bundle and locally built native addon. A synthetic encrypted document
was opened and its Passwords dialog was shown in a 650 × 380 window. The
application used an isolated temporary profile and an already running, idle
Xvfb `:99` display. The Electron, CDP, and capture processes ran together in a
transient systemd user scope with `MemoryHigh=768M`, `MemoryMax=1G`,
`MemorySwapMax=0`, and `TasksMax=256`.

- [Top of the shared dialog](short-dialog-top.png)
- [Body scrolled with the title fixed](short-dialog-scrolled.png)
- [Measured bounds and scroll positions](measurements.json)

At 380 pixels high, the dialog occupied vertical pixels 14–366. The header's
top stayed at pixel 15 while the body scrolled from 0 to 1000 pixels. The body
had 1312 pixels of content in a 303 pixel viewport; the dialog itself did not
scroll. The successful capture took 2.39 seconds, peaked at 223,884 KiB RSS,
and used zero swaps.

The creation dialog could not be captured after attempting to drive the real
GTK save picker with a synthetic path under Xvfb; the picker did not complete.
Rendered tests cover creation's shared frame, accessible description, initial
focus, Tab containment, pending guard, cancellation, and success behavior.
