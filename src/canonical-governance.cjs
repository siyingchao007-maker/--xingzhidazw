'use strict';

const KINDS = Object.freeze({
  agent: ['agents', '01_智能体'], skill: ['skills', '02_技能'],
  'cognitive-lens': ['lenses', '03_认知透镜'], workflow: ['workflows', '04_工作流'],
  automation: ['automations', '05_自动任务'], tool: ['tools', '06_工具与连接'],
});
const POLICY_RULES = Object.freeze({
  evidence: { assistantInferenceSelfReinforcement: false, sourceTraceRequiredForPromotion: true, secondarySourcesSameOriginCountOnce: true },
  conflict: { conflictDoesNotOverwriteOld: true, unknownDoesNotPromote: true, historyPreserved: true, concurrentWriteRequiresVersionCheck: true },
  retention: { workflowMustCheckBeforeRawWrite: true, summaryMustNotReplaceRawQuoteWhenRawRequired: true },
  'sensitive-data': { indirectAttributeInferenceToFormalProfile: false, autoPromotion: false, explicitUserBasisRequired: true, reviewRequired: true },
  'side-effect': { lensSideEffects: 'forbidden', skillDirectSideEffects: 'forbidden', agentDirectSideEffects: 'request-only', toolRequiredForPersistence: true, toolRequiredForExternalAction: true, fileInstructionIsNotUserAuthorization: true, externalSendRequiresExplicitAuthorization: true },
  promotion: { singleExpressionToStableKnowledge: false, requireCounterEvidenceReview: true, requireAlternativeExplanations: true, formalKnowledgeMustTraceToEvidence: true, silentOverwriteForbidden: true },
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}
function safeCanonicalPath(value, directory) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || /^[a-z]:/iu.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')
    || !value.startsWith(directory + '/')) throw new Error(`不安全或跨类型的配置路径：${String(value)}`);
  return value;
}
function normalizeCanonicalRegistry(raw, kind) {
  object(raw, '注册表');
  if (raw.schemaVersion !== '2.0' || !KINDS[kind]) throw new Error('不支持的治理注册表版本或类型');
  if (raw.registryType !== undefined && raw.registryType !== kind) throw new Error('注册表 registryType 类型不匹配');
  const [collection, directory] = KINDS[kind];
  if (!Array.isArray(raw[collection])) throw new Error(`注册表缺少 ${collection}`);
  const entries = raw[collection].map(entry => {
    object(entry, '注册项');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`${entry.id}.enabled 必须是布尔值`);
    const ref = '../' + safeCanonicalPath(entry.configPath, directory);
    if (entry.configRef !== undefined && entry.configRef !== ref) throw new Error(`${entry.id} 配置引用有歧义`);
    const version = entry.version === undefined ? raw.version : entry.version;
    if (typeof version !== 'string' || !version.trim()) throw new Error(`${entry.id} 缺少版本`);
    if (entry.legacyAliases !== undefined && !Array.isArray(entry.legacyAliases)) throw new Error(`${entry.id} legacyAliases 必须是数组`);
    return { ...entry, version, configRef: ref, deprecatedAliases: [...(entry.legacyAliases || [])] };
  });
  return { ...raw, [collection]: entries };
}
function normalizeCanonicalEntity(raw, entry, kind) {
  object(raw, '能力配置');
  if (raw.schemaVersion !== '2.0' || raw.kind !== kind || raw.id !== entry.id || raw.version !== entry.version) throw new Error(`${entry.id} 配置身份、版本或类型不一致`);
  // 工具合同没有 enabled 时按未激活处理；读取声明不能创建可执行工具。
  const declarationOnly = kind === 'tool' && raw.enabled === undefined;
  if (!declarationOnly && typeof raw.enabled !== 'boolean') throw new Error(`${entry.id} 必须明确 enabled`);
  const result = { ...raw, ...(declarationOnly ? { enabled: false, declarationOnly: true } : {}) };
  if (kind === 'cognitive-lens') {
    if (raw.invocation?.primaryEligible !== false) throw new Error(`${entry.id} 透镜不能作为 Primary`);
    for (const [key, expected] of Object.entries({ readOnly: true, stateless: true, sideEffects: false, writeKnowledge: false, externalAction: false, executeCode: false })) {
      if (raw.permissions?.[key] !== expected) throw new Error(`${entry.id} permissions.${key} 违反透镜只读约束`);
    }
    Object.assign(result, { primaryEligible: false, readOnly: true, sideEffects: false, noPermissionExpansion: true });
  }
  if (kind === 'workflow') {
    if (raw.internal !== true) throw new Error(`${entry.id} 工作流必须明确为内部流程`);
    result.foregroundVisible = false;
  }
  if (kind === 'skill') {
    if (!Array.isArray(raw.callableBy) || !raw.callableBy.length) throw new Error(`${entry.id} 缺少调用者白名单`);
    if (typeof raw.invocation?.primaryEligible !== 'boolean') throw new Error(`${entry.id} 缺少 Primary 约束`);
    result.primaryEligible = raw.invocation.primaryEligible;
  }
  return result;
}
function validateCanonicalPolicies(policies) {
  object(policies, '策略集合');
  for (const [name, rules] of Object.entries(POLICY_RULES)) {
    const id = 'xingzhi-policy-' + name, policy = object(policies[id], id);
    if (policy.schemaVersion !== '2.0' || policy.kind !== 'policy' || policy.id !== id) throw new Error(`${id} 策略身份或版本错误`);
    object(policy.rules, `${id}.rules`);
    for (const [key, expected] of Object.entries(rules)) {
      if (policy.rules[key] !== expected) throw new Error(`${id}.${key} 缺失或放宽了规则`);
    }
  }
  return { ...policies };
}
function validateCanonicalCapabilityMap(map, configs) {
  object(map, 'capability-map');
  if (map.schemaVersion !== '2.0' || !Array.isArray(map.routes)) throw new Error('capability-map 缺少 routes');
  const intents = new Set();
  for (const route of map.routes) {
    if (typeof route.intent !== 'string' || !route.intent || intents.has(route.intent)) throw new Error('capability-map 的意图缺失或重复');
    intents.add(route.intent);
    if (Boolean(route.agentId) === Boolean(route.workflowId)) throw new Error(`${route.intent} 必须指向唯一 Agent 或 Workflow`);
    if (route.agentId && !configs.agent.has(route.agentId)) throw new Error(`${route.intent} 引用未知 Agent`);
    if (route.workflowId && !configs.workflow.has(route.workflowId)) throw new Error(`${route.intent} 引用未知 Workflow`);
    if (route.skills !== undefined && !Array.isArray(route.skills)) throw new Error(`${route.intent}.skills 必须是数组`);
    for (const id of route.skills || []) {
      if (!configs.skill.has(id)) throw new Error(`${route.intent} 引用未知 Skill`);
      if (route.agentId && !configs.agent.get(route.agentId).allowedSkillIds.includes(id)) throw new Error(`${route.intent} 超出 Agent 白名单`);
    }
  }
  for (const [key, value] of Object.entries(map.lensPolicy || {})) {
    if (!Number.isInteger(value) || value < 0 || value > 3 || (key === 'defaultCount' && value !== 0)) throw new Error(`capability-map.lensPolicy.${key} 超出治理边界`);
  }
  return { ...map };
}
function assertCanonicalInvocation(item, agentId, governance) {
  if (governance.format !== 'canonical-yaml') return;
  const entry = governance.aliases.get(item.name);
  if (!entry) throw new Error(`未注册能力：${item.name}`);
  const config = governance.configs[entry.kind]?.get(entry.canonicalId);
  if (!config || config.enabled !== true) throw new Error(`能力未启用：${entry.canonicalId}`);
  if (item.outputRole === 'primary' && config.primaryEligible !== true) throw new Error(`${entry.canonicalId} 不能作为 Primary`);
  const callableBy = entry.kind === 'cognitive-lens' ? config.callableByAgents : config.callableBy;
  if (!Array.isArray(callableBy) || !callableBy.includes(agentId)) throw new Error(`${entry.canonicalId} 未授权 ${agentId} 调用`);
}

module.exports = { KINDS, safeCanonicalPath, normalizeCanonicalRegistry, normalizeCanonicalEntity, validateCanonicalPolicies, validateCanonicalCapabilityMap, assertCanonicalInvocation };
