'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const layout = JSON.parse(read('bundler/layout.json'));
let output = read('bundler/prefix.txt');
for (const item of layout) {
  assert.match(item.id, /^\.\/[a-z0-9-]+\.cjs$/u);
  output += item.header + read(`src/${item.id.slice(2)}`) + item.separator;
}
output += read('bundler/suffix.txt');
fs.mkdirSync(dist, {recursive: true});
fs.writeFileSync(path.join(dist, 'main.js'), output);
for (const name of ['manifest.json', 'versions.json']) fs.copyFileSync(path.join(root, name), path.join(dist, name));
for (const folder of ['companion', 'assets']) {
  for (const name of fs.readdirSync(path.join(root, folder))) {
    assert.match(name, /\.(?:cjs|css|png)$/u);
    fs.copyFileSync(path.join(root, folder, name), path.join(dist, name));
  }
}
console.log(JSON.stringify({version: JSON.parse(read('manifest.json')).version, modules: layout.length, output: 'dist/'}));
