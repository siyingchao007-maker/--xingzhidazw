'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const deniedName = /^(?:data\.json(?:\..*)?|capabilities\.xcap|auth\.json|tokens\.json|state\.json|conversation\.json|\.env(?:\..*)?)$|\.(?:pem|key|p12|sqlite|db)$/iu;
const findings = [], warnings = [];
const checks = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u],
  ['provider-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}/u],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/u],
];
let files = 0, bytes = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (['.git', 'dist', 'node_modules', 'reports'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { findings.push({path: relative, reason: 'symlink'}); continue; }
    if (entry.isDirectory()) { walk(file); continue; }
    files++; const buffer = fs.readFileSync(file); bytes += buffer.length;
    if (deniedName.test(entry.name)) findings.push({path: relative, reason: 'private-state-filename'});
    if (buffer.length >= 100 * 1024 * 1024) findings.push({path: relative, reason: 'oversize'});
    let source;
    if (/\.png$/iu.test(entry.name)) {
      const texts = [];
      for (let cursor = 8; cursor + 12 <= buffer.length;) {
        const length = buffer.readUInt32BE(cursor), type = buffer.toString('ascii', cursor + 4, cursor + 8);
        if (cursor + 12 + length > buffer.length) { findings.push({path: relative, reason: 'invalid-png-chunk'}); break; }
        if (['tEXt', 'iTXt', 'eXIf'].includes(type)) texts.push(buffer.subarray(cursor + 8, cursor + 8 + length).toString('utf8'));
        if (type === 'zTXt') {
          const data = buffer.subarray(cursor + 8, cursor + 8 + length), boundary = data.indexOf(0);
          try { texts.push(require('node:zlib').inflateSync(data.subarray(boundary + 2)).toString('utf8')); }
          catch { findings.push({path: relative, reason: 'unreadable-compressed-png-text'}); }
        }
        cursor += 12 + length;
      }
      source = texts.join('\n');
    } else source = buffer.toString('utf8');
    for (const [reason, pattern] of checks) if (pattern.test(source)) findings.push({path: relative, reason});
    if (/[A-Z]:[\\/](?:Users|用户)[\\/][^\s/\\]+/iu.test(source)) warnings.push({path: relative, reason: 'absolute-user-path'});
    if (/[a-z0-9._%+-]+@(?:gmail|qq|163|outlook|hotmail)\.com/iu.test(source)) warnings.push({path: relative, reason: 'personal-email-pattern'});
  }
}
walk(root);
const report = {passed: findings.length === 0, files, bytes, findings, warnings,
  scope: 'Allowlisted export, including PNG text metadata; pattern-based checks are not proof of absence of all private content. Brand asset origin and a representative brand board were reviewed; not a visual or copyright audit of every image.'};
fs.mkdirSync(path.join(root, 'reports'), {recursive: true});
fs.writeFileSync(path.join(root, 'reports/security-scan.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
