"use strict";

const CALIBRATION = new Set(["supported", "weakened", "falsified", "uncertain", "not-assessed"]);
const TARGET_TYPES = new Set(["option", "claim", "assumption", "prediction", "decision"]);
const TEST_TYPES = new Set(["experiment", "observation", "research", "conversation", "execution"]);
const ATTRIBUTION = Object.freeze({
  decisionQuality: new Set(["unknown", "adequate", "weak"]),
  predictionAccuracy: new Set(["unknown", "accurate", "mixed", "inaccurate"]),
  executionFidelity: new Set(["unknown", "aligned", "partial", "diverged"]),
  environmentShift: new Set(["unknown", "none-observed", "material"]),
});

function field(value, label, required = false, maximum = 4000) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`请填写${label}`);
  if (result.length > maximum) throw new Error(`${label}过长`);
  return result;
}

function timestamp(value, label) {
  const result = field(value, label, true, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label}无效`);
  return result;
}

function refs(value, prefix, label) {
  const list = Array.isArray(value) ? value : [];
  const result = [...new Set(list.map((item) => field(item, label, true, 128)))];
  if (result.some((item) => !item.startsWith(prefix))) throw new Error(`${label}引用无效`);
  return result;
}

function createActionBinding(input) {
  const testType = field(input?.testType, "验证类型", true, 32);
  if (!TEST_TYPES.has(testType)) throw new Error("验证类型无效");
  const binding = {
    actionBindingSchemaVersion: 1,
    actionId: field(input.actionId, "行动 ID", true, 128),
    decisionSnapshotId: field(input.decisionSnapshotId, "判断快照 ID", true, 128),
    decisionId: field(input.decisionId, "判断记录 ID", true, 128),
    optionRefs: refs(input.optionRefs, "opt_", "选项"),
    claimRefs: refs(input.claimRefs, "clm_", "主张"),
    assumptionRefs: refs(input.assumptionRefs, "clm_", "假设"),
    testType,
    action: field(input.action, "验证行动", true),
    expectedSignal: field(input.expectedSignal, "预期信号", false),
    failureSignal: field(input.failureSignal, "失败信号", false),
    observationWindow: field(input.observationWindow, "观察窗口", false, 500),
    createdAt: timestamp(input.createdAt, "创建时间"),
    confirmation: { status: "user-confirmed", confirmedAt: timestamp(input.confirmedAt, "确认时间") },
  };
  if (!binding.optionRefs.length && !binding.claimRefs.length && !binding.assumptionRefs.length) {
    throw new Error("验证行动必须指向选项、主张或假设");
  }
  return binding;
}

function createFeedbackObservation(input) {
  const targetType = field(input?.targetType, "反馈目标类型", true, 32);
  if (!TARGET_TYPES.has(targetType)) throw new Error("反馈目标类型无效");
  const calibration = field(input.calibration, "校准状态", true, 32);
  if (!CALIBRATION.has(calibration)) throw new Error("校准状态无效");
  const attribution = {};
  for (const [key, allowed] of Object.entries(ATTRIBUTION)) {
    const value = field(input?.attribution?.[key] || "unknown", key, true, 32);
    if (!allowed.has(value)) throw new Error(`${key}归因无效`);
    attribution[key] = value;
  }
  return {
    feedbackObservationSchemaVersion: 1,
    observationId: field(input.observationId, "反馈 ID", true, 128),
    actionId: field(input.actionId, "行动 ID", true, 128),
    decisionSnapshotId: field(input.decisionSnapshotId, "判断快照 ID", true, 128),
    targetType,
    targetRef: field(input.targetRef, "反馈目标", true, 128),
    actualAction: field(input.actualAction, "实际行动", true),
    observation: field(input.observation, "实际观察", true),
    calibration,
    rationale: field(input.rationale, "校准依据", calibration !== "not-assessed"),
    attribution,
    occurredAt: timestamp(input.occurredAt, "发生时间"),
    recordedAt: timestamp(input.recordedAt, "记录时间"),
    revisionCandidateOnly: true,
  };
}

function validateActionBindingAgainstSnapshot(binding, snapshot) {
  if (!snapshot || snapshot.snapshotId !== binding.decisionSnapshotId) throw new Error("行动绑定的判断快照不存在或不匹配");
  if (snapshot.decisionId !== binding.decisionId) throw new Error("行动绑定的判断记录不匹配");
  const record = snapshot.record || {};
  const optionIds = new Set((record.options || []).map((item) => item.id));
  const claimIds = new Set((record.claims || []).map((item) => item.id));
  const hypothesisIds = new Set((record.claims || []).filter((item) => item.epistemicStatus === "hypothesis").map((item) => item.id));
  for (const ref of binding.optionRefs) if (!optionIds.has(ref)) throw new Error(`行动引用了快照中不存在的选项：${ref}`);
  for (const ref of binding.claimRefs) if (!claimIds.has(ref)) throw new Error(`行动引用了快照中不存在的主张：${ref}`);
  for (const ref of binding.assumptionRefs) {
    if (!claimIds.has(ref)) throw new Error(`行动引用了快照中不存在的假设：${ref}`);
    if (!hypothesisIds.has(ref)) throw new Error(`行动把非假设主张标记为假设：${ref}`);
  }
  return true;
}

function validateFeedbackAgainstAction(observation, binding) {
  if (observation.actionId !== binding.actionId) throw new Error("反馈绑定的行动不匹配");
  if (observation.decisionSnapshotId !== binding.decisionSnapshotId) throw new Error("反馈绑定的判断快照不匹配");
  const allowed = new Set([
    ...binding.optionRefs.map((ref) => `option:${ref}`),
    ...binding.claimRefs.map((ref) => `claim:${ref}`),
    ...binding.assumptionRefs.map((ref) => `assumption:${ref}`),
  ]);
  if (!allowed.has(`${observation.targetType}:${observation.targetRef}`)) throw new Error("反馈目标不属于该行动的精确绑定范围");
  return true;
}

module.exports = {
  CALIBRATION,
  TARGET_TYPES,
  TEST_TYPES,
  createActionBinding,
  createFeedbackObservation,
  validateActionBindingAgainstSnapshot,
  validateFeedbackAgainstAction,
};
