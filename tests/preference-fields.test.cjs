'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./runtime-loader.cjs');
const load = createLoader();
const { normalizeCapabilityPreferences, buildTurnCapabilityPlan } = load('./capability-orchestrator.cjs');
const { normalizeConversationState } = load('./contracts.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const task = name => ({ name, displayName: name, enabled: true, skillType: 'task',
  primaryEligible: true, requires: [], optionalDependencies: [], description: '测试方法参考',
  path: `skills/${name}/SKILL.md`, version: '1.0.0' });
const skills = ['candidate-method', 'invoked-method', 'legacy-method'].map(task);
const v2 = { skillPreferenceSchemaVersion: 2, selectedSkills: ['legacy-method'],
  fixedCandidateIds: ['candidate-method'], fixedInvocationIds: ['invoked-method'] };
const plan = (preferences, extra = {}) => buildTurnCapabilityPlan({ text: '你好',
  preferences, availableSkills: skills, ...extra });
const governed = result => plain(result.governingSkills.map(skill => skill.name));

test('normalizer preserves bounded schema v2 fields without promoting legacy snapshot', () => {
  const result = normalizeCapabilityPreferences({ ...v2,
    fixedCandidateIds: [' candidate-method ', '', null, 'candidate-method', 'x'.repeat(129)],
    fixedInvocationIds: ['invoked-method', 'invoked-method'] });
  assert.equal(result.skillPreferenceSchemaVersion, 2);
  assert.deepEqual(plain(result.fixedCandidateIds), ['candidate-method']);
  assert.deepEqual(plain(result.fixedInvocationIds), ['invoked-method']);
  assert.deepEqual(plain(result.selectedSkills), ['legacy-method']);
});

for (const skillMode of ['auto', 'recommend', 'manual']) {
  test(`schema v2 ${skillMode} invokes only explicit fixed invocation and leaves candidate advisory`, () => {
    const result = plan({ ...v2, skillMode });
    assert.deepEqual(governed(result), ['invoked-method']);
    const rows = plain(result.fixedSkills);
    assert.equal(rows.find(row => row.name === 'invoked-method')?.applicationMode, 'governing');
    assert.equal(rows.find(row => row.name === 'candidate-method')?.applicationMode, 'advisory');
    assert.equal(result.skills.some(row => row.name === 'legacy-method'), false);
  });
  test(`schema v2 ${skillMode} honors disabled above fixed invocation, candidate and one-turn request`, () => {
    const result = plan({ ...v2, skillMode, disabledSkills: ['candidate-method', 'invoked-method'] },
      { requestedSkills: ['candidate-method', 'invoked-method'] });
    assert.deepEqual(governed(result), []);
    assert.equal(result.fixedSkills.length, 0);
  });
}

test('mode switching preserves both v2 lists without converting candidates into invocation', () => {
  let prefs = normalizeCapabilityPreferences({ ...v2, skillMode: 'auto' });
  for (const skillMode of ['manual', 'recommend', 'auto']) {
    prefs = normalizeCapabilityPreferences({ ...prefs, skillMode });
    assert.deepEqual(plain(prefs.fixedCandidateIds), ['candidate-method']);
    assert.deepEqual(plain(prefs.fixedInvocationIds), ['invoked-method']);
    assert.deepEqual(governed(plan(prefs)), ['invoked-method']);
  }
});

test('globally disabled catalog entry cannot be invoked through v2 preferences', () => {
  const result = plan(v2, { availableSkills: skills.map(row => ({ ...row,
    enabled: row.name !== 'invoked-method' })) });
  assert.deepEqual(governed(result), []);
});

for (const skillMode of ['auto', 'recommend', 'manual']) {
  test(`legacy ${skillMode} selection keeps the pre-v2 meaning`, () => {
    const result = plan({ skillMode, selectedSkills: ['legacy-method'],
      fixedCandidateIds: ['candidate-method'], fixedInvocationIds: ['invoked-method'] });
    assert.deepEqual(governed(result), skillMode === 'auto' ? [] : ['legacy-method']);
    assert.equal(Object.hasOwn(result.preferences, 'skillPreferenceSchemaVersion'), false);
  });
}

test('contracts settings and conversation normalization preserve only explicitly declared v2 fields', () => {
  const stored = { settings: { ...v2 }, conversations: [{ id: 'conversation', ...v2, messages: [] }] };
  const result = normalizeConversationState(stored);
  assert.equal(result.settings.skillPreferenceSchemaVersion, 2);
  assert.deepEqual(plain(result.settings.fixedCandidateIds), ['candidate-method']);
  assert.deepEqual(plain(result.settings.fixedInvocationIds), ['invoked-method']);
  assert.equal(result.conversations[0].skillPreferenceSchemaVersion, 2);
  assert.deepEqual(plain(result.conversations[0].fixedInvocationIds), ['invoked-method']);
  assert.deepEqual(plain(stored.settings), v2);
});

test('contracts never auto-migrate an old saved selection into schema v2', () => {
  const result = normalizeConversationState({ settings: { selectedSkills: ['legacy-method'] },
    conversations: [{ id: 'old', selectedSkills: ['legacy-method'], messages: [] }] });
  for (const row of [result.settings, result.conversations[0]]) {
    assert.equal(Object.hasOwn(row, 'skillPreferenceSchemaVersion'), false);
    assert.equal(Object.hasOwn(row, 'fixedCandidateIds'), false);
    assert.deepEqual(plain(row.selectedSkills), ['legacy-method']);
  }
});
