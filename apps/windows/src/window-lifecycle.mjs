/* Registers the BrowserWindow close boundary and returns a removable handler. */
export function registerNativeWindowClose(window, lifecycle) {
  const handler = (event) => lifecycle.handleClose(event);
  window.on("close", handler);
  return () => window.removeListener("close", handler);
}
