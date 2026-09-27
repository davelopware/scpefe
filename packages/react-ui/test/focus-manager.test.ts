import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { FocusManager, type FocusDomCapability } from "../src/focus-manager.ts";

class DeterministicDom implements FocusDomCapability {
  readonly document: Document;
  private readonly frames = new Set<() => void>();

  constructor(document: Document) { this.document = document; }

  schedule(callback: () => void): () => void {
    this.frames.add(callback);
    return () => { this.frames.delete(callback); };
  }

  flush(): void {
    const frames = [...this.frames];
    this.frames.clear();
    for (const callback of frames) callback();
  }

  get pendingFrames(): number { return this.frames.size; }
}

test("nested scopes keep chrome inert until the final release and restore focus in order", (t) => {
  const dom = new JSDOM(`<button id="launch">Launch</button>
    <main class="shell-chrome"></main>
    <section id="outer"><button id="outer-action">Outer</button></section>
    <section id="inner"><button id="inner-action">Inner</button></section>`,
  { url: "https://scpefe.invalid/" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const host = new DeterministicDom(document);
  const manager = new FocusManager(host);
  const launch = document.getElementById("launch") as HTMLElement;
  const chrome = document.querySelector(".shell-chrome") as HTMLElement;
  const outerRoot = document.getElementById("outer") as HTMLElement;
  const innerRoot = document.getElementById("inner") as HTMLElement;
  const outerAction = document.getElementById("outer-action") as HTMLElement;
  const innerAction = document.getElementById("inner-action") as HTMLElement;

  launch.focus();
  const outer = manager.acquire({ scope: outerRoot, chrome });
  assert.equal(manager.modalDepth, 1);
  assert.equal(chrome.hasAttribute("inert"), true);
  assert.equal(document.activeElement, outerAction);

  const inner = manager.acquire({ scope: innerRoot, chrome });
  assert.equal(manager.modalDepth, 2);
  assert.equal(document.activeElement, innerAction);
  inner.release();
  host.flush();
  assert.equal(manager.modalDepth, 1);
  assert.equal(chrome.hasAttribute("inert"), true);
  assert.equal(document.activeElement, outerAction);

  outer.release();
  host.flush();
  assert.equal(manager.modalDepth, 0);
  assert.equal(chrome.hasAttribute("inert"), false);
  assert.equal(document.activeElement, launch);
  assert.equal(host.pendingFrames, 0);
});

test("Tab stays within the top scope and Escape follows the caller policy", (t) => {
  const dom = new JSDOM(`<button id="launch">Launch</button>
    <section id="dialog" tabindex="-1">
      <button id="first">First</button><button id="last">Last</button>
      <input id="hidden" type="hidden" value="private" />
    </section>`, { url: "https://scpefe.invalid/" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const host = new DeterministicDom(document);
  const manager = new FocusManager(host);
  const launch = document.getElementById("launch") as HTMLElement;
  const root = document.getElementById("dialog") as HTMLElement;
  const first = document.getElementById("first") as HTMLElement;
  const last = document.getElementById("last") as HTMLElement;
  launch.focus();
  const scope = manager.acquire({ scope: root, initialFocus: last });
  assert.equal(document.activeElement, last);

  const key = (name: string, shiftKey = false) => {
    let prevented = false;
    return { key: name, shiftKey, preventDefault: () => { prevented = true; },
      get prevented() { return prevented; } };
  };
  const forward = key("Tab");
  scope.handleKeyDown(forward);
  assert.equal(forward.prevented, true);
  assert.equal(document.activeElement, first);
  const backward = key("Tab", true);
  scope.handleKeyDown(backward);
  assert.equal(backward.prevented, true);
  assert.equal(document.activeElement, last);

  let escapes = 0;
  const ignored = key("Escape");
  scope.handleKeyDown(ignored);
  assert.equal(ignored.prevented, false);
  const handled = key("Escape");
  scope.handleKeyDown(handled, () => { escapes += 1; });
  assert.equal(handled.prevented, true);
  assert.equal(escapes, 1);
  scope.release();
  host.flush();
  assert.equal(document.activeElement, launch);
});

test("out-of-order nested cleanup restores the original launcher", (t) => {
  const dom = new JSDOM(`<button id="launch">Launch</button>
    <main class="shell-chrome"></main>
    <section id="outer"><button>Outer</button></section>
    <section id="inner"><button>Inner</button></section>`,
  { url: "https://scpefe.invalid/" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const host = new DeterministicDom(document);
  const manager = new FocusManager(host);
  const launch = document.getElementById("launch") as HTMLElement;
  const outerRoot = document.getElementById("outer") as HTMLElement;
  const innerRoot = document.getElementById("inner") as HTMLElement;
  const chrome = document.querySelector(".shell-chrome") as HTMLElement;
  launch.focus();
  const outer = manager.acquire({ scope: outerRoot, chrome });
  const inner = manager.acquire({ scope: innerRoot, chrome });
  outer.release();
  outerRoot.remove();
  assert.equal(chrome.hasAttribute("inert"), true);
  inner.release();
  host.flush();
  assert.equal(manager.modalDepth, 0);
  assert.equal(chrome.hasAttribute("inert"), false);
  assert.equal(document.activeElement, launch);
  outer.release();
  inner.release();
  assert.equal(host.pendingFrames, 0);
});

test("empty scopes contain Tab, use a safe fallback, and can suppress restoration", (t) => {
  const dom = new JSDOM(`<button id="launch">Launch</button>
    <main class="shell-chrome" inert></main>
    <section id="dialog" tabindex="-1">No controls</section>
    <button id="fallback">Fallback</button>`,
  { url: "https://scpefe.invalid/" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const host = new DeterministicDom(document);
  const manager = new FocusManager(host);
  const launch = document.getElementById("launch") as HTMLElement;
  const root = document.getElementById("dialog") as HTMLElement;
  const fallback = document.getElementById("fallback") as HTMLElement;
  const chrome = document.querySelector(".shell-chrome") as HTMLElement;
  launch.focus();
  const scope = manager.acquire({ scope: root, chrome,
    fallbackFocus: () => fallback });
  assert.equal(document.activeElement, root);
  let prevented = false;
  scope.handleKeyDown({ key: "Tab", shiftKey: true,
    preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, root);

  launch.remove();
  scope.release();
  host.flush();
  assert.equal(document.activeElement, fallback);
  assert.equal(chrome.hasAttribute("inert"), true,
    "a preexisting inert state is retained");

  const completed = manager.acquire({ scope: root, chrome });
  assert.equal(document.activeElement, root);
  completed.release({ restoreFocus: false });
  host.flush();
  assert.equal(document.activeElement, root);
  assert.equal(host.pendingFrames, 0);
  assert.equal(chrome.hasAttribute("inert"), true);
});
