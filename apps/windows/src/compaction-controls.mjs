import React, { useState } from "react";

const h = React.createElement;

/* Reports whether the opened session may present the compaction action. */
export function compactionAvailable(opened) {
  return opened?.readOnly === false && opened.canAddPasswords === true
    && opened.canRemovePasswords === true;
}

/* Renders the accessible destructive-action confirmation while it is open. */
export function CompactionConfirmation({ open, onCancel, onConfirm }) {
  if (!open) return null;
  return h("div", { role: "alertdialog", "aria-modal": "true",
    "aria-labelledby": "compaction-confirmation-title",
    "aria-describedby": "compaction-confirmation-detail" },
  h("h3", { id: "compaction-confirmation-title" },
    "Permanently compact document history?"),
  h("p", { id: "compaction-confirmation-detail", className: "warning" },
    "Compaction irreversibly removes older history from this container. It cannot delete historical copies held by backups, sync tools, caches, or storage providers. An exact verified backup replica must be created first."),
  h("div", { className: "toolbar" },
    h("button", { type: "button", onClick: onCancel, autoFocus: true }, "Cancel"),
    h("button", { type: "button", onClick: onConfirm },
      "Create backup and compact")));
}

/* Presents the keyboard-accessible compaction trigger and confirmation state. */
export function CompactionControls({ onCompact }) {
  const [confirming, setConfirming] = useState(false);
  return h(React.Fragment, null,
    h("h3", null, "History compaction"),
    h("p", { className: "warning" },
      "Compaction permanently removes older embedded history from this container after creating an exact verified backup. It cannot remove external copies."),
    h("button", { type: "button", onClick: () => setConfirming(true) },
      "Compact history…"),
    h(CompactionConfirmation, { open: confirming,
      onCancel: () => setConfirming(false),
      onConfirm: () => { setConfirming(false); void onCompact(); } }));
}
