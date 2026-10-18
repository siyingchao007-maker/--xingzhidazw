"use strict";

const crypto = require("node:crypto");
const { validateVaultMarkdownPath } = require("./knowledge-writer.cjs");
const {
  deriveKnowledgeCardPresentation,
  looksLikeRawSourceDump,
} = require("./knowledge-card-presentation.cjs");
const {
  createReviewKnowledgeCheckpoint,
  normalizeReviewKnowledgeCheckpoint,
  buildReviewKnowledgeDelta,
} = require("./review-knowledge-delta.cjs");
const { buildReviewHistoryQuery } = require("./review-history.cjs");
const { normalizeReviewContextProfile } = require("./review-context-profile.cjs");

const DAILY_REVIEW_ROOTS = Object.freeze([
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
const DAILY_REVIEW_ROOT_SET = new Set(DAILY_REVIEW_ROOTS);
const PLAN_LEVELS = Object.freeze(["year", "month", "week", "day"]);
const PLAN_LEVEL_SET = new Set(PLAN_LEVELS);
const PLAN_STATUSES = new Set([
  "active", "completed", "blocked", "waiting", "not-started", "cancelled",
]);
const DECISION_STATES = new Set([
  "conflicted", "pending", "scheduled", "due", "overdue", "unscheduled", "reviewed", "corrected", "closed",
]);
const ACTIVE_ACTION_STATUSES = new Set(["pending", "in-progress", "waiting"]);
const MAX_REVIEW_NOTES = 2_000;
const MAX_REVIEW_ACTIONS = 2_000;
const MAX_NOTE_BYTES = 500_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_ITEMS = 50;
const MAX_TODAY_SUGGESTIONS = 5;
const MAX_DAILY_REVIEW_SNAPSHOTS = 30;
const MAX_SNAPSHOT_ITEMS = 12;
const MAX_FRONTMATTER_BYTES = 32_000;
const STALE_ACTION_MS = 3 * 24 * 60 * 60 * 1_000;

function boundedText(value, maximum, fallback = "") {
  const text = String(value ?? "").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, maximum);
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoOrNull(value) {
  return validDate(value)?.toISOString() || null;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function periodFor(nowValue) {
  const now = validDate(nowValue);
  if (!now) throw new Error("每日回顾时间无效");
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = addLocalDays(todayStart, -1);
  const dayIndex = (todayStart.getDay() + 6) % 7;
  const weekStart = addLocalDays(todayStart, -dayIndex);
  const weekEndExclusive = addLocalDays(weekStart, 7);
  return {
    now,
    todayStart,
    tomorrowStart: addLocalDays(todayStart, 1),
    yesterdayStart,
    weekStart,
    weekEndExclusive,
    public: {
      date: localDateKey(todayStart),
      yesterday: localDateKey(yesterdayStart),
      weekStart: localDateKey(weekStart),
      weekEnd: localDateKey(addLocalDays(weekEndExclusive, -1)),
      weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(todayStart),
    },
  };
}

function inRange(value, start, endExclusive) {
  const date = validDate(value);
  return Boolean(date && date >= start && date < endExclusive);
}

function parseScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("[") && text.endsWith("]"))) {
    try { return JSON.parse(text); } catch { return text.slice(0, 8_000); }
  }
  return text.slice(0, 8_000);
}

function splitFrontmatter(content) {
  const text = String(content || "").replace(/\r\n/gu, "\n");
  if (!text.startsWith("---\n")) return { fields: Object.create(null), body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0 || end > MAX_FRONTMATTER_BYTES) {
    return { fields: Object.create(null), body: text };
  }
  const raw = text.slice(4, end);
  const fields = Object.create(null);
  let arrayField = null;
  for (const line of raw.split("\n")) {
    const arrayItem = /^\s{2,}-\s+(.+)$/u.exec(line);
    if (arrayField && arrayItem) {
      fields[arrayField].push(parseScalar(arrayItem[1]));
      continue;
    }
    arrayField = null;
    const match = /^([^:#\s][^:]{0,79}):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (Object.hasOwn(fields, name)) continue;
    const value = parseScalar(match[2]);
    fields[name] = value;
    if (value === "") {
      fields[name] = [];
      arrayField = name;
    }
  }
  return { fields, body: text.slice(end + 5) };
}

function field(fields, ...names) {
  for (const name of names) {
    if (Object.hasOwn(fields, name)) return fields[name];
  }
  return null;
}

function stringList(value, maximum = 16) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = boundedText(raw, 120);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maximum) break;
  }
  return result;
}

function safeReviewPath(value) {
  try {
    const path = validateVaultMarkdownPath(String(value || ""));
    return DAILY_REVIEW_ROOT_SET.has(path.split("/")[0]) ? path : null;
  } catch {
    return null;
  }
}

function safeReviewPaths(value, maximum = 12) {
  const result = [];
  const seen = new Set();
  const values = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
  for (const raw of values) {
    let candidate = boundedText(raw, 1_024);
    const wikiLink = /^\[\[([^\]]+)\]\]$/u.exec(candidate);
    if (wikiLink) {
      candidate = wikiLink[1].split("|")[0].trim();
      if (candidate && !/\.[^/]+$/u.test(candidate)) candidate += ".md";
    }
    const path = safeReviewPath(candidate);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
    if (result.length >= maximum) break;
  }
  return result;
}

function reviewSourceClass(path) {
  const root = String(path || "").split("/")[0];
  if (root === "02_我的历史") return "personal-history";
  if (root === "11_证据与来源") return "evidence-source";
  if (root === "03_环境") return "environment-knowledge";
  return "formal-knowledge";
}

function fileTitle(path) {
  return boundedText(String(path || "").split("/").at(-1)?.replace(/\.md$/iu, ""), 200, "未命名");
}

function noteExcerpt(fields, body) {
  const declared = field(fields, "summary", "摘要", "content");
  if (typeof declared === "string" && declared.trim()) return boundedText(declared, 320);
  return boundedText(String(body || "").replace(/^#\s+.*$/mu, ""), 320, "没有可用摘要");
}

function normalizedParent(value) {
  const text = boundedText(value, 300);
  if (!text || /[\u0000-\u001f]/u.test(text)) return null;
  if (text.toLocaleLowerCase().endsWith(".md")) return safeReviewPath(text);
  if (text.includes("/") || text === "." || text === ".." || text.includes("..")) return null;
  return text;
}

function normalizedDecisionReference(value) {
  const text = boundedText(value, 1_024);
  if (!text) return null;
  const linkedPath = safeReviewPaths(text, 1)[0];
  if (linkedPath?.startsWith("06_判断与决策/")) return linkedPath;
  if (text.startsWith("06_判断与决策/") && !/\.[^/]+$/u.test(text)) {
    const path = safeReviewPath(`${text}.md`);
    if (path?.startsWith("06_判断与决策/")) return path;
  }
  return normalizedParent(text);
}

function relatedDecisionReference(fields) {
  const explicit = normalizedDecisionReference(field(
    fields,
    "related_decision",
    "relatedDecision",
    "关联判断",
    "关联决策",
  ));
  if (explicit) return explicit;
  const related = field(fields, "relatedKnowledge", "related_knowledge", "关联知识");
  for (const item of Array.isArray(related) ? related : []) {
    const reference = normalizedDecisionReference(item?.path || item?.id || item?.key);
    if (reference?.startsWith("06_判断与决策/")) return reference;
  }
  return null;
}

function normalizedProgress(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function normalizedPriority(value) {
  const text = boundedText(value, 20).toLocaleLowerCase();
  return new Set(["low", "normal", "high"]).has(text) ? text : "normal";
}

function parsedReviewNote(note, quality) {
  const path = safeReviewPath(note?.path);
  if (!path || typeof note?.content !== "string") {
    quality.rejectedNotes += 1;
    return null;
  }
  const bytes = Buffer.byteLength(note.content, "utf8");
  if (bytes > MAX_NOTE_BYTES) {
    quality.rejectedNotes += 1;
    return null;
  }
  const { fields, body } = splitFrontmatter(note.content);
  const heading = String(body || "").match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const title = boundedText(field(fields, "title", "标题") || heading || fileTitle(path), 200, fileTitle(path));
  const knowledgeType = boundedText(field(fields, "knowledgeType", "knowledge_type", "知识类型"), 80, "note");
  const createdAt = isoOrNull(field(fields, "createdAt", "created_at", "created", "创建时间"));
  const updatedAt = isoOrNull(field(fields, "updatedAt", "updated_at", "updated", "更新时间"));
  if (!createdAt) quality.missingCreatedAt += 1;
  else quality.declaredCreatedAt += 1;
  if (!updatedAt) quality.missingUpdatedAt += 1;
  else quality.declaredUpdatedAt += 1;
  const tags = stringList(field(fields, "tags", "标签"));
  const format = boundedText(field(fields, "xingzhiFormat"), 80, "ordinary");
  const rawType = boundedText(field(fields, "type", "记录类型"), 40);
  const type = rawType.toLocaleLowerCase();
  const level = boundedText(field(fields, "level", "planLevel", "plan_level", "计划层级"), 20).toLocaleLowerCase();
  const presentation = deriveKnowledgeCardPresentation({
    title,
    type: knowledgeType,
    summary: field(fields, "summary", "摘要"),
    keyPoints: field(
      fields,
      "keyPoints",
      "corePoints",
      "core_points",
      "knowledgePoints",
      "knowledge_points",
      "核心知识点",
    ),
    suggestedUses: field(fields, "suggestedUses", "applications", "建议用途"),
    content: field(fields, "content"),
    body,
    tags,
  });
  const root = path.split("/")[0];
  const cardEligible = root !== "11_证据与来源"
    && !looksLikeRawSourceDump({ title, content: note.content })
    && presentation.summaryState === "ready";
  if (!cardEligible) quality.unorganizedKnowledgeNotes += 1;
  let plan = null;
  if (type === "plan") {
    const rawStatus = boundedText(field(fields, "status", "状态"), 32).toLocaleLowerCase();
    const rawProgress = field(fields, "progress", "进度");
    const progress = normalizedProgress(rawProgress);
    const parentPlan = normalizedParent(field(fields, "parent_plan", "parentPlan", "父计划"));
    const id = normalizedParent(field(fields, "id", "plan_id", "planId", "key")) || path;
    const status = PLAN_STATUSES.has(rawStatus) ? rawStatus : "unknown";
    const startDate = isoOrNull(field(fields, "start_date", "startDate", "开始时间"));
    const endDate = isoOrNull(field(fields, "end_date", "endDate", "结束时间"));
    const lastAdvancedAt = isoOrNull(field(fields, "last_advanced_at", "lastAdvancedAt", "最近推进时间"));
    if (!PLAN_LEVEL_SET.has(level) || status === "unknown"
      || (rawProgress !== null && rawProgress !== "" && progress === null)) {
      quality.invalidPlanFields += 1;
    }
    plan = {
      id,
      path,
      key: boundedText(field(fields, "key"), 200),
      title,
      level: PLAN_LEVEL_SET.has(level) ? level : null,
      status,
      progress,
      startDate,
      endDate,
      parentPlan,
      goalId: boundedText(field(fields, "goal_id", "goalId"), 160),
      project: boundedText(field(fields, "project"), 160),
      priority: normalizedPriority(field(fields, "priority", "优先级")),
      lastAdvancedAt,
      summary: noteExcerpt(fields, body),
      tags,
      refs: [id, path, boundedText(field(fields, "key"), 200)].filter(Boolean),
    };
  }
  let decision = null;
  if (type === "decision" || knowledgeType.toLocaleLowerCase() === "decision" || /判断记录|决策记录/u.test(rawType)) {
    const id = normalizedParent(field(fields, "id", "decision_id", "decisionId", "knowledgeId", "key")) || path;
    const rawStatus = boundedText(field(fields, "status", "状态"), 32).toLocaleLowerCase();
    const retired = format === "knowledge-v1"
      && new Set(["historical", "superseded", "rejected"]).has(rawStatus);
    const pending = format === "knowledge-v1" && rawStatus === "pending";
    const closed = retired || new Set(["closed", "cancelled", "已关闭", "已取消"]).has(rawStatus);
    const reviewDateValue = field(fields, "review_date", "reviewDate", "复查日期");
    const reviewDateText = boundedText(reviewDateValue, 80);
    const reviewDate = isoOrNull(reviewDateValue);
    if (reviewDateText && !reviewDate && !new Set(["待确定", "未设置", "无"]).has(reviewDateText)) {
      quality.invalidDecisionFields += 1;
    }
    const expectedResult = boundedText(field(fields, "expected_result", "expectedResult", "预期结果"), 600);
    const actualResult = boundedText(field(fields, "actual_result", "actualResult", "实际结果"), 600);
    const correction = boundedText(field(fields, "correction", "修正", "校正"), 600);
    if (!expectedResult) quality.invalidDecisionFields += 1;
    if (!reviewDate && !closed && !actualResult) quality.invalidDecisionFields += 1;
    if (correction && !actualResult) quality.invalidDecisionFields += 1;
    decision = {
      id,
      path,
      title,
      status: closed ? "closed" : (pending ? "pending" : "active"),
      lifecycleStatus: rawStatus || "active",
      question: boundedText(field(fields, "question", "neutral_question", "中性问题", "问题"), 320),
      decision: boundedText(
        field(fields, "decision", "current_decision", "conclusion", "当前结论", "结论"),
        600,
        noteExcerpt(fields, body),
      ),
      expectedResult,
      reviewDate,
      actualResult,
      correction,
      relatedGoal: normalizedParent(field(fields, "related_goal", "relatedGoal", "关联目标")),
      project: boundedText(field(fields, "project", "项目"), 160),
      sourcePaths: safeReviewPaths(field(fields, "source_notes", "sourceNotes", "来源笔记", "证据来源")),
      refs: [
        id,
        path,
        path.replace(/\.md$/iu, ""),
        normalizedParent(field(fields, "knowledgeId", "key")),
      ].filter(Boolean),
    };
  }
  let feedback = null;
  const resultType = new Set(["result", "feedback"]).has(type)
    ? type
    : (new Set(["result", "feedback"]).has(knowledgeType.toLocaleLowerCase())
      ? knowledgeType.toLocaleLowerCase()
      : null);
  if (resultType) {
    const explicitFeedback = boundedText(field(fields, "feedback", "external_feedback", "外部反馈"), 600);
    const rawFeedbackStatus = boundedText(field(fields, "status", "状态"), 32).toLocaleLowerCase() || "active";
    const feedbackStatus = rawFeedbackStatus === "pending"
      ? "pending"
      : (new Set(["historical", "superseded", "rejected", "closed", "cancelled"]).has(rawFeedbackStatus)
        ? "inactive"
        : "active");
    feedback = {
      id: normalizedParent(field(fields, "id", "result_id", "feedback_id", "knowledgeId", "key")) || path,
      path,
      title,
      kind: resultType,
      status: feedbackStatus,
      lifecycleStatus: rawFeedbackStatus,
      relatedDecision: relatedDecisionReference(fields),
      actualResult: boundedText(
        field(fields, "actual_result", "actualResult", "observed_result", "result", "实际结果", "可观察结果")
          || explicitFeedback
          || field(fields, "content", "summary", "摘要"),
        600,
        "",
      ),
      correction: boundedText(field(fields, "correction", "修正", "校正"), 600),
      recordedAt: isoOrNull(field(fields, "observed_at", "recorded_at", "发生时间", "记录时间"))
        || updatedAt || createdAt,
      sourcePaths: safeReviewPaths(field(fields, "source_notes", "sourceNotes", "来源笔记", "证据来源")),
    };
  }
  return {
    path,
    contentHash: crypto.createHash("sha256").update(note.content, "utf8").digest("hex"),
    sourceClass: reviewSourceClass(path),
    title,
    knowledgeType,
    format,
    createdAt,
    updatedAt,
    tags,
    summary: presentation.summary,
    corePoints: [...presentation.keyPoints],
    presentationSource: presentation.presentationSource,
    cardEligible,
    sourcePath: safeReviewPath(field(fields, "sourceConversationPath", "source_path")),
    relatedPlan: normalizedParent(field(fields, "related_plan", "relatedPlan", "关联计划")),
    plan,
    decision,
    feedback,
  };
}

function dateEpoch(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00\.000Z)?$/u.exec(text);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ).getTime();
  }
  return validDate(value)?.getTime() ?? null;
}

function classifyPlanHealth(plan, nowValue) {
  const now = validDate(nowValue);
  if (!now) throw new Error("计划判断时间无效");
  const status = boundedText(plan?.status, 32).toLocaleLowerCase();
  const progress = normalizedProgress(plan?.progress);
  const start = dateEpoch(plan?.startDate);
  const end = dateEpoch(plan?.endDate, true);
  if (status === "cancelled") return { state: "cancelled", timeProgress: null, reason: "计划已取消" };
  if (status === "completed" || progress === 100) {
    return { state: "completed", timeProgress: end && start ? 100 : null, reason: "计划已完成" };
  }
  if (status === "blocked" || status === "waiting") {
    return { state: status, timeProgress: null, reason: status === "blocked" ? "计划明确标记为阻塞" : "计划正在等待外部条件" };
  }
  if (end !== null && end < now.getTime()) {
    return { state: "overdue", timeProgress: 100, reason: "计划周期已结束但尚未完成" };
  }
  if (status === "not-started"
    || (progress === 0 && start !== null && start <= now.getTime() && !validDate(plan?.lastAdvancedAt))) {
    return { state: "not-started", timeProgress: start !== null && end !== null ? 0 : null, reason: "已经进入计划周期但没有推进记录" };
  }
  if (progress !== null && start !== null && end !== null && end > start) {
    const elapsed = Math.max(0, Math.min(end - start, now.getTime() - start));
    const timeProgress = Math.round((elapsed / (end - start)) * 100);
    if (timeProgress - progress >= 10) {
      return { state: "lagging", timeProgress, reason: `实际进度 ${progress}% 低于时间进度 ${timeProgress}%` };
    }
    return { state: "on-track", timeProgress, reason: `实际进度 ${progress}% 与时间进度 ${timeProgress}% 基本匹配` };
  }
  return { state: "unknown", timeProgress: null, reason: "缺少可计算的日期或进度证据" };
}

function topicSummary(notes) {
  const counts = new Map();
  for (const note of notes) {
    for (const tag of note.tags) {
      if (!tag.startsWith("主题/")) continue;
      const label = boundedText(tag.slice(3), 80);
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"))
    .slice(0, 8);
}

function publicKnowledgeItem(note) {
  return {
    path: note.path,
    title: note.title,
    summary: note.summary,
    corePoints: [...note.corePoints],
    knowledgeType: note.knowledgeType,
    tags: [...note.tags],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    sourcePath: note.sourcePath,
    presentationSource: note.presentationSource,
  };
}

function buildPlanView(notes, now) {
  const rawPlans = notes.map((note) => note.plan).filter(Boolean);
  const plans = rawPlans.map((plan) => ({ ...plan, health: classifyPlanHealth(plan, now) }));
  const levels = Object.fromEntries(PLAN_LEVELS.map((level) => [
    level,
    plans.filter((plan) => plan.level === level).slice(0, MAX_REVIEW_ITEMS),
  ]));
  const referenceMap = new Map();
  for (const plan of plans) {
    for (const reference of plan.refs) {
      if (!referenceMap.has(reference)) referenceMap.set(reference, plan);
    }
  }
  const parentById = new Map();
  const childrenById = new Map();
  const unlinked = [];
  for (const plan of plans) {
    if (!plan.parentPlan) continue;
    const parent = referenceMap.get(plan.parentPlan);
    if (!parent) {
      unlinked.push(plan);
      continue;
    }
    parentById.set(plan.id, parent);
    const children = childrenById.get(parent.id) || [];
    children.push(plan);
    childrenById.set(parent.id, children);
  }
  const chains = [];
  for (const dayPlan of levels.day) {
    const chain = [dayPlan];
    const visited = new Set([dayPlan.id]);
    let current = dayPlan;
    while (parentById.has(current.id) && chain.length < 4) {
      current = parentById.get(current.id);
      if (visited.has(current.id)) break;
      visited.add(current.id);
      chain.unshift(current);
    }
    if (chain.map((item) => item.level).join(",") === PLAN_LEVELS.join(",")) {
      chains.push({ id: `chain-${dayPlan.id}`, items: chain });
    }
  }
  const expectedChild = { year: "month", month: "week", week: "day" };
  const notLanded = plans.filter((plan) => {
    const childLevel = expectedChild[plan.level];
    if (!childLevel || new Set(["completed", "cancelled"]).has(plan.health.state)) return false;
    return !(childrenById.get(plan.id) || []).some((child) => child.level === childLevel);
  });
  const untypedMaterials = notes
    .filter((note) => !note.plan && new Set(["project", "action"]).has(note.knowledgeType))
    .map(publicKnowledgeItem)
    .slice(0, MAX_REVIEW_ITEMS);
  const knowledgeLinks = [];
  const unlinkedKnowledge = [];
  for (const note of notes) {
    if (note.plan || !note.relatedPlan) continue;
    const related = referenceMap.get(note.relatedPlan);
    const item = {
      path: note.path,
      title: note.title,
      relatedPlan: note.relatedPlan,
      planId: related?.id || null,
      planPath: related?.path || null,
      planTitle: related?.title || null,
    };
    if (related) knowledgeLinks.push(item);
    else unlinkedKnowledge.push(item);
  }
  const healthCounts = Object.create(null);
  for (const plan of plans) healthCounts[plan.health.state] = (healthCounts[plan.health.state] || 0) + 1;
  const completionByLevel = Object.fromEntries(PLAN_LEVELS.map((level) => {
    const known = levels[level].filter((plan) => plan.progress !== null);
    const averageProgress = known.length
      ? Math.round(known.reduce((sum, plan) => sum + plan.progress, 0) / known.length)
      : null;
    return [level, { total: levels[level].length, known: known.length, averageProgress }];
  }));
  return {
    levels,
    chains: chains.slice(0, MAX_REVIEW_ITEMS),
    unlinked: unlinked.slice(0, MAX_REVIEW_ITEMS),
    notLanded: notLanded.slice(0, MAX_REVIEW_ITEMS),
    untypedMaterials,
    knowledgeLinks: knowledgeLinks.slice(0, MAX_REVIEW_ITEMS),
    unlinkedKnowledge: unlinkedKnowledge.slice(0, MAX_REVIEW_ITEMS),
    summary: { total: plans.length, byHealth: healthCounts, completionByLevel },
    all: plans,
  };
}

function classifyDecisionState(decision, period) {
  if (decision.status === "closed") return { state: "closed", reason: "决策已关闭或已退出当前知识生命周期" };
  if (decision.status === "pending") return { state: "pending", reason: "决策仍待确认，不能进入执行复盘" };
  if (decision.feedbackConflict) return { state: "conflicted", reason: "存在不同结果记录，需要人工核对" };
  if (decision.actualResult && decision.correction) return { state: "corrected", reason: "已记录实际结果和修正" };
  if (decision.actualResult) return { state: "reviewed", reason: "已记录实际结果，尚未形成修正" };
  const incomplete = [];
  if (!decision.expectedResult) incomplete.push("缺少预期结果");
  if (decision.correction) incomplete.push("已有修正但缺少实际结果");
  const incompleteReason = incomplete.length ? `${incomplete.join("；")}；` : "";
  const reviewAt = dateEpoch(decision.reviewDate);
  if (reviewAt === null) return { state: "unscheduled", reason: `${incompleteReason}缺少复查日期` };
  if (reviewAt < period.todayStart.getTime()) {
    return { state: "overdue", reason: `${incompleteReason}复查日期已过，尚未记录实际结果` };
  }
  if (reviewAt < period.tomorrowStart.getTime()) return { state: "due", reason: `${incompleteReason}今天到复查日期` };
  return { state: "scheduled", reason: `${incompleteReason}已安排后续复查` };
}

function publicDecisionItem(decision, period) {
  const classified = classifyDecisionState(decision, period);
  return {
    id: decision.id,
    path: decision.path,
    title: decision.title,
    status: decision.status,
    lifecycleStatus: decision.lifecycleStatus,
    state: classified.state,
    stateReason: classified.reason,
    question: decision.question,
    decision: decision.decision,
    expectedResult: decision.expectedResult,
    reviewDate: decision.reviewDate,
    actualResult: decision.actualResult,
    correction: decision.correction,
    relatedGoal: decision.relatedGoal,
    project: decision.project,
    sourcePaths: [...decision.sourcePaths],
    linkedResultPaths: [...decision.linkedResultPaths],
    feedbackConflict: decision.feedbackConflict,
  };
}

function uniqueReviewPaths(values, maximum = 24) {
  const result = [];
  const seen = new Set();
  for (const path of values) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
    if (result.length >= maximum) break;
  }
  return result;
}

function mergeDecisionFeedback(decision, records, quality) {
  const sorted = [...records].sort((left, right) => {
    const leftTime = validDate(left.recordedAt)?.getTime() ?? 0;
    const rightTime = validDate(right.recordedAt)?.getTime() ?? 0;
    return rightTime - leftTime || left.path.localeCompare(right.path, "zh-CN");
  });
  const actualValues = [decision.actualResult, ...sorted.map((item) => item.actualResult)].filter(Boolean);
  const correctionValues = [decision.correction, ...sorted.map((item) => item.correction)].filter(Boolean);
  const feedbackConflict = new Set(actualValues).size > 1 || new Set(correctionValues).size > 1;
  if (feedbackConflict) quality.conflictingDecisionFeedback += 1;
  return {
    ...decision,
    actualResult: decision.actualResult || sorted.find((item) => item.actualResult)?.actualResult || "",
    correction: decision.correction || sorted.find((item) => item.correction)?.correction || "",
    sourcePaths: uniqueReviewPaths([
      ...decision.sourcePaths,
      ...sorted.flatMap((item) => [item.path, ...item.sourcePaths]),
    ]),
    linkedResultPaths: uniqueReviewPaths(sorted.map((item) => item.path)),
    feedbackConflict,
  };
}

function buildDecisionView(notes, period, quality) {
  const decisions = notes.map((note) => note.decision).filter(Boolean);
  const referenceMap = new Map();
  for (const decision of decisions) {
    for (const reference of decision.refs) {
      if (!referenceMap.has(reference)) referenceMap.set(reference, decision);
    }
  }
  const recordsByDecision = new Map();
  for (const feedback of notes.map((note) => note.feedback).filter(Boolean)) {
    if (feedback.status === "inactive") {
      quality.inactiveDecisionFeedback += 1;
      continue;
    }
    if (feedback.status === "pending") {
      quality.pendingDecisionFeedback += 1;
      continue;
    }
    const target = feedback.relatedDecision ? referenceMap.get(feedback.relatedDecision) : null;
    if (!target) {
      quality.unlinkedDecisionFeedback += 1;
      continue;
    }
    const records = recordsByDecision.get(target.id) || [];
    records.push(feedback);
    recordsByDecision.set(target.id, records);
  }
  const classified = decisions.map((decision) => publicDecisionItem(
    mergeDecisionFeedback(decision, recordsByDecision.get(decision.id) || [], quality),
    period,
  ));
  const byState = Object.fromEntries([...DECISION_STATES].map((state) => [state, 0]));
  for (const item of classified) byState[item.state] += 1;
  const stateRank = { conflicted: 0, overdue: 1, due: 2, unscheduled: 3, pending: 4, scheduled: 5, corrected: 6, reviewed: 7, closed: 8 };
  const compare = (left, right) => (stateRank[left.state] - stateRank[right.state])
    || ((dateEpoch(left.reviewDate) ?? Number.MAX_SAFE_INTEGER) - (dateEpoch(right.reviewDate) ?? Number.MAX_SAFE_INTEGER))
    || left.title.localeCompare(right.title, "zh-CN");
  const sorted = [...classified].sort(compare);
  const items = sorted.slice(0, MAX_REVIEW_ITEMS);
  const due = sorted
    .filter((item) => new Set(["overdue", "due"]).has(item.state))
    .slice(0, MAX_REVIEW_ITEMS);
  const conflicted = sorted.filter((item) => item.state === "conflicted").slice(0, MAX_REVIEW_ITEMS);
  const open = sorted
    .filter((item) => new Set(["conflicted", "pending", "scheduled", "due", "overdue", "unscheduled"]).has(item.state))
    .slice(0, MAX_REVIEW_ITEMS);
  const reviewed = sorted
    .filter((item) => new Set(["corrected", "reviewed"]).has(item.state))
    .slice(0, MAX_REVIEW_ITEMS);
  return {
    items,
    due,
    conflicted,
    attention: [...conflicted, ...due].slice(0, MAX_REVIEW_ITEMS),
    open,
    reviewed,
    summary: { total: classified.length, byState },
  };
}

function normalizedRelatedPaths(action) {
  const paths = [];
  const seen = new Set();
  for (const item of Array.isArray(action?.relatedKnowledge) ? action.relatedKnowledge : []) {
    const path = safeReviewPath(item?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= 12) break;
  }
  return paths;
}

function suggestionId(prefix, value) {
  const digest = crypto.createHash("sha256").update(`${prefix}:${value}`, "utf8").digest("hex").slice(0, 16);
  return `daily-suggestion-${digest}`;
}

function buildTodayView(actions, plans, decisions, period) {
  const nowMs = period.now.getTime();
  const ranked = [];
  const blockers = [];
  const normalizedActions = [];
  let unlinkedActionCount = 0;
  for (const decision of decisions.attention) {
    const conflicted = decision.state === "conflicted";
    const overdue = decision.state === "overdue";
    const sourcePaths = uniqueReviewPaths(conflicted
      ? [decision.path, ...decision.linkedResultPaths, ...decision.sourcePaths]
      : [decision.path, ...decision.sourcePaths], 12);
    const reviewInstruction = decision.expectedResult
      ? "对照预期结果记录实际结果与修正。"
      : "先补充预期结果，再记录实际结果与修正。";
    ranked.push({
      score: conflicted ? 98 : (overdue ? 92 : 86),
      item: {
        id: suggestionId(conflicted ? "decision-feedback-conflict" : "decision-review", decision.id),
        kind: conflicted ? "decision-feedback-conflict" : "decision-review",
        actionId: null,
        planId: null,
        decisionId: decision.id,
        title: `${conflicted ? "核对冲突结果" : "复盘决策"}：${decision.title}`,
        reason: conflicted
          ? "发现相互不一致的结果记录；需要打开来源核对，不能自动视为已闭环。"
          : (overdue ? `复查日期已过；${reviewInstruction}` : `今天到复查日期；${reviewInstruction}`),
        sourcePaths,
      },
    });
    if (overdue || conflicted) {
      blockers.push({
        actionId: null,
        planId: null,
        decisionId: decision.id,
        title: decision.title,
        reason: conflicted ? "决策存在相互冲突的结果记录" : "决策复查已经逾期",
        sourcePaths,
      });
    }
  }
  for (const raw of (Array.isArray(actions) ? actions : []).slice(0, MAX_REVIEW_ACTIONS)) {
    const id = boundedText(raw?.id, 96);
    const title = boundedText(raw?.title, 160);
    const status = boundedText(raw?.status, 32).toLocaleLowerCase();
    if (!id || !title) continue;
    const action = {
      id,
      title,
      status,
      priority: normalizedPriority(raw?.priority),
      dueAt: isoOrNull(raw?.dueAt),
      updatedAt: isoOrNull(raw?.updatedAt),
      completedAt: isoOrNull(raw?.completedAt),
      sourcePaths: normalizedRelatedPaths(raw),
    };
    normalizedActions.push(action);
    // Unconfirmed conversation suggestions are not today's commitments.
    if (status === "candidate") continue;
    if (ACTIVE_ACTION_STATUSES.has(status) && !action.sourcePaths.length) {
      unlinkedActionCount += 1;
      continue;
    }
    const due = validDate(action.dueAt);
    const updated = validDate(action.updatedAt);
    const priorityBonus = action.priority === "high" ? 8 : action.priority === "low" ? -4 : 0;
    if (ACTIVE_ACTION_STATUSES.has(status) && due && due < period.todayStart) {
      ranked.push({
        score: 100 + priorityBonus,
        item: {
          id: suggestionId("overdue", id), kind: "overdue-action", actionId: id, planId: null,
          title, reason: "正式行动已经逾期，需要决定继续、拆分、延期或取消。", sourcePaths: action.sourcePaths,
        },
      });
      blockers.push({ actionId: id, planId: null, title, reason: "行动已经逾期", sourcePaths: action.sourcePaths });
      continue;
    }
    if (ACTIVE_ACTION_STATUSES.has(status) && due && inRange(due, period.todayStart, period.tomorrowStart)) {
      ranked.push({
        score: 90 + priorityBonus,
        item: {
          id: suggestionId("due-today", id), kind: "due-today", actionId: id, planId: null,
          title, reason: "正式行动今天到期。", sourcePaths: action.sourcePaths,
        },
      });
      continue;
    }
    if (status === "in-progress" && (!updated || nowMs - updated.getTime() >= STALE_ACTION_MS)) {
      ranked.push({
        score: 80 + priorityBonus,
        item: {
          id: suggestionId("stale", id), kind: "stale-action", actionId: id, planId: null,
          title, reason: "行动正在进行，但最近三天没有推进记录。", sourcePaths: action.sourcePaths,
        },
      });
      continue;
    }
    if (status === "waiting") {
      blockers.push({ actionId: id, planId: null, title, reason: "行动正在等待外部条件", sourcePaths: action.sourcePaths });
      continue;
    }
  }
  for (const plan of plans.all) {
    if (new Set(["blocked", "waiting", "overdue"]).has(plan.health.state)) {
      blockers.push({
        actionId: null, planId: plan.id, title: plan.title, reason: plan.health.reason, sourcePaths: [plan.path],
      });
    }
    if (plan.level !== "day" || new Set(["completed", "cancelled"]).has(plan.health.state)) continue;
    ranked.push({
      score: 70 + (plan.priority === "high" ? 8 : 0),
      item: {
        id: suggestionId("day-plan", plan.id), kind: "day-plan", actionId: null, planId: plan.id,
        title: plan.title, reason: `这是当前日计划；${plan.health.reason}。`, sourcePaths: [plan.path],
      },
    });
  }
  for (const plan of plans.notLanded) {
    if (plan.level !== "week" || plan.priority !== "high"
      || new Set(["completed", "cancelled", "blocked", "waiting"]).has(plan.health.state)) continue;
    ranked.push({
      score: 68,
      item: {
        id: suggestionId("plan-next-step", plan.id), kind: "plan-next-step", actionId: null, planId: plan.id,
        title: `为本周计划补充下一步：${plan.title}`,
        reason: "这是高优先级周计划，但尚未关联任何日计划。",
        sourcePaths: [plan.path],
      },
    });
  }
  ranked.sort((left, right) => right.score - left.score || left.item.title.localeCompare(right.item.title, "zh-CN"));
  const suggestions = [];
  const seen = new Set();
  for (const rankedItem of ranked) {
    const key = rankedItem.item.actionId || rankedItem.item.planId || rankedItem.item.decisionId || rankedItem.item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(rankedItem.item);
    if (suggestions.length >= MAX_TODAY_SUGGESTIONS) break;
  }
  const achievements = normalizedActions
    .filter((action) => action.status === "completed" && inRange(action.completedAt, period.weekStart, period.weekEndExclusive))
    .slice(0, MAX_REVIEW_ITEMS)
    .map((action) => ({ actionId: action.id, title: action.title, completedAt: action.completedAt, sourcePaths: action.sourcePaths }));
  const nextMilestoneEnd = addLocalDays(period.todayStart, 14).getTime();
  const nextMilestones = plans.all
    .filter((plan) => {
      const end = dateEpoch(plan.endDate, true);
      return end !== null && end >= nowMs && end <= nextMilestoneEnd
        && !new Set(["completed", "cancelled"]).has(plan.health.state);
    })
    .sort((left, right) => dateEpoch(left.endDate, true) - dateEpoch(right.endDate, true))
    .slice(0, MAX_REVIEW_ITEMS);
  const guidance = [];
  if (!plans.summary.total) guidance.push("尚未发现结构化计划，无法可靠计算年、月、周、日完成度。");
  if (normalizedActions.some((action) => action.status === "candidate")) {
    const count = normalizedActions.filter(action => action.status === "candidate").length;
    guidance.push(`另有 ${count} 条历史行动候选尚未确认，暂不进入今日推进建议；核对后可从首页建立行动。`);
  }
  if (unlinkedActionCount) guidance.push(`${unlinkedActionCount} 项历史行动缺少可打开的来源，今日建议暂未采用这些记录。`);
  if (decisions.summary.byState.unscheduled > 0) {
    guidance.push(`有 ${decisions.summary.byState.unscheduled} 条有效决策缺少复查日期，无法形成可靠反馈闭环。`);
  }
  if (decisions.summary.byState.conflicted > 0) {
    guidance.push(`有 ${decisions.summary.byState.conflicted} 条决策存在结果冲突，需人工核对来源后再修正判断。`);
  }
  if (!suggestions.length) guidance.push("当前没有足够证据生成今日推进项，可以先建立或确认一个最小行动。");
  return {
    suggestions,
    blockers: blockers.slice(0, MAX_REVIEW_ITEMS),
    achievements,
    nextMilestones,
    guidance,
  };
}

function buildDailyReview({
  notes = [],
  actions = [],
  events = [],
  previousReviewSnapshot = null,
  now = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(notes)) throw new Error("每日回顾笔记输入无效");
  if (notes.length > MAX_REVIEW_NOTES) throw new Error("每日回顾文件数量超过安全上限");
  if (!Array.isArray(actions) || actions.length > MAX_REVIEW_ACTIONS) {
    throw new Error("每日回顾行动数量超过安全上限");
  }
  if (!Array.isArray(events)) throw new Error("每日回顾事件输入无效");
  const period = periodFor(now);
  const quality = {
    rejectedNotes: 0,
    missingCreatedAt: 0,
    missingUpdatedAt: 0,
    declaredCreatedAt: 0,
    declaredUpdatedAt: 0,
    invalidPlanFields: 0,
    invalidDecisionFields: 0,
    unlinkedDecisionFeedback: 0,
    conflictingDecisionFeedback: 0,
    inactiveDecisionFeedback: 0,
    pendingDecisionFeedback: 0,
    unorganizedKnowledgeNotes: 0,
  };
  const parsedNotes = [];
  let totalBytes = 0;
  for (const note of notes) {
    if (typeof note?.content === "string") {
      totalBytes += Buffer.byteLength(note.content, "utf8");
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("每日回顾读取总量超过安全上限");
    }
    const parsed = parsedReviewNote(note, quality);
    if (parsed) parsedNotes.push(parsed);
  }
  const knowledgeNotes = parsedNotes.filter((note) => note.cardEligible);
  const yesterdayMatches = knowledgeNotes
    .filter((note) => inRange(note.createdAt, period.yesterdayStart, period.todayStart))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const weekNewMatches = knowledgeNotes
    .filter((note) => inRange(note.createdAt, period.weekStart, period.weekEndExclusive))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const weekUpdatedMatches = knowledgeNotes
    .filter((note) => inRange(note.updatedAt, period.weekStart, period.weekEndExclusive))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const yesterdayNew = yesterdayMatches.slice(0, MAX_REVIEW_ITEMS);
  const weekNew = weekNewMatches.slice(0, MAX_REVIEW_ITEMS);
  const weekUpdated = weekUpdatedMatches.slice(0, MAX_REVIEW_ITEMS);
  const plans = buildPlanView(parsedNotes, period.now);
  const decisions = buildDecisionView(parsedNotes, period, quality);
  const today = buildTodayView(actions, plans, decisions, period);
  const fingerprint = JSON.stringify({
    now: period.now.toISOString(),
    notes: parsedNotes.map((note) => [note.path, note.contentHash]),
    actions: actions.map((action) => [
      boundedText(action?.id, 96),
      boundedText(action?.status, 32),
      isoOrNull(action?.updatedAt),
      isoOrNull(action?.dueAt),
    ]),
  });
  const reviewId = `daily-review-${crypto.createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16)}`;
  const review = {
    id: reviewId,
    generatedAt: period.now.toISOString(),
    period: period.public,
    sources: {
      roots: [...DAILY_REVIEW_ROOTS],
      notesScanned: parsedNotes.length,
      actionsScanned: actions.length,
      eventsScanned: Math.min(events.length, 5_000),
      bytesScanned: totalBytes,
      quality,
    },
    knowledge: {
      totals: {
        yesterdayNew: yesterdayMatches.length,
        weekNew: weekNewMatches.length,
        weekUpdated: weekUpdatedMatches.length,
      },
      yesterdayNew: yesterdayNew.map(publicKnowledgeItem),
      yesterdaySummary: topicSummary(yesterdayMatches),
      weekNew: weekNew.map(publicKnowledgeItem),
      weekUpdated: weekUpdated.map(publicKnowledgeItem),
      weekTopics: topicSummary([...weekNewMatches, ...weekUpdatedMatches]),
    },
    plans: {
      levels: plans.levels,
      chains: plans.chains,
      unlinked: plans.unlinked,
      notLanded: plans.notLanded,
      untypedMaterials: plans.untypedMaterials,
      knowledgeLinks: plans.knowledgeLinks,
      unlinkedKnowledge: plans.unlinkedKnowledge,
      summary: plans.summary,
    },
    decisions,
    today,
  };
  const checkpoint = createReviewKnowledgeCheckpoint({
    generatedAt: review.generatedAt,
    sourceReviewId: reviewId,
    items: parsedNotes.map((note) => ({
      path: note.path,
      contentHash: note.contentHash,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      knowledgeType: note.knowledgeType,
      sourceClass: note.sourceClass,
    })),
  });
  const previousCheckpoint = normalizeReviewKnowledgeCheckpoint(previousReviewSnapshot?.reviewContext?.checkpoint);
  const knowledgeDelta = buildReviewKnowledgeDelta({
    currentCheckpoint: checkpoint,
    previousCheckpoint,
  });
  review.reviewContext = {
    schemaVersion: 1,
    status: "PREPARED",
    checkpoint,
    knowledgeDelta,
    historyQuery: buildReviewHistoryQuery(review),
    profile: null,
  };
  return review;
}

function boundedCount(value, maximum = 1_000_000) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : 0;
}

function snapshotKnowledgeItem(value) {
  const path = safeReviewPath(value?.path);
  const title = boundedText(value?.title, 200);
  if (!path || !title) return null;
  return {
    path,
    title,
    summary: boundedText(value?.summary, 320, "没有可用摘要"),
    corePoints: stringList(value?.corePoints, 6),
    knowledgeType: boundedText(value?.knowledgeType, 80, "note"),
    tags: stringList(value?.tags),
    createdAt: isoOrNull(value?.createdAt),
    updatedAt: isoOrNull(value?.updatedAt),
    sourcePath: safeReviewPath(value?.sourcePath),
    presentationSource: new Set(["structured", "derived"]).has(value?.presentationSource)
      ? value.presentationSource
      : "derived",
  };
}

function snapshotKnowledgeItems(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = snapshotKnowledgeItem(value);
    if (!item) continue;
    result.push(item);
    if (result.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return result;
}

function snapshotTopics(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const label = boundedText(value?.label, 80);
    if (!label) continue;
    result.push({ label, count: boundedCount(value?.count, MAX_REVIEW_NOTES) });
    if (result.length >= 8) break;
  }
  return result;
}

function snapshotHealth(value) {
  const state = boundedText(value?.state, 32);
  const allowed = new Set([
    "completed", "blocked", "waiting", "overdue", "not-started", "lagging", "on-track", "unknown", "cancelled",
  ]);
  return {
    state: allowed.has(state) ? state : "unknown",
    timeProgress: normalizedProgress(value?.timeProgress),
    reason: boundedText(value?.reason, 240, "缺少可验证的进度依据"),
  };
}

function snapshotPlan(value) {
  const path = safeReviewPath(value?.path);
  const id = normalizedParent(value?.id);
  const title = boundedText(value?.title, 200);
  const level = boundedText(value?.level, 20);
  if (!path || !id || !title || !PLAN_LEVEL_SET.has(level)) return null;
  return {
    id,
    path,
    title,
    level,
    status: PLAN_STATUSES.has(value?.status) ? value.status : "unknown",
    progress: normalizedProgress(value?.progress),
    startDate: isoOrNull(value?.startDate),
    endDate: isoOrNull(value?.endDate),
    parentPlan: normalizedParent(value?.parentPlan),
    goalId: boundedText(value?.goalId, 160),
    project: boundedText(value?.project, 160),
    priority: normalizedPriority(value?.priority),
    lastAdvancedAt: isoOrNull(value?.lastAdvancedAt),
    summary: boundedText(value?.summary, 320, "没有可用摘要"),
    health: snapshotHealth(value?.health),
  };
}

function snapshotPlans(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = snapshotPlan(value);
    if (!item) continue;
    result.push(item);
    if (result.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return result;
}

function snapshotDecision(value) {
  const id = normalizedParent(value?.id);
  const path = safeReviewPath(value?.path);
  const title = boundedText(value?.title, 200);
  const state = boundedText(value?.state, 32);
  if (!id || !path || !title || !DECISION_STATES.has(state)) return null;
  return {
    id,
    path,
    title,
    status: new Set(["active", "pending", "closed"]).has(value?.status) ? value.status : "active",
    lifecycleStatus: boundedText(value?.lifecycleStatus, 32, "active"),
    state,
    stateReason: boundedText(value?.stateReason, 240, "缺少状态说明"),
    question: boundedText(value?.question, 320),
    decision: boundedText(value?.decision, 600),
    expectedResult: boundedText(value?.expectedResult, 600),
    reviewDate: isoOrNull(value?.reviewDate),
    actualResult: boundedText(value?.actualResult, 600),
    correction: boundedText(value?.correction, 600),
    relatedGoal: normalizedParent(value?.relatedGoal),
    project: boundedText(value?.project, 160),
    sourcePaths: safeReviewPaths(value?.sourcePaths),
    linkedResultPaths: safeReviewPaths(value?.linkedResultPaths),
    feedbackConflict: value?.feedbackConflict === true,
  };
}

function snapshotDecisions(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = snapshotDecision(value);
    if (!item) continue;
    result.push(item);
    if (result.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return result;
}

function snapshotDecisionSummary(value) {
  return {
    total: boundedCount(value?.total, MAX_REVIEW_NOTES),
    byState: Object.fromEntries([...DECISION_STATES].map((state) => [
      state,
      boundedCount(value?.byState?.[state], MAX_REVIEW_NOTES),
    ])),
  };
}

function snapshotSuggestion(value) {
  const id = boundedText(value?.id, 96);
  const title = boundedText(value?.title, 200);
  if (!/^daily-suggestion-[a-f0-9]{16}$/u.test(id) || !title) return null;
  return {
    id,
    kind: boundedText(value?.kind, 48, "review"),
    actionId: boundedText(value?.actionId, 96) || null,
    planId: normalizedParent(value?.planId),
    decisionId: normalizedParent(value?.decisionId),
    title,
    reason: boundedText(value?.reason, 320, "没有补充理由"),
    sourcePaths: (Array.isArray(value?.sourcePaths) ? value.sourcePaths : [])
      .map(safeReviewPath).filter(Boolean).slice(0, 12),
  };
}

function snapshotSuggestions(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = snapshotSuggestion(value);
    if (item) result.push(item);
    if (result.length >= MAX_TODAY_SUGGESTIONS) break;
  }
  return result;
}

function snapshotBlockers(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const title = boundedText(value?.title, 200);
    if (!title) continue;
    result.push({
      actionId: boundedText(value?.actionId, 96) || null,
      planId: normalizedParent(value?.planId),
      decisionId: normalizedParent(value?.decisionId),
      title,
      reason: boundedText(value?.reason, 320, "缺少补充说明"),
      sourcePaths: (Array.isArray(value?.sourcePaths) ? value.sourcePaths : [])
        .map(safeReviewPath).filter(Boolean).slice(0, 12),
    });
    if (result.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return result;
}

function snapshotPlanLinks(values, { requireTarget = true } = {}) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const path = safeReviewPath(value?.path);
    const title = boundedText(value?.title, 200);
    const planId = normalizedParent(value?.planId);
    if (!path || !title || (requireTarget && !planId)) continue;
    result.push({
      path,
      title,
      relatedPlan: normalizedParent(value?.relatedPlan),
      planId,
      planPath: safeReviewPath(value?.planPath),
      planTitle: boundedText(value?.planTitle, 200) || null,
    });
    if (result.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return result;
}

function snapshotCompletionByLevel(value) {
  return Object.fromEntries(PLAN_LEVELS.map((level) => {
    const item = value?.[level];
    return [level, {
      total: boundedCount(item?.total, MAX_REVIEW_NOTES),
      known: boundedCount(item?.known, MAX_REVIEW_NOTES),
      averageProgress: normalizedProgress(item?.averageProgress),
    }];
  }));
}

function snapshotReviewContext(value) {
  const checkpoint = normalizeReviewKnowledgeCheckpoint(value?.checkpoint);
  if (!checkpoint) return null;
  const profile = normalizeReviewContextProfile(value?.profile);
  return {
    schemaVersion: 1,
    status: profile ? "READY" : "PREPARED",
    checkpoint,
    profile,
  };
}

function createDailyReviewSnapshot(value) {
  const id = boundedText(value?.id, 96);
  const generatedAt = isoOrNull(value?.generatedAt);
  if (!/^daily-review-[a-f0-9]{16}$/u.test(id) || !generatedAt) return null;
  const period = value?.period || {};
  if (![period.date, period.yesterday, period.weekStart, period.weekEnd]
    .every((item) => /^\d{4}-\d{2}-\d{2}$/u.test(String(item || "")))) return null;
  const levelValues = Object.fromEntries(PLAN_LEVELS.map((level) => [
    level,
    snapshotPlans(value?.plans?.levels?.[level]),
  ]));
  const chains = [];
  for (const chain of Array.isArray(value?.plans?.chains) ? value.plans.chains : []) {
    const items = snapshotPlans(chain?.items);
    if (items.length !== 4) continue;
    chains.push({ id: boundedText(chain?.id, 200), items });
    if (chains.length >= 8) break;
  }
  const byHealth = Object.create(null);
  for (const [key, count] of Object.entries(value?.plans?.summary?.byHealth || {}).slice(0, 12)) {
    const state = boundedText(key, 32);
    if (state) byHealth[state] = boundedCount(count, MAX_REVIEW_NOTES);
  }
  return {
    schemaVersion: 3,
    id,
    generatedAt,
    period: {
      date: period.date,
      yesterday: period.yesterday,
      weekStart: period.weekStart,
      weekEnd: period.weekEnd,
      weekday: boundedText(period.weekday, 24),
    },
    reviewContext: snapshotReviewContext(value?.reviewContext),
    sources: {
      roots: [...DAILY_REVIEW_ROOTS],
      notesScanned: boundedCount(value?.sources?.notesScanned, MAX_REVIEW_NOTES),
      actionsScanned: boundedCount(value?.sources?.actionsScanned, MAX_REVIEW_ACTIONS),
      quality: {
        rejectedNotes: boundedCount(value?.sources?.quality?.rejectedNotes, MAX_REVIEW_NOTES),
        missingCreatedAt: boundedCount(value?.sources?.quality?.missingCreatedAt, MAX_REVIEW_NOTES),
        missingUpdatedAt: boundedCount(value?.sources?.quality?.missingUpdatedAt, MAX_REVIEW_NOTES),
        invalidPlanFields: boundedCount(value?.sources?.quality?.invalidPlanFields, MAX_REVIEW_NOTES),
        invalidDecisionFields: boundedCount(value?.sources?.quality?.invalidDecisionFields, MAX_REVIEW_NOTES),
        unlinkedDecisionFeedback: boundedCount(value?.sources?.quality?.unlinkedDecisionFeedback, MAX_REVIEW_NOTES),
        conflictingDecisionFeedback: boundedCount(value?.sources?.quality?.conflictingDecisionFeedback, MAX_REVIEW_NOTES),
        inactiveDecisionFeedback: boundedCount(value?.sources?.quality?.inactiveDecisionFeedback, MAX_REVIEW_NOTES),
        pendingDecisionFeedback: boundedCount(value?.sources?.quality?.pendingDecisionFeedback, MAX_REVIEW_NOTES),
        unorganizedKnowledgeNotes: boundedCount(value?.sources?.quality?.unorganizedKnowledgeNotes, MAX_REVIEW_NOTES),
      },
    },
    knowledge: {
      totals: {
        yesterdayNew: boundedCount(value?.knowledge?.totals?.yesterdayNew, MAX_REVIEW_NOTES),
        weekNew: boundedCount(value?.knowledge?.totals?.weekNew, MAX_REVIEW_NOTES),
        weekUpdated: boundedCount(value?.knowledge?.totals?.weekUpdated, MAX_REVIEW_NOTES),
      },
      yesterdayNew: snapshotKnowledgeItems(value?.knowledge?.yesterdayNew),
      yesterdaySummary: snapshotTopics(value?.knowledge?.yesterdaySummary),
      weekNew: snapshotKnowledgeItems(value?.knowledge?.weekNew),
      weekUpdated: snapshotKnowledgeItems(value?.knowledge?.weekUpdated),
      weekTopics: snapshotTopics(value?.knowledge?.weekTopics),
    },
    plans: {
      levels: levelValues,
      chains,
      unlinked: snapshotPlans(value?.plans?.unlinked),
      notLanded: snapshotPlans(value?.plans?.notLanded),
      untypedMaterials: snapshotKnowledgeItems(value?.plans?.untypedMaterials),
      knowledgeLinks: snapshotPlanLinks(value?.plans?.knowledgeLinks),
      unlinkedKnowledge: snapshotPlanLinks(value?.plans?.unlinkedKnowledge, { requireTarget: false }),
      summary: {
        total: boundedCount(value?.plans?.summary?.total, MAX_REVIEW_NOTES),
        byHealth,
        completionByLevel: snapshotCompletionByLevel(value?.plans?.summary?.completionByLevel),
      },
    },
    decisions: {
      items: snapshotDecisions(value?.decisions?.items),
      summary: snapshotDecisionSummary(value?.decisions?.summary),
    },
    today: {
      suggestions: snapshotSuggestions(value?.today?.suggestions),
      blockers: snapshotBlockers(value?.today?.blockers),
      achievements: snapshotBlockers(value?.today?.achievements),
      nextMilestones: snapshotPlans(value?.today?.nextMilestones),
      guidance: (Array.isArray(value?.today?.guidance) ? value.today.guidance : [])
        .map((item) => boundedText(item, 320)).filter(Boolean).slice(0, 8),
    },
  };
}

function normalizeDailyReviewSnapshots(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const snapshot = createDailyReviewSnapshot(value);
    if (!snapshot || seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    result.push(snapshot);
  }
  result.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  return result.slice(0, MAX_DAILY_REVIEW_SNAPSHOTS);
}

module.exports = {
  DAILY_REVIEW_ROOTS,
  MAX_DAILY_REVIEW_SNAPSHOTS,
  MAX_REVIEW_NOTES,
  buildDailyReview,
  classifyPlanHealth,
  createDailyReviewSnapshot,
  normalizeDailyReviewSnapshots,
};
