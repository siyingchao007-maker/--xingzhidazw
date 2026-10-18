"use strict";

const { validateVaultMarkdownPath } = require("./knowledge-writer.cjs");

const MAX_RECORDS = 2_000;
const MAX_COUNT = 1_000_000;
const ACTIVE_DAYS = 30;
const STALE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HISTORY_QUERY = /(?:历史|旧版|老版本|以前|之前|过去|曾经|当时|过期|追溯|复盘)/u;

function validTime(value) {
  return typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value));
}

function safePath(value) {
  try { return validateVaultMarkdownPath(String(value || "")); } catch { return null; }
}

function normalizeKnowledgeUsage(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const records = [];
  for (const [rawPath, raw] of Object.entries(value).slice(0, MAX_RECORDS * 2)) {
    const path = safePath(rawPath);
    if (!path || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!Number.isFinite(raw.count) || raw.count < 1 || !validTime(raw.firstUsedAt) || !validTime(raw.lastUsedAt)) continue;
    const firstUsedAt = raw.firstUsedAt;
    const lastUsedAt = raw.lastUsedAt;
    if (Date.parse(lastUsedAt) < Date.parse(firstUsedAt)) continue;
    records.push([path, {
      count: Math.min(MAX_COUNT, Math.floor(raw.count)),
      firstUsedAt,
      lastUsedAt,
    }]);
  }
  records.sort((left, right) => Date.parse(right[1].lastUsedAt) - Date.parse(left[1].lastUsedAt)
    || left[0].localeCompare(right[0], "zh-CN"));
  for (const [path, record] of records.slice(0, MAX_RECORDS)) result[path] = record;
  return result;
}

function recordKnowledgeUsage(value, paths, now = new Date().toISOString()) {
  if (!validTime(now)) throw new Error("知识调用时间无效");
  const result = normalizeKnowledgeUsage(value);
  const unique = new Set((Array.isArray(paths) ? paths : []).map(safePath).filter(Boolean));
  for (const path of unique) {
    const previous = result[path];
    result[path] = {
      count: Math.min(MAX_COUNT, Number(previous?.count || 0) + 1),
      firstUsedAt: previous?.firstUsedAt || now,
      lastUsedAt: now,
    };
  }
  return normalizeKnowledgeUsage(result);
}

function usagePresentation(record, now) {
  if (!record) return { usageCount: 0, firstUsedAt: null, lastUsedAt: null, usageBand: "discovery", autoEligible: true };
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(record.lastUsedAt)) / DAY_MS);
  const usageBand = ageDays <= ACTIVE_DAYS ? "active" : ageDays <= STALE_DAYS ? "cooling" : "stale";
  return {
    usageCount: record.count,
    firstUsedAt: record.firstUsedAt,
    lastUsedAt: record.lastUsedAt,
    usageBand,
    autoEligible: usageBand !== "stale",
  };
}

function rankKnowledgeCards(cards, usage, options = {}) {
  const now = validTime(options.now) ? options.now : new Date().toISOString();
  const normalized = normalizeKnowledgeUsage(usage);
  return (Array.isArray(cards) ? cards : []).map((card) => ({
    ...card,
    ...usagePresentation(normalized[card?.path], now),
  })).sort((left, right) => Number(right.autoEligible) - Number(left.autoEligible)
    || right.usageCount - left.usageCount
    || Date.parse(right.lastUsedAt || 0) - Date.parse(left.lastUsedAt || 0)
    || String(left.title || "").localeCompare(String(right.title || ""), "zh-CN")
    || String(left.path || "").localeCompare(String(right.path || ""), "zh-CN"));
}

function filterAutoInvocableResults(results, usage, options = {}) {
  const now = validTime(options.now) ? options.now : new Date().toISOString();
  const normalized = normalizeKnowledgeUsage(usage);
  const allowStale = options.allowStale === true || HISTORY_QUERY.test(String(options.query || ""));
  const kept = [];
  const suppressed = [];
  for (const result of Array.isArray(results) ? results : []) {
    const path = safePath(result?.path);
    const presentation = usagePresentation(path ? normalized[path] : null, now);
    if (!allowStale && !presentation.autoEligible) suppressed.push({ ...result, ...presentation });
    else kept.push({ ...result, ...presentation });
  }
  return { results: kept, suppressed, allowStale };
}

module.exports = {
  ACTIVE_DAYS,
  STALE_DAYS,
  filterAutoInvocableResults,
  normalizeKnowledgeUsage,
  rankKnowledgeCards,
  recordKnowledgeUsage,
};
