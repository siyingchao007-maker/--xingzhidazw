"use strict";

const { sanitizeErrorMessage } = require("./operation-events.cjs");
const {
  archiveDraftSourceChanges,
  canDiscardArchiveDraft,
  normalizeArchiveDraft,
} = require("./archive-review.cjs");

const ACTIONS = Object.freeze({
  "source-review": Object.freeze({
    status: "source-review",
    label: "等待选择归档内容",
    detail: "先选择并查看原始对话；此阶段尚未整理知识，也不会显示确认写入。",
    action: "review",
    actionLabel: "选择并查看原始对话",
    disabled: false,
  }),
  "preparing-preview": Object.freeze({
    status: "preparing-preview",
    label: "正在生成归档预览",
    detail: "正在整理摘要和知识候选；此阶段不会写入正式知识，也不会隐藏对话。",
    action: "wait",
    actionLabel: "生成中",
    disabled: true,
  }),
  organizing: Object.freeze({
    status: "preparing-preview",
    label: "正在生成归档预览",
    detail: "正在整理摘要和知识候选；此阶段不会写入正式知识，也不会隐藏对话。",
    action: "wait",
    actionLabel: "生成中",
    disabled: true,
  }),
  "preview-ready": Object.freeze({
    status: "preview-ready",
    label: "归档内容等待审核",
    detail: "预览已经生成。请检查完整内容、来源和保存位置，再确认写入。",
    action: "review",
    actionLabel: "查看归档内容",
    disabled: false,
  }),
  "needs-input": Object.freeze({
    status: "needs-input",
    label: "归档内容需要补充",
    detail: "预览中仍有需要澄清或排除的知识点。",
    action: "review",
    actionLabel: "查看并处理",
    disabled: false,
  }),
  "content-confirmed": Object.freeze({
    status: "content-confirmed",
    label: "归档内容已经确认",
    detail: "知识写入结果已保存。请查看实际结果，然后进行最终确认。",
    action: "review",
    actionLabel: "查看并最终确认",
    disabled: false,
  }),
  stale: Object.freeze({
    status: "stale",
    label: "归档预览已过期",
    detail: "对话内容已经变化，旧预览不能继续确认。",
    action: "review",
    actionLabel: "查看并重新生成",
    disabled: false,
  }),
  archived: Object.freeze({
    status: "archived",
    label: "已归档",
    detail: "对话已经完成内容审核和最终归档。",
    action: "restore",
    actionLabel: "恢复对话",
    disabled: false,
  }),
});

function safeDetail(value, fallback) {
  const sanitized = sanitizeErrorMessage(value)?.replace(/[\r\n]+/gu, " ").slice(0, 300);
  return sanitized || fallback;
}

function withSafeDiscard(action, conversation) {
  const draft = normalizeArchiveDraft(conversation.archiveDraft);
  if (!draft || !canDiscardArchiveDraft(draft)) return action;
  return {
    ...action,
    draftId: draft.id,
    secondaryAction: "discard",
    secondaryActionLabel: "放弃草稿",
  };
}

function archiveRecoveryAction(conversation = {}) {
  if (conversation.archivedAt || conversation.archiveStatus === "archived") return { ...ACTIONS.archived };
  const sourceChanges = archiveDraftSourceChanges(conversation, conversation.archiveDraft);
  if (conversation.archiveStatus !== "failed"
    && sourceChanges.state !== "invalid"
    && sourceChanges.state !== "stale"
    && sourceChanges.addedCount > 0) {
    return withSafeDiscard({
      status: "new-messages",
      label: `有 ${sourceChanges.addedCount} 条新消息未包含`,
      detail: "原归档草稿仍然有效；可以继续原归档，或在审核页重新整理全部对话。",
      action: "review",
      actionLabel: "继续原归档",
      disabled: false,
    }, conversation);
  }
  if (conversation.archiveStatus === "failed") {
    const hasDraft = Boolean(conversation.archiveDraft);
    return withSafeDiscard({
      status: "failed",
      label: "归档操作未完成",
      detail: safeDetail(
        conversation.archiveError,
        hasDraft ? "归档草稿仍然保留，可以查看后重新尝试。" : "旧版预览无法恢复，请重新生成。",
      ),
      action: hasDraft ? "review" : "retry",
      actionLabel: hasDraft ? "查看归档内容" : "重新生成预览",
      disabled: false,
    }, conversation);
  }
  if (new Set(["pending-confirmation", "pending-review"]).has(conversation.archiveStatus)) {
    return {
      status: "failed",
      label: "旧版归档预览需要更新",
      detail: "旧版预览没有完整持久化，不能安全继续，请重新生成归档预览。",
      action: "retry",
      actionLabel: "重新生成预览",
      disabled: false,
    };
  }
  const effectiveStatus = conversation.archiveStatus === "stale"
    && sourceChanges.state !== "invalid"
    && sourceChanges.state !== "stale"
    ? sourceChanges.state
    : conversation.archiveStatus;
  const known = ACTIONS[effectiveStatus];
  if (known) {
    return withSafeDiscard({
      ...known,
      detail: effectiveStatus === conversation.archiveStatus
        ? safeDetail(conversation.archiveError, known.detail)
        : known.detail,
    }, conversation);
  }
  return {
    status: "idle",
    label: "未归档",
    detail: "先生成可检查的归档预览；最终确认前对话不会消失。",
    action: "archive",
    actionLabel: "预览并归档",
    disabled: false,
  };
}

module.exports = { archiveRecoveryAction };
