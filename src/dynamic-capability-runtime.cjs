"use strict";
const {
  isPrimarySkillEligible,
  isExplicitOrchestrationRequest,
  isSkillVisibleInDialogue,
  isTextTransformation,
  normalizedSkillType,
  skillTypePolicy,
} = require("./capability-surface.cjs");

const MAX_PRIMARY_SKILLS = 1;
const MAX_AUXILIARY_SKILLS = 3;
const DEFAULT_MAX_SKILLS = MAX_PRIMARY_SKILLS + MAX_AUXILIARY_SKILLS;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CONTEXT_BUDGET = 64 * 1024;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u;

function boundedString(value, maximum = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function capabilityId(item, kind = "Skill") {
  const id = boundedString(item?.name || item?.id, 128);
  if (!id) throw new Error(`${kind} 缺少编号`);
  return id;
}

function parseVersion(value, label = "能力版本") {
  const text = boundedString(value, 64);
  const match = VERSION_PATTERN.exec(text);
  if (!match) throw new Error(`${label}格式无效：${text || "未提供"}`);
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseVersion(left);
  const b = Array.isArray(right) ? right : parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function satisfiesVersion(version, rawConstraint) {
  const constraint = boundedString(rawConstraint, 128);
  if (!constraint || constraint === "*") return true;
  const clauses = constraint.split(/\s+/u).filter(Boolean);
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(clause);
    if (!match) throw new Error(`依赖版本约束无效：${constraint}`);
    const operator = match[1] || "=";
    const actual = parseVersion(version);
    const expected = parseVersion(match[2], "依赖版本");
    const compared = compareVersions(actual, expected);
    if (operator === ">=") return compared >= 0;
    if (operator === "<=") return compared <= 0;
    if (operator === ">") return compared > 0;
    if (operator === "<") return compared < 0;
    if (operator === "^") return actual[0] === expected[0] && compared >= 0;
    if (operator === "~") return actual[0] === expected[0] && actual[1] === expected[1] && compared >= 0;
    return compared === 0;
  });
}

function normalizeDependency(value, label = "依赖") {
  if (typeof value === "string") return { id: value.trim(), requiresVersion: "*" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  const allowed = new Set(["id", "requiresVersion", "whenIntents"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label}包含不允许的字段：${extra.join("、")}`);
  const id = boundedString(value.id, 128);
  if (!id) throw new Error(`${label}缺少编号`);
  const whenIntents = value.whenIntents === undefined
    ? []
    : (Array.isArray(value.whenIntents)
      ? value.whenIntents.map((item) => boundedString(item, 300)).filter(Boolean).slice(0, 16)
      : (() => { throw new Error(`${label}条件格式无效`); })());
  return {
    id,
    requiresVersion: boundedString(value.requiresVersion, 128) || "*",
    ...(whenIntents.length ? { whenIntents } : {}),
  };
}

function normalizedDependencies(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label}格式无效`);
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const dependency = normalizeDependency(raw, label);
    if (!dependency.id || seen.has(dependency.id)) continue;
    seen.add(dependency.id);
    result.push(dependency);
  }
  return result;
}

function optionalDependencyMatches(dependency, instructionText) {
  if (!Array.isArray(dependency.whenIntents) || !dependency.whenIntents.length) return false;
  const input = boundedString(instructionText, 12_000).toLocaleLowerCase("zh-CN");
  return dependency.whenIntents.some((intent) => input.includes(intent.toLocaleLowerCase("zh-CN")));
}

function requiredReadScopes(skills) {
  const scoped = skills
    .map((skill) => skillTypePolicy(skill).contributesReadScopes && Array.isArray(skill.readScopes)
      ? [...new Set(skill.readScopes.filter(Boolean))]
      : [])
    .filter((items) => items.length);
  if (!scoped.length) return [];
  return [...new Set(scoped.flat())];
}

function resolveSkillGraph({
  authorizedReadScopes,
  primarySkillId = null,
  requestedSkillIds = [],
  skills = [],
  instructionText = "",
  maxDepth = DEFAULT_MAX_DEPTH,
  maxSkills = DEFAULT_MAX_SKILLS,
  maxContextBytes = DEFAULT_CONTEXT_BUDGET,
  deliverable = "direct-answer",
  allowWorkflow = false,
} = {}) {
  if (authorizedReadScopes !== undefined && (!Array.isArray(authorizedReadScopes)
    || authorizedReadScopes.some(scope => typeof scope !== "string"))) throw new Error("授权读取范围必须是数组");
  const skillMap = new Map();
  for (const item of Array.isArray(skills) ? skills : []) {
    const id = capabilityId(item);
    if (skillMap.has(id)) throw new Error(`Skill 编号重复：${id}`);
    skillMap.set(id, item);
  }
  const requestedRoots = [];
  for (const raw of Array.isArray(requestedSkillIds) ? requestedSkillIds : []) {
    const id = boundedString(raw, 128);
    const item = skillMap.get(id);
    if (!id || requestedRoots.includes(id)) continue;
    if (item && !allowWorkflow && !isSkillVisibleInDialogue(item)) continue;
    requestedRoots.push(id);
  }
  const requestedTaskExists = requestedRoots.some((id) => normalizedSkillType(skillMap.get(id)) === "task");
  const requestedPrimaryId = boundedString(primarySkillId, 128);
  const requestedPrimary = requestedPrimaryId ? skillMap.get(requestedPrimaryId) : null;
  if (requestedPrimaryId && !requestedPrimary) throw new Error(`缺少必需 Skill：${requestedPrimaryId}`);
  const explicitOrchestration = isExplicitOrchestrationRequest(instructionText);
  const effectivePrimarySkillId = requestedPrimary
    && (allowWorkflow || isSkillVisibleInDialogue(requestedPrimary))
    && isPrimarySkillEligible(requestedPrimary, {
      deliverable,
      hasTaskSkill: requestedTaskExists,
      explicitOrchestration,
    })
    ? requestedPrimaryId
    : null;
  const roots = [...requestedRoots];
  if (effectivePrimarySkillId && !roots.includes(effectivePrimarySkillId)) roots.push(effectivePrimarySkillId);
  if (!roots.length) {
    return {
      primarySkillId: null,
      orderedSkillIds: [],
      edges: [],
      loadingReasons: [],
      requiredReadScopes: [],
      effectiveReadScopes: [],
      allowedToolIds: [],
      totalContextBytes: 0,
      permissionBoundary: {
        canElevateKnowledgeWrite: false,
        canElevateExternalTransfer: false,
        canElevateCodexExecution: false,
      },
    };
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error("依赖深度上限无效");
  if (!Number.isSafeInteger(maxSkills) || maxSkills < 1 || maxSkills > 16) throw new Error("Skill 数量上限无效");
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1) throw new Error("Skill 上下文预算无效");

  const visiting = new Set();
  const visited = new Set();
  const order = [];
  const edges = [];
  const loadingReasons = [];
  let totalContextBytes = 0;

  const visit = (id, depth, parentId = null, reason = "主能力") => {
    const item = skillMap.get(id);
    if (!item) throw new Error(`缺少必需 Skill：${id}`);
    if (item.enabled === false) throw new Error(`Skill 已停用，不能被依赖绕过：${id}`);
    if (!allowWorkflow && !isSkillVisibleInDialogue(item)) {
      throw new Error(`后台 workflow 不能进入普通对话：${id}`);
    }
    if (depth > maxDepth) throw new Error(`Skill 依赖深度超过上限：${id}`);
    if (visiting.has(id)) throw new Error(`Skill 依赖存在循环：${[...visiting, id].join(" → ")}`);
    if (visited.has(id)) {
      if (parentId && !edges.some((edge) => edge.from === parentId && edge.to === id)) {
        edges.push({ from: parentId, to: id, type: reason });
      }
      return;
    }
    visiting.add(id);
    const required = normalizedDependencies(item.requires, `Skill ${id} 的必需依赖`);
    const optional = normalizedDependencies(item.optionalDependencies, `Skill ${id} 的可选依赖`)
      .filter((dependency) => optionalDependencyMatches(dependency, instructionText));
    const declaredDepth = Number.isSafeInteger(item.maxDependencyDepth)
      ? item.maxDependencyDepth : maxDepth;
    if ((required.length || optional.length) && depth >= Math.min(maxDepth, declaredDepth)) {
      throw new Error(`Skill ${id} 的依赖深度超过声明上限`);
    }
    for (const dependency of [...required, ...optional]) {
      const dependencySkill = skillMap.get(dependency.id);
      if (!dependencySkill) throw new Error(`Skill ${id} 缺少依赖：${dependency.id}`);
      if (!satisfiesVersion(dependencySkill.version || "1.0.0", dependency.requiresVersion)) {
        throw new Error(`Skill ${id} 的依赖版本不兼容：${dependency.id} ${dependency.requiresVersion}`);
      }
      if (Array.isArray(item.conflicts) && item.conflicts.includes(dependency.id)) {
        throw new Error(`Skill ${id} 与依赖 ${dependency.id} 存在冲突`);
      }
      edges.push({
        from: id,
        to: dependency.id,
        type: optional.includes(dependency) ? "optional" : "required",
        reason: optional.includes(dependency) ? "本轮意图满足可选依赖条件" : "能力包声明必需依赖",
      });
      visit(dependency.id, depth + 1, id, optional.includes(dependency) ? "optional" : "required");
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
    totalContextBytes += Number.isSafeInteger(item.instructionBytes) && item.instructionBytes >= 0
      ? item.instructionBytes : 0;
    loadingReasons.push({ id, parentId, reason });
    if (order.length > maxSkills) {
      const limitError = new Error(`本轮 Skill 数量超过上限 ${maxSkills}`);
      limitError.xzCapacityLimit = "count";
      throw limitError;
    }
    if (totalContextBytes > maxContextBytes) {
      const limitError = new Error(`本轮 Skill 上下文超过预算 ${maxContextBytes} 字节`);
      limitError.xzCapacityLimit = "context";
      throw limitError;
    }
  };

  // 主 Skill 优先装载：roots 里 primary 是最后追加的，若不提前会被辅助 Skill 挤掉
  const visitOrder = effectivePrimarySkillId
    ? [effectivePrimarySkillId, ...roots.filter((id) => id !== effectivePrimarySkillId)]
    : [...roots];
  const degradedSkillIds = [];
  for (const id of visitOrder) {
    const snapshot = {
      order: order.length,
      edges: edges.length,
      reasons: loadingReasons.length,
      bytes: totalContextBytes,
      visited: new Set(visited),
    };
    try {
      visit(id, 0, null, id === effectivePrimarySkillId ? "primary" : "requested");
    } catch (error) {
      if (!error || !error.xzCapacityLimit) throw error;
      // 本轮预算装不下这个根及其依赖：整根回滚，保留已装载能力，不让整轮对话失败
      order.length = snapshot.order;
      edges.length = snapshot.edges;
      loadingReasons.length = snapshot.reasons;
      totalContextBytes = snapshot.bytes;
      visited.clear();
      for (const keptId of snapshot.visited) visited.add(keptId);
      visiting.clear();
      degradedSkillIds.push({ id, limit: error.xzCapacityLimit });
      if (order.length >= maxSkills) break;
    }
  }
  for (let leftIndex = 0; leftIndex < order.length; leftIndex += 1) {
    const left = skillMap.get(order[leftIndex]);
    const leftConflicts = new Set(Array.isArray(left.conflicts) ? left.conflicts : []);
    for (let rightIndex = leftIndex + 1; rightIndex < order.length; rightIndex += 1) {
      const right = skillMap.get(order[rightIndex]);
      const rightConflicts = new Set(Array.isArray(right.conflicts) ? right.conflicts : []);
      if (leftConflicts.has(order[rightIndex]) || rightConflicts.has(order[leftIndex])) {
        throw new Error(`Skill 冲突：${order[leftIndex]} 与 ${order[rightIndex]}`);
      }
    }
  }
  const loadedSkills = order.map((id) => skillMap.get(id));
  const allowedToolIds = [...new Set(loadedSkills.flatMap((skill) => (
    skillTypePolicy(skill).canRequestTools && Array.isArray(skill.toolRequests) ? skill.toolRequests : []
  )).filter((id) => typeof id === "string" && id))];
  return {
    primarySkillId: order.includes(effectivePrimarySkillId) ? effectivePrimarySkillId : null,
    orderedSkillIds: order,
    degradedSkillIds,
    edges,
    loadingReasons,
    requiredReadScopes: requiredReadScopes(loadedSkills),
    effectiveReadScopes: requiredReadScopes(loadedSkills).filter(scope => (
      authorizedReadScopes === undefined || authorizedReadScopes.includes(scope)
    )),
    allowedToolIds,
    totalContextBytes,
    permissionBoundary: {
      canElevateKnowledgeWrite: false,
      canElevateExternalTransfer: false,
      canElevateCodexExecution: false,
    },
  };
}

function searchableTerms(item) {
  return [
    ...(Array.isArray(item?.intents) ? item.intents : []),
    ...(Array.isArray(item?.capabilities) ? item.capabilities : []),
    ...(Array.isArray(item?.tags) ? item.tags : []),
    item?.label,
  ].map((term) => boundedString(term, 300)).filter((term) => term.length >= 2);
}

function scoreCapability(input, item) {
  const text = input.toLocaleLowerCase("zh-CN");
  let score = 0;
  const matched = [];
  const explicitInvocation = ("$" + capabilityId(item)).toLocaleLowerCase("zh-CN");
  const explicit = text.split(explicitInvocation).slice(1)
    .some((suffix) => !/^[a-z0-9_-]/iu.test(suffix));
  if (explicit) {
    score += 100;
    matched.push(explicitInvocation);
  }
  for (const [index, term] of searchableTerms(item).entries()) {
    const normalized = term.toLocaleLowerCase("zh-CN");
    if (!text.includes(normalized)) continue;
    score += index < (Array.isArray(item.intents) ? item.intents.length : 0) ? 12 : 5;
    matched.push(term);
  }
  return { score, matched: matched.slice(0, 4), explicit };
}

function routeDynamicCapabilities({ instructionText, agents = [], skills = [], defaultAgentId } = {}) {
  const input = isTextTransformation(instructionText) ? "" : boundedString(instructionText, 12_000);
  const enabledAgents = (Array.isArray(agents) ? agents : []).filter((item) => item?.enabled !== false && item.internal !== true);
  const enabledSkills = (Array.isArray(skills) ? skills : []).filter((item) => (
    item?.enabled !== false && isSkillVisibleInDialogue(item)
  ));
  const agentCandidates = enabledAgents.map((item) => ({
    id: capabilityId(item, "Agent"),
    ...scoreCapability(input, item),
  })).sort((a, b) => Number(b.explicit) - Number(a.explicit)
    || b.score - a.score || a.id.localeCompare(b.id));
  const skillCandidates = enabledSkills.map((item) => ({
    id: capabilityId(item),
    ...scoreCapability(input, item),
  })).sort((a, b) => Number(b.explicit) - Number(a.explicit)
    || b.score - a.score || a.id.localeCompare(b.id));
  const fallbackAgent = enabledAgents.find((item) => item.isDefault)?.id
    || enabledAgents.find((item) => item.id === defaultAgentId)?.id
    || enabledAgents[0]?.id
    || defaultAgentId
    || "xingzhi-orchestrator";
  const selectedAgent = agentCandidates[0]?.score >= 12 ? agentCandidates[0].id : fallbackAgent;
  const selectedSkill = skillCandidates[0]?.score >= 10 ? skillCandidates[0].id : null;
  return {
    source: "dynamic-local",
    agentId: selectedAgent,
    skillIds: selectedSkill ? [selectedSkill] : [],
    candidates: skillCandidates.slice(0, 8),
    rejected: skillCandidates.filter((item) => item.score < 10).slice(0, 8)
      .map((item) => ({ id: item.id, reason: "与本轮直接请求的语义匹配不足" })),
    confidence: selectedSkill ? Math.min(1, skillCandidates[0].score / 24) : 0.5,
    reason: selectedSkill
      ? `能力包自身的适用意图命中：${skillCandidates[0].matched.join("、")}`
      : "没有能力达到调用阈值，本轮使用零 Skill 后备。",
  };
}

module.exports = {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_SKILLS,
  MAX_AUXILIARY_SKILLS,
  MAX_PRIMARY_SKILLS,
  compareVersions,
  normalizeDependency,
  resolveSkillGraph,
  routeDynamicCapabilities,
  satisfiesVersion,
};
