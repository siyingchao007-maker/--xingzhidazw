'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./runtime-loader.cjs');
const { WorkbenchRuntime, createRuntimeState } = createLoader()('./workbench-runtime.cjs');

function preferenceRuntime(state) {
  const rt = Object.create(WorkbenchRuntime.prototype);
  rt.state = createRuntimeState(state);
  rt._syncRuntimeProjection = () => {};
  rt._notify = () => {};
  rt._save = () => Promise.resolve();
  rt._turnForConversation = () => null;
  return rt;
}

function fixedConversation(id, candidates = [], invocations = []) {
  return { id, title: id, messages: [], skillMode: 'auto', selectedSkills: [...candidates, ...invocations],
    disabledSkills: [], skillPreferenceSchemaVersion: 2, fixedCandidateIds: candidates,
    fixedInvocationIds: invocations, controlledSkillLoading: true };
}

test('new conversation starts with its own empty preferences and non-capability settings cannot inherit old fixed calls', async () => {
  const rt = preferenceRuntime({ activeConversationId: 'old', settings: { controlledSkillLoadingDefault: true },
    conversations: [fixedConversation('old', ['task-old'], ['call-old'])] });
  rt._syncSettingsFromConversation(rt.activeConversation);
  const row = rt.createConversation('new');
  assert.equal(rt.state.settings.fixedCandidateIds.length, 0);
  assert.equal(rt.state.settings.fixedInvocationIds.length, 0);
  await rt.updateSettings({ showWorkPanel: false });
  assert.equal(row.fixedCandidateIds.length, 0);
  assert.equal(row.fixedInvocationIds.length, 0);
  assert.equal(row.controlledSkillLoading, true);
  assert.equal(rt.state.settings.showWorkPanel, false);
  assert.equal(rt.state.conversations[0].fixedInvocationIds[0], 'call-old');
});

test('restored selected conversation owns the settings mirror and keeps its lists after an unrelated setting change', async () => {
  const stale = fixedConversation('stale', ['task-stale'], ['call-stale']);
  const rt = preferenceRuntime({ activeConversationId: 'selected', settings: { ...stale },
    conversations: [stale, fixedConversation('selected', ['task-current'])] });
  assert.equal(rt.state.settings.fixedCandidateIds[0], 'task-current');
  assert.equal(rt.state.settings.fixedInvocationIds.length, 0);
  await rt.updateSettings({ showWorkPanel: false });
  assert.equal(rt.activeConversation.fixedCandidateIds[0], 'task-current');
  assert.equal(rt.activeConversation.fixedInvocationIds.length, 0);
});

test('unrelated settings use current conversation even if a caller has left a stale mirror', async () => {
  const rt = preferenceRuntime({ activeConversationId: 'selected', settings: {},
    conversations: [fixedConversation('selected', ['task-current'])] });
  Object.assign(rt.state.settings, { fixedCandidateIds: ['task-stale'], fixedInvocationIds: ['call-stale'],
    skillPreferenceSchemaVersion: 2, controlledSkillLoading: false });
  await rt.updateSettings({ showWorkPanel: false });
  assert.equal(rt.activeConversation.fixedCandidateIds[0], 'task-current');
  assert.equal(rt.activeConversation.fixedInvocationIds.length, 0);
  assert.equal(rt.activeConversation.controlledSkillLoading, true);
});

test('explicit preference changes still apply without converting fixed candidates into fixed calls', async () => {
  const rt = preferenceRuntime({ activeConversationId: 'selected', settings: {},
    conversations: [fixedConversation('selected', ['task-current'], ['call-current'])] });
  rt._syncSettingsFromConversation(rt.activeConversation);
  await rt.updateSettings({ fixedCandidateIds: ['task-next'], controlledSkillLoading: false });
  assert.equal(rt.activeConversation.fixedCandidateIds[0], 'task-next');
  assert.equal(rt.activeConversation.fixedInvocationIds[0], 'call-current');
  assert.equal(rt.activeConversation.controlledSkillLoading, false);
  await rt.updateSettings({ skillMode: 'manual', fixedInvocationIds: ['call-next'] });
  assert.equal(rt.activeConversation.fixedCandidateIds[0], 'task-next');
  assert.equal(rt.activeConversation.fixedInvocationIds[0], 'call-next');
  assert.equal(rt.activeConversation.skillMode, 'manual');
});
test('restoring runtime preserves migration revision, independent lists and loading flag', () => {
  const state = createRuntimeState({ activeConversationId: 'saved', settings: {}, conversations: [{ id: 'saved',
    title: '保存的对话', messages: [], skillMode: 'auto', selectedSkills: ['task-a'], disabledSkills: [],
    skillPreferenceSchemaVersion: 2, fixedCandidateIds: ['task-a'], fixedInvocationIds: ['task-b'],
    controlledSkillLoading: true, preferenceRevision: 'confirmed-migration' }] });
  const row = state.conversations[0];
  assert.equal(row.preferenceRevision, 'confirmed-migration');
  assert.equal(row.controlledSkillLoading, true);
  assert.equal(row.fixedCandidateIds[0], 'task-a');
  assert.equal(row.fixedInvocationIds[0], 'task-b');
});
test('explicitly exiting training also clears its schema2 fixed invocation', () => {
  const rt = Object.create(WorkbenchRuntime.prototype);
  const c = { id: 'current', selectedSkills: ['xingzhi-training-response'], disabledSkills: [],
    skillPreferenceSchemaVersion: 2, trainingResponseModeActive: true,
    fixedInvocationIds: ['xingzhi-training-response', 'task-b'] };
  rt.state = { activeConversationId: c.id }; rt._syncSettingsFromConversation = () => {};
  assert.equal(rt._applyTrainingResponseModeAction('退出训练模式', c), true);
  assert.equal(c.trainingResponseModeActive, false);
  assert.equal(c.fixedInvocationIds.includes('xingzhi-training-response'), false);
  assert.equal(c.fixedInvocationIds.includes('task-b'), true);
});
