"use strict";

const crypto = require("node:crypto");

const MAX_OPERATION_EVENTS = 200;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PHASES = new Set([
  "credential",
  "authorization",
  "connection",
  "model-discovery",
  "app-server",
  "skills",
  "turn",
  "tool",
  "knowledge-write",
  "archive",
]);
const OUTCOMES = new Set([
  "started",
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "unsupported",
]);

function boundedString(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeErrorMessage(value) {
  const source = boundedString(value, MAX_ERROR_MESSAGE_LENGTH * 4);
  if (!source) return null;
  return source
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(authorization\s*:\s*basic\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(\bbearer\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, "[已隐藏]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function safeIdentifier(value, maxLength = 200) {
  const text = boundedString(value, maxLength);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function normalizeOperationEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const id = safeIdentifier(input.id);
  const timestamp = safeTimestamp(input.timestamp);
  const providerId = boundedString(input.providerId, 64);
  const phase = boundedString(input.phase, 40);
  const outcome = boundedString(input.outcome, 40);
  if (!id || !timestamp || !providerId || !PROVIDER_ID_PATTERN.test(providerId)) return null;
  if (!PHASES.has(phase) || !OUTCOMES.has(outcome)) return null;

  const latency = Number(input.latencyMs);
  return {
    id,
    timestamp,
    providerId,
    model: boundedString(input.model, 200),
    conversationId: safeIdentifier(input.conversationId),
    turnId: safeIdentifier(input.turnId),
    phase,
    outcome,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(Math.min(latency, 86_400_000)) : null,
    errorCode: safeIdentifier(input.errorCode, 100),
    errorMessage: sanitizeErrorMessage(input.errorMessage),
  };
}

function normalizeOperationEvents(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeOperationEvent)
    .filter(Boolean)
    .slice(-MAX_OPERATION_EVENTS);
}

function appendOperationEvent(events, input, options = {}) {
  const candidate = {
    ...input,
    id: input?.id || options.id || crypto.randomUUID(),
    timestamp: input?.timestamp || options.timestamp || new Date().toISOString(),
  };
  const event = normalizeOperationEvent(candidate);
  if (!event) throw new Error("运行事件无效");
  return [...normalizeOperationEvents(events), event].slice(-MAX_OPERATION_EVENTS);
}

function normalizedConnectionStatus(value) {
  return new Set(["idle", "connecting", "connected", "configured", "error"]).has(value) ? value : "idle";
}

function providerEvents(events, providerId) {
  return normalizeOperationEvents(events)
    .filter((event) => event.providerId === providerId)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function buildConnectionDiagnostics(input = {}) {
  const providers = Array.isArray(input.providers) ? input.providers : [];
  const connections = input.providerConnections && typeof input.providerConnections === "object"
    ? input.providerConnections
    : {};
  const credentials = input.credentialStatuses && typeof input.credentialStatuses === "object"
    ? input.credentialStatuses
    : {};
  const authorizations = input.authorizations && typeof input.authorizations === "object"
    ? input.authorizations
    : {};
  const currentModels = input.currentModels && typeof input.currentModels === "object"
    ? input.currentModels
    : {};
  const models = Array.isArray(input.models) ? input.models : [];

  return providers
    .filter((provider) => provider && PROVIDER_ID_PATTERN.test(String(provider.id || "")))
    .map((provider) => {
      const providerId = String(provider.id);
      const events = providerEvents(input.events, providerId);
      const latest = events.at(-1) || null;
      const latestSuccess = [...events].reverse().find((event) => event.outcome === "succeeded") || null;
      const latestLatency = [...events].reverse().find((event) => event.latencyMs !== null)?.latencyMs ?? null;
      const latestFailure = [...events].reverse().find((event) => (
        event.outcome === "failed" || event.outcome === "timed-out"
      )) || null;
      const discovery = [...events].reverse().find((event) => event.phase === "model-discovery") || null;
      const latestTurn = [...events].reverse().find((event) => (
        event.phase === "turn" && event.outcome !== "started"
      )) || null;
      let consecutiveFailures = 0;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].outcome === "succeeded") break;
        if (events[index].outcome === "failed" || events[index].outcome === "timed-out") consecutiveFailures += 1;
      }

      const connection = connections[providerId] || {};
      const isCodex = providerId === "codex";
      const credential = credentials[providerId] || {};
      const modelId = boundedString(currentModels[providerId], 200);
      const providerModels = models.filter((model) => model?.providerId === providerId);
      const failureMessage = latestFailure?.errorMessage || sanitizeErrorMessage(connection.error);
      const failurePhase = latestFailure?.phase || (connection.error ? "connection" : null);

      return {
        providerId,
        label: boundedString(provider.label, 100) || boundedString(provider.name, 100) || providerId,
        protocol: boundedString(provider.protocol, 100) || "unknown",
        credential: isCodex
          ? {
            status: connection.authenticationRequired === true ? "requires-login" : "unverified",
            source: "Codex CLI",
          }
          : {
            status: credential.configured === true ? "configured" : "missing",
            source: credential.configured === true ? boundedString(credential.source, 80) : null,
          },
        authorization: isCodex
          ? { status: "not-required" }
          : { status: authorizations[providerId] === true ? "authorized" : "locked" },
        connection: {
          status: normalizedConnectionStatus(connection.status),
        },
        model: {
          status: modelId || providerModels.length ? "ready" : "missing",
          id: modelId,
          count: providerModels.length,
          discoveryStatus: discovery?.outcome || "unknown",
        },
        lastAttemptAt: latest?.timestamp || null,
        lastSuccessAt: latestSuccess?.timestamp || null,
        latencyMs: latestLatency,
        consecutiveFailures,
        turn: latestTurn ? {
          status: latestTurn.outcome,
          at: latestTurn.timestamp,
          latencyMs: latestTurn.latencyMs,
          model: latestTurn.model,
        } : { status: "unknown", at: null, latencyMs: null, model: null },
        failure: failureMessage ? {
          phase: failurePhase,
          code: latestFailure?.errorCode || null,
          message: failureMessage,
        } : null,
      };
    });
}

module.exports = {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_OPERATION_EVENTS,
  appendOperationEvent,
  buildConnectionDiagnostics,
  normalizeOperationEvent,
  normalizeOperationEvents,
  sanitizeErrorMessage,
};
