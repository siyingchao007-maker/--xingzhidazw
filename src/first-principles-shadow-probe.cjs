"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { parseCognitiveLensResult } = require("./cognitive-lens-result.cjs");
const { normalizeTokenUsage } = require("./response-metrics.cjs");
const { compileSkillSource } = require("./skill-compiler.cjs");

const FIRST_PRINCIPLES_PROBE_SOURCE_PATH = "10_智能体与技能/技能/第一性重建/SKILL.md";
const FIRST_PRINCIPLES_PROBE_MESSAGE_ID = "first-principles-shadow-probe-v039";
const FIRST_PRINCIPLES_PROBE_INPUT = "请重新设计一个个人知识库的每日回顾流程。先放下默认模板，区分已知事实、未经验证的假设、硬约束和可协商约束，再给出一个可逆的小范围验证方案。";
const FIRST_PRINCIPLES_PROBE_DIMENSIONS = Object.freeze([
  "目标",
  "事实",
  "假设",
  "硬约束",
  "软约束",
  "未知",
  "必要条件",
  "重构方案",
  "反证条件",
  "下一步验证",
  "适用边界",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildFirstPrinciplesShadowProbe({ vaultPath, markdown } = {}) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) {
    throw new Error("第一性重建影子探针缺少绝对 Vault 路径");
  }
  const compilation = compileSkillSource({
    sourcePath: FIRST_PRINCIPLES_PROBE_SOURCE_PATH,
    markdown,
  });
  if (compilation.skillId !== "xingzhi-first-principles"
    || compilation.skillType !== "cognitive-lens"
    || !compilation.operators.some((item) => (
      item.id === "first-principles-reconstruction" && item.mode === "reconstruction"
    ))) {
    throw new Error("第一性重建影子探针的 Skill 身份或类型不匹配");
  }
  const inputFingerprint = crypto.createHash("sha256")
    .update(FIRST_PRINCIPLES_PROBE_INPUT)
    .digest("hex");
  return deepFreeze({
    mode: "cognitive-lens-shadow",
    input: FIRST_PRINCIPLES_PROBE_INPUT,
    inputFingerprint: `sha256:${inputFingerprint}`,
    currentUserMessageId: FIRST_PRINCIPLES_PROBE_MESSAGE_ID,
    skill: {
      skillId: compilation.skillId,
      skillVersion: compilation.version,
      contentHash: compilation.contentHash,
      path: path.join(vaultPath, ...FIRST_PRINCIPLES_PROBE_SOURCE_PATH.split("/")),
      operatorIds: ["first-principles-reconstruction"],
    },
    expectedDimensions: [...FIRST_PRINCIPLES_PROBE_DIMENSIONS],
    allowedToolIds: [],
    networkAccess: false,
    knowledgeWrite: false,
    affectsFinalAnswer: false,
  });
}

async function runFirstPrinciplesShadowProbe({
  vaultPath,
  markdown,
  executeShadow,
} = {}) {
  if (typeof executeShadow !== "function") {
    throw new Error("第一性重建影子探针缺少受限执行器");
  }
  const request = buildFirstPrinciplesShadowProbe({ vaultPath, markdown });
  const raw = await executeShadow(request);
  const result = parseCognitiveLensResult(raw?.lensResult, {
    expectedSkillId: request.skill.skillId,
    expectedSkillVersion: request.skill.skillVersion,
    expectedContentHash: request.skill.contentHash,
    currentUserMessageId: request.currentUserMessageId,
    currentUserText: request.input,
  });
  const tokenUsage = normalizeTokenUsage(raw?.tokenUsage);
  if (!tokenUsage || !Number.isFinite(tokenUsage.totalTokens) || tokenUsage.totalTokens <= 0) {
    throw new Error("第一性重建影子探针没有返回可验证的 Token 使用量");
  }
  const latencyMs = raw?.latencyMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error("第一性重建影子探针没有返回可验证的执行耗时");
  }
  return deepFreeze({
    status: "passed",
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    contentHash: result.contentHash,
    applicable: result.applicable,
    findingCount: result.findings.length,
    epistemicStatuses: [...new Set(result.findings.map((item) => item.epistemicStatus))],
    tokenUsage,
    latencyMs: Math.round(latencyMs),
  });
}

module.exports = {
  FIRST_PRINCIPLES_PROBE_DIMENSIONS,
  FIRST_PRINCIPLES_PROBE_INPUT,
  FIRST_PRINCIPLES_PROBE_MESSAGE_ID,
  FIRST_PRINCIPLES_PROBE_SOURCE_PATH,
  buildFirstPrinciplesShadowProbe,
  runFirstPrinciplesShadowProbe,
};
