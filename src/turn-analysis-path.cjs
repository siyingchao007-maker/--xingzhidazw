"use strict";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,127}$/u;
const STATUS_VALUES = new Set(["selected", "completed", "failed"]);
const RELEASE_STATES = new Set(["current", "rolled-back", "unavailable"]);
const SELECTION_REASONS = new Set([
  "selected-explicit",
  "selected-fixed",
  "selected-semantic",
  "selected-automatic",
]);
const FILTER_REASONS = new Set([
  "unknown-skill",
  "invalid-type",
  "disabled",
  "unavailable-version",
  "conflict-with-selected",
  "total-skill-limit",
  "lens-limit",
  "context-budget",
  "migration-gate",
]);
const SOURCE_VALUES = new Set([
  "explicit-skill",
  "explicit-operator",
  "one-turn",
  "fixed",
  "semantic-skill",
  "semantic-operator",
  "automatic-operator",
  "automatic-skill",
  "automatic",
]);
const ROUTING_STRENGTH_MEANINGS = new Set([
  "rule-strength-not-probability",
  "model-reported-not-calibrated",
]);
const ISSUE_REASONS = new Set([
  ...FILTER_REASONS,
  "rolled-back",
  "routing-error",
]);

const SELECTION_REASON_LABELS = Object.freeze({
  "selected-explicit": "本轮明确指定",
  "selected-fixed": "已固定到当前对话",
  "selected-semantic": "按本轮语义匹配",
  "selected-automatic": "按任务特征自动匹配",
});

const FILTER_REASON_LABELS = Object.freeze({
  "unknown-skill": "目录中没有这个透镜，未加载",
  "invalid-type": "该能力不是认知透镜，未作为透镜加载",
  disabled: "该透镜当前已停用",
  "unavailable-version": "没有通过校验的可用版本",
  "conflict-with-selected": "与已选透镜冲突，未加载",
  "total-skill-limit": "本轮 Skill 总数已达到上限",
  "lens-limit": "已达到本轮认知透镜数量上限",
  "context-budget": "本轮上下文预算不足，未加载",
  "migration-gate": "迁移校验未通过，继续使用安全版本",
});

function boundedText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function boundedId(value) {
  const id = boundedText(value, 128).toLowerCase();
  return ID_PATTERN.test(id) ? id : "";
}

function boundedVersion(value) {
  const version = boundedText(value, 64);
  return VERSION_PATTERN.test(version) ? version : "";
}

function boundedHash(value) {
  const hash = boundedText(value, 80).toLowerCase();
  return HASH_PATTERN.test(hash) ? hash : "";
}

function boundedSources(values) {
  const result = [];
  for (const source of Array.isArray(values) ? values : []) {
    const normalized = boundedText(source, 80);
    if (!SOURCE_VALUES.has(normalized) || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= 8) break;
  }
  return result;
}

function identityFrom(raw, fallback = {}) {
  const snapshot = raw?.runtimeSnapshot && typeof raw.runtimeSnapshot === "object"
    ? raw.runtimeSnapshot : {};
  const id = boundedId(snapshot.id || raw?.name || raw?.id || fallback.id);
  if (!id) return null;
  const label = boundedText(raw?.label || raw?.displayName || fallback.label || id, 120) || id;
  const version = boundedVersion(snapshot.version || raw?.version || fallback.version);
  const contentHash = boundedHash(snapshot.contentHash || raw?.contentHash || fallback.contentHash);
  return {
    id,
    label,
    version: version || null,
    contentHash: contentHash || null,
  };
}

function normalizedIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = boundedId(raw.id);
  if (!id) return null;
  return {
    id,
    label: boundedText(raw.label, 120) || id,
    version: boundedVersion(raw.version) || null,
    contentHash: boundedHash(raw.contentHash) || null,
  };
}

function unmeasuredImpact() {
  return {
    measurement: "not-measured",
    changesConclusion: null,
    changesPriority: null,
    changesRisk: null,
    changesAction: null,
  };
}

function releaseStateFor(skill) {
  const release = skill?.release && typeof skill.release === "object" ? skill.release : null;
  if (release?.status === "rolled-back") return "rolled-back";
  if (release?.degraded === true) return "unavailable";
  if (release && ["active", "active-pending-health"].includes(release.status)) return "current";
  return identityFrom(skill) ? "current" : "unavailable";
}

function primaryFromPlan(plan) {
  const primary = plan?.primarySkill;
  if (!primary) {
    return {
      kind: "orchestrator",
      id: "xingzhi-orchestrator",
      label: "行知总控",
      version: null,
      contentHash: null,
    };
  }
  const identity = identityFrom(primary);
  if (!identity) {
    return {
      kind: "orchestrator",
      id: "xingzhi-orchestrator",
      label: "行知总控",
      version: null,
      contentHash: null,
    };
  }
  return { kind: "skill", ...identity };
}

function candidateMapFor(routing) {
  const candidates = new Map();
  for (const raw of Array.isArray(routing?.candidateIndex) ? routing.candidateIndex : []) {
    const identity = identityFrom(raw);
    if (identity && !candidates.has(identity.id)) candidates.set(identity.id, identity);
  }
  return candidates;
}

function boundedCount(value, maximum = 1_000_000) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum) : 0;
}

function routingMetricsFromPlan(routing, candidateMap, lenses, filtered, selectedMap, plan) {
  const loadedLensIds = new Set((Array.isArray(plan?.skills) ? plan.skills : [])
    .filter((skill) => skill?.skillType === "cognitive-lens")
    .map((skill) => boundedId(skill?.name || skill?.id))
    .filter(Boolean));
  const requestedIds = new Set([
    ...selectedMap.keys(),
    ...filtered.map((item) => item.identity.id),
  ]);
  const limits = routing?.limits && typeof routing.limits === "object"
    ? routing.limits : {};
  return {
    candidateCount: boundedCount(candidateMap.size, 64),
    requestedCount: boundedCount(requestedIds.size, 64),
    selectedCount: boundedCount(lenses.length, 16),
    filteredCount: boundedCount(filtered.length, 64),
    loadedBodyCount: boundedCount(loadedLensIds.size, 16),
    unexpectedLoadedBodyCount: boundedCount(
      [...loadedLensIds].filter((skillId) => !selectedMap.has(skillId)).length,
      16,
    ),
    selectedLensContextBytes: boundedCount(limits.selectedLensContextBytes, 1_000_000),
    reservedNonLensContextBytes: boundedCount(limits.reservedNonLensContextBytes, 1_000_000),
    contextBudgetBytes: boundedCount(limits.contextBudgetBytes, 1_000_000),
    maximumLenses: boundedCount(limits.maximumLenses, 16),
    maximumTotalSkills: boundedCount(limits.maximumTotalSkills, 32),
  };
}

function normalizeRoutingMetrics(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    candidateCount: boundedCount(value.candidateCount, 64),
    requestedCount: boundedCount(value.requestedCount, 64),
    selectedCount: boundedCount(value.selectedCount, 16),
    filteredCount: boundedCount(value.filteredCount, 64),
    loadedBodyCount: boundedCount(value.loadedBodyCount, 16),
    unexpectedLoadedBodyCount: boundedCount(value.unexpectedLoadedBodyCount, 16),
    selectedLensContextBytes: boundedCount(value.selectedLensContextBytes, 1_000_000),
    reservedNonLensContextBytes: boundedCount(value.reservedNonLensContextBytes, 1_000_000),
    contextBudgetBytes: boundedCount(value.contextBudgetBytes, 1_000_000),
    maximumLenses: boundedCount(value.maximumLenses, 16),
    maximumTotalSkills: boundedCount(value.maximumTotalSkills, 32),
  };
}

function buildTurnAnalysisPath(plan = {}) {
  const routing = plan?.cognitiveLensRouting && typeof plan.cognitiveLensRouting === "object"
    ? plan.cognitiveLensRouting : {};
  const candidateMap = candidateMapFor(routing);
  const selectedMap = new Map();
  for (const item of Array.isArray(routing.selected) ? routing.selected : []) {
    const skillId = boundedId(item?.skillId);
    if (skillId && !selectedMap.has(skillId)) selectedMap.set(skillId, item);
  }
  const lenses = [];
  for (const skill of Array.isArray(plan?.skills) ? plan.skills : []) {
    if (skill?.skillType !== "cognitive-lens") continue;
    const identity = identityFrom(skill, candidateMap.get(boundedId(skill?.name || skill?.id)));
    if (!identity || lenses.some((item) => item.identity.id === identity.id)) continue;
    const selected = selectedMap.get(identity.id) || {};
    const selectionReason = SELECTION_REASONS.has(selected.reasonCode)
      ? selected.reasonCode : "selected-automatic";
    lenses.push({
      identity,
      selectionReason,
      selectionSources: boundedSources(selected.sources),
      releaseState: releaseStateFor(skill),
      impact: unmeasuredImpact(),
    });
    if (lenses.length >= 4) break;
  }

  const filtered = [];
  for (const item of Array.isArray(routing.filtered) ? routing.filtered : []) {
    const id = boundedId(item?.skillId);
    if (!id || filtered.some((entry) => entry.identity.id === id)) continue;
    const identity = candidateMap.get(id) || {
      id,
      label: id,
      version: null,
      contentHash: null,
    };
    filtered.push({
      identity,
      reasonCode: FILTER_REASONS.has(item?.reasonCode) ? item.reasonCode : "unavailable-version",
      sources: boundedSources(item?.sources),
      conflictsWith: boundedId(item?.conflictsWith) || null,
    });
    if (filtered.length >= 16) break;
  }

  const issues = [];
  for (const item of lenses) {
    if (item.releaseState === "rolled-back") {
      issues.push({ type: "rollback", skillId: item.identity.id, reasonCode: "rolled-back" });
    } else if (item.releaseState === "unavailable") {
      issues.push({ type: "skill-unavailable", skillId: item.identity.id, reasonCode: "unavailable-version" });
    }
  }
  for (const item of filtered) {
    if (["unknown-skill", "invalid-type", "disabled", "unavailable-version", "migration-gate"].includes(item.reasonCode)) {
      issues.push({ type: "skill-unavailable", skillId: item.identity.id, reasonCode: item.reasonCode });
    }
  }
  if (boundedText(plan?.routingError, 1)) {
    issues.push({ type: "routing-error", skillId: null, reasonCode: "routing-error" });
  }

  const routingStrength = Number.isFinite(plan?.routingConfidence)
    ? Math.max(0, Math.min(1, plan.routingConfidence)) : null;
  return normalizeTurnAnalysisPath({
    version: 1,
    source: "runtime-trace",
    overallStatus: "selected",
    primary: primaryFromPlan(plan),
    routing: routingMetricsFromPlan(routing, candidateMap, lenses, filtered, selectedMap, plan),
    lenses,
    filtered,
    issues,
    disagreement: { status: "not-measured", items: [] },
    confidence: {
      status: "not-measured",
      value: null,
      routingStrength,
      routingStrengthMeaning: plan?.routingSource === "semantic-model"
        ? "model-reported-not-calibrated" : "rule-strength-not-probability",
    },
    provenance: {
      runtimeTrace: true,
      modelSelfReportUsed: false,
      hiddenReasoningIncluded: false,
    },
  });
}

function normalizeTurnAnalysisPath(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const primaryIdentity = normalizedIdentity(raw.primary);
  const primaryKind = raw.primary?.kind === "skill" ? "skill" : "orchestrator";
  const primary = primaryIdentity
    ? { kind: primaryKind, ...primaryIdentity }
    : {
        kind: "orchestrator",
        id: "xingzhi-orchestrator",
        label: "行知总控",
        version: null,
        contentHash: null,
      };

  const lenses = [];
  for (const item of Array.isArray(raw.lenses) ? raw.lenses : []) {
    const identity = normalizedIdentity(item?.identity);
    if (!identity || lenses.some((entry) => entry.identity.id === identity.id)) continue;
    lenses.push({
      identity,
      selectionReason: SELECTION_REASONS.has(item?.selectionReason)
        ? item.selectionReason : "selected-automatic",
      selectionSources: boundedSources(item?.selectionSources),
      releaseState: RELEASE_STATES.has(item?.releaseState) ? item.releaseState : "unavailable",
      impact: unmeasuredImpact(),
    });
    if (lenses.length >= 4) break;
  }

  const filtered = [];
  for (const item of Array.isArray(raw.filtered) ? raw.filtered : []) {
    const identity = normalizedIdentity(item?.identity);
    if (!identity || filtered.some((entry) => entry.identity.id === identity.id)) continue;
    filtered.push({
      identity,
      reasonCode: FILTER_REASONS.has(item?.reasonCode) ? item.reasonCode : "unavailable-version",
      sources: boundedSources(item?.sources),
      conflictsWith: boundedId(item?.conflictsWith) || null,
    });
    if (filtered.length >= 16) break;
  }

  const issues = [];
  for (const item of Array.isArray(raw.issues) ? raw.issues : []) {
    const type = ["rollback", "skill-unavailable", "routing-error"].includes(item?.type)
      ? item.type : null;
    if (!type) continue;
    const skillId = boundedId(item?.skillId) || null;
    const proposedReasonCode = boundedText(item?.reasonCode, 80);
    const reasonCode = ISSUE_REASONS.has(proposedReasonCode) ? proposedReasonCode : type;
    const key = `${type}:${skillId || "none"}:${reasonCode}`;
    if (issues.some((entry) => `${entry.type}:${entry.skillId || "none"}:${entry.reasonCode}` === key)) continue;
    issues.push({ type, skillId, reasonCode });
    if (issues.length >= 16) break;
  }

  const routingStrength = Number.isFinite(raw.confidence?.routingStrength)
    ? Math.max(0, Math.min(1, raw.confidence.routingStrength)) : null;
  const routingStrengthMeaning = ROUTING_STRENGTH_MEANINGS.has(raw.confidence?.routingStrengthMeaning)
    ? raw.confidence.routingStrengthMeaning : "rule-strength-not-probability";

  return {
    version: 1,
    source: "runtime-trace",
    overallStatus: STATUS_VALUES.has(raw.overallStatus) ? raw.overallStatus : "selected",
    primary,
    routing: normalizeRoutingMetrics(raw.routing),
    lenses,
    filtered,
    issues,
    disagreement: { status: "not-measured", items: [] },
    confidence: {
      status: "not-measured",
      value: null,
      routingStrength,
      routingStrengthMeaning,
    },
    provenance: {
      runtimeTrace: true,
      modelSelfReportUsed: false,
      hiddenReasoningIncluded: false,
    },
  };
}

function finalizeTurnAnalysisPath(raw, status) {
  const normalized = normalizeTurnAnalysisPath(raw);
  if (!normalized) return null;
  return {
    ...normalized,
    overallStatus: status === "failed" ? "failed" : "completed",
  };
}

function versionMeta(identity, releaseState) {
  const version = identity?.version ? `v${identity.version}` : "版本未记录";
  const release = {
    current: "当前版本",
    "rolled-back": "已回退到可用版本",
    unavailable: "版本不可用",
  }[releaseState] || "版本状态未知";
  return `${version} · ${release}`;
}

function filteredReason(item, identityById) {
  const base = FILTER_REASON_LABELS[item.reasonCode] || "未通过本轮加载条件";
  if (item.reasonCode !== "conflict-with-selected" || !item.conflictsWith) return base;
  const conflictLabel = identityById.get(item.conflictsWith)?.label || item.conflictsWith;
  return `与已选透镜冲突（${conflictLabel}），未加载`;
}

function issueLabel(item, identityById) {
  const skillLabel = item.skillId ? (identityById.get(item.skillId)?.label || item.skillId) : "能力路由";
  if (item.type === "rollback") return `${skillLabel}已回退到最近可用版本`;
  if (item.type === "routing-error") return "能力路由出现错误，本轮记录已保留";
  return `${skillLabel}未获得可用版本`;
}

function analysisPathCardModel(raw) {
  const path = normalizeTurnAnalysisPath(raw);
  if (!path || (!path.lenses.length && !path.filtered.length && !path.issues.length)) return null;
  const identityById = new Map();
  for (const item of path.lenses) identityById.set(item.identity.id, item.identity);
  for (const item of path.filtered) identityById.set(item.identity.id, item.identity);
  const status = {
    selected: { id: "active", label: "本轮已选配" },
    completed: { id: "completed", label: "本轮已完成" },
    failed: { id: "failed", label: "本轮执行未完成" },
  }[path.overallStatus];
  const routingPercent = Number.isFinite(path.confidence.routingStrength)
    ? `${Math.round(path.confidence.routingStrength * 100)}%` : "未记录";
  const routingDetail = path.confidence.routingStrengthMeaning === "model-reported-not-calibrated"
    ? "模型给出的匹配强度，尚未校准，不是回答准确率"
    : "规则匹配强度，不是概率，也不是回答准确率";
  return {
    visible: true,
    title: "本轮分析路径",
    evidenceBadge: "真实运行记录",
    status,
    primary: {
      label: "主执行",
      value: path.primary.label,
      meta: path.primary.kind === "skill" && path.primary.version
        ? `Skill · v${path.primary.version}` : "行知总控综合",
    },
    lenses: path.lenses.map((item) => ({
      id: item.identity.id,
      label: item.identity.label,
      meta: versionMeta(item.identity, item.releaseState),
      reason: SELECTION_REASON_LABELS[item.selectionReason] || "按本轮任务匹配",
      impact: "实际影响未单独测量",
      impactDetail: "结论、优先级、风险、行动四项均未单独测量",
    })),
    filtered: {
      count: path.filtered.length,
      items: path.filtered.map((item) => ({
        id: item.identity.id,
        label: item.identity.label,
        version: item.identity.version ? `v${item.identity.version}` : "版本未记录",
        reason: filteredReason(item, identityById),
      })),
    },
    disagreement: {
      status: path.disagreement.status,
      value: path.lenses.length > 1
        ? "未单独测量，不能据此判断透镜之间是否存在分析分歧"
        : "未单独测量",
    },
    confidence: { label: "综合结论置信度", value: "未独立测量" },
    routingStrength: {
      label: "路由匹配强度",
      value: routingPercent,
      detail: routingDetail,
    },
    issues: {
      count: path.issues.length,
      items: path.issues.map((item) => issueLabel(item, identityById)),
    },
    provenance: "来自本轮运行诊断；不包含内部提示词或隐藏推理。",
  };
}

module.exports = {
  FILTER_REASON_LABELS,
  SELECTION_REASON_LABELS,
  analysisPathCardModel,
  buildTurnAnalysisPath,
  finalizeTurnAnalysisPath,
  normalizeTurnAnalysisPath,
};
