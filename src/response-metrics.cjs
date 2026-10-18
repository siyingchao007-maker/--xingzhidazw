"use strict";

const MAX_DURATION_MS = 24 * 60 * 60_000;
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function exactCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nestedCount(value, ...paths) {
  for (const path of paths) {
    let current = value;
    for (const segment of path) current = current?.[segment];
    const count = exactCount(current);
    if (count !== null) return count;
  }
  return null;
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTokens = nestedCount(value, ["inputTokens"], ["input_tokens"], ["prompt_tokens"]);
  const outputTokens = nestedCount(value, ["outputTokens"], ["output_tokens"], ["completion_tokens"]);
  const reportedTotal = nestedCount(value, ["totalTokens"], ["total_tokens"]);
  const totalTokens = reportedTotal !== null
    ? reportedTotal
    : (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: nestedCount(
      value,
      ["cachedInputTokens"],
      ["cached_input_tokens"],
      ["prompt_cache_hit_tokens"],
      ["input_tokens_details", "cached_tokens"],
      ["prompt_tokens_details", "cached_tokens"],
    ),
    reasoningTokens: nestedCount(
      value,
      ["reasoningTokens"],
      ["reasoningOutputTokens"],
      ["reasoning_output_tokens"],
      ["output_tokens_details", "reasoning_tokens"],
      ["completion_tokens_details", "reasoning_tokens"],
    ),
  };
}

function sumExactTokenUsage(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const normalized = values.map(normalizeTokenUsage);
  if (normalized.some((usage) => usage === null)) return null;
  const sumField = (field) => normalized.every((usage) => usage[field] !== null)
    ? normalized.reduce((total, usage) => total + usage[field], 0)
    : null;
  const result = {
    inputTokens: sumField("inputTokens"),
    outputTokens: sumField("outputTokens"),
    totalTokens: sumField("totalTokens"),
    cachedInputTokens: sumField("cachedInputTokens"),
    reasoningTokens: sumField("reasoningTokens"),
  };
  return Object.values(result).every((value) => value === null || Number.isSafeInteger(value))
    ? result : null;
}

function subtractExactTokenUsage(totalValue, baselineValue) {
  const total = normalizeTokenUsage(totalValue);
  const baseline = normalizeTokenUsage(baselineValue);
  if (!total || !baseline) return null;
  const subtractField = (field) => {
    if (total[field] === null || baseline[field] === null) return null;
    const difference = total[field] - baseline[field];
    return Number.isSafeInteger(difference) && difference >= 0 ? difference : Number.NaN;
  };
  const result = {
    inputTokens: subtractField("inputTokens"),
    outputTokens: subtractField("outputTokens"),
    totalTokens: subtractField("totalTokens"),
    cachedInputTokens: subtractField("cachedInputTokens"),
    reasoningTokens: subtractField("reasoningTokens"),
  };
  return Object.values(result).some(Number.isNaN) ? null : result;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsed(start, end) {
  const beginning = timestamp(start);
  const finished = timestamp(end);
  if (beginning === null || finished === null || finished < beginning) return null;
  return Math.min(MAX_DURATION_MS, Math.round(finished - beginning));
}

function safeDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS
    ? Math.round(value) : null;
}

function safeContextCount(value, maximum = 64 * 1024 * 1024) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : "", "utf8");
}

function normalizeLocalRequestContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    freshThread: value.freshThread === true,
    baseInstructionsBytes: safeContextCount(value.baseInstructionsBytes),
    userTurnBytes: safeContextCount(value.userTurnBytes),
    turnControlBytes: safeContextCount(value.turnControlBytes),
    sentTextBytes: safeContextCount(value.sentTextBytes),
    skillInputCount: safeContextCount(value.skillInputCount, 64),
    visualInputCount: safeContextCount(value.visualInputCount, 64),
  };
}

function measureLocalRequestContext({
  freshThread = false,
  baseInstructions = "",
  turnText = "",
  additions = [],
  inputs = [],
  visualAttachments = [],
} = {}) {
  const controlText = (Array.isArray(additions) ? additions : [])
    .filter((item) => typeof item === "string" && item)
    .join("\n\n");
  const sentTextBytes = (Array.isArray(inputs) ? inputs : []).reduce((total, input) => (
    input?.type === "text" ? total + utf8Bytes(input.text) : total
  ), 0);
  return normalizeLocalRequestContext({
    freshThread,
    baseInstructionsBytes: utf8Bytes(baseInstructions),
    userTurnBytes: utf8Bytes(turnText),
    turnControlBytes: utf8Bytes(controlText),
    sentTextBytes,
    skillInputCount: (Array.isArray(inputs) ? inputs : []).filter((input) => input?.type === "skill").length,
    visualInputCount: (Array.isArray(visualAttachments) ? visualAttachments : []).length,
  });
}

function normalizeResponseMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const totalMs = safeDuration(value.totalMs);
  if (totalMs === null) return null;
  const contextWindow = value.contextWindow && typeof value.contextWindow === "object"
    && Number.isSafeInteger(value.contextWindow.inputTokens) && value.contextWindow.inputTokens >= 0
    && Number.isSafeInteger(value.contextWindow.modelContextWindow) && value.contextWindow.modelContextWindow > 0
    && Number.isFinite(value.contextWindow.inputContextRatio)
    && ["normal", "soft", "hard"].includes(value.contextWindow.pressure)
    ? {
        inputTokens: value.contextWindow.inputTokens,
        modelContextWindow: value.contextWindow.modelContextWindow,
        inputContextRatio: Math.max(0, Math.min(1, value.contextWindow.inputContextRatio)),
        pressure: value.contextWindow.pressure,
      }
    : null;
  const localContext = normalizeLocalRequestContext(value.localContext);
  return {
    version: 1,
    totalMs,
    routingMs: safeDuration(value.routingMs),
    retrievalMs: safeDuration(value.retrievalMs),
    thinkingMs: safeDuration(value.thinkingMs),
    generationMs: safeDuration(value.generationMs),
    tokenUsage: normalizeTokenUsage(value.tokenUsage),
    ...(contextWindow ? { contextWindow } : {}),
    ...(localContext ? { localContext } : {}),
  };
}

function finalizeResponseMetrics(active, completedAt, tokenUsage = null) {
  const totalMs = elapsed(active?.startedAt, completedAt);
  if (totalMs === null) return null;
  const modelEnd = active?.firstOutputAt || completedAt;
  return normalizeResponseMetrics({
    version: 1,
    totalMs: elapsed(active?.requestStartedAt || active?.startedAt, completedAt) ?? totalMs,
    routingMs: elapsed(active?.requestStartedAt, active?.routingCompletedAt),
    retrievalMs: elapsed(active?.retrievalStartedAt, active?.retrievalCompletedAt),
    thinkingMs: elapsed(active?.modelStartedAt, modelEnd),
    generationMs: active?.firstOutputAt ? elapsed(active.firstOutputAt, completedAt) : null,
    tokenUsage,
    contextWindow: active?.contextWindow || null,
    localContext: active?.localContext || null,
  });
}

function formatDuration(value) {
  const milliseconds = safeDuration(value);
  if (milliseconds === null) return "未记录";
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} 秒`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatLiveDuration(startedAt, now = Date.now()) {
  const beginning = timestamp(startedAt);
  const current = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  return formatDuration(beginning === null ? null : Math.max(0, current - beginning));
}

function formatTokenUsage(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return "Token 未返回";
  const details = [];
  const input = normalized.inputTokens;
  const cached = normalized.cachedInputTokens;
  const output = normalized.outputTokens;
  const reasoning = normalized.reasoningTokens;
  if (input !== null) {
    let inputDetail = `输入 ${TOKEN_FORMATTER.format(input)}`;
    if (cached !== null && cached <= input) {
      inputDetail += `（缓存 ${TOKEN_FORMATTER.format(cached)}，非缓存输入 ${TOKEN_FORMATTER.format(input - cached)}）`;
    } else if (cached !== null) {
      inputDetail += `（缓存输入报告 ${TOKEN_FORMATTER.format(cached)}，高于输入）`;
    }
    details.push(inputDetail);
  }
  if (output !== null) {
    const outputDetail = `输出 ${TOKEN_FORMATTER.format(output)}`;
    if (reasoning !== null && reasoning <= output) {
      details.push(`${outputDetail}（其中推理 ${TOKEN_FORMATTER.format(reasoning)}）`);
    } else if (reasoning !== null) {
      details.push(`${outputDetail}（推理输出报告 ${TOKEN_FORMATTER.format(reasoning)}，高于输出）`);
    } else {
      details.push(outputDetail);
    }
  }
  if (reasoning !== null && output === null) details.push(`推理输出 ${TOKEN_FORMATTER.format(reasoning)}`);
  if (cached !== null && input === null) details.push(`缓存输入 ${TOKEN_FORMATTER.format(cached)}`);
  return `Token 本轮累计 ${TOKEN_FORMATTER.format(normalized.totalTokens)}${details.length ? `（${details.join("；")}）` : ""}`;
}

function buildResponseMetricsSummary(value) {
  const metrics = normalizeResponseMetrics(value);
  if (!metrics) return null;
  const stages = [];
  if (metrics.routingMs !== null) stages.push(`能力路由 ${formatDuration(metrics.routingMs)}`);
  if (metrics.retrievalMs !== null) stages.push(`知识检索 ${formatDuration(metrics.retrievalMs)}`);
  if (metrics.thinkingMs !== null) stages.push(`思考等待 ${formatDuration(metrics.thinkingMs)}`);
  if (metrics.generationMs !== null) stages.push(`生成回复 ${formatDuration(metrics.generationMs)}`);
  return {
    total: `总耗时 ${formatDuration(metrics.totalMs)}`,
    stages,
    token: formatTokenUsage(metrics.tokenUsage),
    tokenAvailable: metrics.tokenUsage !== null,
  };
}

module.exports = {
  buildResponseMetricsSummary,
  finalizeResponseMetrics,
  formatDuration,
  formatLiveDuration,
  measureLocalRequestContext,
  normalizeLocalRequestContext,
  normalizeResponseMetrics,
  normalizeTokenUsage,
  subtractExactTokenUsage,
  sumExactTokenUsage,
};
