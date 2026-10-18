"use strict";

const { canonicalProviderModelId } = require("./provider-models.cjs");

function normalizedModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function configuredModels(providerConfigs = {}) {
  const owners = new Map();
  if (!providerConfigs || typeof providerConfigs !== "object" || Array.isArray(providerConfigs)) return owners;
  for (const [providerId, config] of Object.entries(providerConfigs)) {
    const model = canonicalProviderModelId(providerId, config?.model);
    if (!model) continue;
    if (!owners.has(model)) owners.set(model, new Set());
    owners.get(model).add(providerId);
  }
  return owners;
}

function discoveredModels(models = []) {
  const owners = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const providerId = typeof model?.providerId === "string" ? model.providerId.trim() : "";
    const id = canonicalProviderModelId(providerId, model?.id);
    if (!id || !providerId) continue;
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(providerId);
  }
  return owners;
}

function modelOwner(model, providerConfigs, models) {
  const id = normalizedModel(model);
  if (!id) return null;
  const owners = new Set([
    ...(configuredModels(providerConfigs).get(id) || []),
    ...(discoveredModels(models).get(id) || []),
  ]);
  return owners.size === 1 ? [...owners][0] : null;
}

function defaultModelForProvider(providerId, providerConfigs, models) {
  const discovered = (Array.isArray(models) ? models : [])
    .filter((model) => model?.providerId === providerId && normalizedModel(model.id));
  const preferred = discovered.find((model) => model.isDefault === true) || discovered[0];
  return normalizedModel(preferred?.id) || normalizedModel(providerConfigs?.[providerId]?.model);
}

// Codex（本地 app-server / ChatGPT 账号）只接受自己通告的模型。其它提供商的模型名一旦
// 残留进来，Codex 会直接拒绝整轮请求：
//   {"detail":"The '<model>' model is not supported when using Codex with a ChatGPT account."}
// 因此对 codex 做一次显式兼容性判定，而不是只依赖 modelOwner 的“唯一归属”推断。
const NON_CODEX_MODEL_PREFIX = /^(claude|deepseek|kimi|moonshot|gemini|qwen|glm|grok|llama|mistral|doubao|ernie|hunyuan|spark|abab|minimax|step|phi|yi)[-_.]/i;

function looksLikeNonCodexModel(model) {
  const id = normalizedModel(model);
  return Boolean(id) && NON_CODEX_MODEL_PREFIX.test(id);
}

// 返回对 codex 确认可用的模型；无法确认可用时返回 null（由调用方回落到 Codex 自身默认模型）。
function codexCompatibleModel(model, providerConfigs, models) {
  const requested = normalizedModel(model);
  if (!requested) return null;
  const available = (Array.isArray(models) ? models : [])
    .filter((item) => item?.providerId === "codex")
    .map((item) => normalizedModel(item?.id))
    .filter(Boolean);
  // 已发现 Codex 模型列表时以其为准，这是最权威的判据。
  if (available.length) return available.includes(requested) ? requested : null;
  // 尚未发现模型时退化为保守推断：已被其它提供商认领、或属于明确的非 Codex 模型族，一律判为不兼容。
  const owner = modelOwner(requested, providerConfigs, models);
  if (owner && owner !== "codex") return null;
  if (looksLikeNonCodexModel(requested)) return null;
  return requested;
}

function normalizeProviderSelection(input = {}) {
  const providerId = typeof input.providerId === "string" && input.providerId.trim()
    ? input.providerId.trim() : "codex";
  const engine = providerId === "codex" ? "codex-app-server" : "provider-api";
  const originalModel = normalizedModel(input.model);
  let model = canonicalProviderModelId(providerId, originalModel);
  let repaired = (input.engine != null && input.engine !== engine) || model !== originalModel;
  const owner = modelOwner(model, input.providerConfigs, input.models);
  if (owner && owner !== providerId) {
    model = defaultModelForProvider(providerId, input.providerConfigs, input.models);
    repaired = true;
  }
  // codex 的严格校验：modelOwner 只在模型能“唯一归属”到某个提供商时才返回结果，
  // 冷启动（未发现模型）或提供商配置里模型为空时它会返回 null，从而漏过错配。
  if (providerId === "codex" && model && !codexCompatibleModel(model, input.providerConfigs, input.models)) {
    model = defaultModelForProvider("codex", input.providerConfigs, input.models);
    repaired = true;
  }
  if (input.enforceDiscovered === true) {
    const available = (Array.isArray(input.models) ? input.models : [])
      .filter((item) => item?.providerId === providerId)
      .map((item) => normalizedModel(item?.id))
      .filter(Boolean);
    if (available.length && model && !available.includes(model)) {
      model = defaultModelForProvider(providerId, input.providerConfigs, input.models);
      repaired = true;
    }
  }
  if (model !== originalModel) repaired = true;
  return { providerId, engine, model, repaired };
}

function resolveProviderSelectionPatch(current = {}, patch = {}, options = {}) {
  const currentProviderId = typeof current.providerId === "string" && current.providerId.trim()
    ? current.providerId.trim() : "codex";
  const providerId = typeof patch.providerId === "string" && patch.providerId.trim()
    ? patch.providerId.trim() : currentProviderId;
  const providerChanged = providerId !== currentProviderId;
  const requestedModel = Object.hasOwn(patch, "model") ? normalizedModel(patch.model) : undefined;
  const model = providerChanged && requestedModel == null
    ? defaultModelForProvider(providerId, options.providerConfigs, options.models)
    : requestedModel === undefined
      ? normalizedModel(current.model)
      : requestedModel;
  const normalized = normalizeProviderSelection({
    providerId,
    model,
    providerConfigs: options.providerConfigs,
    models: options.models,
    enforceDiscovered: options.enforceDiscovered === true,
  });
  return {
    ...normalized,
    repaired: normalized.repaired || providerChanged,
  };
}

module.exports = {
  defaultModelForProvider,
  modelOwner,
  normalizeProviderSelection,
  resolveProviderSelectionPatch,
};
