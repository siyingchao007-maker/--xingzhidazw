"use strict";

const {
  appendOperationEvent,
  normalizeOperationEvents,
  sanitizeErrorMessage,
} = require("./operation-events.cjs");

const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "timed-out", "cancelled"]);
const AUTHENTICATION_ERROR_CODES = new Set([
  "unauthorized",
  "authentication_required",
  "invalid_authentication",
  "invalid_token",
  "token_invalid",
]);

function numericStatus(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/u.test(value.trim())) return Number(value.trim());
  return null;
}

function authenticationCode(value) {
  if (numericStatus(value) === 401) return true;
  return typeof value === "string" && AUTHENTICATION_ERROR_CODES.has(value.trim().toLowerCase());
}

function isAuthenticationFailure(value, seen = new Set(), depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "number") return value === 401;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[object Object]") return false;
    if (/\b(?:without|not)\s+(?:an?\s+)?(?:authentication|auth|token)\s+(?:failure|error|issue)\b/iu.test(text)) return false;
    if (/^401$/u.test(text) || /could not parse your authentication token/iu.test(text)) return true;
    try {
      if (/^(?:\{|\[)/u.test(text)) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return isAuthenticationFailure(parsed, seen, depth + 1);
      }
    } catch { /* Plain error text is checked below. */ }
    return /\b401\b.{0,120}(?:unauthori[sz]ed|authentication|\bauth\b|token)/iu.test(text)
      || /(?:unauthori[sz]ed|authentication|\bauth\b|token).{0,120}\b401\b/iu.test(text);
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  const status = numericStatus(value.status ?? value.statusCode ?? value.httpStatus ?? value.http_status);
  if (status === 429) return false;
  if (status === 401) return true;
  if (authenticationCode(value.code) || authenticationCode(value.errorCode)
    || authenticationCode(value.error_code)) return true;
  for (const key of ["message", "error", "failure", "statusReason", "statusText", "cause", "response", "data"]) {
    if (isAuthenticationFailure(value[key], seen, depth + 1)) return true;
  }
  return false;
}

function turnIdentity(active) {
  const value = active?.telemetryTurnId || active?.assistantMessageId || active?.turnId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("回合缺少本地诊断标识");
  }
  return value.trim().slice(0, 200);
}

function providerId(active) {
  if (active?.providerId) return String(active.providerId).slice(0, 64);
  return active?.engine === "codex-app-server" ? "codex" : null;
}

function eventExists(events, active, outcomes) {
  const identity = turnIdentity(active);
  return normalizeOperationEvents(events).some((event) => (
    event.phase === "turn" && event.turnId === identity && outcomes.has(event.outcome)
  ));
}

function startedAt(active, options) {
  const value = options?.startedAt || active?.startedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(options) {
  const parsed = Date.parse(options?.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function appendTurnStarted(events, active, options = {}) {
  if (eventExists(events, active, new Set(["started"]))) return normalizeOperationEvents(events);
  return appendOperationEvent(events, {
    providerId: providerId(active),
    model: options.model || null,
    conversationId: active?.conversationId || null,
    turnId: turnIdentity(active),
    phase: "turn",
    outcome: "started",
    timestamp: options.timestamp,
  });
}

function appendTurnTerminal(events, active, outcome, options = {}) {
  if (!TERMINAL_OUTCOMES.has(outcome)) throw new Error("回合结束状态无效");
  if (eventExists(events, active, TERMINAL_OUTCOMES)) return normalizeOperationEvents(events);
  const beginning = startedAt(active, options);
  const finished = timestampMs(options);
  return appendOperationEvent(events, {
    providerId: providerId(active),
    model: options.model || null,
    conversationId: active?.conversationId || null,
    turnId: turnIdentity(active),
    phase: "turn",
    outcome,
    latencyMs: beginning === null ? null : Math.max(0, finished - beginning),
    errorCode: options.errorCode || null,
    errorMessage: options.errorMessage || null,
    timestamp: options.timestamp,
  });
}

function classifyTurnFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "本轮未能完成");
  const code = typeof error?.code === "string" ? error.code
    : (typeof error?.code === "number" && Number.isFinite(error.code) ? String(error.code) : null);
  const timedOut = code === "timeout" || /超时|time(?:d)?\s*out/iu.test(message);
  return {
    outcome: timedOut ? "timed-out" : "failed",
    errorCode: code,
    errorMessage: message,
  };
}

function turnCompletionFailure(turn = {}) {
  const status = typeof turn?.status === "string" && turn.status.trim()
    ? turn.status.trim().slice(0, 100) : "incomplete";
  const failure = turn?.error || turn?.failure || turn?.statusReason || null;
  const code = failure?.code ?? turn?.errorCode;
  const errorCode = typeof code === "string" && code.trim()
    ? code.trim().slice(0, 100)
    : (typeof code === "number" && Number.isFinite(code) ? String(code) : status);
  const rawMessage = failure instanceof Error
    ? failure.message
    : (typeof failure === "string"
      ? failure
      : (typeof failure?.message === "string"
        ? failure.message
        : (typeof turn?.errorMessage === "string" ? turn.errorMessage : "")));
  const errorMessage = sanitizeErrorMessage(String(rawMessage || "").replace(/\s+/gu, " ").trim())
    || `Codex 回合未正常完成（状态：${status}）`;
  return { errorCode, errorMessage, status };
}

module.exports = {
  appendTurnStarted,
  appendTurnTerminal,
  classifyTurnFailure,
  isAuthenticationFailure,
  turnCompletionFailure,
};

