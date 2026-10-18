"use strict";

const { buildDynamicThinkingRequest } = require("./dynamic-thinking-policy.cjs");
const QUESTION_CALIBRATION_VERSION = "0.3.0";
const MAX_QUESTION_CALIBRATION_EVENTS = 500;

const TASK_TYPES = Object.freeze({
  fact: Object.freeze({ id: "fact", label: "事实与概念", pathStage: "观境" }),
  analysis: Object.freeze({ id: "analysis", label: "分析与讨论", pathStage: "观境" }),
  decision: Object.freeze({ id: "decision", label: "选择与判断", pathStage: "立心" }),
  planning: Object.freeze({ id: "planning", label: "目标与规划", pathStage: "立心 · 践真" }),
  action: Object.freeze({ id: "action", label: "具体执行", pathStage: "践真" }),
  creation: Object.freeze({ id: "creation", label: "创作与交付", pathStage: "践真" }),
  troubleshooting: Object.freeze({ id: "troubleshooting", label: "问题排查", pathStage: "观境 · 践真" }),
  review: Object.freeze({ id: "review", label: "结果复盘", pathStage: "知变" }),
});

const FIELD_DEFINITIONS = Object.freeze({
  decision: Object.freeze({
    id: "decision-focus",
    label: "你最在意的判断标准，或不能接受的代价",
    reason: "它会改变不同选项对你是否合适。",
  }),
  decisionOptions: Object.freeze({
    id: "decision-options",
    label: "当前要比较的具体选项",
    reason: "先知道真实选项，才不会把泛泛建议误当成你的答案。",
  }),
  goal: Object.freeze({
    id: "desired-outcome",
    label: "你希望这件事最后达成什么结果",
    reason: "目标不同，下一步的判断与行动也会不同。",
  }),
  time: Object.freeze({
    id: "time-horizon",
    label: "希望完成或回看的时间范围",
    reason: "时间范围会影响方案的可行性。",
  }),
  actionTarget: Object.freeze({
    id: "action-target",
    label: "你现在想推进的具体事情",
    reason: "有了对象，才能给出能直接开始的步骤。",
  }),
  artifact: Object.freeze({
    id: "deliverable",
    label: "希望生成或修改的具体成品",
    reason: "成品类型会改变内容结构和表达方式。",
  }),
  symptom: Object.freeze({
    id: "observed-symptom",
    label: "实际出现的现象、报错或已尝试的步骤",
    reason: "先区分观察到的事实和可能原因，避免把猜测当根因。",
  }),
  reviewEvidence: Object.freeze({
    id: "review-evidence",
    label: "行动前的预期，以及现实中实际发生的结果",
    reason: "对照预期和实际结果，才能分开判断成果与认识变化。",
  }),
  analysisObject: Object.freeze({
    id: "analysis-object",
    label: "需要分析的对象或材料",
    reason: "目前还无法确定分析对象。",
  }),
});

const VALID_DECISIONS = new Set([
  "not-needed",
  "sent-original",
  "accepted-suggestion",
  "edited-suggestion",
]);
const VALID_FIELD_IDS = new Set(Object.values(FIELD_DEFINITIONS).map((item) => item.id));

// These are optional questions, never facts or answers attributed to the user.
const PERSPECTIVES = Object.freeze({
  "content-audience": { label: "谁会认出自己的处境", question: "这个主题对应读者正在面对的哪些具体处境？它会吸引怎样的人参与？", reason: "主题与读者有关，读者才容易把内容接到自己的问题上。", nextTime: "下次写内容需求，可以补一句：希望哪类读者在什么处境下看到它。", covered: /目标读者|目标受众|吸引.*(人群|读者)|读者.*(处境|谁)/u },
  "content-purpose": { label: "读完以后发生什么", question: "读者看完后，希望他想清楚什么，或开始哪一步？怎样观察这篇内容有没有做到？", reason: "预期作用会影响标题、结构和结尾。", nextTime: "下次可以补一句：读完以后，希望对方想清楚什么或做哪一步。", covered: /读完.*(行动|一步|想清楚)|验证任务|衡量.*内容/u },
  "content-scope": { label: "重大选择之外的入口", question: "围绕重大决定来写，会不会遗漏日常小选择中的同类困境？哪些例子更容易让读者认出自己？", reason: "从大主题落到具体情境，有助于检查表达是否离读者太远。", nextTime: "下次可以补一个具体场景，并请对方检查有没有遗漏其他重要场景。", covered: /日常.*(选择|决定)|小选择|小决定/u },
  "decision-basis": { label: "什么依据会改变选择", question: "不同选项分别满足什么、要付出什么代价？哪些判断标准需要由我自己确认？", reason: "把选项好坏与自己愿意承担的代价分开，比较才有依据。", nextTime: "下次问怎么选，可以先写：真实选项、最在意的一点、不能接受的代价。", covered: /判断标准|最在意|不能接受|底线/u },
  "decision-test": { label: "先验证哪个未知", question: "哪些未知最可能改变这次判断？能否先用一个小行动验证，再决定是否继续？", reason: "有些分歧需要现实反馈，继续找答案未必能解决。", nextTime: "下次犹豫时，可以补一句：哪个未知最影响选择，怎样先验证它。", covered: /验证.*未知|未知.*验证|低成本.*验证/u },
  "analysis-assumption": { label: "解释里有什么前提", question: "哪些是已经发生的事实，哪些是我给出的解释？这个解释依赖哪些还没确认的前提？", reason: "前提不同，同一件事可能得出不同结论。", nextTime: "下次描述问题，可以分两句写：实际发生了什么，我目前怎样理解它。", covered: /事实.*解释|解释.*事实|未确认.*前提|隐含前提/u },
  "analysis-alternative": { label: "还有什么解释", question: "还有哪些解释能说明同一现象？什么新证据会让我修改当前看法？", reason: "保留替代解释，有助于检查现有想法是否过早收敛。", nextTime: "下次可以补一句：请检查另一个合理解释，以及什么证据能区分它们。", covered: /替代解释|其他解释|反例|推翻|修改.*看法/u },
  "plan-result": { label: "完成怎样判断", question: "这份计划怎样才算在现实中完成？哪些约束和失败条件会改变安排？", reason: "清楚的完成依据能避免把写好计划当成完成目标。", nextTime: "下次要计划，可以补上：希望的结果、可用资源，以及怎样才算完成。", covered: /验收|完成标准|失败条件/u },
  "action-feedback": { label: "行动后看什么反馈", question: "先做哪一个能开始的动作？做完观察什么信号，什么情况下需要调整？", reason: "行动连接反馈，才能判断这一步是否有用。", nextTime: "下次问怎么做，可以补一句：做完观察什么，何时回来调整。", covered: /观察.*(反馈|信号)|反馈.*调整|验收/u },
  "debug-evidence": { label: "现象与原因分开", question: "已观察到的现象和猜测的原因分别是什么？哪个最小排查动作能区分这些原因？", reason: "先检验原因，可以减少反复尝试不相关的修复。", nextTime: "下次报问题，可以写：做了什么、实际出现什么、原本期待什么、已经试过什么。", covered: /最小.*排查|区分.*原因|现象.*猜测/u },
  "review-change": { label: "结果与认识分开", question: "实际结果与原先预期差在哪里？哪些变化来自这次行动，哪些还不能确认？", reason: "区分结果和解释，复盘才不会只剩一个自我评价。", nextTime: "下次复盘，可以并排写：原先预期、实际结果、仍不确定的原因。", covered: /预期.*实际.*原因|归因|认识变化/u },
  "expression-focus": { label: "这轮先解决哪一个问题", question: "这段话里是否混合了几个不同问题？本轮先解决哪一个，哪些留到下一步？", reason: "明确当前任务，回答更容易对应你真正要推进的事。", nextTime: "下次可以先说：我现在卡在什么；这一轮希望先得到什么。", covered: /本轮先|这一轮.*(希望|先)|优先解决/u },
});
const VALID_PERSPECTIVE_IDS = new Set(Object.keys(PERSPECTIVES));

function recentUserContext(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((item) => item?.role === "user" && !item.internalUserContinuity && item.internal !== true
    && item.status !== "failed" && typeof item.content === "string")
    .slice(-4).map((item) => item.content.slice(0, 1500));
}

function effectiveContext(original, messages) {
  if (/换个话题|新话题|另一个问题|另外一个问题/u.test(original)) return [];
  return recentUserContext(messages);
}

function shouldShowQuestionCalibration(assessment, { userTurnCount = 0, force = false } = {}) {
  return false;
}

function buildQuestionHabitHints(events, { enabled = false } = {}) {
  if (!enabled) return [];
  const window = normalizeQuestionCalibrationEvents(events).filter((item) => item.schemaVersion === 2).slice(-30);
  const offers = window.filter((item) => item.offeredPerspectiveCodes.length > 0);
  if (offers.length < 5) return [];
  return Object.keys(PERSPECTIVES).map((id) => {
    const offered = offers.filter((item) => item.offeredPerspectiveCodes.includes(id));
    const selected = offered.filter((item) => item.selectedPerspectiveCodes.includes(id));
    return { id, offeredCount: offered.length, selectedCount: selected.length,
      text: `保留的 ${window.length} 条旧版校准记录中，「${PERSPECTIVES[id].label}」提示出现 ${offered.length} 次，你选择加入 ${selected.length} 次。`,
      nextTime: PERSPECTIVES[id].nextTime,
      boundary: "这里只描述提示和选择记录；采用建议不能证明表达能力已经提高，也不代表你有固定的弱点。" };
  }).filter((item) => item.offeredCount >= 3).sort((a, b) => b.offeredCount - a.offeredCount).slice(0, 2);
}

function normalizeQuestionText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyQuestion(input) {
  const text = normalizeQuestionText(input);
  if (!text) return TASK_TYPES.analysis;

  // Classify the requested work before words that are merely its subject.
  if (includesAny(text, [/写.*(文章|文案|邮件|报告|代码|首篇|第一篇)/u,
    /第一篇.*(写|文章)/u, /首篇.*(写|内容)/u, /润色|改写|起草/u,
    /制作.*(视频|页面|成品)/u])) return TASK_TYPES.creation;

  if (includesAny(text, [/复盘/u, /回顾.*(结果|行动|过程)/u, /结果.*(预期|目标)/u, /反馈后/u, /试了.*(结果|发现)/u, /执行后/u])) {
    return TASK_TYPES.review;
  }
  if (includesAny(text, [/报错/u, /错误码/u, /故障/u, /排查/u, /打不开/u, /连不上/u, /不工作/u, /没反应/u, /异常/u, /无法使用/u, /不能用/u])) {
    return TASK_TYPES.troubleshooting;
  }
  if (includesAny(text, [/要不要/u, /该不该/u, /是否应该/u, /选哪个/u, /选择/u, /取舍/u, /值不值得/u, /继续还是/u, /还是.*(好|合适)/u, /买不买/u, /辞职/u, /转行/u])) {
    return TASK_TYPES.decision;
  }
  if (includesAny(text, [/帮我写/u, /写一/u, /润色/u, /改写/u, /起草/u, /生成/u, /设计.*(文案|页面|界面|方案|流程|图)/u, /制作/u, /标题/u, /文案/u, /邮件/u, /代码/u])) {
    return TASK_TYPES.creation;
  }
  if (includesAny(text, [/计划/u, /规划/u, /安排/u, /路线图/u, /分阶段/u, /如何推进/u, /怎么推进/u])) {
    return TASK_TYPES.planning;
  }
  if (includesAny(text, [/怎么做/u, /如何做/u, /怎么开始/u, /如何开始/u, /从哪开始/u, /怎么操作/u, /如何操作/u, /怎么配置/u, /如何安装/u, /怎么在/u, /如何在/u, /具体步骤/u, /怎么实现/u])) {
    return TASK_TYPES.action;
  }
  if (includesAny(text, [/是什么/u, /什么是/u, /什么意思/u, /定义/u, /怎么翻译/u, /翻译成/u, /多少/u, /几号/u, /什么时候/u, /在哪里/u, /最新的/u])) {
    return TASK_TYPES.fact;
  }
  return TASK_TYPES.analysis;
}

function isVagueRequest(text, words) {
  return words.some((word) => text === word || text === `帮我${word}` || text === `请${word}` || text === `请帮我${word}`);
}

function assessQuestion(input, { hasAttachments = false, messages = [], forceOffer = false } = {}) {
  const original = typeof input === "string" ? input.trim() : "";
  const context = effectiveContext(original, messages);
  // Classification is retained for historical API compatibility only. It
  // neither chooses perspectives nor determines which information is missing.
  return {
    version: QUESTION_CALIBRATION_VERSION,
    original,
    taskType: { ...classifyQuestion(original) },
    missingFields: [],
    perspectives: [],
    shouldOffer: false,
    hasAttachments: hasAttachments === true,
    contextUsed: context.length > 0,
    reason: "先理解原话与已有思考，再在对话中动态展开相关视角；本地题型规则不判定认知盲区。",
    learningHint: "",
    reflection: "",
    stageGuidance: "",
  };
}

function buildSuggestedQuestion(assessment, { selectedPerspectiveCodes } = {}) {
  if (!assessment || typeof assessment.original !== "string" || !assessment.original.trim()) return "";
  if (Array.isArray(selectedPerspectiveCodes) && selectedPerspectiveCodes.length === 0) return assessment.original;
  return buildDynamicThinkingRequest(assessment.original);
}

function normalizeQuestionCalibrationEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const taskType = TASK_TYPES[event.taskType];
  const decision = VALID_DECISIONS.has(event.decision) ? event.decision : null;
  if (!taskType || !decision) return null;
  const occurredAt = typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt))
    ? new Date(event.occurredAt).toISOString()
    : new Date().toISOString();
  const missingFieldCodes = Array.isArray(event.missingFieldCodes)
    ? [...new Set(event.missingFieldCodes.filter((id) => VALID_FIELD_IDS.has(id)))].slice(0, 2)
    : [];
  const schemaVersion = event.schemaVersion === 2 ? 2 : 1;
  const offeredPerspectiveCodes = schemaVersion === 2 && Array.isArray(event.offeredPerspectiveCodes)
    ? [...new Set(event.offeredPerspectiveCodes.filter((id) => VALID_PERSPECTIVE_IDS.has(id)))].slice(0, 3) : [];
  const selectedPerspectiveCodes = schemaVersion === 2 && ["accepted-suggestion", "edited-suggestion"].includes(decision)
    && Array.isArray(event.selectedPerspectiveCodes)
    ? [...new Set(event.selectedPerspectiveCodes.filter((id) => offeredPerspectiveCodes.includes(id)))].slice(0, 3) : [];
  return {
    schemaVersion,
    id: typeof event.id === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(event.id)
      ? event.id : `qc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    occurredAt,
    taskType: taskType.id,
    pathStage: taskType.pathStage,
    decision,
    missingFieldCodes,
    wasEdited: event.wasEdited === true,
    offeredPerspectiveCodes,
    selectedPerspectiveCodes,
  };
}

function normalizeQuestionCalibrationEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map(normalizeQuestionCalibrationEvent)
    .filter(Boolean)
    .slice(-MAX_QUESTION_CALIBRATION_EVENTS);
}

function createQuestionCalibrationEvent({ assessment, decision, originalText = "", finalText = "", selectedPerspectiveCodes = [] } = {}) {
  if (!assessment?.taskType?.id) return null;
  const original = typeof originalText === "string" ? originalText.trim() : "";
  const final = typeof finalText === "string" ? finalText.trim() : "";
  return normalizeQuestionCalibrationEvent({
    schemaVersion: 2,
    id: `qc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    occurredAt: new Date().toISOString(),
    taskType: assessment.taskType.id,
    decision,
    missingFieldCodes: (assessment.missingFields || []).map((item) => item.id),
    wasEdited: decision === "edited-suggestion" && Boolean(original && final && original !== final),
    offeredPerspectiveCodes: decision !== "not-needed" ? (assessment.perspectives || []).map((item) => item.id) : [],
    selectedPerspectiveCodes,
  });
}

module.exports = {
  FIELD_DEFINITIONS,
  MAX_QUESTION_CALIBRATION_EVENTS,
  QUESTION_CALIBRATION_VERSION,
  TASK_TYPES,
  PERSPECTIVES,
  assessQuestion,
  buildSuggestedQuestion,
  buildQuestionHabitHints,
  classifyQuestion,
  createQuestionCalibrationEvent,
  normalizeQuestionCalibrationEvent,
  normalizeQuestionCalibrationEvents,
  recentUserContext,
  shouldShowQuestionCalibration,
};
