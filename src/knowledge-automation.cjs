const crypto = require("node:crypto");

const CONVERSATION_PROCESSING_MODES = new Set(["automatic", "record-only"]);
const ORGANIZATION_VERSION = "v0.33.0";
const ORGANIZATION_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "pending-confirmation",
  "pending-review",
  "failed",
  "skipped",
]);
const TERMINAL_ORGANIZATION_STATUSES = new Set([
  "completed", "pending-confirmation", "pending-review", "skipped",
]);
const ACTIVE_ORGANIZATION_STATUSES = new Set(["queued", "running"]);
const MAX_ORGANIZATION_RECORDS = 200;
const MAX_ORGANIZATION_ATTEMPTS = 2;

function boundedText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeErrorText(value) {
  return boundedText(value, 2_000)
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9._-]{6,}/giu, "[REDACTED]")
    .slice(0, 500);
}

function normalizeConversationProcessingMode(value, fallback = "automatic") {
  if (CONVERSATION_PROCESSING_MODES.has(value)) return value;
  return CONVERSATION_PROCESSING_MODES.has(fallback) ? fallback : "automatic";
}

function normalizeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function normalizeSourceHash(value) {
  const text = boundedText(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : "";
}

function normalizeReviewItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = boundedText(value.title, 160);
  const reason = boundedText(value.reason, 500);
  if (!title || !reason) return null;
  return {
    id: boundedText(value.id, 160)
      || `review-${crypto.createHash("sha256").update(`${title}\u0000${reason}`, "utf8").digest("hex").slice(0, 20)}`,
    title,
    reason,
    recommendation: boundedText(value.recommendation, 500) || "核对来源、影响与生效时间后再决定。",
    severity: new Set(["major", "sensitive", "conflict", "uncertain"]).has(value.severity)
      ? value.severity : "uncertain",
    sourceRole: value.sourceRole === "assistant" ? "assistant" : "user",
    candidateId: boundedText(value.candidateId, 200) || null,
    confirmationId: boundedText(value.confirmationId, 200) || null,
    status: new Set(["pending", "accepted", "declined", "resolved"]).has(value.status)
      ? value.status : "pending",
  };
}

function normalizeCandidateEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = boundedText(value.key, 160)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const title = boundedText(value.title, 160);
  const claim = boundedText(value.claim, 2_000);
  if (!key || !title || !claim) return null;
  const sourceMessageIds = [...new Set((Array.isArray(value.sourceMessageIds) ? value.sourceMessageIds : [])
    .map((item) => boundedText(item, 200))
    .filter(Boolean))].slice(-20);
  return {
    key,
    title,
    claim,
    relevance: new Set(["personal", "reusable-knowledge", "product-feedback", "temporary", "unrelated"])
      .has(value.relevance) ? value.relevance : "temporary",
    durability: new Set(["durable", "time-bound", "transient"]).has(value.durability)
      ? value.durability : "transient",
    whyUseful: boundedText(value.whyUseful, 500),
    sourceMessageIds,
    evidenceCount: sourceMessageIds.length,
    status: value.status === "candidate-ready" ? "candidate-ready" : "observing",
  };
}

function sourceHashForTurn(userMessage, assistantMessage) {
  const source = JSON.stringify({
    user: {
      id: boundedText(userMessage?.id, 200),
      content: boundedText(userMessage?.content, 200_000),
    },
    assistant: {
      id: boundedText(assistantMessage?.id, 200),
      content: boundedText(assistantMessage?.content, 200_000),
    },
  });
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function createConversationOrganizationRecord(input = {}) {
  const conversationId = boundedText(input.conversationId, 200);
  const userMessageId = boundedText(input.userMessageId, 200);
  const assistantMessageId = boundedText(input.assistantMessageId, 200);
  const sourceHash = normalizeSourceHash(input.sourceHash);
  const organizationVersion = boundedText(input.organizationVersion, 80);
  if (!conversationId || !userMessageId || !assistantMessageId || !sourceHash || !organizationVersion) return null;
  return {
    conversationId,
    userMessageId,
    assistantMessageId,
    sourceHash,
    organizationVersion,
    mode: normalizeConversationProcessingMode(input.mode),
    status: ORGANIZATION_STATUSES.has(input.status) ? input.status : "queued",
    attempts: Math.max(1, Math.min(MAX_ORGANIZATION_ATTEMPTS, normalizeCount(input.attempts) || 1)),
    written: normalizeCount(input.written),
    pending: normalizeCount(input.pending),
    routinePending: normalizeCount(input.routinePending),
    majorPending: normalizeCount(input.majorPending),
    ignored: normalizeCount(input.ignored),
    reviewItems: (Array.isArray(input.reviewItems) ? input.reviewItems : [])
      .map(normalizeReviewItem)
      .filter(Boolean)
      .slice(0, 20),
    candidateEvidence: (Array.isArray(input.candidateEvidence) ? input.candidateEvidence : [])
      .map(normalizeCandidateEvidence)
      .filter(Boolean)
      .slice(0, 20),
    draftPath: boundedText(input.draftPath, 500) || null,
    startedAt: normalizeTimestamp(input.startedAt),
    processedAt: normalizeTimestamp(input.processedAt),
    error: safeErrorText(input.error) || null,
  };
}

function archiveMessageCoverage(records, conversationId) {
  const normalizedConversationId = boundedText(conversationId, 200);
  const covered = new Set();
  for (const record of normalizeConversationOrganizationRecords(records)) {
    if (record.conversationId !== normalizedConversationId
      || !TERMINAL_ORGANIZATION_STATUSES.has(record.status)) continue;
    covered.add(record.userMessageId);
    covered.add(record.assistantMessageId);
  }
  return covered;
}

function unavailableLegacyPendingReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!new Set(["pending-review", "pending-confirmation"]).has(value.status)) return false;
  if (boundedText(value.organizationVersion, 80) === ORGANIZATION_VERSION) return false;
  const hasStructuredCounts = Object.hasOwn(value, "routinePending") || Object.hasOwn(value, "majorPending");
  const hasReviewItems = Array.isArray(value.reviewItems) && value.reviewItems.length > 0;
  return !hasStructuredCounts && !hasReviewItems;
}

function normalizeConversationOrganizationRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => !unavailableLegacyPendingReview(item))
    .map((item) => createConversationOrganizationRecord(item))
    .filter(Boolean)
    .slice(-MAX_ORGANIZATION_RECORDS);
}

function restoreConversationOrganizationRecords(value) {
  return normalizeConversationOrganizationRecords(value).map((record) => {
    if (!ACTIVE_ORGANIZATION_STATUSES.has(record.status)) return record;
    return createConversationOrganizationRecord({
      ...record,
      status: "failed",
      error: "上次对话整理在完成前中断，可安全重试一次",
    });
  });
}

function isCompletedVisibleMessage(message, role) {
  return Boolean(message)
    && message.role === role
    && message.internal !== true
    && message.status === "completed"
    && Boolean(boundedText(message.id, 200))
    && Boolean(boundedText(message.content, 200_001))
    && boundedText(message.content, 200_001).length <= 200_000;
}

function latestRecordForTurn(records, conversationId, userMessageId, assistantMessageId) {
  return [...normalizeConversationOrganizationRecords(records)].reverse().find((record) => (
    record.conversationId === conversationId
    && record.userMessageId === userMessageId
    && record.assistantMessageId === assistantMessageId
  )) || null;
}

function ineligible(reason, attempt = 0) {
  return { eligible: false, reason, attempt };
}

function shouldScheduleConversationOrganization(input = {}) {
  const mode = normalizeConversationProcessingMode(input.mode);
  if (mode === "record-only") return ineligible("record-only");
  if (input.permissionMode === "read-only") return ineligible("read-only");
  const conversationId = boundedText(input.conversationId, 200);
  const { userMessage, assistantMessage } = input;
  if (!conversationId
    || !isCompletedVisibleMessage(userMessage, "user")
    || !isCompletedVisibleMessage(assistantMessage, "assistant")) {
    return ineligible("ineligible-turn");
  }

  const organizationVersion = boundedText(input.organizationVersion, 80) || ORGANIZATION_VERSION;
  const sourceHash = sourceHashForTurn(userMessage, assistantMessage);
  const prior = latestRecordForTurn(
    input.records,
    conversationId,
    boundedText(userMessage.id, 200),
    boundedText(assistantMessage.id, 200),
  );
  const eligible = (reason, attempt = 1) => ({
    eligible: true,
    reason,
    attempt,
    sourceHash,
    organizationVersion,
  });
  if (!prior) return eligible("eligible");
  if (prior.organizationVersion !== organizationVersion) return eligible("policy-updated");
  if (prior.sourceHash !== sourceHash) return eligible("source-updated");
  if (TERMINAL_ORGANIZATION_STATUSES.has(prior.status) || ACTIVE_ORGANIZATION_STATUSES.has(prior.status)) {
    return ineligible("already-processed", prior.attempts);
  }
  if (prior.status === "failed" && prior.attempts < MAX_ORGANIZATION_ATTEMPTS) {
    return eligible("retry", prior.attempts + 1);
  }
  return ineligible("retry-limit", prior.attempts);
}

module.exports = {
  CONVERSATION_PROCESSING_MODES,
  MAX_ORGANIZATION_ATTEMPTS,
  MAX_ORGANIZATION_RECORDS,
  ORGANIZATION_STATUSES,
  ORGANIZATION_VERSION,
  archiveMessageCoverage,
  createConversationOrganizationRecord,
  normalizeConversationOrganizationRecords,
  normalizeConversationProcessingMode,
  restoreConversationOrganizationRecords,
  shouldScheduleConversationOrganization,
  sourceHashForTurn,
};
