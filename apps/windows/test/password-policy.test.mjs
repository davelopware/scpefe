import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("all new-password workflows expose the shared policy and live authoritative result",
  async (t) => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://scpefe.invalid/",
    });
    const prior = new Map(["window", "document", "HTMLElement", "Node",
      "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, { window: dom.window, document: dom.window.document,
      HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
    dom.window.scpefe = { passwordMeetsPolicy: async (password) =>
      password === "strong passphrase with unrelated private words 2026!"
      || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(password) };
    const React = (await import("react")).default;
    const { cleanup, render, within } = await import("@testing-library/react");
    const { PasswordPolicyStatus } = await import("../src/password-policy.mjs");
    t.after(() => {
      cleanup(); dom.window.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });

    const workflows = ["creation", "change", "manual-invitation", "claim"];
    for (const id of workflows) {
      const rendered = render(React.createElement(PasswordPolicyStatus,
        { id, password: "", confirmation: id === "manual-invitation" ? undefined : "",
          optionalBlankGenerates: id === "manual-invitation" }));
      const ui = within(rendered.container);
      assert.match(ui.getByText(/at least 12|SCPEFE will generate/).textContent,
        id === "manual-invitation" ? /generate/ : /at least 12/);
      rendered.unmount();
    }

    const cases = [
      ["short", /at least 12/],
      ["passwordpassword", /less predictable/],
      ["00000000-0000-1000-8000-000000000000", /less predictable/],
      ["550E8400-E29B-41D4-A716-446655440000", /Meets password requirements/],
      ["strong passphrase with unrelated private words 2026!", /Meets password requirements/],
    ];
    for (const [password, expected] of cases) {
      const rendered = render(React.createElement(PasswordPolicyStatus,
        { id: "candidate", password, confirmation: password }));
      assert.match((await within(rendered.container).findByText(expected)).textContent,
        expected);
      rendered.unmount();
    }
  });
