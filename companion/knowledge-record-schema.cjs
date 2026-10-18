"use strict";

const {
  FRESHNESS_STATES,
  MAX_ENVIRONMENT_EVIDENCE_IDS,
  evaluateEnvironmentFreshness,
  normalizeFreshness,
  validateEnvironmentCategory,
  validDate,
} = require("./environment-policy-engine.cjs");

const CURRENT_ROOTS = new Set([
  "01_当前的我",
  "02_我的历史",
  "03_环境",
  "04_关系",
  "05_目标与项目",
  "06_判断与决策",
  "07_行动",
  "08_结果与反馈",
  "09_认知资产",
  "11_证据与来源",
  "12_资料库",
]);
const REVISION_HISTORY_ROOT = "00_系统/运行记录/知识生命周期归档";
const SUPPORTED_FORMATS = new Set(["knowledge-v1", "reference-v1", "knowledge-revision-v1"]);
const ACTIVE_STATUSES = new Set(["active", "valid", "有效", "当前"]);
const MAX_NOTE_LENGTH = 1_000_000;
const MAX_FRONTMATTER_LENGTH = 100_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ARRAY_FIELDS = new Set([
  "aliases",
  "evidenceIds",
  "evidence_refs",
  "keyPoints",
  "lifecycleSources",
  "mergedFrom",
  "relatedKnowledge",
  "relatedProjects",
  "relatedJudgments",
  "relatedActions",
  "related_projects",
  "related_judgments",
  "related_actions",
  "sourceDocumentHashes",
  "sourceDocuments",
  "sourceEvidence",
  "suggestedUses",
  "supersededBy",
  "supersedes",
  "tags",
]);

function schemaError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeText(value, maximum = 20_000) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return "";
  const text = value.replace(/\u0000/gu, "").trim();
  return [...text].slice(0, maximum).join("");
}

function normalizeKey(value) {
  return normalizeText(value, 240).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function isRevisionHistoryPath(path) {
  return typeof path === "string"
    && path.startsWith(`${REVISION_HISTORY_ROOT}/`)
    && path.split("/").length === 4
    && path.endsWith(".md");
}

function assertSafeSegment(segment) {
  if (!segment || segment === "." || segment === ".." || segment !== segment.trim()
    || /[. ]$/u.test(segment) || segment.length > 200
    || WINDOWS_INVALID.test(segment) || WINDOWS_RESERVED.test(segment)) {
    throw schemaError("UNSAFE_RECORD_PATH", "知识记录路径包含不安全的目录或文件名");
  }
}

function assertSafeRecordPath(path, { allowHistory = true } = {}) {
  if (typeof path !== "string" || !path || path.length > 1_024 || path.includes("\\")
    || path.startsWith("/") || path.startsWith("//") || /^[a-z]:/iu.test(path)) {
    throw schemaError("UNSAFE_RECORD_PATH", "知识记录必须使用知识库内的 Markdown 相对路径");
  }
  const normalized = path.normalize("NFC");
  const segments = normalized.split("/");
  segments.forEach(assertSafeSegment);
  if (!normalized.endsWith(".md")) {
    throw schemaError("UNSAFE_RECORD_PATH", "知识记录必须是 Markdown 文件");
  }
  if (allowHistory && isRevisionHistoryPath(normalized)) return normalized;
  if (!CURRENT_ROOTS.has(segments[0])) {
    throw schemaError("UNSAFE_RECORD_PATH", "知识记录不在允许的正式目录中");
  }
  return normalized;
}

function extractFrontmatter(content) {
  if (typeof content !== "string" || content.length > MAX_NOTE_LENGTH) {
    throw schemaError("NOTE_SIZE_INVALID", "知识记录内容为空或超过安全上限");
  }
  const normalized = content.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0 || closing > MAX_FRONTMATTER_LENGTH) {
    throw schemaError("MALFORMED_FRONTMATTER", "知识记录 Frontmatter 未正确结束");
  }
  return {
    raw: normalized.slice(4, closing),
    body: normalized.slice(closing + 5),
  };
}

function parseScalar(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.startsWith('"') || value.startsWith("[") || value.startsWith("{")
    || /^(?:true|false|null|-?\d+(?:\.\d+)?)$/u.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      throw schemaError("MALFORMED_FIELD", "知识记录字段不是有效的 JSON 兼容值");
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function parseBlockScalar(lines, startIndex, folded) {
  const parts = [];
  let index = startIndex + 1;
  while (index < lines.length && (lines[index] === "" || /^\s{2,}/u.test(lines[index]))) {
    parts.push(lines[index] === "" ? "" : lines[index].replace(/^\s{2}/u, ""));
    index += 1;
  }
  return {
    value: folded ? parts.join(" ").trim() : parts.join("\n").replace(/\n+$/u, ""),
    nextIndex: index - 1,
  };
}

function parseSequence(lines, startIndex) {
  const items = [];
  let index = startIndex + 1;
  while (index < lines.length && /^\s/u.test(lines[index])) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const match = /^\s{2,}-\s+(.+)$/u.exec(lines[index]);
    if (!match) break;
    items.push(parseScalar(match[1]));
    if (items.length > 500) throw schemaError("FIELD_LIMIT_EXCEEDED", "知识记录数组字段过长");
    index += 1;
  }
  return { value: items, nextIndex: index - 1 };
}

function parseFrontmatterFields(frontmatter) {
  const lines = frontmatter.split("\n");
  const fields = Object.create(null);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || /^\s/u.test(line) || /^#/u.test(line)) continue;
    const match = /^([^:\s][^:]*?):(?:\s?(.*))$/u.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    const rawValue = match[2] ?? "";
    if (Object.hasOwn(fields, name)) {
      throw schemaError("DUPLICATE_FIELD", `知识记录重复定义了字段：${name}`, { field: name });
    }
    if (/^[|>]-?$/u.test(rawValue.trim())) {
      const parsed = parseBlockScalar(lines, index, rawValue.trim().startsWith(">"));
      fields[name] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (!rawValue.trim() && ARRAY_FIELDS.has(name)) {
      const parsed = parseSequence(lines, index);
      fields[name] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    fields[name] = parseScalar(rawValue);
  }
  return fields;
}

function normalizeStringArray(value, maximum = 500) {
  const values = Array.isArray(value) ? value : value === "" || value === null || value === undefined ? [] : [value];
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const text = normalizeText(item, 2_000);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maximum) break;
  }
  return result;
}

function normalizeObjects(value, maximum = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, maximum)
    .map((item) => ({ ...item }));
}

function requiredText(fields, names, label) {
  for (const name of names) {
    const value = normalizeText(fields[name], 20_000);
    if (value) return value;
  }
  throw schemaError("MISSING_REQUIRED_FIELD", `知识记录缺少必填字段：${label}`, { field: label });
}

function optionalText(fields, names, maximum = 20_000) {
  for (const name of names) {
    const value = normalizeText(fields[name], maximum);
    if (value) return value;
  }
  return "";
}

function normalizeRevision(value) {
  const revision = typeof value === "number" ? value : Number.parseInt(String(value || "1"), 10);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) {
    throw schemaError("INVALID_REVISION", "知识记录 revision 必须是正整数");
  }
  return revision;
}

function normalizeStatus(value) {
  const status = normalizeText(value, 60).toLowerCase();
  if (new Set(["active", "valid", "有效", "当前"]).has(status)) return "active";
  if (new Set(["pending", "待验证", "待核验"]).has(status)) return "pending";
  if (new Set(["superseded", "已替代"]).has(status)) return "superseded";
  if (new Set(["historical", "history", "历史"]).has(status)) return "historical";
  if (new Set(["archived", "归档"]).has(status)) return "archived";
  return status || "unknown";
}

function recordFromFields(note, safePath, fields) {
  const format = normalizeText(fields.xingzhiFormat, 80);
  if (!SUPPORTED_FORMATS.has(format)) return null;

  const isHistory = isRevisionHistoryPath(safePath) || format === "knowledge-revision-v1";
  const root = safePath.split("/")[0];
  const recordClass = format === "reference-v1" || root === "12_资料库"
    ? "business-reference"
    : "personal-knowledge";
  const entityId = requiredText(fields, ["entityId", "knowledgeId", "referenceId"], "entityId");
  const knowledgeKey = requiredText(fields, ["knowledgeKey", "key"], "knowledgeKey");
  const title = requiredText(fields, ["title", "标题"], "title");
  const originalStatus = normalizeStatus(requiredText(fields, ["status", "状态"], "status"));
  const summary = optionalText(fields, ["summary"], 100_000);
  const content = format === "reference-v1"
    ? optionalText(fields, ["content", "summary"], 500_000)
    : requiredText(fields, ["content"], "content");
  if (!content) {
    throw schemaError("MISSING_REQUIRED_FIELD", "业务资料必须至少包含 content 或 summary", { field: "content" });
  }
  if (format === "knowledge-v1") {
    requiredText(fields, ["knowledgeType"], "knowledgeType");
  }
  if (format === "reference-v1") {
    requiredText(fields, ["referenceType"], "referenceType");
  }

  const revision = normalizeRevision(fields.revision ?? fields["版本"] ?? 1);
  const revisionId = optionalText(fields, ["revisionId"], 300) || `${entityId}:r${revision}`;
  const suppliedCanonicalPath = optionalText(fields, ["canonicalPath"], 1_024);
  let canonicalPath = isHistory ? suppliedCanonicalPath || null : suppliedCanonicalPath || safePath;
  if (canonicalPath) canonicalPath = assertSafeRecordPath(canonicalPath, { allowHistory: false });
  if (!isHistory && canonicalPath !== safePath) {
    throw schemaError("CANONICAL_PATH_MISMATCH", "当前知识记录声明的 canonicalPath 与实际路径不一致");
  }

  const knowledgeType = optionalText(fields, ["knowledgeType", "legacyKnowledgeType"], 120) || null;
  const documentHashes = normalizeObjects(fields.sourceDocumentHashes).filter((item) => (
    typeof item.path === "string" && typeof item.sha256 === "string" && SHA256.test(item.sha256)
  ));
  const sourceDocuments = normalizeStringArray(fields.sourceDocuments);
  // [本地增强 R1] environment-policy.yaml 0.2 → field_convention.accepted_input_aliases
  // 明确要求接受 evidence_refs。不补则手工 Frontmatter 的 evidence_refs 被静默丢弃。
  const declaredEvidenceIds = normalizeStringArray(
    fields.evidenceIds ?? fields.evidence_refs,
  );
  if (knowledgeType === "environment" && declaredEvidenceIds.length > MAX_ENVIRONMENT_EVIDENCE_IDS) {
    throw schemaError(
      "ENVIRONMENT_EVIDENCE_LIMIT_EXCEEDED",
      `环境记录 evidenceIds 最多允许 ${MAX_ENVIRONMENT_EVIDENCE_IDS} 项`,
      { field: "evidenceIds", maximum: MAX_ENVIRONMENT_EVIDENCE_IDS },
    );
  }
  const evidenceIds = [...declaredEvidenceIds];
  const messageId = optionalText(fields, ["sourceMessageId", "来源消息"], 500);
  if (messageId) evidenceIds.push(`msg:${messageId}`);
  for (const item of documentHashes) evidenceIds.push(`doc:${item.sha256}`);
  if (documentHashes.length === 0) {
    for (const path of sourceDocuments) evidenceIds.push(`doc-path:${path}`);
  }

  const rawArea = optionalText(fields, ["area", "category", "environmentCategory"], 120) || null;
  const environmentCategory = knowledgeType === "environment"
    ? validateEnvironmentCategory(rawArea)
    : null;
  if (knowledgeType === "environment" && !environmentCategory?.valid) {
    throw schemaError(
      "INVALID_ENVIRONMENT_CATEGORY",
      "环境记录 category/area 必须属于 rules、technology、regional、social、market、industry、organization 之一",
      { field: "category", value: rawArea },
    );
  }
  const area = knowledgeType === "environment" ? environmentCategory.canonical : rawArea;
  const rawFreshness = optionalText(fields, ["freshness"], 40);
  if (knowledgeType === "environment" && rawFreshness && !FRESHNESS_STATES.has(rawFreshness.toLowerCase())) {
    throw schemaError(
      "INVALID_ENVIRONMENT_FRESHNESS",
      "环境记录 freshness 必须是 current、monitoring、stale 或 invalid",
      { field: "freshness", value: rawFreshness },
    );
  }
  const freshness = knowledgeType === "environment"
    ? normalizeFreshness(rawFreshness, "current")
    : null;
  const rawObservedAt = optionalText(fields, ["observedAt", "observed_at"], 100) || null;
  const rawReviewAt = optionalText(fields, ["reviewAt", "review_at"], 100) || null;
  const rawEffectiveUntil = optionalText(fields, ["effectiveUntil"], 100) || null;
  if (knowledgeType === "environment" && rawObservedAt && !validDate(rawObservedAt)) {
    throw schemaError("INVALID_ENVIRONMENT_DATE", "环境记录 observedAt 不是有效日期", { field: "observedAt" });
  }
  if (knowledgeType === "environment" && rawReviewAt && !validDate(rawReviewAt)) {
    throw schemaError("INVALID_ENVIRONMENT_DATE", "环境记录 reviewAt 不是有效日期", { field: "reviewAt" });
  }
  if (knowledgeType === "environment" && rawEffectiveUntil && !validDate(rawEffectiveUntil)) {
    throw schemaError("INVALID_ENVIRONMENT_DATE", "环境记录 effectiveUntil 不是有效日期", { field: "effectiveUntil" });
  }
  const observedAt = knowledgeType === "environment" && rawObservedAt ? validDate(rawObservedAt) : rawObservedAt;
  const reviewAt = knowledgeType === "environment" && rawReviewAt ? validDate(rawReviewAt) : rawReviewAt;
  const scope = optionalText(fields, ["scope"], 2_000) || null;
  // [本地增强 R1] 同上；库内 00_系统/模板/环境模板.md 使用的就是 snake_case。
  const relatedProjects = normalizeStringArray(fields.relatedProjects ?? fields.related_projects, 100);
  const relatedJudgments = normalizeStringArray(fields.relatedJudgments ?? fields.related_judgments, 100);
  const relatedActions = normalizeStringArray(fields.relatedActions ?? fields.related_actions, 100);

  const status = isHistory ? "historical" : originalStatus;
  const isCanonical = !isHistory && fields.canonical !== false;
  const currentEligible = isCanonical && ACTIVE_STATUSES.has(originalStatus);
  const environmentFreshness = knowledgeType === "environment"
    ? evaluateEnvironmentFreshness({
        knowledgeType,
        freshness,
        reviewAt,
        effectiveUntil: rawEffectiveUntil ? validDate(rawEffectiveUntil) : null,
      })
    : { status: null, requiresReview: false, reasonCode: null, reviewAt: null };
  const updatedAt = optionalText(fields, ["updatedAt", "更新时间", "lifecycleUpdatedAt"], 100)
    || (Number.isFinite(Number(note.mtime)) && Number(note.mtime) > 0
      ? new Date(Number(note.mtime)).toISOString()
      : null);

  return {
    format,
    recordClass,
    entityId,
    knowledgeKey,
    normalizedKnowledgeKey: normalizeKey(knowledgeKey),
    path: safePath,
    canonicalPath,
    revision,
    revisionId,
    previousRevisionId: optionalText(fields, ["previousRevisionId"], 300) || null,
    status,
    originalStatus,
    isHistorical: isHistory,
    isCanonical,
    currentEligible,
    // Version identity and evidence eligibility are different axes. Do not hide
    // pending records from mutation/conflict checks, or a second current could be created.
    retrievalEligible: currentEligible
      && !new Set(["candidate-review", "pending", "needs-review", "rejected"]).has(optionalText(fields, ["reviewStatus"], 120))
      && !new Set(["missing", "broken", "needs-recovery"]).has(optionalText(fields, ["sourceStatus"], 120)),
    reviewStatus: optionalText(fields, ["reviewStatus"], 120) || null,
    sourceStatus: optionalText(fields, ["sourceStatus"], 120) || null,
    caseId: optionalText(fields, ["case_id", "caseId"], 300) || null,
    primarySubjectKey: optionalText(fields, ["primarySubjectKey"], 300) || null,
    recordRole: optionalText(fields, ["recordRole"], 120) || null,
    sensitivity: optionalText(fields, ["sensitivity", "敏感度"], 120) || null,
    title,
    content,
    summary: summary || content,
    keyPoints: normalizeStringArray(fields.keyPoints, 100),
    suggestedUses: normalizeStringArray(fields.suggestedUses, 100),
    knowledgeType,
    referenceType: optionalText(fields, ["referenceType"], 120) || null,
    epistemicStatus: optionalText(fields, ["epistemicStatus", "认识状态"], 120) || null,
    effectiveFrom: optionalText(fields, ["effectiveFrom"], 100) || null,
    effectiveUntil: knowledgeType === "environment" && rawEffectiveUntil ? validDate(rawEffectiveUntil) : (rawEffectiveUntil || null),
    area,
    freshness,
    observedAt,
    reviewAt,
    scope,
    relatedProjects,
    relatedJudgments,
    relatedActions,
    environmentFreshness,
    context: optionalText(fields, ["context"], 20_000) || null,
    tags: normalizeStringArray(fields.tags, 50),
    aliases: normalizeStringArray(fields.aliases, 50),
    relatedKnowledge: normalizeObjects(fields.relatedKnowledge, 100),
    supersedes: normalizeStringArray(fields.supersedes, 100),
    supersededBy: normalizeStringArray(fields.supersededBy, 100),
    mergedFrom: normalizeStringArray(fields.mergedFrom, 100),
    lifecycleSources: normalizeObjects(fields.lifecycleSources, 500),
    sourceEvidence: normalizeObjects(fields.sourceEvidence, 500),
    source: {
      conversationPath: optionalText(fields, ["sourceConversationPath"], 1_024) || null,
      messageId: messageId || null,
      quotedText: optionalText(fields, ["sourceQuotedText"], 100_000) || null,
      documents: sourceDocuments,
      documentHashes,
      anchorType: optionalText(fields, ["sourceAnchorType"], 120) || null,
    },
    evidenceIds: [...new Set(evidenceIds)].slice(
      0,
      knowledgeType === "environment" ? MAX_ENVIRONMENT_EVIDENCE_IDS : 500,
    ),
    createdAt: optionalText(fields, ["createdAt", "created", "创建时间"], 100) || null,
    updatedAt,
    changeType: optionalText(fields, ["changeType"], 100) || null,
  };
}

function inspectKnowledgeRecord(note) {
  const path = typeof note?.path === "string" ? note.path : null;
  const content = typeof note?.content === "string" ? note.content : "";
  const governedHint = /^---\r?\n[\s\S]{0,5000}?^xingzhiFormat:\s*(?:"(?:knowledge-v1|reference-v1|knowledge-revision-v1)"|(?:knowledge-v1|reference-v1|knowledge-revision-v1))\s*$/mu.test(content);
  try {
    const safePath = assertSafeRecordPath(path);
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) return { governed: false, malformed: false, path: safePath, record: null };
    const fields = parseFrontmatterFields(frontmatter.raw);
    // [本地增强 R2] 正文兜底：缺 content 字段的 knowledge-v1 笔记以正文作为 content，
    // 否则整条记录 MISING_REQUIRED_FIELD。此项在库内既有实现中存在，属恢复而非新增。
    if (!fields.content && frontmatter.body) {
      fields.content = frontmatter.body.trim();
    }
    const format = normalizeText(fields.xingzhiFormat, 80);
    if (!SUPPORTED_FORMATS.has(format)) {
      return { governed: false, malformed: false, path: safePath, record: null };
    }
    const record = recordFromFields(note, safePath, fields);
    return { governed: true, malformed: false, path: safePath, record };
  } catch (error) {
    return {
      governed: governedHint,
      malformed: governedHint,
      path,
      record: null,
      errorCode: error?.code || "MALFORMED_KNOWLEDGE_RECORD",
      message: error?.message || "知识记录无法解析",
    };
  }
}

function parseKnowledgeRecord(note) {
  const inspection = inspectKnowledgeRecord(note);
  if (!inspection.governed) return null;
  if (inspection.malformed || !inspection.record) {
    throw schemaError(
      inspection.errorCode || "MALFORMED_KNOWLEDGE_RECORD",
      inspection.message || "知识记录无法解析",
      { path: inspection.path },
    );
  }
  return inspection.record;
}

function defaultRecordRetrievalEligibility(note) {
  const content = String(note?.content || "");
  const rawType = /^type:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))\s*$/mu
    .exec(content)?.slice(1).find(Boolean);
  if (normalizeText(rawType, 100) === "conversation-organization") return false;
  const inspection = inspectKnowledgeRecord(note);
  if (inspection.malformed) return false;
  if (!inspection.governed) {
    if (isRevisionHistoryPath(note?.path)) return false;
    try {
      assertSafeRecordPath(note?.path, { allowHistory: false });
      return true;
    } catch {
      return false;
    }
  }
  return inspection.record.retrievalEligible;
}

function buildKnowledgeCatalog(notes) {
  if (!Array.isArray(notes)) throw schemaError("INVALID_CATALOG_INPUT", "知识目录输入必须是数组");
  const records = [];
  const malformed = [];
  for (const note of notes) {
    const inspection = inspectKnowledgeRecord(note);
    if (inspection.malformed) {
      malformed.push({
        path: inspection.path,
        errorCode: inspection.errorCode,
        message: inspection.message,
      });
    } else if (inspection.record) {
      records.push(inspection.record);
    }
  }

  const byIdentity = new Map();
  const byKnowledgeKey = new Map();
  for (const record of records) {
    const identity = `${record.recordClass}\u0000${record.entityId}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push(record);
    const key = `${record.recordClass}\u0000${record.normalizedKnowledgeKey}`;
    if (!byKnowledgeKey.has(key)) byKnowledgeKey.set(key, []);
    byKnowledgeKey.get(key).push(record);
  }

  const conflicts = [];
  for (const grouped of byKnowledgeKey.values()) {
    const current = grouped.filter((record) => record.currentEligible);
    if (current.length <= 1) continue;
    conflicts.push({
      reasonCode: "MULTIPLE_ACTIVE_ENTITIES",
      recordClass: current[0].recordClass,
      knowledgeKey: current[0].knowledgeKey,
      entityIds: current.map((record) => record.entityId),
      paths: current.map((record) => record.path),
    });
  }

  return { records, malformed, conflicts, byIdentity, byKnowledgeKey };
}

module.exports = {
  CURRENT_ROOTS,
  REVISION_HISTORY_ROOT,
  buildKnowledgeCatalog,
  defaultRecordRetrievalEligibility,
  inspectKnowledgeRecord,
  isRevisionHistoryPath,
  parseKnowledgeRecord,
};
