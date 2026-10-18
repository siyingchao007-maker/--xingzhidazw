"use strict";

const DEEPSEEK_MODEL_ALIASES = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
});

const PROVIDER_MODEL_METADATA = Object.freeze({
  deepseek: Object.freeze({
    "deepseek-flash": Object.freeze({
      label: "DeepSeek V4.1 Flash",
      description: "DeepSeek V4.1 Flash；官方 API 模型 ID 为 deepseek-flash，支持多模态、思考模式与 1M 上下文。",
      isDefault: true,
    }),
    "deepseek-v4-pro": Object.freeze({
      label: "DeepSeek V4 Pro",
      description: "DeepSeek V4 Pro；支持思考模式、工具调用与 1M 上下文。",
      isDefault: false,
    }),
  }),
});

function cleanModelId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalProviderModelId(providerId, value) {
  const id = cleanModelId(value);
  if (!id) return null;
  if (providerId === "deepseek") return DEEPSEEK_MODEL_ALIASES[id.toLowerCase()] || id;
  return id;
}

function decorateProviderModels(providerId, models = []) {
  const decorated = [];
  const seen = new Set();
  const metadata = PROVIDER_MODEL_METADATA[providerId] || {};
  for (const input of Array.isArray(models) ? models : []) {
    const id = canonicalProviderModelId(providerId, input?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = metadata[id] || null;
    decorated.push({
      ...input,
      id,
      label: known?.label || input?.label || id,
      description: known?.description || input?.description || "",
      isDefault: known ? known.isDefault === true : input?.isDefault === true,
    });
  }
  return decorated.sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return 0;
  });
}

function usesDeepSeekV4Family(providerId, modelId) {
  if (providerId !== "deepseek") return false;
  const canonical = canonicalProviderModelId(providerId, modelId);
  return canonical === "deepseek-flash" || /^deepseek-v4(?:-|$)/iu.test(canonical || "");
}

module.exports = {
  DEEPSEEK_MODEL_ALIASES,
  PROVIDER_MODEL_METADATA,
  canonicalProviderModelId,
  decorateProviderModels,
  usesDeepSeekV4Family,
};
