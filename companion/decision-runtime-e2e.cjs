"use strict";

const { buildDecisionRecordFromEnvelope, parseModelCandidateEnvelope } = require("./decision-candidate-envelope.cjs");
const { applyDerivedState, createDecisionSnapshot } = require("./decision-kernel.cjs");
const {
  createActionBinding,
  createFeedbackObservation,
  validateActionBindingAgainstSnapshot,
  validateFeedbackAgainstAction,
} = require("./decision-action-feedback.cjs");

const FIXED_TIME = "2026-10-03T10:00:00.000Z";

function createRuntimeLifecycleFixture() {
  const envelope = {
    candidateEnvelopeVersion: 1,
    question: "未来 30 天是否暂停功能开发，先验证真实用户需求？",
    timeHorizon: "30 天",
    scope: "行知个人试用版",
    options: [
      { label: "暂停新增功能并访谈 5 位目标用户", kind: "experiment", availability: "available", outcomes: ["获得真实使用反馈"], risks: ["短期功能迭代放缓"] },
      { label: "继续开发已列出的功能", kind: "candidate", availability: "available", outcomes: ["产品功能增加"], risks: ["需求仍未验证"] },
      { label: "维持现状并暂缓决定", kind: "default-trajectory", availability: "available", outcomes: ["保留当前节奏"], risks: ["继续投入时间但证据不增加"] },
    ],
    findings: [
      { id: "f-user-goal", lensId: "dialogue-synthesis", sourceMessageId: "msg-user-001", pathStage: "none", statement: "用户希望先完成真实用户试用与需求验证。", epistemicStatus: "user-statement", relation: "support", optionIndexes: [0], evidenceRefs: [], assumptions: [] },
      { id: "f-unknown", lensId: "dialogue-synthesis", sourceMessageId: "msg-user-001", pathStage: "none", statement: "当前尚不清楚目标用户是否愿意持续使用或付费。", epistemicStatus: "unknown", relation: "context", optionIndexes: [0, 1], evidenceRefs: [], assumptions: [] },
    ],
    recommendation: { optionIndexes: [0], basisFindingIds: ["f-user-goal"] },
    gates: [],
  };
  return {
    envelope,
    context: { sourceMessageIds: ["msg-user-001"], allowedLensIds: [], evidenceCatalog: [] },
    conversationId: "conversation-fixture-001",
  };
}

function runDecisionLifecycleSimulation() {
  const fixture = createRuntimeLifecycleFixture();
  const normalized = parseModelCandidateEnvelope(fixture.envelope, fixture.context);
  const candidate = buildDecisionRecordFromEnvelope(normalized, {
    sourceConversationId: fixture.conversationId,
    ...fixture.context,
  });
  const confirmedAt = FIXED_TIME;
  const confirmed = {
    ...candidate,
    revision: candidate.revision + 1,
    userDecision: {
      mode: "experiment",
      selectedOptionRefs: [candidate.options[0].id],
      rationale: "先取得真实用户反馈，再决定是否继续扩展功能。",
      conditions: [],
      confirmedAt,
    },
  };
  const derived = applyDerivedState(confirmed);
  if (!derived.ok) throw new Error("模拟闭环：候选记录未通过派生状态校验");
  const snapshotResult = createDecisionSnapshot(derived.value, {
    snapshotId: "snap_runtime_e2e_001",
    confirmedAt,
  });
  if (!snapshotResult.ok) throw new Error("模拟闭环：未能创建确认快照");
  const snapshot = snapshotResult.value;
  const action = createActionBinding({
    actionId: "act_runtime_e2e_001",
    decisionSnapshotId: snapshot.snapshotId,
    decisionId: snapshot.decisionId,
    optionRefs: [candidate.options[0].id],
    claimRefs: [],
    assumptionRefs: candidate.claims.filter((claim) => claim.epistemicStatus === "hypothesis").map((claim) => claim.id),
    testType: "conversation",
    action: "访谈 5 位近期试用过行知的目标用户。",
    expectedSignal: "至少 3 人能指出实际使用价值，并有 1 人愿意继续试用。",
    failureSignal: "多數受访者无法说明使用价值或不愿再次使用。",
    observationWindow: "7 天",
    createdAt: FIXED_TIME,
    confirmedAt: FIXED_TIME,
  });
  validateActionBindingAgainstSnapshot(action, snapshot);
  const feedback = createFeedbackObservation({
    observationId: "obs_runtime_e2e_001",
    actionId: action.actionId,
    decisionSnapshotId: snapshot.snapshotId,
    targetType: "option",
    targetRef: candidate.options[0].id,
    actualAction: "已完成 5 次访谈。",
    observation: "3 人愿意继续试用，1 人愿意讨论付费。",
    calibration: "supported",
    rationale: "达到预先记录的继续试用信号。",
    attribution: { decisionQuality: "adequate", predictionAccuracy: "accurate", executionFidelity: "aligned", environmentShift: "none-observed" },
    occurredAt: FIXED_TIME,
    recordedAt: FIXED_TIME,
  });
  validateFeedbackAgainstAction(feedback, action);
  const frozenBefore = JSON.stringify(snapshot);
  const reviewCandidate = Object.freeze({
    reviewCandidateSchemaVersion: 1,
    status: "pending-user-review",
    decisionId: snapshot.decisionId,
    decisionSnapshotId: snapshot.snapshotId,
    actionId: action.actionId,
    observationId: feedback.observationId,
    observedCalibration: feedback.calibration,
    proposedNextStep: "由用户决定是否创建新的判断修订；原确认快照保持不变。",
  });
  const frozenAfter = JSON.stringify(snapshot);
  if (frozenBefore !== frozenAfter) throw new Error("模拟闭环：反馈修改了不可变快照");
  return Object.freeze({
    ok: true,
    stages: Object.freeze(["candidate", "record", "user-confirmation", "immutable-snapshot", "action", "feedback", "review-candidate"]),
    decisionId: candidate.decisionId,
    snapshotId: snapshot.snapshotId,
    actionId: action.actionId,
    observationId: feedback.observationId,
    snapshotUnchangedAfterFeedback: frozenBefore === frozenAfter,
    reviewCandidate,
  });
}

module.exports = { createRuntimeLifecycleFixture, runDecisionLifecycleSimulation };
