"use strict";

const { setIcon } = require("obsidian");

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function renderList(parent, values, fallback) {
  const clean = list(values).filter((item) => typeof item === "string" && item.trim());
  if (!clean.length) {
    parent.createEl("p", { cls: "xz-knowledge-decision-empty", text: fallback });
    return;
  }
  const ul = parent.createEl("ul");
  clean.forEach((item) => ul.createEl("li", { text: item }));
}

class KnowledgeDecisionOverlay {
  constructor(options = {}) {
    this.fallbackFocus = options.fallbackFocus || null;
    this.item = null;
    this.analysis = null;
    this.onOpenSource = null;
    this.onContinue = null;
    this.onDefer = null;
    this.returnFocus = null;
    this.selectedOption = "";
    this.overlay = options.root.createEl("section", {
      cls: "xz-knowledge-decision",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "xz-knowledge-decision-title",
      },
    });
    this.overlay.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  open({ item, analysis, onOpenSource, onContinue, onDefer } = {}) {
    if (!item || !analysis) return;
    this.item = item;
    this.analysis = analysis;
    this.onOpenSource = onOpenSource;
    this.onContinue = onContinue;
    this.onDefer = onDefer;
    this.selectedOption = analysis.recommendedOption || analysis.options?.[0]?.id || "";
    this.returnFocus = this.overlay.ownerDocument?.activeElement || null;
    this.overlay.removeAttribute("hidden");
    this.render();
    this.closeButton?.focus();
  }

  close() {
    const focus = this.returnFocus?.isConnected === false ? this.fallbackFocus : (this.returnFocus || this.fallbackFocus);
    this.item = null;
    this.analysis = null;
    this.onOpenSource = null;
    this.onContinue = null;
    this.onDefer = null;
    this.returnFocus = null;
    this.overlay.setAttr("hidden", "");
    this.overlay.empty();
    focus?.focus?.();
  }

  destroy() {
    this.close();
    this.overlay.remove?.();
  }

  onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...this.overlay.querySelectorAll?.("button:not([disabled]), input:not([disabled]), a[href]") || []];
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

  section(parent, title, content) {
    const section = parent.createEl("section", { cls: "xz-knowledge-decision-section" });
    section.createEl("h2", { text: title });
    if (Array.isArray(content)) renderList(section, content, "Agent 没有提取出可用内容。 ");
    else section.createEl("p", { text: text(content) });
    return section;
  }

  render() {
    if (!this.item || !this.analysis) return;
    const { item, analysis } = this;
    this.overlay.empty();
    const header = this.overlay.createEl("header", { cls: "xz-knowledge-decision-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "Agent 已整理 · 先判断再操作" });
    heading.createEl("h1", { text: text(item.title, "知识治理判断"), attr: { id: "xz-knowledge-decision-title" } });
    const badges = heading.createDiv({ cls: "xz-knowledge-decision-badges" });
    badges.createSpan({ cls: "xz-status-chip", text: analysis.processingLevel || "L3" });
    badges.createSpan({ cls: "xz-status-chip", text: `置信度 ${Math.round((analysis.confidence || 0) * 100)}%` });
    list(analysis.classification).forEach((label) => badges.createSpan({ cls: "xz-status-chip", text: label }));
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭判断卡", "aria-label": "关闭判断卡" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());

    const body = this.overlay.createDiv({ cls: "xz-knowledge-decision-body" });
    this.section(body, "为什么需要处理", item.summary);
    this.section(body, "Agent 整理结果", analysis.summary);
    this.section(body, "核心知识点", analysis.keyPoints);
    this.section(body, "Agent 当前判断", analysis.decision);
    this.section(body, "判断依据", analysis.evidence);
    this.section(body, "仍然未知", analysis.unknowns);
    this.section(body, "处理建议", analysis.recommendation);
    this.section(body, "处理后影响", analysis.impactAfterHandling);

    const decision = body.createEl("section", { cls: "xz-knowledge-decision-question" });
    decision.createEl("span", { text: "需要你决定" });
    decision.createEl("h2", { text: text(analysis.decisionQuestion) });
    if (analysis.options?.length) {
      const options = decision.createDiv({ cls: "xz-knowledge-decision-options" });
      analysis.options.forEach((option) => {
        const label = options.createEl("label");
        const input = label.createEl("input", { attr: { type: "radio", name: "xz-governance-decision", value: option.id } });
        input.checked = option.id === this.selectedOption;
        input.addEventListener("change", () => { this.selectedOption = option.id; });
        const copy = label.createDiv();
        copy.createEl("strong", { text: option.label });
        copy.createEl("span", { text: option.consequence });
        if (option.id === analysis.recommendedOption) copy.createEl("small", { text: "Agent 推荐" });
      });
    }

    const sources = body.createEl("section", { cls: "xz-knowledge-decision-section" });
    sources.createEl("h2", { text: "查看原始来源" });
    const sourceButtons = sources.createDiv({ cls: "xz-knowledge-decision-sources" });
    list(item.paths).forEach((path) => {
      const button = sourceButtons.createEl("button", { cls: "xz-link-button", text: path, attr: { type: "button" } });
      button.addEventListener("click", () => this.onOpenSource?.(path));
    });
    if (!item.paths?.length) sources.createEl("p", { text: "当前问题没有可直接打开的来源文件。" });

    const footer = this.overlay.createEl("footer", { cls: "xz-knowledge-decision-actions" });
    const defer = footer.createEl("button", { cls: "xz-secondary-button", text: "暂缓处理", attr: { type: "button" } });
    defer.addEventListener("click", async () => {
      await this.onDefer?.(item);
      this.close();
    });
    const proceed = footer.createEl("button", { cls: "xz-primary-button", text: "按建议进入安全处理", attr: { type: "button" } });
    proceed.addEventListener("click", () => {
      const option = this.selectedOption;
      this.close();
      this.onContinue?.(item, option, analysis);
    });
  }
}

module.exports = { KnowledgeDecisionOverlay };
