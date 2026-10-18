"use strict";

const { Notice, setIcon } = require("obsidian");

const PLAN_LEVELS = Object.freeze([
  { id: "year", label: "年计划" },
  { id: "month", label: "月计划" },
  { id: "week", label: "周计划" },
  { id: "day", label: "日计划" },
]);

const HEALTH_LABELS = Object.freeze({
  completed: "已完成",
  blocked: "阻塞",
  waiting: "等待",
  overdue: "逾期",
  "not-started": "尚未启动",
  lagging: "进度滞后",
  "on-track": "正常推进",
  unknown: "依据不足",
  cancelled: "已取消",
});

const DECISION_STATE_LABELS = Object.freeze({
  conflicted: "结果冲突",
  pending: "待确认",
  scheduled: "待复查",
  due: "今日复查",
  overdue: "复查逾期",
  unscheduled: "未设复查日期",
  reviewed: "已记录结果",
  corrected: "已修正",
  closed: "已关闭",
});

class DailyReviewViewController {
  constructor(plugin, refresh) {
    this.plugin = plugin;
    this.refresh = refresh;
    this.operationBusy = false;
    this.planLevel = "day";
    this.expandedCardIds = new Set();
  }

  state() {
    return this.plugin?.getDailyReviewState?.() || {
      status: "idle",
      draft: null,
      snapshots: [],
      error: null,
    };
  }

  get busy() {
    return this.operationBusy;
  }

  async run(operation, successMessage = "") {
    if (this.busy) return;
    this.operationBusy = true;
    this.refresh();
    try {
      await operation();
      if (successMessage) new Notice(successMessage);
    } catch (error) {
      new Notice(error?.message || "每日回顾操作失败");
    } finally {
      this.operationBusy = false;
      this.refresh();
    }
  }

  async openSource(path) {
    try {
      await this.plugin.openVaultPath(path, { mode: "tab" });
    } catch (error) {
      new Notice(error?.message || "来源笔记无法打开");
    }
  }

  selectPlanLevel(level) {
    if (!PLAN_LEVELS.some((item) => item.id === level)) return;
    this.planLevel = level;
    this.refresh();
  }

  toggleCard(cardId) {
    const id = typeof cardId === "string" ? cardId.trim() : "";
    if (!id) return;
    const wasExpanded = this.expandedCardIds.has(id);
    this.expandedCardIds.clear();
    if (!wasExpanded) this.expandedCardIds.add(id);
    this.refresh();
    if (wasExpanded) {
      const safeId = id.replace(/[^a-z0-9_-]/giu, "-");
      queueMicrotask(() => globalThis.document
        ?.querySelector?.(`.xz-daily-card[data-card-id="${safeId}"] .xz-daily-card-toggle`)
        ?.focus?.());
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatDateTime(value, fallback = "尚未生成") {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value, fallback = "未设置") {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function addButton(parent, label, onClick, { primary = false, disabled = false, cls = "" } = {}) {
  const button = parent.createEl("button", {
    cls: ["xz-daily-button", primary ? "is-primary" : "", cls].filter(Boolean).join(" "),
    text: label,
    attr: { type: "button" },
  });
  button.disabled = disabled;
  if (typeof onClick === "function") button.addEventListener("click", () => onClick(button));
  return button;
}

function createCard(parent, {
  id,
  title,
  kicker = "",
  tone = "neutral",
  conclusion = "",
  expanded = false,
  onToggle,
}) {
  const cardId = String(id || "card").replace(/[^a-z0-9_-]/giu, "-");
  const headingId = `xz-daily-card-${cardId}-preview-heading`;
  const bodyId = `xz-daily-card-${cardId}-preview-body`;
  const dialogId = `xz-daily-card-${cardId}-dialog`;
  const card = parent.createEl("section", {
    cls: `xz-daily-card xz-product-card-frame is-${tone}`,
    attr: { "aria-labelledby": headingId, "data-card-id": cardId },
  });
  const header = card.createDiv({ cls: "xz-daily-card-head" });
  const copy = header.createDiv();
  if (kicker) copy.createSpan({ cls: "xz-daily-kicker", text: kicker });
  copy.createEl("h2", { text: title, attr: { id: headingId } });
  const toggle = header.createEl("button", {
    cls: "xz-daily-card-toggle",
    text: "展开",
    attr: {
      type: "button",
      "aria-expanded": String(expanded),
      "aria-haspopup": "dialog",
      ...(expanded ? { "aria-controls": dialogId } : {}),
      "aria-label": `全屏展开卡片：${title}`,
    },
  });
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    onToggle?.(id);
  });
  card.addEventListener("click", (event) => {
    if (event.target?.closest?.("button, a, input, select, textarea, summary")) return;
    onToggle?.(id);
  });
  const body = card.createDiv({
    cls: "xz-daily-card-body",
    attr: {
      id: bodyId,
      "aria-hidden": "true",
      inert: "",
    },
  });
  if (conclusion) body.createEl("p", { cls: "xz-daily-conclusion", text: conclusion });
  return body;
}

function createCardDialog(parent, {
  id,
  title,
  kicker = "",
  tone = "neutral",
  conclusion = "",
  onClose,
}) {
  const cardId = String(id || "card").replace(/[^a-z0-9_-]/giu, "-");
  const dialogId = `xz-daily-card-${cardId}-dialog`;
  const headingId = `${dialogId}-heading`;
  const bodyId = `${dialogId}-body`;
  const dialog = parent.createEl("dialog", {
    cls: "xz-daily-card-dialog",
    attr: { id: dialogId, "aria-labelledby": headingId, "aria-modal": "true" },
  });
  const card = dialog.createEl("article", {
    cls: `xz-daily-card is-${tone} is-expanded`,
    attr: { "data-card-id": cardId },
  });
  const header = card.createDiv({ cls: "xz-daily-card-head" });
  const copy = header.createDiv();
  if (kicker) copy.createSpan({ cls: "xz-daily-kicker", text: kicker });
  copy.createEl("h2", { text: title, attr: { id: headingId } });
  const close = header.createEl("button", {
    cls: "xz-daily-card-toggle is-close",
    text: "收起",
    attr: {
      type: "button",
      "aria-expanded": "true",
      "aria-controls": bodyId,
      "aria-label": `收起全屏卡片：${title}`,
    },
  });
  close.addEventListener("click", () => onClose?.(id));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onClose?.(id);
  });
  const body = card.createDiv({ cls: "xz-daily-card-body", attr: { id: bodyId } });
  if (conclusion) body.createEl("p", { cls: "xz-daily-conclusion", text: conclusion });
  queueMicrotask(() => {
    if (!dialog.isConnected) return;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    close.focus();
  });
  return body;
}

function renderEmpty(card, text) {
  card.createEl("p", { cls: "xz-daily-empty-copy", text });
}

function knowledgeSourceTitle(path) {
  const filename = String(path || "").replaceAll("\\", "/").split("/").at(-1)?.replace(/\.md$/iu, "") || "来源笔记";
  return filename.replace(/-{1,2}k-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu, "").trim() || filename;
}

function renderSources(parent, paths, onOpenSource) {
  const unique = [...new Set(asArray(paths).filter((path) => typeof path === "string" && path.trim()))].slice(0, 4);
  if (!unique.length) return;
  const sources = parent.createDiv({ cls: "xz-daily-sources", attr: { "aria-label": "来源笔记" } });
  unique.forEach((path) => {
    const button = sources.createEl("button", {
      cls: "xz-daily-source",
      text: `来源 · ${knowledgeSourceTitle(path)}`,
      attr: { type: "button", title: path },
    });
    button.addEventListener("click", () => onOpenSource?.(path));
  });
}

function uniqueKnowledgeItems(...groups) {
  const result = [];
  const seen = new Set();
  for (const item of groups.flatMap((group) => asArray(group))) {
    const key = typeof item?.path === "string" && item.path.trim()
      ? item.path.trim()
      : `${safeText(item?.title, "未命名")}\u0000${safeText(item?.summary, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function renderKnowledgeItems(card, items, onOpenSource, emptyText, { expanded = false } = {}) {
  const values = asArray(items).slice(0, expanded ? 50 : 3);
  if (!values.length) {
    renderEmpty(card, emptyText);
    return;
  }
  const list = card.createEl("ol", { cls: "xz-daily-knowledge-list" });
  values.forEach((item) => {
    const row = list.createEl("li", { cls: "xz-daily-knowledge-entry" });
    row.createSpan({ cls: "xz-daily-field-label", text: "入库内容标题" });
    row.createEl("h3", { text: safeText(item.title, "未命名笔记") });
    const overview = row.createDiv({ cls: "xz-daily-knowledge-overview" });
    overview.createSpan({ cls: "xz-daily-field-label", text: "核心内容总览" });
    overview.createEl("p", { text: safeText(item.summary, "没有可用摘要。") });
    const pointSection = row.createDiv({ cls: "xz-daily-knowledge-points" });
    pointSection.createSpan({ cls: "xz-daily-field-label", text: "核心知识点" });
    const points = asArray(item.corePoints).slice(0, 6);
    if (points.length) {
      const pointList = pointSection.createEl("ul");
      points.forEach((point) => pointList.createEl("li", { text: safeText(point, "未命名知识点") }));
    } else {
      pointSection.createEl("p", { cls: "xz-daily-caveat", text: "未识别到显式知识点，可打开来源查看完整内容。" });
    }
    renderSources(row, [item.path], onOpenSource);
  });
}

function renderTopicList(card, topics, emptyText) {
  const values = asArray(topics).slice(0, 8);
  if (!values.length) {
    renderEmpty(card, emptyText);
    return;
  }
  const tags = card.createDiv({ cls: "xz-daily-topics", attr: { "aria-label": "主题摘要" } });
  values.forEach((topic) => tags.createSpan({ text: `${safeText(topic.label, "未分类")} · ${Number(topic.count) || 0}` }));
}

function renderSuggestionList(card, draft, options) {
  const suggestions = asArray(draft?.today?.suggestions);
  if (!suggestions.length) {
    renderEmpty(card, "当前没有足够证据生成推进项。先确认一个最小行动，或完善计划字段后重新检索。");
    return;
  }
  const list = card.createEl("ol", { cls: "xz-daily-priority-list" });
  suggestions.forEach((suggestion, index) => {
    const row = list.createEl("li", { cls: "xz-daily-priority-item" });
    row.createSpan({ cls: "xz-daily-priority-index", text: String(index + 1) });
    const copy = row.createDiv({ cls: "xz-daily-priority-copy" });
    copy.createEl("strong", { text: safeText(suggestion.title, "未命名推进项") });
    copy.createEl("p", { text: safeText(suggestion.reason, "没有补充理由。") });
    renderSources(copy, suggestion.sourcePaths, options.onOpenSource);
  });
}

function renderBlockers(card, blockers, onOpenSource) {
  const values = asArray(blockers).slice(0, 6);
  if (!values.length) {
    renderEmpty(card, "没有发现明确逾期、阻塞或等待项。注意：缺少结构化日期时，系统无法据此证明进度正常。");
    return;
  }
  const list = card.createEl("ul", { cls: "xz-daily-list" });
  values.forEach((item) => {
    const row = list.createEl("li", { cls: "xz-daily-list-item" });
    row.createEl("strong", { text: safeText(item.title, "未命名事项") });
    row.createEl("p", { text: safeText(item.reason, "缺少补充说明。") });
    renderSources(row, item.sourcePaths, onOpenSource);
  });
}

function renderPlanOverview(card, draft, options) {
  const tabs = card.createDiv({ cls: "xz-daily-plan-tabs", attr: { role: "tablist", "aria-label": "计划视角" } });
  PLAN_LEVELS.forEach((level) => {
    const selected = options.planLevel === level.id;
    const tab = tabs.createEl("button", {
      text: level.label,
      attr: { type: "button", role: "tab", "aria-selected": String(selected) },
    });
    tab.toggleClass("is-active", selected);
    tab.addEventListener("click", () => options.onPlanLevelChange?.(level.id));
  });
  const completion = draft?.plans?.summary?.completionByLevel?.[options.planLevel] || {};
  const plans = asArray(draft?.plans?.levels?.[options.planLevel]);
  const summary = card.createDiv({ cls: "xz-daily-plan-summary" });
  summary.createEl("strong", {
    text: completion.averageProgress === null || completion.averageProgress === undefined
      ? "完成度：依据不足"
      : `平均完成度：${completion.averageProgress}%`,
  });
  summary.createSpan({ text: `共 ${Number(completion.total) || plans.length} 项，${Number(completion.known) || 0} 项有进度数据` });
  if (!plans.length) {
    renderEmpty(card, `没有识别到结构化${PLAN_LEVELS.find((item) => item.id === options.planLevel)?.label || "计划"}。`);
    return;
  }
  const list = card.createEl("ul", { cls: "xz-daily-plan-list" });
  plans.slice(0, 8).forEach((plan) => {
    const row = list.createEl("li");
    const head = row.createDiv({ cls: "xz-daily-plan-row" });
    head.createEl("strong", { text: safeText(plan.title, "未命名计划") });
    head.createSpan({
      cls: `xz-daily-state is-${safeText(plan.health?.state, "unknown")}`,
      text: HEALTH_LABELS[plan.health?.state] || "依据不足",
    });
    row.createEl("p", { text: safeText(plan.health?.reason, "缺少可验证的进度依据。") });
    const meta = row.createDiv({ cls: "xz-daily-plan-meta" });
    meta.createSpan({ text: plan.progress === null || plan.progress === undefined ? "进度未知" : `进度 ${plan.progress}%` });
    meta.createSpan({ text: `${formatShortDate(plan.startDate)}—${formatShortDate(plan.endDate)}` });
    renderSources(row, [plan.path], options.onOpenSource);
  });
}

function renderPlanLinks(card, draft, onOpenSource) {
  const chains = asArray(draft?.plans?.chains);
  const links = asArray(draft?.plans?.knowledgeLinks);
  if (!chains.length && !links.length) {
    renderEmpty(card, "尚未形成可验证的年 → 月 → 周 → 日链路，也没有知识笔记显式关联到计划。");
    return;
  }
  chains.slice(0, 3).forEach((chain) => {
    const flow = card.createDiv({ cls: "xz-daily-plan-chain", attr: { "aria-label": "计划链路" } });
    asArray(chain.items).forEach((plan, index) => {
      if (index) flow.createSpan({ cls: "xz-daily-chain-arrow", text: "→", attr: { "aria-hidden": "true" } });
      const button = flow.createEl("button", { text: safeText(plan.title, "未命名计划"), attr: { type: "button" } });
      button.addEventListener("click", () => onOpenSource?.(plan.path));
    });
  });
  if (links.length) {
    const list = card.createEl("ul", { cls: "xz-daily-list is-compact" });
    links.slice(0, 6).forEach((link) => {
      const item = list.createEl("li", { cls: "xz-daily-list-item" });
      item.createEl("strong", { text: safeText(link.title, "未命名知识") });
      item.createEl("p", { text: `关联计划：${safeText(link.planTitle, link.planId || "未知计划")}` });
      renderSources(item, [link.path, link.planPath], onOpenSource);
    });
  }
}

function renderProgress(card, draft) {
  const summary = draft?.plans?.summary || {};
  const health = summary.byHealth || {};
  const rows = card.createDiv({ cls: "xz-daily-progress-list" });
  PLAN_LEVELS.forEach((level) => {
    const value = summary.completionByLevel?.[level.id] || {};
    const row = rows.createDiv({ cls: "xz-daily-progress-row" });
    row.createSpan({ text: level.label });
    const progress = value.averageProgress;
    row.createEl("strong", { text: progress === null || progress === undefined ? "依据不足" : `${progress}%` });
    const track = row.createDiv({ cls: "xz-daily-progress-track", attr: { "aria-hidden": "true" } });
    const bar = track.createDiv({ cls: "xz-daily-progress-bar" });
    bar.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
  });
  const healthList = card.createDiv({ cls: "xz-daily-health-counts" });
  Object.entries(HEALTH_LABELS).forEach(([state, label]) => {
    const count = Number(health[state]) || 0;
    if (count) healthList.createSpan({ cls: `is-${state}`, text: `${label} ${count}` });
  });
  if (!summary.total) card.createEl("p", { cls: "xz-daily-caveat", text: "当前没有结构化计划，完成度不是 0%，而是未知。" });
}

function renderDecisionReview(card, draft, onOpenSource, { expanded = false } = {}) {
  const ordered = [
    ...asArray(draft?.decisions?.attention),
    ...asArray(draft?.decisions?.conflicted),
    ...asArray(draft?.decisions?.due),
    ...asArray(draft?.decisions?.reviewed),
    ...asArray(draft?.decisions?.open),
    ...asArray(draft?.decisions?.items),
  ];
  const seen = new Set();
  const decisions = ordered.filter((item) => {
    const key = safeText(item?.id, item?.path || item?.title || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, expanded ? 50 : 3);
  if (!decisions.length) {
    renderEmpty(card, "尚未识别到结构化决策。使用判断与决策模板记录预期结果和复查日期后，反馈闭环会显示在这里。");
    return;
  }
  const list = card.createEl("ol", { cls: "xz-daily-decision-list" });
  decisions.forEach((item) => {
    const row = list.createEl("li", { cls: "xz-daily-decision-entry" });
    const head = row.createDiv({ cls: "xz-daily-decision-head" });
    head.createEl("h3", { text: safeText(item.title, "未命名决策") });
    head.createSpan({
      cls: `xz-daily-state is-${safeText(item.state, "unknown")}`,
      text: DECISION_STATE_LABELS[item.state] || "状态未知",
    });
    if (item.question) row.createEl("p", { cls: "xz-daily-decision-question", text: item.question });
    const fields = row.createEl("dl", { cls: "xz-daily-decision-fields" });
    [
      ["当前判断", item.decision],
      ["预期结果", item.expectedResult],
      ["实际结果", item.actualResult],
      ["修正", item.correction],
    ].forEach(([label, value]) => {
      fields.createEl("dt", { text: label });
      fields.createEl("dd", { text: safeText(value, "尚未填写") });
    });
    const meta = row.createDiv({ cls: "xz-daily-plan-meta" });
    meta.createSpan({ text: `复查日期：${formatShortDate(item.reviewDate)}` });
    meta.createSpan({ text: safeText(item.stateReason, "缺少状态说明") });
    renderSources(row, [item.path, ...asArray(item.sourcePaths)], onOpenSource);
  });
}

function renderDataQuality(card, draft) {
  const sources = draft?.sources || {};
  const quality = sources.quality || {};
  const facts = card.createEl("dl", { cls: "xz-daily-facts" });
  [
    ["已扫描正式笔记", Number(sources.notesScanned) || 0],
    ["已扫描推进记录", Number(sources.actionsScanned) || 0],
    ["缺少创建时间", Number(quality.missingCreatedAt) || 0],
    ["缺少更新时间", Number(quality.missingUpdatedAt) || 0],
    ["无效计划字段", Number(quality.invalidPlanFields) || 0],
    ["无效决策字段", Number(quality.invalidDecisionFields) || 0],
    ["未关联结果反馈", Number(quality.unlinkedDecisionFeedback) || 0],
    ["冲突结果反馈", Number(quality.conflictingDecisionFeedback) || 0],
    ["已退出生命周期的反馈", Number(quality.inactiveDecisionFeedback) || 0],
    ["尚待确认的反馈", Number(quality.pendingDecisionFeedback) || 0],
    ["未形成知识卡", Number(quality.unorganizedKnowledgeNotes) || 0],
    ["拒绝的越界笔记", Number(quality.rejectedNotes) || 0],
  ].forEach(([label, value]) => {
    facts.createEl("dt", { text: label });
    facts.createEl("dd", { text: String(value) });
  });
  card.createEl("p", {
    cls: "xz-daily-caveat",
    text: "信息卡只展示工作台整理后的核心总结与知识点；原始证据、转录和未整理内容不会直接进入卡片。",
  });
}

function renderDailyReviewDashboard(parent, options = {}) {
  const state = options.state || { status: "idle", draft: null, snapshots: [], error: null };
  const busy = options.busy === true || state.status === "loading";
  const shell = parent.createEl("main", {
    cls: "xz-daily-shell",
    attr: { "aria-busy": String(busy), "aria-label": "每日决策与推进面板" },
  });
  const control = shell.createEl("section", { cls: "xz-daily-control" });
  const controlCopy = control.createDiv();
  controlCopy.createSpan({ cls: "xz-daily-kicker", text: "按日期与记录变化刷新 · 本地只读分析" });
  controlCopy.createEl("h2", { text: state.draft ? `${state.draft.period.date} · ${safeText(state.draft.period.weekday, "今日")}` : "从事实开始今天" });
  controlCopy.createEl("p", {
    text: state.draft
      ? `本周 ${state.draft.period.weekStart}—${state.draft.period.weekEnd} · 数据生成于 ${formatDateTime(state.draft.generatedAt)}`
      : "正在读取正式知识、计划和推进记录，生成可追溯的今日推进判断。",
  });
  const controlActions = control.createDiv({ cls: "xz-daily-control-actions" });
  addButton(controlActions, state.draft ? "重新检索" : "每日回顾", options.onGenerate, { primary: true, disabled: busy });
  if (state.draft) {
    const saved = asArray(state.snapshots).some((snapshot) => snapshot.id === state.draft.id);
    addButton(
      controlActions,
      saved ? "本次回顾已保存" : "保存本次回顾",
      options.onSave,
      { disabled: busy || saved },
    );
  }
  controlActions.createSpan({ text: `历史快照 ${asArray(state.snapshots).length} 份` });

  const live = shell.createDiv({ cls: "xz-daily-live", attr: { "aria-live": "polite" } });
  if (busy) live.createEl("p", { text: "正在检索知识、计划和推进记录……", attr: { role: "status" } });
  if (state.error) live.createEl("p", { cls: "is-error", text: `生成失败：${state.error}`, attr: { role: "status" } });
  if (state.draft && state.freshness === "stale" && !busy) live.createEl("p", { text: "当前显示上次生成的草稿，正在等待重新读取；历史快照保持原样。" });
  if (!state.draft && !busy) {
    const empty = shell.createDiv({ cls: "xz-daily-start", attr: { role: "status" } });
    const icon = empty.createDiv({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "calendar-check-2");
    empty.createEl("h2", { text: "今天还没有生成回顾" });
    empty.createEl("p", { text: "结果只会先生成草稿；不会自动覆盖计划，也不会自动创建执行项。" });
    addButton(empty, "每日回顾", options.onGenerate, { primary: true, disabled: busy });
    return shell;
  }
  if (!state.draft) return shell;

  const draft = state.draft;
  const expandedCardIds = options.expandedCardIds instanceof Set ? options.expandedCardIds : new Set();
  const renderCard = (target, id, settings, renderContent) => {
    const expanded = expandedCardIds.has(id);
    const preview = createCard(target, {
      id,
      ...settings,
      expanded,
      onToggle: options.onToggleCard,
    });
    renderContent(preview, { expanded: false, onOpenSource: options.onOpenSource });
    if (!expanded) return;
    const dialogBody = createCardDialog(shell, {
      id,
      ...settings,
      onClose: options.onToggleCard,
    });
    renderContent(dialogBody, {
      expanded: true,
      onOpenSource: (path) => {
        options.onToggleCard?.(id);
        queueMicrotask(() => options.onOpenSource?.(path));
      },
    });
  };

  const mainGrid = shell.createDiv({ cls: "xz-daily-grid is-main" });
  const buildCard = (id, settings, renderContent) => renderCard(mainGrid, id, settings, renderContent);
  buildCard("today", {
    kicker: "第一优先级",
    title: "今日需要推进",
    tone: "action",
    conclusion: `根据当前证据形成 ${asArray(draft.today?.suggestions).length} 条推进建议。建议仅供阅读，不会自动生成行动。`,
  }, (body, context) => renderSuggestionList(body, draft, {
    ...options,
    busy,
    onOpenSource: context.onOpenSource,
  }));

  buildCard(
    "blockers",
    { kicker: "异常信号", title: "阻塞与提醒", tone: "warning" },
    (body, context) => renderBlockers(body, draft.today?.blockers, context.onOpenSource),
  );

  buildCard("advice", { kicker: "推理边界", title: "今日建议", tone: "advice" }, (body) => {
    const guidance = asArray(draft.today?.guidance);
    if (!guidance.length) {
      renderEmpty(body, "没有额外建议；按今日推进顺序执行，并及时记录实际结果。");
      return;
    }
    const list = body.createEl("ul", { cls: "xz-daily-list is-compact" });
    guidance.forEach((item) => list.createEl("li", { text: item }));
  });

  buildCard("plan-overview", {
    kicker: "四级计划",
    title: "年计划 · 月计划 · 周计划 · 日计划",
    tone: "plan",
    conclusion: "只展示结构化且可追溯的计划；没有 parent_plan 时不会自动猜测承接关系。",
  }, (body, context) => renderPlanOverview(body, draft, {
    ...options,
    planLevel: options.planLevel || "day",
    onOpenSource: context.onOpenSource,
  }));

  buildCard(
    "progress",
    { kicker: "进度判断", title: "计划进度与阻塞", tone: "progress" },
    (body) => renderProgress(body, draft),
  );

  buildCard(
    "links",
    { kicker: "显式关联", title: "知识与计划关联", tone: "knowledge" },
    (body, context) => renderPlanLinks(body, draft, context.onOpenSource),
  );

  buildCard("decisions", {
    kicker: "判断闭环",
    title: "决策与反馈",
    tone: "advice",
    conclusion: `结构化决策 ${Number(draft.decisions?.summary?.total) || 0} 条；待核对 ${(
      Number(draft.decisions?.summary?.byState?.conflicted)
      + Number(draft.decisions?.summary?.byState?.overdue)
      + Number(draft.decisions?.summary?.byState?.due)
    ) || 0} 条。`,
  }, (body, context) => renderDecisionReview(
    body,
    draft,
    context.onOpenSource,
    { expanded: context.expanded },
  ));

  buildCard(
    "data-quality",
    { kicker: "可信度", title: "数据质量", tone: "neutral" },
    (body) => renderDataQuality(body, draft),
  );

  const informationReview = shell.createEl("section", {
    cls: "xz-daily-information-review",
    attr: { "aria-labelledby": "xz-daily-information-review-heading" },
  });
  const reviewHeading = informationReview.createDiv({ cls: "xz-daily-section-heading" });
  reviewHeading.createSpan({ cls: "xz-daily-kicker", text: "知识入库与沉淀" });
  reviewHeading.createEl("h2", { id: "xz-daily-information-review-heading", text: "信息回顾" });
  reviewHeading.createEl("p", { text: "查看入库内容标题、核心内容总览、核心知识点和可追溯来源。" });
  const reviewGrid = informationReview.createDiv({ cls: "xz-daily-grid is-information" });
  const buildReviewCard = (id, settings, renderContent) => renderCard(reviewGrid, id, settings, renderContent);

  buildReviewCard("yesterday", {
    kicker: "昨日入库",
    title: "昨日入库新内容",
    tone: "knowledge",
    conclusion: `可验证新增 ${Number(draft.knowledge?.totals?.yesterdayNew) || 0} 条。`,
  }, (body, context) => renderKnowledgeItems(
    body,
    draft.knowledge?.yesterdayNew,
    context.onOpenSource,
    "昨日没有发现带可靠创建时间的新笔记。",
    { expanded: context.expanded },
  ));

  buildReviewCard("week", {
    kicker: "本周沉淀",
    title: "本周入库总结",
    tone: "knowledge",
    conclusion: `新增 ${Number(draft.knowledge?.totals?.weekNew) || 0} 条，重点更新 ${Number(draft.knowledge?.totals?.weekUpdated) || 0} 条。`,
  }, (body, context) => {
    renderTopicList(body, draft.knowledge?.weekTopics, "本周内容尚未形成可识别的主题聚类。");
    renderKnowledgeItems(
      body,
      uniqueKnowledgeItems(draft.knowledge?.weekNew, draft.knowledge?.weekUpdated),
      context.onOpenSource,
      "本周没有发现带可靠时间信息的入库或重点更新内容。",
      { expanded: context.expanded },
    );
  });

  buildReviewCard(
    "yesterday-summary",
    { kicker: "主题压缩", title: "昨日知识摘要", tone: "knowledge" },
    (body) => renderTopicList(body, draft.knowledge?.yesterdaySummary, "昨日新增内容没有可识别的主题标签。"),
  );
  return shell;
}

module.exports = { DailyReviewViewController, knowledgeSourceTitle, renderDailyReviewDashboard };
