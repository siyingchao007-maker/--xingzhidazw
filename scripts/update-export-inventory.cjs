"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const inventoryPath = path.join(root, "docs", "export-inventory.json");
const previous = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const byPath = new Map(previous.map(entry => [entry.path, entry]));
const additional = [
  "release.local.example.json",
  "scripts/authorization-center.cjs",
  "scripts/update-export-inventory.cjs",
  "src/authorization-center-sync.cjs",
  "tests/authorization-center-sync.test.cjs",
];
for (const file of additional) {
  if (!byPath.has(file)) byPath.set(file, { path: file, origin: "portable-project-tooling" });
}
const next = [...byPath.values()].map(entry => {
  const file = path.join(root, entry.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`清单文件不存在：${entry.path}`);
  const bytes = fs.readFileSync(file);
  return {
    path: entry.path,
    origin: entry.origin,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}).sort((a, b) => a.path.localeCompare(b.path, "en"));
fs.writeFileSync(inventoryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ updated: true, files: next.length, output: "docs/export-inventory.json" }));
