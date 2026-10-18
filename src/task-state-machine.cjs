"use strict";

const TASK_STATE_SCHEMA_VERSION = 1;
const MAX_TASK_EVENTS = 64;
const TASK_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "semantic-understanding", label: "语义理解", checkpointSafe: true }),
  Object.freeze({ id: "evidence-retrieval", label: "证据检索", checkpointSafe: true }),
  Object.freeze({ id: "agent-routing", label: "Agent 路由", checkpointSafe: true }),
  Object.freeze({ id: "skill-routing", label: "Skill 组合", checkpointSafe: true }),
  Object.freeze({ id: "planning", label: "计划与执行准备", checkpointSafe: true }),
  Object.freeze({ id: "execution", label: "Agent 执行", checkpointSafe: false }),
  Object.freeze({ id: "quality-evaluation", label: "主回答质量验收", checkpointSafe: false }),
  Object.freeze({ id: "response-commit", label: "回答提交", checkpointSafe: false }),
]);
const TASK_STAGE_IDS = new Set(TASK_STAGE_DEFINITIONS.map((stage) => stage.id));
const TASK_STAGE_STATUSES = new Set(["pending", "active", "completed", "failed", "blocked", "skipped"]);

function boundedTaskText(value, maximum = 600) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeTaskTime(value) {
  const candidate = typeof value === "string" && value ? value : new Date().toISOString();
  return Number.isNaN(Date.parse(candidate)) ? new Date().toISOString() : candidate;
}

function freshTaskStage(definition, active = false, now = null) {
  const startedAt = active ? safeTaskTime(now) : null;
  return {
    id: definition.id,
    label: definition.label,
    status: active ? "active" : "pending",
    attempts: active ? 1 : 0,
    startedAt,
    completedAt: null,
    durationMs: null,
    resultCode: null,
    errorCode: null,
    summary: "",
    selections: [],
    sideEffectObserved: false,
  };
}

function boundedTaskEvent(event) {
  return {
    code: boundedTaskText(event?.code, 120) || "task.event",
    stageId: TASK_STAGE_IDS.has(event?.stageId) ? event.stageId : null,
    status: TASK_STAGE_STATUSES.has(event?.status) ? event.status : null,
    summary: boundedTaskText(event?.summary, 600),
    at: safeTaskTime(event?.at),
  };
}

function createTaskStateMachine({
  turnId = null,
  inputFingerprint = null,
  sourceMode = "model-only",
  taskLevel = "T0_DIRECT",
  now = null,
} = {}) {
  const createdAt = safeTaskTime(now);
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    turnId: boundedTaskText(turnId, 160) || null,
    inputFingerprint: boundedTaskText(inputFingerprint, 160) || null,
    sourceMode: boundedTaskText(sourceMode, 60) || "model-only",
    taskLevel: boundedTaskText(taskLevel, 60) || "T0_DIRECT",
    status: "active",
    currentStage: TASK_STAGE_DEFINITIONS[0].id,
    lastSafeCheckpoint: null,
    resumeFrom: null,
    createdAt,
    updatedAt: createdAt,
    stages: TASK_STAGE_DEFINITIONS.map((definition, index) => freshTaskStage(definition, index === 0, createdAt)),
    events: [boundedTaskEvent({
      code: "task.created",
      stageId: TASK_STAGE_DEFINITIONS[0].id,
      status: "active",
      summary: "任务状态机已建立",
      at: createdAt,
    })],
  };
}

function normalizeTaskStateMachine(raw, defaults = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return createTaskStateMachine(defaults);
  const fallback = createTaskStateMachine({
    turnId: raw.turnId || defaults.turnId,
    inputFingerprint: raw.inputFingerprint || defaults.inputFingerprint,
    sourceMode: raw.sourceMode || defaults.sourceMode,
    taskLevel: raw.taskLevel || defaults.taskLevel,
    now: raw.createdAt || defaults.now,
  });
  const byId = new Map((Array.isArray(raw.stages) ? raw.stages : [])
    .filter((stage) => TASK_STAGE_IDS.has(stage?.id))
    .map((stage) => [stage.id, stage]));
  let activeSeen = false;
  const stages = TASK_STAGE_DEFINITIONS.map((definition) => {
    const stage = byId.get(definition.id) || {};
    let status = TASK_STAGE_STATUSES.has(stage.status) ? stage.status : "pending";
    if (status === "active") {
      if (activeSeen) status = "pending";
      else activeSeen = true;
    }
    const startedAt = typeof stage.startedAt === "string" && !Number.isNaN(Date.parse(stage.startedAt))
      ? stage.startedAt : null;
    const completedAt = typeof stage.completedAt === "string" && !Number.isNaN(Date.parse(stage.completedAt))
      ? stage.completedAt : null;
    return {
      id: definition.id,
      label: definition.label,
      status,
      attempts: Math.max(0, Math.min(9, Number(stage.attempts) || (status === "active" ? 1 : 0))),
      startedAt,
      completedAt,
      durationMs: Number.isFinite(stage.durationMs) ? Math.max(0, Math.min(86_400_000, stage.durationMs)) : null,
      resultCode: boundedTaskText(stage.resultCode, 120) || null,
      errorCode: boundedTaskText(stage.errorCode, 120) || null,
      summary: boundedTaskText(stage.summary, 600),
      selections: Array.isArray(stage.selections)
        ? stage.selections.map((item) => boundedTaskText(item, 120)).filter(Boolean).slice(0, 6) : [],
      sideEffectObserved: stage.sideEffectObserved === true,
    };
  });
  if (!activeSeen && !stages.some((stage) => new Set(["failed", "blocked"]).has(stage.status))) {
    const requested = TASK_STAGE_IDS.has(raw.currentStage)
      ? stages.find((stage) => stage.id === raw.currentStage && stage.status === "pending") : null;
    const next = requested || stages.find((stage) => stage.status === "pending");
    if (next) {
      next.status = "active";
      next.attempts = Math.max(1, next.attempts);
      next.startedAt ||= safeTaskTime(raw.updatedAt);
      activeSeen = true;
    }
  }
  const active = stages.find((stage) => stage.status === "active") || null;
  const failed = stages.find((stage) => new Set(["failed", "blocked"]).has(stage.status)) || null;
  const completed = stages.every((stage) => new Set(["completed", "skipped"]).has(stage.status));
  return {
    ...fallback,
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    turnId: boundedTaskText(raw.turnId, 160) || fallback.turnId,
    inputFingerprint: boundedTaskText(raw.inputFingerprint, 160) || fallback.inputFingerprint,
    sourceMode: boundedTaskText(raw.sourceMode, 60) || fallback.sourceMode,
    taskLevel: boundedTaskText(raw.taskLevel, 60) || fallback.taskLevel,
    status: completed ? "completed" : (failed ? failed.status : "active"),
    currentStage: active?.id || null,
    lastSafeCheckpoint: TASK_STAGE_IDS.has(raw.lastSafeCheckpoint) ? raw.lastSafeCheckpoint : null,
    resumeFrom: TASK_STAGE_IDS.has(raw.resumeFrom) ? raw.resumeFrom : null,
    createdAt: safeTaskTime(raw.createdAt || fallback.createdAt),
    updatedAt: safeTaskTime(raw.updatedAt || fallback.updatedAt),
    stages,
    events: (Array.isArray(raw.events) ? raw.events : fallback.events)
      .slice(-MAX_TASK_EVENTS).map(boundedTaskEvent),
  };
}

function withTaskEvent(machine, event) {
  machine.events = [...machine.events, boundedTaskEvent(event)].slice(-MAX_TASK_EVENTS);
  return machine;
}

function completeTaskStage(raw, stageId, options = {}) {
  const machine = normalizeTaskStateMachine(raw);
  const index = machine.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) throw new Error(`未知任务阶段：${String(stageId || "未提供")}`);
  const stage = machine.stages[index];
  if (stage.status !== "active") throw new Error(`任务阶段不是当前活动阶段：${stageId}`);
  const completedAt = safeTaskTime(options.now);
  stage.status = options.skipped === true ? "skipped" : "completed";
  stage.completedAt = completedAt;
  stage.durationMs = stage.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(stage.startedAt)) : 0;
  stage.resultCode = boundedTaskText(options.resultCode, 120) || `${stageId}.completed`;
  stage.summary = boundedTaskText(options.summary, 600);
  stage.selections = Array.isArray(options.selections)
    ? options.selections.map((item) => boundedTaskText(item, 120)).filter(Boolean).slice(0, 6) : stage.selections;
  stage.sideEffectObserved = options.sideEffectObserved === true;
  const definition = TASK_STAGE_DEFINITIONS[index];
  if (definition.checkpointSafe && !stage.sideEffectObserved) machine.lastSafeCheckpoint = stageId;
  const next = machine.stages[index + 1] || null;
  if (next) {
    next.status = "active";
    next.attempts = Math.max(1, next.attempts + 1);
    next.startedAt = completedAt;
    machine.currentStage = next.id;
    machine.status = "active";
  } else {
    machine.currentStage = null;
    machine.status = "completed";
  }
  machine.updatedAt = completedAt;
  return withTaskEvent(machine, {
    code: stage.resultCode,
    stageId,
    status: stage.status,
    summary: stage.summary,
    at: completedAt,
  });
}

function failTaskStage(raw, stageId, options = {}) {
  const machine = normalizeTaskStateMachine(raw);
  const stage = machine.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error(`未知任务阶段：${String(stageId || "未提供")}`);
  const failedAt = safeTaskTime(options.now);
  for (const item of machine.stages) if (item.status === "active" && item.id !== stageId) item.status = "pending";
  stage.status = options.blocked === true ? "blocked" : "failed";
  stage.attempts = Math.max(1, stage.attempts);
  stage.startedAt ||= failedAt;
  stage.completedAt = failedAt;
  stage.durationMs = Math.max(0, Date.parse(failedAt) - Date.parse(stage.startedAt));
  stage.errorCode = boundedTaskText(options.errorCode, 120) || `${stageId}.failed`;
  stage.summary = boundedTaskText(options.summary, 600);
  stage.sideEffectObserved = options.sideEffectObserved === true;
  machine.status = stage.status;
  machine.currentStage = null;
  machine.resumeFrom = stageId;
  machine.updatedAt = failedAt;
  return withTaskEvent(machine, {
    code: stage.errorCode,
    stageId,
    status: stage.status,
    summary: stage.summary,
    at: failedAt,
  });
}

function taskRecoveryPlan(raw) {
  const machine = normalizeTaskStateMachine(raw);
  const failed = machine.stages.find((stage) => new Set(["failed", "blocked"]).has(stage.status));
  if (!failed) {
    return machine.status === "completed"
      ? { mode: "completed", resumeFrom: null, reasonCode: "already-completed" }
      : { mode: "resume", resumeFrom: machine.currentStage || machine.lastSafeCheckpoint || "semantic-understanding", reasonCode: "safe-stage-retry" };
  }
  if (failed.sideEffectObserved || failed.status === "blocked") {
    return { mode: "confirmation-required", resumeFrom: failed.id, reasonCode: "side-effect-observed" };
  }
  return { mode: "resume", resumeFrom: failed.id, reasonCode: "safe-stage-retry" };
}

function taskPipelineView(raw) {
  const machine = normalizeTaskStateMachine(raw);
  return machine.stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: stage.status === "active" ? "running" : (stage.status === "pending" ? "ready" : stage.status),
    selections: [...stage.selections],
    attempts: stage.attempts,
    resultCode: stage.resultCode,
    errorCode: stage.errorCode,
    summary: stage.summary,
  }));
}

module.exports = {
  TASK_STAGE_DEFINITIONS,
  TASK_STATE_SCHEMA_VERSION,
  completeTaskStage,
  createTaskStateMachine,
  failTaskStage,
  normalizeTaskStateMachine,
  taskPipelineView,
  taskRecoveryPlan,
};
