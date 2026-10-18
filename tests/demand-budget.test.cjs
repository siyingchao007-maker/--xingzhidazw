'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./runtime-loader.cjs');
const { demandSkillHeadroom, PRIMARY_SKILL_TOOL } = createLoader()('./demand-skill-runtime.cjs');

test('unknown context capacity does not become a guessed safe budget', () => {
  assert.equal(demandSkillHeadroom({ channel: 'provider-api', localBytes: 1024 }), null);
  assert.equal(demandSkillHeadroom({ channel: 'codex-app-server', active: {} }), null);
});
test('Codex uses current reported window and leaves answer reserve', () => {
  assert.equal(demandSkillHeadroom({ channel: 'codex-app-server', active: {
    contextWindow: { modelContextWindow: 100000, inputTokens: 90000 },
  } }), 1808);
});
test('provider budget uses reported model capacity and all serialized request bytes conservatively', () => {
  assert.equal(demandSkillHeadroom({ channel: 'provider-api', model: {
    contextWindowTokens: 100000, contextWindowSource: 'provider-metadata',
  }, localBytes: 90000 }), 1808);
  assert.equal(demandSkillHeadroom({ channel: 'provider-api', model: {
    contextWindowTokens: 100000, contextWindowSource: 'guessed',
  }, localBytes: 100 }), null);
});
test('tool accepts only Skill identifier and short task-fit reason', () => {
  assert.equal(PRIMARY_SKILL_TOOL.name, 'xingzhi_load_primary_skill');
  assert.equal(PRIMARY_SKILL_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(PRIMARY_SKILL_TOOL.inputSchema.properties), ['skillId', 'reason']);
});
test('first native tool call can use fresh effective CLI model capacity with host and answer reserves', () => {
  assert.equal(demandSkillHeadroom({ channel: 'codex-app-server', active: {},
    model: { contextWindowTokens: 450000, contextWindowSource: 'codex-cache-effective' }, localBytes: 10000 }), 366272);
});
