'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const baseline = require('../docs/installed-baseline.json');
const manifest = require('../manifest.json');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
assert.equal(manifest.version, require('../package.json').version, 'Package and plugin versions agree');
assert.equal(manifest.version, require('../src/release-file-contract.cjs').PLUGIN_VERSION, 'Runtime diagnostic version agrees');
assert.equal(manifest.version, require('../package-lock.json').version, 'Lockfile version agrees');
assert.equal(require('../versions.json')[manifest.version], manifest.minAppVersion, 'Version compatibility is declared');
const localReleaseConfigPath = path.join(root, 'release.local.json');
let authorizationCenter = {configured: false, ok: null};
if (fs.existsSync(localReleaseConfigPath)) {
  const localReleaseConfig = JSON.parse(fs.readFileSync(localReleaseConfigPath, 'utf8'));
  const result = require('../src/authorization-center-sync.cjs').checkAuthorizationCenter({
    projectRoot: root,
    installedPluginRoot: path.resolve(localReleaseConfig.installedPluginRoot),
    authorizationCenterRoot: path.resolve(localReleaseConfig.authorizationCenterRoot),
  });
  assert.equal(result.ok, true, `Desktop authorization center is not synchronized: ${result.issues.join('; ')}`);
  authorizationCenter = {configured: true, ok: true, centerVersion: result.centerVersion};
}
// Preserve the initial installed baseline as historical evidence. New releases
// must reproduce their current source; do not replace the old hashes with new ones.
const layout = require('../bundler/layout.json');
const rebuilt = read('bundler/prefix.txt') + layout.map(item =>
  item.header + read(`src/${item.id.slice(2)}`) + item.separator).join('') + read('bundler/suffix.txt');
assert.equal(read('dist/main.js'), rebuilt, 'Built bundle matches current source exactly');
for (const name of ['manifest.json', 'versions.json']) {
  assert.equal(read(`dist/${name}`), read(name), `Built ${name} matches source`);
}
for (const folder of ['assets', 'companion']) {
  for (const name of fs.readdirSync(path.join(root, folder))) {
    assert.ok(fs.readFileSync(path.join(root, folder, name)).equals(fs.readFileSync(path.join(root, 'dist', name))),
      `Built asset or companion matches source: ${name}`);
  }
}
const hashes = {};
for (const [name, expected] of Object.entries(baseline.expected)) {
  hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', name))).digest('hex');
  if (manifest.version === baseline.version) {
    assert.equal(hashes[name], expected, `Installed-release byte equivalence: ${name}`);
  }
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
console.log(JSON.stringify({passed: true, version: manifest.version, syntaxChecked, relativeImportsChecked,
  sourceBuildEquivalent: true, installedBaselineVersion: baseline.version,
  installedReleaseByteEquivalent: Object.entries(baseline.expected).every(([name, expected]) => hashes[name] === expected),
  authorizationCenter, hashes}));

