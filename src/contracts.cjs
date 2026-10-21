const crypto = require("node:crypto");
const { normalizeOperationEvents } = require("./operation-events.cjs");
const { deriveKnowledgeCardPresentation } = require("./knowledge-card-presentation.cjs");
const { normalizeKnowledgeUsage } = require("./knowledge-usage.cjs");
const { normalizeEnvironmentCandidate } = require("./environment-policy-engine.cjs");
const { normalizeReasoningProfile } = require("./reasoning-profile.cjs");

const KNOWLEDGE_TYPES = new Set([
  "basic-info",
  "current-state",
  "value-priority",
  "ability-hypothesis",
  "identity-role",
  "behavior-pattern",
  "history",
  "goal",
  "project",
  "decision",
  "action",
  "result",
  "feedback",
  "relationship",
  "environment",
  "cognitive-asset",
  "evidence",
]);
const EPISTEMIC_STATUSES = new Set([
  "fact",
  "user-statement",
  "inference",
  "value-judgment",
  "hypothesis",
  "unknown",
]);
const REVIEW_STATES = new Set([
  "auto-writable",
  "needs-clarification",
  "needs-confirmation",
  "written",
  "rejected",
  "reverted",
]);
const PROVIDER_PROTOCOLS = new Set([
  "codex-app-server",
  "openai-responses",
  "openai-chat-completions",
]);
const PERMISSION_MODES = new Set(["read-only", "confirm-write", "auto-write"]);
const CONVERSATION_PROCESSING_MODES = new Set(["automatic", "record-only"]);

function normalizeFixedSkillPreferenceFields(value) {
  if (value?.skillPreferenceSchemaVersion !== 2) return {};
  const names = (items) => [...new Set((Array.isArray(items) ? items : []).slice(0, 64)
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0 && item.length <= 128))];
  return {
    skillPreferenceSchemaVersion: 2,
    fixedCandidateIds: names(value.fixedCandidateIds),
    fixedInvocationIds: names(value.fixedInvocationIds),
    controlledSkillLoading: value.controlledSkillLoading === true,
  };
}

function normalizeCapabilityStates(value) {
  const result = { agents: {}, skills: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const kind of ["agents", "skills"]) {
    const source = value[kind];
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [id, enabled] of Object.entries(source).slice(0, 128)) {
      if (/^[a-z0-9][a-z0-9-]{1,63}$/u.test(id) && typeof enabled === "boolean") {
        result[kind][id] = enabled;
      }
    }
  }
  return result;
}

function normalizeProviderCompletion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asText = (item, maximum = 200) => typeof item === "string" && item.trim()
    ? item.trim().slice(0, maximum) : null;
  return {
    finishReason: asText(value.finishReason),
    responseStatus: asText(value.responseStatus),
    incompleteReason: asText(value.incompleteReason),
    actualModel: asText(value.actualModel, 300),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function requireText(value, label, maximum = 200_000) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}不能为空`);
  }
  if (value.length > maximum) throw new Error(`${label}超过安全上限`);
  return value.trim();
}

function createConversation({ title, kind = "topic", id = crypto.randomUUID(), createdAt = nowIso() }) {
  if (!new Set(["main", "topic"]).has(kind)) throw new Error("不支持的对话类型");
  return {
    id,
    title: requireText(title, "对话标题", 160),
    kind,
    engine: "codex-app-server",
    providerId: "codex",
    model: null,
    agentMode: "orchestrator",
    agentId: "xingzhi-orchestrator",
    skillMode: "auto",
    selectedSkills: [],
    disabledSkills: [],
    reasoningProfile: null,
    trainingResponseModeActive: false,
    // This controls the deterministic knowledge writer. Codex itself remains read-only
    // during normal conversation; direct execution is a separate, explicit mode.
    permissionMode: "auto-write",
    threadId: null,
    messages: [],
    createdAt,
    updatedAt: createdAt,
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    archiveStatus: null,
    archiveTags: [],
    archiveSummary: null,
    archiveError: null,
    contextArchive: null,
  };
}

function normalizeConversationState(stored = {}) {
  const savedConversations = Array.isArray(stored.conversations)
    ? stored.conversations.filter((item) => item && typeof item.id === "string")
    : [];
  const conversations = savedConversations.length
    ? savedConversations.map((conversation) => ({
        ...conversation,
        ...normalizeFixedSkillPreferenceFields(conversation),
        trainingResponseModeActive: conversation.trainingResponseModeActive === true,
        ...(Array.isArray(conversation.messages) ? {
          messages: conversation.messages.map((message) => {
            const providerCompletion = normalizeProviderCompletion(message?.providerCompletion);
            return providerCompletion ? { ...message, providerCompletion } : message;
          }),
        } : {}),
      }))
    : [createConversation({ title: "主对话", kind: "main" })];
  const requestedPermission = stored.settings?.permissionMode || stored.codexPermission;
  const permissionMode = PERMISSION_MODES.has(requestedPermission)
    ? requestedPermission
    : "auto-write";

  const storedConsents = stored.settings?.externalTransferConsents;
  const externalTransferConsents = {};
  if (storedConsents && typeof storedConsents === "object" && !Array.isArray(storedConsents)) {
    for (const [providerId, storedConsent] of Object.entries(storedConsents)) {
      if (!storedConsent || typeof storedConsent !== "object" || Array.isArray(storedConsent)) continue;
      if (storedConsent.providerId === providerId && storedConsent.scope === "provider"
        && typeof storedConsent.origin === "string" && storedConsent.origin
        && typeof storedConsent.secretRef === "string" && storedConsent.secretRef) {
        externalTransferConsents[providerId] = {
          providerId,
          scope: "provider",
          origin: storedConsent.origin,
          secretRef: storedConsent.secretRef,
        };
        continue;
      }

      // v4 stored one consent per conversation. Keep only well-formed records here;
      // createRuntimeState later promotes an exact provider/origin/secret match.
      const normalizedByConversation = {};
      for (const [conversationId, consent] of Object.entries(storedConsent)) {
        if (!consent || typeof consent !== "object" || Array.isArray(consent)) continue;
        if (consent.providerId !== providerId || consent.conversationId !== conversationId
          || typeof consent.origin !== "string" || !consent.origin
          || typeof consent.secretRef !== "string" || !consent.secretRef) continue;
        normalizedByConversation[conversationId] = { ...consent };
      }
      if (Object.keys(normalizedByConversation).length) {
        externalTransferConsents[providerId] = normalizedByConversation;
      }
    }
  }

  return {
    schemaVersion: 13,
    conversations,
    activeConversationId: stored.activeConversationId || conversations[0].id,
    settings: {
      controlledSkillLoadingDefault: stored.settings?.controlledSkillLoadingDefault === true,
      permissionMode,
      // A default must not overwrite the user's saved opt-out on restart.
      conversationProcessingMode: CONVERSATION_PROCESSING_MODES.has(stored.settings?.conversationProcessingMode)
        ? stored.settings.conversationProcessingMode : "automatic",
      readScope: stored.settings?.readScope || "whole-vault",
      networkAccess: stored.settings?.networkAccess === true,
      showWorkPanel: stored.settings?.showWorkPanel !== false,
      focusMode: stored.settings?.focusMode !== false,
      providerId: stored.settings?.providerId || "codex",
      model: stored.settings?.model || null,
      defaultReasoningProfile: normalizeReasoningProfile(stored.settings?.defaultReasoningProfile),
      agentMode: new Set(["orchestrator", "smart-route", "locked"]).has(stored.settings?.agentMode)
        ? stored.settings.agentMode
        : "orchestrator",
      agentId: stored.settings?.agentId || "xingzhi-orchestrator",
      skillMode: new Set(["auto", "recommend", "manual"]).has(stored.settings?.skillMode)
        ? stored.settings.skillMode
        : "auto",
      selectedSkills: Array.isArray(stored.settings?.selectedSkills)
        ? stored.settings.selectedSkills
        : [],
      disabledSkills: Array.isArray(stored.settings?.disabledSkills)
        ? stored.settings.disabledSkills
        : [],
      ...normalizeFixedSkillPreferenceFields(stored.settings),
      capabilityStates: normalizeCapabilityStates(stored.settings?.capabilityStates),
      externalTransferConsents,
      providerConfigs: stored.settings?.providerConfigs
        && typeof stored.settings.providerConfigs === "object"
        && !Array.isArray(stored.settings.providerConfigs)
        ? { ...stored.settings.providerConfigs }
        : {},
    },
    providers: Array.isArray(stored.providers) ? stored.providers : [],
    workRuns: Array.isArray(stored.workRuns) ? stored.workRuns : [],
    operationEvents: normalizeOperationEvents(stored.operationEvents),
    knowledgeTransactions: Array.isArray(stored.knowledgeTransactions)
      ? stored.knowledgeTransactions
      : [],
    knowledgeIndexTransactions: Array.isArray(stored.knowledgeIndexTransactions)
      ? stored.knowledgeIndexTransactions
      : [],
    knowledgeUsage: normalizeKnowledgeUsage(stored.knowledgeUsage),
    knowledgeRecovery: stored.knowledgeRecovery
      && typeof stored.knowledgeRecovery === "object"
      && !Array.isArray(stored.knowledgeRecovery)
      && typeof stored.knowledgeRecovery.transactionId === "string"
      && typeof stored.knowledgeRecovery.error === "string"
      && typeof stored.knowledgeRecovery.createdAt === "string"
      ? {
        transactionId: stored.knowledgeRecovery.transactionId.slice(0, 200),
        error: stored.knowledgeRecovery.error.slice(0, 1_000),
        createdAt: stored.knowledgeRecovery.createdAt.slice(0, 100),
      }
      : null,
    legacy: {
      candidates: Array.isArray(stored.candidates) ? stored.candidates : [],
      operations: Array.isArray(stored.operations) ? stored.operations : [],
      codexRuns: Array.isArray(stored.codexRuns) ? stored.codexRuns : [],
    },
  };
}

function validateKnowledgeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("知识候选不能为空");
  if (!KNOWLEDGE_TYPES.has(candidate.knowledgeType)) throw new Error("不支持的知识类型");
  if (!EPISTEMIC_STATUSES.has(candidate.epistemicStatus)) throw new Error("不支持的知识状态");
  if (!REVIEW_STATES.has(candidate.reviewState)) throw new Error("不支持的审核状态");
  requireText(candidate.title, "知识标题", 300);
  requireText(candidate.content, "知识内容");
  if (candidate.summary !== undefined || candidate.keyPoints !== undefined || candidate.suggestedUses !== undefined) {
    requireText(candidate.summary, "知识核心总结", 2_000);
    if (!Array.isArray(candidate.keyPoints) || candidate.keyPoints.length < 1 || candidate.keyPoints.length > 5) {
      throw new Error("知识重点必须包含 1 至 5 条提炼结论");
    }
    candidate.keyPoints.forEach((item) => requireText(item, "知识重点", 500));
    if (!Array.isArray(candidate.suggestedUses) || candidate.suggestedUses.length < 1 || candidate.suggestedUses.length > 3) {
      throw new Error("知识用途必须包含 1 至 3 个具体场景");
    }
    candidate.suggestedUses.forEach((item) => requireText(item, "知识用途", 300));
  }
  if (candidate.knowledgeType === "ability-hypothesis" && candidate.epistemicStatus !== "hypothesis") {
    throw new Error("能力判断必须保存为待验证假设");
  }
  if (!candidate.source || typeof candidate.source.conversationId !== "string"
    || typeof candidate.source.messageId !== "string") {
    throw new Error("知识候选必须保留来源对话和消息");
  }
  if (Object.keys(candidate).some((key) => /path$/iu.test(key))) {
    throw new Error("知识候选不能指定文件路径");
  }
  return true;
}

function defaultReviewState(epistemicStatus, knowledgeType = null) {
  if (epistemicStatus === "unknown") return "needs-clarification";
  if (epistemicStatus === "inference" || epistemicStatus === "value-judgment") {
    return "needs-confirmation";
  }
  if (epistemicStatus === "fact") return "needs-confirmation";
  if (knowledgeType === "relationship" || knowledgeType === "environment") return "needs-confirmation";
  return "auto-writable";
}

function createKnowledgeCandidate(input) {
  const presentation = deriveKnowledgeCardPresentation({
    title: input?.title,
    type: input?.knowledgeType,
    content: input?.content,
    summary: input?.summary,
    keyPoints: input?.keyPoints,
    suggestedUses: input?.suggestedUses,
  });
  let candidate = {
    id: crypto.randomUUID(),
    knowledgeType: input.knowledgeType,
    epistemicStatus: input.epistemicStatus,
    title: requireText(input.title, "知识标题", 300),
    key: typeof input.key === "string" ? input.key.trim() : null,
    content: requireText(input.content, "知识内容"),
    summary: presentation.summary,
    keyPoints: [...presentation.keyPoints],
    suggestedUses: [...presentation.suggestedUses],
    effectiveFrom: input.effectiveFrom || null,
    effectiveUntil: input.effectiveUntil || null,
    confidence: input.confidence || null,
    support: Array.isArray(input.support) ? input.support : [],
    counterEvidence: Array.isArray(input.counterEvidence) ? input.counterEvidence : [],
    area: input.area || input.category || null,
    observedAt: input.observedAt || input.observed_at || null,
    reviewAt: input.reviewAt || input.review_at || null,
    freshness: input.freshness || null,
    scope: input.scope || null,
    evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
    relatedProjects: Array.isArray(input.relatedProjects) ? input.relatedProjects : [],
    relatedJudgments: Array.isArray(input.relatedJudgments) ? input.relatedJudgments : [],
    relatedActions: Array.isArray(input.relatedActions) ? input.relatedActions : [],
    source: {
      conversationId: input.source?.conversationId,
      messageId: input.source?.messageId,
      quotedText: input.source?.quotedText || null,
      capturedAt: input.source?.capturedAt || nowIso(),
    },
    sensitivity: typeof input.sensitivity === "string" ? input.sensitivity : "normal",
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    reviewState: input.reviewState || defaultReviewState(input.epistemicStatus, input.knowledgeType),
    createdAt: nowIso(),
  };
  candidate = normalizeEnvironmentCandidate(candidate, { now: candidate.createdAt });
  validateKnowledgeCandidate(candidate);
  return candidate;
}

function createProviderConfig(input) {
  if (input && Object.hasOwn(input, "apiKey")) {
    throw new Error("提供商配置不能接收或保存明文 API Key");
  }
  const id = requireText(input?.id, "提供商编号", 80);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error("提供商编号格式不正确");
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new Error("不支持的提供商协议");
  let baseUrl = null;
  if (input.protocol !== "codex-app-server") {
    try {
      baseUrl = new URL(requireText(input.baseUrl, "API 地址", 2_000));
    } catch {
      throw new Error("API 地址格式不正确");
    }
    if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "localhost") {
      throw new Error("外部 API 必须使用 HTTPS");
    }
  }
  return {
    id,
    name: requireText(input.name, "提供商名称", 100),
    protocol: input.protocol,
    baseUrl: baseUrl ? baseUrl.toString().replace(/\/$/u, "") : null,
    secretRef: input.secretRef ? requireText(input.secretRef, "密钥引用", 500) : null,
    enabled: input.enabled !== false,
    capabilities: input.capabilities || {},
  };
}

module.exports = {
  CONVERSATION_PROCESSING_MODES,
  EPISTEMIC_STATUSES,
  KNOWLEDGE_TYPES,
  PERMISSION_MODES,
  PROVIDER_PROTOCOLS,
  REVIEW_STATES,
  createConversation,
  createKnowledgeCandidate,
  createProviderConfig,
  defaultReviewState,
  normalizeProviderCompletion,
  normalizeConversationState,
  validateKnowledgeCandidate,
};
