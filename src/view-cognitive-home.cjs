"use strict";

const { Component, ItemView, Menu, Notice, setIcon } = require("obsidian");
const { CognitiveRecordModal } = require("./view-cognitive-forms.cjs");
const { watchDailyReview } = require("./view-daily-refresh.cjs");
const { LOOP_STATUS, normalizePreferences, pendingConfirmations, buildHomeModel } = require("./home-model.cjs");
const { HomeDialog, HomeSearch, addButton, openList, openQuestion, openPathGuide, openFocus, openConfirmations } = require("./home-dialogs.cjs");
const { HOLDS_PATH } = require("./cognitive-records.cjs");
const { PANEL_ICONS, applyChatArt } = require("./reference-ui.cjs");

const VIEW_TYPE_COGNITIVE_HOME = "xingzhi-cognitive-home";
const WORKBENCH_TYPE = "xingzhi-workbench-view";
const EPISTEMIC_LABELS = { fact: "记录事实", "user-statement": "本人自述", inference: "推断", hypothesis: "待验证假设", "value-judgment": "价值判断", unknown: "尚待确认" };

// These exports are also consumed by the existing growth view.
function button(parent, label, action, primary = false) {
  const element = parent.createEl("button", { text: label, cls: primary ? "mod-cta" : "", attr: { type: "button" } });
  element.onclick = () => Promise.resolve().then(action).catch(error => new Notice(error?.message || "操作未完成"));
  return element;
}
function glyph(parent, name, cls = "") {
  const span = parent.createSpan({ cls, attr: { "aria-hidden": "true" } }); setIcon(span, name); return span;
}
function plainDate(value) {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "日期未记录";
}

// The 0.40 workbench exposes the historical `capture` section only as a
// command name; its navigate() implementation falls back to chat for unknown
// sections. Prefer a dedicated API when a newer plugin provides one, and use
// the stable local Inbox as the compatibility target for older builds.
function openCapture(home) {
  if (typeof home.plugin?.openCapture === "function") return home.plugin.openCapture();
  if (typeof home.plugin?.openVaultPath === "function") {
    return home.plugin.openVaultPath("12_资料库/00_Inbox/00_索引.md");
  }
  return home.plugin?.activateWorkbench?.("capture");
}

// ---- 2026-09 PATH 首页（.xz-wb）。唯一首页布局；旧版经典首页已于 2026-09 删除。 ----
const WB_PATH = [
  { name: "观境", en: "PERCEIVE", verb: "知位", desc: "在现实中找到自己的坐标", icon: "mountain" },
  { name: "立心", en: "ANCHOR", verb: "定向", desc: "明所欲，定所守", icon: "target" },
  { name: "践真", en: "TEST", verb: "求实", desc: "以行问世，由事求真", icon: "footprints" },
  { name: "知变", en: "HONE", verb: "生慧", desc: "知所变，亦知所不变", icon: "refresh-cw" },
];
const WB_NEXT = ["写下你看到的局面", "说清要守住什么", "去做一次真实的尝试", "记录现实给的反馈"];
const WB_QUOTES = [
  { text: "知所变，亦知所不变。", source: "行知 PATH" },
  { text: "观境以知位，立心以定向；\n践真以求实，知变以生慧。", source: "行知 PATH" },
  { text: "行动是提问，不是答案。", source: "践真" },
];
const WB_ARCS = ["M62 19 A34 34 0 0 1 81 38", "M81 62 A34 34 0 0 1 62 81", "M38 81 A34 34 0 0 1 19 62", "M19 38 A34 34 0 0 1 38 19"];
function svgEl(parent, tag, attrs = {}) {
  const element = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  parent.appendChild(element); return element;
}
// 链路阶段由记录字段推出，不靠手填：有反馈=知变，有行动=践真，有目标或判断=立心，否则=观境。
function loopStage(loop) {
  if (!loop) return 0;
  if (Array.isArray(loop.feedbacks) && loop.feedbacks.length) return 3;
  if (String(loop.action || "").trim()) return 2;
  if (String(loop.goal || "").trim() || String(loop.judgment || "").trim()) return 1;
  return 0;
}
function monthDay(value) {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日` : "日期未记录";
}
function dayDiff(value, now = new Date()) {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return null;
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 864e5);
}
const stripBecause = value => String(value || "").replace(/^因为[:：]?\s*/u, "");

// ---- 立心页（.xz-wb[data-page="anchor"]）：明所欲 · 知所重 · 定所守 ----
// 页面背景：素材板只供五个页面的顶部大背景裁切，不注入侧栏、卡片或空状态。
// 每页一张底图：同一张拼版里有多条宽幅长条，靠 styles.css 末尾「页面大背景」块的
// background-position 各取一条，所以键可以复用文件而画面不同。
// 注意：sheet / sheet-b / sheet-c 刻意不在此表内 —— 那些裁切百分比是按旧的
// elements-a/b/c(1448×1086 / 1254²) 算的，指向这几张 board 会裁出错位碎片。
// 缺键时 loadAnchorArt 跳过、CSS 回落，面板配图整块不显示，属预期行为。
// 按皮肤分表。gold = 暖金拼版（多条长条共用一张，靠 background-position 取景）；
// ink = 水墨成幅立轴（约 3:1 白底，整张铺满，不需要取景）。
// 缺文件时 loadAnchorArt 跳过该键 → CSS 回落，不会崩。
const ANCHOR_ART_BY_SKIN = {
  gold: [
    // 暖金皮肤：5张独立横版hero图 + 侧栏背景 + 元素拼图
    ["home", "xz-gold-hero-1.png"],      // 首页：亭台楼阁+江河全景
    ["hero", "xz-gold-hero-1.png"],      // 立心：复用首页图
    ["perceive", "xz-gold-hero-2.png"],  // 观境：石阶向上
    ["test", "xz-gold-hero-5.png"],      // 践真：践行横版
    ["hone", "xz-gold-hero-4.png"],      // 知变：藏知横版
    ["archive", "xz-gold-hero-4.png"], // 独立山水，不把带多个分区的素材拼版当作横幅
    ["tune", "xz-gold-tune-hero.png"],   // 调律：窄横幅（1398×216，已裁好）
    ["side-river", "xz-gold-side-river.png"],
    ["sheet", "xz-gold-elements-a.png"],
    ["sheet-b", "xz-gold-elements-a.png"],
    ["sheet-c", "xz-gold-elements-a.png"],
  ],
  ink: [
    // 水墨皮肤：3张独立横版hero图 + 侧栏背景 + 元素拼图
    ["home", "xz-ink-hero-main.png"],
    ["hero", "xz-ink-hero-main.png"],
    ["perceive", "xz-ink-hero-alt1.png"],
    ["test", "xz-ink-hero-alt2.png"],
    ["hone", "xz-ink-hero-alt1.png"],
    ["archive", "xz-ink-hero-main.png"],
    ["tune", "xz-ink-hero-alt2.png"],    // 调律：水墨没有专门横幅，复用 alt2
    ["side-river", "xz-ink-side-river.png"],
    ["sheet", "xz-ink-hero-main.png"],
    ["sheet-b", "xz-ink-hero-main.png"],
    ["sheet-c", "xz-ink-hero-main.png"],
  ],
};
const WB_PAGES = ["home", "anchor", "perceive", "test", "hone", "archive", "tune"];
const WB_STEP_PAGES = ["perceive", "anchor", "test", "hone"];
// 调律页用的本地常量。打包后每个 .cjs 是独立作用域，workbench-runtime 那边的
// MAX_PRIMARY_SKILLS / PROVIDER_ORDER / SKILL_MODE_OPTIONS 在这里拿不到，只能对齐着抄一份。
// 这两个数字与 dynamic-capability-runtime.cjs 的 MAX_PRIMARY_SKILLS / MAX_AUXILIARY_SKILLS 对齐，改那边要同步这里。
const TUNE_MAX_PRIMARY = 1;
const TUNE_MAX_AUX = 3;
const TUNE_PROVIDER_LABELS = { codex: "Codex", openai: "OpenAI", deepseek: "DeepSeek", kimi: "Kimi", custom: "自定义中转" };
const TUNE_PROVIDER_SUB = { codex: "本地应用", openai: "官方 API", deepseek: "官方 API", kimi: "官方 API", custom: "兼容 API" };
// connection.status 的五个真实取值 + 空值
const TUNE_CONN_TEXT = { connected: "连接正常", configured: "已填好，还没试过", connecting: "正在连接", error: "连不上", idle: "还没试过" };
const TUNE_CONN_CLASS = { connected: "ok", configured: "idle", connecting: "warn", error: "bad", idle: "idle" };
const TUNE_GRANT_TEXT = { "not-required": "本地引擎，无需授权", authorized: "已授权，锁定到此连接", locked: "未授权外部发送" };
const TUNE_SKILL_MODES = Object.entries(require("./skill-call-state.cjs").SKILL_MODE_LABELS);
const TUNE_AGENT_MODES = [["orchestrator", "自动调度"], ["smart-route", "智能推荐"], ["locked", "手动锁定"]];
const TUNE_SKINS = [["gold", "暖金山水"], ["ink", "水墨"]];
// 与 ./view-skill-picker.cjs 的「可用透镜」面板完全一致的两个取值函数。
// bundle 每个模块独立作用域，无法 require，只能镜像一份；改那边要同步改这里。
// 标识字段是 name（值形如 xingzhi-first-principles），中文名在 displayName / label。
function skillId(skill) {
  return String(skill?.name || skill?.id || "").trim();
}
function skillLabel(skill, fallback) {
  return String(skill?.displayName || skill?.label || skill?.title || fallback || "Skill").trim();
}
const TUNE_LICENSE_TEXT = { ACTIVE: "已激活", EXPIRING: "即将到期", EXPIRED: "已过期", UNACTIVATED: "未激活", NOT_STARTED: "尚未开始", INVALID: "无效" };
// UI 置灰用的活跃状态集合，比 updateSettings 的硬拦截（只认 streaming）更宽。
const TUNE_ACTIVE_TURN = new Set(["running", "in_progress", "streaming", "starting", "waiting", "waiting_approval"]);
const HOLD_PROMPTS = ["最近一次，你拒绝了什么？为什么？", "什么东西，给多少钱你都不换？", "哪一次让步，事后让你后悔？"];
const SPECULATIVE = new Set(["hypothesis", "inference", "unknown"]);
// 只有日期的字符串按本地零点解析，避免西半球时区显示成前一天。
function localDay(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? new Date(`${text}T00:00:00`) : new Date(text);
}
function todayText(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function latestTest(hold) {
  const tests = Array.isArray(hold?.tests) ? hold.tests : [];
  return [...tests].sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) || null;
}
function holdCounts(hold) {
  const tests = Array.isArray(hold?.tests) ? hold.tests : [];
  const kept = tests.filter(test => test.kept).length;
  return { total: tests.length, kept, yielded: tests.length - kept };
}
function dialogField(parent, label, { multiline = false, value = "", placeholder = "", max = 4000, hint = "" } = {}) {
  const row = parent.createEl("label", { cls: "field" }); row.createSpan({ text: label });
  if (hint) row.createEl("small", { text: hint });
  const input = multiline
    ? row.createEl("textarea", { attr: { rows: "3", maxlength: String(max), placeholder } })
    : row.createEl("input", { attr: { type: "text", maxlength: String(max), placeholder } });
  input.value = value || ""; return input;
}

// ---- 观境页（.xz-wb[data-page="perceive"]）：知时 · 察势 · 定位 ----
// 不新增存储：局面按已有记录的 epistemicStatus 分栏，判断与未知来自行动记录里的判断快照。
const PERCEIVE_SEEN = new Set(["fact", "user-statement"]);
const PERCEIVE_READ = new Set(["inference", "hypothesis", "value-judgment"]);
const PERCEIVE_TAG = { fact: "事实", "user-statement": "你说的", inference: "推断", hypothesis: "假设", "value-judgment": "价值判断", unknown: "尚待确认" };
const PERCEIVE_STRATA = [["fact", "事实"], ["said", "你说的"], ["read", "解读"], ["unk", "还不知道"]];
const PERCEIVE_CONF = { unknown: [0, "还不确定"], low: [1, "低"], medium: [2, "中"], high: [3, "高"] };
const PERCEIVE_COORDS = [["知时", "这个时代，什么在变多，什么在变少？"], ["察势", "你所在的领域，正往哪个方向走？"], ["定位", "你手里有什么，缺什么？"]];
const PERCEIVE_FIELDS = [
  ["q", "眼下的问题", "一句话，写成可以回答的问题", "例如：下个季度该继续做现在的项目，还是换方向？"],
  ["seen", "发生了什么", "只写看到的、别人说的，一行一条", "例如：9 月有 7 人试用，走完一整轮的有 3 人"],
  ["think", "我怎么看", "你的推想、担心、偏好", "例如：新用户卡住，是因为不知道第一条该写什么"],
  ["unsure", "还不确定什么", "写出来，它就能被查证", "例如：他们的付费意愿，是不是因为我们认识"],
];
const emptyPerceiveDraft = () => ({ q: "", seen: "", think: "", unsure: "" });

// ---- 践真页（.xz-wb[data-page="test"]）/ 知变页（.xz-wb[data-page="hone"]）：不新增存储，全部从行动记录推出 ----
const TEST_FILTERS = [["all", "全部在验"], ["over", "已逾期"], ["week", "七天内回看"], ["none", "未定回看"]];
const CAL_LABEL = { supported: "印证", weakened: "动摇", falsified: "落空", uncertain: "还说不清", held: "暂且不改" };
const DECISION_LABEL = { continue: "继续", adjust: "调整", stop: "停止", uncertain: "还说不清" };
const HONE_CAUSES = [["prediction", "判断本身错了"], ["execution", "没按原计划做"], ["environment", "情况变了"], ["evidence", "当时依据就不足"]];
const calOf = feedback => {
  const status = feedback?.judgmentCalibration?.status;
  return ["supported", "weakened", "falsified"].includes(status) ? status : "uncertain";
};
const feedbackTime = feedback => feedback?.occurredAt || feedback?.recordedAt || feedback?.createdAt || "";
const timeOf = value => { const time = new Date(value || "").getTime(); return Number.isFinite(time) ? time : 0; };
const isRevision = feedback => {
  const revised = String(feedback?.revisedJudgment || "").trim();
  return Boolean(revised) && revised !== String(feedback?.previousJudgment || "").trim();
};
const feedbackWhy = feedback => String(feedback?.userInterpretation || feedback?.interpretation || feedback?.impactOnJudgment || "").trim();
const bindingOf = (loop, key) => String(loop?.actionBinding?.[key] || loop?.[key] || "").trim();
function testWhen(loop) {
  const n = loop?.reviewAt ? dayDiff(localDay(loop.reviewAt)) : null;
  if (n === null) return { key: "none", big: "未定回看", small: "还没定哪天回来看", n: null };
  const date = monthDay(localDay(loop.reviewAt));
  if (n < 0) return { key: "over", big: `逾期 ${-n} 天`, small: `${date} 该回看`, n };
  if (n === 0) return { key: "today", big: "今天回看", small: date, n };
  if (n <= 7) return { key: "soon", big: `${n} 天后`, small: `${date} 回看`, n };
  return { key: "later", big: date, small: `${n} 天后`, n };
}
function testWindow(loop) {
  const value = bindingOf(loop, "observationWindow");
  if (!value || value === String(loop?.reviewAt || "") || /^\d{4}-\d{2}-\d{2}/u.test(value)) return "";
  return value;
}
function perceiveKind(status) {
  return status === "fact" ? "fact" : status === "user-statement" ? "said" : status === "unknown" ? "unk" : "read";
}
function perceiveClip(value, max) {
  const text = String(value || "").trim(); return text.length > max ? `${text.slice(0, max)}…` : text;
}
function perceiveFileName(path) {
  return String(path || "").split("#")[0].split("/").pop().replace(/\.md$/u, "") || "未命名记录";
}
function perceiveSource(record) {
  const folder = String(record.path || "").split("/")[0].replace(/^\d+_/u, "");
  return `${folder || "记录"} · ${monthDay(record.updatedAt)}`;
}
// 只做如实的比较，不打分：解读多于看到的，或一条事实都没有时提醒。
function strataReading(n) {
  const seen = n.fact + n.said, total = seen + n.read + n.unk;
  if (!total) return null;
  if (n.read > seen) return { text: `解读（${n.read}）比看到的（${seen}）多。行动之前，先确认其中最关键的一条。`, lean: true };
  if (!n.fact) return { text: "目前还没有一条可以独立核实的事实，全部来自陈述和推想。", lean: true };
  return { text: `看到的 ${seen} 条，解读 ${n.read} 条，还不知道 ${n.unk} 条。`, lean: false };
}
function situationPrompt(draft) {
  const lines = value => String(value || "").split(/\n+/u).map(line => line.trim()).filter(Boolean);
  const block = (title, value) => { const list = lines(value); return list.length ? `\n${title}：\n${list.map(line => `- ${line}`).join("\n")}` : ""; };
  return `我想用观境看清一个局面。\n眼下的问题：${String(draft.q || "").trim()}`
    + block("发生了什么（我看到的、别人说的）", draft.seen) + block("我怎么看", draft.think) + block("我还不确定的", draft.unsure)
    + "\n请帮我把看到的和以为的分开，指出哪些“事实”其实是解读，并列出最能改变我下一步选择的未知。";
}

// ---- 藏知页（.xz-wb[data-page="archive"]）：只读已有笔记，不新增存储 ----
// 全部连线都来自真实字段：relatedKnowledge、supersededBy、sourceConversationPath、
// sourceDocuments、判断快照的 evidencePaths、笔记里的 [[双链]]。虚线只是待确认的线索。
const ARC_TYPE = { cognitive: "认知资产", decision: "决策", project: "项目", action: "行动", feedback: "反馈", note: "笔记", index: "索引", list: "列表" };
const ARC_REL = { related: "相关", supports: "支持", "depends-on": "依赖", "evidence-for": "提供证据", updates: "更新", contradicts: "存在冲突" };
const ARC_ROOT = "09_认知资产/";
const ARC_INBOX = ["09_认知资产/对话沉淀/", "12_资料库/"];
const ARC_FILTERS = [["all", "全部"], ["linked", "已连上"], ["lone", "还没连上"], ["cited", "被引用过"],
  ["soft", "还站不稳"], ["old", "被更新过"], ["plain", "未结构化"]];
const ARC_REST = { src: 96, rel: 128, rev: 84, cite: 112, infer: 156 };
const ARC_PULL = { src: 1, rel: 0.9, rev: 1.25, cite: 0.7, infer: 0.3 };
const ARC_EDGE_NAME = { src: "来自", rel: "关联", rev: "更新", cite: "引用", infer: "可能相关" };
const arcKey = value => String(value || "").trim().toLowerCase();
const arcName = path => String(path || "").split("/").at(-1)?.replace(/\.md$/iu, "") || "未命名";
const arcPair = (a, b) => [a, b].sort().join("~");
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// 对话侧 promotion_status 的真实取值：organized / pending-review / pending-confirmation / completed / failed
// （renderConversationOrganizationMarkdown 与 recordPromotion 两处写入）。
// organized 与 completed 表示这轮对话没有留下需要你判断的东西，绝不进待入藏 —— 这是「不是每个对话都放进来」的关键。
const ARC_PENDING_PROMOTION = new Set(["pending", "failed", "pending-review", "pending-confirmation", "candidate-awaiting-review", "needs-review"]);
// 文档侧 knowledge_status 的真实取值只有 pending / completed / interrupted / failed
// （updateDocumentEvidenceKnowledgeStatus 会校验），completed 不算待入藏。
const ARC_PENDING_DOCUMENT = new Set(["pending", "failed", "interrupted", "pending-review", "pending-confirmation", "candidate-awaiting-review", "needs-review"]);
const arcValues = value => (Array.isArray(value) ? value : value ? [value] : [])
  .map(item => String(item || "").trim()).filter(Boolean);
function arcInboxMeaning(file, frontmatter = {}) {
  const path = String(file?.path || "");
  if (path.startsWith("09_认知资产/对话沉淀/")) {
    if (arcKey(frontmatter.type) !== "conversation-knowledge-entry") return null;
    const status = arcKey(frontmatter.promotion_status);
    if (!ARC_PENDING_PROMOTION.has(status)) return null;
    const topics = arcValues(frontmatter.topics).slice(0, 2);
    const subject = topics.length ? `“${topics.join("、")}”` : "本轮内容";
    if (status === "failed") {
      // 失败原因写在正文的「候选检查结果」里，不在 frontmatter，这里只指路。
      return {
        statusLabel: "入藏未完成",
        reason: `${subject}已经形成候选并尝试入藏，但过程没有走完；原文末尾的「候选检查结果」写着具体原因。确认它仍会影响后续判断，再重试一次。`,
      };
    }
    if (status === "pending-confirmation") {
      return {
        statusLabel: "等待确认",
        reason: `${subject}中形成了达到复用门槛的命题，等待你确认是否值得进入正式知识。`,
      };
    }
    return {
      statusLabel: "需要审核",
      reason: `${subject}含有重大、敏感、冲突、替换或低置信度候选；只有核对来源与适用边界后才应入藏。`,
    };
  }
  if (path.startsWith("12_资料库/")) {
    const sourceKind = arcKey(frontmatter.source_kind);
    const sourceClass = arcKey(frontmatter.source_class);
    // spreadsheet-index 是系统为表格生成的结构化索引，也带 source_class: reference-library，
    // 但它不是用户主动导入、请求整理的资料，不该出现在待入藏。
    if (sourceKind === "spreadsheet-index") return null;
    if (sourceKind !== "uploaded-document" && sourceClass !== "reference-library") return null;
    const status = arcKey(frontmatter.knowledge_status);
    if (!ARC_PENDING_DOCUMENT.has(status)) return null;
    if (status === "failed" || status === "interrupted") {
      const error = perceiveClip(frontmatter.knowledge_error, 88);
      return {
        statusLabel: status === "interrupted" ? "整理被中断" : "整理未完成",
        reason: `这份资料曾明确启动知识整理，但处理没有完成${error ? `：${error}` : ""}。仅在它仍会影响后续判断或行动时重试。`,
      };
    }
    if (["pending-review", "pending-confirmation", "candidate-awaiting-review", "needs-review"].includes(status)) {
      return {
        statusLabel: "等待审核",
        reason: "这份主动导入的资料已经形成知识候选，但来源、结论或适用范围仍需人工核对。",
      };
    }
    return {
      statusLabel: "尚未整理",
      reason: "这份资料由你主动导入并请求整理，但尚未判断其中是否有可复用命题；只有确实会影响后续判断或行动时才入藏。",
    };
  }
  return null;
}

function confirmHomeDestructiveAction(home, {
  title = "确认删除",
  message = "确认继续吗？",
  confirmLabel = "移入回收站",
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    const dialog = new HomeDialog(home, title, (body, modal) => {
      body.createEl("p", { cls: "dialog-note", text: message });
      const footer = body.createDiv({ cls: "dialog-actions" });
      addButton(footer, "取消", () => modal.close());
      const confirm = footer.createEl("button", {
        cls: "mod-warning",
        text: confirmLabel,
        attr: { type: "button" },
      });
      confirm.addEventListener("click", () => {
        settle(true);
        modal.close();
      });
    });
    const close = dialog.onClose.bind(dialog);
    dialog.onClose = () => {
      close();
      settle(false);
    };
    dialog.open();
  });
}

// 知识星图：手写力导向布局。位置缓存在视图上，翻页回来不会重排；只画上面列出的真实关系。
class WbStarMap {
  constructor(host, { pos = new Map(), reduced = false, mini = false, onSelect = () => {} } = {}) {
    Object.assign(this, { host, pos, reduced, mini, onSelect });
    this.nodes = []; this.edges = []; this.byId = new Map();
    this.view = { x: 0, y: 0, k: 1 }; this.alpha = 0; this.target = 0;
    this.frame = 0; this.fitted = false; this.w = 600; this.h = 360; this.selected = null;
    this.svg = svgEl(host, "svg", { class: `wb-star${mini ? " is-mini" : ""}`, viewBox: "0 0 600 360", preserveAspectRatio: "xMidYMid meet", role: "img", focusable: "false", "aria-label": "知识星图" });
    this.scene = svgEl(this.svg, "g", { class: "wb-star-scene" });
    this.gEdge = svgEl(this.scene, "g", { class: "wb-star-edges" });
    this.gNode = svgEl(this.scene, "g", { class: "wb-star-nodes" });
    this.bind();
  }
  bind() {
    const point = event => {
      const rect = this.svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: 0, y: 0 };
      return { x: (event.clientX - rect.left) * this.w / rect.width, y: (event.clientY - rect.top) * this.h / rect.height };
    };
    this.svg.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const hit = event.target.closest?.(".wb-sn");
      const at = point(event);
      this.drag = { id: hit?.dataset.id || null, from: at, moved: 0, ox: this.view.x, oy: this.view.y };
      if (this.drag.id) {
        const node = this.byId.get(this.drag.id);
        if (node) { node.fixed = true; this.drag.node = node; }
        this.target = 0.5; this.kick();
      }
      try { this.svg.setPointerCapture(event.pointerId); } catch { /* 指针捕获不可用时仍可拖动 */ }
    });
    this.svg.addEventListener("pointermove", event => {
      if (!this.drag) return;
      const at = point(event);
      this.drag.moved += Math.abs(at.x - this.drag.from.x) + Math.abs(at.y - this.drag.from.y);
      if (this.drag.node) {
        this.drag.node.x = (at.x - this.view.x) / this.view.k;
        this.drag.node.y = (at.y - this.view.y) / this.view.k;
        this.fitted = true; this.draw();
      } else {
        this.view.x = this.drag.ox + (at.x - this.drag.from.x);
        this.view.y = this.drag.oy + (at.y - this.drag.from.y);
        this.fitted = true; this.apply();
      }
    });
    const release = event => {
      const drag = this.drag; this.drag = null;
      if (!drag) return;
      try { this.svg.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
      if (drag.node) drag.node.fixed = false;
      if (drag.id && drag.moved < 6) this.onSelect(drag.id);
      if (drag.id) { this.target = 0; this.kick(); }
    };
    this.svg.addEventListener("pointerup", release);
    this.svg.addEventListener("pointercancel", release);
    this.svg.addEventListener("wheel", event => {
      event.preventDefault();
      const at = point(event);
      const next = clamp(this.view.k * (event.deltaY < 0 ? 1.12 : 0.89), 0.4, 2.6);
      this.view.x = at.x - (at.x - this.view.x) * next / this.view.k;
      this.view.y = at.y - (at.y - this.view.y) * next / this.view.k;
      this.view.k = next; this.fitted = true; this.apply();
    }, { passive: false });
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.host);
    }
  }
  resize() {
    const w = Math.round(this.host.clientWidth) || this.w, h = Math.round(this.host.clientHeight) || this.h;
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.fit(true);
  }
  setData(nodes, edges) {
    const kept = new Map(this.nodes.map(node => [node.id, node]));
    this.nodes = nodes.map((raw, index) => {
      const old = kept.get(raw.id) || (this.pos.has(raw.id) ? { ...this.pos.get(raw.id), vx: 0, vy: 0 } : null);
      const angle = index * 2.399963, radius = 26 + Math.sqrt(index + 1) * 26;
      return Object.assign({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, fixed: false },
        old ? { x: old.x, y: old.y, vx: 0, vy: 0 } : null, raw);
    });
    this.byId = new Map(this.nodes.map(node => [node.id, node]));
    this.edges = edges.filter(edge => this.byId.has(edge.a) && this.byId.has(edge.b))
      .map(edge => ({ ...edge, from: this.byId.get(edge.a), to: this.byId.get(edge.b) }));
    for (const node of this.nodes) node.deg = 0;
    for (const edge of this.edges) { edge.from.deg += edge.kind === "infer" ? 0 : 1; edge.to.deg += edge.kind === "infer" ? 0 : 1; }
    this.build();
    this.fitted = false;
    if (this.reduced) { this.alpha = 1; for (let i = 0; i < 220; i += 1) this.step(); this.alpha = 0; this.fit(true); this.draw(); return; }
    this.alpha = 1; this.target = 0; this.kick();
  }
  build() {
    // Obsidian 的 empty() 扩展只保证 HTMLElement，这里用原生方式清空 SVG 组。
    while (this.gEdge.firstChild) this.gEdge.removeChild(this.gEdge.firstChild);
    while (this.gNode.firstChild) this.gNode.removeChild(this.gNode.firstChild);
    for (const edge of this.edges) {
      edge.el = svgEl(this.gEdge, "line", { class: `wb-se is-${edge.kind}`, "data-id": edge.id });
      svgEl(edge.el, "title").textContent = `${edge.from.label} ${edge.label || ARC_EDGE_NAME[edge.kind]} ${edge.to.label}`;
    }
    for (const node of this.nodes) {
      const group = svgEl(this.gNode, "g", {
        class: `wb-sn is-${node.kind}${node.old ? " is-old" : ""}${node.deg ? "" : " is-lone"}${node.soft ? " is-soft" : ""}`,
        "data-id": node.id,
      });
      if (node.kind === "s") svgEl(group, "rect", { class: "wb-sn-dot", x: -6, y: -6, width: 12, height: 12, rx: 2 });
      else if (node.kind === "j") svgEl(group, "path", { class: "wb-sn-dot", d: "M0 -9 9 0 0 9 -9 0Z" });
      else svgEl(group, "circle", { class: "wb-sn-dot", r: clamp(6 + node.deg * 1.4, 6, 14) });
      const text = svgEl(group, "text", { class: "wb-sn-label", y: node.kind === "k" ? 24 : 21, "text-anchor": "middle" });
      text.textContent = node.label.length > 12 ? `${node.label.slice(0, 12)}…` : node.label;
      if (this.mini || node.deg >= 2) group.classList.add("has-label");
      svgEl(group, "title").textContent = node.title || node.label;
      node.el = group;
    }
    this.mark();
  }
  mark() {
    const near = new Set();
    if (this.selected) {
      near.add(this.selected);
      for (const edge of this.edges) {
        if (edge.a === this.selected) near.add(edge.b);
        if (edge.b === this.selected) near.add(edge.a);
      }
    }
    for (const node of this.nodes) {
      node.el?.classList.toggle("is-sel", node.id === this.selected);
      node.el?.classList.toggle("is-near", Boolean(this.selected) && near.has(node.id) && node.id !== this.selected);
      node.el?.classList.toggle("is-dim", Boolean(this.selected) && !near.has(node.id));
      node.el?.classList.toggle("has-label", this.mini || node.deg >= 2 || near.has(node.id));
    }
    for (const edge of this.edges) {
      const on = Boolean(this.selected) && (edge.a === this.selected || edge.b === this.selected);
      edge.el?.classList.toggle("is-on", on);
      edge.el?.classList.toggle("is-dim", Boolean(this.selected) && !on);
    }
  }
  select(id) { this.selected = id || null; this.mark(); }
  step() {
    const nodes = this.nodes, count = nodes.length, alpha = this.alpha;
    if (!count) return;
    for (const node of nodes) {
      if (node.fixed) continue;
      node.vx -= node.x * 0.05 * alpha; node.vy -= node.y * 0.075 * alpha;
    }
    for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (i % 7) - 3 + 0.5; dy = (j % 5) - 2 + 0.5; d2 = dx * dx + dy * dy || 1; }
      const d = Math.sqrt(d2), force = Math.min(1400 / d2, 12) * alpha;
      const ux = dx / d * force, uy = dy / d * force;
      if (!a.fixed) { a.vx -= ux; a.vy -= uy; }
      if (!b.fixed) { b.vx += ux; b.vy += uy; }
    }
    for (const edge of this.edges) {
      const a = edge.from, b = edge.to;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const force = (d - (ARC_REST[edge.kind] || 120)) / d * 0.055 * alpha * (ARC_PULL[edge.kind] || 0.8);
      const ux = dx * force, uy = dy * force;
      if (!a.fixed) { a.vx += ux; a.vy += uy; }
      if (!b.fixed) { b.vx -= ux; b.vy -= uy; }
    }
    for (const node of nodes) {
      if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
      node.vx *= 0.6; node.vy *= 0.6;
      node.x += clamp(node.vx, -26, 26); node.y += clamp(node.vy, -26, 26);
    }
    this.alpha += (this.target - this.alpha) * 0.022;
  }
  kick() {
    if (this.frame || this.reduced) return;
    const tick = () => {
      this.frame = 0;
      if (!this.svg.isConnected) return;
      this.step(); this.draw();
      if (this.alpha < 0.12 && !this.fitted) { this.fit(true); this.fitted = true; }
      if (this.alpha > 0.012 || this.drag) this.frame = requestAnimationFrame(tick);
      else { this.alpha = 0; for (const node of this.nodes) this.pos.set(node.id, { x: node.x, y: node.y }); }
    };
    this.frame = requestAnimationFrame(tick);
  }
  stir() { this.alpha = Math.max(this.alpha, 0.85); this.kick(); }
  draw() {
    for (const edge of this.edges) {
      edge.el?.setAttribute("x1", edge.from.x.toFixed(1)); edge.el?.setAttribute("y1", edge.from.y.toFixed(1));
      edge.el?.setAttribute("x2", edge.to.x.toFixed(1)); edge.el?.setAttribute("y2", edge.to.y.toFixed(1));
    }
    for (const node of this.nodes) node.el?.setAttribute("transform", `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
    this.apply();
  }
  apply() { this.scene.setAttribute("transform", `translate(${this.view.x.toFixed(1)} ${this.view.y.toFixed(1)}) scale(${this.view.k.toFixed(3)})`); }
  fit(force = false) {
    if (!this.nodes.length || (this.fitted && !force)) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const node of this.nodes) { x0 = Math.min(x0, node.x); y0 = Math.min(y0, node.y); x1 = Math.max(x1, node.x); y1 = Math.max(y1, node.y); }
    const pad = this.mini ? 34 : 52;
    const width = Math.max(x1 - x0, 1), height = Math.max(y1 - y0, 1);
    this.view.k = clamp(Math.min((this.w - pad * 2) / width, (this.h - pad * 2) / height), 0.4, this.mini ? 1.3 : 1.6);
    this.view.x = this.w / 2 - (x0 + x1) / 2 * this.view.k;
    this.view.y = this.h / 2 - (y0 + y1) / 2 * this.view.k;
    this.apply();
  }
  zoomBy(factor) {
    const next = clamp(this.view.k * factor, 0.4, 2.6);
    this.view.x = this.w / 2 - (this.w / 2 - this.view.x) * next / this.view.k;
    this.view.y = this.h / 2 - (this.h / 2 - this.view.y) * next / this.view.k;
    this.view.k = next; this.fitted = true; this.apply();
  }
  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0; this.observer?.disconnect(); this.observer = null;
    for (const node of this.nodes) this.pos.set(node.id, { x: node.x, y: node.y });
    this.nodes = []; this.edges = []; this.byId = new Map();
  }
}

// 展开星图：整张图放大看，共用视图里的位置缓存，关掉时销毁自己的动画循环。
class ArchiveMapModal extends HomeDialog {
  constructor(home) {
    super(home, "知识星图", body => this.build(body));
  }
  build(body) {
    body.addClass("xz-arc-map-modal");
    const state = this.home.arcState || this.home.archiveState();
    body.createEl("p", { cls: "dialog-note", text: `${state.nodes.length} 个节点，${state.edges.length} 条连线。实线是笔记里真实写着的关系，虚线是待你确认的线索。` });
    const legend = body.createDiv({ cls: "wb-star-legend" });
    for (const [cls, text] of [["k", "知识"], ["s", "来源"], ["j", "判断"], ["rel", "关联"], ["rev", "更新"], ["infer", "待确认"]]) {
      legend.createSpan({ cls: `wb-slg is-${cls}`, text });
    }
    const host = body.createDiv({ cls: "wb-star-wrap is-full" });
    // 全图和小窗的节点集合不同，各用一份位置缓存，否则子图坐标会污染全图布局。
    this.map = new WbStarMap(host, {
      pos: this.home.wbArcFullPos = this.home.wbArcFullPos || new Map(),
      reduced: this.home.contentEl.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
      onSelect: id => {
        if (!id.startsWith("k:")) return this.home.archiveMapPick(id);
        this.home.selectArchive(id.slice(2));
        this.map.select(id);
        this.note.textContent = `已选中「${arcName(id.slice(2))}」，左侧列表和详情已同步。`;
        return null;
      },
    });
    this.note = body.createEl("p", { cls: "wb-arc-map-note", text: "拖动节点可以挪，滚轮缩放，点一下同步到列表。" });
    const acts = body.createDiv({ cls: "wb-arc-d-acts" });
    this.home.action(acts, "回到全图", "arc-modal-fit", () => this.map.fit(true), "wb-chip-btn");
    this.home.action(acts, "重新散开", "arc-modal-stir", () => this.map.stir(), "wb-chip-btn");
    requestAnimationFrame(() => {
      if (!this.map) return;
      this.map.resize();
      this.map.setData(state.nodes, state.edges);
      if (this.home.wbArcSelected) this.map.select(`k:${this.home.wbArcSelected}`);
    });
  }
  onClose() { this.map?.destroy(); this.map = null; super.onClose(); }
}

// One business implementation, hosted either by the legacy ItemView or by a
// genuine Component. Each host owns only its own contentEl and lifecycle.
function cognitiveWorkspaceClass(Base) { return class CognitiveWorkspace extends Base {
  constructor(leaf, plugin) {
    super(leaf); this.app = plugin.app; this.plugin = plugin; this.snapshot = null; this.loading = false;
    this.wbPage = "home"; this.wbSelectedHold = null; this.wbHoldDraft = { text: "", boundary: "" };
    this.wbPerceiveComposing = false; this.wbPerceiveDraft = emptyPerceiveDraft();
    this.wbTestFilter = "all"; this.wbHoneOpen = null; this.wbHoneCauses = new Map(); this.wbHoneKept = new Map();
    this.wbArcQuery = ""; this.wbArcFilter = "all"; this.wbArcSelected = null;
    this.wbArcDismissed = new Set(); this.wbArcPos = new Map(); this.wbArcMap = null;
    this.arcCatalog = null; this.arcState = null; this.arcError = ""; this.arcLoading = false; this.arcBusy = false;
    this.error = ""; this.preferences = normalizePreferences(); this.questionDraft = "";
    this.model = buildHomeModel(); this.refs = {}; this.closed = true;
  }
  getViewType() { return VIEW_TYPE_COGNITIVE_HOME; }
  getDisplayText() { return "行知首页"; }
  getIcon() { return "house"; }
  getState() { return { ...this.preferences }; }
  async setState(state, result) {
    const previousSkin = this.preferences?.skin;
    this.preferences = normalizePreferences(state);
    if (this.workbenchOwner) this.workbenchOwner.cognitivePreferences = { ...this.preferences };
    await super.setState(state, result);
    // 恢复工作区布局时也可能带着另一套皮肤进来，同样要重解析图片路径。
    if (previousSkin !== this.preferences.skin) void this.loadAnchorArt();
    if (!this.closed && this.root) {
      if (this.root.dataset.layout !== this.preferences.layout) this.buildLayout();
      else { this.applyPreferences(); this.renderData(); }
    }
  }
  setPreference(patch) {
    const previousLayout = this.preferences.layout;
    const previousSkin = this.preferences.skin;
    this.preferences = normalizePreferences({ ...this.preferences, ...patch });
    if (this.workbenchOwner) this.workbenchOwner.cognitivePreferences = { ...this.preferences };
    // 换皮肤要重新解析图片路径（表变了），异步完成后自己会再调 applyPreferences。
    if (previousSkin !== this.preferences.skin) void this.loadAnchorArt();
    if (this.root && previousLayout !== this.preferences.layout) this.buildLayout();
    else { this.applyPreferences(); this.renderData(); }
    this.app.workspace.requestSaveLayout?.();
  }
  statusLabel(status) { return LOOP_STATUS[status] || "状态待核对"; }

  restoreDrafts(drafts) {
    // Workspace state is data, not arbitrary properties/methods of this view.
    for (const [key, fields] of [["wbHoldDraft", ["text", "boundary"]], ["wbPerceiveDraft", ["q", "seen", "think", "unsure"]]]) {
      if (!drafts?.[key] || typeof drafts[key] !== "object") continue;
      for (const field of fields) if (typeof drafts[key][field] === "string") this[key][field] = drafts[key][field];
    }
    if (typeof drafts?.questionDraft === "string") this.questionDraft = drafts.questionDraft;
  }

  async onOpen() {
    this.closed = false;
    // The PATH decorator has already restored its store. Apply migrated UI
    // drafts before building inputs, never after rendering an empty form.
    if (this.initialDrafts) { this.restoreDrafts(this.initialDrafts); this.initialDrafts = null; }
    this.originalStyle = this.contentEl.getAttribute("style");
    this.contentEl.addClass("xz-cognitive-home-view");
    Object.assign(this.contentEl.style, { padding: "0", maxWidth: "none", height: "100%", minHeight: "0", overflow: "hidden" });
    this.buildLayout();
    this.unsubscribe = this.plugin.subscribe(() => this.onStateChange());
    if (this.app.vault.on) for (const event of ["modify", "create", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(event, (file, oldPath) => {
        if (/^(?:0[15678])_/u.test(file?.path || "") || /^(?:0[15678])_/u.test(oldPath || "")) this.scheduleRefresh();
        // 藏知读的是 09_认知资产与 12_资料库，不在上面的认知快照范围内，单独排一次重扫。
        if (/^(?:09|12)_/u.test(file?.path || "") || /^(?:09|12)_/u.test(oldPath || "")) this.scheduleArchiveRescan();
      }));
    }
    this.registerDomEvent(this.contentEl.ownerDocument, "keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k"
        && (this.root.contains(this.contentEl.ownerDocument.activeElement) || this.app.workspace.activeLeaf?.view === this)) {
        event.preventDefault(); new HomeSearch(this).open();
      }
    });
    this.stopDailyRefresh = watchDailyReview(this, this.plugin, () => { if (!this.closed) this.renderData(); });
    await this.loadLandscape();
    await this.loadAnchorArt();
    if (!this.closed) await this.refresh();
  }
  async onClose() {
    this.closed = true; clearTimeout(this.refreshTimer); clearTimeout(this.renderTimer); clearTimeout(this.arcTimer);
    this.wbArcMap?.destroy(); this.wbArcMap = null;
    this.unsubscribe?.(); this.stopDailyRefresh?.();
    this.contentEl.removeClass("xz-cognitive-home-view");
    if (this.originalStyle === null) this.contentEl.removeAttribute("style");
    else if (typeof this.originalStyle === "string") this.contentEl.setAttribute("style", this.originalStyle);
    this.contentEl.empty(); this.refs = {}; this.root = null;
  }
  onStateChange() {
    if (this.closed) return;
    const state = this.plugin.state || {};
    const signature = `${state.knowledgeTransactions?.length}:${state.runtime?.userContinuity?.completedAt}:${state.runtime?.cognitiveLastTransactionId}`;
    if (signature !== this.snapshotSignature) { this.snapshotSignature = signature; this.scheduleRefresh(); }
    const pendingSignature = pendingConfirmations(state).map(item => `${item.id}:${item.title}:${item.reason}`).join("|");
    if (pendingSignature !== this.pendingSignature) {
      this.pendingSignature = pendingSignature; clearTimeout(this.renderTimer);
      this.renderTimer = setTimeout(() => { if (!this.closed) this.renderData(); }, 100);
    }
  }
  scheduleRefresh() { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { if (!this.closed) void this.refresh(); }, 250); }
  async refresh() {
    if (this.closed) return;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true; this.error = ""; this.renderStatus();
    try { const snapshot = await this.plugin.getCognitiveSnapshot(); if (!this.closed) this.snapshot = snapshot; }
    catch (error) { if (!this.closed) this.error = error?.message || "未能读取本地认知记录"; }
    finally {
      this.loading = false;
      if (!this.closed) this.renderData();
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    }
  }
  async loadLandscape() {
    try {
      const directory = String(this.plugin.manifest?.dir || ".obsidian/plugins/xingzhi-workbench").replace(/\\/gu, "/").replace(/\/$/u, "");
      const path = `${directory}/home-landscape.png`;
      if (typeof this.app.vault.adapter.exists === "function" && !await this.app.vault.adapter.exists(path)) {
        this.landscapeAvailable = false;
        this.applyPreferences();
        return;
      }
      const url = this.app.vault.adapter.getResourcePath(path);
      // Kept on the view so a rebuild can re-apply it to the new root.
      this.landscapeUrl = `url(${JSON.stringify(url)})`;
      if (!this.closed && this.root) { this.landscapeAvailable = true; this.applyPreferences(); }
    } catch { this.landscapeAvailable = false; this.applyPreferences(); }
  }
  // 立心页素材：缺哪张就不设哪个变量，CSS 会回落到首页山景或纯色。
  async loadAnchorArt() {
    const art = {};
    const directory = String(this.plugin.manifest?.dir || ".obsidian/plugins/xingzhi-workbench").replace(/\\/gu, "/").replace(/\/$/u, "");
    // 水墨素材若尚未复制进插件目录，这一轮会全部 continue，art 为空 → CSS 回落到渐变底，
    // 页面仍可用。换皮肤时必须重跑本方法，否则变量还指向上一套图。
    const table = ANCHOR_ART_BY_SKIN[this.preferences?.skin] || ANCHOR_ART_BY_SKIN.gold;
    for (const [key, file] of table) {
      try {
        const path = `${directory}/${file}`;
        if (typeof this.app.vault.adapter.exists === "function" && !await this.app.vault.adapter.exists(path)) continue;
        art[key] = `url(${JSON.stringify(this.app.vault.adapter.getResourcePath(path))})`;
      } catch { /* 素材缺失不影响页面 */ }
    }
    // 先清掉上一套皮肤留下的变量：内联 style 不会因为换表而自动失效，
    // 否则缺图的那几个键会继续显示旧皮肤的图（半新半旧的错配）。
    for (const key of Object.keys(this.anchorArt || {})) {
      if (!(key in art)) this.root?.style.removeProperty(`--xz-anchor-${key}`);
    }
    this.anchorArt = art;
    if (!this.closed) this.applyPreferences();
  }
  applyPreferences() {
    if (!this.root) return;
    if (this.landscapeUrl) this.root.style.setProperty("--xz-home-landscape", this.landscapeUrl);
    for (const [key, value] of Object.entries(this.anchorArt || {})) this.root.style.setProperty(`--xz-anchor-${key}`, value);
    // 皮肤标记挂在 root 上，CSS 用 .xz-wb-host[data-skin="ink"] 覆盖一层 --wb-* 变量。
    this.root.dataset.skin = this.preferences.skin || "gold";
    this.root.classList.toggle("has-art", Boolean(this.preferences.landscape));
    this.root.classList.toggle("has-anchor-sheet", Boolean(this.preferences.landscape && this.anchorArt?.sheet));
    this.root.classList.toggle("has-sheet-b", Boolean(this.preferences.landscape && this.anchorArt?.["sheet-b"]));
    this.root.classList.toggle("has-sheet-c", Boolean(this.preferences.landscape && this.anchorArt?.["sheet-c"]));
    this.root.classList.toggle("has-landscape", this.preferences.landscape && Boolean(this.landscapeAvailable));
    this.root.classList.toggle("is-sidebar-compact", this.preferences.compactSidebar);
    this.refs.background?.setAttribute("aria-pressed", String(this.preferences.landscape));
    this.refs.compact?.setAttribute("aria-expanded", String(!this.preferences.compactSidebar));
    for (const leaf of this.app.workspace.getLeavesOfType?.(WORKBENCH_TYPE) || []) {
      if (leaf.view?.contentEl) applyChatArt(leaf.view);
    }
  }
  action(parent, label, name, run, cls = "text-button", icon = "") {
    const element = parent.createEl("button", { cls, attr: { type: "button", title: label, "aria-label": label, "data-action": name } });
    if (icon) glyph(element, icon);
    if (label && cls !== "icon-button" && !cls.split(" ").includes("is-icon")) element.createSpan({ text: label });
    element.addEventListener("click", () => Promise.resolve().then(run).catch(error => new Notice(error?.message || "操作未完成")));
    return element;
  }

  buildLayout() {
    // 星图持有 rAF 与 ResizeObserver，换页前必须先停掉，否则会在已卸载的 DOM 上继续跑。
    this.wbArcMap?.destroy(); this.wbArcMap = null;
    this.contentEl.empty(); this.refs = {};
    this.buildPathLayout();
  }

  // ======================= PATH 首页（.xz-wb） =======================
  buildPathLayout() {
    this.wbUid = this.wbUid || Math.random().toString(36).slice(2, 8);
    this.wbThesisSignature = ""; this.wbHoldsSignature = ""; this.wbSituationSignature = ""; this.wbSelectedChange = null; this.wbInsightIndex = this.wbInsightIndex || 0;
    if (this.embedded) this.contentEl.addClass("xz-unified-business-host");
    const host = this.root = this.contentEl.createDiv({ cls: "xz-wb-host xz-reference-ui", attr: { "data-layout": "path" } });
    const page = WB_PAGES.includes(this.wbPage) ? this.wbPage : "home";
    const label = { home: "行知个人工作台", anchor: "行知 · 立心", perceive: "行知 · 观境", test: "行知 · 践真", hone: "行知 · 知变", archive: "行知 · 藏知", tune: "行知 · 调律" }[page];
    const wb = host.createDiv({ cls: "xz-wb", attr: { "aria-label": label, "data-page": page } });

    if (!this.embedded) {
    const side = wb.createEl("aside", { cls: "wb-side", attr: { "aria-label": "行知导航" } });
    const brand = side.createDiv({ cls: "wb-brand" });
    this.wbBrandImage(brand.createDiv({ cls: "wb-brand-mark" }));
    const brandCopy = brand.createDiv({ cls: "wb-brand-copy" });
    brandCopy.createEl("strong", { text: "行知" }); brandCopy.createEl("small", { text: "XINGZHI" });
    const nav = side.createEl("nav", { cls: "wb-nav" });
    const homeItem = this.wbNavItem(nav, "首页", "HOME", "house", "sidebar-home", () => this.wbGo("home"));
    if (page === "home") homeItem.setAttribute("aria-current", "page");
    this.wbNavItem(nav, "对话", "CHAT", "message-circle", "open-chat", () => this.plugin.activateWorkbench("chat"));
    nav.createDiv({ cls: "wb-nav-group", text: "PATH" });
    WB_PATH.forEach((step, index) => {
      const item = this.wbNavItem(nav, step.name, step.en, step.icon, `path-${index}`, () => this.wbStepAction(index));
      if (WB_STEP_PAGES[index] === page) item.setAttribute("aria-current", "page");
    });
    nav.createDiv({ cls: "wb-nav-group", text: "工具" });
    const archiveItem = this.wbNavItem(nav, "藏知", "ARCHIVE", "library", "sidebar-memory", () => this.wbGo("archive"));
    if (page === "archive") archiveItem.setAttribute("aria-current", "page");
    const tuneItem = this.wbNavItem(nav, "调律", "TUNE", "sliders-horizontal", "sidebar-settings", () => this.wbGo("tune"));
    if (page === "tune") tuneItem.setAttribute("aria-current", "page");
    const sideFoot = side.createDiv({ cls: "wb-side-foot" });
    sideFoot.createEl("p", { text: "知所变，\n亦知所不变。" });
    sideFoot.createEl("small", { text: "以行求知　以知促行" });
    }

    const main = this.refs.main = wb.createDiv({ cls: "wb-main" });
    if (!this.embedded) {
    const top = main.createEl("header", { cls: "wb-topbar" });
    const motto = top.createDiv({ cls: "wb-motto", text: "以行求知　以知促行" });
    motto.createEl("small", { text: "A BRIGHTER WAY THROUGH A WIDER WORLD" });
    const tools = top.createDiv({ cls: "wb-tools" });
    this.action(tools, "搜索我的记录 · Ctrl K", "search", () => new HomeSearch(this).open(), "wb-icon-btn is-icon", "search");
    this.refs.pendingButton = this.action(tools, "等待确认与已到期回看", "confirmations", () => this.wbOpenAlerts(), "wb-icon-btn is-icon", "bell");
    this.action(tools, "新建", "new-menu", () => this.openNewMenu(), "wb-icon-btn is-icon", "plus");
    }

    const content = main.createEl("main", { cls: "wb-content", attr: { tabindex: "-1", "aria-label": label } });
    this.refs.status = content.createDiv({ cls: "wb-status", attr: { role: "status", "aria-live": "polite" } });
    if (page === "anchor") this.buildAnchorContent(content);
    else if (page === "perceive") this.buildPerceiveContent(content);
    else if (page === "test") this.buildTestContent(content);
    else if (page === "hone") this.buildHoneContent(content);
    else if (page === "archive") this.buildArchiveContent(content);
    else if (page === "tune") this.buildTuneContent(content);
    else this.buildHomeContent(content);
    const footer = content.createEl("footer", { cls: "wb-footer" });
    footer.createSpan({ text: "以行求知，以知促行。" }); this.refs.updated = footer.createSpan();
    this.applyPreferences(); this.renderData();
  }
  wbGo(page) {
    if (this.embedded && !WB_PAGES.includes(page)) return this.workbenchOwner.navigate("chat");
    if (this.embedded && this.workbenchOwner.unifiedWorkspace?.page !== page) return this.workbenchOwner.navigate(page);
    const next = WB_PAGES.includes(page) ? page : "home";
    if (this.wbPage === next && this.root?.dataset.layout === "path") { if (this.refs.main) this.refs.main.scrollTop = 0; return; }
    this.wbPage = next; this.wbSelectedHold = null; this.wbPerceiveComposing = false;
    this.wbTestFilter = "all"; this.wbHoneOpen = null; this.wbHoneCauses = new Map(); this.wbHoneKept = new Map();
    this.wbArcQuery = ""; this.wbArcFilter = "all";
    this.buildLayout();
  }
  buildHomeContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero", attr: { "aria-label": "行知" } });
    const heroCopy = hero.createDiv({ cls: "wb-hero-copy" });
    heroCopy.createEl("h1", { text: "看清位置　找到方向　走出自己的路" });
    heroCopy.createEl("p", { cls: "wb-hero-en", text: "A BRIGHTER WAY THROUGH A WIDER WORLD" });
    heroCopy.createDiv({ cls: "wb-hero-rule" });
    heroCopy.createEl("p", { cls: "wb-hero-lede", text: "在更大的视野中，理解当下，\n看见可能，并持续向前。" });
    const heroActions = heroCopy.createDiv({ cls: "wb-hero-actions" });
    this.action(heroActions, "进入对话", "open-chat", () => this.plugin.activateWorkbench("chat"), "wb-hero-chat", "message-circle");
    heroActions.createSpan({ cls: "wb-hero-chat-hint", text: "讲讲正在发生的事，行知陪你看清它" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "行动是认知的延伸，\n也是更清晰的开始。" });
    quote.createEl("small", { text: "ACTION EXTENDS UNDERSTANDING, AND ALSO OPENS A CLEARER BEGINNING." });

    const upper = content.createDiv({ cls: "wb-row" });
    const thesis = this.wbPanel(upper, "今日命题", "TODAY'S QUESTION");
    this.refs.swap = this.wbMore(thesis, "更换关注", "choose-focus", "repeat", () => this.chooseFocus());
    this.refs.thesis = thesis.createDiv({ cls: "wb-thesis" });
    const method = this.wbPanel(upper, "行知之法", "THE PATH");
    this.wbMore(method, "认识 PATH", "path-guide", "arrow-right", () => openPathGuide(this));
    this.buildRing(method);
    const chain = this.wbPanel(upper, "当前链路", "WHERE YOU ARE");
    this.refs.chain = chain.createEl("ol", { cls: "wb-chain" });
    this.refs.chainNote = chain.createEl("p", { cls: "wb-chain-note" });
    this.refs.cta = this.action(chain, "", "continue", () => this.wbContinue(), "wb-cta");

    const lower = content.createDiv({ cls: "wb-row" });
    const trajectory = this.wbPanel(lower, "判断修订", "HOW YOUR VIEW CHANGED");
    this.refs.trajMore = this.wbMore(trajectory, "全部修订", "revisions", "arrow-right", () => this.wbOpenRevisions());
    this.refs.traj = trajectory.createDiv({ cls: "wb-traj" });
    const todo = this.wbPanel(lower, "待验之事", "TO TEST IN REALITY");
    this.refs.todoMore = this.wbMore(todo, "全部", "all-actions", "arrow-right", () => this.wbOpenActions());
    this.refs.todo = todo.createDiv({ cls: "wb-todo-host" });
    const insight = this.wbPanel(lower, "今日洞见", "INSIGHT");
    this.refs.insight = insight.createDiv({ cls: "wb-insight", attr: { "aria-live": "polite" } });
    this.refs.dots = insight.createDiv({ cls: "wb-dots" });
  }
  wbBrandImage(parent) {
    const fallback = () => { parent.empty(); parent.createEl("strong", { cls: "wb-brand-fallback", text: "行知" }); };
    try {
      const image = parent.createEl("img", { attr: { src: this.plugin.getBrandAssetUrl(), alt: "" } });
      image.addEventListener("error", fallback, { once: true });
    } catch { fallback(); }
  }
  wbNavItem(parent, label, english, icon, name, run) {
    const item = this.action(parent, "", name, run, "wb-nav-item", icon);
    item.setAttribute("aria-label", label); item.setAttribute("title", label);
    item.createSpan({ cls: "wb-nav-text", text: label }).createEl("em", { text: english });
    return item;
  }
  wbPanel(parent, title, english) {
    const panel = parent.createEl("section", { cls: "wb-panel", attr: { "data-panel": english.toLowerCase().replace(/[^a-z0-9]+/gu, "-") } });
    const head = panel.createDiv({ cls: "wb-ph" });
    if (PANEL_ICONS[title]) glyph(head, PANEL_ICONS[title], "wb-panel-icon");
    head.createEl("h2", { text: title }); head.createSpan({ cls: "wb-en", text: english });
    panel.wbHead = head; return panel;
  }
  wbMore(panel, label, name, icon, run) {
    const element = this.action(panel.wbHead, label, name, run, "wb-more"); glyph(element, icon); return element;
  }
  buildRing(parent) {
    const method = parent.createDiv({ cls: "wb-method" });
    const ring = method.createDiv({ cls: "wb-ring" });
    const svg = svgEl(ring, "svg", { class: "wb-arcs", viewBox: "0 0 100 100", "aria-hidden": "true" });
    const markerId = `xz-wb-arrow-${this.wbUid}`;
    const marker = svgEl(svgEl(svg, "defs"), "marker", { id: markerId, viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto" });
    svgEl(marker, "path", { class: "wb-arrowhead", d: "M0 1 8 5 0 9", fill: "none", "stroke-width": 1.6 });
    this.refs.arcs = WB_ARCS.map(d => svgEl(svg, "path", { class: "wb-arc", d, "marker-end": `url(#${markerId})` }));
    this.wbBrandImage(ring.createDiv({ cls: "wb-ring-center" }));
    this.refs.nodes = WB_PATH.map((step, index) => {
      const node = this.action(ring, "", `path-${index}`, () => this.wbStepAction(index), `wb-node wb-n${index + 1}`);
      node.setAttribute("aria-label", `${step.name}：${step.desc}`); node.setAttribute("title", `${step.name} · ${step.desc}`);
      node.createEl("b", { text: step.name }); node.createEl("small", { text: step.verb });
      return node;
    });
    const row = method.createDiv({ cls: "wb-tools-row" });
    this.refs.archive = this.wbTool(row, "藏知", "积累沉淀", "library", "sidebar-memory", () => this.wbGo("archive"));
    this.wbTool(row, "调律", "模型与偏好", "sliders-horizontal", "sidebar-settings", () => this.wbGo("tune"));
  }
  wbTool(parent, label, hint, icon, name, run) {
    const element = this.action(parent, "", name, run, "wb-tool", icon);
    element.setAttribute("aria-label", label); element.setAttribute("title", label);
    const copy = element.createSpan({ cls: "wb-tool-copy" }); copy.createEl("b", { text: label });
    return copy.createEl("small", { text: hint });
  }

  // 四步入口：观境、立心、践真、知变各有独立页面。
  wbStepAction(index) {
    return this.wbGo(WB_STEP_PAGES[index] || "home");
  }
  wbContinue() {
    const focus = this.model.focus;
    if (!focus) {
      const input = this.refs.thesis?.querySelector("textarea");
      if (input) { input.focus(); return; }
      return openQuestion(this);
    }
    const stage = loopStage(focus);
    if (stage === 3) return this.createAction(focus);
    if (stage === 2) return openFocus(this, focus);
    return this.wbStepAction(stage);
  }
  wbDue() { return this.model.active.filter(loop => loop.reviewAt && (dayDiff(loop.reviewAt) ?? 1) <= 0); }
  wbOpenAlerts() {
    const due = this.wbDue(), pending = this.model.pending.length;
    const openDue = () => due.length === 1 ? openFocus(this, due[0]) : openList(this, "已到回看时间", due, {
      description: "是否完成需按实际情况记录。", choose: loop => openFocus(this, loop) });
    if (pending && due.length) {
      new HomeDialog(this, "等你处理", (body, modal) => {
        addButton(body, `${pending} 项理解或写入等待确认`, () => { modal.close(); openConfirmations(this); });
        addButton(body, `${due.length} 件事已到回看时间`, () => { modal.close(); openDue(); });
      }).open();
      return;
    }
    if (due.length) return openDue();
    return openConfirmations(this);
  }
  wbOpenRevisions() {
    const records = this.model.changes.map(change => ({ ...change, title: `${monthDay(change.occurredAt)} · ${change.title || "未命名"}`,
      summary: `${change.previous || "（原判断未记录）"} → ${change.current}${change.because ? `\n因为：${stripBecause(change.because)}` : ""}` }));
    openList(this, "判断修订", records, { description: "每一次修订都保留之前怎么想、现在怎么想、因为什么。",
      choose: record => this.plugin.openVaultPath(record.path) });
  }
  wbOpenActions() {
    openList(this, "进行中的行动", this.model.active, { empty: "还没有进行中的行动。", choose: loop => openFocus(this, loop) });
  }

  renderPathData() {
    const { focus } = this.model, stage = loopStage(focus);
    this.renderPathThesis(focus);
    this.refs.nodes.forEach((node, index) => {
      node.classList.toggle("is-current", Boolean(focus) && index === stage);
      node.classList.toggle("is-done", Boolean(focus) && index < stage);
    });
    this.refs.arcs.forEach((arc, index) => arc.classList.toggle("is-lit", Boolean(focus) && index < stage));
    this.renderPathChain(focus, stage); this.renderPathTrajectory(); this.renderPathTodo(); this.renderPathInsight();
    this.refs.archive.textContent = this.model.records.length ? `已沉淀 ${this.model.records.length} 条` : "积累沉淀";
    this.wbRenderChrome();
  }
  wbRenderChrome() {
    const alerts = this.wbDue().length + this.model.pending.length;
    const bell = this.refs.pendingButton || this.workbenchOwner?.unifiedWorkspace?.alertButton;
    if (bell) {
      bell.querySelector(".wb-badge")?.remove();
      if (alerts) bell.createSpan({ cls: "wb-badge", text: alerts > 99 ? "99+" : String(alerts) });
      bell.setAttribute("aria-label", alerts ? `${alerts} 项等待确认或已到回看时间` : "目前没有待确认或到期的内容");
    }
    this.refs.updated.textContent = this.model.generatedAt ? `本地记录 · ${plainDate(this.model.generatedAt)} 更新${this.loading ? " · 正在重新读取" : ""}` : "从一个真实问题开始";
  }
  renderPathThesis(focus) {
    this.refs.swap.hidden = !focus || this.model.loops.length < 2;
    // 仅在关注内容变化时重建，避免状态刷新打断空状态输入框的输入与焦点。
    const signature = focus ? [focus.id, focus.updatedAt, focus.problem, focus.title, focus.judgment, focus.path, focus.feedbacks?.length].join("|") : "empty";
    if (signature === this.wbThesisSignature) return;
    this.wbThesisSignature = signature;
    const host = this.refs.thesis; host.empty();
    const body = host.createDiv({ cls: "wb-thesis-body" });
    if (!focus) {
      body.addClass("is-empty");
      body.createEl("p", { cls: "wb-thesis-q", text: "从一个真实问题开始。" });
      const id = `xz-wb-question-${this.wbUid}`;
      body.createEl("label", { cls: "wb-thesis-meta", text: "你正在犹豫、或者想看清的一件事，越具体越好。", attr: { for: id } });
      const input = body.createEl("textarea", { cls: "wb-question", attr: { id, rows: "3", maxlength: "12000", placeholder: "例如：下个季度该继续做现在的项目，还是换方向？" } });
      input.value = this.questionDraft || "";
      input.addEventListener("input", () => { this.questionDraft = input.value; });
      const error = body.createEl("p", { cls: "wb-form-error", attr: { role: "alert" } });
      const send = this.action(body.createDiv({ cls: "wb-thesis-actions" }), "在对话中梳理", "begin-analysis", async () => {
        const content = input.value.trim();
        if (!content) { error.textContent = "请先写下一个具体问题。"; input.focus(); return; }
        send.disabled = true; error.textContent = "";
        try { await this.beginAnalysis(content); this.questionDraft = ""; input.value = ""; }
        catch (failure) { error.textContent = failure?.message || "未能打开对话，问题内容已保留。"; }
        finally { send.disabled = false; }
      }, "wb-text-btn");
      glyph(send, "arrow-right");
      input.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); send.click(); }
      });
    } else {
      body.createEl("p", { cls: "wb-thesis-q", text: focus.problem || focus.title || "未命名问题" });
      const prefill = `我想继续梳理这个问题：${focus.problem || focus.title}\n当前判断：${focus.judgment || "尚未形成"}\n相关记录：${focus.path}`;
      this.action(body, "在对话中继续梳理这个问题", "new-question", () => openQuestion(this, prefill), "wb-go is-icon", "arrow-right");
      const chips = body.createDiv({ cls: "wb-chips" });
      this.action(chips, "查看要点", "open-focus", () => openFocus(this, focus), "wb-chip");
      this.action(chips, "记录真实反馈", "feedback", () => this.createAction(focus), "wb-chip");
      this.action(chips, "打开笔记", "open-record", () => this.plugin.openVaultPath(focus.path), "wb-chip");
      body.createDiv({ cls: "wb-thesis-meta", text: `当前判断：${focus.judgment || "尚未形成"}` });
    }
    host.createDiv({ cls: "wb-thesis-scene", attr: { "aria-hidden": "true" } });
  }
  renderPathChain(focus, stage) {
    const list = this.refs.chain; list.empty();
    const details = focus ? [focus.problem || focus.title, focus.goal || focus.judgment, focus.action, `已记录 ${focus.feedbacks?.length || 0} 次反馈`] : [];
    WB_PATH.forEach((step, index) => {
      const state = !focus ? "" : index < stage ? "is-done" : index === stage ? "is-current" : "";
      const item = list.createEl("li", { cls: `wb-step ${state}`.trim() });
      if (state === "is-current") item.setAttribute("aria-current", "step");
      item.createSpan({ cls: "wb-pin", attr: { "aria-hidden": "true" } });
      item.createEl("b", { text: step.name });
      const description = item.createSpan({ cls: "wb-step-d", text: step.desc });
      if (focus && index <= stage && details[index]) description.setAttribute("title", details[index]);
      if (focus) item.createSpan({ cls: "wb-tag", text: index < stage ? "已走过" : index === stage ? "进行中" : "待进行" });
    });
    this.refs.chainNote.textContent = focus
      ? `当前关注「${focus.title || "未命名"}」。链路由记录中的问题、目标、行动与反馈推出。`
      : "还没有正在推进的事。先在左边写下一个问题，链路会从观境开始亮起。";
    this.refs.cta.textContent = focus ? WB_NEXT[stage] : "写下第一个问题";
  }
  renderPathTrajectory(focusIndex = null) {
    const host = this.refs.traj; host.empty();
    const all = this.model.changes; this.refs.trajMore.hidden = !all.length;
    if (!all.length) {
      host.createEl("p", { cls: "wb-empty", text: "当新的依据让你改变一个判断，修订会留在这里：之前怎么想、现在怎么想、因为什么。" });
      svgEl(svgEl(host, "svg", { class: "wb-traj-svg", viewBox: "0 0 300 150", "aria-hidden": "true" }), "path", { class: "wb-axis", d: "M0 130H300", "stroke-dasharray": "3 5" });
      if ((this.snapshot?.judgments || []).length) {
        glyph(this.action(host, "查看已有判断", "judgments", () => this.openRecords("已有判断与依据", this.snapshot?.judgments || []), "wb-text-btn"), "arrow-right");
      }
      return;
    }
    const list = all.slice(0, 8).reverse(), now = Date.now(), W = 300, H = 130;
    const times = list.map(change => { const time = Date.parse(change.occurredAt); return Number.isFinite(time) ? Math.min(time, now) : now; });
    const t0 = times[0], span = Math.max(864e5, now - t0);
    const points = times.map((time, index) => [12 + (time - t0) / span * (W - 24), H - 18 - index / Math.max(1, list.length - 1) * (H - 50)]);
    const selected = Math.min(this.wbSelectedChange ?? list.length - 1, list.length - 1);
    const recent = all.filter(change => now - Date.parse(change.occurredAt) < 30 * 864e5).length;
    const stats = host.createDiv({ cls: "wb-stat-row" });
    const total = stats.createSpan(); total.createEl("b", { text: String(all.length) }); total.appendText("次判断修订");
    const month = stats.createSpan(); month.createEl("b", { text: String(recent) }); month.appendText("次在近 30 天");
    const svg = svgEl(host, "svg", { class: "wb-traj-svg", viewBox: `0 0 ${W} 150`, role: "group", "aria-label": `判断修订时间线，显示最近 ${list.length} 次` });
    const gradientId = `xz-wb-traj-${this.wbUid}`;
    const gradient = svgEl(svgEl(svg, "defs"), "linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
    svgEl(gradient, "stop", { offset: 0, class: "wb-stop-top" }); svgEl(gradient, "stop", { offset: 1, class: "wb-stop-bottom" });
    svgEl(svg, "path", { class: "wb-axis", d: `M0 ${H}H${W}` });
    const curve = points.map((point, index) => {
      if (!index) return `M${point[0]} ${point[1]}`;
      const previous = points[index - 1], middle = (previous[0] + point[0]) / 2;
      return `C${middle} ${previous[1]} ${middle} ${point[1]} ${point[0]} ${point[1]}`;
    }).join(" ");
    if (points.length > 1) {
      svgEl(svg, "path", { class: "wb-area", d: `${curve} L${points.at(-1)[0]} ${H} L${points[0][0]} ${H}Z`, fill: `url(#${gradientId})` });
      svgEl(svg, "path", { class: "wb-curve", d: curve });
    }
    let lastLabel = -Infinity;
    points.forEach(([x, y], index) => {
      const dot = svgEl(svg, "circle", { class: `wb-pt${index === selected ? " is-selected" : ""}`, cx: x, cy: y, r: 5, tabindex: 0, role: "button",
        "data-i": index, "aria-pressed": String(index === selected), "aria-label": `${monthDay(list[index].occurredAt)} ${list[index].title || "判断修订"}` });
      const pick = () => { this.wbSelectedChange = index; this.renderPathTrajectory(index); };
      dot.addEventListener("click", pick);
      dot.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); } });
      if (index === selected || x - lastLabel >= 44) {
        svgEl(svg, "text", { class: "wb-pt-label", x, y: H + 16, "text-anchor": "middle" }).textContent = monthDay(list[index].occurredAt);
        lastLabel = x;
      }
    });
    const change = list[selected];
    const card = this.action(host, "", "revision", () => this.plugin.openVaultPath(change.path), "wb-traj-card");
    card.setAttribute("aria-label", `打开「${change.title || "判断修订"}」的记录`);
    const head = card.createSpan({ cls: "wb-traj-head" });
    head.createEl("strong", { text: change.title || "未命名" });
    head.createEl("s", { text: change.previous || "（原判断未记录）" });
    card.createSpan({ cls: "wb-to", text: `→ ${change.current}` });
    if (change.because) card.createEl("small", { text: `因为：${stripBecause(change.because)}` });
    if (focusIndex !== null) host.querySelector(`.wb-pt[data-i="${focusIndex}"]`)?.focus();
  }
  renderPathTodo() {
    const host = this.refs.todo; host.empty();
    const far = 8.64e15;
    const loops = [...this.model.active].sort((a, b) => (Date.parse(a.reviewAt) || far) - (Date.parse(b.reviewAt) || far));
    this.refs.todoMore.hidden = loops.length <= 5;
    if (!loops.length) {
      host.createEl("p", { cls: "wb-empty", text: "践真从一件愿意走进现实的小事开始。定好回看日期，到期会出现在这里。" });
      glyph(this.action(host, "建立第一个行动", "create-action", () => this.createAction(), "wb-text-btn"), "arrow-right");
    } else {
      const list = host.createEl("ul", { cls: "wb-todo" });
      for (const loop of loops.slice(0, 5)) {
        const days = loop.reviewAt ? dayDiff(loop.reviewAt) : null;
        const [tone, label] = days === null ? ["later", "未定回看"] : days < 0 ? ["overdue", `逾期 ${-days} 天`]
          : days === 0 ? ["soon", "今天回看"] : days <= 3 ? ["soon", `${days} 天后`] : ["later", monthDay(loop.reviewAt)];
        const title = loop.action || loop.title || "未命名行动";
        const row = this.action(list.createEl("li"), "", "open-focus", () => openFocus(this, loop), "wb-todo-row");
        row.setAttribute("aria-label", `${title}，${label}，查看并记录反馈`); row.setAttribute("title", title);
        row.createSpan({ cls: "wb-todo-ring", attr: { "aria-hidden": "true" } });
        row.createSpan({ cls: "wb-todo-t", text: title });
        row.createSpan({ cls: `wb-s is-${tone}`, text: label });
        glyph(row, "chevron-right", "wb-todo-chev");
      }
    }
    if (this.lastTransactionId) this.action(host, "撤销刚才保存的反馈", "undo-feedback", async () => {
      await this.plugin.undoCognitiveChange(this.lastTransactionId); this.lastTransactionId = null; await this.refresh();
    }, "wb-text-btn wb-undo");
  }
  renderPathInsight(focusDot = false) {
    const items = [...this.model.changes.slice(0, 2).map(change => ({ change })), ...WB_QUOTES.map(quote => ({ quote }))];
    this.wbInsightIndex = (this.wbInsightIndex || 0) % items.length;
    const item = items[this.wbInsightIndex], host = this.refs.insight; host.empty();
    if (item.change) {
      const change = item.change;
      host.createSpan({ cls: "wb-kind", text: `最近的修订 · ${monthDay(change.occurredAt)}` });
      if (change.previous) host.createEl("p", { cls: "wb-was", text: change.previous });
      host.createEl("p", { text: change.current });
      host.createEl("small", { text: `${change.title || "判断修订"}${change.because ? ` · 因为${stripBecause(change.because)}` : ""}` });
      this.action(host, "打开这条记录", "revision", () => this.plugin.openVaultPath(change.path), "wb-insight-open is-icon", "arrow-up-right");
    } else {
      host.createSpan({ cls: "wb-kind", text: item.quote.source });
      host.createEl("p", { text: item.quote.text });
    }
    const dots = this.refs.dots; dots.empty();
    items.forEach((_, index) => {
      const dot = this.action(dots, `第 ${index + 1} 条`, "insight-dot", () => { this.wbInsightIndex = index; this.renderPathInsight(true); }, "wb-dot is-icon");
      dot.setAttribute("aria-current", String(index === this.wbInsightIndex));
    });
    if (focusDot) dots.children[this.wbInsightIndex]?.focus();
  }

  renderStatus() {
    if (!this.refs.status) return;
    const host = this.refs.status; host.empty(); host.hidden = false;
    if (this.error) {
      host.createSpan({ text: `读取未完成：${this.error}${this.snapshot ? "。保留上次读取的记录。" : ""}` });
      this.action(host, "重新读取", "retry", () => this.refresh());
    } else if (this.loading && !this.snapshot) host.createSpan({ text: "正在读取本地目标、行动与反馈…" });
    else if (this.model.issues.length) {
      host.createSpan({ text: `${this.model.issues.length} 份记录需要核对，首页未将它们计入结果。` });
      this.action(host, "审核与修复", "knowledge-health", () => this.plugin.openKnowledgeHealth());
    } else host.hidden = true;
  }
  renderData() {
    if (this.closed || !this.root) return;
    this.model = buildHomeModel(this.snapshot || {}, this.plugin.state || {}, this.preferences, new Date());
    if (this.root.dataset.layout === "path") {
      this.renderStatus();
      if (this.refs.holds) { this.renderAnchor(); this.wbRenderChrome(); }
      else if (this.refs.situation) { this.renderPerceive(); this.wbRenderChrome(); }
      else if (this.refs.testRoad) { this.renderTest(); this.wbRenderChrome(); }
      else if (this.refs.honeGaps) { this.renderHone(); this.wbRenderChrome(); }
      else if (this.refs.arcList) { this.renderArchive(); this.wbRenderChrome(); }
      else if (this.refs.tuneDing) { this.renderTune(); this.wbRenderChrome(); }
      else this.renderPathData();
      return;
    }
    this.renderStatus(); this.renderTiles(); this.renderProgress(); this.renderPriorities(); this.renderReview();
    this.refs.updated.textContent = this.model.generatedAt ? `本地记录 · ${plainDate(this.model.generatedAt)} 更新${this.loading ? " · 正在重新读取" : ""}` : "从一个真实问题开始";
    this.refs.pendingButton.setAttribute("aria-label", this.model.pending.length ? `${this.model.pending.length} 项内容等待确认` : "目前没有待确认内容");
    this.refs.pendingButton.classList.toggle("has-pending", this.model.pending.length > 0);
  }
  renderTiles() {
    const { focus, direction } = this.model;
    const cognition = this.refs.cognition; cognition.empty();
    if (focus) {
      this.action(cognition, focus.problem || focus.title, "open-focus", () => openFocus(this, focus), "tile-record");
      this.action(cognition, "继续梳理", "new-question", () => openQuestion(this, `我想继续梳理这个问题：${focus.problem || focus.title}\n当前判断：${focus.judgment || "尚未形成"}\n相关记录：${focus.path}`), "tile-link", "message-circle");
    } else this.action(cognition, "开始分析一个真实问题", "new-question", () => openQuestion(this), "tile-link", "message-circle");
    const destination = this.refs.direction; destination.empty();
    if (direction) {
      this.action(destination, direction.title, "direction", () => this.plugin.openVaultPath(direction.path), "tile-record");
      destination.createEl("small", { cls: "small-status", text: EPISTEMIC_LABELS[direction.epistemicStatus] || "目标记录" });
      this.action(destination, "选择阶段目标", "choose-direction", () => this.openGoals(true), "tile-link", "flag");
    } else this.action(destination, "梳理此阶段的方向", "direction", () => openQuestion(this, "我想梳理此阶段的方向、真正重视的东西，以及愿意承担的代价。"), "tile-link", "flag");
    const action = this.refs.action; action.empty();
    if (focus) {
      this.action(action, focus.action || "查看当前行动", "open-focus", () => openFocus(this, focus), "tile-record");
      action.createEl("small", { cls: "small-status", text: this.statusLabel(focus.status) });
      this.action(action, "记录真实反馈", "feedback", () => this.createAction(focus), "tile-link", "square-pen");
    } else this.action(action, "建立下一步行动", "create-action", () => this.createAction(), "tile-link", "square-plus");
  }
  sectionTitle(parent, title, english) {
    const heading = parent.createDiv({ cls: "section-heading" });
    const copy = heading.createDiv(); copy.createEl("h2", { text: title }); copy.createSpan({ cls: "section-english", text: english }); return heading;
  }
  renderProgress() {
    const parent = this.refs.progress; parent.empty(); this.sectionTitle(parent, "成长轨迹", "PROGRESS");
    const sum = this.model.week.reduce((total, day) => total + day.count, 0);
    parent.createEl("p", { cls: "small-status", text: `本周已记录 ${sum} 次行动反馈` });
    const chart = parent.createDiv({ cls: "progress-bars", attr: { role: "img", "aria-label": this.model.week.map(day => `${day.date}：${day.count} 次反馈`).join("；") } });
    const max = Math.max(1, ...this.model.week.map(day => day.count));
    for (const day of this.model.week) {
      const column = chart.createDiv({ cls: `bar-column${day.today ? " is-today" : ""}`, attr: { "aria-hidden": "true", title: `${day.date} · ${day.count} 次反馈` } });
      column.createSpan({ cls: "bar-value", text: String(day.count) });
      const bar = column.createDiv({ cls: "progress-bar" }); bar.style.height = `${Math.max(2, Math.round(day.count / max * 82))}px`;
      column.createSpan({ cls: "bar-label", text: day.label });
    }
    parent.createEl("p", { cls: "chart-caption", text: sum ? "实际反馈记录，来自认知行动表单。" : "留下真实反馈，让变化有迹可循。" });
  }
  renderPriorities() {
    const parent = this.refs.priorities; parent.empty();
    const heading = this.sectionTitle(parent, "当前重点", "FOCUS");
    this.action(heading, "选择当前关注", "choose-focus", () => this.chooseFocus(), "icon-button", "sliders-horizontal");
    const ordered = this.model.focus ? [this.model.focus, ...this.model.active.filter(loop => loop.id !== this.model.focus.id)] : this.model.active;
    if (!ordered.length) {
      parent.createEl("p", { cls: "empty-text", text: "还没有记录中的行动。先确定一件愿意走进现实的小事。" });
      this.action(parent, "建立第一个行动", "create-action", () => this.createAction(), "text-button", "plus");
    }
    for (const loop of ordered.slice(0, 4)) {
      const row = this.action(parent, "", "open-focus", () => openFocus(this, loop), `priority-row${loop.status === "completed" ? " is-complete" : ""}`);
      row.setAttribute("aria-label", `${loop.title}，${this.statusLabel(loop.status)}，查看记录`);
      glyph(row, loop.status === "completed" ? "square-check" : "square", "priority-check");
      const copy = row.createDiv({ cls: "priority-copy" }); copy.createSpan({ text: loop.action || loop.title });
      copy.createEl("small", { text: `${this.statusLabel(loop.status)}${loop.reviewAt ? ` · ${plainDate(loop.reviewAt)} 回看` : ""}` });
    }
  }
  renderReview() {
    const changes = this.refs.changes; changes.empty(); this.sectionTitle(changes, "判断与修订", "REFLECTION");
    if (!this.model.changes.length) {
      changes.createEl("p", { cls: "empty-text", text: "当新的依据改变判断，修订会留在这里。" });
      this.action(changes, "查看已有判断", "judgments", () => this.openRecords("已有判断与依据", this.snapshot?.judgments || []));
    }
    for (const change of this.model.changes.slice(0, 2)) {
      const row = this.action(changes, "", "revision", () => this.plugin.openVaultPath(change.path), "change-row");
      row.setAttribute("aria-label", `查看${change.title}的判断修订`);
      row.createSpan({ cls: "change-date", text: plainDate(change.occurredAt) });
      const copy = row.createDiv({ cls: "change-copy" }); copy.createEl("strong", { text: change.title }); copy.createEl("p", { text: change.current });
    }
    const review = this.refs.review; review.empty(); this.sectionTitle(review, "等你回看", "REVIEW");
    if (this.model.pending.length) this.action(review, `${this.model.pending.length} 项理解或写入等待确认`, "confirmations", () => openConfirmations(this), "review-entry", "bell");
    const reviewLoop = this.model.active.find(loop => loop.reviewAt && Date.parse(loop.reviewAt) <= Date.now());
    if (reviewLoop) {
      review.createEl("p", { cls: "small-status", text: "已到计划回看时间，是否完成需按实际情况记录。" });
      this.action(review, reviewLoop.title, "feedback", () => this.createAction(reviewLoop), "review-entry", "calendar-check");
    }
    const daily = this.plugin.getDailyReviewState();
    const dailyRefreshing = daily?.freshness === "stale" || daily?.status === "loading";
    if (daily?.error) review.createEl("p", { cls: "empty-text", text: `今日建议未更新：${daily.error}` });
    else if (dailyRefreshing) review.createEl("p", { cls: "empty-text", text: "今日建议正在根据最新本地记录更新。" });
    else if (daily?.draft?.today?.suggestions?.length) this.action(review, "查看今日推进建议与依据", "sidebar-today", () => this.plugin.openActionCenter(), "review-entry", "arrow-right");
    if (!this.model.pending.length && !reviewLoop && !daily?.draft?.today?.suggestions?.length && !daily?.error && !dailyRefreshing) review.createEl("p", { cls: "empty-text", text: "暂时没有等待回看的内容。行动带回新信息时，再来看看。" });
    if (this.lastTransactionId) this.action(review, "撤销刚才保存的反馈", "undo-feedback", async () => {
      await this.plugin.undoCognitiveChange(this.lastTransactionId); this.lastTransactionId = null; await this.refresh();
    });
  }

  // ======================= 立心页 =======================
  buildAnchorContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-anchor-hero", attr: { "aria-label": "立心" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "立心" });
    copy.createEl("p", { cls: "wb-anchor-sub", text: "明所欲　知所重　定所守" });
    copy.createEl("p", { cls: "wb-hero-en", text: "ANCHOR · FIND WHAT YOU WILL NOT TRADE AWAY" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "在变化之外，找到真正要守住的东西。" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "所守之物不随环境波动而改变，\n但它仍需经受现实的检验。" });
    quote.createEl("small", { text: "观境以知位，立心以定向" });

    const upper = content.createDiv({ cls: "wb-row wb-anchor-top" });
    const hold = this.wbPanel(upper, "定所守", "WHAT YOU HOLD");
    hold.addClass("wb-hold-panel");
    this.refs.addHold = this.wbMore(hold, "写下一条所守", "add-hold", "plus", () => this.openHoldEditor());
    hold.createEl("p", { cls: "wb-panel-note", text: "不愿轻易交换掉的东西。每一条都写清边界，并记下它在现实里被考验的时刻。" });
    const wrap = hold.createDiv({ cls: "wb-hold-wrap" });
    const pole = this.refs.pole = wrap.createDiv({ cls: "wb-pole" });
    glyph(pole.createDiv({ cls: "wb-star" }), "sparkle", "wb-star-fallback");
    const poleCopy = pole.createDiv({ cls: "wb-pole-copy" });
    this.refs.poleTitle = poleCopy.createEl("b"); this.refs.poleNote = poleCopy.createEl("small");
    this.refs.holds = wrap.createDiv({ cls: "wb-holds-host" });
    const signals = this.wbPanel(upper, "待确认的价值信号", "SIGNALS");
    signals.createEl("p", { cls: "wb-panel-note", text: "记录里关于你看重什么的推测。它们还没被你确认，由你决定算不算数。" });
    this.refs.signals = signals.createDiv({ cls: "wb-signals-host" });

    const lower = this.refs.anchorLower = content.createDiv({ cls: "wb-row wb-anchor-bottom" });
    const want = this.wbPanel(upper, "明所欲", "WHAT YOU WANT");
    this.refs.goalsMore = this.wbMore(want, "全部目标", "all-goals", "arrow-right", () => this.openAnchorGoals());
    this.refs.goals = want.createDiv({ cls: "wb-goals-host" });
    const weigh = this.wbPanel(lower, "知所重", "WHAT MATTERS MORE");
    weigh.createEl("p", { cls: "wb-panel-note", text: "你确认过的价值与偏好。排序来自真实的取舍，不来自自评。" });
    this.refs.values = weigh.createDiv({ cls: "wb-values-host" });
    const gap = this.wbPanel(lower, "言行之间", "SAID AND DONE");
    gap.createEl("p", { cls: "wb-panel-note", text: "写下要守、但现实里让步了的地方。它不是批评，是下一次践真的入口。" });
    this.refs.gaps = gap.createDiv({ cls: "wb-gaps-host" });
    this.refs.linkHint = gap.createEl("p", { cls: "wb-link-hint", attr: { "aria-live": "polite" } });
  }
  anchorState() {
    const snap = this.snapshot || {};
    const holds = snap.holds && Array.isArray(snap.holds.holds) ? snap.holds : { holds: [], hash: "", exists: false, foreign: false };
    const active = holds.holds.filter(hold => hold.status === "active");
    const retired = holds.holds.filter(hold => hold.status === "retired");
    const issue = (snap.issues || []).find(item => item.path === HOLDS_PATH) || null;
    const values = Array.isArray(snap.values) ? snap.values : [];
    const goals = (Array.isArray(snap.allGoals) ? snap.allGoals : this.model.goals) || [];
    return { holds, active, retired, issue, goals,
      signals: values.filter(record => SPECULATIVE.has(record.epistemicStatus)),
      confirmed: values.filter(record => record.type === "value-priority" && !SPECULATIVE.has(record.epistemicStatus)) };
  }
  renderAnchor() {
    const state = this.anchorState();
    if (this.wbSelectedHold && !state.active.some(hold => hold.id === this.wbSelectedHold)) this.wbSelectedHold = null;
    const selected = state.active.find(hold => hold.id === this.wbSelectedHold) || null;
    this.renderHolds(state, selected);
    this.renderSignals(state);
    this.renderAnchorGoals(state, selected);
    this.renderAnchorValues(state);
    this.renderAnchorGaps(state, selected);
    this.refs.anchorLower.classList.toggle("is-filtering", Boolean(selected));
  }
  renderHolds(state, selected) {
    const { active, retired, holds, issue } = state, has = active.length > 0;
    this.refs.addHold.hidden = !has || holds.foreign || Boolean(issue);
    this.refs.pole.classList.toggle("is-dim", !has);
    this.refs.poleTitle.textContent = has ? `${active.length} 条所守` : "还没有所守";
    const tested = active.filter(hold => hold.tests?.length).length;
    this.refs.poleNote.textContent = has ? `${tested} 条经过了现实检验` : "像北极星，不告诉你怎么走，只告诉你别往哪走";
    // 空状态里有输入框：内容没变就不重建，避免刷新打断输入。
    const signature = [holds.hash, holds.foreign, issue?.reason, this.wbSelectedHold, this.lastTransactionId, Boolean(this.snapshot), Boolean(this.error)].join("|");
    if (signature === this.wbHoldsSignature) return;
    this.wbHoldsSignature = signature;
    const host = this.refs.holds; host.empty();
    if (!this.snapshot) { host.createEl("p", { cls: "wb-empty", text: this.error ? "暂时读不到本地记录。" : "正在读取你的所守…" }); return; }
    if (issue || holds.foreign) {
      host.createEl("p", { cls: "wb-empty", text: issue ? `所守记录需要核对：${issue.reason}` : "「所守.md」已存在，但不是行知生成的格式。页面不会覆盖它。" });
      this.action(host, "打开原文", "open-holds", () => this.plugin.openVaultPath(HOLDS_PATH), "wb-text-btn", "file-text");
      return;
    }
    if (!has) this.renderHoldComposer(host);
    else {
      const list = host.createEl("ul", { cls: "wb-holds" });
      for (const hold of active) this.renderHoldCard(list, hold, selected);
    }
    const foot = host.createDiv({ cls: "wb-hold-foot" });
    if (retired.length) this.action(foot, `已不再守 ${retired.length} 条`, "retired-holds", () => this.openRetiredHolds(retired), "wb-text-btn");
    if (holds.exists) this.action(foot, "打开所守原文", "open-holds", () => this.plugin.openVaultPath(HOLDS_PATH), "wb-text-btn");
    if (this.lastTransactionId && this.lastTransactionId === this.wbHoldTransaction) this.action(foot, "撤销刚才的修改", "undo-hold", async () => {
      await this.plugin.undoCognitiveChange(this.lastTransactionId); this.lastTransactionId = null; this.wbHoldTransaction = null;
      new Notice("已撤销刚才的所守修改"); await this.refresh();
    }, "wb-text-btn wb-undo");
    if (!foot.childElementCount) foot.remove();
  }
  renderHoldComposer(host) {
    host.createEl("p", { cls: "wb-empty", text: "从一次真实的取舍想起，比凭空列价值观更准。" });
    const composer = host.createDiv({ cls: "wb-composer" });
    const id = `xz-wb-hold-${this.wbUid}`;
    const prompts = host.createEl("ul", { cls: "wb-prompts" });
    host.insertBefore(prompts, composer);
    composer.createEl("label", { cls: "wb-composer-label", text: "写下一条你愿意守住的东西", attr: { for: id } });
    const text = composer.createEl("textarea", { cls: "wb-question", attr: { id, rows: "2", maxlength: "200", placeholder: "例如：不拿身体换进度" } });
    const boundary = composer.createEl("textarea", { cls: "wb-question", attr: { rows: "2", maxlength: "4000", "aria-label": "边界", placeholder: "边界：什么情况下可以让步？例如：一次性的关键演示可以晚睡一晚，但不连续。" } });
    text.value = this.wbHoldDraft.text; boundary.value = this.wbHoldDraft.boundary;
    text.addEventListener("input", () => { this.wbHoldDraft.text = text.value; });
    boundary.addEventListener("input", () => { this.wbHoldDraft.boundary = boundary.value; });
    for (const prompt of HOLD_PROMPTS) {
      this.action(prompts.createEl("li"), prompt, "hold-prompt", () => { text.placeholder = prompt; text.focus(); }, "wb-prompt");
    }
    const error = composer.createEl("p", { cls: "wb-form-error", attr: { role: "alert" } });
    const row = composer.createDiv({ cls: "wb-composer-actions" });
    const save = this.action(row, "记下这条所守", "save-hold", async () => {
      if (!text.value.trim()) { error.textContent = "请先写下要守住的东西。"; text.focus(); return; }
      save.disabled = true; error.textContent = "";
      try {
        await this.saveHolds("save", { text: text.value, boundary: boundary.value, why: "", goalPaths: [] }, "所守已记下");
        this.wbHoldDraft = { text: "", boundary: "" };
      } catch (failure) { error.textContent = failure?.message || "保存未完成，填写内容仍保留。"; }
      finally { save.disabled = false; }
    }, "wb-solid-btn");
    const talk = this.action(row, "在对话中梳理", "hold-talk", () => openQuestion(this,
      `我想想清楚自己不愿轻易交换掉的东西。${text.value.trim() ? `\n我先写下的是：${text.value.trim()}` : ""}\n请帮我从最近一次真实的取舍出发，说清它为什么重要、边界在哪里。`), "wb-text-btn");
    glyph(talk, "arrow-right");
  }
  renderHoldCard(list, hold, selected) {
    const item = list.createEl("li", { cls: `wb-hold${selected?.id === hold.id ? " is-selected" : ""}` });
    const main = this.action(item, "", "select-hold", () => {
      this.wbSelectedHold = this.wbSelectedHold === hold.id ? null : hold.id; this.renderData();
    }, "wb-hold-main");
    main.setAttribute("aria-pressed", String(selected?.id === hold.id));
    main.setAttribute("aria-label", `${hold.text}：查看它连着哪些目标`);
    main.createSpan({ cls: "wb-hold-t", text: hold.text });
    if (hold.why) main.createEl("span", { cls: "wb-hold-why", text: hold.why });
    const bound = main.createEl("span", { cls: "wb-hold-bound" });
    if (hold.boundary) { bound.createEl("b", { text: "边界" }); bound.appendText(`　${hold.boundary}`); }
    else bound.setText("还没写边界：什么情况下你会让步？");
    const test = item.createDiv({ cls: "wb-hold-test" });
    const last = latestTest(hold), counts = holdCounts(hold);
    if (!last) {
      test.createSpan({ cls: "wb-pill is-untested", text: "尚未经过现实检验" });
      test.createSpan({ text: "下次它被考验时，记下你怎么选的。" });
    } else {
      test.createSpan({ cls: `wb-pill ${last.kept ? "is-kept" : "is-yield"}`, text: last.kept ? "守住了" : "让步了" });
      test.createSpan({ text: `最近一次：${monthDay(localDay(last.at))}，${last.situation}` });
      test.createSpan({ text: `共检验 ${counts.total} 次，守住 ${counts.kept} 次` });
    }
    const acts = test.createDiv({ cls: "wb-hold-acts" });
    this.action(acts, "记一次考验", "test-hold", () => this.openHoldTest(hold), "wb-chip-btn is-primary");
    this.action(acts, last && !last.kept ? "重新看这条边界" : "修改", "edit-hold", () => this.openHoldEditor(hold), "wb-chip-btn");
    this.action(acts, "不再守", "retire-hold", () => this.confirmRetireHold(hold), "wb-chip-btn is-quiet");
  }
  renderSignals(state) {
    const host = this.refs.signals; host.empty();
    if (!state.signals.length) {
      host.createEl("p", { cls: "wb-empty", text: "和行知聊得越多，这里会出现它观察到的倾向。每一条都要你点头才会写进画像。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-signals" });
    for (const record of state.signals.slice(0, 4)) {
      const item = list.createEl("li", { cls: "wb-signal" });
      item.createEl("p", { text: record.title || "未命名记录" });
      if (record.summary && record.summary !== record.title) item.createEl("span", { cls: "wb-signal-sum", text: record.summary });
      item.createEl("small", { text: `${EPISTEMIC_LABELS[record.epistemicStatus] || "尚待确认"}${record.updatedAt ? ` · ${monthDay(record.updatedAt)}` : ""}` });
      const acts = item.createDiv({ cls: "wb-signal-acts" });
      if (!state.issue && !state.holds.foreign) this.action(acts, "记为所守", "signal-hold", () => this.openHoldEditor(null, { text: record.title || "", why: record.summary || "" }), "wb-chip-btn is-primary");
      this.action(acts, "打开记录核对", "signal-open", () => this.plugin.openVaultPath(record.path), "wb-chip-btn");
    }
    if (state.signals.length > 4) this.action(host, `全部 ${state.signals.length} 条`, "all-signals", () => this.openRecords("待确认的价值信号", state.signals), "wb-text-btn");
  }
  renderAnchorGoals(state, selected) {
    const host = this.refs.goals; host.empty();
    const direction = this.model.direction;
    const goals = state.goals.filter(goal => goal.path !== direction?.path);
    this.refs.goalsMore.hidden = !state.goals.length;
    if (!goals.length && !direction) {
      host.createEl("p", { cls: "wb-empty", text: "还没有记录方向。一个好目标要写清：服务于什么方向、到什么时候、什么情况下放下它。" });
      const talk = this.action(host, "在对话中梳理此阶段的方向", "direction-talk", () => openQuestion(this, "我想梳理此阶段的方向：真正想要的是什么、到什么时候，以及什么情况下我会放下它。"), "wb-text-btn");
      glyph(talk, "arrow-right");
      return;
    }
    if (direction) {
      const block = this.action(host, "", "open-direction", () => this.plugin.openVaultPath(direction.path), "wb-direction");
      block.setAttribute("aria-label", `此阶段方向：${direction.title}，打开记录`);
      block.createEl("small", { text: "此阶段方向" }); block.createSpan({ text: direction.title });
    }
    const list = host.createEl("ul", { cls: "wb-goals" });
    for (const goal of goals.slice(0, 5)) {
      const linked = Boolean(selected?.goalPaths?.includes(goal.path));
      const item = list.createEl("li", { cls: `wb-goal${linked ? " is-linked" : ""}` });
      const open = this.action(item, "", "open-goal", () => this.plugin.openVaultPath(goal.path), "wb-goal-main");
      open.setAttribute("aria-label", `${goal.title}，打开记录`);
      const head = open.createSpan({ cls: "wb-goal-t" }); head.createEl("b", { text: goal.title || "未命名目标" });
      if (goal.updatedAt) head.createSpan({ text: `${monthDay(goal.updatedAt)} 更新` });
      if (goal.summary && goal.summary !== goal.title) open.createSpan({ cls: "wb-goal-sum", text: goal.summary });
      const serve = item.createDiv({ cls: "wb-goal-serve" });
      const serving = state.active.filter(hold => hold.goalPaths?.includes(goal.path));
      if (serving.length) for (const hold of serving) serve.createSpan({ text: `守着「${hold.text}」` });
      else serve.createSpan({ cls: "is-none", text: "还没有对应的所守" });
    }
    if (goals.length > 5) host.createEl("p", { cls: "wb-more-note", text: `另有 ${goals.length - 5} 个目标，见「全部目标」。` });
  }
  renderAnchorValues(state) {
    const host = this.refs.values; host.empty();
    if (!state.confirmed.length) {
      host.createEl("p", { cls: "wb-empty", text: "你确认过的价值与偏好会列在这里。每记录一次真实取舍（为了什么放弃了什么），就多一条证据。" });
      const talk = this.action(host, "在对话中梳理我看重什么", "values-talk", () => openQuestion(this, "我想梳理自己真正看重的东西。请从我最近一次为了某件事放弃另一件事的经历开始问我。"), "wb-text-btn");
      glyph(talk, "arrow-right");
      return;
    }
    const list = host.createEl("ol", { cls: "wb-values" });
    for (const record of state.confirmed.slice(0, 6)) {
      const item = list.createEl("li", { cls: "wb-value" });
      const open = this.action(item, "", "open-value", () => this.plugin.openVaultPath(record.path), "wb-value-main");
      open.setAttribute("aria-label", `${record.title}，打开记录`);
      open.createEl("b", { text: record.title || "未命名记录" });
      open.createSpan({ cls: "wb-tag", text: EPISTEMIC_LABELS[record.epistemicStatus] || "尚待确认" });
      if (record.summary && record.summary !== record.title) open.createEl("small", { text: record.summary });
    }
    if (state.confirmed.length > 6) this.action(host, `全部 ${state.confirmed.length} 条`, "all-values", () => this.openRecords("知所重", state.confirmed), "wb-text-btn");
  }
  renderAnchorGaps(state, selected) {
    const host = this.refs.gaps; host.empty();
    const gaps = state.active.map(hold => ({ hold, last: latestTest(hold), counts: holdCounts(hold) }))
      .filter(entry => entry.last && !entry.last.kept);
    if (!gaps.length) {
      host.createEl("p", { cls: "wb-empty", text: state.active.some(hold => hold.tests?.length)
        ? "目前记下的考验里，最近一次你都守住了。" : "有了所守和它的考验记录之后，说的和做的对不上时，这里会指出来。" });
    } else {
      const list = host.createEl("ul", { cls: "wb-gaps" });
      for (const { hold, last, counts } of gaps) {
        const item = list.createEl("li", { cls: `wb-gap${selected?.id === hold.id ? " is-linked" : ""}` });
        item.createEl("b", { text: hold.text });
        const pair = item.createEl("dl", { cls: "wb-gap-pair" });
        pair.createEl("dt", { text: "说的" }); pair.createEl("dd", { text: hold.boundary || hold.text });
        pair.createEl("dt", { text: "做的" }); pair.createEl("dd", { text: `${monthDay(localDay(last.at))}，${last.situation}${last.note ? `。${last.note}` : ""}` });
        pair.createEl("dt", { text: "累计" }); pair.createEl("dd", { text: `守住 ${counts.kept} 次，让步 ${counts.yielded} 次` });
        const acts = item.createDiv({ cls: "wb-signal-acts" });
        this.action(acts, "设计一次小行动去践真", "gap-action", () => this.createAction(), "wb-chip-btn is-primary");
        this.action(acts, "重新看这条边界", "gap-edit", () => this.openHoldEditor(hold), "wb-chip-btn");
      }
    }
    if (selected) {
      const goals = (selected.goalPaths || []).length, gap = gaps.some(entry => entry.hold.id === selected.id);
      this.refs.linkHint.textContent = `「${selected.text}」关联 ${goals} 个目标${gap ? "，最近一次考验让步了" : ""}。再点一次取消。`;
    } else this.refs.linkHint.textContent = "";
  }

  async saveHolds(action, payload, message) {
    const hash = this.snapshot?.holds?.hash || "";
    const result = await this.plugin.updateCognitiveHolds(action, payload, hash);
    this.lastTransactionId = result.transactionId; this.wbHoldTransaction = result.transactionId;
    if (this.snapshot) this.snapshot = { ...this.snapshot, holds: { ...(this.snapshot.holds || {}), ...result.holds, hash: result.hash, exists: true, foreign: false } };
    new Notice(message);
    if (!this.closed) { this.renderData(); void this.refresh(); }
    return result;
  }
  openHoldEditor(hold = null, prefill = {}) {
    const goals = this.anchorState().goals;
    new HomeDialog(this, hold ? "修改这条所守" : "写下一条所守", (body, modal) => {
      body.addClass("xz-wb-dialog");
      body.createEl("p", { cls: "dialog-note", text: "写你自己愿意守住的东西。行知只记录，不替你判断对错；保存后写入「01_当前的我/价值与偏好/所守.md」。" });
      const text = dialogField(body, "所守", { value: hold?.text ?? prefill.text, max: 200, placeholder: "例如：不向用户承诺做不到的效果" });
      const why = dialogField(body, "为什么", { multiline: true, value: hold?.why ?? prefill.why, placeholder: "它为什么重要？最好是一段真实经历。" });
      const boundary = dialogField(body, "边界", { multiline: true, value: hold?.boundary ?? prefill.boundary, placeholder: "什么情况下可以让步？让到哪里为止？" });
      const chosen = new Set(hold?.goalPaths || []);
      if (goals.length) {
        const group = body.createDiv({ cls: "field" }); group.createSpan({ text: "它守护哪些目标（可不选）" });
        for (const goal of goals.slice(0, 20)) {
          const row = group.createEl("label", { cls: "check-field" });
          const box = row.createEl("input", { attr: { type: "checkbox" } }); box.checked = chosen.has(goal.path);
          box.addEventListener("change", () => { if (box.checked) chosen.add(goal.path); else chosen.delete(goal.path); });
          row.createSpan({ text: goal.title || goal.path });
        }
      }
      const error = body.createEl("p", { cls: "form-error", attr: { role: "alert" } });
      const footer = body.createDiv({ cls: "dialog-actions" });
      addButton(footer, "取消", () => modal.close());
      const save = addButton(footer, hold ? "保存修改" : "记下这条所守", async () => {
        if (!text.value.trim()) { error.textContent = "请先写下要守住的东西。"; text.focus(); return; }
        save.disabled = true; error.textContent = "";
        try {
          // 只保留目标列表里仍存在的关联，避免目标被移走后保存失败。
          const known = new Set(goals.map(goal => goal.path));
          const goalPaths = [...chosen].filter(path => known.has(path)).slice(0, 8);
          await this.saveHolds("save", { id: hold?.id, text: text.value, why: why.value, boundary: boundary.value, goalPaths }, hold ? "所守已更新" : "所守已记下");
          modal.close();
        } catch (failure) { error.textContent = failure?.message || "保存未完成，填写内容仍保留。"; }
        finally { save.disabled = false; }
      }, { primary: true });
      setTimeout(() => text.focus(), 0);
    }).open();
  }
  openHoldTest(hold) {
    new HomeDialog(this, "记一次考验", (body, modal) => {
      body.addClass("xz-wb-dialog");
      body.createEl("p", { cls: "dialog-note", text: `「${hold.text}」${hold.boundary ? `\n边界：${hold.boundary}` : ""}` });
      const situation = dialogField(body, "当时的情境", { multiline: true, max: 800, placeholder: "什么事让它受到了考验？例如：对方要求在报价里写明提升比例。" });
      const choice = body.createDiv({ cls: "field" }); choice.createSpan({ text: "你最后怎么选的" });
      const toggle = choice.createDiv({ cls: "xz-wb-choice", attr: { role: "radiogroup", "aria-label": "守住或让步" } });
      let kept = null;
      const options = [[true, "守住了"], [false, "让步了"]].map(([value, label]) => {
        const button = toggle.createEl("button", { text: label, cls: "button", attr: { type: "button", role: "radio", "aria-checked": "false" } });
        button.addEventListener("click", () => { kept = value; options.forEach(([v, b]) => { b.setAttribute("aria-checked", String(v === value)); b.toggleClass("primary", v === value); }); });
        return [value, button];
      });
      const dateRow = body.createEl("label", { cls: "field" }); dateRow.createSpan({ text: "日期" });
      const date = dateRow.createEl("input", { attr: { type: "date", max: todayText() } }); date.value = todayText();
      const note = dialogField(body, "事后怎么看（可不填）", { multiline: true, max: 800, placeholder: "如果让步了：边界该调整，还是下次要守住？" });
      const error = body.createEl("p", { cls: "form-error", attr: { role: "alert" } });
      const footer = body.createDiv({ cls: "dialog-actions" });
      addButton(footer, "取消", () => modal.close());
      const save = addButton(footer, "记下这次考验", async () => {
        if (!situation.value.trim()) { error.textContent = "请写下当时的情境。"; situation.focus(); return; }
        if (kept === null) { error.textContent = "请选择守住了还是让步了。"; return; }
        if (!date.value) { error.textContent = "请选择日期。"; date.focus(); return; }
        save.disabled = true; error.textContent = "";
        try {
          await this.saveHolds("test", { id: hold.id, situation: situation.value, kept, at: date.value, note: note.value }, kept ? "已记下：这次守住了" : "已记下：这次让步了");
          modal.close();
        } catch (failure) { error.textContent = failure?.message || "保存未完成，填写内容仍保留。"; }
        finally { save.disabled = false; }
      }, { primary: true });
      setTimeout(() => situation.focus(), 0);
    }).open();
  }
  confirmRetireHold(hold) {
    new HomeDialog(this, "不再守这一条？", (body, modal) => {
      body.addClass("xz-wb-dialog");
      body.createEl("p", { cls: "dialog-note", text: `「${hold.text}」会移到「已不再守」，它的考验记录都会保留，之后可以恢复。` });
      const footer = body.createDiv({ cls: "dialog-actions" });
      addButton(footer, "取消", () => modal.close());
      addButton(footer, "不再守", async () => { await this.saveHolds("retire", { id: hold.id }, "已移到「已不再守」"); modal.close(); }, { primary: true });
    }).open();
  }
  openRetiredHolds(retired) {
    const records = retired.map(hold => ({ ...hold, title: hold.text, summary: `${hold.boundary ? `边界：${hold.boundary}　` : ""}守住 ${holdCounts(hold).kept} 次，让步 ${holdCounts(hold).yielded} 次 · 选择后恢复为正在守` }));
    openList(this, "已不再守", records, { description: "这些是你曾经写下、后来放下的所守。选择一条可以恢复。",
      choose: hold => this.saveHolds("restore", { id: hold.id }, "已恢复为正在守") });
  }
  openAnchorGoals() {
    openList(this, "阶段目标与计划", this.anchorState().goals, {
      description: "来自「05_目标与项目」里的记录，保留原有的来源与认识状态。",
      empty: "还没有可读取的阶段目标。可以先在对话中梳理方向，再按原有确认流程保存。",
      choose: record => this.plugin.openVaultPath(record.path),
    });
  }

  // ======================= 观境页 =======================
  buildPerceiveContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-perceive-hero", attr: { "aria-label": "观境" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "观境" });
    copy.createEl("p", { cls: "wb-page-sub", text: "知时　察势　定位" });
    copy.createEl("p", { cls: "wb-hero-en", text: "PERCEIVE · FIND WHERE YOU STAND" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "在时代与现实中，找到自己的坐标。" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "真正的清晰，\n来自对更大图景的看见。" });
    quote.createEl("small", { text: "观境得到的是关于位置的假设，\n它要到践真里去接受检验。" });

    const upper = content.createDiv({ cls: "wb-row wb-perceive-top" });
    const sit = this.wbPanel(upper, "局面", "THE SITUATION");
    sit.addClass("wb-sit-panel"); sit.addClass("has-horizon");
    sit.createDiv({ cls: "wb-art wb-art-horizon", attr: { "aria-hidden": "true" } });
    this.refs.newSit = this.wbMore(sit, "写下新的局面", "new-situation", "plus", () => this.openSituationComposer());
    sit.createEl("p", { cls: "wb-panel-note", text: "把看到的和以为的分开放。两者混在一起时，人会把猜测当成事实去行动。" });
    this.refs.situation = sit.createDiv({ cls: "wb-sit-host" });
    const place = this.wbPanel(upper, "我的位置", "WHERE I STAND");
    this.refs.selfMore = this.wbMore(place, "当前的我", "self-records", "arrow-right", () => this.openRecords("当前的我", this.snapshot?.self || []));
    this.refs.position = place.createDiv({ cls: "wb-pos-host" });

    const knownRow = content.createDiv({ cls: "wb-row wb-perceive-known-row" });
    const known = this.wbPanel(knownRow, "已知的信息", "KNOWN INFORMATION");
    known.createEl("p", { cls: "wb-panel-note", text: "已有记录中的事实与本人自述；是否适用于这次局面，仍需结合来源确认。" });
    this.refs.perceiveKnown = known.createDiv({ cls: "wb-perceive-known" });
    const lower = content.createDiv({ cls: "wb-row wb-perceive-bottom" });
    const judg = this.wbPanel(lower, "已有判断与依据", "WHAT I THINK AND WHY");
    judg.createDiv({ cls: "wb-art wb-art-peaks", attr: { "aria-hidden": "true" } });
    this.refs.judgMore = this.wbMore(judg, "全部判断", "judgments", "arrow-right", () => this.openRecords("已有判断与依据", this.snapshot?.judgments || []));
    judg.createEl("p", { cls: "wb-panel-note", text: "每个判断都写着凭什么、有多确定、什么会让你改变看法。" });
    this.refs.judgs = judg.createDiv({ cls: "wb-judg-host" });
    const unk = this.wbPanel(knownRow, "还不知道的", "WHAT I DON'T KNOW YET");
    unk.createDiv({ cls: "wb-art wb-art-dawn", attr: { "aria-hidden": "true" } });
    unk.createEl("p", { cls: "wb-panel-note", text: "判断背后的前提和空白。先弄清哪一条，最能改变你接下来的选择。" });
    this.refs.unks = unk.createDiv({ cls: "wb-unk-host" });
    const next = this.wbPanel(lower, "下一步思考方向", "NEXT STEPS");
    next.createEl("p", { cls: "wb-panel-note", text: "从已有材料和未知里继续澄清，不必马上进入行动计划。" });
    this.action(next, "结合已有记录继续讨论", "perceive-discuss", () => openQuestion(this, "请结合我的相关记录，继续分析当前问题：哪些事实、解释和未知会改变判断？先充分展开分析，不强制进入行动计划。"), "wb-chip-btn", "message-circle");
    this.wbMore(next, "关联已有材料", "perceive-materials", "library", () => this.wbGo("archive"));
  }
  perceiveState() {
    const snap = this.snapshot || {};
    const focus = this.model.focus;
    const byPath = new Map();
    for (const record of [...(snap.judgments || []), ...(snap.self || []), ...(snap.actions || []), ...(snap.feedback || [])]) {
      if (record?.path && !byPath.has(record.path)) byPath.set(record.path, record);
    }
    const records = [...byPath.values()];
    const seen = records.filter(record => PERCEIVE_SEEN.has(record.epistemicStatus));
    const read = records.filter(record => PERCEIVE_READ.has(record.epistemicStatus));
    const open = records.filter(record => !PERCEIVE_SEEN.has(record.epistemicStatus) && !PERCEIVE_READ.has(record.epistemicStatus));
    // 有判断快照的行动：当前关注排最前。
    const loops = this.model.loops.filter(loop => loop.judgmentSnapshots?.length);
    if (focus) loops.sort((a, b) => Number(b.id === focus.id) - Number(a.id === focus.id));
    const unknowns = [], known = new Set();
    const push = (value, kind, from, path) => {
      const text = String(value || "").trim();
      if (!text || known.has(text)) return;
      known.add(text); unknowns.push({ text, kind, from, path });
    };
    for (const loop of loops) {
      const latest = loop.judgmentSnapshots.at(-1);
      const from = `来自判断「${perceiveClip(latest.statement, 24)}」`;
      for (const item of latest.assumptions || []) push(item, "假设", from, loop.path);
      for (const item of latest.unknowns || []) push(item, "未知", from, loop.path);
    }
    for (const record of open) push(record.title, "未知", perceiveSource(record), record.path);
    const facts = seen.filter(record => record.epistemicStatus === "fact").length;
    const counts = { fact: facts, said: seen.length - facts, read: read.length, unk: unknowns.length };
    return { focus, seen, read, open, loops, unknowns, counts, judgments: snap.judgments || [], self: snap.self || [] };
  }
  renderPerceive() {
    const state = this.perceiveState();
    this.renderSituation(state);
    this.renderPosition(state);
    this.renderPerceiveJudgments(state);
    this.renderPerceiveUnknowns(state);
    if (this.refs.perceiveKnown) {
      const host = this.refs.perceiveKnown; host.empty();
      if (!state.seen.length) host.createEl("p", { cls: "wb-empty", text: "还没有可读取的事实或本人自述。写下局面或关联一份材料后，它们会在这里出现。" });
      for (const record of state.seen.slice(0, 6)) {
        const row = host.createDiv({ cls: "wb-known-row" });
        row.createEl("small", { cls: "wb-known-status", text: PERCEIVE_TAG[record.epistemicStatus] || "尚待确认" });
        this.action(row, record.title || "未命名记录", "known-record", () => this.plugin.openVaultPath(record.path), "wb-text-btn");
        row.createEl("small", { text: perceiveSource(record) });
      }
      if (state.seen.length > 6) this.action(host, `查看其余 ${state.seen.length - 6} 条`, "perceive-known-all", () => this.openRecords("已知的信息", state.seen), "wb-text-btn");
    }
  }
  openSituationComposer() {
    this.wbPerceiveComposing = true; this.renderData();
    setTimeout(() => this.refs.situation?.querySelector("textarea")?.focus(), 0);
  }
  renderSituation(state) {
    const { focus, seen, read, counts } = state;
    const blank = !focus && !seen.length && !read.length;
    const composing = this.wbPerceiveComposing || blank;
    this.refs.newSit.hidden = composing;
    // 局面里有输入框：内容没变就不重建，避免后台刷新打断输入。
    const signature = [focus?.id, focus?.updatedAt, focus?.problem, ...[...seen, ...read].map(record => `${record.path}:${record.epistemicStatus}:${record.updatedAt}`),
      counts.unk, this.wbPerceiveComposing, blank, Boolean(this.snapshot), Boolean(this.error)].join("|");
    if (signature === this.wbSituationSignature) return;
    this.wbSituationSignature = signature;
    const host = this.refs.situation; host.empty();
    if (!this.snapshot) { host.createEl("p", { cls: "wb-empty", text: this.error ? "暂时读不到本地记录。" : "正在读取你的记录…" }); return; }
    if (composing) { this.renderSituationComposer(host, blank); return; }

    if (focus) {
      const card = host.createDiv({ cls: "wb-sit-focus" });
      const head = card.createDiv({ cls: "wb-sit-fh" });
      head.createEl("small", { text: "眼下的问题" });
      if (focus.updatedAt) head.createSpan({ text: `${monthDay(focus.updatedAt)} 更新` });
      this.action(card, focus.problem || focus.title || "未命名问题", "open-focus", () => openFocus(this, focus), "wb-sit-q");
      card.createDiv({ cls: "wb-vig", attr: { "aria-hidden": "true" } });
    } else {
      glyph(this.action(host, "还没有写下眼下的问题。写一个，局面才有焦点", "new-situation", () => this.openSituationComposer(), "wb-sit-ask"), "arrow-right");
    }

    const strata = host.createDiv({ cls: "wb-strata" });
    const bar = strata.createDiv({ cls: "wb-strata-bar", attr: { role: "img", "aria-label": PERCEIVE_STRATA.map(([key, label]) => `${label} ${counts[key]} 条`).join("，") } });
    for (const [key] of PERCEIVE_STRATA) if (counts[key]) bar.createEl("i", { cls: `s-${key}` }).style.flexGrow = String(counts[key]);
    const keys = strata.createDiv({ cls: "wb-strata-key", attr: { "aria-hidden": "true" } });
    for (const [key, label] of PERCEIVE_STRATA) { const tag = keys.createSpan(); tag.createEl("i", { cls: `s-${key}` }); tag.appendText(`${label} ${counts[key]}`); }
    const reading = strataReading(counts);
    if (reading) strata.createEl("p", { cls: `wb-strata-read${reading.lean ? " is-lean" : ""}`, text: reading.text });

    const split = host.createDiv({ cls: "wb-split" });
    this.renderSitColumn(split, "看到的", "可以核实的事实，和别人或你自己说过的话", seen,
      "还没有一条看到的。只有解读的局面，最容易让人走偏。", "这其实是解读",
      record => `我想重新看这条记录的认识状态：「${record.title || "未命名记录"}」\n它现在记为「${EPISTEMIC_LABELS[record.epistemicStatus] || "尚待确认"}」，但我觉得它其实是一个解读。请帮我分辨：哪些部分是看到的，哪些是我的推想？\n相关记录：${record.path}`);
    this.renderSitColumn(split, "以为的", "推断、假设、价值判断：还需要现实来回答", read,
      "这里是空的。你对局面的看法，也值得写下来被检验。", "列为待验",
      record => `我想把这个看法列为待验：「${record.title || "未命名记录"}」\n请帮我设计一个最小的办法去验证它：看到什么说明它对，看到什么说明它错？\n相关记录：${record.path}`);
  }
  renderSitColumn(parent, title, note, records, empty, actLabel, prompt) {
    const column = parent.createDiv({ cls: "wb-sit-col" });
    const head = column.createDiv({ cls: "wb-sit-colh" });
    head.createEl("b", { text: title }); head.createEl("small", { text: note });
    if (!records.length) { column.createEl("p", { cls: "wb-empty", text: empty }); return; }
    const list = column.createEl("ul", { cls: "wb-sit-list" });
    for (const record of records.slice(0, 6)) {
      const kind = perceiveKind(record.epistemicStatus);
      const item = list.createEl("li", { cls: `wb-sit-item k-${kind}` });
      const open = this.action(item, "", "open-record", () => this.plugin.openVaultPath(record.path), "wb-sit-main");
      open.setAttribute("aria-label", `${record.title || "未命名记录"}，打开记录`);
      open.setAttribute("title", record.summary || record.title || "");
      open.createSpan({ text: record.title || "未命名记录" });
      const meta = item.createDiv({ cls: "wb-sit-meta" });
      meta.createSpan({ cls: `wb-ep ${kind}`, text: PERCEIVE_TAG[record.epistemicStatus] || "尚待确认" });
      meta.createSpan({ cls: "wb-sit-src", text: perceiveSource(record) });
      this.action(meta, actLabel, "sit-recheck", () => openQuestion(this, prompt(record)), "wb-link-btn");
    }
    if (records.length > 6) this.action(column, `全部 ${records.length} 条`, "sit-all", () => this.openRecords(title, records), "wb-text-btn");
  }
  renderSituationComposer(host, blank) {
    if (blank) {
      const intro = host.createDiv({ cls: "wb-empty-art" });
      intro.createDiv({ cls: "wb-vig-road", attr: { "aria-hidden": "true" } });
      intro.createEl("p", { cls: "wb-empty", text: "观境从一个具体的问题开始。写下它，再把看到的、想到的、不确定的分三处写，行知会帮你把它们分开。" });
    }
    const form = host.createDiv({ cls: "wb-sit-form" });
    const inputs = {};
    let submit = null;
    for (const [key, label, hint, placeholder] of PERCEIVE_FIELDS) {
      const id = `xz-wb-sit-${key}-${this.wbUid}`;
      const field = form.createDiv({ cls: `wb-sit-field${key === "q" ? " is-wide" : ""}` });
      const caption = field.createEl("label", { attr: { for: id } });
      caption.createEl("b", { text: label }); caption.createEl("small", { text: hint });
      const input = inputs[key] = field.createEl("textarea", { cls: "wb-question", attr: { id, rows: key === "q" ? "2" : "3", maxlength: "2000", placeholder } });
      input.value = this.wbPerceiveDraft[key] || "";
      input.addEventListener("input", () => { this.wbPerceiveDraft[key] = input.value; });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit?.click(); }
      });
    }
    const error = form.createEl("p", { cls: "wb-form-error", attr: { role: "alert" } });
    const row = form.createDiv({ cls: "wb-composer-actions" });
    submit = this.action(row, "交给行知梳理", "situation-submit", async () => {
      const draft = this.wbPerceiveDraft;
      if (!String(draft.q || "").trim()) { error.textContent = "请先写下眼下的问题。"; inputs.q.focus(); return; }
      submit.disabled = true; error.textContent = "";
      try {
        await this.beginAnalysis(situationPrompt(draft));
        this.wbPerceiveDraft = emptyPerceiveDraft(); this.wbPerceiveComposing = false; this.wbSituationSignature = "";
        if (!this.closed) this.renderData();
      } catch (failure) { error.textContent = failure?.message || "没能打开对话，填写的内容仍保留。"; }
      finally { submit.disabled = false; }
    }, "wb-solid-btn");
    if (!blank) this.action(row, "先不写了", "situation-cancel", () => { this.wbPerceiveComposing = false; this.renderData(); }, "wb-text-btn");
    else row.createSpan({ cls: "wb-sit-hint", text: "行知会帮你检查：哪些“事实”其实是解读。" });
  }
  renderPosition(state) {
    const host = this.refs.position; host.empty();
    const { self, focus } = state, latest = self[0] || null;
    this.refs.selfMore.hidden = !self.length;
    const locus = host.createDiv({ cls: `wb-locus${latest ? "" : " is-dim"}` });
    locus.createDiv({ cls: "wb-emblem", attr: { "aria-hidden": "true" } });
    const copy = locus.createDiv({ cls: "wb-locus-copy" });
    copy.createEl("p", { text: latest ? `从 ${self.length} 条「当前的我」记录里看` : "还看不出你的位置" });
    copy.createEl("small", { text: latest ? "它们合起来，是一个关于你位置的假设" : "行知从「当前的我」里整理出来" });
    const coords = host.createEl("ul", { cls: "wb-coords" });
    const subject = focus ? `\n我眼下的问题是：${focus.problem || focus.title}` : "";
    PERCEIVE_COORDS.forEach(([label, prompt], index) => {
      const item = coords.createEl("li", { cls: "wb-coord" });
      item.createEl("b", { text: label });
      if (index === 2 && latest) {
        const open = this.action(item, "", "open-self", () => this.plugin.openVaultPath(latest.path), "wb-coord-main");
        open.setAttribute("aria-label", `${latest.title || "未命名记录"}，打开记录`);
        open.createSpan({ text: perceiveClip(latest.summary || latest.title, 70) });
        const kind = perceiveKind(latest.epistemicStatus);
        open.createSpan({ cls: `wb-ep ${kind}`, text: PERCEIVE_TAG[latest.epistemicStatus] || "尚待确认" });
      } else {
        this.action(item, prompt, `coord-${index}`, () => openQuestion(this, `我想用观境的「${label}」看一看：${prompt}${subject}`), "wb-coord-ask");
      }
    });
    const cta = host.createDiv({ cls: "wb-test-cta" });
    if (latest) {
      cta.createEl("p", { text: "这是一个关于位置的假设，不是结论。它对不对，要靠行动来回答。" });
      glyph(this.action(cta, "带着它去践真", "to-practice", () => this.wbStepAction(2), "wb-solid-btn"), "arrow-right");
    } else {
      cta.createEl("p", { text: "写下一个局面、聊过几次之后，这里会给出一个关于你位置的假设。" });
      glyph(this.action(cta, "先写写当前的我", "self-talk", () => openQuestion(this, "我想先梳理一下当前的我：手里有什么、缺什么，最近在意什么。请一条一条问我。"), "wb-text-btn"), "arrow-right");
    }
  }
  renderPerceiveJudgments(state) {
    const host = this.refs.judgs; host.empty();
    this.refs.judgMore.hidden = !state.judgments.length;
    if (!state.loops.length && !state.judgments.length) {
      host.createEl("p", { cls: "wb-empty", text: "还没有判断。写下局面后，行知会陪你形成第一个判断，并写清它凭什么成立、什么会推翻它。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-judgs" });
    if (state.loops.length) { for (const loop of state.loops.slice(0, 3)) this.renderJudgCard(list, loop); return; }
    for (const record of state.judgments.slice(0, 4)) {
      const item = list.createEl("li", { cls: "wb-judg is-plain" });
      const open = this.action(item, "", "open-judgment", () => this.plugin.openVaultPath(record.path), "wb-judg-t");
      open.setAttribute("aria-label", `${record.title || "未命名判断"}，打开记录`);
      open.createEl("b", { text: record.title || "未命名判断" });
      if (record.summary && record.summary !== record.title) open.createEl("small", { text: perceiveClip(record.summary, 90) });
      const meta = item.createDiv({ cls: "wb-sit-meta" });
      const kind = perceiveKind(record.epistemicStatus);
      meta.createSpan({ cls: `wb-ep ${kind}`, text: PERCEIVE_TAG[record.epistemicStatus] || "尚待确认" });
      meta.createSpan({ cls: "wb-sit-src", text: perceiveSource(record) });
      this.action(meta, "写清凭什么", "judg-basis", () => openQuestion(this,
        `我想写清这个判断凭什么成立：「${record.title || "未命名判断"}」\n请帮我整理：依据是什么、有多确定、什么情况下我会改变看法。\n相关记录：${record.path}`), "wb-link-btn");
    }
  }
  renderJudgCard(list, loop) {
    const snap = loop.judgmentSnapshots.at(-1);
    const item = list.createEl("li", { cls: "wb-judg" });
    const head = item.createDiv({ cls: "wb-judg-head" });
    const title = this.action(head, "", "open-focus", () => openFocus(this, loop), "wb-judg-t");
    title.setAttribute("aria-label", `${snap.statement}，查看这项行动`);
    title.createEl("b", { text: snap.statement });
    const [ticks, word] = PERCEIVE_CONF[snap.confidence?.level] || PERCEIVE_CONF.unknown;
    const conf = head.createSpan({ cls: "wb-conf", attr: { title: `把握：${word}` } });
    conf.createSpan({ text: "把握" });
    const tickBox = conf.createSpan({ cls: "wb-ticks", attr: { "aria-hidden": "true" } });
    for (let index = 0; index < 3; index += 1) tickBox.createEl("i", index < ticks ? { cls: "is-on" } : {});
    conf.createSpan({ cls: "wb-conf-w", text: word });

    const detail = item.createEl("dl");
    const evidence = snap.evidencePaths || [], basis = snap.confidence?.basis || "";
    detail.createEl("dt", { text: "依据" });
    const evidenceCell = detail.createEl("dd");
    if (evidence.length) {
      evidenceCell.createSpan({ text: `${evidence.length} 条${basis ? `，主要是${perceiveClip(basis, 40)}` : ""}` });
      const refs = evidenceCell.createEl("ul", { cls: "wb-ev" });
      for (const path of evidence.slice(0, 3)) this.action(refs.createEl("li"), perceiveFileName(path), "open-evidence", () => this.plugin.openVaultPath(path), "wb-link-btn");
    } else {
      evidenceCell.addClass("is-none");
      evidenceCell.setText(basis ? `没有附上记录，理由是：${perceiveClip(basis, 50)}` : "还没有依据，现在它只是一个看法");
    }
    const change = snap.changeConditions?.changeCondition || "";
    detail.createEl("dt", { text: "何时改变" });
    detail.createEl("dd", change ? { text: change } : { cls: "is-none", text: "还没写：什么情况下你会放弃它？" });
    if (snap.prediction?.observationWindow) {
      detail.createEl("dt", { text: "观察到" }); detail.createEl("dd", { text: snap.prediction.observationWindow });
    }
    const revision = this.model.changes.find(entry => entry.path === loop.path);
    if (revision) {
      const rev = item.createDiv({ cls: "wb-rev" });
      rev.appendText(`${monthDay(revision.occurredAt)} 修订过：`); rev.createEl("s", { text: perceiveClip(revision.previous, 60) });
      if (revision.because) { rev.createEl("br"); rev.appendText(`改变它的是：${perceiveClip(revision.because, 80)}`); }
    }
    const acts = item.createDiv({ cls: "wb-judg-acts" });
    const subject = `「${snap.statement}」\n相关记录：${loop.path}`;
    this.action(acts, "补上依据", "judg-evidence", () => openQuestion(this, `我想给这个判断补上依据：${subject}\n请帮我找：哪些已经发生的事支持它，哪些和它相反？`), "wb-chip-btn is-primary");
    this.action(acts, change ? "重新看改变的条件" : "写下改变的条件", "judg-change", () => openQuestion(this,
      `我想写清这个判断在什么情况下会被推翻：${subject}\n请问我：看到什么，我就应该放弃或修改它？`), "wb-chip-btn");
  }
  renderPerceiveUnknowns(state) {
    const host = this.refs.unks; host.empty();
    if (!state.unknowns.length) {
      host.createEl("p", { cls: "wb-empty", text: "写下局面时的“还不确定什么”，和判断背后的前提，都会列在这里。知道自己不知道什么，是观境最有用的产出。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-unks" });
    for (const entry of state.unknowns.slice(0, 5)) {
      const item = list.createEl("li", { cls: "wb-unk" });
      const top = item.createDiv({ cls: "wb-unk-t" });
      top.createEl("p", { text: entry.text });
      top.createSpan({ cls: `wb-ep ${entry.kind === "假设" ? "read" : "unk"}`, text: entry.kind });
      item.createEl("small", { text: entry.from });
      const acts = item.createDiv({ cls: "wb-judg-acts" });
      const ref = entry.path ? `\n相关记录：${entry.path}` : "";
      this.action(acts, "去问一个人", "unknown-ask", () => openQuestion(this,
        `关于「${entry.text}」，我想找一个人问清楚。请帮我想：问谁最合适，问哪一两个问题最能得到真实的回答？${ref}`), "wb-chip-btn");
      this.action(acts, "去查一查", "unknown-search", () => openQuestion(this,
        `我想查清这件还不确定的事：「${entry.text}」。请帮我列出可以核实的来源，以及查到什么会改变我的判断。${ref}`), "wb-chip-btn");
      this.action(acts, "设计一次践真", "unknown-practice", () => this.createAction(), "wb-chip-btn is-primary");
    }
    if (state.unknowns.length > 5) host.createEl("p", { cls: "wb-more-note", text: `另有 ${state.unknowns.length - 5} 条，写在各自的判断和记录里。` });
  }

  // ---- 践真页 ----
  buildTestContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-test-hero", attr: { "aria-label": "践真" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "践真" });
    copy.createEl("p", { cls: "wb-page-sub", text: "以行问世　由事求真" });
    copy.createEl("p", { cls: "wb-hero-en", text: "TEST · LET REALITY ANSWER" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "行动不是答案，是向现实提的问题。" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "想得再周全，也只是问题；\n事情怎么发生，才是回答。" });
    quote.createEl("small", { text: "践真收下现实的回答，\n知变再据此改写判断。" });

    const upper = content.createDiv({ cls: "wb-row wb-test-a" });
    const road = this.wbPanel(upper, "待验之事", "WHAT I'M TESTING");
    road.addClass("wb-road-panel");
    road.createDiv({ cls: "wb-art wb-art-path", attr: { "aria-hidden": "true" } });
    this.refs.testNew = this.action(road.wbHead, "设计一次践真", "test-new", () => this.createAction(), "wb-solid-btn wb-head-btn", "plus");
    road.createEl("p", { cls: "wb-panel-note", text: "按回看日排成一条路。每件事都写着：去做什么，预期看到什么，看到什么就算落空。" });
    this.refs.testFilters = road.createDiv({ cls: "wb-filters", attr: { role: "group", "aria-label": "筛选待验之事" } });
    this.refs.testRoad = road.createDiv({ cls: "wb-road-host" });
    const clear = this.wbPanel(upper, "问得清不清", "IS THE QUESTION CLEAR");
    clear.addClass("has-waves");
    clear.createDiv({ cls: "wb-art wb-art-waves", attr: { "aria-hidden": "true" } });
    clear.createEl("p", { cls: "wb-panel-note", text: "问题问得含糊，现实的回答也会含糊。这里只看在验的事缺了什么。" });
    this.refs.testClarity = clear.createDiv({ cls: "wb-clarity-host" });

    const lower = content.createDiv({ cls: "wb-row wb-test-b" });
    const ans = this.wbPanel(lower, "现实的回答", "WHAT REALITY SAID");
    ans.createDiv({ cls: "wb-art wb-art-moon", attr: { "aria-hidden": "true" } });
    this.refs.testAnsCount = ans.wbHead.createSpan({ cls: "wb-count" });
    ans.createEl("p", { cls: "wb-panel-note", text: "当时的预期和实际发生的事，并排放着。落空的那些，往往最值钱。" });
    this.refs.testAnswers = ans.createDiv({ cls: "wb-ans-host" });
    const un = this.wbPanel(lower, "还没拿去验的判断", "NOT YET TESTED");
    un.createDiv({ cls: "wb-art wb-art-peak", attr: { "aria-hidden": "true" } });
    un.createEl("p", { cls: "wb-panel-note", text: "有了判断，还没决定用什么行动去问。" });
    this.refs.testUntested = un.createDiv({ cls: "wb-ut-host" });
  }
  testState() {
    const loops = this.model.active.filter(loop => String(loop.action || "").trim());
    // 已经在回看日（或之后）记下过结果的，算已回答，移到「现实的回答」。
    const pending = loops.filter(loop => {
      const last = (loop.feedbacks || []).at(-1);
      if (!last) return true;
      if (!loop.reviewAt) return false;
      return timeOf(feedbackTime(last)) < localDay(loop.reviewAt).getTime();
    }).map(loop => ({ loop, when: testWhen(loop) }));
    pending.sort((a, b) => (a.when.n === null) - (b.when.n === null) || (a.when.n ?? 0) - (b.when.n ?? 0));
    const count = key => key === "all" ? pending.length
      : key === "week" ? pending.filter(entry => entry.when.key === "today" || entry.when.key === "soon").length
      : pending.filter(entry => entry.when.key === key).length;
    const answers = [];
    for (const loop of this.model.loops) for (const feedback of loop.feedbacks || []) answers.push({ loop, feedback });
    answers.sort((a, b) => timeOf(feedbackTime(b.feedback)) - timeOf(feedbackTime(a.feedback)));
    const untested = this.model.active.filter(loop => String(loop.judgment || "").trim() && !String(loop.action || "").trim());
    return { pending, count, answers, untested };
  }
  renderTest() {
    const state = this.testState();
    if (this.wbTestFilter !== "all" && !state.count(this.wbTestFilter)) this.wbTestFilter = "all";
    this.renderTestRoad(state);
    this.renderTestClarity(state);
    this.renderTestAnswers(state);
    this.renderTestUntested(state);
  }
  renderTestRoad(state) {
    const host = this.refs.testRoad; host.empty();
    const filters = this.refs.testFilters; filters.empty();
    const has = state.pending.length > 0;
    this.refs.testNew.hidden = !has; filters.hidden = !has;
    if (!this.snapshot) { host.createEl("p", { cls: "wb-empty", text: this.error ? "暂时读不到本地记录。" : "正在读取你的记录…" }); return; }
    if (!has) { this.renderTestRoadEmpty(host); return; }
    for (const [key, label] of TEST_FILTERS) {
      const n = state.count(key);
      const chip = filters.createEl("button", { cls: `wb-filter${key === "over" ? " is-over" : ""}`, attr: { type: "button", "aria-pressed": String(this.wbTestFilter === key), "data-action": `test-filter-${key}` } });
      chip.createSpan({ text: label }); chip.createEl("b", { text: String(n) });
      chip.disabled = key !== "all" && !n;
      chip.addEventListener("click", () => { this.wbTestFilter = key; this.renderTest(); });
    }
    const f = this.wbTestFilter;
    const shown = state.pending.filter(({ when }) => f === "all" || (f === "week" ? ["today", "soon"].includes(when.key) : when.key === f));
    const list = host.createEl("ol", { cls: "wb-road" });
    for (const { loop, when } of shown) this.renderTestRow(list, loop, when);
  }
  renderTestRow(list, loop, when) {
    const row = list.createEl("li", { cls: `wb-t-row is-${when.key}` });
    const stamp = row.createDiv({ cls: "wb-t-when" });
    stamp.createEl("b", { text: when.big }); stamp.createEl("small", { text: when.small });
    row.createDiv({ cls: "wb-t-rail", attr: { "aria-hidden": "true" } }).createEl("i");
    const card = row.createDiv({ cls: "wb-t-card" });
    const claim = card.createEl("p", { cls: "wb-t-claim" });
    claim.createEl("small", { text: "验证" }); claim.appendText(loop.judgment || loop.title || "未命名判断");
    const act = card.createEl("p", { cls: "wb-t-act" });
    act.createSpan({ text: "去做" }); act.appendText(loop.action);
    const sig = card.createEl("dl", { cls: "wb-t-sig" });
    const pair = (cls, label, value, missing) => {
      sig.createEl("dt", { cls, text: label });
      sig.createEl("dd", value ? { text: value } : { cls: "is-missing", text: missing });
    };
    pair("exp", "预期", String(loop.expected || "").trim(), "还没写预期");
    pair("yes", "成立的迹象", bindingOf(loop, "successSignal"), "还没写");
    pair("no", "落空的迹象", bindingOf(loop, "failureSignal"), "还没写：看到什么，就说明判断错了？");
    const foot = card.createDiv({ cls: "wb-t-foot" });
    const first = (loop.judgmentSnapshots || [])[0];
    if (first) {
      const [ticks, word] = PERCEIVE_CONF[first.confidence?.level] || PERCEIVE_CONF.unknown;
      const conf = foot.createSpan({ cls: "wb-conf", attr: { title: `初始把握：${word}` } });
      const tickBox = conf.createSpan({ cls: "wb-ticks", attr: { "aria-hidden": "true" } });
      for (let index = 0; index < 3; index += 1) tickBox.createEl("i", index < ticks ? { cls: "is-on" } : {});
      conf.createSpan({ text: `初始把握 ${word}` });
    }
    const windowText = testWindow(loop);
    if (windowText) foot.createSpan({ cls: "wb-t-win", text: `观察 ${windowText}` });
    const acts = foot.createDiv({ cls: "wb-t-acts" });
    this.action(acts, "查看记录", "test-open", () => openFocus(this, loop), "wb-text-btn");
    if (when.key === "none") this.action(acts, "定个回看日", "test-date", () => openQuestion(this,
      `我想给这次践真定一个回看日：「${loop.action}」\n它在验证：${loop.judgment || loop.title}\n请帮我想：多久之后，现实最可能给出清楚的回答？\n相关记录：${loop.path}`), "wb-chip-btn");
    const urgent = when.key === "over" || when.key === "today";
    this.action(acts, "记下现实的回答", "test-answer", () => this.createAction(loop), `wb-chip-btn${urgent ? " is-primary" : ""}`);
  }
  renderTestRoadEmpty(host) {
    const intro = host.createDiv({ cls: "wb-empty-art" });
    intro.createDiv({ cls: "wb-vig-road", attr: { "aria-hidden": "true" } });
    intro.createEl("p", { cls: "wb-empty", text: "还没有放进践真的事。挑一个你拿不准的判断，想一件这周就能做的小事去问问现实。" });
    const sample = host.createDiv({ cls: "wb-t-sample", attr: { "aria-label": "示例" } });
    sample.createEl("p", { cls: "wb-t-sample-h", text: "一次问得清楚的践真，大概是这样" });
    const claim = sample.createEl("p", { cls: "wb-t-claim" });
    claim.createEl("small", { text: "验证" }); claim.appendText("新用户卡住，是因为不知道第一条该写什么。");
    const act = sample.createEl("p", { cls: "wb-t-act" });
    act.createSpan({ text: "去做" }); act.appendText("给 5 位新用户一个写好的第一条示例，不做讲解。");
    const sig = sample.createEl("dl", { cls: "wb-t-sig" });
    sig.createEl("dt", { cls: "exp", text: "预期" }); sig.createEl("dd", { text: "至少 3 人一天内写下自己的第一条" });
    sig.createEl("dt", { cls: "no", text: "落空的迹象" }); sig.createEl("dd", { text: "有了示例，多数人还是没写" });
    const row = host.createDiv({ cls: "wb-composer-actions" });
    glyph(this.action(row, "设计第一次践真", "test-first", () => this.createAction(), "wb-solid-btn"), "plus");
    this.action(row, "先去观境，找一个拿不准的判断", "test-to-perceive", () => this.wbGo("perceive"), "wb-text-btn");
  }
  renderTestClarity(state) {
    const host = this.refs.testClarity; host.empty();
    if (!state.pending.length) {
      host.createEl("p", { cls: "wb-empty", text: "一次问得清楚的践真，要先写下四件事：" });
      const recipe = host.createEl("ol", { cls: "wb-recipe" });
      for (const [title, note] of [["去做什么", "一件这周就能开始的小事，而不是一个计划。"], ["预期看到什么", "判断如果对，现实里会出现什么。"],
        ["看到什么就算落空", "写不出这一条，这件事做完也证明不了你错了。"], ["哪天回来看", "不定日子，践真很容易变成一直在做。"]]) {
        const item = recipe.createEl("li"); item.createEl("b", { text: title }); item.createSpan({ text: note });
      }
      return;
    }
    const groups = [
      ["no", "没写落空的迹象", true, "没有它，这件事做完也说明不了判断错了。", entry => !bindingOf(entry.loop, "failureSignal")],
      ["over", "到了日子还没回答", true, "结果还说不清也没关系，先记下「还说不清」。", entry => entry.when.key === "over"],
      ["exp", "没写预期", false, "不先写下预期，事后很容易觉得“本来就这样”。", entry => !String(entry.loop.expected || "").trim()],
      ["date", "没定回看日", false, "不定日子，践真很容易变成一直在做。", entry => entry.when.key === "none"],
    ].map(([key, label, warn, note, test]) => ({ key, label, warn, note, items: state.pending.filter(test) })).filter(group => group.items.length);
    if (!groups.length) {
      host.createEl("p", { cls: "wb-all-clear", text: `${state.pending.length} 件在验的事，都写清了预期、落空的迹象和回看日。` });
      return;
    }
    const checks = host.createEl("ul", { cls: "wb-checks" });
    for (const group of groups) {
      const item = checks.createEl("li", { cls: `wb-ck${group.warn ? " is-warn" : ""}` });
      const head = item.createDiv({ cls: "wb-ck-h" });
      head.createEl("b", { text: String(group.items.length) }); head.createSpan({ text: group.label });
      item.createEl("p", { text: group.note });
      const list = item.createEl("ul");
      for (const { loop } of group.items.slice(0, 3)) {
        const row = list.createEl("li");
        row.createSpan({ text: perceiveClip(loop.judgment || loop.action || loop.title, 40) });
        if (group.key === "over") this.action(row, "去回答", "clarity-answer", () => this.createAction(loop), "wb-link-btn");
        else this.action(row, "补上", `clarity-${group.key}`, () => openQuestion(this,
          `我想把这次践真问得更清楚，它现在「${group.label}」。\n去做：${loop.action}\n它在验证：${loop.judgment || loop.title}\n请帮我补上这一项。\n相关记录：${loop.path}`), "wb-link-btn");
      }
      if (group.items.length > 3) list.createEl("li", { cls: "wb-ck-more", text: `另有 ${group.items.length - 3} 件` });
    }
  }
  renderTestAnswers(state) {
    const host = this.refs.testAnswers; host.empty();
    this.refs.testAnsCount.textContent = state.answers.length ? `${state.answers.length} 次` : "";
    if (!state.answers.length) {
      host.createEl("p", { cls: "wb-empty", text: "现实还没有回答过。第一次记下结果后，这里会把你当时的预期和实际发生的事并排放着。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-answers" });
    for (const { loop, feedback } of state.answers.slice(0, 4)) {
      const cal = calOf(feedback);
      const item = list.createEl("li", { cls: `wb-ans is-${cal}` });
      const head = item.createDiv({ cls: "wb-ans-h" });
      head.createEl("b", { text: feedback.previousJudgment || loop.judgment || loop.title || "未命名判断" });
      head.createSpan({ cls: `wb-cal ${cal}`, text: CAL_LABEL[cal] });
      const cmp = item.createDiv({ cls: "wb-cmp" });
      const exp = cmp.createDiv(); exp.createEl("small", { text: "当时预期" });
      exp.createEl("p", { text: feedback.judgmentCalibration?.expected || loop.expected || "（当时没写预期）" });
      const obs = cmp.createDiv({ cls: "is-real" }); obs.createEl("small", { text: "实际发生" });
      obs.createEl("p", { text: feedback.result || "（没写结果）" });
      if (DECISION_LABEL[feedback.decision] || isRevision(feedback)) {
        const next = item.createEl("p", { cls: "wb-ans-next" });
        next.createEl("em", { text: DECISION_LABEL[feedback.decision] || "改写" });
        if (isRevision(feedback)) next.appendText(`判断改成：${feedback.revisedJudgment}`);
      }
      const foot = item.createDiv({ cls: "wb-ans-foot" });
      foot.createSpan({ text: `${monthDay(feedbackTime(feedback))} 记下` });
      if ((cal === "falsified" || cal === "weakened") && !isRevision(feedback)) glyph(this.action(foot, "带去知变", "answer-hone", () => this.wbGo("hone"), "wb-link-btn"), "arrow-right");
    }
  }
  renderTestUntested(state) {
    const host = this.refs.testUntested; host.empty();
    if (!state.untested.length) {
      host.createEl("p", { cls: "wb-empty", text: "观境里形成、还没配上行动的判断，会先停在这里，等你决定怎么去问。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-uts" });
    for (const loop of state.untested.slice(0, 4)) {
      const item = list.createEl("li", { cls: "wb-ut" });
      this.action(item, "", "untested-open", () => openFocus(this, loop), "wb-ut-t").createSpan({ text: loop.judgment });
      const meta = item.createDiv({ cls: "wb-sit-meta" });
      meta.createSpan({ cls: "wb-sit-src", text: `${loop.title || "未命名链路"} · ${monthDay(loop.updatedAt)}` });
      this.action(meta, "设计践真", "untested-design", () => openQuestion(this,
        `我想为这个判断设计一次践真：「${loop.judgment}」\n请帮我想：这周能做的一件小事是什么？预期看到什么？看到什么就说明判断错了？哪天回来看？\n相关记录：${loop.path}`), "wb-chip-btn is-primary");
    }
    if (state.untested.length > 4) host.createEl("p", { cls: "wb-more-note", text: `另有 ${state.untested.length - 4} 条。` });
  }

  // ---- 知变页 ----
  buildHoneContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-hone-hero", attr: { "aria-label": "知变" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "知变" });
    copy.createEl("p", { cls: "wb-page-sub", text: "察其异　辨其因　知所变　守所不变" });
    copy.createEl("p", { cls: "wb-hero-en", text: "HONE · LEARN FROM THE GAP" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "差异是学习的起点。" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "知所变，\n亦知所不变。" });
    quote.createEl("small", { text: "该改的改，该守的守；\n两样都留下为什么。" });

    const upper = content.createDiv({ cls: "wb-row wb-hone-a" });
    const gaps = this.wbPanel(upper, "待辨明的差异", "WHERE REALITY DIFFERED");
    gaps.createDiv({ cls: "wb-art wb-art-ring", attr: { "aria-hidden": "true" } });
    this.refs.honeGapCount = gaps.wbHead.createSpan({ cls: "wb-count" });
    gaps.createEl("p", { cls: "wb-panel-note", text: "现实的回答和预期不一样，判断还没动过。先分清差异从哪来，再决定改还是守。" });
    this.refs.honeGaps = gaps.createDiv({ cls: "wb-gaps-host" });
    const scale = this.wbPanel(upper, "逐变与固守", "BETWEEN DRIFT AND DOGMA");
    scale.addClass("has-river");
    scale.createDiv({ cls: "wb-art wb-art-river", attr: { "aria-hidden": "true" } });
    scale.createEl("p", { cls: "wb-panel-note", text: "知变走在两种失败之间。这里不打分，只把两头各有几处值得再看一眼的地方指出来。" });
    this.refs.honeScale = scale.createDiv({ cls: "wb-scale-host" });

    const lower = content.createDiv({ cls: "wb-row wb-hone-b" });
    const changes = this.wbPanel(lower, "近期知变", "HOW MY JUDGMENT CHANGED");
    changes.createDiv({ cls: "wb-art wb-art-ridge", attr: { "aria-hidden": "true" } });
    this.refs.honeChangeCount = changes.wbHead.createSpan({ cls: "wb-count" });
    changes.createEl("p", { cls: "wb-panel-note", text: "每一次改写：原来怎么想，现在怎么想，因为什么。" });
    this.refs.honeChanges = changes.createDiv({ cls: "wb-changes-host" });
    const holds = this.wbPanel(lower, "守所不变", "WHAT I KEPT");
    holds.createDiv({ cls: "wb-art wb-art-hill", attr: { "aria-hidden": "true" } });
    holds.createEl("p", { cls: "wb-panel-note", text: "立心里写下的所守，经历了哪些考验；还有现实回答过、仍然站得住的判断。" });
    this.refs.honeHolds = holds.createDiv({ cls: "wb-holds-host" });

    const band = this.wbPanel(content, "回到观境", "BACK TO PERCEIVE");
    band.addClass("wb-cycle-band");
    band.createDiv({ cls: "wb-art wb-art-ripple", attr: { "aria-hidden": "true" } });
    this.refs.honeCycle = band.createDiv({ cls: "wb-cycle-host" });
  }
  honeState() {
    const gaps = [], revisions = [], kept = [], drift = [], dogma = [];
    for (const loop of this.model.loops) {
      const feedbacks = loop.feedbacks || [];
      let sinceRevision = 0;
      feedbacks.forEach((feedback, index) => {
        sinceRevision += 1;
        if (!isRevision(feedback)) return;
        const version = (loop.judgmentSnapshots || []).find(snap => snap.sourceFeedbackId === feedback.id)?.version || null;
        const entry = { loop, feedback, version, index, oneShot: sinceRevision === 1, why: feedbackWhy(feedback) };
        revisions.push(entry); sinceRevision = 0;
      });
      const last = feedbacks.at(-1);
      if (!last || isRevision(last)) continue;
      const cal = calOf(last);
      if (cal === "falsified" || cal === "weakened") gaps.push({ loop, feedback: last, cal });
      if (cal === "supported") kept.push({ loop, feedback: last });
      // 固守：落空了仍选继续；或最近一次改写之后，现实两次以上不支持，判断没动。
      const since = timeOf((loop.judgmentSnapshots || []).at(-1)?.capturedAt);
      const against = feedbacks.filter(feedback => timeOf(feedbackTime(feedback)) >= since && ["falsified", "weakened"].includes(calOf(feedback))).length;
      if (cal === "falsified" && last.decision === "continue") dogma.push({ kind: "continue", loop, feedback: last });
      else if (against >= 2) dogma.push({ kind: "twice", loop, feedback: last, against });
    }
    for (const entry of revisions) {
      if (!entry.why) drift.push({ kind: "why", ...entry });
      if (entry.oneShot) drift.push({ kind: "once", ...entry });
    }
    const byTime = (a, b) => timeOf(feedbackTime(b.feedback)) - timeOf(feedbackTime(a.feedback));
    gaps.sort(byTime); revisions.sort(byTime); kept.sort(byTime);
    const anchor = this.anchorState();
    const recent = revisions.filter(entry => { const n = dayDiff(feedbackTime(entry.feedback)); return n !== null && n >= -30; }).length;
    return { gaps, revisions, kept, drift, dogma, holds: anchor.active, recent,
      judged: this.model.loops.filter(loop => loop.judgmentSnapshots?.length || String(loop.judgment || "").trim()).length,
      testing: this.model.active.filter(loop => String(loop.action || "").trim()).length };
  }
  renderHone() {
    const state = this.honeState();
    this.renderHoneGaps(state);
    this.renderHoneScale(state);
    this.renderHoneChanges(state);
    this.renderHoneHolds(state);
    this.renderHoneCycle(state);
  }
  honeLocate(id, loop) {
    const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : String(id).replace(/"/gu, "");
    const target = this.refs.main?.querySelector(`[data-hone="${safe}"]`);
    if (!target) return openFocus(this, loop);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-flash"); void target.offsetWidth; target.classList.add("is-flash");
    setTimeout(() => target.classList.remove("is-flash"), 1600);
  }
  honePrompt(entry, ask) {
    const { loop, feedback } = entry;
    const causes = [...(this.wbHoneCauses.get(feedback.id) || [])].map(key => HONE_CAUSES.find(([k]) => k === key)?.[1]).filter(Boolean);
    return `${ask}\n原判断：${feedback.previousJudgment || loop.judgment || loop.title}\n当时预期：${feedback.judgmentCalibration?.expected || loop.expected || "（没写）"}\n实际发生：${feedback.result || "（没写）"}\n现实的回答：${CAL_LABEL[calOf(feedback)]}${causes.length ? `\n我直觉上觉得差异来自：${causes.join("、")}` : ""}\n相关记录：${loop.path}`;
  }
  renderHoneGaps(state) {
    const host = this.refs.honeGaps; host.empty();
    this.refs.honeGapCount.textContent = state.gaps.length ? `${state.gaps.length} 处` : "";
    if (!this.snapshot) { host.createEl("p", { cls: "wb-empty", text: this.error ? "暂时读不到本地记录。" : "正在读取你的记录…" }); return; }
    if (!state.gaps.length) {
      if (state.revisions.length || state.kept.length) {
        host.createEl("p", { cls: "wb-all-clear", text: "最近和预期不一样的回答，都已经辨过了。下一次落空或动摇，会先停在这里。" });
        return;
      }
      const intro = host.createDiv({ cls: "wb-empty-art" });
      intro.createDiv({ cls: "wb-vig-star", attr: { "aria-hidden": "true" } });
      intro.createEl("p", { cls: "wb-empty", text: "现实还没给过和预期不一样的回答。在践真里记下结果后，落空或动摇的会先停在这里，等你分辨差异从哪来。" });
      glyph(this.action(host, "去践真看看在验的事", "hone-to-test", () => this.wbGo("test"), "wb-text-btn"), "arrow-right");
      return;
    }
    const list = host.createEl("ul", { cls: "wb-gaps" });
    for (const entry of state.gaps.slice(0, 4)) {
      const { loop, feedback, cal } = entry;
      const item = list.createEl("li", { cls: `wb-gap is-${cal}`, attr: { "data-hone": feedback.id } });
      const meta = item.createDiv({ cls: "wb-gap-meta" });
      meta.createEl("b", { text: loop.title || "未命名链路" });
      meta.createSpan({ text: `${monthDay(feedbackTime(feedback))} 记下${DECISION_LABEL[feedback.decision] ? ` · 当时选了「${DECISION_LABEL[feedback.decision]}」` : ""}` });
      meta.createSpan({ cls: `wb-cal ${cal}`, text: CAL_LABEL[cal] });
      const claim = item.createEl("p", { cls: "wb-gap-claim" });
      claim.createEl("small", { text: "原判断" }); claim.appendText(feedback.previousJudgment || loop.judgment || loop.title || "未命名判断");
      const cmp = item.createDiv({ cls: "wb-cmp" });
      const exp = cmp.createDiv(); exp.createEl("small", { text: "当时预期" });
      exp.createEl("p", { text: feedback.judgmentCalibration?.expected || loop.expected || "（当时没写预期）" });
      const obs = cmp.createDiv({ cls: "is-real" }); obs.createEl("small", { text: "实际发生" });
      obs.createEl("p", { text: feedback.result || "（没写结果）" });
      const cause = item.createDiv({ cls: "wb-cause" });
      const label = cause.createEl("b", { text: "差异从哪来" }); label.createEl("small", { text: "可多选，先凭直觉" });
      const picks = cause.createDiv({ cls: "wb-cause-picks", attr: { role: "group", "aria-label": "差异从哪来" } });
      const chosen = this.wbHoneCauses.get(feedback.id) || new Set();
      for (const [key, text] of HONE_CAUSES) {
        const pick = picks.createEl("button", { cls: "wb-cause-pick", text, attr: { type: "button", "aria-pressed": String(chosen.has(key)), "data-action": `hone-cause-${key}` } });
        pick.addEventListener("click", () => {
          const set = this.wbHoneCauses.get(feedback.id) || new Set();
          if (set.has(key)) set.delete(key); else set.add(key);
          this.wbHoneCauses.set(feedback.id, set);
          pick.setAttribute("aria-pressed", String(set.has(key)));
        });
      }
      const acts = item.createDiv({ cls: "wb-gap-acts" });
      this.action(acts, "改写判断", "hone-revise", () => this.createAction(loop), "wb-chip-btn is-primary");
      this.action(acts, "暂且不改", "hone-keep", () => openQuestion(this, this.honePrompt(entry,
        "现实这次和我的预期不一样，但我想暂且不改这个判断。请帮我写清：这次为什么不算数？再看到什么，我就一定改？")), "wb-chip-btn");
      this.action(acts, "再验一次", "hone-retest", () => this.createAction(loop), "wb-chip-btn");
      this.action(acts, "和行知一起想", "hone-think", () => openQuestion(this, this.honePrompt(entry,
        "现实的回答和我的预期不一样。请陪我分辨：差异到底从哪来？该改判断，还是该守住它？")), "wb-text-btn wb-gap-think");
    }
    if (state.gaps.length > 4) host.createEl("p", { cls: "wb-more-note", text: `另有 ${state.gaps.length - 4} 处，先辨完上面的。` });
  }
  renderHoneScale(state) {
    const host = this.refs.honeScale; host.empty();
    const unique = list => new Set(list.map(entry => entry.feedback.id)).size;
    const left = unique(state.drift), right = unique(state.dogma);
    const scale = host.createDiv({ cls: "wb-scale", attr: { role: "img", "aria-label": `逐变那头 ${left} 处，固守那头 ${right} 处` } });
    const line = scale.createDiv({ cls: "wb-scale-line" });
    const dotsL = line.createDiv({ cls: "wb-dots l" }); for (let i = 0; i < Math.min(left, 8); i += 1) dotsL.createEl("i");
    line.createDiv({ cls: "wb-scale-mid" });
    const dotsR = line.createDiv({ cls: "wb-dots r" }); for (let i = 0; i < Math.min(right, 8); i += 1) dotsR.createEl("i");
    const ends = scale.createDiv({ cls: "wb-scale-ends", attr: { "aria-hidden": "true" } });
    const endL = ends.createSpan({ text: "逐变" }); endL.createEl("small", { text: "随波改判断" });
    ends.createSpan({ cls: "wb-scale-mid-t", text: "该变的变，该守的守" });
    const endR = ends.createSpan({ text: "固守" }); endR.createEl("small", { text: "现实说了也不改" });
    if (!state.revisions.length && !this.model.loops.some(loop => loop.feedbacks?.length)) {
      host.addClass("is-blank");
      host.createEl("p", { cls: "wb-empty", text: "记录还少，看不出偏向哪一头。改过几次判断、收过几次现实的回答之后，这里会指出两头各有哪几处值得再看。" });
      return;
    }
    host.removeClass("is-blank");
    if (!left && !right) { host.createEl("p", { cls: "wb-all-clear", text: "两头都没有要再看的地方。" }); return; }
    const sides = host.createDiv({ cls: "wb-sides" });
    const side = (cls, title, signals) => {
      const group = sides.createDiv({ cls: `wb-side-g ${cls}` });
      group.createEl("h3", { text: title });
      for (const [label, note, items] of signals) {
        const sig = group.createDiv({ cls: "wb-sig" });
        const head = sig.createDiv({ cls: "wb-sig-h" });
        head.createEl("em", { cls: items.length ? "" : "zero", text: String(items.length) }); head.createSpan({ text: label });
        if (!items.length) continue;
        sig.createEl("p", { text: note });
        const list = sig.createEl("ul");
        for (const entry of items.slice(0, 3)) this.action(list.createEl("li"), perceiveClip(entry.loop.title || entry.feedback.previousJudgment, 22), "hone-locate",
          () => this.honeLocate(entry.feedback.id, entry.loop), "wb-link-btn");
      }
    };
    side("l", "逐变那头", [
      ["改了判断，没写因为什么", "过一阵就说不清当初为什么改了。", state.drift.filter(entry => entry.kind === "why")],
      ["只听了一次回答就改写", "一次结果可能是偶然；改之前可以再问一次。", state.drift.filter(entry => entry.kind === "once")],
    ]);
    side("r", "固守那头", [
      ["落空了，仍选「继续」", "继续可以，但要写下这次为什么不算数。", state.dogma.filter(entry => entry.kind === "continue")],
      ["现实两次不支持，判断没动", "两次都不支持还不动，多半在守不该守的东西。", state.dogma.filter(entry => entry.kind === "twice")],
    ]);
  }
  renderHoneChanges(state) {
    const host = this.refs.honeChanges; host.empty();
    this.refs.honeChangeCount.textContent = state.revisions.length ? `${state.revisions.length} 次` : "";
    if (!state.revisions.length) {
      host.createEl("p", { cls: "wb-empty", text: "还没有改写过判断。每次改写都会留在这里，下次你会想知道当初为什么改。" });
      const sample = host.createDiv({ cls: "wb-ch-card is-sample", attr: { "aria-label": "示例" } });
      const prev = sample.createEl("p", { cls: "wb-ch-prev" }); prev.createEl("small", { text: "原来" }); prev.createEl("s", { text: "新用户流失，是因为功能太少。" });
      const now = sample.createEl("p", { cls: "wb-ch-now" }); now.createEl("small", { text: "现在" }); now.appendText("首页空状态才是新用户流失的主要原因。");
      const why = sample.createEl("p", { cls: "wb-ch-why" }); why.createEl("em", { text: "因为" }); why.appendText("停下的人都停在第一次打开首页之后，新加的功能没人用过。");
      return;
    }
    const list = host.createEl("ol", { cls: "wb-changes" });
    for (const entry of state.revisions.slice(0, 5)) {
      const { loop, feedback, version, why } = entry;
      const item = list.createEl("li", { cls: "wb-ch" });
      const when = item.createDiv({ cls: "wb-ch-when" });
      const n = dayDiff(feedbackTime(feedback));
      when.createEl("b", { text: monthDay(feedbackTime(feedback)) });
      when.createEl("small", { text: n === 0 ? "今天" : n !== null && n < 0 ? `${-n} 天前` : "" });
      item.createDiv({ cls: "wb-ch-rail", attr: { "aria-hidden": "true" } }).createEl("i");
      const card = item.createDiv({ cls: "wb-ch-card", attr: { "data-hone": feedback.id } });
      const head = card.createDiv({ cls: "wb-ch-head" });
      head.createEl("b", { text: loop.title || "未命名链路" });
      if (version) head.createSpan({ cls: "wb-ver", text: `第 ${version} 版判断` });
      const prev = card.createEl("p", { cls: "wb-ch-prev" }); prev.createEl("small", { text: "原来" }); prev.createEl("s", { text: feedback.previousJudgment || "（没记下）" });
      const now = card.createEl("p", { cls: "wb-ch-now" }); now.createEl("small", { text: "现在" }); now.appendText(feedback.revisedJudgment);
      if (why) {
        const line = card.createEl("p", { cls: "wb-ch-why" }); line.createEl("em", { text: "因为" }); line.appendText(stripBecause(why));
      } else {
        const line = card.createDiv({ cls: "wb-ch-why is-missing" }); line.createSpan({ text: "没写因为什么" });
        this.action(line, "补上", "change-why", () => openQuestion(this,
          `我改写过一个判断，但没写为什么改。\n原来：${feedback.previousJudgment}\n现在：${feedback.revisedJudgment}\n现实的回答：${feedback.result || "（没写）"}\n请帮我回想并写清：是什么让我改了看法？\n相关记录：${loop.path}`), "wb-link-btn");
      }
      const foot = card.createDiv({ cls: "wb-ch-foot" });
      this.action(foot, "看这条链路的所有版本", "change-open", () => openFocus(this, loop), "wb-text-btn");
    }
    if (state.revisions.length > 5) host.createEl("p", { cls: "wb-more-note", text: `更早还有 ${state.revisions.length - 5} 次改写。` });
  }
  renderHoneHolds(state) {
    const host = this.refs.honeHolds; host.empty();
    if (!state.holds.length) {
      host.createEl("p", { cls: "wb-empty", text: "立心里还没写下所守。所守是你不愿轻易换掉的东西；写下来，知变时才分得清哪些该改、哪些该守。" });
      glyph(this.action(host, "去立心写下所守", "hone-to-anchor", () => this.wbGo("anchor"), "wb-text-btn"), "arrow-right");
    } else {
      const list = host.createEl("ul", { cls: "wb-hd-list" });
      for (const hold of state.holds.slice(0, 4)) {
        const item = list.createEl("li", { cls: "wb-hd" });
        item.createEl("p", { cls: "wb-hd-t", text: hold.text });
        if (hold.why) item.createEl("p", { cls: "wb-hd-why", text: hold.why });
        const counts = holdCounts(hold);
        const trail = item.createDiv({ cls: "wb-trail" });
        if (counts.total) {
          const pips = trail.createSpan({ cls: "wb-pips", attr: { "aria-hidden": "true" } });
          for (const test of [...(hold.tests || [])].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-10)) pips.createEl("i", test.kept ? {} : { cls: "gave" });
          trail.createSpan({ text: `考验 ${counts.total} 次，守住 ${counts.kept} 次` });
        } else trail.createSpan({ text: "还没经历过考验" });
        const last = latestTest(hold);
        if (last) {
          const line = item.createEl("p", { cls: "wb-hd-last" });
          line.createEl("em", { cls: last.kept ? "kept" : "gave", text: last.kept ? "守住了" : "让步了" });
          line.appendText(`${monthDay(localDay(last.at))} · ${last.situation || ""}${last.note ? `。${last.note}` : ""}`);
        }
      }
    }
    if (!state.kept.length) return;
    const sub = host.createEl("h3", { cls: "wb-sub-h", text: "现实回答过、仍然站得住的判断" });
    sub.createEl("small", { text: `${state.kept.length} 条` });
    const kept = host.createEl("ul", { cls: "wb-kept" });
    for (const { loop, feedback } of state.kept.slice(0, 3)) {
      const item = kept.createEl("li");
      const top = item.createDiv({ cls: "wb-kept-t" });
      top.createSpan({ cls: "wb-cal supported", text: CAL_LABEL.supported });
      this.action(top, "", "kept-open", () => openFocus(this, loop), "wb-link-btn wb-kept-claim").createSpan({ text: loop.judgment || feedback.previousJudgment || loop.title });
      if (feedback.result) item.createEl("p", { text: perceiveClip(feedback.result, 90) });
    }
  }
  renderHoneCycle(state) {
    const host = this.refs.honeCycle; host.empty();
    const cycle = host.createEl("ol", { cls: "wb-cycle" });
    const nodes = [
      [0, `${state.judged}`, "条判断在看"], [1, `${state.holds.length}`, "条所守"], [2, `${state.testing}`, "件在验"], [3, `${state.recent}`, "次改写（30 天内）"],
    ];
    for (const [index, count, label] of nodes) {
      const step = WB_PATH[index];
      const item = cycle.createEl("li", { cls: `wb-cy${index === 3 ? " is-here" : ""}` });
      const button = this.action(item, "", `cycle-${index}`, () => index === 3 ? null : this.wbStepAction(index), "wb-cy-btn");
      button.setAttribute("aria-label", `${step.name}：${count} ${label}`);
      if (index === 3) button.setAttribute("aria-current", "page");
      glyph(button, step.icon, "wb-cy-ic");
      const name = button.createEl("b", { text: step.name }); name.createEl("small", { text: step.verb });
      const line = button.createSpan({ cls: "wb-cy-n" }); line.createEl("strong", { text: count }); line.appendText(label);
    }
    const back = cycle.createEl("li", { cls: "wb-cy-back" });
    if (state.recent) {
      back.createEl("p", { text: "改写后的判断，会成为下一次观境的起点。" });
      glyph(this.action(back, "带着新判断回到观境", "cycle-back", () => this.wbGo("perceive"), "wb-solid-btn"), "arrow-right");
    } else {
      back.createEl("p", { text: "走完一次践真、改写过判断，这里会接上下一次观境。" });
      glyph(this.action(back, "先去观境", "cycle-back", () => this.wbGo("perceive"), "wb-text-btn"), "arrow-right");
    }
  }

  // ---- 藏知 ----
  buildArchiveContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-arc-hero", attr: { "aria-label": "藏知" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "藏知" });
    copy.createEl("p", { cls: "wb-page-sub", text: "聚其散　连其脉　见其变" });
    copy.createEl("p", { cls: "wb-hero-en", text: "ARCHIVE · WHAT YOU HAVE COME TO KNOW" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "一条一条攒下来的，\n才是你自己的东西。" });
    const quote = hero.createEl("aside", { cls: "wb-hero-quote" });
    quote.createEl("p", { text: "散的是记录，\n连起来才是认知。" });
    quote.createEl("small", { text: "这里只画真实存在的关系；\n虚线是待你确认的线索。" });

    const band = this.wbPanel(content, "入藏之路", "HOW IT GETS HERE");
    band.addClass("wb-arc-flow");
    band.createDiv({ cls: "wb-art wb-art-brook", attr: { "aria-hidden": "true" } });
    this.refs.arcFlow = band.createDiv({ cls: "wb-flow-host" });

    const row = content.createDiv({ cls: "wb-row wb-arc-row" });
    const list = this.wbPanel(row, "知识条目", "ENTRIES");
    list.addClass("wb-arc-list-panel");
    list.createDiv({ cls: "wb-art wb-art-peaks", attr: { "aria-hidden": "true" } });
    this.refs.arcCount = list.wbHead.createSpan({ cls: "wb-count" });
    this.wbMore(list, "打开整理工具", "arc-tool", "arrow-right", () => this.plugin.openKnowledgeStructure());
    const bar = list.createDiv({ cls: "wb-arc-bar" });
    const search = this.refs.arcSearch = bar.createEl("input", {
      cls: "wb-arc-search", attr: { type: "search", placeholder: "搜标题、标签、来源", "aria-label": "搜索知识条目", maxlength: "80" },
    });
    search.value = this.wbArcQuery || "";
    search.addEventListener("input", () => { this.wbArcQuery = search.value; this.renderArchiveList(); });
    const chips = bar.createDiv({ cls: "wb-arc-chips", attr: { role: "group", "aria-label": "筛选" } });
    this.refs.arcChips = new Map();
    for (const [key, text] of ARC_FILTERS) {
      const chip = chips.createEl("button", { cls: "wb-arc-chip", attr: { type: "button", "data-action": `arc-filter-${key}`, "aria-pressed": String((this.wbArcFilter || "all") === key) } });
      chip.createSpan({ text });
      chip.createEl("em", { cls: "wb-arc-chip-n" });
      chip.addEventListener("click", () => { this.wbArcFilter = key; this.renderArchiveList(); });
      this.refs.arcChips.set(key, chip);
    }
    this.refs.arcList = list.createDiv({ cls: "wb-arc-list-host" });

    const column = row.createDiv({ cls: "wb-col wb-arc-graph-column" });
    const map = this.wbPanel(column, "它连着什么", "NEARBY");
    map.addClass("wb-arc-map-panel");
    map.createDiv({ cls: "wb-art wb-art-star", attr: { "aria-hidden": "true" } });
    this.wbMore(map, "展开星图", "arc-expand", "arrow-right", () => this.openArchiveMap());
    this.refs.arcMapHost = map.createDiv({ cls: "wb-star-wrap" });
    this.refs.arcMapNote = map.createEl("p", { cls: "wb-arc-map-note" });
    const detail = this.wbPanel(column, "这一条", "THIS ENTRY");
    detail.addClass("wb-arc-detail-panel");
    detail.createDiv({ cls: "wb-art wb-art-strata", attr: { "aria-hidden": "true" } });
    this.refs.arcDetail = detail.createDiv({ cls: "wb-arc-detail-host" });

    const inbox = this.wbPanel(content, "待入藏", "WAITING TO BE FILED");
    inbox.addClass("wb-arc-inbox");
    inbox.createDiv({ cls: "wb-art wb-art-orb", attr: { "aria-hidden": "true" } });
    this.refs.arcInboxCount = inbox.wbHead.createSpan({ cls: "wb-count" });
    inbox.createEl("p", { cls: "wb-panel-note", text: "这里只显示还等着你判断的内容，依据是文件自己记下的状态：对话沉淀里 promotion_status 停在待确认、待审核或入藏失败的，以及你主动导入的资料 knowledge_status 还是待整理、被中断或失败的。已经整理干净（organized / completed）的对话不会出现在这里，普通问答、临时指令和寒暄本来就不会形成候选。每一项都写明了为什么值得你再看一眼。" });
    this.refs.arcInbox = inbox.createDiv({ cls: "wb-arc-inbox-host" });
  }
  scheduleArchiveRescan() {
    clearTimeout(this.arcTimer);
    this.arcTimer = setTimeout(() => {
      if (this.closed || !this.refs.arcList) return;
      void this.loadArchive(true);
    }, 400);
  }
  // 目录由插件统一维护；先用缓存渲染，再后台重扫一次，避免打开页面时空白。
  async loadArchive(force = false) {
    if (this.arcLoading) { this.arcAgain = true; return; }
    const catalog = this.plugin.getKnowledgeStructureCatalog?.();
    if (!force && catalog?.presentationVersion === 2) { this.arcCatalog = catalog; this.renderArchive(); return; }
    this.arcLoading = true;
    if (catalog) { this.arcCatalog = catalog; this.renderArchive(); }
    try {
      const next = await this.plugin.refreshKnowledgeStructureCatalog?.();
      if (!this.closed) this.arcCatalog = next || this.plugin.getKnowledgeStructureCatalog?.() || null;
    } catch (error) { if (!this.closed) this.arcError = error?.message || "暂时读不到知识目录。"; }
    finally {
      this.arcLoading = false;
      if (!this.closed && this.refs.arcList) this.renderArchive();
      if (this.arcAgain) { this.arcAgain = false; this.scheduleArchiveRescan(); }
    }
  }
  // 把目录、判断快照、笔记双链合成一张图。全部字段都是已有的，不写任何新存储。
  archiveState() {
    const catalog = this.arcCatalog || this.plugin.getKnowledgeStructureCatalog?.() || {};
    // catalog.cards 只含已完成智能提炼的卡片；reviewCards 是同样 knowledge-v1 但摘要待复核的，
    // 藏知要把库看全，两边都算进来，只在列表上标出来。
    const ready = Array.isArray(catalog.cards) ? catalog.cards : [];
    const review = Array.isArray(catalog.reviewCards) ? catalog.reviewCards : [];
    const cards = [...ready, ...review];
    const reviewing = new Set(review.map(card => card.path));
    const plain = (Array.isArray(catalog.ordinaryCards) ? catalog.ordinaryCards : []).filter(card => card.path.startsWith(ARC_ROOT));
    const sources = Array.isArray(catalog.sourceCards) ? catalog.sourceCards : [];
    const entries = [...cards, ...plain];
    const byPath = new Map(entries.map(card => [card.path, card]));
    const byTitle = new Map();
    for (const card of entries) {
      byTitle.set(arcKey(card.title), card);
      for (const alias of card.aliases || []) byTitle.set(arcKey(alias), card);
    }
    const resolve = value => {
      if (!value) return null;
      const text = typeof value === "object" ? String(value.path || value.title || value.knowledge || value.target || "") : String(value);
      const bare = text.replace(/^!?\[\[/u, "").replace(/\]\]$/u, "").split("|")[0].split("#")[0].trim();
      if (!bare) return null;
      return byPath.get(bare) || byTitle.get(arcKey(bare)) || byTitle.get(arcKey(arcName(bare))) || null;
    };
    const nodes = [], edges = [], seenEdge = new Set();
    const addEdge = (kind, a, b, label = "") => {
      if (!a || !b || a === b) return;
      const id = `${kind}:${a}>${b}`;
      if (seenEdge.has(id)) return;
      seenEdge.add(id); edges.push({ id, kind, a, b, label });
    };
    const usedSource = new Set();
    for (const card of entries) {
      const soft = SPECULATIVE.has(card.epistemicStatus);
      const old = Boolean((card.supersededBy || []).length) || card.status === "superseded";
      nodes.push({ id: `k:${card.path}`, kind: "k", label: card.title, title: card.path, old, soft, card });
    }
    for (const card of entries) {
      const self = `k:${card.path}`;
      for (const raw of card.relations || []) {
        const target = resolve(raw);
        if (!target) continue;
        const relation = typeof raw === "object" ? arcKey(raw.relation || raw.type || "related") : "related";
        addEdge("rel", self, `k:${target.path}`, ARC_REL[relation] || ARC_REL.related);
      }
      for (const raw of card.supersededBy || []) {
        const target = resolve(raw);
        if (target) addEdge("rev", `k:${target.path}`, self, "更新");
      }
      for (const raw of card.supersedes || []) {
        const target = resolve(raw);
        if (target) addEdge("rev", self, `k:${target.path}`, "更新");
      }
      const origins = [card.source?.conversationPath, ...(card.source?.documents || [])].filter(Boolean);
      for (const path of origins.slice(0, 6)) {
        const id = `s:${path}`;
        if (!usedSource.has(path)) {
          usedSource.add(path);
          const kind = sources.some(item => item.path === path) || path.startsWith("11_") ? "对话" : "资料";
          nodes.push({ id, kind: "s", label: arcName(path), title: path, sk: kind, path });
        }
        addEdge("src", self, id, "来自");
      }
      // 笔记里的 [[双链]]：Obsidian 已解析好，直接读。
      const links = this.app.metadataCache?.resolvedLinks?.[card.path] || {};
      for (const target of Object.keys(links)) {
        if (target !== card.path && byPath.has(target)) addEdge("rel", self, `k:${target}`, "相关");
      }
    }
    // 判断引用：行动记录的判断快照里列出的依据，如果指向知识条目，就是一条真实引用。
    for (const loop of this.model.loops) {
      const snapshot = (loop.judgmentSnapshots || []).at(-1);
      const cited = [...new Set([...(snapshot?.evidencePaths || []), ...(loop.evidencePaths || [])])]
        .map(path => byPath.get(path)).filter(Boolean);
      if (!cited.length) continue;
      const id = `j:${loop.id}`;
      nodes.push({ id, kind: "j", label: loop.title || "未命名判断", title: loop.judgment || loop.title, loop });
      for (const card of cited) addEdge("cite", id, `k:${card.path}`, "引用");
    }
    const firm = new Map(nodes.map(node => [node.id, 0]));
    for (const edge of edges) { firm.set(edge.a, (firm.get(edge.a) || 0) + 1); firm.set(edge.b, (firm.get(edge.b) || 0) + 1); }
    // 线索：共享来源或共享标签的两条知识，画成虚线，等你确认。
    const linked = new Set(edges.filter(edge => edge.kind === "rel").map(edge => arcPair(edge.a, edge.b)));
    const dismissed = this.wbArcDismissed || new Set();
    const groups = new Map();
    for (const card of entries) {
      for (const token of [...(card.tags || []).map(tag => `t:${arcKey(tag)}`), ...(card.source?.documents || []).map(path => `d:${path}`)]) {
        if (!groups.has(token)) groups.set(token, []);
        groups.get(token).push(card);
      }
    }
    const hints = [];
    for (const [token, list] of groups) {
      if (list.length < 2 || list.length > 6) continue;
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
        const a = `k:${list[i].path}`, b = `k:${list[j].path}`, pair = arcPair(a, b);
        if (linked.has(pair) || dismissed.has(pair)) continue;
        linked.add(pair);
        const why = token.startsWith("t:") ? `都带标签「${token.slice(2)}」` : `来自同一份资料 ${arcName(token.slice(2))}`;
        hints.push({ pair, a, b, why, from: list[i], to: list[j] });
        addEdge("infer", a, b, "可能相关");
      }
    }
    const inbox = this.archiveInbox();
    const filed = entries.filter(card => card.format === "knowledge-v1").length;
    const connected = entries.filter(card => (firm.get(`k:${card.path}`) || 0) > 0).length;
    const citedCount = new Set(edges.filter(edge => edge.kind === "cite").map(edge => edge.b)).size;
    return { catalog, entries, sources, nodes, edges, firm, hints, inbox, reviewing,
      counts: { inbox: inbox.length, filed, connected, cited: citedCount, plain: plain.length, total: entries.length } };
  }
  archiveInbox() {
    // 判定只看文件自己记下的状态（arcInboxMeaning），不再看「有没有被某条知识引用为来源」：
    // 一份资料可以既被引用过、又仍有待你审核的候选，按来源过滤会把它错误地藏起来。
    const files = (this.app.vault.getMarkdownFiles?.() || [])
      .filter(file => ARC_INBOX.some(prefix => file.path.startsWith(prefix)))
      .filter(file => !file.path.endsWith("-索引.md") && !/\/(?:00_索引|README)\.md$/u.test(file.path));
    return files
      .map(file => {
        const frontmatter = this.app.metadataCache?.getFileCache?.(file)?.frontmatter || {};
        const meaning = arcInboxMeaning(file, frontmatter);
        if (!meaning) return null;
        return {
          path: file.path,
          title: file.basename,
          at: file.stat?.mtime || 0,
          kind: file.path.startsWith("12_") ? "资料" : "对话沉淀",
          ...meaning,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
  }
  openArchiveDeleteMenu(event, label, action) {
    event.preventDefault();
    event.stopPropagation();
    if (this.arcBusy) return;
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(label)
      .setIcon("trash-2")
      .onClick(() => Promise.resolve().then(action).catch(error => new Notice(error?.message || "删除未完成"))));
    menu.showAtMouseEvent(event);
  }
  async trashArchiveRecord(path, allowedPrefixes) {
    const safePath = String(path || "");
    if (!allowedPrefixes.some(prefix => safePath.startsWith(prefix)) || !safePath.endsWith(".md")) {
      throw new Error("该文件不在藏知允许删除的范围内");
    }
    const file = this.app.vault.getAbstractFileByPath?.(safePath);
    if (!file || Array.isArray(file.children) || file.extension !== "md") throw new Error("文件已经移动或不存在");
    if (typeof this.app.fileManager?.trashFile === "function") await this.app.fileManager.trashFile(file);
    else if (typeof this.app.vault?.trash === "function") await this.app.vault.trash(file, false);
    else throw new Error("当前 Obsidian 环境不支持可恢复删除");
  }
  async deleteArchiveEntry(card) {
    if (this.arcBusy || !card?.path) return;
    this.arcBusy = true;
    let changed = false;
    try {
      if (card.format === "knowledge-v1"
        && typeof this.plugin?.previewKnowledgeRemoval === "function"
        && typeof this.plugin?.applyKnowledgeRemoval === "function") {
        const preview = await this.plugin.previewKnowledgeRemoval(card.path);
        const confirmed = await confirmHomeDestructiveAction(this, {
          title: `删除知识条目：${preview.title || card.title || "未命名知识"}`,
          message: `对应文件：${preview.path}\n\n这条正式知识会移入可恢复的知识回收站，不会永久删除；来源对话与证据会保留。目录索引会自动更新，但其他笔记中的手写链接不会自动改写。确认继续吗？`,
          confirmLabel: "移入知识回收站",
        });
        if (!confirmed) return;
        await this.plugin.applyKnowledgeRemoval(preview.id);
        new Notice(`“${preview.title || card.title || "该知识"}”已移入知识回收站，可在整理工具中撤销`);
      } else {
        const confirmed = await confirmHomeDestructiveAction(this, {
          title: `删除知识条目：${card.title || "未命名条目"}`,
          message: `对应文件：${card.path}\n\n这是一条尚未采用正式知识结构的笔记，将移入 Obsidian 回收站，不会永久删除。确认继续吗？`,
          confirmLabel: "移入回收站",
        });
        if (!confirmed) return;
        await this.trashArchiveRecord(card.path, [ARC_ROOT]);
        new Notice(`“${card.title || "该条目"}”已移入 Obsidian 回收站`);
      }
      changed = true;
      if (this.wbArcSelected === card.path) this.wbArcSelected = null;
    } finally {
      this.arcBusy = false;
      if (changed && !this.closed) {
        this.arcCatalog = null;
        await this.loadArchive(true);
      }
    }
  }
  async deleteArchiveInboxItem(item) {
    if (this.arcBusy || !item?.path) return;
    this.arcBusy = true;
    let changed = false;
    try {
      const confirmed = await confirmHomeDestructiveAction(this, {
        title: `移除待入藏：${item.title || "未命名内容"}`,
        message: `待入藏记录：${item.path}\n\n删除后，这份整理记录会移入 Obsidian 回收站，并从“待入藏”列表消失；原始对话、证据文件或原始附件不会一起删除。确认继续吗？`,
        confirmLabel: "移除待入藏记录",
      });
      if (!confirmed) return;
      await this.trashArchiveRecord(item.path, ARC_INBOX);
      changed = true;
      new Notice(`“${item.title || "该内容"}”已从待入藏移除，原始来源仍保留`);
    } finally {
      this.arcBusy = false;
      if (changed && !this.closed) {
        this.arcCatalog = null;
        await this.loadArchive(true);
      }
    }
  }
  renderArchive() {
    if (!this.refs.arcList) return;
    if (!this.arcCatalog && !this.arcLoading) { void this.loadArchive(); }
    this.arcState = this.archiveState();
    this.renderArchiveFlow();
    this.renderArchiveList();
    this.renderArchiveInbox();
  }
  renderArchiveFlow() {
    const host = this.refs.arcFlow; host.empty();
    const { counts } = this.arcState;
    if (!this.arcCatalog) {
      host.createEl("p", { cls: "wb-empty", text: this.arcError || "正在读取知识目录…" });
      return;
    }
    const steps = [
      ["待入藏", counts.inbox, "有明确理由、仍待你判断的内容", "arc-flow-inbox"],
      ["已成条目", counts.total, `其中 ${counts.filed} 条是结构化知识`, "arc-flow-filed"],
      ["连上关系", counts.connected, "至少有一条真实连线", "arc-flow-linked"],
      ["被判断引用", counts.cited, "在判断的依据里出现过", "arc-flow-cited"],
    ];
    const flow = host.createEl("ol", { cls: "wb-flow" });
    steps.forEach(([label, value, note, name], index) => {
      const item = flow.createEl("li", { cls: `wb-flow-step${value ? "" : " is-zero"}` });
      const button = this.action(item, "", name, () => this.archiveFlowJump(index), "wb-flow-btn");
      button.setAttribute("aria-label", `${label}：${value} 条。${note}`);
      button.createEl("strong", { text: String(value) });
      button.createEl("b", { text: label });
      button.createEl("small", { text: note });
      if (index < steps.length - 1) glyph(item, "chevron-right", "wb-flow-arrow");
    });
    if (!counts.total) return;
    const lone = counts.total - counts.connected;
    host.createEl("p", { cls: "wb-arc-flow-note", text: lone
      ? `还有 ${lone} 条没连上任何东西。孤立的知识不会在你需要时被想起。`
      : `${counts.total} 条都连上了。被判断引用过的有 ${counts.cited} 条。` });
  }
  archiveFlowJump(index) {
    if (index === 0) { this.refs.arcInbox?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    this.wbArcFilter = ["all", "all", "linked", "cited"][index] || "all";
    this.renderArchiveList();
    this.refs.arcList?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  archiveVisible() {
    const { entries, firm, edges } = this.arcState;
    const query = arcKey(this.wbArcQuery);
    const filter = this.wbArcFilter || "all";
    const cited = new Set(edges.filter(edge => edge.kind === "cite").map(edge => edge.b));
    return entries.filter(card => {
      if (filter === "lone" && (firm.get(`k:${card.path}`) || 0) > 0) return false;
      if (filter === "linked" && !(firm.get(`k:${card.path}`) || 0)) return false;
      if (filter === "cited" && !cited.has(`k:${card.path}`)) return false;
      if (filter === "soft" && !SPECULATIVE.has(card.epistemicStatus)) return false;
      if (filter === "old" && !(card.supersededBy || []).length && card.status !== "superseded") return false;
      if (filter === "plain" && card.format === "knowledge-v1") return false;
      if (!query) return true;
      const hay = [card.title, card.path, (card.tags || []).join(" "), (card.aliases || []).join(" "),
        card.excerpt || "", card.source?.conversationPath || ""].join(" ").toLowerCase();
      return hay.includes(query);
    });
  }
  renderArchiveList() {
    if (!this.arcState) return;
    const { entries, firm } = this.arcState;
    for (const [key, chip] of this.refs.arcChips || []) {
      chip.setAttribute("aria-pressed", String((this.wbArcFilter || "all") === key));
      const saved = this.wbArcFilter, savedQuery = this.wbArcQuery;
      this.wbArcFilter = key; this.wbArcQuery = "";
      const n = this.archiveVisible().length;
      this.wbArcFilter = saved; this.wbArcQuery = savedQuery;
      chip.querySelector(".wb-arc-chip-n").textContent = n ? String(n) : "";
      chip.classList.toggle("is-zero", !n);
    }
    const visible = this.archiveVisible();
    this.refs.arcCount.textContent = entries.length ? `${visible.length} / ${entries.length} 条` : "";
    const host = this.refs.arcList; host.empty();
    if (!this.arcCatalog) { host.createEl("p", { cls: "wb-empty", text: this.arcError || "正在读取知识目录…" }); this.renderArchiveMap(); this.renderArchiveDetail(); return; }
    if (!entries.length) {
      const intro = host.createDiv({ cls: "wb-empty-art" });
      intro.createDiv({ cls: "wb-vig-star", attr: { "aria-hidden": "true" } });
      intro.createEl("p", { cls: "wb-empty", text: "09_认知资产里还没有条目。在对话里聊清一件事，整理入藏之后，它会出现在这里，并和来源连起来。" });
      glyph(this.action(host, "去对话说说正在发生的事", "arc-to-chat", () => this.plugin.activateWorkbench("chat"), "wb-text-btn"), "arrow-right");
      this.renderArchiveMap(); this.renderArchiveDetail();
      return;
    }
    if (!visible.length) {
      host.createEl("p", { cls: "wb-empty", text: "这个条件下没有条目。换个筛选或清空搜索。" });
      this.action(host, "看全部", "arc-clear", () => { this.wbArcFilter = "all"; this.wbArcQuery = ""; if (this.refs.arcSearch) this.refs.arcSearch.value = ""; this.renderArchiveList(); }, "wb-text-btn");
      this.renderArchiveMap(); this.renderArchiveDetail();
      return;
    }
    if (!visible.some(card => card.path === this.wbArcSelected)) this.wbArcSelected = visible[0].path;
    const list = host.createEl("ul", { cls: "wb-arc-list" });
    for (const card of visible.slice(0, 60)) {
      const degree = firm.get(`k:${card.path}`) || 0;
      const old = Boolean((card.supersededBy || []).length) || card.status === "superseded";
      const item = list.createEl("li", {
        cls: `wb-arc-item${card.path === this.wbArcSelected ? " is-sel" : ""}${degree ? "" : " is-lone"}${old ? " is-old" : ""}`,
        attr: { "data-arc": card.path },
      });
      item.addEventListener("contextmenu", event => this.openArchiveDeleteMenu(event, "移入回收站", () => this.deleteArchiveEntry(card)));
      const button = this.action(item, "", "arc-pick", () => this.selectArchive(card.path), "wb-arc-item-btn");
      button.setAttribute("aria-label", `${card.title}，${degree ? `${degree} 条连线` : "还没连上"}`);
      if (card.path === this.wbArcSelected) button.setAttribute("aria-current", "true");
      button.createEl("b", { text: card.title });
      const meta = button.createDiv({ cls: "wb-arc-meta" });
      meta.createSpan({ cls: "wb-arc-type", text: ARC_TYPE[card.knowledgeType] || ARC_TYPE[card.type] || "笔记" });
      if (card.epistemicStatus) meta.createSpan({ cls: `wb-arc-epi is-${card.epistemicStatus}`, text: EPISTEMIC_LABELS[card.epistemicStatus] || card.epistemicStatus });
      if (card.format !== "knowledge-v1") meta.createSpan({ cls: "wb-arc-epi is-plain", text: "未结构化" });
      else if (this.arcState.reviewing.has(card.path)) meta.createSpan({ cls: "wb-arc-epi is-plain", text: "摘要待复核" });
      if (old) meta.createSpan({ cls: "wb-arc-epi is-old", text: "被更新过" });
      meta.createSpan({ cls: "wb-arc-deg", text: degree ? `${degree} 连线` : "还没连上" });
      if (card.updatedAt) meta.createSpan({ text: monthDay(card.updatedAt) });
      if (card.excerpt) button.createEl("p", { text: perceiveClip(card.excerpt, 88) });
      const remove = this.action(item, "移入回收站", "arc-delete", () => this.deleteArchiveEntry(card), "wb-arc-delete is-icon", "trash-2");
      remove.disabled = this.arcBusy;
    }
    if (visible.length > 60) host.createEl("p", { cls: "wb-more-note", text: `另有 ${visible.length - 60} 条，用搜索找它们。` });
    this.renderArchiveMap();
    this.renderArchiveDetail();
  }
  selectArchive(path) {
    this.wbArcSelected = path;
    this.renderArchiveList();
    this.wbArcMap?.select(`k:${path}`);
  }
  archiveNeighbours(id) {
    const { edges } = this.arcState;
    const near = new Set([id]);
    for (const edge of edges) {
      if (edge.a === id) near.add(edge.b);
      if (edge.b === id) near.add(edge.a);
    }
    if (near.size <= 2) for (const edge of edges) {
      if (near.has(edge.a)) near.add(edge.b);
      if (near.has(edge.b)) near.add(edge.a);
    }
    return near;
  }
  renderArchiveMap() {
    const host = this.refs.arcMapHost;
    if (!host) return;
    const { nodes, edges } = this.arcState;
    const selected = this.wbArcSelected ? `k:${this.wbArcSelected}` : null;
    if (!nodes.length) {
      this.wbArcMap?.destroy(); this.wbArcMap = null;
      host.empty();
      host.createDiv({ cls: "wb-star-blank" }).createEl("p", { text: "还没有条目可以连。" });
      this.refs.arcMapNote.textContent = "";
      return;
    }
    if (!this.wbArcMap) {
      host.empty();
      this.wbArcPos = this.wbArcPos || new Map();
      this.wbArcMap = new WbStarMap(host, {
        pos: this.wbArcPos,
        reduced: this.contentEl.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
        mini: true,
        onSelect: id => this.archiveMapPick(id),
      });
      const zoom = host.createDiv({ cls: "wb-star-zoom" });
      this.action(zoom, "放大", "arc-zoom-in", () => this.wbArcMap?.zoomBy(1.2), "wb-star-zbtn is-icon", "plus");
      this.action(zoom, "缩小", "arc-zoom-out", () => this.wbArcMap?.zoomBy(0.83), "wb-star-zbtn is-icon", "minus");
      this.action(zoom, "回到全图", "arc-zoom-fit", () => this.wbArcMap?.fit(true), "wb-star-zbtn is-icon", "maximize");
    }
    const near = selected ? this.archiveNeighbours(selected) : null;
    const shown = near ? nodes.filter(node => near.has(node.id)) : nodes;
    const keep = new Set(shown.map(node => node.id));
    this.wbArcMap.resize();
    this.wbArcMap.setData(shown, edges.filter(edge => keep.has(edge.a) && keep.has(edge.b)));
    this.wbArcMap.select(selected);
    const count = shown.length - (near ? 1 : 0);
    this.refs.arcMapNote.textContent = near
      ? (count ? `这一条周围 ${count} 个邻居。拖动可以挪，滚轮缩放。` : "这一条还没连上任何东西。")
      : `${nodes.length} 个节点。拖动可以挪，滚轮缩放。`;
  }
  archiveMapPick(id) {
    if (id.startsWith("k:")) return this.selectArchive(id.slice(2));
    const node = this.arcState.nodes.find(item => item.id === id);
    if (node?.kind === "s") return this.plugin.openVaultPath(node.path);
    if (node?.loop) return openFocus(this, node.loop);
    return null;
  }
  renderArchiveDetail() {
    const host = this.refs.arcDetail; host.empty();
    const card = this.arcState.entries.find(item => item.path === this.wbArcSelected);
    if (!card) { host.createEl("p", { cls: "wb-empty", text: "选中左边任意一条，这里显示它的来源、关系和引用。" }); return; }
    const { edges, hints, firm } = this.arcState;
    const self = `k:${card.path}`;
    const nodeOf = id => this.arcState.nodes.find(node => node.id === id);
    host.createEl("h3", { cls: "wb-arc-d-title", text: card.title });
    const meta = host.createDiv({ cls: "wb-arc-meta" });
    meta.createSpan({ cls: "wb-arc-type", text: ARC_TYPE[card.knowledgeType] || ARC_TYPE[card.type] || "笔记" });
    if (card.epistemicStatus) meta.createSpan({ cls: `wb-arc-epi is-${card.epistemicStatus}`, text: EPISTEMIC_LABELS[card.epistemicStatus] || card.epistemicStatus });
    meta.createSpan({ text: card.updatedAt ? `${monthDay(card.updatedAt)} 更新` : "更新时间未记录" });
    if (card.excerpt) host.createEl("p", { cls: "wb-arc-d-sum", text: perceiveClip(card.excerpt, 220) });
    if (SPECULATIVE.has(card.epistemicStatus)) {
      host.createEl("p", { cls: "wb-arc-d-warn", text: `这条还是${EPISTEMIC_LABELS[card.epistemicStatus] || "待验证"}。用它做决定之前，先去践真验一次。` });
    }
    const section = (title, note = "") => {
      const block = host.createDiv({ cls: "wb-arc-d-sec" });
      const head = block.createEl("h4", { text: title });
      if (note) head.createEl("small", { text: note });
      return block;
    };
    const origins = edges.filter(edge => edge.kind === "src" && edge.a === self);
    const originBlock = section("从哪来", "来源写在笔记的 frontmatter 里");
    if (origins.length) {
      const list = originBlock.createEl("ul", { cls: "wb-arc-links" });
      for (const edge of origins.slice(0, 6)) {
        const node = nodeOf(edge.b);
        const item = list.createEl("li");
        this.action(item, "", "arc-open-src", () => this.plugin.openVaultPath(node.path), "wb-link-btn")
          .createSpan({ text: `${node.sk} · ${node.label}` });
      }
    } else originBlock.createEl("p", { cls: "wb-arc-d-thin", text: "没写来源。以后整理入藏时带上来源，就能追回原话。" });

    const relations = edges.filter(edge => edge.kind === "rel" && (edge.a === self || edge.b === self));
    const revisions = edges.filter(edge => edge.kind === "rev" && (edge.a === self || edge.b === self));
    const relBlock = section("连着什么", `${relations.length + revisions.length} 条真实关系`);
    if (relations.length || revisions.length) {
      const list = relBlock.createEl("ul", { cls: "wb-arc-links" });
      for (const edge of [...relations, ...revisions].slice(0, 10)) {
        const other = nodeOf(edge.a === self ? edge.b : edge.a);
        if (!other) continue;
        const item = list.createEl("li");
        item.createSpan({ cls: `wb-arc-rel is-${edge.kind}`, text: edge.kind === "rev" ? (edge.a === self ? "更新了" : "被更新") : edge.label });
        this.action(item, "", "arc-open-rel", () => this.selectArchive(other.card.path), "wb-link-btn").createSpan({ text: other.label });
      }
    } else relBlock.createEl("p", { cls: "wb-arc-d-thin", text: "还没有任何关系。它在库里是孤立的。" });

    const cites = edges.filter(edge => edge.kind === "cite" && edge.b === self);
    const citeBlock = section("谁用过它", "来自行动记录里的判断依据");
    if (cites.length) {
      const list = citeBlock.createEl("ul", { cls: "wb-arc-links" });
      for (const edge of cites.slice(0, 8)) {
        const node = nodeOf(edge.a);
        const item = list.createEl("li");
        this.action(item, "", "arc-open-cite", () => openFocus(this, node.loop), "wb-link-btn").createSpan({ text: node.label });
      }
    } else citeBlock.createEl("p", { cls: "wb-arc-d-thin", text: "还没有判断引用过它。存着而没用上的知识，等于没有。" });

    const mine = hints.filter(hint => hint.a === self || hint.b === self);
    if (mine.length) {
      const hintBlock = section("可能相关", "只是线索，等你确认");
      for (const hint of mine.slice(0, 3)) {
        const other = hint.a === self ? hint.to : hint.from;
        const row = hintBlock.createDiv({ cls: "wb-arc-hint" });
        row.createEl("b", { text: other.title });
        row.createEl("small", { text: hint.why });
        const acts = row.createDiv({ cls: "wb-arc-hint-acts" });
        this.action(acts, "去笔记里写上关联", "arc-hint-yes", () => this.plugin.openVaultPath(card.path), "wb-chip-btn is-primary");
        this.action(acts, "不相关", "arc-hint-no", () => {
          this.wbArcDismissed = this.wbArcDismissed || new Set();
          this.wbArcDismissed.add(hint.pair);
          this.renderArchive();
        }, "wb-chip-btn");
      }
    }
    const acts = host.createDiv({ cls: "wb-arc-d-acts" });
    this.action(acts, "打开这条笔记", "arc-open", () => this.plugin.openVaultPath(card.path), "wb-chip-btn is-primary");
    if (!(firm.get(self) || 0)) {
      this.action(acts, "和行知一起找它的位置", "arc-place", () => openQuestion(this,
        `这条知识现在是孤立的，我想给它找到位置。\n标题：${card.title}\n摘要：${card.excerpt || "（没写摘要）"}\n记录：${card.path}\n请帮我看：它和我已有的哪些认识相关？是支持、依赖，还是更新了旧的看法？`), "wb-chip-btn");
    }
    if (SPECULATIVE.has(card.epistemicStatus)) {
      this.action(acts, "去践真验一次", "arc-to-test", () => this.wbGo("test"), "wb-chip-btn");
    }
    const remove = this.action(acts, "移入回收站", "arc-delete-detail", () => this.deleteArchiveEntry(card), "wb-arc-delete wb-arc-delete-detail is-icon", "trash-2");
    remove.disabled = this.arcBusy;
  }
  renderArchiveInbox() {
    const host = this.refs.arcInbox; host.empty();
    const { inbox } = this.arcState;
    this.refs.arcInboxCount.textContent = inbox.length ? `${inbox.length} 份` : "";
    if (!this.arcCatalog) { host.createEl("p", { cls: "wb-empty", text: this.arcError || "正在读取…" }); return; }
    if (!inbox.length) {
      host.createEl("p", { cls: "wb-all-clear", text: "当前没有通过入藏意义门槛、又仍待处理的内容。普通对话不会为了凑数量出现在这里。" });
      return;
    }
    const list = host.createEl("ul", { cls: "wb-arc-inbox-list" });
    for (const item of inbox.slice(0, 8)) {
      const row = list.createEl("li", { cls: "wb-arc-pend" });
      row.addEventListener("contextmenu", event => this.openArchiveDeleteMenu(event, "从待入藏移除", () => this.deleteArchiveInboxItem(item)));
      const main = row.createDiv({ cls: "wb-arc-pend-main" });
      const head = main.createDiv({ cls: "wb-arc-pend-head" });
      head.createEl("b", { text: item.title });
      head.createSpan({ cls: "wb-arc-type", text: item.kind });
      head.createSpan({ cls: "wb-arc-pend-status", text: item.statusLabel || "等待判断" });
      if (item.at) head.createSpan({ text: monthDay(item.at) });
      main.createEl("p", { cls: "wb-arc-pend-reason", text: `待入藏理由：${item.reason}` });
      const acts = row.createDiv({ cls: "wb-arc-pend-acts" });
      this.action(acts, "整理入藏", "arc-file", () => this.plugin.openKnowledgeStructure(), "wb-chip-btn is-primary");
      this.action(acts, "先看看原文", "arc-peek", () => this.plugin.openVaultPath(item.path), "wb-text-btn");
      const remove = this.action(row, "从待入藏移除", "arc-delete-pending", () => this.deleteArchiveInboxItem(item), "wb-arc-delete wb-arc-delete-pending is-icon", "trash-2");
      remove.disabled = this.arcBusy;
    }
    if (inbox.length > 8) host.createEl("p", { cls: "wb-more-note", text: `另有 ${inbox.length - 8} 份，在整理工具里一起处理。` });
  }
  openArchiveMap() {
    new ArchiveMapModal(this).open();
  }

  // ===== 行知 调律页 (tune) · 2026-09 =====
  // 两条互不相通的持久化通道：
  //   外观四项  -> view state（setPreference + requestSaveLayout），每个视图实例一份
  //   引擎/能力 -> plugin.state.settings（updateSettings 白名单 + saveData）
  // 混用会静默丢设置，所以下面每个控件都标了走哪条。
  tuneSettings() {
    return this.plugin?.state?.settings || {};
  }
  tuneProviders() {
    const list = [
      ...(Array.isArray(this.plugin?.state?.providers) ? this.plugin.state.providers : []),
      ...(Array.isArray(this.plugin?.state?.runtime?.providers) ? this.plugin.state.runtime.providers : []),
    ];
    const merged = new Map();
    for (const item of list) {
      const id = typeof item === "string" ? item : String(item?.id || "");
      if (!id) continue;
      merged.set(id, { ...(merged.get(id) || {}), ...(typeof item === "string" ? { id } : item), id });
    }
    return [...merged.values()].filter(item => item.enabled !== false);
  }
  tuneProviderLabel(id) {
    const found = this.tuneProviders().find(item => item.id === id);
    return String(found?.label || TUNE_PROVIDER_LABELS[id] || id || "—");
  }
  // 模型清单只来自运行时探测（state.runtime.models），没探测过就是空的。
  tuneModels(providerId) {
    const all = Array.isArray(this.plugin?.state?.runtime?.models) ? this.plugin.state.runtime.models : [];
    return all.filter(item => !item?.providerId || item.providerId === providerId);
  }
  // 诊断是 per-provider 的一条记录；拿不到就返回空对象，UI 一律显示「还没诊断过」。
  tuneDiag(providerId) {
    try {
      const all = this.plugin.getConnectionDiagnostics?.();
      const list = Array.isArray(all) ? all : (Array.isArray(all?.providers) ? all.providers : []);
      return list.find(item => item?.providerId === providerId) || {};
    } catch { return {}; }
  }
  // 本轮是否在跑。硬拦截只认 streaming，UI 置灰用更宽的 6 种活跃状态。
  tuneBusy() {
    const conversationId = this.plugin?.state?.activeConversationId;
    if (!conversationId) return false;
    const conversations = this.plugin?.state?.conversations;
    const conversation = Array.isArray(conversations)
      ? conversations.find(item => item?.id === conversationId)
      : conversations?.[conversationId];
    return TUNE_ACTIVE_TURN.has(String(conversation?.turn?.status || ""));
  }
  buildTuneContent(content) {
    const hero = content.createEl("section", { cls: "wb-hero wb-tune-hero", attr: { "aria-label": "调律" } });
    const copy = hero.createDiv({ cls: "wb-hero-copy" });
    copy.createEl("h1", { text: "调律" });
    copy.createEl("p", { cls: "wb-page-sub", text: "让工具合你的手 · 先定音，再开口" });
    copy.createEl("p", { cls: "wb-hero-en", text: "TUNE THE INSTRUMENT BEFORE YOU PLAY" });
    copy.createDiv({ cls: "wb-hero-rule" });
    copy.createEl("p", { cls: "wb-hero-lede", text: "这里只放最常调的几样。\n细项仍在原来的抽屉与弹窗里。" });
    const now = hero.createEl("aside", { cls: "wb-hero-quote wb-now" });
    now.createEl("p", { cls: "wb-now-t", text: "此刻的音" });
    this.refs.tuneNow = now.createDiv({ cls: "wb-now-lines" });
    now.createEl("small", { text: "改动即时生效，只作用于之后的新一轮。" });

    this.refs.tuneLock = content.createDiv({ cls: "wb-lock-host" });

    const row1 = content.createDiv({ cls: "wb-row wb-tune-row1" });
    // 定音：引擎 + 模型 + 连接 + 外部发送授权（走 updateSettings）
    const ding = this.wbPanel(row1, "定音", "ENGINE & MODEL");
    ding.addClass("wb-tune-ding");
    ding.createDiv({ cls: "wb-art wb-art-tune-gold", attr: { "aria-hidden": "true" } });
    ding.createEl("p", { cls: "wb-panel-note", text: "引擎和模型成对选：先定引擎，模型只列它自己的。" });
    this.refs.tuneDing = ding.createDiv({ cls: "wb-tune-ding-host" });
    this.wbMore(ding, "连接细项", "tune-conn", "settings", () => this.tuneOpenSettings());

    // 和弦：Skill 模式 / 透镜固定 / Agent（走 updateSettings）
    const hexian = this.wbPanel(row1, "和弦", "SKILLS · LENSES · AGENT");
    hexian.addClass("wb-tune-hexian");
    hexian.createDiv({ cls: "wb-art wb-art-tune-chord", attr: { "aria-hidden": "true" } });
    this.refs.tuneHexian = hexian.createDiv({ cls: "wb-tune-hexian-host" });
    this.wbMore(hexian, "能力管理", "tune-caps", "package", () => this.tuneOpenCapabilities());

    const row2 = content.createDiv({ cls: "wb-row wb-tune-row2" });
    // 音色：外观（走 setPreference，另一条通道）
    const yinse = this.wbPanel(row2, "音色", "APPEARANCE");
    yinse.addClass("wb-tune-yinse");
    yinse.createDiv({ cls: "wb-art wb-art-tune-hue", attr: { "aria-hidden": "true" } });
    this.refs.tuneYinse = yinse.createDiv({ cls: "wb-tune-yinse-host" });
    yinse.createEl("p", { cls: "wb-pfoot-note", text: "外观即改即见，不动任何记录。深浅跟随 Obsidian 主题。" });

    // 节拍：回看统计，只读
    const jiepai = this.wbPanel(row2, "节拍", "REVIEW RHYTHM");
    jiepai.addClass("wb-tune-jiepai");
    jiepai.createDiv({ cls: "wb-art wb-art-tune-beat", attr: { "aria-hidden": "true" } });
    jiepai.wbHead.createSpan({ cls: "wb-ro", text: "只看不改" });
    jiepai.createEl("p", { cls: "wb-panel-note", text: "回看日按每条行动单独设定，这里只汇总。" });
    this.refs.tuneJiepai = jiepai.createDiv({ cls: "wb-tune-beats-host" });
    this.wbMore(jiepai, "去践真", "tune-to-test", "footprints", () => this.wbGo("test"));

    // 校音：诊断 + 授权 + 能力包
    const jiaoyin = this.wbPanel(row2, "校音", "DIAGNOSTICS & LICENSE");
    jiaoyin.addClass("wb-tune-jiaoyin");
    jiaoyin.createDiv({ cls: "wb-art wb-art-tune-check", attr: { "aria-hidden": "true" } });
    this.refs.tuneJiaoyin = jiaoyin.createDiv({ cls: "wb-tune-jiaoyin-host" });
  }
  tuneOpenSettings() {
    if (typeof this.plugin?.openWorkbenchSettings === "function") return this.plugin.openWorkbenchSettings();
    return this.plugin?.activateWorkbench?.("settings");
  }
  tuneOpenCapabilities() {
    if (typeof this.plugin?.openCapabilityManager === "function") return this.plugin.openCapabilityManager();
    return this.plugin?.activateWorkbench?.("settings");
  }
  // 所有写入都经这里：busy 时不提交，updateSettings 抛错兜住转成 Notice。
  async tuneWrite(patch, label = "已调整") {
    if (this.tuneBusy()) { new Notice("本轮正在生成，引擎与能力暂不能改。等这一轮结束，或先在对话页停止生成。"); return; }
    try {
      await this.plugin.updateSettings(patch);
      new Notice(label);
    } catch (error) {
      new Notice(String(error?.message || error || "设置未保存").slice(0, 200));
    }
    this.renderTune();
  }
  renderTune() {
    if (!this.refs.tuneDing) return;
    const settings = this.tuneSettings();
    const providerId = String(settings.providerId || "codex");
    const model = String(settings.model || "");
    const busy = this.tuneBusy();
    const diag = this.tuneDiag(providerId);
    const models = this.tuneModels(providerId);
    // 模型归属校验：只有当运行时确实探到过清单时才敢说「不成对」，空清单不冤枉用户。
    const mismatch = !!model && models.length > 0 && !models.some(item => String(item?.id || item) === model);

    this.renderTuneLock(busy);
    this.renderTuneNow(providerId, model, mismatch, diag, settings);
    this.renderTuneDing(providerId, model, models, mismatch, diag, settings, busy);
    this.renderTuneHexian(settings, busy);
    this.renderTuneYinse();
    this.renderTuneBeats();
    this.renderTuneJiaoyin(providerId, diag, busy);
  }
  renderTuneLock(busy) {
    const host = this.refs.tuneLock;
    if (!host) return;
    host.empty();
    host.toggleClass("is-on", busy);
    if (!busy) return;
    const lock = host.createDiv({ cls: "wb-lock" });
    glyph(lock, "lock");
    const copy = lock.createDiv();
    copy.createEl("strong", { text: "本轮正在生成，引擎与能力暂不能改" });
    copy.createEl("p", { text: "定音、和弦这类会影响下一轮的设置此时提交会被拒绝。等这一轮回答完，或在对话页先停止生成，再回来调。外观（音色）和浏览、跳转不受影响。" });
  }
  renderTuneNow(providerId, model, mismatch, diag, settings) {
    const host = this.refs.tuneNow;
    if (!host) return;
    host.empty();
    const pinned = Array.isArray(settings.selectedSkills) ? settings.selectedSkills.length : 0;
    const consent = diag?.authorization?.status || "";
    const line = (key, value) => {
      const row = host.createDiv({ cls: "wb-now-line" });
      row.createSpan({ cls: "wb-now-k", text: key });
      row.createSpan({ text: value });
    };
    line("引擎", this.tuneProviderLabel(providerId));
    line("模型", model ? (model + (mismatch ? "（不成对）" : "")) : "尚未选定");
    line("固定透镜", pinned ? `${pinned} 个` : "未固定");
    line("连接", TUNE_CONN_TEXT[diag?.connection?.status] || "还没试过");
    line("外部发送", TUNE_GRANT_TEXT[consent] || "未授权");
  }
  renderTuneDing(providerId, model, models, mismatch, diag, settings, busy) {
    const host = this.refs.tuneDing;
    if (!host) return;
    host.empty();
    const providers = this.tuneProviders();
    if (!providers.length) {
      host.createEl("p", { cls: "wb-hint", text: "还没有可用的引擎。先在「连接细项」里启动本地 Codex，或填一个 API 连接。" });
      return;
    }
    const engField = host.createDiv({ cls: "wb-field" });
    const engLabel = engField.createDiv({ cls: "wb-label" });
    engLabel.createSpan({ text: "引擎" });
    engLabel.createEl("em", { text: "圆点 = 连接状态" });
    const seg = engField.createDiv({ cls: "wb-seg is-cards", attr: { role: "group", "aria-label": "引擎" } });
    for (const provider of providers) {
      const id = provider.id;
      const on = id === providerId;
      const button = seg.createEl("button", {
        cls: "wb-opt" + (on ? " is-on" : ""),
        attr: { type: "button", "data-action": `tune-prov-${id}`, "aria-pressed": String(on), ...(busy ? { disabled: "true" } : {}) },
      });
      const state = this.tuneDiag(id)?.connection?.status || "";
      button.createSpan({ cls: `wb-swatch is-${TUNE_CONN_CLASS[state] || "idle"}`, attr: { "aria-hidden": "true" } });
      const text = button.createDiv({ cls: "wb-opt-copy" });
      text.createSpan({ text: this.tuneProviderLabel(id) });
      const sub = TUNE_PROVIDER_SUB[id] || (provider.protocol === "codex-app-server" ? "本地应用" : "兼容 API");
      text.createEl("em", { text: sub });
      // 换引擎同时清空模型，避免留下上一家的模型 id（updateSettings 会拒绝不成对的组合）。
      if (!on) button.addEventListener("click", () => void this.tuneWrite({ providerId: id, model: null }, `引擎已改为 ${this.tuneProviderLabel(id)}`));
    }

    const modelField = host.createDiv({ cls: "wb-field" });
    const modelLabel = modelField.createDiv({ cls: "wb-label" });
    modelLabel.createSpan({ text: "模型" });
    modelLabel.createEl("em", { text: `只列 ${this.tuneProviderLabel(providerId)} 的` });
    if (!models.length) {
      modelField.createEl("p", {
        cls: "wb-hint",
        text: providerId === "codex" ? "正在读取可用模型…若一直为空，去「连接细项」确认本地 Codex 已启动。" : "尚未发现模型。去「连接细项」填好连接后点「重新诊断」。",
      });
    } else {
      const wrap = modelField.createDiv({ cls: "wb-select-wrap" });
      const select = wrap.createEl("select", { cls: "wb-select", attr: { "aria-label": "模型", ...(busy ? { disabled: "true" } : {}) } });
      if (mismatch) select.createEl("option", { text: `${model}（不属于${this.tuneProviderLabel(providerId)}）`, attr: { value: model, selected: "true" } });
      if (!model) select.createEl("option", { text: "尚未选定", attr: { value: "", selected: "true" } });
      for (const item of models) {
        const id = String(item?.id || item);
        const option = select.createEl("option", { text: String(item?.label || id), attr: { value: id } });
        if (id === model) option.selected = true;
      }
      glyph(wrap, "chevron-down");
      select.addEventListener("change", () => { if (select.value) void this.tuneWrite({ model: select.value }, `模型已改为 ${select.value}`); });
    }
    if (mismatch) {
      const warn = host.createDiv({ cls: "wb-mismatch" });
      glyph(warn, "triangle-alert");
      const copy = warn.createDiv();
      copy.createEl("strong", { text: "这个模型不属于当前引擎，发送会被拒。" });
      copy.createEl("p", { text: `${model} 不在 ${this.tuneProviderLabel(providerId)} 的模型里。` });
      this.action(copy, "重选成一对", "tune-fix-pair", () => {
        const first = models[0];
        void this.tuneWrite({ model: String(first?.id || first) }, "已重选成一对");
      }, "wb-chip-btn");
    }

    const kv = host.createDiv({ cls: "wb-kv" });
    const put = (key, value, cls = "") => {
      const row = kv.createDiv({ cls: "wb-row-kv" });
      row.createSpan({ cls: "wb-label", text: key });
      row.createSpan({ cls: `wb-status ${cls}`, text: value });
      return row;
    };
    put("连接", TUNE_CONN_TEXT[diag?.connection?.status] || "还没试过", `is-${TUNE_CONN_CLASS[diag?.connection?.status] || "idle"}`);
    // 授权三态：codex 本地无需授权；其余按 consent 记录。
    const grant = diag?.authorization?.status || (settings.externalTransferConsents?.[providerId] ? "authorized" : "locked");
    const grantRow = put("外部发送", TUNE_GRANT_TEXT[grant] || "未授权外部发送", `is-${grant === "authorized" ? "ok" : grant === "not-required" ? "idle" : "warn"}`);
    if (grant === "authorized") {
      // 收回授权是真写 settings，和其他写操作一样必须跟着本轮状态置灰。
      const revoke = this.action(grantRow, "收回授权", "tune-revoke", () => void this.tuneWrite({ externalTransferConsents: { [providerId]: false } }, "已收回外部发送授权"), "wb-chip-btn");
      if (busy) revoke.setAttribute("disabled", "true");
    }
    kv.createEl("p", { cls: "wb-field-note", text: grant === "not-required" ? "本地引擎不外发内容。" : "授权只针对这一个连接；换连接要重新授权。开启授权请在「连接细项」里确认地址与密钥后勾选。" });
  }
  renderTuneHexian(settings, busy) {
    const host = this.refs.tuneHexian;
    if (!host) return;
    host.empty();
    const runtime = this.plugin?.state?.runtime || {};
    const governance = runtime.capabilityManager?.governanceStatus;
    if (governance) {
      const status = host.createDiv({ cls: "wb-hint", attr: { role: "status" } });
      status.createEl("strong", { text: governance.message });
      if (governance.reason) status.createEl("p", { text: governance.reason });
      else if (governance.registryRoot) status.createEl("p", { text: governance.registryRoot });
    }
    const skills = Array.isArray(runtime.skills) ? runtime.skills : [];
    const agents = Array.isArray(runtime.agents) ? runtime.agents.filter(item => item?.enabled !== false) : [];
    const pinned = new Set(Array.isArray(settings.selectedSkills) ? settings.selectedSkills : []);
    const lenses = skills.filter(item => String(item?.skillType || item?.type || "") === "cognitive-lens");
    const licensed = (() => { try { const p = this.plugin.getCapabilityProtectionSnapshot(); return !p.present || p.unlocked; } catch { return true; } })();

    const segRow = (label, options, current, write, note = "") => {
      const field = host.createDiv({ cls: "wb-field" });
      const head = field.createDiv({ cls: "wb-label" });
      head.createSpan({ text: label });
      if (note) head.createEl("em", { text: note });
      const seg = field.createDiv({ cls: "wb-seg", attr: { role: "group", "aria-label": label } });
      for (const [value, text, hint] of options) {
        const on = value === current;
        const button = seg.createEl("button", {
          cls: "wb-opt" + (on ? " is-on" : ""),
          attr: { type: "button", "data-action": `tune-${label}-${value}`, "aria-pressed": String(on), title: hint || text, ...(busy ? { disabled: "true" } : {}) },
        });
        button.createSpan({ text });
        if (!on) button.addEventListener("click", () => void write(value));
      }
      return field;
    };

    segRow("Skill 模式", TUNE_SKILL_MODES, String(settings.skillMode || "auto"),
      value => this.tuneWrite({ skillMode: value }, "Skill 模式已改"));

    const lensField = host.createDiv({ cls: "wb-field" });
    const lensHead = lensField.createDiv({ cls: "wb-label" });
    lensHead.createSpan({ text: "认知透镜" });
    lensHead.createEl("em", { text: licensed ? (lenses.length ? `固定的每轮都会带上 · 已固定 ${lenses.filter(l => pinned.has(skillId(l))).length} 个` : "尚未发现透镜") : "未解锁" });
    if (!licensed) {
      lensField.createEl("p", { cls: "wb-hint", text: "能力包还没解锁，认知透镜暂时不可用。去下面「校音」里解锁。" });
    } else if (!lenses.length) {
      lensField.createEl("p", { cls: "wb-hint", text: "运行时还没报告可用透镜。打开一次对话，或在「能力管理」里刷新能力目录。" });
    } else {
      const wrap = lensField.createDiv({ cls: "wb-lenses" });
      for (const lens of lenses) {
        // 与透镜选择器同一个键：selectedSkills 在后端按 skill.name 匹配（见 availableByName）。
        const id = skillId(lens);
        const on = pinned.has(id);
        const button = wrap.createEl("button", {
          cls: "wb-lens" + (on ? " is-on" : ""),
          attr: { type: "button", "data-action": `tune-lens-${id}`, "aria-pressed": String(on), title: String(lens?.description || lens?.summary || "").trim() || id, ...(busy ? { disabled: "true" } : {}) },
        });
        if (on) glyph(button, "pin");
        button.createSpan({ text: skillLabel(lens, id) });
        // 固定与禁用共用 selectedSkills / disabledSkills，这里只增删自己这一个 id。
        button.addEventListener("click", () => {
          const next = new Set(pinned);
          if (next.has(id)) next.delete(id); else next.add(id);
          void this.tuneWrite({ selectedSkills: [...next] }, on ? "已取消固定" : "已固定，之后每轮都会带上");
        });
      }
      lensField.createEl("p", { cls: "wb-field-note", text: `一轮最多 ${TUNE_MAX_PRIMARY} 主 + ${TUNE_MAX_AUX} 辅，由路由规则决定，这里不能改。固定超出上限时由路由取前几个。` });
    }

    segRow("Agent 模式", TUNE_AGENT_MODES, String(settings.agentMode || "orchestrator"),
      value => this.tuneWrite({ agentMode: value }, "Agent 模式已改"));

    if (String(settings.agentMode || "") === "locked") {
      const field = host.createDiv({ cls: "wb-field" });
      field.createDiv({ cls: "wb-label" }).createSpan({ text: "锁定到" });
      if (!agents.length) {
        field.createEl("p", { cls: "wb-hint", text: "运行时还没报告可用 Agent。去「能力管理」刷新能力目录。" });
      } else {
        const wrap = field.createDiv({ cls: "wb-select-wrap" });
        const select = wrap.createEl("select", { cls: "wb-select", attr: { "aria-label": "锁定到哪个 Agent", ...(busy ? { disabled: "true" } : {}) } });
        for (const agent of agents) {
          const id = String(agent.id);
          const option = select.createEl("option", { text: String(agent.name || id), attr: { value: id } });
          if (id === String(settings.agentId || "")) option.selected = true;
        }
        glyph(wrap, "chevron-down");
        select.addEventListener("change", () => void this.tuneWrite({ agentId: select.value }, "已锁定 Agent"));
      }
    }

    const cap = host.createDiv({ cls: "wb-cap" });
    glyph(cap, "layers");
    cap.createSpan({ text: `一轮最多 ${TUNE_MAX_PRIMARY} 主 + ${TUNE_MAX_AUX} 辅，由路由规则决定。` });
    cap.createSpan({ cls: "wb-ro", text: "只读" });
  }
  renderTuneYinse() {
    const host = this.refs.tuneYinse;
    if (!host) return;
    host.empty();
    const prefs = this.preferences || {};
    // 外观走 view state（setPreference），不是 updateSettings；生成中也允许改，因为不碰任何一轮。
    const segRow = (label, options, current, key, note = "") => {
      const field = host.createDiv({ cls: "wb-field" });
      const head = field.createDiv({ cls: "wb-label" });
      head.createSpan({ text: label });
      if (note) head.createEl("em", { text: note });
      const seg = field.createDiv({ cls: "wb-seg", attr: { role: "group", "aria-label": label } });
      for (const [value, text] of options) {
        const on = value === current;
        const button = seg.createEl("button", {
          cls: "wb-opt" + (on ? " is-on" : ""),
          attr: { type: "button", "data-action": `tune-${key}-${value}`, "aria-pressed": String(on) },
        });
        button.createSpan({ text });
        if (!on) button.addEventListener("click", () => this.setPreference({ [key]: value }));
      }
    };
    segRow("皮肤", TUNE_SKINS, prefs.skin === "ink" ? "ink" : "gold", "skin");
    const toggle = (label, hint, key, on) => {
      const row = host.createDiv({ cls: "wb-switch-row" });
      const copy = row.createDiv();
      copy.createEl("strong", { text: label });
      copy.createEl("em", { text: hint });
      const button = row.createEl("button", {
        cls: "wb-switch" + (on ? " is-on" : ""),
        attr: { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, "data-action": `tune-${key}` },
      });
      button.createSpan({ cls: "wb-switch-dot", attr: { "aria-hidden": "true" } });
      button.addEventListener("click", () => this.setPreference({ [key]: !on }));
    };
    toggle("紧凑侧栏", "只留图标，给正文腾地方", "compactSidebar", prefs.compactSidebar === true);
    toggle("山峦背景", "关掉后面板更素净", "landscape", prefs.landscape !== false);
    host.createEl("p", { cls: "wb-field-note", text: "只改行知自己的界面（首页、观境、立心、践真、知变、藏知、调律、对话）；Obsidian 主题和笔记区不动。" });
  }
  renderTuneBeats() {
    const host = this.refs.tuneJiepai;
    if (!host) return;
    host.empty();
    const model = this.model || {};
    const active = Array.isArray(model.active) ? model.active : [];
    if (!active.length) {
      host.createEl("p", { cls: "wb-hint", text: "还没有行动链路。去践真定下第一件要验的事，回看节拍会在这里出现。" });
      return;
    }
    // 只用真实字段：reviewAt 有没有、到期没到期。不造「节拍评分」。
    const days = value => {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return null;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const target = new Date(time); target.setHours(0, 0, 0, 0);
      return Math.round((target - today) / 86400000);
    };
    let overdue = 0, soon = 0, later = 0, none = 0;
    for (const loop of active) {
      const diff = loop?.reviewAt ? days(loop.reviewAt) : null;
      if (diff === null) none += 1;
      else if (diff <= 0) overdue += 1;
      else if (diff <= 7) soon += 1;
      else later += 1;
    }
    const beats = host.createDiv({ cls: "wb-beats" });
    const beat = (label, count, cls) => {
      const item = beats.createDiv({ cls: `wb-beat is-${cls}` });
      item.createSpan({ cls: "wb-beat-n", text: String(count) });
      item.createSpan({ cls: "wb-beat-l", text: label });
      return item;
    };
    beat("已过回看日", overdue, "overdue");
    beat("七天内要回看", soon, "soon");
    beat("更晚", later, "later");
    beat("还没定回看日", none, "none");
    host.createEl("p", { cls: "wb-field-note", text: `共 ${active.length} 条在验的链路。统计来自每条行动自己的回看日。` });
  }
  renderTuneJiaoyin(providerId, diag, busy) {
    const host = this.refs.tuneJiaoyin;
    if (!host) return;
    host.empty();
    let license = {};
    try { license = this.plugin.getCommercialLicenseSnapshot?.() || {}; } catch { license = {}; }
    let pack = {};
    try { pack = this.plugin.getCapabilityProtectionSnapshot?.() || {}; } catch { pack = {}; }

    const kv = host.createDiv({ cls: "wb-kv" });
    const put = (key, value, cls = "") => {
      const row = kv.createDiv({ cls: "wb-row-kv" });
      row.createSpan({ cls: "wb-label", text: key });
      row.createSpan({ cls: `wb-status ${cls}`, text: value });
      return row;
    };
    // 「上次诊断」没有独立字段，是从 operationEvents 反推的，事件被挤掉就会没有 —— 所以允许显示「无记录」。
    const at = diag?.lastSuccessAt || diag?.lastAttemptAt || "";
    const when = (() => {
      const time = Date.parse(at);
      if (!Number.isFinite(time)) return "";
      return new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    })();
    put("上次诊断", when || "还没诊断过（或记录已滚出）", when ? "is-ok" : "is-idle");
    put("授权", TUNE_LICENSE_TEXT[String(license.status || "")] || String(license.status || "未激活"),
      String(license.status || "") === "ACTIVE" ? "is-ok" : String(license.status || "") === "EXPIRING" ? "is-warn" : "is-idle");
    if (license.expiresAt) {
      const time = Date.parse(license.expiresAt);
      put("到期", Number.isFinite(time) ? new Date(time).toLocaleDateString("zh-CN") : String(license.expiresAt));
    }
    // entryCount 的真实语义是「能力包内受保护文件数」，不是「已解锁 N 个能力」，文案照旧。
    put("本地能力包", pack.present ? `${pack.unlocked ? "已解锁" : "未解锁"} · ${pack.entryCount || 0} 个受保护文件` : "未内置",
      pack.present ? (pack.unlocked ? "is-ok" : "is-warn") : "is-idle");
    if (pack.error) host.createEl("p", { cls: "wb-hint", text: String(pack.error).slice(0, 200) });

    const foot = host.createDiv({ cls: "wb-pfoot" });
    // 诊断会真去打这个连接，本轮在跑时一并置灰，避免和生成抢同一个 provider。
    const probe = this.action(foot, "重新诊断当前连接", "tune-diagnose", async () => {
      try {
        await this.plugin.diagnoseProvider(providerId);
        new Notice("诊断完成");
      } catch (error) {
        new Notice(String(error?.message || error || "诊断失败").slice(0, 200));
      }
      this.renderTune();
    }, "wb-chip-btn");
    if (busy) probe.setAttribute("disabled", "true");
    if (typeof this.plugin?.openCommercialLicenseModal === "function") {
      this.action(foot, "授权与解锁", "tune-license", () => this.plugin.openCommercialLicenseModal(), "wb-chip-btn");
    }
  }
  createAction(loop = null) {
    new CognitiveRecordModal(this.plugin, loop, result => {
      if (this.closed) return;
      this.lastTransactionId = result.transactionId;
      if (result.loop?.id) this.setPreference({ selectedLoopId: result.loop.id });
      void this.refresh();
    }).open();
  }
  async beginAnalysis(content) {
    if (this.openingAnalysis) throw new Error("正在打开对话，请稍候。");
    this.openingAnalysis = true;
    try {
      await this.plugin.createConversation();
      await this.plugin.activateWorkbench("chat");
      const view = this.app.workspace.getLeavesOfType(WORKBENCH_TYPE)[0]?.view;
      if (typeof view?.setComposerDraft !== "function" || typeof view?.sendCurrentDraft !== "function") throw new Error("对话界面尚未就绪，问题内容已保留。");
      view.setComposerDraft(content, { focus: true });
      // Existing composer owns connection checks, permissions and failed-send recovery.
      Promise.resolve().then(() => view.sendCurrentDraft()).catch(error => new Notice(error?.message || "发送未完成，请在对话中查看保留的草稿。"));
    } finally { this.openingAnalysis = false; }
  }
  openRecords(title, records) { openList(this, title, records, { choose: record => this.plugin.openVaultPath(record.path) }); }
  openGoals(select = false) {
    openList(this, select ? "选择此阶段关注的目标" : "阶段目标与计划", this.model.goals, {
      description: "这里来自已有目标记录，保留记录原有的来源与认识状态。",
      empty: "还没有可读取的阶段目标。可以先在对话中梳理方向，再按原有确认流程保存。",
      choose: record => select ? this.setPreference({ directionPath: record.path }) : this.plugin.openVaultPath(record.path),
    });
  }
  chooseFocus() {
    openList(this, "由你选择当前关注", this.model.loops, {
      empty: "还没有认知行动记录，可以从新建行动开始。",
      choose: loop => this.setPreference({ selectedLoopId: loop.id }),
    });
  }
  openNewMenu() {
    new HomeDialog(this, "从这里开始", (body, modal) => {
      for (const [label, run] of [["分析一个真实问题", () => openQuestion(this)], ["建立下一步行动", () => this.createAction()], ["记录一段想法或资料", () => openCapture(this)]]) {
        addButton(body, label, () => { modal.close(); return run(); });
      }
    }).open();
  }
}; }

class CognitiveHomeView extends cognitiveWorkspaceClass(ItemView) {
  async onOpen() {
    // A saved old leaf can restore after onLayoutReady (e.g. enabling a trusted
    // plugin). It is a compatibility handoff, not the old homepage UI.
    this.closed = false;
    this.contentEl.createEl("p", { text: "正在恢复行知统一工作台…", attr: { role: "status" } });
    this.redirectTimer = setTimeout(() => {
      if (!this.closed) void this.plugin.migrateLegacyWorkspaces().catch(error => new Notice(error?.message || "工作区恢复未完成"));
    }, 0);
  }
  async onClose() { clearTimeout(this.redirectTimer); await super.onClose(); }
}
class CognitiveComponentHost extends Component {
  constructor(contentHost) { super(); this.contentEl = contentHost; this.embedded = true; }
  async setState() {}
  onunload() { if (!this.closed) void this.onClose(); }
}
const EmbeddedCognitiveWorkspace = cognitiveWorkspaceClass(CognitiveComponentHost);

module.exports = { CognitiveHomeView, EmbeddedCognitiveWorkspace, VIEW_TYPE_COGNITIVE_HOME, LOOP_STATUS, button };
