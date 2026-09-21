/* Retries migration with a user-selected backup target after backup failure. */
export async function migrateWithBackupSelection({ service, dialog, window,
  takeoverToken }) {
  try {
    return await service.migrateDocument(undefined, { takeoverToken });
  } catch (error) {
    if (error?.code !== "MIGRATION_BACKUP_FAILED") throw error;
  }
  const chosen = await dialog.showSaveDialog(window, {
    title: "Choose another pre-migration backup destination",
    defaultPath: service.suggestedBackupTarget(),
    filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
    properties: ["createDirectory"],
  });
  if (chosen.canceled || !chosen.filePath) return null;
  return service.migrateDocument(chosen.filePath, { takeoverToken });
}

/* Registers a two-step migration boundary while retaining takeover authority in main. */
export function registerMigrationHandler({ ipcMain, service, dialog, window }) {
  let pendingTakeover = null;
  ipcMain.handle("document:migrate", async (_event, request) => {
    if (!request || typeof request !== "object"
        || typeof request.forceTakeover !== "boolean"
        || Object.keys(request).length !== 1) {
      throw new TypeError("migration decision is invalid");
    }
    const takeoverToken = request.forceTakeover ? pendingTakeover : undefined;
    if (request.forceTakeover && !takeoverToken) {
      throw new Error("No migration lease takeover is awaiting confirmation");
    }
    if (!request.forceTakeover) pendingTakeover = null;
    try {
      const result = await migrateWithBackupSelection({ service, dialog, window,
        takeoverToken });
      pendingTakeover = null;
      return result;
    } catch (error) {
      if (error?.code !== "LEASE_CLOCK_UNCERTAIN") throw error;
      pendingTakeover = error.takeoverToken;
      return Object.freeze({ decisionRequired: "lease-takeover",
        holderName: String(error.lease?.holderName || "another editor") });
    }
  });
}
