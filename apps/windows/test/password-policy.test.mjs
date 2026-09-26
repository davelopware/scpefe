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
    dom.window.scpefe = { assessPasswordPolicy: async (password) =>
      password === "short" || password === "native minimum override words"
        || password === "ééééé"
        ? "minimum-length"
        : password === "strong passphrase with unrelated private words 2026!"
          || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(password) ? "accepted" : "predictable" };
    const React = (await import("react")).default;
    const { cleanup, render, within } = await import("@testing-library/react");
    const { assessProposedPassword, PasswordPolicyStatus } = await import(
      "../src/password-policy.mjs");
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
      assert.match(ui.getByText(/sufficiently long|SCPEFE will generate/).textContent,
        id === "manual-invitation" ? /generate/ : /sufficiently long/);
      rendered.unmount();
    }

    assert.deepEqual(await assessProposedPassword("   "), { status: "empty" });
    assert.deepEqual(await assessProposedPassword("short"), {
      status: "rejected", reason: "minimum-length",
    });
    assert.deepEqual(await assessProposedPassword("native minimum override words"), {
      status: "rejected", reason: "minimum-length",
    }, "renderer uses the native reason without encoding the threshold");
    assert.deepEqual(await assessProposedPassword("ééééé"), {
      status: "rejected", reason: "minimum-length",
    }, "multibyte classification comes from the native assessment");
    assert.deepEqual(await assessProposedPassword("  passwordpassword  "), {
      status: "rejected", reason: "predictable",
    });
    assert.deepEqual(await assessProposedPassword(
      "  strong passphrase with unrelated private words 2026!  "), {
      status: "accepted",
      password: "strong passphrase with unrelated private words 2026!",
    });
    const authoritative = dom.window.scpefe.assessPasswordPolicy;
    dom.window.scpefe.assessPasswordPolicy = async () => { throw new Error("offline"); };
    assert.deepEqual(await assessProposedPassword("strong passphrase words"), {
      status: "unavailable",
    });
    dom.window.scpefe.assessPasswordPolicy = authoritative;

    const cases = [
      ["short", /too short/],
      ["passwordpassword", /too predictable/],
      ["00000000-0000-1000-8000-000000000000", /too predictable/],
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
