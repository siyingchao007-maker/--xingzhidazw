"use strict";

const { Notice } = require("obsidian");

const GOVERNANCE_BATCH_SIZE = 20;
const GOVERNANCE_CATEGORY_LABELS = Object.freeze({
  "content-duplicate": "重复知识",
  "version-conflict": "版本与冲突",
  classification: "分类判断",
  "structure-quality": "结构与质量",
  "source-integrity": "来源与完整性",
  "freshness-status": "时效与状态",
  "capability-definition": "能力定义",
});
const GOVERNANCE_PRIORITY_LABELS = Object.freeze({ high: "高优先级", medium: "中优先级", low: "低优先级" });
const GOVERNANCE_STATUS_LABELS = Object.freeze({ open: "当前待处理", deferred: "已暂缓", resolved: "最近已解决" });
const GOVERNANCE_QUEUE_LABELS = Object.freeze({
  all: "全部处理层级",
  agent: "Agent 待整理",
  completed: "已分析待复核",
  applied: "已写入待复核",
  human: "重大信息待确认",
  failed: "系统未能处理",
});

function textOr(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatCardDate(value, fallback = "未记录更新时间") {
  const normalized = textOr(value, "");
  const datePrefix = normalized.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
  if (datePrefix) return datePrefix;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp)).replaceAll("/", "-");
}

class KnowledgeGovernanceSection {
  constructor(options = {}) {
    this.plugin = options.plugin;
    this.reader = options.reader;
    this.setBusy = options.setBusy;
    this.rerender = options.rerender;
    this.onOpenPath = options.onOpenPath;
    this.onAnalyze = options.onAnalyze;
    this.onApplyAgentBatch = options.onApplyAgentBatch;
    this.onPreviewIssue = options.onPreviewIssue;
    this.onOpenLifecycleCandidate = options.onOpenLifecycleCandidate;
    this.status = "open";
    this.category = "all";
    this.queue = "all";
    this.visible = GOVERNANCE_BATCH_SIZE;
  }

  resetBatch() {
    this.visible = GOVERNANCE_BATCH_SIZE;
  }

  readerCard(item) {
    return {
      title: item?.title,
      typeLabel: GOVERNANCE_CATEGORY_LABELS[item?.category] || "知识治理",
      summary: item?.summary,
      keyPoints: Array.isArray(item?.reasons) ? item.reasons : [],
      suggestedUses: [item?.recommendation].filter(Boolean),
      tags: [
        GOVERNANCE_PRIORITY_LABELS[item?.priority],
        GOVERNANCE_STATUS_LABELS[item?.reviewStatus],
      ].filter(Boolean),
      path: Array.isArray(item?.paths) ? item.paths[0] : null,
      statusLabel: GOVERNANCE_STATUS_LABELS[item?.reviewStatus],
      updatedAt: item?.lastSeenAt,
      relatedKnowledge: (Array.isArray(item?.paths) ? item.paths : []).slice(1).map((path) => ({ path, label: path })),
    };
  }

  async setStatus(item, status) {
    if (!item?.id || typeof this.plugin?.setKnowledgeGovernanceItemStatus !== "function") return;
    this.setBusy?.(true);
    try {
      await this.plugin.setKnowledgeGovernanceItemStatus(item.id, status);
      new Notice(status === "deferred" ? "知识更新待办已暂缓，后续扫描仍会继续复核" : "知识更新待办已恢复到当前队列");
    } catch (error) {
      new Notice(`知识更新待办状态更新失败：${error?.message || "未知错误"}`);
    } finally {
      this.setBusy?.(false);
    }
  }

  async previewAgentBatch() {
    if (typeof this.plugin?.previewKnowledgeGovernanceAgentBatch !== "function") return;
    this.setBusy?.(true);
    try {
      const preview = await this.plugin.previewKnowledgeGovernanceAgentBatch({ limit: 5 });
      const completed = preview?.items?.filter((item) => item.status === "completed").length || 0;
      const failed = preview?.items?.filter((item) => item.status === "failed").length || 0;
      new Notice(`只读预演完成：成功 ${completed} 条，失败 ${failed} 条；没有写入任何笔记`);
    } catch (error) {
      new Notice(`Agent 只读预演失败：${error?.message || "未知错误"}`);
    } finally {
      this.setBusy?.(false);
      this.rerender?.();
    }
  }

  matchesQueue(item) {
    if (this.queue === "agent") return ["queued", "running", "interrupted"].includes(item.agentStatus);
    if (this.queue === "completed") return item.agentStatus === "completed";
    if (this.queue === "applied") return item.agentStatus === "applied";
    if (this.queue === "human") return item.handlingMode === "human-review";
    if (this.queue === "failed") return item.handlingMode === "system-failed" || item.agentStatus === "failed";
    return true;
  }

  renderAgentPreview(parent) {
    const preview = this.plugin?.getKnowledgeGovernanceAgentBatchState?.();
    if (!preview) return;
    const section = parent.createDiv({ cls: "xz-governance-agent-preview" });
    const head = section.createDiv({ cls: "xz-governance-agent-preview-head" });
    const heading = head.createDiv();
    heading.createEl("h4", { text: "首批 Agent 只读预演" });
    heading.createEl("p", { text: "本次预演不会写入或覆盖任何笔记；结果只用于核对摘要、分类、证据和风险级别。" });
    head.createSpan({ cls: "xz-status-chip", text: preview.status === "running" ? "正在整理" : "预演已结束" });
    if (!preview.items?.length) {
      section.createEl("p", { cls: "xz-maintenance-empty", text: "当前没有符合 L1/L2 边界的待整理知识。" });
      return;
    }
    const grid = section.createDiv({ cls: "xz-governance-preview-grid" });
    preview.items.forEach((entry, index) => {
      const card = grid.createEl("article", { cls: `xz-governance-preview-card xz-product-card-frame is-${entry.status}` });
      card.createEl("small", { text: `预演 ${index + 1} · ${entry.status === "completed" ? "已完成" : entry.status === "failed" ? "处理失败" : "正在整理"}` });
      card.createEl("h5", { text: textOr(entry.title, "待整理知识") });
      card.createEl("p", { text: entry.analysis?.summary || entry.error || "等待 Agent 返回整理结果。" });
      const tags = card.createDiv({ cls: "xz-governance-card-badges" });
      if (entry.analysis?.processingLevel) tags.createSpan({ cls: "xz-status-chip", text: entry.analysis.processingLevel });
      if (entry.analysis?.handlingMode) tags.createSpan({ cls: "xz-status-chip", text: entry.analysis.handlingMode });
      const open = card.createEl("button", { cls: "xz-secondary-button", text: "展开预演结果", attr: { type: "button" } });
      open.disabled = !entry.analysis;
      open.addEventListener("click", () => this.reader?.open({
        title: entry.title,
        typeLabel: "Agent 只读预演",
        summary: entry.analysis?.summary,
        keyPoints: entry.analysis?.keyPoints,
        suggestedUses: [entry.analysis?.recommendation].filter(Boolean),
        tags: entry.analysis?.classification,
        path: entry.path,
        statusLabel: entry.analysis?.processingLevel,
      }));
    });
    const eligible = preview.items.filter((entry) => entry.status === "completed"
      && entry.analysis?.processingLevel === "L1"
      && entry.analysis?.handlingMode === "agent-auto"
      && entry.analysis?.disposition === "enrich-existing");
    const commit = section.createEl("button", {
      cls: "xz-primary-button xz-governance-agent-commit",
      text: "确认首批可撤销写入",
      attr: { type: "button" },
    });
    commit.disabled = !eligible.length || preview.status === "running" || Boolean(preview.committedAt);
    commit.addEventListener("click", () => this.onApplyAgentBatch?.(
      preview,
      eligible.map((entry) => entry.itemId),
    ));
  }

  openAction(item, report) {
    if (!item) return;
    if (item.sourceKind === "health-issue") {
      const issue = (report?.issues || []).find((entry) => entry.id === item.sourceId);
      if (!issue) {
        new Notice("当前扫描报告已经变化，请先扫描全库");
        return;
      }
      if (issue?.repair?.mode === "automatic") this.onPreviewIssue?.(issue.id);
      else this.onOpenPath?.(item.paths?.[0]);
      return;
    }
    const candidate = (report?.lifecycle?.candidates || []).find((entry) => entry.id === item.sourceId);
    if (!candidate) {
      new Notice("当前生命周期候选已经变化，请先扫描全库");
      return;
    }
    this.onOpenLifecycleCandidate?.(candidate);
  }

  renderCard(parent, item, index, report, busy) {
    const card = parent.createEl("article", {
      cls: `xz-governance-card xz-product-card-frame is-${item.priority} is-${item.reviewStatus}`,
    });
    const openDetail = () => this.reader?.open(this.readerCard(item));
    card.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea, summary")) return;
      openDetail();
    });
    const head = card.createDiv({ cls: "xz-governance-card-head" });
    const title = head.createDiv();
    title.createEl("small", { text: `更新待办 ${index + 1}` });
    title.createEl("h4", { text: textOr(item.title, "需要检查的知识问题") });
    const badges = head.createDiv({ cls: "xz-governance-card-badges" });
    badges.createSpan({ cls: "xz-status-chip", text: GOVERNANCE_PRIORITY_LABELS[item.priority] || item.priority });
    badges.createSpan({ cls: "xz-status-chip", text: GOVERNANCE_STATUS_LABELS[item.reviewStatus] || item.reviewStatus });

    card.createSpan({ cls: "xz-governance-card-category", text: GOVERNANCE_CATEGORY_LABELS[item.category] || "其他治理" });
    card.createEl("p", { cls: "xz-governance-card-summary", text: textOr(item.summary, "没有可显示的更新摘要") });
    if (item.processing) {
      const status = { running: "正在分析", completed: "已分析待复核", applied: "已写入待复核", failed: "分析失败", interrupted: "分析中断" }[item.processing.status];
      card.createEl("p", { text: `${status} · ${formatCardDate(item.processing.updatedAt)}。${item.processing.error || item.processing.summary || ""}` });
      if (item.processing.status === "completed") card.createEl("p", { cls: "xz-cognitive-muted", text: "这是已保存的分析进度。再次预览或写入时会重新核对原文，分析完成不代表问题已经修复。" });
    }
    const recommendation = card.createDiv({ cls: "xz-governance-card-recommendation" });
    recommendation.createSpan({ text: "处理建议" });
    recommendation.createEl("p", { text: textOr(item.recommendation, "核对后重新扫描。") });
    const meta = card.createDiv({ cls: "xz-governance-card-meta" });
    meta.createSpan({ text: `首次：${formatCardDate(item.firstSeenAt, "未记录")}` });
    meta.createSpan({ text: `复查：${item.seenCount || 1} 次` });
    meta.createSpan({ text: `关联：${item.paths?.length || 0} 个文件` });

    const actions = card.createDiv({ cls: "xz-governance-card-actions" });
    const detail = actions.createEl("button", { cls: "xz-primary-button", text: "展开详情", attr: { type: "button" } });
    detail.addEventListener("click", openDetail);
    if (item.reviewStatus !== "resolved") {
      const processLabel = item.handlingMode === "agent-auto" || item.handlingMode === "agent-candidate"
        ? "查看 Agent 整理"
        : item.handlingMode === "deterministic" ? "查看修复方案"
          : item.handlingMode === "system-failed" ? "查看故障说明" : "查看判断与建议";
      const process = actions.createEl("button", { cls: "xz-secondary-button", text: processLabel, attr: { type: "button" } });
      process.disabled = busy || !report;
      process.addEventListener("click", () => this.onAnalyze?.(item, () => this.openAction(item, report)));
      const defer = actions.createEl("button", {
        cls: "xz-secondary-button",
        text: item.reviewStatus === "deferred" ? "恢复处理" : "暂缓处理",
        attr: { type: "button" },
      });
      defer.disabled = busy;
      defer.addEventListener("click", () => this.setStatus(item, item.reviewStatus === "deferred" ? "open" : "deferred"));
    } else {
      const open = actions.createEl("button", { cls: "xz-secondary-button", text: "打开相关知识", attr: { type: "button" } });
      open.disabled = !item.paths?.[0];
      open.addEventListener("click", () => this.onOpenPath?.(item.paths?.[0]));
    }
  }

  render(parent, { report, busy = false } = {}) {
    const governance = this.plugin?.getKnowledgeGovernanceState?.() || {
      items: [], resolved: [], totals: {}, lastScanAt: null, limited: false,
    };
    const section = parent.createEl("section", { cls: "xz-health-section xz-governance-panel", attr: { role: "tabpanel" } });
    section.createEl("h3", { text: "知识更新待办" });
    section.createEl("p", {
      cls: "xz-health-section-intro",
      text: "Agent 自动理解新资料与旧知识的关系，先完成摘要、核心知识点、用途、标签、分类、证据提取与版本判断；本地内核再校验风险和可写范围。普通低风险整理进入统一审批预览，只有重大信息需要用户判断；用户统一审批后才写入 Obsidian 正式知识区。资料库保持外部参考来源身份，结构检查不代表内容已验证，也不用于推断用户个人认知。只有重新扫描确认问题消失后，才会进入已解决。",
    });
    const metrics = section.createDiv({ cls: "xz-governance-metrics", attr: { "aria-label": "知识治理摘要" } });
    [
      ["Agent 待整理", governance.totals?.agentQueued || 0],
      ["已分析待复核", governance.totals?.agentCompleted || 0],
      ["已写入待复核", governance.totals?.appliedPending || 0],
      ["重大信息待确认", governance.totals?.humanReview || 0],
      ["系统未能处理", governance.totals?.systemFailed || 0],
    ].forEach(([label, value]) => {
      const metric = metrics.createDiv();
      metric.createEl("strong", { text: String(value) });
      metric.createSpan({ text: label });
    });

    section.createEl("p", { cls: "xz-cognitive-muted", text: `最近 7 天扫描后未再发现 ${governance.recentResolved?.days7 || 0} 项，最近 30 天 ${governance.recentResolved?.days30 || 0} 项。按最多 200 条最近历史统计${governance.recentResolved?.historyLimited ? "，可能不完整" : ""}；不等同于 Agent 自动修复数量。` });
    const toolbar = section.createDiv({ cls: "xz-governance-toolbar" });
    const previewButton = toolbar.createEl("button", {
      cls: "xz-primary-button xz-governance-agent-preview-button",
      text: "Agent 只读预演前 5 条",
      attr: { type: "button" },
    });
    previewButton.disabled = busy || typeof this.plugin?.previewKnowledgeGovernanceAgentBatch !== "function";
    previewButton.addEventListener("click", () => this.previewAgentBatch());
    const queueLabel = toolbar.createEl("label");
    queueLabel.createSpan({ text: "处理层级" });
    const queue = queueLabel.createEl("select", { attr: { "aria-label": "筛选治理处理层级" } });
    Object.entries(GOVERNANCE_QUEUE_LABELS)
      .forEach(([value, label]) => queue.createEl("option", { text: label, attr: { value } }));
    queue.value = this.queue;
    queue.addEventListener("change", () => {
      this.queue = queue.value;
      this.resetBatch();
      this.rerender?.();
    });
    const statusLabel = toolbar.createEl("label");
    statusLabel.createSpan({ text: "处理状态" });
    const status = statusLabel.createEl("select", { attr: { "aria-label": "筛选治理处理状态" } });
    [["open", "当前待处理"], ["deferred", "已暂缓"], ["resolved", "最近已解决"], ["all", "全部状态"]]
      .forEach(([value, label]) => status.createEl("option", { text: label, attr: { value } }));
    status.value = this.status;
    status.addEventListener("change", () => {
      this.status = status.value;
      this.resetBatch();
      this.rerender?.();
    });
    const categoryLabel = toolbar.createEl("label");
    categoryLabel.createSpan({ text: "问题类别" });
    const category = categoryLabel.createEl("select", { attr: { "aria-label": "筛选治理问题类别" } });
    category.createEl("option", { text: "全部类别", attr: { value: "all" } });
    Object.entries(GOVERNANCE_CATEGORY_LABELS)
      .forEach(([value, label]) => category.createEl("option", { text: label, attr: { value } }));
    category.value = this.category;
    category.addEventListener("change", () => {
      this.category = category.value;
      this.resetBatch();
      this.rerender?.();
    });

    const active = Array.isArray(governance.items) ? governance.items : [];
    const resolved = Array.isArray(governance.resolved) ? governance.resolved : [];
    const combined = this.status === "resolved"
      ? resolved
      : this.status === "all"
        ? [...active, ...resolved]
        : active.filter((item) => item.reviewStatus === this.status);
    const filtered = combined.filter((item) => (
      (this.category === "all" || item.category === this.category) && this.matchesQueue(item)
    ));
    section.createEl("p", {
      cls: "xz-governance-result-count",
      text: `显示 ${Math.min(filtered.length, this.visible)} / ${filtered.length} 项 · 最后扫描 ${formatCardDate(governance.lastScanAt, "尚未扫描")}`,
    });
    if (governance.limited) section.createEl("p", {
      cls: "xz-maintenance-error",
      text: `本地持久队列达到上限，另有 ${governance.totals?.omitted || 0} 项未持久保存；请先分批处理并重新扫描。`,
    });
    this.renderAgentPreview(section);
    if (!filtered.length) section.createEl("p", { cls: "xz-maintenance-empty", text: "当前筛选范围没有知识更新待办。" });
    else {
      const grid = section.createDiv({ cls: "xz-governance-grid" });
      filtered.slice(0, this.visible).forEach((item, index) => this.renderCard(grid, item, index, report, busy));
      if (filtered.length > this.visible) {
        const more = section.createEl("button", { cls: "xz-secondary-button xz-governance-load-more", text: "继续加载", attr: { type: "button" } });
        more.addEventListener("click", () => {
          this.visible += GOVERNANCE_BATCH_SIZE;
          this.rerender?.();
        });
      }
    }
  }
}

module.exports = { GOVERNANCE_BATCH_SIZE, KnowledgeGovernanceSection };
