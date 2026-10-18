"use strict";

const { Modal, Notice, setIcon } = require("obsidian");

const BLOCK_TYPE_LABELS = Object.freeze({
  "heading-section": "标题章节",
  paragraph: "普通段落",
  list: "列表",
  table: "表格",
  quote: "引用",
  code: "代码块",
  separator: "分隔线",
});

function preview(value, maximum = 150) {
  const text = String(value || "").trim().replace(/\s+/gu, " ");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function selectionBytes(blocks, selected) {
  return blocks.filter((block) => selected.has(block.id))
    .reduce((total, block) => total + String(block.content || "").length, 0);
}

class XingzhiBlockDeleteConfirmationModal extends Modal {
  constructor(app, blocks, options = {}) {
    super(app);
    this.blocks = blocks;
    this.wholeMessage = options.wholeMessage === true;
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  onOpen() {
    this.modalEl.addClass("xz-message-block-delete-confirmation");
    this.titleEl.setText(this.wholeMessage
      ? "二次确认：删除整条消息内容"
      : "二次确认：删除所选段落");
    this.contentEl.createEl("p", {
      text: this.wholeMessage
        ? `将删除当前消息的全部 ${this.blocks.length} 个段落。原文会从对话记录和后续模型上下文中移除，但会保留一条本地恢复记录；已写入知识库的笔记不会被删除。`
        : `将从当前对话消息中删除 ${this.blocks.length} 个段落。已写入知识库的笔记不会被删除，并会保留可恢复记录。`,
    });
    const list = this.contentEl.createEl("ul", { cls: "xz-message-block-delete-preview" });
    this.blocks.slice(0, 8).forEach((block) => list.createEl("li", {
      text: preview(block.content, 120) || block.label,
    }));
    if (this.blocks.length > 8) list.createEl("li", { text: `另有 ${this.blocks.length - 8} 个段落` });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-warning",
      text: this.wholeMessage ? "确认删除整条消息内容" : "确认删除并保留恢复记录",
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => {
      this.resolveValue?.(true);
      this.resolveValue = null;
      this.close();
    });
    setTimeout(() => cancel.focus(), 0);
  }

  onClose() {
    this.resolveValue?.(false);
    this.resolveValue = null;
    this.contentEl.empty();
  }

  waitForConfirmation() {
    this.open();
    return this.promise;
  }
}

class XingzhiMessageBlocksModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.plugin = options.plugin;
    this.conversationId = String(options.conversationId || "");
    this.messageId = String(options.messageId || "");
    this.selected = new Set();
    this.snapshot = null;
    this.busy = false;
  }

  onOpen() {
    this.modalEl.addClass("xz-message-blocks-modal");
    this.titleEl.setText("段落管理");
    this.reload();
  }

  onClose() {
    this.contentEl.empty();
  }

  reload() {
    try {
      this.snapshot = this.plugin?.getMessageBlocks?.(this.conversationId, this.messageId);
      if (!this.snapshot) throw new Error("无法读取消息段落");
      const available = new Set(this.snapshot.blocks.map((block) => block.id));
      this.selected = new Set([...this.selected].filter((id) => available.has(id)));
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        cls: "xz-message-block-error",
        text: `无法打开段落管理：${error?.message || error}`,
      });
    }
  }

  render() {
    const snapshot = this.snapshot;
    const blocks = snapshot?.blocks || [];
    this.contentEl.empty();
    const intro = this.contentEl.createDiv({ cls: "xz-message-block-intro" });
    intro.createEl("p", {
      text: snapshot.contentDeleted
        ? "这条消息的正文已经删除。恢复操作会把删除前的原文放回原位置。"
        : "勾选需要处理的内容。归档只会使用所选段落生成知识卡；删除只修改当前消息，并保留恢复记录。",
    });
    const stats = intro.createDiv({ cls: "xz-message-block-stats" });
    stats.createSpan({ text: `${blocks.length} 个内容卡片` });
    stats.createSpan({ text: `已选 ${this.selected.size} 个` });
    stats.createSpan({ text: `${selectionBytes(blocks, this.selected)} 个字符` });

    if (snapshot.contentDeleted) {
      const empty = this.contentEl.createDiv({
        cls: "xz-message-block-deleted-state",
        attr: { role: "status" },
      });
      empty.createEl("strong", { text: "整条消息内容已删除" });
      empty.createEl("p", {
        text: snapshot.canRestore
          ? "原文不会继续进入后续对话上下文。你可以恢复最近一次删除。"
          : "当前没有可用的恢复记录。",
      });
      const deletedActions = this.contentEl.createDiv({ cls: "xz-message-block-actions" });
      if (snapshot.canRestore) {
        const restore = deletedActions.createEl("button", {
          cls: "mod-cta",
          text: `恢复整条消息内容${snapshot.trashCount > 1 ? `（${snapshot.trashCount} 次记录）` : ""}`,
          attr: { type: "button" },
        });
        restore.disabled = this.busy;
        restore.addEventListener("click", () => this.run(async () => {
          await this.plugin.restoreMessageBlockDeletion(this.conversationId, this.messageId);
          this.selected.clear();
          this.reload();
        }, "整条消息内容已恢复"));
      }
      return;
    }

    const toolbar = this.contentEl.createDiv({ cls: "xz-message-block-toolbar" });
    const selectAll = toolbar.createEl("button", {
      cls: "xz-secondary-button",
      text: "全选可选项",
      attr: { type: "button" },
    });
    selectAll.disabled = this.busy || this.selected.size === blocks.length;
    selectAll.addEventListener("click", () => {
      this.selected = new Set(blocks.map((block) => block.id));
      this.render();
    });
    const clear = toolbar.createEl("button", {
      cls: "xz-secondary-button",
      text: "取消选择",
      attr: { type: "button" },
    });
    clear.disabled = this.busy || this.selected.size === 0;
    clear.addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });

    const list = this.contentEl.createDiv({ cls: "xz-message-block-list" });
    blocks.forEach((block) => {
      const card = list.createEl("details", { cls: "xz-message-block-card" });
      if (this.selected.has(block.id)) card.addClass("is-selected");
      const summary = card.createEl("summary", { cls: "xz-message-block-summary" });
      const choice = summary.createEl("input", {
        attr: {
          type: "checkbox",
          "aria-label": `选择段落：${block.label}`,
        },
      });
      choice.checked = this.selected.has(block.id);
      choice.disabled = this.busy;
      choice.addEventListener("click", (event) => event.stopPropagation());
      choice.addEventListener("change", () => {
        if (choice.checked) this.selected.add(block.id);
        else this.selected.delete(block.id);
        this.render();
      });
      const heading = summary.createDiv({ cls: "xz-message-block-heading" });
      const top = heading.createDiv({ cls: "xz-message-block-title-row" });
      top.createEl("strong", { text: block.label });
      top.createSpan({
        cls: "xz-message-block-type",
        text: BLOCK_TYPE_LABELS[block.type] || "内容块",
      });
      if (block.archived) top.createSpan({ cls: "xz-message-block-archived", text: "已归档" });
      heading.createEl("p", { text: preview(block.content) });
      const glyph = summary.createSpan({ cls: "xz-message-block-expand", attr: { "aria-hidden": "true" } });
      setIcon(glyph, "chevron-down");
      card.createEl("pre", { cls: "xz-message-block-content", text: block.content.trim() });
    });

    const actions = this.contentEl.createDiv({ cls: "xz-message-block-actions" });
    if (snapshot.canRestore) {
      const restore = actions.createEl("button", {
        cls: "xz-secondary-button",
        text: `恢复最近删除${snapshot.trashCount > 1 ? `（${snapshot.trashCount} 次）` : ""}`,
        attr: { type: "button" },
      });
      restore.disabled = this.busy;
      restore.addEventListener("click", () => this.run(async () => {
        await this.plugin.restoreMessageBlockDeletion(this.conversationId, this.messageId);
        this.selected.clear();
        this.reload();
      }, "最近删除的段落已恢复"));
    }
    const remove = actions.createEl("button", {
      cls: "mod-warning",
      text: this.selected.size > 0 && this.selected.size === blocks.length
        ? "删除整条消息内容"
        : "删除所选段落",
      attr: { type: "button" },
    });
    remove.disabled = this.busy || this.selected.size === 0;
    remove.setAttr("title", "删除前会二次确认，并保留恢复记录");
    remove.addEventListener("click", async () => {
      const selectedBlocks = blocks.filter((block) => this.selected.has(block.id));
      const wholeMessage = selectedBlocks.length === blocks.length;
      const confirmed = await new XingzhiBlockDeleteConfirmationModal(this.app, selectedBlocks, { wholeMessage })
        .waitForConfirmation();
      if (!confirmed) return;
      await this.run(async () => {
        await this.plugin.deleteMessageBlocks(this.conversationId, this.messageId, [...this.selected]);
        this.selected.clear();
        this.reload();
      }, wholeMessage ? "整条消息内容已删除，可在本界面恢复" : "所选段落已删除，可在本界面恢复");
    });
    const archive = actions.createEl("button", {
      cls: "mod-cta",
      text: "生成所选段落知识卡",
      attr: { type: "button" },
    });
    archive.disabled = this.busy || this.selected.size === 0;
    archive.addEventListener("click", () => this.run(async () => {
      await this.plugin.prepareMessageBlockArchive(this.conversationId, this.messageId, [...this.selected]);
      this.close();
      await this.plugin.openArchiveReview(this.conversationId);
    }, "所选段落已整理为知识卡，请逐卡审核后再写入"));
  }

  async run(action, successMessage) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await action();
      new Notice(successMessage);
    } catch (error) {
      new Notice(`段落操作未完成：${error?.message || error}`);
    } finally {
      this.busy = false;
      if (this.contentEl?.isConnected && this.snapshot) this.render();
    }
  }
}

module.exports = {
  XingzhiBlockDeleteConfirmationModal,
  XingzhiMessageBlocksModal,
};
