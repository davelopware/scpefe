import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordConfirmationFields } from
  "../src/creation-security-controls.mjs";

function render(kind, revealed, onToggle = () => {}) {
  return PasswordConfirmationFields({ kind,
    label: kind === "owner" ? "Owner password" : "Recovery password",
    confirmationLabel: kind === "owner"
      ? "Confirm owner password" : "Confirm recovery password",
    revealed, required: kind === "owner", onToggle });
}

test("rendered password confirmations are masked and keyboard-operable by default", () => {
  const owner = renderToStaticMarkup(render("owner", false));
  const recovery = renderToStaticMarkup(render("recovery", false));
  for (const markup of [owner, recovery]) {
    assert.equal((markup.match(/type="password"/g) ?? []).length, 2);
    assert.match(markup, /<button type="button" aria-pressed="false"/);
    assert.match(markup, /aria-controls="[^"]+-password [^"]+-password-confirmation"/);
    assert.match(markup, />Show (owner|recovery) passwords<\/button>/);
  }
  assert.equal((owner.match(/required=""/g) ?? []).length, 2);
  assert.equal(recovery.includes('required=""'), false);
});

test("rendered show state reveals both fields without replacing their controls", () => {
  const hidden = renderToStaticMarkup(render("owner", false));
  const shown = renderToStaticMarkup(render("owner", true));
  assert.equal((shown.match(/type="text"/g) ?? []).length, 2);
  assert.match(shown, /aria-pressed="true"/);
  assert.match(shown, />Hide owner passwords<\/button>/);
  for (const id of ["owner-password", "owner-password-confirmation"]) {
    assert.ok(hidden.includes(`id="${id}"`));
    assert.ok(shown.includes(`id="${id}"`));
  }
  let toggles = 0;
  const element = render("owner", false, () => { toggles += 1; });
  element.props.children[3].props.onClick();
  assert.equal(toggles, 1);
});
