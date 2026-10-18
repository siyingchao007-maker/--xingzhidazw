"use strict";

const path = require("node:path");
const { getReasoningOperator } = require("./reasoning-operator-registry.cjs");
const {
  SKILL_SOURCE_SCHEMA_VERSION,
  normalizeSkillSourceText,
  parseSkillSource,
} = require("./skill-source-schema.cjs");
const {
  SKILL_VERSION_CLAIM_SCHEMA_VERSION,
  activateSkillRelease,
  markSkillReleasePublished,
  publishSkillRelease,
  recordSkillDraft,
  skillVersionClaimPath,
} = require("./skill-release-store.cjs");

const SKILL_COMPILE_SCHEMA_VERSION = "xingzhi-skill-compile/v1";
const CAPABILITY_FORMAT_VERSION = 3;
const EVALUATION_FIELDS = new Set(["suiteVersion", "passed", "caseCount"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function strictFields(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label}包含不允许的字段：${extra.join("、")}`);
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function skillInvocation(source) {
  if (source.skillType === "workflow") return "workflow-only";
  if (source.invocation.primaryEligible && source.invocation.agentRouted) return "implicit";
  return "explicit";
}

function skillInterfaceMetadata(source, invocation) {
  const shortDescription = `${source.label}：${source.description}`.slice(0, 200);
  return [
    "interface:",
    `  display_name: ${JSON.stringify(source.label)}`,
    `  short_description: ${JSON.stringify(shortDescription)}`,
    `  default_prompt: ${JSON.stringify(`使用 $${source.name} 处理当前问题，并遵守行知的读取、归档与权限边界。`)}`,
    "policy:",
    `  allow_implicit_invocation: ${invocation === "implicit" ? "true" : "false"}`,
    "",
  ].join("\n");
}

function compileSkillSource({ sourcePath, markdown } = {}) {
  const source = parseSkillSource(markdown, { sourcePath });
  const normalizedMarkdown = normalizeSkillSourceText(markdown);
  const contentHash = `sha256:${source.sourceHash}`;
  const basePath = path.posix.dirname(source.sourcePath);
  const skillConfigPath = `${basePath}/技能配置.yaml`;
  const codexInterfacePath = `${basePath}/agents/openai.yaml`;
  const invocation = skillInvocation(source);
  const operatorDefinitions = source.operators.map((mapping) => getReasoningOperator(mapping.id));
  if (operatorDefinitions.some((operator) => !operator)) throw new Error("编译时发现未知 reasoning operator");
  const capabilities = [...new Set([source.label, ...operatorDefinitions.map((operator) => operator.label)])];
  const compiledFrom = {
    schemaVersion: SKILL_COMPILE_SCHEMA_VERSION,
    sourceSchemaVersion: SKILL_SOURCE_SCHEMA_VERSION,
    sourcePath: source.sourcePath,
    sourceVersion: source.version,
    contentHash,
    skillType: source.skillType,
    operators: source.operators,
  };
  const skillConfig = {
    formatVersion: CAPABILITY_FORMAT_VERSION,
    id: source.name,
    label: source.label,
    description: source.description,
    version: source.version,
    source: "compiled",
    protected: false,
    enabled: true,
    loadMode: "on-demand",
    skillPath: source.sourcePath,
    surface: source.skillType === "workflow" ? "internal" : "user",
    invocation,
    skillType: source.skillType,
    primaryEligible: source.invocation.primaryEligible,
    controlsFinalLayout: source.output.controlsFinalLayout,
    returnsStructuredResult: source.output.returnsStructuredResult,
    capabilities,
    intents: [source.label],
    tags: [...new Set([source.skillType, ...source.operators.map((operator) => operator.id)])],
    requires: [],
    optionalDependencies: [],
    conflicts: [],
    recommendedOperators: source.operators.map((operator) => operator.id),
    readScopes: [],
    riskLevel: "bounded",
    maxDependencyDepth: 0,
    toolRequests: [],
    compiledFrom,
  };
  const registryEntry = {
    id: source.name,
    configPath: skillConfigPath,
    skillPath: source.sourcePath,
  };
  const appServerInput = {
    type: "skill",
    name: source.name,
    description: source.description,
    path: source.sourcePath,
    version: source.version,
    contentHash,
  };
  return deepFreeze({
    schemaVersion: SKILL_COMPILE_SCHEMA_VERSION,
    skillId: source.name,
    label: source.label,
    description: source.description,
    version: source.version,
    skillType: source.skillType,
    sourcePath: source.sourcePath,
    contentHash,
    normalizedMarkdown,
    operators: source.operators,
    invocation: source.invocation,
    output: source.output,
    artifacts: {
      skillConfigPath,
      skillConfigText: jsonFile(skillConfig),
      codexInterfacePath,
      codexInterfaceText: skillInterfaceMetadata(source, invocation),
      registryEntry,
    },
    appServerInput,
  });
}

function normalizeEvaluation(value) {
  const evaluation = strictRecord(value, "Skill 行为评测结果");
  strictFields(evaluation, EVALUATION_FIELDS, "Skill 行为评测结果");
  if (typeof evaluation.suiteVersion !== "string" || !evaluation.suiteVersion.trim()
    || Buffer.byteLength(evaluation.suiteVersion, "utf8") > 100) {
    throw new Error("Skill 行为评测套件版本无效");
  }
  if (typeof evaluation.passed !== "boolean") throw new Error("Skill 行为评测 passed 必须是布尔值");
  if (!Number.isSafeInteger(evaluation.caseCount) || evaluation.caseCount < 1 || evaluation.caseCount > 100_000) {
    throw new Error("Skill 行为评测用例数无效");
  }
  return {
    suiteVersion: evaluation.suiteVersion.trim(),
    passed: evaluation.passed,
    caseCount: evaluation.caseCount,
  };
}

function safePublishedAt(value) {
  const publishedAt = String(value || new Date().toISOString());
  const time = new Date(publishedAt);
  if (!Number.isFinite(time.valueOf()) || time.toISOString() !== publishedAt) throw new Error("Skill 发布时间无效");
  return publishedAt;
}

async function compileAndPublishSkill(vault, {
  sourcePath,
  markdown,
  evaluate,
  activate = false,
  publishedAt = new Date().toISOString(),
} = {}) {
  const compilation = compileSkillSource({ sourcePath, markdown });
  const safeTime = safePublishedAt(publishedAt);
  await recordSkillDraft(vault, { sourcePath, markdown: compilation.normalizedMarkdown });
  if (typeof evaluate !== "function") throw new Error("Skill 发布缺少行为评测器");
  const evaluationInput = deepFreeze({
    schemaVersion: SKILL_COMPILE_SCHEMA_VERSION,
    appServerInput: compilation.appServerInput,
    instructions: compilation.normalizedMarkdown,
    skillType: compilation.skillType,
    operators: compilation.operators,
    output: compilation.output,
  });
  const evaluation = normalizeEvaluation(await evaluate(evaluationInput));
  if (!evaluation.passed) {
    return deepFreeze({
      status: "draft",
      published: false,
      activated: false,
      compilation,
      evaluation,
      release: null,
      activeEntry: null,
    });
  }
  const release = await publishSkillRelease(vault, {
    sourcePath,
    markdown: compilation.normalizedMarkdown,
    evaluation,
    publishedAt: safeTime,
  });
  let activeEntry = await markSkillReleasePublished(vault, release);
  if (activate === true) activeEntry = await activateSkillRelease(vault, release);
  return deepFreeze({
    status: activate === true ? "activated" : "published",
    published: true,
    activated: activate === true,
    compilation,
    evaluation,
    release,
    activeEntry,
  });
}

module.exports = {
  SKILL_COMPILE_SCHEMA_VERSION,
  SKILL_VERSION_CLAIM_SCHEMA_VERSION,
  compileAndPublishSkill,
  compileSkillSource,
  skillVersionClaimPath,
};
