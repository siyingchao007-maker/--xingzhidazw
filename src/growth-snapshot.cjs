"use strict";
const { CURRENT_PROFILE_PATH, GROWTH_PATH_PATH, GROWTH_EVENTS_PATH, extractProfileEntries, extractGrowthPathEvents, buildUserContinuityCardSummary, interactionLedgerPath } = require("./user-continuity.cjs");
const { readGrowthEvents, readInteractionEvents } = require("./growth-records.cjs");
const { conversationTranscriptPath } = require("./conversation-store.cjs");
const { recordContinuityRun } = require("./growth-status.cjs");
const { readOrganizationPoints, dedupePoints, PRESENTATION_PATH, applyPointPresentation } = require("./growth-points.cjs");
async function buildGrowthSnapshot(vault, state, now, options = {}) {
  const month = options.month || now.slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error("交互月份无效");
  const ledgerPath = interactionLedgerPath(`${month}-01T00:00:00Z`);
  const definitions = [
    { id: "current-profile", title: "当前交互与使用偏好", typeLabel: "当前画像", path: CURRENT_PROFILE_PATH },
    { id: "growth-path", title: "用户成长路径", typeLabel: "成长路径", path: GROWTH_PATH_PATH },
    { id: "growth-events", title: "成长路径事件", typeLabel: "成长事件", path: GROWTH_EVENTS_PATH },
    { id: "interaction-ledger", title: "交互痕迹", typeLabel: "交互事件", path: ledgerPath },
  ];
  const cards = await Promise.all(definitions.map(async d => {
    try { const exists = await vault.exists(d.path); const content = exists ? await vault.read(d.path) : "";
      return { ...d, exists, content, summary: buildUserContinuityCardSummary(d.id, content), modifiedAt: vault.modifiedAt?.(d.path) || null }; }
    catch (error) { return { ...d, exists: false, content: "", error: error.message }; }
  }));
  const errors = cards.filter(c => c.error).map(c => ({ path: c.path, reason: c.error }));
  const parse = (card, fn) => { try { return fn(card.content); } catch (error) { errors.push({ path: card.path, reason: error.message }); return []; } };
  const profiles = parse(cards[0], extractProfileEntries);
  const events = [...new Map([...parse(cards[1], extractGrowthPathEvents), ...parse(cards[2], readGrowthEvents)].map(e => [e.id, e])).values()];
  const sourcePaths = new Map((state.conversations || []).flatMap(c => (c.messages || []).filter(m => m.role === "user" && !m.internal).map(m => [m.id, conversationTranscriptPath(c.id)])));
  profiles.forEach(p => { p.sourceMessageId = p.sourceMessageIds?.at(-1) || ""; p.sourcePath = sourcePaths.get(p.sourceMessageId) || ""; });
  const runs = recordContinuityRun(state.continuityRuns || [], state.runtime?.userContinuity);
  const runsByMessage = new Map(runs.map(r => [r.sourceMessageId, r]));
  const interactions = readInteractionEvents(cards[3].content, ledgerPath).map(e => ({ ...e, processing: runsByMessage.get(e.sourceMessageId) || null }));
  const sources = new Map((state.conversations || []).filter(c => !c.deletedAt).flatMap(c => (c.messages || []).filter(m => m.role === "user" && !m.internal).map(m => [m.id, { message: m, path: conversationTranscriptPath(c.id) }])));
  const organized = new Map((state.conversationOrganizationRecords || []).filter(r => r.draftPath).map(r => [r.userMessageId, r]));
  const pointGroups = [], pending = [...interactions];
  // Bound concurrent reads; no model calls or knowledge writes during rendering.
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
    while (pending.length) {
      const event = pending.shift(), record = organized.get(event.sourceMessageId), source = sources.get(event.sourceMessageId);
      if (!record || !source) continue;
      const path = globalThis.__xzResolveOrganizationPath(record.draftPath, record);
      if (!path.startsWith("09_认知资产/对话沉淀/") || !path.endsWith(".md") || path.includes("\\") || path.split("/").some(s => !s || s === "." || s === "..")) continue;
      try {
        if (!await vault.exists(path)) continue;
        pointGroups.push(readOrganizationPoints(await vault.read(path), { path, sourceMessageId: event.sourceMessageId, sourceText: source.message.content,
          sourcePath: source.path, occurredAt: source.message.completedAt || source.message.createdAt || event.occurredAt }));
      } catch (error) { errors.push({ path, reason: error.message }); }
    }
  }));
  let presentation = null;
  try { if (await vault.exists(PRESENTATION_PATH)) { const text = await vault.read(PRESENTATION_PATH); if (text.length > 1_000_000) throw new Error("历史卡片摘要超过读取上限"); presentation = JSON.parse(text); } }
  catch (error) { errors.push({ path: PRESENTATION_PATH, reason: error.message }); }
  const memoryPoints = applyPointPresentation(dedupePoints(pointGroups.flat()), presentation).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.sourceMessageId.localeCompare(b.sourceMessageId) || a.order - b.order);
  const summarizedSources = new Set(memoryPoints.map(p => p.sourceMessageId)).size;
  events.forEach(e => { e.sourcePath ||= sourcePaths.get(e.sourceMessageId) || ""; });
  events.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return { generatedAt: now, month, cards, events, profiles, interactions, memoryPoints, summarizedSources, runs: runs.toReversed(), errors,
    status: state.runtime?.userContinuity || runs.at(-1) || null,
    lastCheckedAt: runs.map(r => r.completedAt).filter(Boolean).sort().at(-1) || null,
    lastGrowthChangeAt: cards[2].modifiedAt || events.map(e => e.recordedAt).filter(Boolean).sort().at(-1) || null,
    latestEventAt: events[0]?.occurredAt || null };
}
function growthReplayPreview(state, options = {}) {
  const since = options.since || new Date(Date.now() - 7 * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(since))) throw new Error("起始日期无效");
  const runs = new Map((state.continuityRuns || []).map(r => [`${r.conversationId}:${r.sourceMessageId}`, r]));
  const items = [];
  for (const conversation of state.conversations || []) {
    if (conversation.deletedAt || conversation.archivedAt) continue;
    for (const message of conversation.messages || []) {
      if (message.role !== "user" || message.internal || message.status !== "completed" || !String(message.content || "").trim()) continue;
      const time = message.completedAt || message.createdAt;
      if (!Number.isFinite(Date.parse(time)) || Date.parse(time) < Date.parse(since)) continue;
      const previous = runs.get(`${conversation.id}:${message.id}`);
      if (previous && !["failed", "partial", "interrupted", "recorded-only", "skipped-read-only", "pending-confirmation"].includes(previous.status) && !options.includeProcessed) continue;
      items.push({ conversationId: conversation.id, sourceMessageId: message.id, occurredAt: time, title: conversation.title || "对话记录",
        summary: String(message.content).replace(/\s+/gu, " ").slice(0, 160), previousStatus: previous?.status || "unknown" });
    }
  }
  return { since, total: items.length, items: items.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 30) };
}
module.exports = { buildGrowthSnapshot, growthReplayPreview };
