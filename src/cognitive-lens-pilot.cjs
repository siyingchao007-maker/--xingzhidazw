"use strict";

const path = require("node:path");
const {
  inputFingerprint,
  recentCognitiveLensShadowDiagnostics,
  restoreCognitiveLensShadowDiagnostics,
  runCognitiveLensShadowComparison,
} = require("./cognitive-lens-shadow.cjs");
const { evaluateCognitiveLensMigrationGate } = require("./cognitive-lens-migration.cjs");
const { compileSkillSource } = require("./skill-compiler.cjs");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value, label, pattern = null) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 256 || (pattern && !pattern.test(text))) {
    throw new Error(`${label}无效`);
  }
  return text;
}

function normalizedCases(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 32) {
    throw new Error(`${label}固定样本无效`);
  }
  const ids = new Set();
  return deepFreeze(value.map((item) => {
    const id = requiredText(item?.id, `${label}样本编号`, /^[a-z0-9][a-z0-9-]{1,79}$/u);
    if (ids.has(id)) throw new Error(`${label}样本编号重复：${id}`);
    ids.add(id);
    const input = requiredText(item?.input, `${label}样本输入`);
    const domain = requiredText(item?.domain, `${label}样本领域`, /^[a-z0-9][a-z0-9-]{1,79}$/u);
    const operatorId = item?.operatorId == null
      ? null
      : requiredText(item.operatorId, `${label}旧 operator`, /^[a-z][a-z0-9-]{2,127}$/u);
    const operatorIds = item?.operatorIds === undefined
      ? (operatorId ? [operatorId] : [])
      : (() => {
        if (!Array.isArray(item.operatorIds) || item.operatorIds.length > 8) {
          throw new Error(`${label}旧 operator 列表无效`);
        }
        return [...new Set(item.operatorIds.map((id) => requiredText(
          id,
          `${label}旧 operator`,
          /^[a-z][a-z0-9-]{2,127}$/u,
        )))];
      })();
    if (!Array.isArray(item?.expectedDimensions) || item.expectedDimensions.length > 32) {
      throw new Error(`${label}样本评测维度无效`);
    }
    const expectedDimensions = [...new Set(item.expectedDimensions.map((dimension) => (
      requiredText(dimension, `${label}评测维度`)
    )))];
    return { id, domain, operatorId, operatorIds, input, expectedDimensions };
  }));
}

function createCognitiveLensPilot({
  label,
  sourcePath,
  skillId,
  operatorId,
  operatorMode,
  operatorBindings = null,
  cases,
  messageIdPrefix,
} = {}) {
  const pilotLabel = requiredText(label, "认知透镜名称");
  const expectedSourcePath = requiredText(sourcePath, `${pilotLabel} Skill 路径`);
  const expectedSkillId = requiredText(skillId, `${pilotLabel} Skill ID`, /^[a-z][a-z0-9-]{2,127}$/u);
  const bindings = (() => {
    const values = operatorBindings == null
      ? [{ id: operatorId, mode: operatorMode }]
      : operatorBindings;
    if (!Array.isArray(values) || !values.length || values.length > 8) {
      throw new Error(`${pilotLabel} operator 绑定无效`);
    }
    const seen = new Set();
    return values.map((binding) => {
      const id = requiredText(binding?.id, `${pilotLabel} operator ID`, /^[a-z][a-z0-9-]{2,127}$/u);
      const mode = requiredText(binding?.mode, `${pilotLabel} operator 模式`, /^[a-z][a-z0-9-]{2,127}$/u);
      if (seen.has(id)) throw new Error(`${pilotLabel} operator 绑定重复：${id}`);
      seen.add(id);
      return { id, mode };
    });
  })();
  const bindingById = new Map(bindings.map((binding) => [binding.id, binding]));
  const currentUserMessagePrefix = requiredText(
    messageIdPrefix,
    `${pilotLabel}消息前缀`,
    /^[a-z0-9][a-z0-9-]{1,79}$/u,
  );
  const fixedCases = normalizedCases(cases, pilotLabel);
  for (const item of fixedCases) {
    if (item.operatorIds.some((id) => !bindingById.has(id))) {
      throw new Error(`${pilotLabel}固定样本包含未绑定的旧 operator`);
    }
  }

  function compiledPilotSkill(vaultPath, markdown) {
    if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) {
      throw new Error(`${pilotLabel}配对评测缺少绝对 Vault 路径`);
    }
    const compiled = compileSkillSource({ sourcePath: expectedSourcePath, markdown });
    if (compiled.skillId !== expectedSkillId
      || compiled.skillType !== "cognitive-lens"
      || bindings.some((binding) => !compiled.operators.some((item) => (
        item.id === binding.id && item.mode === binding.mode
      )))) {
      throw new Error(`${pilotLabel}配对评测的 Skill 身份或类型不匹配`);
    }
    return {
      skillId: compiled.skillId,
      skillVersion: compiled.version,
      contentHash: compiled.contentHash,
      path: path.join(vaultPath, ...expectedSourcePath.split("/")),
      operatorIds: bindings.map((binding) => binding.id),
      operatorModes: bindings.map((binding) => ({ ...binding })),
    };
  }

  function exactSkillDiagnostic(row, skill) {
    return row?.shadow?.skillId === skill.skillId
      && row.shadow.skillVersion === skill.skillVersion
      && row.shadow.contentHash === skill.contentHash;
  }

  function pilotState({ vaultPath, markdown, diagnostics = [] } = {}) {
    const skill = compiledPilotSkill(vaultPath, markdown);
    const restored = restoreCognitiveLensShadowDiagnostics(diagnostics);
    const fingerprints = new Set(fixedCases.map((item) => inputFingerprint(item.input)));
    const pilotDiagnostics = restored.filter((row) => (
      fingerprints.has(row.inputFingerprint) && exactSkillDiagnostic(row, skill)
    ));
    const completed = new Set(pilotDiagnostics
      .filter((row) => row.status !== "shadow-failed")
      .map((row) => row.inputFingerprint));
    const next = fixedCases.find((item) => !completed.has(inputFingerprint(item.input))) || null;
    return {
      skill,
      restored,
      pilotDiagnostics,
      completedCases: completed.size,
      remainingCases: fixedCases.length - completed.size,
      nextCaseId: next?.id || null,
      gate: evaluateCognitiveLensMigrationGate({ ...skill, diagnostics: pilotDiagnostics }),
    };
  }

  function status(options = {}) {
    const state = pilotState(options);
    return deepFreeze({
      skillId: state.skill.skillId,
      skillVersion: state.skill.skillVersion,
      contentHash: state.skill.contentHash,
      completedCases: state.completedCases,
      remainingCases: state.remainingCases,
      nextCaseId: state.nextCaseId,
      gate: state.gate,
    });
  }

  async function run({
    vaultPath,
    markdown,
    diagnostics = [],
    caseId = null,
    executeLegacy,
    executeShadow,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof executeLegacy !== "function" || typeof executeShadow !== "function") {
      throw new Error(`${pilotLabel}配对评测缺少真实新旧执行器`);
    }
    const before = pilotState({ vaultPath, markdown, diagnostics });
    const selected = caseId
      ? fixedCases.find((item) => item.id === caseId)
      : fixedCases.find((item) => item.id === before.nextCaseId);
    if (caseId && !selected) throw new Error(`${pilotLabel}配对评测用例不存在`);
    if (!selected) {
      return deepFreeze({
        status: "complete",
        comparison: null,
        diagnostics: before.restored,
        completedCases: before.completedCases,
        remainingCases: before.remainingCases,
        nextCaseId: null,
        gate: before.gate,
      });
    }

    const request = {
      caseId: selected.id,
      domain: selected.domain,
      input: selected.input,
      expectedDimensions: [...selected.expectedDimensions],
      operatorId: selected.operatorId,
      operatorIds: [...selected.operatorIds],
    };
    const legacyResult = await executeLegacy(request);
    const selectedSkill = {
      ...before.skill,
      operatorIds: [...selected.operatorIds],
      operatorModes: selected.operatorIds.map((id) => ({ ...bindingById.get(id) })),
    };
    const { comparison } = await runCognitiveLensShadowComparison({
      caseId: selected.id,
      domain: selected.domain,
      input: selected.input,
      currentUserMessageId: `${currentUserMessagePrefix}-${selected.id}`,
      legacyResult,
      shadowSkill: selectedSkill,
      expectedDimensions: [...selected.expectedDimensions],
      executeShadow,
      now,
    });
    const nextDiagnostics = recentCognitiveLensShadowDiagnostics(before.restored, comparison);
    const after = pilotState({ vaultPath, markdown, diagnostics: nextDiagnostics });
    return deepFreeze({
      status: comparison.status,
      caseId: selected.id,
      domain: selected.domain,
      comparison,
      diagnostics: nextDiagnostics,
      completedCases: after.completedCases,
      remainingCases: after.remainingCases,
      nextCaseId: after.nextCaseId,
      gate: after.gate,
    });
  }

  return deepFreeze({ cases: fixedCases, status, run });
}

module.exports = { createCognitiveLensPilot };
