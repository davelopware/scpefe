/* Treats window focus changes as activity, reserving locking for OS screen lock. */
export function registerWindowFocusProtection({ window, powerMonitor, activity, lock }) {
  powerMonitor.on("lock-screen", () => { void lock("screen-lock"); });
  for (const event of ["blur", "minimize", "focus", "restore"]) {
    window.on(event, activity);
  }
}
