"use strict";

const { setIcon } = require("obsidian");

const ICONS = Object.freeze({
  "source-review": "list-checks",
  failed: "circle-alert",
  "preparing-preview": "loader-circle",
  "preview-ready": "clipboard-check",
  "needs-input": "message-circle-question",
  "content-confirmed": "badge-check",
  "new-messages": "message-square-more",
  stale: "refresh-cw",
});

function renderArchiveStatus(parent, action, handlers = {}) {
  if (!action || new Set(["idle", "archived"]).has(action.status)) return null;
  const card = parent.createDiv({
    cls: `xz-archive-status is-${action.status}`,
    attr: { role: action.status === "failed" ? "alert" : "status" },
  });
  const icon = card.createSpan({ cls: "xz-archive-status-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, ICONS[action.status] || "archive");
  const copy = card.createDiv({ cls: "xz-archive-status-copy" });
  copy.createEl("strong", { text: action.label });
  copy.createEl("span", { text: action.detail });
  const actions = card.createDiv({ cls: "xz-archive-status-actions" });
  const button = actions.createEl("button", {
    cls: "xz-archive-status-action",
    text: action.actionLabel,
    attr: { type: "button" },
  });
  button.disabled = action.disabled === true;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const handler = handlers[action.action];
    if (typeof handler === "function") void handler();
  });
  if (action.secondaryAction && action.secondaryActionLabel) {
    const secondary = actions.createEl("button", {
      cls: "xz-archive-status-action is-secondary",
      text: action.secondaryActionLabel,
      attr: { type: "button" },
    });
    secondary.addEventListener("click", (event) => {
      event.stopPropagation();
      const handler = handlers[action.secondaryAction];
      if (typeof handler === "function") void handler();
    });
  }
  return card;
}

module.exports = { renderArchiveStatus };
