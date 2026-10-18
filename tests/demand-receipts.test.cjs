"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSkillCall, normalizeCapabilityTrace, advanceSkillCalls, skillCallDescription } = require("../src/skill-call-state.cjs");

const at = "2026-10-18T06:30:00.000Z";
const definitionHash = "d".repeat(64);
const bodyHash = "b".repeat(64);
const toolCallId = "call_" + "x".repeat(295);

function demandRow(channel = "codex-app-server") {
  return {
    id: "research-method", label: "研究方法", source: "model-demand", applicationMode: "governing",
    reason: "需要交叉比较研究依据。", runtimeSnapshot: { version: "1.2.0", contentHash: `sha256:${definitionHash}` },
    callState: {
      schemaVersion: 1, attemptId: "attempt-1", selectedAt: at, toolCallId,
      readReceipt: {
        issuer: "plugin-vault-reader", scope: "local-tool-result", channel,
        skillId: "research-method", attemptId: "attempt-1", toolCallId,
        version: "1.2.0", definitionHash, contentHash: bodyHash, bytes: 812, readAt: at,
      },
    },
  };
}

for (const channel of ["codex-app-server", "provider-api"]) {
  test(`local tool result confirms complete local read on ${channel}`, () => {
    const result = normalizeSkillCall(demandRow(channel));
    assert.equal(result.instructionLoaded, true);
    assert.equal(result.callState.stage, "read-confirmed");
    assert.equal(result.callState.toolCallId, toolCallId);
    assert.equal(result.callState.readReceipt.toolCallId, toolCallId);
    assert.equal(result.callState.readReceipt.channel, channel);
    assert.equal(result.callState.submittedAt, null);
  });
}

const receiptMutations = {
  issuer: "model-assertion", scope: "remote-read", channel: "untrusted-channel",
  skillId: "different-skill", attemptId: "different-attempt", toolCallId: "other-call",
  version: "1.2.1", definitionHash: "e".repeat(64), contentHash: "not-a-hash",
  bytes: 0, readAt: "not-a-date",
};
for (const [field, value] of Object.entries(receiptMutations)) {
  test(`rejects local tool result with mismatched ${field}`, () => {
    const row = demandRow();
    row.callState.readReceipt[field] = value;
    assert.equal(normalizeSkillCall(row).instructionLoaded, false);
  });
}

test("requires an explicit governing model-demand source", () => {
  for (const mutation of [{ source: "automatic" }, { source: undefined }, { applicationMode: "advisory" }, { applicationMode: undefined }]) {
    const row = { ...demandRow(), ...mutation };
    assert.equal(normalizeSkillCall(row).instructionLoaded, false);
    assert.equal(normalizeCapabilityTrace({ skills: [row] }).skills[0].instructionLoaded, false);
  }
});

test("requires complete version and definition identity anchors", () => {
  for (const runtimeSnapshot of [{ version: "1.2.0" }, { contentHash: definitionHash }, { version: "1.2.0", contentHash: "arbitrary" }]) {
    assert.equal(normalizeSkillCall({ ...demandRow(), runtimeSnapshot }).instructionLoaded, false);
  }
});

test("checks an independently supplied body hash when present", () => {
  const row = demandRow();
  row.runtimeSnapshot.bodyHash = "a".repeat(64);
  assert.equal(normalizeSkillCall(row).instructionLoaded, false);
});

test("tool call IDs cannot be silently truncated or absent", () => {
  for (const invalid of ["", "x".repeat(301), "call with spaces", undefined]) {
    const row = demandRow();
    row.callState.toolCallId = invalid;
    row.callState.readReceipt.toolCallId = invalid;
    assert.equal(normalizeSkillCall(row).instructionLoaded, false);
  }
});

test("a model-demand receipt cannot bypass tool ownership through the legacy scope", () => {
  const row = demandRow("provider-api");
  row.callState.readReceipt.scope = "local-prompt";
  delete row.callState.toolCallId;
  delete row.callState.readReceipt.toolCallId;
  assert.equal(normalizeSkillCall(row).instructionLoaded, false);
});

test("a one-character tool call ID is accepted without rewriting", () => {
  const row = demandRow();
  row.callState.toolCallId = "a";
  row.callState.readReceipt.toolCallId = "a";
  assert.equal(normalizeSkillCall(row).instructionLoaded, true);
  assert.equal(normalizeSkillCall(row).callState.toolCallId, "a");
});

test("persisted trace retains bounded reason and receipt metadata, never body text", () => {
  const row = demandRow();
  row.body = "SECRET_METHOD_BODY";
  row.callState.readReceipt.body = "SECRET_RECEIPT_BODY";
  row.callState.readReceipt.extra = { arbitrary: "SECRET_EXTRA" };
  row.reason += "因".repeat(300);
  const trace = normalizeCapabilityTrace({ primarySkillId: row.id, skills: [row] });
  const saved = trace.skills[0];
  assert.equal(saved.instructionLoaded, true);
  assert.equal(saved.source, "model-demand");
  assert.equal(saved.applicationMode, "governing");
  assert.equal(saved.reason.length, 240);
  assert.equal(saved.callState.toolCallId, toolCallId);
  assert.equal(saved.callState.readReceipt.toolCallId, toolCallId);
  assert.equal(saved.version, "1.2.0");
  assert.equal(saved.contentHash.replace(/^sha256:/, ""), definitionHash);
  assert.doesNotMatch(JSON.stringify(trace), /SECRET_|arbitrary/u);
  assert.deepEqual(normalizeCapabilityTrace(trace), trace);
});

test("local read, channel submission, and completion remain distinct milestones", () => {
  const row = { ...demandRow(), ...normalizeSkillCall(demandRow()) };
  const localDescription = skillCallDescription(row);
  assert.match(localDescription, /完整读取/u);
  assert.match(localDescription, /尚未向模型通道提交/u);
  assert.match(localDescription, /不证明.*理解/u);
  const submitted = advanceSkillCalls([row], "attempt-1", "submitted", {}, at)[0];
  assert.equal(submitted.callState.submittedAt, at);
  assert.match(skillCallDescription(submitted), /已向模型通道发起提交/u);
  assert.equal(submitted.callState.readReceipt.toolCallId, toolCallId);
  const done = advanceSkillCalls([submitted], "attempt-1", "completed", {}, at)[0];
  assert.equal(done.callState.outcome, "completed");
  assert.equal(done.instructionLoaded, true);
});

test("legacy provider local-prompt receipt remains accepted and unexpanded", () => {
  const row = demandRow("provider-api");
  row.source = "explicit";
  row.callState.readReceipt.scope = "local-prompt";
  delete row.callState.toolCallId;
  delete row.callState.readReceipt.toolCallId;
  const normalized = normalizeSkillCall(row);
  assert.equal(normalized.instructionLoaded, true);
  assert.equal(normalized.callState.readReceipt.scope, "local-prompt");
  assert.equal(normalized.callState.readReceipt.toolCallId, undefined);
  row.callState.readReceipt.channel = "codex-app-server";
  assert.equal(normalizeSkillCall(row).instructionLoaded, false);
});

test("advisory rows cannot elevate a receipt to instruction loaded", () => {
  const row = demandRow();
  row.applicationMode = "advisory";
  const result = normalizeSkillCall(row);
  assert.equal(result.instructionLoaded, false);
  assert.equal(result.callState.stage, "recommended");
  assert.equal(result.callState.readReceipt, null);
});
