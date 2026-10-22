import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentSessionSnapshot, SessionDocument } from "@scpefe/frontend-core";
import { createShellCommands, type ShellCommand, type ShellCommandFacts } from "../src/shell/shell-commands.ts";

type Doc = SessionDocument;
function snapshot(kind: "edit" | "locked", adoption = 1,
  compact = true): DocumentSessionSnapshot<Doc> {
  const value = { kind, adoption, commands: { compact, save: true, enterEdit: true } };
  return value as unknown as DocumentSessionSnapshot<Doc>;
}

test("menu, shortcut and status callers share current eligibility and tracked invocation", async () => {
  let current = snapshot("edit");
  const facts: ShellCommandFacts = { activeAdoption: 1, profileReady: true,
    modalBusy: false };
  const calls: Array<[ShellCommand, HTMLElement | null]> = [];
  let tracked = 0;
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: async (command, focus) => { calls.push([command, focus]); },
    track: async (operation) => { tracked += 1; await operation(); } });
  const focus = {} as HTMLElement;
  const visible = current;
  assert.equal(commands.available("save"), true);
  assert.equal(commands.available("activity"), false);
  facts.activityAvailable = true;
  assert.equal(commands.available("activity"), true);
  assert.equal(await commands.invoke("save", { returnFocus: focus,
    observedSnapshot: visible }), true);
  assert.deepEqual(calls, [["save", focus]]);
  assert.equal(tracked, 1);

  facts.modalBusy = true;
  assert.equal(commands.available("save"), false);
  assert.equal(await commands.invoke("save", { observedSnapshot: visible }), false);
  facts.modalBusy = false;
  current = snapshot("edit", 2);
  assert.equal(await commands.invoke("save", { observedSnapshot: visible }), false,
    "an action rendered for an earlier adoption cannot act on its replacement");
  assert.equal(await commands.invoke("save"), false,
    "a status control cannot act on an adoption that has not reached the view");
  facts.activeAdoption = null;
  current = snapshot("locked", 2);
  assert.equal(commands.available("save"), false);
  assert.equal(commands.available("activity"), false);
  assert.equal(await commands.invoke("save"), false);
  assert.equal(tracked, 1);
});

test("File compaction follows current command eligibility and rejects stale menu state", async () => {
  let current = snapshot("edit");
  const facts: ShellCommandFacts = { activeAdoption: 1, profileReady: true,
    modalBusy: false };
  const calls: ShellCommand[] = [];
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: (command) => { calls.push(command); },
    track: async (operation) => { await operation(); } });
  const visible = current;
  assert.equal(commands.available("compact"), true);
  assert.equal(await commands.invoke("compact", { observedSnapshot: visible }), true);
  facts.modalBusy = true;
  assert.equal(commands.available("compact"), false);
  assert.equal(await commands.invoke("compact", { observedSnapshot: visible }), false);
  facts.modalBusy = false;
  current = snapshot("edit", 1, false);
  assert.equal(commands.available("compact"), false);
  assert.equal(await commands.invoke("compact"), false,
    "the session command result blocks compaction even when the File menu was open");
  current = snapshot("edit", 2);
  assert.equal(await commands.invoke("compact", { observedSnapshot: visible }), false);
  facts.activeAdoption = 2;
  assert.equal(await commands.invoke("compact", { observedSnapshot: visible }), false,
    "a menu item rendered for another adoption cannot act on the replacement");
  assert.equal(await commands.invoke("compact"), true);
  current = snapshot("locked", 2);
  assert.equal(commands.available("compact"), false);
  assert.deepEqual(calls, ["compact", "compact"]);
});

test("CSV table commands protect read-only presentation and reject invalid source", async () => {
  const make = (text: string) => ({ kind: "edit", adoption: 1,
    document: { contentType: "csv" }, working: { text },
    commands: { undo: true, redo: true, write: true } }) as unknown as
    DocumentSessionSnapshot<Doc>;
  let current = make("heading\nvalue");
  const facts: ShellCommandFacts = { activeAdoption: 1, profileReady: true,
    modalBusy: false, csvView: "table" };
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: () => {}, track: async (operation) => { await operation(); } });
  assert.equal(commands.available("show-csv-source"), true);
  assert.equal(commands.available("show-table"), false);
  assert.equal(commands.available("undo"), false);
  assert.equal(commands.available("redo"), false);
  assert.equal(commands.available("find"), true);
  assert.equal(commands.available("replace"), false);
  facts.csvView = "source";
  assert.equal(commands.available("show-table"), true);
  assert.equal(commands.available("undo"), true);
  assert.equal(commands.available("replace"), true);
  current = make("heading\n\"unterminated");
  assert.equal(commands.available("show-table"), false);
  current = { ...make("heading\nvalue"), kind: "read-only",
    commands: { write: false } } as unknown as DocumentSessionSnapshot<Doc>;
  assert.equal(commands.available("replace"), true);
  assert.equal(commands.available("show-table"), true);
  current = { ...make("heading\nvalue"),
    publication: { state: "conflict", resolving: true } } as unknown as
    DocumentSessionSnapshot<Doc>;
  assert.equal(commands.available("show-table"), false,
    "CSV conflict repair stays in source view even when the draft parses");
  current = snapshot("locked");
  assert.equal(commands.available("show-csv-source"), false);
  assert.equal(commands.available("show-table"), false);
});

test("Table structure availability follows focused row, column, and write mode", () => {
  const make = (text: string, kind: "edit" | "read-only" = "edit") => ({
    kind, adoption: 1, document: { contentType: "csv" }, working: { text },
    commands: { write: kind === "edit" },
  }) as unknown as DocumentSessionSnapshot<Doc>;
  let current = make("name,age\nAda,36");
  const facts: ShellCommandFacts = { activeAdoption: 1, profileReady: true,
    modalBusy: false, csvView: "table", tableFocus: null };
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: () => {}, track: async (operation) => { await operation(); } });
  const available = (values: ShellCommand[]) => values.map((command) =>
    commands.available(command));
  const row = ["add-row-above", "add-row-below", "delete-row"] as ShellCommand[];
  const column = ["add-column-left", "add-column-right", "delete-column"] as ShellCommand[];
  assert.deepEqual(available([...row, ...column]), [false, false, false,
    false, false, false], "no focus");
  facts.tableFocus = { row: 0, column: 0 };
  assert.deepEqual(available(row), [false, true, false], "heading");
  assert.deepEqual(available(column), [true, true, true]);
  facts.tableFocus = { row: 1, column: 1 };
  assert.deepEqual(available(row), [true, true, true], "data row");
  facts.tableFocus = { row: 2, column: 1 };
  assert.deepEqual(available(row), [false, false, false], "insertion row");
  assert.deepEqual(available(column), [true, true, true]);
  current = make("only");
  facts.tableFocus = { row: 0, column: 0 };
  assert.deepEqual(available(column), [true, true, false], "final column");
  current = make("name,age\nAda,36", "read-only");
  assert.deepEqual(available([...row, ...column]), [false, false, false,
    false, false, false], "read-only");
  current = make("name,age\ninvalid");
  assert.deepEqual(available([...row, ...column]), [false, false, false,
    false, false, false], "invalid CSV");
  current = make("name,age\nAda,36");
  facts.csvView = "source";
  assert.deepEqual(available([...row, ...column]), [false, false, false,
    false, false, false], "source view");
});
