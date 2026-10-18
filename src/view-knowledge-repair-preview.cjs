"use strict";

const { setIcon } = require("obsidian");

function list(value) {
  return Array.isArray(value) ? value : [];
}

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function renderMetric(parent, label, value) {
  const item = parent.createDiv({ cls: "xz-repair-preview-metric" });
  item.createEl("strong", { text: String(count(value)) });
  item.createSpan({ text: label });
}

class KnowledgeRepairPreviewOverlay {
  constructor(options) {
    this.fallbackFocus = options.fallbackFocus || null;
    this.preview = null;
    this.mode = "health";
    this.onConfirm = null;
    this.onOpenPath = null;
    this.busy = false;
    this.returnFocus = null;
    this.overlay = options.root.createEl("section", {
      cls: "xz-knowledge-repair-preview xz-knowledge-reader",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "xz-knowledge-repair-preview-title",
      },
    });
    this.overlay.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  open(options = {}) {
    if (!options.preview) return;
    this.preview = options.preview;
    this.mode = options.mode === "index" ? "index" : "health";
    this.onConfirm = options.onConfirm;
    this.onOpenPath = options.onOpenPath;
    this.busy = false;
    this.returnFocus = this.overlay.ownerDocument?.activeElement || null;
    this.overlay.removeAttribute("hidden");
    this.render();
    this.closeButton?.focus();
  }

  close() {
    if (this.busy) return;
    const returnFocus = this.returnFocus;
    this.preview = null;
    this.onConfirm = null;
    this.onOpenPath = null;
    this.returnFocus = null;
    this.overlay.setAttr("hidden", "");
    this.overlay.empty();
    const focusTarget = returnFocus?.isConnected === false ? this.fallbackFocus : (returnFocus || this.fallbackFocus);
    focusTarget?.focus?.();
  }

  onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...this.overlay.querySelectorAll?.("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])") || []];
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

  async confirm() {
    if (this.busy || typeof this.onConfirm !== "function") return;
    this.busy = true;
    this.render();
    let completed = false;
    try {
      completed = await this.onConfirm(this.preview) === true;
    } finally {
      this.busy = false;
      if (completed) this.close();
      else this.render();
    }
  }

  openPath(path) {
    if (path && typeof this.onOpenPath === "function") this.onOpenPath(path);
  }

  renderPathList(parent, title, paths) {
    const clean = list(paths).filter((path) => typeof path === "string" && path.trim());
    if (!clean.length) return;
    const details = parent.createEl("details", { cls: "xz-repair-preview-details", attr: { open: "" } });
    details.createEl("summary", { text: `${title}（${clean.length}）` });
    const items = details.createEl("ul");
    clean.forEach((path) => {
      const item = items.createEl("li");
      const button = item.createEl("button", { cls: "xz-link-button", text: path, attr: { type: "button" } });
      button.addEventListener("click", () => this.openPath(path));
    });
  }

  renderIndex(body, preview) {
    const changes = list(preview.changes);
    const linkCount = changes.reduce((sum, item) => sum + count(item?.linkCount), 0);
    const summary = body.createEl("section", { cls: "xz-knowledge-reader-summary" });
    const head = summary.createDiv({ cls: "xz-knowledge-reader-section-head" });
    head.createSpan({ text: "目录整理方案" });
    if (!changes.length) {
      summary.createEl("h2", { text: "知识目录已经是最新状态，无需处理" });
      summary.createEl("p", { text: "本次检查没有发现缺失或过期的自动目录链接，未产生任何写入操作。" });
      return false;
    }
    summary.createEl("h2", { text: `准备更新 ${changes.length} 个知识目录` });
    summary.createEl("p", { text: `本次将新增或更新 ${linkCount} 条知识链接。只整理行知管理的自动目录区块，不会修改手写内容。` });

    const section = body.createEl("section", { cls: "xz-knowledge-reader-section" });
    section.createEl("h2", { text: "将要更新的目录" });
    const items = section.createDiv({ cls: "xz-repair-preview-change-list" });
    changes.forEach((change) => {
      const card = items.createDiv({ cls: "xz-repair-preview-change" });
      const open = card.createEl("button", {
        cls: "xz-link-button",
        text: change?.path || "未命名目录",
        attr: { type: "button" },
      });
      open.addEventListener("click", () => this.openPath(change?.path));
      card.createSpan({ text: `${count(change?.linkCount)} 条知识链接` });
    });
    return true;
  }

  renderHealth(body, preview) {
    const schemaFiles = list(preview.schemaFiles);
    const duplicates = list(preview.duplicateDefinitions);
    const manualIssues = list(preview.manualIssues);
    const repairable = count(preview.repairableIssues);
    const summary = body.createEl("section", { cls: "xz-knowledge-reader-summary" });
    const head = summary.createDiv({ cls: "xz-knowledge-reader-section-head" });
    head.createSpan({ text: "问题处理方案" });
    summary.createEl("h2", { text: repairable ? `准备处理 ${repairable} 个知识问题` : "当前没有可自动提交的处理项" });
    summary.createEl("p", {
      text: repairable
        ? `方案覆盖 ${count(preview.requestedIssues)} 个问题。系统只处理已列出的安全变更，不会修改手写内容，也不会永久删除旧知识。`
        : "所选问题需要人工判断，或在重新扫描后已不存在；本次不会写入知识库。",
    });

    const metrics = body.createEl("section", { cls: "xz-repair-preview-metrics", attr: { "aria-label": "处理方案摘要" } });
    renderMetric(metrics, "旧字段升级", schemaFiles.length);
    renderMetric(metrics, "旧定义归档", duplicates.length);
    renderMetric(metrics, "目录更新", preview.indexFiles);
    renderMetric(metrics, "人工判断", manualIssues.length);

    this.renderPathList(body, "旧字段升级文件", schemaFiles);
    if (duplicates.length) {
      const details = body.createEl("details", { cls: "xz-repair-preview-details", attr: { open: "" } });
      details.createEl("summary", { text: `旧定义移入可恢复归档区（${duplicates.length}）` });
      details.createEl("p", { cls: "xz-repair-preview-safety", text: "不会直接删除旧定义；旧副本移入可恢复归档区，权威定义保持不变。" });
      const moves = details.createDiv({ cls: "xz-repair-preview-change-list" });
      duplicates.forEach((item) => {
        const card = moves.createDiv({ cls: "xz-repair-preview-change" });
        card.createEl("strong", { text: item?.from || "未知旧副本" });
        card.createSpan({ text: `保留：${item?.canonicalPath || "未知权威定义"}` });
        card.createSpan({ text: `归档到：${item?.to || "待生成"}` });
      });
    }
    if (count(preview.indexIssues) || count(preview.indexFiles)) {
      const details = body.createEl("details", { cls: "xz-repair-preview-details" });
      details.createEl("summary", { text: `整理知识目录（${count(preview.indexFiles)} 个目录）` });
      details.createEl("p", { text: "只替换“行知自动索引”区块，不会修改手写内容。" });
    }
    if (manualIssues.length) {
      const details = body.createEl("details", { cls: "xz-repair-preview-details" });
      details.createEl("summary", { text: `需要人工判断（${manualIssues.length}）` });
      const items = details.createEl("ul");
      manualIssues.forEach((issue) => items.createEl("li", { text: `${issue?.code || "未知问题"} · ${issue?.path || "未知路径"}` }));
    }
    return repairable > 0;
  }

  render() {
    if (!this.preview) return;
    const preview = this.preview;
    this.overlay.empty();
    const header = this.overlay.createEl("header", { cls: "xz-knowledge-reader-header" });
    const heading = header.createDiv({ cls: "xz-knowledge-reader-heading" });
    heading.createEl("span", { cls: "xz-eyebrow", text: "只读预览 · 确认后才会写入" });
    heading.createEl("h1", {
      text: this.mode === "index" ? "目录整理方案" : "知识问题处理方案",
      attr: { id: "xz-knowledge-repair-preview-title" },
    });
    const headerActions = header.createDiv({ cls: "xz-knowledge-reader-header-actions" });
    this.closeButton = headerActions.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭处理方案", "aria-label": "关闭处理方案" },
    });
    this.closeButton.disabled = this.busy;
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());

    const body = this.overlay.createDiv({ cls: "xz-knowledge-reader-body xz-repair-preview-body" });
    const canConfirm = this.mode === "index" ? this.renderIndex(body, preview) : this.renderHealth(body, preview);
    const safety = body.createEl("section", { cls: "xz-knowledge-reader-section xz-repair-preview-safety" });
    safety.createEl("h2", { text: "安全边界" });
    const points = safety.createEl("ul", { cls: "xz-knowledge-reader-list" });
    [
      "当前页面只是方案预览，不会立即写入。",
      "提交前会再次校验文件是否变化，避免覆盖人工编辑。",
      "旧副本只移入可恢复归档区，不做永久删除。",
      "目录整理只维护行知自动区块，不会修改手写内容。",
    ].forEach((point) => points.createEl("li", { text: point }));

    const actions = body.createDiv({ cls: "xz-repair-preview-actions" });
    const cancel = actions.createEl("button", { cls: "xz-secondary-button", text: "返回检查结果", attr: { type: "button" } });
    cancel.disabled = this.busy;
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "xz-primary-button",
      text: this.busy ? "正在提交…" : (this.mode === "index" ? "确认更新目录" : "提交处理"),
      attr: { type: "button" },
    });
    confirm.disabled = this.busy || !canConfirm;
    confirm.addEventListener("click", () => this.confirm());
  }
}

module.exports = { KnowledgeRepairPreviewOverlay };
