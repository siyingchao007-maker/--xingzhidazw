"use strict";

const SETTINGS_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  candidateGeneration: true,
  persistence: true,
  existingRecordsReadOnly: false,
  shadowMode: false,
});
const EVENT_TYPES = new Set([
  "candidate.requested", "candidate.parsed", "candidate.rejected", "candidate.previewed",
  "candidate.persisted", "candidate.shadowed", "record.opened", "record.confirmed",
  "action.created", "feedback.created", "evidence.reviewed", "self-check.completed",
]);

function normalizeSettings(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    candidateGeneration: input.candidateGeneration !== false,
    persistence: input.persistence !== false,
    existingRecordsReadOnly: input.existingRecordsReadOnly === true,
    shadowMode: input.shadowMode === true,
  });
}

function createMetricEvent(type, payload = {}, at = new Date().toISOString()) {
  if (!EVENT_TYPES.has(type)) throw new Error(`不支持的 Judgment Kernel 指标事件：${type}`);
  if (Number.isNaN(Date.parse(at))) throw new Error("指标事件时间无效");
  const safe = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return Object.freeze({
    metricSchemaVersion: 1,
    type,
    at,
    success: safe.success !== false,
    durationMs: Number.isFinite(safe.durationMs) && safe.durationMs >= 0 ? Math.round(safe.durationMs) : null,
    reasonCode: typeof safe.reasonCode === "string" ? safe.reasonCode.slice(0, 160) : null,
    conversationId: typeof safe.conversationId === "string" ? safe.conversationId.slice(0, 160) : null,
    decisionId: typeof safe.decisionId === "string" ? safe.decisionId.slice(0, 160) : null,
    counts: safe.counts && typeof safe.counts === "object" && !Array.isArray(safe.counts)
      ? Object.fromEntries(Object.entries(safe.counts).filter(([, count]) => Number.isFinite(count)).map(([key, count]) => [String(key).slice(0, 80), Math.max(0, Math.round(count))]))
      : {},
  });
}

function aggregateMetrics(events) {
  const list = Array.isArray(events) ? events : [];
  const byType = {};
  let failures = 0;
  let durationTotal = 0;
  let durationCount = 0;
  for (const event of list) {
    if (!event || !EVENT_TYPES.has(event.type)) continue;
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (event.success === false) failures += 1;
    if (Number.isFinite(event.durationMs)) { durationTotal += event.durationMs; durationCount += 1; }
  }
  const requested = byType["candidate.requested"] || 0;
  const parsed = byType["candidate.parsed"] || 0;
  const persisted = byType["candidate.persisted"] || 0;
  return Object.freeze({
    totalEvents: list.length,
    failures,
    byType: Object.freeze({ ...byType }),
    candidateParseRate: requested ? parsed / requested : null,
    candidatePersistenceRate: parsed ? persisted / parsed : null,
    averageDurationMs: durationCount ? Math.round(durationTotal / durationCount) : null,
  });
}

module.exports = { SETTINGS_VERSION, DEFAULT_SETTINGS, EVENT_TYPES, normalizeSettings, createMetricEvent, aggregateMetrics };
