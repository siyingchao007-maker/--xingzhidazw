"use strict";

const { Component, MarkdownRenderer, setIcon } = require("obsidian");
const { renderGrowthContent } = require("./view-growth-content.cjs");

class UserGrowthPanel {
  constructor(options) {
    this.plugin = options.plugin;
    this.onClose = options.onClose;
    this.opened = false;
    this.loading = false;
    this.snapshot = null;
    this.readerCard = null;
    this.markdownComponent = null;

    this.scrim = options.root.createDiv({ cls: "xz-maintenance-scrim", attr: { hidden: "" } });
    this.scrim.addEventListener("click", () => this.close());
    this.drawer = options.root.createEl("aside", {
      cls: "xz-maintenance-drawer xz-user-growth-panel",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-user-growth-title",
      },
    });
    const header = this.drawer.createDiv({ cls: "xz-maintenance-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "个人连续性 · 本地可追溯" });
    heading.createEl("h2", { text: "我的成长", attr: { id: "xz-user-growth-title" } });
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭我的成长", "aria-label": "关闭我的成长" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());
    this.body = this.drawer.createDiv({ cls: "xz-maintenance-body xz-user-growth-body" });

    this.reader = options.root.createEl("section", {
      cls: "xz-user-growth-reader",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "xz-user-growth-reader-title",
      },
    });
    this.drawer.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); this.close(); } });
    this.reader.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeReader();
      }
    });
  }

  destroy() {
    this.markdownComponent?.unload?.();
    this.markdownComponent = null;
    this.drawer.remove();
    this.scrim.remove();
    this.reader.remove();
  }

  async open() {
    this.opened = true;
    this.scrim.removeAttribute("hidden");
    this.drawer.removeAttribute("hidden");
    await this.refresh();
    this.closeButton?.focus();
  }

  close() {
    const wasOpen = this.opened;
    this.opened = false;
    this.closeReader();
    this.scrim.setAttr("hidden", "");
    this.drawer.setAttr("hidden", "");
    if (wasOpen) this.onClose?.();
  }

  signature() {
    const state = this.plugin.state || {};
    return JSON.stringify([state.runtime?.userContinuity, state.runtime?.conversationOrganization, state.runtime?.cognitiveLastTransactionId, state.knowledgeTransactions?.length]);
  }

  async refresh() {
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true; this.error = null; this.renderContent();
    const signature = this.signature();
    try {
      [this.snapshot, this.cognitive] = await Promise.all([this.plugin.getUserContinuitySnapshot({ month: this.month }), this.plugin.getCognitiveSnapshot()]);
      this.loadedSignature = signature;
    } catch (error) { this.error = `成长记录读取失败：${error.message}`; }
    finally { this.loading = false; this.renderContent(); if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); } }
  }

  render() {
    if (this.opened && !this.loading && this.loadedSignature !== this.signature()) { void this.refresh(); return; }
  }

  renderContent() {
    if (!this.opened) return;
    const scroll = this.body.scrollTop;
    renderGrowthContent(this);
    this.body.scrollTop = scroll;
  }

  async openReader(card, returnFocus) {
    if (!card?.exists) return;
    this.readerCard = card;
    this.returnFocus = returnFocus;
    this.markdownComponent?.unload?.();
    this.markdownComponent = new Component();
    this.markdownComponent.load();
    this.reader.empty();
    this.reader.removeAttribute("hidden");
    const header = this.reader.createEl("header", { cls: "xz-user-growth-reader__header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: `${card.typeLabel} · 全屏只读` });
    heading.createEl("h1", { text: card.title, attr: { id: "xz-user-growth-reader-title" } });
    const actions = header.createDiv({ cls: "xz-user-growth-reader__actions" });
    const open = actions.createEl("button", { cls: "xz-secondary-button", text: "在 Obsidian 打开", attr: { type: "button" } });
    open.addEventListener("click", () => void this.plugin?.openVaultPath?.(card.path));
    const close = actions.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭全屏阅读", "aria-label": "关闭全屏阅读" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeReader());
    const content = this.reader.createDiv({ cls: "xz-user-growth-reader__content markdown-rendered" });
    await MarkdownRenderer.render(this.plugin.app, card.content, content, card.path, this.markdownComponent);
    close.focus();
  }

  closeReader() {
    if (!this.readerCard) return;
    const returnFocus = this.returnFocus;
    this.readerCard = null;
    this.returnFocus = null;
    this.markdownComponent?.unload?.();
    this.markdownComponent = null;
    this.reader.setAttr("hidden", "");
    this.reader.empty();
    returnFocus?.focus?.();
  }
}

module.exports = { UserGrowthPanel };
