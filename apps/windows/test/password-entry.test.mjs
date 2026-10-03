import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import "../scripts/register-frontend-typescript.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://scpefe.invalid/",
});
const installed = ["window", "document", "HTMLElement", "Node",
  "MutationObserver", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame"];
const previous = new Map(installed.map((key) =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => { callback(); return 1; } });

const React = (await import("react")).default;
const { act, cleanup, render } = await import("@testing-library/react");
const userEvent = (await import("@testing-library/user-event")).default;
const { usePasswordEntry, clearMountedPasswordFields } = await import(
  "@scpefe/react-ui");

after(() => {
  cleanup();
  assert.equal(dom.window.document.body.children.length, 0);
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("password-entry interface keeps independent fields, focus, and selected candidates", async (t) => {
  let entry;
  function Harness() {
    entry = usePasswordEntry(["current", "new", "confirmation", "temporary"]);
    return React.createElement("form", null,
      ...["current", "new", "confirmation", "temporary"].map((name) =>
        React.createElement("label", { key: name }, name,
          React.createElement("input", { ...entry.field(name), name }))));
  }
  const rendered = render(React.createElement(Harness));
  t.after(() => { rendered.unmount(); cleanup(); });
  const user = userEvent.setup({ document: dom.window.document });
  const field = (name) => rendered.getByLabelText(name);

  await user.type(field("current"), "existing secret");
  await user.type(field("new"), "first draft");
  field("new").focus();
  act(() => entry.toggle("new"));
  assert.equal(field("new").type, "text");
  assert.equal(field("confirmation").type, "password");
  assert.equal(field("new").value, "first draft");
  assert.equal(dom.window.document.activeElement === field("new"), true);
  assert.equal(field("new").getAttribute("data-password-entry"), "new");

  act(() => entry.replace("new", "fixed test candidate", "confirmation"));
  assert.equal(field("new").value, "fixed test candidate");
  assert.equal(field("confirmation").value, "fixed test candidate");
  assert.equal(field("current").value, "existing secret");
  assert.equal(field("temporary").value, "");
  act(() => entry.replace("temporary", "fixed temporary candidate"));
  assert.equal(field("temporary").value, "fixed temporary candidate");
  assert.equal(field("new").value, "fixed test candidate");

  clearMountedPasswordFields();
  assert.equal(field("new").value, "", "revealed secret clears at lock boundary");
  assert.equal(field("current").value, "");
  act(() => entry.reset());
  assert.deepEqual(["current", "new", "confirmation", "temporary"].map(
    (name) => field(name).value), ["", "", "", ""]);
  assert.equal(field("new").type, "password");
});
