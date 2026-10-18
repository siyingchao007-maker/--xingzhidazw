"use strict";
const { canonicalGrowthType, GROWTH_EVENT_TYPES } = require("./growth-contract.cjs");
const EVENT_STATE_MARKER = "XINGZHI_GROWTH_EVENT_V2";
function encodeGrowthRecord(event) {
  return `<!-- ${EVENT_STATE_MARKER}:${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")} -->`;
}
function readGrowthEvents(markdown) {
  const text = String(markdown || "");
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("成长档案超过读取上限，请按年度归档后重试");
  const events = []; let start = 0;
  for (const match of text.matchAll(/<!-- xingzhi-growth-event:([A-Za-z0-9._:-]+) -->/gu)) {
    const block = text.slice(start, match.index); start = match.index + match[0].length;
    const encoded = block.match(/<!-- XINGZHI_GROWTH_EVENT_V2:([A-Za-z0-9_-]+) -->/u);
    let event;
    if (encoded) {
      try { event = JSON.parse(Buffer.from(encoded[1], "base64url").toString("utf8")); }
      catch { throw new Error(`成长事件 ${match[1]} 的结构记录损坏，未覆盖原文件`); }
      if (event?.id !== match[1] || !event.title || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error("成长事件记录与标识不一致");
    } else {
      const heading = [...block.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.+)$/gmu)].at(-1);
      if (!heading) continue;
      event = { id: match[1], title: heading[2], occurredAt: heading[1].replace(" ", "T") + ":00Z",
        eventType: block.match(/^- 类型：(.+)$/mu)?.[1]?.trim(), summary: block.match(/^- 摘要：(.+)$/mu)?.[1] || heading[2],
        sourceMessageId: block.match(/^- 来源消息：`([^`]+)`/mu)?.[1] || "", evidenceQuote: "", sourcePath: "", sourceRole: "user-statement" };
    }
    event.eventType = canonicalGrowthType(event.eventType);
    if (!GROWTH_EVENT_TYPES.has(event.eventType)) continue;
    events.push(event);
  }
  return [...new Map(events.map(e => [e.id, e])).values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}
function readInteractionEvents(markdown, path) {
  const text = String(markdown || ""); const events = []; let start = 0;
  for (const match of text.matchAll(/<!-- xingzhi-interaction:([A-Za-z0-9._:-]+) -->/gu)) {
    const block = text.slice(start, match.index); start = match.index + match[0].length;
    const heading = [...block.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.+)$/gmu)].at(-1);
    const link = block.match(/\[\[([^\]|]+)#\^([^\]|]+)(?:\|[^\]]+)?\]\]/u);
    events.push({ id: match[1], title: heading?.[2] || "交互记录", occurredAt: heading ? heading[1].replace(" ", "T") + ":00Z" : null,
      summary: block.match(/(?:问题概览|用户问题|输入摘要)[：:]\s*(.+)$/mu)?.[1] || "打开原记录查看",
      sourcePath: link?.[1] || path, sourceMessageId: link?.[2] || "" });
  }
  return events.toReversed();
}
module.exports = { encodeGrowthRecord, readGrowthEvents, readInteractionEvents };
