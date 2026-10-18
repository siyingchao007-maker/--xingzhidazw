"use strict";

const { conversationTranscriptPath } = require("./conversation-store.cjs");

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function countVisibleMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => (
    message
    && message.internal !== true
    && (message.role === "user" || message.role === "assistant")
  )).length;
}

function safeTranscriptPath(conversationId) {
  try {
    return conversationTranscriptPath(conversationId);
  } catch {
    return null;
  }
}

function listDeletedConversations(conversations) {
  if (!Array.isArray(conversations)) return [];
  return conversations
    .map((conversation) => {
      const deletedAt = validTimestamp(conversation?.deletedAt);
      if (!deletedAt || !CONVERSATION_ID_PATTERN.test(String(conversation?.id || ""))) return null;
      return {
        id: String(conversation.id),
        title: typeof conversation.title === "string" && conversation.title.trim()
          ? conversation.title.trim().slice(0, 200)
          : "未命名对话",
        deletedAt,
        providerId: typeof conversation.providerId === "string" ? conversation.providerId : "codex",
        model: typeof conversation.model === "string" && conversation.model.trim() ? conversation.model.trim() : null,
        messageCount: countVisibleMessages(conversation.messages),
        kind: typeof conversation.kind === "string" ? conversation.kind : "topic",
        transcriptPath: safeTranscriptPath(String(conversation.id)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.deletedAt) - Date.parse(left.deletedAt));
}

function permanentlyDeleteConversationRecord(conversations, conversationId) {
  if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
    throw new Error("对话编号无效");
  }
  if (!Array.isArray(conversations)) throw new Error("对话列表无效");
  const index = conversations.findIndex((conversation) => (
    conversation?.id === conversationId && validTimestamp(conversation.deletedAt)
  ));
  if (index < 0) throw new Error("只有回收站中的对话才能永久删除");
  return {
    conversations: conversations.filter((_, itemIndex) => itemIndex !== index),
    conversation: conversations[index],
  };
}

function restoreConversationRecord(conversations, conversationId, options = {}) {
  if (!CONVERSATION_ID_PATTERN.test(String(conversationId || ""))) {
    throw new Error("对话编号无效");
  }
  if (!Array.isArray(conversations)) throw new Error("对话列表无效");

  const index = conversations.findIndex((conversation) => (
    conversation?.id === conversationId && validTimestamp(conversation.deletedAt)
  ));
  if (index < 0) throw new Error("该对话不在回收站中");

  const now = validTimestamp(options.now) || new Date().toISOString();
  const restored = {
    ...conversations[index],
    deletedAt: null,
    archivedAt: null,
    archiveStatus: null,
    archiveError: null,
    updatedAt: now,
  };
  const next = conversations.slice();
  next[index] = restored;
  return { conversations: next, conversation: restored };
}

async function restoreConversationWithPersistence(options = {}) {
  const state = options.state;
  if (!state || !Array.isArray(state.conversations)) throw new Error("对话状态无效");
  const previousConversations = state.conversations;
  const previousActiveConversationId = state.activeConversationId;
  const result = restoreConversationRecord(previousConversations, options.conversationId, { now: options.now });
  state.conversations = result.conversations;
  state.activeConversationId = result.conversation.id;
  options.syncSelection?.(result.conversation);
  options.notify?.();
  try {
    await options.save?.();
    return result.conversation;
  } catch (error) {
    state.conversations = previousConversations;
    state.activeConversationId = previousActiveConversationId;
    const previousActive = previousConversations.find((item) => item?.id === previousActiveConversationId)
      || previousConversations[0];
    options.syncSelection?.(previousActive);
    options.notify?.();
    throw error;
  }
}

module.exports = {
  CONVERSATION_ID_PATTERN,
  countVisibleMessages,
  listDeletedConversations,
  permanentlyDeleteConversationRecord,
  restoreConversationRecord,
  restoreConversationWithPersistence,
};
