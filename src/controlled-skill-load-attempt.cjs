"use strict";

const { createHash } = require("node:crypto");

const MAX_PRIMARY_SKILL_BODY_BYTES = 24 * 1024;
const MAX_UNIQUE_TOOL_CALLS = 2;
const CHANNELS = new Set(["codex-app-server", "provider-api"]);
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/u;

const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const failure = (code, details = {}) => ({ ok: false, code, ...details });
const exactToolCallId = value => typeof value === "string" && TOOL_CALL_ID_PATTERN.test(value) ? value : null;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function validateModelArguments(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("INVALID_ARGUMENTS", { reasonCode: "OBJECT_REQUIRED" });
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "skillId") {
    return failure("INVALID_ARGUMENTS", { reasonCode: "EXACT_FIELDS_REQUIRED" });
  }
  const skillId = clean(input.skillId, 128);
  const reason = clean(input.reason, 240);
  if (!skillId || !reason || input.skillId.trim().length > 128 || input.reason.trim().length > 240) {
    return failure("INVALID_ARGUMENTS", { reasonCode: "INVALID_SKILL_OR_REASON" });
  }
  return { ok: true, skillId, reason };
}

function normalizeHostContext(input) {
  const toolCallId = exactToolCallId(input?.toolCallId);
  const channel = clean(input?.channel, 40);
  if (!toolCallId) return failure("INVALID_HOST_CONTEXT", { reasonCode: "TOOL_CALL_ID_INVALID" });
  if (!CHANNELS.has(channel)) return failure("INVALID_HOST_CONTEXT", { reasonCode: "CHANNEL_NOT_ALLOWED" });
  return { ok: true, toolCallId, channel };
}

function publicSlotFailure(slot, code = "ALREADY_LOADED") {
  return failure(code, {
    lockedSkillId: slot.skillId,
    lockedVersion: slot.version,
    localRead: slot.localRead.status,
    channelSubmission: slot.channelSubmission.status,
  });
}

function createControlledSkillLoadAttempt(options = {}) {
  const attemptId = clean(options.attemptId, 160);
  if (!attemptId) throw new TypeError("attemptId is required");
  if (typeof options.lookupSkill !== "function") throw new TypeError("lookupSkill must be a function");
  if (typeof options.readSkillBody !== "function") throw new TypeError("readSkillBody must be a function");

  const lookupSkill = options.lookupSkill;
  const readSkillBody = options.readSkillBody;
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const maxBodyBytes = Number.isSafeInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
    ? options.maxBodyBytes : MAX_PRIMARY_SKILL_BODY_BYTES;
  const maxUniqueCalls = Number.isSafeInteger(options.maxUniqueCalls) && options.maxUniqueCalls > 0
    ? options.maxUniqueCalls : MAX_UNIQUE_TOOL_CALLS;

  const callPromises = new Map();
  let overLimitPromise = null;
  let cancelledReplayPromise = null;
  let cancelled = false;
  let cancellationReason = null;
  let slot = null;

  function snapshot() {
    return {
      attemptId,
      cancelled,
      uniqueToolCallCount: callPromises.size,
      slot: slot ? {
        skillId: slot.skillId,
        version: slot.version,
        definitionHash: slot.definitionHash,
        ownerToolCallId: slot.ownerToolCallId,
        channel: slot.channel,
        reason: slot.reason,
        localRead: { ...slot.localRead },
        channelSubmission: { ...slot.channelSubmission },
      } : null,
    };
  }

  function finishReadFailure(code, details = {}) {
    if (!slot) return failure(code, details);
    const status = code === "TURN_CANCELLED" ? "cancelled" : "failed";
    slot.localRead = { status, code, finishedAt: now() };
    if (slot.channelSubmission.status === "pending") {
      slot.channelSubmission = { status, code, finishedAt: now() };
    }
    const result = failure(code, details);
    slot.readResult = result;
    slot.delivery.resolve(result);
    return result;
  }

  async function readReservedSkill(skillSnapshot) {
    let read;
    try {
      read = await readSkillBody(Object.freeze({ ...skillSnapshot }), {
        attemptId,
        toolCallId: slot.ownerToolCallId,
        channel: slot.channel,
        signal: slot.abortController.signal,
      });
    } catch (_error) {
      if (cancelled || slot.abortController.signal.aborted) {
        return finishReadFailure("TURN_CANCELLED", { cancellationReason });
      }
      return finishReadFailure("READ_FAILED");
    }

    if (cancelled || slot.abortController.signal.aborted) {
      return finishReadFailure("TURN_CANCELLED", { cancellationReason });
    }
    const body = typeof read === "string" ? read : read?.body;
    const actualVersion = clean(typeof read === "object" ? read?.version : skillSnapshot.version, 64);
    const actualDefinitionHash = clean(
      typeof read === "object" ? read?.definitionHash : skillSnapshot.definitionHash,
      160,
    );
    if (!body || typeof body !== "string") return finishReadFailure("READ_FAILED");
    if (actualVersion !== slot.version || actualDefinitionHash !== slot.definitionHash) {
      return finishReadFailure("VERSION_CHANGED");
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > maxBodyBytes) {
      return finishReadFailure("BUDGET_EXCEEDED", { bytes, maxBytes: maxBodyBytes });
    }

    const readAt = now();
    const contentHash = createHash("sha256").update(body, "utf8").digest("hex");
    const receipt = {
      issuer: "plugin-vault-reader",
      scope: "local-tool-result",
      skillId: slot.skillId,
      attemptId,
      toolCallId: slot.ownerToolCallId,
      channel: slot.channel,
      version: slot.version,
      definitionHash: slot.definitionHash,
      contentHash,
      bytes,
      readAt,
    };
    slot.localRead = { status: "succeeded", bytes, contentHash, readAt };
    const result = {
      ok: true,
      code: "SKILL_LOADED",
      skillId: slot.skillId,
      version: slot.version,
      definitionHash: slot.definitionHash,
      reason: slot.reason,
      body,
      bytes,
      contentHash,
      receipt,
    };
    slot.readResult = result;
    return result;
  }

  async function waitForExistingSlot(requestedSkillId) {
    if (requestedSkillId !== slot.skillId) return publicSlotFailure(slot);
    const readResult = await slot.readPromise;
    if (!readResult.ok) return { ...readResult };
    if (slot.channelSubmission.status === "submitted") return publicSlotFailure(slot);
    const delivery = await slot.delivery.promise;
    if (delivery?.status === "submitted" || slot.channelSubmission.status === "submitted") {
      return publicSlotFailure(slot);
    }
    return delivery?.ok === false ? { ...delivery } : publicSlotFailure(slot);
  }

  async function processUniqueRequest(modelArguments, hostContext) {
    if (cancelled) return failure("TURN_CANCELLED", { cancellationReason });
    const args = validateModelArguments(modelArguments);
    if (!args.ok) return args;

    if (slot) return waitForExistingSlot(args.skillId);

    let skillSnapshot;
    try {
      skillSnapshot = await lookupSkill(args.skillId, { attemptId, channel: hostContext.channel });
    } catch (_error) {
      return failure("NOT_ELIGIBLE", { reasonCode: "CATALOG_LOOKUP_FAILED" });
    }
    if (cancelled) return failure("TURN_CANCELLED", { cancellationReason });
    if (!skillSnapshot || clean(skillSnapshot.id, 128) !== args.skillId) {
      return failure("NOT_ELIGIBLE", { reasonCode: "NOT_IN_CANDIDATE_SNAPSHOT" });
    }
    if (skillSnapshot.eligible !== true) {
      return failure(clean(skillSnapshot.code, 80) || "NOT_ELIGIBLE");
    }
    const version = clean(skillSnapshot.version, 64);
    const definitionHash = clean(skillSnapshot.definitionHash, 160);
    const estimatedBytes = skillSnapshot.estimatedBytes;
    if (!version || !definitionHash) {
      return failure("NOT_ELIGIBLE", { reasonCode: "IDENTITY_SNAPSHOT_INCOMPLETE" });
    }
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1) {
      return failure("NOT_ELIGIBLE", { reasonCode: "BODY_SIZE_UNKNOWN" });
    }
    if (estimatedBytes > maxBodyBytes) {
      return failure("BUDGET_EXCEEDED", { estimatedBytes, maxBytes: maxBodyBytes });
    }

    // The first request that completes all eligibility gates owns the one-body slot.
    // JavaScript executes this compare-and-set without an await, so concurrent callers
    // cannot both reserve it within the same attempt object.
    if (slot) return waitForExistingSlot(args.skillId);
    const delivery = deferred();
    slot = {
      skillId: args.skillId,
      version,
      definitionHash,
      reason: args.reason,
      ownerToolCallId: hostContext.toolCallId,
      channel: hostContext.channel,
      localRead: { status: "reading", startedAt: now() },
      channelSubmission: { status: "pending" },
      abortController: new AbortController(),
      delivery,
      readPromise: null,
      readResult: null,
    };
    slot.readPromise = readReservedSkill({
      ...skillSnapshot,
      id: args.skillId,
      version,
      definitionHash,
    });
    return slot.readPromise;
  }

  function request(modelArguments, rawHostContext) {
    const hostContext = normalizeHostContext(rawHostContext);
    if (!hostContext.ok) return Promise.resolve(hostContext);
    if (cancelled) {
      cancelledReplayPromise ||= Promise.resolve(failure("TURN_CANCELLED", { cancellationReason }));
      return cancelledReplayPromise;
    }
    if (callPromises.has(hostContext.toolCallId)) return callPromises.get(hostContext.toolCallId);
    if (callPromises.size >= maxUniqueCalls) {
      overLimitPromise ||= Promise.resolve(failure("TOO_MANY_TOOL_CALLS", { maxUniqueToolCalls: maxUniqueCalls }));
      return overLimitPromise;
    }
    const pending = processUniqueRequest(modelArguments, hostContext);
    callPromises.set(hostContext.toolCallId, pending);
    return pending;
  }

  function markChannelSubmitted(details = {}) {
    if (!slot) return failure("NO_SKILL_LOADED");
    if (cancelled) return failure("TURN_CANCELLED", { cancellationReason });
    const toolCallId = exactToolCallId(details.toolCallId);
    const channel = clean(details.channel, 40);
    if (toolCallId !== slot.ownerToolCallId) return failure("TOOL_CALL_MISMATCH");
    if (channel !== slot.channel) return failure("CHANNEL_MISMATCH");
    if (slot.localRead.status !== "succeeded") return failure("LOCAL_READ_NOT_READY");
    if (slot.channelSubmission.status === "submitted") {
      return { ok: true, code: "CHANNEL_ALREADY_SUBMITTED", ...slot.channelSubmission };
    }
    if (slot.channelSubmission.status === "failed") return failure("DELIVERY_ALREADY_FAILED");
    if (slot.channelSubmission.status === "cancelled") return failure("TURN_CANCELLED", { cancellationReason });
    const submittedAt = clean(details.submittedAt, 64) || now();
    slot.channelSubmission = { status: "submitted", channel, submittedAt };
    slot.delivery.resolve({ ok: true, status: "submitted", channel, submittedAt });
    return { ok: true, code: "CHANNEL_SUBMITTED", ...slot.channelSubmission };
  }

  function markChannelFailed(details = {}) {
    if (!slot) return failure("NO_SKILL_LOADED");
    if (cancelled) return failure("TURN_CANCELLED", { cancellationReason });
    const toolCallId = exactToolCallId(details.toolCallId);
    if (toolCallId !== slot.ownerToolCallId) return failure("TOOL_CALL_MISMATCH");
    if (slot.localRead.status !== "succeeded") return failure("LOCAL_READ_NOT_READY");
    if (slot.channelSubmission.status === "submitted") return failure("CHANNEL_ALREADY_SUBMITTED");
    if (slot.channelSubmission.status === "failed") {
      return failure(slot.channelSubmission.code || "DELIVERY_FAILED");
    }
    const code = clean(details.code, 80) || "DELIVERY_FAILED";
    slot.channelSubmission = { status: "failed", code, finishedAt: now() };
    const result = failure(code);
    slot.delivery.resolve(result);
    return result;
  }

  function cancel(reason = "cancelled") {
    if (cancelled) return snapshot();
    cancelled = true;
    cancellationReason = clean(reason, 160) || "cancelled";
    if (slot) {
      slot.abortController.abort(cancellationReason);
      if (slot.localRead.status === "reading") {
        slot.localRead = { status: "cancelled", code: "TURN_CANCELLED", finishedAt: now() };
      }
      if (slot.channelSubmission.status === "pending") {
        slot.channelSubmission = { status: "cancelled", code: "TURN_CANCELLED", finishedAt: now() };
      }
      slot.delivery.resolve(failure("TURN_CANCELLED", { cancellationReason }));
    }
    return snapshot();
  }

  return Object.freeze({
    request,
    markChannelSubmitted,
    markChannelFailed,
    cancel,
    snapshot,
  });
}

module.exports = {
  MAX_PRIMARY_SKILL_BODY_BYTES,
  MAX_UNIQUE_TOOL_CALLS,
  createControlledSkillLoadAttempt,
};