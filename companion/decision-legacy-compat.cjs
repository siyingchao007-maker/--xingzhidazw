"use strict";

function text(value, maximum = 4000) { return String(value || "").trim().slice(0, maximum); }

function extractJsonBlocks(markdown) {
  const blocks = [];
  const pattern = /```([A-Za-z0-9_-]+)?\s*\n([\s\S]*?)\n```/gu;
  let match;
  while ((match = pattern.exec(String(markdown || ""))) !== null) {
    const body = match[2].trim();
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    try { blocks.push({ label: match[1] || "json", value: JSON.parse(body) }); } catch {}
  }
  return blocks;
}

function extractV2Markers(markdown) {
  const source = String(markdown || "");
  if (source.length > 2_000_000) return [];
  const markers = [];
  const pattern = /<!--\s*XINGZHI_COGNITIVE_LOOP_V2:([A-Za-z0-9_-]{1,300000})\s*-->/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    try {
      const json = Buffer.from(match[1], "base64url").toString("utf8");
      const value = JSON.parse(json);
      if (value && typeof value === "object" && !Array.isArray(value)) markers.push(value);
    } catch {}
  }
  return markers;
}

function summaryFromV2(value, original, sourceLabel) {
  return Object.freeze({
    kind: "cognitive-loop-v2",
    schemaVersion: 2,
    title: text(value.title || value.question || value.topic || "旧认知循环 V2", 240),
    judgment: text(value.judgment || value.currentJudgment || value.problem || "", 2000),
    snapshotCount: Array.isArray(value.judgmentSnapshots) ? value.judgmentSnapshots.length : 0,
    actionBound: Boolean(value.actionBinding?.testsJudgmentSnapshotId),
    sourceLabel,
    readOnly: true,
    original,
  });
}

function detectLegacyCognitiveRecord(markdown) {
  const original = String(markdown || "");
  for (const value of extractV2Markers(original)) {
    if (value.cognitiveSchemaVersion === 2) return summaryFromV2(value, original, "XINGZHI_COGNITIVE_LOOP_V2");
  }
  for (const block of extractJsonBlocks(original)) {
    const value = block.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value.cognitiveSchemaVersion === 2) {
      return summaryFromV2(value, original, block.label);
    }
  }
  if (/cognitiveSchemaVersion\s*:\s*2/u.test(original)) {
    const heading = original.match(/^#\s+(.+)$/mu)?.[1] || "旧认知循环 V2";
    return Object.freeze({ kind: "cognitive-loop-v2", schemaVersion: 2, title: text(heading, 240), judgment: "", snapshotCount: 0, actionBound: false, sourceLabel: "markdown", readOnly: true, original });
  }
  return null;
}

function legacyReadOnlySummary(record) {
  if (!record) return null;
  return Object.freeze({
    title: record.title,
    rows: Object.freeze([
      ["记录类型", "认知循环 V2"],
      ["模式", "只读兼容"],
      ["判断快照", `${record.snapshotCount} 个`],
      ["行动绑定", record.actionBound ? "已绑定" : "未绑定或无法确认"],
      ["当前判断", record.judgment || "原记录未提供可直接展示的判断字段"],
    ]),
  });
}

module.exports = { extractJsonBlocks, extractV2Markers, detectLegacyCognitiveRecord, legacyReadOnlySummary };
