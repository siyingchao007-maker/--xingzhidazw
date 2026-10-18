"use strict";

const crypto = require("node:crypto");
const { hashContent, validateVaultMarkdownPath } = require("./knowledge-writer.cjs");

const START_MARKER = "<!-- 行知自动索引：开始 -->";
const END_MARKER = "<!-- 行知自动索引：结束 -->";
const FORMAL_ROOTS = Object.freeze([
  "01_当前的我", "02_我的历史", "03_环境", "04_关系", "05_目标与项目",
  "06_判断与决策", "07_行动", "08_结果与反馈", "09_认知资产", "11_证据与来源", "12_资料库",
]);
const FORMAL_ROOT_SET = new Set(FORMAL_ROOTS);
const MAX_INDEX_NOTES = 200;
const MAX_INDEX_BYTES = 500_000;
const MAX_PREVIEWS = 10;

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function withoutMarkdown(path) {
  return String(path || "").replace(/\.md$/iu, "");
}

function inspectIndexMarkers(content) {
  const text = String(content || "");
  const starts = text.split(START_MARKER).length - 1;
  const ends = text.split(END_MARKER).length - 1;
  if (starts === 0 && ends === 0) return { state: "absent", start: -1, end: -1 };
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (starts !== 1 || ends !== 1 || start < 0 || end < start + START_MARKER.length) {
    return { state: "damaged", start, end };
  }
  return { state: "valid", start, end: end + END_MARKER.length };
}

function assertIndexPath(input) {
  const path = validateVaultMarkdownPath(input);
  const segments = path.split("/");
  if (segments.length < 3 || !FORMAL_ROOT_SET.has(segments[0])) {
    throw new Error("自动索引只允许修改正式知识根下与所在目录同名的索引");
  }
  const expected = `${segments.at(-2)}-索引.md`;
  if (segments.at(-1) !== expected) throw new Error("自动索引文件名与所在目录不一致");
  return path;
}

function assertKnowledgeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("知识索引条目无效");
  const path = validateVaultMarkdownPath(entry.path);
  const segments = path.split("/");
  if (segments.length < 3 || !FORMAL_ROOT_SET.has(segments[0]) || /-索引\.md$/iu.test(path)) {
    throw new Error("知识索引条目不在允许的正式目录中");
  }
  const title = String(entry.title || "").replace(/[\r\n|\[\]]+/gu, " ").trim().slice(0, 200);
  if (!title) throw new Error("知识索引标题不能为空");
  return {
    path,
    title,
    status: entry.reviewStatus === "candidate-review" ? "待审核"
      : String(entry.status || "active").replace(/[\r\n|]+/gu, " ").trim().slice(0, 40) || "active",
    updatedAt: String(entry.updatedAt || "").replace(/[\r\n|]+/gu, " ").trim().slice(0, 100),
  };
}

function statusLabel(status) {
  return ({ active: "有效", valid: "有效", pending: "待验证", historical: "已过期", superseded: "被替代", rejected: "已否定" })[status]
    || status;
}

function renderControlledBlock(entries) {
  const lines = [START_MARKER, "## 本目录知识", ""];
  if (!entries.length) lines.push("- 当前暂无行知正式知识。");
  else {
    for (const entry of entries) {
      const suffix = entry.updatedAt ? ` · ${entry.updatedAt}` : "";
      lines.push(`- [[${withoutMarkdown(entry.path)}|${entry.title}]] · ${statusLabel(entry.status)}${suffix}`);
    }
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

function replaceControlledBlock(content, entries) {
  const text = String(content || "");
  if (byteLength(text) > MAX_INDEX_BYTES) throw new Error("索引文件超过安全大小上限");
  const markers = inspectIndexMarkers(text);
  if (markers.state === "damaged") throw new Error("索引标记已损坏，已停止自动更新");
  const block = renderControlledBlock(entries);
  if (markers.state === "valid") return `${text.slice(0, markers.start)}${block}${text.slice(markers.end)}`;
  const separator = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

function stableEntries(entries) {
  return [...entries].sort((left, right) => (
    left.title.localeCompare(right.title, "zh-CN") || left.path.localeCompare(right.path, "zh-CN")
  ));
}

function clonePreview(preview) {
  return {
    id: preview.id,
    createdAt: preview.createdAt,
    changes: preview.changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      linkCount: change.links.length,
      links: change.links.map((item) => ({ ...item })),
    })),
  };
}

function createKnowledgeIndexer(options = {}) {
  const vault = options.vault;
  if (!vault || typeof vault.read !== "function" || typeof vault.exists !== "function") {
    throw new Error("知识索引器需要可读且可检查文件状态的 Vault 适配器");
  }
  const clock = typeof options.clock === "function" ? options.clock : () => new Date().toISOString();
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();
  const previews = new Map();

  function preview(input = {}) {
    const indexNotes = Array.isArray(input.indexNotes) ? input.indexNotes : [];
    const knowledge = Array.isArray(input.knowledge) ? input.knowledge.map(assertKnowledgeEntry) : [];
    if (indexNotes.length > MAX_INDEX_NOTES) throw new Error("索引文件数量超过安全预览上限");
    const groups = new Map();
    for (const item of knowledge) {
      const directory = item.path.split("/").slice(0, -1).join("/");
      if (!groups.has(directory)) groups.set(directory, []);
      groups.get(directory).push(item);
    }
    const seen = new Set();
    const changes = [];
    for (const note of indexNotes) {
      if (!note || typeof note.content !== "string") throw new Error("索引文件内容无效");
      const path = assertIndexPath(note.path);
      if (seen.has(path)) throw new Error("索引预览包含重复路径");
      seen.add(path);
      const directory = path.split("/").slice(0, -1).join("/");
      const links = stableEntries(groups.get(directory) || []);
      const nextContent = replaceControlledBlock(note.content, links);
      if (nextContent === note.content) continue;
      changes.push({
        operation: "replace",
        path,
        beforeHash: hashContent(note.content),
        afterHash: hashContent(nextContent),
        content: nextContent,
        links,
      });
    }
    for (const directory of groups.keys()) {
      const name = directory.split("/").at(-1);
      const expected = `${directory}/${name}-索引.md`;
      if (seen.has(expected)) continue;
      const indexPath = assertIndexPath(expected);
      const links = stableEntries(groups.get(directory) || []);
      const content = `# ${name}\n\n${renderControlledBlock(links)}\n`;
      changes.push({
        operation: "create",
        path: indexPath,
        beforeHash: null,
        afterHash: hashContent(content),
        content,
        links,
      });
    }
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
    const record = { id: String(idFactory()), createdAt: clock(), changes };
    if (!record.id.trim()) throw new Error("索引预览编号不能为空");
    previews.set(record.id, record);
    return clonePreview(record);
  }

  async function materialize(previewId) {
    const record = previews.get(String(previewId || ""));
    if (!record) throw new Error("找不到索引预览，可能已经使用或过期");
    for (const change of record.changes) {
      if (change.operation === "create") {
        if (await vault.exists(change.path)) throw new Error(`索引预览已经过期：${change.path}`);
        continue;
      }
      let current;
      try {
        current = await vault.read(change.path);
      } catch {
        throw new Error(`索引预览已经过期：${change.path}`);
      }
      if (hashContent(current) !== change.beforeHash) throw new Error(`索引预览已经过期：${change.path}`);
    }
    return record.changes.map((change) => (change.operation === "create"
      ? { operation: "create", path: change.path, content: change.content }
      : {
          operation: "replace",
          path: change.path,
          content: change.content,
          expectedHash: change.beforeHash,
        }));
  }

  function complete(previewId) {
    return previews.delete(String(previewId || ""));
  }

  return Object.freeze({ complete, materialize, preview });
}

module.exports = {
  END_MARKER,
  FORMAL_ROOTS,
  START_MARKER,
  createKnowledgeIndexer,
  inspectIndexMarkers,
  replaceControlledBlock,
};
