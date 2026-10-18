'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  MAX_CANDIDATE_PROMPT_BYTES,
  buildControlledSkillCandidates,
} = require('../src/controlled-skill-candidates.cjs');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_PATH = 'c'.repeat(64);

function governance({ legacyExtensions = [] } = {}) {
  return {
    aliases: new Map([
      ['agent-live', { canonicalId: 'agent-canonical', kind: 'agent', deprecated: true }],
      ['agent-canonical', { canonicalId: 'agent-canonical', kind: 'agent', deprecated: false }],
      ['task-a-old', { canonicalId: 'task-a', kind: 'skill', deprecated: true }],
      ['task-a', { canonicalId: 'task-a', kind: 'skill', deprecated: false }],
      ['lens-a', { canonicalId: 'lens-a', kind: 'cognitive-lens', deprecated: false }],
    ]),
    configs: {
      agent: new Map([['agent-canonical', {
        id: 'agent-canonical',
        enabled: true,
        allowedSkillIds: ['task-a'],
      }]]),
      skill: new Map([['task-a', {
        id: 'task-a',
        version: '2.1.0',
        enabled: true,
        primaryEligible: true,
        callableBy: ['agent-canonical'],
      }]]),
    },
    governanceStatus: {
      status: 'loaded',
      legacyExtensions,
    },
  };
}

function canonicalInput(overrides = {}) {
  const gov = governance();
  return {
    conversation: {
      skillMode: 'auto',
      disabledSkills: [],
      fixedCandidateIds: ['task-a-old'],
    },
    capabilityPlan: {
      agent: { agentId: 'agent-live' },
      governingSkills: [],
    },
    capabilityCatalog: {
      governanceStatus: gov.governanceStatus,
      v2Governance: gov,
      agents: [{ id: 'agent-live', enabled: true, allowedSkillIds: ['task-a-old'] }],
      skills: [{
        name: 'task-a-old',
        label: '事实核验',
        description: '核对证据、反证与未知。'.repeat(20),
        version: '2.1.0',
        enabled: true,
        skillType: 'task',
        primaryEligible: true,
        source: 'verified-release',
        contentHash: `sha256:${HASH_A}`,
      }],
    },
    availableSkills: [{
      name: 'task-a-old',
      label: '事实核验',
      version: '2.1.0',
      enabled: true,
      skillType: 'task',
      primaryEligible: true,
      instructionBytes: 4096,
      contentHash: `sha256:${HASH_A}`,
    }],
    contextHeadroomBytes: 32 * 1024,
    ...overrides,
  };
}

test('builds a frozen canonical candidate and a bounded Chinese prompt', () => {
  const result = buildControlledSkillCandidates(canonicalInput());

  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual({ ...result.candidates[0], description: undefined }, {
    id: 'task-a-old',
    name: 'task-a-old',
    label: '事实核验',
    version: '2.1.0',
    canonicalId: 'task-a',
    definitionHash: HASH_A,
    estimatedBytes: 4096,
    source: 'canonical-v2',
    fixedCandidate: true,
    governanceMode: 'canonical',
    budgetStatus: 'ready',
    description: undefined,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.match(result.prompt, /受控按需加载/u);
  assert.match(result.prompt, /task-a-old/u);
  assert.doesNotMatch(result.prompt, /path|catalogPath|SKILL\.md/iu);
  assert.ok(Buffer.byteLength(result.prompt, 'utf8') <= MAX_CANDIDATE_PROMPT_BYTES);
  assert.ok(Array.from(result.candidates[0].description).length <= 160);
});

test('does not read a Skill body or any path while building the catalog', () => {
  const input = canonicalInput();
  const forbidden = () => { throw new Error('candidate catalog touched protected content'); };
  for (const skill of [input.capabilityCatalog.skills[0], input.availableSkills[0]]) {
    Object.defineProperties(skill, {
      path: { enumerable: true, get: forbidden },
      catalogPath: { enumerable: true, get: forbidden },
      instructions: { enumerable: true, get: forbidden },
      body: { enumerable: true, get: forbidden },
    });
  }

  const result = buildControlledSkillCandidates(input);
  assert.equal(result.status, 'available');
  assert.equal(result.candidates.length, 1);
});

test('orders fixed candidates first without forcing a selection', () => {
  const input = canonicalInput();
  input.conversation.fixedCandidateIds = ['task-b'];
  input.capabilityCatalog.v2Governance.aliases.set('task-b', {
    canonicalId: 'task-b', kind: 'skill', deprecated: false,
  });
  input.capabilityCatalog.v2Governance.configs.skill.set('task-b', {
    id: 'task-b', version: '1.0.0', enabled: true, primaryEligible: true,
    callableBy: ['agent-canonical'],
  });
  input.capabilityCatalog.v2Governance.configs.agent.get('agent-canonical').allowedSkillIds.push('task-b');
  input.capabilityCatalog.skills.push({
    name: 'task-b', label: '优先方法', description: '优先候选', version: '1.0.0',
    enabled: true, skillType: 'task', primaryEligible: true, contentHash: `sha256:${HASH_B}`,
  });
  input.availableSkills.push({
    name: 'task-b', label: '优先方法', version: '1.0.0', enabled: true,
    skillType: 'task', primaryEligible: true, instructionBytes: 1024, contentHash: `sha256:${HASH_B}`,
  });

  const result = buildControlledSkillCandidates(input);
  assert.deepEqual(result.candidates.map((item) => item.id), ['task-b', 'task-a-old']);
  assert.match(result.prompt, /可以选择 0 个或 1 个/u);
});

test('returns candidates with a host-check marker when headroom is unknown', () => {
  const input = canonicalInput();
  delete input.contextHeadroomBytes;

  const result = buildControlledSkillCandidates(input);

  assert.equal(result.status, 'available-pending-context-check');
  assert.equal(result.candidates[0].budgetStatus, 'host-check-required');
  assert.match(result.prompt, /实际读取前再次校验上下文余量/u);
});

test('closes the catalog outside auto mode or when governance is not loaded', () => {
  const recommend = canonicalInput({ conversation: { skillMode: 'recommend' } });
  assert.deepEqual(buildControlledSkillCandidates(recommend), {
    candidates: [], prompt: '', status: 'closed', reason: '当前不是被动模式。',
  });

  const missingGovernance = canonicalInput();
  missingGovernance.capabilityCatalog.governanceStatus = { status: 'default-rules' };
  assert.deepEqual(buildControlledSkillCandidates(missingGovernance), {
    candidates: [], prompt: '', status: 'closed', reason: '治理规则未加载，使用默认规则。',
  });
});

test('closes when the turn already has a governing task', () => {
  const input = canonicalInput({
    capabilityPlan: {
      agent: { agentId: 'agent-live' },
      governingSkills: [{ name: 'already-selected', skillType: 'task', applicationMode: 'governing' }],
    },
  });
  assert.deepEqual(buildControlledSkillCandidates(input), {
    candidates: [], prompt: '', status: 'closed', reason: '本轮已有明确的能力调用。',
  });

  const fixedInvocation = canonicalInput();
  fixedInvocation.conversation.fixedInvocationIds = ['task-a-old'];
  assert.equal(buildControlledSkillCandidates(fixedInvocation).status, 'closed');

  const explicitLens = canonicalInput();
  explicitLens.capabilityPlan.governingSkills = [{
    name: 'lens-a', skillType: 'cognitive-lens', applicationMode: 'governing',
  }];
  assert.equal(buildControlledSkillCandidates(explicitLens).status, 'closed');
});

test('accepts governance Maps created in another VM realm', () => {
  const input = canonicalInput();
  const crossRealm = vm.runInNewContext(`new Map([
    ['agent-live', { canonicalId: 'agent-canonical', kind: 'agent' }],
    ['task-a-old', { canonicalId: 'task-a', kind: 'skill' }]
  ])`);
  input.capabilityCatalog.v2Governance.aliases = crossRealm;
  assert.equal(buildControlledSkillCandidates(input).status, 'available');
});

test('excludes disabled, internal, non-task, non-primary, training, dependencies and unknown-size skills', () => {
  const input = canonicalInput();
  const variants = [
    ['disabled', { enabled: false, skillType: 'task', primaryEligible: true, instructionBytes: 100 }],
    ['session-disabled', { enabled: true, skillType: 'task', primaryEligible: true, instructionBytes: 100 }],
    ['internal', { enabled: true, skillType: 'task', primaryEligible: true, surface: 'internal', instructionBytes: 100 }],
    ['lens', { enabled: true, skillType: 'cognitive-lens', primaryEligible: false, instructionBytes: 100 }],
    ['not-primary', { enabled: true, skillType: 'task', primaryEligible: false, instructionBytes: 100 }],
    ['xingzhi-training-response', { enabled: true, skillType: 'task', primaryEligible: true, instructionBytes: 100 }],
    ['dependency', { enabled: true, skillType: 'task', primaryEligible: true, instructionBytes: 100, requires: ['other'] }],
    ['unknown-size', { enabled: true, skillType: 'task', primaryEligible: true }],
  ];
  input.conversation.disabledSkills = ['session-disabled'];
  for (const [id, fields] of variants) {
    input.capabilityCatalog.skills.push({ name: id, label: id, version: '1.0.0', source: 'extension', protected: false, ...fields });
    input.availableSkills.push({ name: id, label: id, version: '1.0.0', source: 'extension', protected: false, ...fields });
    input.capabilityCatalog.governanceStatus.legacyExtensions.push({ id, label: id });
    input.capabilityCatalog.agents[0].allowedSkillIds.push(id);
  }

  const result = buildControlledSkillCandidates(input);
  assert.deepEqual(result.candidates.map((item) => item.id), ['task-a-old']);
});

test('excludes bodies above 24 KiB or larger than known context headroom', () => {
  const tooLarge = canonicalInput();
  tooLarge.availableSkills[0].instructionBytes = 24 * 1024 + 1;
  assert.equal(buildControlledSkillCandidates(tooLarge).status, 'empty');

  const noHeadroom = canonicalInput({ contextHeadroomBytes: 4095 });
  assert.equal(buildControlledSkillCandidates(noHeadroom).status, 'empty');
});

test('requires canonical alias, enabled config and reciprocal Agent authorization', () => {
  const cases = [
    (input) => input.capabilityCatalog.v2Governance.aliases.delete('task-a-old'),
    (input) => { input.capabilityCatalog.v2Governance.configs.skill.get('task-a').enabled = false; },
    (input) => { input.capabilityCatalog.v2Governance.configs.agent.get('agent-canonical').allowedSkillIds = []; },
    (input) => { input.capabilityCatalog.v2Governance.configs.skill.get('task-a').callableBy = ['other-agent']; },
  ];
  for (const mutate of cases) {
    const input = canonicalInput();
    mutate(input);
    assert.equal(buildControlledSkillCandidates(input).status, 'empty');
  }
});

test('does not confuse governance-config version with the locked Skill body version', () => {
  const input = canonicalInput();
  input.capabilityCatalog.v2Governance.configs.skill.get('task-a').version = '2.0.0-rc1';
  assert.equal(buildControlledSkillCandidates(input).status, 'available');

  input.availableSkills[0].version = '1.5.0';
  assert.equal(buildControlledSkillCandidates(input).status, 'empty');
});

test('normalizes a sha256 prefix and rejects an unknown definition hash', () => {
  const valid = buildControlledSkillCandidates(canonicalInput());
  assert.equal(valid.candidates[0].definitionHash, HASH_A);

  const invalid = canonicalInput();
  invalid.availableSkills[0].contentHash = 'sha256:not-a-real-hash';
  invalid.capabilityCatalog.skills[0].contentHash = 'sha256:not-a-real-hash';
  assert.equal(buildControlledSkillCandidates(invalid).status, 'empty');
});

test('admits legacy compatibility only when listed and allowed by the current legacy Agent', () => {
  const gov = governance({ legacyExtensions: [{ id: 'path-legacy', label: 'PATH' }] });
  const input = canonicalInput({
    conversation: { skillMode: 'auto', disabledSkills: [], fixedCandidateIds: ['path-legacy'] },
    capabilityCatalog: {
      governanceStatus: gov.governanceStatus,
      v2Governance: gov,
      agents: [{ id: 'agent-live', enabled: true, allowedSkillIds: ['path-legacy'] }],
      skills: [{
        name: 'path-legacy', label: 'PATH', version: '1.6.0', enabled: true,
        skillType: 'task', primaryEligible: true, source: 'extension', protected: false,
        description: '帮助梳理处境、判断、行动和反馈。', contentHash: `sha256:${HASH_PATH}`,
      }],
    },
    availableSkills: [{
      name: 'path-legacy', label: 'PATH', version: '1.6.0', enabled: true,
      skillType: 'task', primaryEligible: true, source: 'extension', protected: false,
      instructionBytes: 22067, contentHash: `sha256:${HASH_PATH}`,
    }],
  });

  const result = buildControlledSkillCandidates(input);
  assert.equal(result.candidates[0].source, 'legacy-compatibility');
  assert.equal(result.candidates[0].canonicalId, null);
  assert.match(result.prompt, /旧规则兼容/u);

  input.capabilityCatalog.agents[0].allowedSkillIds = [];
  assert.equal(buildControlledSkillCandidates(input).status, 'empty');
});

test('never exceeds the 8 KiB prompt budget and returns only displayed candidates', () => {
  const gov = governance({ legacyExtensions: [] });
  const input = canonicalInput({
    conversation: { skillMode: 'auto', disabledSkills: [], fixedCandidateIds: [] },
    capabilityCatalog: {
      governanceStatus: gov.governanceStatus,
      v2Governance: gov,
      agents: [{ id: 'agent-live', enabled: true, allowedSkillIds: ['*'] }],
      skills: [],
    },
    availableSkills: [],
  });
  for (let index = 0; index < 100; index += 1) {
    const id = `legacy-${String(index).padStart(3, '0')}`;
    input.capabilityCatalog.governanceStatus.legacyExtensions.push({ id, label: `方法${index}` });
    input.capabilityCatalog.skills.push({
      name: id, label: `方法${index}`, description: '适用说明'.repeat(80), version: '1.0.0',
      enabled: true, skillType: 'task', primaryEligible: true, source: 'extension', protected: false,
      contentHash: `sha256:${HASH_B}`,
    });
    input.availableSkills.push({
      name: id, label: `方法${index}`, version: '1.0.0', enabled: true, skillType: 'task',
      primaryEligible: true, source: 'extension', protected: false, instructionBytes: 100,
      contentHash: `sha256:${HASH_B}`,
    });
  }

  const result = buildControlledSkillCandidates(input);
  assert.ok(Buffer.byteLength(result.prompt, 'utf8') <= MAX_CANDIDATE_PROMPT_BYTES);
  assert.ok(result.candidates.length > 0 && result.candidates.length < 100);
  for (const item of result.candidates) assert.match(result.prompt, new RegExp(item.id, 'u'));
});
