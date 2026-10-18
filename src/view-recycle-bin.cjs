"use strict";

const { Notice, setIcon } = require("obsidian");

const RECYCLE_BIN_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function formatDeletedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function buildRecycleBinBulkDeletePlan(conversations) {
  const ids = [];
  const seen = new Set();
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const id = String(conversation?.id || "");
    const deletedAt = Date.parse(conversation?.deletedAt || "");
    if (!RECYCLE_BIN_CONVERSATION_ID_PATTERN.test(id) || !Number.isFinite(deletedAt) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const count = ids.length;
  return {
    ids,
    count,
    confirmLabel: `全部永久删除（${count}）`,
    message: `确定继续吗？这将只删除当前回收站中的 ${count} 个对话及其原始对话 Markdown，操作完成后不可恢复；正式知识库不会被连带删除。`,
  };
}

class RecycleBinPanel {
  constructor(options) {
    this.plugin = options.plugin;
    this.onClose = options.onClose;
    this.onRestored = options.onRestored;
    this.onPermanentlyDeleted = options.onPermanentlyDeleted;
    this.confirm = options.confirm;
    this.opened = false;

    this.scrim = options.root.createDiv({ cls: "xz-maintenance-scrim", attr: { hidden: "" } });
    this.scrim.addEventListener("click", () => this.close());
    this.drawer = options.root.createEl("aside", {
      cls: "xz-maintenance-drawer xz-recycle-bin",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-recycle-bin-title",
      },
    });
    const header = this.drawer.createDiv({ cls: "xz-maintenance-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "可恢复，也可彻底清除" });
    heading.createEl("h2", { text: "删除对话回收站", attr: { id: "xz-recycle-bin-title" } });
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭回收站", "aria-label": "关闭回收站" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());
    this.body = this.drawer.createDiv({ cls: "xz-maintenance-body" });
  }

  open() {
    this.opened = true;
    this.render();
    this.scrim.removeAttribute("hidden");
    this.drawer.removeAttribute("hidden");
    this.closeButton.focus();
  }

  close() {
    const wasOpen = this.opened;
    this.opened = false;
    this.scrim.setAttr("hidden", "");
    this.drawer.setAttr("hidden", "");
    if (wasOpen) this.onClose?.();
  }

  render() {
    if (!this.opened) return;
    this.body.empty();
    const intro = this.body.createEl("section", { cls: "xz-maintenance-intro" });
    intro.createEl("p", { text: "删除对话仍保存在本地，可按原编号恢复。永久删除会清除对话内容和对应的原始对话 Markdown，且不可恢复；已经写入正式知识库的知识不会被连带删除。" });
    const conversations = typeof this.plugin?.listDeletedConversations === "function"
      ? this.plugin.listDeletedConversations()
      : [];
    if (!conversations.length) {
      this.body.createEl("p", { cls: "xz-maintenance-empty", text: "回收站为空。" });
      return;
    }

    const plan = buildRecycleBinBulkDeletePlan(conversations);
    const bulkActions = this.body.createDiv({ cls: "xz-recycle-bulk-actions" });
    bulkActions.createEl("span", { text: `回收站中共有 ${plan.count} 个对话` });
    const bulkDelete = bulkActions.createEl("button", {
      cls: "xz-secondary-button xz-recycle-bulk-delete",
      text: plan.confirmLabel,
      attr: { type: "button" },
    });
    bulkDelete.disabled = plan.count === 0
      || typeof this.plugin?.permanentlyDeleteConversation !== "function"
      || typeof this.confirm !== "function";
    bulkDelete.addEventListener("click", async () => {
      const confirmed = await this.confirm?.({
        title: "全部永久删除",
        message: plan.message,
        confirmLabel: "确认全部永久删除",
      });
      if (!confirmed) return;
      bulkDelete.disabled = true;
      bulkDelete.setText("正在永久删除…");
      const deletedIds = [];
      const failures = [];
      for (const conversationId of plan.ids) {
        try {
          await this.plugin.permanentlyDeleteConversation(conversationId);
          deletedIds.push(conversationId);
        } catch (error) {
          failures.push({ conversationId, message: error?.message || "未知错误" });
        }
      }
      if (deletedIds.length) this.onPermanentlyDeleted?.(deletedIds);
      if (failures.length) {
        new Notice(`已永久删除 ${deletedIds.length} 个对话，${failures.length} 个未能删除：${failures[0].message}`);
      } else {
        new Notice(`已永久删除回收站中的 ${deletedIds.length} 个对话`);
      }
      this.render();
    });

    const list = this.body.createDiv({ cls: "xz-recycle-list" });
    conversations.forEach((conversation) => {
      const card = list.createEl("section", { cls: "xz-recycle-card" });
      card.createEl("h3", { text: conversation.title || "未命名对话" });
      const details = card.createEl("dl", { cls: "xz-recycle-details" });
      [
        ["删除时间", formatDeletedAt(conversation.deletedAt)],
        ["原提供商", conversation.providerId || "codex"],
        ["原模型", conversation.model || "自动选择"],
        ["消息数量", String(conversation.messageCount || 0)],
      ].forEach(([label, value]) => {
        details.createEl("dt", { text: label });
        details.createEl("dd", { text: value });
      });
      const actions = card.createDiv({ cls: "xz-recycle-actions" });
      const restore = actions.createEl("button", {
        cls: "xz-primary-button xz-recycle-restore",
        text: "恢复对话",
        attr: { type: "button" },
      });
      restore.disabled = typeof this.plugin?.restoreConversation !== "function";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        restore.setText("恢复中…");
        try {
          await this.plugin.restoreConversation(conversation.id);
          new Notice(`已恢复：${conversation.title || "未命名对话"}`);
          this.onRestored?.(conversation.id);
        } catch (error) {
          new Notice(`恢复失败：${error?.message || "未知错误"}`);
          this.render();
        }
      });
      const remove = actions.createEl("button", {
        cls: "xz-secondary-button xz-recycle-permanent",
        text: "永久删除",
        attr: { type: "button" },
      });
      remove.disabled = typeof this.plugin?.permanentlyDeleteConversation !== "function"
        || typeof this.confirm !== "function";
      remove.addEventListener("click", async () => {
        const confirmed = await this.confirm?.({
          title: "永久删除对话",
          message: `确定永久删除“${conversation.title || "未命名对话"}”吗？这会删除工作台中的完整对话和原始记录 ${conversation.transcriptPath || "（原始记录路径不可用）"}，且不可恢复。已经写入 01—09、11 的正式知识不会被删除。`,
          confirmLabel: "永久删除",
        });
        if (!confirmed) return;
        remove.disabled = true;
        remove.setText("删除中…");
        try {
          await this.plugin.permanentlyDeleteConversation(conversation.id);
          new Notice(`已永久删除：${conversation.title || "未命名对话"}`);
          this.onPermanentlyDeleted?.(conversation.id);
          this.render();
        } catch (error) {
          new Notice(`永久删除失败：${error?.message || "未知错误"}`);
          this.render();
        }
      });
    });
  }
}

module.exports = { RecycleBinPanel, buildRecycleBinBulkDeletePlan };
