const crypto = require("node:crypto");

const ALLOWED_OPERATIONS = new Set(["create", "append"]);
const FORBIDDEN_ROOTS = new Set([".obsidian", ".git", "node_modules"]);
const MAX_CANDIDATE_CONTENT_LENGTH = 200_000;
const MAX_SEARCH_TOKENS = 96;
const SEARCH_STOP_WORDS = new Set([
  "以及", "有关", "相关", "包括", "进行", "检索", "用户", "知识", "正式", "获准",
  "优先", "重点", "返回", "保留", "来源", "根据", "不要", "只是", "可以", "请",
]);
const SEARCH_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh-CN", { granularity: "word" })
  : null;

function validateCandidatePayload(candidate) {
  if (!candidate || !ALLOWED_OPERATIONS.has(candidate.operation)) {
    throw new Error("第一版仅允许新建或追加内容");
  }
  if (typeof candidate.content !== "string" || candidate.content.trim() === "") {
    throw new Error("候选内容不能为空");
  }
  if (candidate.content.length > MAX_CANDIDATE_CONTENT_LENGTH) {
    throw new Error("候选内容不能超过 20 万个字符");
  }
  normalizeVaultPath(candidate.path);
}

function normalizeVaultPath(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("文件路径不能为空");
  }

  const normalized = input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("检测到不安全路径，已拒绝操作");
  }

  if (segments.length === 0) {
    throw new Error("文件路径不能为空");
  }

  if (FORBIDDEN_ROOTS.has(segments[0].toLowerCase())) {
    throw new Error("禁止写入知识库系统目录");
  }

  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("行知工作台只允许写入 Markdown 文件");
  }

  return segments.join("/");
}

function createWriteCandidate({ operation, path, content, observedMtime = null }) {
  const candidate = {
    id: crypto.randomUUID(),
    operation,
    path,
    content,
    observedMtime: Number.isFinite(observedMtime) ? observedMtime : null,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  validateCandidatePayload(candidate);
  candidate.path = normalizeVaultPath(path);
  return candidate;
}

function validateCandidateCommit(candidate, currentFile) {
  if (!candidate || candidate.status !== "pending") {
    throw new Error("只有待审核候选可以写入");
  }
  validateCandidatePayload(candidate);

  if (candidate.operation === "create" && currentFile.exists) {
    throw new Error("目标文件已经存在，请重新生成候选");
  }

  if (candidate.operation === "append") {
    if (!currentFile.exists) {
      throw new Error("准备追加的目标文件已不存在");
    }
    if (candidate.observedMtime !== currentFile.mtime) {
      throw new Error("目标文件在候选生成后已被修改，请重新预览");
    }
  }

  return true;
}

function yamlString(value) {
  return JSON.stringify(String(value).replaceAll("\r\n", "\n"));
}

function buildCaptureMarkdown({ title, body, category, createdAt = new Date() }) {
  const safeTitle = String(title || "未命名记录").trim() || "未命名记录";
  const safeBody = String(body || "").trim();
  const safeCategory = String(category || "个人表述").trim();
  const timestamp = createdAt.toISOString();

  return [
    "---",
    `标题: ${yamlString(safeTitle)}`,
    `创建时间: ${yamlString(timestamp)}`,
    `信息性质: ${safeCategory}`,
    "审核状态: 已确认",
    "来源: 行知工作台快速收集",
    "---",
    "",
    `# ${safeTitle}`,
    "",
    "## 原始内容",
    "",
    safeBody,
    "",
  ].join("\n");
}

function section(title, value, fallback = "未知") {
  return [`## ${title}`, "", String(value || "").trim() || fallback, ""].join("\n");
}

function buildDecisionMarkdown({
  question,
  facts,
  inferences,
  values,
  unknowns,
  counterEvidence,
  conclusion,
  confidence,
  reviewDate,
  createdAt = new Date(),
}) {
  const safeQuestion = String(question || "未命名判断").trim() || "未命名判断";
  return [
    "---",
    `标题: ${yamlString(safeQuestion)}`,
    `创建时间: ${yamlString(createdAt.toISOString())}`,
    "记录类型: 判断记录",
    `置信度: ${String(confidence || "未评估").trim()}`,
    `复查日期: ${yamlString(String(reviewDate || "待确定").trim())}`,
    "审核状态: 已确认",
    "来源: 行知工作台判断表单",
    "---",
    "",
    `# ${safeQuestion}`,
    "",
    section("待判断问题", safeQuestion),
    section("事实", facts),
    section("推断", inferences),
    section("价值判断", values),
    section("未知", unknowns),
    section("反证与改变条件", counterEvidence),
    section("当前结论", conclusion),
  ].join("\n");
}

function buildActionMarkdown({
  title,
  relatedDecision,
  nextAction,
  doneDefinition,
  dueDate,
  actualAction,
  observedResult,
  correction,
  createdAt = new Date(),
}) {
  const safeTitle = String(title || "未命名行动").trim() || "未命名行动";
  const actual = String(actualAction || "").trim() || "尚未执行";
  const result = String(observedResult || "").trim() || "未知";
  const isPending = actual === "尚未执行" && result === "未知";
  return [
    "---",
    `标题: ${yamlString(safeTitle)}`,
    `创建时间: ${yamlString(createdAt.toISOString())}`,
    "记录类型: 行动记录",
    `当前状态: ${isPending ? "待执行" : "待复盘"}`,
    `截止日期: ${yamlString(String(dueDate || "待确定").trim())}`,
    "审核状态: 已确认",
    "来源: 行知工作台行动表单",
    "---",
    "",
    `# ${safeTitle}`,
    "",
    section("关联判断", relatedDecision),
    section("计划的下一步", nextAction),
    section("完成标准", doneDefinition),
    section("实际行动", actual),
    section("可观察结果", result),
    section("校正", correction, "结果出现后再填写"),
  ].join("\n");
}

const MAX_SEARCH_QUERY_VARIANTS = 3;
const MAX_SEARCH_VARIANT_LENGTH = 200;
const MAX_SEARCH_DOCUMENT_CHARS = 12_000;
const RRF_K = 60;

function boundedSearchText(value, maximum = MAX_SEARCH_DOCUMENT_CHARS) {
  return normalizeSearchText(value).slice(0, maximum);
}

function noteSearchFields(note) {
  const basename = boundedSearchText(note?.basename, 500);
  const path = boundedSearchText(note?.path, 1_000);
  const summary = boundedSearchText(note?.summary, 2_000);
  const tags = boundedSearchText(Array.isArray(note?.tags) ? note.tags.join(" ") : note?.tags, 1_000);
  const aliases = boundedSearchText(Array.isArray(note?.aliases) ? note.aliases.join(" ") : note?.aliases, 1_000);
  const content = boundedSearchText(note?.content);
  return {
    basename,
    path,
    summary,
    tags,
    aliases,
    content,
    structural: `${basename} ${path} ${tags} ${aliases} ${summary}`,
  };
}

function scoreSearchFields(fields, tokens) {
  return tokens.reduce((score, token) => {
    let next = score;
    if (fields.basename.includes(token)) next += 12;
    if (fields.path.includes(token)) next += 5;
    if (fields.tags.includes(token) || fields.aliases.includes(token)) next += 7;
    if (fields.summary.includes(token)) next += 4;
    if (fields.content.includes(token)) next += 2;
    return next;
  }, 0);
}

function scoreNote(note, tokens) {
  return scoreSearchFields(noteSearchFields(note), tokens);
}

function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

function tokenizeSearchQuery(query) {
  const normalized = normalizeSearchText(query).trim();
  if (!normalized) return [];
  const tokens = [];
  const seen = new Set();
  const add = (candidate) => {
    const token = String(candidate || "").trim();
    if (token.length < 2 || token.length > 32 || SEARCH_STOP_WORDS.has(token) || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  const chunks = normalized
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

  for (const chunk of chunks) {
    add(chunk);
    if (!/\p{Script=Han}/u.test(chunk)) continue;
    if (SEARCH_SEGMENTER) {
      for (const item of SEARCH_SEGMENTER.segment(chunk)) {
        if (item.isWordLike) add(item.segment);
      }
    } else {
      for (const run of chunk.match(/\p{Script=Han}+/gu) || []) {
        if (run.length <= 8) add(run);
        for (let index = 0; index < run.length - 1; index += 1) {
          add(run.slice(index, index + 2));
          add(run.slice(index, index + 4));
        }
      }
    }
    if (tokens.length >= MAX_SEARCH_TOKENS) break;
  }

  return tokens.slice(0, MAX_SEARCH_TOKENS);
}

function normalizeQueryVariants(query, options = {}) {
  const primary = normalizeSearchText(query).trim().slice(0, MAX_SEARCH_VARIANT_LENGTH);
  const seen = new Set(primary ? [primary] : []);
  const variants = [];
  for (const raw of Array.isArray(options.queryVariants) ? options.queryVariants : []) {
    const variant = normalizeSearchText(raw).trim().slice(0, MAX_SEARCH_VARIANT_LENGTH);
    if (!variant || seen.has(variant)) continue;
    seen.add(variant);
    variants.push(variant);
    if (variants.length >= MAX_SEARCH_QUERY_VARIANTS) break;
  }
  return { primary, variants };
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 256);
}

function queryNgrams(value) {
  const compact = compactSearchText(value);
  const grams = [];
  const seen = new Set();
  for (let index = 0; index < compact.length - 1 && grams.length < 128; index += 1) {
    const gram = compact.slice(index, index + 2);
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(gram);
    }
  }
  return grams;
}

function fuzzyCoverageFromGrams(grams, document) {
  if (!grams.length) return 0;
  let matches = 0;
  for (const gram of grams) if (document.includes(gram)) matches += 1;
  return matches / grams.length;
}

function rankRows(rows, scoreKey) {
  return rows
    .filter((row) => row[scoreKey] > 0)
    .sort((left, right) => right[scoreKey] - left[scoreKey]
      || String(left.note?.path || "").localeCompare(String(right.note?.path || ""), "zh-CN"));
}

function hybridRankNotes(notes, query, limit = 30, options = {}) {
  const safeNotes = Array.isArray(notes) ? notes.slice(0, 5_000) : [];
  const safeLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 30));
  const { primary, variants } = normalizeQueryVariants(query, options);
  const primaryTokens = tokenizeSearchQuery(primary);
  const variantTokens = variants.map(tokenizeSearchQuery).filter((tokens) => tokens.length);
  const fuzzyQueries = [primary, ...variants].map(queryNgrams).filter((grams) => grams.length);
  const structuralTokens = [...primaryTokens, ...variantTokens.flat()].slice(0, MAX_SEARCH_TOKENS);
  if (!primaryTokens.length && !variantTokens.length) {
    return {
      results: [],
      diagnostics: {
        strategy: "hybrid-local-v1",
        queryVariantCount: variants.length,
        lexicalCandidateCount: 0,
        fuzzyCandidateCount: 0,
        structuralCandidateCount: 0,
        fusedCandidateCount: 0,
      },
    };
  }

  const rows = safeNotes.map((note, index) => {
    const fields = noteSearchFields(note);
    const lexicalScore = scoreSearchFields(fields, primaryTokens);
    const semanticScore = variantTokens.reduce(
      (best, tokens) => Math.max(best, scoreSearchFields(fields, tokens)),
      0,
    );
    const document = `${fields.basename} ${fields.path} ${fields.summary} ${fields.content}`;
    const compactDocument = compactSearchText(document);
    const fuzzyScore = fuzzyQueries.length
      ? Math.max(...fuzzyQueries.map((grams) => fuzzyCoverageFromGrams(grams, compactDocument)))
      : 0;
    const structuralScore = structuralTokens.reduce(
      (score, token) => score + (fields.structural.includes(token) ? 1 : 0),
      0,
    );
    return { note, index, fields, compactDocument, lexicalScore, semanticScore, fuzzyScore, structuralScore };
  });

  const rankings = [
    { signal: "lexical", weight: 1.2, rows: rankRows([...rows], "lexicalScore") },
    { signal: "semantic-variant", weight: 1, rows: rankRows([...rows], "semanticScore") },
    {
      signal: "fuzzy",
      weight: 0.85,
      rows: rankRows(rows.filter((row) => row.fuzzyScore >= 0.3), "fuzzyScore"),
    },
    { signal: "structure", weight: 0.65, rows: rankRows([...rows], "structuralScore") },
  ];
  const candidateWindow = Math.min(safeNotes.length, Math.max(50, safeLimit * 5));
  const fused = new Map();
  for (const ranking of rankings) {
    ranking.rows.slice(0, candidateWindow).forEach((row, rank) => {
      const key = String(row.note?.path || `note-${row.index}`);
      const current = fused.get(key) || { row, rrf: 0, signals: new Set() };
      current.rrf += ranking.weight / (RRF_K + rank + 1);
      current.signals.add(ranking.signal);
      fused.set(key, current);
    });
  }
  const compactPrimary = compactSearchText(primary);
  const results = [...fused.values()]
    .map(({ row, rrf, signals }) => {
      const exactPhrase = compactPrimary.length >= 2
        && row.compactDocument.includes(compactPrimary);
      return {
        ...row.note,
        score: Number((rrf * 1_000 + (exactPhrase ? 10 : 0) + row.fuzzyScore * 5).toFixed(3)),
        matchSignals: [...signals],
      };
    })
    .sort((left, right) => right.score - left.score
      || String(left.path || "").localeCompare(String(right.path || ""), "zh-CN"))
    .slice(0, safeLimit);
  return {
    results,
    diagnostics: {
      strategy: "hybrid-local-v1",
      queryVariantCount: variants.length,
      lexicalCandidateCount: rankings[0].rows.length,
      fuzzyCandidateCount: rankings[2].rows.length,
      structuralCandidateCount: rankings[3].rows.length,
      fusedCandidateCount: fused.size,
    },
  };
}

function rankNotes(notes, query, limit = 30, options = {}) {
  return hybridRankNotes(notes, query, limit, options).results;
}

function sanitizeFileName(input) {
  return String(input || "未命名记录")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .slice(0, 80) || "未命名记录";
}

function toLocalDateStamp(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  buildActionMarkdown,
  buildCaptureMarkdown,
  buildDecisionMarkdown,
  createWriteCandidate,
  hybridRankNotes,
  normalizeVaultPath,
  rankNotes,
  sanitizeFileName,
  toLocalDateStamp,
  validateCandidateCommit,
};
