'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const baseline = require('../docs/installed-baseline.json');
const hashes = {};
for (const [name, expected] of Object.entries(baseline.expected)) {
  hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', name))).digest('hex');
  assert.equal(hashes[name], expected, `Installed-release byte equivalence: ${name}`);
}
let syntaxChecked = 0;
for (const folder of ['src', 'companion', 'scripts', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, folder)).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(root, folder, name), 'utf8');
    new vm.Script(`(function(module,exports,require,__dirname,__filename){\n${source}\n})`, {filename: `${folder}/${name}`});
    syntaxChecked++;
  }
}
new vm.Script(fs.readFileSync(path.join(root, 'dist/main.js'), 'utf8'));
const localIds = new Set(require('../bundler/layout.json').map(item => item.id));
let relativeImportsChecked = 0;
for (const folder of ['src', 'companion']) {
  for (const name of fs.readdirSync(path.join(root, folder)).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(root, folder, name), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.\/[^'"]+\.cjs)['"]\s*\)/gu)) {
      assert.ok(localIds.has(match[1]) || fs.existsSync(path.join(root, 'companion', match[1])), `Missing local import: ${name}: ${match[1]}`);
      relativeImportsChecked++;
    }
  }
}
console.log(JSON.stringify({passed: true, syntaxChecked, relativeImportsChecked, installedReleaseByteEquivalent: true, hashes}));
