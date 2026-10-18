"use strict";

const { Notice, setIcon } = require("obsidian");
const { KnowledgeReaderOverlay } = require("./view-knowledge-reader.cjs");
const { KnowledgeRepairPreviewOverlay } = require("./view-knowledge-repair-preview.cjs");
const { KnowledgeGovernanceSection } = require("./view-knowledge-governance.cjs");
const { KnowledgeDecisionOverlay } = require("./view-knowledge-decision.cjs");

const LIFECYCLE_KIND_LABELS = Object.freeze({
  "exact-duplicate": "精确重复",
  "same-key-version": "同主题多版本",
  "cross-type-copy": "跨分类相同内容",
  "near-duplicate": "近似内容",
  "expired-active": "有效期已结束",
  "status-inconsistent": "状态信息不一致",
});
const CONFIDENCE_LABELS = Object.freeze({ high: "高置信度", medium: "中等置信度", low: "低置信度" });

function latestUndoableIndexTransaction(plugin) {
  const transactions = Array.isArray(plugin?.state?.knowledgeIndexTransactions)
    ? plugin.state.knowledgeIndexTransactions : [];
  return [...transactions].reverse().find((item) => item?.status === "committed") || null;
}

function latestUndoableLifecycleTransaction(plugin) {
  const transactions = Array.isArray(plugin?.state?.knowledgeTransactions)
    ? plugin.state.knowledgeTransactions : [];
  const preferred = plugin?.state?.runtime?.knowledgeLifecycleLastTransactionId;
  return [...transactions].reverse().find((item) => item?.status === "committed"
    && (!preferred || item.id === preferred)
    && item.entries?.some((entry) => entry?.operation === "archive"
      || (typeof entry?.afterContent === "string" && entry.afterContent.includes("lifecycleUpdatedAt:"))))
    || [...transactions].reverse().find((item) => item?.status === "committed"
      && item.entries?.some((entry) => entry?.operation === "archive"
        || (typeof entry?.afterContent === "string" && entry.afterContent.includes("lifecycleUpdatedAt:"))))
    || null;
}

function textOr(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function compactCardTag(value) {
  const normalized = textOr(value, "").replaceAll("\\", "/");
  return normalized.split("/").map((part) => part.trim()).filter(Boolean).at(-1) || "未分类";
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

function renderTextChips(parent, values, emptyText) {
  const list = parent.createDiv({ cls: "xz-knowledge-chip-list" });
  const clean = (Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim());
  if (!clean.length) list.createSpan({ cls: "xz-knowledge-empty-inline", text: emptyText });
  else clean.forEach((value) => list.createSpan({ cls: "xz-knowledge-chip", text: value }));
  return list;
}

class KnowledgeHealthPanel {
  constructor(options) {
    this.plugin = options.plugin;
    this.onClose = options.onClose;
    this.confirm = options.confirm;
    this.opened = false;
    this.busy = false;
    this.activeTab = "governance";
    this.lifecycleChoices = new Map();
    this.focusedLifecycleCandidateId = null;

    this.scrim = options.root.createDiv({ cls: "xz-maintenance-scrim", attr: { hidden: "" } });
    this.scrim.addEventListener("click", () => this.close());
    this.drawer = options.root.createEl("aside", {
      cls: "xz-maintenance-drawer xz-knowledge-health",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-knowledge-health-title",
      },
    });
    const header = this.drawer.createDiv({ cls: "xz-maintenance-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "本地检查与受控处理" });
    heading.createEl("h2", { text: "知识治理中心", attr: { id: "xz-knowledge-health-title" } });
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭知识治理中心", "aria-label": "关闭知识治理中心" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());
    this.body = this.drawer.createDiv({ cls: "xz-maintenance-body" });
    this.reader = new KnowledgeReaderOverlay({ root: options.root, plugin: this.plugin });
    this.repairPreviewOverlay = new KnowledgeRepairPreviewOverlay({
      root: options.root,
      fallbackFocus: this.closeButton,
    });
    this.decisionOverlay = new KnowledgeDecisionOverlay({
      root: options.root,
      fallbackFocus: this.closeButton,
    });
    this.governanceSection = new KnowledgeGovernanceSection({
      plugin: this.plugin,
      reader: this.reader,
      setBusy: (value) => {
        this.busy = value;
        this.render();
      },
      rerender: () => this.render(),
      onOpenPath: (path) => this.openKnowledgeFile(path),
      onAnalyze: (item, onContinue) => this.analyzeGovernanceItem(item, onContinue),
      onApplyAgentBatch: (preview, itemIds) => this.applyGovernanceAgentBatch(preview, itemIds),
      onPreviewIssue: (issueId) => this.previewKnowledgeHealthRepairs([issueId]),
      onOpenLifecycleCandidate: (candidate) => {
        this.focusedLifecycleCandidateId = candidate.id;
        this.activeTab = "lifecycle";
        this.render();
      },
    });
  }

  async open() {
    this.opened = true;
    this.scrim.removeAttribute("hidden");
    this.drawer.removeAttribute("hidden");
    this.render();
    this.closeButton.focus();
    if (this.plugin?.getKnowledgeHealthReport?.()?.presentationVersion !== 1) await this.refresh();
  }

  close() {
    const wasOpen = this.opened;
    this.reader.close();
    this.repairPreviewOverlay.close();
    this.decisionOverlay.close();
    this.opened = false;
    this.scrim.setAttr("hidden", "");
    this.drawer.setAttr("hidden", "");
    if (wasOpen) this.onClose?.();
  }

  destroy() {
    this.opened = false;
    this.reader.destroy();
    this.repairPreviewOverlay.close();
    this.decisionOverlay.destroy();
  }

  async analyzeGovernanceItem(item, onContinue) {
    if (this.busy || !item?.id || typeof this.plugin?.analyzeKnowledgeGovernanceItem !== "function") return;
    this.busy = true;
    this.render();
    try {
      const analysis = await this.plugin.analyzeKnowledgeGovernanceItem(item.id);
      this.decisionOverlay.open({
        item,
        analysis,
        onOpenSource: (path) => this.openKnowledgeFile(path),
        onContinue: () => onContinue?.(),
        onDefer: () => this.plugin?.setKnowledgeGovernanceItemStatus?.(item.id, "deferred"),
      });
    } catch (error) {
      new Notice(`Agent 判断卡生成失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async applyGovernanceAgentBatch(preview, itemIds) {
    if (this.busy || !preview?.id || typeof this.plugin?.applyKnowledgeGovernanceAgentBatch !== "function") return;
    const count = Array.isArray(itemIds) ? itemIds.length : 0;
    const confirmed = await this.confirm?.({
      title: "确认提交首批 Agent 语义整理",
      message: `将更新 ${count} 条正式知识的派生摘要、知识点、用途、主题标签和别名。原始知识内容与来源不会覆盖；单批最多 5 条，写入带哈希校验、审计与撤销。是否继续？`,
      confirmLabel: "提交可撤销写入",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      const result = await this.plugin.applyKnowledgeGovernanceAgentBatch(preview.id, itemIds);
      new Notice(`Agent 语义整理已写入 ${result.applied} 条；重新扫描后剩余 ${result.remainingIssues ?? "未知"} 个问题`);
    } catch (error) {
      new Notice(`Agent 语义整理提交失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async refresh() {
    if (this.busy || typeof this.plugin?.refreshKnowledgeHealth !== "function") return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.refreshKnowledgeHealth();
      this.governanceSection.resetBatch();
    } catch (error) {
      new Notice(`知识体检失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async previewKnowledgeHealthRepairs(issueIds = null) {
    if (this.busy || typeof this.plugin?.previewKnowledgeHealthRepairs !== "function") return;
    this.busy = true;
    this.activeTab = "governance";
    this.render();
    let preview = null;
    try {
      preview = await this.plugin.previewKnowledgeHealthRepairs(issueIds);
    } catch (error) {
      new Notice(`处理方案生成失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
      if (preview) {
        this.repairPreviewOverlay.open({
          mode: "health",
          preview,
          onConfirm: (value) => this.applyKnowledgeHealthRepairs(value),
          onOpenPath: (path) => this.openKnowledgeFile(path),
        });
      }
    }
  }

  async applyKnowledgeHealthRepairs(preview) {
    if (this.busy || !preview || typeof this.plugin?.applyKnowledgeHealthRepairs !== "function") return;
    const confirmed = await this.confirm?.({
      title: "确认提交知识体检处理",
      message: `将升级 ${preview.schemaFiles.length} 个旧字段文件、把 ${preview.duplicateDefinitions.length} 个旧定义移入可恢复归档区，并更新 ${preview.indexFiles} 个索引。不会直接删除旧定义；${preview.manualIssues.length} 个需人工判断的问题不会自动改写。是否提交？`,
      confirmLabel: "提交处理",
    });
    if (!confirmed) return false;
    this.busy = true;
    this.render();
    try {
      const result = await this.plugin.applyKnowledgeHealthRepairs(preview.id);
      new Notice(`处理后重新扫描完成：当前剩余 ${result.remainingIssues ?? "未知"} 个问题`);
      return true;
    } catch (error) {
      new Notice(`提交处理失败：${error?.message || "未知错误"}`);
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async previewLifecycle(selection) {
    if (this.busy || !selection || typeof this.plugin?.previewKnowledgeLifecycleChanges !== "function") return;
    this.busy = true;
    this.activeTab = "lifecycle";
    this.render();
    let preview = null;
    try {
      preview = await this.plugin.previewKnowledgeLifecycleChanges([selection]);
    } catch (error) {
      new Notice(`生命周期预览失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
      if (preview) {
        this.revealLifecyclePreview(preview);
        new Notice(preview.canCommit
          ? "生命周期提交预览已生成，已定位到预览"
          : "只读合并草稿已生成，已定位到草稿");
      }
    }
  }

  revealLifecyclePreview(preview) {
    if (!preview?.id) return false;
    const target = this.body?.querySelector?.(".xz-lifecycle-preview");
    if (!target) return false;
    target.focus?.({ preventScroll: true });
    target.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return true;
  }

  async applyLifecyclePreview(preview) {
    if (this.busy || !preview?.canCommit || typeof this.plugin?.applyKnowledgeLifecycleChanges !== "function") return;
    const confirmed = await this.confirm?.({
      title: "确认知识生命周期变更",
      message: `将新建 ${preview.filesToCreate || 0} 个智能提炼知识，修改 ${preview.filesToModify} 个旧知识文件，把 ${preview.filesToArchive} 个确认的重复副本移入可恢复归档区。不会永久删除文件，不会改动原始对话或文档证据；提交前会再次校验文件是否变化。是否继续？`,
      confirmLabel: preview.synthesizedKnowledge ? "确认生成并替代旧版" : "确认提交",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      const result = await this.plugin.applyKnowledgeLifecycleChanges(preview.id);
      this.lifecycleChoices.clear();
      new Notice(`生命周期处理完成：新建 ${result.createdFiles || 0} 个，修改 ${result.modifiedFiles} 个，归档 ${result.archivedFiles} 个，剩余候选 ${result.remainingCandidates} 组`);
    } catch (error) {
      new Notice(`生命周期处理失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async undoLifecycle(transaction) {
    if (this.busy || !transaction || typeof this.plugin?.undoKnowledgeLifecycleTransaction !== "function") return;
    const confirmed = await this.confirm?.({
      title: "撤销知识生命周期变更",
      message: "将恢复该事务修改前的知识内容和原始路径，并重新生成目录索引。若文件后来被人工编辑，系统会拒绝覆盖。是否继续？",
      confirmLabel: "确认撤销",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.undoKnowledgeLifecycleTransaction(transaction.id);
      new Notice("知识生命周期变更已撤销");
    } catch (error) {
      new Notice(`撤销生命周期变更失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async previewIndexes() {
    if (this.busy || typeof this.plugin?.previewKnowledgeIndexes !== "function") return;
    this.busy = true;
    this.render();
    let preview = null;
    try {
      preview = await this.plugin.previewKnowledgeIndexes();
    } catch (error) {
      new Notice(`索引预览失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
      if (preview) {
        this.repairPreviewOverlay.open({
          mode: "index",
          preview,
          onConfirm: (value) => this.applyPreview(value),
          onOpenPath: (path) => this.openKnowledgeFile(path),
        });
      }
    }
  }

  async applyPreview(preview) {
    if (this.busy || !preview || typeof this.plugin?.applyKnowledgeIndexes !== "function") return;
    const confirmed = await this.confirm?.({
      title: "确认更新知识目录",
      message: `将更新 ${preview.changes.length} 个知识目录。只替换“行知自动索引”区块，不会修改手写内容，并可撤销。是否继续？`,
      confirmLabel: "确认更新目录",
    });
    if (!confirmed) return false;
    this.busy = true;
    this.render();
    try {
      await this.plugin.applyKnowledgeIndexes(preview.id);
      new Notice("知识目录已更新，可在本页撤销");
      return true;
    } catch (error) {
      new Notice(`目录更新失败：${error?.message || "未知错误"}`);
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async undoIndex(transaction) {
    if (this.busy || !transaction || typeof this.plugin?.undoKnowledgeIndexTransaction !== "function") return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.undoKnowledgeIndexTransaction(transaction.id);
      new Notice("已撤销最近一次索引更新");
    } catch (error) {
      new Notice(`撤销索引更新失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async openKnowledgeFile(path, mode = "window") {
    if (!path || path === "未知路径" || typeof this.plugin?.openVaultPath !== "function") return;
    try {
      await this.plugin.openVaultPath(path, { mode });
    } catch (error) {
      new Notice(`无法打开文件：${error?.message || "未知错误"}`);
    }
  }

  async removeKnowledge(item) {
    if (this.busy || !item?.path
      || typeof this.plugin?.previewKnowledgeRemoval !== "function"
      || typeof this.plugin?.applyKnowledgeRemoval !== "function") return;
    this.busy = true;
    this.render();
    try {
      const preview = await this.plugin.previewKnowledgeRemoval(item.path);
      const confirmed = await this.confirm?.({
        title: `移入知识回收站：${textOr(preview.title, "未命名知识")}`,
        message: `对应的 Obsidian 文件：${preview.path}\n\n该文件会移入可恢复归档，不会永久删除；来源对话与证据不会删除。目录索引会自动更新，但其他笔记中的手写链接不会自动改写。预览后文件如有变化，提交会被拒绝。确认继续吗？`,
        confirmLabel: "移入知识回收站",
      });
      if (!confirmed) return;
      await this.plugin.applyKnowledgeRemoval(preview.id);
      this.reader.close();
      new Notice(`“${textOr(preview.title, "该知识")}”已移入知识回收站，可撤销`);
    } catch (error) {
      new Notice(`移入知识回收站失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async undoKnowledgeRemoval() {
    const id = this.plugin?.state?.runtime?.knowledgeRemovalLastTransactionId;
    if (this.busy || !id || typeof this.plugin?.undoKnowledgeRemovalTransaction !== "function") return;
    const confirmed = await this.confirm?.({
      title: "撤销最近一次知识删除",
      message: "将把知识从可恢复归档还原到原路径，并重新生成目录索引。若归档文件或原路径后来发生变化，系统会拒绝覆盖。是否继续？",
      confirmLabel: "确认撤销",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.undoKnowledgeRemovalTransaction(id);
      new Notice("最近一次知识删除已撤销");
    } catch (error) {
      new Notice(`撤销知识删除失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  renderKnowledgeCard(parent, item) {
    const card = parent.createEl("article", {
      cls: "xz-knowledge-card xz-knowledge-product-card xz-product-card-frame",
    });
    const openReader = () => this.reader.open(item);
    card.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea, summary")) return;
      openReader();
    });
    const head = card.createDiv({ cls: "xz-knowledge-card-head" });
    const title = head.createDiv({ cls: "xz-knowledge-card-title" });
    title.createEl("h4", { text: textOr(item?.title, "未命名知识") });
    const badges = head.createDiv({ cls: "xz-knowledge-card-badges" });
    [item?.typeLabel, item?.statusLabel].filter(Boolean)
      .forEach((label) => badges.createSpan({ cls: "xz-status-chip", text: label }));
    if (item?.summaryState === "needs-review") badges.createSpan({ cls: "xz-status-chip is-manual", text: "待整理" });

    const summary = card.createDiv({ cls: "xz-knowledge-card-summary xz-product-card-summary" });
    summary.createEl("span", { cls: "xz-knowledge-card-kicker", text: "核心总结" });
    summary.createEl("p", {
      cls: "xz-knowledge-card-content",
      text: textOr(item?.summary, item?.contentPreview || "这条知识尚未形成可用摘要。"),
    });

    const knowledge = card.createDiv({ cls: "xz-product-card-columns" });
    const points = knowledge.createDiv({ cls: "xz-product-card-block" });
    points.createEl("span", { cls: "xz-product-card-label", text: "核心知识点" });
    const pointList = points.createEl("ul");
    (Array.isArray(item?.keyPoints) ? item.keyPoints : []).slice(0, 1)
      .forEach((point) => pointList.createEl("li", { text: point }));
    const uses = knowledge.createDiv({ cls: "xz-product-card-block is-use" });
    uses.createEl("span", { cls: "xz-product-card-label", text: "建议用途" });
    const useList = uses.createEl("ul");
    (Array.isArray(item?.suggestedUses) ? item.suggestedUses : []).slice(0, 1)
      .forEach((use) => useList.createEl("li", { text: use }));

    const rawTags = (Array.isArray(item?.tags) ? item.tags : []).slice(0, 2);
    const tags = renderTextChips(card, rawTags.map(compactCardTag), "尚未添加标签");
    tags.addClass("xz-product-card-tags");
    Array.from(tags.querySelectorAll(".xz-knowledge-chip")).forEach((chip, index) => {
      chip.setAttribute("title", rawTags[index] || "");
    });
    const tagOverflow = Math.max(Number(item?.tagOverflow || 0), Math.max(0, (item?.tags || []).length - 2));
    if (tagOverflow > 0) tags.createSpan({ cls: "xz-knowledge-chip is-overflow", text: `+${tagOverflow}` });
    const meta = card.createDiv({ cls: "xz-product-card-meta" });
    meta.createSpan({ text: item?.provenance?.status === "addresses-checked" ? "来源地址已核对 · 结论需判断"
      : item?.provenance?.status === "needs-review" ? "来源需要核对" : "来源尚未核验" });
    meta.createSpan({ text: formatCardDate(item?.updatedAt) });

    const actions = card.createDiv({ cls: "xz-knowledge-card-actions" });
    const detail = actions.createEl("button", {
      cls: "xz-primary-button xz-knowledge-detail-toggle",
      text: "展开阅读",
      attr: { type: "button" },
    });
    detail.addEventListener("click", openReader);
    const open = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: "在 Obsidian 打开",
      attr: { type: "button" },
    });
    open.disabled = !item?.path || typeof this.plugin?.openVaultPath !== "function";
    open.addEventListener("click", () => this.openKnowledgeFile(item.path));
    const remove = actions.createEl("button", {
      cls: "xz-knowledge-delete-button",
      text: "移入回收站",
      attr: { type: "button", title: `将对应文件移入知识回收站：${item.path}` },
    });
    remove.disabled = this.busy || !item?.path;
    remove.addEventListener("click", () => this.removeKnowledge(item));
  }

  async previewIntelligentMerge(candidate, reason) {
    if (this.busy || !candidate?.id || typeof this.plugin?.previewIntelligentKnowledgeMerge !== "function") return;
    this.busy = true;
    this.activeTab = "lifecycle";
    this.render();
    let preview = null;
    try {
      preview = await this.plugin.previewIntelligentKnowledgeMerge(candidate.id, reason);
    } catch (error) {
      new Notice(`智能合并失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
      if (preview) {
        this.revealLifecyclePreview(preview);
        new Notice("智能合并候选已生成；请核对内容和来源后再确认写入");
      }
    }
  }

  lifecycleChoice(candidate) {
    if (!this.lifecycleChoices.has(candidate.id)) {
      this.lifecycleChoices.set(candidate.id, { selectedPath: "", reason: "" });
    }
    return this.lifecycleChoices.get(candidate.id);
  }

  lifecycleReasonInput(parent, candidate, placeholder) {
    const choice = this.lifecycleChoice(candidate);
    const label = parent.createEl("label", { cls: "xz-lifecycle-field" });
    label.createSpan({ text: "处理原因（会写入审计记录）" });
    const input = label.createEl("input", {
      attr: {
        type: "text",
        maxlength: "1000",
        placeholder,
        "aria-label": `${LIFECYCLE_KIND_LABELS[candidate.kind] || "生命周期候选"}处理原因`,
      },
    });
    input.value = choice.reason;
    input.disabled = this.busy;
    input.addEventListener("input", () => { choice.reason = input.value; });
    return input;
  }

  lifecyclePathSelect(parent, candidate, labelText) {
    const choice = this.lifecycleChoice(candidate);
    const label = parent.createEl("label", { cls: "xz-lifecycle-field" });
    label.createSpan({ text: labelText });
    const select = label.createEl("select", {
      attr: { "aria-label": `${LIFECYCLE_KIND_LABELS[candidate.kind] || "生命周期候选"}${labelText}` },
    });
    select.createEl("option", { text: "请先选择，不会自动处理", attr: { value: "" } });
    (candidate.members || []).forEach((member) => {
      select.createEl("option", {
        text: `${textOr(member.title, "未命名知识")} · ${member.path}`,
        attr: { value: member.path },
      });
    });
    select.value = choice.selectedPath;
    select.disabled = this.busy;
    select.addEventListener("change", () => { choice.selectedPath = select.value; });
    return select;
  }

  renderLifecycleMember(parent, member) {
    const card = parent.createDiv({ cls: "xz-lifecycle-member" });
    const head = card.createDiv({ cls: "xz-lifecycle-member-head" });
    head.createEl("strong", { text: textOr(member?.title, "未命名知识") });
    head.createSpan({ cls: "xz-status-chip", text: textOr(member?.status, "状态未知") });
    card.createEl("p", { cls: "xz-lifecycle-content", text: textOr(member?.contentPreview, "没有可显示的正文") });
    const meta = card.createDiv({ cls: "xz-lifecycle-member-meta" });
    meta.createSpan({ text: `类型：${textOr(member?.knowledgeType)}` });
    meta.createSpan({ text: `有效期：${textOr(member?.effectiveFrom, "未记录")} → ${textOr(member?.effectiveUntil, "当前")}` });
    meta.createSpan({ text: `来源消息：${textOr(member?.sourceMessageId, "未记录")}` });
    const open = card.createEl("button", { cls: "xz-link-button", text: "打开这条知识", attr: { type: "button" } });
    open.disabled = this.busy || !member?.path;
    open.addEventListener("click", () => this.openKnowledgeFile(member.path));
  }

  renderLifecycleCandidate(parent, candidate, index) {
    const card = parent.createEl("article", { cls: `xz-lifecycle-candidate is-${candidate.kind}` });
    const head = card.createDiv({ cls: "xz-lifecycle-candidate-head" });
    const title = head.createDiv();
    title.createEl("small", { text: `候选 ${index + 1}` });
    title.createEl("h4", { text: LIFECYCLE_KIND_LABELS[candidate.kind] || candidate.kind });
    const badges = head.createDiv({ cls: "xz-lifecycle-badges" });
    badges.createSpan({ cls: "xz-status-chip", text: CONFIDENCE_LABELS[candidate.confidence] || candidate.confidence });
    badges.createSpan({
      cls: `xz-status-chip ${candidate.automaticEligible ? "is-automatic" : "is-manual"}`,
      text: candidate.automaticEligible ? "规则明确，仍需确认" : "必须人工判断",
    });
    const reasons = card.createEl("ul", { cls: "xz-lifecycle-reasons" });
    (candidate.reasons || []).forEach((reason) => reasons.createEl("li", { text: reason }));
    (candidate.blockingReasons || []).forEach((reason) => reasons.createEl("li", { cls: "is-blocking", text: reason }));
    const members = card.createDiv({ cls: "xz-lifecycle-members" });
    (candidate.members || []).forEach((member) => this.renderLifecycleMember(members, member));

    const controls = card.createDiv({ cls: "xz-lifecycle-controls" });
    const choice = this.lifecycleChoice(candidate);
    if (candidate.kind === "exact-duplicate") {
      this.lifecyclePathSelect(controls, candidate, "选择要保留的权威知识");
      this.lifecycleReasonInput(controls, candidate, "例如：正文和适用范围一致，保留来源更完整的一条");
      const button = controls.createEl("button", { cls: "xz-primary-button", text: "预览可恢复归档", attr: { type: "button" } });
      button.disabled = this.busy;
      button.addEventListener("click", () => this.previewLifecycle({
        candidateId: candidate.id,
        action: "archive-duplicate",
        canonicalPath: choice.selectedPath,
        archivePaths: (candidate.memberPaths || []).filter((path) => path !== choice.selectedPath),
        reason: choice.reason,
      }));
    } else if (candidate.kind === "same-key-version") {
      this.lifecyclePathSelect(controls, candidate, "选择当前有效的新版");
      this.lifecycleReasonInput(controls, candidate, "例如：业务阶段已经变化，新记录明确取代旧记录");
      const actions = controls.createDiv({ cls: "xz-lifecycle-control-actions" });
      const supersede = actions.createEl("button", { cls: "xz-primary-button", text: "预览标记旧版", attr: { type: "button" } });
      supersede.disabled = this.busy;
      supersede.addEventListener("click", () => this.previewLifecycle({
        candidateId: candidate.id,
        action: "supersede",
        successorPath: choice.selectedPath,
        supersededPaths: (candidate.memberPaths || []).filter((path) => path !== choice.selectedPath),
        reason: choice.reason,
      }));
      const merge = actions.createEl("button", { cls: "xz-secondary-button", text: "生成智能合并候选", attr: { type: "button" } });
      merge.disabled = this.busy;
      merge.addEventListener("click", () => this.previewIntelligentMerge(candidate, choice.reason));
    } else if (candidate.kind === "expired-active" || candidate.kind === "status-inconsistent") {
      this.lifecycleReasonInput(controls, candidate, candidate.kind === "expired-active"
        ? "例如：有效期已结束，确认转为历史知识"
        : "例如：按正式状态修正显示标签");
      const action = candidate.kind === "expired-active" ? "mark-historical" : "repair-status-metadata";
      const button = controls.createEl("button", {
        cls: "xz-primary-button",
        text: candidate.kind === "expired-active" ? "预览转为历史" : "预览修复状态",
        attr: { type: "button" },
      });
      button.disabled = this.busy;
      button.addEventListener("click", () => this.previewLifecycle({ candidateId: candidate.id, action, reason: choice.reason }));
    } else {
      this.lifecycleReasonInput(controls, candidate, "说明需要比较的事实、场景或分类差异");
      const draft = controls.createEl("button", { cls: "xz-secondary-button", text: "生成只读对照草稿", attr: { type: "button" } });
      draft.disabled = this.busy;
      draft.addEventListener("click", () => this.previewLifecycle({
        candidateId: candidate.id,
        action: "merge-draft",
        reason: choice.reason,
      }));
      controls.createEl("p", { cls: "xz-lifecycle-safety-note", text: "这类候选不能直接删除或自动选新版，只能先人工比较。" });
    }
  }

  renderLifecyclePreview(preview) {
    const section = this.body.createEl("section", {
      cls: "xz-health-preview xz-lifecycle-preview",
      attr: { role: "status", "aria-live": "polite", tabindex: "-1" },
    });
    section.createEl("h3", { text: preview.synthesizedKnowledge ? "智能合并确认预览" : preview.canCommit ? "生命周期提交预览" : "只读判断草稿" });
    section.createEl("p", {
      text: preview.canCommit
        ? `将新建 ${preview.filesToCreate || 0} 个智能提炼知识，修改 ${preview.filesToModify} 个旧知识，并把 ${preview.filesToArchive} 个重复副本移入可恢复归档。`
        : "这份草稿只用于人工比较，不会写入或删除任何知识。",
    });
    if (preview.synthesizedKnowledge) {
      const synthesized = preview.synthesizedKnowledge;
      const card = section.createEl("article", { cls: "xz-lifecycle-synthesis-card" });
      card.createEl("span", { cls: "xz-eyebrow", text: "智能提炼 · 待你确认" });
      card.createEl("h4", { text: synthesized.title });
      card.createEl("h5", { text: "核心总结" });
      card.createEl("p", { text: synthesized.summary });
      card.createEl("h5", { text: "核心知识点" });
      const points = card.createEl("ul");
      (synthesized.keyPoints || []).forEach((item) => points.createEl("li", { text: item }));
      card.createEl("h5", { text: "建议用途" });
      const uses = card.createEl("ul");
      (synthesized.suggestedUses || []).forEach((item) => uses.createEl("li", { text: item }));
      if (synthesized.unresolvedConflicts?.length) {
        card.createEl("h5", { text: "仍需核对的矛盾" });
        const conflicts = card.createEl("ul");
        synthesized.unresolvedConflicts.forEach((item) => conflicts.createEl("li", { text: item }));
      }
      const full = card.createEl("details", { cls: "xz-lifecycle-synthesis-content" });
      full.createEl("summary", { text: "查看完整合并内容" });
      full.createEl("p", { text: synthesized.content });
      card.createEl("small", { text: `来源 ${synthesized.sourceCount || 0} 条 · 置信度 ${Math.round(Number(synthesized.confidence || 0) * 100)}% · ${synthesized.path}` });
    }
    if (preview.createdFiles?.length) {
      const details = section.createEl("details", { attr: { open: "" } });
      details.createEl("summary", { text: `将新建的知识（${preview.createdFiles.length}）` });
      const list = details.createEl("ul");
      preview.createdFiles.forEach((path) => list.createEl("li", { text: path }));
    }
    if (preview.modifiedFiles?.length) {
      const details = section.createEl("details", { attr: { open: "" } });
      details.createEl("summary", { text: `将修改的知识（${preview.modifiedFiles.length}）` });
      const list = details.createEl("ul");
      preview.modifiedFiles.forEach((path) => list.createEl("li", { text: path }));
    }
    if (preview.archiveMoves?.length) {
      const details = section.createEl("details", { attr: { open: "" } });
      details.createEl("summary", { text: `将移入恢复区的副本（${preview.archiveMoves.length}）` });
      const list = details.createEl("ul");
      preview.archiveMoves.forEach((move) => list.createEl("li", { text: `${move.from} · ${move.recoveryMode}` }));
    }
    (preview.drafts || []).forEach((draft) => {
      const details = section.createEl("details", { cls: "xz-lifecycle-draft", attr: { open: "" } });
      details.createEl("summary", { text: draft.title });
      details.createEl("pre", { text: draft.content });
    });
    const warnings = section.createEl("ul", { cls: "xz-lifecycle-preview-warnings" });
    (preview.warnings || []).forEach((warning) => warnings.createEl("li", { text: warning }));
    const submit = section.createEl("button", {
      cls: "xz-primary-button",
      text: preview.synthesizedKnowledge ? "确认生成新知识并替代旧版" : "确认提交生命周期变更",
      attr: { type: "button" },
    });
    submit.disabled = this.busy || !preview.canCommit;
    submit.addEventListener("click", () => this.applyLifecyclePreview(preview));
  }

  renderLifecycleTab(report) {
    const lifecycle = report.lifecycle || { totals: {}, candidates: [] };
    const section = this.body.createEl("section", { cls: "xz-health-section xz-lifecycle-panel", attr: { role: "tabpanel" } });
    if (this.focusedLifecycleCandidateId) {
      const back = section.createEl("button", { cls: "xz-secondary-button xz-governance-back", text: "返回知识更新待办", attr: { type: "button" } });
      back.addEventListener("click", () => {
        this.focusedLifecycleCandidateId = null;
        this.activeTab = "governance";
        this.render();
      });
    }
    section.createEl("h3", { text: "知识生命周期" });
    section.createEl("p", { cls: "xz-health-section-intro", text: "本地发现重复、旧版、过期和状态矛盾。系统只给出候选与预览；你确认后才会修改，所谓“删除重复”实际是移入可恢复归档区。" });
    const metrics = section.createDiv({ cls: "xz-lifecycle-metrics", attr: { "aria-label": "知识生命周期摘要" } });
    [
      ["扫描知识", lifecycle.totals?.scanned || 0],
      ["精确重复", lifecycle.totals?.exactDuplicates || 0],
      ["多版本", lifecycle.totals?.sameKeyVersions || 0],
      ["近似/跨类", (lifecycle.totals?.nearDuplicates || 0) + (lifecycle.totals?.crossTypeCopies || 0)],
      ["过期/状态", (lifecycle.totals?.expiredActive || 0) + (lifecycle.totals?.statusInconsistent || 0)],
    ].forEach(([label, value]) => {
      const card = metrics.createDiv();
      card.createEl("strong", { text: String(value) });
      card.createSpan({ text: label });
    });
    const preview = this.plugin?.state?.runtime?.knowledgeLifecyclePreview || null;
    if (preview) this.renderLifecyclePreview(preview);
    const undoable = latestUndoableLifecycleTransaction(this.plugin);
    if (undoable) {
      const undo = section.createEl("button", { cls: "xz-secondary-button xz-lifecycle-undo", text: "撤销最近一次生命周期变更", attr: { type: "button" } });
      undo.disabled = this.busy;
      undo.addEventListener("click", () => this.undoLifecycle(undoable));
    }
    if (!lifecycle.candidates?.length) {
      section.createEl("p", { cls: "xz-maintenance-empty", text: "当前没有需要处理的生命周期候选。" });
      return;
    }
    const list = section.createDiv({ cls: "xz-lifecycle-candidate-list" });
    const candidates = this.focusedLifecycleCandidateId
      ? [...lifecycle.candidates].sort((left, right) => (
          Number(right.id === this.focusedLifecycleCandidateId) - Number(left.id === this.focusedLifecycleCandidateId)
        ))
      : lifecycle.candidates;
    candidates.forEach((candidate, index) => this.renderLifecycleCandidate(list, candidate, index));
  }

  render() {
    if (!this.opened) return;
    this.body.empty();
    const intro = this.body.createEl("section", { cls: "xz-maintenance-intro" });
    intro.createEl("p", {
      text: "体检、去重识别和安全校验在本地完成；只有你点击“生成智能合并候选”时才调用当前模型。任何正式变更都必须先预览、再由你确认。",
    });
    const actions = intro.createDiv({ cls: "xz-health-actions" });
    const refresh = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: this.busy ? "处理中…" : "扫描全库",
      attr: { type: "button" },
    });
    refresh.disabled = this.busy || typeof this.plugin?.refreshKnowledgeHealth !== "function";
    refresh.addEventListener("click", () => this.refresh());
    const repairAll = actions.createEl("button", {
      cls: "xz-primary-button",
      text: "生成处理方案",
      attr: { type: "button" },
    });
    repairAll.disabled = this.busy || typeof this.plugin?.previewKnowledgeHealthRepairs !== "function";
    repairAll.addEventListener("click", () => this.previewKnowledgeHealthRepairs(null));
    const previewButton = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: "整理知识目录",
      attr: { type: "button" },
    });
    previewButton.disabled = this.busy || typeof this.plugin?.previewKnowledgeIndexes !== "function";
    previewButton.addEventListener("click", () => this.previewIndexes());

    const storedReport = this.plugin?.getKnowledgeHealthReport?.() || null;
    const report = storedReport?.presentationVersion === 1 ? storedReport : null;
    if (!report) {
      this.body.createEl("p", { cls: "xz-maintenance-empty", text: this.busy ? "正在扫描知识库…" : "尚未运行知识体检。" });
      return;
    }
    const structuredKnowledge = (report.knowledge || []).filter((item) => item.presentationSource === "structured");
    const pendingKnowledge = (report.knowledge || []).filter((item) => item.presentationSource !== "structured");
    const metrics = this.body.createEl("section", { cls: "xz-health-metrics", attr: { "aria-label": "知识体检摘要" } });
    [
      ["正式知识", report.totals?.valid || 0],
      ["旧字段", report.totals?.legacySchema || 0],
      ["损坏知识", report.totals?.malformed || 0],
      ["待处理问题", report.totals?.issues || 0],
    ].forEach(([label, value]) => {
      const card = metrics.createDiv({ cls: "xz-health-metric" });
      card.createEl("strong", { text: String(value) });
      card.createSpan({ text: label });
    });

    const undoable = latestUndoableIndexTransaction(this.plugin);
    if (undoable) {
      const undo = this.body.createEl("button", {
        cls: "xz-secondary-button xz-health-undo",
        text: "撤销目录更新",
        attr: { type: "button" },
      });
      undo.disabled = this.busy;
      undo.addEventListener("click", () => this.undoIndex(undoable));
    }

    const distribution = this.body.createEl("section", { cls: "xz-health-section xz-knowledge-map" });
    distribution.createEl("h3", { text: "知识地图" });
    distribution.createEl("p", { cls: "xz-health-section-intro", text: "按知识库目录查看当前正式知识分布。" });
    if (!report.distribution?.length) distribution.createEl("p", { cls: "xz-maintenance-empty", text: "尚无合法的行知正式知识。" });
    else {
      const list = distribution.createEl("ul", { cls: "xz-health-distribution" });
      report.distribution.forEach((item) => list.createEl("li", { text: `${item.directory} · ${item.count} 条` }));
    }

    const tabs = this.body.createDiv({ cls: "xz-health-tabs", attr: { role: "tablist", "aria-label": "知识中心视图" } });
    [
      ["governance", `知识更新待办 ${this.plugin?.getKnowledgeGovernanceState?.()?.totals?.current || 0}`],
      ["knowledge", `知识卡片 ${structuredKnowledge.length}`],
    ].forEach(([id, label]) => {
      const selected = this.activeTab === id;
      const tab = tabs.createEl("button", {
        cls: `xz-health-tab${selected ? " is-active" : ""}`,
        text: label,
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      tab.addEventListener("click", () => {
        this.activeTab = id;
        this.render();
      });
    });

    if (this.activeTab === "governance") {
      this.governanceSection.render(this.body, { report, busy: this.busy });
    } else if (this.activeTab === "knowledge") {
      const knowledge = this.body.createEl("section", { cls: "xz-health-section xz-knowledge-catalog", attr: { role: "tabpanel" } });
      knowledge.createEl("h3", { text: "知识卡片" });
      knowledge.createEl("p", { cls: "xz-health-section-intro", text: "固定尺寸卡片只展示核心总结、知识重点和建议用途；来源与原始记录在全屏阅读中查看。" });
      if (pendingKnowledge.length) knowledge.createEl("p", {
        cls: "xz-structure-exclusion-note",
        text: `${pendingKnowledge.length} 条旧知识尚未完成智能摘要、知识点和用途加工，已进入知识更新待办，不会以成品知识卡展示。`,
      });
      if (!structuredKnowledge.length) knowledge.createEl("p", { cls: "xz-maintenance-empty", text: "尚无已完成智能加工的正式知识。" });
      else {
        const list = knowledge.createDiv({ cls: "xz-knowledge-card-list" });
        structuredKnowledge.forEach((item) => this.renderKnowledgeCard(list, item));
      }
      if (this.plugin?.state?.runtime?.knowledgeRemovalLastTransactionId) {
        const undo = knowledge.createEl("button", {
          cls: "xz-secondary-button xz-knowledge-removal-undo",
          text: "撤销最近一次知识删除",
          attr: { type: "button" },
        });
        undo.disabled = this.busy;
        undo.addEventListener("click", () => this.undoKnowledgeRemoval());
      }
    } else {
      this.renderLifecycleTab(report);
    }
  }
}

module.exports = { KnowledgeHealthPanel };
