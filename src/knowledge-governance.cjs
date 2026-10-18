"use strict";

const { classifyKnowledgeGovernanceRisk } = require("./knowledge-governance-risk.cjs");

const GOVERNANCE_VERSION = 3;
const MAX_GOVERNANCE_ITEMS = 1_000;
const MAX_RESOLVED_ITEMS = 200;
const MAX_PATHS = 12;
const MAX_REASONS = 8;

const PRIORITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });
const ISSUE_CATEGORY = Object.freeze({
  "duplicate-agent-definition": "capability-definition",
  "duplicate-skill-definition": "capability-definition",
  "duplicate-knowledge-id": "content-duplicate",
  "broken-related-link": "source-integrity",
  "malformed-knowledge-note": "source-integrity",
  "legacy-schema": "structure-quality",
  "invalid-knowledge-id": "structure-quality",
  "unsupported-knowledge-type": "structure-quality",
  "knowledge-root-mismatch": "structure-quality",
  "damaged-index-markers": "structure-quality",
  "missing-index-file": "structure-quality",
  "index-unlisted": "structure-quality",
  "unstructured-knowledge-note": "classification",
  "semantic-structure-incomplete": "structure-quality",
  "missing-source-provenance": "source-integrity",
  "knowledge-split-candidate": "structure-quality",
});
const LIFECYCLE_CATEGORY = Object.freeze({
  "exact-duplicate": "content-duplicate",
  "near-duplicate": "content-duplicate",
  "same-key-version": "version-conflict",
  "cross-type-copy": "classification",
  "expired-active": "freshness-status",
  "status-inconsistent": "freshness-status",
});
const LIFECYCLE_TITLE = Object.freeze({
  "exact-duplicate": "发现精确重复知识",
  "near-duplicate": "发现近似重复知识",
  "same-key-version": "发现同主题多版本知识",
  "cross-type-copy": "发现跨类型重复表达",
  "expired-active": "知识有效期已过但仍标记有效",
  "status-inconsistent": "知识状态与标签不一致",
});

function boundedText(value, maximum, fallback = "") {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim() : "";
  return (text || fallback).slice(0, maximum);
}

function timestamp(value, fallback = null) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function governanceId(value) {
  const id = boundedText(value, 220);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,219}$/u.test(id) ? id : null;
}

function safeMarkdownPath(value) {
  const path = boundedText(value, 1_024).replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.includes("//") || !/\.md$/iu.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

function cleanStrings(values, maximumItems, maximumLength) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = boundedText(value, maximumLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maximumItems) break;
  }
  return result;
}

function cleanPaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const path = safeMarkdownPath(value);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
    if (result.length >= MAX_PATHS) break;
  }
  return result;
}

function issuePriority(severity) {
  if (severity === "critical" || severity === "error") return "high";
  if (severity === "warning") return "medium";
  return "low";
}

function lifecyclePriority(candidate) {
  if (candidate?.kind === "same-key-version" || candidate?.kind === "exact-duplicate") return "high";
  return candidate?.confidence === "high" ? "medium" : "low";
}

function findingFromIssue(issue) {
  const sourceId = governanceId(issue?.id);
  if (!sourceId) return null;
  const path = safeMarkdownPath(issue?.path);
  const risk = classifyKnowledgeGovernanceRisk({
    sourceKind: "health-issue",
    code: issue?.code,
    path,
    title: issue?.title,
    message: issue?.message,
    repair: issue?.repair,
  });
  return {
    id: `issue:${sourceId}`,
    sourceKind: "health-issue",
    sourceId,
    findingCode: boundedText(issue?.code, 120, "unknown"),
    category: ISSUE_CATEGORY[issue?.code] || "structure-quality",
    priority: issuePriority(issue?.severity),
    confidence: "rule-based",
    actionMode: issue?.repair?.mode === "automatic"
      ? "automatic" : issue?.repair?.mode === "agent" ? "agent" : "manual",
    recommendedAction: boundedText(issue?.repair?.kind, 100, "manual-review"),
    title: boundedText(issue?.title, 240, "需要检查的知识问题"),
    summary: boundedText(issue?.message, 1_200, "当前扫描发现一项需要处理的问题。"),
    recommendation: boundedText(issue?.recommendation, 1_000, "打开相关知识核对后重新扫描。"),
    reasons: [],
    paths: path ? [path] : [],
    ...risk,
  };
}

function findingFromLifecycle(candidate) {
  const sourceId = governanceId(candidate?.id);
  if (!sourceId) return null;
  const memberTitles = cleanStrings(
    (Array.isArray(candidate?.members) ? candidate.members : []).map((member) => member?.title),
    4,
    160,
  );
  const reasons = cleanStrings([
    ...(Array.isArray(candidate?.reasons) ? candidate.reasons : []),
    ...(Array.isArray(candidate?.blockingReasons) ? candidate.blockingReasons : []),
  ], MAX_REASONS, 500);
  const summaryParts = [memberTitles.length ? `涉及：${memberTitles.join("、")}` : "", reasons[0] || ""]
    .filter(Boolean);
  const risk = classifyKnowledgeGovernanceRisk({
    sourceKind: "lifecycle-candidate",
    code: candidate?.kind,
    paths: candidate?.memberPaths,
    message: reasons.join("；"),
  });
  return {
    id: `lifecycle:${sourceId}`,
    sourceKind: "lifecycle-candidate",
    sourceId,
    findingCode: boundedText(candidate?.kind, 120, "unknown"),
    category: LIFECYCLE_CATEGORY[candidate?.kind] || "version-conflict",
    priority: lifecyclePriority(candidate),
    confidence: ["high", "medium", "low"].includes(candidate?.confidence) ? candidate.confidence : "rule-based",
    actionMode: candidate?.automaticEligible === true ? "confirm-required" : "manual",
    recommendedAction: boundedText(candidate?.recommendedAction, 100, "manual-review"),
    title: LIFECYCLE_TITLE[candidate?.kind] || "发现知识生命周期候选",
    summary: boundedText(summaryParts.join("；"), 1_200, "需要比较相关知识并判断关系。"),
    recommendation: candidate?.automaticEligible === true
      ? "规则依据较明确，但仍须先预览并确认后处理。"
      : "需要人工判断事实、场景、分类或版本关系，系统不会自动选边。",
    reasons,
    paths: cleanPaths(candidate?.memberPaths),
    ...risk,
  };
}

function reportFindings(report) {
  const result = [];
  for (const issue of Array.isArray(report?.issues) ? report.issues : []) {
    const finding = findingFromIssue(issue);
    if (finding) result.push(finding);
  }
  for (const candidate of Array.isArray(report?.lifecycle?.candidates) ? report.lifecycle.candidates : []) {
    const finding = findingFromLifecycle(candidate);
    if (finding) result.push(finding);
  }
  const unique = new Map();
  for (const item of result) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()].sort((left, right) => (
    PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      || left.category.localeCompare(right.category, "zh-CN")
      || left.id.localeCompare(right.id, "zh-CN")
  ));
}

function normalizeItem(value, { resolved = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = governanceId(value.id);
  const sourceId = governanceId(value.sourceId);
  const sourceKind = value.sourceKind === "health-issue" || value.sourceKind === "lifecycle-candidate"
    ? value.sourceKind : null;
  if (!id || !sourceId || !sourceKind) return null;
  const firstSeenAt = timestamp(value.firstSeenAt);
  const lastSeenAt = timestamp(value.lastSeenAt);
  if (!firstSeenAt || !lastSeenAt) return null;
  const resolvedAt = resolved ? timestamp(value.resolvedAt) : null;
  if (resolved && !resolvedAt) return null;
  const findingCode = boundedText(value.findingCode, 120, value.sourceId);
  const risk = classifyKnowledgeGovernanceRisk({
    sourceKind,
    code: findingCode,
    paths: value.paths,
    title: value.title,
    message: value.summary,
    repair: value.actionMode === "automatic" ? { mode: "automatic" } : null,
  });
  return {
    id,
    sourceKind,
    sourceId,
    findingCode,
    category: boundedText(value.category, 80, "structure-quality"),
    priority: Object.hasOwn(PRIORITY_ORDER, value.priority) ? value.priority : "low",
    confidence: boundedText(value.confidence, 40, "rule-based"),
    actionMode: ["automatic", "confirm-required", "manual", "agent"].includes(value.actionMode)
      ? value.actionMode : "manual",
    recommendedAction: boundedText(value.recommendedAction, 100, "manual-review"),
    title: boundedText(value.title, 240, "需要检查的知识问题"),
    summary: boundedText(value.summary, 1_200, "当前扫描发现一项需要处理的问题。"),
    recommendation: boundedText(value.recommendation, 1_000, "核对后重新扫描。"),
    reasons: cleanStrings(value.reasons, MAX_REASONS, 500),
    paths: cleanPaths(value.paths),
    processingLevel: risk.processingLevel,
    handlingMode: risk.handlingMode,
    agentStatus: ["running", "completed", "failed", "interrupted", "applied"].includes(value.processing?.status) ? value.processing.status : risk.agentStatus,
    processing: value.processing && ["running", "completed", "failed", "interrupted", "applied"].includes(value.processing.status) ? {
      status: value.processing.status,
      updatedAt: timestamp(value.processing.updatedAt),
      summary: boundedText(value.processing.summary, 1_200),
      error: boundedText(value.processing.error, 500),
    } : null,
    riskReasons: cleanStrings(value.riskReasons?.length ? value.riskReasons : risk.riskReasons, MAX_REASONS, 500),
    decisionQuestion: boundedText(value.decisionQuestion, 1_000, risk.decisionQuestion),
    firstSeenAt,
    lastSeenAt,
    seenCount: Number.isSafeInteger(value.seenCount) && value.seenCount > 0
      ? Math.min(value.seenCount, 1_000_000) : 1,
    reviewStatus: resolved ? "resolved" : (value.reviewStatus === "deferred" ? "deferred" : "open"),
    deferredAt: !resolved && value.reviewStatus === "deferred" ? timestamp(value.deferredAt) : null,
    ...(resolved ? { resolvedAt } : {}),
  };
}

function handlingTotals(items) {
  return {
    agentQueued: items.filter((item) => ["queued", "running", "interrupted"].includes(item.agentStatus)).length,
    agentCompleted: items.filter((item) => item.agentStatus === "completed").length,
    appliedPending: items.filter((item) => item.agentStatus === "applied").length,
    humanReview: items.filter((item) => item.handlingMode === "human-review").length,
    systemFailed: items.filter((item) => item.handlingMode === "system-failed" || item.agentStatus === "failed").length,
  };
}

function emptyState() {
  return {
    version: GOVERNANCE_VERSION,
    lastScanAt: null,
    scanCount: 0,
    limited: false,
    totals: {
      scanned: 0, valid: 0, current: 0, persisted: 0, deferred: 0, resolved: 0, omitted: 0,
      agentQueued: 0, agentCompleted: 0, humanReview: 0, systemFailed: 0,
    },
    items: [],
    resolved: [],
  };
}

function normalizeKnowledgeGovernanceState(value, { restore = false } = {}) {
  const base = emptyState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const items = [];
  const itemIds = new Set();
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    const item = normalizeItem(raw);
    if (!item || itemIds.has(item.id)) continue;
    if (restore && item.processing?.status === "running") {
      item.processing.status = "interrupted";
      item.processing.error = "上次分析未完成，需要重新分析。";
      item.agentStatus = "interrupted";
    }
    itemIds.add(item.id);
    items.push(item);
    if (items.length >= MAX_GOVERNANCE_ITEMS) break;
  }
  const resolved = [];
  const resolvedIds = new Set();
  for (const raw of Array.isArray(value.resolved) ? value.resolved : []) {
    const item = normalizeItem(raw, { resolved: true });
    if (!item || itemIds.has(item.id) || resolvedIds.has(item.id)) continue;
    resolvedIds.add(item.id);
    resolved.push(item);
    if (resolved.length >= MAX_RESOLVED_ITEMS) break;
  }
  const lastScanAt = timestamp(value.lastScanAt);
  const scanCount = Number.isSafeInteger(value.scanCount) && value.scanCount >= 0
    ? Math.min(value.scanCount, 1_000_000) : 0;
  const omitted = Number.isSafeInteger(value?.totals?.omitted) && value.totals.omitted > 0
    ? Math.min(value.totals.omitted, 1_000_000) : 0;
  return {
    version: GOVERNANCE_VERSION,
    lastScanAt,
    scanCount,
    limited: omitted > 0,
    totals: {
      scanned: Number.isSafeInteger(value?.totals?.scanned) && value.totals.scanned >= 0 ? value.totals.scanned : 0,
      valid: Number.isSafeInteger(value?.totals?.valid) && value.totals.valid >= 0 ? value.totals.valid : 0,
      current: items.length + omitted,
      persisted: items.length,
      deferred: items.filter((item) => item.reviewStatus === "deferred").length,
      resolved: resolved.length,
      omitted,
      ...handlingTotals(items),
    },
    items,
    resolved,
  };
}

function reconcileKnowledgeGovernance({ previous, report, now } = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("知识治理需要有效的知识体检报告");
  }
  const scannedAt = timestamp(now || report.generatedAt || new Date().toISOString());
  if (!scannedAt) throw new Error("知识治理扫描时间无效");
  const prior = normalizeKnowledgeGovernanceState(previous);
  const priorById = new Map(prior.items.map((item) => [item.id, item]));
  const allFindings = reportFindings(report);
  const omitted = Math.max(0, allFindings.length - MAX_GOVERNANCE_ITEMS);
  const findings = allFindings.slice(0, MAX_GOVERNANCE_ITEMS);
  const items = findings.map((finding) => {
    const old = priorById.get(finding.id);
    return normalizeItem({
      ...finding,
      processing: old?.processing || null,
      firstSeenAt: old?.firstSeenAt || scannedAt,
      lastSeenAt: scannedAt,
      seenCount: Math.min((old?.seenCount || 0) + 1, 1_000_000),
      reviewStatus: old?.reviewStatus === "deferred" ? "deferred" : "open",
      deferredAt: old?.reviewStatus === "deferred" ? old.deferredAt : null,
    });
  });
  const currentIds = new Set(allFindings.map((item) => item.id));
  const newlyResolved = prior.items
    .filter((item) => !currentIds.has(item.id))
    .map((item) => ({ ...item, reviewStatus: "resolved", deferredAt: null, resolvedAt: scannedAt }));
  const resolved = [...newlyResolved, ...prior.resolved.filter((item) => !currentIds.has(item.id))]
    .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt) || left.id.localeCompare(right.id, "zh-CN"))
    .filter((item, index, array) => array.findIndex((other) => other.id === item.id) === index)
    .slice(0, MAX_RESOLVED_ITEMS);
  return {
    version: GOVERNANCE_VERSION,
    lastScanAt: scannedAt,
    scanCount: Math.min(prior.scanCount + 1, 1_000_000),
    limited: omitted > 0,
    totals: {
      scanned: Number.isSafeInteger(report?.totals?.scanned) && report.totals.scanned >= 0 ? report.totals.scanned : 0,
      valid: Number.isSafeInteger(report?.totals?.valid) && report.totals.valid >= 0 ? report.totals.valid : 0,
      current: allFindings.length,
      persisted: items.length,
      deferred: items.filter((item) => item.reviewStatus === "deferred").length,
      resolved: resolved.length,
      omitted,
      ...handlingTotals(items),
    },
    items,
    resolved,
  };
}

function recordGovernanceProcessing(state, itemId, processing) {
  const next = normalizeKnowledgeGovernanceState(state);
  const item = next.items.find(entry => entry.id === itemId);
  if (!item) return next;
  item.processing = { ...processing, updatedAt: processing.updatedAt || new Date().toISOString() };
  return normalizeKnowledgeGovernanceState(next);
}

function recentResolvedCounts(state, now = new Date().toISOString()) {
  const resolved = normalizeKnowledgeGovernanceState(state).resolved;
  const age = row => Date.parse(now) - Date.parse(row.resolvedAt);
  return { days7: resolved.filter(row => age(row) >= 0 && age(row) <= 7 * 86400_000).length,
    days30: resolved.filter(row => age(row) >= 0 && age(row) <= 30 * 86400_000).length,
    historyLimited: resolved.length >= MAX_RESOLVED_ITEMS };
}

function setKnowledgeGovernanceReviewStatus(state, itemId, status, now = new Date().toISOString()) {
  if (status === "resolved") throw new Error("治理任务不能手动标记为已解决；必须在问题修复后重新扫描确认");
  if (status !== "open" && status !== "deferred") throw new Error("不支持的治理审核状态");
  const current = normalizeKnowledgeGovernanceState(state);
  const id = governanceId(itemId);
  const index = current.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("找不到治理任务，可能已在重新扫描后变化");
  const changedAt = status === "deferred" ? timestamp(now) : null;
  if (status === "deferred" && !changedAt) throw new Error("暂缓时间无效");
  const items = current.items.map((item, itemIndex) => itemIndex === index ? {
    ...item,
    reviewStatus: status,
    deferredAt: changedAt,
  } : item);
  return {
    ...current,
    totals: {
      ...current.totals,
      deferred: items.filter((item) => item.reviewStatus === "deferred").length,
      ...handlingTotals(items),
    },
    items,
  };
}

module.exports = {
  GOVERNANCE_VERSION,
  recordGovernanceProcessing,
  recentResolvedCounts,
  MAX_GOVERNANCE_ITEMS,
  MAX_RESOLVED_ITEMS,
  normalizeKnowledgeGovernanceState,
  reconcileKnowledgeGovernance,
  setKnowledgeGovernanceReviewStatus,
};
