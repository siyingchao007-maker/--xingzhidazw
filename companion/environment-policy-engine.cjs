"use strict";

const ENVIRONMENT_ROUTE_VERSION = "0.2.0";
const ENVIRONMENT_ROOT = "03_环境";
const FRESHNESS_STATES = new Set(["current", "monitoring", "stale", "invalid"]);
const ALLOWED_ENVIRONMENT_CATEGORIES = new Set([
  "rules",
  "technology",
  "regional",
  "social",
  "market",
  "industry",
  "organization",
]);
const MAX_ENVIRONMENT_EVIDENCE_IDS = 30;
const MAX_ENVIRONMENT_RELATION_IDS = 100;

const ENVIRONMENT_ROUTES = Object.freeze({
  rules: "规则与制度",
  policy: "规则与制度",
  institution: "规则与制度",
  technology: "技术环境",
  regional: "区域环境",
  social: "社会环境",
  market: "市场环境",
  industry: "行业环境",
  organization: "组织环境",
});

const ENVIRONMENT_CATEGORY_OPTIONS = Object.freeze([
  Object.freeze({ value: "rules", label: "规则与制度" }),
  Object.freeze({ value: "technology", label: "技术环境" }),
  Object.freeze({ value: "regional", label: "区域环境" }),
  Object.freeze({ value: "social", label: "社会环境" }),
  Object.freeze({ value: "market", label: "市场环境" }),
  Object.freeze({ value: "industry", label: "行业环境" }),
  Object.freeze({ value: "organization", label: "组织环境" }),
]);

const ENVIRONMENT_ALIASES = Object.freeze({
  "规则与制度": "rules",
  "规则制度": "rules",
  "规则": "rules",
  "制度": "institution",
  "政策": "policy",
  "政策环境": "policy",
  "技术环境": "technology",
  "技术": "technology",
  "区域环境": "regional",
  "区域": "regional",
  "社会环境": "social",
  "社会": "social",
  "市场环境": "market",
  "市场": "market",
  "行业环境": "industry",
  "行业": "industry",
  "组织环境": "organization",
  "组织": "organization",
});

function text(value, maximum = 2_000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "bigint", "boolean"].includes(typeof value)) return "";
  return String(value).replace(/\u0000/gu, "").trim().slice(0, maximum);
}

function normalizedToken(value) {
  const raw = text(value, 120);
  if (!raw) return "";
  if (Object.hasOwn(ENVIRONMENT_ALIASES, raw)) return ENVIRONMENT_ALIASES[raw];
  return raw.toLowerCase().replaceAll("_", "-");
}

function canonicalEnvironmentSubtype(value) {
  const token = normalizedToken(value);
  if (!token) return "unknown";
  if (Object.hasOwn(ENVIRONMENT_ROUTES, token)) {
    if (token === "policy" || token === "institution") return "rules";
    return token;
  }
  return "unknown";
}

function validateEnvironmentCategory(value) {
  const canonical = canonicalEnvironmentSubtype(value);
  if (!ALLOWED_ENVIRONMENT_CATEGORIES.has(canonical)) {
    return Object.freeze({
      valid: false,
      canonical: "unknown",
      reasonCode: "INVALID_ENVIRONMENT_CATEGORY",
    });
  }
  return Object.freeze({ valid: true, canonical, reasonCode: null });
}

function routeEnvironmentSubtype(value) {
  const raw = normalizedToken(value);
  const validation = validateEnvironmentCategory(value);
  if (!validation.valid) {
    return Object.freeze({
      known: false,
      raw: raw || "unknown",
      subtype: "unknown",
      directory: null,
      folder: null,
      requiresConfirmation: true,
      reasonCode: "ENVIRONMENT_SUBTYPE_REQUIRED",
    });
  }
  const canonical = validation.canonical;
  const routeKey = raw === "policy" || raw === "institution" ? raw : canonical;
  const folder = ENVIRONMENT_ROUTES[routeKey] || ENVIRONMENT_ROUTES[canonical];
  return Object.freeze({
    known: true,
    raw,
    subtype: canonical,
    directory: `${ENVIRONMENT_ROOT}/${folder}`,
    folder,
    requiresConfirmation: false,
    reasonCode: null,
  });
}

function validDate(value) {
  const raw = text(value, 100);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function normalizeFreshness(value, fallback = "current") {
  const normalized = text(value, 40).toLowerCase();
  return FRESHNESS_STATES.has(normalized) ? normalized : fallback;
}

function uniqueStrings(values, maximum = 100) {
  if (values === null || values === undefined || values === "") return [];
  const source = Array.isArray(values) ? values : [values];
  const result = [];
  const seen = new Set();
  for (const item of source) {
    if (!["string", "number", "bigint", "boolean"].includes(typeof item)) continue;
    const normalized = text(item, 2_000);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function normalizeEnvironmentCandidate(candidate, { now = new Date().toISOString() } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate.knowledgeType !== "environment") {
    return candidate;
  }
  const route = routeEnvironmentSubtype(candidate.area || candidate.category || candidate.environmentCategory);
  const evidenceIds = uniqueStrings([
    ...(Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : []),
    ...(Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []),
    ...(Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs : []),
  ], MAX_ENVIRONMENT_EVIDENCE_IDS);
  const hasEvidence = evidenceIds.length > 0
    || (Array.isArray(candidate.evidence) && candidate.evidence.some((item) => item && typeof item === "object"));
  const observedAt = validDate(candidate.observedAt || candidate.observed_at || candidate.effectiveFrom)
    || validDate(now);
  const reviewAt = validDate(candidate.reviewAt || candidate.review_at);
  const freshness = normalizeFreshness(candidate.freshness, hasEvidence ? "current" : "monitoring");
  return {
    ...candidate,
    area: route.known ? route.subtype : "unknown",
    category: route.known ? route.subtype : "unknown",
    observedAt,
    reviewAt,
    freshness,
    scope: text(candidate.scope, 2_000),
    evidenceIds,
    relatedProjects: uniqueStrings(candidate.relatedProjects || candidate.related_projects, MAX_ENVIRONMENT_RELATION_IDS),
    relatedJudgments: uniqueStrings(candidate.relatedJudgments || candidate.related_judgments, MAX_ENVIRONMENT_RELATION_IDS),
    relatedActions: uniqueStrings(candidate.relatedActions || candidate.related_actions, MAX_ENVIRONMENT_RELATION_IDS),
  };
}

function evaluateEnvironmentFreshness(record, { now = Date.now() } = {}) {
  if (!record || record.knowledgeType !== "environment") {
    return Object.freeze({ status: null, requiresReview: false, reasonCode: null, reviewAt: null });
  }
  const explicit = normalizeFreshness(record.freshness, "current");
  const reviewAt = validDate(record.reviewAt || record.review_at);
  const effectiveUntil = validDate(record.effectiveUntil);
  if (explicit === "invalid") {
    return Object.freeze({ status: "invalid", requiresReview: false, reasonCode: "ENVIRONMENT_INVALID", reviewAt });
  }
  if (explicit === "stale") {
    return Object.freeze({ status: "stale", requiresReview: true, reasonCode: "ENVIRONMENT_STALE", reviewAt });
  }
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (effectiveUntil && Date.parse(effectiveUntil) < nowMs) {
    return Object.freeze({ status: "stale", requiresReview: true, reasonCode: "ENVIRONMENT_EFFECTIVE_PERIOD_ENDED", reviewAt });
  }
  if (reviewAt && Date.parse(reviewAt) <= nowMs) {
    return Object.freeze({ status: "stale", requiresReview: true, reasonCode: "ENVIRONMENT_REVIEW_DUE", reviewAt });
  }
  if (explicit === "monitoring") {
    return Object.freeze({ status: "monitoring", requiresReview: false, reasonCode: "ENVIRONMENT_MONITORING", reviewAt });
  }
  return Object.freeze({ status: "current", requiresReview: false, reasonCode: null, reviewAt });
}

function environmentImpactTargets(record) {
  if (!record || record.knowledgeType !== "environment") return Object.freeze({ projects: [], judgments: [], actions: [] });
  const projects = uniqueStrings(record.relatedProjects || record.related_projects, MAX_ENVIRONMENT_RELATION_IDS);
  const judgments = uniqueStrings(record.relatedJudgments || record.related_judgments, MAX_ENVIRONMENT_RELATION_IDS);
  const actions = uniqueStrings(record.relatedActions || record.related_actions, MAX_ENVIRONMENT_RELATION_IDS);
  for (const relation of Array.isArray(record.relatedKnowledge) ? record.relatedKnowledge : []) {
    const value = text(relation?.path || relation?.label || relation?.title || relation, 1_024);
    if (!value) continue;
    if (value.startsWith("05_目标与项目/")) projects.push(value);
    else if (value.startsWith("06_判断与决策/")) judgments.push(value);
    else if (value.startsWith("07_行动/")) actions.push(value);
  }
  return Object.freeze({
    projects: uniqueStrings(projects, MAX_ENVIRONMENT_RELATION_IDS),
    judgments: uniqueStrings(judgments, MAX_ENVIRONMENT_RELATION_IDS),
    actions: uniqueStrings(actions, MAX_ENVIRONMENT_RELATION_IDS),
  });
}

module.exports = {
  ENVIRONMENT_ROUTE_VERSION,
  ENVIRONMENT_ROOT,
  ENVIRONMENT_ROUTES,
  ENVIRONMENT_CATEGORY_OPTIONS,
  ALLOWED_ENVIRONMENT_CATEGORIES,
  FRESHNESS_STATES,
  MAX_ENVIRONMENT_EVIDENCE_IDS,
  canonicalEnvironmentSubtype,
  validateEnvironmentCategory,
  routeEnvironmentSubtype,
  normalizeEnvironmentCandidate,
  normalizeFreshness,
  evaluateEnvironmentFreshness,
  environmentImpactTargets,
  validDate,
  uniqueStrings,
};
