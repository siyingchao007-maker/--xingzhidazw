"use strict";

const WRITE_METHODS = new Set([
  "create", "createBinary", "modify", "process", "rename", "trashMarkdown", "deletePermanent", "ensureFolder",
]);

function createCommercialVaultGate(adapter, requireLicense) {
  if (!adapter || typeof requireLicense !== "function") throw new Error("商业版写入保护配置无效");
  return Object.freeze(Object.fromEntries(Object.entries(adapter).map(([name, method]) => [
    name,
    WRITE_METHODS.has(name) && typeof method === "function"
      ? (...args) => { requireLicense(); return method(...args); }
      : method,
  ])));
}

module.exports = { createCommercialVaultGate };
