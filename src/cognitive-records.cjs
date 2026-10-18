"use strict";

const { randomUUID } = require("node:crypto");
const { validateVaultMarkdownPath } = require("./knowledge-writer.cjs");

const LOOP_ROOT = "07_行动/认知行动";
const FEEDBACK_ROOT = "08_结果与反馈/行动反馈";
const LOOP_MARKER_V1 = "XINGZHI_COGNITIVE_LOOP_V1";
const LOOP_MARKER_V2 = "XINGZHI_COGNITIVE_LOOP_V2";
const MAX_JUDGMENT_SNAPSHOTS = 50;
const DECISIONS = Object.freeze({ continue: "继续", adjust: "调整", stop: "停止", uncertain: "继续验证" });
const CALIBRATION_STATUSES = new Set(["not-assessed", "supported", "weakened", "falsified", "uncertain"]);
const CONFIDENCE_LEVELS = new Set(["unknown", "low", "medium", "high"]);
const ATTRIBUTION_STATUSES = Object.freeze({
  decisionQuality: new Set(["unknown", "adequate", "weak"]),
  predictionAccuracy: new Set(["unknown", "accurate", "mixed", "inaccurate"]),
  executionFidelity: new Set(["unknown", "aligned", "partial", "diverged"]),
  environmentShift: new Set(["unknown", "none-observed", "material"]),
});

function field(value, label, required = false, max = 4000) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${label}必须是文字`);
  const text = String(value || "").trim();
  if (required && !text) throw new Error(`请填写${label}`);
  if (text.length > max || text.includes("\0") || /<!--\s*(?:XINGZHI_|xingzhi-)/u.test(text)) throw new Error(`${label}过长或包含保留的记录标记`);
  return text;
}

function textList(value, label, maxItems = 20) {
  if (value === undefined || value === null || value === "") return [];
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/u) : null;
  if (!input || input.length > maxItems) throw new Error(`${label}格式无效或超过 ${maxItems} 项`);
  return [...new Set(input.map((item) => field(item, label, false, 800).replace(/^[-*]\s+/u, "")).filter(Boolean))];
}

function enumValue(value, allowed, fallback, label) {
  const normalized = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!allowed.has(normalized)) throw new Error(`${label}无效`);
  return normalized;
}

function validTime(value, label) {
  const text = field(value, label, true, 80);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label}无效`);
  return text;
}

function safeId(id) {
  if (!/^[A-Za-z0-9-]{1,100}$/u.test(id)) throw new Error("记录编号无效");
  return id;
}

function loopPath(id) { return `${LOOP_ROOT}/${safeId(id)}.md`; }
function feedbackPath(id) { return `${FEEDBACK_ROOT}/${safeId(id)}.md`; }

function sourcePaths(value) {
  if (!Array.isArray(value) || value.length > 12) throw new Error("最多关联 12 份已有依据");
  return [...new Set(value.filter(Boolean).map(path => validateVaultMarkdownPath(path)))];
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function judgmentSnapshot({
  loopId,
  version,
  capturedAt,
  statement,
  evidencePaths = [],
  assumptions = [],
  unknowns = [],
  confidenceLevel = "unknown",
  confidenceBasis = "",
  expected = "",
  successSignal = "",
  failureSignal = "",
  observationWindow = "",
  counterEvidence = "",
  changeCondition = "",
  sourceFeedbackId = null,
}) {
  const numericVersion = Number(version);
  if (!Number.isSafeInteger(numericVersion) || numericVersion < 1 || numericVersion > 200) throw new Error("判断快照版本无效");
  const time = validTime(capturedAt, "判断快照时间");
  return {
    id: `${safeId(loopId)}:judgment:${numericVersion}`,
    version: numericVersion,
    capturedAt: time,
    statement: field(statement, "判断", true),
    evidencePaths: sourcePaths(evidencePaths),
    assumptions: textList(assumptions, "判断假设"),
    unknowns: textList(unknowns, "判断未知"),
    confidence: {
      level: enumValue(confidenceLevel, CONFIDENCE_LEVELS, "unknown", "判断置信度"),
      basis: field(confidenceBasis, "置信度依据"),
    },
    prediction: {
      expected: field(expected, "预期结果"),
      successSignal: field(successSignal, "成功信号"),
      failureSignal: field(failureSignal, "失败信号"),
      observationWindow: field(observationWindow, "观察窗口"),
    },
    changeConditions: {
      counterEvidence: field(counterEvidence, "反证或未知"),
      changeCondition: field(changeCondition, "改变判断的条件"),
    },
    confirmation: {
      status: "user-confirmed",
      confirmedAt: time,
      source: "user-record",
    },
    sourceFeedbackId: sourceFeedbackId ? safeId(sourceFeedbackId) : null,
    immutability: "append-only",
  };
}

function actionBinding(input, snapshot = null, legacyReason = "") {
  const hypothesis = field(input.hypothesis, "待验证假设");
  const bound = Boolean(snapshot || hypothesis);
  return {
    testsJudgmentSnapshotId: snapshot?.id || null,
    testsHypothesis: hypothesis,
    successSignal: field(input.successSignal, "成功信号"),
    failureSignal: field(input.failureSignal, "失败信号"),
    observationWindow: field(input.observationWindow || input.reviewAt, "观察窗口"),
    unboundReason: bound
      ? ""
      : field(input.unboundReason, "未绑定原因") || legacyReason || "未提供可验证判断或假设",
  };
}

function createLoop(input, now, id = `loop-${randomUUID()}`) {
  const loopId = safeId(id);
  const createdAt = validTime(now, "创建时间");
  const loop = {
    id: loopId,
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    status: "planned",
    subjectKey: "user.current",
    feedbacks: [],
    cognitiveSchemaVersion: 2,
  };
  for (const key of ["title", "problem", "goal", "judgment", "action", "expected", "counterEvidence", "changeCondition", "reviewAt", "stopCondition", "hypothesis", "successSignal", "failureSignal", "observationWindow", "unboundReason"]) {
    loop[key] = field(input[key], ({ title: "标题", problem: "问题", goal: "目标", action: "下一步行动", expected: "预期结果" })[key] || key,
      ["title", "problem", "action", "expected"].includes(key), key === "title" ? 160 : 4000);
  }
  loop.evidencePaths = sourcePaths(input.evidencePaths || []);
  const snapshot = loop.judgment
    ? judgmentSnapshot({
        loopId,
        version: 1,
        capturedAt: createdAt,
        statement: loop.judgment,
        evidencePaths: loop.evidencePaths,
        assumptions: input.assumptions,
        unknowns: input.unknowns,
        confidenceLevel: input.confidenceLevel,
        confidenceBasis: input.confidenceBasis,
        expected: loop.expected,
        successSignal: loop.successSignal,
        failureSignal: loop.failureSignal,
        observationWindow: loop.observationWindow || loop.reviewAt,
        counterEvidence: loop.counterEvidence,
        changeCondition: loop.changeCondition,
      })
    : null;
  loop.judgmentSnapshots = snapshot ? [snapshot] : [];
  loop.activeJudgmentSnapshotId = snapshot?.id || null;
  loop.actionBinding = actionBinding(loop, snapshot);
  return loop;
}

function upgradeLoopForCalibration(loop) {
  const next = clone(loop);
  if (next.cognitiveSchemaVersion === 2) return next;
  next.cognitiveSchemaVersion = 2;
  next.judgmentSnapshots = [];
  next.activeJudgmentSnapshotId = null;
  next.hypothesis = "";
  next.successSignal = "";
  next.failureSignal = "";
  next.observationWindow = "";
  next.unboundReason = "旧记录没有结果前判断快照";
  next.actionBinding = actionBinding(next, null, next.unboundReason);
  return next;
}

function eligibleSnapshot(loop, occurredAt) {
  return (loop.judgmentSnapshots || [])
    .filter(snapshot => Date.parse(snapshot.capturedAt) <= Date.parse(occurredAt))
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt) || right.version - left.version)[0] || null;
}

function calibrationInputPresent(input) {
  return ["calibrationStatus", "calibrationRationale", "decisionQuality", "predictionAccuracy", "executionFidelity", "environmentShift"]
    .some(key => input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== "");
}

function calibrationFor({ input, snapshot, observed, recordedAt }) {
  const confirmed = input.calibrationConfirmed === true;
  if (calibrationInputPresent(input) && !confirmed) throw new Error("判断校准需要用户确认（calibrationConfirmed）后才能写回");
  const status = confirmed
    ? enumValue(input.calibrationStatus, CALIBRATION_STATUSES, "uncertain", "判断校准状态")
    : "not-assessed";
  if (!snapshot && ["supported", "weakened", "falsified"].includes(status)) throw new Error("缺少结果出现前的判断快照，不能确认该判断被支持、削弱或证伪");
  const rationale = confirmed ? field(input.calibrationRationale, "校准依据") : "";
  if (confirmed && ["supported", "weakened", "falsified"].includes(status) && !rationale) throw new Error("请填写判断校准依据");
  const attribution = {};
  for (const [key, allowed] of Object.entries(ATTRIBUTION_STATUSES)) {
    attribution[key] = confirmed ? enumValue(input[key], allowed, "unknown", `${key}归因`) : "unknown";
  }
  return {
    eligibility: snapshot ? "eligible" : "missing-pre-outcome-snapshot",
    snapshotId: snapshot?.id || null,
    snapshotVersion: snapshot?.version || null,
    expected: snapshot?.prediction?.expected || "",
    observed,
    status,
    rationale,
    attribution,
    confirmation: {
      status: confirmed ? "user-confirmed" : "not-confirmed",
      confirmedAt: confirmed ? recordedAt : null,
    },
  };
}

function applyFeedback(loop, input, now, id = `feedback-${randomUUID()}`) {
  const feedbackId = safeId(id);
  if (loop.feedbacks.some(feedback => feedback.id === feedbackId)) return loop;
  const recordedAt = validTime(now, "记录时间");
  if (input.occurredAt && !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("实际发生时间无效");
  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : recordedAt;
  if (Date.parse(occurredAt) > Date.parse(recordedAt) + 300000) throw new Error("实际结果不能发生在未来");
  const current = upgradeLoopForCalibration(loop);
  if (current.feedbacks.length >= 200) throw new Error("该行动已累积 200 次反馈，请结束当前阶段并新建后续行动");

  const actualAction = field(input.actualAction, "实际做了什么", true);
  const result = field(input.result, "实际结果", true);
  const userInterpretation = field(input.userInterpretation ?? input.interpretation, "用户解释");
  const aiInterpretationText = field(input.aiInterpretation, "AI 候选解释");
  const revisedJudgment = field(input.revisedJudgment, "修订后的判断");
  const evidencePaths = sourcePaths(input.evidencePaths || []);
  const decision = input.decision || "uncertain";
  if (!Object.hasOwn(DECISIONS, decision)) throw new Error("反馈后的方向无效");
  const snapshot = eligibleSnapshot(current, occurredAt);
  const calibration = calibrationFor({ input, snapshot, observed: result, recordedAt });
  const feedback = {
    id: feedbackId,
    occurredAt,
    recordedAt,
    actualAction,
    result,
    interpretation: userInterpretation,
    userInterpretation,
    aiInterpretation: {
      text: aiInterpretationText,
      status: aiInterpretationText ? "candidate" : "not-provided",
    },
    impactOnJudgment: field(input.impactOnJudgment, "对判断的影响"),
    judgmentCalibration: calibration,
    decision,
    revisedJudgment,
    previousJudgment: current.judgment,
    completed: input.completed === true,
    evidencePaths,
    observedReality: { occurredAt, actualAction, result, evidencePaths: [...evidencePaths] },
  };

  let nextSnapshot = null;
  if (revisedJudgment && revisedJudgment !== current.judgment) {
    if (current.judgmentSnapshots.length >= MAX_JUDGMENT_SNAPSHOTS) throw new Error(`判断快照已达到 ${MAX_JUDGMENT_SNAPSHOTS} 个，请结束当前阶段并新建后续行动`);
    nextSnapshot = judgmentSnapshot({
      loopId: current.id,
      version: current.judgmentSnapshots.length + 1,
      capturedAt: recordedAt,
      statement: revisedJudgment,
      evidencePaths: [...new Set([...current.evidencePaths, ...evidencePaths])],
      assumptions: input.revisedAssumptions,
      unknowns: input.revisedUnknowns,
      confidenceLevel: input.revisedConfidenceLevel,
      confidenceBasis: input.revisedConfidenceBasis,
      expected: field(input.revisedExpected, "修订后的预期") || current.expected,
      successSignal: field(input.revisedSuccessSignal, "修订后的成功信号") || current.actionBinding.successSignal,
      failureSignal: field(input.revisedFailureSignal, "修订后的失败信号") || current.actionBinding.failureSignal,
      observationWindow: field(input.revisedObservationWindow, "修订后的观察窗口") || current.actionBinding.observationWindow,
      counterEvidence: field(input.revisedCounterEvidence, "修订后的反证") || current.counterEvidence,
      changeCondition: field(input.revisedChangeCondition, "修订后的改变条件") || current.changeCondition,
      sourceFeedbackId: feedbackId,
    });
  }

  const nextSnapshots = nextSnapshot ? [...current.judgmentSnapshots, nextSnapshot] : [...current.judgmentSnapshots];
  return {
    ...current,
    updatedAt: recordedAt,
    revision: current.revision + 1,
    judgment: revisedJudgment || current.judgment,
    status: decision === "stop" ? "paused" : feedback.completed ? "completed" : "attempted",
    feedbacks: [...current.feedbacks, feedback],
    judgmentSnapshots: nextSnapshots,
    activeJudgmentSnapshotId: nextSnapshot?.id || current.activeJudgmentSnapshotId,
    actionBinding: nextSnapshot
      ? {
          ...current.actionBinding,
          testsJudgmentSnapshotId: nextSnapshot.id,
          successSignal: nextSnapshot.prediction.successSignal,
          failureSignal: nextSnapshot.prediction.failureSignal,
          observationWindow: nextSnapshot.prediction.observationWindow,
          unboundReason: "",
        }
      : { ...current.actionBinding },
  };
}

function noteHeader({ id, title, path, type, content, revision = 1, updatedAt, sourcePath = path, evidencePaths = [] }) {
  const fields = {
    xingzhiFormat: "knowledge-v1",
    entityId: id,
    knowledgeKey: `user.${type}.${id}`,
    knowledgeType: type,
    title,
    content,
    summary: content.slice(0, 500),
    status: "active",
    canonical: true,
    canonicalPath: path,
    revision,
    epistemicStatus: "user-statement",
    reviewStatus: "user-confirmed",
    sourceStatus: "available",
    primarySubjectKey: "user.current",
    recordRole: "user-entered-record",
    sensitivity: "personal",
    updatedAt,
    sourceDocuments: [sourcePath, ...evidencePaths],
    sourceEvidence: [{ type: "user-entered-record", sourcePath, role: "user" }],
  };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n`;
}

function lines(fields) { return fields.map(([label, value]) => `- ${label}：${value || "尚未填写"}`).join("\n"); }

function renderLegacyLoop(loop) {
  const path = loopPath(loop.id);
  const summary = `行动状态：${loop.status}。问题：${loop.problem}。行动：${loop.action}。预期：${loop.expected}。当前判断：${loop.judgment || "尚未形成"}。`;
  return [
    noteHeader({ id: loop.id, title: loop.title, path, type: "action", content: summary, revision: loop.revision, updatedAt: loop.updatedAt, evidencePaths: loop.evidencePaths }),
    `# ${loop.title}`, "", "> 用户填写的计划与反馈；计划不等于执行，当前判断保留自述属性。", "", "## 问题与判断", "",
    lines([["问题", loop.problem], ["目标", loop.goal], ["当前判断", loop.judgment], ["反证或未知", loop.counterEvidence], ["改变判断的条件", loop.changeCondition]]), "",
    "## 行动与预期", "", lines([["行动", loop.action], ["预期", loop.expected], ["复查时间", loop.reviewAt], ["停止条件", loop.stopCondition], ["状态", loop.status]]), "",
    "## 依据", "", ...loop.evidencePaths.map(pathValue => `- [[${pathValue}]]`), "", "## 实际反馈", "",
    ...(loop.feedbacks.length ? loop.feedbacks.map(feedback => `- ${feedback.occurredAt} · [[${feedbackPath(feedback.id)}|查看反馈]] · ${feedback.result.slice(0, 200)} · ${DECISIONS[feedback.decision]}`) : ["尚未记录实际结果。"]), "",
    `<!-- ${LOOP_MARKER_V1}:${Buffer.from(JSON.stringify(loop), "utf8").toString("base64url")} -->`, "",
  ].join("\n");
}

function renderSnapshot(snapshot) {
  return [
    `### v${snapshot.version} · ${snapshot.capturedAt}`,
    "",
    lines([
      ["当时判断", snapshot.statement],
      ["置信度", snapshot.confidence.level],
      ["置信度依据", snapshot.confidence.basis],
      ["当时预期", snapshot.prediction.expected],
      ["成功信号", snapshot.prediction.successSignal],
      ["失败信号", snapshot.prediction.failureSignal],
      ["观察窗口", snapshot.prediction.observationWindow],
      ["当时假设", snapshot.assumptions.join("；")],
      ["当时未知", snapshot.unknowns.join("；")],
      ["改变条件", snapshot.changeConditions.changeCondition],
      ["确认状态", snapshot.confirmation.status],
    ]),
    "",
  ];
}

function renderLoop(loop) {
  if (loop.cognitiveSchemaVersion !== 2) return renderLegacyLoop(loop);
  const path = loopPath(loop.id);
  const summary = `行动状态：${loop.status}。问题：${loop.problem}。行动：${loop.action}。预期：${loop.expected}。当前判断：${loop.judgment || "尚未形成"}。`;
  return [
    noteHeader({ id: loop.id, title: loop.title, path, type: "action", content: summary, revision: loop.revision, updatedAt: loop.updatedAt, evidencePaths: loop.evidencePaths }),
    `# ${loop.title}`, "", "> 用户填写的计划、判断快照与反馈；计划不等于执行，结果不会倒写结果出现前的判断。", "", "## 问题与当前判断", "",
    lines([["问题", loop.problem], ["目标", loop.goal], ["当前判断", loop.judgment], ["反证或未知", loop.counterEvidence], ["改变判断的条件", loop.changeCondition]]), "",
    "## 行动绑定与预期", "", lines([
      ["行动", loop.action],
      ["验证判断快照", loop.actionBinding.testsJudgmentSnapshotId],
      ["验证假设", loop.actionBinding.testsHypothesis],
      ["预期", loop.expected],
      ["成功信号", loop.actionBinding.successSignal],
      ["失败信号", loop.actionBinding.failureSignal],
      ["观察窗口", loop.actionBinding.observationWindow],
      ["未绑定原因", loop.actionBinding.unboundReason],
      ["复查时间", loop.reviewAt],
      ["停止条件", loop.stopCondition],
      ["状态", loop.status],
    ]), "",
    "## 判断快照", "",
    ...(loop.judgmentSnapshots.length ? loop.judgmentSnapshots.flatMap(renderSnapshot) : ["旧记录或当前记录没有结果出现前的判断快照，不能追认校准。", ""]),
    "## 依据", "", ...loop.evidencePaths.map(pathValue => `- [[${pathValue}]]`), "", "## 实际反馈", "",
    ...(loop.feedbacks.length ? loop.feedbacks.map(feedback => `- ${feedback.occurredAt} · [[${feedbackPath(feedback.id)}|查看反馈]] · ${feedback.result.slice(0, 200)} · ${DECISIONS[feedback.decision]} · ${feedback.judgmentCalibration?.status || "not-assessed"}`) : ["尚未记录实际结果。"]), "",
    `<!-- ${LOOP_MARKER_V2}:${Buffer.from(JSON.stringify(loop), "utf8").toString("base64url")} -->`, "",
  ].join("\n");
}

function renderLegacyFeedback(loop, feedback) {
  const path = feedbackPath(feedback.id);
  return [
    noteHeader({ id: feedback.id, title: `${loop.title} · 反馈`, path, type: "feedback", content: feedback.result, updatedAt: feedback.recordedAt, evidencePaths: feedback.evidencePaths }),
    `# ${loop.title} · 实际反馈`, "", `关联行动：[[${loopPath(loop.id)}|${loop.title}]]`, "",
    lines([["发生时间", feedback.occurredAt], ["记录时间", feedback.recordedAt], ["实际做了什么", feedback.actualAction], ["实际结果", feedback.result],
      ["原先预期", loop.expected], ["原因假设", feedback.interpretation], ["原判断", feedback.previousJudgment], ["修订判断", feedback.revisedJudgment], ["下一轮", DECISIONS[feedback.decision]]]), "",
    ...feedback.evidencePaths.map(pathValue => `- [[${pathValue}]]`), "",
  ].join("\n");
}

function renderFeedback(loop, feedback) {
  if (!feedback.judgmentCalibration) return renderLegacyFeedback(loop, feedback);
  const path = feedbackPath(feedback.id);
  const calibration = feedback.judgmentCalibration;
  return [
    noteHeader({ id: feedback.id, title: `${loop.title} · 反馈`, path, type: "feedback", content: feedback.result, updatedAt: feedback.recordedAt, evidencePaths: feedback.evidencePaths }),
    `# ${loop.title} · 实际反馈`, "", `关联行动：[[${loopPath(loop.id)}|${loop.title}]]`, "",
    "## 观察到的现实", "", lines([
      ["发生时间", feedback.observedReality.occurredAt],
      ["记录时间", feedback.recordedAt],
      ["实际做了什么", feedback.observedReality.actualAction],
      ["实际结果", feedback.observedReality.result],
    ]), "",
    "## 用户解释", "", feedback.userInterpretation || "尚未填写。", "",
    "## AI 候选解释", "", feedback.aiInterpretation.text || "未提供；AI 解释不会自动改变判断。", "",
    `状态：${feedback.aiInterpretation.status}`, "",
    "## 预期与现实", "", lines([
      ["关联判断快照", calibration.snapshotId],
      ["校准资格", calibration.eligibility],
      ["原先预期", calibration.expected],
      ["实际观察", calibration.observed],
      ["校准状态", calibration.status],
      ["校准依据", calibration.rationale],
      ["确认状态", calibration.confirmation.status],
    ]), "",
    "## 偏差来源", "", lines([
      ["判断质量", calibration.attribution.decisionQuality],
      ["预测准确度", calibration.attribution.predictionAccuracy],
      ["执行一致性", calibration.attribution.executionFidelity],
      ["环境变化", calibration.attribution.environmentShift],
    ]), "",
    "## 对判断的影响", "", lines([
      ["影响说明", feedback.impactOnJudgment],
      ["原判断", feedback.previousJudgment],
      ["修订判断", feedback.revisedJudgment],
      ["下一轮", DECISIONS[feedback.decision]],
    ]), "",
    ...feedback.evidencePaths.map(pathValue => `- [[${pathValue}]]`), "",
  ].join("\n");
}

function validateActionBinding(binding, snapshots) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("行动验证绑定无效");
  const snapshotIds = new Set(snapshots.map(snapshot => snapshot.id));
  if (binding.testsJudgmentSnapshotId !== null && !snapshotIds.has(binding.testsJudgmentSnapshotId)) throw new Error("行动绑定的判断快照不存在");
  const hypothesis = field(binding.testsHypothesis, "待验证假设");
  const unboundReason = field(binding.unboundReason, "未绑定原因");
  if (!binding.testsJudgmentSnapshotId && !hypothesis && !unboundReason) throw new Error("行动必须绑定判断、假设或说明未绑定原因");
  field(binding.successSignal, "成功信号");
  field(binding.failureSignal, "失败信号");
  field(binding.observationWindow, "观察窗口");
}

function validateSnapshot(snapshot, loop, expectedVersion) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("判断快照结构无效");
  if (snapshot.version !== expectedVersion || snapshot.id !== `${loop.id}:judgment:${expectedVersion}`) throw new Error("判断快照版本链无效");
  validTime(snapshot.capturedAt, "判断快照时间");
  field(snapshot.statement, "判断", true);
  sourcePaths(snapshot.evidencePaths);
  textList(snapshot.assumptions, "判断假设");
  textList(snapshot.unknowns, "判断未知");
  enumValue(snapshot.confidence?.level, CONFIDENCE_LEVELS, "unknown", "判断置信度");
  field(snapshot.confidence?.basis, "置信度依据");
  field(snapshot.prediction?.expected, "预期结果");
  field(snapshot.prediction?.successSignal, "成功信号");
  field(snapshot.prediction?.failureSignal, "失败信号");
  field(snapshot.prediction?.observationWindow, "观察窗口");
  field(snapshot.changeConditions?.counterEvidence, "反证或未知");
  field(snapshot.changeConditions?.changeCondition, "改变判断的条件");
  if (snapshot.confirmation?.status !== "user-confirmed" || snapshot.immutability !== "append-only") throw new Error("判断快照缺少主体确认或不可变边界");
  validTime(snapshot.confirmation.confirmedAt, "判断确认时间");
  if (snapshot.sourceFeedbackId !== null) safeId(snapshot.sourceFeedbackId);
}

function validateFeedback(feedback) {
  if (!feedback || typeof feedback !== "object" || Array.isArray(feedback)) throw new Error("行动反馈结构无效");
  safeId(feedback.id);
  validTime(feedback.occurredAt, "反馈发生时间");
  validTime(feedback.recordedAt, "反馈记录时间");
  field(feedback.actualAction, "实际做了什么", true);
  field(feedback.result, "实际结果", true);
  if (!Object.hasOwn(DECISIONS, feedback.decision)) throw new Error("反馈后的方向无效");
  sourcePaths(feedback.evidencePaths);
  if (!feedback.judgmentCalibration) return;
  if (!CALIBRATION_STATUSES.has(feedback.judgmentCalibration.status)) throw new Error("判断校准状态无效");
  if (!["eligible", "missing-pre-outcome-snapshot"].includes(feedback.judgmentCalibration.eligibility)) throw new Error("判断校准资格无效");
  if (!["user-confirmed", "not-confirmed"].includes(feedback.judgmentCalibration.confirmation?.status)) throw new Error("判断校准确认状态无效");
  if (feedback.judgmentCalibration.confirmation.status === "user-confirmed") validTime(feedback.judgmentCalibration.confirmation.confirmedAt, "判断校准确认时间");
  else if (feedback.judgmentCalibration.confirmation.confirmedAt !== null) throw new Error("未确认的判断校准不能带确认时间");
  for (const [key, allowed] of Object.entries(ATTRIBUTION_STATUSES)) {
    if (!allowed.has(feedback.judgmentCalibration.attribution?.[key])) throw new Error(`${key}归因无效`);
  }
}

function validateCalibrationLinks(loop) {
  const snapshots = new Map(loop.judgmentSnapshots.map(snapshot => [snapshot.id, snapshot]));
  const feedbacks = new Map(loop.feedbacks.map(feedback => [feedback.id, feedback]));
  for (const feedback of loop.feedbacks) {
    const calibration = feedback.judgmentCalibration;
    if (!calibration) continue;
    const snapshot = calibration.snapshotId ? snapshots.get(calibration.snapshotId) : null;
    if (calibration.eligibility === "eligible") {
      if (!snapshot || snapshot.version !== calibration.snapshotVersion || Date.parse(snapshot.capturedAt) > Date.parse(feedback.occurredAt)) throw new Error("判断校准没有有效的结果前快照");
      if (calibration.expected !== snapshot.prediction.expected) throw new Error("判断校准的预期与快照不一致");
    } else if (calibration.snapshotId !== null || calibration.snapshotVersion !== null) {
      throw new Error("缺少结果前快照的校准不能关联判断版本");
    }
    if (["supported", "weakened", "falsified"].includes(calibration.status)
      && (calibration.eligibility !== "eligible" || calibration.confirmation.status !== "user-confirmed" || !calibration.rationale)) throw new Error("实质判断校准缺少结果前快照、用户确认或校准依据");
  }
  for (const snapshot of loop.judgmentSnapshots) {
    if (!snapshot.sourceFeedbackId) continue;
    const source = feedbacks.get(snapshot.sourceFeedbackId);
    if (!source || source.revisedJudgment !== snapshot.statement || Date.parse(snapshot.capturedAt) !== Date.parse(source.recordedAt)) throw new Error("判断修订快照与来源反馈不一致");
  }
}

function validateLoop(loop, path) {
  if (loopPath(loop.id) !== path || !loop.title || !Array.isArray(loop.feedbacks) || !Array.isArray(loop.evidencePaths)
    || !["planned", "attempted", "completed", "paused"].includes(loop.status) || !Number.isSafeInteger(loop.revision) || loop.revision < 1) throw new Error("行动记录与路径或版本不一致");
  validTime(loop.createdAt, "行动创建时间");
  validTime(loop.updatedAt, "行动更新时间");
  field(loop.title, "标题", true, 160);
  field(loop.problem, "问题", true);
  field(loop.action, "下一步行动", true);
  field(loop.expected, "预期结果", true);
  sourcePaths(loop.evidencePaths);
  if (loop.feedbacks.length > 200) throw new Error("行动反馈数量超过上限");
  loop.feedbacks.forEach(validateFeedback);
  if (loop.cognitiveSchemaVersion !== 2) return;
  if (!Array.isArray(loop.judgmentSnapshots) || loop.judgmentSnapshots.length > MAX_JUDGMENT_SNAPSHOTS) throw new Error("判断快照数量无效");
  loop.judgmentSnapshots.forEach((snapshot, index) => validateSnapshot(snapshot, loop, index + 1));
  for (let index = 1; index < loop.judgmentSnapshots.length; index += 1) {
    if (Date.parse(loop.judgmentSnapshots[index].capturedAt) < Date.parse(loop.judgmentSnapshots[index - 1].capturedAt)) throw new Error("判断快照时间顺序无效");
  }
  const snapshotIds = new Set(loop.judgmentSnapshots.map(snapshot => snapshot.id));
  if (loop.activeJudgmentSnapshotId !== null && !snapshotIds.has(loop.activeJudgmentSnapshotId)) throw new Error("当前判断快照不存在");
  const latestSnapshot = loop.judgmentSnapshots.at(-1) || null;
  if (loop.activeJudgmentSnapshotId !== (latestSnapshot?.id || null)) throw new Error("当前判断快照不是最新版本");
  if (latestSnapshot && loop.judgment !== latestSnapshot.statement) throw new Error("当前判断与活动快照不一致");
  validateActionBinding(loop.actionBinding, loop.judgmentSnapshots);
  if (latestSnapshot && loop.actionBinding.testsJudgmentSnapshotId !== latestSnapshot.id) throw new Error("当前行动没有绑定最新判断快照");
  validateCalibrationLinks(loop);
}

function parseLoop(note) {
  if (!note?.content || !/XINGZHI_COGNITIVE_LOOP_V[12]/u.test(note.content)) return null;
  const match = note.content.match(/<!-- (XINGZHI_COGNITIVE_LOOP_V[12]):([A-Za-z0-9_-]+) -->\s*$/u);
  let loop;
  try { loop = JSON.parse(Buffer.from(match?.[2] || "", "base64url").toString("utf8")); }
  catch { throw new Error("行动记录结构损坏，请打开原文核对；未覆盖文件"); }
  const schemaVersion = loop?.cognitiveSchemaVersion;
  if (!loop || ![undefined, 2].includes(schemaVersion)
    || (match?.[1] === LOOP_MARKER_V2) !== (schemaVersion === 2)) throw new Error("行动记录版本标记与内容不一致");
  validateLoop(loop, note.path);
  return loop;
}

// ---- 立心 · 所守（用户自己写下的边界与现实考验）----
const HOLDS_PATH = "01_当前的我/价值与偏好/所守.md";
const HOLDS_MARKER = "XINGZHI_HOLDS_V1";
const HOLDS_ID = "holds-current";
const MAX_HOLDS = 40;
const MAX_HOLD_TESTS = 80;

function emptyHolds() { return { schema: 1, id: HOLDS_ID, revision: 0, updatedAt: "", holds: [] }; }

function holdGoalPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("每条所守最多关联 8 个目标");
  return [...new Set(value.filter(Boolean).map((path) => {
    const normalized = validateVaultMarkdownPath(path);
    if (!normalized.startsWith("05_")) throw new Error("所守只能关联「05_目标与项目」里的记录");
    return normalized;
  }))];
}

function holdDate(value, label) {
  const text = field(value, label, true, 40);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label}无效`);
  return text;
}

function validateHolds(data) {
  const broken = "所守记录结构损坏，请打开原文核对；未覆盖文件";
  if (!data || data.schema !== 1 || data.id !== HOLDS_ID || !Array.isArray(data.holds) || data.holds.length > MAX_HOLDS) throw new Error(broken);
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error(broken);
  const ids = new Set();
  for (const hold of data.holds) {
    if (!hold || typeof hold !== "object" || ids.has(hold.id)) throw new Error(broken);
    safeId(String(hold.id || "")); ids.add(hold.id);
    field(hold.text, "所守", true, 200); field(hold.why, "为什么"); field(hold.boundary, "边界");
    if (!["active", "retired"].includes(hold.status)) throw new Error(broken);
    holdGoalPaths(hold.goalPaths);
    if (!Array.isArray(hold.tests) || hold.tests.length > MAX_HOLD_TESTS) throw new Error(broken);
    for (const test of hold.tests) {
      if (!test || typeof test.kept !== "boolean") throw new Error(broken);
      safeId(String(test.id || "")); holdDate(test.at, "考验日期"); field(test.situation, "情境", true, 800); field(test.note, "备注", false, 800);
    }
  }
  return data;
}

function parseHolds(content) {
  if (!content || !content.includes(HOLDS_MARKER)) return null;
  const match = content.match(new RegExp(`<!-- ${HOLDS_MARKER}:([A-Za-z0-9_-]+) -->\\s*$`, "u"));
  let data;
  try { data = JSON.parse(Buffer.from(match?.[1] || "", "base64url").toString("utf8")); }
  catch { throw new Error("所守记录结构损坏，请打开原文核对；未覆盖文件"); }
  return validateHolds(data);
}

function holdTally(hold) {
  const kept = hold.tests.filter((test) => test.kept).length;
  return { kept, yielded: hold.tests.length - kept };
}

function renderHold(hold) {
  const tally = holdTally(hold);
  const tests = [...hold.tests].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return [
    `### ${hold.text}`, "",
    `- 为什么：${hold.why || "尚未填写"}`,
    `- 边界：${hold.boundary || "尚未填写"}`,
    `- 关联目标：${hold.goalPaths.length ? hold.goalPaths.map((path) => `[[${path}]]`).join("、") : "未关联"}`,
    `- 现实考验：守住 ${tally.kept} 次 · 让步 ${tally.yielded} 次`,
    ...tests.map((test) => `  - ${test.at} · ${test.kept ? "守住" : "让步"} · ${test.situation}${test.note ? ` —— ${test.note}` : ""}`),
    "",
  ];
}

function renderHolds(data) {
  const active = data.holds.filter((hold) => hold.status === "active");
  const retired = data.holds.filter((hold) => hold.status === "retired");
  const summary = active.length ? `用户写下的所守：${active.map((hold) => hold.text).join("；")}` : "暂无正在守的边界。";
  return [
    noteHeader({ id: HOLDS_ID, title: "所守", path: HOLDS_PATH, type: "value-priority", content: summary.slice(0, 2000), revision: Math.max(1, data.revision), updatedAt: data.updatedAt || new Date(0).toISOString() }),
    "# 所守", "", "> 你自己写下的边界：愿意守住什么、守到哪里，以及现实考验过它的时刻。行知只记录，不打分。", "",
    "## 正在守", "", ...(active.length ? active.flatMap(renderHold) : ["还没有写下所守。", ""]),
    ...(retired.length ? ["## 已不再守", "", ...retired.flatMap(renderHold)] : []),
    `<!-- ${HOLDS_MARKER}:${Buffer.from(JSON.stringify(data), "utf8").toString("base64url")} -->`, "",
  ].join("\n");
}

function applyHoldAction(data, action, payload, now) {
  const next = clone(data);
  const input = payload && typeof payload === "object" ? payload : {};
  const find = () => {
    const hold = next.holds.find((item) => item.id === input.id);
    if (!hold) throw new Error("没有找到这条所守，请刷新后再试");
    return hold;
  };
  if (action === "save") {
    const values = { text: field(input.text, "所守", true, 200), why: field(input.why, "为什么"), boundary: field(input.boundary, "边界"), goalPaths: holdGoalPaths(input.goalPaths) };
    if (input.id) Object.assign(find(), values, { updatedAt: now });
    else {
      if (next.holds.length >= MAX_HOLDS) throw new Error(`最多记录 ${MAX_HOLDS} 条所守`);
      next.holds.push({ id: `hold-${randomUUID()}`, ...values, status: "active", createdAt: now, updatedAt: now, tests: [] });
    }
  } else if (action === "test") {
    const hold = find();
    if (hold.tests.length >= MAX_HOLD_TESTS) throw new Error("这条所守的考验记录已达上限");
    if (typeof input.kept !== "boolean") throw new Error("请选择守住或让步");
    hold.tests.push({ id: `test-${randomUUID()}`, at: holdDate(input.at, "考验日期"), situation: field(input.situation, "情境", true, 800), kept: input.kept, note: field(input.note, "备注", false, 800) });
    hold.updatedAt = now;
  } else if (action === "retire" || action === "restore") {
    const hold = find(); hold.status = action === "retire" ? "retired" : "active"; hold.updatedAt = now;
  } else throw new Error("未知的所守操作");
  next.revision += 1; next.updatedAt = now;
  return validateHolds(next);
}

module.exports = {
  HOLDS_PATH,
  emptyHolds,
  parseHolds,
  renderHolds,
  applyHoldAction,
  holdTally,
  LOOP_ROOT,
  FEEDBACK_ROOT,
  DECISIONS,
  CALIBRATION_STATUSES,
  loopPath,
  feedbackPath,
  createLoop,
  applyFeedback,
  renderLoop,
  renderFeedback,
  parseLoop,
};
