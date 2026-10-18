"use strict";
const { GROWTH_CONTRACT_VERSION } = require("./growth-contract.cjs");
const { redactSecrets } = require("./user-continuity.cjs");
const LABELS = Object.freeze({ queued: "等待处理", running: "正在分析", written: "有新成长记录", "written-with-pending": "已更新，部分待核实",
  "profile-updated": "偏好已更新，成长无新增", "no-change": "暂无新变化", partial: "部分内容未采用", "pending-confirmation": "有内容待核实",
  "recorded-only": "仅记录交互", "skipped-read-only": "只读模式", failed: "处理失败", interrupted: "处理已中断", completed: "处理完成" });
function clean(value, max = 500) { return redactSecrets(String(value || "")).slice(0, max); }
function continuityOutcome(applied) {
  const count = Number(applied.growthEventsWritten || 0);
  const ignored = (applied.ignored || []).map(x => clean(x, 300)).slice(0, 20);
  const rejected = ignored.filter(x => x.includes("未采用："));
  const status = count ? (applied.pending ? "written-with-pending" : "written")
    : applied.pending ? "pending-confirmation" : rejected.length ? "partial"
      : applied.written ? "profile-updated" : "no-change";
  const reason = count ? `新增 ${count} 条有来源的成长事件` : rejected.length ? `${rejected.length} 条分析未采用，请查看原因`
    : applied.pending ? `${applied.pending} 条观察需要核实`
      : ignored[0] || (applied.written ? "交互偏好发生变化，未观察到新的成长事件" : "没有新的可验证变化，或同一事件已记录");
  return { status, reason, ignored, growthEventsWritten: count, rejectedCount: rejected.length, contractVersion: GROWTH_CONTRACT_VERSION };
}
function normalizeRun(run, restore = false) {
  if (!run?.conversationId || !run?.sourceMessageId) return null;
  const interrupted = restore && ["running", "queued"].includes(run.status);
  return { conversationId: clean(run.conversationId, 200), sourceMessageId: clean(run.sourceMessageId, 200),
    status: interrupted ? "interrupted" : LABELS[run.status] ? run.status : "completed",
    startedAt: run.startedAt || null, completedAt: run.completedAt || null, eventPath: clean(run.eventPath, 1024),
    growthEventsWritten: Math.max(0, Number(run.growthEventsWritten || 0)),
    reason: interrupted ? "上次处理未完成，可选择该记录重新分析" : clean(run.reason || run.report?.reason), error: clean(run.error),
    ignored: (Array.isArray(run.ignored) ? run.ignored : []).slice(0, 20).map(x => clean(x, 300)),
    blocked: (Array.isArray(run.blocked) ? run.blocked : []).slice(0, 20).map(x => ({ statement: clean(x.statement, 200), reason: clean(x.reason, 80) })),
    contractVersion: clean(run.contractVersion, 50), capabilityVersions: clean(run.capabilityVersions, 1500), model: clean(run.model, 150) };
}
function restoreContinuityRuns(value) { return (Array.isArray(value) ? value : []).slice(-500).map(x => normalizeRun(x, true)).filter(Boolean); }
function recordContinuityRun(previous, current) {
  const next = normalizeRun(current); if (!next) return previous || [];
  const rows = (Array.isArray(previous) ? previous : []).filter(x => x.conversationId !== next.conversationId || x.sourceMessageId !== next.sourceMessageId);
  return [...rows, next].slice(-500);
}
function statusLabel(status) { return LABELS[status] || "尚无检查记录"; }
function displayTime(value) { return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "尚无记录"; }
module.exports = { restoreContinuityRuns, recordContinuityRun, continuityOutcome, statusLabel, displayTime };
