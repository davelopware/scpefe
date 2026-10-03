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
    modalBusy: false, passwordsDialogActive: false, passwordsOpening: 0 };
  const calls: Array<[ShellCommand, HTMLElement | null]> = [];
  let tracked = 0;
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: async (command, focus) => { calls.push([command, focus]); },
    track: async (operation) => { tracked += 1; await operation(); } });
  const focus = {} as HTMLElement;
  const visible = current;
  assert.equal(commands.available("save"), true);
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
  assert.equal(await commands.invoke("save"), false);
  assert.equal(tracked, 1);
});

test("only active Passwords may request currently eligible compaction", async () => {
  let current = snapshot("edit");
  const facts: ShellCommandFacts = { activeAdoption: 1, profileReady: true,
    modalBusy: true, passwordsDialogActive: true, passwordsOpening: 1 };
  const calls: ShellCommand[] = [];
  const commands = createShellCommands({ session: { getSnapshot: () => current,
    subscribe: () => () => {} }, facts: () => facts,
    run: (command) => { calls.push(command); },
    track: async (operation) => { await operation(); } });
  const visible = current;
  const openingA = { kind: "passwords" as const, opening: 1 };
  assert.equal(commands.available("compact"), false);
  assert.equal(commands.available("compact", openingA), true);
  assert.equal(await commands.invoke("save", { origin: openingA }), false);
  assert.equal(await commands.invoke("compact", { origin: openingA,
    observedSnapshot: visible }), true);
  facts.passwordsDialogActive = false;
  assert.equal(await commands.invoke("compact", { origin: openingA }), false);
  facts.passwordsDialogActive = true;
  facts.passwordsOpening = 2;
  assert.equal(await commands.invoke("compact", { origin: openingA,
    observedSnapshot: visible }), false,
    "a callback from the previous Passwords opening cannot act in the next one");
  const openingB = { kind: "passwords" as const, opening: 2 };
  assert.equal(await commands.invoke("compact", { origin: openingB,
    observedSnapshot: visible }), true);
  current = snapshot("edit", 1, false);
  assert.equal(await commands.invoke("compact", { origin: openingB }), false,
    "a changed session command result blocks the open dialog control");
  current = snapshot("edit", 2);
  assert.equal(await commands.invoke("compact", { origin: openingB,
    observedSnapshot: visible }), false);
  facts.passwordsDialogActive = false;
  assert.equal(await commands.invoke("compact", { origin: openingB }), false);
  assert.deepEqual(calls, ["compact", "compact"]);
});
