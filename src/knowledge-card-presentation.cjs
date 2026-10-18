"use strict";

const MAX_SUMMARY_CHARS = 220;
const MAX_POINT_CHARS = 150;
const MAX_POINTS = 4;
const MAX_USES = 3;
const METADATA_SECTION = /^(?:认识状态|分类与存放|标签与关联|来源与证据|检索(?:提示|方式)|调用方式|技术信息|系统信息|frontmatter|metadata|元数据)$/iu;
const METADATA_LINE = /^(?:类型|置信度|知识分类|写入目录|文件名|完整路径|标签|别名|来源对话|来源消息|文档证据|建议检索词|冲突校验键|保存位置|知识编号|knowledgeId|knowledgeType|epistemicStatus|status|key|title|content|updatedAt)\s*[：:]/iu;
const STRUCTURAL_TYPES = new Set([
  "index", "list", "folder", "template", "moc",
  "company-list", "person-list", "project-list", "custom-list", "generic-list",
]);
const RAW_SOURCE_MARKER = /(?:本文件保存原始对话来源|知识结论需另行经过认识状态|对话已直接归档，未执行知识整理|^##\s+(?:用户|行知)\s*·)/mu;
const TRANSCRIPT_TIMESTAMP_LINE = /(?:^|\n)\s*(?:[-*+]\s*)?(?:(?:\d{1,2}:)?[0-5]?\d):[0-5]\d(?=\D|$)/gu;
const TRANSCRIPT_TIMESTAMP_ANYWHERE = /(?<!\d)(?:(?:\d{1,2}:)?[0-5]?\d):[0-5]\d(?=\D|$)/gu;
const STARTS_WITH_TIMESTAMP = /^\s*(?:[-*+]\s*)?(?:(?:\d{1,2}:)?[0-5]?\d):[0-5]\d(?=\D|$)/u;
const RAW_PRESENTATION_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:用户|行知)\s*[·・]\s*\d{4}-\d{2}-\d{2}T|~msg-[a-z0-9-]{8,}|(?:^|\n)\s*(?:title|content|summary|keyPoints|suggestedUses)\s*:/iu;

function boundedText(value, maximum = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function uniqueText(values, maximum, itemMaximum) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = boundedText(value, itemMaximum).replace(/\s+/gu, " ");
    const key = text.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maximum) break;
  }
  return result;
}

function stripFrontmatter(value) {
  const text = String(value || "").replace(/\r\n?/gu, "\n").replace(/\\n/gu, "\n");
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end >= 0 && end <= 32_000 ? text.slice(end + 5) : text;
}

function cleanInlineMarkdown(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_~]+/gu, "")
    .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function knowledgeLines(value, title = "") {
  const lines = [];
  let fenced = false;
  const normalizedTitle = boundedText(title, 300);
  for (const raw of stripFrontmatter(value).split("\n")) {
    const trimmed = raw.trim();
    if (/^```/u.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed)?.[1]?.trim();
    if (heading && METADATA_SECTION.test(heading)) break;
    if (heading) continue;
    const withoutListMarker = trimmed.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/u, "");
    if (METADATA_LINE.test(withoutListMarker)) continue;
    const clean = cleanInlineMarkdown(withoutListMarker);
    if (!clean || clean === normalizedTitle || /^(?:无|暂无明确关联知识)$/u.test(clean)) continue;
    lines.push(clean);
  }
  return uniqueText(lines, 32, 1_000);
}

function sentenceParts(lines) {
  const parts = [];
  for (const line of lines) {
    const segments = line.replace(/([。！？；])/gu, "$1\n").split("\n");
    for (const segment of segments) {
      const clean = segment.trim();
      if (clean) parts.push(clean);
    }
  }
  return uniqueText(parts, 16, MAX_POINT_CHARS);
}

function trimAtBoundary(value, maximum) {
  const text = boundedText(value, 10_000);
  if (text.length <= maximum) return { text, truncated: false };
  const prefix = text.slice(0, maximum - 1);
  const boundary = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("；"), prefix.lastIndexOf("，"));
  const safe = boundary >= Math.floor(maximum * 0.58) ? prefix.slice(0, boundary + 1) : prefix;
  return { text: `${safe.trimEnd()}…`, truncated: true };
}

function defaultUses(type) {
  const normalized = boundedText(type, 100).toLowerCase();
  if (/(?:current|state|当前|self|profile|basic)/u.test(normalized)) {
    return ["核对当前状态", "为相关判断补充个人背景", "更新后对比状态变化"];
  }
  if (/(?:project|goal|plan|action|项目|目标|计划|行动)/u.test(normalized)) {
    return ["制定下一步行动", "检查目标与项目进展", "日常回顾时校准优先级"];
  }
  if (/(?:decision|judg|risk|判断|决策|风险)/u.test(normalized)) {
    return ["同类判断前复用依据", "复查关键假设与风险", "对照后续结果校准判断"];
  }
  if (/(?:result|feedback|复盘|结果|反馈)/u.test(normalized)) {
    return ["复盘结果与原计划偏差", "提炼可复用经验", "为下一轮行动提供反馈"];
  }
  if (/(?:relationship|person|company|environment|关系|人物|公司|环境)/u.test(normalized)) {
    return ["相关人物或组织分析", "补充现实环境背景", "核对关系与来源信息"];
  }
  if (/(?:cognitive|method|principle|认知|方法|原则)/u.test(normalized)) {
    return ["解决相似问题时复用", "形成判断框架", "在复盘中检验适用边界"];
  }
  if (/(?:evidence|source|证据|来源)/u.test(normalized)) {
    return ["核对事实来源", "支撑相关判断", "出现冲突时回看原始证据"];
  }
  return ["回答相关问题时作为背景资料", "进行判断前核对来源与适用条件"];
}

function isStructuralKnowledge(input = {}) {
  const type = boundedText(input.type || input.knowledgeType || input.template, 100).toLowerCase();
  const path = boundedText(input.path, 1_024).replaceAll("\\", "/");
  const filename = path.split("/").at(-1)?.toLowerCase() || "";
  return STRUCTURAL_TYPES.has(type)
    || /-索引\.md$/iu.test(filename)
    || /-列表\.md$/iu.test(filename)
    || /^(?:readme|moc|index|目录|索引|模板)(?:[-_. ].*)?\.md$/iu.test(filename);
}

function looksLikeRawSourceDump(input = {}) {
  const title = boundedText(input.title, 500);
  const content = boundedText(input.content, 200_000) || boundedText(input.body, 200_000);
  if (RAW_SOURCE_MARKER.test(`${title}\n${content}`)) return true;
  const combined = `${title}\n${content}`;
  const lineTimestamps = combined.match(TRANSCRIPT_TIMESTAMP_LINE) || [];
  if (lineTimestamps.length >= 3) return true;
  const inlineTimestamps = combined.match(TRANSCRIPT_TIMESTAMP_ANYWHERE) || [];
  return inlineTimestamps.length >= 3
    && (STARTS_WITH_TIMESTAMP.test(title) || STARTS_WITH_TIMESTAMP.test(content));
}

function isRawPresentationText(value, title = "") {
  const text = boundedText(value, 200_000);
  if (!text) return false;
  return RAW_PRESENTATION_MARKER.test(text)
    || looksLikeRawSourceDump({ title, content: text });
}

function presentationLines(value, title = "") {
  return isRawPresentationText(value, title) ? [] : knowledgeLines(value, title);
}

function deriveKnowledgeCardPresentation(input = {}) {
  const title = boundedText(input.title, 200) || "未命名知识";
  const explicitSummary = boundedText(input.summary, 4_000);
  const content = boundedText(input.content, 20_000);
  const fallbackBody = boundedText(input.body, 20_000);
  const explicitSummaryLines = presentationLines(explicitSummary, title);
  const explicitPoints = Array.isArray(input.keyPoints)
    ? presentationLines(input.keyPoints.join("\n"), title)
    : presentationLines(input.keyPoints, title);
  let contentLines = presentationLines(content, title);
  if (!contentLines.length && fallbackBody) contentLines = presentationLines(fallbackBody, title);
  const contentSentences = sentenceParts(contentLines);
  const sourceSummary = explicitSummaryLines.join(" ")
    || sentenceParts(explicitPoints).slice(0, 2).join("")
    || contentSentences.slice(0, 2).join("");
  const boundedSummary = trimAtBoundary(sourceSummary, MAX_SUMMARY_CHARS);
  const summaryState = boundedSummary.text ? "ready" : "needs-review";
  const summary = boundedSummary.text || "这条知识尚未形成可用摘要，请打开来源补充或重新整理。";
  const keyPoints = uniqueText(
    explicitPoints.length ? explicitPoints : contentSentences.length ? contentSentences : sentenceParts(explicitSummaryLines),
    MAX_POINTS,
    MAX_POINT_CHARS,
  );
  const presentationSource = summaryState === "needs-review"
    ? "needs-review"
    : explicitSummaryLines.length || explicitPoints.length
      ? "structured"
      : "derived";
  const suggestedUses = uniqueText(
    Array.isArray(input.suggestedUses) && input.suggestedUses.length
      ? input.suggestedUses.filter((value) => !isRawPresentationText(value, title))
      : defaultUses(input.type || input.knowledgeType),
    MAX_USES,
    100,
  );
  const tags = uniqueText(input.tags, 40, 120);
  return Object.freeze({
    summary,
    summaryState,
    presentationSource,
    summaryTruncated: boundedSummary.truncated,
    keyPoints: Object.freeze(keyPoints.length ? keyPoints : ["尚无可提炼的核心知识点，需打开原文补充整理。"]),
    suggestedUses: Object.freeze(suggestedUses),
    visibleTags: Object.freeze(tags.slice(0, 3)),
    tagOverflow: Math.max(0, tags.length - 3),
  });
}

module.exports = {
  deriveKnowledgeCardPresentation,
  isStructuralKnowledge,
  knowledgeLines,
  looksLikeRawSourceDump,
};
