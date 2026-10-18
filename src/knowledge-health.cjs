"use strict";

const crypto = require("node:crypto");
const { inspectGeneratedKnowledgeNote, readKnowledgeManifest } = require("./knowledge-tools.cjs");
const { inspectKnowledgeRecord } = require("./knowledge-record-schema.cjs");
const { routeKnowledgeCandidate } = require("./knowledge-router.cjs");
const { FORMAL_ROOTS, inspectIndexMarkers } = require("./knowledge-indexer.cjs");
const { scanKnowledgeLifecycle } = require("./knowledge-lifecycle.cjs");
const {
  deriveKnowledgeCardPresentation,
  isStructuralKnowledge,
} = require("./knowledge-card-presentation.cjs");

const MAX_FORMAL_NOTES = 2_000;
const MAX_CONTROL_NOTES = 500;
const MAX_PATH = 1_024;
const MODERN_SCHEMA_FIELDS = Object.freeze([
  "epistemicStatus", "tags", "aliases", "relatedKnowledge",
  "sourceConversationPath", "sourceMessageId", "sourceDocuments",
]);
const SEVERITY_ORDER = Object.freeze({ critical: 0, error: 1, warning: 2, info: 3 });
const FORMAL_ROOT_SET = new Set(FORMAL_ROOTS);
const KNOWLEDGE_PREVIEW_CHARS = 1_600;
const SPLIT_CANDIDATE_CHARS = 8_000;
const SOURCE_ONLY_PREFIXES = Object.freeze([
  "11_证据与来源/对话与访谈/",
  "11_证据与来源/外部文档/",
]);
const SYSTEM_MANAGED_FORMAL_TYPES = new Set([
  "interaction-ledger",
  "user-continuity-profile",
  "user-interaction-profile",
  "profile-revision-log",
  "growth-event-log",
  "user-growth-path",
  "conversation-knowledge-entry",
]);
const EPISTEMIC_LABELS = Object.freeze({
  fact: "已验证事实",
  "user-statement": "用户自述",
  inference: "推断",
  "value-judgment": "价值判断",
  hypothesis: "待验证假设",
  unknown: "未知",
});
const STATUS_LABELS = Object.freeze({
  active: "有效",
  "needs-verification": "待验证",
  expired: "已过期",
  superseded: "已被替代",
  rejected: "已否定",
});
const ISSUE_GUIDANCE = Object.freeze({
  "missing-source-file": Object.freeze({ title: "来源文件不存在", impact: "这条记录不能沿声明路径返回原始材料。", recommendation: "先按原始文件编号或哈希恢复来源；不能恢复时标记 sourceStatus: needs-recovery，不要补写猜测的证据。" }),
  "missing-source-anchor": Object.freeze({ title: "来源消息锚点缺失", impact: "文件存在，但声明的原始消息不可定位。", recommendation: "核对原始对话及备份。恢复真实消息，或保持待核验状态；不要用知识摘要伪造原话。" }),
  "source-quote-needs-review": Object.freeze({ title: "引用文字需要人工核对", impact: "忽略空白后仍未在来源文件精确找到引用；可能涉及节选、转述或来源变化。", recommendation: "打开来源逐段核对；若为转述应明确标识，不能自动判成虚假或已证实。" }),
  "candidate-awaiting-review": Object.freeze({ title: "知识候选等待审核", impact: "记录仍可查看和比较版本，但不进入默认可信检索。", recommendation: "依据原始证据确认、驳回或补充条件；不要仅为减少体检提示而批量接受。" }),
  "damaged-index-markers": Object.freeze({ title: "目录索引的自动维护标记损坏", impact: "系统无法安全判断哪些内容可自动替换，因此会停止更新这个索引。", recommendation: "打开索引文件，修复或重新生成成对的“行知自动索引”标记后再预览。" }),
  "malformed-knowledge-note": Object.freeze({ title: "知识文件结构损坏", impact: "这条内容不能被可靠识别、检索或参与冲突校验。", recommendation: "打开原文件检查 Frontmatter；不要直接覆盖正文，先修复字段格式。" }),
  "legacy-schema": Object.freeze({ title: "知识仍使用旧版字段", impact: "来源、标签、关联或生命周期信息可能不完整，后续调用精度会下降。", recommendation: "补齐列出的缺失字段，或使用后续的知识 Schema 升级器批量迁移。" }),
  "invalid-knowledge-id": Object.freeze({ title: "知识编号不安全或不合法", impact: "编号无法作为稳定关联键，可能破坏去重、撤销和来源追踪。", recommendation: "为这条知识生成只含字母、数字、点、下划线、冒号或短横线的稳定编号。" }),
  "unsupported-knowledge-type": Object.freeze({ title: "知识类型无法识别", impact: "系统不知道应把它归入哪个知识目录，也无法选择正确的检索和冲突规则。", recommendation: "把 knowledgeType 改为行知注册表中支持的知识类型。" }),
  "knowledge-root-mismatch": Object.freeze({ title: "知识放错了一级目录", impact: "目录语义与知识类型不一致，按目录检索和自动索引可能漏掉它。", recommendation: "按提示把文件移动到正确的 01—09 或 11 目录，再重新扫描。" }),
  "broken-related-link": Object.freeze({ title: "关联知识链接已失效", impact: "系统沿双链读取上下文时无法找到目标知识，关联推理会中断。", recommendation: "修正关联路径，或在确认目标知识已不存在后移除这条关联。" }),
  "duplicate-knowledge-id": Object.freeze({ title: "多个文件使用了同一个知识编号", impact: "系统无法确定哪一条才是权威版本，去重和更新可能指向错误文件。", recommendation: "确认主版本，为其他文件重新编号或标记为被替代。" }),
  "missing-index-file": Object.freeze({ title: "知识所在目录缺少目录页", impact: "知识虽然存在，但目录首页无法展示和导航到它。", recommendation: "先查看修复方案，确认后创建缺失的知识目录页。" }),
  "index-unlisted": Object.freeze({ title: "知识尚未收录进目录", impact: "文件可以被全文检索，但在知识目录中不可见。", recommendation: "查看修复方案，确认后将这条知识链接加入对应目录。" }),
  "duplicate-agent-definition": Object.freeze({ title: "发现重复的 Agent 定义", impact: "同一 Agent 可能出现多个版本，加载时难以确定权威定义。", recommendation: "保留注册表指向的定义，把旧副本归档或移除。" }),
  "duplicate-skill-definition": Object.freeze({ title: "发现重复的 Skill 定义", impact: "同名 Skill 可能加载到不同指令，导致相同任务输出不稳定。", recommendation: "保留注册表指向的 SKILL.md，把旧副本归档或移除。" }),
  "unstructured-knowledge-note": Object.freeze({ title: "旧笔记尚未进入知识结构", impact: "内容可以全文检索，但缺少稳定类型、状态、来源和调用字段，难以参与精确关联与迭代。", recommendation: "打开原文核对，将可复用结论整理成知识候选；原文件保持不变，确认后再写入正式知识。" }),
  "semantic-structure-incomplete": Object.freeze({ title: "知识缺少可用的语义整理", impact: "卡片无法稳定展示核心总结、核心知识点或建议用途，检索命中后仍需重新阅读原文。", recommendation: "依据原文补充核心总结、知识点和用途；模型生成内容必须先人工复核。" }),
  "missing-source-provenance": Object.freeze({ title: "知识缺少可追溯来源", impact: "无法从结论回到对话或文档证据，出现冲突时难以核验。", recommendation: "补充来源对话、来源消息或来源文档；没有证据时将认识状态降为待验证。" }),
  "knowledge-split-candidate": Object.freeze({ title: "单条知识可能承载了过多内容", impact: "过长知识会混合多个结论、适用条件或行动方法，降低检索和复用精度。", recommendation: "先生成只读拆分建议，按独立结论或用途拆成候选；原知识在确认前保持不变。" }),
});

const ISSUE_REPAIRS = Object.freeze({
  "legacy-schema": Object.freeze({ mode: "automatic", kind: "schema-upgrade", actionLabel: "查看修复方案" }),
  "missing-index-file": Object.freeze({ mode: "automatic", kind: "index-update", actionLabel: "查看修复方案" }),
  "index-unlisted": Object.freeze({ mode: "automatic", kind: "index-update", actionLabel: "查看修复方案" }),
  "duplicate-agent-definition": Object.freeze({ mode: "manual", kind: "control-plane-review", actionLabel: "查看判断与建议" }),
  "duplicate-skill-definition": Object.freeze({ mode: "manual", kind: "control-plane-review", actionLabel: "查看判断与建议" }),
  "semantic-structure-incomplete": Object.freeze({ mode: "agent", kind: "semantic-enrichment", actionLabel: "查看 Agent 整理" }),
  "unstructured-knowledge-note": Object.freeze({ mode: "agent", kind: "knowledge-classification", actionLabel: "查看 Agent 分类" }),
});

function issueGuidance(code) {
  return ISSUE_GUIDANCE[code] || {
    title: "发现一项需要检查的知识问题",
    impact: "这可能影响知识的检索、关联、校验或维护。",
    recommendation: "打开相关文件核对具体提示，修改后重新运行知识体检。",
  };
}

function issueRepair(code) {
  return ISSUE_REPAIRS[code] || Object.freeze({
    mode: "manual",
    kind: "manual-review",
    actionLabel: "查看判断与建议",
  });
}

function knowledgePurpose(manifest) {
  const label = manifest?.category?.label || "知识";
  return `这条${label}会在相关问题、判断或行动中按标题、标签、正文和关联知识被检索；新知识写入前还会用冲突校验键检查重复与矛盾。`;
}

function inspectHealthNote(note) {
  const inspection = inspectKnowledgeRecord(note);
  if (!inspection.governed) return inspectGeneratedKnowledgeNote(note);
  if (inspection.malformed) return { generated: true, malformed: true, path: note.path };
  const record = inspection.record;
  const manifest = {
    ...record,
    source: { ...record.source },
    category: { label: record.recordClass === "business-reference" ? "业务资料" : record.knowledgeType },
  };
  return {
    ...record, record, manifest, generated: true, malformed: false,
    knowledgeId: record.entityId, key: record.knowledgeKey,
    knowledgeType: record.knowledgeType || record.referenceType,
    schemaFields: [...String(note.content).matchAll(/^([A-Za-z][A-Za-z0-9_]*):/gm)].map(m => m[1]),
    sourceConversationPath: record.source.conversationPath,
    sourceMessageId: record.source.messageId,
    sourceQuotedText: record.source.quotedText,
    sourceDocuments: record.source.documents,
  };
}

// These checks establish source addressability, never the truth of a claim.
function sourcePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || /^[a-z]:/i.test(value) || value.split("/").some(p => !p || p === "." || p === ".." || p.startsWith("."))
    || /[\u0000-\u001f]/u.test(value) || !FORMAL_ROOT_SET.has(value.split("/")[0])) return null;
  return value;
}

async function collectSourceInventory(vault, notes) {
  const paths = new Set();
  for (const note of notes) {
    const record = inspectKnowledgeRecord(note).record;
    if (!record) continue;
    for (const p of [record.source.conversationPath, ...record.source.documents]) {
      if (sourcePath(p)) paths.add(p);
    }
  }
  const result = [];
  for (const path of paths) {
    try { result.push({ path, exists: await vault.exists(path) }); }
    catch { result.push({ path, exists: null }); }
  }
  return result;
}

function inspectSourceIntegrity(inspected, notesByPath, inventory, issues) {
  const path = inspected.path;
  const checks = [];
  const add = (code, message, detail) => {
    checks.push({ code, detail });
    addIssue(issues, code, "warning", path, message, detail);
  };
  const checkFile = raw => {
    const target = sourcePath(raw);
    if (!target) { add("invalid-source-path", "来源路径无效或不在知识资料范围内。", String(raw)); return null; }
    const observed = inventory.has(target) ? inventory.get(target) : notesByPath.has(target) ? true : /\.md$/i.test(target) ? false : null;
    if (observed === false) add("missing-source-file", `来源文件不存在：${target}`, target);
    else if (observed !== true) add("source-not-checked", `来源文件尚未核验：${target}`, target);
    return observed === true ? target : null;
  };
  if (inspected.sourceConversationPath) {
    const target = checkFile(inspected.sourceConversationPath);
    const content = target ? notesByPath.get(target)?.content : null;
    if (target && inspected.sourceMessageId) {
      if (typeof content !== "string") add("source-anchor-not-checked", "来源文件存在，但消息正文未载入，锚点尚未核验。", target);
      else {
        const escaped = inspected.sourceMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`(?:^|[ \t])\\^${escaped}[ \t]*$`, "m").test(content.replace(/\r\n/g,"\n"))) {
          add("missing-source-anchor", `来源文件中找不到消息锚点：${inspected.sourceMessageId}`, `${target}#^${inspected.sourceMessageId}`);
        }
      }
    }
    if (target && typeof content === "string" && inspected.sourceQuotedText
      && !content.replace(/\s/g, "").includes(inspected.sourceQuotedText.replace(/\s/g, ""))) {
      add("source-quote-needs-review", "来源原文未精确匹配引用文字，需要人工核对；这不等于内容虚假。", target);
    }
  } else if (inspected.sourceMessageId) add("source-anchor-without-file", "有来源消息编号，但缺少可定位的对话文件。", inspected.sourceMessageId);
  for (const doc of inspected.sourceDocuments || []) checkFile(doc);
  return { status: checks.length ? "needs-review" : inspected.sourceConversationPath || inspected.sourceDocuments?.length ? "addresses-checked" : "not-checked", checks,
    hashesChecked: false, claimTruthVerified: false };
}

function knowledgeCard(note, inspected) {
  const manifest = inspected.manifest || readKnowledgeManifest(note);
  const content = typeof manifest?.content === "string" ? manifest.content.trim() : "";
  const presentation = deriveKnowledgeCardPresentation({
    title: inspected.title,
    type: inspected.knowledgeType,
    content,
    summary: manifest?.summary || "",
    keyPoints: manifest?.keyPoints || [],
    suggestedUses: manifest?.suggestedUses || [],
    tags: manifest?.tags || [],
  });
  return {
    path: inspected.path,
    title: String(inspected.title).slice(0, 200),
    knowledgeId: String(inspected.knowledgeId).slice(0, 200),
    knowledgeType: String(inspected.knowledgeType).slice(0, 80),
    typeLabel: manifest?.category?.label || String(inspected.knowledgeType).slice(0, 80),
    epistemicStatus: inspected.epistemicStatus,
    epistemicLabel: EPISTEMIC_LABELS[inspected.epistemicStatus] || inspected.epistemicStatus,
    status: String(inspected.status).slice(0, 40),
    statusLabel: STATUS_LABELS[inspected.status] || String(inspected.status).slice(0, 40),
    updatedAt: inspected.updatedAt || null,
    directory: inspected.path.split("/").slice(0, -1).join("/"),
    schema: null,
    contentPreview: presentation.summary.slice(0, KNOWLEDGE_PREVIEW_CHARS),
    contentTruncated: presentation.summaryTruncated,
    ...presentation,
    purpose: knowledgePurpose(manifest),
    tags: [...(manifest?.tags || [])],
    aliases: [...(manifest?.aliases || [])],
    relatedKnowledge: (manifest?.relatedKnowledge || []).map((item) => ({ ...item })),
    source: manifest?.source ? { ...manifest.source, documents: [...(manifest.source.documents || [])] } : null,
    retrieval: manifest?.retrieval ? {
      conflictKey: manifest.retrieval.conflictKey,
      terms: [...(manifest.retrieval.terms || [])],
      modes: (manifest.retrieval.modes || []).map((item) => ({ ...item })),
    } : null,
  };
}

function issueId(code, path, detail = "") {
  return crypto.createHash("sha256").update(`${code}\0${path}\0${detail}`).digest("hex").slice(0, 16);
}

function safePath(value) {
  const path = typeof value === "string" ? value.replaceAll("\\", "/").slice(0, MAX_PATH) : "";
  return path && !path.startsWith("/") && !path.includes("../") ? path : "未知路径";
}

function addIssue(issues, code, severity, path, message, detail = "") {
  const safe = safePath(path);
  const guidance = issueGuidance(code);
  issues.push({
    id: issueId(code, safe, detail),
    code,
    severity,
    path: safe,
    message: String(message).slice(0, 500),
    title: guidance.title,
    impact: guidance.impact,
    recommendation: guidance.recommendation,
    repair: { ...issueRepair(code) },
  });
}

function normalizeLinkPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let path = value.replaceAll("\\", "/").split("#")[0].trim();
  if (!path || path.startsWith("/") || path.includes("../")) return null;
  if (!/\.md$/iu.test(path)) path += ".md";
  return path;
}

function indexPathForKnowledge(path) {
  const directory = path.split("/").slice(0, -1).join("/");
  const name = directory.split("/").at(-1);
  return `${directory}/${name}-索引.md`;
}

function registeredIds(items, kind) {
  const result = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = kind === "skill" ? item?.name || item?.id : item?.id;
    if (typeof id !== "string" || !id) continue;
    const paths = new Set([item?.path, item?.configPath, item?.descriptionPath].filter((value) => typeof value === "string"));
    result.set(id, paths);
  }
  return result;
}

function detectDuplicateCapabilities(controlNotes, registeredAgents, registeredSkills, issues) {
  const agentIds = registeredIds(registeredAgents, "agent");
  const skillIds = registeredIds(registeredSkills, "skill");
  for (const note of controlNotes) {
    const path = safePath(note?.path);
    const content = typeof note?.content === "string" ? note.content.slice(0, 128_000) : "";
    if (!content || /-索引\.md$/iu.test(path)) continue;
    if (/\/技能\/.+\/SKILL\.md$/iu.test(path)) {
      const id = /^name:\s*([a-z0-9][a-z0-9-]{1,63})\s*$/mu.exec(content.slice(0, 8_000))?.[1];
      const canonical = id ? skillIds.get(id) : null;
      if (canonical && !canonical.has(path)) {
        addIssue(issues, "duplicate-skill-definition", "warning", path, `发现未注册的重复 Skill 定义：${id}`, id);
      }
    }
    if (/\/智能体\/.+\.md$/iu.test(path)) {
      const matches = new Set(content.match(/xingzhi-[a-z0-9-]{2,63}/gu) || []);
      for (const id of matches) {
        const canonical = agentIds.get(id);
        if (canonical && !canonical.has(path)) {
          addIssue(issues, "duplicate-agent-definition", "warning", path, `发现未注册的重复 Agent 定义：${id}`, id);
        }
      }
    }
  }
}

function isUnstructuredKnowledgeCandidate(note) {
  const path = safePath(note?.path);
  const content = typeof note?.content === "string" ? note.content : "";
  if (!content.trim() || path === "未知路径") return false;
  if (SOURCE_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (isStructuralKnowledge({ path })) return false;
  const systemType = /^type:\s*["']?([a-z0-9-]+)["']?\s*$/mu.exec(content.slice(0, 8_000))?.[1];
  if (systemType && SYSTEM_MANAGED_FORMAL_TYPES.has(systemType)) return false;
  if (/^---\r?\n[\s\S]{0,8000}?^xingzhiFormat:\s*(?:"structure-v1"|structure-v1)\s*$/mu.test(content)) return false;
  return true;
}

function scanKnowledgeHealth(input = {}) {
  const suppliedFormalNotes = Array.isArray(input.formalNotes) ? input.formalNotes : [];
  const suppliedControlNotes = Array.isArray(input.controlNotes) ? input.controlNotes : [];
  if (suppliedFormalNotes.length > MAX_FORMAL_NOTES || suppliedControlNotes.length > MAX_CONTROL_NOTES) {
    throw new Error("知识库笔记数量超过安全扫描上限");
  }
  const formalNotes = suppliedFormalNotes.filter((note) => FORMAL_ROOT_SET.has(safePath(note?.path).split("/")[0]));
  const controlNotes = suppliedControlNotes.filter((note) => safePath(note?.path).split("/")[0] === "10_智能体与技能");
  const issues = [];
  const knowledge = [];
  const lifecycleRecords = [];
  const distribution = new Map();
  const ids = new Map();
  const allPaths = new Set(formalNotes.map((note) => safePath(note?.path)).filter((path) => path !== "未知路径"));
  const indexNotes = new Map();
  const notesByPath = new Map(formalNotes.map(note => [note.path, note]));
  const sourceInventory = new Map((input.sourceInventory || []).map(item => [item.path, item.exists]));
  let generated = 0;
  let malformed = 0;
  let legacySchema = 0;
  let unstructured = 0;
  let semanticReview = 0;
  let missingProvenance = 0;
  let splitCandidates = 0;

  for (const note of formalNotes) {
    const path = safePath(note?.path);
    if (/-索引\.md$/iu.test(path)) {
      indexNotes.set(path, typeof note?.content === "string" ? note.content : "");
      const markerState = inspectIndexMarkers(note?.content).state;
      if (markerState === "damaged") {
        addIssue(issues, "damaged-index-markers", "error", path, "自动索引标记缺失、重复或顺序错误，已禁止自动覆盖。");
      }
    }
    const inspected = inspectHealthNote(note);
    if (!inspected.generated) {
      if (isUnstructuredKnowledgeCandidate(note)) {
        unstructured += 1;
        addIssue(issues, "unstructured-knowledge-note", "info", path, "发现一条位于正式知识目录、但尚未采用行知知识结构的旧笔记。");
      }
      continue;
    }
    generated += 1;
    if (inspected.malformed) {
      malformed += 1;
      addIssue(issues, "malformed-knowledge-note", "error", path, "行知知识 Frontmatter 无法通过严格校验。");
      continue;
    }
    const directory = path.split("/").slice(0, -1).join("/");
    distribution.set(directory, (distribution.get(directory) || 0) + 1);
    const hasCanonicalSchema = inspected.record && (inspected.record.format === "reference-v1" || inspected.schemaFields.includes("entityId"));
    const missing = hasCanonicalSchema ? [] : MODERN_SCHEMA_FIELDS.filter((field) => !inspected.schemaFields.includes(field));
    if (missing.length) {
      legacySchema += 1;
      addIssue(issues, "legacy-schema", "warning", path, `知识仍使用旧字段集合，缺少：${missing.join("、")}。`, missing.join(","));
    }
    if (!ids.has(inspected.knowledgeId)) ids.set(inspected.knowledgeId, []);
    ids.get(inspected.knowledgeId).push(path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(inspected.knowledgeId)) {
      addIssue(issues, "invalid-knowledge-id", "error", path, "知识编号包含不允许的字符或超过长度上限。");
    }
    let expectedRoot = null;
    try {
      expectedRoot = inspected.record?.recordClass === "business-reference" ? "12_资料库" : routeKnowledgeCandidate({ knowledgeType: inspected.knowledgeType }).directory.split("/")[0];
    } catch {
      addIssue(issues, "unsupported-knowledge-type", "error", path, `不支持的知识类型：${inspected.knowledgeType}`);
    }
    const actualRoot = path.split("/")[0];
    if (expectedRoot && expectedRoot !== actualRoot) {
      addIssue(issues, "knowledge-root-mismatch", "error", path, `知识类型应位于 ${expectedRoot}，当前位于 ${actualRoot}。`);
    }
    for (const relation of inspected.relatedKnowledge) {
      const target = normalizeLinkPath(relation?.path);
      if (target && !allPaths.has(target)) {
        addIssue(issues, "broken-related-link", "warning", path, `关联知识不存在：${target}`, target);
      }
    }
    const card = knowledgeCard(note, inspected);
    card.schema = missing.length ? "legacy" : "current";
    const manifest = inspected.manifest || readKnowledgeManifest(note);
    const missingSemanticFields = [
      !(typeof manifest?.summary === "string" && manifest.summary.trim()) ? "核心总结" : null,
      !(Array.isArray(manifest?.keyPoints) && manifest.keyPoints.some((item) => typeof item === "string" && item.trim())) ? "核心知识点" : null,
      !(Array.isArray(manifest?.suggestedUses) && manifest.suggestedUses.some((item) => typeof item === "string" && item.trim())) ? "建议用途" : null,
    ].filter(Boolean);
    if (missingSemanticFields.length || card.summaryState === "needs-review") {
      semanticReview += 1;
      addIssue(
        issues,
        "semantic-structure-incomplete",
        "warning",
        path,
        `知识需要补充或复核：${missingSemanticFields.length ? missingSemanticFields.join("、") : "现有摘要无法安全提炼"}。`,
        missingSemanticFields.join(",") || "needs-review",
      );
    }
    const hasLegacySource = [...note.content.matchAll(/^(?:来源对话|来源消息|文档证据):[ \t]*(.*)$/gmu)]
      .some((match) => match[1].trim() && !['""', "''"].includes(match[1].trim()));
    const hasSource = Boolean(inspected.sourceConversationPath || inspected.sourceMessageId
      || (Array.isArray(inspected.sourceDocuments) && inspected.sourceDocuments.length)
      || (Array.isArray(inspected.lifecycleSources) && inspected.lifecycleSources.length)
      || hasLegacySource);
    if (!hasSource) {
      missingProvenance += 1;
      addIssue(issues, "missing-source-provenance", "warning", path, "来源对话、来源消息和来源文档均为空。", inspected.knowledgeId);
    }
    if (typeof manifest?.content === "string" && manifest.content.length > SPLIT_CANDIDATE_CHARS) {
      splitCandidates += 1;
      addIssue(issues, "knowledge-split-candidate", "info", path, `核心知识内容为 ${manifest.content.length} 字，超过 ${SPLIT_CANDIDATE_CHARS} 字的拆分复核阈值。`, String(manifest.content.length));
    }
    card.provenance = inspectSourceIntegrity(inspected, notesByPath, sourceInventory, issues);
    if (!hasSource) card.provenance.status = "missing";
    card.reviewStatus = inspected.record?.reviewStatus || null;
    card.retrievalEligible = inspected.record?.retrievalEligible ?? true;
    if (card.reviewStatus === "candidate-review") {
      card.statusLabel = "待审核";
      addIssue(issues, "candidate-awaiting-review", "info", path, "当前记录仍标记待审核；保留展示并从默认可信检索中排除。", inspected.knowledgeId);
    }
    knowledge.push(card);
    lifecycleRecords.push({
      ...inspected,
      generated: true,
      malformed: false,
      contentHash: crypto.createHash("sha256").update(note.content, "utf8").digest("hex"),
    });
  }

  for (const [id, paths] of ids) {
    if (paths.length < 2) continue;
    for (const path of paths) addIssue(issues, "duplicate-knowledge-id", "error", path, `知识编号重复：${id}`, id);
  }
  for (const item of knowledge) {
    const indexPath = indexPathForKnowledge(item.path);
    const index = indexNotes.get(indexPath);
    if (index === undefined) {
      addIssue(issues, "missing-index-file", "error", item.path, `缺少目录索引：${indexPath}`, indexPath);
    } else if (!index.includes(`[[${item.path.replace(/\.md$/iu, "")}|`)
      && !index.includes(`[[${item.path.replace(/\.md$/iu, "")}]]`)
      && !index.includes(`[[${item.path.replace(/\.md$/iu, "")}#`)) {
      addIssue(issues, "index-unlisted", "info", item.path, `正式知识尚未收录到 ${indexPath}。`, indexPath);
    }
  }
  detectDuplicateCapabilities(controlNotes, input.registeredAgents, input.registeredSkills, issues);
  const lifecycle = scanKnowledgeLifecycle({
    records: lifecycleRecords,
    now: typeof input.now === "string" ? input.now : undefined,
  });
  issues.sort((left, right) => (
    (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
      || left.path.localeCompare(right.path, "zh-CN") || left.code.localeCompare(right.code)
  ));
  knowledge.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  return {
    presentationVersion: 1,
    generatedAt: typeof input.now === "string" ? input.now : new Date().toISOString(),
    totals: {
      scanned: formalNotes.length,
      generated,
      valid: knowledge.length,
      malformed,
      legacySchema,
      unstructured,
      semanticReview,
      missingProvenance,
      splitCandidates,
      issues: issues.length,
      lifecycleCandidates: lifecycle.totals.candidates,
    },
    distribution: [...distribution.entries()]
      .map(([directory, count]) => ({ directory, count }))
      .sort((left, right) => left.directory.localeCompare(right.directory, "zh-CN")),
    knowledge,
    issues,
    lifecycle,
  };
}

module.exports = { MODERN_SCHEMA_FIELDS, scanKnowledgeHealth, inspectHealthNote, collectSourceInventory };
