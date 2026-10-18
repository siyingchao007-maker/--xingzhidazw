"use strict";

const PROFILE_IDS = Object.freeze(["auto", "fast", "balanced", "deep", "max"]);
const PROFILE_OPTIONS = Object.freeze([
  Object.freeze({ id: "auto", label: "自动", description: "按本轮任务复杂度自动分配" }),
  Object.freeze({ id: "fast", label: "快速", description: "优先速度；简单问答与改写" }),
  Object.freeze({ id: "balanced", label: "标准", description: "速度与分析投入平衡" }),
  Object.freeze({ id: "deep", label: "深度", description: "方案、PATH、多条件分析" }),
  Object.freeze({ id: "max", label: "极致", description: "请求当前模型可用的最高档" }),
]);

const EFFORT_RANK = Object.freeze({ none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 });
const PROFILE_EFFORT = Object.freeze({ fast: "low", balanced: "medium", deep: "high", max: "max" });
const ALLOWED_EFFORTS = new Set(Object.keys(EFFORT_RANK));
const STATUS_IDS = new Set(["sent", "unverified", "degraded", "model-default"]);

function normalizeReasoningProfile(value, fallback = "auto") {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PROFILE_IDS.includes(candidate) ? candidate : fallback;
}

function profileLabel(value) {
  return PROFILE_OPTIONS.find((item) => item.id === normalizeReasoningProfile(value))?.label || "自动";
}

function effortToProfile(value) {
  const effort = String(value || "").toLowerCase();
  if (effort === "none" || effort === "minimal" || effort === "low") return "fast";
  if (effort === "medium") return "balanced";
  if (effort === "high") return "deep";
  if (effort === "xhigh" || effort === "max") return "max";
  return "balanced";
}

function highestSupportedEffort(requested, supported) {
  if (!Array.isArray(supported) || !supported.length) return { effort: requested, changed: false };
  const normalized = [...new Set(supported.map((item) => String(item || "").toLowerCase()).filter((item) => ALLOWED_EFFORTS.has(item)))];
  if (!normalized.length) return { effort: requested, changed: false };
  if (normalized.includes(requested)) return { effort: requested, changed: false };
  const requestedRank = EFFORT_RANK[requested] ?? EFFORT_RANK.high;
  const lower = normalized.filter((item) => EFFORT_RANK[item] <= requestedRank)
    .sort((left, right) => EFFORT_RANK[right] - EFFORT_RANK[left])[0];
  const selected = lower || normalized.sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])[0];
  return { effort: selected, changed: selected !== requested };
}

function normalizeSupportedEfforts(value) {
  if (!Array.isArray(value)) return null;
  const list = [...new Set(value.map((item) => String(item || "").toLowerCase()).filter((item) => ALLOWED_EFFORTS.has(item)))];
  return list.length ? list : null;
}

function inferredOpenAiEfforts(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return null;
  if (/^gpt-5-pro(?:$|[-_.])/u.test(id)) return ["high"];
  if (/^gpt-5\.1-codex-max(?:$|[-_.])/u.test(id)) return ["low", "medium", "high", "xhigh"];
  if (/^gpt-5\.1(?:$|[-_.])/u.test(id)) return ["low", "medium", "high"];
  if (/^gpt-5\.6(?:$|[-_.])/u.test(id)) return ["low", "medium", "high", "xhigh", "max"];
  if (/^gpt-5(?:$|[-_.])/u.test(id) || /^o[1-9](?:$|[-_.])/u.test(id)) return ["low", "medium", "high"];
  return null;
}

function resolveReasoningExecution({
  requestedProfile = "auto",
  requestedSource = "conversation",
  automaticEffort = "high",
  providerId = "codex",
  protocol = "codex-app-server",
  modelId = "",
  supportedEfforts = null,
} = {}) {
  const requested = normalizeReasoningProfile(requestedProfile);
  const automatic = String(automaticEffort || "high").toLowerCase();
  let systemSuggestion = effortToProfile(automatic);
  const isDeepSeek = providerId === "deepseek" && protocol === "openai-chat-completions";
  const deepSeekThinkingFamily = isDeepSeek
    && /^(?:deepseek-flash(?:$|[-_.])|deepseek-v4(?:-[a-z0-9._-]+)?|deepseek-chat|deepseek-reasoner)$/iu.test(String(modelId || "").trim());
  const declaredEfforts = normalizeSupportedEfforts(supportedEfforts);
  const openAiEfforts = providerId === "openai"
    ? (declaredEfforts || inferredOpenAiEfforts(modelId)) : null;
  const isCustom = /^custom(?:-[0-9]{1,3})?$/u.test(providerId);
  const knownSupport = providerId === "codex" || isDeepSeek || isCustom
    || (providerId === "openai" && Boolean(openAiEfforts));

  if (!knownSupport) {
    return {
      version: 1,
      requestedProfile: requested,
      requestedSource,
      systemSuggestion,
      effectiveProfile: "model-default",
      requestEffort: null,
      status: "model-default",
      degradationReason: "当前提供商没有已配置的手动推理档位映射，使用模型默认设置。",
      providerId,
      protocol,
      modelId: String(modelId || "").slice(0, 160),
    };
  }

  const requestedEffort = requested === "auto" ? automatic : PROFILE_EFFORT[requested];
  let requestEffort = requestedEffort;
  let degradationReason = null;

  if (isDeepSeek) {
    // DeepSeek's current API uses none/low/high/max. Its compatibility aliases
    // medium/xhigh are both normalized server-side to high, so never emit them.
    const deepSeekMap = requested === "auto"
      ? ({ none: "none", minimal: "none", low: "none", medium: "high", high: "high", xhigh: "high", max: "max" })
      : ({ low: "none", medium: "low", high: "high", xhigh: "max", max: "max" });
    requestEffort = deepSeekMap[requestedEffort] || "high";
    if (requestEffort === "none") {
      const effectiveProfile = requested === "auto" ? "fast" : requested;
      return {
        version: 1, requestedProfile: requested, requestedSource, systemSuggestion,
        ...(requested === "auto" ? { systemSuggestion: effectiveProfile } : {}),
        effectiveProfile,
        requestEffort: "none", status: "sent", degradationReason: null,
        providerId, protocol, modelId: String(modelId || "").slice(0, 160),
        ...(deepSeekThinkingFamily ? { thinking: "disabled" } : {}),
      };
    }
  } else if (requestEffort === "max" && providerId === "codex") {
    // This plugin's verified App Server range tops out at xhigh.
    requestEffort = "xhigh";
  } else if (requestEffort === "max" && !normalizeSupportedEfforts(supportedEfforts)?.includes("max")) {
    requestEffort = "xhigh";
    degradationReason = "当前模型没有声明支持 max；已改为兼容档 xhigh。";
  }

  const supported = declaredEfforts || openAiEfforts;
  if (supported) {
    const clamped = highestSupportedEffort(requestEffort, supported);
    if (clamped.changed) {
      requestEffort = clamped.effort;
      degradationReason = `模型声明支持的档位不包含所选级别，已降为 ${requestEffort}。`;
    }
  }

  const effectiveProfile = effortToProfile(requestEffort);
  if (requested === "auto") systemSuggestion = effectiveProfile;
  const compatibilityUnverified = isCustom && !supported;
  if (compatibilityUnverified && !degradationReason) {
    degradationReason = "自定义兼容端点未提供档位能力元数据；参数会发送，但服务端是否识别无法验证。";
  }
  return {
    version: 1,
    requestedProfile: requested,
    requestedSource,
    systemSuggestion,
    effectiveProfile,
    requestEffort,
    status: degradationReason ? (compatibilityUnverified ? "unverified" : "degraded") : "sent",
    degradationReason,
    providerId,
    protocol,
    modelId: String(modelId || "").slice(0, 160),
  };
}

function normalizeReasoningExecution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const requestedProfile = normalizeReasoningProfile(value.requestedProfile);
  const effectiveProfile = PROFILE_IDS.includes(value.effectiveProfile) || value.effectiveProfile === "model-default"
    ? value.effectiveProfile : "model-default";
  const requestEffort = ALLOWED_EFFORTS.has(String(value.requestEffort || "").toLowerCase())
    ? String(value.requestEffort).toLowerCase() : null;
  const status = STATUS_IDS.has(value.status) ? value.status : "model-default";
  return {
    version: 1,
    requestedProfile,
    requestedSource: ["conversation", "global-default", "system"].includes(value.requestedSource)
      ? value.requestedSource : "conversation",
    systemSuggestion: normalizeReasoningProfile(value.systemSuggestion),
    effectiveProfile,
    requestEffort,
    status,
    degradationReason: typeof value.degradationReason === "string" ? value.degradationReason.slice(0, 400) : null,
    providerId: typeof value.providerId === "string" ? value.providerId.slice(0, 80) : "",
    protocol: typeof value.protocol === "string" ? value.protocol.slice(0, 80) : "",
    modelId: typeof value.modelId === "string" ? value.modelId.slice(0, 160) : "",
    ...(value.thinking === "disabled" ? { thinking: "disabled" } : {}),
  };
}

function reasoningExecutionLabel(value) {
  const execution = normalizeReasoningExecution(value);
  if (!execution) return "";
  if (execution.status === "model-default") return "模型默认 · 未开放手动档位";
  const requested = profileLabel(execution.requestedProfile);
  const effective = execution.effectiveProfile === "model-default" ? "模型默认" : profileLabel(execution.effectiveProfile);
  const suffix = execution.status === "degraded" ? " · 已降级" : execution.status === "unverified" ? " · 兼容性未验证" : " · 参数已发送";
  return `${requested === "自动" ? `自动→${effective}` : requested}${requested !== "自动" && requested !== effective ? `→${effective}` : ""}${suffix}`;
}

module.exports = {
  PROFILE_IDS,
  PROFILE_OPTIONS,
  inferredOpenAiEfforts,
  effortToProfile,
  normalizeReasoningExecution,
  normalizeReasoningProfile,
  profileLabel,
  reasoningExecutionLabel,
  resolveReasoningExecution,
};
