"use strict";

const { Notice, setIcon } = require("obsidian");
const { KnowledgeReaderOverlay } = require("./view-knowledge-reader.cjs");

const ROOT_OPTIONS = Object.freeze([
  "01_当前的我", "02_我的历史", "03_环境", "04_关系", "05_目标与项目",
  "06_判断与决策", "07_行动", "08_结果与反馈", "09_认知资产", "11_证据与来源",
]);

const CONTENT_TYPES = Object.freeze([
  { id: "folder", label: "文件夹", kind: "folder", template: "index" },
  { id: "note", label: "普通笔记", kind: "note", template: "generic" },
  { id: "company", label: "公司卡", kind: "note", template: "company" },
  { id: "person", label: "人物卡", kind: "note", template: "person" },
  { id: "relationship", label: "关系记录", kind: "note", template: "relationship" },
  { id: "project", label: "项目笔记", kind: "note", template: "project" },
  { id: "company-list", label: "公司列表", kind: "list", template: "company-list" },
  { id: "person-list", label: "人物关系列表", kind: "list", template: "person-list" },
  { id: "project-list", label: "项目列表", kind: "list", template: "project-list" },
  { id: "custom-list", label: "自定义列表", kind: "list", template: "generic-list" },
]);

function text(value, fallback = "暂无") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function compactCardTag(value) {
  const normalized = text(value, "").replaceAll("\\", "/");
  return normalized.split("/").map((part) => part.trim()).filter(Boolean).at(-1) || "未分类";
}

function formatCardDate(value, fallback = "未记录更新时间") {
  const normalized = text(value, "");
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

function makeSelect(parent, label, values, selected, onChange) {
  const field = parent.createEl("label", { cls: "xz-structure-field" });
  field.createSpan({ text: label });
  const select = field.createEl("select");
  for (const item of values) {
    const option = select.createEl("option", {
      text: typeof item === "string" ? item : item.label,
      attr: { value: typeof item === "string" ? item : item.id },
    });
    if ((typeof item === "string" ? item : item.id) === selected) option.selected = true;
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function makeInput(parent, label, value, placeholder, onChange, eventName = "input") {
  const field = parent.createEl("label", { cls: "xz-structure-field" });
  field.createSpan({ text: label });
  const input = field.createEl("input", {
    attr: { type: "text", value, placeholder, maxlength: "120" },
  });
  input.addEventListener(eventName, () => onChange(input.value));
  return input;
}

class KnowledgeStructurePanel {
  constructor(options) {
    this.plugin = options.plugin;
    this.onClose = options.onClose;
    this.confirm = options.confirm;
    this.opened = false;
    this.busy = false;
    this.activeTab = "catalog";
    this.catalogMode = "cards";
    this.filters = { query: "", root: "all", type: "all" };
    this.draft = {
      root: "05_目标与项目",
      type: "note",
      folder: "",
      name: "",
      entries: null,
    };
    this.selectedSuggestions = new Set();
    this.enrichmentSelectionId = null;

    this.scrim = options.root.createDiv({ cls: "xz-maintenance-scrim", attr: { hidden: "" } });
    this.scrim.addEventListener("click", () => this.close());
    this.drawer = options.root.createEl("aside", {
      cls: "xz-maintenance-drawer xz-knowledge-structure",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-knowledge-structure-title",
      },
    });
    const header = this.drawer.createDiv({ cls: "xz-maintenance-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "本地 Markdown · 预览后确认" });
    heading.createEl("h2", { text: "知识结构管理", attr: { id: "xz-knowledge-structure-title" } });
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭知识结构管理", "aria-label": "关闭知识结构管理" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());
    this.body = this.drawer.createDiv({ cls: "xz-maintenance-body" });
    this.reader = new KnowledgeReaderOverlay({ root: options.root, plugin: this.plugin });
  }

  async open() {
    this.opened = true;
    this.scrim.removeAttribute("hidden");
    this.drawer.removeAttribute("hidden");
    this.render();
    this.closeButton.focus();
    if (this.plugin?.getKnowledgeStructureCatalog?.()?.presentationVersion !== 2) await this.refreshCatalog();
  }

  close() {
    const wasOpen = this.opened;
    this.reader.close();
    this.opened = false;
    this.scrim.setAttr("hidden", "");
    this.drawer.setAttr("hidden", "");
    if (wasOpen) this.onClose?.();
  }

  destroy() {
    this.opened = false;
    this.reader.destroy();
  }

  async refreshCatalog() {
    if (this.busy || typeof this.plugin?.refreshKnowledgeStructureCatalog !== "function") return;
    this.busy = true;
    this.render();
    try {
      const catalog = await this.plugin.refreshKnowledgeStructureCatalog();
      const skipped = Array.isArray(catalog?.skippedOversized) ? catalog.skippedOversized : [];
      if (skipped.length) {
        const head = skipped.slice(0, 2).join("、");
        new Notice(`已跳过 ${skipped.length} 个超大 Markdown 文件，其余知识不受影响：${head}${skipped.length > 2 ? " 等" : ""}`);
      }
    } catch (error) {
      new Notice(`知识目录扫描失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  creationInput() {
    const type = CONTENT_TYPES.find((item) => item.id === this.draft.type) || CONTENT_TYPES[1];
    return {
      kind: type.kind,
      template: type.template,
      root: this.draft.root,
      folder: this.draft.folder,
      name: this.draft.name,
      ...(type.kind === "list" && Array.isArray(this.draft.entries)
        ? { entries: this.draft.entries }
        : {}),
    };
  }

  async previewCreate() {
    if (this.busy || typeof this.plugin?.previewKnowledgeStructureCreate !== "function") return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.previewKnowledgeStructureCreate(this.creationInput());
    } catch (error) {
      new Notice(`创建预览失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async applyCreate(preview) {
    if (this.busy || !preview || typeof this.plugin?.applyKnowledgeStructureCreate !== "function") return;
    const paths = (preview.changes || []).map((change) => change.path).join("；");
    const confirmed = await this.confirm?.({
      title: "确认创建知识内容",
      message: `将创建 ${preview.changes?.length || 0} 个 Markdown 文件：${paths}。不会覆盖同名文件，提交后可以撤销。是否继续？`,
      confirmLabel: "确认创建",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.applyKnowledgeStructureCreate(preview.id);
      this.draft.name = "";
      this.draft.entries = null;
      new Notice("知识内容已创建，可在本页撤销最近变更");
      this.activeTab = "catalog";
    } catch (error) {
      new Notice(`创建失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async scanEnrichment() {
    if (this.busy || typeof this.plugin?.previewKnowledgeStructureEnrichment !== "function") return;
    this.busy = true;
    this.render();
    try {
      const preview = await this.plugin.previewKnowledgeStructureEnrichment();
      this.enrichmentSelectionId = preview.id;
      this.selectedSuggestions = new Set((preview.suggestions || []).slice(0, 8).map((item) => item.id));
    } catch (error) {
      new Notice(`智能整理扫描失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async applyEnrichment(preview) {
    if (this.busy || !preview || !this.selectedSuggestions.size
      || typeof this.plugin?.applyKnowledgeStructureEnrichment !== "function") return;
    const confirmed = await this.confirm?.({
      title: "确认写入所选标签与关联",
      message: `将更新 ${this.selectedSuggestions.size} 个已勾选的正式知识文件。只写入明确字段支持的标签和已解析关联，文件变化时会拒绝提交，并可撤销。是否继续？`,
      confirmLabel: "确认所选建议",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.applyKnowledgeStructureEnrichment(preview.id, [...this.selectedSuggestions]);
      this.selectedSuggestions.clear();
      this.enrichmentSelectionId = null;
      new Notice("所选智能整理建议已写入，可撤销最近变更");
    } catch (error) {
      new Notice(`智能整理提交失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async undoLatest() {
    const id = this.plugin?.state?.runtime?.knowledgeStructureLastTransactionId;
    if (this.busy || !id || typeof this.plugin?.undoTransaction !== "function") return;
    const confirmed = await this.confirm?.({
      title: "撤销最近一次知识结构变更",
      message: "撤销会按提交时的文件哈希校验当前状态；如文件后来被人工修改，将拒绝撤销以保护新内容。是否继续？",
      confirmLabel: "确认撤销",
    });
    if (!confirmed) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.undoTransaction(id);
      new Notice("最近一次知识结构变更已撤销");
    } catch (error) {
      new Notice(`撤销失败：${error?.message || "未知错误"}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async removeKnowledge(card) {
    if (this.busy || !card?.path
      || typeof this.plugin?.previewKnowledgeRemoval !== "function"
      || typeof this.plugin?.applyKnowledgeRemoval !== "function") return;
    this.busy = true;
    this.render();
    try {
      const preview = await this.plugin.previewKnowledgeRemoval(card.path);
      const confirmed = await this.confirm?.({
        title: `移入知识回收站：${text(preview.title, "未命名知识")}`,
        message: `对应的 Obsidian 文件：${preview.path}\n\n该文件会移入可恢复归档，不会永久删除；来源对话与证据不会删除。目录索引会自动更新，但其他笔记中的手写链接不会自动改写。预览后文件如有变化，提交会被拒绝。确认继续吗？`,
        confirmLabel: "移入知识回收站",
      });
      if (!confirmed) return;
      await this.plugin.applyKnowledgeRemoval(preview.id);
      this.reader.close();
      new Notice(`“${text(preview.title, "该知识")}”已移入知识回收站，可撤销`);
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

  filteredCards() {
    const catalog = this.plugin?.getKnowledgeStructureCatalog?.();
    const cards = catalog?.presentationVersion === 2 ? catalog.cards || [] : [];
    const query = this.filters.query.normalize("NFKC").trim().toLowerCase();
    return cards.filter((card) => {
      if (this.filters.root !== "all" && !card.path.startsWith(`${this.filters.root}/`)) return false;
      if (this.filters.type !== "all" && card.type !== this.filters.type) return false;
      if (!query) return true;
      return [
        card.title,
        card.type,
        card.path,
        card.summary,
        ...(card.keyPoints || []),
        ...(card.suggestedUses || []),
        ...(card.tags || []),
        ...(card.aliases || []),
        JSON.stringify(card.relations || []),
        card.source?.conversationPath || "",
        ...(card.source?.documents || []),
      ]
        .join(" ").normalize("NFKC").toLowerCase().includes(query);
    });
  }

  prepareListFromCards(cards) {
    if (!cards.length) {
      new Notice("当前筛选结果为空，不能生成列表");
      return;
    }
    this.draft = {
      root: "09_认知资产",
      type: "custom-list",
      folder: "",
      name: `知识筛选列表-${new Date().toISOString().slice(0, 10)}`,
      entries: cards.slice(0, 200).map((card) => ({
        title: card.title,
        type: card.type,
        path: card.path,
        tags: [...(card.tags || [])],
        relations: [...(card.relations || [])],
        updatedAt: card.updatedAt,
      })),
    };
    this.activeTab = "create";
    this.render();
  }

  renderTabs() {
    const tabs = this.body.createDiv({ cls: "xz-structure-tabs", attr: { role: "tablist" } });
    [["catalog", "知识目录"], ["create", "新建内容"], ["enrichment", "智能整理"]].forEach(([id, label]) => {
      const selected = this.activeTab === id;
      const button = tabs.createEl("button", {
        cls: selected ? "is-active" : "",
        text: label,
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.activeTab = id;
        this.render();
      });
    });
  }

  renderCreate() {
    const section = this.body.createEl("section", { cls: "xz-structure-section", attr: { role: "tabpanel" } });
    section.createEl("h3", { text: "新建内容" });
    section.createEl("p", { cls: "xz-health-section-intro", text: "先选择类型和保存位置，查看最终路径与完整 Markdown；只有再次确认后才写入 Vault。" });
    const form = section.createEl("form", { cls: "xz-structure-form" });
    makeSelect(form, "保存根目录", ROOT_OPTIONS, this.draft.root, (value) => { this.draft.root = value; });
    makeSelect(form, "内容类型", CONTENT_TYPES, this.draft.type, (value) => {
      this.draft.type = value;
      if (value !== "custom-list") this.draft.entries = null;
    });
    makeInput(form, "下级文件夹（可选）", this.draft.folder, "例如：客户与合作", (value) => { this.draft.folder = value; });
    makeInput(form, "名称", this.draft.name, "输入文件夹、笔记或列表名称", (value) => { this.draft.name = value; });
    if (Array.isArray(this.draft.entries)) {
      form.createEl("p", { cls: "xz-structure-selection-note", text: `将写入当前筛选结果 ${this.draft.entries.length} 条（最多 200 条）。` });
    }
    const submit = form.createEl("button", {
      cls: "xz-primary-button",
      text: this.busy ? "生成中…" : "预览创建",
      attr: { type: "submit" },
    });
    submit.disabled = this.busy || !this.draft.name.trim();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.previewCreate();
    });

    const preview = this.plugin?.state?.runtime?.knowledgeStructurePreview || null;
    if (!preview) return;
    const card = section.createEl("article", { cls: "xz-structure-preview" });
    card.createEl("h4", { text: "创建预览" });
    (preview.changes || []).forEach((change) => {
      card.createEl("strong", { text: change.path });
      card.createEl("p", { text: change.summary });
      card.createEl("h5", { text: "完整 Markdown" });
      card.createEl("pre", { text: change.content, attr: { tabindex: "0" } });
    });
    const confirm = card.createEl("button", { cls: "xz-primary-button", text: "确认创建", attr: { type: "button" } });
    confirm.disabled = this.busy;
    confirm.addEventListener("click", () => this.applyCreate(preview));
  }

  renderEnrichment() {
    const section = this.body.createEl("section", { cls: "xz-structure-section", attr: { role: "tabpanel" } });
    section.createEl("h3", { text: "智能整理" });
    section.createEl("p", { cls: "xz-health-section-intro", text: "只扫描行知正式 knowledge-v1 笔记。公司、人物和关系必须有明确字段；人物标签使用匿名稳定编号，不猜测动机。" });
    const scan = section.createEl("button", { cls: "xz-secondary-button", text: this.busy ? "扫描中…" : "扫描标签与关联候选", attr: { type: "button" } });
    scan.disabled = this.busy;
    scan.addEventListener("click", () => this.scanEnrichment());
    const preview = this.plugin?.state?.runtime?.knowledgeStructureEnrichmentPreview || null;
    if (!preview) return;
    if (this.enrichmentSelectionId !== preview.id) {
      this.enrichmentSelectionId = preview.id;
      this.selectedSuggestions = new Set((preview.suggestions || []).slice(0, 8).map((item) => item.id));
    }
    if (!preview.suggestions?.length) {
      section.createEl("p", { cls: "xz-maintenance-empty", text: "没有发现可以安全自动补充的正式知识。" });
      return;
    }
    const list = section.createDiv({ cls: "xz-structure-card-grid" });
    preview.suggestions.forEach((suggestion, index) => {
      const card = list.createEl("article", { cls: "xz-structure-card xz-structure-suggestion" });
      const label = card.createEl("label", { cls: "xz-structure-check" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selectedSuggestions.has(suggestion.id);
      checkbox.disabled = this.busy || (index >= 8 && !checkbox.checked);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (this.selectedSuggestions.size >= 8) {
            checkbox.checked = false;
            new Notice("单次最多选择 8 项，请分批提交");
          } else this.selectedSuggestions.add(suggestion.id);
        } else this.selectedSuggestions.delete(suggestion.id);
        this.render();
      });
      label.createEl("strong", { text: suggestion.path });
      card.createEl("p", { text: suggestion.reason });
      card.createEl("h5", { text: "证据片段" });
      const evidence = card.createEl("ul");
      (suggestion.evidence || []).forEach((item) => evidence.createEl("li", { text: item }));
      card.createEl("h5", { text: "拟增加标签" });
      const chips = card.createDiv({ cls: "xz-structure-chips" });
      (suggestion.additions?.tags || []).forEach((tag) => chips.createSpan({ text: tag }));
      card.createEl("p", { text: `拟增加已解析关联：${suggestion.additions?.relatedKnowledge?.length || 0} 条` });
    });
    const apply = section.createEl("button", { cls: "xz-primary-button", text: "确认所选建议", attr: { type: "button" } });
    apply.disabled = this.busy || this.selectedSuggestions.size === 0;
    apply.addEventListener("click", () => this.applyEnrichment(preview));
  }

  renderCatalogCard(parent, card) {
    const article = parent.createEl("article", {
      cls: "xz-structure-card xz-knowledge-product-card xz-product-card-frame",
    });
    const openReader = () => this.reader.open(card);
    article.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea, summary")) return;
      openReader();
    });
    const head = article.createDiv({ cls: "xz-structure-card-head" });
    const copy = head.createDiv();
    copy.createEl("span", { cls: "xz-eyebrow", text: text(card.type, "note") });
    copy.createEl("h4", { text: text(card.title, "未命名") });
    const badges = head.createDiv({ cls: "xz-knowledge-card-badges" });
    badges.createSpan({ cls: "xz-status-chip is-intelligent", text: "智能提炼" });
    badges.createSpan({ cls: "xz-status-chip", text: `调用 ${Number(card.usageCount || 0)} 次` });
    badges.createSpan({
      cls: `xz-status-chip is-usage-${card.usageBand || "discovery"}`,
      text: ({ active: "近期使用", cooling: "调用降温", stale: "退出自动调用", discovery: "待发现" })[card.usageBand] || "待发现",
    });
    const summary = article.createDiv({ cls: "xz-product-card-summary" });
    summary.createEl("span", { cls: "xz-product-card-label", text: "核心总结" });
    summary.createEl("p", { text: text(card.summary, "这条知识尚未形成可用摘要。") });
    const knowledge = article.createDiv({ cls: "xz-product-card-columns" });
    const points = knowledge.createDiv({ cls: "xz-product-card-block" });
    points.createEl("span", { cls: "xz-product-card-label", text: "核心知识点" });
    const pointList = points.createEl("ul");
    (card.keyPoints || []).slice(0, 1).forEach((point) => pointList.createEl("li", { text: point }));
    const uses = knowledge.createDiv({ cls: "xz-product-card-block is-use" });
    uses.createEl("span", { cls: "xz-product-card-label", text: "建议用途" });
    const useList = uses.createEl("ul");
    (card.suggestedUses || []).slice(0, 1).forEach((use) => useList.createEl("li", { text: use }));
    const chips = article.createDiv({ cls: "xz-structure-chips xz-product-card-tags" });
    (card.tags || []).slice(0, 2).forEach((tag) => chips.createSpan({
      text: compactCardTag(tag),
      attr: { title: String(tag || "") },
    }));
    const tagOverflow = Math.max(Number(card.tagOverflow || 0), Math.max(0, (card.tags || []).length - 2));
    if (tagOverflow > 0) chips.createSpan({ cls: "is-overflow", text: `+${tagOverflow}` });
    const meta = article.createDiv({ cls: "xz-product-card-meta" });
    meta.createSpan({ text: card.source?.conversationPath || card.source?.documents?.length ? "来源可追溯" : "来源待补充" });
    meta.createSpan({ text: formatCardDate(card.updatedAt) });
    const actions = article.createDiv({ cls: "xz-structure-card-actions" });
    const details = actions.createEl("button", { cls: "xz-primary-button", text: "展开阅读", attr: { type: "button" } });
    details.addEventListener("click", openReader);
    const open = actions.createEl("button", { cls: "xz-link-button", text: "在 Obsidian 打开", attr: { type: "button" } });
    open.addEventListener("click", () => this.plugin?.openVaultPath?.(card.path, { mode: "tab" }));
    if (card.format === "knowledge-v1") {
      const remove = actions.createEl("button", {
        cls: "xz-knowledge-delete-button",
        text: "移入回收站",
        attr: { type: "button", title: `将对应文件移入知识回收站：${card.path}` },
      });
      remove.disabled = this.busy;
      remove.addEventListener("click", () => this.removeKnowledge(card));
    }
  }

  renderCatalog() {
    const section = this.body.createEl("section", { cls: "xz-structure-section", attr: { role: "tabpanel" } });
    const head = section.createDiv({ cls: "xz-structure-section-head" });
    const copy = head.createDiv();
    copy.createEl("h3", { text: "知识目录" });
    copy.createEl("p", { cls: "xz-health-section-intro", text: "这里只展示经过提炼并写入为 knowledge-v1 的正式知识；原始对话、文档证据和普通笔记不会冒充知识卡。" });
    copy.createEl("p", {
      cls: "xz-health-section-intro",
      text: "调用次数从 v0.29.1 起按实际返回给模型的检索命中累计；旧对话没有完整的逐条调用日志，因此不做猜测回填。",
    });
    const refresh = head.createEl("button", { cls: "xz-secondary-button", text: this.busy ? "扫描中…" : "刷新目录", attr: { type: "button" } });
    refresh.disabled = this.busy;
    refresh.addEventListener("click", () => this.refreshCatalog());

    const filters = section.createDiv({ cls: "xz-structure-filters" });
    makeInput(filters, "搜索", this.filters.query, "标题、路径、标签、公司、关系或别名", (value) => { this.filters.query = value; this.render(); }, "change");
    makeSelect(filters, "根目录", [{ id: "all", label: "全部目录" }, ...ROOT_OPTIONS.map((root) => ({ id: root, label: root }))], this.filters.root, (value) => { this.filters.root = value; this.render(); });
    const storedCatalog = this.plugin?.getKnowledgeStructureCatalog?.() || {};
    const catalog = storedCatalog.presentationVersion === 2 ? storedCatalog : {};
    const allCards = catalog.cards || [];
    const types = [...new Set(allCards.map((card) => card.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    makeSelect(filters, "类型", [{ id: "all", label: "全部类型" }, ...types.map((type) => ({ id: type, label: type }))], this.filters.type, (value) => { this.filters.type = value; this.render(); });

    const cards = this.filteredCards();
    const visibleCards = cards.slice(0, 200);
    const toolbar = section.createDiv({ cls: "xz-structure-toolbar" });
    [["cards", "卡片视图"], ["table", "表格视图"]].forEach(([mode, label]) => {
      const button = toolbar.createEl("button", { cls: this.catalogMode === mode ? "xz-secondary-button is-active" : "xz-secondary-button", text: label, attr: { type: "button" } });
      button.addEventListener("click", () => { this.catalogMode = mode; this.render(); });
    });
    const buildList = toolbar.createEl("button", { cls: "xz-primary-button", text: "从筛选结果生成列表", attr: { type: "button" } });
    buildList.disabled = cards.length === 0;
    buildList.addEventListener("click", () => this.prepareListFromCards(cards));
    toolbar.createSpan({ cls: "xz-structure-result-count", text: `当前 ${cards.length} 条 · 显示 ${visibleCards.length} 条` });

    const structuralCards = catalog.structuralCards || [];
    const sourceCards = catalog.sourceCards || [];
    const ordinaryCards = catalog.ordinaryCards || [];
    const reviewCards = catalog.reviewCards || [];
    if (sourceCards.length || ordinaryCards.length) {
      section.createEl("p", {
        cls: "xz-structure-exclusion-note",
        attr: { role: "status" },
        text: `本次已从知识卡中排除 ${sourceCards.length} 条原始证据、${ordinaryCards.length} 条未提炼普通笔记；它们仍保留在 Obsidian 中，不会被删除。`,
      });
    }
    if (structuralCards.length) {
      const structural = section.createEl("details", { cls: "xz-structure-entries" });
      structural.createEl("summary", { text: `结构条目 ${structuralCards.length} 个（目录、索引与列表）` });
      const structureList = structural.createEl("ul");
      structuralCards.slice(0, 200).forEach((card) => {
        const item = structureList.createEl("li");
        const button = item.createEl("button", { cls: "xz-link-button", text: card.title, attr: { type: "button" } });
        button.addEventListener("click", () => this.plugin?.openVaultPath?.(card.path, { mode: "tab" }));
        item.createSpan({ text: ` · ${card.path}` });
      });
    }

    if (reviewCards.length) {
      const pending = section.createEl("details", { cls: "xz-structure-entries xz-structure-review-queue" });
      pending.createEl("summary", { text: `待智能加工 ${reviewCards.length} 条（不进入正式知识卡展示）` });
      pending.createEl("p", {
        text: "这些 knowledge-v1 文件缺少模型生成的核心总结、知识点或用途；原文仍保留，可在知识治理中重新整理。",
      });
      const list = pending.createEl("ul");
      reviewCards.slice(0, 200).forEach((card) => {
        const item = list.createEl("li");
        const open = item.createEl("button", { cls: "xz-link-button", text: card.title, attr: { type: "button" } });
        open.addEventListener("click", () => this.plugin?.openVaultPath?.(card.path, { mode: "tab" }));
        item.createSpan({ text: ` · ${card.path}` });
      });
    }
    if (!cards.length) {
      section.createEl("p", {
        cls: "xz-maintenance-empty",
        text: this.busy
          ? "正在扫描知识目录…"
          : reviewCards.length
            ? "当前没有已完成智能提炼的正式知识卡；上方旧资料仍保留在待加工队列。"
            : "当前筛选条件下没有知识。",
      });
      return;
    }
    if (this.catalogMode === "cards") {
      const grid = section.createDiv({ cls: "xz-structure-card-grid xz-knowledge-product-grid" });
      visibleCards.forEach((card) => this.renderCatalogCard(grid, card));
    } else {
      const wrap = section.createDiv({ cls: "xz-structure-table-wrap" });
      const table = wrap.createEl("table");
      const headRow = table.createEl("thead").createEl("tr");
      ["名称", "类型", "位置", "调用", "自动调用", "标签", "关联", "操作"].forEach((label) => headRow.createEl("th", { text: label }));
      const body = table.createEl("tbody");
      visibleCards.forEach((card) => {
        const row = body.createEl("tr");
        row.createEl("td", { text: card.title });
        row.createEl("td", { text: card.type });
        row.createEl("td", { text: card.path });
        row.createEl("td", { text: String(card.usageCount || 0) });
        row.createEl("td", { text: card.autoEligible === false ? "已退出" : "可调用" });
        row.createEl("td", { text: (card.tags || []).join("、") });
        row.createEl("td", { text: String(card.relations?.length || 0) });
        const actions = row.createEl("td", { cls: "xz-structure-table-actions" });
        const view = actions.createEl("button", { cls: "xz-link-button", text: "查看", attr: { type: "button" } });
        view.addEventListener("click", () => this.reader.open(card));
        if (card.format === "knowledge-v1") {
          const remove = actions.createEl("button", {
            cls: "xz-knowledge-delete-button",
            text: "移入回收站",
            attr: { type: "button", title: `将对应文件移入知识回收站：${card.path}` },
          });
          remove.disabled = this.busy;
          remove.addEventListener("click", () => this.removeKnowledge(card));
        }
      });
    }
  }

  render() {
    if (!this.opened) return;
    this.body.empty();
    const safety = this.body.createEl("div", { cls: "xz-structure-safety" });
    safety.createEl("strong", { text: "安全边界" });
    safety.createSpan({ text: "仅管理 01–09 与 11；原始证据不显示为知识卡；知识删除只移入可恢复回收站，不提供永久删除。" });
    this.renderTabs();
    if (this.activeTab === "create") this.renderCreate();
    else if (this.activeTab === "enrichment") this.renderEnrichment();
    else this.renderCatalog();

    const lastId = this.plugin?.state?.runtime?.knowledgeStructureLastTransactionId;
    if (lastId) {
      const undo = this.body.createEl("button", { cls: "xz-secondary-button xz-structure-undo", text: "撤销最近变更", attr: { type: "button" } });
      undo.disabled = this.busy;
      undo.addEventListener("click", () => this.undoLatest());
    }
    if (this.plugin?.state?.runtime?.knowledgeRemovalLastTransactionId) {
      const undo = this.body.createEl("button", {
        cls: "xz-secondary-button xz-knowledge-removal-undo",
        text: "撤销最近一次知识删除",
        attr: { type: "button" },
      });
      undo.disabled = this.busy;
      undo.addEventListener("click", () => this.undoKnowledgeRemoval());
    }
  }
}

module.exports = { KnowledgeStructurePanel };
