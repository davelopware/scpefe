import React, { useEffect, useRef, useState } from "react";
import type { DocumentSessionSnapshot, SessionDocument, SnapshotSource } from "@scpefe/frontend-core";
import { useSessionSnapshot } from "../use-session-snapshot.ts";

const menuDefinitions: Array<[string, Array<[string, string, string?] | null>]> = [
  ["File", [["new", "New", "Ctrl+N"], ["open", "Open…", "Ctrl+O"], null,
    ["save", "Save", "Ctrl+S"], ["backup", "Backup…"],
    ["export", "Export Plaintext…"], null, ["close", "Close", "Ctrl+W"],
    ["exit", "Exit"]]],
  ["Edit", [["edit", "Edit Contents"], null, ["undo", "Undo", "Ctrl+Z"],
    ["redo", "Redo", "Ctrl+Y"], null, ["find", "Find…", "Ctrl+F"],
    ["replace", "Replace…", "Ctrl+H"]]],
  ["Security", [["lock", "Lock"], ["unlock", "Unlock"], null,
    ["passwords", "Passwords…"],
    ["profile", "Profile…"]]],
];

/** Projects command eligibility from the same session snapshot as the editor. */
export function MenuBar<Doc extends SessionDocument>({ session, active, profileReady,
  blocked, run }: {
  session: SnapshotSource<DocumentSessionSnapshot<Doc>>;
  active: boolean;
  profileReady: boolean;
  blocked: boolean;
  run(command: string, returnFocus: HTMLElement | null): void }) {
  const snapshot = useSessionSnapshot(session);
  const locked = snapshot.kind === "locked";
  const commands = snapshot.kind === "read-only" || snapshot.kind === "edit"
    ? snapshot.commands : null;
  const enabled: Record<string, boolean> = {
    new: profileReady, open: profileReady,
    save: active && snapshot.kind === "edit" && commands?.save === true,
    backup: active && commands?.backup === true,
    export: active && commands?.export === true,
    close: active || locked, exit: true,
    edit: active && snapshot.kind === "read-only" && commands?.enterEdit === true,
    undo: active && snapshot.kind === "edit" && commands?.undo === true,
    redo: active && snapshot.kind === "edit" && commands?.redo === true,
    find: active, replace: active,
    lock: active, unlock: locked,
    passwords: active, profile: profileReady,
  };
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)
        || event.altKey || blocked) return;
      const shortcuts: Record<string, string> = { n: "new", o: "open", s: "save",
        w: "close", z: "undo", y: "redo", f: "find", h: "replace" };
      const command = shortcuts[event.key.toLowerCase()];
      if (command && enabled[command]) {
        event.preventDefault();
        run(command, document.activeElement as HTMLElement | null);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const [open, setOpen] = useState<string | null>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const menus = useRef<Record<string, HTMLDivElement | null>>({});
  const focusFirst = (name: string) => requestAnimationFrame(() =>
    menus.current[name]?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  const openMenu = (name: string) => { setOpen(name); focusFirst(name); };
  useEffect(() => {
    const accessKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey
        || document.querySelector(".shell-chrome")?.hasAttribute("inert")) return;
      const match = menuDefinitions.find(([name]) =>
        name[0].toLowerCase() === event.key.toLowerCase());
      if (!match) return;
      event.preventDefault(); openMenu(match[0]);
    };
    window.addEventListener("keydown", accessKey);
    return () => window.removeEventListener("keydown", accessKey);
  }, []);
  return <nav className="menu-bar" role="menubar" aria-label="Application menu">
    {menuDefinitions.map(([name, items], menuIndex) => <div className="menu" key={name}>
      <button type="button" role="menuitem" aria-label={name} aria-haspopup="menu"
        aria-expanded={open === name} ref={(node) => { triggers.current[name] = node; }}
        onClick={() => open === name ? setOpen(null) : openMenu(name)}
        onKeyDown={(event) => {
          if (["ArrowDown", "Enter", " "].includes(event.key)) {
            event.preventDefault(); openMenu(name);
          } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const offset = event.key === "ArrowRight" ? 1 : menuDefinitions.length - 1;
            const next = menuDefinitions[(menuIndex + offset) % menuDefinitions.length][0];
            if (open !== null) { setOpen(next); focusFirst(next); }
            triggers.current[next]?.focus();
          }
        }}><u>{name[0]}</u>{name.slice(1)}</button>
      {open === name && <div role="menu" aria-label={name}
        ref={(node) => { menus.current[name] = node; }} onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault(); setOpen(null); triggers.current[name]?.focus(); return;
          }
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const offset = event.key === "ArrowRight" ? 1 : menuDefinitions.length - 1;
            const next = menuDefinitions[(menuIndex + offset) % menuDefinitions.length][0];
            setOpen(next); triggers.current[next]?.focus(); focusFirst(next); return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)")];
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const offset = event.key === "ArrowDown" ? 1 : buttons.length - 1;
            buttons[(Math.max(at, 0) + offset) % buttons.length]?.focus();
          }
        }}>{items.map((item, index) => item === null
          ? <hr key={index} role="separator" />
          : <button key={item[0]} type="button" role="menuitem"
            disabled={!enabled[item[0]]} onClick={() => {
              const returnFocus = triggers.current[name];
              returnFocus?.focus(); setOpen(null);
              if (returnFocus) run(item[0], returnFocus);
              requestAnimationFrame(() => {
                if (!document.querySelector('[role="dialog"]')) triggers.current[name]?.focus();
              });
            }}><span>{item[1]}</span>{item[2] && <kbd>{item[2]}</kbd>}</button>)}</div>}
    </div>)}</nav>;
}
