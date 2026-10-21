'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./runtime-loader.cjs');

const load = createLoader();
const { WorkbenchRuntime, boundedPush } = load('./workbench-runtime.cjs');
// Share the host Date so identities built from a fixed clock pass the module's
// `instanceof Date` check (Obsidian runs everything in one realm).
const deviceIdentity = createLoader({ globals: { Date } })('./commercial-device-identity.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(condition(), 'condition reached');
}

function runtime(overrides = {}) {
  const rt = Object.create(WorkbenchRuntime.prototype);
  Object.assign(rt, {
    state: {
      conversations: [], settings: {},
      runtime: { connection: { warnings: [] }, providerConnections: {} },
    },
    started: false, stopPersistence: null, vaultPath: '/vault',
    requireLicense() {}, _notify() {}, _markCodexAuthenticationRequired() {},
    _restoreKnowledgeRecoveryMarker: async () => {},
    _projectCatalogSkills: () => [], _capabilityManagerSnapshot: () => ({}),
    capabilityCatalog: { issues: [] },
    turnRunOwners: new Map(), startingTurnOwners: new Map(), turnWatchdogs: new Map(),
    userContinuityTimers: new Map(), backgroundProcessingChains: new Map(),
    deferredBackgroundRetries: new Map(), auxiliaryStartPromises: new Map(),
    providerIterators: new Map(), pendingTurnWaiters: new Map(), pendingMessageContext: new Map(),
    pendingCapabilityDrafts: new Map(), startingConversationIds: new Set(),
    backgroundStartingConversationIds: new Set(),
  }, overrides);
  return rt;
}

function appServer(overrides = {}) {
  return {
    start: async () => ({ userAgent: 'test' }), stop() {},
    setSkillExtraRoots: async () => {},
    listModels: async () => ({ data: [] }), listSkills: async () => ({ data: [] }),
    ...overrides,
  };
}

test('boundedPush keeps the newest 200 connection warnings', () => {
  const warnings = [];
  for (let index = 0; index < 1000; index++) boundedPush(warnings, `Codex 正在自动重连：${index}`);
  assert.equal(warnings.length, 200);
  assert.equal(warnings[0], 'Codex 正在自动重连：800');
  assert.equal(warnings.at(-1), 'Codex 正在自动重连：999');
});

test('start loads the capability catalog concurrently with the Codex app-server', async () => {
  const catalog = deferred();
  const server = deferred();
  const calls = [];
  const rt = runtime({
    _startConversationLedgerBackfill() {},
    refreshCapabilityCatalog: () => { calls.push('catalog'); return catalog.promise; },
    appServer: appServer({ start: () => { calls.push('codex'); return server.promise; } }),
  });
  const starting = rt.start();
  await tick();
  // Both are in flight before either one finishes.
  assert.deepEqual(calls.sort(), ['catalog', 'codex']);
  assert.equal(rt.state.runtime.connection.status, 'connecting');
  server.resolve({ userAgent: 'codex-test' });
  await tick();
  assert.equal(rt.started, false, 'start waits for the catalog');
  catalog.resolve();
  const connection = await starting;
  assert.equal(connection.status, 'connected');
  assert.equal(connection.userAgent, 'codex-test');
  assert.equal(rt.started, true);
});

test('start falls back to core agents when the Vault catalog fails', async () => {
  const rt = runtime({
    _startConversationLedgerBackfill() {},
    refreshCapabilityCatalog: async () => { throw new Error('catalog broken'); },
    appServer: appServer(),
  });
  const connection = await rt.start();
  assert.equal(connection.status, 'connected');
  assert.ok(rt.capabilityCatalog.agents.length > 0);
  assert.ok(rt.capabilityCatalog.agents.every((agent) => agent.protected && agent.source === 'core'));
  // Errors thrown from this test realm are reported with the generic fallback text.
  assert.ok(connection.warnings.some((warning) => warning.startsWith('Vault 能力注册表未加载，已使用安全后备：')));
});

test('start settles the catalog before reporting an app-server failure', async () => {
  const catalog = deferred();
  let cleaned = 0;
  const rt = runtime({
    _startConversationLedgerBackfill() {},
    refreshCapabilityCatalog: () => catalog.promise,
    cleanupSkillExtraRoots: () => { cleaned++; },
    appServer: appServer({ start: async () => { throw new Error('spawn failed'); } }),
  });
  let settled = false;
  const starting = rt.start().finally(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  catalog.resolve();
  await assert.rejects(starting, /spawn failed/u);
  assert.equal(rt.state.runtime.connection.status, 'error');
  assert.equal(cleaned, 1);
});

test('start does not wait for the historical ledger backfill', async () => {
  const writes = deferred();
  const rt = runtime({
    refreshCapabilityCatalog: async () => {},
    appServer: appServer(),
    _persistConversationLedger: () => writes.promise,
  });
  rt.state.conversations = [{ id: 'a' }];
  const connection = await rt.start();
  assert.equal(connection.status, 'connected');
  writes.resolve();
  await rt.ledgerBackfill;
});

test('ledger backfill skips deleted conversations and records bounded failures', async () => {
  const seen = [];
  const notified = [];
  const rt = runtime({
    _notify: () => notified.push(true),
    _persistConversationLedger: async (conversation) => {
      seen.push(conversation.id);
      if (conversation.id === 'c') throw new Error('disk full');
    },
  });
  rt.state.conversations = [{ id: 'a' }, { id: 'b', deletedAt: 'x' }, { id: 'c', title: '标题' }];
  await rt._startConversationLedgerBackfill();
  assert.deepEqual(seen, ['a', 'c']);
  const { warnings } = rt.state.runtime.connection;
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith('历史对话总账回填失败：标题；'));
  assert.equal(notified.length, 1);
});

test('stop cancels the remaining ledger backfill', async () => {
  const first = deferred();
  const seen = [];
  const rt = runtime({
    appServer: appServer(),
    _persistConversationLedger: (conversation) => {
      seen.push(conversation.id);
      return conversation.id === 'a' ? first.promise : Promise.resolve();
    },
  });
  rt.state.conversations = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const backfill = rt._startConversationLedgerBackfill();
  await until(() => seen.length > 0);
  assert.deepEqual(seen, ['a']);
  await rt.stop();
  first.resolve();
  await backfill;
  assert.deepEqual(seen, ['a'], 'no conversation is written after stop()');
});

test('ledger writes are serialized per conversation', async () => {
  const events = [];
  const gates = [deferred(), deferred(), deferred()];
  let call = 0;
  const rt = runtime({
    _writeConversationLedger: async (conversation) => {
      const index = call++;
      events.push(`start:${conversation.id}:${index}`);
      await gates[index].promise;
      events.push(`end:${conversation.id}:${index}`);
      if (index === 0) throw new Error('first write failed');
      return index;
    },
  });
  const conversation = { id: 'same' };
  const first = rt._persistConversationLedger(conversation);
  const second = rt._persistConversationLedger(conversation);
  const other = rt._persistConversationLedger({ id: 'other' });
  await tick();
  // Different conversations run in parallel; the same conversation waits.
  assert.deepEqual(events, ['start:same:0', 'start:other:1']);
  gates[1].resolve();
  assert.equal(await other, 1);
  gates[0].resolve();
  await assert.rejects(first, /first write failed/u);
  await tick();
  assert.deepEqual(events.slice(-1), ['start:same:2'], 'a failed write does not break the chain');
  gates[2].resolve();
  assert.equal(await second, 2);
  await tick();
  assert.equal(rt.conversationLedgerWrites.size, 0, 'finished chains are released');
});

const WINDOWS_OUTPUT = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n'
  + '    MachineGuid    REG_SZ    3f2504e0-4f89-11d3-9a0c-0305e82c3301\r\n\r\n';
const fixedIdentity = { arch: 'x64', hostname: () => 'test-host', now: () => new Date('2026-01-01T00:00:00Z') };

test('async device identity matches the synchronous identity', async () => {
  const execFileSync = () => WINDOWS_OUTPUT;
  const execFile = (file, args, options, callback) => {
    assert.equal(file, 'reg.exe');
    assert.equal(options.timeout, 5_000);
    setImmediate(() => callback(null, WINDOWS_OUTPUT));
  };
  const sync = deviceIdentity.getCurrentDeviceIdentity({ platform: 'win32', execFileSync, ...fixedIdentity });
  const asyncIdentity = await deviceIdentity.getCurrentDeviceIdentityAsync({ platform: 'win32', execFile, ...fixedIdentity });
  assert.deepEqual(asyncIdentity, sync);
});

test('async device identity falls back to the dbus machine id and keeps error messages', async () => {
  const readFile = async (file) => {
    if (file === '/etc/machine-id') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return '0123456789abcdef0123456789abcdef\n';
  };
  const readFileSync = (file) => {
    if (file === '/etc/machine-id') throw new Error('missing');
    return '0123456789abcdef0123456789abcdef\n';
  };
  assert.equal(
    await deviceIdentity.readMachineIdAsync({ platform: 'linux', readFile }),
    deviceIdentity.readMachineId({ platform: 'linux', readFileSync }),
  );
  const failingExec = (file, args, options, callback) => callback(new Error('ETIMEDOUT'));
  await assert.rejects(deviceIdentity.readMachineIdAsync({ platform: 'darwin', execFile: failingExec }), {
    message: '无法读取本机设备标识',
  });
  await assert.rejects(deviceIdentity.readMachineIdAsync({ platform: 'win32', execFile: (f, a, o, cb) => cb(null, 'no guid') }), {
    message: '无法读取本机设备标识',
  });
  await assert.rejects(deviceIdentity.readMachineIdAsync({ platform: 'aix' }), {
    message: '行知设备绑定暂不支持当前操作系统',
  });
});

function protectedSkillFixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const vault = path.join(sandbox, 'vault');
  const skills = path.join(vault, '10_智能体与技能', '技能');
  fs.mkdirSync(path.join(skills, 'method', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'method', 'SKILL.md'), 'ENCRYPTED_ON_DISK');
  fs.writeFileSync(path.join(skills, 'method', 'nested', 'note.md'), 'plain note');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(skills, 'method', 'linked.md'));
  fs.symlinkSync(outside, path.join(skills, 'linked-dir'), 'dir');
  const Plugin = createLoader({
    modules: { 'node:fs': fs },
    host: { Notice: class {}, ItemView: class {} },
  })('./main.cjs');
  const plugin = new Plugin();
  plugin.vaultPath = vault;
  plugin.getCapabilityProtectionSnapshot = () => ({ present: true, unlocked: true });
  plugin.capabilityPack = {
    present: true,
    has: (relative) => relative === '10_智能体与技能/技能/method/SKILL.md',
    readText: () => 'DECRYPTED_INSTRUCTIONS',
  };
  return { plugin, vault, skills, outside };
}

test('protected Skill materialization copies files asynchronously and skips symlinks', async (t) => {
  const { plugin } = protectedSkillFixture(t);
  const [skillRoot, releaseRoot] = await plugin.prepareProtectedSkillExtraRoots();
  const runtimeDir = plugin.protectedSkillRuntimeDir;
  assert.equal(path.dirname(skillRoot), runtimeDir);
  assert.equal(fs.readFileSync(path.join(skillRoot, 'method', 'SKILL.md'), 'utf8'), 'DECRYPTED_INSTRUCTIONS');
  assert.equal(fs.readFileSync(path.join(skillRoot, 'method', 'nested', 'note.md'), 'utf8'), 'plain note');
  assert.equal(fs.existsSync(path.join(skillRoot, 'method', 'linked.md')), false);
  assert.equal(fs.existsSync(path.join(skillRoot, 'linked-dir')), false);
  assert.deepEqual(fs.readdirSync(releaseRoot), [], 'a missing release root yields an empty directory');
  plugin.cleanupProtectedSkillRuntime();
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('cancelling protected Skill materialization removes the partial copy', async (t) => {
  const { plugin } = protectedSkillFixture(t);
  let partialDir = null;
  plugin.capabilityPack.readText = () => {
    partialDir = plugin.protectedSkillRuntimeDir;
    plugin.cleanupProtectedSkillRuntime();
    return 'DECRYPTED_INSTRUCTIONS';
  };
  await assert.rejects(plugin.prepareProtectedSkillExtraRoots(), { code: 'PROTECTED_SKILL_CANCELLED' });
  assert.ok(partialDir);
  assert.equal(fs.existsSync(partialDir), false);
  assert.equal(plugin.protectedSkillRuntimeDir, null);
});

test('a symlinked Skill root that escapes the Vault is rejected and cleaned up', async (t) => {
  const { plugin, skills, outside } = protectedSkillFixture(t);
  fs.rmSync(skills, { recursive: true });
  fs.symlinkSync(outside, skills, 'dir');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('xingzhi-cap-')));
  await assert.rejects(plugin.prepareProtectedSkillExtraRoots(), /越过 Vault 边界/u);
  const leaked = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('xingzhi-cap-') && !before.has(name));
  assert.deepEqual(leaked, []);
  assert.equal(plugin.protectedSkillRuntimeDir, null);
});
