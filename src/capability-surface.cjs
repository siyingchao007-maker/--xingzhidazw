"use strict";
const INTERNAL_SKILLS = new Set(["xingzhi-interaction-event-extraction", "xingzhi-user-profile-evolution", "xingzhi-growth-path-synthesis", "xingzhi-conversation-organization"]);
const SKILL_TYPES = new Set(["task", "orchestrator", "cognitive-lens", "workflow"]);

function normalizedSkillType(skill) {
  const declared = skill?.skillType || skill?.compiledFrom?.skillType;
  if (declared === undefined || declared === null || declared === "") return "task";
  return SKILL_TYPES.has(declared) ? declared : "invalid";
}

function declaredBoolean(skill, directKey, nestedOwner, nestedKey, fallback) {
  if (typeof skill?.[directKey] === "boolean") return skill[directKey];
  if (typeof skill?.[nestedOwner]?.[nestedKey] === "boolean") return skill[nestedOwner][nestedKey];
  return fallback;
}

function skillTypePolicy(skill) {
  const skillType = normalizedSkillType(skill);
  const constrained = skillType === "cognitive-lens" || skillType === "workflow";
  const valid = skillType !== "invalid";
  return Object.freeze({
    skillType,
    visibleInDialogue: valid && skillType !== "workflow",
    primaryEligible: !valid || constrained
      ? false
      : declaredBoolean(skill, "primaryEligible", "invocation", "primaryEligible", true),
    controlsFinalLayout: !valid || constrained
      ? false
      : declaredBoolean(skill, "controlsFinalLayout", "output", "controlsFinalLayout", skillType === "task"),
    contributesReadScopes: valid && skillType !== "cognitive-lens",
    canRequestTools: valid && skillType !== "cognitive-lens",
  });
}

function isExplicitOrchestrationRequest(value) {
  return /多视角|多个视角|多个角度|多角度|系统性分析|综合分析/u.test(String(value || ""));
}

function isInternalSkill(skill) {
  return normalizedSkillType(skill) === "workflow"
    || INTERNAL_SKILLS.has(skill?.name || skill?.id)
    || skill?.surface === "internal"
    || skill?.invocation === "workflow-only";
}

function isSkillVisibleInDialogue(skill) {
  return skillTypePolicy(skill).visibleInDialogue && !isInternalSkill(skill);
}

function isPrimarySkillEligible(skill, {
  deliverable = "direct-answer",
  hasTaskSkill = false,
  explicitOrchestration = false,
} = {}) {
  const policy = skillTypePolicy(skill);
  if (!policy.primaryEligible) return false;
  if (policy.skillType === "orchestrator") {
    return deliverable === "multi-perspective-analysis" && explicitOrchestration && !hasTaskSkill;
  }
  return policy.skillType === "task";
}
// Text transformations must not activate capabilities mentioned in the material.
function isTextTransformation(value) {
  const text = String(value || "").slice(0, 2000);
  const direct = /^(?:请|帮我|请帮我|麻烦)?\s*(?:翻译|改写|润色|缩写|总结这段|概括这段|只(?:需|要)?(?:改|纠正)(?:错别字|拼写|标点)|仅(?:修改|修正)(?:错别字|拼写|标点)|解释.{0,20}(?:这个词|这个词语|词义))/u.test(text)
    || /(?:这段|这句|这段文字|下面的|这个计划|这段行动计划).{0,30}(?:改短|改成表格|起.{0,6}标题|写.{0,6}标题|润色|翻译)/u.test(text);
  return direct && !/(?:同时|另外|然后|并且).{0,10}(?:评估|判断|比较|制定|拆解|分析风险)/u.test(text);
}
module.exports = {
  INTERNAL_SKILLS,
  isInternalSkill,
  isExplicitOrchestrationRequest,
  isPrimarySkillEligible,
  isSkillVisibleInDialogue,
  isTextTransformation,
  normalizedSkillType,
  skillTypePolicy,
};
