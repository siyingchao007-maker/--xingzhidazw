"use strict";

const { Notice, setIcon } = require("obsidian");

function text(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanList(values, maximum = 12) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .slice(0, maximum);
}

function renderList(parent, values, emptyText) {
  const list = parent.createEl("ul", { cls: "xz-knowledge-reader-list" });
  const clean = cleanList(values);
  if (!clean.length) list.createEl("li", { cls: "is-empty", text: emptyText });
  else clean.forEach((value) => list.createEl("li", { text: value }));
  return list;
}

class KnowledgeReaderOverlay {
  constructor(options) {
    this.plugin = options.plugin;
    this.card = null;
    this.rawContent = "";
    this.rawError = "";
    this.requestKey = "";
    this.returnFocus = null;
    const overlayHost = options.root.ownerDocument?.body || options.root;
    const usesStandardBrand = Boolean(options.root.closest?.(".xz-standard-brand"));
    this.portal = usesStandardBrand
      ? overlayHost.createEl("div", { cls: "xz-standard-brand xz-knowledge-reader-portal" })
      : null;
    const overlayRoot = this.portal || overlayHost;
    this.overlay = overlayRoot.createEl("section", {
      cls: "xz-workbench xz-knowledge-reader",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "xz-knowledge-reader-title",
      },
    });
    this.overlay.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  destroy() {
    this.returnFocus = null;
    this.close();
    this.overlay.remove();
    this.portal?.remove();
    this.portal = null;
  }

  onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...this.overlay.querySelectorAll?.("button:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])") || []];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && event.target === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && event.target === last) {
      event.preventDefault();
      first.focus();
    }
  }

  close() {
    const returnFocus = this.returnFocus;
    this.requestKey = "";
    this.card = null;
    this.rawContent = "";
    this.rawError = "";
    this.returnFocus = null;
    this.overlay.setAttr("hidden", "");
    this.overlay.empty();
    returnFocus?.focus?.();
  }

  async open(card) {
    if (!card) return;
    if (!this.card) this.returnFocus = this.overlay.ownerDocument?.activeElement || null;
    this.card = card;
    this.rawContent = "";
    this.rawError = "";
    this.overlay.removeAttribute("hidden");
    this.render(true);
    this.closeButton?.focus();
    if (!card.path || typeof this.plugin?.readKnowledgeStructureFile !== "function") {
      this.rawError = "当前入口不能读取原始记录，仍可在 Obsidian 中打开。";
      this.render(false);
      return;
    }
    const requestKey = `${card.path}:${Date.now()}`;
    this.requestKey = requestKey;
    try {
      const result = await this.plugin.readKnowledgeStructureFile(card.path);
      if (this.requestKey !== requestKey || this.card !== card) return;
      this.rawContent = typeof result?.content === "string" ? result.content : "";
    } catch (error) {
      if (this.requestKey !== requestKey || this.card !== card) return;
      this.rawError = `原始记录读取失败：${error?.message || "未知错误"}`;
    }
    this.render(false);
  }

  render(loading = false) {
    if (!this.card) return;
    const card = this.card;
    const hadFocus = this.overlay.contains?.(this.overlay.ownerDocument?.activeElement) === true;
    this.overlay.empty();
    const header = this.overlay.createEl("header", { cls: "xz-knowledge-reader-header" });
    const heading = header.createDiv({ cls: "xz-knowledge-reader-heading" });
    heading.createEl("span", {
      cls: "xz-eyebrow",
      text: `${text(card.typeLabel, card.type || "知识")} · 只读详情`,
    });
    heading.createEl("h1", { text: text(card.title, "未命名知识"), attr: { id: "xz-knowledge-reader-title" } });
    const actions = header.createDiv({ cls: "xz-knowledge-reader-header-actions" });
    const open = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: "在 Obsidian 打开",
      attr: { type: "button" },
    });
    open.disabled = !card.path || typeof this.plugin?.openVaultPath !== "function";
    open.addEventListener("click", async () => {
      try {
        await this.plugin.openVaultPath(card.path, { mode: "tab" });
      } catch (error) {
        new Notice(`无法打开文件：${error?.message || "未知错误"}`);
      }
    });
    this.closeButton = actions.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭全屏阅读", "aria-label": "关闭全屏阅读" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());

    const body = this.overlay.createDiv({ cls: "xz-knowledge-reader-body" });
    const summary = body.createEl("section", { cls: "xz-knowledge-reader-summary" });
    const summaryHead = summary.createDiv({ cls: "xz-knowledge-reader-section-head" });
    summaryHead.createEl("span", { text: "核心总结" });
    if (card.summaryState === "needs-review") summaryHead.createSpan({ cls: "xz-status-chip is-manual", text: "待整理" });
    summary.createEl("p", { text: text(card.summary, card.contentPreview || card.excerpt || "这条知识尚未形成可用摘要。") });

    const primary = body.createDiv({ cls: "xz-knowledge-reader-primary" });
    const points = primary.createEl("section", { cls: "xz-knowledge-reader-section" });
    points.createEl("h2", { text: "核心知识点" });
    renderList(points, card.keyPoints, "尚无可提炼的核心知识点，需要补充整理。 ");
    const uses = primary.createEl("section", { cls: "xz-knowledge-reader-section is-suggestion" });
    uses.createEl("h2", { text: "建议用途" });
    uses.createEl("p", { cls: "xz-knowledge-reader-inference", text: "以下用途由知识类型推断，不等同于原文事实。" });
    renderList(uses, card.suggestedUses, "暂未形成明确的使用建议。 ");

    const context = body.createEl("section", { cls: "xz-knowledge-reader-section" });
    context.createEl("h2", { text: "来源与适用条件" });
    const facts = context.createEl("dl", { cls: "xz-knowledge-reader-facts" });
    [
      ["认识状态", card.epistemicLabel || card.epistemicStatus],
      ["有效状态", card.statusLabel || card.status],
      ["更新时间", card.updatedAt],
      ["保存位置", card.path],
      ["来源对话", card.source?.conversationPath],
      ["来源文档", cleanList(card.source?.documents, 20).join("、")],
    ].filter(([, value]) => typeof value === "string" && value.trim()).forEach(([label, value]) => {
      facts.createEl("dt", { text: label });
      facts.createEl("dd", { text: value });
    });
    const tags = cleanList(card.tags, 20);
    if (tags.length) {
      context.createEl("h3", { text: "标签" });
      const chips = context.createDiv({ cls: "xz-knowledge-reader-chips" });
      tags.forEach((tag) => chips.createSpan({ cls: "xz-knowledge-chip", text: tag }));
    }

    const relations = cleanList((card.relatedKnowledge || card.relations || []).map((relation) => (
      typeof relation === "string" ? relation : text(relation?.label, relation?.title || relation?.path || "")
    )), 20);
    const relationSection = body.createEl("section", { cls: "xz-knowledge-reader-section" });
    relationSection.createEl("h2", { text: "关联知识" });
    renderList(relationSection, relations, "尚未建立明确的关联知识。 ");

    const original = body.createEl("details", { cls: "xz-knowledge-reader-original" });
    original.createEl("summary", { text: "查看原始记录" });
    if (loading) original.createEl("p", { text: "正在读取本地原始记录…" });
    else if (this.rawError) original.createEl("p", { cls: "xz-maintenance-error", text: this.rawError });
    else original.createEl("pre", {
      text: this.rawContent || "原始记录为空。",
      attr: { tabindex: "0", "aria-label": "原始知识记录" },
    });
    if (hadFocus) this.closeButton?.focus();
  }
}

module.exports = { KnowledgeReaderOverlay };
