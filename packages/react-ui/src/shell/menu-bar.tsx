import React, { useEffect, useRef, useState } from "react";
import type { DocumentSessionSnapshot, SessionDocument } from "@scpefe/frontend-core";
import type { ShellCommand, ShellCommands } from "./shell-commands.ts";

const menuDefinitions: Array<[string, Array<[ShellCommand, string, string?] | null>]> = [
  ["File", [["new", "New", "Ctrl+N"], ["open", "Open…", "Ctrl+O"], null,
    ["save", "Save", "Ctrl+S"], ["backup", "Backup…"],
    ["export", "Export Plaintext…"], ["compact", "History Compaction…"], null,
    ["close", "Close", "Ctrl+W"],
    ["exit", "Exit"]]],
  ["Edit", [["edit", "Edit Contents"], null, ["undo", "Undo", "Ctrl+Z"],
    ["redo", "Redo", "Ctrl+Y"], null, ["find", "Find…", "Ctrl+F"],
    ["replace", "Replace…", "Ctrl+H"]]],
  ["Security", [["lock", "Lock"], ["unlock", "Unlock"], null,
    ["passwords", "Passwords…"],
    ["profile", "Profile…"]]],
  ["Help", [["about", "About"]]],
];

/** Presents shell commands without owning their eligibility or dispatch. */
export function MenuBar<Doc extends SessionDocument>({ snapshot, commands }: {
  snapshot: DocumentSessionSnapshot<Doc>;
  commands: ShellCommands<Doc> }) {
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)
        || event.altKey) return;
      const shortcuts: Record<string, ShellCommand> = { n: "new", o: "open", s: "save",
        w: "close", z: "undo", y: "redo", f: "find", h: "replace" };
      const command = shortcuts[event.key.toLowerCase()];
      if (command && commands.available(command)) {
        event.preventDefault();
        void commands.invoke(command, { returnFocus: document.activeElement as HTMLElement | null,
          observedSnapshot: snapshot });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const menus = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (open === null) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !bar.current?.contains(event.target)) {
        setOpen(null);
      }
    };
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [open]);
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
  return <nav className="menu-bar" role="menubar" aria-label="Application menu" ref={bar}>
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
            disabled={!commands.available(item[0])} onClick={() => {
              const returnFocus = triggers.current[name];
              returnFocus?.focus(); setOpen(null);
              if (returnFocus) void commands.invoke(item[0], { returnFocus,
                observedSnapshot: snapshot });
              requestAnimationFrame(() => {
                if (!document.querySelector('[role="dialog"]')) triggers.current[name]?.focus();
              });
            }}><span>{item[1]}</span>{item[2] && <kbd>{item[2]}</kbd>}</button>)}</div>}
    </div>)}</nav>;
}
