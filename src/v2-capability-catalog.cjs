"use strict";

const path = require("node:path");
const {
  safeCanonicalPath, normalizeCanonicalRegistry, normalizeCanonicalEntity,
  validateCanonicalPolicies, validateCanonicalCapabilityMap, assertCanonicalInvocation,
} = require("./canonical-governance.cjs");
const {
  REGISTRY_COLLECTIONS,
  buildAliasIndex,
  resolveCapabilityId,
  validateAgentConfig,
  validateRegistry,
} = require("./v2-capability-schema.cjs");

const V2_ROOT = "10_智能体与技能/v2";
const V2_REGISTRY_ROOT = `${V2_ROOT}/08_注册表`;
const GOVERNANCE_ROOTS = Object.freeze([V2_ROOT, "10_智能体与技能"]);
const MAX_V2_FILE_BYTES = 256 * 1024;
const REGISTRY_FILES = Object.freeze({
  agent: "agent-registry.yaml",
  skill: "skill-registry.yaml",
  "cognitive-lens": "lens-registry.yaml",
  workflow: "workflow-registry.yaml",
  automation: "automation-registry.yaml",
  tool: "tool-registry.yaml",
});

function parseJsonConfig(text, label) {
  if (typeof text !== "string") throw new TypeError(`${label} 必须是文本`);
  if (Buffer.byteLength(text, "utf8") > MAX_V2_FILE_BYTES) throw new Error(`${label} 超出大小限制`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    // 使用 Obsidian 自带解析器，不新增运行时依赖。
    try { parsed = require("obsidian").parseYaml(text); }
    catch (error) { throw new Error(`${label} YAML 解析失败：${String(error?.message || error).slice(0, 240)}`); }
  }
  let nodes = 0;
  const ancestors = new WeakSet();
  function inspect(value, depth = 0) {
    if (++nodes > 50_000 || depth > 24) throw new Error(`${label} 配置结构过深或过大`);
    if (!value || typeof value !== "object") return;
    if (ancestors.has(value)) throw new Error(`${label} 不允许循环引用`);
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${label} 含保留键`);
      inspect(child, depth + 1);
    }
    ancestors.delete(value);
  }
  inspect(parsed);
  return parsed;
}

function resolveRegistryRef(configRef, root = V2_ROOT) {
  const resolved = path.posix.normalize(`${root}/08_注册表/${configRef}`);
  if (!resolved.startsWith(`${root}/`) || resolved.includes("/../")) {
    throw new Error(`v2 configRef 越出能力系统目录：${configRef}`);
  }
  return resolved;
}

async function readJson(vault, filePath, label = filePath) {
  return parseJsonConfig(await vault.read(filePath), label);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 不一致：${String(actual)} != ${String(expected)}`);
}

function validateSimpleEntity(config, entry, kind) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${entry.id} 配置无效`);
  assertEqual(config.schemaVersion, "2.0", `${entry.id}.schemaVersion`);
  assertEqual(config.kind, kind, `${entry.id}.kind`);
  assertEqual(config.id, entry.id, `${entry.id}.id`);
  assertEqual(config.version, entry.version, `${entry.id}.version`);
  if (config.enabled !== true && config.enabled !== false) throw new Error(`${entry.id}.enabled 必须是布尔值`);
  if (kind === "cognitive-lens") {
    if (config.primaryEligible !== false || config.readOnly !== true
      || config.sideEffects !== false || config.noPermissionExpansion !== true) {
      throw new Error(`${entry.id} 违反认知透镜只读、无副作用或非 Primary 约束`);
    }
  }
  if (kind === "workflow" && config.foregroundVisible !== false) {
    throw new Error(`${entry.id} 后台 Workflow 不得暴露为前台 Agent`);
  }
  return config;
}

function assertCrossReferences(agentConfigs, registries) {
  const sets = {};
  for (const [kind, registry] of Object.entries(registries)) {
    const collection = REGISTRY_COLLECTIONS[kind];
    sets[kind] = new Set(registry[collection].map((entry) => entry.id));
  }
  const fields = [
    ["allowedAgentIds", "agent"],
    ["allowedSkillIds", "skill"],
    ["allowedLensIds", "cognitive-lens"],
    ["allowedWorkflowIds", "workflow"],
  ];
  for (const config of agentConfigs.values()) {
    for (const [field, kind] of fields) {
      for (const id of config[field]) {
        if (!sets[kind].has(id)) throw new Error(`${config.id}.${field} 引用了未注册能力：${id}`);
      }
    }
  }
}

async function loadV2CapabilityGovernance(vault) {
  if (!vault || typeof vault.read !== "function") throw new Error("缺少可读 Vault 适配器");
  let root = null;
  for (const candidate of GOVERNANCE_ROOTS) {
    const entryPath = `${candidate}/08_注册表/agent-registry.yaml`;
    if (typeof vault.exists === "function") {
      if (await vault.exists(entryPath)) { root = candidate; break; }
    } else {
      try { await vault.read(entryPath); root = candidate; break; }
      catch (error) {
        if (error?.code !== "ENOENT" && !/missing|不存在|找不到/iu.test(String(error?.message || ""))) throw error;
      }
    }
  }
  if (!root) throw new Error("未找到治理注册表：10_智能体与技能/v2/08_注册表/ 或 10_智能体与技能/08_注册表/");
  const registryRoot = `${root}/08_注册表`;
  const registries = {};
  let canonicalFormat = false;
  for (const [kind, fileName] of Object.entries(REGISTRY_FILES)) {
    const raw = await readJson(vault, `${registryRoot}/${fileName}`, `${kind} Registry`);
    const canonicalFeatures = raw.registryType !== undefined || raw.kind === "registry"
      || (Array.isArray(raw[REGISTRY_COLLECTIONS[kind]]) && raw[REGISTRY_COLLECTIONS[kind]].some(entry => entry?.configPath !== undefined));
    if (kind === "agent") canonicalFormat = canonicalFeatures;
    else if (!canonicalFormat && canonicalFeatures) throw new Error("治理注册表混用了不一致的数据格式");
    registries[kind] = canonicalFormat ? normalizeCanonicalRegistry(raw, kind) : validateRegistry(raw, kind);
  }
  const configs = {
    agent: new Map(),
    skill: new Map(),
    "cognitive-lens": new Map(),
    workflow: new Map(),
    automation: new Map(),
    tool: new Map(),
  };
  for (const [kind, registry] of Object.entries(registries)) {
    const collection = REGISTRY_COLLECTIONS[kind];
    for (const entry of registry[collection]) {
      const configPath = resolveRegistryRef(entry.configRef, root);
      const raw = await readJson(vault, configPath, `${entry.id} 配置`);
      const normalized = canonicalFormat ? normalizeCanonicalEntity(raw, entry, kind) : raw;
      if (canonicalFormat) entry.enabled = entry.enabled === undefined ? normalized.enabled : entry.enabled && normalized.enabled;
      const config = kind === "agent"
        ? validateAgentConfig(normalized)
        : validateSimpleEntity(normalized, entry, kind);
      assertEqual(config.id, entry.id, `${entry.id}.id`);
      assertEqual(config.version, entry.version, `${entry.id}.version`);
      configs[kind].set(entry.id, Object.freeze({ ...config, enabled: entry.enabled && config.enabled, configPath }));
    }
  }
  for (const [kind, registry] of Object.entries(registries)) registries[kind] = validateRegistry(registry, kind);
  const aliases = buildAliasIndex(Object.entries(registries).map(([kind, registry]) => ({ kind, registry })));
  assertCrossReferences(configs.agent, registries);

  let policy;
  let capabilityMap = await readJson(vault, `${registryRoot}/capability-map.yaml`, "v2 capability-map");
  if (canonicalFormat) {
    const registry = await readJson(vault, `${registryRoot}/policy-registry.yaml`, "Policy Registry");
    if (registry.schemaVersion !== "2.0" || !Array.isArray(registry.policies)) throw new Error("策略注册表无效");
    const policies = Object.create(null);
    for (const entry of registry.policies) {
      if (!entry || typeof entry.id !== "string" || Object.hasOwn(policies, entry.id)) throw new Error("策略编号缺失或重复");
      const policyPath = `${root}/${safeCanonicalPath(entry.configPath, "07_权限与策略")}`;
      const document = await readJson(vault, policyPath, entry.id);
      if (document.id !== entry.id || document.version !== (entry.version || registry.version)) throw new Error(`${entry.id} 策略身份或版本不一致`);
      policies[entry.id] = document;
    }
    validateCanonicalPolicies(policies);
    validateCanonicalCapabilityMap(capabilityMap, configs);
    const agents = Object.fromEntries([...configs.agent].map(([id, config]) => [id, {
      writeMode: config.writeMode, allowedSkillIds: [...config.allowedSkillIds],
      allowedLensIds: [...config.allowedLensIds], runtime: { ...config.runtime },
    }]));
    policy = { schemaVersion: "2.0", defaults: { promptMayExpandPermissions: false },
      lenses: { mayExpandPermissions: false }, agents, documents: policies,
      enforcementScope: "capability-routing-only", source: "policy-registry" };
    capabilityMap = { ...capabilityMap, agents };
  } else {
    policy = await readJson(vault, `${root}/07_权限与策略/policy-map.yaml`, "v2 policy-map");
  }
  assertEqual(policy.schemaVersion, "2.0", "policy-map.schemaVersion");
  assertEqual(capabilityMap.schemaVersion, "2.0", "capability-map.schemaVersion");
  if (policy.defaults?.promptMayExpandPermissions !== false) throw new Error("v2 Policy 必须禁止 Prompt 扩权");
  if (policy.lenses?.mayExpandPermissions !== false) throw new Error("v2 Policy 必须禁止 Lens 扩权");
  for (const id of configs.agent.keys()) {
    if (!policy.agents?.[id] || !capabilityMap.agents?.[id]) {
      throw new Error(`v2 Agent 缺少 Policy 或 capability-map：${id}`);
    }
  }
  return Object.freeze({
    schemaVersion: "2.0",
    root,
    registryRoot,
    format: canonicalFormat ? "canonical-yaml" : "legacy-json",
    defaultAgentId: registries.agent.defaultAgentId,
    registries,
    configs,
    aliases,
    policy,
    capabilityMap,
    loadedAt: new Date().toISOString(),
  });
}

function resolveLegacyOrCanonical(governance, requestedId, expectedKind) {
  return resolveCapabilityId(governance.aliases, requestedId, expectedKind);
}

// Coordinate candidates, never permissions. The caller must still authorize the
// final plan independently before loading instructions or dispatching a turn.
function coordinateV2CapabilityPlan(plan, governance, options = {}) {
  if (!governance || options.internalWorkflow === true) return plan;
  if (!plan || typeof plan !== "object") throw new TypeError("能力计划无效");
  const selected = Array.isArray(plan.skills) ? plan.skills : [];
  const selectedById = new Map(selected.map(item => [item.name, item]));
  const available = new Map((options.availableSkills || []).map(item => [item.name, item]));
  const selectedName = id => selectedById.has(id) ? id : selected.find(item => {
    const target = governance.aliases.get(id), entry = governance.aliases.get(item.name);
    return target && entry && target.canonicalId === entry.canonicalId;
  })?.name || id;
  const dependencyId = value => selectedName(typeof value === "string" ? value : value?.id);
  const edges = (plan.dependencyGraph?.edges || []).map(edge => ({
    ...edge, from: selectedName(edge.from), to: selectedName(edge.to),
  }));
  for (const item of selected) for (const value of (available.get(item.name) || item).optionalDependencies || []) {
    edges.push({ from: item.name, to: dependencyId(value), type: "optional" });
  }
  const requiredChildren = id => [...new Set([
    ...((available.get(id) || selectedById.get(id))?.requires || []).map(dependencyId),
    ...edges.filter(edge => edge.from === id && edge.type === "required").map(edge => edge.to),
  ])];
  const closure = ids => {
    const result = new Set();
    const visit = id => {
      if (result.has(id)) return;
      if (!selectedById.has(id)) throw new Error(`计划缺少必需 Skill：${id}`);
      result.add(id); for (const child of requiredChildren(id)) visit(child);
    };
    for (const id of ids) visit(id);
    return result;
  };
  // Only nodes with real optional-branch evidence may be omitted. Unknown or
  // explicitly selected supporting roots are mandatory, not convenient fallbacks.
  const optionalReachable = new Set();
  for (const edge of edges.filter(edge => edge.type === "optional" && selectedById.has(edge.to))) {
    for (const id of closure([edge.to])) optionalReachable.add(id);
  }
  const explicit = new Set((options.explicitSkillIds || []).map(selectedName));
  const required = closure(selected.filter(item => item.outputRole === "primary" || explicit.has(item.name)
    || item.source !== "dependency" || !optionalReachable.has(item.name)).map(item => item.name));
  const originalAgentId = String(plan.agent?.agentId || "").trim();
  const candidates = (options.availableAgents || []).filter(item => item?.enabled !== false && item.internal !== true);
  const current = candidates.find(item => item.id === originalAgentId);
  const preferredDefault = candidates.find(item => {
    return governance.aliases.get(item.id)?.canonicalId === governance.defaultAgentId;
  }) || candidates.find(item => item.isDefault);
  const ordered = [...new Set([current, ...(options.agentLocked === true ? [] : [preferredDefault, ...candidates])].filter(Boolean))];
  const check = (agent, ids) => {
    // Unregistered task extensions retain the pre-existing Agent allowlist even
    // when canonical constraints require changing the responsible Agent.
    const allowed = Array.isArray(agent.allowedSkillIds) && agent.allowedSkillIds.length
      && !agent.allowedSkillIds.includes("*") ? new Set(agent.allowedSkillIds) : null;
    for (const id of ids) if (allowed && !governance.aliases.has(id) && !allowed.has(id)) {
      throw new Error(`${agent.id} 无权调用扩展 ${id}`);
    }
    return authorizeV2CapabilityPlan({ ...plan,
      agent: { ...plan.agent, agentId: agent.id }, skills: selected.filter(item => ids.has(item.name)),
    }, governance, options);
  };
  let chosen = null, lastError = null;
  for (const agent of ordered) {
    try { check(agent, required); chosen = agent; break; }
    catch (error) { lastError = error; }
  }
  if (!chosen) {
    const error = new Error(`${options.agentLocked === true ? `已锁定 Agent ${originalAgentId}，不能自动替换；` : ""}必需 Skill 计划无法执行（${[...required].join("、")}）：${lastError?.message || "没有可用且获授权的 Agent"}`);
    error.code = options.agentLocked === true ? "XZ_LOCKED_AGENT_INCOMPATIBLE" : "XZ_REQUIRED_PLAN_INCOMPATIBLE";
    throw error;
  }
  const retained = new Set(required), rejected = new Map(), attempted = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const edge of edges) {
      if (edge.type !== "optional" || !retained.has(edge.from) || !selectedById.has(edge.to)
        || retained.has(edge.to) || attempted.has(edge.to)) continue;
      attempted.add(edge.to);
      const branch = closure([edge.to]), proposed = new Set([...retained, ...branch]);
      try { check(chosen, proposed); for (const id of branch) retained.add(id); progressed = true; }
      catch (error) { for (const id of branch) rejected.set(id, String(error.message).slice(0, 400)); }
    }
  }
  const omittedSkills = selected.filter(item => !retained.has(item.name)).map(item => ({
    id: item.name, reasonCode: "optional-incompatible",
    reason: rejected.get(item.name) || "所属可选辅助分支未保留；不改变主 Skill 与必需依赖。",
  }));
  const changed = chosen.id !== originalAgentId;
  return { ...plan,
    agent: { ...plan.agent, agentId: chosen.id, label: chosen.label || chosen.id,
      ...(changed ? { status: chosen.isDefault ? "orchestrator" : "automatic",
        reason: "保留明确选择的主 Skill 与必需依赖，改由已获授权的 Agent 负责。" } : {}) },
    skills: selected.filter(item => retained.has(item.name)),
    coordinationTrace: { originalAgentId, selectedAgentId: chosen.id, agentChanged: changed,
      requiredSkillIds: [...required], retainedSkillIds: [...retained], omittedSkills },
  };
}

function authorizeV2CapabilityPlan(plan, governance, options = {}) {
  if (!governance) return plan;
  if (!plan || typeof plan !== "object") throw new TypeError("能力计划无效");
  if (options.internalWorkflow === true) {
    return {
      ...plan,
      v2RouteTrace: {
        schemaVersion: "2.0",
        routeClass: "background-workflow",
        governanceStatus: governance.format === "canonical-yaml" ? "existing-workflow-runtime" : "workflow-policy-gated",
        policyEnforcement: "existing-runtime-gates",
      },
    };
  }
  const legacyAgentId = String(plan.agent?.agentId || "").trim();
  const agentResolution = resolveLegacyOrCanonical(governance, legacyAgentId, "agent");
  const agentConfig = governance.configs.agent.get(agentResolution.canonicalId);
  if (!agentConfig || agentConfig.enabled === false) throw new Error(`v2 Responsible Agent 不可用：${agentResolution.canonicalId}`);
  const selected = Array.isArray(plan.skills) ? plan.skills : [];
  // 新版注册表之外、已由现有目录启用的任务扩展沿用旧运行时规则，不伪造正式 ID。
  const registeredExtensions = new Set((Array.isArray(options.registeredExtensions) ? options.registeredExtensions : [])
    .filter(entry => entry?.source === "extension" && entry.protected === false && entry.enabled === true
      && entry.skillType === "task" && !governance.aliases.has(entry.name)).map(entry => entry.name));
  const primary = selected.filter((item) => item?.outputRole === "primary");
  if (primary.length > agentConfig.runtime.maxPrimarySkills) throw new Error("v2 路由出现多个 Primary Skill");
  const resolutions = selected.map(item => registeredExtensions.has(String(item?.name || "").trim())
    ? { canonicalId: null, kind: "legacy-extension" }
    : resolveLegacyOrCanonical(governance, String(item?.name || "").trim()));
  const auxiliary = selected.filter((item, index) => item?.outputRole !== "primary" && resolutions[index].kind !== "cognitive-lens");
  if (auxiliary.length > agentConfig.runtime.maxAuxiliarySkills) throw new Error("v2 路由辅助 Skill 数量超限");
  const resolvedSkills = [];
  let lensCount = 0;
  for (const [index, item] of selected.entries()) {
    const requestedId = String(item?.name || "").trim();
    const resolved = resolutions[index];
    if (resolved.kind !== "legacy-extension") assertCanonicalInvocation(item, agentResolution.canonicalId, governance);
    if (resolved.kind === "skill") {
      if (!agentConfig.allowedSkillIds.includes(resolved.canonicalId)) {
        throw new Error(`${agentResolution.canonicalId} 无权调用 ${resolved.canonicalId}`);
      }
    } else if (resolved.kind === "cognitive-lens") {
      lensCount += 1;
      if (!agentConfig.allowedLensIds.includes(resolved.canonicalId)) {
        throw new Error(`${agentResolution.canonicalId} 无权调用 ${resolved.canonicalId}`);
      }
      if (item?.outputRole === "primary") throw new Error("Cognitive Lens 不能成为 Primary Skill");
    } else if (resolved.kind !== "legacy-extension") {
      throw new Error(`前台能力计划不能直接调用 ${resolved.kind}：${requestedId}`);
    }
    resolvedSkills.push({
      requestedId,
      canonicalId: resolved.canonicalId,
      kind: resolved.kind,
      role: item?.outputRole || "auxiliary",
    });
  }
  if (lensCount > agentConfig.runtime.maxLenses) throw new Error("v2 路由认知透镜数量超限");
  return {
    ...plan,
    agent: { ...plan.agent, canonicalAgentId: agentResolution.canonicalId },
    skills: selected.map((item, index) => ({ ...item, canonicalCapabilityId: resolvedSkills[index].canonicalId })),
    v2RouteTrace: {
      schemaVersion: "2.0",
      routeClass: "foreground",
      responsibleAgent: agentResolution.canonicalId,
      primarySkill: resolvedSkills.find((item) => item.role === "primary")?.canonicalId || null,
      auxiliarySkills: resolvedSkills.filter((item) => item.kind === "skill" && item.role !== "primary").map((item) => item.canonicalId),
      lenses: resolvedSkills.filter((item) => item.kind === "cognitive-lens").map((item) => item.canonicalId),
      permissionSource: governance.format === "canonical-yaml" ? "entity-config+policy-registry" : "entity-config+policy-map",
      promptMayExpandPermissions: false,
      legacyExtensionIds: resolvedSkills.filter(item => item.kind === "legacy-extension").map(item => item.requestedId),
      governanceStatus: resolvedSkills.some(item => item.kind === "legacy-extension") ? "registered-core+legacy-extensions" : "enforced",
      policyEnforcement: "capability-routing-only",
    },
  };
}

module.exports = {
  REGISTRY_FILES,
  V2_REGISTRY_ROOT,
  V2_ROOT,
  authorizeV2CapabilityPlan,
  coordinateV2CapabilityPlan,
  loadV2CapabilityGovernance,
  resolveLegacyOrCanonical,
};