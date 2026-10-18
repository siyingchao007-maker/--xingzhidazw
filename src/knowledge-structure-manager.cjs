"use strict";

const crypto = require("node:crypto");
const { hashContent, validateVaultMarkdownPath } = require("./knowledge-writer.cjs");
const {
  deriveKnowledgeCardPresentation,
  isStructuralKnowledge,
} = require("./knowledge-card-presentation.cjs");

const ALLOWED_STRUCTURE_ROOTS = Object.freeze([
  "01_当前的我",
  "02_我的历史",
  "03_环境",
  "04_关系",
  "05_目标与项目",
  "06_判断与决策",
  "07_行动",
  "08_结果与反馈",
  "09_认知资产",
  "11_证据与来源",
]);
const ALLOWED_ROOT_SET = new Set(ALLOWED_STRUCTURE_ROOTS);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/u;
const FORMAL_MARKER = /^---\r?\nxingzhiFormat:\s*(?:"knowledge-v1"|knowledge-v1)\s*\r?\n/u;
const MAX_NOTES = 5_000;
const MAX_SUGGESTIONS = 500;
const CONTROLLED_RELATIONS = new Set(["客户", "合作伙伴", "同事", "上级", "下属", "朋友", "家人"]);
const TEMPLATES_BY_KIND = Object.freeze({
  folder: new Set(["index"]),
  note: new Set(["generic", "company", "person", "relationship", "project"]),
  list: new Set(["generic-list", "company-list", "person-list", "project-list"]),
});

function structureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertRoot(root) {
  const normalized = String(root || "").normalize("NFC").trim();
  if (!ALLOWED_ROOT_SET.has(normalized)) {
    throw structureError("UNSAFE_ROOT", "只能在 01 至 09 或 11 的正式知识根目录中创建内容。");
  }
  return normalized;
}

function safeSegment(value, label = "名称") {
  const segment = String(value || "").normalize("NFC").trim();
  if (!segment || segment === "." || segment === ".." || segment.length > 120
    || WINDOWS_INVALID.test(segment) || WINDOWS_RESERVED.test(segment)
    || /[. ]$/u.test(segment) || segment.includes("..")) {
    throw structureError("UNSAFE_NAME", `${label}包含危险路径或 Windows 不允许的名称。`);
  }
  return segment;
}

function safeFolderPath(value) {
  const text = String(value || "").normalize("NFC").trim();
  if (!text) return "";
  if (text.includes("\\") || text.startsWith("/") || /^[a-z]:/iu.test(text)) {
    throw structureError("UNSAFE_PATH", "文件夹路径必须是知识库内的相对路径。");
  }
  const segments = text.split("/");
  if (segments.length > 4) throw structureError("UNSAFE_PATH", "文件夹层级超过安全上限。");
  return segments.map((segment) => safeSegment(segment, "文件夹名称")).join("/");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function uniqueStrings(values, maximum = 30) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").normalize("NFC").trim();
    if (!text || text.length > 160 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maximum) break;
  }
  return result;
}

function stablePersonId(name) {
  const normalized = String(name || "").normalize("NFKC").trim().toLowerCase();
  if (!normalized) throw structureError("INVALID_PERSON", "人物名称不能为空。");
  return `person-${crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
}

function structureFrontmatter({ title, template, tags, now }) {
  return [
    "---",
    'xingzhiFormat: "structure-v1"',
    `title: ${yamlString(title)}`,
    `template: ${yamlString(template)}`,
    `tags: ${JSON.stringify(uniqueStrings(tags))}`,
    "aliases: []",
    "relatedKnowledge: []",
    `createdAt: ${yamlString(now)}`,
    `updatedAt: ${yamlString(now)}`,
    "---",
  ];
}

function tableCell(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim().slice(0, 300);
}

function tableFor(template, entries = []) {
  if (template === "person-list") {
    return [
      "| 姓名 | 公司 | 角色 | 关系状态 | 最近联系 | 关联笔记 |",
      "|---|---|---|---|---|---|",
      "|  |  |  |  |  |  |",
    ];
  }
  if (template === "company-list") {
    return [
      "| 公司 | 行业 | 合作状态 | 关键人物 | 最近进展 | 关联笔记 |",
      "|---|---|---|---|---|---|",
      "|  |  |  |  |  |  |",
    ];
  }
  if (template === "project-list") {
    return [
      "| 项目 | 阶段 | 负责人 | 下一步 | 截止时间 | 关联笔记 |",
      "|---|---|---|---|---|---|",
      "|  |  |  |  |  |  |",
    ];
  }
  const table = [
    "| 名称 | 类型 | 状态 | 标签 | 关联 | 更新时间 |",
    "|---|---|---|---|---|---|",
  ];
  if (!entries.length) return [...table, "|  |  |  |  |  |  |"];
  for (const entry of entries) {
    const link = `[[${entry.path.replace(/\.md$/iu, "")}|${tableCell(entry.title)}]]`;
    table.push(`| ${link} | ${tableCell(entry.type)} | ${tableCell(entry.status)} | ${tableCell(entry.tags.join("、"))} | ${entry.relations.length} | ${tableCell(entry.updatedAt)} |`);
  }
  return table;
}

function noteSections(template, title) {
  if (template === "company") {
    return [
      `公司名称：${title}`,
      "",
      "## 公司概况",
      "",
      "- 行业：",
      "- 地区：",
      "- 合作状态：",
      "",
      "## 业务信息",
      "",
      "| 事项 | 当前信息 | 证据或来源 | 更新时间 |",
      "|---|---|---|---|",
      "|  |  |  |  |",
      "",
      "## 联系人与关系",
      "",
      "| 人物 | 角色 | 已确认关系 | 最近事件 | 关联笔记 |",
      "|---|---|---|---|---|",
      "|  |  |  |  |  |",
      "",
      "## 证据与来源",
      "",
      "- ",
      "",
      "## 待确认",
      "",
      "- ",
    ];
  }
  if (template === "person") {
    return [
      `人物：${title}`,
      "",
      "## 基本信息",
      "",
      "- 公司：",
      "- 角色：",
      "",
      "## 已确认的关系事件",
      "",
      "| 日期 | 事件 | 来源 | 对当前判断的影响 |",
      "|---|---|---|---|",
      "|  |  |  |  |",
      "",
      "## 边界与未知",
      "",
      "- 不推断未被证据支持的动机或人格。",
    ];
  }
  if (template === "relationship") {
    return [
      "## 关系主体",
      "",
      "- 人物：",
      "- 公司：",
      "- 关系：",
      "",
      "## 已发生事件",
      "",
      "| 日期 | 可核验事件 | 来源 | 影响 |",
      "|---|---|---|---|",
      "|  |  |  |  |",
      "",
      "## 推断与未知",
      "",
      "- ",
    ];
  }
  if (template === "project") {
    return [
      "## 项目目标",
      "",
      "- ",
      "",
      "## 当前阶段",
      "",
      "- ",
      "",
      "## 行动清单",
      "",
      "| 行动 | 负责人 | 截止时间 | 状态 | 结果或证据 |",
      "|---|---|---|---|---|",
      "|  |  |  |  |  |",
      "",
      "## 风险与待确认",
      "",
      "- ",
    ];
  }
  return [
    "## 摘要",
    "",
    "- ",
    "",
    "## 详细内容",
    "",
    "",
    "## 关联与来源",
    "",
    "- ",
  ];
}

function buildStructureMarkdown({ title, template, kind, now, entries = [] }) {
  const tags = [];
  if (template === "company") tags.push(`实体/公司/${title}`);
  if (template === "person") tags.push(`实体/人物/${stablePersonId(title)}`);
  const lines = [
    ...structureFrontmatter({ title, template, tags, now }),
    "",
    `# ${title}`,
    "",
  ];
  if (kind === "folder" || kind === "list") {
    lines.push(
      kind === "folder" ? "此页是该文件夹的可见目录。新增内容后可在确认界面更新卡片和列表。" : "此页用于维护可点击的结构化列表。",
      "",
      ...tableFor(template, entries),
    );
  } else {
    lines.push(...noteSections(template, title));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildCreationPreview(input = {}, options = {}) {
  const root = assertRoot(input.root);
  const kind = String(input.kind || "note").trim();
  if (!new Set(["folder", "note", "list"]).has(kind)) {
    throw structureError("INVALID_KIND", "创建类型必须是文件夹、笔记或列表。");
  }
  const name = safeSegment(input.name, "名称");
  const folder = safeFolderPath(input.folder);
  const template = String(input.template || (kind === "folder" ? "index" : kind === "list" ? "generic-list" : "generic"));
  if (!TEMPLATES_BY_KIND[kind].has(template)) {
    throw structureError("INVALID_TEMPLATE", "所选模板不属于当前创建类型，已拒绝生成。");
  }
  const clock = typeof options.clock === "function" ? options.clock : () => new Date().toISOString();
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();
  const now = String(clock());
  const entries = [];
  if (kind === "list") {
    const candidates = Array.isArray(input.entries) ? input.entries : [];
    if (candidates.length > 200) throw structureError("ENTRY_LIMIT", "筛选列表单次最多写入 200 条知识。");
    for (const candidate of candidates) {
      const entryPath = validateVaultMarkdownPath(String(candidate?.path || ""));
      entries.push({
        path: entryPath,
        title: String(candidate?.title || fileTitle(entryPath)).slice(0, 200),
        type: String(candidate?.type || "note").slice(0, 80),
        status: String(candidate?.status || "").slice(0, 80),
        tags: uniqueStrings(candidate?.tags, 20),
        relations: Array.isArray(candidate?.relations) ? candidate.relations.slice(0, 30) : [],
        updatedAt: String(candidate?.updatedAt || "").slice(0, 80),
      });
    }
  }

  let path;
  let title = name;
  if (kind === "folder") {
    path = `${root}/${folder ? `${folder}/` : ""}${name}/${name}-索引.md`;
    title = `${name} · 索引`;
  } else if (kind === "list") {
    path = `${root}/${folder ? `${folder}/` : ""}${name}-列表.md`;
  } else {
    path = `${root}/${folder ? `${folder}/` : ""}${name}.md`;
  }
  validateVaultMarkdownPath(path);
  const content = buildStructureMarkdown({
    title: kind === "folder" ? name : title,
    template,
    kind,
    now,
    entries,
  });
  return Object.freeze({
    id: String(idFactory()),
    kind,
    root,
    name,
    folder,
    template,
    createdAt: now,
    changes: Object.freeze([Object.freeze({
      operation: "create",
      path,
      content,
      summary: kind === "folder" ? "创建文件夹索引" : kind === "list" ? "创建结构化列表" : "创建结构化笔记",
    })]),
  });
}

function splitFrontmatter(content) {
  const text = String(content || "").replace(/\r\n/gu, "\n");
  if (!text.startsWith("---\n")) return { fields: {}, body: text, raw: "" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0 || end > 32_000) return { fields: {}, body: text, raw: "" };
  const raw = text.slice(4, end);
  const fields = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || value.startsWith("[")) {
      try { value = JSON.parse(value); } catch { /* retain bounded plain text */ }
    }
    fields[match[1]] = value;
  }
  return { fields, body: text.slice(end + 5), raw };
}

function fileTitle(path) {
  return String(path || "").split("/").at(-1)?.replace(/\.md$/iu, "") || "未命名";
}

function scanKnowledgeCatalog(notes = []) {
  if (!Array.isArray(notes)) throw structureError("INVALID_NOTES", "目录扫描输入必须是笔记列表。");
  const cards = [];
  const structuralCards = [];
  const sourceCards = [];
  const ordinaryCards = [];
  for (const note of notes.slice(0, MAX_NOTES)) {
    if (!note || typeof note.path !== "string" || typeof note.content !== "string") continue;
    let safePath;
    try { safePath = validateVaultMarkdownPath(note.path); } catch { continue; }
    const { fields, body } = splitFrontmatter(note.content);
    const heading = body.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    const title = String(fields.title || fields["标题"] || heading || fileTitle(safePath)).slice(0, 200);
    const template = String(fields.template || "");
    const type = template || (/-索引\.md$/iu.test(safePath) ? "index" : /-列表\.md$/iu.test(safePath) ? "list" : String(fields.knowledgeType || "note"));
    const tags = uniqueStrings(Array.isArray(fields.tags) ? fields.tags : []);
    const aliases = uniqueStrings(Array.isArray(fields.aliases) ? fields.aliases : []);
    const relations = Array.isArray(fields.relatedKnowledge) ? fields.relatedKnowledge.slice(0, 30) : [];
    const format = String(fields.xingzhiFormat || "ordinary");
    const listField = (value) => Object.freeze(uniqueStrings(
      Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : [],
      12,
    ));
    const baseCard = {
      id: hashContent(safePath).slice(0, 16),
      path: safePath,
      title,
      type,
      format,
      knowledgeType: String(fields.knowledgeType || (template ? "" : type) || ""),
      epistemicStatus: String(fields.epistemicStatus || fields["认知状态"] || ""),
      status: String(fields.status || fields["状态"] || ""),
      supersedes: listField(fields.supersedes),
      supersededBy: listField(fields.supersededBy),
      createdAt: String(fields.createdAt || fields["创建时间"] || ""),
      tags: Object.freeze(tags),
      aliases: Object.freeze(aliases),
      relations: Object.freeze(relations.map((item) => typeof item === "object" && item ? { ...item } : item)),
      source: Object.freeze({
        conversationPath: String(fields.sourceConversationPath || ""),
        documents: Object.freeze(uniqueStrings(Array.isArray(fields.sourceDocuments) ? fields.sourceDocuments : [], 30)),
      }),
      updatedAt: String(fields.updatedAt || fields["更新时间"] || ""),
    };
    if (isStructuralKnowledge(baseCard)) {
      structuralCards.push(Object.freeze(baseCard));
      continue;
    }
    if (format !== "knowledge-v1") {
      const nonKnowledgeCard = Object.freeze({
        ...baseCard,
        kind: safePath.startsWith("11_证据与来源/") ? "raw-conversation" : "ordinary-note",
      });
      if (safePath.startsWith("11_证据与来源/")) sourceCards.push(nonKnowledgeCard);
      else ordinaryCards.push(nonKnowledgeCard);
      continue;
    }
    const presentation = deriveKnowledgeCardPresentation({
      title,
      type,
      content: typeof fields.content === "string" ? fields.content : "",
      summary: typeof fields.summary === "string" ? fields.summary : "",
      keyPoints: fields.keyPoints || fields.corePoints || [],
      suggestedUses: fields.suggestedUses || fields.applications || [],
      body,
      tags,
    });
    cards.push(Object.freeze({
      ...baseCard,
      excerpt: presentation.summary,
      ...presentation,
    }));
  }
  cards.sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.path.localeCompare(right.path, "zh-CN"));
  structuralCards.sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.path.localeCompare(right.path, "zh-CN"));
  sourceCards.sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.path.localeCompare(right.path, "zh-CN"));
  ordinaryCards.sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.path.localeCompare(right.path, "zh-CN"));
  return Object.freeze({
    presentationVersion: 2,
    generatedAt: new Date().toISOString(),
    cards: Object.freeze(cards),
    structuralCards: Object.freeze(structuralCards),
    sourceCards: Object.freeze(sourceCards),
    ordinaryCards: Object.freeze(ordinaryCards),
    table: Object.freeze({
      columns: Object.freeze(["名称", "类型", "路径", "标签", "关联", "更新时间"]),
      rows: Object.freeze(cards.map((card) => Object.freeze([
        card.title, card.type, card.path, card.tags.join("、"), String(card.relations.length), card.updatedAt,
      ]))),
    }),
  });
}

function cleanEntity(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[。；;，,]+$/u, "")
    .slice(0, 120);
  if (!text || text.includes("..") || /[\\/#[\]|{}<>\u0000-\u001f]/u.test(text)) return "";
  return text;
}

function explicitEntities(content) {
  const companies = [];
  const people = [];
  const relations = [];
  const relationshipTypes = [];
  const evidence = [];
  for (const rawLine of String(content || "").replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.trim().replace(/^[-*]\s*/u, "");
    let match = line.match(/^(?:公司|公司名称|企业名称)\s*[：:]\s*(.+)$/u);
    if (match) {
      const name = cleanEntity(match[1]);
      if (name) {
        companies.push(name);
        evidence.push(line);
      }
      continue;
    }
    match = line.match(/^(?:人物|姓名|联系人)\s*[：:]\s*(.+)$/u);
    if (match) {
      const name = cleanEntity(match[1]);
      if (name) {
        people.push(name);
        evidence.push(line);
      }
      continue;
    }
    match = line.match(/^关系\s*[：:]\s*(.+?)\s*(?:->|→)\s*(.+?)\s*[（(]([^）)]+)[）)]\s*$/u);
    if (match) {
      const from = cleanEntity(match[1]);
      const to = cleanEntity(match[2]);
      const relation = cleanEntity(match[3]);
      if (from && to && relation) {
        relations.push({ from, to, relation });
        evidence.push(line);
      }
      continue;
    }
    match = line.match(/^关系类型\s*[：:]\s*(.+)$/u);
    if (match) {
      const relationshipType = cleanEntity(match[1]);
      if (CONTROLLED_RELATIONS.has(relationshipType)) {
        relationshipTypes.push(relationshipType);
        evidence.push(line);
      }
    }
  }
  return {
    companies: uniqueStrings(companies, 20),
    people: uniqueStrings(people, 30).map((name) => ({ id: stablePersonId(name), name })),
    relations: relations.slice(0, 30),
    relationshipTypes: uniqueStrings(relationshipTypes, 10),
    evidence: uniqueStrings(evidence, 20),
  };
}

function buildEnrichmentPreview(notes = [], options = {}) {
  if (!Array.isArray(notes)) throw structureError("INVALID_NOTES", "智能整理输入必须是笔记列表。");
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();
  const catalog = scanKnowledgeCatalog(notes);
  const entityPaths = new Map();
  for (const card of [...catalog.cards, ...catalog.ordinaryCards]) {
    for (const name of [card.title, ...card.aliases]) {
      if (name && !entityPaths.has(name)) entityPaths.set(name, card.path);
    }
  }
  const suggestions = [];
  for (const note of notes.slice(0, MAX_NOTES)) {
    if (!note || typeof note.path !== "string" || typeof note.content !== "string"
      || !FORMAL_MARKER.test(note.content)) continue;
    let safePath;
    try { safePath = validateVaultMarkdownPath(note.path); } catch { continue; }
    const { fields } = splitFrontmatter(note.content);
    if (fields.xingzhiFormat !== "knowledge-v1") continue;
    const entities = explicitEntities(note.content);
    const currentTags = uniqueStrings(Array.isArray(fields.tags) ? fields.tags : []);
    const additions = uniqueStrings([
      ...entities.companies.map((name) => `实体/公司/${name}`),
      ...entities.people.map((person) => `实体/人物/${person.id}`),
      ...entities.relationshipTypes.map((relation) => `关系/${relation}`),
    ]).filter((tag) => !currentTags.includes(tag));
    const relatedKnowledge = [];
    for (const label of [...entities.companies, ...entities.people.map((person) => person.name)]) {
      const relatedPath = entityPaths.get(label);
      if (!relatedPath || relatedPath === safePath) continue;
      relatedKnowledge.push({ label, relation: "mentions", path: relatedPath, resolved: true });
    }
    if (!additions.length && !entities.relations.length && !relatedKnowledge.length) continue;
    suggestions.push(Object.freeze({
      id: hashContent(`${safePath}\n${hashContent(note.content)}`).slice(0, 20),
      path: safePath,
      beforeHash: hashContent(note.content),
      selected: true,
      reason: "只采用笔记中明确标注的公司、人物和关系字段；不推断动机或人格。",
      entities: Object.freeze({
        companies: Object.freeze([...entities.companies]),
        people: Object.freeze(entities.people.map((person) => Object.freeze({ ...person }))),
        relations: Object.freeze(entities.relations.map((relation) => Object.freeze({ ...relation }))),
        relationshipTypes: Object.freeze([...entities.relationshipTypes]),
      }),
      evidence: Object.freeze([...entities.evidence]),
      additions: Object.freeze({
        tags: Object.freeze(additions),
        relatedKnowledge: Object.freeze(relatedKnowledge.map((relation) => Object.freeze({ ...relation }))),
      }),
    }));
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return Object.freeze({
    id: String(idFactory()),
    createdAt: new Date().toISOString(),
    suggestions: Object.freeze(suggestions),
  });
}

function replaceJsonArrayField(content, field, additions) {
  const pattern = new RegExp(`^${field}:\\s*(\\[[^\\n]*\\])\\s*$`, "mu");
  const match = String(content).match(pattern);
  if (!match) throw structureError("UNSUPPORTED_FRONTMATTER", `笔记的 ${field} 字段不是可安全升级的单行数组。`);
  let current;
  try { current = JSON.parse(match[1]); } catch {
    throw structureError("UNSUPPORTED_FRONTMATTER", `笔记的 ${field} 字段格式已损坏。`);
  }
  if (!Array.isArray(current)) throw structureError("UNSUPPORTED_FRONTMATTER", `${field} 必须是数组。`);
  let next;
  if (field === "relatedKnowledge") {
    const seen = new Set();
    next = [];
    for (const item of [...current, ...additions]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const normalized = {
        label: String(item.label || "").slice(0, 160),
        relation: String(item.relation || "related").slice(0, 80),
        path: String(item.path || "").slice(0, 1_024),
        resolved: item.resolved === true,
      };
      const key = `${normalized.relation}\n${normalized.path}\n${normalized.label}`;
      if (!normalized.label || seen.has(key)) continue;
      seen.add(key);
      next.push(normalized);
      if (next.length >= 30) break;
    }
  } else {
    next = uniqueStrings([...current, ...additions]);
  }
  return String(content).replace(pattern, `${field}: ${JSON.stringify(next)}`);
}

function materializeEnrichment(note, suggestion) {
  if (!note || typeof note.path !== "string" || typeof note.content !== "string" || !suggestion) {
    throw structureError("INVALID_ENRICHMENT", "智能整理目标或建议不完整。");
  }
  const safePath = validateVaultMarkdownPath(note.path);
  if (safePath !== suggestion.path || hashContent(note.content) !== suggestion.beforeHash) {
    throw structureError("HASH_CONFLICT", "笔记在预览后发生变化，请重新扫描后再确认。");
  }
  if (!FORMAL_MARKER.test(note.content)) {
    throw structureError("UNSUPPORTED_FORMAT", "只有行知正式 knowledge-v1 笔记可以自动补充字段。");
  }
  let content = replaceJsonArrayField(note.content, "tags", suggestion.additions?.tags || []);
  content = replaceJsonArrayField(
    content,
    "relatedKnowledge",
    suggestion.additions?.relatedKnowledge || [],
  );
  return Object.freeze({
    operation: "replace",
    path: safePath,
    content,
    expectedHash: suggestion.beforeHash,
  });
}

module.exports = {
  ALLOWED_STRUCTURE_ROOTS,
  buildCreationPreview,
  buildEnrichmentPreview,
  materializeEnrichment,
  scanKnowledgeCatalog,
  stablePersonId,
};
