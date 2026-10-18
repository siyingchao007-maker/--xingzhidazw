"use strict";

const path = require("node:path");

const SCHEMA_VERSION = "2.0";
const ENTITY_KINDS = Object.freeze(["agent", "skill", "cognitive-lens", "workflow", "automation", "tool"]);
const REGISTRY_COLLECTIONS = Object.freeze({
  agent: "agents",
  skill: "skills",
  "cognitive-lens": "lenses",
  workflow: "workflows",
  automation: "automations",
  tool: "tools",
});
const ID_PREFIXES = Object.freeze({
  agent: "xingzhi-agent-",
  skill: "xingzhi-skill-",
  "cognitive-lens": "xingzhi-lens-",
  workflow: "xingzhi-workflow-",
  automation: "xingzhi-automation-",
  tool: "xingzhi-tool-",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} 必须是对象`);
  return value;
}

function requireText(value, label, maxLength = 4000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是非空文本`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} 超出长度限制`);
  return normalized;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`);
  const max = Number.isInteger(options.max) ? options.max : 128;
  if (value.length > max) throw new Error(`${label} 数量超出限制`);
  const normalized = value.map((item, index) => requireText(item, `${label}[${index}]`, 300));
  if (options.forbidWildcard && normalized.includes("*")) throw new Error(`${label} 禁止使用通配符 *`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} 包含重复项`);
  return normalized;
}

function requireVersion(value, label = "version") {
  const normalized = requireText(value, label, 64);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`${label} 必须是语义化版本`);
  }
  return normalized;
}

function requireEntityId(value, kind, label = "id") {
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`未知实体类型：${kind}`);
  const normalized = requireText(value, label, 160);
  if (!normalized.startsWith(ID_PREFIXES[kind]) || !/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error(`${label} 必须使用 ${ID_PREFIXES[kind]} 前缀和小写连字符格式`);
  }
  return normalized;
}

function requireSafeRef(value, label, options = {}) {
  const normalized = requireText(value, label, 500).replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`${label} 必须是相对路径`);
  }
  const parts = normalized.split("/");
  const allowedParents = Number.isInteger(options.allowedParents) ? options.allowedParents : 0;
  const parentCount = parts.findIndex((part) => part !== "..");
  const effectiveParentCount = parentCount === -1 ? parts.length : parentCount;
  if (effectiveParentCount > allowedParents
    || parts.slice(effectiveParentCount).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} 包含不安全路径片段`);
  }
  return normalized;
}

function validateLegacy(value, canonicalId) {
  if (value === undefined) return { aliases: [] };
  const legacy = requireObject(value, "legacy");
  const aliases = requireStringArray(legacy.aliases || [], "legacy.aliases", { max: 32 });
  if (aliases.includes(canonicalId)) throw new Error("legacy.aliases 不能包含当前正式 ID");
  for (const alias of aliases) {
    if (!/^[a-z0-9-]+$/.test(alias)) throw new Error(`旧 ID 格式无效：${alias}`);
  }
  const result = { aliases };
  for (const key of ["configPath", "descriptionPath"]) {
    if (legacy[key] !== undefined) {
      result[key] = requireStringArray(legacy[key], `legacy.${key}`, { max: 16 })
        .map((item, index) => requireSafeRef(item, `legacy.${key}[${index}]`));
    }
  }
  return result;
}

function validateRuntime(value) {
  const runtime = requireObject(value, "runtime");
  const integer = (key, min, max) => {
    const current = runtime[key];
    if (!Number.isInteger(current) || current < min || current > max) {
      throw new Error(`runtime.${key} 必须在 ${min} 到 ${max} 之间`);
    }
    return current;
  };
  const normalized = {
    maxPrimarySkills: runtime.maxPrimarySkills === undefined ? 1 : integer("maxPrimarySkills", 1, 1),
    maxAuxiliarySkills: integer("maxAuxiliarySkills", 0, 3),
    maxLenses: integer("maxLenses", 0, 3),
    maxDependencyDepth: integer("maxDependencyDepth", 0, 2),
    defaultLensCount: runtime.defaultLensCount === undefined ? 0 : integer("defaultLensCount", 0, 3),
  };
  if (normalized.defaultLensCount > normalized.maxLenses) {
    throw new Error("runtime.defaultLensCount 不能大于 runtime.maxLenses");
  }
  return normalized;
}

function validateAgentConfig(value) {
  const config = requireObject(value, "Agent 配置");
  if (config.schemaVersion !== SCHEMA_VERSION) throw new Error(`Agent schemaVersion 必须是 ${SCHEMA_VERSION}`);
  if (config.kind !== "agent") throw new Error("Agent kind 必须是 agent");
  const id = requireEntityId(config.id, "agent");
  const allowedAgentIds = requireStringArray(config.allowedAgentIds || [], "allowedAgentIds", { forbidWildcard: true });
  const allowedSkillIds = requireStringArray(config.allowedSkillIds || [], "allowedSkillIds", { forbidWildcard: true });
  const allowedLensIds = requireStringArray(config.allowedLensIds || [], "allowedLensIds", { forbidWildcard: true });
  const allowedWorkflowIds = requireStringArray(config.allowedWorkflowIds || [], "allowedWorkflowIds", { forbidWildcard: true });
  allowedAgentIds.forEach((item) => requireEntityId(item, "agent", "allowedAgentIds 项"));
  allowedSkillIds.forEach((item) => requireEntityId(item, "skill", "allowedSkillIds 项"));
  allowedLensIds.forEach((item) => requireEntityId(item, "cognitive-lens", "allowedLensIds 项"));
  allowedWorkflowIds.forEach((item) => requireEntityId(item, "workflow", "allowedWorkflowIds 项"));
  const writeMode = requireText(config.writeMode, "writeMode", 40);
  if (!['none', 'request-only'].includes(writeMode)) throw new Error("Agent writeMode 只允许 none 或 request-only");
  const memory = config.memory === undefined ? {} : requireObject(config.memory, "memory");
  if (memory.mayWriteFormalKnowledge === true) throw new Error("Agent 不得直接写入正式知识");
  const routing = requireObject(config.routing, "routing");
  const runtime = validateRuntime(config.runtime);
  return {
    ...config,
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "agent",
    label: requireText(config.label, "label", 120),
    version: requireVersion(config.version),
    enabled: requireBoolean(config.enabled, "enabled"),
    legacy: validateLegacy(config.legacy, id),
    role: requireText(config.role, "role", 4000),
    responsibility: requireStringArray(config.responsibility, "responsibility", { max: 32 }),
    intents: requireStringArray(config.intents, "intents", { max: 64 }),
    capabilities: requireStringArray(config.capabilities, "capabilities", { max: 64 }),
    allowedAgentIds,
    allowedSkillIds,
    allowedLensIds,
    allowedWorkflowIds,
    readScopes: requireStringArray(config.readScopes || [], "readScopes", { max: 32, forbidWildcard: true }),
    readPolicy: requireText(config.readPolicy, "readPolicy", 80),
    writeMode,
    riskLevel: requireText(config.riskLevel, "riskLevel", 80),
    routing,
    runtime,
    memory,
    promptRef: requireSafeRef(config.promptRef, "promptRef"),
  };
}

function validateRegistry(value, kind) {
  const registry = requireObject(value, `${kind} Registry`);
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`未知 Registry 类型：${kind}`);
  if (registry.schemaVersion !== SCHEMA_VERSION) throw new Error(`${kind} Registry schemaVersion 必须是 ${SCHEMA_VERSION}`);
  const collection = REGISTRY_COLLECTIONS[kind];
  if (!Array.isArray(registry[collection])) throw new Error(`${kind} Registry 缺少 ${collection} 数组`);
  const ids = new Set();
  const entries = registry[collection].map((entry, index) => {
    requireObject(entry, `${collection}[${index}]`);
    const id = requireEntityId(entry.id, kind, `${collection}[${index}].id`);
    if (ids.has(id)) throw new Error(`${kind} Registry 出现重复 ID：${id}`);
    ids.add(id);
    return {
      ...entry,
      id,
      label: requireText(entry.label, `${id}.label`, 120),
      version: requireVersion(entry.version, `${id}.version`),
      enabled: requireBoolean(entry.enabled, `${id}.enabled`),
      configRef: requireSafeRef(entry.configRef, `${id}.configRef`, { allowedParents: 1 }),
      deprecatedAliases: requireStringArray(entry.deprecatedAliases || [], `${id}.deprecatedAliases`, { max: 32 }),
    };
  });
  return { ...registry, schemaVersion: SCHEMA_VERSION, [collection]: entries };
}

function buildAliasIndex(registries) {
  if (!Array.isArray(registries)) throw new TypeError("registries 必须是数组");
  const index = new Map();
  for (const descriptor of registries) {
    const { kind, registry } = descriptor;
    const validated = validateRegistry(registry, kind);
    const collection = REGISTRY_COLLECTIONS[kind];
    for (const entry of validated[collection]) {
      if (index.has(entry.id)) throw new Error(`正式 ID 或旧 ID 冲突：${entry.id}`);
      index.set(entry.id, Object.freeze({ canonicalId: entry.id, kind, deprecated: false }));
      for (const alias of entry.deprecatedAliases) {
        if (index.has(alias)) throw new Error(`正式 ID 或旧 ID 冲突：${alias}`);
        index.set(alias, Object.freeze({ canonicalId: entry.id, kind, deprecated: true }));
      }
    }
  }
  return index;
}

function resolveCapabilityId(aliasIndex, requestedId, expectedKind) {
  if (!(aliasIndex instanceof Map)) throw new TypeError("aliasIndex 必须是 Map");
  const id = requireText(requestedId, "requestedId", 160);
  const resolved = aliasIndex.get(id);
  if (!resolved) throw new Error(`未知能力 ID：${id}`);
  if (expectedKind && resolved.kind !== expectedKind) {
    throw new Error(`能力类型不匹配：${id} 实际为 ${resolved.kind}`);
  }
  return { requestedId: id, ...resolved };
}

function authorizeCapabilityRequest(agent, request) {
  const config = validateAgentConfig(agent);
  requireObject(request, "能力调用请求");
  const requested = {
    agentIds: requireStringArray(request.agentIds || [], "request.agentIds", { forbidWildcard: true }),
    skillIds: requireStringArray(request.skillIds || [], "request.skillIds", { forbidWildcard: true }),
    lensIds: requireStringArray(request.lensIds || [], "request.lensIds", { forbidWildcard: true }),
    workflowIds: requireStringArray(request.workflowIds || [], "request.workflowIds", { forbidWildcard: true }),
  };
  const checks = [
    ["agentIds", config.allowedAgentIds],
    ["skillIds", config.allowedSkillIds],
    ["lensIds", config.allowedLensIds],
    ["workflowIds", config.allowedWorkflowIds],
  ];
  for (const [key, allowed] of checks) {
    for (const id of requested[key]) {
      if (!allowed.includes(id)) throw new Error(`${config.id} 无权调用 ${id}`);
    }
  }
  if (requested.skillIds.length > config.runtime.maxPrimarySkills + config.runtime.maxAuxiliarySkills) {
    throw new Error("请求的 Skill 数量超过 Agent 运行限制");
  }
  if (requested.lensIds.length > config.runtime.maxLenses) {
    throw new Error("请求的 Lens 数量超过 Agent 运行限制");
  }
  return Object.freeze({ authorized: true, agentId: config.id, ...requested });
}

module.exports = {
  ENTITY_KINDS,
  ID_PREFIXES,
  REGISTRY_COLLECTIONS,
  SCHEMA_VERSION,
  authorizeCapabilityRequest,
  buildAliasIndex,
  resolveCapabilityId,
  validateAgentConfig,
  validateRegistry,
};
