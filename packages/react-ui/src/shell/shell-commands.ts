import type { DocumentSessionSnapshot, SessionDocument, SnapshotSource } from "@scpefe/frontend-core";

/** Commands exposed by the shared shell, including the current Passwords trigger. */
export type ShellCommand = "new" | "open" | "save" | "backup" | "export" | "close"
  | "exit" | "edit" | "undo" | "redo" | "find" | "replace" | "lock"
  | "unlock" | "passwords" | "profile" | "compact";

/** The Passwords origin permits only its existing compaction control. */
export type CommandOrigin = "shell" | "passwords";

/** Presentation facts read at invocation rather than stored as command state. */
export interface ShellCommandFacts {
  activeAdoption: number | null;
  profileReady: boolean;
  modalBusy: boolean;
  passwordsDialogActive: boolean;
}

/** One eligibility and invocation path for menus, shortcuts, status and Passwords. */
export interface ShellCommands<Doc extends SessionDocument> {
  available(command: ShellCommand, origin?: CommandOrigin): boolean;
  invoke(command: ShellCommand, options?: {
    origin?: CommandOrigin;
    returnFocus?: HTMLElement | null;
    observedSnapshot?: DocumentSessionSnapshot<Doc>;
  }): Promise<boolean>;
}

/** Binds current session eligibility to React's modal, focus and completion behavior. */
export function createShellCommands<Doc extends SessionDocument>({ session, facts,
  run, track }: {
  session: SnapshotSource<DocumentSessionSnapshot<Doc>>;
  facts(): ShellCommandFacts;
  run(command: ShellCommand, returnFocus: HTMLElement | null): void | Promise<void>;
  track(operation: () => void | Promise<void>): Promise<void>;
}): ShellCommands<Doc> {
  function available(command: ShellCommand, origin: CommandOrigin = "shell") {
    const view = facts();
    if (origin === "passwords") {
      if (command !== "compact" || !view.passwordsDialogActive) return false;
    } else if (view.modalBusy) return false;
    const snapshot = session.getSnapshot();
    const active = (snapshot.kind === "read-only" || snapshot.kind === "edit")
      && snapshot.adoption === view.activeAdoption;
    const commands = active ? snapshot.commands : null;
    switch (command) {
      case "new": case "open": case "profile": return view.profileReady;
      case "exit": return true;
      case "close": return active || snapshot.kind === "locked";
      case "unlock": return snapshot.kind === "locked";
      case "save": return active && commands?.save === true;
      case "backup": return active && commands?.backup === true;
      case "export": return active && commands?.export === true;
      case "edit": return active && commands?.enterEdit === true;
      case "undo": return active && commands?.undo === true;
      case "redo": return active && commands?.redo === true;
      case "compact": return active && commands?.compact === true;
      case "find": case "replace": case "lock": case "passwords": return active;
    }
  }
  return {
    available,
    async invoke(command, options = {}) {
      if (options.observedSnapshot && options.observedSnapshot !== session.getSnapshot()) return false;
      if (!available(command, options.origin)) return false;
      await track(() => run(command, options.returnFocus ?? null));
      return true;
    },
  };
}
