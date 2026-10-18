"use strict";

const crypto = require("node:crypto");

const COMMAND_PATTERN = /^\/(?:删除\s*md|delete-md)(?:\s+|$)/iu;
const PROTECTED_ROOTS = new Set(["00_系统", "10_智能体与技能", "17_多Agent多视角系统"]);
const PROTECTED_PREFIXES = [
  "11_证据与来源/对话与访谈/行知对话/",
  "11_证据与来源/对话整理/",
];
const GLOB_PATTERN = /[*?\[\]{}]/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function stripMatchingQuotes(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'")))) return text.slice(1, -1).trim();
  return text;
}

function validateDirectMdDeletePath(value) {
  const raw = stripMatchingQuotes(value);
  if (!raw) throw new Error("删除命令缺少知识库内 Markdown 路径");
  if (raw.length > 500 || Buffer.byteLength(raw, "utf8") > 1_500 || CONTROL_PATTERN.test(raw)) {
    throw new Error("删除路径为空、过长或包含控制字符");
  }
  if (/^[A-Za-z]:[\\/]/u.test(raw) || /^[\\/]{1,2}/u.test(raw)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw) || raw.startsWith("~")) {
    throw new Error("删除命令只接受 Obsidian 知识库内的相对路径");
  }
  if (GLOB_PATTERN.test(raw)) throw new Error("删除命令不允许通配符或批量路径");
  if (/[\\/]$/u.test(raw)) throw new Error("删除命令不能删除目录");
  const normalized = raw.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.length < 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("删除路径必须是知识库内的完整文件相对路径");
  }
  if (segments.some((segment) => /[:<>|"`]/u.test(segment))) throw new Error("删除路径包含不允许的路径字符");
  const root = segments[0];
  if (root.startsWith(".") || PROTECTED_ROOTS.has(root)) {
    throw new Error(`该目录属于行知保护区，不能通过直接删除命令修改：${root}`);
  }
  if (PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error("该 Markdown 属于行知运行记录，请使用对应的对话管理功能删除");
  }
  if (!/\.md$/iu.test(segments.at(-1))) throw new Error("直接删除命令只允许删除单个 Markdown（.md）文件");
  return normalized;
}

function parseDirectMdDeleteCommand(value) {
  const text = String(value || "").trim();
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return { matched: false, path: null };
  return { matched: true, path: validateDirectMdDeletePath(text.slice(match[0].length)) };
}

function directMdDeleteAuditPath(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) throw new Error("文件删除审计时间无效");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `00_系统/运行记录/文件删除/${year}/${year}-${month}.md`;
}

function appendDirectMdDeleteAudit(existing, event = {}) {
  const timestamp = new Date(event.timestamp).toISOString();
  const path = validateDirectMdDeletePath(event.path);
  const outcome = event.outcome === "failed" ? "failed" : "trashed";
  const id = crypto.createHash("sha256").update(`${timestamp}\0${path}\0${outcome}`, "utf8").digest("hex").slice(0, 24);
  const marker = `<!-- xingzhi-direct-md-delete:${id} -->`;
  const current = String(existing || "");
  if (current.includes(marker)) return current;
  const header = current.trim() ? current.trimEnd() : [
    "---",
    "type: xingzhi-file-operation-audit",
    "protected: true",
    "---",
    "",
    "# Markdown 文件删除审计",
    "",
    "> 只记录目标路径、时间、结果和可恢复性，不保存被删除文件内容。",
  ].join("\n");
  return [
    header,
    "",
    `## ${timestamp.replace("T", " ").slice(0, 19)} · ${outcome === "trashed" ? "已移入回收站" : "删除失败"}`,
    "",
    `- 路径：\`${path}\``,
    `- 结果：${outcome}`,
    `- 可恢复：${outcome === "trashed" ? "是（系统回收站）" : "未发生删除"}`,
    ...(event.error ? [`- 错误：${String(event.error).replace(/[\r\n]+/gu, " ").slice(0, 300)}`] : []),
    "",
    marker,
    "",
  ].join("\n");
}

module.exports = {
  appendDirectMdDeleteAudit,
  directMdDeleteAuditPath,
  parseDirectMdDeleteCommand,
  validateDirectMdDeletePath,
};
