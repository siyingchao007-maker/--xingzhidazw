"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { normalizeControlledTopics } = require("./entity-knowledge-engine.cjs");
const {
  normalizeEnvironmentCandidate,
  routeEnvironmentSubtype,
  evaluateEnvironmentFreshness,
} = require("./environment-policy-engine.cjs");

const PERSONAL_KEY_ROUTES = Object.freeze([
  [/(?:^|\.)(?:basic_info|profile)(?:\.|$)/u, "01_当前的我/基本信息"],
  [/(?:^|\.)(?:current_state)(?:\.|$)/u, "01_当前的我/当前状态"],
  [/(?:^|\.)(?:value_priority|values)(?:\.|$)/u, "01_当前的我/价值排序"],
  [/(?:^|\.)(?:ability_hypothesis)(?:\.|$)/u, "01_当前的我/能力假设"],
  [/(?:^|\.)(?:identity_role)(?:\.|$)/u, "01_当前的我/身份与角色"],
  [/(?:^|\.)(?:behavior_pattern)(?:\.|$)/u, "01_当前的我/行为模式"],
  [/(?:^|\.)(?:history|experience)(?:\.|$)/u, "02_我的历史/经历"],
  [/(?:^|\.)(?:environment)(?:\.|$)/u, "03_环境/环境信息"],
  [/(?:^|\.)(?:relationship)(?:\.|$)/u, "04_关系/关系记录"],
  [/(?:^|\.)(?:goal)(?:\.|$)/u, "05_目标与项目/阶段目标"],
  [/(?:^|\.)(?:project)(?:\.|$)/u, "05_目标与项目/项目"],
  [/(?:^|\.)(?:decision)(?:\.|$)/u, "06_判断与决策/决策"],
  [/(?:^|\.)(?:action)(?:\.|$)/u, "07_行动/行动项"],
  [/(?:^|\.)(?:result)(?:\.|$)/u, "08_结果与反馈/结果"],
  [/(?:^|\.)(?:feedback)(?:\.|$)/u, "08_结果与反馈/反馈"],
  [/(?:^|\.)(?:evidence)(?:\.|$)/u, "11_证据与来源/证据记录"],
  [/(?:^|\.)(?:method|cost_method|cost_calculation|strategy|framework|mental_model|cognitive_asset)(?:\.|$)/u,
    "09_认知资产/方法"],
]);
const EPISTEMIC_LABELS = Object.freeze({
  fact: "事实",
  "user-statement": "用户自述",
  inference: "推断",
  "value-judgment": "价值判断",
  hypothesis: "假设",
  unknown: "未知",
});
const KNOWLEDGE_TYPE_LABELS = Object.freeze({
  "basic-info": "基本信息",
  "current-state": "当前状态",
  "value-priority": "价值排序",
  "ability-hypothesis": "能力假设",
  "identity-role": "身份角色",
  "behavior-pattern": "行为模式",
  history: "历史",
  goal: "目标",
  project: "项目",
  decision: "判断决策",
  action: "行动",
  result: "结果",
  feedback: "反馈",
  relationship: "关系",
  environment: "环境",
  "cognitive-asset": "认知资产",
  evidence: "证据",
});
const SUPPORTED_DECISIONS = new Set(["create", "merge", "patch", "supersede", "conflict", "ignore"]);

function revisionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, maximum = 200_000) {
  if (value === null || value === undefined) return "";
  const result = String(value).replace(/\u0000/gu, "").trim();
  return [...result].slice(0, maximum).join("");
}

function normalizedKnowledgeKey(value) {
  return text(value, 300).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function assertNoPathFields(value, ancestry = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPathFields(entry, ancestry.concat(index)));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/gu, "").toLowerCase();
    const evidencePath = normalized === "path" && ancestry.some((part) => (
      /^(?:source)?documenthashes$/iu.test(String(part).replace(/[_-]/gu, ""))
    ));
    if (!evidencePath && (normalized === "path" || normalized.endsWith("path"))) {
      throw revisionError("MODEL_PATH_REJECTED", `模型不能指定知识路径：${ancestry.concat(key).join(".")}`);
    }
    assertNoPathFields(child, ancestry.concat(key));
  }
}

function safeSegment(value, fallback, maximum = 100) {
  let result = text(value, maximum * 2)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/\.{2,}/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "");
  result = [...result].slice(0, maximum).join("").replace(/[. ]+$/u, "");
  return result || fallback;
}

function businessDirectory(knowledgeKey) {
  const key = text(knowledgeKey, 300).toLowerCase();
  if (/(?:^|\.)(?:us|usa|us_lines|united_states)(?:\.|$)/u.test(key)) {
    return "12_资料库/业务知识/中航环球/美国线";
  }
  if (/(?:^|\.)(?:eu|europe|eu_lines|europe_lines)(?:\.|$)/u.test(key)) {
    return "12_资料库/业务知识/中航环球/欧洲线";
  }
  if (/(?:^|\.)(?:mexico|mx)(?:\.|$)/u.test(key)) {
    return "12_资料库/业务知识/中航环球/墨西哥线";
  }
  if (/(?:^|\.)(?:uk|britain)(?:\.|$)/u.test(key)) {
    return "12_资料库/业务知识/中航环球/英国线";
  }
  if (/(?:^|\.)(?:canada|ca)(?:\.|$)/u.test(key)) {
    return "12_资料库/业务知识/中航环球/加拿大线";
  }
  if (key.startsWith("business.freight.") || key.includes(".freight.")) {
    return "12_资料库/业务知识/货代/通用规则";
  }
  if (key.startsWith("company.business.")) {
    return "12_资料库/业务知识/中航环球/通用规则";
  }
  return "12_资料库/业务知识/待分类";
}

function personalDirectory(knowledgeKey, candidate = null) {
  if (candidate?.knowledgeType === "environment") {
    const environmentRoute = routeEnvironmentSubtype(candidate.area || candidate.category);
    if (!environmentRoute.known || !environmentRoute.directory) {
      throw revisionError("ENVIRONMENT_SUBTYPE_REQUIRED", "环境知识缺少明确分类，不能生成正式路径");
    }
    return environmentRoute.directory;
  }
  const stableKey = normalizedKnowledgeKey(knowledgeKey).replace(/-/gu, "_");
  const matched = PERSONAL_KEY_ROUTES.find(([pattern]) => pattern.test(stableKey));
  return matched?.[1] || "09_认知资产/知识对象";
}

// [本地增强] 知识记录可读命名：<日期>-<标题>，稳定编号只留在 frontmatter 的 entityId
function xzVaultAbsoluteDir(relativeDir) {
  try {
    const adapter = globalThis.app?.vault?.adapter;
    let base = typeof adapter?.basePath === "string" ? adapter.basePath : "";
    if (!base && typeof adapter?.getBasePath === "function") base = adapter.getBasePath();
    if (!base) return "";
    return nodePath.join(base, ...String(relativeDir).split("/"));
  } catch { return ""; }
}
function xzFileEntityId(absolutePath) {
  try {
    const fd = fs.openSync(absolutePath, "r");
    try {
      const buf = Buffer.alloc(512);
      const read = fs.readSync(fd, buf, 0, 512, 0);
      const head = buf.slice(0, read).toString("utf8");
      const matched = head.match(/^entityId:\s*"?([^"\r\n]+)"?\s*$/mu);
      return matched ? matched[1].trim() : "";
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}
// 截断到上限；拉丁词不要切在半个词上
function xzTrimReadable(value, maximum) {
  if (!value) return "";
  const chars = [...value];
  if (chars.length <= maximum) return value;
  let cut = chars.slice(0, maximum).join("");
  if (/[A-Za-z0-9]$/u.test(cut) && /\s/u.test(cut)) {
    const atSpace = cut.replace(/\s+\S*$/u, "");
    if ([...atSpace].length >= Math.ceil(maximum * 0.5)) cut = atSpace;
  }
  return cut.replace(/[. ]+$/u, "");
}
function xzRecordStem(candidate, fallbackId) {
  const rawTitle = text(candidate && candidate.title, 200).replace(/^联网证据[｜|]\s*/u, "");
  const title = xzTrimReadable(safeSegment(rawTitle, "", 120), 30);
  const stampSource = text((candidate && (candidate.createdAt || candidate.updatedAt)) || "", 40);
  const stamp = /^\d{4}-\d{2}-\d{2}/u.test(stampSource) ? stampSource.slice(0, 10) : "";
  const parts = [stamp, title].filter(Boolean);
  return parts.length ? parts.join("-") : fallbackId;
}
function resolveCanonicalPath({ candidate, entityId }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw revisionError("INVALID_CANDIDATE", "知识候选不能为空");
  }
  assertNoPathFields(candidate);
  const recordClass = text(candidate.recordClass, 80);
  const knowledgeKey = text(candidate.knowledgeKey || candidate.key, 300);
  if (!knowledgeKey) throw revisionError("MISSING_KNOWLEDGE_KEY", "知识候选缺少稳定知识键");
  const safeId = safeSegment(entityId, "knowledge", 64).replace(/\s+/gu, "-");
  const directory = recordClass === "business-reference"
    ? businessDirectory(knowledgeKey)
    : personalDirectory(knowledgeKey, candidate);
  const stem = xzRecordStem(candidate, safeId);
  const absoluteDir = xzVaultAbsoluteDir(directory);
  if (!absoluteDir) return `${directory}/${stem}.md`;
  let name = `${stem}.md`;
  for (let n = 2; n <= 200; n += 1) {
    const full = nodePath.join(absoluteDir, name);
    if (!fs.existsSync(full)) break;
    if (xzFileEntityId(full) === entityId) break;
    name = `${stem}-${n}.md`;
  }
  return `${directory}/${name}`;
}

function uniqueStrings(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values.flat(Infinity)) {
    const normalized = text(value, 2_000);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueObjects(values, identity) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const key = identity(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...value });
  }
  return result;
}

function mergeText(previous, incoming, now) {
  const before = text(previous);
  const next = text(incoming);
  if (!before) return next;
  if (!next || before.includes(next)) return before;
  if (next.includes(before)) return next;
  const day = text(now, 10);
  return `${before}\n\n补充（${day}）：${next}`;
}

function mergeSummary(previous, incoming) {
  const before = text(previous, 20_000);
  const next = text(incoming, 20_000);
  if (!before) return next;
  if (!next || before.includes(next)) return before;
  if (next.includes(before)) return next;
  return `${before} ${next}`;
}

function documentEvidence(candidate) {
  const source = candidate?.source && typeof candidate.source === "object" ? candidate.source : {};
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
  const documents = uniqueStrings(
    source.documents,
    evidence.filter((item) => item?.type === "documented").map((item) => item.sourceId),
  );
  const documentHashes = uniqueObjects(
    Array.isArray(source.documentHashes) ? source.documentHashes : [],
    (item) => `${text(item.path, 1_024)}\u0000${text(item.sha256, 64)}`,
  ).filter((item) => /^[a-f0-9]{64}$/u.test(text(item.sha256, 64)));
  const documentQuotes = uniqueObjects(
    evidence.filter((item) => item?.type === "documented")
      .map((item) => ({
        sourceDocumentPath: text(item.sourceId, 1_024),
        quotedText: text(item.quotedText, 100_000),
      })),
    (item) => `${item.sourceDocumentPath}\u0000${item.quotedText}`,
  ).filter((item) => item.sourceDocumentPath && item.quotedText);
  return { documents, documentHashes, documentQuotes };
}

function buildSystemTags(recordClass, knowledgeType, epistemicStatus) {
  const epistemic = EPISTEMIC_LABELS[epistemicStatus] || text(epistemicStatus, 40) || "未知";
  return recordClass === "business-reference"
    ? ["行知/资料类型/业务资料", `行知/认识状态/${epistemic}`, "行知/状态/有效"]
    : [
        `行知/知识类型/${KNOWLEDGE_TYPE_LABELS[knowledgeType] || text(knowledgeType, 40) || "知识"}`,
        `行知/认识状态/${epistemic}`,
        "行知/状态/有效",
      ];
}

function yaml(name, value) {
  return `${name}: ${JSON.stringify(value)}`;
}

function buildMarkdown(state) {
  const format = state.recordClass === "business-reference" ? "reference-v1" : "knowledge-v1";
  const identityLines = state.recordClass === "business-reference"
    ? [yaml("referenceId", state.entityId), yaml("referenceType", state.referenceType)]
    : [yaml("knowledgeId", state.entityId), yaml("knowledgeType", state.knowledgeType)];
  const metadata = [
    "---",
    yaml("xingzhiFormat", format),
    yaml("entityId", state.entityId),
    ...identityLines,
    yaml("epistemicStatus", state.epistemicStatus),
    yaml("status", "active"),
    ...Object.entries(state.governance || {}).filter(([, value]) => value != null)
      .map(([field, value]) => yaml(field, value)),
    yaml("knowledgeKey", state.knowledgeKey),
    yaml("key", state.knowledgeKey),
    yaml("title", state.title),
    yaml("content", state.content),
    yaml("summary", state.summary),
    yaml("keyPoints", state.keyPoints),
    yaml("suggestedUses", state.suggestedUses),
    yaml("effectiveFrom", state.effectiveFrom || ""),
    yaml("effectiveUntil", state.effectiveUntil || ""),
    ...(state.knowledgeType === "environment" ? [
      yaml("area", state.area || ""),
      yaml("observedAt", state.observedAt || ""),
      yaml("reviewAt", state.reviewAt || ""),
      yaml("freshness", state.freshness || "current"),
      yaml("scope", state.scope || ""),
      yaml("relatedProjects", state.relatedProjects || []),
      yaml("relatedJudgments", state.relatedJudgments || []),
      yaml("relatedActions", state.relatedActions || []),
    ] : []),
    yaml("context", state.context || ""),
    yaml("tags", state.tags),
    yaml("aliases", state.aliases),
    yaml("relatedKnowledge", state.relatedKnowledge),
    yaml("sourceConversationPath", state.source.conversationPath || ""),
    yaml("sourceMessageId", state.source.messageId || ""),
    yaml("sourceQuotedText", state.source.quotedText || ""),
    yaml("sourceDocuments", state.source.documents),
    yaml("sourceDocumentHashes", state.source.documentHashes),
    yaml("sourceEvidence", state.sourceEvidence),
    yaml("evidenceIds", state.evidenceIds),
    yaml("lifecycleSources", state.lifecycleSources),
    yaml("revision", state.revision),
    yaml("revisionId", state.revisionId),
    yaml("previousRevisionId", state.previousRevisionId || ""),
    yaml("canonical", true),
    yaml("canonicalPath", state.canonicalPath),
    yaml("changeType", state.changeType),
    yaml("contentFingerprint", crypto.createHash("sha256").update(state.content, "utf8").digest("hex")),
    yaml("createdAt", state.createdAt),
    yaml("updatedAt", state.updatedAt),
    yaml("版本", state.revision),
    yaml("状态", "active"),
    yaml("知识类型", state.recordClass === "business-reference" ? "业务资料" : state.knowledgeType),
    yaml("认识状态", state.epistemicStatus),
    yaml("标题", state.title),
    yaml("创建时间", state.createdAt),
    yaml("更新时间", state.updatedAt),
    "---",
  ];
  const sections = [
    `# ${state.title}`,
    "",
    "## 核心总结",
    "",
    state.summary,
    "",
    "## 核心知识点",
    "",
    ...(state.keyPoints.length ? state.keyPoints.map((item) => `- ${item}`) : ["- 暂无单独提炼项"]),
    "",
    "## 可应用于",
    "",
    ...(state.suggestedUses.length ? state.suggestedUses.map((item) => `- ${item}`) : ["- 后续相关判断与行动"]),
    "",
    "## 完整知识内容",
    "",
    state.content,
    ...(state.knowledgeType === "environment" ? [
      "",
      "## 环境状态",
      "",
      `- 分类：${state.area || "待确认"}`,
      `- 时效：${state.freshness || "current"}`,
      `- 观察时间：${state.observedAt || "未记录"}`,
      `- 复核时间：${state.reviewAt || "未设置"}`,
      `- 适用范围：${state.scope || "未说明"}`,
      `- 关联项目：${state.relatedProjects.length ? state.relatedProjects.join("、") : "无"}`,
      `- 关联判断：${state.relatedJudgments.length ? state.relatedJudgments.join("、") : "无"}`,
      `- 关联行动：${state.relatedActions.length ? state.relatedActions.join("、") : "无"}`,
    ] : []),
    "",
    "## 适用边界",
    "",
    state.context || "- 以来源、适用范围和当前有效期为边界；未知部分不得外推。",
    "",
    "## 来源与修订",
    "",
    `- 稳定知识键：\`${state.knowledgeKey}\``,
    `- 当前修订：\`${state.revisionId}\``,
    `- 当前入口：\`${state.canonicalPath}\``,
    ...state.source.documents.map((item) => `- 文档证据：[[${item.replace(/\.md$/iu, "")}]]`),
  ];
  return [...metadata, "", ...sections, ""].join("\n");
}

function materializeEntityMutation({
  candidate,
  decision,
  currentRecord = null,
  currentNote = null,
  now,
  conversationPath = null,
} = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw revisionError("INVALID_CANDIDATE", "知识候选不能为空");
  }
  candidate = normalizeEnvironmentCandidate(candidate, { now });
  assertNoPathFields(candidate);
  if (!decision || typeof decision !== "object" || !SUPPORTED_DECISIONS.has(decision.type)) {
    throw revisionError("INVALID_DECISION", "知识对象判定结果无效");
  }
  if (decision.type === "conflict" || decision.type === "ignore") {
    return { decision: decision.type, writes: [], preview: null };
  }
  const entityId = text(decision.entityId, 300);
  const knowledgeKey = text(decision.knowledgeKey || candidate.knowledgeKey || candidate.key, 300);
  const recordClass = text(decision.recordClass || candidate.recordClass, 80);
  if (!entityId || !knowledgeKey || !new Set(["personal-knowledge", "business-reference"]).has(recordClass)) {
    throw revisionError("INVALID_IDENTITY", "知识对象缺少有效的实体编号、稳定键或记录类型");
  }

  const creating = decision.type === "create";
  if (!creating) {
    if (!currentRecord || !currentNote || typeof currentNote.content !== "string") {
      throw revisionError("CURRENT_RECORD_REQUIRED", "更新知识对象必须提供当前记录和当前原文");
    }
    if (currentRecord.entityId !== entityId
      || normalizedKnowledgeKey(currentRecord.knowledgeKey) !== normalizedKnowledgeKey(knowledgeKey)
      || currentRecord.path !== decision.currentPath || currentNote.path !== currentRecord.path) {
      throw revisionError("CURRENT_IDENTITY_MISMATCH", "当前记录与知识对象判定不一致，已拒绝更新");
    }
  }

  const canonicalPath = creating
    ? resolveCanonicalPath({ candidate: { ...candidate, recordClass, knowledgeKey }, entityId })
    : currentRecord.path;
  const sourceEvidence = documentEvidence(candidate);
  const existingDocuments = currentRecord?.source?.documents || [];
  const existingHashes = currentRecord?.source?.documentHashes || [];
  const documents = uniqueStrings(existingDocuments, sourceEvidence.documents);
  const documentHashes = uniqueObjects(
    [...existingHashes, ...sourceEvidence.documentHashes],
    (item) => `${text(item.path, 1_024)}\u0000${text(item.sha256, 64)}`,
  );
  const newMessageId = text(candidate?.source?.messageId, 500);
  const newQuote = text(candidate?.source?.quotedText, 100_000);
  const primaryMessageId = currentRecord?.source?.messageId || newMessageId || null;
  const primaryQuote = currentRecord?.source?.quotedText || newQuote || null;
  const evidenceIds = uniqueStrings(
    currentRecord?.evidenceIds,
    candidate.evidenceIds,
    newMessageId ? `msg:${newMessageId}` : null,
    documentHashes.map((item) => `doc:${item.sha256}`),
    documentHashes.length ? [] : documents.map((item) => `doc-path:${item}`),
  );
  const sourceEvidenceRows = uniqueObjects([
    ...(Array.isArray(currentRecord?.sourceEvidence) ? currentRecord.sourceEvidence : []),
    ...(currentRecord?.source?.quotedText ? [{
      sourceMessageId: currentRecord.source.messageId,
      quotedText: currentRecord.source.quotedText,
    }] : []),
    ...(newQuote ? [{ sourceMessageId: newMessageId || null, quotedText: newQuote }] : []),
    ...sourceEvidence.documentQuotes,
  ], (item) => `${text(item.sourceMessageId, 500)}\u0000${text(item.sourceDocumentPath, 1_024)}\u0000${text(item.quotedText, 100_000)}`);
  const nextRevision = creating ? 1 : Number(decision.nextRevision || currentRecord.revision + 1);
  const revisionId = `${entityId}:r${nextRevision}`;
  const lifecycleSources = uniqueObjects([
    ...(Array.isArray(currentRecord?.lifecycleSources) ? currentRecord.lifecycleSources : []),
    ...(currentRecord ? [{
      entityId,
      revisionId: currentRecord.revisionId,
      path: currentRecord.path,
      sourceConversationPath: currentRecord.source?.conversationPath || null,
      sourceMessageId: currentRecord.source?.messageId || null,
      sourceQuotedText: currentRecord.source?.quotedText || null,
      sourceDocuments: existingDocuments,
    }] : []),
    {
      entityId,
      revisionId,
      path: canonicalPath,
      sourceConversationPath: conversationPath || null,
      sourceMessageId: newMessageId || null,
      sourceQuotedText: newQuote || null,
      sourceDocuments: sourceEvidence.documents,
    },
  ], (item) => JSON.stringify(item));

  const oldContent = currentRecord?.content || "";
  const oldSummary = currentRecord?.summary || oldContent;
  const content = decision.type === "patch"
    ? oldContent
    : decision.type === "merge"
      ? mergeText(oldContent, candidate.content, now)
      : text(candidate.content);
  const summary = decision.type === "patch"
    ? oldSummary
    : decision.type === "merge"
      ? mergeSummary(oldSummary, candidate.summary || candidate.content)
      : text(candidate.summary || candidate.content, 20_000);
  const keyPoints = decision.type === "patch"
    ? uniqueStrings(currentRecord?.keyPoints)
    : decision.type === "merge"
      ? uniqueStrings(currentRecord?.keyPoints, candidate.keyPoints).slice(0, 8)
      : uniqueStrings(candidate.keyPoints).slice(0, 8);
  const suggestedUses = decision.type === "patch"
    ? uniqueStrings(currentRecord?.suggestedUses)
    : decision.type === "merge"
      ? uniqueStrings(currentRecord?.suggestedUses, candidate.suggestedUses).slice(0, 6)
      : uniqueStrings(candidate.suggestedUses).slice(0, 6);
  const epistemicStatus = text(candidate.epistemicStatus || currentRecord?.epistemicStatus, 120) || "unknown";
  const knowledgeType = text(candidate.knowledgeType || currentRecord?.knowledgeType, 120) || "cognitive-asset";
  const referenceType = text(candidate.referenceType || currentRecord?.referenceType, 120) || "business-operational";
  const topics = normalizeControlledTopics([...(currentRecord?.tags || []), ...(candidate.tags || [])]);
  const tags = [...buildSystemTags(recordClass, knowledgeType, epistemicStatus), ...topics];
  const title = text(candidate.title || currentRecord?.title, 300);
  const state = {
    governance: {
      reviewStatus: currentRecord?.reviewStatus,
      sourceStatus: currentRecord?.sourceStatus,
      case_id: currentRecord?.caseId,
      primarySubjectKey: currentRecord?.primarySubjectKey,
      recordRole: currentRecord?.recordRole,
      sensitivity: currentRecord?.sensitivity,
    },
    recordClass,
    entityId,
    knowledgeKey,
    knowledgeType,
    referenceType,
    epistemicStatus,
    title,
    content,
    summary,
    keyPoints,
    suggestedUses,
    effectiveFrom: decision.type === "patch"
      ? currentRecord?.effectiveFrom || null
      : candidate.effectiveFrom || currentRecord?.effectiveFrom || null,
    effectiveUntil: candidate.effectiveUntil || currentRecord?.effectiveUntil || null,
    area: knowledgeType === "environment"
      ? candidate.area || currentRecord?.area || null : null,
    observedAt: knowledgeType === "environment"
      ? candidate.observedAt || currentRecord?.observedAt || null : null,
    reviewAt: knowledgeType === "environment"
      ? candidate.reviewAt || currentRecord?.reviewAt || null : null,
    freshness: knowledgeType === "environment"
      ? candidate.freshness || currentRecord?.freshness || "current" : null,
    scope: knowledgeType === "environment"
      ? candidate.scope || currentRecord?.scope || "" : "",
    relatedProjects: knowledgeType === "environment"
      ? uniqueStrings(currentRecord?.relatedProjects, candidate.relatedProjects).slice(0, 100) : [],
    relatedJudgments: knowledgeType === "environment"
      ? uniqueStrings(currentRecord?.relatedJudgments, candidate.relatedJudgments).slice(0, 100) : [],
    relatedActions: knowledgeType === "environment"
      ? uniqueStrings(currentRecord?.relatedActions, candidate.relatedActions).slice(0, 100) : [],
    context: decision.type === "patch"
      ? currentRecord?.context || ""
      : candidate.context || currentRecord?.context || "",
    tags,
    aliases: uniqueStrings(
      currentRecord?.aliases,
      candidate.aliases,
      currentRecord?.title && currentRecord.title !== title ? currentRecord.title : null,
    ).slice(0, 50),
    relatedKnowledge: uniqueObjects(
      [...(currentRecord?.relatedKnowledge || []), ...(candidate.relatedKnowledge || [])],
      (item) => JSON.stringify(item),
    ).slice(0, 100),
    source: {
      conversationPath: currentRecord?.source?.conversationPath || conversationPath || null,
      messageId: primaryMessageId,
      quotedText: primaryQuote,
      documents,
      documentHashes,
    },
    sourceEvidence: sourceEvidenceRows,
    evidenceIds,
    lifecycleSources,
    revision: nextRevision,
    revisionId,
    previousRevisionId: creating ? null : currentRecord.revisionId,
    canonicalPath,
    changeType: decision.type,
    createdAt: currentRecord?.createdAt || text(now, 100),
    updatedAt: text(now, 100),
  };
  const markdown = buildMarkdown(state);
  const operation = creating
    ? "create"
    : decision.historyPolicy === "metadata-only"
      ? "replace"
      : "snapshot-replace";
  const write = {
    candidateId: candidate.id || null,
    entityId,
    knowledgeId: entityId,
    title,
    operation,
    path: canonicalPath,
    content: markdown,
    tagPlan: tags.map((tag) => ({ tag, status: "governed" })),
    manifest: {
      recordClass,
      entityId,
      knowledgeKey,
      revision: nextRevision,
      revisionId,
      canonicalPath,
      changeType: decision.type,
      historyPolicy: decision.historyPolicy,
      tags,
    },
  };
  if (!creating) {
    write.expectedHash = crypto.createHash("sha256").update(currentNote.content, "utf8").digest("hex");
  }
  return { decision: decision.type, writes: [write], preview: { ...write.manifest } };
}

module.exports = {
  materializeEntityMutation,
  resolveCanonicalPath,
};
