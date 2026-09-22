import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://scpefe.invalid/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactModule = await import("react");
const React = ReactModule.default;
const { Fragment, useState } = ReactModule;
const { cleanup, render, within } = await import("@testing-library/react");
const userEvent = (await import("@testing-library/user-event")).default;
const { PasswordConfirmationFields } = await import(
  "../src/creation-security-controls.mjs");

function CreationSecurityFields() {
  const [ownerRevealed, setOwnerRevealed] = useState(false);
  const [recoveryRevealed, setRecoveryRevealed] = useState(false);
  return React.createElement(Fragment, null,
    React.createElement(PasswordConfirmationFields, {
      kind: "owner", label: "Owner password",
      confirmationLabel: "Confirm owner password",
      revealed: ownerRevealed, required: true,
      onToggle: () => setOwnerRevealed((revealed) => !revealed),
    }),
    React.createElement(PasswordConfirmationFields, {
      kind: "recovery", label: "Recovery password",
      confirmationLabel: "Confirm recovery password",
      revealed: recoveryRevealed, required: false,
      onToggle: () => setRecoveryRevealed((revealed) => !revealed),
    }));
}

test("mounted password pairs reveal independently and retain entered secrets", async (t) => {
  t.after(cleanup);
  const user = userEvent.setup({ document: dom.window.document });
  const { container } = render(React.createElement(CreationSecurityFields));
  const ui = within(container);
  const owner = ui.getByLabelText("Owner password");
  const ownerConfirmation = ui.getByLabelText("Confirm owner password");
  const recovery = ui.getByLabelText("Recovery password");
  const recoveryConfirmation = ui.getByLabelText("Confirm recovery password");
  const inputs = [owner, ownerConfirmation, recovery, recoveryConfirmation];

  for (const input of inputs) assert.equal(input.type, "password");
  let ownerToggle = ui.getByRole("button", { name: "Show owner passwords" });
  let recoveryToggle = ui.getByRole("button", { name: "Show recovery passwords" });
  assert.equal(ownerToggle.getAttribute("aria-pressed"), "false");
  assert.equal(recoveryToggle.getAttribute("aria-pressed"), "false");

  const ownerSecret = "owner secret words";
  const recoverySecret = "independent recovery words";
  await user.type(owner, ownerSecret);
  await user.type(ownerConfirmation, ownerSecret);
  await user.type(recovery, recoverySecret);
  await user.type(recoveryConfirmation, recoverySecret);

  ownerToggle.focus();
  assert.equal(dom.window.document.activeElement === ownerToggle, true,
    "the owner visibility toggle receives focus");
  await user.keyboard("{Enter}");
  ownerToggle = ui.getByRole("button", { name: "Hide owner passwords" });
  recoveryToggle = ui.getByRole("button", { name: "Show recovery passwords" });
  assert.equal(ownerToggle.getAttribute("aria-pressed"), "true");
  assert.equal(recoveryToggle.getAttribute("aria-pressed"), "false");
  assert.equal(owner.type, "text");
  assert.equal(ownerConfirmation.type, "text");
  assert.equal(recovery.type, "password");
  assert.equal(recoveryConfirmation.type, "password");
  assert.equal(owner.value, ownerSecret);
  assert.equal(ownerConfirmation.value, ownerSecret);
  assert.equal(recovery.value, recoverySecret);
  assert.equal(recoveryConfirmation.value, recoverySecret);

  await user.click(recoveryToggle);
  recoveryToggle = ui.getByRole("button", { name: "Hide recovery passwords" });
  assert.equal(recoveryToggle.getAttribute("aria-pressed"), "true");
  assert.equal(recovery.type, "text");
  assert.equal(recoveryConfirmation.type, "text");
  assert.equal(owner.type, "text");

  ownerToggle.focus();
  await user.keyboard(" ");
  ownerToggle = ui.getByRole("button", { name: "Show owner passwords" });
  assert.equal(ownerToggle.getAttribute("aria-pressed"), "false");
  assert.equal(owner.type, "password");
  assert.equal(ownerConfirmation.type, "password");
  assert.equal(recovery.type, "text");
  assert.equal(recoveryConfirmation.type, "text");

  await user.click(recoveryToggle);
  recoveryToggle = ui.getByRole("button", { name: "Show recovery passwords" });
  assert.equal(recoveryToggle.getAttribute("aria-pressed"), "false");
  for (const input of inputs) assert.equal(input.type, "password");
  assert.deepEqual(inputs.map((input) => input.value),
    [ownerSecret, ownerSecret, recoverySecret, recoverySecret]);
});
