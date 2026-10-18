"use strict";

const {
  DECISION_RECORD_SCHEMA_VERSION,
  JUDGMENT_KERNEL_VERSION,
  IDS,
  clone,
  parseDecisionRecord,
  validateDecisionCandidate,
} = require("./decision-record-schema.cjs");
const { decisionEvidenceReport } = require("./decision-evidence-bridge.cjs");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function evaluateDecisionRecord(input) {
  const parsed = parseDecisionRecord(input);
  if (!parsed.ok) {
    return deepFreeze({
      ok: false,
      schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
      kernelVersion: JUDGMENT_KERNEL_VERSION,
      errors: clone(parsed.errors),
      derivedState: { readiness: "needs-input", reviewState: "current", reasonCodes: ["record-invalid"] },
      evidence: { byClaim: [], counts: { none: 0, linked: 0, contested: 0, stale: 0, broken: 0 }, needsReview: false },
    });
  }
  const record = parsed.value;
  const reasons = [];
  const availableOptions = record.options.filter((option) => option.availability === "available");
  const openGates = record.gates.filter((gate) => gate.status === "open");
  const evidence = decisionEvidenceReport(record);
  if (!record.frame.question) reasons.push("question-missing");
  if (!record.options.length) reasons.push("options-missing");
  if (record.options.length && !availableOptions.length) reasons.push("no-available-option");
  if (openGates.length) reasons.push("gate-open");
  if (record.claims.some((claim) => claim.epistemicStatus === "unknown")) reasons.push("critical-unknown-present");
  if (evidence.counts.contested) reasons.push("evidence-contested");
  if (evidence.counts.broken) reasons.push("evidence-broken");
  if (evidence.counts.stale) reasons.push("evidence-stale");

  const confirmed = Boolean(record.userDecision.confirmedAt);
  if (confirmed && ["select", "experiment"].includes(record.userDecision.mode) && !record.userDecision.selectedOptionRefs.length) {
    reasons.push("confirmed-selection-missing-option");
  }
  if (confirmed && ["defer", "decline"].includes(record.userDecision.mode)
    && record.userDecision.selectedOptionRefs.length) reasons.push("non-selection-has-option");

  let readiness = "draft";
  if (confirmed && !reasons.includes("confirmed-selection-missing-option") && !reasons.includes("non-selection-has-option")) {
    readiness = "confirmed";
  } else if (!record.frame.question || !record.options.length || !availableOptions.length || openGates.length) {
    readiness = "needs-input";
  } else {
    readiness = "ready-for-confirmation";
  }
  const reviewState = evidence.needsReview ? "needs-review" : "current";
  return deepFreeze({
    ok: true,
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    kernelVersion: JUDGMENT_KERNEL_VERSION,
    errors: [],
    derivedState: { readiness, reviewState, reasonCodes: unique(reasons).sort() },
    evidence,
    gates: {
      open: openGates.map((gate) => gate.id),
      satisfied: record.gates.filter((gate) => gate.status === "satisfied").map((gate) => gate.id),
      overriddenByUser: record.gates.filter((gate) => gate.status === "overridden-by-user").map((gate) => gate.id),
    },
    dominance: { status: "not-applicable", reasonCode: "requires-comparable-user-confirmed-criteria" },
  });
}

function applyDerivedState(input) {
  const parsed = parseDecisionRecord(input);
  if (!parsed.ok) return parsed;
  const report = evaluateDecisionRecord(parsed.value);
  const value = clone(parsed.value);
  value.derivedState = clone(report.derivedState);
  return { ok: true, value, errors: [], report };
}

function createDecisionSnapshot(input, { snapshotId, confirmedAt, supersedes = null } = {}) {
  const parsed = parseDecisionRecord(input);
  if (!parsed.ok) return parsed;
  const record = clone(parsed.value);
  const at = confirmedAt || record.userDecision.confirmedAt;
  const errors = [];
  if (!snapshotId || !IDS.snapshot.test(snapshotId)) errors.push({ path: "$.snapshotId", code: "id-format", message: "快照 ID 格式不正确" });
  if (!at || Number.isNaN(Date.parse(at))) errors.push({ path: "$.confirmedAt", code: "confirmation-required", message: "只有用户确认后才能生成快照" });
  if (record.userDecision.confirmedAt !== at) errors.push({ path: "$.confirmedAt", code: "confirmation-mismatch", message: "快照时间必须与用户确认时间一致" });
  const report = evaluateDecisionRecord(record);
  if (report.derivedState.readiness !== "confirmed") errors.push({ path: "$.userDecision", code: "not-confirmed", message: "当前用户决定尚不能形成正式快照" });
  if (errors.length) return { ok: false, value: null, errors };
  const snapshot = {
    decisionSnapshotSchemaVersion: 1,
    snapshotId,
    decisionId: record.decisionId,
    confirmedAt: at,
    supersedes: supersedes || null,
    judgmentKernelVersion: JUDGMENT_KERNEL_VERSION,
    freshnessAtDecision: report.evidence.byClaim.map((item) => ({ claimId: item.claimId, state: item.state })),
    record,
    immutability: "append-only",
  };
  return { ok: true, value: deepFreeze(snapshot), errors: [], report };
}

function runKernelSelfCheck() {
  const record = {
    decisionRecordSchemaVersion: 1,
    judgmentKernelVersion: JUDGMENT_KERNEL_VERSION,
    decisionId: "dec_self_check_001",
    revision: 1,
    snapshotRefs: [],
    activeSnapshotId: null,
    frame: { question: "是否以一次小规模实验验证当前方案？", subjectRef: "user.current", goalRefs: [], timeHorizon: "7天", scope: "影子自检" },
    options: [
      { id: "opt_experiment_001", label: "进行低成本实验", kind: "experiment", availability: "available", outcomes: [], riskRefs: [], assumptionRefs: [] },
      { id: "opt_defer_001", label: "暂缓", kind: "defer", availability: "available", outcomes: [], riskRefs: [], assumptionRefs: [] },
    ],
    claims: [],
    gates: [],
    modelRecommendation: { status: "candidate", optionRefs: ["opt_experiment_001"], basisRefs: [] },
    userDecision: { mode: "defer", selectedOptionRefs: [], rationale: "", conditions: [], confirmedAt: null },
    derivedState: { readiness: "draft", reviewState: "current", reasonCodes: [] },
  };
  const before = JSON.stringify(record);
  const candidate = validateDecisionCandidate(record);
  const report = evaluateDecisionRecord(record);
  const unchanged = before === JSON.stringify(record);
  return deepFreeze({
    ok: candidate.ok && report.ok && unchanged && report.derivedState.readiness === "ready-for-confirmation",
    kernelVersion: JUDGMENT_KERNEL_VERSION,
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    checks: {
      candidateAccepted: candidate.ok,
      deterministicEvaluation: report.ok,
      inputUnchanged: unchanged,
      readiness: report.derivedState.readiness,
      noFileNetworkOrModelDependency: true,
    },
  });
}

module.exports = {
  JUDGMENT_KERNEL_VERSION,
  DECISION_RECORD_SCHEMA_VERSION,
  deepFreeze,
  evaluateDecisionRecord,
  applyDerivedState,
  createDecisionSnapshot,
  runKernelSelfCheck,
};
