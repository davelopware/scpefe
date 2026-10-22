import type { DocumentSessionSnapshot, SessionDocument, SnapshotSource } from "@scpefe/frontend-core";
import { parseCsvSource } from "@scpefe/frontend-core";

/** Commands exposed by the shared shell. */
export type ShellCommand = "new" | "open" | "save" | "backup" | "export" | "close"
  | "exit" | "edit" | "undo" | "redo" | "find" | "replace" | "lock"
  | "unlock" | "passwords" | "profile" | "compact" | "about" | "activity"
  | "show-csv-source" | "show-table" | CsvStructureCommand;

/** Structural edits available from the CSV Table menu. */
export type CsvStructureCommand = "add-row-above" | "add-row-below" | "delete-row"
  | "add-column-left" | "add-column-right" | "delete-column";

const csvStructureCommands = new Set<ShellCommand>(["add-row-above", "add-row-below",
  "delete-row", "add-column-left", "add-column-right", "delete-column"]);

/** Identifies the commands dispatched to the active CSV table. */
export function isCsvStructureCommand(command: ShellCommand): command is CsvStructureCommand {
  return csvStructureCommands.has(command);
}

/** Presentation facts read at invocation rather than stored as command state. */
export interface ShellCommandFacts {
  activeAdoption: number | null;
  profileReady: boolean;
  modalBusy: boolean;
  activityAvailable?: boolean;
  csvView?: "source" | "table";
  tableFocus?: { row: number; column: number } | null;
}

/** One eligibility and invocation path for menus, shortcuts and status. */
export interface ShellCommands<Doc extends SessionDocument> {
  available(command: ShellCommand): boolean;
  invoke(command: ShellCommand, options?: {
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
  function available(command: ShellCommand) {
    const view = facts();
    if (view.modalBusy) return false;
    const snapshot = session.getSnapshot();
    const active = (snapshot.kind === "read-only" || snapshot.kind === "edit")
      && snapshot.adoption === view.activeAdoption;
    const commands = active ? snapshot.commands : null;
    const csv = active && snapshot.document?.contentType === "csv";
    const table = csv && view.csvView === "table";
    const parsed = table && isCsvStructureCommand(command)
      ? parseCsvSource(snapshot.working.text) : null;
    const focus = view.tableFocus;
    const structure = snapshot.kind === "edit" && commands?.write === true
      && parsed?.valid === true && focus !== null && focus !== undefined
      && Number.isInteger(focus.row) && Number.isInteger(focus.column)
      && focus.row >= 0 && focus.row <= parsed.rows.length
      && focus.column >= 0 && focus.column < parsed.rows[0].length;
    switch (command) {
      case "new": case "open": case "profile": return view.profileReady;
      case "exit": case "about": return true;
      case "close": return active || snapshot.kind === "locked";
      case "unlock": return snapshot.kind === "locked";
      case "save": return active && commands?.save === true;
      case "backup": return active && commands?.backup === true;
      case "export": return active && commands?.export === true;
      case "edit": return active && commands?.enterEdit === true;
      case "undo": return active && !table && commands?.undo === true;
      case "redo": return active && !table && commands?.redo === true;
      case "show-csv-source": return csv && table;
      case "show-table": return csv && !table
        && parseCsvSource(snapshot.working.text).valid;
      case "add-row-above": case "delete-row":
        return structure && focus!.row > 0 && focus!.row < parsed!.rows.length;
      case "add-row-below": return structure && focus!.row < parsed!.rows.length;
      case "add-column-left": case "add-column-right": return structure;
      case "delete-column": return structure && parsed!.rows[0].length > 1;
      case "compact": return active && commands?.compact === true;
      case "activity": return active && view.activityAvailable === true;
      case "find": return active;
      case "replace": return active && !table;
      case "lock": case "passwords": return active;
    }
  }
  return {
    available,
    async invoke(command, options = {}) {
      if (options.observedSnapshot && options.observedSnapshot !== session.getSnapshot()) return false;
      if (!available(command)) return false;
      await track(() => run(command, options.returnFocus ?? null));
      return true;
    },
  };
}
