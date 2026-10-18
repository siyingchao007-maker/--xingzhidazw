'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function createLoader() {
  const cache = new Map();
  const deny = name => () => { throw new Error(`External operation forbidden in offline test: ${name}`); };
  const denied = new Proxy({}, {get: (_, key) => key === 'promises' ? denied : deny(String(key))});
  class HostClass {}
  const host = new Proxy({Modal: HostClass, SuggestModal: HostClass, FuzzySuggestModal: HostClass,
    ItemView: HostClass, Component: HostClass, Plugin: HostClass},
    {get: (object, key) => key in object ? object[key] : deny(`obsidian.${String(key)}`)});
  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    if (id === 'obsidian') return host;
    if (['fs', 'node:fs', 'node:fs/promises', 'node:child_process', 'node:http', 'node:https', 'node:net'].includes(id)) return denied;
    if (['node:crypto', 'node:path', 'path', 'node:events', 'node:os', 'os', 'node:zlib', 'node:string_decoder', 'node:util'].includes(id)) return require(id);
    assert.match(id, /^\.\/[a-z0-9-]+\.cjs$/u);
    const source = ['src', 'companion'].map(folder => path.join(root, folder, id.slice(2))).find(file => fs.existsSync(file));
    assert.ok(source, `Local module exists: ${id}`);
    let body = fs.readFileSync(source, 'utf8');
    if (id === './workbench-runtime.cjs') body += '\nmodule.exports.__controlledSkillTest = {dynamicToolSpecs, providerToolSpecs};';
    const module = {exports: {}}; cache.set(id, module);
    const factory = vm.runInNewContext(`(function(module,exports,require){\n${body}\n})`, {
      Buffer, console, structuredClone, AbortController, TextEncoder, TextDecoder, URL,
      setTimeout, clearTimeout, process: {platform: process.platform, env: {}},
    }, {filename: id});
    factory(module, module.exports, load);
    return module.exports;
  }
  return load;
}
module.exports = {createLoader};
