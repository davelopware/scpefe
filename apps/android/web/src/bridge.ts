import { registerPlugin } from "@capacitor/core";
import type { SessionHost, ShellHost, CreationTargetHost,
  JournalTransportHost, SessionEventsHost, SecurityClipboardHost,
  DocumentOpened, Profile, ClientSettings } from "@scpefe/react-ui";
import { validateCreateFormRequest, validatePassword } from "../../../windows/src/contracts.mjs";

type CreationRequest = ReturnType<typeof validateCreateFormRequest>;
type PluginOpened = { opened: DocumentOpened };

/** Native methods exposed to the WebView; opaque target keys never cross it. */
export interface AndroidPluginContract {
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
}

export const native = registerPlugin<AndroidPluginContract>("Scpefe");

function opened(value: unknown): DocumentOpened {
  if (!value || typeof value !== "object") throw new TypeError("Invalid native document");
  const candidate = value as Partial<DocumentOpened>;
  if (candidate.readOnly !== true || candidate.canEdit !== false
      || typeof candidate.content !== "string"
      || new TextEncoder().encode(candidate.content).length > 1024 * 1024
      || !["plain-text", "csv"].includes(candidate.contentType ?? "")
      || candidate.publicationState !== "target-published") {
    throw new TypeError("Invalid native document");
  }
  return Object.freeze({ content: candidate.content, readOnly: true, canEdit: false,
    contentType: candidate.contentType,
    publicationState: "target-published", targetName: "Selected document" });
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

const unsupported = async (): Promise<never> => {
  throw Object.assign(new Error("This action is not available on Android yet."),
    { code: "OPERATION_FAILED" });
};

/** Shared-UI host, limited to profile and read-only admission in this issue. */
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
  updateWorkingCopy: async () => undefined,
  activity: async () => undefined,
  onLocked: () => () => {},
  onJournalWarning: () => () => {},
  onRegularSave: () => () => {},
  onExternalOpenRequested: () => () => {},
  onUnresolvedJournalSummary: () => () => {},
  onSwitchRetained: () => () => {},
  copyInvitationPassphrase: async () => false,
  enterEditMode: unsupported,
  cancelLeaseTakeover: unsupported,
  restoreRecoveredWork: unsupported,
  saveDocument: unsupported,
  saveDivergenceResolution: unsupported,
  reconnectPendingPublication: unsupported,
  discardPendingPublication: unsupported,
  discardRecoveredWork: unsupported,
  acceptHeadMismatch: unsupported,
  discardUnreadableJournal: unsupported,
  backupDocument: unsupported,
  exportPlaintext: unsupported,
} as unknown as SessionHost & ShellHost & CreationTargetHost & JournalTransportHost
  & SessionEventsHost & SecurityClipboardHost & {
    createDocument: NonNullable<SessionHost["createDocument"]>;
    assessPasswordPolicy(password: string): Promise<string> };
}

export const host = createHost(native);
