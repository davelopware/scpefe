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
globalThis.requestAnimationFrame = (callback) => callback();

const React = (await import("react")).default;
const { cleanup, render, within } = await import("@testing-library/react");
const userEvent = (await import("@testing-library/user-event")).default;
const { CreateDocumentControl, CreationSecurityDialog } = await import(
  "../src/creation-security-dialog.mjs");

function mountedDialog(t, onCreate = async () => {}, onCancel = () => {}) {
  t.after(cleanup);
  const user = userEvent.setup({ document: dom.window.document });
  const rendered = render(React.createElement(CreationSecurityDialog,
    { onCreate, onCancel }));
  return { user, ui: within(rendered.container), ...rendered };
}

async function enterOwner(ui, user, confirmation = "owner password words") {
  await user.type(ui.getByLabelText("Owner password"), "owner password words");
  await user.type(ui.getByLabelText("Confirm owner password"), confirmation);
  await user.click(ui.getByLabelText(
    "I understand that lost passwords cannot be recovered."));
}

test("mounted post-picker dialog is focused and has no initial-text field", (t) => {
  const { ui } = mountedDialog(t);
  const dialog = ui.getByRole("dialog", { name: "Secure new document" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dom.window.document.activeElement,
    ui.getByLabelText("Owner password"));
  assert.equal(ui.queryByLabelText("Initial text"), null);
  assert.match(dialog.textContent, /lost passwords cannot be recovered/i);
});

test("owner mismatch stays open, retains input, focuses confirmation, and creates nothing",
  async (t) => {
    let createCalls = 0;
    const { user, ui } = mountedDialog(t, async () => { createCalls += 1; });
    await enterOwner(ui, user, "owner password typo");
    await user.click(ui.getByRole("button", { name: "Create" }));
    assert.equal(createCalls, 0);
    assert.match(ui.getByRole("alert").textContent, /owner passwords do not match/);
    assert.equal(ui.getByRole("dialog").isConnected, true);
    assert.equal(ui.getByLabelText("Owner password").value, "owner password words");
    assert.equal(ui.getByLabelText("Confirm owner password").value,
      "owner password typo");
    assert.equal(dom.window.document.activeElement,
      ui.getByLabelText("Confirm owner password"));
  });

test("optional recovery acknowledgement is conditional and matching values cross once",
  async (t) => {
    const requests = [];
    const { user, ui } = mountedDialog(t, async (request) => {
      requests.push(request);
    });
    assert.equal(ui.queryByLabelText(
      "I will store the recovery password independently."), null);
    await enterOwner(ui, user);
    await user.type(ui.getByLabelText(
      "Independent recovery password (strongly recommended)"),
    "independent recovery words");
    await user.type(ui.getByLabelText("Confirm recovery password"),
      "independent recovery words");
    const acknowledgement = ui.getByLabelText(
      "I will store the recovery password independently.");
    await user.click(acknowledgement);
    await user.click(ui.getByRole("button", { name: "Create" }));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      ownerPassword: "owner password words",
      ownerPasswordConfirmation: "owner password words",
      recoveryPassword: "independent recovery words",
      recoveryPasswordConfirmation: "independent recovery words",
      content: "", understandsIrrecoverable: true,
      storedRecoverySeparately: true,
    });
  });

test("recovery mismatch never invokes creation and keeps both pairs recoverable",
  async (t) => {
    let createCalls = 0;
    const { user, ui } = mountedDialog(t, async () => { createCalls += 1; });
    await enterOwner(ui, user);
    await user.type(ui.getByLabelText(
      "Independent recovery password (strongly recommended)"),
    "independent recovery words");
    await user.type(ui.getByLabelText("Confirm recovery password"),
      "recovery password typo");
    await user.click(ui.getByLabelText(
      "I will store the recovery password independently."));
    await user.click(ui.getByRole("button", { name: "Create" }));
    assert.equal(createCalls, 0);
    assert.match(ui.getByRole("alert").textContent,
      /recovery passwords do not match/);
    assert.equal(dom.window.document.activeElement,
      ui.getByLabelText("Confirm recovery password"));
    assert.equal(ui.getByLabelText("Owner password").value, "owner password words");
    assert.equal(ui.getByLabelText(
      "Independent recovery password (strongly recommended)").value,
    "independent recovery words");
  });

test("creation failure remains inline with retained secrets and can be retried", async (t) => {
  let createCalls = 0;
  const { user, ui } = mountedDialog(t, async () => {
    createCalls += 1;
    if (createCalls === 1) throw new Error("Encrypted publication failed safely");
  });
  await enterOwner(ui, user);
  await user.click(ui.getByRole("button", { name: "Create" }));
  assert.match(ui.getByRole("alert").textContent, /publication failed safely/i);
  assert.equal(ui.getByLabelText("Owner password").value, "owner password words");
  assert.equal(dom.window.document.activeElement, ui.getByLabelText("Owner password"));
  await user.click(ui.getByRole("button", { name: "Create" }));
  assert.equal(createCalls, 2);
});

test("Cancel and Escape are keyboard-operable without invoking creation", async (t) => {
  let createCalls = 0;
  let cancelCalls = 0;
  const { user, ui } = mountedDialog(t, async () => { createCalls += 1; },
    () => { cancelCalls += 1; });
  await user.click(ui.getByRole("button", { name: "Cancel" }));
  assert.equal(cancelCalls, 1);
  ui.getByLabelText("Owner password").focus();
  await user.keyboard("{Escape}");
  assert.equal(cancelCalls, 2);
  assert.equal(createCalls, 0);
});

test("mounted creation control runs picker first and picker cancellation opens no dialog",
  async (t) => {
    t.after(cleanup);
    let selected = false;
    let pickerCalls = 0;
    let createCalls = 0;
    let cancelCalls = 0;
    dom.window.scpefe = {
      chooseCreateTarget: async () => {
        pickerCalls += 1;
        return selected ? { selected: true } : null;
      },
      cancelCreateTarget: async () => { cancelCalls += 1; },
      createDocument: async () => { createCalls += 1; return { created: true }; },
    };
    const user = userEvent.setup({ document: dom.window.document });
    const rendered = render(React.createElement(CreateDocumentControl,
      { onCreated: () => {}, onError: (error) => { throw error; } }));
    const ui = within(rendered.container);
    const launcher = ui.getByRole("button", { name: "Create encrypted document…" });
    await user.click(launcher);
    assert.equal(pickerCalls, 1);
    assert.equal(ui.queryByRole("dialog"), null);
    assert.equal(createCalls, 0);

    selected = true;
    await user.click(launcher);
    assert.equal(pickerCalls, 2);
    assert.ok(ui.getByRole("dialog", { name: "Secure new document" }));
    assert.equal(createCalls, 0);
    await user.click(ui.getByRole("button", { name: "Cancel" }));
    assert.equal(cancelCalls, 1);
    assert.equal(ui.queryByRole("dialog"), null);
    assert.equal(dom.window.document.activeElement, launcher);
  });
