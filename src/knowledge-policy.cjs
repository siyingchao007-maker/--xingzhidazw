"use strict";

const POLICY_VERSION = "1.0";

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

const CONTROL_PLANE_TYPES = new Set([
  "agent-config",
  "skill-config",
  "provider-config",
  "model-config",
  "permission-config",
  "system-config",
  "control-plane",
]);

const EPISTEMIC_STATUSES = new Set([
  "fact",
  "user-statement",
  "inference",
  "value-judgment",
  "hypothesis",
  "unknown",
]);

const SENSITIVITIES = new Set([
  "normal",
  "personal",
  "relationship",
  "financial",
  "health",
  "highly-sensitive",
]);

const VERIFIABLE_EVIDENCE_TYPES = new Set([
  "direct-observation",
  "documented",
  "cross-confirmed",
]);

const CLARIFYING_CONFLICTS = new Set([
  "contradiction",
  "ambiguous-entity",
  "source-disagreement",
]);

const SAFE_CONFLICTS = new Set([
  "none",
  "compatible-update",
  "temporal-successor",
]);

const EXTERNAL_CONFIRM_SENSITIVITIES = new Set([
  "relationship",
  "financial",
  "health",
  "highly-sensitive",
]);

const RELATIONSHIP_FACT_ASPECTS = new Set([
  "observed-event",
  "reported-statement",
  "profile",
]);

function safeCandidateId(candidate) {
  try {
    return candidate && typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : null;
  } catch {
    return null;
  }
}

function decision({
  candidateId = null,
  type,
  reasonCode,
  message,
  operation = null,
  undoable = false,
  clarification = null,
  confirmation = null,
}) {
  return {
    policyVersion: POLICY_VERSION,
    candidateId,
    decision: type,
    reasonCode,
    message,
    operation,
    canWrite: type === "auto-commit",
    undoable: type === "auto-commit" && undoable === true,
    clarification,
    confirmation,
  };
}

function reject(candidate, reasonCode, message) {
  return decision({
    candidateId: safeCandidateId(candidate),
    type: "reject",
    reasonCode,
    message,
  });
}

function clarify(candidate, reasonCode, message, question) {
  return decision({
    candidateId: safeCandidateId(candidate),
    type: "clarify",
    reasonCode,
    message,
    clarification: {
      blocking: true,
      question,
    },
  });
}

function confirm(candidate, reasonCode, message, scope = "local-write") {
  return decision({
    candidateId: safeCandidateId(candidate),
    type: "confirm",
    reasonCode,
    message,
    confirmation: {
      scope,
      reason: message,
    },
  });
}

function autoCommit(candidate, operation = "write") {
  return decision({
    candidateId: safeCandidateId(candidate),
    type: "auto-commit",
    reasonCode: "SAFE_LOCAL_WRITE",
    message: operation === "merge-source"
      ? "内容与现有知识一致，可以合并来源并保留撤销记录。"
      : "候选通过知识政策检查，可以本地写入并保留撤销记录。",
    operation,
    undoable: true,
  });
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeToken(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("_", "-")
    : "";
}

function normalizeConflict(value) {
  if (value && typeof value === "object") {
    return normalizeToken(value.type || value.kind || value.action);
  }
  return normalizeToken(value || "none");
}

function containsModelSuppliedPath(value, depth = 0, seen = new WeakSet(), ancestry = []) {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  let entries;
  try {
    entries = Object.entries(value);
  } catch {
    return true;
  }

  for (const [key, child] of entries) {
    const normalizedKey = key.toLowerCase().replace(/[\s_-]/gu, "");
    const isTrustedEvidencePath = normalizedKey === "path"
      && ancestry.some((segment) => new Set([
        "documenthashes",
        "sourcedocumenthashes",
      ]).has(String(segment).toLowerCase().replace(/[\s_-]/gu, "")));
    if (!isTrustedEvidencePath && (normalizedKey === "path"
      || normalizedKey.endsWith("path")
      || normalizedKey.endsWith("路径"))) {
      return true;
    }
    if (containsModelSuppliedPath(child, depth + 1, seen, [...ancestry, key])) return true;
  }
  return false;
}

function hasValidSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  try {
    return hasText(source.conversationId) && hasText(source.messageId);
  } catch {
    return false;
  }
}

function hasVerifiableEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.some((item) => {
    if (!item || typeof item !== "object") return false;
    try {
      const type = normalizeToken(item.type);
      return VERIFIABLE_EVIDENCE_TYPES.has(type) && hasText(item.sourceId);
    } catch {
      return false;
    }
  });
}

function isRelationshipMotive(candidate) {
  if (candidate.knowledgeType !== "relationship") return false;
  const aspect = normalizeToken(
    candidate.relationshipAspect || candidate.aspect || candidate.claimKind,
  );
  if (new Set(["motive", "intent", "motivation", "动机", "意图"]).has(aspect)) return true;

  const claim = `${candidate.title || ""}\n${candidate.content || ""}`.toLowerCase();
  return [
    /故意/gu,
    /有意/gu,
    /刻意/gu,
    /蓄意/gu,
    /动机/gu,
    /意图/gu,
    /想要借此/gu,
    /intentionally/gu,
    /deliberately/gu,
    /on purpose/gu,
    /\bmotive\b/gu,
    /\bintent\b/gu,
  ].some((pattern) => pattern.test(claim));
}

function effectiveSensitivity(candidate, declaredSensitivity) {
  if (declaredSensitivity === "highly-sensitive") return declaredSensitivity;
  if (candidate.knowledgeType === "relationship") return "relationship";
  if (candidate.knowledgeType === "current-state") {
    const area = normalizeToken(candidate.stateArea || candidate.area);
    if (area === "financial") return "financial";
    if (new Set(["physical", "health", "medical", "mental-health"]).has(area)) return "health";
  }
  return declaredSensitivity;
}

function normalizePermissionMode(value) {
  const mode = normalizeToken(value || "auto-write");
  return new Set(["auto-write", "confirm-write", "read-only"]).has(mode)
    ? mode
    : null;
}

function evaluateKnowledgeCandidateUnsafe(candidate, options) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return reject(candidate, "INVALID_CANDIDATE", "模型返回的知识候选不是有效对象。");
  }

  if (containsModelSuppliedPath(candidate)) {
    return reject(
      candidate,
      "MODEL_SUPPLIED_PATH",
      "模型不能指定知识库目标路径；路径必须由后台路由器决定。",
    );
  }

  const knowledgeType = normalizeToken(candidate.knowledgeType);
  if (CONTROL_PLANE_TYPES.has(knowledgeType)) {
    return reject(
      candidate,
      "CONTROL_PLANE_FORBIDDEN",
      "普通对话不能修改智能体、技能、模型、提供商、权限或系统配置。",
    );
  }
  if (!KNOWLEDGE_TYPES.has(knowledgeType)) {
    return reject(candidate, "UNSUPPORTED_KNOWLEDGE_TYPE", "不支持该知识类型。");
  }

  const epistemicStatus = normalizeToken(candidate.epistemicStatus);
  if (!EPISTEMIC_STATUSES.has(epistemicStatus)) {
    return reject(candidate, "UNSUPPORTED_EPISTEMIC_STATUS", "不支持该认识状态。");
  }

  const sensitivity = normalizeToken(candidate.sensitivity || "normal");
  if (!SENSITIVITIES.has(sensitivity)) {
    return reject(candidate, "UNSUPPORTED_SENSITIVITY", "不支持该敏感度等级。");
  }

  if (!hasText(candidate.title) || !hasText(candidate.content)) {
    return reject(candidate, "INVALID_CANDIDATE", "知识标题和内容不能为空。");
  }

  if (!hasValidSource(candidate.source)) {
    return reject(candidate, "MISSING_SOURCE", "知识候选必须保留来源对话和消息。");
  }

  if (knowledgeType === "ability-hypothesis" && epistemicStatus !== "hypothesis") {
    return reject(
      candidate,
      "ABILITY_MUST_BE_HYPOTHESIS",
      "能力判断必须保存为待验证假设，不能保存为事实。",
    );
  }

  if (isRelationshipMotive(candidate) && epistemicStatus === "fact") {
    return reject(
      candidate,
      "RELATIONSHIP_MOTIVE_NOT_FACT",
      "对他人动机或意图的解释不能保存为事实。",
    );
  }

  if (knowledgeType === "relationship" && epistemicStatus === "fact") {
    const relationshipAspect = normalizeToken(
      candidate.relationshipAspect || candidate.aspect || candidate.claimKind,
    );
    if (!RELATIONSHIP_FACT_ASPECTS.has(relationshipAspect)) {
      return reject(
        candidate,
        "RELATIONSHIP_FACT_REQUIRES_OBSERVABLE_ASPECT",
        "关系事实必须明确是可观察事件、可追溯陈述或基础资料。",
      );
    }
  }

  if (epistemicStatus === "fact"
    && (options.trustedEvidence !== true || !hasVerifiableEvidence(candidate.evidence))) {
    return reject(
      candidate,
      "FACT_REQUIRES_TRUSTED_EVIDENCE",
      "事实证据必须由工作台在本地核验；模型自行填写的证据类型或来源编号不能触发自动写入。",
    );
  }

  if (epistemicStatus === "unknown") {
    return clarify(
      candidate,
      "UNKNOWN_REQUIRES_CLARIFICATION",
      "未知内容不能由模型自行补全。",
      `关于“${candidate.title.trim()}”，目前还缺少什么关键信息？`,
    );
  }

  const conflict = normalizeConflict(options.conflict);
  if (conflict === "stale-version") {
    return reject(
      candidate,
      "STALE_VERSION",
      "知识版本已经变化，不能覆盖较新的内容。",
    );
  }
  if (CLARIFYING_CONFLICTS.has(conflict)) {
    return clarify(
      candidate,
      "CONFLICT_REQUIRES_CLARIFICATION",
      "候选与现有知识存在不能自动消解的冲突。",
      options.conflictQuestion || `关于“${candidate.title.trim()}”，这是情况发生了变化，还是不同场景下的说法？`,
    );
  }
  if (conflict === "exact-duplicate") {
    const permissionMode = normalizePermissionMode(options.permissionMode);
    if (!permissionMode) {
      return reject(candidate, "INVALID_PERMISSION_MODE", "不支持该权限模式。");
    }
    if (permissionMode === "read-only") {
      return reject(candidate, "READ_ONLY_MODE", "当前为只读模式，不能合并来源。");
    }
    if (permissionMode === "confirm-write") {
      return confirm(
        candidate,
        "PERMISSION_REQUIRES_CONFIRMATION",
        "当前权限模式要求在合并来源前确认。",
      );
    }
    return autoCommit(candidate, "merge-source");
  }
  if (!SAFE_CONFLICTS.has(conflict)) {
    return reject(candidate, "UNSUPPORTED_CONFLICT", "不支持该冲突状态。");
  }

  const policySensitivity = effectiveSensitivity(candidate, sensitivity);
  if (options.externalTransfer === true
    && EXTERNAL_CONFIRM_SENSITIVITIES.has(policySensitivity)) {
    return reject(
      candidate,
      "SENSITIVE_EXTERNAL_WRITE_BLOCKED",
      "该候选由外部模型生成，敏感知识不会自动进入本地知识库；请改用本机 Codex 对话或手动整理。",
    );
  }

  if (sensitivity === "highly-sensitive") {
    return confirm(
      candidate,
      "HIGH_SENSITIVITY_REQUIRES_CONFIRMATION",
      "高度敏感的知识在本地写入前也必须确认。",
    );
  }

  const permissionMode = normalizePermissionMode(options.permissionMode);
  if (!permissionMode) {
    return reject(candidate, "INVALID_PERMISSION_MODE", "不支持该权限模式。");
  }
  if (permissionMode === "read-only") {
    return reject(candidate, "READ_ONLY_MODE", "当前为只读模式，不能写入知识库。");
  }
  if (permissionMode === "confirm-write") {
    return confirm(
      candidate,
      "PERMISSION_REQUIRES_CONFIRMATION",
      "当前权限模式要求在写入前确认。",
    );
  }

  const reviewReasons = Array.isArray(candidate.reviewReasons)
    ? candidate.reviewReasons.map(normalizeToken)
    : [];
  if (normalizeToken(candidate.reviewState) === "needs-confirmation") {
    const documentFact = reviewReasons.some((reason) => reason.startsWith("document-fact-"));
    return confirm(
      candidate,
      documentFact
        ? "DOCUMENT_FACT_REQUIRES_CONFIRMATION"
        : "CANDIDATE_REQUIRES_CONFIRMATION",
      documentFact
        ? "工作台已核验引用确实来自本次上传文档，但原文不能机械证明整理后的事实结论，需要确认后才能写入。"
        : "这条知识候选被标记为需要确认，不能自动写入。",
    );
  }

  if (new Set(["inference", "value-judgment", "hypothesis"]).has(epistemicStatus)) {
    return confirm(
      candidate,
      "INTERPRETATION_REQUIRES_CONFIRMATION",
      "推断、价值判断和待验证假设必须由用户确认后才能写入。",
    );
  }

  return autoCommit(candidate);
}

function evaluateKnowledgeCandidate(candidate, options = {}) {
  try {
    const safeOptions = options && typeof options === "object" ? options : {};
    return evaluateKnowledgeCandidateUnsafe(candidate, safeOptions);
  } catch {
    return reject(candidate, "INVALID_CANDIDATE", "模型返回的知识候选无法安全读取。");
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function summarize(decisions) {
  const summary = {
    total: decisions.length,
    autoCommit: 0,
    clarify: 0,
    confirm: 0,
    reject: 0,
  };
  for (const item of decisions) {
    if (item.decision === "auto-commit") summary.autoCommit += 1;
    else if (item.decision === "clarify") summary.clarify += 1;
    else if (item.decision === "confirm") summary.confirm += 1;
    else summary.reject += 1;
  }
  return summary;
}

function resolveCandidateOptions(candidate, options) {
  const candidateId = safeCandidateId(candidate);
  let conflict = options.conflict;
  let conflictQuestion = options.conflictQuestion;

  if (candidateId && options.conflicts && typeof options.conflicts === "object") {
    try {
      const perCandidate = options.conflicts[candidateId];
      if (perCandidate !== undefined) {
        conflict = perCandidate;
        if (perCandidate && typeof perCandidate === "object") {
          conflictQuestion = perCandidate.question || conflictQuestion;
        }
      }
    } catch {
      conflict = "invalid";
    }
  }

  return {
    permissionMode: options.permissionMode,
    externalTransfer: options.externalTransfer,
    trustedEvidence: options.trustedEvidenceCandidateIds instanceof Set
      && options.trustedEvidenceCandidateIds.has(candidateId),
    conflict,
    conflictQuestion,
  };
}

function bulkConfirmation(item) {
  return decision({
    candidateId: item.candidateId,
    type: "confirm",
    reasonCode: "BULK_WRITE_REQUIRES_CONFIRMATION",
    message: "本轮自动写入数量超过安全上限，需要整体确认。",
    confirmation: {
      scope: "bulk-local-write",
      reason: "本轮自动写入数量超过安全上限，需要整体确认。",
    },
  });
}

function evaluateKnowledgeBatch(candidates, options = {}) {
  const safeOptions = options && typeof options === "object" ? options : {};
  const input = Array.isArray(candidates) ? candidates : [candidates];
  const hardLimit = positiveInteger(safeOptions.hardLimit, 50);
  const autoCommitLimit = positiveInteger(safeOptions.autoCommitLimit, 5);

  if (input.length > hardLimit) {
    const decisions = input.map((candidate) => reject(
      candidate,
      "BATCH_LIMIT_EXCEEDED",
      "本轮知识候选数量超过硬性安全上限。",
    ));
    return {
      policyVersion: POLICY_VERSION,
      decisions,
      summary: summarize(decisions),
      batchConfirmationRequired: false,
    };
  }

  let decisions = input.map((candidate) => evaluateKnowledgeCandidate(
    candidate,
    resolveCandidateOptions(candidate, safeOptions),
  ));
  const autoCommitCount = decisions.filter((item) => item.decision === "auto-commit").length;
  const batchConfirmationRequired = autoCommitCount > autoCommitLimit;
  if (batchConfirmationRequired) {
    decisions = decisions.map((item) => item.decision === "auto-commit"
      ? bulkConfirmation(item)
      : item);
  }

  return {
    policyVersion: POLICY_VERSION,
    decisions,
    summary: summarize(decisions),
    batchConfirmationRequired,
  };
}

module.exports = {
  POLICY_VERSION,
  evaluateKnowledgeBatch,
  evaluateKnowledgeCandidate,
};
