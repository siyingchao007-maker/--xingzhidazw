"use strict";

const crypto = require("node:crypto");
const { normalizeResponseMetrics, normalizeTokenUsage } = require("./response-metrics.cjs");
const { normalizeTurnAnalysisPath } = require("./turn-analysis-path.cjs");

const SUITE_ID = "xingzhi-runtime-performance-baseline";
const SUITE_VERSION = "v1";
const CATEGORIES = Object.freeze([
  "simple-task",
  "ordinary-analysis",
  "complex-decision",
  "explicit-multi-perspective",
]);

const BASELINE_CASES = Object.freeze([
  {
    id: "simple-translation",
    category: "simple-task",
    input: "请把“交付日期已经确认”翻译成英文，只输出译文。",
  },
  {
    id: "simple-polite-rewrite",
    category: "simple-task",
    input: "把“请尽快给我回复”改写得更礼貌，只输出一句话。",
  },
  {
    id: "ordinary-comparison",
    category: "ordinary-analysis",
    input: "只根据以下信息比较两个订阅方案：A 每月 100 元，可随时取消；B 每月 80 元，需锁定一年。列出差异与仍需确认的未知，不替虚构用户做最终选择，控制在 180 字内。",
  },
  {
    id: "ordinary-cause-boundary",
    category: "ordinary-analysis",
    input: "只根据以下事实分析一次迟到：当天堵车，出门时间又比平时晚 20 分钟。区分事实、推断和未知，不扩展成长建议，控制在 180 字内。",
  },
  {
    id: "complex-career-decision",
    category: "complex-decision",
    input: "一名虚构人物在两个工作机会之间选择：A 税前月薪 18000 元、每周约 55 小时、学习机会多；B 税前月薪 14000 元、每周约 40 小时、工作稳定。其目标是在未来两年提升可迁移能力，同时每周至少保留两个晚上照顾家人。请评估选择，写明关键假设、失败条件、反证、最值得先验证的一项信息和条件式建议。",
  },
  {
    id: "complex-business-decision",
    category: "complex-decision",
    input: "一家虚构的小型软件团队有 4 个月现金储备，正在考虑是否把主要资源投入一个尚无付费客户、但已有 12 个访谈对象表示感兴趣的新产品。现有业务能覆盖约 70% 的月成本。请给出是否投入的判断，区分事实、推断和未知，检查关键约束、失败条件、最强反方和一个低成本验证实验。",
  },
  {
    id: "explicit-three-lenses-product",
    category: "explicit-multi-perspective",
    input: "请显式使用 $xingzhi-first-principles、$xingzhi-system-feedback-analysis 和 $xingzhi-causal-evidence-audit 分析这个虚构方案：社区把新人完成一次签到视为留存成功，并据此决定扩大获客预算。比较三个视角新增的机制或行动差异，合并重复证据，保留未知，最后给出最小验证动作。",
  },
  {
    id: "explicit-three-lenses-cooperation",
    category: "explicit-multi-perspective",
    input: "请显式使用 $xingzhi-contradiction-stage-analysis、$xingzhi-incentive-structure-analysis 和 $xingzhi-reversal-failure-conditions 评估这个虚构合作：平台按成交额奖励销售，但售后成本由交付团队承担；双方计划下月把成交目标提高 50%。说明三个视角各自改变了什么，合并重复发现，列出失败信号与下一项验证。",
  },
].map((item) => Object.freeze({ ...item })));

function boundedText(value, maximum = 240) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum)
    : "";
}

function safeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function fingerprint(value, length = 24) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, length);
}

function caseFingerprint(item) {
  return fingerprint(JSON.stringify({
    suite: `${SUITE_ID}/${SUITE_VERSION}`,
    id: item.id,
    category: item.category,
    input: item.input,
  }));
}

const SUITE_FINGERPRINT = fingerprint(JSON.stringify(BASELINE_CASES.map((item) => ({
  id: item.id,
  category: item.category,
  inputFingerprint: caseFingerprint(item),
}))));

function baselineCase(caseId) {
  const selected = caseId
    ? BASELINE_CASES.find((item) => item.id === caseId)
    : BASELINE_CASES[0];
  if (!selected) throw new Error(`未知性能基线用例：${boundedText(caseId, 80)}`);
  return selected;
}

function normalizeRouting(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    candidateCount: safeCount(raw.candidateCount, 64),
    requestedCount: safeCount(raw.requestedCount, 64),
    selectedCount: safeCount(raw.selectedCount, 16),
    filteredCount: safeCount(raw.filteredCount, 64),
    loadedBodyCount: safeCount(raw.loadedBodyCount, 16),
    unexpectedLoadedBodyCount: safeCount(raw.unexpectedLoadedBodyCount, 16),
    selectedLensContextBytes: safeCount(raw.selectedLensContextBytes, 1_000_000),
    reservedNonLensContextBytes: safeCount(raw.reservedNonLensContextBytes, 1_000_000),
    contextBudgetBytes: safeCount(raw.contextBudgetBytes, 1_000_000),
  };
}

function failureStage(panel, outcome) {
  if (outcome === "succeeded") return null;
  const machine = panel?.taskStateMachine;
  const failed = Array.isArray(machine?.stages)
    ? machine.stages.find((stage) => stage?.status === "failed")
    : null;
  return boundedText(failed?.id || machine?.currentStage || "runtime", 80) || "runtime";
}

function buildPerformanceBaselineResult({ caseId, diagnostic, panel, message, model, error } = {}) {
  const item = baselineCase(caseId);
  const outcome = diagnostic?.outcome === "succeeded" && !error ? "completed" : "failed";
  const analysisPath = normalizeTurnAnalysisPath(diagnostic?.analysisPath || panel?.analysisPath);
  const performance = normalizeResponseMetrics(diagnostic?.performance || message?.responseMetrics);
  const tokenUsage = normalizeTokenUsage(performance?.tokenUsage || diagnostic?.tokens);
  const result = {
    version: 1,
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    suiteFingerprint: SUITE_FINGERPRINT,
    caseId: item.id,
    category: item.category,
    inputFingerprint: caseFingerprint(item),
    recordedAt: new Date().toISOString(),
    status: outcome,
    model: boundedText(model || diagnostic?.model, 120) || null,
    route: normalizeRouting(analysisPath?.routing),
    latency: performance ? {
      totalMs: performance.totalMs,
      routingMs: performance.routingMs,
      retrievalMs: performance.retrievalMs,
      thinkingMs: performance.thinkingMs,
      generationMs: performance.generationMs,
    } : null,
    localContext: performance?.localContext || null,
    tokens: tokenUsage,
    repairAttempts: safeCount(diagnostic?.quality?.repairAttempts, 4),
    repairMode: new Set(["none", "append", "replace"]).has(diagnostic?.quality?.repairMode)
      ? diagnostic.quality.repairMode : "none",
    answerChars: safeCount(diagnostic?.answerChars, 1_000_000),
    answerHash: /^[a-f0-9]{64}$/u.test(String(diagnostic?.answerHash || ""))
      ? diagnostic.answerHash : null,
    failure: outcome === "failed" ? {
      stage: failureStage(panel, diagnostic?.outcome),
      code: boundedText(error?.code || "baseline-case-failed", 120) || "baseline-case-failed",
      message: boundedText(error?.message || error || "用例未完成", 300) || "用例未完成",
    } : null,
  };
  if (result.route.unexpectedLoadedBodyCount > 0
    || result.route.loadedBodyCount !== result.route.selectedCount) {
    result.status = "failed";
    result.failure = {
      stage: "skill-context-loading",
      code: "unexpected-lens-body-load",
      message: "实际加载的认知透镜正文与入选透镜不一致。",
    };
  }
  return result;
}

function normalizeBaselineResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = BASELINE_CASES.find((entry) => entry.id === raw.caseId);
  if (!item || raw.suiteId !== SUITE_ID || raw.suiteVersion !== SUITE_VERSION
    || raw.suiteFingerprint !== SUITE_FINGERPRINT
    || raw.inputFingerprint !== caseFingerprint(item)) return null;
  const status = raw.status === "completed" ? "completed" : "failed";
  return {
    version: 1,
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    suiteFingerprint: SUITE_FINGERPRINT,
    caseId: item.id,
    category: item.category,
    inputFingerprint: caseFingerprint(item),
    recordedAt: Number.isFinite(Date.parse(raw.recordedAt)) ? raw.recordedAt : new Date(0).toISOString(),
    status,
    model: boundedText(raw.model, 120) || null,
    route: normalizeRouting(raw.route),
    latency: (() => {
      const metrics = normalizeResponseMetrics(raw.latency ? { ...raw.latency, tokenUsage: raw.tokens } : null);
      return metrics ? {
        totalMs: metrics.totalMs,
        routingMs: metrics.routingMs,
        retrievalMs: metrics.retrievalMs,
        thinkingMs: metrics.thinkingMs,
        generationMs: metrics.generationMs,
      } : null;
    })(),
    localContext: (() => {
      const metrics = normalizeResponseMetrics(raw.latency
        ? { ...raw.latency, tokenUsage: raw.tokens, localContext: raw.localContext }
        : null);
      return metrics?.localContext || null;
    })(),
    tokens: normalizeTokenUsage(raw.tokens),
    repairAttempts: safeCount(raw.repairAttempts, 4),
    repairMode: new Set(["none", "append", "replace"]).has(raw.repairMode)
      ? raw.repairMode : "none",
    answerChars: safeCount(raw.answerChars, 1_000_000),
    answerHash: /^[a-f0-9]{64}$/u.test(String(raw.answerHash || "")) ? raw.answerHash : null,
    failure: status === "failed" ? {
      stage: boundedText(raw.failure?.stage, 80) || "runtime",
      code: boundedText(raw.failure?.code, 120) || "baseline-case-failed",
      message: boundedText(raw.failure?.message, 300) || "用例未完成",
    } : null,
  };
}

function restorePerformanceBaseline(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const byId = new Map();
  for (const raw of Array.isArray(source.results) ? source.results : []) {
    const result = normalizeBaselineResult(raw);
    if (result) byId.set(result.caseId, result);
  }
  return {
    version: 1,
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    suiteFingerprint: SUITE_FINGERPRINT,
    results: BASELINE_CASES.map((item) => byId.get(item.id)).filter(Boolean),
  };
}

function recordPerformanceBaselineResult(previous, raw) {
  const state = restorePerformanceBaseline(previous);
  const result = normalizeBaselineResult(raw);
  if (!result) throw new Error("性能基线结果与当前固定套件不一致");
  const byId = new Map(state.results.map((item) => [item.caseId, item]));
  const current = byId.get(result.caseId);
  if (!current || current.status !== "completed" || result.status === "completed") {
    byId.set(result.caseId, result);
  }
  return {
    ...state,
    results: BASELINE_CASES.map((item) => byId.get(item.id)).filter(Boolean),
  };
}

function nextPerformanceBaselineCase(previous) {
  const state = restorePerformanceBaseline(previous);
  const completed = new Set(state.results
    .filter((item) => item.status === "completed")
    .map((item) => item.caseId));
  return BASELINE_CASES.find((item) => !completed.has(item.id)) || null;
}

function percentile(values, ratio) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  if (ordered.length === 1) return Math.round(ordered[0]);
  const index = (ordered.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
  return Math.round(value);
}

function distribution(values) {
  const measured = values.filter(Number.isFinite);
  return {
    measuredCount: measured.length,
    p50: percentile(measured, 0.5),
    p95: percentile(measured, 0.95),
    minimum: measured.length ? Math.min(...measured) : null,
    maximum: measured.length ? Math.max(...measured) : null,
  };
}

function aggregateSubset(results) {
  const completed = results.filter((item) => item.status === "completed");
  const selectedCount = completed.reduce((sum, item) => sum + item.route.selectedCount, 0);
  const filteredCount = completed.reduce((sum, item) => sum + item.route.filteredCount, 0);
  const routedCount = selectedCount + filteredCount;
  const stageTotals = Object.fromEntries(["routingMs", "retrievalMs", "thinkingMs", "generationMs"].map((field) => [
    field,
    completed.reduce((sum, item) => sum + (Number.isFinite(item.latency?.[field]) ? item.latency[field] : 0), 0),
  ]));
  const dominantStage = Object.entries(stageTotals)
    .sort((left, right) => right[1] - left[1])[0];
  return {
    caseCount: results.length,
    completedCount: completed.length,
    failedCount: results.length - completed.length,
    routing: {
      candidateCount: distribution(completed.map((item) => item.route.candidateCount)),
      actualLensCount: distribution(completed.map((item) => item.route.selectedCount)),
      requestedCount: selectedCount + filteredCount,
      selectedCount,
      filteredCount,
      lensFilterRate: routedCount ? Number((filteredCount / routedCount).toFixed(4)) : 0,
      loadedBodyCount: completed.reduce((sum, item) => sum + item.route.loadedBodyCount, 0),
      unexpectedLoadedBodyCount: completed.reduce(
        (sum, item) => sum + item.route.unexpectedLoadedBodyCount,
        0,
      ),
      unselectedLensBodiesExcluded: completed.every((item) => (
        item.route.unexpectedLoadedBodyCount === 0
        && item.route.loadedBodyCount === item.route.selectedCount
      )),
      selectedLensContextBytes: distribution(
        completed.map((item) => item.route.selectedLensContextBytes),
      ),
    },
    tokens: {
      input: distribution(completed.map((item) => item.tokens?.inputTokens)),
      output: distribution(completed.map((item) => item.tokens?.outputTokens)),
      total: distribution(completed.map((item) => item.tokens?.totalTokens)),
    },
    latency: {
      method: "linear-interpolation-r7",
      total: distribution(completed.map((item) => item.latency?.totalMs)),
      routing: distribution(completed.map((item) => item.latency?.routingMs)),
      retrieval: distribution(completed.map((item) => item.latency?.retrievalMs)),
      thinking: distribution(completed.map((item) => item.latency?.thinkingMs)),
      generation: distribution(completed.map((item) => item.latency?.generationMs)),
      dominantStage: dominantStage?.[1] > 0 ? dominantStage[0] : null,
      stageTotals,
      regressionLocatable: completed.length > 0 && completed.every((item) => (
        Number.isFinite(item.latency?.totalMs)
        && [item.latency?.retrievalMs, item.latency?.thinkingMs, item.latency?.generationMs]
          .some(Number.isFinite)
      )),
    },
    quality: {
      repairCount: completed.reduce((sum, item) => sum + item.repairAttempts, 0),
      repairedTurnCount: completed.filter((item) => item.repairAttempts > 0).length,
      repairRate: completed.length
        ? Number((completed.filter((item) => item.repairAttempts > 0).length / completed.length).toFixed(4))
        : 0,
    },
    failures: results.filter((item) => item.status === "failed").map((item) => ({
      caseId: item.caseId,
      stage: item.failure?.stage || "runtime",
      code: item.failure?.code || "baseline-case-failed",
    })),
  };
}

function provisionalThresholds(overall) {
  const upward = (value, factor, unit) => Number.isFinite(value)
    ? Math.ceil((value * factor) / unit) * unit : null;
  return {
    status: overall.completedCount === BASELINE_CASES.length ? "provisional" : "insufficient-sample",
    comparisonRule: "same-suite-same-model-fresh-thread",
    latencyP95WarningMs: upward(overall.latency.total.p95, 1.25, 1_000),
    latencyP95StopMs: upward(overall.latency.total.p95, 1.5, 1_000),
    inputTokenP95Warning: upward(overall.tokens.input.p95, 1.25, 100),
    inputTokenP95Stop: upward(overall.tokens.input.p95, 1.5, 100),
    lensFilterRateWarning: Number(Math.min(1, overall.routing.lensFilterRate + 0.1).toFixed(4)),
    repairRateWarning: Number(Math.min(1, overall.quality.repairRate + 0.1).toFixed(4)),
    note: "首轮仅 8 个固定合成用例，阈值用于定位回归，不代表所有真实任务的服务承诺。",
  };
}

function categoryThresholds(categories) {
  return Object.fromEntries(Object.entries(categories).map(([category, aggregate]) => [
    category,
    provisionalThresholds(aggregate),
  ]));
}

function buildPerformanceBaselineReport(previous) {
  const state = restorePerformanceBaseline(previous);
  const categories = Object.fromEntries(CATEGORIES.map((category) => [
    category,
    aggregateSubset(state.results.filter((item) => item.category === category)),
  ]));
  const overall = aggregateSubset(state.results);
  return {
    version: 1,
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    suiteFingerprint: SUITE_FINGERPRINT,
    generatedAt: new Date().toISOString(),
    caseCount: BASELINE_CASES.length,
    recordedCount: state.results.length,
    complete: state.results.length === BASELINE_CASES.length
      && state.results.every((item) => item.status === "completed"),
    privacy: {
      syntheticInputsOnly: true,
      rawInputsPersisted: false,
      rawAnswersPersisted: false,
      answerHashOnly: true,
    },
    execution: {
      freshEphemeralThreadPerCase: true,
      networkAccess: false,
      knowledgeTools: false,
      userStateFileRead: false,
      vaultWrites: "memory-overlay-only",
    },
    results: state.results,
    categories,
    overall,
    thresholds: {
      overall: provisionalThresholds(overall),
      byCategory: categoryThresholds(categories),
    },
  };
}

module.exports = {
  BASELINE_CASES,
  CATEGORIES,
  SUITE_FINGERPRINT,
  SUITE_ID,
  SUITE_VERSION,
  baselineCase,
  buildPerformanceBaselineReport,
  buildPerformanceBaselineResult,
  caseFingerprint,
  nextPerformanceBaselineCase,
  percentile,
  recordPerformanceBaselineResult,
  restorePerformanceBaseline,
};
