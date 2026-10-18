"use strict";

const MAX_INFORMATION_NEEDS = 6;
const FRESHNESS_MAX_AGE_DAYS = Object.freeze({ stable: null, recent: 45, live: 1 });
const PRIVATE_SOURCE_SCOPES = new Set(["personal", "private", "user-context", "local"]);
const PUBLIC_SOURCE_SCOPES = new Set(["public", "web", "external"]);
const PRIVATE_SOURCE_CLASSES = new Set([
  "personal", "personal-context", "personal-knowledge", "private", "private-knowledge", "user-context",
]);
const EVIDENCE_SEARCH_STOP_WORDS = new Set([
  "以及", "有关", "相关", "包括", "进行", "检索", "用户", "知识", "正式", "获准",
  "优先", "重点", "返回", "保留", "来源", "根据", "不要", "只是", "可以", "请",
]);
const EVIDENCE_SEARCH_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh-CN", { granularity: "word" })
  : null;

function boundedAdaptiveText(value, maximum = 240) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeInformationNeeds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = boundedAdaptiveText(raw.id, 80);
    const label = boundedAdaptiveText(raw.label, 160);
    const query = boundedAdaptiveText(raw.query || raw.label, 240);
    const scope = boundedAdaptiveText(raw.scope || raw.sourceScope || raw.source || raw.kind, 80).toLowerCase();
    if (!id || !label || !query || seen.has(id)) continue;
    seen.add(id);
    const privateScope = raw.private === true
      || new Set(["personal", "private", "user-context", "local"]).has(scope)
      || (!scope && /我(?:的|现在|目前|准备|过去|最近|当前)|关于我|结合我|用户个人资料|本地资料|个人背景/u.test(`${label} ${query}`));
    result.push({
      id,
      label,
      query,
      freshness: Object.hasOwn(FRESHNESS_MAX_AGE_DAYS, raw.freshness) ? raw.freshness : "stable",
      optional: raw.optional === true,
      scope,
      publicNeed: !privateScope && (raw.public === true || raw.publicNeed === true
        || new Set(["public", "web", "external"]).has(scope)
        || (!scope && /^(?:recent|live)$/u.test(String(raw.freshness || "")))),
      privateNeed: privateScope,
      publicExpected: raw.publicExpected === true,
    });
    if (result.length >= MAX_INFORMATION_NEEDS) break;
  }
  return result;
}

function buildFallbackInformationNeed({
  instructionText = "", sourceMode = "model-only", allowWebSearch = false, locked = false,
} = {}) {
  const query = boundedAdaptiveText(instructionText, 240);
  if (!query) return null;
  const mentionsPersonalScope = /我(?:的|现在|目前|准备|过去|最近|当前|曾经)|结合我|关于我|我的资料|我准备的/u.test(query);
  const mentionsPublicScope = /当前|最新|市场|行业|赛道|竞品|公开|趋势|政策|价格/u.test(query);
  const ambiguousHybridScope = sourceMode === "hybrid"
    && (mentionsPersonalScope === mentionsPublicScope);
  const unknownScope = ambiguousHybridScope || (!mentionsPersonalScope && !mentionsPublicScope
    && !["web", "web-context-then-decide"].includes(sourceMode));
  const scope = unknownScope ? "unknown" : (mentionsPersonalScope ? "personal" : "public");
  const publicExpected = unknownScope
    ? (mentionsPublicScope || (sourceMode === "hybrid" && allowWebSearch === true))
    : scope === "public";
  const requiresLiveWeb = allowWebSearch === true && publicExpected
    && ["web", "hybrid", "web-context-then-decide"].includes(sourceMode);
  return {
    id: "fallback-turn-topic",
    label: unknownScope ? "未分类的复合信息需求" : boundedAdaptiveText(query, 160),
    query,
    freshness: requiresLiveWeb ? "live" : "stable",
    optional: false,
    scope,
    publicNeed: !unknownScope && requiresLiveWeb,
    publicExpected: unknownScope && publicExpected && allowWebSearch === true,
    privateNeed: scope === "personal",
    unknownScope,
    unknownNotAssessed: unknownScope,
    locked: locked === true,
  };
}

function adaptiveTermSet(value) {
  const normalized = boundedAdaptiveText(value, 500).normalize("NFKC").toLowerCase();
  const text = normalized.replace(/[^\p{L}\p{N}]+/gu, " ");
  const terms = [];
  const seen = new Set();
  const add = (candidate) => {
    const term = String(candidate || "").trim();
    if (term.length < 2 || term.length > 32 || EVIDENCE_SEARCH_STOP_WORDS.has(term) || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  for (const chunk of text.split(/\s+/u).filter(Boolean)) {
    add(chunk);
    if (!/\p{Script=Han}/u.test(chunk)) continue;
    if (EVIDENCE_SEARCH_SEGMENTER) {
      for (const part of EVIDENCE_SEARCH_SEGMENTER.segment(chunk)) {
        if (part.isWordLike) add(part.segment);
      }
    } else {
      for (const run of chunk.match(/[\p{Script=Han}]+/gu) || []) {
        if (run.length <= 8) add(run);
        for (let index = 0; index < run.length - 1; index += 1) {
          add(run.slice(index, index + 2));
          add(run.slice(index, index + 4));
        }
      }
    }
    if (terms.length >= 64) break;
  }
  return terms.slice(0, 64);
}

function adaptiveResultText(result) {
  return [result?.title, result?.path, result?.excerpt, result?.claim]
    .filter((item) => typeof item === "string").join(" ").normalize("NFKC").toLowerCase();
}

function relevantToInformationNeed(result, need) {
  const haystack = adaptiveResultText(result);
  if (!haystack) return false;
  const terms = adaptiveTermSet(`${need.label} ${need.query}`);
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return terms.length > 0 && matched >= Math.min(2, terms.length);
}

function adaptiveDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resultHasPrivateProvenance(result) {
  const scopes = [result?.scope, result?.sourceScope, result?.environment?.scope]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const sourceClass = String(result?.sourceClass || "").toLowerCase();
  return result?.private === true
    || scopes.some((scope) => PRIVATE_SOURCE_SCOPES.has(scope))
    || PRIVATE_SOURCE_CLASSES.has(sourceClass);
}

function isPublicHttpUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) return false;
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/u.test(hostname)) return false;
    const private172 = /^172\.(\d{1,3})\./u.exec(hostname);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (hostname === "::1" || hostname === "[::1]"
      || /^\[(?:f[cd]|fe[89ab])[0-9a-f:]*\]$/u.test(hostname)
      || /^f[cd][0-9a-f:]*$/u.test(hostname) || /^fe[89ab][0-9a-f:]*$/u.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function resultHasPublicProvenance(result) {
  if (resultHasPrivateProvenance(result)) return false;
  const scopes = [result?.scope, result?.sourceScope, result?.environment?.scope]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (scopes.some((scope) => PUBLIC_SOURCE_SCOPES.has(scope))) return true;
  const sourceUrls = [result?.url, result?.sourceUrl]
    .concat(Array.isArray(result?.sourceDocuments) ? result.sourceDocuments : []);
  return sourceUrls.some(isPublicHttpUrl);
}

function resultCanSupportCurrentNeed(result, need = null) {
  const sourceClass = String(result?.sourceClass || "").toLowerCase();
  const usagePolicy = String(result?.usagePolicy || "").toLowerCase();
  const verificationStatus = String(result?.verificationStatus || "").toLowerCase();
  const lifecycleStatus = String(result?.lifecycleStatus || result?.status || "").toLowerCase();
  const promotionStatus = String(result?.promotionStatus || "").toLowerCase();
  if (result?.isHistorical === true
    || new Set(["revision-history", "reference-library", "conversation-draft", "history-only"]).has(sourceClass)) return false;
  if (new Set([
    "historical-comparison-only", "reference-only", "draft-context-only", "candidate-context-only",
    "environment-review-required", "environment-historical-only",
  ]).has(usagePolicy)) return false;
  if (!new Set(["fact", "verified", "confirmed"]).has(verificationStatus)) return false;
  if (new Set(["pending", "pending-review", "historical", "superseded", "rejected", "invalid", "stale"])
    .has(lifecycleStatus)) return false;
  if (result?.formalKnowledge === false) return false;
  if (promotionStatus && !new Set(["promoted", "completed", "organized"]).has(promotionStatus)) return false;
  if (result?.requiresReview === true || result?.environment?.requiresReview === true
    || new Set(["stale", "invalid"]).has(String(result?.environment?.freshness || result?.freshness || "").toLowerCase())) return false;
  if (need?.publicNeed === true && !resultHasPublicProvenance(result)) return false;
  return true;
}

function resultFreshForInformationNeed(result, need, nowTimestamp) {
  if (!resultCanSupportCurrentNeed(result, need)) return false;
  const environmentFreshness = String(result?.environment?.freshness || result?.freshness || "").toLowerCase();
  if (result?.requiresReview === true || result?.environment?.requiresReview === true
    || environmentFreshness === "stale"
    || environmentFreshness === "invalid") {
    return false;
  }
  const effectiveUntil = adaptiveDate(result?.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil < nowTimestamp) return false;
  const maximumAgeDays = FRESHNESS_MAX_AGE_DAYS[need.freshness];
  if (maximumAgeDays === null) return true;
  const updatedAt = adaptiveDate(result?.updatedAt);
  return updatedAt !== null && nowTimestamp - updatedAt <= maximumAgeDays * 86_400_000;
}

function resultIdentity(result, index) {
  const identity = boundedAdaptiveText(result?.sourceIdentity, 200);
  if (identity) return identity;
  return boundedAdaptiveText(result?.path || result?.title, 500) || `result-${index}`;
}

function publicNeedMissing(need, sourceMode) {
  if (need.privateNeed === true) return false;
  if (need.unknownScope === true || need.scope === "unknown") return need.publicExpected === true;
  if (need.publicNeed === true) return true;
  if (["web", "web-context-then-decide"].includes(sourceMode)) return true;
  return need.freshness === "live";
}

function publicSourceMode(sourceMode) {
  return ["web", "hybrid", "web-context-then-decide"].includes(sourceMode);
}

function assessLocalEvidenceSufficiency({
  informationNeeds = [], results = [], sourceMode = "model-only",
  retrievalSucceeded = true, fallbackQuery = "", now = null,
} = {}) {
  const needs = normalizeInformationNeeds(informationNeeds);
  const safeResults = Array.isArray(results) ? results.filter((item) => item && typeof item === "object") : [];
  const nowTimestamp = adaptiveDate(now) ?? Date.now();
  if (!needs.length) {
    const routeNeedsWeb = ["web", "web-context-then-decide"].includes(sourceMode)
      && Boolean(boundedAdaptiveText(fallbackQuery));
    const locked = sourceMode === "local-only";
    return {
      status: locked ? "insufficient-local-only" : (routeNeedsWeb ? "missing" : "not-required"),
      webRequired: !locked && routeNeedsWeb,
      informationNeeds: [], coveredNeedIds: [], missingNeedIds: [], unknownNeedIds: [], staleNeedIds: [],
      gapQueries: !locked && routeNeedsWeb && boundedAdaptiveText(fallbackQuery)
        ? [boundedAdaptiveText(fallbackQuery)] : [],
      freshResultCount: 0, staleResultCount: 0,
      reasonCodes: retrievalSucceeded === false ? ["local-retrieval-failed"] : ["no-structured-information-needs"],
      reason: routeNeedsWeb
        ? "当前公开信息需求尚无结构化的本地覆盖记录。"
        : "当前没有需要评估的结构化证据需求。",
    };
  }
  const coveredNeedIds = [];
  const staleNeedIds = [];
  const missingNeedIds = [];
  const unverifiedNeedIds = [];
  const unknownNeedIds = [];
  const publicMissingNeedIds = [];
  const freshResultSources = new Set();
  const staleResultSources = new Set();
  for (const need of needs) {
    if (need.unknownScope === true || need.scope === "unknown") {
      unknownNeedIds.push(need.id);
      if (need.publicExpected === true) {
        missingNeedIds.push(need.id);
        publicMissingNeedIds.push(need.id);
      }
      continue;
    }
    const relevant = safeResults.map((result, index) => ({ result, index }))
      .filter(({ result }) => relevantToInformationNeed(result, need));
    const supportable = relevant.filter(({ result }) => resultCanSupportCurrentNeed(result, need));
    const fresh = supportable.filter(({ result }) => resultFreshForInformationNeed(result, need, nowTimestamp));
    if (fresh.length) {
      coveredNeedIds.push(need.id);
      fresh.forEach(({ result, index }) => freshResultSources.add(resultIdentity(result, index)));
    } else if (supportable.length) {
      staleNeedIds.push(need.id);
      missingNeedIds.push(need.id);
      supportable.forEach(({ result, index }) => staleResultSources.add(resultIdentity(result, index)));
    } else if (relevant.length) {
      unverifiedNeedIds.push(need.id);
      if (!need.optional) missingNeedIds.push(need.id);
    } else if (!need.optional) {
      missingNeedIds.push(need.id);
    }
    if (missingNeedIds.includes(need.id) && publicNeedMissing(need, sourceMode)) {
      publicMissingNeedIds.push(need.id);
    }
  }
  const locked = sourceMode === "local-only";
  const noRequiredNeeds = needs.every((need) => need.optional === true);
  const status = unknownNeedIds.length
    ? "unknown-not-assessed"
    : (noRequiredNeeds
      ? "not-assessed"
      : (missingNeedIds.length === 0
        ? "sufficient"
        : (locked ? "insufficient-local-only" : (coveredNeedIds.length ? "partial" : "missing"))));
  const reasonCodes = [];
  if (unknownNeedIds.length) reasonCodes.push("information-scope-not-assessed");
  if (noRequiredNeeds) reasonCodes.push("no-required-information-needs");
  if (retrievalSucceeded === false) reasonCodes.push("local-retrieval-failed");
  if (staleNeedIds.length) reasonCodes.push("local-evidence-stale");
  if (unverifiedNeedIds.length) reasonCodes.push("local-evidence-not-verified");
  if (missingNeedIds.some((id) => !staleNeedIds.includes(id))) reasonCodes.push("local-evidence-missing");
  if (!reasonCodes.length) reasonCodes.push("local-evidence-sufficient");
  const missing = new Set(missingNeedIds);
  const publicMissing = new Set(publicMissingNeedIds);
  return {
    status,
    webRequired: !locked && publicSourceMode(sourceMode) && publicMissingNeedIds.length > 0,
    informationNeeds: needs,
    coveredNeedIds,
    missingNeedIds,
    unknownNeedIds,
    staleNeedIds,
    unverifiedNeedIds,
    gapQueries: locked ? [] : needs
      .filter((need) => missing.has(need.id) && publicMissing.has(need.id)
        && need.publicNeed === true && need.scope !== "unknown")
      .map((need) => need.query)
      .filter((query) => !/(?:我(?:的|现在|目前|准备|过去|最近|当前)|结合我|关于我|私有|会员物料)/u.test(query)),
    freshResultCount: freshResultSources.size,
    staleResultCount: staleResultSources.size,
    reasonCodes,
    reason: status === "sufficient"
      ? "本地资料覆盖了本轮信息需求，并满足设定的核实状态与时效条件。"
      : (status === "unknown-not-assessed"
        ? "本地资料检索范围尚未拆分为可判断的个人与公开需求；没有据此认定资料充分，公开检索词仍需依据单独的公开主题生成。"
        : (status === "not-assessed"
          ? "当前只有可选信息需求或没有明确的必需信息需求；本地命中不能据此宣称证据充分。"
          : (locked
            ? "用户已锁定仅本地模式；本地资料仍有缺口或需要复核。"
            : (publicMissingNeedIds.length
              ? "本地资料尚未覆盖全部公开信息需求。"
              : "本地资料尚未覆盖全部个人背景需求，或匹配内容尚未达到核实条件。")))),
  };
}

function buildGapSearchQuery(assessment, fallbackQuery = "") {
  const queries = Array.isArray(assessment?.gapQueries) ? assessment.gapQueries : [];
  const joined = queries.map((item) => boundedAdaptiveText(item, 160)).filter(Boolean).join("；");
  // The fallback can contain a mixed-scope user instruction. Only structured,
  // explicitly public gaps may cross the search boundary.
  void fallbackQuery;
  return boundedAdaptiveText(joined, 240);
}

module.exports = {
  FRESHNESS_MAX_AGE_DAYS,
  MAX_INFORMATION_NEEDS,
  assessLocalEvidenceSufficiency,
  buildFallbackInformationNeed,
  buildGapSearchQuery,
  normalizeInformationNeeds,
  relevantToInformationNeed,
};
