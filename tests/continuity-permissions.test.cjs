'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLoader} = require('./runtime-loader.cjs');
const load = createLoader();
const {WorkbenchRuntime, createRuntimeState} = load('./workbench-runtime.cjs');
const {normalizeConversationState} = load('./contracts.cjs');
const {UserContinuityService} = load('./user-continuity-service.cjs');
const {CURRENT_PROFILE_PATH, GROWTH_EVENTS_PATH, GROWTH_PATH_PATH,
  profileRevisionPath, interactionLedgerPath} = load('./user-continuity.cjs');
const NOW = '2026-10-20T06:00:00.000Z';
const FORMAL_PATHS = [CURRENT_PROFILE_PATH, profileRevisionPath(NOW), GROWTH_EVENTS_PATH, GROWTH_PATH_PATH];

function fixture({permissionMode = 'auto-write', conversationPermission,
  processingMode = 'automatic', analyzer} = {}) {
  const files = new Map();
  const transactions = [];
  const writer = {
    plan: mutations => ({mutations}),
    async commit(plan) {
      const transaction = {id: `tx-${transactions.length + 1}`, mutations: plan.mutations, undoToken: 'test-only'};
      for (const mutation of plan.mutations) files.set(mutation.path, mutation.content);
      transactions.push(transaction);
      return transaction;
    },
    exportJournal: () => transactions.slice(),
  };
  const vault = {exists: async path => files.has(path), read: async path => files.get(path) || ''};
  const conversation = {id: 'chat-test', title: '合成权限回归', messages: [
    {id: 'msg-user', role: 'user', content: '我偏好先看结论。我已完成本周的复盘。', status: 'completed', createdAt: NOW},
    {id: 'msg-answer', role: 'assistant', content: '已收到。', status: 'completed', createdAt: NOW},
  ], ...(conversationPermission ? {permissionMode: conversationPermission} : {})};
  const runtime = Object.create(WorkbenchRuntime.prototype);
  runtime.state = createRuntimeState({activeConversationId: conversation.id,
    settings: {permissionMode, conversationProcessingMode: processingMode}, conversations: [conversation]});
  // Preserve the requested live selection here; separate restoration tests below cover A02.
  runtime.state.settings.conversationProcessingMode = processingMode;
  runtime.knowledgeWriter = writer;
  runtime.userContinuityService = new UserContinuityService({vault, writer, clock: () => NOW});
  let analyzerCalls = 0;
  runtime.userContinuityAnalyzer = async input => {
    analyzerCalls += 1;
    if (analyzer) return analyzer(input);
    return analysisFor(input);
  };
  runtime.clock = () => NOW;
  runtime._save = async () => {};
  runtime._notify = () => {};
  runtime._backgroundWorkPanelForConversation = () => null;
  return {runtime, vault, files, transactions,
    conversation: runtime.state.conversations[0],
    analyzerCalls: () => analyzerCalls,
    run: () => runtime._runUserContinuityTurn(conversation.id, 'msg-user', 'msg-answer')};
}

function analysisFor({interactionEvent}) {
  return {observations: [{dimension: 'communication', statement: '偏好先看结论',
    epistemicStatus: 'user-statement', confidence: 0.95, relation: 'new', targetProfileId: null,
    evidenceQuote: '我偏好先看结论', sourceMessageId: interactionEvent.sourceMessageId}],
  growthEvents: [{id: 'growth-test', title: '完成本周复盘', summary: '用户自述已经完成本周复盘。',
    eventType: 'action', confidence: 0.95, evidenceQuote: '我已完成本周的复盘',
    sourceMessageId: interactionEvent.sourceMessageId}], ignored: []};
}

function assertNoFormalWrites(f) {
  for (const path of FORMAL_PATHS) assert.equal(f.files.has(path), false, `Must not submit ${path}`);
  assert.equal(f.transactions.flatMap(tx => tx.mutations).filter(m => FORMAL_PATHS.includes(m.path)).length, 0);
}

test('A01: confirm-write records interaction but does not analyze or auto-update profile and growth', async () => {
  const f = fixture({permissionMode: 'confirm-write'});
  const result = await f.run();
  assertNoFormalWrites(f);
  assert.equal(f.analyzerCalls(), 0, 'Do not spend model tokens when semantic results cannot be reviewed');
  assert.equal(f.files.has(interactionLedgerPath(NOW)), true);
  assert.equal(result.status, 'recorded-only');
  assert.equal(result.analysisStatus, 'disabled');
  assert.match(result.reason, /整理前确认/u);
  assert.match(result.reason, /画像|成长/u);
});

test('A01 control: auto-write still commits allowed profile, revision and growth files', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.analysisStatus, 'written');
  for (const path of FORMAL_PATHS) assert.equal(f.files.has(path), true, `Expected allowed write ${path}`);
  assert.equal(f.analyzerCalls(), 1);
});

test('A01 control: read-only records no interaction and submits no knowledge writes', async () => {
  const f = fixture({permissionMode: 'read-only'});
  const result = await f.run();
  assert.equal(result.status, 'skipped-read-only');
  assert.equal(f.analyzerCalls(), 0);
  assert.equal(f.files.size, 0);
  assert.equal(f.transactions.length, 0);
});

test('A01 control: record-only saves the interaction but runs no analyzer or formal profile writes', async () => {
  const f = fixture({processingMode: 'record-only'});
  const result = await f.run();
  assert.equal(result.status, 'recorded-only');
  assert.equal(f.analyzerCalls(), 0);
  assert.equal(f.files.has(interactionLedgerPath(NOW)), true);
  assertNoFormalWrites(f);
});

test('A01: conversation confirm-write overrides the global automatic-write setting', async () => {
  const f = fixture({permissionMode: 'auto-write', conversationPermission: 'confirm-write'});
  const result = await f.run();
  assertNoFormalWrites(f);
  assert.equal(result.status, 'recorded-only');
  assert.equal(f.analyzerCalls(), 0);
  assert.match(result.reason, /整理前确认/u);
});

for (const revokedMode of ['confirm-write', 'read-only', 'record-only']) {
  test(`A01 race: revoking to ${revokedMode} before analysis returns prevents formal submission`, async () => {
    let analysisStarted;
    let releaseAnalysis;
    const started = new Promise(resolve => { analysisStarted = resolve; });
    const resumed = new Promise(resolve => { releaseAnalysis = resolve; });
    const f = fixture({analyzer: async input => { analysisStarted(); await resumed; return analysisFor(input); }});
    const running = f.run();
    await started;
    if (revokedMode === 'record-only') f.runtime.state.settings.conversationProcessingMode = 'record-only';
    else f.conversation.permissionMode = revokedMode;
    releaseAnalysis();
    const result = await running;
    assertNoFormalWrites(f);
    assert.equal(f.files.has(interactionLedgerPath(NOW)), true, 'Earlier authorized record is preserved');
    assert.ok(['recorded-only', 'skipped-read-only'].includes(result.status));
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  });
}

test('A01 service race: revoking canApply during async profile read prevents the final commit', async () => {
  const f = fixture();
  const recorded = await f.runtime.userContinuityService.recordInteraction({conversation: f.conversation,
    userMessage: f.conversation.messages[0], assistantMessage: f.conversation.messages[1]});
  let allowed = true;
  let readStarted;
  let releaseRead;
  const started = new Promise(resolve => { readStarted = resolve; });
  const resumed = new Promise(resolve => { releaseRead = resolve; });
  const exists = f.vault.exists;
  f.vault.exists = async path => {
    if (path === CURRENT_PROFILE_PATH) { readStarted(); await resumed; }
    return exists(path);
  };
  const applying = f.runtime.userContinuityService.applyAnalysis({interactionEvent: recorded.event,
    analysis: analysisFor({interactionEvent: recorded.event}), automaticOrganization: true, canApply: () => allowed});
  await started;
  allowed = false;
  releaseRead();
  const result = await applying;
  assertNoFormalWrites(f);
  assert.equal(result.transactionId, null);
  assert.equal(f.files.has(interactionLedgerPath(NOW)), true);
});

test('A02: saved record-only survives contract normalization and a serialized restart roundtrip', () => {
  const stored = {settings: {conversationProcessingMode: 'record-only'}};
  const normalized = normalizeConversationState(stored);
  assert.equal(normalized.settings.conversationProcessingMode, 'record-only');
  const restarted = createRuntimeState(JSON.parse(JSON.stringify(normalized)));
  assert.equal(restarted.settings.conversationProcessingMode, 'record-only');
});

for (const mode of [undefined, null, '', 'unsupported']) {
  test(`A02 control: missing or invalid processing mode ${String(mode)} defaults to automatic`, () => {
    assert.equal(normalizeConversationState({settings: {conversationProcessingMode: mode}})
      .settings.conversationProcessingMode, 'automatic');
  });
}

test('A01: conversation read-only overrides global auto-write before recording or analysis', async () => {
  const f = fixture({permissionMode: 'auto-write', conversationPermission: 'read-only'});
  const result = await f.run();
  assert.equal(result.status, 'skipped-read-only');
  assert.equal(f.files.size, 0);
  assert.equal(f.transactions.length, 0);
  assert.equal(f.analyzerCalls(), 0);
});

for (const [targetMode, activeMode] of [['confirm-write', 'auto-write'], ['auto-write', 'read-only']]) {
  test(`A01: background target ${targetMode} uses its own permission while active conversation is ${activeMode}`, async () => {
    const f = fixture({conversationPermission: targetMode});
    f.runtime.state.conversations.push({id: 'other-chat', permissionMode: activeMode, messages: []});
    f.runtime.state.activeConversationId = 'other-chat';
    f.runtime.state.settings.permissionMode = activeMode;
    const result = await f.run();
    if (targetMode === 'confirm-write') {
      assertNoFormalWrites(f);
      assert.equal(result.status, 'recorded-only');
      assert.equal(f.analyzerCalls(), 0);
    } else {
      assert.equal(result.analysisStatus, 'written');
      for (const path of FORMAL_PATHS) assert.equal(f.files.has(path), true);
      assert.equal(f.analyzerCalls(), 1);
    }
  });
}

test('A01 recorder race: read-only revocation during async ledger lookup prevents recording and analysis', async () => {
  const f = fixture();
  let lookupStarted;
  let releaseLookup;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const resumed = new Promise(resolve => { releaseLookup = resolve; });
  const exists = f.vault.exists;
  f.vault.exists = async path => {
    if (path === interactionLedgerPath(NOW)) { lookupStarted(); await resumed; }
    return exists(path);
  };
  const running = f.run();
  await started;
  f.conversation.permissionMode = 'read-only';
  releaseLookup();
  const result = await running;
  assert.equal(result.status, 'skipped-read-only');
  assert.equal(result.eventPath, null);
  assert.equal(f.files.size, 0);
  assert.equal(f.transactions.length, 0);
  assert.equal(f.analyzerCalls(), 0);
});
