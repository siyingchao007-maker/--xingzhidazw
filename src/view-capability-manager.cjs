"use strict";

const { Modal, Notice, setIcon } = require("obsidian");
const { normalizedSkillType } = require("./capability-surface.cjs");
const {
  ACTION_COPY,
  renderReleaseActions,
  renderReleaseDetails,
  renderReleaseFeedback,
  renderReleaseMeta,
  renderReleaseStatus,
} = require("./view-capability-release.cjs");

const TABS = Object.freeze([
  { id: "agents", label: "Agent" },
  { id: "skills", label: "Skill" },
  { id: "lenses", label: "透镜" },
  { id: "simulator", label: "路由模拟" },
  { id: "tools", label: "受控工具" },
  { id: "issues", label: "配置问题" },
]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function visibleCapabilityAgents(values) {
  return list(values).filter((entry) => (
    entry?.id !== "xingzhi-orchestrator" && entry?.internal !== true
  ));
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function dependencyLabel(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "未知依赖";
  return `${text(value.id, "未知依赖")}${value.requiresVersion && value.requiresVersion !== "*" ? ` ${value.requiresVersion}` : ""}`;
}

function addList(parent, title, values, emptyText = "无") {
  const section = parent.createDiv({ cls: "xz-capability-detail-row" });
  section.createEl("strong", { text: title });
  const items = list(values);
  if (!items.length) {
    section.createSpan({ text: emptyText });
    return;
  }
  const host = section.createDiv({ cls: "xz-capability-chip-list" });
  for (const value of items) host.createSpan({ text: dependencyLabel(value) });
}

class XingzhiCapabilityManagerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.activeTab = "skills";
    this.pendingEnable = null;
    this.recoveryPreview = null;
    this.releasePreview = null;
    this.releaseOperationError = null;
    this.simulation = null;
    this.busy = false;
  }

  onOpen() {
    this.modalEl.addClass("xz-capability-manager-modal");
    this.render();
    void this.refresh();
  }

  onClose() {
    this.contentEl.empty();
  }

  snapshot() {
    return this.plugin?.state?.runtime?.capabilityManager || {
      agents: [], skills: [], issues: [], tools: [], limits: {},
    };
  }

  async refresh() {
    if (this.busy || typeof this.plugin?.refreshCapabilityCatalog !== "function") return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.refreshCapabilityCatalog();
    } catch (error) {
      new Notice(`能力扫描未完成：${text(error?.message, "未知错误")}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "xz-capability-manager-header" });
    const title = header.createDiv();
    title.createEl("span", { cls: "xz-card-kicker", text: "动态能力运行时" });
    title.createEl("h2", { text: "能力管理" });
    title.createEl("p", { text: "查看、校验和管理 Obsidian 中的 Agent、Skill、透镜与受控工具。扩展能力首次发现时不会自动启用。" });
    const refresh = header.createEl("button", {
      cls: "xz-capability-refresh",
      attr: { type: "button", "aria-label": "重新扫描能力" },
    });
    const icon = refresh.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "refresh-cw");
    refresh.createSpan({ text: this.busy ? "扫描中" : "重新扫描" });
    refresh.disabled = this.busy;
    refresh.addEventListener("click", () => void this.refresh());

    const snapshot = this.snapshot();
    if (snapshot.governanceStatus) {
      const governance = this.contentEl.createDiv({ cls: "xz-capability-section-intro", attr: { role: "status" } });
      governance.createEl("strong", { text: snapshot.governanceStatus.message });
      governance.createEl("p", { text: snapshot.governanceStatus.reason || snapshot.governanceStatus.registryRoot || "" });
    }
    const summary = this.contentEl.createDiv({ cls: "xz-capability-summary" });
    const visibleAgents = visibleCapabilityAgents(snapshot.agents);
    const taskSkills = list(snapshot.skills).filter((entry) => normalizedSkillType(entry) !== "cognitive-lens");
    const lenses = list(snapshot.skills).filter((entry) => normalizedSkillType(entry) === "cognitive-lens");
    for (const item of [
      ["Agent", visibleAgents.length],
      ["Skill", taskSkills.length],
      ["透镜", lenses.length],
      ["已启用扩展", [...visibleAgents, ...list(snapshot.skills)].filter((entry) => !entry.protected && entry.enabled).length],
      ["配置问题", list(snapshot.issues).length],
    ]) {
      const card = summary.createDiv({ cls: "xz-capability-summary-card" });
      card.createEl("strong", { text: String(item[1]) });
      card.createSpan({ text: item[0] });
    }

    const tabs = this.contentEl.createDiv({ cls: "xz-capability-tabs", attr: { role: "tablist" } });
    for (const tab of TABS) {
      const button = tabs.createEl("button", {
        text: tab.label,
        cls: this.activeTab === tab.id ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(this.activeTab === tab.id) },
      });
      button.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.pendingEnable = null;
        this.recoveryPreview = null;
        this.releasePreview = null;
        this.releaseOperationError = null;
        this.render();
      });
    }

    const body = this.contentEl.createDiv({ cls: "xz-capability-manager-body" });
    if (this.activeTab === "agents") this.renderCapabilities(body, "agents", visibleAgents);
    else if (this.activeTab === "skills") this.renderCapabilities(body, "skills", taskSkills);
    else if (this.activeTab === "lenses") this.renderCapabilities(body, "lenses", lenses);
    else if (this.activeTab === "simulator") this.renderSimulator(body);
    else if (this.activeTab === "tools") this.renderTools(body, snapshot.tools);
    else this.renderIssues(body, snapshot.issues);
  }

  renderCapabilities(parent, kind, values) {
    const entries = list(values);
    const introduction = parent.createDiv({ cls: "xz-capability-section-intro" });
    introduction.createEl("h3", { text: kind === "agents" ? "Agent 目录" : kind === "lenses" ? "透镜目录" : "Skill 目录" });
    introduction.createEl("p", {
      text: kind === "agents"
        ? "Agent 决定本轮角色和主工作流，但不能提高任何系统权限。"
        : kind === "lenses"
          ? "透镜补充分析视角，不承担主 Skill 工作流，也不扩大读取或工具权限。"
          : "Skill 定义工作方法和输出契约；依赖由工作台展开，不能在正文中自行递归执行。",
    });
    if (!entries.length) {
      parent.createEl("p", { cls: "xz-capability-empty", text: "尚未发现能力。" });
      return;
    }
    const grid = parent.createDiv({ cls: "xz-capability-grid" });
    for (const capability of entries) this.renderCapabilityCard(grid, kind, capability);
  }

  renderCapabilityCard(parent, kind, capability) {
    const id = text(capability.id);
    const release = kind === "skills" || kind === "lenses" ? capability.releaseManagement : null;
    const card = parent.createEl("article", {
      cls: `xz-capability-item ${capability.enabled ? "is-enabled" : "is-disabled"}${release ? ` has-release is-release-${release.status?.id || "unknown"}` : ""}`,
    });
    const header = card.createDiv({ cls: "xz-capability-item-header" });
    const heading = header.createDiv();
    heading.createEl("span", {
      cls: "xz-card-kicker",
      text: capability.protected ? "受保护核心" : "Vault 扩展",
    });
    heading.createEl("h4", { text: text(capability.label, id) });
    const statusHost = header.createDiv({ cls: "xz-capability-status-stack" });
    const status = statusHost.createSpan({
      cls: `xz-capability-status ${capability.enabled ? "is-on" : "is-off"}`,
      text: capability.enabled ? "已启用" : "未启用",
    });
    status.setAttr("aria-label", capability.enabled ? "该能力已启用" : "该能力未启用");
    renderReleaseStatus(statusHost, release);
    card.createEl("p", { cls: "xz-capability-description", text: text(capability.description, "暂无说明") });

    const meta = card.createDiv({ cls: "xz-capability-meta" });
    meta.createSpan({ text: `版本 ${text(capability.version, "1.0.0")}` });
    meta.createSpan({ text: capability.riskLevel === "bounded" ? "权限受限" : "需复核" });
    if (capability.versionStatus === "modified") meta.createSpan({ cls: "is-warning", text: "本地已修改" });
    renderReleaseMeta(meta, release);

    const details = card.createEl("details", { cls: "xz-capability-details" });
    details.createEl("summary", { text: release ? "查看能力范围、版本与依赖" : "查看能力范围与依赖" });
    addList(details, "适用意图", capability.intents);
    addList(details, "核心能力", capability.capabilities);
    addList(details, "读取范围", capability.readScopes, "不主动扩大读取范围");
    if (kind === "skills" || kind === "lenses") {
      addList(details, "必需依赖", capability.requires);
      addList(details, "可选依赖", capability.optionalDependencies);
      addList(details, "冲突能力", capability.conflicts);
      addList(details, "工具请求", capability.toolRequests, "无工具请求");
    }
    const hash = details.createDiv({ cls: "xz-capability-hash" });
    hash.createEl("strong", { text: "内容指纹" });
    hash.createEl("code", { text: text(capability.contentHash, "尚未生成").slice(0, 20) });
    renderReleaseDetails(details, release);

    if (this.pendingEnable?.kind === kind && this.pendingEnable?.id === id) {
      const preview = card.createDiv({ cls: "xz-capability-install-preview" });
      preview.createEl("strong", { text: "启用前预览" });
      preview.createEl("p", {
        text: `将读取：${list(capability.readScopes).join("、") || "不新增主动读取范围"}；依赖：${list(capability.requires).map(dependencyLabel).join("、") || "无"}；工具：${list(capability.toolRequests).join("、") || "无"}。启用不会获得写入、删除、外发或执行权限。`,
      });
    }
    if (this.recoveryPreview?.kind === kind && this.recoveryPreview?.id === id) {
      const preview = card.createDiv({ cls: "xz-capability-install-preview" });
      preview.createEl("strong", { text: "官方版本恢复预览" });
      preview.createEl("p", {
        text: `将恢复 ${this.recoveryPreview.changes.filter((item) => item.changed).length} 个控制文件；恢复前会生成本地备份。正式知识笔记不受影响。`,
      });
    }
    renderReleaseFeedback(card, {
      release,
      preview: this.releasePreview,
      operationError: this.releaseOperationError,
    });

    const actions = card.createDiv({ cls: "xz-capability-actions" });
    renderReleaseActions(actions, {
      release,
      preview: this.releasePreview,
      disabled: this.busy,
      onValidate: () => void this.validateRelease(id),
      onPreview: (action) => void this.previewReleaseAction(action, id),
      onApply: () => void this.applyReleaseAction(),
    });
    if (!capability.protected) {
      const pending = this.pendingEnable?.kind === kind && this.pendingEnable?.id === id;
      const toggle = actions.createEl("button", {
        text: capability.enabled ? "停用扩展" : (pending ? "确认启用" : "预览并启用"),
        attr: { type: "button" },
      });
      toggle.disabled = this.busy;
      toggle.addEventListener("click", () => {
        if (!capability.enabled && !pending) {
          this.pendingEnable = { kind, id };
          this.render();
          return;
        }
        void this.setEnabled(kind === "lenses" ? "skills" : kind, id, !capability.enabled);
      });
    }
    if (capability.protected && capability.versionStatus === "modified") {
      const pendingRecovery = this.recoveryPreview?.kind === (kind === "lenses" ? "skills" : kind)
        && this.recoveryPreview?.id === id;
      const recovery = actions.createEl("button", {
        text: pendingRecovery ? "确认恢复官方版本" : "预览官方恢复",
        attr: { type: "button" },
      });
      recovery.disabled = this.busy;
      recovery.addEventListener("click", () => {
        if (pendingRecovery) void this.applyRecovery();
        else void this.previewRecovery(kind === "lenses" ? "skills" : kind, id);
      });
    }
    const openPath = actions.createEl("button", { text: "在 Obsidian 打开", attr: { type: "button" } });
    openPath.addEventListener("click", () => void this.plugin?.openVaultPath?.(capability.path));
  }

  async setEnabled(kind, id, enabled) {
    if (this.busy || typeof this.plugin?.setCapabilityEnabled !== "function") return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.setCapabilityEnabled(kind, id, enabled);
      this.pendingEnable = null;
      new Notice(enabled ? "扩展能力已启用" : "扩展能力已停用");
    } catch (error) {
      new Notice(`无法更新能力：${text(error?.message, "未知错误")}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  releaseError(id, error, fallback) {
    return {
      id,
      message: text(error?.message, fallback),
      path: text(error?.filePath, "10_智能体与技能/技能"),
      field: text(error?.field, "skill"),
    };
  }

  async validateRelease(id) {
    if (this.busy || typeof this.plugin?.validateCapabilityRelease !== "function") return;
    this.busy = true;
    this.render();
    try {
      const result = await this.plugin.validateCapabilityRelease(id);
      this.releasePreview = null;
      if (result.validation?.passed === false) {
        this.releaseOperationError = {
          id,
          message: result.validation.error?.message || "草稿校验失败",
          path: result.validation.error?.path || result.sourcePath,
          field: result.validation.error?.field || "skill",
        };
        new Notice(`草稿校验失败：${this.releaseOperationError.path} · ${this.releaseOperationError.field}`);
      } else {
        this.releaseOperationError = null;
        const evaluation = result.evaluation;
        new Notice(evaluation?.passed
          ? `草稿校验与发布评测通过：${evaluation.qualifyingCases}/${evaluation.requiredCases}`
          : `草稿结构校验通过；发布评测 ${evaluation?.qualifyingCases || 0}/${evaluation?.requiredCases || 0} 尚未通过`);
      }
    } catch (error) {
      this.releaseOperationError = this.releaseError(id, error, "草稿校验失败");
      new Notice(`草稿校验失败：${this.releaseOperationError.path} · ${this.releaseOperationError.field}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async previewReleaseAction(action, id) {
    if (this.busy || typeof this.plugin?.previewCapabilityReleaseAction !== "function") return;
    this.busy = true;
    this.render();
    try {
      this.releasePreview = await this.plugin.previewCapabilityReleaseAction(action, id);
      this.releaseOperationError = null;
    } catch (error) {
      this.releasePreview = null;
      this.releaseOperationError = this.releaseError(id, error, "无法生成版本变更预览");
      new Notice(`无法生成预览：${this.releaseOperationError.path} · ${this.releaseOperationError.field}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async applyReleaseAction() {
    if (this.busy || !this.releasePreview || typeof this.plugin?.applyCapabilityReleaseAction !== "function") return;
    const preview = this.releasePreview;
    this.busy = true;
    this.render();
    try {
      const result = await this.plugin.applyCapabilityReleaseAction(preview.token);
      this.releasePreview = null;
      this.releaseOperationError = null;
      new Notice(ACTION_COPY[result.action]?.done || "Skill 版本状态已更新");
    } catch (error) {
      this.releasePreview = null;
      this.releaseOperationError = this.releaseError(preview.skillId, error, "Skill 版本操作失败");
      new Notice(`版本操作失败：${this.releaseOperationError.path} · ${this.releaseOperationError.field}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async previewRecovery(kind, id) {
    if (this.busy || typeof this.plugin?.previewCapabilityRecovery !== "function") return;
    this.busy = true;
    try {
      this.recoveryPreview = await this.plugin.previewCapabilityRecovery(kind, id);
    } catch (error) {
      new Notice(`无法生成恢复预览：${text(error?.message, "未知错误")}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async applyRecovery() {
    if (this.busy || !this.recoveryPreview || typeof this.plugin?.applyCapabilityRecovery !== "function") return;
    this.busy = true;
    try {
      const result = await this.plugin.applyCapabilityRecovery(this.recoveryPreview.token);
      this.recoveryPreview = null;
      new Notice(`已恢复 ${result.restoredFiles} 个文件；恢复前版本已备份`);
    } catch (error) {
      new Notice(`能力恢复失败：${text(error?.message, "未知错误")}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  renderSimulator(parent) {
    const section = parent.createEl("section", { cls: "xz-capability-simulator" });
    section.createEl("h3", { text: "路由模拟器" });
    section.createEl("p", { text: "输入一句真实请求，只预览会选择哪些能力，不发送给模型，也不执行任务。" });
    const textarea = section.createEl("textarea", {
      attr: { rows: "4", placeholder: "例如：评估这个项目的承压能力，并给出恢复顺序" },
    });
    const run = section.createEl("button", { text: "开始模拟", cls: "mod-cta", attr: { type: "button" } });
    run.addEventListener("click", () => {
      try {
        this.simulation = this.plugin?.simulateCapabilityRoute?.(textarea.value);
        this.render();
      } catch (error) {
        new Notice(`路由模拟失败：${text(error?.message, "未知错误")}`);
      }
    });
    if (!this.simulation) return;
    const result = section.createEl("article", { cls: "xz-capability-simulation-result" });
    result.createEl("span", { cls: "xz-card-kicker", text: "仅预览 · 未执行" });
    if (this.simulation.agent?.id === "xingzhi-orchestrator") {
      result.createEl("h4", { text: "路由方式：后台自动调度" });
    } else {
      result.createEl("h4", { text: `主 Agent：${text(this.simulation.agent?.label, "专业 Agent")}` });
    }
    result.createEl("p", { text: text(this.simulation.agent?.reason, "按安全后备处理") });
    const lensIds = new Set(list(this.snapshot().skills)
      .filter((item) => normalizedSkillType(item) === "cognitive-lens").map((item) => item.id));
    const simulatedSkills = list(this.simulation.skills);
    addList(result, "Skill 调用顺序", simulatedSkills.filter((item) => !lensIds.has(item.id))
      .map((item) => `${item.label}（${item.role === "primary" ? "主要" : "辅助"}）`), "零 Skill");
    addList(result, "透镜", simulatedSkills.filter((item) => lensIds.has(item.id))
      .map((item) => item.label), "本轮未用透镜");
    addList(result, "推理方法", list(this.simulation.reasoningMethods).map((item) => item.label), "无需额外方法");
    addList(result, "候选能力", list(this.simulation.routingAudit?.candidates).map((item) => (
      `${item.id}${Number.isFinite(item.score) ? ` · 匹配分 ${item.score}` : ""}`
    )), "无候选");
    addList(result, "未采用", list(this.simulation.routingAudit?.rejected).map((item) => (
      `${item.id} · ${item.reason}`
    )), "无拒绝项");
    const boundary = result.createEl("p", { cls: "xz-capability-boundary" });
    boundary.setText("模拟结果不能授予知识写入、外部发送或 Codex 执行权限。");
  }

  renderTools(parent, values) {
    parent.createEl("h3", { text: "受控工具注册表" });
    parent.createEl("p", { text: "只有这里登记的工具才能被能力请求；高风险操作必须逐轮确认。" });
    const grid = parent.createDiv({ cls: "xz-capability-grid xz-tool-grid" });
    for (const tool of list(values)) {
      const card = grid.createEl("article", { cls: "xz-capability-item" });
      card.createEl("span", { cls: "xz-card-kicker", text: text(tool.permission, "未知权限") });
      card.createEl("h4", { text: text(tool.label, tool.id) });
      card.createEl("p", { text: text(tool.description, "暂无说明") });
      const meta = card.createDiv({ cls: "xz-capability-meta" });
      meta.createSpan({ text: `每轮最多 ${tool.rateLimit} 次` });
      meta.createSpan({ text: tool.confirmation === "required" ? "必须确认" : tool.confirmation === "policy" ? "服从知识策略" : "无需额外确认" });
      meta.createSpan({ text: tool.rollback ? "支持恢复" : "只读或无变更" });
    }
  }

  renderIssues(parent, values) {
    const issues = list(values);
    parent.createEl("h3", { text: "被隔离的配置问题" });
    parent.createEl("p", { text: "错误配置只会停用对应扩展，不会让四个核心 Agent、六个核心 Skill 或主工作台失效。" });
    if (!issues.length) {
      parent.createEl("p", { cls: "xz-capability-empty", text: "当前没有发现配置问题。" });
      return;
    }
    const listEl = parent.createDiv({ cls: "xz-capability-issue-list" });
    for (const issue of issues) {
      const card = listEl.createEl("article", { cls: "xz-capability-issue" });
      card.createEl("strong", { text: text(issue.message, "配置无效") });
      card.createEl("code", { text: text(issue.path, "未知位置") });
    }
  }
}

module.exports = { XingzhiCapabilityManagerModal };
