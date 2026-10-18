"use strict";

const crypto = require("node:crypto");

const MAX_CHECKPOINT_ITEMS = 2_000;
const MAX_DELTA_ITEMS = 50;
const CHECKPOINT_ID = /^review-checkpoint-[a-f0-9]{16}$/u;

function boundedText(value, maximum, fallback = "") {
  const text = String(value ?? "").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, maximum);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeCheckpointPath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || path.length > 1_024 || path.startsWith("/") || !path.endsWith(".md")
    || /[\u0000-\u001f]/u.test(path)
    || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("review checkpoint 路径无效");
  }
  return path;
}

function timeEvidenceFor(item) {
  if (item.updatedAt) return { observedAt: item.updatedAt, basis: "updatedAt", confidence: "declared" };
  if (item.createdAt) return { observedAt: item.createdAt, basis: "createdAt", confidence: "declared" };
  return { observedAt: null, basis: "content-hash-only", confidence: "missing" };
}

function normalizeCheckpointItem(value) {
  const path = normalizeCheckpointPath(value?.path);
  const contentHash = boundedText(value?.contentHash, 64).toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) throw new Error(`review checkpoint 内容哈希无效：${path}`);
  const createdAt = isoOrNull(value?.createdAt);
  const updatedAt = isoOrNull(value?.updatedAt);
  const item = {
    path,
    contentHash,
    createdAt,
    updatedAt,
    knowledgeType: boundedText(value?.knowledgeType, 80, "note"),
    sourceClass: boundedText(value?.sourceClass, 80, "formal-knowledge"),
  };
  return { ...item, timeEvidence: timeEvidenceFor(item) };
}

function checkpointDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify({
    generatedAt: value.generatedAt,
    sourceReviewId: value.sourceReviewId,
    items: value.items,
  }), "utf8").digest("hex").slice(0, 16);
}

function createReviewKnowledgeCheckpoint({ items = [], generatedAt, sourceReviewId = null } = {}) {
  const normalizedGeneratedAt = isoOrNull(generatedAt);
  if (!normalizedGeneratedAt) throw new Error("review checkpoint 生成时间无效");
  if (!Array.isArray(items) || items.length > MAX_CHECKPOINT_ITEMS) {
    throw new Error("review checkpoint 条目数量超过安全上限");
  }
  const normalizedItems = items.map(normalizeCheckpointItem)
    .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  const seen = new Set();
  for (const item of normalizedItems) {
    if (seen.has(item.path)) throw new Error(`review checkpoint 路径重复：${item.path}`);
    seen.add(item.path);
  }
  const normalizedSourceReviewId = boundedText(sourceReviewId, 96) || null;
  const timeEvidence = normalizedItems.reduce((counts, item) => {
    counts[item.timeEvidence.confidence === "declared" ? "declared" : "missing"] += 1;
    return counts;
  }, { declared: 0, missing: 0 });
  const checkpoint = {
    schemaVersion: 1,
    generatedAt: normalizedGeneratedAt,
    sourceReviewId: normalizedSourceReviewId,
    itemCount: normalizedItems.length,
    timeEvidence,
    items: normalizedItems,
  };
  return {
    ...checkpoint,
    id: `review-checkpoint-${checkpointDigest(checkpoint)}`,
  };
}

function normalizeReviewKnowledgeCheckpoint(value) {
  if (!value || value.schemaVersion !== 1 || !CHECKPOINT_ID.test(String(value.id || ""))) return null;
  try {
    const normalized = createReviewKnowledgeCheckpoint({
      items: value.items,
      generatedAt: value.generatedAt,
      sourceReviewId: value.sourceReviewId,
    });
    return normalized.id === value.id ? normalized : null;
  } catch {
    return null;
  }
}

function checkpointReference(item) {
  return {
    path: item.path,
    contentHash: item.contentHash,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    knowledgeType: item.knowledgeType,
    sourceClass: item.sourceClass,
    timeEvidence: { ...item.timeEvidence },
  };
}

function buildReviewKnowledgeDelta({ currentCheckpoint, previousCheckpoint = null } = {}) {
  const current = normalizeReviewKnowledgeCheckpoint(currentCheckpoint);
  if (!current) throw new Error("当前 review checkpoint 无效");
  const previous = normalizeReviewKnowledgeCheckpoint(previousCheckpoint);
  if (!previous) {
    return {
      schemaVersion: 1,
      status: "NO_CHECKPOINT",
      baselineEstablished: true,
      fromCheckpointId: null,
      toCheckpointId: current.id,
      window: { from: null, to: current.generatedAt },
      counts: { added: 0, updated: 0, removed: 0, unchanged: 0 },
      added: [],
      updated: [],
      removed: [],
      truncated: false,
      timeEvidence: { ...current.timeEvidence },
      unknowns: ["没有可用的上次复盘 checkpoint；本次只建立基线，不把现有知识误报为新增。"],
    };
  }

  const before = new Map(previous.items.map((item) => [item.path, item]));
  const after = new Map(current.items.map((item) => [item.path, item]));
  const added = [];
  const updated = [];
  const removed = [];
  let unchanged = 0;

  for (const item of current.items) {
    const old = before.get(item.path);
    if (!old) {
      added.push(checkpointReference(item));
      continue;
    }
    if (old.contentHash === item.contentHash) {
      unchanged += 1;
      continue;
    }
    updated.push({
      path: item.path,
      before: checkpointReference(old),
      after: checkpointReference(item),
    });
  }
  for (const item of previous.items) {
    if (!after.has(item.path)) removed.push(checkpointReference(item));
  }

  const truncated = added.length > MAX_DELTA_ITEMS
    || updated.length > MAX_DELTA_ITEMS
    || removed.length > MAX_DELTA_ITEMS;
  return {
    schemaVersion: 1,
    status: "DELTA_AVAILABLE",
    baselineEstablished: true,
    fromCheckpointId: previous.id,
    toCheckpointId: current.id,
    window: { from: previous.generatedAt, to: current.generatedAt },
    counts: {
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      unchanged,
    },
    added: added.slice(0, MAX_DELTA_ITEMS),
    updated: updated.slice(0, MAX_DELTA_ITEMS),
    removed: removed.slice(0, MAX_DELTA_ITEMS),
    truncated,
    timeEvidence: { ...current.timeEvidence },
    unknowns: current.timeEvidence.missing
      ? [`有 ${current.timeEvidence.missing} 条记录缺少声明时间；变化判断依赖内容哈希，不能推断实际发生时间。`]
      : [],
  };
}

module.exports = {
  MAX_CHECKPOINT_ITEMS,
  createReviewKnowledgeCheckpoint,
  normalizeReviewKnowledgeCheckpoint,
  buildReviewKnowledgeDelta,
};
