"use strict";
const { statusLabel, displayTime } = require("./growth-status.cjs");
const { GROWTH_EVENT_LABELS } = require("./growth-contract.cjs");
const { button, LOOP_STATUS } = require("./view-cognitive-home.cjs");
const { GrowthReplayModal } = require("./view-growth-replay.cjs");
const { renderPointCard } = require("./view-point-card.cjs");
const { POINT_LABELS, pointTitle } = require("./growth-points.cjs");
const CALIBRATION_STATUS = { "not-assessed": "尚未校准", supported: "原判断得到支持", weakened: "原判断被削弱", falsified: "原判断被证伪", uncertain: "仍不确定" };
function sourceButton(parent, plugin, event) {
  if (event.sourcePath) button(parent, "查看原始依据", () => plugin.openVaultPath(event.sourcePath.split("#")[0], { blockId: event.sourceRole === "user-record" ? undefined : event.sourceMessageId || event.sourcePath.split("#^")[1] }));
  else parent.createEl("p", { cls: "xz-cognitive-muted", text: "旧记录尚未关联可定位的原文，不能据此补写证据。" });
}
function renderGrowthContent(panel) {
  const { body, snapshot: s, plugin } = panel;
  body.empty();
  const intro = body.createEl("section", { cls: "xz-cognitive-header" });
  const copy = intro.createDiv(); copy.createEl("h3", { text: "从真实经历看见变化" });
  copy.createEl("p", { text: "按内容要点回看记忆与思考，沿着真实经历查看成长。每张卡片都可以展开详情、回到依据。" });
  const nav = intro.createDiv({ cls: "xz-cognitive-actions" });
  button(nav, "回到首页", () => { panel.close(); return plugin.openCognitiveHome(); });
  button(nav, panel.loading ? "正在读取…" : "重新读取", () => panel.refresh()).disabled = panel.loading;
  button(nav, "检查历史记录", () => new GrowthReplayModal(plugin, () => panel.refresh()).open());
  if (panel.error) body.createEl("p", { text: panel.error, cls: "xz-cognitive-error", attr: { role: "alert" } });
  if (!s) { body.createEl("p", { text: panel.loading ? "正在读取本地成长记录…" : "尚未读取到记录" }); return; }
  if (s.errors.length) body.createEl("p", { cls: "xz-cognitive-error", attr: { role: "alert" }, text: `${s.errors.length} 份记录读取或解析失败，列表可能不完整。${s.errors[0].reason}` });
  const updateStatus = body.createEl("section", { cls: "xz-cognitive-card xz-growth-update-status", attr: { "aria-label": "成长记录更新情况" } });
  updateStatus.createEl("h3", { text: "成长记录更新情况" });
  updateStatus.createEl("strong", { text: statusLabel(s.status?.status) });
  updateStatus.createEl("p", { text: s.status?.error || s.status?.reason || "尚无可追溯的最近处理原因；刷新页面只会重读已有记录。" });
  updateStatus.createEl("p", { cls: "xz-cognitive-muted", text: `最近检查：${displayTime(s.lastCheckedAt)} · 最近成长记录变更：${displayTime(s.lastGrowthChangeAt)}` });
  const waitingFeedback = (panel.cognitive?.loops || []).filter(loop => !["completed", "paused"].includes(loop.status) && !loop.feedbacks.length).length;
  if (waitingFeedback) {
    updateStatus.createEl("p", { text: `${waitingFeedback} 项行动尚未记录实际反馈。行动计划与实际成长分别记录，新增计划不会自动视为已经完成。` });
    button(updateStatus, "回到行动并记录反馈", () => { panel.close(); return plugin.openCognitiveHome(); });
  }
  if (["failed", "interrupted", "partial", "pending-confirmation"].includes(s.status?.status)) button(updateStatus, "核对处理记录", () => new GrowthReplayModal(plugin, () => panel.refresh()).open());
  const memory = body.createEl("section", { cls: "xz-memory-section" });
  const mh = memory.createDiv({ cls: "xz-cognitive-section-head" }); mh.createEl("h3", { text: "记忆与思考" });
  const ml = mh.createEl("label"); ml.createSpan({ text: "月份 " }); const month = ml.createEl("input", { attr: { type: "month", "aria-label": "记忆月份" } }); month.value = s.month;
  month.onchange = () => { if (month.value) { panel.month = month.value; panel.pointLimit = 12; panel.interactionLimit = 12; void panel.refresh(); } };
  memory.createEl("p", { cls: "xz-cognitive-muted", text: `${s.memoryPoints?.length || 0} 个内容要点 · 提问、设想与已发生的成长分别呈现。` });
  const pointFilter = memory.createEl("label", { cls: "xz-point-filter" }); pointFilter.createSpan({ text: "内容类型 " }); const select = pointFilter.createEl("select");
  for (const [value, text] of [["all", "全部内容"], ...Object.entries(POINT_LABELS)]) select.createEl("option", { text, attr: { value } }); select.value = panel.pointKind || "all";
  select.onchange = () => { panel.pointKind = select.value; panel.pointLimit = 12; panel.renderContent(); };
  const points = (s.memoryPoints || []).filter(p => !panel.pointKind || panel.pointKind === "all" || p.kind === panel.pointKind);
  const mg = memory.createDiv({ cls: "xz-cognitive-grid" });
  for (const point of points.slice(0, panel.pointLimit || 12)) renderPointCard(mg, plugin, { ...point, label: POINT_LABELS[point.kind], caption: point.kind === "suggestion" ? "是否采用由你决定" : point.kind === "legacy" || point.presentation === "legacy-summary" ? "来自已有整理稿 · 可回看原要点" : "依据本次表达整理" });
  if (!points.length) mg.createEl("p", { cls: "xz-cognitive-empty", text: "当前范围没有可展示的提炼要点。只有原始对话的记录保留在下方来源记录中，可通过“检查历史记录”重新整理。" });
  if (points.length > (panel.pointLimit || 12)) button(memory, `显示更多要点（共 ${points.length} 个）`, () => { panel.pointLimit = (panel.pointLimit || 12) + 12; panel.renderContent(); });
  const diagnostics = body.createEl("details"); diagnostics.createEl("summary", { text: "更新详情与事件时间" });
  const status = diagnostics.createEl("section", { cls: "xz-cognitive-context" });
  status.createEl("strong", { text: statusLabel(s.status?.status) });
  status.createEl("p", { text: s.status?.error || s.status?.reason || "升级前的逐条处理结果未持久保存，无法追认当时的原因。" });
  status.createEl("p", { cls: "xz-cognitive-muted", text: `最近检查：${displayTime(s.lastCheckedAt)} · 最近成长记录变更：${displayTime(s.lastGrowthChangeAt)} · 最新事件发生：${displayTime(s.latestEventAt)}` });
  if (s.errors.length) status.createEl("p", { cls: "xz-cognitive-error", text: `${s.errors.length} 份记录读取或解析失败，列表可能不完整。${s.errors[0].reason}` });
  const journey = body.createEl("section"); journey.createEl("h3", { text: "行动阶段" });
  const journeys = journey.createDiv({ cls: "xz-cognitive-grid" });
  for (const loop of (panel.cognitive?.loops || []).slice(0, 12)) {
    const snapshot = loop.judgmentSnapshots?.at(-1);
    renderPointCard(journeys, plugin, { title: loop.title, summary: loop.problem, label: LOOP_STATUS[loop.status], sourcePath: loop.path, sourceRole: "user-record", occurredAt: loop.updatedAt,
      caption: loop.feedbacks.length ? `已记录 ${loop.feedbacks.length} 次实际反馈` : "已有行动计划 · 等待实际反馈", sections: [
        { title: "当前判断", text: loop.judgment }, { title: "下一步行动", text: loop.action }, { title: "预期结果", text: loop.expected },
        ...(snapshot ? [{ title: `结果前判断快照 v${snapshot.version}`, text: `${snapshot.statement} · 置信度 ${snapshot.confidence.level} · ${snapshot.capturedAt}` }] : []),
        ...loop.feedbacks.flatMap(feedback => [
          { title: "实际反馈", text: feedback.result },
          ...(feedback.judgmentCalibration ? [{ title: "判断校准", text: feedback.judgmentCalibration.eligibility === "eligible"
            ? `${CALIBRATION_STATUS[feedback.judgmentCalibration.status] || "状态未知"} · 预期：${feedback.judgmentCalibration.expected || "未记录"}`
            : "缺少结果出现前的判断快照，本次不追认校准。" }] : []),
        ]),
      ] });
  }
  if (!panel.cognitive?.loops.length) journeys.createEl("p", { cls: "xz-cognitive-empty", text: "还没有关联了问题、行动与反馈的阶段记录。可在首页建立第一项行动；已有成长事件在下方保留。" });
  const eventsSection = body.createEl("section");
  const head = eventsSection.createDiv({ cls: "xz-cognitive-section-head" }); head.createEl("h3", { text: "成长路径与事件" });
  const filterLabel = head.createEl("label"); filterLabel.createSpan({ text: "事件类型 " }); const filter = filterLabel.createEl("select");
  for (const [value, text] of [["all", "全部类型"], ...Object.entries(GROWTH_EVENT_LABELS)]) filter.createEl("option", { text, attr: { value } }); filter.value = panel.eventType || "all";
  filter.onchange = () => { panel.eventType = filter.value; panel.eventLimit = 24; panel.renderContent(); };
  const events = s.events.filter(e => !panel.eventType || panel.eventType === "all" || e.eventType === panel.eventType);
  const grid = eventsSection.createDiv({ cls: "xz-growth-event-grid" });
  let date = "";
  for (const event of events.slice(0, panel.eventLimit || 24)) {
    const group = displayTime(event.occurredAt).split(" ")[0]; if (group !== date) { date = group; grid.createEl("h4", { cls: "xz-growth-date", text: date }); }
    renderPointCard(grid, plugin, { ...event, label: GROWTH_EVENT_LABELS[event.eventType] || "成长事件", caption: event.sourceRole === "user-record" ? "用户填写" : "依据用户自述", stateDescription: ["goal", "action"].includes(event.eventType) ? "计划与结果分别记录；是否完成以实际反馈为准。" : "保留当时的记录，新的经历可以补充或修订这个判断。" });
  }
  if (!events.length) grid.createEl("p", { cls: "xz-cognitive-empty", text: "当前范围没有成长事件。没有可验证的新变化时，保持空白是正常结果。" });
  if (events.length > (panel.eventLimit || 24)) button(eventsSection, `显示更多（共 ${events.length} 条）`, () => { panel.eventLimit = (panel.eventLimit || 24) + 24; panel.renderContent(); });
  const interactionSection = body.createEl("details"); interactionSection.createEl("summary", { text: `来源记录（${s.month} · ${s.interactions.length} 次交互）` });
  interactionSection.createEl("p", { cls: "xz-cognitive-muted", text: `其中 ${s.summarizedSources || 0} 次有可展示的提炼要点。此处保留原始输入与处理状态，便于追溯。` });
  const interactions = interactionSection.createDiv({ cls: "xz-source-log" });
  for (const event of s.interactions.slice(0, panel.interactionLimit || 12)) {
    const card = interactions.createEl("article", { cls: "xz-source-log-row" }); card.createSpan({ cls: "xz-cognitive-tag", text: displayTime(event.occurredAt) });
    card.createEl("p", { text: event.summary });
    card.createEl("p", { cls: "xz-cognitive-muted", text: event.processing ? statusLabel(event.processing.status) : "旧记录没有逐条处理结果" }); sourceButton(card, plugin, event);
  }
  if (!s.interactions.length) interactions.createEl("p", { text: "这个月尚无交互记录。可以切换月份查看已有记录。" });
  if (s.interactions.length > (panel.interactionLimit || 12)) button(interactionSection, `显示更多交互（共 ${s.interactions.length} 条）`, () => { panel.interactionLimit = (panel.interactionLimit || 12) + 12; panel.renderContent(); });
  const preferences = body.createEl("details"); preferences.createEl("summary", { text: `当前交互与使用偏好（${s.profiles.length} 项）` });
  const pg = preferences.createDiv({ cls: "xz-cognitive-grid" });
  for (const p of s.profiles.slice(0, 80)) renderPointCard(pg, plugin, { ...p, title: pointTitle(p.statement), summary: p.statement, occurredAt: p.lastObservedAt,
    label: p.status === "active" ? "已采用的交互偏好" : "待核实观察", stateDescription: p.status === "active" ? "当前用于调整交互方式，可根据新的表达修订。" : "目前只作为观察，尚不作为稳定偏好。" });
  const runs = body.createEl("details"); runs.createEl("summary", { text: `最近处理记录（${s.runs.length} 条）` });
  for (const run of s.runs.slice(0, 20)) { const card = runs.createEl("article", { cls: "xz-cognitive-context" }); card.createEl("strong", { text: `${statusLabel(run.status)} · ${displayTime(run.completedAt || run.startedAt)}` }); card.createEl("p", { text: run.reason || run.error || "未保存原因" }); for (const reason of run.ignored || []) card.createEl("p", { text: reason }); if (run.capabilityVersions) card.createEl("p", { cls: "xz-cognitive-muted", text: `模型：${run.model || "未知"} · 能力：${run.capabilityVersions}` }); }
  const files = body.createEl("details"); files.createEl("summary", { text: "查看完整档案与 Markdown 原文" });
  const fileLinks = files.createDiv({ cls: "xz-cognitive-actions" });
  for (const card of s.cards) button(fileLinks, card.title, () => panel.openReader(card)).disabled = !card.exists;
  body.createEl("p", { cls: "xz-cognitive-muted", text: `本页读取于 ${displayTime(s.generatedAt)}。刷新页面只重读文件；历史重检需要主动选择记录，并会使用当前模型连接。` });
}
module.exports = { renderGrowthContent };
