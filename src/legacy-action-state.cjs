"use strict";

const crypto = require("node:crypto");

const ACTION_STATUSES = new Set([
  "candidate", "pending", "in-progress", "waiting", "completed", "cancelled",
]);
const ACTION_PRIORITIES = new Set(["low", "normal", "high"]);
const ACTION_OUTCOMES = new Set(["achieved", "partial", "failed", "changed", "unknown"]);
const CODEX_STATUSES = new Set([
  "idle", "running", "completed", "failed", "cancelled", "interrupted",
]);
const EXECUTION_WORKSPACE = /^00_系统\/执行工作区\/[a-zA-Z0-9._:-]{1,96}\/[a-zA-Z0-9._:-]{1,96}$/u;
const EXECUTION_ID = /^action-execution-[a-zA-Z0-9._:-]{1,96}$/u;
const MAX_ACTIONS = 2_000;
const MAX_EVENTS = 500;

function boundedText(value, maximum, fallback = "") {
  const text = String(value ?? "").replace(/\u0000/gu, "").trim();
  return (text || fallback).slice(0, maximum);
}

function validTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestamp(options = {}) {
  const value = typeof options.clock === "function" ? options.clock() : new Date().toISOString();
  return validTimestamp(value) || new Date().toISOString();
}

function normalizedId(value, prefix) {
  const text = boundedText(value, 96).replace(/[^a-zA-Z0-9._:-]/gu, "-");
  return text || `${prefix}-${crypto.randomUUID()}`;
}

function normalizedStringList(values, { maximum = 16, itemLength = 80 } = {}) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = boundedText(value, itemLength);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maximum) break;
  }
  return result;
}

function safeKnowledgePath(value) {
  const path = boundedText(value, 500).replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!path || !path.toLocaleLowerCase().endsWith(".md")) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  if (!/^(?:0[1-9]_|11_)/u.test(path)) return null;
  if (/(?:^|\/)(?:\.obsidian|\.git|node_modules|00_系统|10_智能体与技能)(?:\/|$)/iu.test(path)) return null;
  return path;
}

function normalizedRelatedKnowledge(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const path = safeKnowledgePath(value?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({
      path,
      label: boundedText(value?.label, 120, path.split("/").at(-1).replace(/\.md$/iu, "")),
    });
    if (result.length >= 24) break;
  }
  return result;
}

function normalizedSource(value) {
  const source = value && typeof value === "object" ? value : {};
  if (source.kind === "daily-review") {
    return {
      kind: "daily-review",
      conversationId: null,
      reviewId: /^daily-review-[a-f0-9]{16}$/u.test(String(source.reviewId || ""))
        ? String(source.reviewId)
        : null,
      messageId: normalizedId(source.messageId, "msg"),
      quotedText: boundedText(source.quotedText, 1_000),
    };
  }
  return {
    conversationId: normalizedId(source.conversationId, "conv"),
    messageId: normalizedId(source.messageId, "msg"),
    quotedText: boundedText(source.quotedText, 1_000),
  };
}

function normalizedResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = boundedText(value.summary, 4_000);
  if (!summary) return null;
  return {
    summary,
    outcome: ACTION_OUTCOMES.has(value.outcome) ? value.outcome : "unknown",
    deviation: boundedText(value.deviation, 2_000),
    nextStep: boundedText(value.nextStep, 2_000),
  };
}

function normalizedCodexExecution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const executionId = boundedText(value.executionId, 120);
  if (executionId && !EXECUTION_ID.test(executionId)) return null;
  const conversationId = boundedText(value.conversationId, 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/u.test(conversationId)) return null;
  const workspacePath = boundedText(value.workspacePath, 500).replace(/\\/gu, "/");
  if (!EXECUTION_WORKSPACE.test(workspacePath)) return null;
  const persistedStatus = CODEX_STATUSES.has(value.status) ? value.status : "idle";
  const status = persistedStatus === "running" ? "interrupted" : persistedStatus;
  return {
    executionId: executionId || null,
    status,
    conversationId,
    workspacePath,
    startedAt: validTimestamp(value.startedAt),
    finishedAt: status === "running" ? null : validTimestamp(value.finishedAt),
    summary: boundedText(value.summary, 8_000),
    error: boundedText(
      status === "interrupted" && !value.error
        ? "上次 Codex 执行在插件关闭前没有完成；该旧记录现已只读"
        : value.error,
      1_000,
    ),
  };
}

function normalizeLegacyAction(value, options = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallbackTimestamp = timestamp(options);
  let status = ACTION_STATUSES.has(input.status) ? input.status : "candidate";
  const result = normalizedResult(input.result);
  const codexExecution = normalizedCodexExecution(input.codexExecution);
  if (status === "completed" && !result) status = "pending";
  if (codexExecution?.status === "interrupted" && status === "in-progress") status = "waiting";
  const reminderAt = validTimestamp(input.reminderAt);
  const notifiedFor = validTimestamp(input.reminderState?.notifiedFor);
  const notificationMatches = reminderAt && notifiedFor === reminderAt;
  return {
    id: normalizedId(input.id, "action"),
    status,
    title: boundedText(input.title, 160, "未命名行动"),
    details: boundedText(input.details, 8_000),
    priority: ACTION_PRIORITIES.has(input.priority) ? input.priority : "normal",
    dueAt: validTimestamp(input.dueAt),
    reminderAt,
    tags: normalizedStringList(input.tags),
    relatedKnowledge: normalizedRelatedKnowledge(input.relatedKnowledge),
    source: normalizedSource(input.source),
    result,
    codexExecution,
    reminderState: {
      lastNotifiedAt: notificationMatches ? validTimestamp(input.reminderState?.lastNotifiedAt) : null,
      notifiedFor: notificationMatches ? notifiedFor : null,
    },
    createdAt: validTimestamp(input.createdAt) || fallbackTimestamp,
    updatedAt: validTimestamp(input.updatedAt) || fallbackTimestamp,
    completedAt: status === "completed"
      ? (validTimestamp(input.completedAt) || fallbackTimestamp)
      : null,
  };
}

function normalizedActions(values, seen, options, { deleted = false } = {}) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const action = normalizeLegacyAction(value, options);
    if (seen.has(action.id)) continue;
    const deletedAt = deleted ? validTimestamp(value?.deletedAt) : null;
    if (deleted && !deletedAt) continue;
    seen.add(action.id);
    result.push(deleted ? { ...action, deletedAt } : action);
    if (result.length >= MAX_ACTIONS) break;
  }
  return result;
}

function normalizedEvents(values, options) {
  const fallbackTimestamp = timestamp(options);
  return (Array.isArray(values) ? values : [])
    .filter((event) => event && typeof event === "object" && !Array.isArray(event))
    .slice(-MAX_EVENTS)
    .map((event) => ({
      id: boundedText(event.id, 96) || `action-event-${crypto.randomUUID()}`,
      actionId: boundedText(event.actionId, 96),
      type: boundedText(event.type, 48, "updated"),
      at: validTimestamp(event.at) || fallbackTimestamp,
      summary: boundedText(event.summary, 240),
    }))
    .filter((event) => event.actionId);
}

function normalizeLegacyActionState(stored = {}, options = {}) {
  const seen = new Set();
  const actions = normalizedActions(stored.actions, seen, options);
  return {
    actions,
    deletedActions: normalizedActions(stored.deletedActions, seen, options, { deleted: true }),
    actionEvents: normalizedEvents(stored.actionEvents, options),
    actionReminderState: {
      lastCheckedAt: validTimestamp(stored.actionReminderState?.lastCheckedAt),
    },
  };
}

module.exports = {
  normalizeLegacyAction,
  normalizeLegacyActionState,
};
