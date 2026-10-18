"use strict";

function menuEntries(entries) {
  if (!entries) return [];
  if (typeof entries.values === "function") return [...entries.values()];
  return Array.isArray(entries) ? entries : [];
}

function setExpanded(entry) {
  const value = entry?.menu?.open ? "true" : "false";
  if (typeof entry?.menuSummary?.setAttr === "function") entry.menuSummary.setAttr("aria-expanded", value);
  else entry?.menuSummary?.setAttribute?.("aria-expanded", value);
}

function closeEntry(entry, { restoreFocus = false } = {}) {
  if (!entry?.menu?.open) return false;
  entry.menu.open = false;
  setExpanded(entry);
  if (restoreFocus) entry.menuSummary?.focus?.();
  return true;
}

function closeConversationMenusOutside(entries, eventPath) {
  const path = Array.isArray(eventPath) ? eventPath : [];
  let closed = 0;
  for (const entry of menuEntries(entries)) {
    if (!entry?.menu?.open) continue;
    const inside = path.some(node => {
      if (node === entry.menu) return true;
      if (!node || typeof node.nodeType !== "number") return false;
      return Boolean(entry.menu.contains?.(node));
    });
    if (!inside && closeEntry(entry)) closed += 1;
  }
  return closed;
}

function closeConversationMenuOnEscape(entries, event) {
  const open = menuEntries(entries).filter(entry => entry?.menu?.open);
  if (!open.length) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  open.forEach((entry, index) => closeEntry(entry, { restoreFocus: index === 0 }));
  return true;
}

function syncConversationMenuToggle(entries, current) {
  setExpanded(current);
  if (!current?.menu?.open) return;
  for (const entry of menuEntries(entries)) {
    if (entry?.menu !== current.menu) closeEntry(entry);
  }
}

module.exports = {
  closeConversationMenusOutside,
  closeConversationMenuOnEscape,
  syncConversationMenuToggle,
};
