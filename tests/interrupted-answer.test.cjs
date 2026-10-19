'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLoader} = require('./runtime-loader.cjs');

// Exercise the actual view methods; the fake host only supplies DOM primitives.
class Element {
  constructor(options = {}) { this.children = []; this.hidden = false; this.text = options.text || ''; }
  empty() { this.children = []; }
  toggleAttribute(key, value) { this[key] = value; }
  toggleClass() {}
  setText(value) { this.text = value; }
  setAttr() {}
  addEventListener() {}
  createEl(_tag, options) { const child = new Element(options); this.children.push(child); return child; }
  createSpan(options) { return this.createEl('span', options); }
  createDiv(options) { return this.createEl('div', options); }
}
const load = createLoader({host: {setIcon() {}}, globals: {Error}});
const {XingzhiWorkbenchView} = load('./workbench-view.cjs');
const {WorkbenchRuntime} = load('./workbench-runtime.cjs');

function viewFixture() {
  const view = Object.create(XingzhiWorkbenchView.prototype);
  const entry = Object.fromEntries(['article','avatar','author','mediaBadge','time','text','failureRecovery',
    'actions','copy','manageBlocks','metrics','references'].map(key => [key, new Element()]));
  Object.assign(view, {plugin: {state: {settings: {}}}, getActiveConversation: () => ({id: 'chat'}),
    workPanelForConversation: () => ({}), renderMessageContent: (_entry, text, options) => {
      entry.rendered = text; entry.markdown = options.markdown;
    }});
  for (const name of ['renderMessageImages','renderChatImage','renderGeneratedMessageImages',
    'renderMessageAttachmentStatus','renderMessageResults']) view[name] = () => {};
  return {view, entry};
}

for (const status of ['failed', 'error', 'interrupted', 'cancelled']) {
  test(`${status}: retained answer remains visible and copyable without API completion metadata`, () => {
    const {view, entry} = viewFixture();
    const body = '# 已收到的报告\n\n证据与分析。\n\n末尾未完';
    const message = {id: 'answer', role: 'assistant', status, content: body, error: '连接已断开'};
    view.updateMessageNode(entry, message, 'assistant', body, message.error);
    assert.equal(entry.rendered, body);
    assert.equal(entry.markdown, true);
    assert.equal(entry.text.hidden, false);
    assert.equal(entry.failureRecovery.hidden, false);
    assert.equal(entry.copy.disabled, false);
    assert.equal(message.status, status, 'Partial content is never relabelled completed');
  });
}
test('no-content failure still shows its error and does not invent an answer', () => {
  const {view, entry} = viewFixture();
  view.updateMessageNode(entry, {id: 'a', status: 'failed', content: '', error: '断开'}, 'assistant', '', '断开');
  assert.equal(entry.text.hidden, true);
  assert.equal(entry.copy.disabled, true);
});
test('failure placeholder is not presented as a preserved answer', () => {
  const {view, entry} = viewFixture();
  const body = '本轮未能完成：断开';
  view.updateMessageNode(entry, {id: 'a', status: 'failed', content: body, error: '断开'}, 'assistant', body, '断开');
  assert.equal(entry.text.hidden, true);
});

test('normal dialogue never schedules a wall-clock deadline even with the legacy 15-minute setting', () => {
  const scheduled = [];
  const {WorkbenchRuntime: Runtime} = createLoader({globals: {
    setTimeout: (fn, delay) => { scheduled.push({fn, delay}); return {unref() {}}; }, clearTimeout() {},
  }})('./workbench-runtime.cjs');
  const rt = Object.create(Runtime.prototype);
  const active = {conversationId: 'chat', assistantMessageId: 'a', status: 'streaming', engine: 'codex-app-server'};
  Object.assign(rt, {turnTimeoutMs: 900000, turnWatchdogs: new Map(), _turnForConversation: () => active});
  rt._startTurnWatchdog(active);
  assert.equal(scheduled.length, 0);
  assert.equal(rt.turnWatchdogs.size, 0);
  assert.equal(active.status, 'streaming');
});

test('transport failure saves the partial body, token usage and failure separately', async () => {
  const rt = Object.create(WorkbenchRuntime.prototype);
  const body = '# 还未完成的报告\n\n已经收到的正文';
  const message = {id: 'answer', content: body, status: 'streaming', responseMetrics: {tokenUsage: {totalTokens: 123}}};
  const conversation = {id: 'chat', messages: [message]};
  const active = {conversationId: 'chat', assistantMessageId: 'answer', status: 'streaming'};
  let saved;
  Object.assign(rt, {state: {conversations: [conversation], runtime: {approvals: []}},
    providerIterators: new Map(), turnWatchdogs: new Map(),
    _turnForConversation: () => active, _turnRunForActiveTurn: () => null,
    _finishWorkPanelTrace() {}, _recordTurnTerminal() {}, _finishMessageMetrics() {},
    _persistConversation: async c => { saved = JSON.parse(JSON.stringify(c)); },
    _save: async () => {}, _notify() {},
  });
  await rt._failTurn(active, new Error('连接已断开'));
  assert.equal(saved.messages[0].content, body);
  assert.equal(saved.messages[0].error, '连接已断开');
  assert.equal(saved.messages[0].status, 'failed');
  assert.equal(saved.messages[0].responseMetrics.tokenUsage.totalTokens, 123);
});
