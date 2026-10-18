"use strict";

const { buildRealProgressBlock } = require("./real-progress-policy.cjs");
const { missingPathDisplay } = require("./path-output-contract.cjs");

const { answerContract, answerContractBlock, missingRequirements } = require("./answer-contract.cjs");
const MAX_ANSWER_QUALITY_REPAIRS = 1;
const MAX_QUALITY_TEXT_CHARS = 40_000;
const DEFECT_LABELS = Object.freeze({
  "answer-empty": "回答为空或不可用",
  "semantic-stage-missing": "没有完成语义理解",
  "evidence-stage-missing": "没有完成证据探测",
  "agent-missing": "没有主 Agent 执行记录",
  "substantive-too-thin": "实质性回答过于简略",
  "framework-missing": "缺少问题框架或组织结构",
  "logic-missing": "缺少依据、假设或底层逻辑",
  "calibration-missing": "缺少事实、推断、未知或风险校准",
  "next-step-missing": "缺少结论后的可执行下一步",
  "requested-topic-missing": "尚未检测到部分明确请求主题的回应",
  "research-evidence-not-observed": "请求的研究资料没有可核验的覆盖记录",
  "public-evidence-not-observed": "当前公开信息需求没有可核验的覆盖证据",
  "primary-deliverable-missing": "主要任务的受保护交付字段不完整",
  "output-constraint-violated": "没有满足用户明确的长度或格式约束",
  "path-display-incomplete": "用户明确要求完整 PATH，但回答缺少请求的阶段呈现",
});

function boundedQualityText(value, maximum = MAX_QUALITY_TEXT_CHARS) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function isSubstantiveTask(taskLevel, deliverable) {
  return taskLevel !== "T0_DIRECT" || deliverable !== "direct-answer";
}

function hasPathSkill(skills = [], primarySkill = null) {
  const values = [...(Array.isArray(skills) ? skills : []), ...(Array.isArray(primarySkill) ? primarySkill : primarySkill ? [primarySkill] : [])];
  return values.some((skill) => {
    const id = typeof skill === "string" ? skill : (skill?.id || skill?.skillId || skill?.name || "");
    return id === "xingzhi-path-runtime";
  });
}

function wordCount(text) {
  if (typeof Intl?.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)]
      .filter((item) => item.isWordLike).length;
  }
  return (text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) || []).length;
}

function requiredPublicNeedIds(value) {
  const ids = [];
  for (const need of Array.isArray(value) ? value : []) {
    if (!need || typeof need !== "object" || need.optional === true) continue;
    const scope = String(need.scope || need.sourceScope || need.source || need.kind || "").toLowerCase();
    const privateNeed = need.private === true || new Set(["personal", "private", "local", "user-context"]).has(scope);
    const unknownScope = scope === "unknown" || need.unknownScope === true;
    const publicNeed = need.public === true || need.publicNeed === true || need.publicExpected === true
      || new Set(["public", "web", "external"]).has(scope)
      || (!privateNeed && !unknownScope && /^(?:recent|live)$/iu.test(String(need.freshness || "")));
    const id = typeof need.id === "string" ? need.id.trim().slice(0, 80) : "";
    if (publicNeed && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function requiredInformationNeedIds(value) {
  const ids = [];
  for (const need of Array.isArray(value) ? value : []) {
    if (!need || typeof need !== "object" || need.optional === true) continue;
    const id = typeof need.id === "string" ? need.id.trim().slice(0, 80) : "";
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function assessResearchEvidence(input, contract) {
  const informationNeeds = Array.isArray(input.informationNeeds)
    ? input.informationNeeds
    : (Array.isArray(contract?.informationNeeds) ? contract.informationNeeds : []);
  const inputNeedIds = requiredInformationNeedIds(informationNeeds);
  const requiredNeedIds = inputNeedIds.length
    ? inputNeedIds
    : (Array.isArray(contract?.informationNeedIds)
      ? [...new Set(contract.informationNeedIds.filter((id) => typeof id === "string" && id.trim()))]
      : []);
  const assessment = input.evidenceAssessment && typeof input.evidenceAssessment === "object"
    ? input.evidenceAssessment : {};
  const covered = new Set([
    ...(Array.isArray(assessment.coveredNeedIds) ? assessment.coveredNeedIds : []),
    ...(Array.isArray(assessment.coveredLocalNeedIds) ? assessment.coveredLocalNeedIds : []),
    ...(Array.isArray(assessment.coveredPublicNeedIds) ? assessment.coveredPublicNeedIds : []),
  ].filter((id) => typeof id === "string"));
  const missingNeedIds = requiredNeedIds.filter((id) => !covered.has(id));
  const expected = contract?.researchExpected === true || requiredNeedIds.length > 0;
  return {
    expected,
    status: !expected ? "not-required" : (requiredNeedIds.length === 0
      ? "not-assessed"
      : (missingNeedIds.length ? "missing" : "covered")),
    requiredNeedIds,
    coveredNeedIds: requiredNeedIds.filter((id) => covered.has(id)),
    missingNeedIds,
    assessmentStatus: boundedQualityText(assessment.status, 80),
  };
}

function assessPublicEvidence(input, contract) {
  const informationNeeds = Array.isArray(input.informationNeeds)
    ? input.informationNeeds
    : (Array.isArray(contract?.informationNeeds) ? contract.informationNeeds : []);
  const inputNeedIds = requiredPublicNeedIds(informationNeeds);
  const requiredNeedIds = inputNeedIds.length
    ? inputNeedIds
    : (Array.isArray(contract?.publicInformationNeedIds)
      ? [...new Set(contract.publicInformationNeedIds.filter((id) => typeof id === "string" && id.trim()))]
      : []);
  const contractRequiresPublic = contract?.publicExpected === true;
  const required = requiredNeedIds.length > 0 || contractRequiresPublic;
  const assessment = input.evidenceAssessment && typeof input.evidenceAssessment === "object"
    ? input.evidenceAssessment : {};
  const covered = new Set([
    ...(Array.isArray(assessment.coveredNeedIds) ? assessment.coveredNeedIds : []),
    ...(Array.isArray(assessment.coveredPublicNeedIds) ? assessment.coveredPublicNeedIds : []),
  ].filter((id) => typeof id === "string"));
  const missingNeedIds = requiredNeedIds.filter((id) => !covered.has(id));
  // A textual "sufficient" label or unrelated source count cannot establish
  // coverage for a specific public information need.
  const coveredAll = required && requiredNeedIds.length > 0 && missingNeedIds.length === 0;
  const actualPublicSourceCount = typeof input.actualPublicSourceCount === "number"
    && Number.isFinite(input.actualPublicSourceCount)
    ? Math.max(0, input.actualPublicSourceCount) : null;
  const actualWebCalls = typeof input.actualWebCalls === "number" && Number.isFinite(input.actualWebCalls)
    ? Math.max(0, input.actualWebCalls) : null;
  const networkAllowed = typeof input.networkAllowed === "boolean" ? input.networkAllowed : null;
  return {
    required,
    status: !required ? "not-required" : (coveredAll ? "covered" : "missing"),
    requiredNeedIds,
    coveredNeedIds: requiredNeedIds.filter((id) => covered.has(id)),
    missingNeedIds: requiredNeedIds.length ? missingNeedIds : (coveredAll ? [] : ["public-scope-not-assessed"]),
    actualPublicSourceCount,
    actualWebCalls,
    networkAllowed,
    assessmentStatus: boundedQualityText(assessment.status, 80),
  };
}

function outputConstraintViolations(text, contract) {
  const constraints = contract?.outputConstraints || {};
  const violations = [];
  if (Number.isSafeInteger(constraints.maximumCharacters)
    && Array.from(text).length > constraints.maximumCharacters) {
    violations.push("maximum-characters");
  }
  if (Number.isSafeInteger(constraints.maximumWords)) {
    if (wordCount(text) > constraints.maximumWords) violations.push("maximum-words");
  }
  if (constraints.singleSentence === true) {
    const sentenceParts = text
      .split(/[。！？!?]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const nonEmptyLines = text.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    if (sentenceParts.length > 1 || nonEmptyLines.length > 1) violations.push("single-sentence");
  }
  return violations;
}

function evaluateAnswerQuality(input = {}) {
  const text = boundedQualityText(input.text);
  const defects = [];
  const contract = input.contract?.version === 2 && Array.isArray(input.contract.requirements)
    ? input.contract
    : answerContract(input.instructionText, {
        outputDepth: input.outputDepth,
        taskLevel: input.taskLevel,
        deliverable: input.deliverable,
        skills: input.skills,
        primarySkill: input.primarySkill,
        informationNeeds: input.informationNeeds,
      });
  const missing = missingRequirements(text, contract);
  const researchEvidence = assessResearchEvidence(input, contract);
  const publicEvidence = assessPublicEvidence(input, contract);
  const formatViolations = outputConstraintViolations(text, contract);
  const pathDisplayMissing = (hasPathSkill(input.skillIds, input.primarySkill) || hasPathSkill(input.skills, input.primarySkill))
    ? missingPathDisplay(text, {
        fullPresentation: /完整\s*PATH|PATH[^。\n]{0,16}(?:完整呈现|完整展开)|完整呈现[^。\n]{0,24}四阶段/iu.test(input.instructionText || "")
          && !/(?:不|无需|不必|不要|不用|避免|禁止)[^，,。！？\n]{0,24}(?:完整\s*PATH|PATH[^，,。\n]{0,16}(?:完整|四阶段)|完整呈现[^，,。\n]{0,16}四阶段)/iu.test(input.instructionText || ""),
      })
    : [];
  if (pathDisplayMissing.length) defects.push("path-display-incomplete");
  if (missing.some((requirement) => requirement?.sources?.includes("user-explicit"))) {
    defects.push("requested-topic-missing");
  }
  if (missing.some((requirement) => requirement?.sources?.some((source) => (
    source === "deliverable-baseline" || source === "primary-skill-baseline"
  )))) {
    defects.push("primary-deliverable-missing");
  }
  if (researchEvidence.expected && researchEvidence.status !== "covered") {
    defects.push("research-evidence-not-observed");
  }
  if (publicEvidence.required && publicEvidence.status !== "covered") {
    defects.push("public-evidence-not-observed");
  }
  if (!text) defects.push("answer-empty");
  if (formatViolations.length) defects.push("output-constraint-violated");
  if (!new Set(["completed", "fallback", "delegated-to-main", "not-required"]).has(input.semanticStatus)) {
    defects.push("semantic-stage-missing");
  }
  if (!new Set(["completed", "degraded", "context-only", "not-required"]).has(input.evidenceStatus)) {
    defects.push("evidence-stage-missing");
  }
  if (!boundedQualityText(input.agentId, 160)) defects.push("agent-missing");
  const skillIds = Array.isArray(input.skillIds) ? input.skillIds : [];
  const trainingSkillActive = skillIds.includes("xingzhi-training-response");

  const substantive = isSubstantiveTask(input.taskLevel || "T0_DIRECT", input.deliverable || "direct-answer");
  if (substantive && input.interpretationStatus !== "ambiguous") {
    if (trainingSkillActive) {
      if (!/(?:框架|结构|分为|首先|第一|结论|framework|structure|first|conclusion)/iu.test(text)) defects.push("framework-missing");
      if (!/(?:底层|逻辑|因为|原因|依据|假设|机制|logic|because|reason|evidence|assumption|mechanism)/iu.test(text)) defects.push("logic-missing");
      if (!/(?:事实|推断|未知|证据|置信|风险|失败|取决于|可能|fact|inference|unknown|confidence|risk|failure|depends|likely)/iu.test(text)) defects.push("calibration-missing");
      if (!/(?:下一步|建议|行动|验证|可以先|优先|next step|recommend|action|verify|validate|prioritize)/iu.test(text)) defects.push("next-step-missing");
    }
  }

  const uniqueDefects = [...new Set(defects)];
  const repairAttempts = Math.max(0, Math.min(MAX_ANSWER_QUALITY_REPAIRS, Number(input.repairAttempts) || 0));
  const passed = uniqueDefects.length === 0;
  const researchEvidenceMissing = researchEvidence.expected && researchEvidence.status !== "covered";
  const publicEvidenceMissing = publicEvidence.required && publicEvidence.status !== "covered";
  const shouldRepair = !researchEvidenceMissing && !publicEvidenceMissing
    && (missing.length > 0 || formatViolations.length > 0 || pathDisplayMissing.length > 0) && text.length > 0
    && (input.interpretationStatus !== "ambiguous" || pathDisplayMissing.length > 0)
    && repairAttempts < MAX_ANSWER_QUALITY_REPAIRS;
  const repairMode = shouldRepair
    ? (contract.outputConstraints?.strict === true ? "replace" : "append")
    : "none";
  const status = passed ? "passed" : (shouldRepair ? "repair-required" : "accepted-with-limit");
  return {
    status,
    contract,
    missingRequirements: missing,
    pathDisplayMissing,
    formatViolations,
    method: "local-protected-contract-v2",
    semanticCompleteness: "not-measured",
    researchEvidence,
    publicEvidence,
    shouldRepair,
    repairMode,
    substantive,
    repairAttempts,
    maxRepairs: MAX_ANSWER_QUALITY_REPAIRS,
    defects: uniqueDefects,
    defectLabels: uniqueDefects.map((code) => DEFECT_LABELS[code] || code),
    score: null,
  };
}

function buildAnswerQualityBlock({
  taskLevel = "T0_DIRECT",
  deliverable = "direct-answer",
  trainingSkillActive = false,
  instructionText = "",
  outputDepth = "standard",
  skills = [],
  primarySkill = null,
  informationNeeds = [],
  internalWorkflow = false,
} = {}) {
  if (internalWorkflow) return "";
  const substantive = isSubstantiveTask(taskLevel, deliverable);
  const contract = answerContract(instructionText, {
    outputDepth,
    taskLevel,
    deliverable,
    skills,
    primarySkill,
    informationNeeds,
  });
  return [
    "【主回答质量闭环】",
    answerContractBlock(contract),
    buildRealProgressBlock({ deliverable, outputDepth: contract.outputDepth, skills, primarySkill, internalWorkflow }),
    "形成草稿后，在提交前只做一次内部自检和必要修正；不要展示自检过程。",
    "必须确认：语义对齐、来源边界、Agent 与本轮实际加载的 Skill 已经落实，不得把未加载的能力或固定格式强加给回答。",
    contract.cognitiveLensCount > 0
      ? `本轮加载了 ${contract.cognitiveLensCount} 个认知透镜。认知透镜只能提供局部分析；主要 Skill 或主 Agent 保留最终交付权。`
      : "本轮最终交付由主要 Skill 或主 Agent 负责。",
    substantive
      ? (trainingSkillActive
        ? "本轮已明确触发训练式回答：按需覆盖问题框架、底层逻辑、关键依据、必要视角、校准反馈、结论与下一轮练习；不要机械堆栏目。"
        : "本轮按普通回答或执行任务验收：直接、完整地交付用户当前要求；不要主动改成练习、教练、教学或复盘流程，也不要为了命中质量关键词强加固定栏目。")
      : "本轮允许简短直接，但简短不等于绕过语义理解、证据探测、Agent、Skill 和验收。",
  ].join("\n");
}

module.exports = {
  MAX_ANSWER_QUALITY_REPAIRS,
  buildAnswerQualityBlock,
  evaluateAnswerQuality,
};
