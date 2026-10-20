"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLoader } = require("./runtime-loader.cjs");

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const Plugin = createLoader({ host: { Notice: class {}, ItemView: class {
    constructor(leaf) { this.leaf = leaf; this.contentEl = { empty() {}, createEl() { return { addEventListener() {} }; } }; }
  } } })("./main.cjs");
  const plugin = new Plugin();
  const views = new Map();
  plugin.addCommand = () => {};
  plugin.registerView = (type, factory) => views.set(type, factory);
  plugin.app = { workspace: { detachLeavesOfType() {} } };
  plugin.cleanupProtectedSkillRuntime = () => {};
  plugin.manifest = { version: "test" };
  return { plugin, views };
}

test("plugin load registers recoverable views and returns before slow journal recovery", async () => {
  const { plugin, views } = fixture();
  const hydration = deferred();
  plugin.loadData = () => hydration.promise;
  plugin._initializeWorkbench = () => hydration.promise;
  const loading = plugin.onload();
  const returned = await Promise.race([Promise.resolve(loading).then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
  assert.equal(returned, true, "Obsidian plugin load must not await journal recovery");
  assert.equal(views.size, 4);
  assert.equal(plugin.startupReady, false);
  assert.ok(plugin.startupPromise);
  hydration.resolve();
  await plugin.startupPromise;
});

test("state cannot be saved before recovery has completed", async () => {
  const { plugin } = fixture();
  let writes = 0;
  plugin.startupReady = false;
  plugin.saveData = async () => { writes++; };
  await assert.rejects(plugin.saveWorkbenchState({}), /启动|恢复/u);
  assert.equal(writes, 0);
});

test("unloading during a pending read prevents late runtime initialization", async () => {
  const { plugin } = fixture();
  const read = deferred();
  plugin.loadData = () => read.promise;
  const loading = plugin.onload();
  if (!plugin.startupPromise) {
    read.resolve({});
    await loading;
    assert.fail("plugin must expose a cancellable recovery task");
  }
  await loading;
  plugin.onunload();
  read.resolve({});
  await plugin.startupPromise;
  assert.equal(plugin.startupReady, false);
  assert.equal(plugin.workbenchRuntime, undefined);
  assert.equal(plugin.startupFailure, null);
});

test("background recovery failure retains a diagnostic code without saving data", async () => {
  const { plugin, views } = fixture();
  plugin.loadData = async () => { throw Object.assign(new Error("synthetic read failure"), { code: "SYNTHETIC_FAILURE" }); };
  await plugin.onload();
  await plugin.startupPromise;
  assert.equal(plugin.startupReady, false);
  assert.equal(plugin.startupFailure.code, "SYNTHETIC_FAILURE");
  assert.equal(views.size, 4);
});

test("pending view restores the original page and page state after successful recovery", async () => {
  const { plugin, views } = fixture();
  const recovery = deferred();
  plugin._initializeWorkbench = async () => { await recovery.promise; plugin.startupReady = true; };
  await plugin.onload();
  const type = [...views.keys()][0];
  const restored = [];
  const leaf = { setViewState: async state => { restored.push(state); leaf.view = { getViewType: () => state.type }; } };
  const view = views.get(type)(leaf);
  leaf.view = view;
  await view.setState({ section: "chat", scrollTop: 32 });
  await view.onOpen();
  recovery.resolve();
  await plugin.startupPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.length, 2);
  assert.equal(restored[1].type, type);
  assert.deepEqual(restored[1].state, { section: "chat", scrollTop: 32 });
});

test("closing a pending view leaves the user's replacement page alone", async () => {
  const { plugin, views } = fixture();
  const recovery = deferred();
  plugin._initializeWorkbench = async () => { await recovery.promise; plugin.startupReady = true; };
  await plugin.onload();
  let replacements = 0;
  const leaf = { setViewState: async () => { replacements++; } };
  const view = [...views.values()][0](leaf);
  leaf.view = view;
  await view.onOpen();
  await view.onClose();
  recovery.resolve();
  await plugin.startupPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replacements, 0);
});

test("normal unload can still persist an interrupted answer after successful recovery", async () => {
  const { plugin } = fixture();
  let writes = 0;
  plugin.startupReady = true;
  plugin.startupFailure = null;
  plugin.startupCancelled = true;
  plugin.saveData = async () => { writes++; };
  await plugin.saveWorkbenchState({});
  assert.equal(writes, 1);
});

test("a failed real view restoration falls back to a retryable recovery view", async () => {
  const { plugin, views } = fixture();
  const recovery = deferred();
  plugin._initializeWorkbench = async () => { await recovery.promise; plugin.startupReady = true; };
  await plugin.onload();
  const type = [...views.keys()][0];
  let failureInjected = false;
  const leaf = { setViewState: async state => {
    if (state.type === "empty") { leaf.view = { getViewType: () => "empty" }; return; }
    if (!failureInjected) { failureInjected = true; throw new Error("synthetic view construction error"); }
    leaf.view = views.get(state.type)(leaf);
    await leaf.view.setState(state.state);
    await leaf.view.onOpen();
  } };
  leaf.view = views.get(type)(leaf);
  await leaf.view.setState({ page: "home" });
  await leaf.view.onOpen();
  recovery.resolve();
  await plugin.startupPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failureInjected, true);
  assert.equal(plugin.startupFailure, null);
  assert.equal(plugin.startupViewErrors.has(leaf), true);
  assert.deepEqual(leaf.view.getState(), { page: "home" });
  assert.equal(typeof leaf.view.restoreOriginalView, "function");
});

test("Judgment Kernel addon waits for recovery without holding Obsidian plugin load", async () => {
  const ready = deferred();
  let installed = 0;
  class Plugin { async onload() { this.startupPromise = ready.promise; this.startupReady = false; } }
  const source = fs.readFileSync(path.join(__dirname, "../bundler/suffix.txt"), "utf8").split("// XINGZHI_JUDGMENT_KERNEL_V3_BEGIN")[1];
  vm.runInNewContext(source, {
    module: { exports: Plugin }, console,
    __require: () => ({ install: () => { installed++; return { runKernelSelfCheck: () => ({ ok: true }) }; } }),
    __nativeRequire: () => ({}),
  });
  const plugin = new Plugin();
  await plugin.onload();
  assert.equal(installed, 0);
  plugin.startupReady = true;
  ready.resolve();
  await plugin.startupPromise;
  assert.equal(installed, 1);
});
