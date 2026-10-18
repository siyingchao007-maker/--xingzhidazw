"use strict";

const crypto = require("node:crypto");
const {
  inspectGeneratedKnowledgeNote,
  readKnowledgeManifest,
} = require("./knowledge-tools.cjs");
const { validateVaultMarkdownPath } = require("./knowledge-writer.cjs");

const ALLOWED_SUGGESTION_FIELDS = new Set([
  "path", "beforeHash", "processingLevel", "handlingMode", "summary", "keyPoints",
  "suggestedUses", "tags", "aliases",
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message) {
  const error = new Error(message);
  error.code = "UNSAFE_SEMANTIC_ENRICHMENT";
  throw error;
}

function boundedText(value, maximum, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) fail(label + "不能为空");
  if (result.length > maximum) fail(label + "超过安全长度");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(result)) fail(label + "包含控制字符");
  return result;
}

function cleanList(value, maximumItems, maximumLength, label) {
  if (!Array.isArray(value) || !value.length) fail(label + "不能为空");
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const clean = boundedText(item, maximumLength, label);
    if (seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
    if (result.length >= maximumItems) break;
  }
  if (!result.length) fail(label + "不能为空");
  return result;
}

function cleanOptionalList(value, maximumItems, maximumLength) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim().slice(0, maximumLength);
    if (!clean || seen.has(clean) || /[\n\r#[\]|{}<>]/u.test(clean) || clean.includes("..")) continue;
    seen.add(clean);
    result.push(clean);
    if (result.length >= maximumItems) break;
  }
  return result;
}

function generatedParts(content) {
  const match = String(content).match(/^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/u);
  if (!match) fail("知识文件缺少可安全更新的 Frontmatter");
  return {
    opening: match[1],
    frontmatter: match[2],
    closing: match[3],
    body: match[4],
    eol: match[1].includes("\r\n") ? "\r\n" : "\n",
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&");
}

function replaceFrontmatterField(frontmatter, field, value) {
  const source = "^" + escapeRegExp(field) + ":\\s*.*$";
  const matches = [...frontmatter.matchAll(new RegExp(source, "gmu"))];
  if (matches.length !== 1) fail("知识文件的 " + field + " 字段缺失或重复");
  return frontmatter.replace(new RegExp(source, "mu"), field + ": " + value);
}

function replaceBodySection(body, heading, lines, eol) {
  const normalized = body.replace(/\r\n/gu, "\n");
  const source = "(^## " + escapeRegExp(heading) + "\\s*\\n)([\\s\\S]*?)(?=^## |$)";
  const matches = [...normalized.matchAll(new RegExp(source, "gmu"))];
  if (matches.length !== 1) fail("知识文件的“" + heading + "”章节缺失或重复");
  const replacement = "## " + heading + "\n\n" + lines.join("\n") + "\n\n";
  return normalized.replace(new RegExp(source, "mu"), replacement).replaceAll("\n", eol);
}

function themeTags(values) {
  return cleanOptionalList(values, 8, 60).map((value) => {
    const compact = value.replace(/^#+/u, "").replaceAll("/", "-").trim();
    return compact ? "主题/" + compact : "";
  }).filter(Boolean);
}

function materializeSemanticEnrichment(note, suggestion, options = {}) {
  if (!note || typeof note.path !== "string" || typeof note.content !== "string") {
    fail("语义整理目标不完整");
  }
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) {
    fail("语义整理建议不完整");
  }
  for (const key of Object.keys(suggestion)) {
    if (!ALLOWED_SUGGESTION_FIELDS.has(key)) fail("语义整理建议包含不支持的字段：" + key);
  }
  const path = validateVaultMarkdownPath(note.path);
  if (path !== suggestion.path) fail("语义整理不能改变目标路径");
  if (!SHA256.test(String(suggestion.beforeHash || ""))) fail("语义整理缺少有效的来源哈希");
  const liveHash = crypto.createHash("sha256").update(note.content, "utf8").digest("hex");
  if (liveHash !== suggestion.beforeHash) fail("知识文件在预演后发生变化，请重新扫描");
  if (suggestion.processingLevel !== "L1" || suggestion.handlingMode !== "agent-auto") {
    fail("仅允许 L1 Agent 自动语义加工进入受控写入");
  }
  const inspected = inspectGeneratedKnowledgeNote(note);
  const manifest = readKnowledgeManifest(note);
  if (!inspected.generated || inspected.malformed || !manifest) fail("只有结构完整的行知正式知识可以补充派生语义");

  const summary = boundedText(suggestion.summary, 2_000, "核心总结");
  const keyPoints = cleanList(suggestion.keyPoints, 5, 600, "核心知识点");
  const suggestedUses = cleanList(suggestion.suggestedUses, 3, 600, "建议用途");
  const tags = [...new Set([...manifest.tags, ...themeTags(suggestion.tags)])].slice(0, 20);
  const aliases = [...new Set([...manifest.aliases, ...cleanOptionalList(suggestion.aliases, 8, 80)])].slice(0, 12);
  const parts = generatedParts(note.content);
  let frontmatter = parts.frontmatter;
  frontmatter = replaceFrontmatterField(frontmatter, "summary", JSON.stringify(summary));
  frontmatter = replaceFrontmatterField(frontmatter, "keyPoints", JSON.stringify(keyPoints));
  frontmatter = replaceFrontmatterField(frontmatter, "suggestedUses", JSON.stringify(suggestedUses));
  frontmatter = replaceFrontmatterField(frontmatter, "tags", JSON.stringify(tags));
  frontmatter = replaceFrontmatterField(frontmatter, "aliases", JSON.stringify(aliases));
  const now = typeof options.now === "string" && Number.isFinite(Date.parse(options.now))
    ? new Date(options.now).toISOString() : new Date().toISOString();
  frontmatter = replaceFrontmatterField(frontmatter, "更新时间", JSON.stringify(now));
  let body = replaceBodySection(parts.body, "核心总结", [summary], parts.eol);
  body = replaceBodySection(body, "核心知识点", keyPoints.map((item) => "- " + item), parts.eol);
  body = replaceBodySection(body, "可应用于", suggestedUses.map((item) => "- " + item), parts.eol);
  body = body.split(/\r?\n/u).map((line) => /^- 标签：/u.test(line)
    ? "- 标签：" + (tags.map((tag) => "#" + tag).join(" ") || "无")
    : /^- 别名：/u.test(line) ? "- 别名：" + (aliases.join("、") || "无") : line).join(parts.eol);
  const content = parts.opening + frontmatter + parts.closing + body;
  const verified = readKnowledgeManifest({ path, content });
  if (!verified || verified.content !== manifest.content
    || verified.source.messageId !== manifest.source.messageId
    || verified.source.conversationPath !== manifest.source.conversationPath
    || verified.summary !== summary) {
    fail("语义整理结果未通过原文、来源与派生字段一致性校验");
  }
  return Object.freeze({ operation: "replace", path, content, expectedHash: suggestion.beforeHash });
}

module.exports = { materializeSemanticEnrichment };

