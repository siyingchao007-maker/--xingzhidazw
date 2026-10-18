"use strict";

const {
  isSkillVisibleInDialogue,
  normalizedSkillType,
  skillTypePolicy,
} = require("./capability-surface.cjs");

const DEFAULT_MAX_LENSES = 3;
const COMPLEX_MAX_LENSES = 4;
const DEFAULT_MAX_TOTAL_SKILLS = 4;
const DEFAULT_CONTEXT_BUDGET = 64 * 1024;
const MAX_CANDIDATE_INDEX_ITEMS = 32;
const MAX_CANDIDATE_INDEX_BYTES = 16 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMPLEX_TASK_LEVELS = new Set(["T3_PANEL", "T4_GATED"]);
const RELEASE_STATUSES = new Set(["active", "active-pending-health", "rolled-back"]);
const SOURCE_PRIORITY = Object.freeze({
  "explicit-skill": 600,
  "explicit-operator": 580,
  "one-turn": 560,
  fixed: 500,
  "semantic-skill": 400,
  "semantic-operator": 380,
  "automatic-operator": 300,
  "automatic-skill": 200,
  automatic: 180,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function boundedText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function boundedId(value) {
  const id = boundedText(value, 128);
  return /^[a-z0-9][a-z0-9-]{1,127}$/u.test(id) ? id : "";
}

function boundedIds(values, maximum = 8) {
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const id = boundedId(raw?.id || raw);
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length >= maximum) break;
  }
  return result;
}

function releaseIsUsable(skill) {
  const release = skill?.release;
  if (!release) return true;
  return release.degraded !== true
    && RELEASE_STATUSES.has(release.status)
    && release.resolvedFrom === "active"
    && VERSION_PATTERN.test(boundedText(release.resolvedVersion, 64))
    && HASH_PATTERN.test(boundedText(release.resolvedHash, 80).toLowerCase());
}

function instructionBytesFor(skill) {
  return Number.isSafeInteger(skill?.instructionBytes) && skill.instructionBytes >= 0
    ? skill.instructionBytes : 0;
}

function skillAvailability(skill, availabilityOverride) {
  if (!skill) return { available: false, reasonCode: "unknown-skill" };
  if (normalizedSkillType(skill) !== "cognitive-lens") {
    return { available: false, reasonCode: "invalid-type" };
  }
  if (skill.enabled === false || !isSkillVisibleInDialogue(skill)) {
    return { available: false, reasonCode: "disabled" };
  }
  if (!VERSION_PATTERN.test(boundedText(skill?.release?.resolvedVersion || skill.version, 64))
    || (skill.instructionBytes !== undefined
      && (!Number.isSafeInteger(skill.instructionBytes) || skill.instructionBytes < 0))
    || !releaseIsUsable(skill)) {
    return { available: false, reasonCode: "unavailable-version" };
  }
  if (availabilityOverride === false || availabilityOverride?.available === false) {
    return {
      available: false,
      reasonCode: boundedText(availabilityOverride?.reasonCode, 80) || "unavailable-version",
    };
  }
  return { available: true, reasonCode: "available" };
}

function availabilityOverrideFor(overrides, skillId) {
  if (overrides instanceof Map) return overrides.get(skillId);
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) return overrides[skillId];
  return undefined;
}

function candidateMetadata(skill, availabilityOverride) {
  const policy = skillTypePolicy(skill);
  const availability = skillAvailability(skill, availabilityOverride);
  const contentHash = boundedText(skill?.release?.resolvedHash || skill?.contentHash, 80).toLowerCase();
  return {
    id: boundedId(skill?.name || skill?.id),
    label: boundedText(skill?.displayName || skill?.label || skill?.name || skill?.id, 120),
    description: boundedText(skill?.description, 240),
    version: boundedText(skill?.release?.resolvedVersion || skill?.version, 64),
    ...(HASH_PATTERN.test(contentHash) ? { contentHash } : {}),
    instructionBytes: Math.min(instructionBytesFor(skill), DEFAULT_CONTEXT_BUDGET * 4),
    skillType: policy.skillType,
    primaryEligible: policy.primaryEligible,
    controlsFinalLayout: policy.controlsFinalLayout,
    conflicts: boundedIds(skill?.conflicts),
    operatorIds: boundedIds(skill?.recommendedOperators || skill?.operators),
    available: availability.available,
    availabilityReason: availability.reasonCode,
  };
}

function buildCognitiveLensCandidateIndex(skills, { availabilityOverrides } = {}) {
  const candidates = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && normalizedSkillType(skill) === "cognitive-lens")
    .map((skill) => candidateMetadata(
      skill,
      availabilityOverrideFor(availabilityOverrides, boundedId(skill?.name || skill?.id)),
    ))
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = [];
  for (const item of candidates.slice(0, MAX_CANDIDATE_INDEX_ITEMS)) {
    const next = [...result, item];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_CANDIDATE_INDEX_BYTES) break;
    result.push(item);
  }
  return deepFreeze(result);
}

function normalizeRequests(requests) {
  const grouped = new Map();
  for (const [index, request] of (Array.isArray(requests) ? requests : []).entries()) {
    const skillId = boundedId(request?.skillId || request?.id);
    const source = boundedText(request?.source, 80) || "automatic";
    if (!skillId) continue;
    if (!grouped.has(skillId)) {
      grouped.set(skillId, {
        skillId,
        sources: [],
        priority: 0,
        firstIndex: index,
      });
    }
    const item = grouped.get(skillId);
    if (!item.sources.includes(source)) item.sources.push(source);
    item.priority = Math.max(item.priority, SOURCE_PRIORITY[source] || 0);
  }
  return [...grouped.values()].sort((left, right) => right.priority - left.priority
    || left.firstIndex - right.firstIndex || left.skillId.localeCompare(right.skillId));
}

function selectionReason(sources) {
  if (sources.some((source) => source.startsWith("explicit") || source === "one-turn")) {
    return "selected-explicit";
  }
  if (sources.includes("fixed")) return "selected-fixed";
  if (sources.some((source) => source.startsWith("semantic"))) return "selected-semantic";
  return "selected-automatic";
}

function conflictingSkill(skill, selected, skillMap) {
  const candidateId = boundedId(skill?.name || skill?.id);
  const candidateConflicts = new Set(boundedIds(skill?.conflicts, 16));
  return selected.find((item) => {
    const selectedSkill = skillMap.get(item.skillId);
    const selectedConflicts = new Set(boundedIds(selectedSkill?.conflicts, 16));
    return candidateConflicts.has(item.skillId) || selectedConflicts.has(candidateId);
  })?.skillId || null;
}

function routeCognitiveLenses({
  skills = [],
  requests = [],
  taskLevel = "T2_JUDGMENT",
  nonLensSkillIds = [],
  nonLensContextBytes = 0,
  contextBudgetBytes = DEFAULT_CONTEXT_BUDGET,
  maxTotalSkills = DEFAULT_MAX_TOTAL_SKILLS,
  availabilityOverrides,
} = {}) {
  const skillMap = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const id = boundedId(skill?.name || skill?.id);
    if (id && !skillMap.has(id)) skillMap.set(id, skill);
  }
  const nonLensCount = new Set(boundedIds(nonLensSkillIds, 16)).size;
  const totalSkillLimit = Number.isSafeInteger(maxTotalSkills) && maxTotalSkills > 0
    ? Math.min(maxTotalSkills, 16) : DEFAULT_MAX_TOTAL_SKILLS;
  const contextBudget = Number.isSafeInteger(contextBudgetBytes) && contextBudgetBytes > 0
    ? contextBudgetBytes : DEFAULT_CONTEXT_BUDGET;
  const reservedBytes = Number.isSafeInteger(nonLensContextBytes) && nonLensContextBytes > 0
    ? nonLensContextBytes : 0;
  const maximumLenses = COMPLEX_TASK_LEVELS.has(taskLevel)
    ? COMPLEX_MAX_LENSES : DEFAULT_MAX_LENSES;
  const selected = [];
  const filtered = [];
  let selectedLensBytes = 0;

  for (const request of normalizeRequests(requests)) {
    const skill = skillMap.get(request.skillId);
    const availability = skillAvailability(
      skill,
      availabilityOverrideFor(availabilityOverrides, request.skillId),
    );
    const diagnostic = {
      skillId: request.skillId,
      sources: [...request.sources],
      reasonCode: availability.reasonCode,
    };
    if (!availability.available) {
      filtered.push(diagnostic);
      continue;
    }
    const conflictsWith = conflictingSkill(skill, selected, skillMap);
    if (conflictsWith) {
      filtered.push({ ...diagnostic, reasonCode: "conflict-with-selected", conflictsWith });
      continue;
    }
    if (nonLensCount + selected.length >= totalSkillLimit) {
      filtered.push({ ...diagnostic, reasonCode: "total-skill-limit" });
      continue;
    }
    if (selected.length >= maximumLenses) {
      filtered.push({ ...diagnostic, reasonCode: "lens-limit" });
      continue;
    }
    const instructionBytes = instructionBytesFor(skill);
    if (reservedBytes + selectedLensBytes + instructionBytes > contextBudget) {
      filtered.push({ ...diagnostic, reasonCode: "context-budget" });
      continue;
    }
    selectedLensBytes += instructionBytes;
    selected.push({
      ...diagnostic,
      reasonCode: selectionReason(request.sources),
      instructionBytes,
    });
  }

  return deepFreeze({
    selectedSkillIds: selected.map((item) => item.skillId),
    selected,
    filtered,
    candidateIndex: buildCognitiveLensCandidateIndex(skills, { availabilityOverrides }),
    limits: {
      maximumLenses,
      maximumTotalSkills: totalSkillLimit,
      nonLensSkillCount: nonLensCount,
      contextBudgetBytes: contextBudget,
      reservedNonLensContextBytes: reservedBytes,
      selectedLensContextBytes: selectedLensBytes,
    },
    evidencePolicy: {
      weighting: "one-per-source-and-quote",
      repeatedAcrossLensesAddsWeight: false,
      majorityVoteUsed: false,
    },
  });
}

module.exports = {
  COMPLEX_MAX_LENSES,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_LENSES,
  DEFAULT_MAX_TOTAL_SKILLS,
  MAX_CANDIDATE_INDEX_BYTES,
  MAX_CANDIDATE_INDEX_ITEMS,
  buildCognitiveLensCandidateIndex,
  routeCognitiveLenses,
};
