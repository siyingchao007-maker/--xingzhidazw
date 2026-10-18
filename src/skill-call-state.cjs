"use strict";

// These are delivery milestones, never evidence that the model followed a method.
const SKILL_MODE_LABELS = Object.freeze({ auto: "被动建议", recommend: "先推荐后调用", manual: "完全手动" });
const clean = (value, max = 160) => typeof value === "string" ? value.slice(0, max) : "";
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const skillId = row => clean(row?.name || row?.id);
const toolCallId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,300}$/u.test(value) ? value : null;
const hash = value => clean(value, 80).replace(/^sha256:/u, "");

function isDemandReadReceipt(receipt, row, attemptId, expectedVersion, expectedHash, expectedToolCallId) {
  const expectedBodyHash = hash(row.runtimeSnapshot?.bodyHash || row.bodyHash);
  return row.source === "model-demand" && row.applicationMode === "governing"
    && receipt?.issuer === "plugin-vault-reader" && receipt.scope === "local-tool-result"
    && receipt.skillId === skillId(row) && receipt.attemptId === attemptId
    && ["codex-app-server", "provider-api"].includes(receipt.channel)
    && expectedToolCallId && receipt.toolCallId === expectedToolCallId
    && expectedVersion && receipt.version === expectedVersion
    && /^[a-f0-9]{64}$/u.test(expectedHash) && hash(receipt.definitionHash) === expectedHash
    && /^[a-f0-9]{64}$/u.test(receipt.contentHash || "")
    && (!expectedBodyHash || receipt.contentHash === expectedBodyHash)
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && stamp(receipt.readAt);
}

function normalizeSkillCall(row = {}) {
  if (!row || typeof row !== "object") row = {};
  const raw = row.callState;
  const valid = raw?.schemaVersion === 1 && clean(raw.attemptId);
  const attemptId = valid ? clean(raw.attemptId) : null;
  const advisory = row.applicationMode === "advisory";
  const receipt = valid && !advisory ? raw.readReceipt : null;
  const expectedToolCallId = valid && row.source === "model-demand" ? toolCallId(raw.toolCallId) : null;
  const expectedVersion = clean(row.runtimeSnapshot?.version || row.release?.resolvedVersion || row.version, 64);
  const expectedHash = clean(row.runtimeSnapshot?.contentHash || row.release?.resolvedHash || row.contentHash, 80).replace(/^sha256:/u, "");
  const legacyReadReceipt = row.source !== "model-demand" && receipt?.issuer === "plugin-vault-reader"
    && receipt.scope === "local-prompt" && receipt.skillId === skillId(row)
    && receipt.attemptId === attemptId && receipt.channel === "provider-api"
    && /^[a-f0-9]{64}$/.test(receipt.contentHash || "")
    && (!expectedVersion || receipt.version === expectedVersion)
    // Legacy definition hashes include configuration as well as instructions.
    && (!expectedHash || clean(receipt.definitionHash || receipt.contentHash, 80).replace(/^sha256:/u, "") === expectedHash)
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && stamp(receipt.readAt);
  const demandReadReceipt = isDemandReadReceipt(receipt, row, attemptId, expectedVersion, expectedHash, expectedToolCallId);
  const readReceipt = legacyReadReceipt || demandReadReceipt
    ? { issuer: receipt.issuer, scope: receipt.scope, skillId: receipt.skillId,
        attemptId, channel: receipt.channel, contentHash: receipt.contentHash,
        bytes: receipt.bytes, readAt: receipt.readAt, version: clean(receipt.version, 64) || null,
        definitionHash: clean(receipt.definitionHash, 80) || null,
        ...(demandReadReceipt ? { toolCallId: expectedToolCallId } : {}) }
    : null;
  const submittedAt = valid && !advisory ? stamp(raw.submittedAt) : null;
  const outcome = valid && ["completed", "failed", "cancelled", "interrupted"].includes(raw.outcome) ? raw.outcome : null;
  return {
    instructionLoaded: Boolean(readReceipt),
    callState: {
      schemaVersion: 1, attemptId,
      ...(expectedToolCallId ? { toolCallId: expectedToolCallId } : {}),
      stage: !valid ? "historical-unconfirmed" : advisory ? "recommended"
        : readReceipt ? "read-confirmed" : submittedAt ? "submitted" : "selected",
      selectedAt: valid && !advisory ? stamp(raw.selectedAt) : null,
      submittedAt, readReceipt, outcome,
      finishedAt: outcome ? stamp(raw.finishedAt) : null,
    },
  };
}

function startSkillCalls(rows, attemptId, at) {
  return (Array.isArray(rows) ? rows : []).slice(0, 24).map(row => ({
    ...row, ...normalizeSkillCall({ ...row, callState: {
      schemaVersion: 1, attemptId, selectedAt: at,
    } }),
  }));
}

function advanceSkillCalls(rows, attemptId, event, details = {}, at) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const normalized = normalizeSkillCall(row), state = normalized.callState;
    if (!attemptId || state.attemptId !== attemptId || state.outcome) return { ...row, ...normalized };
    const next = { ...state };
    if (row.applicationMode !== "advisory") {
      if (event === "submitted" && (!details.skillIds || details.skillIds.includes(skillId(row)))) next.submittedAt ||= at;
      if (event === "read-confirmed") {
        const receipt = (Array.isArray(details.receipts) ? details.receipts : []).find(item => item?.skillId === skillId(row));
        if (receipt) next.readReceipt = receipt;
      }
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(event)) {
      next.outcome = event; next.finishedAt = at;
    }
    return { ...row, ...normalizeSkillCall({ ...row, callState: next }) };
  });
}

function skillCallLabel(row) {
  const { callState: state } = normalizeSkillCall(row);
  const milestone = {
    "historical-unconfirmed": "历史记录 · 读取未确认",
    recommended: "已推荐", selected: "已选择", submitted: "已提交 · 读取未确认",
    "read-confirmed": "已确认读取（插件）",
  }[state.stage];
  const terminal = { completed: "本轮完成", failed: "本轮失败", cancelled: "本轮取消", interrupted: "本轮中断" }[state.outcome];
  return [terminal, milestone].filter(Boolean).join(" · ");
}

function skillCallDescription(row) {
  const state = normalizeSkillCall(row).callState;
  if (state.stage === "read-confirmed" && state.readReceipt?.scope === "local-tool-result") return `${skillCallLabel(row)}；仅确认插件已完整读取正文并生成工具结果。${state.submittedAt ? "已向模型通道发起提交。" : "尚未向模型通道提交。"}本地读取与通道提交不证明模型理解或遵循方法。`;
  if (state.stage === "read-confirmed") return `${skillCallLabel(row)}；仅确认插件已读取正文并组装提示，不证明模型读取或遵循。${state.submittedAt ? "已向模型通道发起提交。" : "尚未向模型通道提交。"}`;
  if (state.stage === "submitted") return `${skillCallLabel(row)}；已向模型通道发起请求，服务未提供正文读取回执。`;
  if (state.stage === "recommended") return `${skillCallLabel(row)}；仅名称与简短说明，未加载正文。`;
  return `${skillCallLabel(row)}；没有可验证的正文读取回执。`;
}

function interruptUnfinishedSkillCalls(rows, at) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const normalized = { ...row, ...normalizeSkillCall(row) };
    return normalized.callState.attemptId && !normalized.callState.outcome
      ? advanceSkillCalls([normalized], normalized.callState.attemptId, "interrupted", {}, at)[0] : normalized;
  });
}

function normalizeCoordinationTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return null;
  const ids = value => (Array.isArray(value) ? value : []).slice(0, 24).map(id => clean(id, 128)).filter(Boolean);
  return { originalAgentId: clean(trace.originalAgentId, 128), selectedAgentId: clean(trace.selectedAgentId, 128),
    agentChanged: trace.agentChanged === true, requiredSkillIds: ids(trace.requiredSkillIds), retainedSkillIds: ids(trace.retainedSkillIds),
    omittedSkills: (Array.isArray(trace.omittedSkills) ? trace.omittedSkills : []).slice(0, 24).map(row => ({
      id: clean(row?.id, 128), reasonCode: clean(row?.reasonCode, 80), reason: clean(row?.reason, 400),
    })).filter(row => row.id) };
}

function normalizeCapabilityTrace(trace, interruptedAt = null) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return null;
  // Persist the bounded existing trace. Do not copy body text or arbitrary objects.
  let skills = (Array.isArray(trace.skills) ? trace.skills : []).slice(0, 24).map(row => {
    const demand = row?.source === "model-demand";
    const safe = { id: skillId(row), label: clean(row?.label, 200),
      version: clean(demand ? row?.runtimeSnapshot?.version || row?.release?.resolvedVersion || row?.version : row?.version, 64),
      skillType: clean(row?.skillType, 40), source: clean(row?.source, 40), contentHash: clean(row?.contentHash, 80) || null,
      applicationMode: row?.applicationMode === "advisory" ? "advisory" : "governing" };
    if (demand) {
      safe.contentHash = clean(row?.runtimeSnapshot?.contentHash || row?.release?.resolvedHash || row?.contentHash, 80) || null;
      safe.reason = clean(row?.reason, 240);
      const bodyHash = clean(row?.runtimeSnapshot?.bodyHash || row?.bodyHash, 80);
      if (bodyHash) safe.bodyHash = bodyHash;
    }
    return { ...safe, ...normalizeSkillCall({ ...safe,
      ...(demand ? { applicationMode: row?.applicationMode } : {}), callState: row?.callState }) };
  }).filter(row => row.id);
  if (interruptedAt) skills = interruptUnfinishedSkillCalls(skills, interruptedAt);
  return { schemaVersion: 2, skills, primarySkillId: clean(trace.primarySkillId) || null,
    coordination: normalizeCoordinationTrace(trace.coordination),
    agent: trace.agent ? { id: clean(trace.agent.id), label: clean(trace.agent.label, 200), reason: clean(trace.agent.reason, 600) } : null,
    lenses: (Array.isArray(trace.lenses) ? trace.lenses : []).slice(0, 16).map(row => ({
      id: clean(row?.id), label: clean(row?.label, 200), phase: clean(row?.phase, 40),
      instructionSource: clean(row?.instructionSource, 40), resolvedSkillId: clean(row?.resolvedSkillId),
    })),
    omittedLensIds: (Array.isArray(trace.omittedLensIds) ? trace.omittedLensIds : []).slice(0, 24).map(id => clean(id)),
    workflow: clean(trace.workflow, 80) || null, taskLevel: clean(trace.taskLevel, 40) || null,
    outputDepth: clean(trace.outputDepth, 40) || null, sourceMode: clean(trace.sourceMode, 80) || null,
    allowWebSearch: trace.allowWebSearch === true, routingSource: clean(trace.routingSource, 80) || null,
    routingConfidence: Number.isFinite(trace.routingConfidence) ? Math.max(0, Math.min(1, trace.routingConfidence)) : null,
  };
}

module.exports = { SKILL_MODE_LABELS, normalizeSkillCall, startSkillCalls, advanceSkillCalls, normalizeCoordinationTrace,
  skillCallLabel, skillCallDescription, normalizeCapabilityTrace, interruptUnfinishedSkillCalls };
