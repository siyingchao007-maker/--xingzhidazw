"use strict";

const { buildTurnCapabilityPlan } = require("./capability-orchestrator.cjs");
const {
  evaluateCognitiveLensMigrationGate,
  migrationSuite,
} = require("./cognitive-lens-migration.cjs");
const {
  buildReasoningCoordinationBlock,
  getReasoningOperator,
} = require("./reasoning-operator-registry.cjs");
const {
  compileAndPublishSkill,
  compileSkillSource,
} = require("./skill-compiler.cjs");
const { markActiveSkillHealthy } = require("./skill-release-store.cjs");
const {
  SKILL_REGISTRY_PATH,
  loadVaultCapabilityCatalog,
  loadVaultSkillInstructions,
} = require("./vault-capability-package.cjs");

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertVault(vault) {
  for (const method of ["exists", "read", "create", "modify", "process", "ensureFolder"]) {
    if (typeof vault?.[method] !== "function") throw new Error(`迁移激活缺少 Vault ${method} 接口`);
  }
}

async function preflightExactArtifact(vault, filePath, content) {
  if (!await vault.exists(filePath)) return;
  if (await vault.read(filePath) !== content) {
    throw new Error(`迁移生成文件已经存在且内容不一致：${filePath}`);
  }
}

function parseRegistry(text) {
  let registry;
  try {
    registry = JSON.parse(text);
  } catch {
    throw new Error("Skill 注册表必须是 JSON 兼容 YAML");
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)
    || registry.registryType !== "xingzhi-skill-registry"
    || !Array.isArray(registry.skills)) {
    throw new Error("Skill 注册表结构无效");
  }
  return registry;
}

async function registryUpdate(vault, entry) {
  const currentText = await vault.read(SKILL_REGISTRY_PATH);
  const current = parseRegistry(currentText);
  const matches = current.skills.filter((item) => item?.id === entry.id);
  if (matches.length > 1) throw new Error(`Skill 注册表存在重复编号：${entry.id}`);
  if (matches.length === 1) {
    if (JSON.stringify(matches[0]) !== JSON.stringify(entry)) {
      throw new Error(`Skill 注册表已有不兼容条目：${entry.id}`);
    }
    return { changed: false, text: currentText };
  }
  return {
    changed: true,
    text: jsonFile({ ...current, skills: [...current.skills, entry] }),
  };
}

async function installCompiledArtifacts(vault, compilation) {
  const artifacts = [
    [compilation.artifacts.skillConfigPath, compilation.artifacts.skillConfigText],
    [compilation.artifacts.codexInterfacePath, compilation.artifacts.codexInterfaceText],
  ];
  for (const [filePath, content] of artifacts) await preflightExactArtifact(vault, filePath, content);
  const registry = await registryUpdate(vault, compilation.artifacts.registryEntry);
  for (const [filePath, content] of artifacts) {
    if (await vault.exists(filePath)) continue;
    const slash = filePath.lastIndexOf("/");
    if (slash > 0) await vault.ensureFolder(filePath.slice(0, slash));
    await vault.create(filePath, content);
  }
  if (registry.changed) await vault.modify(SKILL_REGISTRY_PATH, registry.text);
}

function activePlan({ catalog, diagnostics, text }) {
  return buildTurnCapabilityPlan({
    text,
    availableAgents: catalog.agents,
    availableSkills: catalog.skills,
    cognitiveLensShadowDiagnostics: diagnostics,
    preferences: { skillMode: "auto" },
  });
}

function requiredText(value, label, pattern = null) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2_000 || (pattern && !pattern.test(text))) throw new Error(`${label}无效`);
  return text;
}

function createCognitiveLensMigrationActivator({
  label,
  sourcePath,
  skillId,
  operatorId,
  operatorMode,
  positiveText,
  operatorBindings = null,
  routingChecks = null,
  negativeText,
  gateErrorCode,
} = {}) {
  const activationLabel = requiredText(label, "认知透镜名称");
  const expectedSourcePath = requiredText(sourcePath, `${activationLabel} Skill 路径`);
  const expectedSkillId = requiredText(skillId, `${activationLabel} Skill ID`, /^[a-z][a-z0-9-]{2,127}$/u);
  const bindings = (() => {
    const values = operatorBindings == null
      ? [{ id: operatorId, mode: operatorMode }]
      : operatorBindings;
    if (!Array.isArray(values) || !values.length || values.length > 8) {
      throw new Error(`${activationLabel} operator 绑定无效`);
    }
    const seen = new Set();
    return values.map((binding) => {
      const id = requiredText(binding?.id, `${activationLabel} operator ID`, /^[a-z][a-z0-9-]{2,127}$/u);
      const mode = requiredText(binding?.mode, `${activationLabel} operator 模式`, /^[a-z][a-z0-9-]{2,127}$/u);
      if (seen.has(id)) throw new Error(`${activationLabel} operator 绑定重复：${id}`);
      seen.add(id);
      return { id, mode };
    });
  })();
  const bindingIds = bindings.map((binding) => binding.id);
  const checks = (() => {
    const values = routingChecks == null
      ? [{ text: positiveText, operatorIds: [bindingIds[0]] }]
      : routingChecks;
    if (!Array.isArray(values) || !values.length || values.length > 16) {
      throw new Error(`${activationLabel}正例核验无效`);
    }
    return values.map((check) => {
      const text = requiredText(check?.text, `${activationLabel}正例`);
      if (!Array.isArray(check?.operatorIds) || !check.operatorIds.length) {
        throw new Error(`${activationLabel}正例 operator 列表无效`);
      }
      const operatorIds = [...new Set(check.operatorIds.map((id) => (
        requiredText(id, `${activationLabel}正例 operator`, /^[a-z][a-z0-9-]{2,127}$/u)
      )))];
      if (operatorIds.some((id) => !bindingIds.includes(id))) {
        throw new Error(`${activationLabel}正例包含未绑定的 operator`);
      }
      return { text, operatorIds };
    });
  })();
  if (bindingIds.some((id) => !checks.some((check) => check.operatorIds.includes(id)))) {
    throw new Error(`${activationLabel}正例没有覆盖全部 operator`);
  }
  const negativeRoutingText = requiredText(negativeText, `${activationLabel}负例`);
  const errorCode = requiredText(gateErrorCode, `${activationLabel}门槛错误码`, /^[A-Z][A-Z0-9_]{2,127}$/u);
  const suite = migrationSuite(expectedSkillId);
  if (!suite) throw new Error(`${activationLabel}没有已登记的迁移评测套件`);

  function activationError(gate) {
    const error = new Error(`${activationLabel}迁移门槛未通过：${gate.reasonCodes.join(",") || "unknown"}`);
    error.code = errorCode;
    error.gate = gate;
    return error;
  }

  async function activate({
    vault,
    diagnostics = [],
    publishedAt = new Date().toISOString(),
  } = {}) {
    assertVault(vault);
    const markdown = await vault.read(expectedSourcePath);
    const compilation = compileSkillSource({ sourcePath: expectedSourcePath, markdown });
    if (compilation.skillId !== expectedSkillId
      || compilation.skillType !== "cognitive-lens"
      || bindings.some((binding) => !compilation.operators.some((item) => (
        item.id === binding.id && item.mode === binding.mode
      )))) {
      throw new Error(`${activationLabel} Skill 身份、类型或 operator 映射不正确`);
    }
    const gate = evaluateCognitiveLensMigrationGate({
      skillId: compilation.skillId,
      skillVersion: compilation.version,
      contentHash: compilation.contentHash,
      diagnostics,
    });
    if (!gate.passed) throw activationError(gate);

    await preflightExactArtifact(vault, compilation.artifacts.skillConfigPath, compilation.artifacts.skillConfigText);
    await preflightExactArtifact(vault, compilation.artifacts.codexInterfacePath, compilation.artifacts.codexInterfaceText);
    await registryUpdate(vault, compilation.artifacts.registryEntry);

    const published = await compileAndPublishSkill(vault, {
      sourcePath: expectedSourcePath,
      markdown,
      publishedAt,
      activate: true,
      evaluate: async () => ({
        suiteVersion: suite.suiteVersion,
        passed: gate.passed,
        caseCount: gate.qualifyingCases,
      }),
    });
    await installCompiledArtifacts(vault, compilation);

    const enabledExtensions = { skills: { [expectedSkillId]: true } };
    const catalog = await loadVaultCapabilityCatalog(vault, { enabledExtensions });
    const activeSkill = catalog.skills.find((item) => item.name === expectedSkillId);
    if (!activeSkill?.release || activeSkill.release.resolvedFrom !== "active"
      || activeSkill.release.resolvedVersion !== compilation.version
      || activeSkill.release.resolvedHash !== compilation.contentHash) {
      throw new Error(`${activationLabel}活动快照未通过目录核验`);
    }
    const instructions = await loadVaultSkillInstructions(vault, activeSkill);
    if (instructions !== compilation.normalizedMarkdown) {
      throw new Error(`${activationLabel}运行指令不是已发布的不可变快照`);
    }

    const routingVerifications = checks.map((check) => {
      const plan = activePlan({ catalog, diagnostics, text: check.text });
      const selected = plan.skills.filter((item) => item.name === expectedSkillId);
      const operators = check.operatorIds.map((id) => (
        plan.reasoningPlan.operators.find((item) => item.id === id)
      ));
      const coordination = buildReasoningCoordinationBlock(plan.reasoningPlan.operators);
      const includesLegacyBody = check.operatorIds.some((id) => {
        const legacyInstruction = getReasoningOperator(id)?.instruction || "";
        return legacyInstruction && coordination.includes(legacyInstruction);
      });
      if (selected.length !== 1
        || operators.some((item) => item?.instructionSource !== "active-skill")
        || includesLegacyBody) {
        const actual = operators.map((item, index) => (
          `${check.operatorIds[index]}=${item?.instructionSource || "missing"}`
        )).join(",");
        throw new Error(`${activationLabel}单一活动来源核验失败：skills=${selected.length}; ${actual}; legacy=${includesLegacyBody}`);
      }
      return {
        operatorIds: [...check.operatorIds],
        instructionSources: Object.freeze(Object.fromEntries(
          operators.map((item) => [item.id, item.instructionSource]),
        )),
        selectedSkillCount: selected.length,
      };
    });

    const negative = activePlan({ catalog, diagnostics, text: negativeRoutingText });
    const simpleNegativeTriggered = negative.skills.some((item) => item.name === expectedSkillId)
      || bindingIds.some((id) => negative.reasoningPlan.operatorIds.includes(id));
    if (simpleNegativeTriggered) throw new Error(`简单任务错误触发${activationLabel}`);

    const healthy = await markActiveSkillHealthy(vault, {
      skillId: compilation.skillId,
      version: compilation.version,
      contentHash: compilation.contentHash,
    });
    return Object.freeze({
      status: healthy.status,
      identity: Object.freeze({
        skillId: compilation.skillId,
        skillVersion: compilation.version,
        contentHash: compilation.contentHash,
      }),
      gate,
      release: published.release,
      activeEntry: healthy,
      verification: Object.freeze({
        instructionSource: "active-skill",
        operatorInstructionSources: Object.freeze(Object.fromEntries(
          bindingIds.map((id) => [id, "active-skill"]),
        )),
        selectedSkillCount: Math.max(...routingVerifications.map((item) => item.selectedSkillCount)),
        routingChecks: Object.freeze(routingVerifications.map((item) => Object.freeze(item))),
        simpleNegativeTriggered,
        snapshotPath: published.release.snapshotPath,
      }),
    });
  }

  return Object.freeze({ activate, suiteVersion: suite.suiteVersion });
}

module.exports = {
  createCognitiveLensMigrationActivator,
  installCompiledArtifacts,
};
