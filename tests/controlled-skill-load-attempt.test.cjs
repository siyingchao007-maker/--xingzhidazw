"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createControlledSkillLoadAttempt,
  MAX_PRIMARY_SKILL_BODY_BYTES,
} = require("../src/controlled-skill-load-attempt.cjs");

const skill = (id, overrides = {}) => ({
  id,
  version: "2.0.0",
  definitionHash: `definition-${id}`,
  estimatedBytes: 256,
  eligible: true,
  ...overrides,
});

const createAttempt = (overrides = {}) => {
  const catalog = new Map([
    ["path", skill("path")],
    ["sales", skill("sales")],
  ]);
  const reads = [];
  const attempt = createControlledSkillLoadAttempt({
    attemptId: "attempt-1",
    lookupSkill: async (id) => catalog.get(id) || null,
    readSkillBody: async (snapshot) => {
      reads.push(snapshot.id);
      return {
        body: `# ${snapshot.id}\n\nmethod`,
        version: snapshot.version,
        definitionHash: snapshot.definitionHash,
      };
    },
    now: () => "2026-10-17T10:00:00.000Z",
    ...overrides,
  });
  return { attempt, reads, catalog };
};

test("an untouched attempt loads zero primary Skills", () => {
  const { attempt, reads } = createAttempt();

  assert.deepEqual(attempt.snapshot(), {
    attemptId: "attempt-1",
    cancelled: false,
    uniqueToolCallCount: 0,
    slot: null,
  });
  assert.deepEqual(reads, []);
});

test("loads one eligible primary Skill and keeps local read separate from channel submission", async () => {
  const { attempt, reads } = createAttempt();

  const result = await attempt.request(
    { skillId: "path", reason: "需要用 PATH 方法梳理问题" },
    { toolCallId: "call-1", channel: "codex-app-server" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.skillId, "path");
  assert.equal(result.body, "# path\n\nmethod");
  assert.equal(result.bytes, Buffer.byteLength(result.body, "utf8"));
  assert.match(result.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.receipt.scope, "local-tool-result");
  assert.equal(result.receipt.channel, "codex-app-server");
  assert.equal(result.receipt.toolCallId, "call-1");
  assert.deepEqual(reads, ["path"]);

  const beforeSubmit = attempt.snapshot();
  assert.equal(beforeSubmit.slot.localRead.status, "succeeded");
  assert.equal(beforeSubmit.slot.channelSubmission.status, "pending");

  const submitted = attempt.markChannelSubmitted({
    toolCallId: "call-1",
    channel: "codex-app-server",
    submittedAt: "2026-10-17T10:00:01.000Z",
  });
  assert.equal(submitted.ok, true);
  assert.equal(attempt.snapshot().slot.channelSubmission.status, "submitted");
});

test("the first eligible read atomically locks the slot and rejects another Skill", async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const { attempt, reads } = createAttempt({
    readSkillBody: async (snapshot) => {
      reads.push(snapshot.id);
      await readGate;
      return { body: "method", version: snapshot.version, definitionHash: snapshot.definitionHash };
    },
  });

  const first = attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  await Promise.resolve();
  const second = await attempt.request(
    { skillId: "sales", reason: "也适合当前任务" },
    { toolCallId: "call-2", channel: "provider-api" },
  );

  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_LOADED");
  assert.equal(second.lockedSkillId, "path");
  releaseRead();
  assert.equal((await first).ok, true);
  assert.deepEqual(reads, ["path"]);
});

test("a transport replay with the same toolCallId returns the same promise and reads once", async () => {
  const { attempt, reads } = createAttempt();
  const args = { skillId: "path", reason: "适合当前任务" };
  const host = { toolCallId: "call-1", channel: "provider-api" };

  const first = attempt.request(args, host);
  const replay = attempt.request(args, host);

  assert.equal(replay, first);
  assert.equal((await replay).ok, true);
  assert.deepEqual(reads, ["path"]);
  assert.equal(attempt.snapshot().uniqueToolCallCount, 1);
});

test("distinct toolCallIds with the same 160-character prefix never collide", async () => {
  const { attempt } = createAttempt();
  const sharedPrefix = "a".repeat(160);
  const firstId = `${sharedPrefix}x`;
  const secondId = `${sharedPrefix}y`;

  const first = await attempt.request(
    { skillId: "", reason: "first invalid call" },
    { toolCallId: firstId, channel: "provider-api" },
  );
  const second = await attempt.request(
    { skillId: "", reason: "second invalid call" },
    { toolCallId: secondId, channel: "provider-api" },
  );

  assert.equal(first.code, "INVALID_ARGUMENTS");
  assert.equal(second.code, "INVALID_ARGUMENTS");
  assert.equal(attempt.snapshot().uniqueToolCallCount, 2);
});

test("toolCallId accepts only 1-300 ASCII letters, digits, underscores, or hyphens", async () => {
  const { attempt } = createAttempt();

  const invalidCharacter = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call:1", channel: "provider-api" },
  );
  const tooLong = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "a".repeat(301), channel: "provider-api" },
  );
  const maxLength = await attempt.request(
    { skillId: "", reason: "valid host id, invalid model args" },
    { toolCallId: "Z".repeat(300), channel: "provider-api" },
  );

  assert.equal(invalidCharacter.code, "INVALID_HOST_CONTEXT");
  assert.equal(invalidCharacter.reasonCode, "TOOL_CALL_ID_INVALID");
  assert.equal(tooLong.code, "INVALID_HOST_CONTEXT");
  assert.equal(tooLong.reasonCode, "TOOL_CALL_ID_INVALID");
  assert.equal(maxLength.code, "INVALID_ARGUMENTS");
  assert.equal(attempt.snapshot().uniqueToolCallCount, 1);
});

test("at most two unique toolCallIds are processed, including invalid calls", async () => {
  const { attempt, reads } = createAttempt();

  const first = await attempt.request(
    { skillId: "", reason: "无效" },
    { toolCallId: "bad-1", channel: "provider-api" },
  );
  const second = await attempt.request(
    { skillId: "path", reason: "", extraPath: "C:/secrets" },
    { toolCallId: "bad-2", channel: "provider-api" },
  );
  const third = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-3", channel: "provider-api" },
  );

  assert.equal(first.code, "INVALID_ARGUMENTS");
  assert.equal(second.code, "INVALID_ARGUMENTS");
  assert.equal(third.code, "TOO_MANY_TOOL_CALLS");
  assert.equal(attempt.snapshot().uniqueToolCallCount, 2);
  assert.equal(attempt.snapshot().slot, null);
  assert.deepEqual(reads, []);
});

test("an ineligible request consumes a unique call but does not lock the slot", async () => {
  const { attempt, catalog, reads } = createAttempt();
  catalog.set("disabled", skill("disabled", { eligible: false, code: "DISABLED" }));

  const denied = await attempt.request(
    { skillId: "disabled", reason: "尝试禁用项" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  const accepted = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-2", channel: "provider-api" },
  );

  assert.equal(denied.code, "DISABLED");
  assert.equal(accepted.ok, true);
  assert.equal(attempt.snapshot().slot.skillId, "path");
  assert.deepEqual(reads, ["path"]);
});

test("a failed eligible read keeps the locked Skill and cannot refund the slot", async () => {
  const { attempt } = createAttempt({
    readSkillBody: async () => { throw new Error("disk unavailable"); },
  });

  const failed = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  const alternate = await attempt.request(
    { skillId: "sales", reason: "换一个方法" },
    { toolCallId: "call-2", channel: "provider-api" },
  );

  assert.equal(failed.code, "READ_FAILED");
  assert.equal(alternate.code, "ALREADY_LOADED");
  assert.equal(attempt.snapshot().slot.skillId, "path");
  assert.equal(attempt.snapshot().slot.localRead.status, "failed");
});

test("cancellation discards a late body and never marks local read as successful", async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const { attempt } = createAttempt({
    readSkillBody: async (snapshot) => {
      await readGate;
      return { body: "late secret body", version: snapshot.version, definitionHash: snapshot.definitionHash };
    },
  });

  const pending = attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  await Promise.resolve();
  attempt.cancel("user-cancelled");
  releaseRead();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.code, "TURN_CANCELLED");
  assert.equal(Object.hasOwn(result, "body"), false);
  assert.equal(attempt.snapshot().slot.localRead.status, "cancelled");
  assert.equal(attempt.snapshot().slot.channelSubmission.status, "cancelled");
});

test("a version change after the slot is locked discards the body", async () => {
  const { attempt } = createAttempt({
    readSkillBody: async (snapshot) => ({
      body: "new version body",
      version: "2.1.0",
      definitionHash: snapshot.definitionHash,
    }),
  });

  const result = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "VERSION_CHANGED");
  assert.equal(Object.hasOwn(result, "body"), false);
  assert.equal(attempt.snapshot().slot.version, "2.0.0");
  assert.equal(attempt.snapshot().slot.localRead.status, "failed");
});

test("the 24 KiB budget is checked before and after reading without truncation", async () => {
  const preflight = createAttempt();
  preflight.catalog.set("large", skill("large", { estimatedBytes: MAX_PRIMARY_SKILL_BODY_BYTES + 1 }));
  const preflightResult = await preflight.attempt.request(
    { skillId: "large", reason: "尝试超大正文" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  assert.equal(preflightResult.code, "BUDGET_EXCEEDED");
  assert.equal(preflight.attempt.snapshot().slot, null);
  assert.deepEqual(preflight.reads, []);

  const postflight = createAttempt({
    readSkillBody: async (snapshot) => ({
      body: "界".repeat(MAX_PRIMARY_SKILL_BODY_BYTES),
      version: snapshot.version,
      definitionHash: snapshot.definitionHash,
    }),
  });
  const postflightResult = await postflight.attempt.request(
    { skillId: "path", reason: "实际正文超预算" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  assert.equal(postflightResult.code, "BUDGET_EXCEEDED");
  assert.equal(Object.hasOwn(postflightResult, "body"), false);
  assert.equal(postflight.attempt.snapshot().slot.skillId, "path");
  assert.equal(postflight.attempt.snapshot().slot.localRead.status, "failed");
});

test("a new call for the same Skill waits for submission and then returns ALREADY_LOADED metadata", async () => {
  const { attempt } = createAttempt();
  const first = await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  assert.equal(first.ok, true);

  let settled = false;
  const second = attempt.request(
    { skillId: "path", reason: "再次请求同一方法" },
    { toolCallId: "call-2", channel: "provider-api" },
  ).then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);

  attempt.markChannelSubmitted({
    toolCallId: "call-1",
    channel: "provider-api",
    submittedAt: "2026-10-17T10:00:02.000Z",
  });
  const secondResult = await second;
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.code, "ALREADY_LOADED");
  assert.equal(secondResult.lockedSkillId, "path");
  assert.equal(secondResult.channelSubmission, "submitted");
});

test("submission and delivery failure are rejected while localRead is still reading", async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const { attempt } = createAttempt({
    readSkillBody: async (snapshot) => {
      await readGate;
      return { body: "method", version: snapshot.version, definitionHash: snapshot.definitionHash };
    },
  });
  const pending = attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );
  await Promise.resolve();

  assert.equal(attempt.markChannelSubmitted({ toolCallId: "call-1", channel: "provider-api" }).code, "LOCAL_READ_NOT_READY");
  assert.equal(attempt.markChannelFailed({ toolCallId: "call-1", code: "DELIVERY_FAILED" }).code, "LOCAL_READ_NOT_READY");
  assert.equal(attempt.markChannelSubmitted({ toolCallId: "other", channel: "provider-api" }).code, "TOOL_CALL_MISMATCH");

  releaseRead();
  assert.equal((await pending).ok, true);
  assert.equal(attempt.snapshot().slot.localRead.status, "succeeded");
  assert.equal(attempt.snapshot().slot.channelSubmission.status, "pending");
});

test("cancelling after local read drops cached body on replay and blocks late submission", async () => {
  const { attempt, reads } = createAttempt();
  const args = { skillId: "path", reason: "适合当前任务" };
  const host = { toolCallId: "call-1", channel: "provider-api" };
  const loaded = await attempt.request(args, host);
  assert.equal(loaded.ok, true);
  assert.equal(Object.hasOwn(loaded, "body"), true);

  attempt.cancel("user-cancelled-after-read");
  const replay = await attempt.request(args, host);
  const lateSubmit = attempt.markChannelSubmitted({
    toolCallId: "call-1",
    channel: "provider-api",
  });

  assert.equal(replay.code, "TURN_CANCELLED");
  assert.equal(Object.hasOwn(replay, "body"), false);
  assert.equal(lateSubmit.code, "TURN_CANCELLED");
  assert.deepEqual(reads, ["path"]);
  assert.equal(attempt.snapshot().slot.localRead.status, "succeeded");
  assert.equal(attempt.snapshot().slot.channelSubmission.status, "cancelled");
});

test("a failed channel submission cannot later be overwritten as submitted", async () => {
  const { attempt } = createAttempt();
  await attempt.request(
    { skillId: "path", reason: "适合当前任务" },
    { toolCallId: "call-1", channel: "provider-api" },
  );

  assert.equal(attempt.markChannelFailed({ toolCallId: "call-1", code: "DELIVERY_FAILED" }).code, "DELIVERY_FAILED");
  const lateSubmit = attempt.markChannelSubmitted({ toolCallId: "call-1", channel: "provider-api" });

  assert.equal(lateSubmit.code, "DELIVERY_ALREADY_FAILED");
  assert.equal(attempt.snapshot().slot.channelSubmission.status, "failed");
});
