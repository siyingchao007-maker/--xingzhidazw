"use strict";
const crypto = require("node:crypto");
const { DAILY_REVIEW_ROOTS } = require("./daily-review.cjs");
const { parseLoop } = require("./cognitive-records.cjs");
function localDay(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function affectsDailyReview(path) {
  const p = String(path || "").replaceAll("\\", "/");
  return DAILY_REVIEW_ROOTS.some(root => p === root || p.startsWith(root + "/"));
}
function refreshKey(now, revision, actions, events) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([actions || [], events || []])).digest("hex");
  return `${localDay(now)}:${revision}:${digest}`;
}
function includeCognitiveLoops(draft, notes, now) {
  const today = localDay(now), suggestions = [], loopPaths = new Set();
  for (const note of notes) {
    let loop;
    try { loop = parseLoop(note); } catch { continue; }
    if (!loop) continue;
    loopPaths.add(note.path);
    if (["completed", "paused"].includes(loop.status)) continue;
    const due = loop.reviewAt && loop.reviewAt.slice(0, 10) <= today;
    if (!due && loop.feedbacks.length) continue;
    suggestions.push({ id: `loop-${loop.id}`, kind: "loop-review", title: loop.title,
      reason: due ? "已到约定复查日期，请核对实际结果；日期到期不代表行动已经完成。" : "已有行动计划，尚无实际反馈；先确认执行情况，再决定下一步。",
      sourcePaths: [note.path], actionId: null, planId: null, priority: due ? 0 : 1 });
  }
  suggestions.sort((a,b) => a.priority - b.priority || a.id.localeCompare(b.id));
  draft.today.suggestions = [...suggestions.map(({ priority, ...item }) => item), ...draft.today.suggestions.filter(s => !s.sourcePaths?.some(p => loopPaths.has(p)))].slice(0,5);
  if (draft.today.suggestions.length) draft.today.guidance = draft.today.guidance.filter(s => !s.includes("没有足够证据生成今日推进项"));
  return draft;
}
module.exports = { localDay, affectsDailyReview, refreshKey, includeCognitiveLoops };
