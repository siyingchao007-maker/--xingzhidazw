"use strict";

const MIGRATION_DOMAINS = Object.freeze([
  "product",
  "career",
  "personal-decision",
  "simple-negative",
]);
const MINIMUM_CASES_PER_DOMAIN = 2;
const MINIMUM_TOTAL_CASES = MIGRATION_DOMAINS.length * MINIMUM_CASES_PER_DOMAIN;
const FIRST_PRINCIPLES_MIGRATION_SUITE_VERSION = "first-principles-shadow-pilot/v1";
const SYSTEM_FEEDBACK_MIGRATION_DOMAINS = Object.freeze([
  "business-operations",
  "product-delivery",
  "personal-system",
  "simple-negative",
]);
const SYSTEM_FEEDBACK_MIGRATION_SUITE_VERSION = "system-feedback-shadow-pilot/v1";
const CAUSAL_EVIDENCE_MIGRATION_DOMAINS = Object.freeze([
  "causal-explanation",
  "evidence-audit",
  "joint",
  "simple-negative",
]);
const CAUSAL_EVIDENCE_MIGRATION_SUITE_VERSION = "causal-evidence-shadow-pilot/v1";
const REVERSAL_FAILURE_MIGRATION_DOMAINS = Object.freeze([
  "failure-premortem",
  "goal-backcasting",
  "joint",
  "simple-negative",
]);
const REVERSAL_FAILURE_MIGRATION_SUITE_VERSION = "reversal-failure-shadow-pilot/v1";
const CONTRADICTION_STAGE_MIGRATION_DOMAINS = Object.freeze([
  "product",
  "career",
  "relationship",
  "long-term-growth",
  "simple-negative",
]);
const CONTRADICTION_STAGE_MIGRATION_SUITE_VERSION = "contradiction-stage-shadow-pilot/v1";
const INCENTIVE_STRUCTURE_MIGRATION_DOMAINS = Object.freeze([
  "customer",
  "collaboration",
  "workplace",
  "platform-rules",
  "simple-negative",
]);
const INCENTIVE_STRUCTURE_MIGRATION_SUITE_VERSION = "incentive-structure-shadow-pilot/v1";
const MIGRATION_SUITES = Object.freeze({
  "xingzhi-first-principles": Object.freeze({
    suiteVersion: FIRST_PRINCIPLES_MIGRATION_SUITE_VERSION,
    domains: MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
  "xingzhi-system-feedback-analysis": Object.freeze({
    suiteVersion: SYSTEM_FEEDBACK_MIGRATION_SUITE_VERSION,
    domains: SYSTEM_FEEDBACK_MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
  "xingzhi-causal-evidence-audit": Object.freeze({
    suiteVersion: CAUSAL_EVIDENCE_MIGRATION_SUITE_VERSION,
    domains: CAUSAL_EVIDENCE_MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
  "xingzhi-reversal-failure-conditions": Object.freeze({
    suiteVersion: REVERSAL_FAILURE_MIGRATION_SUITE_VERSION,
    domains: REVERSAL_FAILURE_MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
  "xingzhi-contradiction-stage-analysis": Object.freeze({
    suiteVersion: CONTRADICTION_STAGE_MIGRATION_SUITE_VERSION,
    domains: CONTRADICTION_STAGE_MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
  "xingzhi-incentive-structure-analysis": Object.freeze({
    suiteVersion: INCENTIVE_STRUCTURE_MIGRATION_SUITE_VERSION,
    domains: INCENTIVE_STRUCTURE_MIGRATION_DOMAINS,
    minimumCasesPerDomain: MINIMUM_CASES_PER_DOMAIN,
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactIdentity(diagnostic, identity) {
  return diagnostic?.shadow?.skillId === identity.skillId
    && diagnostic.shadow.skillVersion === identity.skillVersion
    && diagnostic.shadow.contentHash === identity.contentHash;
}

function hasCostMetrics(diagnostic) {
  return Number.isSafeInteger(diagnostic?.cost?.legacy?.tokenUsage?.totalTokens)
    && Number.isSafeInteger(diagnostic?.cost?.shadow?.tokenUsage?.totalTokens)
    && Number.isFinite(diagnostic?.cost?.legacy?.latencyMs)
    && Number.isFinite(diagnostic?.cost?.shadow?.latencyMs);
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function migrationSuite(skillId) {
  return MIGRATION_SUITES[String(skillId || "")] || null;
}

function evaluateCognitiveLensMigrationGate({
  skillId,
  skillVersion,
  contentHash,
  diagnostics = [],
} = {}) {
  const identity = {
    skillId: String(skillId || ""),
    skillVersion: String(skillVersion || ""),
    contentHash: String(contentHash || ""),
  };
  const reasons = [];
  const suite = migrationSuite(identity.skillId);
  if (!suite) addReason(reasons, "unsupported-migration-suite");
  if (!/^[a-z][a-z0-9-]{2,127}$/u.test(identity.skillId)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(identity.skillVersion)
    || !/^sha256:[0-9a-f]{64}$/u.test(identity.contentHash)) {
    addReason(reasons, "invalid-release-identity");
  }
  const candidateRows = (Array.isArray(diagnostics) ? diagnostics : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
  const unique = new Map();
  for (const item of candidateRows.filter((row) => exactIdentity(row, identity))) {
    const evaluatedAt = Date.parse(item.createdAt);
    if (!/^sha256:[0-9a-f]{64}$/u.test(item.inputFingerprint)
      || !["passed", "review", "shadow-failed"].includes(item.status)
      || !Number.isFinite(evaluatedAt)) continue;
    const previous = unique.get(item.inputFingerprint);
    if (!previous || evaluatedAt >= Date.parse(previous.createdAt)) {
      unique.set(item.inputFingerprint, item);
    }
  }
  const rows = [...unique.values()];
  const completedRows = rows.filter((item) => item.status !== "shadow-failed");
  const requiredDomains = suite?.domains || [];
  const minimumCasesPerDomain = suite?.minimumCasesPerDomain || 0;
  const requiredCases = requiredDomains.length * minimumCasesPerDomain;
  const domainCounts = Object.fromEntries(requiredDomains.map((domain) => [domain, 0]));
  for (const row of completedRows) {
    if (Object.hasOwn(domainCounts, row.domain)) domainCounts[row.domain] += 1;
  }
  if (completedRows.length < requiredCases) addReason(reasons, "insufficient-total-cases");
  if (requiredDomains.some((domain) => domainCounts[domain] < minimumCasesPerDomain)) {
    addReason(reasons, "insufficient-domain-coverage");
  }
  if (rows.some((item) => item.status === "shadow-failed")) {
    addReason(reasons, "shadow-failure");
  }
  if (completedRows.some((item) => Array.isArray(item.issues)
    && item.issues.some((issue) => issue?.severity === "error" || issue?.severity === "warning"))) {
    addReason(reasons, "blocking-quality-issue");
  }
  if (completedRows.some((item) => !Number.isFinite(item?.completeness?.delta)
    || item.completeness.delta < 0)) {
    addReason(reasons, "completeness-regression");
  }
  if (completedRows.some((item) => item.domain === "simple-negative"
    && item?.shadow?.applicable !== false)) {
    addReason(reasons, "negative-case-triggered");
  }
  if (completedRows.some((item) => !hasCostMetrics(item))) {
    addReason(reasons, "missing-cost-metrics");
  }
  return deepFreeze({
    version: 1,
    suiteVersion: suite?.suiteVersion || null,
    ...identity,
    passed: reasons.length === 0,
    reasonCodes: reasons,
    qualifyingCases: completedRows.length,
    requiredCases,
    domainCounts,
    requiredDomains: [...requiredDomains],
    minimumCasesPerDomain,
  });
}

function publishedCognitiveLensMigrationGate({
  skillId,
  skillVersion,
  contentHash,
  evaluation,
} = {}) {
  const suite = migrationSuite(skillId);
  if (!suite || !evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)
    || evaluation.suiteVersion !== suite.suiteVersion
    || evaluation.passed !== true
    || !Number.isSafeInteger(evaluation.caseCount)
    || evaluation.caseCount < suite.domains.length * suite.minimumCasesPerDomain) return null;
  const identityCheck = evaluateCognitiveLensMigrationGate({
    skillId,
    skillVersion,
    contentHash,
    diagnostics: [],
  });
  if (identityCheck.reasonCodes.includes("invalid-release-identity")) return null;
  return deepFreeze({
    version: 1,
    suiteVersion: suite.suiteVersion,
    skillId: String(skillId),
    skillVersion: String(skillVersion),
    contentHash: String(contentHash),
    passed: true,
    reasonCodes: [],
    qualifyingCases: evaluation.caseCount,
    requiredCases: suite.domains.length * suite.minimumCasesPerDomain,
    domainCounts: Object.fromEntries(suite.domains.map((domain) => [domain, suite.minimumCasesPerDomain])),
    requiredDomains: [...suite.domains],
    minimumCasesPerDomain: suite.minimumCasesPerDomain,
    evidenceSource: "published-evaluation",
  });
}

module.exports = {
  CAUSAL_EVIDENCE_MIGRATION_DOMAINS,
  CAUSAL_EVIDENCE_MIGRATION_SUITE_VERSION,
  CONTRADICTION_STAGE_MIGRATION_DOMAINS,
  CONTRADICTION_STAGE_MIGRATION_SUITE_VERSION,
  FIRST_PRINCIPLES_MIGRATION_SUITE_VERSION,
  INCENTIVE_STRUCTURE_MIGRATION_DOMAINS,
  INCENTIVE_STRUCTURE_MIGRATION_SUITE_VERSION,
  MIGRATION_DOMAINS,
  MINIMUM_CASES_PER_DOMAIN,
  MINIMUM_TOTAL_CASES,
  REVERSAL_FAILURE_MIGRATION_DOMAINS,
  REVERSAL_FAILURE_MIGRATION_SUITE_VERSION,
  SYSTEM_FEEDBACK_MIGRATION_DOMAINS,
  SYSTEM_FEEDBACK_MIGRATION_SUITE_VERSION,
  evaluateCognitiveLensMigrationGate,
  migrationSuite,
  publishedCognitiveLensMigrationGate,
};
