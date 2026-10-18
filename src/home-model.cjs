"use strict";

const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value : "";
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const LOOP_STATUS = Object.freeze({ planned: "计划中", attempted: "已尝试，继续验证", completed: "已完成", paused: "已暂停" });

function normalizePreferences(value = {}) {
  return {
    selectedLoopId: text(value.selectedLoopId).slice(0, 200),
    directionPath: text(value.directionPath).slice(0, 1000),
    landscape: value.landscape !== false,
    compactSidebar: value.compactSidebar === true,
    // 2026-09 PATH 首页改版；旧版首页已删除，此处只保留字段以吞掉历史遗留的 "classic" 值。
    layout: "path",
    // 2026-09 双皮肤；"gold" 暖金山水为默认，"ink" 为水墨。未知值一律回落 gold。
    skin: value.skin === "ink" ? "ink" : "gold",
  };
}

function pendingConfirmations(state = {}) {
  const runtime = state.runtime || {};
  const panels = [runtime.workPanel, runtime.backgroundWorkPanel];
  for (const collection of [runtime.workPanels, runtime.backgroundWorkPanels,
    state.workPanelSummaries, state.backgroundWorkPanelSummaries]) {
    if (!collection || typeof collection !== "object") continue;
    for (const [conversationId, panel] of Object.entries(collection)) {
      if (panel && typeof panel === "object") panels.push({ ...panel, conversationId: panel.conversationId || conversationId });
    }
  }
  const conversations = new Map(array(state.conversations).filter(c => c && !c.deletedAt).map(c => [c.id, c]));
  const byId = new Map();
  for (const panel of panels) {
    for (const item of array(panel?.confirmations)) {
      if (!item || !text(item.id)) continue;
      const conversationId = item.conversationId || panel.conversationId || state.activeConversationId;
      if (!conversations.has(conversationId)) continue;
      // Runtime state precedes persisted summaries, including resolved statuses.
      if (!byId.has(item.id)) byId.set(item.id, { ...item, conversationId });
    }
  }
  return [...byId.values()].filter(item => item.status === "pending");
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function feedbackWeek(loops, now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday); date.setDate(date.getDate() + index);
    return { date: localDay(date), label: ["一", "二", "三", "四", "五", "六", "日"][index], count: 0, today: localDay(date) === localDay(now) };
  });
  const seen = new Set();
  for (const loop of array(loops)) for (const entry of array(loop?.feedbacks)) {
    const moment = new Date(entry?.occurredAt || entry?.createdAt || "");
    if (!Number.isFinite(moment.getTime()) || moment.getTime() > now.getTime()) continue;
    const key = entry.id || `${loop.id}:${moment.toISOString()}:${text(entry.result)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = days.find(day => day.date === localDay(moment));
    if (bucket) bucket.count += 1;
  }
  return days;
}

function judgmentChanges(loops) {
  const changes = [];
  for (const loop of array(loops)) for (const feedback of array(loop?.feedbacks)) {
    const revised = text(feedback?.revisedJudgment).trim();
    if (!revised || revised === text(feedback.previousJudgment).trim()) continue;
    changes.push({ id: feedback.id, title: text(loop.title), path: loop.path,
      previous: text(feedback.previousJudgment), current: revised,
      because: text(feedback.interpretation || feedback.impactOnJudgment || feedback.result).trim(),
      occurredAt: feedback.occurredAt || feedback.createdAt || loop.updatedAt });
  }
  return changes.sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt));
}

function buildHomeModel(snapshot = {}, state = {}, preferences = {}, now = new Date()) {
  const prefs = normalizePreferences(preferences);
  const loops = array(snapshot?.loops).filter(loop => loop && text(loop.id) && text(loop.path));
  const active = loops.filter(loop => !["completed", "paused"].includes(loop.status));
  const selected = loops.find(loop => loop.id === prefs.selectedLoopId);
  const focus = selected || active[0] || loops[0] || null;
  const goals = array(snapshot?.goals).filter(record => record && text(record.path));
  const direction = goals.find(record => record.path === prefs.directionPath) || goals[0] || null;
  const records = [...array(snapshot?.self), ...goals, ...array(snapshot?.judgments), ...array(snapshot?.actions), ...array(snapshot?.feedback)]
    .filter(record => record && text(record.path));
  return { loops, active, focus, goals, direction,
    records: [...new Map(records.map(record => [record.path, record])).values()],
    pending: pendingConfirmations(state), changes: judgmentChanges(loops),
    week: feedbackWeek(loops, now), issues: array(snapshot?.issues),
    generatedAt: text(snapshot?.generatedAt), preferences: prefs };
}

module.exports = { LOOP_STATUS, normalizePreferences, pendingConfirmations, feedbackWeek, judgmentChanges, buildHomeModel };