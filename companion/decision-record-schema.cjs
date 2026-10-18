"use strict";

const DECISION_RECORD_SCHEMA_VERSION = 1;
const JUDGMENT_KERNEL_VERSION = "3.0.0";

const ENUMS = Object.freeze({
  optionKind: new Set(["candidate", "default-trajectory", "defer", "experiment"]),
  availability: new Set(["available", "unavailable", "unknown"]),
  epistemicStatus: new Set(["fact", "user-statement", "inference", "hypothesis", "value-judgment", "unknown"]),
  evidenceRelation: new Set(["support", "oppose", "context"]),
  evidenceStatus: new Set(["retrieved", "used", "cited", "user-confirmed"]),
  freshness: new Set(["current", "monitoring", "stale", "invalid", "unknown"]),
  gateType: new Set(["hard-constraint", "legal-review", "safety-review", "missing-critical-evidence"]),
  gateStatus: new Set(["open", "satisfied", "overridden-by-user", "not-applicable"]),
  authority: new Set(["user", "policy", "source", "system-derived"]),
  recommendationStatus: new Set(["candidate"]),
  decisionMode: new Set(["select", "defer", "experiment", "decline"]),
  readiness: new Set(["draft", "needs-input", "ready-for-confirmation", "confirmed"]),
  reviewState: new Set(["current", "needs-review"]),
});

const IDS = Object.freeze({
  decision: /^dec_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
  option: /^opt_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
  claim: /^clm_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
  gate: /^gate_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
  snapshot: /^snap_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function push(errors, path, code, message) {
  errors.push({ path, code, message });
}

function rejectUnknownKeys(value, allowed, path, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(errors, `${path}.${key}`, "unknown-field", "字段不在 Decision Record v1 契约中");
  }
}

function text(value, path, errors, { required = false, maximum = 4000 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) push(errors, path, "required", "缺少必填文本");
    return "";
  }
  if (typeof value !== "string") {
    push(errors, path, "type", "必须是文本");
    return "";
  }
  const result = value.trim();
  if (required && !result) push(errors, path, "required", "缺少必填文本");
  if (result.length > maximum) push(errors, path, "too-long", `文本不能超过 ${maximum} 个字符`);
  return result.slice(0, maximum);
}

function enumValue(value, allowed, path, errors, fallback = "unknown") {
  if (!allowed.has(value)) {
    push(errors, path, "enum", `不支持的值：${String(value)}`);
    return fallback;
  }
  return value;
}

function idValue(value, pattern, path, errors) {
  const result = text(value, path, errors, { required: true, maximum: 128 });
  if (result && !pattern.test(result)) push(errors, path, "id-format", "稳定 ID 格式不正确");
  return result;
}

function stringList(value, path, errors, { maximum = 200, idPattern = null } = {}) {
  if (!Array.isArray(value)) {
    push(errors, path, "type", "必须是数组");
    return [];
  }
  if (value.length > maximum) push(errors, path, "too-many", `最多允许 ${maximum} 项`);
  const result = [];
  for (let index = 0; index < Math.min(value.length, maximum); index += 1) {
    const item = text(value[index], `${path}[${index}]`, errors, { required: true, maximum: 512 });
    if (idPattern && item && !idPattern.test(item)) push(errors, `${path}[${index}]`, "id-format", "引用 ID 格式不正确");
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

function parseEvidenceEdge(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "type", "证据边必须是对象");
    return null;
  }
  rejectUnknownKeys(value, new Set([
    "evidenceId", "revisionId", "relation", "status", "locator", "quoteHash", "retrievedAt", "freshnessAtDecision",
  ]), path, errors);
  const edge = {
    evidenceId: text(value.evidenceId, `${path}.evidenceId`, errors, { required: true, maximum: 512 }),
    revisionId: text(value.revisionId, `${path}.revisionId`, errors, { maximum: 256 }) || null,
    relation: enumValue(value.relation, ENUMS.evidenceRelation, `${path}.relation`, errors, "context"),
    status: enumValue(value.status, ENUMS.evidenceStatus, `${path}.status`, errors, "retrieved"),
    locator: text(value.locator, `${path}.locator`, errors, { maximum: 1000 }) || null,
    quoteHash: text(value.quoteHash, `${path}.quoteHash`, errors, { maximum: 128 }) || null,
    retrievedAt: text(value.retrievedAt, `${path}.retrievedAt`, errors, { maximum: 64 }) || null,
    freshnessAtDecision: enumValue(value.freshnessAtDecision || "unknown", ENUMS.freshness, `${path}.freshnessAtDecision`, errors),
  };
  if (edge.retrievedAt && Number.isNaN(Date.parse(edge.retrievedAt))) {
    push(errors, `${path}.retrievedAt`, "timestamp", "必须是有效时间");
  }
  return edge;
}

function parseOption(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "type", "选项必须是对象");
    return null;
  }
  rejectUnknownKeys(value, new Set(["id", "label", "kind", "availability", "outcomes", "riskRefs", "assumptionRefs"]), path, errors);
  return {
    id: idValue(value.id, IDS.option, `${path}.id`, errors),
    label: text(value.label, `${path}.label`, errors, { required: true, maximum: 240 }),
    kind: enumValue(value.kind, ENUMS.optionKind, `${path}.kind`, errors, "candidate"),
    availability: enumValue(value.availability, ENUMS.availability, `${path}.availability`, errors),
    outcomes: stringList(value.outcomes || [], `${path}.outcomes`, errors, { maximum: 50 }),
    riskRefs: stringList(value.riskRefs || [], `${path}.riskRefs`, errors, { maximum: 50 }),
    assumptionRefs: stringList(value.assumptionRefs || [], `${path}.assumptionRefs`, errors, { maximum: 50, idPattern: IDS.claim }),
  };
}

function parseClaim(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "type", "主张必须是对象");
    return null;
  }
  rejectUnknownKeys(value, new Set(["id", "text", "epistemicStatus", "evidenceEdges", "assumptionRefs", "optionRelations", "sourceFindingRefs"]), path, errors);
  const optionRelations = Array.isArray(value.optionRelations) ? value.optionRelations.map((relation, index) => {
    const relationPath = `${path}.optionRelations[${index}]`;
    if (!isObject(relation)) {
      push(errors, relationPath, "type", "选项关系必须是对象");
      return null;
    }
    rejectUnknownKeys(relation, new Set(["optionRef", "relation"]), relationPath, errors);
    return {
      optionRef: idValue(relation.optionRef, IDS.option, `${relationPath}.optionRef`, errors),
      relation: enumValue(relation.relation, ENUMS.evidenceRelation, `${relationPath}.relation`, errors, "context"),
    };
  }).filter(Boolean) : [];
  if (value.optionRelations !== undefined && !Array.isArray(value.optionRelations)) push(errors, `${path}.optionRelations`, "type", "必须是数组");
  return {
    id: idValue(value.id, IDS.claim, `${path}.id`, errors),
    text: text(value.text, `${path}.text`, errors, { required: true, maximum: 2000 }),
    epistemicStatus: enumValue(value.epistemicStatus, ENUMS.epistemicStatus, `${path}.epistemicStatus`, errors),
    evidenceEdges: Array.isArray(value.evidenceEdges)
      ? value.evidenceEdges.slice(0, 100).map((edge, index) => parseEvidenceEdge(edge, `${path}.evidenceEdges[${index}]`, errors)).filter(Boolean)
      : [],
    assumptionRefs: stringList(value.assumptionRefs || [], `${path}.assumptionRefs`, errors, { maximum: 50, idPattern: IDS.claim }),
    optionRelations,
    sourceFindingRefs: stringList(value.sourceFindingRefs || [], `${path}.sourceFindingRefs`, errors, { maximum: 50 }),
  };
}

function parseGate(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "type", "门槛必须是对象");
    return null;
  }
  rejectUnknownKeys(value, new Set(["id", "type", "status", "reason", "sourceRefs", "authority", "userConfirmed"]), path, errors);
  const gate = {
    id: idValue(value.id, IDS.gate, `${path}.id`, errors),
    type: enumValue(value.type, ENUMS.gateType, `${path}.type`, errors, "missing-critical-evidence"),
    status: enumValue(value.status, ENUMS.gateStatus, `${path}.status`, errors, "open"),
    reason: text(value.reason, `${path}.reason`, errors, { required: true, maximum: 1000 }),
    sourceRefs: stringList(value.sourceRefs || [], `${path}.sourceRefs`, errors, { maximum: 50 }),
    authority: enumValue(value.authority, ENUMS.authority, `${path}.authority`, errors, "system-derived"),
    userConfirmed: value.userConfirmed === true,
  };
  if (gate.type === "hard-constraint" && gate.authority === "user" && gate.userConfirmed !== true) {
    push(errors, `${path}.userConfirmed`, "user-confirmation-required", "用户硬约束必须由用户确认");
  }
  return gate;
}

function validateReferences(record, errors) {
  const optionIds = new Set(record.options.map((item) => item.id));
  const claimIds = new Set(record.claims.map((item) => item.id));
  const duplicate = (items, path) => {
    const seen = new Set();
    for (let index = 0; index < items.length; index += 1) {
      if (seen.has(items[index].id)) push(errors, `${path}[${index}].id`, "duplicate-id", "稳定 ID 重复");
      seen.add(items[index].id);
    }
  };
  duplicate(record.options, "$.options");
  duplicate(record.claims, "$.claims");
  duplicate(record.gates, "$.gates");
  for (let index = 0; index < record.options.length; index += 1) {
    for (const ref of record.options[index].assumptionRefs) {
      if (!claimIds.has(ref)) push(errors, `$.options[${index}].assumptionRefs`, "dangling-reference", `找不到主张 ${ref}`);
    }
  }
  for (let index = 0; index < record.claims.length; index += 1) {
    const claim = record.claims[index];
    for (const ref of claim.assumptionRefs) {
      if (!claimIds.has(ref)) push(errors, `$.claims[${index}].assumptionRefs`, "dangling-reference", `找不到主张 ${ref}`);
    }
    for (const relation of claim.optionRelations) {
      if (!optionIds.has(relation.optionRef)) push(errors, `$.claims[${index}].optionRelations`, "dangling-reference", `找不到选项 ${relation.optionRef}`);
    }
  }
  for (const ref of record.modelRecommendation.optionRefs) {
    if (!optionIds.has(ref)) push(errors, "$.modelRecommendation.optionRefs", "dangling-reference", `找不到选项 ${ref}`);
  }
  for (const ref of record.modelRecommendation.basisRefs) {
    if (!claimIds.has(ref)) push(errors, "$.modelRecommendation.basisRefs", "dangling-reference", `找不到主张 ${ref}`);
  }
  for (const ref of record.userDecision.selectedOptionRefs) {
    if (!optionIds.has(ref)) push(errors, "$.userDecision.selectedOptionRefs", "dangling-reference", `找不到选项 ${ref}`);
  }
}

function parseDecisionRecord(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, value: null, errors: [{ path: "$", code: "type", message: "Decision Record 必须是对象" }] };
  rejectUnknownKeys(input, new Set([
    "decisionRecordSchemaVersion", "judgmentKernelVersion", "decisionId", "revision", "snapshotRefs", "activeSnapshotId", "frame", "options", "claims", "gates", "modelRecommendation", "userDecision", "derivedState",
  ]), "$", errors);
  if (input.decisionRecordSchemaVersion !== DECISION_RECORD_SCHEMA_VERSION) push(errors, "$.decisionRecordSchemaVersion", "schema-version", "只接受 Decision Record schema v1");
  if (input.judgmentKernelVersion !== JUDGMENT_KERNEL_VERSION) push(errors, "$.judgmentKernelVersion", "kernel-version", `内核版本必须是 ${JUDGMENT_KERNEL_VERSION}`);

  const frameInput = isObject(input.frame) ? input.frame : {};
  if (!isObject(input.frame)) push(errors, "$.frame", "type", "frame 必须是对象");
  rejectUnknownKeys(frameInput, new Set(["question", "subjectRef", "goalRefs", "timeHorizon", "scope"]), "$.frame", errors);
  const frame = {
    question: text(frameInput.question, "$.frame.question", errors, { required: true, maximum: 1000 }),
    subjectRef: text(frameInput.subjectRef, "$.frame.subjectRef", errors, { maximum: 512 }) || null,
    goalRefs: stringList(frameInput.goalRefs || [], "$.frame.goalRefs", errors, { maximum: 50 }),
    timeHorizon: text(frameInput.timeHorizon, "$.frame.timeHorizon", errors, { maximum: 240 }) || null,
    scope: text(frameInput.scope, "$.frame.scope", errors, { maximum: 1000 }) || null,
  };

  const options = Array.isArray(input.options)
    ? input.options.slice(0, 100).map((item, index) => parseOption(item, `$.options[${index}]`, errors)).filter(Boolean)
    : [];
  if (!Array.isArray(input.options)) push(errors, "$.options", "type", "options 必须是数组");
  const claims = Array.isArray(input.claims)
    ? input.claims.slice(0, 300).map((item, index) => parseClaim(item, `$.claims[${index}]`, errors)).filter(Boolean)
    : [];
  if (!Array.isArray(input.claims)) push(errors, "$.claims", "type", "claims 必须是数组");
  const gates = Array.isArray(input.gates)
    ? input.gates.slice(0, 100).map((item, index) => parseGate(item, `$.gates[${index}]`, errors)).filter(Boolean)
    : [];
  if (!Array.isArray(input.gates)) push(errors, "$.gates", "type", "gates 必须是数组");

  const recommendationInput = isObject(input.modelRecommendation) ? input.modelRecommendation : {};
  if (!isObject(input.modelRecommendation)) push(errors, "$.modelRecommendation", "type", "modelRecommendation 必须是对象");
  rejectUnknownKeys(recommendationInput, new Set(["status", "optionRefs", "basisRefs"]), "$.modelRecommendation", errors);
  const modelRecommendation = {
    status: enumValue(recommendationInput.status, ENUMS.recommendationStatus, "$.modelRecommendation.status", errors, "candidate"),
    optionRefs: stringList(recommendationInput.optionRefs || [], "$.modelRecommendation.optionRefs", errors, { maximum: 20, idPattern: IDS.option }),
    basisRefs: stringList(recommendationInput.basisRefs || [], "$.modelRecommendation.basisRefs", errors, { maximum: 50, idPattern: IDS.claim }),
  };

  const userInput = isObject(input.userDecision) ? input.userDecision : {};
  if (!isObject(input.userDecision)) push(errors, "$.userDecision", "type", "userDecision 必须是对象");
  rejectUnknownKeys(userInput, new Set(["mode", "selectedOptionRefs", "rationale", "conditions", "confirmedAt"]), "$.userDecision", errors);
  const confirmedAt = text(userInput.confirmedAt, "$.userDecision.confirmedAt", errors, { maximum: 64 }) || null;
  if (confirmedAt && Number.isNaN(Date.parse(confirmedAt))) push(errors, "$.userDecision.confirmedAt", "timestamp", "必须是有效时间");
  const userDecision = {
    mode: enumValue(userInput.mode, ENUMS.decisionMode, "$.userDecision.mode", errors, "defer"),
    selectedOptionRefs: stringList(userInput.selectedOptionRefs || [], "$.userDecision.selectedOptionRefs", errors, { maximum: 20, idPattern: IDS.option }),
    rationale: text(userInput.rationale, "$.userDecision.rationale", errors, { maximum: 4000 }),
    conditions: stringList(userInput.conditions || [], "$.userDecision.conditions", errors, { maximum: 50 }),
    confirmedAt,
  };

  const derivedInput = isObject(input.derivedState) ? input.derivedState : {};
  if (!isObject(input.derivedState)) push(errors, "$.derivedState", "type", "derivedState 必须是对象");
  rejectUnknownKeys(derivedInput, new Set(["readiness", "reviewState", "reasonCodes"]), "$.derivedState", errors);
  const derivedState = {
    readiness: enumValue(derivedInput.readiness, ENUMS.readiness, "$.derivedState.readiness", errors, "draft"),
    reviewState: enumValue(derivedInput.reviewState, ENUMS.reviewState, "$.derivedState.reviewState", errors, "current"),
    reasonCodes: stringList(derivedInput.reasonCodes || [], "$.derivedState.reasonCodes", errors, { maximum: 100 }),
  };

  const value = {
    decisionRecordSchemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    judgmentKernelVersion: JUDGMENT_KERNEL_VERSION,
    decisionId: idValue(input.decisionId, IDS.decision, "$.decisionId", errors),
    revision: Number.isSafeInteger(input.revision) && input.revision >= 1 ? input.revision : 1,
    snapshotRefs: stringList(input.snapshotRefs || [], "$.snapshotRefs", errors, { maximum: 200, idPattern: IDS.snapshot }),
    activeSnapshotId: input.activeSnapshotId === null || input.activeSnapshotId === undefined || input.activeSnapshotId === ""
      ? null : idValue(input.activeSnapshotId, IDS.snapshot, "$.activeSnapshotId", errors),
    frame,
    options,
    claims,
    gates,
    modelRecommendation,
    userDecision,
    derivedState,
  };
  validateReferences(value, errors);
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) {
    push(errors, "$.revision", "type", "revision 必须是大于等于 1 的整数");
  }
  if (value.activeSnapshotId && !value.snapshotRefs.includes(value.activeSnapshotId)) {
    push(errors, "$.activeSnapshotId", "dangling-reference", "活动快照必须出现在 snapshotRefs 中");
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

function validateDecisionCandidate(input) {
  const parsed = parseDecisionRecord(input);
  if (!parsed.ok) return parsed;
  const errors = [];
  if (parsed.value.userDecision.confirmedAt !== null) {
    push(errors, "$.userDecision.confirmedAt", "model-cannot-confirm", "模型候选不得设置用户确认时间");
  }
  for (let index = 0; index < parsed.value.gates.length; index += 1) {
    const gate = parsed.value.gates[index];
    if (gate.authority === "user" || gate.userConfirmed === true) {
      push(errors, `$.gates[${index}]`, "model-cannot-claim-user-authority", "模型候选不得冒充用户确认");
    }
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? parsed.value : null, errors };
}

module.exports = {
  DECISION_RECORD_SCHEMA_VERSION,
  JUDGMENT_KERNEL_VERSION,
  IDS,
  ENUMS,
  clone,
  parseDecisionRecord,
  validateDecisionCandidate,
};
