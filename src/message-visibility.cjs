const CLIENT_USER_MESSAGE_ID_PATTERN = /^msg-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function messageArray(messages) {
  return Array.isArray(messages) ? messages : [];
}

function visibleConversationMessages(messages) {
  return messageArray(messages).filter((message) => message && message.internal !== true);
}

function acceptedClientUserMessageId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return CLIENT_USER_MESSAGE_ID_PATTERN.test(id) ? id : null;
}

function reconcileOptimisticUserMessage(messages, pending) {
  const visible = visibleConversationMessages(messages);
  if (!pending?.id) return { messages: visible, pending: null };
  if (visible.some((message) => message?.id === pending.id)) {
    return { messages: visible, pending: null };
  }
  return { messages: [...visible, pending], pending };
}

function messageForTurn(messages, assistantMessageId) {
  if (!assistantMessageId) return null;
  return messageArray(messages).find((message) => message?.id === assistantMessageId) || null;
}

function isInternalTurn(messages, assistantMessageId) {
  return messageForTurn(messages, assistantMessageId)?.internal === true;
}

function visibleStreamingMessage(messages, assistantMessageId) {
  const exact = messageForTurn(messages, assistantMessageId);
  if (exact) {
    if (exact.internal === true) return null;
    return exact.role === "assistant" && exact.status === "streaming" ? exact : null;
  }
  return [...visibleConversationMessages(messages)].reverse().find((message) => (
    message?.role === "assistant" && message?.status === "streaming"
  )) || null;
}

module.exports = {
  acceptedClientUserMessageId,
  isInternalTurn,
  reconcileOptimisticUserMessage,
  visibleConversationMessages,
  visibleStreamingMessage,
};
