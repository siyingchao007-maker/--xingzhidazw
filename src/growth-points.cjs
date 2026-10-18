"use strict";
const { createHash } = require("node:crypto");
const POINT_LABELS = { "self-report": "自述线索", question: "待解问题", plan: "方案设想", judgment: "当前判断", legacy: "历史提炼", suggestion: "系统建议" };
const POINT_STATES = { "self-report": "依据用户本次表达整理，尚不能由此认定为长期稳定特征。", question: "这是正在探索的问题，尚未形成结论。", plan: "这是考虑中的方案，实际执行与结果需要另行记录。", judgment: "这是当前表达的判断，可随新证据修订。", legacy: "从已有整理稿提取，内容与认识状态需结合原文核对。", suggestion: "来源于助手整理稿，尚不代表用户已经接受或执行。" };
const bounded = (value, max) => typeof value === "string" ? value.replaceAll("\0", "").trim().slice(0, max) : "";
const key = text => createHash("sha256").update(text).digest("hex").slice(0, 20);
const PRESENTATION_PATH = "00_系统/运行记录/内容卡片/历史展示摘要-v1.json";
function presentationDigest(point) { return createHash("sha256").update(`${point.id}\n${point.summary}`).digest("hex"); }
function applyPointPresentation(points, index) {
  if (!index || index.version !== 1 || !index.points || typeof index.points !== "object") return points;
  return points.flatMap(point => {
    const item = index.points[point.id];
    if (!item || item.sourceDigest !== presentationDigest(point)) return [point];
    if (item.hidden === true && bounded(item.reason, 300)) return [];
    const title = bounded(item.title, 80), summary = bounded(item.summary, 600);
    if (!title || !summary) return [point];
    const kind = point.kind === "suggestion" ? "suggestion" : Object.hasOwn(POINT_LABELS, item.kind) ? item.kind : point.kind;
    // The sidecar changes presentation only. Its original synthesized statement remains visible.
    return [{ ...point, title, summary, kind, presentation: "legacy-summary", stateDescription: POINT_STATES[kind], sections: [{ title: "整理稿中的原要点", text: point.summary }] }];
  });
}
function normalizeDisplayPoints(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(p => {
    if (!p || !["self-report", "question", "plan", "judgment"].includes(p.kind)) return [];
    const title = bounded(p.title, 80), summary = bounded(p.summary, 600), evidenceQuote = bounded(p.evidenceQuote, 500);
    if (!title || !summary || !evidenceQuote) return [];
    return [{ title, summary, evidenceQuote, kind: p.kind, details: Array.isArray(p.details) ? p.details.map(x => bounded(x, 400)).filter(Boolean).slice(0, 4) : [] }];
  });
}
function displayPointPrompt() {
  return "displayPoints 是供产品卡片展示的内容提炼，最多 8 项，一个独立记忆线索或思考点一项；与正式知识晋升、成长事件分开。每项仅含 title、summary、kind、evidenceQuote、details。title 用 8—24 字概括内容主题，不使用对话标题、问候或原话开头；summary 用 1—2 句总结这个要点，保留不确定性、否定和未执行状态，不抄长段原话；details 为最多 4 条必要补充。kind 只能是 self-report（本次自述）、question（待解问题）、plan（方案设想）、judgment（当前判断）。evidenceQuote 必须逐字来自当前用户消息。不得把助手建议、附件转述或普通提问写成用户事实或已完成的成长。临时操作指令、寒暄、处理流程和无信息输入返回空数组。";
}
function section(text, heading) {
  const at = text.indexOf(`\n## ${heading}\n`);
  if (at < 0) return "";
  const start = at + heading.length + 6, end = text.indexOf("\n## ", start);
  return text.slice(start, end < 0 ? text.length : end).trim();
}
function pointTitle(summary) {
  // The source is already a synthesized knowledge point. Keep its qualifying words.
  return summary.replace(/^(?:本轮)?用户(?:明确自述|明确表示|明确表达|自述|表示)?/u, "").trim().split(/[；;。\n]/u)[0].slice(0, 80) || "待核对的内容要点";
}
function dedupePoints(points) {
  return [...new Map(points.map(p => [`${p.sourceMessageId}:${p.kind}:${p.summary.replace(/\s+/gu, "")}`, p])).values()];
}
function readOrganizationPoints(content, context) {
  const text = String(content || "").replace(/\r\n?/gu, "\n");
  if (text.length > 1_000_000) throw new Error("对话整理稿超过读取上限");
  const wrap = (p, index) => ({ ...p, id: `point-${key(`${context.sourceMessageId}:${p.kind}:${p.summary}`)}`, sourcePath: context.sourcePath,
    sourceMessageId: context.sourceMessageId, occurredAt: context.occurredAt, archivePath: context.path, order: index, stateDescription: POINT_STATES[p.kind] });
  const marker = text.match(/<!-- XINGZHI_DISPLAY_POINTS_V1:([A-Za-z0-9_-]+) -->/u);
  if (marker) {
    let raw; try { raw = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8")); } catch { throw new Error("内容卡片数据损坏"); }
    return dedupePoints(normalizeDisplayPoints(raw).filter(p => context.sourceText && context.sourceText.includes(p.evidenceQuote)).map(wrap));
  }
  // Basic archive fallback consists of user/assistant excerpts; it is not a summary.
  if (/^用户：/mu.test(section(text, "本轮概览"))) return [];
  const candidates = [];
  for (const [heading, kind] of [["用户明确表达", "legacy"], ["助手生成内容（系统草稿）", "suggestion"]]) {
    const block = section(text, heading);
    for (const match of block.matchAll(/^### (.+)\n+([\s\S]*?)(?=^### |$(?![\s\S]))/gmu)) {
      const summary = match[2].split(/^-/mu)[0].trim();
      if (summary) candidates.push({ title: match[1].trim(), summary, kind, details: [], evidenceQuote: "" });
    }
  }
  if (candidates.length) return dedupePoints(candidates.map(wrap));
  const summaries = section(text, "核心知识点").split("\n").filter(line => /^- /u.test(line)).map(line => line.slice(2).trim())
    .filter(line => line && !/(?:知识候选|候选门槛|晋升|根目录|profile-[a-z0-9]|可复用知识点|既有画像|来源角色|独立证据.*(?:不足|没有))/u.test(line))
    .filter(line => !context.sourceText?.includes(line));
  return dedupePoints(summaries.slice(0, 8).map(summary => ({ title: pointTitle(summary), summary, kind: /^(?:本轮)?助手/u.test(summary) ? "suggestion" : "legacy", details: [], evidenceQuote: "" })).map(wrap));
}
module.exports = { POINT_LABELS, POINT_STATES, normalizeDisplayPoints, displayPointPrompt, readOrganizationPoints, dedupePoints, pointTitle, PRESENTATION_PATH, presentationDigest, applyPointPresentation };
