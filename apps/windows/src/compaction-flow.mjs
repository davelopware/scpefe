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

/* Registers the trusted Electron compaction boundary after renderer confirmation. */
export function registerCompactionHandler({ ipcMain, service, dialog, window,
  confirmation }) {
  ipcMain.handle("document:compact", (_event, request) => {
    if (!request || typeof request !== "object" || request.confirmed !== true
        || Object.keys(request).length !== 1) {
      throw new TypeError("compaction confirmation is invalid");
    }
    return compactWithBackupSelection({ service, dialog, window, confirmation });
  });
}
