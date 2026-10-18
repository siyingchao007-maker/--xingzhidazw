"use strict";

const crypto = require("node:crypto");
const { parseMessageBlocks } = require("./message-blocks.cjs");
const { deriveKnowledgeCardPresentation } = require("./knowledge-card-presentation.cjs");
const { isArchivableMessage } = require("./archive-planner.cjs");

const ARCHIVE_DRAFT_VERSION = 1;
const MAX_ARCHIVE_CANDIDATES = 100;
const MAX_ARCHIVE_SOURCES = 10_000;
const MAX_ARCHIVE_WRITES = 100;
const MAX_ARCHIVE_CLARIFICATIONS = 100;
const MAX_ARCHIVE_CANDIDATE_TEXT_LENGTH = 200_000;
const MAX_ARCHIVE_WRITE_TEXT_LENGTH = 200_000;
const MAX_ARCHIVE_QUOTE_LENGTH = 200_000;
const MAX_ARCHIVE_SUMMARY_LENGTH = 4_000;
const MAX_ARCHIVE_SOURCE_LENGTH = 40_000_000;
const MAX_ARCHIVE_TOTAL_SOURCE_LENGTH = 40_000_000;
const MAX_ARCHIVE_ID_LENGTH = 512;
const MAX_ARCHIVE_PATH_LENGTH = 1_024;
const MAX_ARCHIVE_BLOCK_SELECTIONS = 2_000;
const VALID_DRAFT_STATUSES = new Set([
  "source-review",
  "preview-ready",
  "needs-input",
  "content-confirmed",
  "stale",
  "failed",
  "archived",
]);
const EXCLUDED_DECISIONS = new Set(["reject", "deduplicate", "duplicate", "skip", "excluded"]);
const ARCHIVE_CARD_PREVIEW_LENGTH = 900;
const KNOWLEDGE_TYPE_PRESENTATION = Object.freeze({
  "basic-info": ["基本信息", "记录相对稳定的基础信息，便于后续回答在身份与背景上保持一致。"],
  "current-state": ["当前状态", "记录当前阶段的真实状态，后续只应结合记录时间和新的变化使用。"],
  "value-priority": ["价值排序", "记录目标冲突时的取舍标准，便于后续判断和方案比较保持一致。"],
  "ability-hypothesis": ["能力假设", "记录仍需验证的能力判断，后续应结合行动结果更新，不能当作已经证实的事实。"],
  "identity-role": ["身份与角色", "记录当前承担的身份、职责和边界，便于在相关情境中调用。"],
  "behavior-pattern": ["行为模式", "记录跨情境反复出现的行为倾向，后续可用于复盘，但仍需持续检查反例。"],
  history: ["历史经历", "记录已经发生的经历和时间线，作为后续判断与复盘的背景依据。"],
  goal: ["目标", "记录希望达成的方向或阶段目标，便于后续拆解项目、行动和验证结果。"],
  project: ["项目", "记录有明确目标、范围或进度的项目，便于持续跟踪状态、约束和下一步。"],
  decision: ["判断与决策", "记录当时的选择、理由和条件，便于后续检查前提变化并复盘结果。"],
  action: ["行动", "记录已确定或已执行的行动，便于后续追踪完成情况和反馈。"],
  result: ["结果", "记录行动或项目产生的实际结果，便于与预期对照并更新判断。"],
  feedback: ["反馈", "记录外部反馈、偏差和调整信号，便于后续改进行动或决策。"],
  relationship: ["关系", "记录可追溯的关系事实、互动或边界；对人物动机的解释仍需单独验证。"],
  environment: ["环境", "记录会影响选择和行动的外部条件，后续使用时需要检查时效。"],
  "cognitive-asset": ["认知资产", "记录可重复使用的方法、框架或认知结论，便于在相似问题中重新调用。"],
  evidence: ["证据与来源", "保存支持某项判断的原始材料或来源线索，便于追溯和复核。"],
  other: ["其他知识", "记录本次对话中可复用的信息，后续可按标题、正文和来源重新检索。"],
});
const EPISTEMIC_LABELS = Object.freeze({
  fact: "已验证事实",
  "user-statement": "用户自述",
  inference: "推断",
  "value-judgment": "价值判断",
  hypothesis: "待验证假设",
  unknown: "未知或待补充",
});
const ARCHIVE_DECISION_LABELS = Object.freeze({
  confirm: "需要本次确认",
  clarify: "需要补充",
  "auto-commit": "可写入",
  reject: "本次不写入",
  deduplicate: "已存在，不重复写入",
  duplicate: "已存在，不重复写入",
  skip: "本次不写入",
  excluded: "本次不写入",
});
const WRITE_OPERATION_LABELS = Object.freeze({
  create: "新建知识笔记",
  update: "更新现有知识笔记",
  append: "追加到现有知识笔记",
  merge: "合并到现有知识笔记",
  replace: "更新现有知识生命周期",
  overwrite: "覆盖现有知识笔记",
  skip: "不执行写入",
});

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value, maximum, { required = false, label = "文本" } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`归档草稿字段“${label}”不能为空`);
  if (text.length > maximum) {
    throw new Error(`归档草稿字段“${label}”超过安全上限（实际 ${text.length} 字符，上限 ${maximum} 字符）`);
  }
  return text;
}

function boundedArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("归档草稿项目数量超过安全上限");
  return value;
}

function presentationText(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function presentationPreview(value, maximum) {
  const content = presentationText(value);
  return content.length > maximum ? `${content.slice(0, maximum - 1).trimEnd()}…` : content;
}

function presentationList(value, maximum = 12) {
  return Array.isArray(value)
    ? [...new Set(value.map(presentationText).filter(Boolean))].slice(0, maximum)
    : [];
}

function presentationRelations(value) {
  return Array.isArray(value) ? value.slice(0, 12).map((item) => ({
    label: presentationText(item?.label || item?.title),
    relationLabel: presentationText(item?.relationLabel || item?.relation || "关联"),
    path: presentationText(item?.path),
    resolved: item?.resolved === true && Boolean(presentationText(item?.path)),
  })).filter((item) => item.label) : [];
}

function archiveCandidateCard(candidate, {
  decision = {},
  clarification = {},
  write = {},
  tags = [],
} = {}) {
  const knowledgeType = presentationText(candidate?.knowledgeType || candidate?.type || "other").toLowerCase();
  const [typeLabel, purpose] = KNOWLEDGE_TYPE_PRESENTATION[knowledgeType]
    || [knowledgeType || "未分类知识", KNOWLEDGE_TYPE_PRESENTATION.other[1]];
  const epistemicStatus = presentationText(candidate?.epistemicStatus || "unknown").toLowerCase();
  const content = presentationText(candidate?.content);
  const presentation = deriveKnowledgeCardPresentation({
    title: candidate?.title,
    type: knowledgeType,
    content,
    summary: candidate?.summary,
    keyPoints: candidate?.keyPoints,
    suggestedUses: candidate?.suggestedUses,
    tags: candidate?.tags,
  });
  const contentTruncated = content.length > ARCHIVE_CARD_PREVIEW_LENGTH;
  const contentPreview = contentTruncated
    ? `${content.slice(0, ARCHIVE_CARD_PREVIEW_LENGTH - 1).trimEnd()}…`
    : content;
  const policyDecision = presentationText(decision?.decision || candidate?.policyDecision || "confirm").toLowerCase();
  const selected = candidate?.selected !== false;
  const manifest = isObject(write?.manifest) ? write.manifest : {};
  const normalizedTags = presentationList([
    ...presentationList(manifest.tags),
    ...presentationList(candidate?.tags),
    ...presentationList(tags),
  ]);
  const tagPlan = Array.isArray(write?.tagPlan) ? write.tagPlan.slice(0, 24) : [];
  const existingTags = presentationList(tagPlan
    .filter((item) => presentationText(item?.status).toLowerCase() === "existing")
    .map((item) => item?.tag));
  const newTags = presentationList(tagPlan
    .filter((item) => presentationText(item?.status).toLowerCase() === "new")
    .map((item) => item?.tag));
  const classifiedTags = new Set([...existingTags, ...newTags]);
  const unclassifiedTags = normalizedTags.filter((tag) => !classifiedTags.has(tag));
  const aliases = presentationList(manifest.aliases?.length ? manifest.aliases : candidate?.aliases);
  const relations = presentationRelations(
    manifest.relatedKnowledge?.length ? manifest.relatedKnowledge : candidate?.relatedKnowledge,
  );
  const forwardLinks = relations
    .filter((item) => item.resolved)
    .map(({ label, relationLabel, path }) => ({ label, relationLabel, path }));
  const unresolvedLinks = relations
    .filter((item) => !item.resolved)
    .map(({ label, relationLabel }) => ({ label, relationLabel }));
  const sourceConversationPath = presentationText(manifest?.source?.conversationPath);
  const backlinkTargets = presentationList([
    sourceConversationPath,
    ...forwardLinks.map((item) => item.path),
  ]);

  const decisionReason = presentationText(decision?.message || candidate?.evidence)
    || "本次整理未提供单独的判断理由，请以知识正文和来源原文为准。";
  const sourceQuote = presentationText(candidate?.source?.quotedText);
  return {
    title: presentationText(candidate?.title || candidate?.key || "待整理知识"),
    knowledgeType,
    typeLabel,
    purpose,
    epistemicStatus,
    epistemicLabel: EPISTEMIC_LABELS[epistemicStatus] || epistemicStatus || EPISTEMIC_LABELS.unknown,
    content,
    summary: presentation.summary,
    keyPoints: [...presentation.keyPoints],
    suggestedUses: [...presentation.suggestedUses],
    contentPreview: contentPreview || "本次整理没有生成可显示的知识正文，当前项目不应直接确认写入。",
    contentTruncated,
    decisionLabel: selected
      ? (ARCHIVE_DECISION_LABELS[policyDecision] || policyDecision || "待审核")
      : "本次不写入",
    decisionReason,
    decisionReasonPreview: presentationPreview(decisionReason, 420),
    clarificationQuestion: presentationText(clarification?.question),
    sourceMessageId: presentationText(candidate?.source?.messageId),
    sourceQuote,
    sourceQuotePreview: presentationPreview(sourceQuote, 420),
    path: presentationText(write?.path),
    operation: presentationText(write?.operation),
    operationLabel: WRITE_OPERATION_LABELS[presentationText(write?.operation).toLowerCase()]
      || presentationText(write?.operation)
      || "尚未生成写入操作",
    operationReason: presentationText(write?.operation).toLowerCase() === "create"
      ? "当前写入计划是新建知识笔记；只有确认写入后才会创建文件。"
      : "操作方式来自本次冲突检查和写入计划，请结合判断依据与保存位置核对。",
    writeContent: presentationText(write?.content),
    tags: normalizedTags,
    existingTags,
    newTags,
    unclassifiedTags,
    aliases,
    tagReason: tagPlan.length
      ? "“新建标签”表示现有行知知识中未检出；“套用现有标签”表示会复用已经存在的行知标签。"
      : "旧草稿没有保存标签新旧状态；卡片只展示将写入的标签，不猜测它是否已经存在。",
    sourceConversationPath,
    forwardLinks,
    unresolvedLinks,
    backlinkTargets,
    linkReason: backlinkTargets.length
      ? "写入后，新知识会链接到来源对话和已解析的关联知识；这些目标会在 Obsidian 的反向链接中看到本知识。"
      : "本次整理没有生成可验证的知识链接；不会为了填满卡片而虚构双向关系。",
  };
}

function safeTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("归档草稿包含无效时间");
  return date.toISOString();
}

function normalizeRelativeVaultPath(value) {
  const path = boundedString(value, MAX_ARCHIVE_PATH_LENGTH, { required: true }).replace(/\\/gu, "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.split("/").some((part) => part === "..")) {
    throw new Error("归档草稿包含不安全的知识库路径");
  }
  return path.replace(/^\.\//u, "");
}

function visibleArchiveSources(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  if (messages.length > MAX_ARCHIVE_SOURCES) throw new Error("归档来源消息数量超过安全上限");
  const sources = messages
    .filter(isArchivableMessage)
    .map((message) => ({
      messageId: boundedString(message.id, MAX_ARCHIVE_ID_LENGTH, { required: true }),
      role: message.role,
      content: boundedString(message.displayContent || message.content || "", MAX_ARCHIVE_SOURCE_LENGTH),
      createdAt: safeTimestamp(message.createdAt, null),
    }));
  if (sources.reduce((total, source) => total + source.content.length, 0) > MAX_ARCHIVE_TOTAL_SOURCE_LENGTH) {
    throw new Error("归档来源内容超过安全上限");
  }
  return sources;
}

function normalizeBlockSelection(value) {
  if (!isObject(value)) return null;
  const messageId = boundedString(value.messageId, MAX_ARCHIVE_ID_LENGTH, {
    required: true,
    label: "段落归档来源消息编号",
  });
  const blocks = boundedArray(value.blocks || [], MAX_ARCHIVE_BLOCK_SELECTIONS).map((block, index) => ({
    id: boundedString(block?.id, MAX_ARCHIVE_ID_LENGTH, {
      required: true,
      label: `第 ${index + 1} 个段落编号`,
    }),
    fingerprint: boundedString(block?.fingerprint, 64, {
      required: true,
      label: `第 ${index + 1} 个段落指纹`,
    }),
    type: boundedString(block?.type || "paragraph", 64),
    label: boundedString(block?.label || `第 ${index + 1} 段`, 200),
  }));
  if (!blocks.length || blocks.some((block) => !/^[a-f0-9]{64}$/u.test(block.fingerprint))) {
    throw new Error("段落归档选择无效");
  }
  return {
    messageId,
    blocks,
    sourceHash: boundedString(value.sourceHash, 64),
    readOnlyContext: boundedString(value.readOnlyContext, 4_000),
  };
}

function conversationFingerprint(conversation) {
  const payload = visibleArchiveSources(conversation).map((source) => ({
    messageId: source.messageId,
    role: source.role,
    content: source.content,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function recoverableDraftStatus(draft) {
  if (draft.status !== "stale") return draft.status;
  if (draft.confirmedAt || draft.actualWrites.length) return "content-confirmed";
  if (draft.mode === "knowledge"
    && draft.candidates.length === 0
    && draft.plannedWrites.length === 0
    && /^尚未整理/u.test(draft.summary)) {
    return "source-review";
  }
  return calculateCounts(draft).blocked > 0 ? "needs-input" : "preview-ready";
}

function archiveDraftSourceChanges(conversation, draft) {
  const normalized = normalizeArchiveDraft(draft);
  const invalid = {
    state: "invalid",
    addedCount: 0,
    addedSourceIds: [],
    changedSourceIds: [],
    missingSourceIds: [],
  };
  if (!normalized || normalized.conversationId !== conversation?.id) return invalid;
  try {
    const currentSources = visibleArchiveSources(conversation);
    const currentById = new Map(currentSources.map((source) => [source.messageId, source]));
    const draftSourceIds = new Set(normalized.sources.map((source) => source.messageId));
    const addedSourceIds = currentSources
      .filter((source) => !draftSourceIds.has(source.messageId))
      .map((source) => source.messageId);
    const changedSourceIds = [];
    const missingSourceIds = [];

    if (normalized.archiveScope === "message-blocks") {
      const selection = normalized.blockSelection;
      const currentMessage = (Array.isArray(conversation?.messages) ? conversation.messages : [])
        .find((message) => (
          !message?.internal
          && ["user", "assistant"].includes(message?.role)
          && message?.id === selection?.messageId
        ));
      if (!currentMessage) {
        missingSourceIds.push(selection?.messageId || normalized.sources[0]?.messageId || "unknown");
      } else {
        const currentContent = String(currentMessage.displayContent ?? currentMessage.content ?? "");
        const availableFingerprints = new Map();
        for (const block of parseMessageBlocks(currentContent)) {
          availableFingerprints.set(
            block.fingerprint,
            (availableFingerprints.get(block.fingerprint) || 0) + 1,
          );
        }
        for (const selectedBlock of selection.blocks) {
          const remaining = availableFingerprints.get(selectedBlock.fingerprint) || 0;
          if (remaining <= 0) {
            changedSourceIds.push(currentMessage.id);
            break;
          }
          availableFingerprints.set(selectedBlock.fingerprint, remaining - 1);
        }
      }
    } else {
      for (const source of normalized.sources.filter((item) => item.selected !== false)) {
        const current = currentById.get(source.messageId);
        if (!current) {
          missingSourceIds.push(source.messageId);
        } else if (current.role !== source.role || current.content !== source.content) {
          changedSourceIds.push(source.messageId);
        }
      }
    }

    return {
      state: changedSourceIds.length || missingSourceIds.length
        ? "stale"
        : recoverableDraftStatus(normalized),
      addedCount: addedSourceIds.length,
      addedSourceIds,
      changedSourceIds,
      missingSourceIds,
    };
  } catch (_error) {
    return invalid;
  }
}

function normalizeDecision(value) {
  if (!isObject(value)) throw new Error("归档草稿包含无效知识判断");
  return {
    candidateId: boundedString(value.candidateId || value.id, MAX_ARCHIVE_ID_LENGTH, { required: true }),
    decision: boundedString(value.decision || "confirm", 64, { required: true }).toLowerCase(),
    reasonCode: boundedString(value.reasonCode, 128),
    message: boundedString(value.message || value.reason, 2_000),
    operation: boundedString(value.operation, 64),
    conflictAction: boundedString(value.conflictAction, 64),
  };
}

function normalizeCandidate(value, decisionByCandidate, index = 0) {
  if (!isObject(value)) throw new Error("归档草稿包含无效知识候选");
  const id = boundedString(value.id || value.candidateId, MAX_ARCHIVE_ID_LENGTH, { required: true });
  const decisionRecord = decisionByCandidate.get(id) || null;
  const decision = decisionRecord?.decision || boundedString(value.policyDecision || "confirm", 64).toLowerCase();
  const policyState = decision === "clarify"
    ? "needs-input"
    : (EXCLUDED_DECISIONS.has(decision)
      || (decisionRecord?.operation === "merge-source" && decision !== "confirm")) ? "excluded" : "ready";
  const selected = policyState === "excluded"
    ? false
    : typeof value.selected === "boolean" ? value.selected : true;
  const reviewed = typeof value.reviewed === "boolean" ? value.reviewed : policyState !== "needs-input";
  const source = isObject(value.source) ? {
    messageId: boundedString(value.source.messageId, MAX_ARCHIVE_ID_LENGTH, {
      label: `第 ${index + 1} 条知识候选的来源消息编号`,
    }),
    quotedText: boundedString(value.source.quotedText, MAX_ARCHIVE_QUOTE_LENGTH, {
      label: `第 ${index + 1} 条知识候选原文引用`,
    }),
    conversationPath: value.source.conversationPath
      ? normalizeRelativeVaultPath(value.source.conversationPath)
      : "",
  } : { messageId: "", quotedText: "" };
  return {
    id,
    title: boundedString(value.title || "未命名知识", 500, {
      required: true,
      label: `第 ${index + 1} 条知识候选标题`,
    }),
    content: boundedString(value.content, MAX_ARCHIVE_CANDIDATE_TEXT_LENGTH, {
      label: `第 ${index + 1} 条知识候选正文`,
    }),
    summary: boundedString(value.summary, 2_000, {
      label: `第 ${index + 1} 条知识候选核心总结`,
    }),
    keyPoints: boundedArray(value.keyPoints || [], 5)
      .map((item) => boundedString(item, 500))
      .filter(Boolean),
    suggestedUses: boundedArray(value.suggestedUses || [], 3)
      .map((item) => boundedString(item, 300))
      .filter(Boolean),
    knowledgeType: boundedString(value.knowledgeType || value.type || "other", 128),
    epistemicStatus: boundedString(value.epistemicStatus || "unknown", 128),
    sensitivity: boundedString(value.sensitivity || "normal", 64),
    key: boundedString(value.key, 500),
    evidence: boundedString(value.evidence || value.reason, 4_000),
    tags: boundedArray(value.tags || [], 24)
      .map((tag) => boundedString(tag, 128).replace(/^#+/u, ""))
      .filter(Boolean),
    aliases: boundedArray(value.aliases || [], 24)
      .map((alias) => boundedString(alias, 256))
      .filter(Boolean),
    relatedKnowledge: boundedArray(value.relatedKnowledge || [], 24).map((item) => ({
      label: boundedString(item?.label || item?.title, 500, { required: true }),
      relationLabel: boundedString(item?.relationLabel || item?.relation || "关联", 128),
      path: item?.path ? normalizeRelativeVaultPath(item.path) : "",
      resolved: item?.resolved === true && Boolean(item?.path),
    })),
    source,
    policyDecision: decision,
    policyState,
    selected,
    reviewed,
  };
}

function normalizeClarification(value) {
  if (!isObject(value)) throw new Error("归档草稿包含无效澄清项");
  return {
    id: boundedString(value.id, MAX_ARCHIVE_ID_LENGTH, { required: true }),
    candidateId: boundedString(value.candidateId, MAX_ARCHIVE_ID_LENGTH, { required: true }),
    question: boundedString(value.question, 4_000, { required: true }),
    answer: boundedString(value.answer, 10_000),
    resolved: Boolean(value.resolved),
  };
}

function normalizeWrite(value, { actual = false, index = 0 } = {}) {
  if (!isObject(value)) throw new Error("归档草稿包含无效写入计划");
  const normalized = {
    candidateId: boundedString(value.candidateId, MAX_ARCHIVE_ID_LENGTH),
    knowledgeId: boundedString(value.knowledgeId, MAX_ARCHIVE_ID_LENGTH),
    path: normalizeRelativeVaultPath(value.path),
    operation: boundedString(value.operation || (actual ? value.status : "create"), 64, { required: true }),
    title: boundedString(value.title, 500),
  };
  if (actual) {
    normalized.status = boundedString(value.status || "written", 64, { required: true });
    normalized.transactionId = boundedString(value.transactionId, MAX_ARCHIVE_ID_LENGTH);
    normalized.error = boundedString(value.error, 4_000);
  } else {
    normalized.content = boundedString(value.content, MAX_ARCHIVE_WRITE_TEXT_LENGTH, {
      label: `第 ${index + 1} 条计划写入正文`,
    });
    normalized.expectedHash = boundedString(value.expectedHash, 256);
    normalized.tagPlan = boundedArray(value.tagPlan || [], 24).map((item) => ({
      tag: boundedString(item?.tag, 128, { required: true }).replace(/^#+/u, ""),
      status: boundedString(item?.status || "unknown", 32, { required: true }).toLowerCase(),
    }));
    const manifest = isObject(value.manifest) ? value.manifest : {};
    const source = isObject(manifest.source) ? manifest.source : {};
    normalized.manifest = {
      tags: boundedArray(manifest.tags || [], 24)
        .map((tag) => boundedString(tag, 128).replace(/^#+/u, ""))
        .filter(Boolean),
      aliases: boundedArray(manifest.aliases || [], 24)
        .map((alias) => boundedString(alias, 256))
        .filter(Boolean),
      relatedKnowledge: boundedArray(manifest.relatedKnowledge || [], 24).map((item) => ({
        label: boundedString(item?.label || item?.title, 500, { required: true }),
        relationLabel: boundedString(item?.relationLabel || item?.relation || "关联", 128),
        path: item?.path ? normalizeRelativeVaultPath(item.path) : "",
        resolved: item?.resolved === true && Boolean(item?.path),
      })),
      source: {
        conversationPath: source.conversationPath
          ? normalizeRelativeVaultPath(source.conversationPath)
          : "",
        messageId: boundedString(source.messageId, MAX_ARCHIVE_ID_LENGTH),
      },
    };
  }
  return normalized;
}

function calculateCounts(draft) {
  const candidates = Array.isArray(draft?.candidates) ? draft.candidates : [];
  const sources = Array.isArray(draft?.sources) ? draft.sources : [];
  const selected = candidates.filter((candidate) => candidate.selected);
  const blocked = selected.filter((candidate) => candidate.policyState === "needs-input" && !candidate.reviewed);
  return {
    messages: sources.length,
    selectedMessages: sources.filter((source) => source.selected !== false).length,
    candidates: candidates.length,
    selected: selected.length,
    blocked: blocked.length,
    excluded: candidates.length - selected.length,
  };
}

function groupArchiveCandidates(candidates) {
  const groups = {
    selected: [],
    blocking: [],
    restorable: [],
    unavailable: [],
  };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate?.policyState === "excluded") {
      groups.unavailable.push(candidate);
    } else if (candidate?.selected !== true) {
      groups.restorable.push(candidate);
    } else if (candidate?.policyState === "needs-input") {
      groups.blocking.push(candidate);
    } else {
      groups.selected.push(candidate);
    }
  }
  return groups;
}

function resolvedPreviewStatus(draft) {
  if (["source-review", "content-confirmed", "stale", "failed", "archived"].includes(draft.status)) return draft.status;
  return calculateCounts(draft).blocked > 0 ? "needs-input" : "preview-ready";
}

function normalizeArchiveDraft(value, { throwOnError = false } = {}) {
  try {
    if (!isObject(value) || value.version !== ARCHIVE_DRAFT_VERSION) return null;
    const id = boundedString(value.id, MAX_ARCHIVE_ID_LENGTH, { required: true });
    const conversationId = boundedString(value.conversationId, MAX_ARCHIVE_ID_LENGTH, { required: true });
    const fingerprint = boundedString(value.fingerprint, 64, { required: true });
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) return null;
    const mode = value.mode === "transcript-only" ? "transcript-only" : value.mode === "knowledge" ? "knowledge" : null;
    if (!mode || !VALID_DRAFT_STATUSES.has(value.status)) return null;
    const decisions = boundedArray(value.decisions || [], MAX_ARCHIVE_CANDIDATES).map(normalizeDecision);
    const decisionByCandidate = new Map(decisions.map((decision) => [decision.candidateId, decision]));
    const candidates = boundedArray(value.candidates || [], MAX_ARCHIVE_CANDIDATES)
      .map((candidate, index) => normalizeCandidate(candidate, decisionByCandidate, index));
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return null;
    const sources = boundedArray(value.sources || [], MAX_ARCHIVE_SOURCES).map((source) => {
      if (!isObject(source) || !["user", "assistant"].includes(source.role)) {
        throw new Error("归档草稿包含无效来源");
      }
      return {
        messageId: boundedString(source.messageId, MAX_ARCHIVE_ID_LENGTH, {
          required: true,
          label: "归档来源消息编号",
        }),
        role: source.role,
        content: boundedString(source.content, MAX_ARCHIVE_SOURCE_LENGTH),
        createdAt: safeTimestamp(source.createdAt, null),
        selected: source.selected !== false,
      };
    });
    if (sources.reduce((total, source) => total + source.content.length, 0) > MAX_ARCHIVE_TOTAL_SOURCE_LENGTH) return null;
    const clarifications = boundedArray(value.clarifications || [], MAX_ARCHIVE_CLARIFICATIONS)
      .map(normalizeClarification);
    const plannedWrites = boundedArray(value.plannedWrites || [], MAX_ARCHIVE_WRITES)
      .map((write, index) => normalizeWrite(write, { index }));
    const actualWrites = boundedArray(value.actualWrites || [], MAX_ARCHIVE_WRITES)
      .map((write, index) => normalizeWrite(write, { actual: true, index }));
    const tags = boundedArray(value.tags || [], 24)
      .map((tag) => boundedString(tag, 64).replace(/^#+/u, ""))
      .filter(Boolean);
    const normalized = {
      version: ARCHIVE_DRAFT_VERSION,
      id,
      conversationId,
      fingerprint,
      mode,
      archiveScope: value.archiveScope === "message-blocks" ? "message-blocks" : "conversation",
      blockSelection: value.archiveScope === "message-blocks"
        ? normalizeBlockSelection(value.blockSelection)
        : null,
      status: value.status,
      generatedAt: safeTimestamp(value.generatedAt, new Date().toISOString()),
      confirmedAt: safeTimestamp(value.confirmedAt, null),
      summary: boundedString(value.summary, MAX_ARCHIVE_SUMMARY_LENGTH, { label: "归档摘要" }),
      tags: [...new Set(tags)].slice(0, 12),
      candidates,
      decisions,
      clarifications,
      sources,
      plannedWrites,
      actualWrites,
      error: value.error ? boundedString(value.error, 4_000) : null,
    };
    if (normalized.archiveScope === "message-blocks" && !normalized.blockSelection) {
      throw new Error("段落归档草稿缺少选择范围");
    }
    normalized.status = resolvedPreviewStatus(normalized);
    normalized.counts = calculateCounts(normalized);
    return normalized;
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

function createArchiveDraft({
  id,
  conversation,
  mode = "knowledge",
  summary = "",
  tags = [],
  candidates = [],
  decisions = [],
  clarifications = [],
  plannedWrites = [],
  actualWrites = [],
  status = "preview-ready",
  selectedSourceIds = null,
  archiveScope = "conversation",
  blockSelection = null,
  sourceOverrides = null,
  generatedAt = new Date().toISOString(),
}) {
  const conversationId = boundedString(conversation?.id, MAX_ARCHIVE_ID_LENGTH, { required: true });
  const candidateIds = new Set(candidates.map((candidate) => String(candidate?.id || candidate?.candidateId || "")));
  const conversationSources = visibleArchiveSources(conversation);
  const sourceById = new Map(conversationSources.map((source) => [source.messageId, source]));
  let draftSources = conversationSources;
  if (archiveScope === "message-blocks") {
    const overrides = boundedArray(sourceOverrides || [], MAX_ARCHIVE_SOURCES);
    if (!overrides.length) throw new Error("段落归档缺少所选来源");
    draftSources = overrides.map((override) => {
      const original = sourceById.get(String(override?.messageId || ""));
      if (!original || override?.role !== original.role) throw new Error("段落归档来源与原消息不一致");
      return {
        messageId: original.messageId,
        role: original.role,
        content: boundedString(override?.content, MAX_ARCHIVE_SOURCE_LENGTH, {
          required: true,
          label: "所选段落正文",
        }),
        createdAt: original.createdAt,
      };
    });
  }
  const draft = normalizeArchiveDraft({
    version: ARCHIVE_DRAFT_VERSION,
    id: id || `archive-draft-${crypto.randomUUID()}`,
    conversationId,
    fingerprint: conversationFingerprint(conversation),
    mode,
    archiveScope,
    blockSelection,
    status,
    generatedAt,
    confirmedAt: null,
    summary,
    tags,
    candidates,
    decisions: decisions.filter((decision) => candidateIds.has(String(decision?.candidateId || decision?.id || ""))),
    clarifications: clarifications
      .filter((item) => candidateIds.has(String(item?.candidateId || "")))
      .map((item, index) => ({
        ...item,
        id: item?.id || `archive-clarification-${String(item?.candidateId || "unknown")}-${index + 1}`,
      })),
    sources: draftSources.map((source) => ({
      ...source,
      selected: selectedSourceIds instanceof Set
        ? selectedSourceIds.has(source.messageId)
        : Array.isArray(selectedSourceIds)
          ? selectedSourceIds.includes(source.messageId)
          : true,
    })),
    plannedWrites: plannedWrites.filter((write) => !write?.candidateId || candidateIds.has(String(write.candidateId))),
    actualWrites,
    error: null,
  }, { throwOnError: true });
  if (!draft) throw new Error("无法生成安全的归档审核草稿");
  return draft;
}

function createArchiveSourceReview({ id, conversation, generatedAt = new Date().toISOString() }) {
  return createArchiveDraft({
    id,
    conversation,
    mode: "knowledge",
    status: "source-review",
    summary: "尚未整理。请先查看并选择本次要归档的对话内容。",
    generatedAt,
  });
}

function archiveDraftState(conversation, draft) {
  return archiveDraftSourceChanges(conversation, draft).state;
}

function canDiscardArchiveDraft(draft) {
  const normalized = normalizeArchiveDraft(draft);
  return Boolean(
    normalized
    && !new Set(["content-confirmed", "archived"]).has(normalized.status)
    && normalized.actualWrites.length === 0
  );
}

function setCandidateSelection(draft, candidateId, selected) {
  const normalized = normalizeArchiveDraft(draft);
  if (!normalized) throw new Error("归档审核草稿无效，请重新生成预览");
  if (["content-confirmed", "archived"].includes(normalized.status)) {
    throw new Error("归档内容已经确认，不能再修改知识选择");
  }
  const target = normalized.candidates.find((candidate) => candidate.id === candidateId);
  if (!target) throw new Error("找不到要修改的知识候选");
  if (Boolean(selected) && target.policyState === "excluded") {
    throw new Error("系统判定为不可写入的知识候选不能恢复到可选列表");
  }
  target.selected = Boolean(selected);
  target.reviewed = target.selected ? target.policyState !== "needs-input" : true;
  normalized.status = resolvedPreviewStatus(normalized);
  normalized.counts = calculateCounts(normalized);
  return normalized;
}

function setArchiveSourceSelection(draft, messageId, selected) {
  const normalized = normalizeArchiveDraft(draft);
  if (!normalized) throw new Error("归档审核草稿无效，请重新开始归档");
  if (normalized.status !== "source-review") {
    throw new Error("对话来源已经进入整理阶段，不能再修改选择");
  }
  const target = normalized.sources.find((source) => source.messageId === messageId);
  if (!target) throw new Error("找不到要修改的来源消息");
  target.selected = Boolean(selected);
  normalized.counts = calculateCounts(normalized);
  return normalized;
}

function canOrganizeArchiveReview(conversation, draft) {
  const normalized = normalizeArchiveDraft(draft);
  return Boolean(
    normalized
    && normalized.status === "source-review"
    && archiveDraftState(conversation, normalized) === "source-review"
    && calculateCounts(normalized).selectedMessages > 0
  );
}

function canConfirmArchiveContents(conversation, draft) {
  const normalized = normalizeArchiveDraft(draft);
  if (!normalized) return false;
  const state = archiveDraftState(conversation, normalized);
  return state === "preview-ready" && calculateCounts(normalized).blocked === 0;
}

function markArchiveContentConfirmed(conversation, draft, {
  confirmedAt = new Date().toISOString(),
  actualWrites = [],
} = {}) {
  if (!canConfirmArchiveContents(conversation, draft)) {
    throw new Error("归档内容尚未完成审核，不能确认写入");
  }
  const normalized = normalizeArchiveDraft(draft);
  const result = normalizeArchiveDraft({
    ...normalized,
    status: "content-confirmed",
    confirmedAt,
    actualWrites,
    error: null,
  });
  if (!result) throw new Error("无法保存归档内容确认结果");
  return result;
}

function canFinalizeArchive(conversation, draft) {
  const normalized = normalizeArchiveDraft(draft);
  return Boolean(
    normalized
    && normalized.status === "content-confirmed"
    && normalized.conversationId === conversation?.id
    && archiveDraftState(conversation, normalized) === "content-confirmed"
  );
}

module.exports = {
  ARCHIVE_DRAFT_VERSION,
  MAX_ARCHIVE_CANDIDATES,
  MAX_ARCHIVE_SOURCES,
  MAX_ARCHIVE_BLOCK_SELECTIONS,
  archiveCandidateCard,
  archiveDraftSourceChanges,
  archiveDraftState,
  calculateCounts,
  canDiscardArchiveDraft,
  canOrganizeArchiveReview,
  canConfirmArchiveContents,
  canFinalizeArchive,
  conversationFingerprint,
  createArchiveDraft,
  createArchiveSourceReview,
  groupArchiveCandidates,
  markArchiveContentConfirmed,
  normalizeArchiveDraft,
  setArchiveSourceSelection,
  setCandidateSelection,
  visibleArchiveSources,
};
