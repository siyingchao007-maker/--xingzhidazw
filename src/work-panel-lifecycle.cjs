"use strict";

const AUTO_CLOSE_DELAY_MS = 4_000;
const RUNNING_STATUSES = new Set([
  "running", "in_progress", "streaming", "starting", "waiting", "waiting_approval",
]);
const FAILURE_STATUSES = new Set(["failed", "error", "timed-out", "interrupted"]);
const RESOLVED_STATUSES = new Set(["answered", "resolved", "dismissed", "accepted", "declined", "cancelled"]);

function items(value) {
  return Array.isArray(value) ? value : [];
}

function isPending(item) {
  const status = String(item?.status || "pending").toLowerCase();
  return !RESOLVED_STATUSES.has(status);
}

function knowledgeSearchStatusText(searchState = {}) {
  const status = String(searchState?.status || "not-run");
  const attempts = Number(searchState?.attempts || 0);
  const hits = Number(searchState?.hits || 0);
  if (status === "skipped") return "本轮按权限或隔离设置跳过记忆检索";
  if (status === "budget-exhausted") return `已检索 ${attempts} 次 · 命中 ${hits} 条 · 补查达到本轮限额`;
  if (status === "searching" || status === "running") return `正在执行第 ${Math.max(1, attempts)} 次知识检索`;
  if (status === "empty") return `已检索 ${attempts} 次 · 命中 0 条`;
  if (status === "completed") return `已检索 ${attempts} 次 · 命中 ${hits} 条`;
  if (status === "failed") return `知识检索失败 · 已尝试 ${attempts} 次`;
  if (status === "interrupted") return `知识检索已停止 · 已尝试 ${attempts} 次`;
  return "尚未执行知识检索";
}

function classifyWorkPanelLifecycle(input = {}) {
  const turnStatus = String(input.turn?.status || "").toLowerCase();
  const workPanel = input.workPanel && typeof input.workPanel === "object" ? input.workPanel : {};
  const approvals = items(input.approvals).filter((item) => (
    !item?.conversationId || item.conversationId === input.conversationId
  ));
  const writeCount = items(workPanel.writes).filter((item) => (
    !new Set(["undone", "reverted"]).has(String(item?.status || "").toLowerCase())
  )).length;
  const blocked = items(workPanel.confirmations).some(isPending)
    || items(workPanel.clarifications).some(isPending)
    || approvals.some(isPending);
  const failed = FAILURE_STATUSES.has(turnStatus)
    || Boolean(input.knowledgeRecovery)
    || items(workPanel.errors).length > 0
    || Boolean(workPanel.error || workPanel.writeError);
  const running = RUNNING_STATUSES.has(turnStatus);
  const hasResult = writeCount > 0
    || items(workPanel.sources).length > 0
    || items(workPanel.candidates).length > 0
    || Number(workPanel.knowledgeSummary?.written || 0) > 0
    || Number(workPanel.knowledgeSummary?.rejected || 0) > 0;
  const completed = new Set(["completed", "succeeded"]).has(turnStatus) || (!turnStatus && hasResult);

  const phase = failed ? "failed" : blocked ? "blocked" : running ? "running" : completed ? "completed" : "idle";
  return {
    phase,
    shouldOpen: failed || blocked || running,
    canAutoClose: completed && !failed && !blocked,
    writeCount,
  };
}

class WorkPanelLifecycleController {
  constructor(options = {}) {
    this.onChange = typeof options.onChange === "function" ? options.onChange : () => {};
    this.states = new Map();
  }

  getState(conversationId) {
    return this.states.get(conversationId) || {
      conversationId,
      open: false,
      userMode: "closed",
      phase: "idle",
      writeCount: 0,
    };
  }

  update(input = {}) {
    const conversationId = String(input.conversationId || "");
    if (!conversationId) return this.getState("");
    const previous = this.getState(conversationId);
    const lifecycle = classifyWorkPanelLifecycle(input);
    const next = {
      conversationId,
      open: previous.open,
      userMode: previous.userMode,
      ...lifecycle,
    };
    this.states.set(conversationId, next);
    return next;
  }

  manualToggle(conversationId) {
    const previous = this.getState(conversationId);
    const next = {
      ...previous,
      open: !previous.open,
      userMode: previous.open ? "closed" : "open",
    };
    this.states.set(conversationId, next);
    this.onChange(next);
    return next;
  }

  close(conversationId) {
    const previous = this.getState(conversationId);
    const next = { ...previous, open: false, userMode: "closed" };
    this.states.set(conversationId, next);
    this.onChange(next);
    return next;
  }

  dispose() {}
}

class TechnicalDetailsDisclosureController {
  constructor() {
    this.openByConversation = new Map();
  }

  isOpen(conversationId) {
    return this.openByConversation.get(String(conversationId || "")) === true;
  }

  setOpen(conversationId, open) {
    this.openByConversation.set(String(conversationId || ""), open === true);
    return open === true;
  }
}

module.exports = {
  AUTO_CLOSE_DELAY_MS,
  TechnicalDetailsDisclosureController,
  WorkPanelLifecycleController,
  classifyWorkPanelLifecycle,
  knowledgeSearchStatusText,
};
