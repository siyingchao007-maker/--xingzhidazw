"use strict";

const { normalizeTokenUsage } = require("./response-metrics.cjs");

const SOFT_CONTEXT_RATIO = 0.40;
const HARD_CONTEXT_RATIO = 0.55;
const SOFT_CONTEXT_LIMIT_BYTES = 128 * 1024;
const SOFT_CONTEXT_TARGET_BYTES = 80 * 1024;
const HARD_CONTEXT_LIMIT_BYTES = 96 * 1024;
const HARD_CONTEXT_TARGET_BYTES = 64 * 1024;

function reasoningEffortForTurn({
  taskLevel = "T1_FOCUSED",
  deliverable = "analysis",
  knowledgeWorkflow = "none",
  internalArchive = false,
  internalBackgroundAnalysis = false,
} = {}) {
  if (internalBackgroundAnalysis) return "medium";
  if (internalArchive || knowledgeWorkflow !== "none") return "high";
  if (taskLevel === "T0_DIRECT") return "medium";
  if (taskLevel === "T1_FOCUSED") return "high";
  if (taskLevel === "T2_JUDGMENT" || taskLevel === "T3_PANEL") return "xhigh";
  if (taskLevel === "T4_GATED") {
    return ["decision-evaluation", "multi-perspective-analysis"].includes(deliverable)
      ? "xhigh" : "high";
  }
  return "high";
}

function safeWindow(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function threadContextUsage(tokenUsage = {}) {
  const last = normalizeTokenUsage(tokenUsage?.last);
  const modelContextWindow = safeWindow(tokenUsage?.modelContextWindow);
  if (!last || last.inputTokens === null || !modelContextWindow) return null;
  const inputContextRatio = Math.max(0, Math.min(1, last.inputTokens / modelContextWindow));
  const pressure = inputContextRatio >= HARD_CONTEXT_RATIO
    ? "hard"
    : inputContextRatio >= SOFT_CONTEXT_RATIO ? "soft" : "normal";
  return {
    inputTokens: last.inputTokens,
    modelContextWindow,
    inputContextRatio,
    pressure,
  };
}

function contextCompactionOptions(usage) {
  if (usage?.pressure === "hard") {
    return {
      force: true,
      limitBytes: HARD_CONTEXT_LIMIT_BYTES,
      targetBytes: HARD_CONTEXT_TARGET_BYTES,
    };
  }
  if (usage?.pressure === "soft") {
    return {
      force: true,
      limitBytes: SOFT_CONTEXT_LIMIT_BYTES,
      targetBytes: SOFT_CONTEXT_TARGET_BYTES,
    };
  }
  return null;
}

function knowledgeSearchBudgetForTurn({
  prefetched = false,
  prefetchHits = 0,
  internalArchive = false,
} = {}) {
  if (internalArchive) return 0;
  // A hit is not proof of coverage. Keep room to follow multiple information needs.
  return 6;
}

function providerToolRoundBudget({ taskLevel = "T1_FOCUSED", internalArchive = false } = {}) {
  if (internalArchive) return 2;
  return ["T2_JUDGMENT", "T3_PANEL", "T4_GATED"].includes(taskLevel) ? 7 : 4;
}

module.exports = {
  HARD_CONTEXT_RATIO,
  SOFT_CONTEXT_RATIO,
  contextCompactionOptions,
  knowledgeSearchBudgetForTurn,
  providerToolRoundBudget,
  reasoningEffortForTurn,
  threadContextUsage,
};
