'use strict';

const MAX_AUTOMATIC_SKILL_BYTES = 24 * 1024;
const MAX_CANDIDATE_PROMPT_BYTES = 8 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 160;
const TRAINING_RESPONSE_SKILL_ID = 'xingzhi-training-response';
const INTERNAL_SKILL_IDS = new Set([
  'xingzhi-interaction-event-extraction',
  'xingzhi-user-profile-evolution',
  'xingzhi-growth-path-synthesis',
  'xingzhi-conversation-organization',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function itemId(value) {
  if (typeof value?.name === 'string' && value.name.trim()) return value.name.trim();
  if (typeof value?.id === 'string' && value.id.trim()) return value.id.trim();
  return '';
}

function uniqueStrings(value) {
  const seen = new Set();
  const result = [];
  for (const raw of asArray(value)) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function truncateCharacters(value, limit) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  return Array.from(normalized).slice(0, limit).join('');
}

function mapGet(collection, key) {
  if (collection && typeof collection.get === 'function') return collection.get(key);
  if (collection && typeof collection === 'object') return collection[key];
  return undefined;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function terminalResult(status, reason) {
  return deepFreeze({ candidates: [], prompt: '', status, reason });
}

function isTask(skill) {
  return (skill?.skillType || skill?.compiledFrom?.skillType) === 'task';
}

function isPrimaryEligible(skill) {
  if (typeof skill?.primaryEligible === 'boolean') return skill.primaryEligible;
  if (typeof skill?.invocation?.primaryEligible === 'boolean') return skill.invocation.primaryEligible;
  return false;
}

function isForegroundTask(skill) {
  const id = itemId(skill);
  return Boolean(id)
    && !INTERNAL_SKILL_IDS.has(id)
    && id !== TRAINING_RESPONSE_SKILL_ID
    && isTask(skill)
    && isPrimaryEligible(skill)
    && skill?.internal !== true
    && skill?.surface !== 'internal'
    && skill?.foregroundVisible !== false
    && skill?.invocation !== 'workflow-only';
}

function requiredDependencies(skill) {
  return asArray(skill?.requires).filter((entry) => (
    (typeof entry === 'string' && entry.trim())
    || (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim())
  ));
}

function governingCapabilities(plan) {
  const explicit = [];
  if (plan?.primarySkill) explicit.push(plan.primarySkill);
  if (Array.isArray(plan?.governingSkills)) explicit.push(...plan.governingSkills);
  else for (const skill of asArray(plan?.skills)) {
    if (skill?.applicationMode !== 'advisory') explicit.push(skill);
  }
  return explicit.filter((item) => item && item.applicationMode !== 'advisory');
}

function resolveAgent(capabilityPlan, capabilityCatalog, governance) {
  const requestedId = String(
    capabilityPlan?.agent?.agentId
      || capabilityPlan?.agent?.canonicalAgentId
      || capabilityPlan?.agentId
      || '',
  ).trim();
  if (!requestedId) return null;
  const alias = mapGet(governance?.aliases, requestedId);
  const canonicalId = capabilityPlan?.agent?.canonicalAgentId
    || (alias?.kind === 'agent' ? alias.canonicalId : null);
  if (!canonicalId) return null;
  const governanceConfig = mapGet(governance?.configs?.agent, canonicalId);
  if (!governanceConfig || governanceConfig.enabled === false) return null;
  const legacyConfig = asArray(capabilityCatalog?.agents)
    .find((agent) => itemId(agent) === requestedId || itemId(agent) === canonicalId);
  return { requestedId, canonicalId, governanceConfig, legacyConfig };
}

function exactVersion(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedSha256(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^sha256:/iu, '').toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function lockedDefinitionIdentity(available, catalog) {
  const releases = [available?.release, catalog?.release].filter(Boolean);
  for (const release of releases) {
    if (release.degraded === true
      || !['active', 'active-pending-health', 'rolled-back'].includes(release.status)
      || release.resolvedFrom !== 'active'
      || !exactVersion(release.resolvedVersion)
      || !normalizedSha256(release.resolvedHash)) return null;
  }
  const versions = [available?.version, catalog?.version, ...releases.map((release) => release.resolvedVersion)]
    .map(exactVersion)
    .filter(Boolean);
  if (versions.length < 2 || new Set(versions).size !== 1) return null;

  const declaredHashes = [
    available?.contentHash,
    catalog?.contentHash,
    ...releases.map((release) => release.resolvedHash),
  ].filter((value) => value !== undefined && value !== null && value !== '');
  if (!declaredHashes.length) return null;
  const hashes = declaredHashes.map(normalizedSha256);
  if (hashes.some((hash) => !hash) || new Set(hashes).size !== 1) return null;
  return { version: versions[0], definitionHash: hashes[0] };
}

function descriptionFor(available, catalog) {
  const values = [
    catalog?.shortDescription,
    catalog?.description,
    catalog?.purpose,
    available?.shortDescription,
    available?.description,
    available?.purpose,
  ];
  const source = values.find((value) => typeof value === 'string' && value.trim())
    || catalog?.label || available?.label || itemId(catalog) || itemId(available);
  return truncateCharacters(source, MAX_DESCRIPTION_CHARACTERS);
}

function canonicalAuthorization({ id, governance, agent }) {
  const alias = mapGet(governance?.aliases, id);
  if (!alias || alias.kind !== 'skill' || !alias.canonicalId) return null;
  const config = mapGet(governance?.configs?.skill, alias.canonicalId);
  if (!config || config.enabled === false || config.primaryEligible !== true) return null;
  const allowed = uniqueStrings(agent.governanceConfig?.allowedSkillIds);
  if (!allowed.includes(alias.canonicalId)) return null;
  const callableBy = uniqueStrings(config.callableBy);
  if (!callableBy.includes(agent.canonicalId)) return null;
  return {
    canonicalId: alias.canonicalId,
    source: 'canonical-v2',
    governanceMode: 'canonical',
  };
}

function legacyAuthorization({ id, capabilityCatalog, agent }) {
  const listed = asArray(capabilityCatalog?.governanceStatus?.legacyExtensions)
    .some((entry) => (typeof entry === 'string' ? entry : entry?.id) === id);
  if (!listed || !agent.legacyConfig || agent.legacyConfig.enabled === false) return null;
  const allowed = uniqueStrings(agent.legacyConfig.allowedSkillIds);
  if (!allowed.includes('*') && !allowed.includes(id)) return null;
  return {
    canonicalId: null,
    source: 'legacy-compatibility',
    governanceMode: 'legacy-compatibility',
  };
}

function candidateFrom({
  catalogSkill,
  availableSkill,
  conversation,
  capabilityCatalog,
  governance,
  agent,
  contextHeadroomBytes,
  fixedIndex,
}) {
  const id = itemId(catalogSkill);
  if (!id || itemId(availableSkill) !== id) return null;
  if (catalogSkill.enabled === false || availableSkill.enabled === false) return null;
  if (uniqueStrings(conversation?.disabledSkills).includes(id)) return null;
  if (!isForegroundTask(catalogSkill) || !isForegroundTask(availableSkill)) return null;
  if (requiredDependencies(catalogSkill).length || requiredDependencies(availableSkill).length) return null;

  const estimatedBytes = Number.isSafeInteger(availableSkill.instructionBytes)
    ? availableSkill.instructionBytes
    : Number.isSafeInteger(catalogSkill.instructionBytes) ? catalogSkill.instructionBytes : null;
  if (!estimatedBytes || estimatedBytes > MAX_AUTOMATIC_SKILL_BYTES) return null;
  const headroomKnown = Number.isFinite(contextHeadroomBytes) && contextHeadroomBytes >= 0;
  if (headroomKnown && estimatedBytes > contextHeadroomBytes) return null;

  const identity = lockedDefinitionIdentity(availableSkill, catalogSkill);
  if (!identity) return null;
  const { version, definitionHash: lockedHash } = identity;

  const authorization = canonicalAuthorization({ id, governance, agent })
    || legacyAuthorization({ id, capabilityCatalog, agent });
  if (!authorization) return null;

  const label = truncateCharacters(
    catalogSkill.label || catalogSkill.displayName || availableSkill.label || availableSkill.displayName || id,
    120,
  );
  return {
    candidate: {
      id,
      name: id,
      label,
      version,
      canonicalId: authorization.canonicalId,
      definitionHash: lockedHash,
      estimatedBytes,
      source: authorization.source,
      fixedCandidate: fixedIndex.has(id),
      governanceMode: authorization.governanceMode,
      budgetStatus: headroomKnown ? 'ready' : 'host-check-required',
      description: descriptionFor(availableSkill, catalogSkill),
    },
    order: fixedIndex.has(id) ? fixedIndex.get(id) : Number.MAX_SAFE_INTEGER,
  };
}

function promptHeader(hasUnknownHeadroom) {
  return [
    '【行知受控按需加载】',
    '以下只是本轮获准的方法候选，不代表已经调用。你可以选择 0 个或 1 个主 Skill；普通问题可以直接回答。',
    '只有确有帮助时才调用 xingzhi_load_primary_skill，并仅提交 skillId 与不超过 240 字的简短任务适配原因。',
    '固定候选只提高展示顺序，不强制调用。Skill 是方法参考，不得借此扩展读取、联网、写入、执行或外发权限。',
    ...(hasUnknownHeadroom ? ['上下文余量当前未知；宿主必须在实际读取前再次校验上下文余量，校验不通过就不得读取正文。'] : []),
    '候选目录：',
  ].join('\n');
}

function promptLine(candidate) {
  const flags = [
    candidate.fixedCandidate ? '固定候选' : '普通候选',
    candidate.source === 'legacy-compatibility' ? '旧规则兼容' : 'v2治理',
    candidate.budgetStatus === 'host-check-required' ? '待读前预算校验' : '预算已初检',
  ].join('、');
  return `- ${candidate.id}｜${candidate.label}｜v${candidate.version}｜约${candidate.estimatedBytes}字节｜${flags}｜适用：${candidate.description}`;
}

function fitPrompt(candidates, hasUnknownHeadroom) {
  const header = promptHeader(hasUnknownHeadroom);
  const displayed = [];
  let prompt = header;
  for (const candidate of candidates) {
    const next = `${prompt}\n${promptLine(candidate)}`;
    if (Buffer.byteLength(next, 'utf8') > MAX_CANDIDATE_PROMPT_BYTES) break;
    displayed.push(candidate);
    prompt = next;
  }
  return { displayed, prompt: displayed.length ? prompt : '' };
}

function buildControlledSkillCandidates({
  conversation = {},
  capabilityPlan = {},
  capabilityCatalog = {},
  availableSkills = [],
  contextHeadroomBytes,
} = {}) {
  if (conversation?.skillMode !== 'auto') {
    return terminalResult('closed', '当前不是被动模式。');
  }
  if (capabilityCatalog?.governanceStatus?.status !== 'loaded') {
    return terminalResult('closed', '治理规则未加载，使用默认规则。');
  }
  const governance = capabilityCatalog?.v2Governance;
  if (!governance?.aliases || !governance?.configs) {
    return terminalResult('closed', '治理目录不可用，未开放自动加载。');
  }
  if (conversation?.trainingResponseModeActive === true
    || uniqueStrings(conversation?.fixedInvocationIds).length > 0
    || governingCapabilities(capabilityPlan).length > 0) {
    return terminalResult('closed', '本轮已有明确的能力调用。');
  }
  const agent = resolveAgent(capabilityPlan, capabilityCatalog, governance);
  if (!agent) return terminalResult('empty', '当前负责 Agent 没有可验证的治理身份。');

  const availableById = new Map();
  for (const skill of asArray(availableSkills)) {
    const id = itemId(skill);
    if (id && !availableById.has(id)) availableById.set(id, skill);
  }
  const fixedIds = uniqueStrings(conversation?.fixedCandidateIds);
  const fixedIndex = new Map(fixedIds.map((id, index) => [id, index]));
  const rows = [];
  for (const [catalogOrder, catalogSkill] of asArray(capabilityCatalog?.skills).entries()) {
    const id = itemId(catalogSkill);
    const availableSkill = availableById.get(id);
    if (!availableSkill) continue;
    const row = candidateFrom({
      catalogSkill,
      availableSkill,
      conversation,
      capabilityCatalog,
      governance,
      agent,
      contextHeadroomBytes,
      fixedIndex,
    });
    if (row) rows.push({ ...row, catalogOrder });
  }
  rows.sort((left, right) => left.order - right.order || left.catalogOrder - right.catalogOrder);
  const candidates = rows.map((row) => row.candidate);
  if (!candidates.length) return terminalResult('empty', '当前没有符合治理、授权、依赖与预算条件的主 Skill 候选。');

  const headroomKnown = Number.isFinite(contextHeadroomBytes) && contextHeadroomBytes >= 0;
  const { displayed, prompt } = fitPrompt(candidates, !headroomKnown);
  if (!displayed.length) return terminalResult('empty', '候选说明超过安全提示预算，未开放自动加载。');
  return deepFreeze({
    candidates: displayed,
    prompt,
    status: headroomKnown ? 'available' : 'available-pending-context-check',
    reason: null,
  });
}

module.exports = {
  MAX_AUTOMATIC_SKILL_BYTES,
  MAX_CANDIDATE_PROMPT_BYTES,
  buildControlledSkillCandidates,
};