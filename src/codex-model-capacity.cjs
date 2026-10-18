"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function capacityFromCatalog(catalog, config, model, now = Date.now()) {
  const fetchedAt = Date.parse(catalog?.fetched_at);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt < -60_000 || now - fetchedAt > 3_600_000) return null;
  if (config?.model_provider && config.model_provider !== "openai") return null;
  const row = Array.isArray(catalog?.models) ? catalog.models.find(item => item.slug === model) : null;
  if (!Number.isSafeInteger(row?.context_window) || row.context_window < 16384 || row.context_window > 100_000_000) return null;
  const override = config?.model_context_window;
  if (override != null && (!Number.isSafeInteger(override) || override <= 0)) return null;
  return { contextWindowTokens: Math.floor(Math.min(row.context_window, override || row.context_window) * 0.9),
    contextWindowSource: "codex-cache-effective", observedAt: catalog.fetched_at };
}

async function readCodexModelCapacity(client, model) {
  if (typeof model !== "string" || !model || typeof client?._request !== "function") return null;
  try {
    const response = await client._request("config/read", { includeLayers: false });
    const codexHome = client.environment?.CODEX_HOME || path.join(os.homedir(), ".codex");
    const file = path.join(codexHome, "models_cache.json");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    const catalog = JSON.parse(await fs.readFile(file, "utf8"));
    // Return only capacity metadata. Never retain the cache identity or effective configuration.
    return capacityFromCatalog(catalog, response?.config, model);
  } catch { return null; }
}

module.exports = { capacityFromCatalog, readCodexModelCapacity };