"use strict";

const { ItemView, Modal, Notice, setIcon } = require("obsidian");
const { archiveCandidateCard, groupArchiveCandidates } = require("./archive-review.cjs");
const {
  captureArchiveScrollPosition,
  restoreArchiveScrollPosition,
} = require("./archive-scroll.cjs");

const VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW = "xingzhi-archive-review-view";

function text(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function formatTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function statusText(status, archiveScope = "conversation") {
  const base = {
    "source-review": "来源对话已保留，等待生成知识审核内容",
    "preview-ready": "知识候选已生成，等待逐条审核",
    "needs-input": "还有内容需要澄清或排除",
    "content-confirmed": "所选知识已写入，等待最终归档",
    stale: "对话已变化，需要重新生成预览",
    failed: "上次操作失败，草稿仍保留",
    archived: "已完成最终归档",
  }[status] || "正在准备归档预览";
  if (archiveScope !== "message-blocks") return base;
  return {
    "preview-ready": "所选段落已生成知识候选，等待逐条审核",
    "needs-input": "所选段落还有内容需要澄清或排除",
    "content-confirmed": "所选知识已写入，等待完成本次段落归档记录",
    stale: "来源消息已经变化，需要重新选择段落",
  }[status] || base;
}

function itemTitle(item, fallback) {
  return text(item?.title, item?.key, item?.path, item?.messageId, fallback);
}

function addField(parent, label, value, { pre = false } = {}) {
  const content = text(value);
  if (!content) return;
  const row = parent.createDiv({ cls: "xz-archive-detail-field" });
  row.createEl("strong", { text: label });
  row.createEl(pre ? "pre" : "p", { text: content });
}

class XingzhiArchiveItemDetailModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.title = options.title || "归档详情";
    this.fields = Array.isArray(options.fields) ? options.fields : [];
    this.description = text(options.description);
    this.path = text(options.path);
    this.onOpenPath = options.onOpenPath;
  }

  onOpen() {
    this.modalEl.addClass("xz-archive-item-detail-modal");
    this.titleEl.setText(this.title);
    const body = this.contentEl.createDiv({ cls: "xz-archive-item-detail" });
    if (this.description) body.createEl("p", { cls: "xz-archive-detail-intro", text: this.description });
    this.fields.forEach((field) => addField(body, field.label, field.value, { pre: field.pre }));
    if (this.path) {
      const open = body.createEl("button", {
        cls: "xz-secondary-button",
        text: "打开知识笔记",
        attr: { type: "button" },
      });
      open.disabled = typeof this.onOpenPath !== "function";
      open.addEventListener("click", () => this.onOpenPath?.(this.path));
    }
    const actions = body.createDiv({ cls: "modal-button-container" });
    const close = actions.createEl("button", { text: "关闭", attr: { type: "button" } });
    close.addEventListener("click", () => this.close());
    setTimeout(() => close.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class XingzhiArchiveClarificationModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.title = options.title || "补充归档信息";
    this.question = options.question || "请补充这项知识的真实情况。";
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  onOpen() {
    this.modalEl.addClass("xz-archive-clarification-modal");
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { cls: "xz-archive-clarification-question", text: this.question });
    const label = this.contentEl.createEl("label", { text: "我的补充" });
    const input = this.contentEl.createEl("textarea", {
      cls: "xz-archive-clarification-input",
      attr: {
        rows: "7",
        placeholder: "输入真实内容。提交后会加入当前对话，并重新生成归档预览。",
        "aria-label": "归档补充内容",
      },
    });
    const inputId = `xz-archive-clarification-${Date.now()}`;
    input.id = inputId;
    label.setAttr("for", inputId);
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: "保存补充并重新生成预览",
      attr: { type: "button" },
    });
    const sync = () => { submit.disabled = !input.value.trim(); };
    input.addEventListener("input", sync);
    submit.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return;
      this.resolveValue?.(value);
      this.resolveValue = null;
      this.close();
    });
    sync();
    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.resolveValue?.(null);
    this.resolveValue = null;
    this.contentEl.empty();
  }

  waitForValue() {
    this.open();
    return this.promise;
  }
}

class XingzhiArchiveReviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.conversationId = "";
    this.unsubscribe = null;
    this.updateFrame = null;
    this.busy = false;
    this.activeSectionId = "";
    this.activeDraftId = "";
  }

  getViewType() {
    return VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW;
  }

  getDisplayText() {
    return "归档内容审核";
  }

  getIcon() {
    return "archive";
  }

  getState() {
    return { conversationId: this.conversationId };
  }

  async setState(state, result) {
    this.conversationId = text(state?.conversationId);
    await super.setState(state, result);
    if (this.contentEl?.isConnected) this.render();
  }

  conversation() {
    return (Array.isArray(this.plugin?.state?.conversations) ? this.plugin.state.conversations : [])
      .find((item) => item?.id === this.conversationId) || null;
  }

  draft() {
    if (typeof this.plugin?.getArchiveReview === "function") {
      return this.plugin.getArchiveReview(this.conversationId);
    }
    return this.conversation()?.archiveDraft || null;
  }

  async onOpen() {
    this.containerEl.addClass("xz-archive-review-view");
    this.render();
    if (typeof this.plugin?.subscribe === "function") {
      const maybeUnsubscribe = this.plugin.subscribe(() => this.scheduleRender());
      if (typeof maybeUnsubscribe === "function") this.unsubscribe = maybeUnsubscribe;
    }
  }

  async onClose() {
    if (this.updateFrame !== null) {
      const cancel = globalThis.cancelAnimationFrame || clearTimeout;
      cancel(this.updateFrame);
      this.updateFrame = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
    this.containerEl.removeClass("xz-archive-review-view");
  }

  scheduleRender() {
    if (this.busy) return;
    if (this.updateFrame !== null) return;
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 16));
    this.updateFrame = schedule(() => {
      this.updateFrame = null;
      if (this.busy) return;
      if (this.contentEl?.isConnected) this.render();
    });
  }

  returnToWorkbench() {
    return this.plugin?.activateWorkbench?.();
  }

  captureScrollPosition() {
    const root = this.contentEl?.querySelector(".xz-archive-review-page");
    if (!root) return null;
    return {
      conversationId: root.getAttribute("data-archive-conversation-id") || "",
      draftId: root.getAttribute("data-archive-draft-id") || "",
      sectionId: root.getAttribute("data-archive-section-id") || "",
      position: captureArchiveScrollPosition(root, this.contentEl),
    };
  }

  restoreScrollPosition(root, snapshot) {
    if (!root || !snapshot) return;
    const sameDraft = snapshot.conversationId === (root.getAttribute("data-archive-conversation-id") || "")
      && snapshot.draftId === (root.getAttribute("data-archive-draft-id") || "");
    if (!sameDraft) return;
    restoreArchiveScrollPosition(root, snapshot.position);
  }

  syncActiveSection(draft, items, preferredId) {
    const ids = items.map((item) => item.id);
    if (
      this.activeDraftId !== draft.id
      || !ids.includes(this.activeSectionId)
    ) {
      this.activeSectionId = ids.includes(preferredId) ? preferredId : ids[0] || "";
    }
    this.activeDraftId = draft.id;
  }

  pageSection(parent, {
    id,
    title,
    count = null,
    description = "",
    wide = false,
  }, renderBody) {
    if (this.activeSectionId && id !== this.activeSectionId) return null;
    const section = parent.createEl("section", {
      cls: "xz-archive-page-section",
      attr: {
        id: `xz-archive-section-${id}`,
        "aria-labelledby": `xz-archive-section-title-${id}`,
        tabindex: "-1",
      },
    });
    const header = section.createDiv({ cls: "xz-archive-page-section-header" });
    const copy = header.createDiv();
    copy.createEl("h2", { attr: { id: `xz-archive-section-title-${id}` }, text: title });
    if (description) copy.createEl("p", { text: description });
    if (count !== null) header.createSpan({ cls: "xz-count", text: String(count) });
    const body = section.createDiv({ cls: `xz-archive-card-grid${wide ? " is-wide" : ""}` });
    renderBody(body);
    return section;
  }

  pageNav(parent, items) {
    const nav = parent.createEl("nav", { cls: "xz-archive-page-nav", attr: { "aria-label": "归档审核板块" } });
    items.forEach((item) => {
      const isActive = item.id === this.activeSectionId;
      const button = nav.createEl("button", {
        attr: {
          type: "button",
          "aria-pressed": String(isActive),
          "data-section-id": item.id,
        },
      });
      button.createSpan({ cls: "xz-archive-page-nav-label", text: item.label });
      if (item.count !== null && item.count !== undefined) {
        button.createSpan({ cls: "xz-archive-page-nav-count", text: String(item.count) });
      }
      button.addEventListener("click", () => {
        if (this.activeSectionId === item.id) return;
        this.activeSectionId = item.id;
        this.render();
        setTimeout(() => {
          this.contentEl
            .querySelector(`button[data-section-id="${item.id}"]`)
            ?.focus();
        }, 0);
      });
    });
    return nav;
  }

  openItemDetails(title, fields, path = "", description = "") {
    new XingzhiArchiveItemDetailModal(this.app, {
      title,
      fields,
      path,
      description,
      onOpenPath: (target) => this.plugin?.openVaultPath?.(target),
    }).open();
  }

  renderContentCard(parent, {
    kicker = "归档内容",
    title,
    summary = "",
    status = "",
    meta = [],
    actionLabel = "查看完整内容",
    onClick,
    renderActions = null,
  }) {
    const card = parent.createEl("article", {
      cls: "xz-archive-content-card xz-product-card-frame",
    });
    const surface = card.createEl("button", {
      cls: "xz-archive-content-card-surface",
      attr: { type: "button", title: `${actionLabel}：${title}` },
    });
    surface.addEventListener("click", onClick);
    const header = surface.createDiv({ cls: "xz-archive-content-card-header" });
    const heading = header.createDiv();
    heading.createSpan({ cls: "xz-archive-content-card-kicker", text: kicker });
    heading.createEl("h3", { text: title });
    if (status) header.createSpan({ cls: "xz-status-tag", text: status });
    const content = text(summary);
    if (content) {
      const preview = content.length > 700 ? `${content.slice(0, 699).trimEnd()}…` : content;
      surface.createEl("p", { cls: "xz-archive-content-card-summary", text: preview });
      if (preview !== content) surface.createSpan({ cls: "xz-archive-content-card-more", text: "内容较长，点击卡片查看完整内容。" });
    }
    const facts = meta.filter((item) => text(item?.value));
    if (facts.length) {
      const list = surface.createEl("dl", { cls: "xz-archive-content-card-meta" });
      facts.forEach((item) => {
        const row = list.createDiv();
        row.createEl("dt", { text: item.label });
        row.createEl("dd", { text: text(item.value) });
      });
    }
    const actions = card.createDiv({ cls: "xz-archive-content-card-actions" });
    if (typeof renderActions === "function") renderActions(actions);
    const open = actions.createEl("button", {
      cls: "xz-secondary-button",
      attr: { type: "button" },
      text: actionLabel,
    });
    open.addEventListener("click", onClick);
    return card;
  }

  renderEmptyCard(parent, title, description) {
    const card = parent.createEl("article", { cls: "xz-archive-empty-card", attr: { role: "status" } });
    const icon = card.createDiv({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "inbox");
    const copy = card.createDiv();
    copy.createEl("h3", { text: title });
    copy.createEl("p", { text: description });
    return card;
  }

  candidateFields(card) {
    return [
      { label: "完整标题", value: card.title },
      { label: "核心总结", value: card.summary },
      { label: "核心知识点", value: card.keyPoints.map((item) => `- ${item}`).join("\n"), pre: true },
      { label: "可应用于", value: card.suggestedUses.map((item) => `- ${item}`).join("\n"), pre: true },
      {
        label: "完整知识内容",
        value: card.content || "本次整理没有生成知识正文，当前项目不应直接确认写入。",
        pre: true,
      },
      { label: "归档用途", value: card.purpose },
      { label: "知识类型", value: `${card.typeLabel}（${card.knowledgeType || "未分类"}）` },
      { label: "认识状态", value: card.epistemicLabel },
      { label: "归档判断", value: card.decisionLabel },
      { label: "判断依据", value: card.decisionReason },
      { label: "需要澄清的问题", value: card.clarificationQuestion || "当前没有待澄清问题" },
      { label: "来源消息", value: card.sourceMessageId || "本次整理未提供来源消息编号" },
      { label: "来源原文", value: card.sourceQuote || "本次整理未提供可引用的来源原文", pre: true },
      { label: "计划保存位置", value: card.path || "本次整理尚未生成保存位置" },
      { label: "计划操作", value: card.operationLabel },
      { label: "操作原因", value: card.operationReason },
      { label: "本次归档标签", value: card.tags.join("、") || "本次整理未提供标签" },
      { label: "新建标签", value: card.newTags.join("、") || "无" },
      { label: "套用现有标签", value: card.existingTags.join("、") || "无" },
      { label: "标签状态待核对", value: card.unclassifiedTags.join("、") || "无" },
      { label: "标签原因", value: card.tagReason },
      { label: "别名", value: card.aliases.join("、") || "无" },
      {
        label: "正向链接",
        value: card.forwardLinks.map((item) => `${item.relationLabel}：${item.label} → ${item.path}`).join("\n") || "无已解析的关联知识链接",
        pre: true,
      },
      {
        label: "待解析关联",
        value: card.unresolvedLinks.map((item) => `${item.relationLabel}：${item.label}`).join("\n") || "无",
        pre: true,
      },
      {
        label: "反向链接目标",
        value: card.backlinkTargets.join("\n") || "无可验证的反向链接目标",
        pre: true,
      },
      { label: "链接原因", value: card.linkReason },
      {
        label: "将写入的完整 Markdown",
        value: card.writeContent || "本次整理尚未生成可写入的 Markdown，当前项目不应直接确认写入。",
        pre: true,
      },
    ];
  }

  renderCandidate(parent, candidate, draft, {
    actionMode = "selected",
    renderActions = null,
  } = {}) {
    const decision = draft.decisions.find((item) => item.candidateId === candidate.id) || {};
    const clarification = draft.clarifications.find((item) => item.candidateId === candidate.id) || {};
    const write = draft.plannedWrites.find((item) => item.candidateId === candidate.id) || {};
    const cardData = archiveCandidateCard(candidate, {
      decision,
      clarification,
      write,
      tags: draft.tags,
    });
    const candidateWrites = draft.plannedWrites.filter((item) => item.candidateId === candidate.id);
    const actualWritePaths = new Set(draft.actualWrites
      .filter((item) => item.candidateId === candidate.id)
      .map((item) => item.path));
    const isWritten = candidateWrites.length > 0
      && candidateWrites.every((item) => actualWritePaths.has(item.path));
    const displayActionMode = isWritten ? "written" : actionMode;
    this.cardSequence += 1;
    const titleId = `xz-archive-knowledge-card-title-${this.cardSequence}`;
    const stateClass = isWritten
      ? "is-written"
      : !candidate.selected
      ? "is-excluded"
      : candidate.policyState === "needs-input" ? "is-blocked" : "is-ready";
    const card = parent.createEl("article", {
      cls: `xz-archive-knowledge-card xz-product-card-frame ${stateClass}`,
      attr: { "aria-labelledby": titleId },
    });
    const openDetails = () => this.openItemDetails(
      `知识完整详情｜${cardData.title}`,
      this.candidateFields(cardData),
      cardData.path,
      "这里展示完整正文、标签新旧状态、正向链接、反向链接目标、判断依据、来源证据和实际写入内容。确认写入前，请以这里的信息为准。",
    );
    const summary = card.createEl("button", {
      cls: "xz-archive-knowledge-card-summary",
      attr: {
        type: "button",
        title: `全屏展开知识卡：${cardData.title}`,
        "aria-haspopup": "dialog",
      },
    });
    summary.addEventListener("click", openDetails);
    const header = summary.createDiv({ cls: "xz-archive-knowledge-card-header" });
    const heading = header.createDiv({ cls: "xz-archive-knowledge-card-heading" });
    heading.createSpan({ cls: "xz-archive-knowledge-card-kicker", text: `知识卡 · ${cardData.typeLabel}` });
    heading.createEl("h4", { attr: { id: titleId }, text: cardData.title });
    const headerState = header.createDiv({ cls: "xz-archive-knowledge-card-header-state" });
    headerState.createSpan({ cls: "xz-status-tag", text: cardData.decisionLabel });
    const fullScreenHint = headerState.createSpan({ cls: "xz-archive-knowledge-card-toggle" });
    fullScreenHint.createSpan({ text: "全屏阅读" });
    const fullScreenIcon = fullScreenHint.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(fullScreenIcon, "maximize-2");

    const glance = summary.createDiv({ cls: "xz-archive-knowledge-card-glance" });
    const compactPreview = cardData.summary.length > 160
      ? `${cardData.summary.slice(0, 159).trimEnd()}…`
      : cardData.summary;
    glance.createEl("p", { text: compactPreview || "本次整理尚未生成核心内容" });
    const glanceMeta = glance.createDiv({ cls: "xz-archive-knowledge-card-glance-meta" });
    [cardData.epistemicLabel, cardData.operationLabel]
      .filter(Boolean)
      .forEach((value) => glanceMeta.createSpan({ text: value }));
    if (cardData.tags.length) glanceMeta.createSpan({ text: `${cardData.tags.length} 个标签` });

    const actions = card.createDiv({ cls: "xz-archive-knowledge-card-actions" });
    const availability = {
      selected: { label: "可选择 · 已纳入", className: "is-selectable" },
      written: { label: "已写入 · 等待最终确认", className: "is-written" },
      blocked: { label: "需要先处理 · 暂不可写入", className: "is-blocked" },
      removed: { label: "已移出 · 可以恢复", className: "is-removed" },
      unavailable: { label: "系统不可选", className: "is-unavailable" },
      readonly: { label: "审核已锁定", className: "is-readonly" },
    }[displayActionMode] || { label: "查看状态", className: "is-readonly" };
    actions.createSpan({
      cls: `xz-archive-card-availability ${availability.className}`,
      text: availability.label,
    });
    const canEdit = !this.busy
      && !["content-confirmed", "archived", "stale"].includes(draft.status)
      && !isWritten
      && typeof this.plugin?.setArchiveCandidateSelection === "function";
    if (displayActionMode === "selected") {
      const remove = actions.createEl("button", {
        cls: "xz-secondary-button xz-archive-candidate-remove",
        text: "移出本次归档",
        attr: {
          type: "button",
          title: "取消“纳入本次归档”；之后可在“已移出”恢复",
        },
      });
      remove.disabled = !canEdit;
      remove.addEventListener("click", () => this.runAction(() => (
        this.plugin.setArchiveCandidateSelection(
          this.conversationId,
          draft.id,
          candidate.id,
          false,
        )
      ), "已移出本次归档；可在“已移出”恢复"));
    } else if (displayActionMode === "removed") {
      const restore = actions.createEl("button", {
        cls: "xz-secondary-button xz-archive-candidate-restore",
        text: "恢复到可选知识",
        attr: { type: "button" },
      });
      restore.disabled = !canEdit;
      restore.addEventListener("click", () => this.runAction(() => (
        this.plugin.setArchiveCandidateSelection(
          this.conversationId,
          draft.id,
          candidate.id,
          true,
        )
      ), "已恢复到可选知识"));
    }
    if (displayActionMode === "selected" && candidateWrites.length) {
      const writeSingle = actions.createEl("button", {
        cls: "xz-primary-button xz-archive-candidate-write",
        text: "确认并单独写入",
        attr: { type: "button" },
      });
      const canWriteCandidate = !this.busy
        && draft.status === "preview-ready"
        && draft.counts.blocked === 0
        && typeof this.plugin?.confirmArchiveCandidate === "function";
      writeSingle.disabled = !canWriteCandidate;
      writeSingle.setAttr("title", canWriteCandidate
        ? "只写入这张知识卡；其他卡片保持待审核，不会最终归档对话"
        : "请先处理待澄清内容或重新生成过期预览");
      writeSingle.addEventListener("click", () => this.runAction(() => (
        this.plugin.confirmArchiveCandidate(this.conversationId, draft.id, candidate.id)
      ), "这张知识卡已写入；其他卡片仍可继续逐张审核"));
    }
    if (typeof renderActions === "function") renderActions(actions, { canEdit, cardData });
    const detail = actions.createEl("button", {
      cls: "xz-secondary-button xz-archive-knowledge-card-detail",
      text: "查看完整详情",
      attr: { type: "button" },
    });
    detail.addEventListener("click", openDetails);
    return card;
  }

  render() {
    const scrollSnapshot = this.captureScrollPosition();
    let root = null;
    try {
      const conversation = this.conversation();
      const draft = this.draft();
      this.contentEl.empty();
      this.cardSequence = 0;
      root = this.contentEl.createDiv({ cls: "xz-archive-review xz-archive-review-page" });
      if (!conversation || !draft) {
        this.renderEmptyCard(root, "尚未生成归档预览", "请返回对话并点击“预览并归档”。");
        return;
      }
    const groups = groupArchiveCandidates(draft.candidates);
    const selectedReady = groups.selected;
    const blocking = groups.blocking;
    const restorable = groups.restorable;
    const unavailable = groups.unavailable;
    const reviewLocked = ["content-confirmed", "archived"].includes(draft.status);
    const selectedCandidateIds = new Set(draft.candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => candidate.id));
    const actualWriteKeys = new Set(draft.actualWrites
      .map((write) => `${write.candidateId || ""}\u0000${write.path || ""}`));
    const selectedPlannedWrites = draft.plannedWrites.filter((write) => (
      !write.candidateId || selectedCandidateIds.has(write.candidateId)
    ));
    const remainingWrites = selectedPlannedWrites.filter((write) => (
      !actualWriteKeys.has(`${write.candidateId || ""}\u0000${write.path || ""}`)
    ));
    const writeItems = [...draft.actualWrites, ...remainingWrites];
    const navItems = draft.status === "source-review"
      ? [{ id: "sources", label: "来源", count: draft.counts.selectedMessages }]
      : [
        { id: "overview", label: "总览", count: null },
        { id: "planned", label: "可选知识", count: selectedReady.length },
        { id: "blocking", label: "待处理", count: blocking.length },
        { id: "removed", label: "已移出", count: restorable.length },
        { id: "unavailable", label: "不可选", count: unavailable.length },
        { id: "sources", label: "来源", count: draft.sources.length },
        { id: "results", label: "保存结果", count: writeItems.length + 1 },
      ];
    const preferredSection = draft.status === "source-review"
      ? "sources"
      : selectedReady.length ? "planned" : "overview";
    this.syncActiveSection(draft, navItems, preferredSection);
    root.setAttribute("data-archive-conversation-id", this.conversationId);
    root.setAttribute("data-archive-draft-id", draft.id);
    root.setAttribute("data-archive-section-id", this.activeSectionId);
    const header = root.createDiv({ cls: "xz-archive-page-header" });
    const heading = header.createDiv({ cls: "xz-archive-page-heading" });
    heading.createSpan({ cls: "xz-archive-page-kicker", text: "独立归档审核页" });
    heading.createEl("h1", { text: text(conversation.title, "未命名对话") });
    heading.createEl("p", { text: statusText(draft.status, draft.archiveScope) });
    const headerActions = header.createDiv({ cls: "xz-archive-page-header-actions" });
    const mode = headerActions.createSpan({ cls: "xz-archive-review-mode", text: draft.mode === "transcript-only" ? "仅保存原始对话" : "整理知识并归档" });
    mode.setAttr("title", draft.mode === "transcript-only"
      ? "不生成正式知识，但仍需审核和两次确认"
      : "先审核知识候选，再确认写入和最终归档");
    const back = headerActions.createEl("button", { cls: "xz-secondary-button", text: "返回对话", attr: { type: "button" } });
    back.addEventListener("click", () => { void this.returnToWorkbench(); });
    this.pageNav(header, navItems);
    if (draft.status !== "source-review") {
      header.createEl("p", {
        cls: "xz-archive-page-hint",
        text: "一次只显示一个板块。移出只影响本次归档，可在“已移出”恢复；系统不可选项不会被强制写入。",
      });
    }

    if (draft.status === "stale" || draft.error) {
      const error = root.createDiv({ cls: "xz-archive-review-alert", attr: { role: "alert" } });
      const archiveErrorText = text(draft.error, conversation.archiveError, "请重新生成预览后再继续。");
      const isWriteLimitError = archiveErrorText.includes("写入文件数量超过安全上限");
      error.createEl("strong", { text: draft.status === "stale" ? "这份预览已经过期" : "上次操作未完成" });
      error.createEl("p", { text: archiveErrorText });
      if (isWriteLimitError) {
        error.createEl("p", {
          text: "本次知识卡数量超过单次事务上限。请在下方知识卡中使用“确认并单独写入”；已经写入的卡不会在后续确认中重复写入。",
        });
      }
      const progress = conversation.archiveProgress;
      if (progress && Number.isInteger(progress.totalChunks) && progress.totalChunks > 0) {
        const completed = Math.max(0, Math.min(progress.nextChunkIndex || 0, progress.totalChunks));
        error.createEl("p", {
          text: `阶段进度：已安全保存 ${completed}/${progress.totalChunks} 段。`,
        });
        if (completed > 0 && !progress.checkpoint) {
          error.createEl("p", {
            text: "旧版阶段结果缺少候选快照；继续时会从第一段安全重建，不会生成只有标题和标签的空归档。",
          });
        }
      }
      if (!isWriteLimitError && draft.status !== "stale" && typeof this.plugin?.backgroundArchiveConversation === "function") {
        const actions = error.createDiv({ cls: "xz-archive-review-alert-actions" });
        const retry = actions.createEl("button", {
          cls: "mod-cta",
          text: "继续生成审核内容",
          attr: { type: "button" },
        });
        retry.disabled = this.busy;
        retry.setAttr("title", "从已保存阶段继续；旧版缺少候选快照时会自动安全重建");
        retry.addEventListener("click", () => this.runAction(async () => {
          await this.plugin.backgroundArchiveConversation(this.conversationId);
        }, "归档审核内容已恢复，请继续检查知识卡片"));
      }
    }

    this.pageSection(root, {
      id: "overview",
      title: "归档总览",
      description: "先确认范围、摘要和草稿状态",
      wide: true,
    }, (body) => {
      const stats = body.createDiv({ cls: "xz-archive-review-stats" });
      [
        ["来源消息", draft.counts.messages],
        ["已选知识", selectedReady.length],
        ["待处理", blocking.length],
        ["已移出", restorable.length],
        ["系统不可选", unavailable.length],
      ].forEach(([label, value]) => {
        const stat = stats.createDiv();
        stat.createEl("strong", { text: String(value) });
        stat.createSpan({ text: label });
      });
      this.renderContentCard(body, {
        kicker: "归档摘要",
        title: "本次归档内容概览",
        summary: draft.summary || "本次没有生成摘要",
        status: statusText(draft.status, draft.archiveScope),
        meta: [
          { label: "归档标签", value: draft.tags.join("、") || "无" },
          { label: "生成时间", value: formatTime(draft.generatedAt) },
        ],
        actionLabel: selectedReady.length
          ? `查看 ${selectedReady.length} 条可选知识正文`
          : "查看完整归档摘要",
        onClick: selectedReady.length
          ? () => {
              this.activeSectionId = "planned";
              this.render();
              setTimeout(() => this.contentEl
                .querySelector('button[data-section-id="planned"]')
                ?.focus(), 0);
            }
          : () => this.openItemDetails("归档总览", [
              { label: "归档摘要", value: draft.summary, pre: true },
              { label: "归档标签", value: draft.tags.join("、") || "无" },
              { label: "归档模式", value: draft.mode === "transcript-only" ? "仅保存原始对话" : "整理知识并归档" },
              { label: "草稿生成时间", value: formatTime(draft.generatedAt) },
              { label: "草稿编号", value: draft.id },
              { label: "内容指纹", value: draft.fingerprint },
            ]),
      });
    });

    this.pageSection(root, {
      id: "planned",
      title: "可选知识",
      count: selectedReady.length,
      description: "当前已纳入本次归档；可以查看详情或移出，移出后仍可恢复",
      wide: true,
    }, (body) => {
      if (!selectedReady.length) this.renderEmptyCard(body, "当前没有已选择的知识", "可以到“已移出”恢复候选；系统不可选项不会进入可选列表。");
      else body.createEl("p", {
        cls: "xz-archive-knowledge-card-guide",
        text: "知识卡统一以固定尺寸展示。点击卡片可全屏核对完整正文与 Markdown；也可以逐张确认并单独写入，已写入的卡不会重复写入。",
      });
      selectedReady.forEach((candidate) => this.renderCandidate(body, candidate, draft, {
        actionMode: reviewLocked ? "readonly" : "selected",
      }));
    });

    this.pageSection(root, {
      id: "blocking",
      title: "需要先处理",
      count: blocking.length,
      description: "这些候选暂时不可写入；请补充真实信息，或者将其移出本次归档",
      wide: true,
    }, (body) => {
      if (!blocking.length) this.renderEmptyCard(body, "当前没有待处理项目", "所有阻断项都已处理，可以继续审核可选知识。");
      blocking.forEach((candidate) => {
        const clarification = draft.clarifications.find((item) => item.candidateId === candidate.id) || {};
        this.renderCandidate(body, candidate, draft, {
          actionMode: reviewLocked ? "readonly" : "blocked",
          renderActions: reviewLocked ? null : (actions, { canEdit }) => {
            const supplement = actions.createEl("button", {
              cls: "xz-primary-button",
              text: "补充后重新整理",
              attr: { type: "button" },
            });
            supplement.disabled = !canEdit || typeof this.plugin?.submitArchiveClarification !== "function";
            supplement.addEventListener("click", async () => {
              const answer = await new XingzhiArchiveClarificationModal(this.app, {
                title: `补充：${itemTitle(candidate, "知识候选")}`,
                question: text(clarification.question, "请补充这项知识的真实情况。"),
              }).waitForValue();
              if (!answer) return;
              await this.runAction(async () => {
                await this.plugin.submitArchiveClarification(
                  this.conversationId,
                  draft.id,
                  candidate.id,
                  answer,
                );
              }, "补充已保存，归档预览已重新生成");
            });
            const remove = actions.createEl("button", {
              cls: "xz-secondary-button",
              text: "移出本次归档",
              attr: { type: "button" },
            });
            remove.disabled = !canEdit;
            remove.addEventListener("click", () => this.runAction(() => (
              this.plugin.setArchiveCandidateSelection(this.conversationId, draft.id, candidate.id, false)
            ), "已移出本次归档；可在“已移出”恢复"));
          },
        });
      });
    });

    this.pageSection(root, {
      id: "removed",
      title: "已移出本次归档",
      count: restorable.length,
      description: "这些内容只是从本次选择中移出，没有被删除；确认写入前可以恢复",
      wide: true,
    }, (body) => {
      if (!restorable.length) this.renderEmptyCard(body, "没有已移出的知识", "从“可选知识”或“待处理”移出的候选会出现在这里，并可以恢复。");
      restorable.forEach((candidate) => this.renderCandidate(body, candidate, draft, {
        actionMode: reviewLocked ? "readonly" : "removed",
      }));
    });

    this.pageSection(root, {
      id: "unavailable",
      title: "系统不可选",
      count: unavailable.length,
      description: "因拒绝、重复合并或安全政策不能写入；可以查看原因，但不能强制恢复",
      wide: true,
    }, (body) => {
      if (!unavailable.length) this.renderEmptyCard(body, "没有系统不可选项", "本次没有被政策拒绝或判定为重复合并的知识候选。");
      unavailable.forEach((candidate) => this.renderCandidate(body, candidate, draft, {
        actionMode: "unavailable",
      }));
    });

    this.pageSection(root, {
      id: "sources",
      title: draft.archiveScope === "message-blocks" ? "所选段落来源" : "来源对话",
      count: draft.sources.length,
      description: draft.archiveScope === "message-blocks"
        ? "这里只显示本次勾选的原文；只读上下文不会成为知识来源"
        : "内部提示和工具调用不会显示",
      wide: false,
    }, (body) => {
      if (!draft.sources.length) {
        this.renderEmptyCard(body, "没有可展示的来源对话", "当前归档草稿没有保留用户或助手消息。内部提示和工具调用始终不会显示。");
      }
      draft.sources.forEach((source, index) => this.renderContentCard(body, {
        kicker: "来源对话",
        title: `${source.role === "user" ? "用户" : "助手"} · 第 ${index + 1} 条`,
        summary: source.content,
        status: formatTime(source.createdAt),
        meta: [
          { label: "说话方", value: source.role === "user" ? "用户" : "助手" },
          { label: "消息编号", value: source.messageId },
        ],
        actionLabel: "查看完整原文",
        onClick: () => this.openItemDetails("来源对话原文", [
          { label: "说话方", value: source.role === "user" ? "用户" : "助手" },
          { label: "消息时间", value: formatTime(source.createdAt) },
          { label: "消息编号", value: source.messageId },
          { label: "完整原文", value: source.content, pre: true },
        ]),
      }));
    });

    this.pageSection(root, {
      id: "results",
      title: "保存位置与实际结果",
      count: writeItems.length + 1,
      description: draft.actualWrites.length ? "同时显示已写入结果和剩余计划" : "当前显示计划保存位置",
      wide: false,
    }, (body) => {
      const transcriptPath = globalThis.__xzArchive.transcript(conversation.id, conversation);
      this.renderContentCard(body, {
        kicker: "原始对话",
        title: "原始对话记录",
        summary: transcriptPath,
        status: conversation.archivedAt ? "已归档" : "持续保存中",
        meta: [
          { label: "保存类型", value: "对话证据" },
          { label: "当前状态", value: conversation.archivedAt ? "已完成最终归档" : "仍在当前对话列表" },
        ],
        actionLabel: "查看保存详情",
        onClick: () => this.openItemDetails("原始对话保存位置", [
          { label: "Vault 路径", value: transcriptPath },
          { label: "当前状态", value: conversation.archivedAt ? "已完成最终归档" : "仍在当前对话列表" },
        ], transcriptPath),
      });
      writeItems.forEach((write) => {
        const isActualWrite = write.status === "written";
        this.renderContentCard(body, {
        kicker: isActualWrite ? "实际写入结果" : "计划保存位置",
        title: itemTitle(write, "知识文件"),
        summary: write.path,
        status: text(write.status, write.operation, "计划写入"),
        meta: [
          { label: "操作", value: text(write.operation, "计划写入") },
          { label: "事务编号", value: write.transactionId },
          { label: "错误", value: write.error },
        ],
        actionLabel: "查看保存详情",
        onClick: () => this.openItemDetails("知识保存位置与结果", [
          { label: "文件路径", value: write.path },
          { label: "操作", value: write.operation },
          { label: "实际结果", value: write.status },
          { label: "事务编号", value: write.transactionId },
          { label: "错误", value: write.error },
        ], write.path),
        });
      });
    });

    const footer = root.createDiv({ cls: "xz-archive-review-footer" });
    const close = footer.createEl("button", { text: "返回对话", attr: { type: "button" } });
    close.addEventListener("click", () => { void this.returnToWorkbench(); });
    if (!["content-confirmed", "archived"].includes(draft.status)) {
      if (draft.archiveScope !== "message-blocks") {
        const regenerate = footer.createEl("button", {
          cls: "xz-secondary-button",
          text: "重新整理全部对话",
          attr: { type: "button" },
        });
        regenerate.disabled = this.busy || draft.actualWrites.length > 0;
        regenerate.setAttr("title", draft.actualWrites.length
          ? "已有知识卡写入知识库；请完成本次知识确认，不能直接重新整理"
          : "重新整理全部可见来源对话");
        regenerate.addEventListener("click", () => this.runAction(async () => {
          await this.plugin.backgroundArchiveConversation(this.conversationId);
        }, "已在后台重新整理全部对话，请继续审核知识卡片"));
      }
      const confirm = footer.createEl("button", {
        cls: "mod-cta",
        text: draft.actualWrites.length
          ? remainingWrites.length ? `确认写入剩余 ${remainingWrites.length} 条` : "完成知识确认"
          : "确认写入所选知识",
        attr: { type: "button" },
      });
      confirm.disabled = this.busy || draft.status !== "preview-ready" || draft.counts.blocked > 0;
      confirm.setAttr("title", confirm.disabled
        ? "请先解决阻断项或重新生成过期预览"
        : "提交当前选中的知识；对话仍不会消失");
      confirm.addEventListener("click", () => this.runAction(() => (
        this.plugin.confirmArchiveContents(this.conversationId, draft.id)
      ), draft.archiveScope === "message-blocks"
        ? "所选知识已写入；请检查结果后完成本次段落归档"
        : "所选知识已写入；请继续检查实际结果后再最终归档"));
    } else if (draft.status === "content-confirmed") {
      const final = footer.createEl("button", {
        cls: draft.archiveScope === "message-blocks" ? "mod-cta" : "mod-warning",
        text: draft.archiveScope === "message-blocks" ? "完成本次段落归档" : "最终确认归档",
        attr: { type: "button" },
      });
      final.disabled = this.busy;
      final.setAttr("title", draft.archiveScope === "message-blocks"
        ? "记录所选段落已完成归档；原对话仍保留在当前列表"
        : "完成后对话才会移入归档列表");
      final.addEventListener("click", () => this.runAction(async () => {
        await this.plugin.finalizeArchive(this.conversationId, draft.id);
        await this.returnToWorkbench();
      }, draft.archiveScope === "message-blocks"
        ? "所选段落已完成归档，原对话保持可见"
        : "对话已完成最终归档"));
    }
    } finally {
      this.restoreScrollPosition(root, scrollSnapshot);
    }
  }

  async runAction(action, successMessage = "归档审核已更新") {
    if (this.busy) return;
    this.busy = true;
    this.contentEl?.addClass?.("is-archive-busy");
    this.contentEl?.querySelectorAll?.("button, input, select, textarea")
      ?.forEach((control) => { control.disabled = true; });
    try {
      await action();
      new Notice(successMessage);
    } catch (error) {
      new Notice(`归档操作未完成：${text(error?.message, error, "未知错误")}`);
    } finally {
      this.busy = false;
      this.contentEl?.removeClass?.("is-archive-busy");
      if (this.contentEl?.isConnected) this.render();
    }
  }
}

module.exports = {
  VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW,
  XingzhiArchiveClarificationModal,
  XingzhiArchiveItemDetailModal,
  XingzhiArchiveReviewView,
};
