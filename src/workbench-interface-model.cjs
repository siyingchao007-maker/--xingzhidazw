"use strict";
const { normalizedSkillType } = require("./capability-surface.cjs");
const { isAuthenticationFailure } = require("./turn-telemetry.cjs");

const SOURCE_SCOPE_LABELS = Object.freeze({
  "local-web": Object.freeze({ control: "本地 + 全网", badge: "全网优先" }),
  local: Object.freeze({ control: "仅本地", badge: "仅本地" }),
  web: Object.freeze({ control: "仅全网", badge: "全网资料" }),
  conversation: Object.freeze({ control: "当前对话", badge: "当前对话" }),
});

const TASK_KIND_LABELS = Object.freeze({
  research: "调研任务",
  analysis: "分析任务",
  preparation: "资料准备",
  execution: "执行任务",
  conversation: "对话",
});

function normalizeDisplayText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function shortenTitle(value, fallback = "新对话", maxLength = 28) {
  const normalized = normalizeDisplayText(value) || fallback;
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

function inferWorkbenchTaskKind(value) {
  const text = normalizeDisplayText(value);
  if (/(?:调研|调查|搜索|检索|研究|查找|公开资料)/u.test(text)) return "research";
  if (/(?:整理|准备|制作|生成|汇总|资料包|报告)/u.test(text)) return "preparation";
  if (/(?:分析|比较|对比|评估|判断|诊断|复盘)/u.test(text)) return "analysis";
  if (/(?:执行|删除|写入|发送|创建|修改|升级|部署)/u.test(text)) return "execution";
  return "conversation";
}

function buildComposerPresentation(input = {}) {
  const scope = SOURCE_SCOPE_LABELS[input.sourceScope] || SOURCE_SCOPE_LABELS["local-web"];
  const modeChips = [];
  if (input.trainingSuppressedForTurn === true) {
    modeChips.push({
      id: "training-skip",
      label: "本轮普通回答",
      removable: false,
      tone: "neutral",
    });
  } else if (input.trainingModeActive === true) {
    modeChips.push({
      id: "training",
      label: "训练模式",
      removable: true,
      tone: "training",
    });
  }
  return {
    sourceScope: input.sourceScope || "local-web",
    sourceScopeLabel: scope.control,
    modeChips,
    showTechnicalControls: input.showTechnicalControls === true,
    advancedLabel: "本轮设置",
  };
}

function buildTaskHeaderPresentation(input = {}) {
  const sourceScope = SOURCE_SCOPE_LABELS[input.sourceScope] || SOURCE_SCOPE_LABELS["local-web"];
  const taskKind = TASK_KIND_LABELS[input.taskKind] || TASK_KIND_LABELS.conversation;
  return {
    title: shortenTitle(input.taskTitle || input.conversationTitle),
    summary: normalizeDisplayText(input.taskSummary),
    badges: [
      { id: "task-kind", label: taskKind, tone: "task" },
      { id: "source-scope", label: sourceScope.badge, tone: "source" },
    ],
  };
}

function workbenchItemId(value) {
  if (typeof value === "string") return value;
  return normalizeDisplayText(value?.id || value?.name || value?.label || value?.path || value?.url);
}

function workbenchItemLabel(value) {
  return normalizeDisplayText(typeof value === "string"
    ? value : (value?.label || value?.name || value?.title || value?.id));
}

function workbenchStatus(value) {
  return normalizeDisplayText(value).toLowerCase().replaceAll("_", "-");
}

function sourceCategory(source) {
  const type = workbenchStatus(source?.sourceType || source?.kind || source?.type || source?.origin);
  const locator = normalizeDisplayText(source?.url || source?.path || source?.file || source);
  if (type.includes("attachment") || type.includes("upload") || /(?:^|[/\\])附件(?:[/\\]|$)/u.test(locator)) {
    return "attachment";
  }
  if (type.includes("web") || type.includes("public") || /^https?:\/\//iu.test(locator)) return "public";
  return "local";
}

function countWorkbenchSources(work = {}) {
  const sources = Array.isArray(work.sources)
    ? work.sources
    : (Array.isArray(work.readSources)
      ? work.readSources
      : (Array.isArray(work.references) ? work.references : []));
  const counts = { publicCount: 0, localCount: 0, attachmentCount: 0 };
  for (const source of sources) {
    const category = sourceCategory(source);
    if (category === "public") counts.publicCount += 1;
    else if (category === "attachment") counts.attachmentCount += 1;
    else counts.localCount += 1;
  }
  return {
    ...counts,
    label: `公开 ${counts.publicCount} · 本地 ${counts.localCount} · 附件 ${counts.attachmentCount}`,
  };
}

function buildWorkbenchRunSummary(input = {}) {
  const work = input.work && typeof input.work === "object" ? input.work : {};
  const backgroundWork = input.backgroundWork && typeof input.backgroundWork === "object"
    ? input.backgroundWork : {};
  const organization = input.organization && typeof input.organization === "object"
    ? input.organization : {};
  const turnStatus = workbenchStatus(input.turn?.status);
  const traceStatus = workbenchStatus(work.traceStatus);
  const backgroundStatus = workbenchStatus(backgroundWork.traceStatus || organization.status);
  const completedStatuses = ["completed", "complete", "succeeded", "success", "restored"];
  const failedStatuses = ["failed", "error", "blocked"];
  const turnCompleted = completedStatuses.includes(turnStatus);
  const turnFailed = failedStatuses.includes(turnStatus);
  const failed = turnFailed || (!turnCompleted && failedStatuses.includes(traceStatus));
  const foregroundCompleted = turnCompleted || (!turnFailed && completedStatuses.includes(traceStatus));
  const backgroundActive = [backgroundStatus, workbenchStatus(organization.status)].some((status) => (
    ["active", "running", "queued", "in-progress", "starting"].includes(status)
  ));
  const activeStage = (Array.isArray(work.executionPipeline) ? work.executionPipeline : [])
    .find((stage) => ["running", "active", "in-progress", "starting"].includes(workbenchStatus(stage?.status)));
  const activeStageId = workbenchItemId(activeStage);
  const webSearching = [work?.webSearch?.contextClarification, work?.webSearch?.answerRetrieval]
    .some((status) => ["searching", "planned", "planned-gap-only"].includes(workbenchStatus(status)));
  let now;
  if (failed) {
    now = {
      id: "failed",
      label: "本轮工作遇到问题",
      detail: normalizeDisplayText(work.routingError || work.error || input.turn?.error)
        || "可以查看恢复选项或展开技术详情。",
      tone: "failed",
      progress: 100,
    };
  } else if (foregroundCompleted && backgroundActive) {
    now = {
      id: "organizing",
      label: "回答已完成，正在后台整理",
      detail: "整理不会阻塞输入，可以继续对话。",
      tone: "running",
      progress: 88,
    };
  } else if (foregroundCompleted) {
    now = {
      id: "completed",
      label: "本轮回答已完成",
      detail: "回答与本轮已确认操作均已结束。",
      tone: "completed",
      progress: 100,
    };
  } else if (backgroundActive) {
    now = {
      id: "organizing",
      label: "正在整理本轮结果",
      detail: "正在保存原文并整理可追溯的知识候选。",
      tone: "running",
      progress: 88,
    };
  } else if (webSearching || /(?:evidence|retrieval|search)/iu.test(activeStageId)) {
    now = {
      id: "finding",
      label: "正在查找相关资料",
      detail: "正在核对本地资料与公开来源。",
      tone: "running",
      progress: 48,
    };
  } else if (/(?:agent|skill|planning|execution|quality|response|model)/iu.test(activeStageId)) {
    now = {
      id: "executing",
      label: "正在执行并组织回答",
      detail: "已完成理解与资料判断，正在形成可交付结果。",
      tone: "running",
      progress: 72,
    };
  } else if ([turnStatus, traceStatus].some((status) => (
    ["active", "running", "in-progress", "streaming", "starting", "waiting", "waiting-approval"].includes(status)
  ))) {
    now = {
      id: "understanding",
      label: "正在理解你的任务",
      detail: "正在结合当前对话识别目标、约束和所需资料。",
      tone: "running",
      progress: 22,
    };
  } else {
    now = {
      id: "ready",
      label: "等待本轮任务",
      detail: "发送消息后，这里会显示真实进度与结果。",
      tone: "idle",
      progress: 0,
    };
  }

  const skills = Array.isArray(work.skills)
    ? work.skills
    : (Array.isArray(work.usedSkills) ? work.usedSkills : []);
  const agentId = workbenchItemId(work.agentId || work.agent);
  const agentLabel = normalizeDisplayText(work.agentLabel || work.agent);
  const visibleAgent = agentId && agentId !== "xingzhi-orchestrator"
    ? (agentLabel || agentId) : "按任务自动选择能力";
  const lensIds = new Set((Array.isArray(input.skillCatalog) ? input.skillCatalog : [])
    .filter((item) => normalizedSkillType(item) === "cognitive-lens")
    .map(workbenchItemId));
  const skillLabels = skills.filter((item) => normalizedSkillType(item) !== "cognitive-lens"
    && !lensIds.has(workbenchItemId(item))).map(item => `${workbenchItemLabel(item)}（${require("./skill-call-state.cjs").skillCallLabel(item)}）`).filter(Boolean);
  const capability = {
    label: visibleAgent,
    detail: skillLabels.length ? `配合：${skillLabels.join("、")}` : "本轮未额外启用专项能力",
  };

  const writes = (Array.isArray(work.writes)
    ? work.writes
    : (Array.isArray(work.transactions) ? work.transactions : (Array.isArray(work.changes) ? work.changes : [])))
    .filter((item) => !["failed", "rejected", "undone", "reverted"].includes(workbenchStatus(item?.status)));
  const candidates = (Array.isArray(work.candidates)
    ? work.candidates
    : (Array.isArray(work.knowledgeCandidates) ? work.knowledgeCandidates : []));
  const pendingCandidates = candidates.filter((item) => {
    const status = workbenchStatus(item?.status || item?.decision || item?.reviewState);
    return !status || ["pending", "confirm", "clarify", "needs-confirmation", "pending-review"].includes(status);
  });
  const writtenCount = Math.max(writes.length, Number(organization.written) || 0);
  const pendingCount = Math.max(pendingCandidates.length, Number(organization.pending) || 0);
  let changesLabel = "本轮没有修改知识库";
  if (writtenCount && pendingCount) changesLabel = `已写入 ${writtenCount} 项，另有 ${pendingCount} 项待确认`;
  else if (writtenCount) changesLabel = `已写入 ${writtenCount} 项知识`;
  else if (pendingCount) changesLabel = `有 ${pendingCount} 项知识候选待确认`;

  return {
    now,
    sources: countWorkbenchSources(work),
    capability,
    changes: {
      label: changesLabel,
      detail: writtenCount ? "所有写入都保留来源与撤销记录。" : "未确认的信息不会自动写入正式知识库。",
      tone: writtenCount ? "changed" : (pendingCount ? "pending" : "none"),
    },
    technicalAvailable: traceStatus !== "empty" && Boolean(work.conversationId || Object.keys(work).length),
  };
}

function buildAttachmentReceiptPresentation(input = {}) {
  const purpose = workbenchStatus(input.purpose) || "conversation";
  const status = workbenchStatus(input.status) || "completed";
  const indexStatus = workbenchStatus(input.indexStatus);
  const failed = ["failed", "error", "interrupted", "cancelled"].includes(status);
  const completed = ["completed", "complete", "succeeded", "success", "stored-reference-only"].includes(status);
  const files = Array.isArray(input.files) ? input.files : [];
  const completedStageStatuses = new Set([
    "completed", "complete", "succeeded", "success", "saved", "extracted", "indexed", "queryable", "ready",
  ]);
  const failedStageStatuses = new Set(["failed", "error", "interrupted", "cancelled"]);
  const skippedStageStatuses = new Set(["not-applicable", "not-required", "skipped", "disabled"]);
  const stageStatus = (field, fallback) => {
    const values = files.map((file) => workbenchStatus(file?.[field])).filter(Boolean);
    if (!values.length) return fallback;
    if (values.some((value) => failedStageStatuses.has(value))) return "error";
    if (values.every((value) => skippedStageStatuses.has(value))) return "skipped";
    if (values.every((value) => completedStageStatuses.has(value) || skippedStageStatuses.has(value))) return "completed";
    return "running";
  };
  const fallbackStageStatus = failed ? "error" : (completed ? "completed" : "running");
  const savedStatus = stageStatus("originalStatus", fallbackStageStatus);
  const parsedStatus = stageStatus("extractionStatus", fallbackStageStatus);
  const perFileIndexStatuses = files.map((file) => workbenchStatus(file?.indexStatus)).filter(Boolean);
  const allIndexesNotApplicable = perFileIndexStatuses.length > 0
    && perFileIndexStatuses.every((value) => skippedStageStatuses.has(value));
  const indexedStatus = stageStatus(
    "indexStatus",
    ["completed", "indexed", "queryable", "ready"].includes(indexStatus)
      ? "completed" : (indexStatus && skippedStageStatuses.has(indexStatus) ? "skipped" : "skipped"),
  );
  const knowledgeStatus = purpose === "knowledge"
    ? stageStatus("knowledgeStatus", failed ? "error" : (completed ? "completed" : "running"))
    : "skipped";
  const queryable = completed && input.queryable === true
    && (indexedStatus === "completed" || allIndexesNotApplicable);
  const recordedError = normalizeDisplayText(input.error)
    || files.map((file) => normalizeDisplayText(file?.knowledgeError)).find(Boolean)
    || "";
  const upstreamStagesPreserved = savedStatus === "completed" && parsedStatus === "completed";
  let label;
  let detail;
  if (purpose === "knowledge" && knowledgeStatus === "error" && upstreamStagesPreserved) {
    label = "知识整理未完成";
    detail = `原文件和提取内容已保留；${recordedError || "AI 知识整理回合未正常完成"}。可直接从知识整理阶段重试。`;
  } else if (failed || savedStatus === "error" || parsedStatus === "error") {
    label = "附件处理失败";
    detail = recordedError || "附件尚未完成保存或读取，请查看具体失败阶段。";
  } else if (purpose === "reference") {
    label = "已保存为资料，未整理为正式知识";
    detail = "文件原文和可读取正文已保留；未启动知识提炼与审核。";
  } else if (purpose === "knowledge" && queryable) {
    label = "已整理并可检索";
    detail = "运行层已确认索引完成，检索状态可用。";
  } else if (purpose === "knowledge") {
    label = completed ? "知识整理已完成" : "正在整理为知识候选";
    detail = completed
      ? "原文和整理结果已保留；正式知识是否写入由知识候选处理结果决定。"
      : "完成后仍需等待索引或人工确认。";
  } else {
    label = "已提交给本轮回答，未写入正式知识";
    detail = "附件只作为本轮回答资料使用。";
  }
  const canRetryKnowledge = purpose === "knowledge"
    && knowledgeStatus === "error"
    && files.some((file) => normalizeDisplayText(file?.originalPath)
      && completedStageStatuses.has(workbenchStatus(file?.originalStatus)));
  return {
    purpose,
    status,
    queryable,
    label,
    detail,
    error: recordedError || null,
    canRetryKnowledge,
    fileCount: files.length,
    files: files.map((file) => ({
      name: normalizeDisplayText(file?.name || file?.title || file?.path) || "未命名文件",
      path: normalizeDisplayText(file?.evidencePath || file?.path),
      originalPath: normalizeDisplayText(file?.originalPath),
      originalStatus: workbenchStatus(file?.originalStatus),
      extractionStatus: workbenchStatus(file?.extractionStatus),
      indexStatus: workbenchStatus(file?.indexStatus),
      knowledgeStatus: workbenchStatus(file?.knowledgeStatus),
      knowledgeError: normalizeDisplayText(file?.knowledgeError),
    })),
    steps: [
      { id: "saved", label: "文件已保存", status: savedStatus },
      { id: "parsed", label: "内容已读取", status: parsedStatus },
      {
        id: "indexed",
        label: allIndexesNotApplicable
          ? "无需结构化索引"
          : (indexedStatus === "completed" ? "结构化索引已建立" : "结构化索引"),
        status: indexedStatus,
      },
      {
        id: "knowledge",
        label: purpose === "knowledge" ? "知识整理" : "未启动知识整理",
        status: knowledgeStatus,
      },
    ],
  };
}

function buildFailureRecoveryPresentation(input = {}) {
  const status = workbenchStatus(input.status);
  const failed = ["failed", "error", "interrupted", "cancelled"].includes(status);
  if (!failed) return null;
  const recovery = input.recovery && typeof input.recovery === "object" ? input.recovery : {};
  const recoveryMode = workbenchStatus(recovery.mode);
  const checkpointAllowsRetry = recoveryMode === "resume" && Boolean(normalizeDisplayText(recovery.resumeFrom));
  const requiresConfirmation = recoveryMode === "confirmation-required";
  const error = normalizeDisplayText(input.error);
  const authenticationRequired = input.authenticationRequired === true || isAuthenticationFailure(input.error);
  const canRetryAfterAuthentication = authenticationRequired && checkpointAllowsRetry && !requiresConfirmation;
  const canRetry = !authenticationRequired && checkpointAllowsRetry;
  const title = authenticationRequired
    ? "模型认证未通过"
    : (status === "interrupted" || status === "cancelled" ? "本轮已停止" : "本轮未能完成");
  return {
    title,
    detail: authenticationRequired
      ? (requiresConfirmation
        ? "此模型连接的认证未通过；本轮可能已产生外部变化，需要先人工确认结果。"
        : "请检查对应账号的登录状态或更新 API 凭据；下次请求仍会验证认证状态。")
      : (requiresConfirmation
        ? "可能已经产生外部变化，需要人工确认实际结果后再继续。"
        : (error || (canRetry ? "可以从已验证的安全检查点重新执行。" : "请先查看连接诊断或技术详情。"))),
    canRetry,
    canRetryAfterAuthentication,
    authenticationRequired,
    retryLabel: authenticationRequired ? "登录后确认重试" : "从安全点重试",
    canContinueLocally: input.mandatoryOnline !== true && input.allowLocalFallback === true,
    diagnosticsLabel: "查看连接诊断",
    recoveryMode,
  };
}

function conversationOrganizationInlineMode(input = {}) {
  const status = workbenchStatus(input.status);
  const pending = Math.max(0, Number(input.pending) || 0);
  if (pending > 0 || ["pending-review", "pending-confirmation"].includes(status)) return "review";
  if (["queued", "running"].includes(status)) return "progress";
  return "hidden";
}

module.exports = {
  buildAttachmentReceiptPresentation,
  buildComposerPresentation,
  buildFailureRecoveryPresentation,
  buildTaskHeaderPresentation,
  buildWorkbenchRunSummary,
  conversationOrganizationInlineMode,
  inferWorkbenchTaskKind,
  shortenTitle,
};
