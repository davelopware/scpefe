import React from "react";

const h = React.createElement;

/* Reports whether the opened session may present the compaction action. */
export function compactionAvailable(opened) {
  return opened?.readOnly === false && opened.canAddPasswords === true
    && opened.canRemovePasswords === true;
}

/* Presents the accessible trigger for the renderer's focused confirmation. */
export function CompactionControls({ onCompact }) {
  return h(React.Fragment, null,
    h("h3", null, "History compaction"),
    h("p", { id: "compaction-action-warning", className: "warning" },
      "Compaction permanently removes older embedded history from this container after creating an exact verified backup. It cannot remove copies retained by backups, sync tools, caches, or storage providers."),
    h("button", { type: "button", onClick: () => { void onCompact(); },
      "aria-describedby": "compaction-action-warning" }, "Compact history…"));
}
