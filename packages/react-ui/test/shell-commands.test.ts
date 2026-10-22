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
  current = snapshot("locked");
  assert.equal(commands.available("show-csv-source"), false);
  assert.equal(commands.available("show-table"), false);
});
