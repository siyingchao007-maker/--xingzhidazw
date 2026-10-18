"use strict";
const { Modal } = require("obsidian");
const { displayTime } = require("./growth-status.cjs");
function action(parent, text, callback) { const b = parent.createEl("button", { text, cls: "xz-secondary-button", attr: { type: "button" } }); b.addEventListener("click", callback); return b; }
function sourceActions(parent, plugin, point, beforeNavigate = () => {}) {
  if (point.sourcePath) action(parent, "查看原始依据", () => { beforeNavigate(); return plugin.openVaultPath(point.sourcePath.split("#")[0], { blockId: point.sourceRole === "user-record" ? undefined : point.sourceMessageId || point.sourcePath.split("#^")[1] }); });
  if (point.archivePath) action(parent, "查看整理稿", () => { beforeNavigate(); return plugin.openVaultPath(point.archivePath); });
}
class PointDetailModal extends Modal {
  constructor(plugin, point, returnFocus) { super(plugin.app); Object.assign(this, { plugin, point, returnFocus }); }
  onOpen() {
    const p = this.point; this.modalEl.addClass("xz-point-modal"); this.contentEl.empty();
    this.contentEl.createSpan({ cls: "xz-cognitive-kicker", text: p.label || "内容要点" });
    this.contentEl.createEl("h2", { text: p.title });
    if (p.occurredAt) this.contentEl.createEl("p", { cls: "xz-cognitive-muted", text: displayTime(p.occurredAt) });
    const grid = this.contentEl.createDiv({ cls: "xz-point-detail-grid" });
    const section = (heading, text, wide = false) => { const card = grid.createEl("section", { cls: `xz-point-detail-card${wide ? " is-wide" : ""}` }); card.createEl("h3", { text: heading }); if (text) card.createEl("p", { text }); return card; };
    section("核心概括", p.summary, true);
    if (p.details?.length) { const card = section("内容要点"); const list = card.createEl("ul"); p.details.forEach(text => list.createEl("li", { text })); }
    if (p.stateDescription) section("这条内容目前意味着什么", p.stateDescription);
    for (const item of p.sections || []) if (item.text) section(item.title, item.text);
    const evidence = section("来源与依据", "", true);
    if (p.evidenceQuote) evidence.createEl("blockquote", { text: p.evidenceQuote });
    else evidence.createEl("p", { cls: "xz-cognitive-muted", text: p.sourcePath ? "完整上下文保留在来源记录中。" : "这条旧记录尚未关联可定位的原始依据。" });
    const actions = evidence.createDiv({ cls: "xz-cognitive-actions" }); sourceActions(actions, this.plugin, p, () => this.close());
    const close = action(this.contentEl, "返回卡片列表", () => this.close()); close.focus();
  }
  onClose() { this.contentEl.empty(); this.returnFocus?.focus?.(); }
}
function renderPointCard(parent, plugin, point) {
  const card = parent.createEl("article", { cls: "xz-cognitive-card xz-point-card", attr: { "data-point-kind": point.kind || "growth" } });
  const meta = card.createDiv({ cls: "xz-point-meta" }); meta.createSpan({ cls: "xz-cognitive-tag", text: point.label || "内容要点" });
  if (point.occurredAt) meta.createEl("time", { text: displayTime(point.occurredAt), attr: { datetime: point.occurredAt } });
  card.createEl("h4", { text: point.title }); card.createEl("p", { cls: "xz-point-summary", text: point.summary });
  if (point.caption) card.createEl("p", { cls: "xz-cognitive-muted xz-point-caption", text: point.caption });
  const footer = card.createDiv({ cls: "xz-point-footer" });
  const detail = action(footer, "查看详情", () => new PointDetailModal(plugin, point, detail).open());
  detail.setAttribute("aria-label", `查看详情：${point.title}`);
  return card;
}
module.exports = { renderPointCard, PointDetailModal, sourceActions };
