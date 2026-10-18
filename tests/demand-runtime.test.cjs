'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLoader } = require('./runtime-loader.cjs');
const load = createLoader();
const { WorkbenchRuntime } = load('./workbench-runtime.cjs');
const { createDefaultControlledToolRegistry } = load('./controlled-tool-registry.cjs');
const { PRIMARY_SKILL_TOOL } = load('./demand-skill-runtime.cjs');
const id = 'test-method';
const body = '# Local method\nSYNTHETIC_BODY_ONLY_IN_TOOL_RESULT';
const hash = crypto.createHash('sha256').update(body).digest('hex');

function fixture(channel = 'provider-api') {
  const c = { id: 'conversation', skillMode: 'auto', skillPreferenceSchemaVersion: 2,
    controlledSkillLoading: true, fixedCandidateIds: [id], fixedInvocationIds: [], disabledSkills: [],
    providerId: channel === 'provider-api' ? 'synthetic-provider' : 'codex', engine: channel, messages: [
      { id: 'source', role: 'user', capabilityTrace: { skills: [] } },
      { id: 'answer', role: 'assistant', capabilityTrace: { skills: [] } },
    ] };
  const skill = { name: id, label: '合成方法', path: '10_智能体与技能/技能/test/SKILL.md',
    catalogPath: '10_智能体与技能/技能/test/SKILL.md', version: '1.0.0', contentHash: hash,
    instructionBytes: Buffer.byteLength(body), skillType: 'task', primaryEligible: true,
    instructionHash: hash,
    loadMode: 'on-demand', enabled: true, requires: [] };
  const agent = { id: 'legacy-agent', enabled: true, allowedSkillIds: [id] };
  const cfg = { id: 'canonical-agent', enabled: true, allowedSkillIds: ['canonical-method'] };
  const catalog = { governanceStatus: { status: 'loaded' }, agents: [agent], skills: [skill],
    v2Governance: { aliases: new Map([
      ['legacy-agent', { kind: 'agent', canonicalId: cfg.id }],
      [id, { kind: 'skill', canonicalId: 'canonical-method' }],
    ]), configs: { agent: new Map([[cfg.id, cfg]]), skill: new Map([['canonical-method', {
      id: 'canonical-method', enabled: true, version: '2.0.0', primaryEligible: true,
      callableBy: [cfg.id], requires: [],
    }]]) } } };
  const active = { telemetryTurnId: 'attempt', conversationId: c.id, sourceMessageId: 'source',
    assistantMessageId: 'answer', status: 'streaming', skillCalls: [],
    contextWindow: { modelContextWindow: 200000, inputTokens: 2000 } };
  const context = { conversationId: c.id, messageId: 'source', allowedToolIds: [], allowedReadRoots: ['01_当前的我'],
    toolAuditEvents: [], permissionMode: 'read-only', turnLane: 'foreground' };
  const panel = { agentReason: '', skills: [] };
  const rt = Object.create(WorkbenchRuntime.prototype);
  let reads = 0, consent = true;
  Object.assign(rt, { capabilityCatalog: catalog, state: { conversations: [c] },
    _availableSkills: () => catalog.skills, _turnForConversation: () => active,
    _panelForLane: () => panel, _notify: () => {}, requireLicense: () => {},
    _captureWorkPanelSummary: () => {}, hasExternalTransferConsent: () => consent,
    controlledTools: createDefaultControlledToolRegistry([PRIMARY_SKILL_TOOL]),
    vault: { read: async () => { reads++; return body; } },
  });
  const plan = { agent: { agentId: agent.id, canonicalAgentId: cfg.id }, governingSkills: [] };
  const prepared = rt._prepareDemandSkill(c, plan, context);
  rt._setDemandSkillBudget(context, { contextWindowTokens: 200000, contextWindowSource: 'provider-metadata' }, { messages: ['hello'] });
  return { rt, c, skill, context, active, panel, prepared, reads: () => reads,
    revoke: () => { consent = false; }, call: (args = { skillId: id, reason: '核对当前任务的证据' }, callId = 'call-1') =>
      rt._handleKnowledgeTool(PRIMARY_SKILL_TOOL.name, args, context, { toolCallId: callId, channel }),
    submit: (callId = 'call-1') => rt._finishDemandSkillDelivery(context, { toolCallId: callId, channel }, true) };
}

for (const channel of ['provider-api', 'codex-app-server']) {
  test(`${channel}: actual runtime loads one body, records a real receipt, submits separately and keeps body transient`, async () => {
    const f = fixture(channel);
    assert.equal(f.prepared.candidates.length, 1);
    const boundaries = JSON.stringify({ roots: f.context.allowedReadRoots, permission: f.context.permissionMode });
    const response = await f.call();
    assert.equal(response.success, true);
    assert.equal(f.reads(), 1);
    assert.equal(f.active.skillCalls[0].source, 'model-demand');
    assert.equal(f.active.skillCalls[0].instructionLoaded, true);
    assert.equal(f.active.skillCalls[0].callState.submittedAt, null);
    f.submit();
    assert.ok(f.active.skillCalls[0].callState.submittedAt);
    assert.equal(f.active.skillCalls[0].callState.readReceipt.channel, channel);
    assert.equal(JSON.stringify({ roots: f.context.allowedReadRoots, permission: f.context.permissionMode }), boundaries);
    assert.equal(JSON.stringify(f.c).includes('SYNTHETIC_BODY_ONLY_IN_TOOL_RESULT'), false);
    assert.equal(JSON.stringify(f.panel).includes('SYNTHETIC_BODY_ONLY_IN_TOOL_RESULT'), false);
    await f.call();
    assert.equal(f.reads(), 1);
    assert.equal(f.context.toolAuditEvents.length, 1);
    assert.equal(f.active.skillCalls.length, 1);
  });

  test(`${channel}: disabling candidate before call prevents reading while chat remains available`, async () => {
    const f = fixture(channel);
    f.c.disabledSkills = [id];
    const response = await f.call();
    assert.equal(response.success, false);
    assert.equal(f.reads(), 0);
    assert.equal(f.active.status, 'streaming');
  });
}

test('external consent revoked before read is refused', async () => {
  const f = fixture(); f.revoke();
  const response = await f.call();
  assert.equal(response.success, false); assert.equal(f.reads(), 0);
});
test('cached body cannot be replayed after consent is revoked', async () => {
  const f = fixture(); assert.equal((await f.call()).success, true);
  f.revoke(); const response = await f.call();
  assert.equal(response.success, false);
  assert.doesNotMatch(response.contentItems[0].text, /SYNTHETIC_BODY_ONLY_IN_TOOL_RESULT/);
  assert.equal(f.reads(), 1);
  f.submit(); assert.equal(f.active.skillCalls[0].callState.submittedAt, null);
});
test('cached body cannot be replayed after the Skill is disabled or its version changes', async () => {
  for (const change of [f => { f.skill.enabled = false; }, f => { f.skill.version = '2.0.0'; }]) {
    const f = fixture(); assert.equal((await f.call()).success, true); change(f);
    const response = await f.call(); assert.equal(response.success, false);
    assert.doesNotMatch(response.contentItems[0].text, /SYNTHETIC_BODY_ONLY_IN_TOOL_RESULT/);
    assert.equal(f.reads(), 1);
  }
});
test('a changed raw body cannot be delivered under the old frozen version and definition', async () => {
  const f = fixture(); f.rt.vault.read = async () => 'different raw body with same metadata';
  const response = await f.call();
  assert.equal(response.success, false); assert.match(response.contentItems[0].text, /VERSION_CHANGED/);
  assert.doesNotMatch(response.contentItems[0].text, /different raw body/);
});
test('unknown provider capacity refuses a body without breaking conversation', async () => {
  const f = fixture(); f.rt._setDemandSkillBudget(f.context, {}, { messages: [] });
  const response = await f.call();
  assert.equal(response.success, false); assert.match(response.contentItems[0].text, /BUDGET_EXCEEDED/);
  assert.equal(f.reads(), 0); assert.equal(f.active.status, 'streaming');
});
test('manual mode and pre-migration conversations do not expose the tool', () => {
  for (const patch of [{ skillMode: 'manual' }, { skillPreferenceSchemaVersion: undefined }]) {
    const f = fixture(); const context = { ...f.context, allowedToolIds: [] };
    Object.assign(f.c, patch);
    const prepared = f.rt._prepareDemandSkill(f.c, { governingSkills: [] }, context);
    assert.equal(prepared.candidates.length, 0);
    assert.equal(context.allowedToolIds.includes(PRIMARY_SKILL_TOOL.name), false);
  }
});

test('stopping a loaded attempt prevents a cached result reaching a replacement answer', async () => {
  const f = fixture(); assert.equal((await f.call()).success, true);
  f.active.status = 'interrupted';
  f.rt._cancelDemandSkillForTurn(f.active, 'cancelled');
  const result = await f.call();
  assert.equal(result.success, false); assert.doesNotMatch(result.contentItems[0].text, /SYNTHETIC_BODY_ONLY_IN_TOOL_RESULT/);
  assert.equal(f.reads(), 1);
});

module.exports = { fixture, id, body };
