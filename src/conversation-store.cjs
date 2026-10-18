const crypto = require("node:crypto");
// ---------------------------------------------------------------- 归档可读命名与解析层
// 文件分工（方案 §2）：
//   - 只把「总账可读视图」<日期>-<标题>.md 用于展示；
//   - ID 到文件的映射一律按扩展名区分，避免 .jsonl 与 .md 互串。
// 稳定 ID 始终以 frontmatter / 首行 conversationId 为真源，文件名只是展示。
const xzNodeFs = require("node:fs");
const xzNodePath = require("node:path");
const XZ_TRANSCRIPT_DIR = "11_证据与来源/对话与访谈/行知对话";
const XZ_LEDGER_DIR = "11_证据与来源/对话与访谈/行知对话总账";
const XZ_SCAN_TTL_MS = 1_000;
const XZ_HEAD_BYTES = 512;
const xzScanCache = new Map();
const xzIdMapCache = new Map();
const xzIdConflictCache = new Map();
const xzIdConflictFilesCache = new Map();
function xzVaultBasePath() {
  try {
    const adapter = globalThis.app?.vault?.adapter;
    let base = typeof adapter?.basePath === "string" ? adapter.basePath : "";
    if (!base && typeof adapter?.getBasePath === "function") base = adapter.getBasePath();
    return typeof base === "string" ? base : "";
  } catch { return ""; }
}
function xzArchiveNames(relativeDir) {
  const base = xzVaultBasePath();
  if (!base) return null;
  const now = Date.now();
  const cached = xzScanCache.get(relativeDir);
  if (cached && now - cached.at < XZ_SCAN_TTL_MS) return cached.names;
  let names = null;
  try { names = xzNodeFs.readdirSync(xzNodePath.join(base, ...relativeDir.split("/"))); }
  catch { names = null; }
  xzScanCache.set(relativeDir, { at: now, names });
  return names;
}
// 按「目录 + 扩展名」建立 id -> 文件名 映射；同一 ID 命中多份时记入冲突集合
function xzArchiveIdMap(relativeDir, extension) {
  const base = xzVaultBasePath();
  if (!base) return null;
  const key = relativeDir + "|" + extension;
  const now = Date.now();
  const cached = xzIdMapCache.get(key);
  if (cached && now - cached.at < XZ_SCAN_TTL_MS) return cached.map;
  const names = xzArchiveNames(relativeDir);
  if (!Array.isArray(names)) return null;
  const dir = xzNodePath.join(base, ...relativeDir.split("/"));
  const map = new Map();
  const conflictFiles = new Map();
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    let head = "";
    try {
      const fd = xzNodeFs.openSync(xzNodePath.join(dir, name), "r");
      try {
        const buf = Buffer.alloc(XZ_HEAD_BYTES);
        const read = xzNodeFs.readSync(fd, buf, 0, XZ_HEAD_BYTES, 0);
        head = buf.slice(0, read).toString("utf8");
      } finally { xzNodeFs.closeSync(fd); }
    } catch { continue; }
    const m = head.match(/conversationId["\s:]+"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u);
    if (!m) continue;
    if (map.has(m[1])) {
      const files = conflictFiles.get(m[1]) || [map.get(m[1])];
      files.push(name);
      conflictFiles.set(m[1], files);
    } else map.set(m[1], name);
  }
  xzIdMapCache.set(key, { at: now, map });
  xzIdConflictCache.set(key, new Set(conflictFiles.keys()));
  xzIdConflictFilesCache.set(key, conflictFiles);
  return map;
}
function xzInvalidateArchiveCache(relativeDir, extension) {
  const key = relativeDir + "|" + extension;
  xzScanCache.delete(relativeDir);
  xzIdMapCache.delete(key);
  xzIdConflictCache.delete(key);
  xzIdConflictFilesCache.delete(key);
}
function xzRememberArchive(relativeDir, id, extension, name) {
  const cached = xzScanCache.get(relativeDir);
  if (cached && Array.isArray(cached.names) && !cached.names.includes(name)) cached.names.push(name);
  const key = relativeDir + "|" + extension;
  const m = xzIdMapCache.get(key);
  if (m && m.map && id && !m.map.has(id)) m.map.set(id, name);
}
function xzSafeTitlePart(title) {
  return String(title || "")
    .replace(/[\\/:*?"<>|#^\[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 20)
    .replace(/[、，,。.：:；;…\-—\s]+$/u, "")
    .trim();
}
// 命名规则（方案 §3）：<日期>-<标题>；无可用标题时退回「新对话-<日期>」
function xzReadableStem(id, conversation) {
  const rawTitle = typeof conversation?.title === "string" ? conversation.title.trim() : "";
  const stampSource = String(conversation?.createdAt || conversation?.updatedAt || "");
  const stamp = /^\d{4}-\d{2}-\d{2}/u.test(stampSource) ? stampSource.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const title = xzSafeTitlePart(rawTitle);
  if (!title || title === "新对话") return `新对话-${stamp}`;
  return `${stamp}-${title}`;
}
function xzResolveArchivePath(relativeDir, id, extension, conversation) {
  // ① 按 frontmatter / 首行的 conversationId 精确定位（仅限同扩展名）
  let map = xzArchiveIdMap(relativeDir, extension);
  if (map) {
    const key = relativeDir + "|" + extension;
    let conflicts = xzIdConflictCache.get(key);
    if (conflicts && conflicts.has(id)) {
      xzInvalidateArchiveCache(relativeDir, extension);
      map = xzArchiveIdMap(relativeDir, extension);
      conflicts = xzIdConflictCache.get(key);
      if (conflicts && conflicts.has(id)) {
        const files = xzIdConflictFilesCache.get(key)?.get(id) || [];
        throw new Error(`归档冲突：目录「${relativeDir}」中扩展名「${extension}」的 conversationId「${id}」对应多个文件：${files.join("、") || "文件名无法读取"}。已停止写入以避免覆盖；请核对这些文件后重试。`);
      }
    }
    const hit = map?.get(id);
    if (hit) return `${relativeDir}/${hit}`;
  }
  // ② 兜底：历史命名
  const names = xzArchiveNames(relativeDir);
  if (Array.isArray(names)) {
    const exact = `${id}${extension}`;
    if (names.includes(exact)) return `${relativeDir}/${exact}`;
    const compact = id.replace(/-/gu, "");
    const suffixes = [`-${id}${extension}`, `-${compact.slice(0, 12)}${extension}`, `-${compact.slice(0, 8)}${extension}`];
    const matched = names.find((name) => name.endsWith(extension) && suffixes.some((s) => name.endsWith(s)));
    if (matched) return `${relativeDir}/${matched}`;
  }
  // ③ 新建：<日期>-<标题>，重名追加 -2/-3（不追加 UUID）
  const stem = conversation ? xzReadableStem(id, conversation) : id;
  let name = `${stem}${extension}`;
  if (Array.isArray(names)) {
    let n = 1;
    while (names.includes(name)) { n += 1; name = `${stem}-${n}${extension}`; }
  }
  xzRememberArchive(relativeDir, id, extension, name);
  return `${relativeDir}/${name}`;
}
function xzConversationTranscriptPath(conversationId, conversation) {
  const id = requireText(conversationId, "对话编号", 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("对话编号格式不正确");
  return xzResolveArchivePath(XZ_TRANSCRIPT_DIR, id, ".md", conversation);
}
function xzConversationLedgerPath(conversationId, conversation) {
  const id = String(conversationId || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("对话编号格式不正确");
  return xzResolveArchivePath(XZ_LEDGER_DIR, id, ".jsonl", conversation);
}
function xzConversationLedgerViewPath(conversationId, conversation) {
  const id = String(conversationId || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("对话编号格式不正确");
  return xzResolveArchivePath(XZ_LEDGER_DIR, id, ".md", conversation);
}
globalThis.__xzArchive = Object.freeze({
  transcript: xzConversationTranscriptPath,
  ledger: xzConversationLedgerPath,
  ledgerView: xzConversationLedgerViewPath,
  transcriptDir: XZ_TRANSCRIPT_DIR,
  ledgerDir: XZ_LEDGER_DIR,
});

const MAX_MESSAGE_LENGTH = 200_000;
const MAX_TITLE_LENGTH = 32;
const MAX_MANUAL_TITLE_LENGTH = 64;
const ROLES = new Set(["user", "assistant"]);

function requireText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  if (value.length > maximum) throw new Error(`${label}超过安全上限`);
  return value.trim();
}

function createMessage(input = {}) {
  if (!ROLES.has(input.role)) throw new Error("不支持的消息角色");
  const createdAt = input.createdAt || new Date().toISOString();
  const status = input.status || "completed";
  if (!new Set(["streaming", "completed", "failed", "interrupted"]).has(status)) {
    throw new Error("不支持的消息状态");
  }
  return {
    id: input.id || crypto.randomUUID(),
    role: input.role,
    content: requireText(input.content, "消息内容", MAX_MESSAGE_LENGTH),
    status,
    createdAt,
    completedAt: status === "streaming" ? null : (input.completedAt || createdAt),
    error: input.error ? String(input.error).slice(0, 2_000) : null,
    workRunId: input.workRunId || null,
  };
}

function conversationTranscriptPath(conversationId, conversation = null) {
  return xzConversationTranscriptPath(conversationId, conversation);
}

function yamlString(value) {
  return `"${String(value ?? "").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r?\n/gu, "\\n")}"`;
}

function roleLabel(role) {
  return role === "user" ? "用户" : "行知";
}

function safeBlockId(id) {
  const value = requireText(id, "消息编号", 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value)) throw new Error("消息编号格式不正确");
  return value;
}

function messageMarkdown(message) {
  const validated = createMessage(message);
  return [
    `## ${roleLabel(validated.role)} · ${validated.createdAt}`,
    "",
    `${validated.content} ^${safeBlockId(validated.id)}`,
    "",
  ].join("\n");
}

function buildConversationTranscript(conversation) {
  const id = requireText(conversation?.id, "对话编号", 100);
  conversationTranscriptPath(id);
  const title = requireText(conversation?.title, "对话标题", 160);
  const createdAt = conversation.createdAt || new Date().toISOString();
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  return [
    "---",
    `conversationId: ${yamlString(id)}`,
    `标题: ${yamlString(title)}`,
    `创建时间: ${yamlString(createdAt)}`,
    "类型: 行知对话原始记录",
    "---",
    "",
    `# ${title}`,
    "",
    "> 本文件保存原始对话来源。知识结论需另行经过认识状态、冲突与权限校验。",
    "",
    ...messages.map(messageMarkdown),
  ].join("\n");
}

function appendConversationMessage(markdown, message) {
  if (typeof markdown !== "string") throw new Error("对话记录必须是文本");
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  return `${markdown}${separator}${messageMarkdown(message)}`;
}

function replaceConversationMessage(markdown, previousMessage, nextMessage) {
  if (typeof markdown !== "string") throw new Error("对话记录必须是文本");
  const previous = createMessage(previousMessage);
  const next = createMessage(nextMessage);
  if (safeBlockId(previous.id) !== safeBlockId(next.id) || previous.role !== next.role) {
    throw new Error("只能更新同一条对话消息");
  }
  const header = `## ${roleLabel(previous.role)} · ${previous.createdAt}`;
  const marker = `^${safeBlockId(previous.id)}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0 || markdown.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error("对话记录中的消息定位不唯一");
  }
  const headerIndex = markdown.lastIndexOf(header, markerIndex);
  if (headerIndex < 0) throw new Error("对话记录中的消息标题缺失");
  const headerPrefixValid = headerIndex === 0 || markdown[headerIndex - 1] === "\n";
  const expectedBodyStart = headerIndex + header.length;
  if (!headerPrefixValid || !/^\r?\n\r?\n/u.test(markdown.slice(expectedBodyStart))) {
    throw new Error("对话记录中的消息结构不完整");
  }
  let sectionEnd = markerIndex + marker.length;
  const trailingNewline = markdown.slice(sectionEnd).match(/^(?:\r\n|\n|\r)/u);
  if (trailingNewline) sectionEnd += trailingNewline[0].length;
  return `${markdown.slice(0, headerIndex)}${messageMarkdown(next)}${markdown.slice(sectionEnd)}`;
}

function archiveTag(value) {
  return String(value || "")
    .trim()
    .replace(/^#+/u, "")
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 32);
}

function updateConversationArchiveMetadata(markdown, conversation) {
  if (typeof markdown !== "string") throw new Error("对话记录必须是文本");
  const id = requireText(conversation?.id, "对话编号", 100);
  conversationTranscriptPath(id);
  if (!markdown.includes(`conversationId: ${yamlString(id)}`)) {
    throw new Error("对话记录不属于目标对话");
  }
  const archivedAt = requireText(conversation?.archivedAt, "归档时间", 100);
  if (Number.isNaN(Date.parse(archivedAt))) throw new Error("归档时间格式不正确");
  const summary = requireText(conversation?.archiveSummary || "对话已完成归档整理", "归档摘要", 1_000);
  const tags = [...new Set((Array.isArray(conversation?.archiveTags) ? conversation.archiveTags : [])
    .map(archiveTag)
    .filter(Boolean))].slice(0, 12);
  const startMarker = "<!-- xingzhi-archive:start -->";
  const endMarker = "<!-- xingzhi-archive:end -->";
  const block = [
    startMarker,
    "## 归档信息",
    "",
    `归档时间：${archivedAt}`,
    "",
    `归档摘要：${summary}`,
    "",
    `归档标签：${tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "（无）"}`,
    endMarker,
  ].join("\n");
  const start = markdown.indexOf(startMarker);
  if (start >= 0) {
    const end = markdown.indexOf(endMarker, start);
    if (end < 0) throw new Error("归档元数据标记不完整");
    return `${markdown.slice(0, start)}${block}${markdown.slice(end + endMarker.length)}`;
  }
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  return `${markdown}${separator}${block}\n`;
}

function updateConversationContextMetadata(markdown, conversation) {
  if (typeof markdown !== "string") throw new Error("对话记录必须是文本");
  const id = requireText(conversation?.id, "对话编号", 100);
  conversationTranscriptPath(id);
  if (!markdown.includes(`conversationId: ${yamlString(id)}`)) {
    throw new Error("对话记录不属于目标对话");
  }
  const context = conversation?.contextArchive;
  if (!context || typeof context !== "object" || Array.isArray(context)) return markdown;
  const updatedAt = requireText(context.updatedAt, "上下文整理时间", 100);
  if (Number.isNaN(Date.parse(updatedAt))) throw new Error("上下文整理时间格式不正确");
  const throughMessageId = safeBlockId(context.throughMessageId);
  const archivedMessageCount = Number(context.archivedMessageCount);
  const segmentCount = Number(context.segmentCount);
  if (!Number.isInteger(archivedMessageCount) || archivedMessageCount < 1
    || !Number.isInteger(segmentCount) || segmentCount < 1) {
    throw new Error("上下文整理计数不正确");
  }
  const startMarker = "<!-- xingzhi-context-archive:start -->";
  const endMarker = "<!-- xingzhi-context-archive:end -->";
  const summary = requireText(context.summary, "上下文整理摘要", 32_000)
    .replaceAll(startMarker, "（上下文整理起始标记）")
    .replaceAll(endMarker, "（上下文整理结束标记）");
  const block = [
    startMarker,
    "## 自动上下文整理索引",
    "",
    `最近整理时间：${updatedAt}`,
    "",
    `上下文整理截止消息：[[#^${throughMessageId}|${throughMessageId}]]`,
    "",
    `已整理消息数：${archivedMessageCount}`,
    "",
    `整理段数：${segmentCount}`,
    "",
    `上下文整理摘要：${summary}`,
    "",
    "> 原始消息仍完整保存在本文件；此摘要只用于缩短模型上下文，不替代原始证据。",
    endMarker,
  ].join("\n");
  const start = markdown.indexOf(startMarker);
  if (start >= 0) {
    const end = markdown.indexOf(endMarker, start);
    if (end < 0) throw new Error("上下文整理元数据标记不完整");
    return `${markdown.slice(0, start)}${block}${markdown.slice(end + endMarker.length)}`;
  }
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  return `${markdown}${separator}${block}\n`;
}

function summarizeConversationTitle(input) {
  const normalized = String(input || "").trim().replace(/\s+/gu, " ");
  if (!normalized) return "新对话";
  const firstClause = normalized.split(/[。！？!?；;\n]/u)[0].trim();
  return [...(firstClause || normalized)].slice(0, MAX_TITLE_LENGTH).join("") || "新对话";
}

function normalizeConversationTitle(input) {
  const title = String(input || "").trim().replace(/\s+/gu, " ");
  if (!title) throw new Error("对话标题不能为空");
  if ([...title].length > MAX_MANUAL_TITLE_LENGTH) {
    throw new Error(`对话标题最多 ${MAX_MANUAL_TITLE_LENGTH} 个字符`);
  }
  return title;
}

function updateConversationTitleMetadata(markdown, conversation) {
  if (typeof markdown !== "string") throw new Error("对话记录必须是文本");
  const id = requireText(conversation?.id, "对话编号", 100);
  conversationTranscriptPath(id);
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
  if (!frontmatterMatch) throw new Error("对话记录标题结构不完整");
  const frontmatter = frontmatterMatch[1];
  if (!frontmatter.split(/\r?\n/u).includes(`conversationId: ${yamlString(id)}`)) {
    throw new Error("对话记录不属于目标对话");
  }
  const title = normalizeConversationTitle(conversation?.title);
  const titleField = /^标题: .*$/mu;
  if (!titleField.test(frontmatter)) {
    throw new Error("对话记录标题结构不完整");
  }
  const updatedFrontmatter = frontmatter.replace(titleField, `标题: ${yamlString(title)}`);
  const body = markdown.slice(frontmatterMatch[0].length);
  const headingMatch = body.match(/^(\r?\n)?# [^\r\n]*/u);
  if (!headingMatch) throw new Error("对话记录标题结构不完整");
  const headingPrefix = headingMatch[1] || "";
  const updatedBody = body.replace(/^(\r?\n)?# [^\r\n]*/u, `${headingPrefix}# ${title}`);
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  return `---${newline}${updatedFrontmatter}${newline}---${newline}${updatedBody}`;
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  appendConversationMessage,
  buildConversationTranscript,
  conversationTranscriptPath,
  createMessage,
  normalizeConversationTitle,
  replaceConversationMessage,
  summarizeConversationTitle,
  updateConversationArchiveMetadata,
  updateConversationContextMetadata,
  updateConversationTitleMetadata,
};
