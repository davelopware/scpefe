/* Retries migration with a user-selected backup target after backup failure. */
export async function migrateWithBackupSelection({ service, dialog, window,
  forceTakeover = false }) {
  try {
    return await service.migrateDocument(undefined, { forceTakeover });
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
  return service.migrateDocument(chosen.filePath, { forceTakeover });
}

/* Presents the older-client warning before any migration work starts. */
export async function confirmAndMigrate({ service, dialog, window }) {
  const warning = await dialog.showMessageBox(window, {
    type: "warning", title: "Migrate older encrypted document?",
    message: "Migration is required before this document can be edited or saved.",
    detail: "A verified exact backup will be created first. Older SCPEFE clients may not open the migrated document.",
    buttons: ["Keep read-only", "Create backup and migrate"],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  if (warning.response !== 1) return null;
  try {
    return await migrateWithBackupSelection({ service, dialog, window });
  } catch (error) {
    if (error?.code !== "LEASE_CLOCK_UNCERTAIN") throw error;
    const takeover = await dialog.showMessageBox(window, {
      type: "warning", title: "Editing lease time cannot be trusted",
      message: `The editing lease held by ${error.lease?.holderName || "another editor"} appears to be from the future.`,
      detail: "Only force takeover if you have confirmed that no other client is editing this document.",
      buttons: ["Cancel", "Force takeover and migrate"],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (takeover.response !== 1) return null;
    return migrateWithBackupSelection({ service, dialog, window,
      forceTakeover: true });
  }
}

/* Registers the trusted Electron migration boundary. */
export function registerMigrationHandler({ ipcMain, service, dialog, window }) {
  ipcMain.handle("document:migrate", () => confirmAndMigrate({ service, dialog, window }));
}
