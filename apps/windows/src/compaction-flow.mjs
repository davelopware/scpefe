/* Runs compaction and lets the user choose another backup target on backup failure. */
export async function compactWithBackupSelection({ service, dialog, window,
  confirmation }) {
  try {
    return await service.compactDocument(confirmation);
  } catch (error) {
    if (error?.code !== "COMPACTION_BACKUP_FAILED") throw error;
  }
  const chosen = await dialog.showSaveDialog(window, {
    title: "Choose another pre-compaction backup destination",
    defaultPath: service.suggestedBackupTarget(),
    filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
    properties: ["createDirectory"],
  });
  if (chosen.canceled || !chosen.filePath) return null;
  return service.compactDocument(confirmation, chosen.filePath);
}

/* Confirms irreversible removal in the trusted host before any service call. */
export async function confirmAndCompact({ service, dialog, window, confirmation }) {
  const warning = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Permanently compact document history?",
    message: "Compaction causes irreversible local history removal from this container.",
    detail: "It cannot delete historical copies retained by storage providers, sync tools, caches, backups, or other external copies. SCPEFE must create and verify an exact backup replica before compaction.",
    buttons: ["Cancel", "Create backup and compact"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (warning.response !== 1) return null;
  return compactWithBackupSelection({ service, dialog, window, confirmation });
}

/* Registers the trusted Electron compaction boundary. */
export function registerCompactionHandler({ ipcMain, service, dialog, window,
  confirmation }) {
  ipcMain.handle("document:compact", () => confirmAndCompact({ service, dialog,
    window, confirmation }));
}
