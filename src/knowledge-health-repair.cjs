"use strict";

const crypto = require("node:crypto");
const { inspectGeneratedKnowledgeNote } = require("./knowledge-tools.cjs");
const { routeKnowledgeCandidate } = require("./knowledge-router.cjs");
const { hashContent, validateVaultMarkdownPath } = require("./knowledge-writer.cjs");

const AUTOMATIC_CODES = new Set([
  "legacy-schema",
  "missing-index-file",
  "index-unlisted",
]);
const INDEX_CODES = new Set(["missing-index-file", "index-unlisted"]);
const MIGRATION_FIELDS = Object.freeze([
  "epistemicStatus", "tags", "aliases", "relatedKnowledge", "sourceConversationPath",
  "sourceMessageId", "sourceQuotedText", "sourceDocuments",
]);
const EPISTEMIC_LABELS = Object.freeze({
  fact: "事实",
  "user-statement": "用户自述",
  inference: "推断",
  "value-judgment": "价值判断",
  hypothesis: "待验证假设",
  unknown: "未知",
});

function safeJsonScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!text.startsWith('"')) return text;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
}

function fieldValue(frontmatter, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.*)$`, "mu").exec(frontmatter);
  return match ? safeJsonScalar(match[1]) : "";
}

function hasField(frontmatter, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}:`, "mu").test(frontmatter);
}

function unique(values, limit = 20) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function safeTag(value) {
  return String(value || "").trim().replace(/^#+/u, "")
    .replace(/[\\/\[\]#|^:]/gu, "-").replace(/\s+/gu, "-")
    .replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48);
}

function legacyConversationPath(frontmatter) {
  let value = fieldValue(frontmatter, "来源对话");
  const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/u.exec(value);
  if (link) value = link[1];
  value = value.replaceAll("\\", "/").trim();
  if (!value || value.startsWith("/") || value.includes("../")) return "";
  if (!/\.md$/iu.test(value)) value += ".md";
  try {
    return validateVaultMarkdownPath(value);
  } catch {
    return "";
  }
}

function legacyDocuments(frontmatter) {
  const value = fieldValue(frontmatter, "文档证据");
  if (!value) return [];
  return unique(value.split("|").map((item) => {
    const text = item.trim();
    const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/u.exec(text);
    return link ? `${link[1].replace(/\.md$/iu, "")}.md` : text;
  }));
}

function originalExpression(body) {
  const match = /^- 原始表达：(.+)$/mu.exec(body);
  return match ? match[1].trim().slice(0, 8_000) : "";
}

function frontmatterParts(content) {
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/u.exec(String(content || ""));
  if (!match || match[2].length > 64_000) throw new Error("知识 Frontmatter 无法安全升级");
  return {
    eol: match[1],
    frontmatter: match[2],
    body: String(content).slice(match[0].length),
  };
}

function upgradeLegacyKnowledgeNote(note) {
  const path = validateVaultMarkdownPath(note?.path);
  const content = typeof note?.content === "string" ? note.content : "";
  const inspected = inspectGeneratedKnowledgeNote({ path, content });
  if (!inspected.generated || inspected.malformed) throw new Error(`知识文件不能安全升级：${path}`);
  const parts = frontmatterParts(content);
  const route = routeKnowledgeCandidate({ knowledgeType: inspected.knowledgeType });
  const key = fieldValue(parts.frontmatter, "key");
  const title = fieldValue(parts.frontmatter, "title");
  const epistemic = inspected.epistemicStatus || fieldValue(parts.frontmatter, "认识状态") || "unknown";
  const values = {
    epistemicStatus: epistemic,
    tags: [
      `行知/知识类型/${safeTag(route.label)}`,
      `行知/认识状态/${safeTag(EPISTEMIC_LABELS[epistemic] || epistemic)}`,
      "行知/状态/有效",
    ],
    aliases: key && key !== title ? [key] : [],
    relatedKnowledge: [],
    sourceConversationPath: legacyConversationPath(parts.frontmatter),
    sourceMessageId: fieldValue(parts.frontmatter, "来源消息"),
    sourceQuotedText: originalExpression(parts.body),
    sourceDocuments: legacyDocuments(parts.frontmatter),
  };
  const addedFields = MIGRATION_FIELDS.filter((name) => !hasField(parts.frontmatter, name));
  if (!addedFields.length) return { path, content, expectedHash: hashContent(content), addedFields };
  const inserted = addedFields.map((name) => `${name}: ${JSON.stringify(values[name])}`);
  const lines = parts.frontmatter.split(/\r?\n/u);
  const versionIndex = lines.findIndex((line) => /^版本:/u.test(line));
  lines.splice(versionIndex >= 0 ? versionIndex : lines.length, 0, ...inserted);
  const nextContent = `---${parts.eol}${lines.join(parts.eol)}${parts.eol}---${parts.body}`;
  const verified = inspectGeneratedKnowledgeNote({ path, content: nextContent });
  if (!verified.generated || verified.malformed) throw new Error(`字段升级结果未通过校验：${path}`);
  return { path, content: nextContent, expectedHash: hashContent(content), addedFields };
}

function planKnowledgeHealthRepairs(input = {}) {
  const now = typeof input.now === "string" ? input.now : new Date().toISOString();
  const issues = (Array.isArray(input.issues) ? input.issues : []).slice(0, 2_000);
  const formal = new Map((Array.isArray(input.formalNotes) ? input.formalNotes : []).map((note) => [note?.path, note]));
  const schemaChanges = [];
  const duplicateMoves = [];
  const indexIssueIds = [];
  const manualIssues = [];

  for (const issue of issues) {
    if (!issue || typeof issue.id !== "string" || !AUTOMATIC_CODES.has(issue.code)) {
      if (issue?.id) manualIssues.push({ id: issue.id, code: issue.code, path: issue.path });
      continue;
    }
    if (issue.code === "legacy-schema") {
      const note = formal.get(issue.path);
      if (!note) throw new Error(`处理方案已过期，找不到知识文件：${issue.path}`);
      const upgraded = upgradeLegacyKnowledgeNote(note);
      schemaChanges.push({
        issueId: issue.id,
        operation: "replace",
        path: upgraded.path,
        content: upgraded.content,
        expectedHash: upgraded.expectedHash,
        addedFields: upgraded.addedFields,
      });
      continue;
    }
    if (INDEX_CODES.has(issue.code)) {
      indexIssueIds.push(issue.id);
      continue;
    }
  }
  const id = crypto.createHash("sha256")
    .update(`${now}\0${issues.map((issue) => issue?.id || "").join("\0")}`)
    .digest("hex").slice(0, 24);
  return {
    id,
    createdAt: now,
    requestedIssues: issues.length,
    schemaChanges,
    duplicateMoves,
    indexIssueIds,
    manualIssues,
    indexPreview: null,
  };
}

function publicKnowledgeHealthRepairPreview(plan) {
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    requestedIssues: plan.requestedIssues,
    repairableIssues: plan.schemaChanges.length + plan.duplicateMoves.length + plan.indexIssueIds.length,
    schemaFiles: plan.schemaChanges.map((change) => change.path),
    duplicateDefinitions: plan.duplicateMoves.map(({ from, to, canonicalPath }) => ({ from, to, canonicalPath })),
    indexIssues: plan.indexIssueIds.length,
    indexFiles: plan.indexPreview?.changes?.length || 0,
    manualIssues: plan.manualIssues.map(({ id, code, path }) => ({ id, code, path })),
  };
}

module.exports = {
  planKnowledgeHealthRepairs,
  publicKnowledgeHealthRepairPreview,
  upgradeLegacyKnowledgeNote,
};
