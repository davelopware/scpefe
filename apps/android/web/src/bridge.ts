import { registerPlugin } from "@capacitor/core";
import type { SessionHost, ShellHost, CreationTargetHost,
  JournalTransportHost, SessionEventsHost, SecurityClipboardHost,
  DocumentOpened, Profile, ClientSettings } from "@scpefe/react-ui";
import { validateCreateFormRequest, validatePassword } from "../../../windows/src/contracts.mjs";

type CreationRequest = ReturnType<typeof validateCreateFormRequest>;
type PluginOpened = { opened: DocumentOpened };

/** Native methods exposed to the WebView; opaque target keys never cross it. */
export interface AndroidPluginContract {
  addListener?(name: "regularSave" | "journalWarning",
    listener: (event: Record<string, unknown>) => void): Promise<{
      remove(): Promise<void> }>;
  getProfile(): Promise<{ profile: Profile | null }>;
  saveProfile(value: { profile: Profile }): Promise<{ profile: Profile }>;
  getClientSettings(): Promise<{ settings: ClientSettings }>;
  saveClientSettings(value: { settings: ClientSettings }): Promise<{ settings: ClientSettings }>;
  assessPasswordPolicy(value: { password: string }): Promise<{ assessment: string }>;
  chooseCreateTarget(): Promise<{ selected: boolean }>;
  cancelCreateTarget(): Promise<void>;
  createDocument(value: { request: CreationRequest }): Promise<{
    created: true; opened: DocumentOpened; name: string }>;
  chooseOpenTarget(): Promise<{ selected: boolean; name?: string }>;
  cancelOpenTarget(): Promise<void>;
  openSelectedDocument(value: { password: string }): Promise<PluginOpened>;
  unlockDocument(value: { password: string }): Promise<PluginOpened>;
  lock(): Promise<{ locked: true; journalSaved: true; warningCode: null }>;
  closeDocument(): Promise<{ closed: true }>;
  getUnresolvedJournalSummary(): Promise<{ total: number; pendingPublications: number }>;
  enterEditMode(): Promise<PluginOpened>;
  restoreRecoveredWork(): Promise<{ opened: DocumentOpened & {
    recoveredUnsaved: true; cursor: { start: number; end: number } } }>;
  updateWorkingCopy(value: { update: { content: string;
    cursor: { start: number; end: number }; journalScope: string;
    revision: number } }): Promise<{ accepted: true }>;
  saveDocument(value: { request: { content: string; journalScope?: string;
    revision?: number } }): Promise<{ result: { saved: true; content: string;
    journalScope?: string; revision?: number;
    publicationState: "target-published" | "pending-publication" } }>;
  reconnectPendingPublication(): Promise<{ result: { content: string;
    publicationState: "target-published" | "pending-publication" | "conflict" } }>;
}

export const native = registerPlugin<AndroidPluginContract>("Scpefe");

function opened(value: unknown): DocumentOpened {
  if (!value || typeof value !== "object") throw new TypeError("Invalid native document");
  const candidate = value as Partial<DocumentOpened>;
  if (typeof candidate.readOnly !== "boolean" || typeof candidate.canEdit !== "boolean"
      || (candidate.readOnly === false && candidate.canEdit !== true)
      || typeof candidate.content !== "string"
      || (candidate.provisional !== undefined && candidate.provisional !== true)
      || new TextEncoder().encode(candidate.content).length > 1024 * 1024
      || !["plain-text", "csv"].includes(candidate.contentType ?? "")
      || !["target-published", "pending-publication", "conflict"].includes(
        candidate.publicationState ?? "")) {
    throw new TypeError("Invalid native document");
  }
  const recovery = candidate.recovery;
  if (recovery && (recovery.state !== "unsaved"
      || typeof recovery.content !== "string"
      || !Number.isSafeInteger(recovery.updateTime)
      || !recovery.cursor || !Number.isSafeInteger(recovery.cursor.start)
      || !Number.isSafeInteger(recovery.cursor.end)
      || recovery.cursor.start < 0 || recovery.cursor.end < recovery.cursor.start
      || recovery.cursor.end > recovery.content.length)) {
    throw new TypeError("Invalid native recovery");
  }
  return Object.freeze({ content: candidate.content, readOnly: candidate.readOnly,
    canEdit: candidate.canEdit,
    contentType: candidate.contentType,
    publicationState: candidate.publicationState!, targetName: "Selected document",
    ...(candidate.provisional ? { provisional: true as const } : {}),
    ...(recovery ? { recovery: Object.freeze({ content: recovery.content,
      state: "unsaved" as const, updateTime: recovery.updateTime,
      cursor: Object.freeze({ start: recovery.cursor.start, end: recovery.cursor.end }),
      ...(recovery.baseMismatch ? { baseMismatch: true as const } : {}) }) } : {}),
    ...(candidate.unreadableJournal ? { unreadableJournal: true as const } : {}) });
}

function profile(value: unknown): Profile {
  if (!value || typeof value !== "object") throw new TypeError("Invalid profile");
  const candidate = value as Partial<Profile>;
  if (![candidate.name, candidate.email, candidate.deviceName].every(
    (part) => typeof part === "string" && part.length > 0
      && new TextEncoder().encode(part).length <= 512)) {
    throw new TypeError("Invalid profile");
  }
  return { name: candidate.name!, email: candidate.email!, deviceName: candidate.deviceName! };
}

function workingUpdate(value: unknown): { content: string;
    cursor: { start: number; end: number }; journalScope: string;
    revision: number } {
  if (!value || typeof value !== "object") throw new TypeError("Invalid working copy");
  const update = value as { content?: unknown; cursor?: { start?: unknown; end?: unknown };
    journalScope?: unknown; revision?: unknown };
  const start = update.cursor?.start, end = update.cursor?.end;
  if (typeof update.content !== "string"
      || new TextEncoder().encode(update.content).length > 1024 * 1024
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || (start as number) < 0 || (end as number) < (start as number)
      || (end as number) > update.content.length
      || typeof update.journalScope !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(update.journalScope)
      || !Number.isSafeInteger(update.revision) || (update.revision as number) < 1) {
    throw new TypeError("Invalid working copy");
  }
  return { content: update.content,
    cursor: { start: start as number, end: end as number },
    journalScope: update.journalScope, revision: update.revision as number };
}

function recovered(value: unknown) {
  if (!value || typeof value !== "object") throw new TypeError("Invalid recovery");
  const candidate = value as { content?: unknown; readOnly?: unknown; canEdit?: unknown;
    recoveredUnsaved?: unknown; cursor?: { start?: unknown; end?: unknown } };
  const start = candidate.cursor?.start, end = candidate.cursor?.end;
  if (candidate.readOnly !== false || candidate.canEdit !== true
      || candidate.recoveredUnsaved !== true || typeof candidate.content !== "string"
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || (start as number) < 0 || (end as number) < (start as number)
      || (end as number) > candidate.content.length) {
    throw new TypeError("Invalid recovery");
  }
  return Object.freeze({ content: candidate.content, readOnly: false as const,
    canEdit: true as const, recoveredUnsaved: true as const,
    cursor: Object.freeze({ start: start as number, end: end as number }) });
}

const unsupported = async (): Promise<never> => {
  throw Object.assign(new Error("This action is not available on Android yet."),
    { code: "OPERATION_FAILED" });
};

function subscribe(plugin: AndroidPluginContract,
    name: "regularSave" | "journalWarning",
    listener: (event: Record<string, unknown>) => void) {
  let disposed = false;
  let handle: { remove(): Promise<void> } | null = null;
  void plugin.addListener?.(name, listener).then((registered) => {
    if (disposed) void registered.remove();
    else handle = registered;
  }).catch(() => {});
  return () => { disposed = true; if (handle) void handle.remove(); };
}

/** Shared-UI host for native admission, edit lease, and encrypted local checkpoints. */
export function createHost(plugin: AndroidPluginContract) { return {
  getProfile: async () => { const value = (await plugin.getProfile()).profile;
    return value === null ? null : profile(value); },
  saveProfile: async (value: Profile) => profile(
    (await plugin.saveProfile({ profile: profile(value) })).profile),
  reconcileProfile: async () => null,
  getClientSettings: async () => (await plugin.getClientSettings()).settings,
  saveClientSettings: async (settings: ClientSettings) =>
    (await plugin.saveClientSettings({ settings })).settings,
  chooseCreateTarget: async () => (await plugin.chooseCreateTarget()).selected
    ? { selected: true as const } : null,
  cancelCreateTarget: async () => { await plugin.cancelCreateTarget(); },
  createDocument: async (request: object) => {
    const result = await plugin.createDocument({ request: validateCreateFormRequest(request) });
    if (result.created !== true || typeof result.name !== "string")
      throw new TypeError("Invalid native creation result");
    return { created: true as const, opened: opened(result.opened), name: result.name };
  },
  chooseOpenTarget: async () => { const value = await plugin.chooseOpenTarget();
    return value.selected ? { selected: true as const, name: "Selected document" } : null; },
  cancelOpenTarget: async () => { await plugin.cancelOpenTarget(); },
  openSelectedDocument: async (password: string) => opened(
    (await plugin.openSelectedDocument({ password: validatePassword(password) })).opened),
  unlockDocument: async (password: string) => opened(
    (await plugin.unlockDocument({ password: validatePassword(password) })).opened),
  lock: async () => plugin.lock(),
  closeDocument: async () => (await plugin.closeDocument()).closed,
  getUnresolvedJournalSummary: async () => plugin.getUnresolvedJournalSummary(),
  assessPasswordPolicy: async (password: string) =>
    (await plugin.assessPasswordPolicy({ password: validatePassword(password) })).assessment,
  createJournalScope: () => crypto.randomUUID(),
  updateWorkingCopy: async (update: object) => {
    const result = await plugin.updateWorkingCopy({ update: workingUpdate(update) });
    if (result.accepted !== true) throw new TypeError("Invalid checkpoint result");
  },
  activity: async () => undefined,
  onLocked: () => () => {},
  onJournalWarning: (listener: (code: string, scope: string | null) => void) =>
    subscribe(plugin, "journalWarning", (event) => {
      if (typeof event.code === "string") listener(event.code, null);
    }),
  onRegularSave: (listener: (result: { published: true; provisional: true;
      content: string; journalScope: string; revision: number }) => void) =>
    subscribe(plugin, "regularSave", (event) => {
      if (event.published === true && event.provisional === true
          && typeof event.content === "string"
          && typeof event.journalScope === "string"
          && Number.isSafeInteger(event.revision) && (event.revision as number) > 0)
        listener({ published: true, provisional: true, content: event.content,
          journalScope: event.journalScope, revision: event.revision as number });
    }),
  onExternalOpenRequested: () => () => {},
  onUnresolvedJournalSummary: () => () => {},
  onSwitchRetained: () => () => {},
  copyInvitationPassphrase: async () => false,
  enterEditMode: async () => opened((await plugin.enterEditMode()).opened),
  cancelLeaseTakeover: unsupported,
  restoreRecoveredWork: async () => recovered(
    (await plugin.restoreRecoveredWork()).opened),
  saveDocument: async (content: string, version?: { journalScope: string;
      revision: number } | null) => {
    if (typeof content !== "string"
        || new TextEncoder().encode(content).length > 1024 * 1024)
      throw new TypeError("Invalid save content");
    const request = { content, ...(version ? {
      journalScope: version.journalScope, revision: version.revision } : {}) };
    const result = (await plugin.saveDocument({ request })).result;
    if (result.saved !== true || result.content !== content
        || !["target-published", "pending-publication"].includes(
          result.publicationState)
        || (version && (result.journalScope !== version.journalScope
          || result.revision !== version.revision)))
      throw new TypeError("Invalid native save result");
    return result;
  },
  saveDivergenceResolution: unsupported,
  reconnectPendingPublication: async () => {
    const result = (await plugin.reconnectPendingPublication()).result;
    if (typeof result.content !== "string"
        || !["target-published", "pending-publication", "conflict"].includes(
          result.publicationState))
      throw new TypeError("Invalid native publication result");
    return result;
  },
  discardPendingPublication: unsupported,
  discardRecoveredWork: unsupported,
  acceptHeadMismatch: unsupported,
  discardUnreadableJournal: unsupported,
  backupDocument: unsupported,
  exportPlaintext: unsupported,
} as unknown as SessionHost & ShellHost & CreationTargetHost & JournalTransportHost
  & SessionEventsHost & SecurityClipboardHost & {
    createDocument: NonNullable<SessionHost["createDocument"]>;
    createJournalScope(): string;
    assessPasswordPolicy(password: string): Promise<string> };
}

export const host = createHost(native);
