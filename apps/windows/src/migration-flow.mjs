import { runLeaseOperation } from "./lease-takeover.mjs";

/* Retries migration with a user-selected backup target after backup failure. */
export async function migrateWithBackupSelection({ service, dialog, window,
  takeoverToken }) {
  let retryTakeoverToken = takeoverToken;
  try {
    return await service.migrateDocument(undefined, { takeoverToken });
  } catch (error) {
    if (error?.code !== "MIGRATION_BACKUP_FAILED") throw error;
    retryTakeoverToken = error.takeoverToken;
  }
  const chosen = await dialog.showSaveDialog(window, {
    title: "Choose another pre-migration backup destination",
    defaultPath: service.suggestedBackupTarget(),
    filters: [{ name: "SCPEFE document", extensions: ["scpefe"] }],
    properties: ["createDirectory"],
  });
  if (chosen.canceled || !chosen.filePath) return null;
  return service.migrateDocument(chosen.filePath, { takeoverToken: retryTakeoverToken });
}

/* Registers a two-step migration boundary while retaining takeover authority in main. */
export function registerMigrationHandler({ ipcMain, getService, dialog, window,
  authorizations, validateAuthorization }) {
  ipcMain.handle("document:migrate", async (_event, request) => {
    const authorization = validateAuthorization(request);
    const service = getService();
    return runLeaseOperation({ authorizations, operation: "migration", service,
      authorization, perform: (takeoverToken) =>
        migrateWithBackupSelection({ service, dialog, window, takeoverToken }) });
  });
}
