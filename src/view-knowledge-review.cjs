const { Modal } = require("obsidian");

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function addReviewSection(parent, title, value, className = "") {
  const text = firstText(value);
  if (!text) return null;
  const section = parent.createEl("section", {
    cls: ["xz-knowledge-review-section", className].filter(Boolean).join(" "),
  });
  section.createEl("h3", { text: title });
  section.createEl("p", { text });
  return section;
}

function addMetadata(parent, entries) {
  const present = entries.filter(([, value]) => firstText(value));
  if (!present.length) return;
  const meta = parent.createDiv({ cls: "xz-knowledge-review-meta" });
  present.forEach(([label, value]) => {
    const row = meta.createDiv({ cls: "xz-knowledge-review-meta-row" });
    row.createSpan({ text: label });
    row.createEl("strong", { text: firstText(value) });
  });
}

function addRelatedNote(parent, relatedPath, onOpenPath) {
  const path = firstText(relatedPath);
  if (!path) return;
  const section = parent.createEl("section", { cls: "xz-knowledge-review-section xz-related-note" });
  section.createEl("h3", { text: "冲突知识笔记" });
  section.createEl("p", { text: path });
  const button = section.createEl("button", {
    cls: "xz-secondary-button xz-open-related-note",
    text: "打开知识笔记",
    attr: { type: "button" },
  });
  button.disabled = typeof onOpenPath !== "function";
  button.addEventListener("click", () => onOpenPath?.(path));
}

function clarificationFieldLabel(clarification) {
  const explicit = firstText(clarification?.fieldLabel, clarification?.missingField);
  if (explicit) return explicit.slice(0, 24);
  const question = firstText(clarification?.question, clarification?.title);
  return question.match(/(生效时间|变化时间|适用时间|时间范围|适用范围|信息来源|原始依据|具体对象|目标期限|判断标准)/u)?.[1]
    || "回答这个具体问题";
}

class XingzhiKnowledgeDetailModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.candidate = options.candidate || {};
    this.decision = options.decision || {};
    this.clarification = options.clarification || {};
    this.confirmation = options.confirmation || null;
    this.relatedPath = options.relatedPath || "";
    this.reportPath = options.reportPath || "";
    this.onOpenPath = options.onOpenPath;
    this.onDecision = options.onDecision;
    this.onClarify = options.onClarify;
  }

  onOpen() {
    this.modalEl.addClass("xz-knowledge-review-modal", "is-fullscreen");
    this.titleEl.setText(this.confirmation ? "知识审核与处理" : "知识候选详情");
    const title = firstText(this.candidate.title, this.candidate.key, "待整理知识");
    this.contentEl.createEl("h2", { cls: "xz-knowledge-review-title", text: title });
    addMetadata(this.contentEl, [
      ["知识类型", this.candidate.knowledgeType || this.candidate.type],
      ["认识状态", this.candidate.epistemicStatus],
      ["候选状态", this.decision.decision || this.candidate.reviewState || this.candidate.status],
      ["处理级别", this.confirmation?.reviewKind === "major" ? "重大信息，需要人工确认" : (this.confirmation ? "普通确认" : "仅展示判断结果")],
      ["拟写入位置", this.confirmation?.path],
      ["知识键", this.candidate.key],
      ["跨轮证据", this.candidate.evidenceCount ? `${this.candidate.evidenceCount} 个独立回合` : "来源待核对"],
    ]);
    addReviewSection(
      this.contentEl,
      "候选要表达什么",
      firstText(this.candidate.content, this.candidate.summary, this.candidate.reason, "暂无正文"),
      "xz-knowledge-review-content",
    );
    addReviewSection(
      this.contentEl,
      "为什么进入候选",
      firstText(
        this.candidate.whyUseful,
        this.decision.message,
        this.clarification.reason,
        this.candidate.reason,
        "系统已识别到跨轮重复证据，且这项内容可能影响未来检索或回答。",
      ),
    );
    addReviewSection(
      this.contentEl,
      "支持证据",
      this.candidate.evidenceCount
        ? `同一主张已在 ${this.candidate.evidenceCount} 个独立回合出现。${this.candidate.evidenceQuote ? `最近原话：${this.candidate.evidenceQuote}` : "来源消息已保留在本地对话记录中。"}`
        : firstText(this.candidate.evidenceQuote, "来源消息已经记录，但当前候选缺少可显示的跨轮计数。"),
    );
    if (this.confirmation) {
      addReviewSection(
        this.contentEl,
        "确认后的影响",
        `确认后将通过可撤销的本地事务写入 ${firstText(this.confirmation.path, "正式知识库")}；不写入只会取消本次候选，不会删除原始对话和整理报告。`,
        "xz-knowledge-review-impact",
      );
      addReviewSection(
        this.contentEl,
        "你需要做什么",
        this.confirmation.reviewKind === "major"
          ? "核对候选主张、适用时间和是否会替换旧知识；正确就确认写入，不正确就选择不保存这条。"
          : "确认这项内容是否值得后续持续调用；值得保留就确认写入，否则选择不保存这条。",
      );
    } else if (this.clarification) {
      addReviewSection(
        this.contentEl,
        "你需要做什么",
        firstText(this.clarification.question, "回答下方所列的具体缺失信息；系统不会要求你补全未说明的内容。"),
        "xz-knowledge-review-impact",
      );
    } else if (this.decision.decision === "confirm") {
      addReviewSection(
        this.contentEl,
        "当前为什么不能直接操作",
        "这是一条旧版或已失效的等待记录，没有保留下可校验的写入事务。系统不会用不完整数据补写；请查看整理报告，并在需要时通过主动归档重新生成候选。",
        "xz-knowledge-review-warning",
      );
    } else {
      addReviewSection(this.contentEl, "你需要做什么", "当前无需操作；系统会继续累计独立证据，达到门槛后再提供明确处理选项。", "xz-knowledge-review-impact");
    }
    addRelatedNote(this.contentEl, this.relatedPath, this.onOpenPath);
    const actions = this.contentEl.createDiv({ cls: "modal-button-container xz-knowledge-review-actions" });
    if (this.reportPath) {
      const report = actions.createEl("button", { text: "查看后台处理记录（可选）", attr: { type: "button" } });
      report.disabled = typeof this.onOpenPath !== "function";
      report.addEventListener("click", () => this.onOpenPath?.(this.reportPath));
    }
    if (this.clarification && typeof this.onClarify === "function") {
      const clarify = actions.createEl("button", {
        cls: "mod-cta",
        text: `补充：${clarificationFieldLabel(this.clarification)}`,
        attr: { type: "button" },
      });
      clarify.addEventListener("click", () => {
        this.close();
        this.onClarify();
      });
    }
    if (this.confirmation && typeof this.onDecision === "function") {
      const decline = actions.createEl("button", { text: "不保存这条", attr: { type: "button" } });
      const accept = actions.createEl("button", { cls: "mod-cta", text: "确认写入", attr: { type: "button" } });
      const settle = async (decision) => {
        actions.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        try {
          await this.onDecision(decision);
          this.close();
        } catch (error) {
          actions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
          addReviewSection(
            this.contentEl,
            "处理失败",
            firstText(error?.message, error, "确认记录可能已经失效，请重新生成整理候选。"),
            "xz-knowledge-review-warning",
          );
        }
      };
      decline.addEventListener("click", () => { void settle("decline"); });
      accept.addEventListener("click", () => { void settle("accept"); });
    }
    const close = actions.createEl("button", { text: "稍后处理", attr: { type: "button" } });
    close.addEventListener("click", () => this.close());
    setTimeout(() => close.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class XingzhiClarificationModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.question = options.question || "";
    this.reason = options.reason || "";
    this.candidate = options.candidate || {};
    this.relatedPath = options.relatedPath || "";
    this.initialValue = options.initialValue || "";
    this.options = Array.isArray(options.options)
      ? options.options.filter((item) => item && typeof item === "object"
        && typeof item.value === "string" && item.value.trim()
        && typeof item.label === "string" && item.label.trim()).slice(0, 12)
      : [];
    this.onOpenPath = options.onOpenPath;
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  settle(value) {
    this.resolveValue?.(value);
    this.resolveValue = null;
    this.close();
  }

  onOpen() {
    this.modalEl.addClass("xz-knowledge-review-modal");
    this.titleEl.setText("回答候选所缺问题");
    addReviewSection(this.contentEl, "系统具体需要什么", this.question || "当前候选没有给出具体问题，因此不应要求补充。");
    addReviewSection(this.contentEl, "为什么需要这项信息", this.reason);

    const candidateTitle = firstText(this.candidate.title, this.candidate.key);
    if (candidateTitle) {
      const candidateSection = this.contentEl.createEl("section", {
        cls: "xz-knowledge-review-section xz-knowledge-review-content",
      });
      candidateSection.createEl("h3", { text: "相关知识候选" });
      candidateSection.createEl("strong", { text: candidateTitle });
      candidateSection.createEl("p", {
        text: firstText(this.candidate.content, this.candidate.summary, this.candidate.reason, "暂无正文"),
      });
    }

    addRelatedNote(this.contentEl, this.relatedPath, this.onOpenPath);
    if (this.options.length) {
      const optionSection = this.contentEl.createEl("section", {
        cls: "xz-knowledge-review-section xz-clarification-options",
      });
      optionSection.createEl("h3", { text: "可直接选择" });
      optionSection.createEl("p", {
        cls: "xz-cognitive-muted",
        text: "选择只会把答案带回输入框，不会绕过知识写入审核。",
      });
      const optionList = optionSection.createDiv({ cls: "xz-tag-list" });
      this.options.forEach((option) => {
        const button = optionList.createEl("button", {
          cls: "xz-secondary-button",
          text: option.label,
          attr: { type: "button", title: option.value },
        });
        button.addEventListener("click", () => this.settle(`${option.label}（${option.value}）`));
      });
    }
    const inputSection = this.contentEl.createEl("section", {
      cls: "xz-knowledge-review-section xz-clarification-input-section",
    });
    const fieldLabel = clarificationFieldLabel({ question: this.question });
    const label = inputSection.createEl("label", { text: `填写：${fieldLabel}` });
    const textarea = inputSection.createEl("textarea", {
      cls: "xz-clarification-textarea",
      attr: {
        rows: "7",
        placeholder: `只回答“${fieldLabel}”。内容会先放入输入框，仍由你确认发送。`,
        "aria-label": `填写${fieldLabel}`,
      },
    });
    label.setAttr("for", "xingzhi-clarification-textarea");
    textarea.id = "xingzhi-clarification-textarea";
    textarea.value = this.initialValue;

    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: "填入输入框",
      attr: { type: "button" },
    });
    const syncSubmit = () => { submit.disabled = !textarea.value.trim(); };
    const submitValue = () => {
      const value = textarea.value.trim();
      if (value) this.settle(value);
    };
    textarea.addEventListener("input", syncSubmit);
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      submitValue();
    });
    submit.addEventListener("click", submitValue);
    syncSubmit();
    setTimeout(() => textarea.focus(), 0);
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

module.exports = {
  XingzhiClarificationModal,
  XingzhiKnowledgeDetailModal,
};
