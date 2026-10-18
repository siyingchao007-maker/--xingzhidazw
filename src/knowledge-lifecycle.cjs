"use strict";

const crypto = require("node:crypto");
const { deriveKnowledgeCardPresentation } = require("./knowledge-card-presentation.cjs");

const FORMAL_ROOTS = new Set([
  "01_当前的我", "02_我的历史", "03_环境", "04_关系", "05_目标与项目",
  "06_判断与决策", "07_行动", "08_结果与反馈", "09_认知资产", "11_证据与来源",
]);
const SOURCE_ONLY_PREFIXES = Object.freeze([
  "11_证据与来源/对话与访谈/",
  "11_证据与来源/外部文档/",
]);
const MAX_RECORDS = 2_000;
const MAX_RECORD_CONTENT = 500_000;
const MAX_CANDIDATES = 1_000;
const CONTENT_PREVIEW = 500;

const STATUS_TAGS = Object.freeze({
  active: "行知/状态/有效",
  valid: "行知/状态/有效",
  pending: "行知/状态/待验证",
  historical: "行知/状态/已过期",
  superseded: "行知/状态/被替代",
  rejected: "行知/状态/已否定",
});

function canonicalKnowledgeContent(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, "");
}

function safePath(value) {
  const path = typeof value === "string" ? value.replaceAll("\\", "/").trim() : "";
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("../") || path.includes("//")) return null;
  if (!/\.md$/iu.test(path)) return null;
  return path;
}

function eligibleRecord(value) {
  if (!value || value.generated !== true || value.malformed === true) return false;
  const path = safePath(value.path);
  if (!path || !FORMAL_ROOTS.has(path.split("/")[0])) return false;
  if (SOURCE_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (typeof value.knowledgeId !== "string" || !value.knowledgeId.trim()) return false;
  if (typeof value.knowledgeType !== "string" || !value.knowledgeType.trim()) return false;
  if (typeof value.key !== "string" || !value.key.trim()) return false;
  if (typeof value.content !== "string" || !value.content.trim()) return false;
  if (value.content.length > MAX_RECORD_CONTENT) throw new Error("知识内容超过生命周期安全扫描上限");
  return true;
}

function normalizeRecord(value) {
  const content = String(value.content);
  return Object.freeze({
    generated: true,
    malformed: false,
    path: safePath(value.path),
    knowledgeId: String(value.knowledgeId).slice(0, 200),
    knowledgeType: String(value.knowledgeType).slice(0, 100),
    epistemicStatus: String(value.epistemicStatus || "unknown").slice(0, 100),
    status: String(value.status || "active").slice(0, 100),
    key: String(value.key).trim().slice(0, 500),
    title: String(value.title || value.key).trim().slice(0, 500),
    content,
    summary: typeof value.summary === "string" ? value.summary.slice(0, 4_000) : "",
    keyPoints: (Array.isArray(value.keyPoints) ? value.keyPoints : [])
      .filter((item) => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 5),
    suggestedUses: (Array.isArray(value.suggestedUses) ? value.suggestedUses : [])
      .filter((item) => typeof item === "string").map((item) => item.slice(0, 300)).slice(0, 3),
    context: String(value.context || "").trim().slice(0, 8_000),
    effectiveFrom: typeof value.effectiveFrom === "string" && value.effectiveFrom ? value.effectiveFrom.slice(0, 100) : null,
    effectiveUntil: typeof value.effectiveUntil === "string" && value.effectiveUntil ? value.effectiveUntil.slice(0, 100) : null,
    tags: [...new Set((Array.isArray(value.tags) ? value.tags : []).filter((item) => typeof item === "string").map((item) => item.slice(0, 200)))].slice(0, 100),
    aliases: [...new Set((Array.isArray(value.aliases) ? value.aliases : []).filter((item) => typeof item === "string").map((item) => item.slice(0, 200)))].slice(0, 100),
    relatedKnowledge: (Array.isArray(value.relatedKnowledge) ? value.relatedKnowledge : []).slice(0, 100),
    sourceConversationPath: safePath(value.sourceConversationPath) || null,
    sourceMessageId: typeof value.sourceMessageId === "string" ? value.sourceMessageId.slice(0, 500) : null,
    sourceDocuments: [...new Set((Array.isArray(value.sourceDocuments) ? value.sourceDocuments : []).filter((item) => typeof item === "string").map((item) => item.slice(0, 1_024)))].slice(0, 100),
    lifecycleGroupId: typeof value.lifecycleGroupId === "string" ? value.lifecycleGroupId.slice(0, 200) : null,
    supersedes: [...new Set((Array.isArray(value.supersedes) ? value.supersedes : []).filter((item) => typeof item === "string").map((item) => item.slice(0, 200)))].slice(0, 100),
    supersededBy: typeof value.supersededBy === "string" ? value.supersededBy.slice(0, 200) : null,
    mergedFrom: [...new Set((Array.isArray(value.mergedFrom) ? value.mergedFrom : []).filter((item) => typeof item === "string").map((item) => item.slice(0, 200)))].slice(0, 100),
    lifecycleSources: (Array.isArray(value.lifecycleSources) ? value.lifecycleSources : []).slice(0, 100),
    lifecycleUpdatedAt: typeof value.lifecycleUpdatedAt === "string" ? value.lifecycleUpdatedAt.slice(0, 100) : null,
    lifecycleReason: typeof value.lifecycleReason === "string" ? value.lifecycleReason.slice(0, 1_000) : null,
    contentFingerprint: typeof value.contentFingerprint === "string" ? value.contentFingerprint.slice(0, 128) : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.slice(0, 100) : null,
    expectedHash: typeof value.contentHash === "string" ? value.contentHash.slice(0, 128) : null,
  });
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceIdentity(record) {
  return JSON.stringify({
    conversation: record.sourceConversationPath || "",
    message: record.sourceMessageId || "",
    documents: [...record.sourceDocuments].sort(),
  });
}

function exactIdentity(record) {
  return JSON.stringify({
    content: canonicalKnowledgeContent(record.content),
    context: canonicalKnowledgeContent(record.context),
    epistemicStatus: record.epistemicStatus,
    status: record.status,
    effectiveFrom: record.effectiveFrom || "",
    effectiveUntil: record.effectiveUntil || "",
  });
}

function candidateId(kind, records) {
  const identities = records.map((item) => `${item.knowledgeId}\0${item.path}`).sort();
  return crypto.createHash("sha256").update(`${kind}\0${identities.join("\0")}`).digest("hex").slice(0, 24);
}

function member(record) {
  const presentation = deriveKnowledgeCardPresentation({
    title: record.title,
    type: record.knowledgeType,
    content: record.content,
    summary: record.summary,
    keyPoints: record.keyPoints,
    suggestedUses: record.suggestedUses,
  });
  return Object.freeze({
    knowledgeId: record.knowledgeId,
    path: record.path,
    title: record.title,
    knowledgeType: record.knowledgeType,
    key: record.key,
    status: record.status,
    epistemicStatus: record.epistemicStatus,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    updatedAt: record.updatedAt,
    context: record.context,
    contentPreview: presentation.summary.slice(0, CONTENT_PREVIEW),
    contentTruncated: presentation.summaryTruncated,
    keyPoints: Object.freeze([...presentation.keyPoints]),
    suggestedUses: Object.freeze([...presentation.suggestedUses]),
    presentationSource: presentation.presentationSource,
    sourceConversationPath: record.sourceConversationPath,
    sourceMessageId: record.sourceMessageId,
    sourceDocuments: [...record.sourceDocuments],
    lifecycleGroupId: record.lifecycleGroupId,
    supersedes: [...record.supersedes],
    supersededBy: record.supersededBy,
    mergedFrom: [...record.mergedFrom],
    lifecycleUpdatedAt: record.lifecycleUpdatedAt,
    lifecycleReason: record.lifecycleReason,
    expectedHash: record.expectedHash,
  });
}

function hasResolvedVersionChain(records) {
  const current = records.filter((record) => !["superseded", "historical", "rejected"].includes(record.status));
  if (current.length !== 1) return false;
  const successor = current[0];
  const old = records.filter((record) => record !== successor);
  return old.length > 0 && old.every((record) => (
    record.status === "superseded"
    && record.supersededBy === successor.knowledgeId
    && successor.supersedes.includes(record.knowledgeId)
    && record.lifecycleGroupId
    && record.lifecycleGroupId === successor.lifecycleGroupId
  ));
}

function addCandidate(list, input) {
  if (list.length >= MAX_CANDIDATES) throw new Error("生命周期候选超过安全扫描上限");
  const records = [...input.records].sort((left, right) => lexicalCompare(left.path, right.path));
  list.push(Object.freeze({
    id: candidateId(input.kind, records),
    kind: input.kind,
    confidence: input.confidence,
    recommendedAction: input.recommendedAction,
    automaticEligible: input.automaticEligible === true,
    reasons: Object.freeze([...input.reasons]),
    blockingReasons: Object.freeze([...(input.blockingReasons || [])]),
    memberPaths: Object.freeze(records.map((item) => item.path)),
    members: Object.freeze(records.map(member)),
    distinctSourceCount: new Set(records.map(sourceIdentity)).size,
    similarity: typeof input.similarity === "number" ? Number(input.similarity.toFixed(3)) : null,
  }));
}

function charSet(value) {
  return new Set([...canonicalKnowledgeContent(value)].slice(0, 8_000));
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function nearSimilarity(left, right) {
  const title = dice(charSet(`${left.title}${left.aliases.join("")}`), charSet(`${right.title}${right.aliases.join("")}`));
  const content = dice(charSet(left.content), charSet(right.content));
  if (title < 0.68 || content < 0.68) return 0;
  return (title * 0.45) + (content * 0.55);
}

function pairKey(left, right) {
  return [left.path, right.path].sort().join("\0");
}

function scanKnowledgeLifecycle(input = {}) {
  const supplied = Array.isArray(input.records) ? input.records : [];
  if (supplied.length > MAX_RECORDS) throw new Error("知识数量超过生命周期安全扫描上限");
  const records = supplied.filter(eligibleRecord).map(normalizeRecord)
    .sort((left, right) => lexicalCompare(left.path, right.path));
  const candidates = [];
  const paired = new Set();

  for (const group of groupBy(records, (item) => `${item.knowledgeType}\0${item.key}`).values()) {
    if (group.length < 2) continue;
    const exactGroups = [...groupBy(group, exactIdentity).values()].filter((items) => items.length > 1);
    for (const exact of exactGroups) {
      const sources = new Set(exact.map(sourceIdentity));
      addCandidate(candidates, {
        kind: "exact-duplicate",
        records: exact,
        confidence: "high",
        recommendedAction: "archive-duplicate",
        automaticEligible: sources.size === 1,
        reasons: ["知识类型、稳定知识键、规范化正文、上下文、状态和有效期一致。"],
        blockingReasons: sources.size === 1 ? [] : ["重复知识包含不同来源，必须先把所有来源保留到权威知识。"],
      });
      for (let left = 0; left < exact.length; left += 1) {
        for (let right = left + 1; right < exact.length; right += 1) paired.add(pairKey(exact[left], exact[right]));
      }
    }
    if (new Set(group.map(exactIdentity)).size > 1 && !hasResolvedVersionChain(group)) {
      addCandidate(candidates, {
        kind: "same-key-version",
        records: group,
        confidence: "high",
        recommendedAction: "choose-version-relationship",
        automaticEligible: false,
        reasons: ["知识类型和稳定知识键相同，但正文、上下文、状态或有效期不同。"],
        blockingReasons: ["必须人工判断是时间更新、场景差异、内容补充还是矛盾。"],
      });
    }
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) paired.add(pairKey(group[left], group[right]));
    }
  }

  const contentGroups = groupBy(records, (item) => canonicalKnowledgeContent(item.content));
  for (const group of contentGroups.values()) {
    if (group.length < 2 || new Set(group.map((item) => item.knowledgeType)).size < 2) continue;
    addCandidate(candidates, {
      kind: "cross-type-copy",
      records: group,
      confidence: "high",
      recommendedAction: "review-classification",
      automaticEligible: false,
      reasons: ["规范化正文完全相同，但知识类型不同。"],
      blockingReasons: ["同一表达可能同时支撑多个知识类型，不能按重复内容自动删除。"],
    });
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) paired.add(pairKey(group[left], group[right]));
    }
  }

  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const a = records[left];
      const b = records[right];
      if (a.knowledgeType !== b.knowledgeType || paired.has(pairKey(a, b))) continue;
      const similarity = nearSimilarity(a, b);
      if (similarity < 0.7) continue;
      addCandidate(candidates, {
        kind: "near-duplicate",
        records: [a, b],
        confidence: "medium",
        recommendedAction: "review-similarity",
        automaticEligible: false,
        similarity,
        reasons: [`标题和正文的本地字符重合度为 ${Math.round(similarity * 100)}%。`],
        blockingReasons: ["相似度只用于召回候选，不能证明两条知识语义等同。"],
      });
      paired.add(pairKey(a, b));
    }
  }

  const now = Date.parse(typeof input.now === "string" ? input.now : new Date().toISOString());
  for (const record of records) {
    const until = record.effectiveUntil ? Date.parse(record.effectiveUntil) : Number.NaN;
    if ((record.status === "active" || record.status === "valid") && Number.isFinite(until) && until < now) {
      addCandidate(candidates, {
        kind: "expired-active",
        records: [record],
        confidence: "high",
        recommendedAction: "mark-historical",
        automaticEligible: false,
        reasons: ["有效截止时间已经过去，但知识状态仍为有效。"],
        blockingReasons: ["状态变化仍需人工确认，避免把日期录入错误当成真实失效。"],
      });
    }
    const expectedTag = STATUS_TAGS[record.status];
    const statusTags = record.tags.filter((tag) => tag.startsWith("行知/状态/"));
    if (expectedTag && statusTags.length && !statusTags.includes(expectedTag)) {
      addCandidate(candidates, {
        kind: "status-inconsistent",
        records: [record],
        confidence: "high",
        recommendedAction: "repair-status-metadata",
        automaticEligible: true,
        reasons: [`正式状态为 ${record.status}，但状态标签没有对应为 ${expectedTag}。`],
        blockingReasons: [],
      });
    }
  }

  const counts = Object.create(null);
  for (const candidate of candidates) counts[candidate.kind] = (counts[candidate.kind] || 0) + 1;
  candidates.sort((left, right) => lexicalCompare(left.kind, right.kind) || lexicalCompare(left.id, right.id));
  return Object.freeze({
    generatedAt: typeof input.now === "string" ? input.now : new Date().toISOString(),
    totals: Object.freeze({
      scanned: records.length,
      candidates: candidates.length,
      exactDuplicates: counts["exact-duplicate"] || 0,
      sameKeyVersions: counts["same-key-version"] || 0,
      crossTypeCopies: counts["cross-type-copy"] || 0,
      nearDuplicates: counts["near-duplicate"] || 0,
      expiredActive: counts["expired-active"] || 0,
      statusInconsistent: counts["status-inconsistent"] || 0,
    }),
    candidates: Object.freeze(candidates),
  });
}

module.exports = {
  FORMAL_ROOTS,
  canonicalKnowledgeContent,
  scanKnowledgeLifecycle,
};
