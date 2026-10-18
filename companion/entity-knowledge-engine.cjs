"use strict";

const crypto = require("node:crypto");

const ACTIVE_STATUSES = new Set(["active", "current", "valid", "有效", "当前"]);
const ALLOWED_RECORD_CLASSES = new Set([
  "personal-knowledge",
  "business-reference",
  "conversation-record",
  "discard",
]);
const METADATA_FIELDS = new Set([
  "alias",
  "aliases",
  "format",
  "formatting",
  "link",
  "links",
  "tag",
  "tags",
  "title-style",
  "typo",
  "whitespace",
]);
const MATERIAL_FIELDS = new Set([
  "amount",
  "applicability",
  "conclusion",
  "currentstate",
  "effectivefrom",
  "effectiveuntil",
  "formula",
  "method",
  "price",
  "rate",
  "scope",
  "status",
  "threshold",
  "validity",
]);
const TOPIC_ALIASES = new Map([
  ["国际货代", "货代业务"],
  ["货代", "货代业务"],
  ["货运代理", "货代业务"],
  ["职业", "职业发展"],
  ["职业规划", "职业发展"],
  ["客户获取", "客户开发"],
  ["获客", "客户开发"],
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype
    || prototype?.constructor?.name === "Object";
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKnowledgeKey(value) {
  const key = normalizeString(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
  if (key.length < 2 || key.length > 200 || /[\\/\u0000-\u001f]/u.test(key)
    || key === "." || key === "..") {
    throw new TypeError("knowledgeKey 必须是稳定、非路径形式的知识键");
  }
  return key;
}

function normalizeRecordClass(value) {
  const recordClass = normalizeString(value);
  if (!ALLOWED_RECORD_CLASSES.has(recordClass)) {
    throw new TypeError(`不支持的记录类型：${recordClass || "(空)"}`);
  }
  return recordClass;
}

function assertModelDidNotSupplyPath(value, ancestry = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertModelDidNotSupplyPath(entry, ancestry.concat(index)));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
    const evidencePath = normalizedKey === "path" && ancestry.some((part) => (
      /^(?:source)?documenthashes$/iu.test(String(part).replace(/[_-]/gu, ""))
    ));
    if (!evidencePath && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
      const location = ancestry.concat(key).join(".");
      throw new TypeError(`模型不能指定知识路径：${location}`);
    }
    assertModelDidNotSupplyPath(child, ancestry.concat(key));
  }
}

function normalizeEvidenceIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeString).filter(Boolean))];
}

function isActiveRecord(record) {
  if (!isPlainObject(record)) return false;
  const status = normalizeString(record.status).toLowerCase();
  return !status || ACTIVE_STATUSES.has(status);
}

function deriveEntityId(knowledgeKey) {
  const readableTail = knowledgeKey
    .split(".")
    .slice(-2)
    .join("-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const digest = crypto.createHash("sha256").update(knowledgeKey).digest("hex").slice(0, 10);
  return `${readableTail || "knowledge"}-${digest}`;
}

function baseResult(type, incoming, currentRecord = null) {
  const knowledgeKey = normalizeKnowledgeKey(incoming.knowledgeKey);
  const entityId = currentRecord?.entityId || deriveEntityId(knowledgeKey);
  const currentRevision = Number.isInteger(currentRecord?.revision) && currentRecord.revision > 0
    ? currentRecord.revision
    : 0;

  return {
    type,
    entityId,
    knowledgeKey,
    recordClass: normalizeRecordClass(incoming.recordClass),
    currentPath: currentRecord?.path || null,
    currentRevision,
    nextRevision: type === "ignore" || type === "conflict" ? currentRevision : currentRevision + 1,
    createCurrentFile: type === "create",
  };
}

function conflictResult(reasonCode, incoming, currentRecord = null, details = {}) {
  return {
    ...baseResult("conflict", incoming, currentRecord),
    reasonCode,
    historyPolicy: "none",
    requiresConfirmation: true,
    mutations: [],
    ...details,
  };
}

function normalizedChangedFields(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((field) => normalizeString(field).replace(/[_-]/gu, "").toLowerCase()).filter(Boolean))];
}

function allEvidenceAlreadyApplied(incomingEvidence, currentEvidence) {
  if (incomingEvidence.length === 0) return false;
  const currentSet = new Set(currentEvidence);
  return incomingEvidence.every((evidenceId) => currentSet.has(evidenceId));
}

function contentDiffers(incoming, currentRecord) {
  const next = normalizeString(incoming.content);
  const previous = normalizeString(currentRecord?.content);
  return Boolean(next && previous && next !== previous);
}

function materialTokens(value) {
  const normalized = normalizeString(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const matches = normalized.match(
    /(?:usd|eur|cny|rmb|hkd|gbp|cad|mxn|aud|jpy)?\s*[-+]?\d+(?:[.,]\d+)*(?:\s*%|\s*(?:kg|kgs|lb|lbs|cbm|m3|立方米|公斤|千克|美元|欧元|元))?|[÷×*/=≤≥<>]|(?:启用|停用|失效|废止|禁止|允许|取较大|取较小|最大值|最小值)/giu,
  ) || [];
  return [...new Set(matches.map((token) => token.replace(/\s+/gu, "")))].sort();
}

function detectMaterialContentChange(incoming, currentRecord) {
  if (!isPlainObject(incoming) || !isPlainObject(currentRecord)
    || !contentDiffers(incoming, currentRecord)) return false;
  const incomingFrom = normalizeString(incoming.effectiveFrom);
  const currentFrom = normalizeString(currentRecord.effectiveFrom);
  const incomingUntil = normalizeString(incoming.effectiveUntil);
  const currentUntil = normalizeString(currentRecord.effectiveUntil);
  if ((incomingFrom && incomingFrom !== currentFrom)
    || (incomingUntil && incomingUntil !== currentUntil)) return true;
  const before = materialTokens(currentRecord.content);
  const after = materialTokens(incoming.content);
  return (before.length > 0 || after.length > 0)
    && JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Decide how one evidence-backed candidate changes the stable knowledge object.
 * This is deliberately a pure policy function: it never accepts a destination
 * path from a model and never writes to the vault.
 */
function resolveEntityMutation({ incoming, currentRecords = [] } = {}) {
  if (!isPlainObject(incoming)) throw new TypeError("incoming 必须是知识候选对象");
  if (!Array.isArray(currentRecords)) throw new TypeError("currentRecords 必须是数组");

  assertModelDidNotSupplyPath(incoming);
  const knowledgeKey = normalizeKnowledgeKey(incoming.knowledgeKey);
  const recordClass = normalizeRecordClass(incoming.recordClass);
  const evidenceIds = normalizeEvidenceIds(incoming.evidenceIds);

  if (recordClass === "discard") {
    return {
      ...baseResult("ignore", incoming),
      reasonCode: "CANDIDATE_MARKED_DISCARD",
      historyPolicy: "none",
      requiresConfirmation: false,
      mutations: [],
    };
  }

  if (evidenceIds.length === 0 || !Number.isFinite(incoming.confidence) || incoming.confidence < 0.7) {
    return conflictResult("INSUFFICIENT_EVIDENCE", incoming, null, {
      missingEvidence: evidenceIds.length === 0,
      confidence: Number.isFinite(incoming.confidence) ? incoming.confidence : null,
    });
  }

  const matches = currentRecords.filter((record) => {
    if (!isActiveRecord(record)) return false;
    try {
      return normalizeKnowledgeKey(record.knowledgeKey) === knowledgeKey;
    } catch {
      return false;
    }
  });

  if (matches.length > 1) {
    return conflictResult("MULTIPLE_ACTIVE_ENTITIES", incoming, matches[0], {
      conflictingEntityIds: matches.map((record) => record.entityId).filter(Boolean),
    });
  }

  if (matches.length === 0) {
    return {
      ...baseResult("create", incoming),
      historyPolicy: "none",
      requiresConfirmation: false,
      mutations: [{ operation: "create-current", knowledgeKey }],
    };
  }

  const currentRecord = matches[0];
  if (normalizeString(currentRecord.recordClass) !== recordClass) {
    return conflictResult("RECORD_CLASS_MISMATCH", incoming, currentRecord, {
      currentRecordClass: currentRecord.recordClass,
      incomingRecordClass: recordClass,
    });
  }

  const currentEvidenceIds = normalizeEvidenceIds(currentRecord.evidenceIds);
  const changedFields = normalizedChangedFields(incoming.changedFields);
  const hasMaterialChange = changedFields.some((field) => MATERIAL_FIELDS.has(field))
    || detectMaterialContentChange(incoming, currentRecord);
  const hasOnlyMetadataChanges = changedFields.length > 0
    && changedFields.every((field) => METADATA_FIELDS.has(field));
  const mutationIntent = normalizeString(incoming.mutationIntent).toLowerCase();
  const sameEffectivePeriod = Boolean(
    normalizeString(incoming.effectiveFrom)
      && normalizeString(currentRecord.effectiveFrom)
      && normalizeString(incoming.effectiveFrom) === normalizeString(currentRecord.effectiveFrom),
  );
  const incomingEffectiveFrom = normalizeString(incoming.effectiveFrom);
  const incomingEffectiveUntil = normalizeString(incoming.effectiveUntil);
  const sameEffectiveWindow = (!incomingEffectiveFrom
      || incomingEffectiveFrom === normalizeString(currentRecord.effectiveFrom))
    && (!incomingEffectiveUntil
      || incomingEffectiveUntil === normalizeString(currentRecord.effectiveUntil));

  if (
    recordClass === "business-reference"
    && sameEffectivePeriod
    && contentDiffers(incoming, currentRecord)
    && (mutationIntent === "supersede" || hasMaterialChange)
  ) {
    return conflictResult("SOURCE_CONFLICT_SAME_EFFECTIVE_PERIOD", incoming, currentRecord, {
      evidenceIds,
      currentEvidenceIds,
    });
  }

  if (allEvidenceAlreadyApplied(evidenceIds, currentEvidenceIds)
    && !contentDiffers(incoming, currentRecord)
    && changedFields.length === 0
    && sameEffectiveWindow
    && mutationIntent !== "patch"
    && mutationIntent !== "supersede") {
    return {
      ...baseResult("ignore", incoming, currentRecord),
      reasonCode: "EVIDENCE_ALREADY_APPLIED",
      historyPolicy: "none",
      requiresConfirmation: false,
      mutations: [],
    };
  }

  if (hasMaterialChange || mutationIntent === "supersede") {
    return {
      ...baseResult("supersede", incoming, currentRecord),
      historyPolicy: "full-snapshot",
      requiresConfirmation: true,
      changedFields,
      mutations: [
        { operation: "snapshot-current", path: currentRecord.path },
        { operation: "replace-current", path: currentRecord.path },
      ],
    };
  }

  if (mutationIntent === "patch" && hasOnlyMetadataChanges) {
    return {
      ...baseResult("patch", incoming, currentRecord),
      historyPolicy: "metadata-only",
      requiresConfirmation: false,
      changedFields,
      mutations: [{ operation: "replace-current", path: currentRecord.path }],
    };
  }

  if (mutationIntent === "patch" && changedFields.length > 0) {
    return {
      ...baseResult("supersede", incoming, currentRecord),
      historyPolicy: "full-snapshot",
      requiresConfirmation: true,
      changedFields,
      reasonCode: "UNCLASSIFIED_PATCH_ESCALATED",
      mutations: [
        { operation: "snapshot-current", path: currentRecord.path },
        { operation: "replace-current", path: currentRecord.path },
      ],
    };
  }

  if (contentDiffers(incoming, currentRecord)) {
    return conflictResult("UNVERIFIED_COMPATIBLE_MERGE", incoming, currentRecord, {
      evidenceIds,
      currentEvidenceIds,
    });
  }

  return {
    ...baseResult("merge", incoming, currentRecord),
    historyPolicy: "full-snapshot",
    requiresConfirmation: false,
    changedFields,
    mutations: [
      { operation: "snapshot-current", path: currentRecord.path },
      { operation: "replace-current", path: currentRecord.path },
    ],
  };
}

function normalizeControlledTopics(values, limit = 4) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();

  for (const rawValue of values) {
    let value = normalizeString(rawValue);
    if (!value) continue;
    value = value.replace(/^#+/u, "").trim();

    if (/^(?:行知|系统|状态|范围|来源|证据|生命周期)\//u.test(value)) continue;
    if (/^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?$/u.test(value)) continue;

    value = value.replace(/^(?:主题\/)+/u, "");
    value = value.replace(/^(?:主题[-_:：])+?/u, "").trim();
    value = TOPIC_ALIASES.get(value) || value;

    if (!value || value.length > 16 || /[，。！？；,!?;]/u.test(value)) continue;
    const topic = `主题/${value}`;
    if (seen.has(topic)) continue;
    seen.add(topic);
    result.push(topic);
    if (result.length >= Math.max(0, limit)) break;
  }

  return result;
}

function classifyRetrievalIntent(query) {
  const text = normalizeString(query);
  const explicitlyHistorical = /(?:历史|旧版|历次|版本沿革|回溯|当时|曾经|之前的版本|版本(?:差异|变化|对比|比较)|(?:比较|对比)[\s\S]{0,30}(?:版本|\d{1,2}\s*月\s*\d{1,2}\s*日))/u.test(text);

  return {
    includeHistory: explicitlyHistorical,
    historyReason: explicitlyHistorical ? "explicit-version-comparison" : null,
    scope: explicitlyHistorical ? "current-and-history" : "current-only",
  };
}

module.exports = {
  ALLOWED_RECORD_CLASSES,
  classifyRetrievalIntent,
  detectMaterialContentChange,
  normalizeControlledTopics,
  resolveEntityMutation,
};
