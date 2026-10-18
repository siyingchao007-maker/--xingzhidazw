"use strict";

const { instructionTextForRouting } = require("./reasoning-plan.cjs");
const { isTextTransformation, normalizedSkillType } = require("./capability-surface.cjs");

// These local checks only detect absent response signals. They cannot certify factual
// accuracy, reasoning quality, or whether a field was answered substantively.
const REQUIREMENT_DEFINITIONS = Object.freeze([
  ["agents", "Agent 职责与调用", /\bagents?\b|智能体/iu],
  ["skills", "Skill 方法与调用", /\bskills?\b|技能|提示词/iu],
  ["sources", "引用与证据", /引用|来源|证据|依据|references?|sources?|evidence/iu],
  ["layout", "界面布局与呈现", /界面.{0,6}(?:布局|排版|呈现)|页面.{0,6}(?:布局|排版)|卡片布局|版式|视觉布局|\bUI\b|\blayout\b|\binterface\b/iu],
  ["logic", "底层逻辑与机制", /底层|逻辑|机制|原理|architecture|mechanism/iu],
  ["cost", "成本与投入", /成本|费用|预算|投入|报价|cost|budget/iu],
  ["risk", "风险与失败条件", /风险|反证|失败条件|失效条件|判断.{0,8}失效|不确定性|risk|failure|invalidate/iu],
  ["unknowns", "关键未知与信息缺口", /关键未知|未知信息|信息缺口|尚不清楚|无法确认|uncertaint|unknown|information gap/iu],
  ["validation", "验证与验收标准", /验收|验证标准|测试|验证|acceptance|validation|testing/iu],
  ["schedule", "计划与时间安排", /时间安排|排期|实施计划|执行步骤|下一步|时间表|schedule|timeline/iu],
  ["growth", "成长与变化", /成长|成长路径|growth/iu],
  ["rollback", "回退与恢复", /回滚|回退|恢复|rollback|recovery/iu],
  ["options", "备选方案与比较", /备选方案|多个方案|方案.{0,4}(?:比较|选择)|(?:给出|提供|制定).{0,8}方案|选项|比较|\balternatives?\b|\boptions?\b/iu],
  ["core-conclusion", "当前结论或交付结果", /结论|当前判断|建议|推荐|决定|选择|暂缓|(?:建议|决定|应(?:当|该)?)(?:继续|停止|采用|放弃)|继续(?:执行|推进)|可行|不可行|recommend|conclusion|decision/iu],
  ["core-evidence", "主要依据与证据边界", /依据|证据|来源|因为|原因|机制|事实|样本|数据|假设|支持|表明|evidence|source|because|reason|mechanism|assumption/iu],
  ["core-uncertainty", "关键未知、限制或适用边界", /关键未知|未知|不确定|缺少|没有.{0,10}(?:数据|证据|样本|信息|报价|记录)|尚未|待验证|取决于|限制|边界|适用条件|无法确认|unknown|uncertain|depends|limitation|boundary/iu],
  ["core-failure-condition", "失败、停止或判断失效条件", /失败条件|失效条件|停止条件|终止条件|判断.{0,8}失效|推翻|反证|风险|若.{0,24}(?:则|就).{0,16}(?:停止|终止|失效|放弃|回退)|failure|stop condition|invalidate|falsif|risk/iu],
  ["core-next-step", "下一项可验证行动", /下一步|下一项|优先.{0,12}(?:验证|确认|检查|获取|执行|测试)|先.{0,12}(?:验证|确认|检查|获取|取得|执行|测试|做)|行动|复查|next step|next action|verify|validate/iu],
  ["action-objective", "本轮具体成果、用途与行动对象", /具体成果|预期成果|可用成果|行动目标|本轮目标|目标是|服务于|要实现|负责人|责任人|触发条件|objective|owner|trigger/iu],
  ["action-steps", "执行步骤与顺序", /执行步骤|行动清单|第一步|第二步|先.{0,16}(?:再|然后)|步骤|里程碑|step|milestone/iu],
  ["completion-criteria", "成果完成标准与可核验依据", /成果标准|核验依据|完成标准|验收标准|成功标准|完成条件|可观察结果|交付标准|acceptance|done criteria|success criteria/iu],
  ["action-constraints", "资源、代价、依赖与停止条件", /可用资源|预算|代价上限|投入上限|主要依赖|依赖|阻碍|前提|停止条件|失败处理|风险|dependency|blocker|prerequisite|stop condition/iu],
  ["feedback-loop", "回看时间或触发条件与反馈调整", /回看时间|复查时间|触发条件|反馈|复查|复盘|调整|继续|暂停|终止|校正|review|feedback|adjust|pause|terminate/iu],
  ["perspective-differences", "视角之间的机制或行动差异", /视角.{0,12}(?:差异|不同|冲突|共同)|共同事实|冲突假设|一方面|另一方面|相比|综合|difference|conflict|synthesis/iu],
  ["source-trace", "来源范围与追溯", /来源|出处|文件|资料|引用|追溯|source|reference|document/iu],
  ["conflicts-and-gaps", "冲突、差异与信息缺口", /冲突|差异|分歧|信息缺口|缺失|无法裁决|矛盾|conflict|difference|gap|missing/iu],
  ["research-source-provenance", "资料来源与核验范围", /来源|出处|引用|核验|已核实|资料库|本地资料|公开资料|公开页面|报告|文档|source|reference|verified/iu],
  ["research-local-inventory", "请求调取的本地资料盘点", /盘点|已有|现有|调取|检索|找到|资料清单|物料|材料|本地资料|资料库|inventory|retrieved|local materials/iu],
  ["research-public-verification", "公开资料检索与核验", /当前|最新|市场|行业|赛道|趋势|公开|联网|网上|互联网|在线|实时|核验|验证日期|current|latest|market|public|verified/iu],
  ["research-comparables", "请求的对标对象与变现机制", /对标|类似赛道|同类|比较|变现|盈利|收入来源|收费|商业模式|收入逻辑|monetization|revenue|comparable|benchmark/iu],
]);

const REQUIREMENT_BY_ID = new Map(REQUIREMENT_DEFINITIONS.map((entry) => [entry[0], entry]));
const TOPIC_IDS = new Set([
  "agents", "skills", "sources", "layout", "logic", "cost", "risk", "unknowns",
  "validation", "schedule", "growth", "rollback", "options",
]);
const REQUEST_PATTERN = /请|帮我|需要|要求|包括|说明|分析|比较|逐项|检测|检查|给我|方案|\bplease\b|\binclude\b|\bexplain\b/iu;
const CONCISE_PATTERN = /(?:^|\s)(?:(?:请|麻烦|我需要|需要|我希望|希望|我要|要求|请你|帮我|给我|这次|本轮|用|使用)\s*)?(?:简短|简洁|简要)(?:地|的)?(?:回答|说明|解释|分析|介绍|总结|表达|呈现|描述|回复|作答|撰写|写|讲)|(?:我需要|需要|我希望|希望|我要|这次|本轮|请|麻烦|要求|帮我).{0,16}?(?:简短|简洁|简要)(?:地|的)?(?:回答|说明|解释|分析|介绍|总结|表达|呈现|描述|回复|作答|撰写|写|讲)|\bbrief\b|\bconcise\b/iu;
const EXPANDED_PATTERN = /(?:^|\s)(?:(?:请|麻烦|我需要|需要|我希望|希望|我要|要求|请你|帮我|给我|这次|本轮|再|然后|接着|同时|并且|用|使用)\s*){0,3}(?:(?:完整|详细|全面|深入|深度|详尽|逐项|系统性地|展开)\s*){1,3}.{0,4}?(?:分析|说明|解释|回答|展开|讨论|比较|梳理|评估|介绍|阐述|推导|审计|诊断|研究|输出|列出)|(?:^|\s)(?:展开|深入|详细|全面|完整|系统性地).{0,4}?(?:分析|说明|解释|回答|讨论|比较|梳理|评估|介绍|阐述|推导|审计|诊断|研究|输出|列出)|\bdetailed\b|\bcomprehensive\b|\bin[- ]depth\b/iu;
const DECISION_PATTERN = /是否|应不应该|应该.{0,12}(?:继续|选择|采用|放弃|停止)|选择|取舍|决策|当前判断|可行(?:性)?|继续还是|采用还是|停止还是/iu;
const EXECUTION_PATTERN = /行动清单|执行方案|执行步骤|落地计划|实施计划|里程碑|推进计划|下一步怎么做|如何执行/iu;
const MULTI_PERSPECTIVE_PATTERN = /多视角|多个视角|多个角度|多角度|系统性分析|综合分析/iu;
const DOCUMENT_PATTERN = /整合|归纳|汇总|融合|重组.{0,8}(?:文件|图片|资料|报告|方案)|统一方案/iu;
const KNOWLEDGE_PATTERN = /归档|知识分包|知识候选|知识整理|整理知识库|重构知识库/iu;
const MAXIMUM_CHARACTERS_PATTERN = /(?:(?:控制|限制)在|不超过|不多于|最多|少于|小于)\s*(\d{1,5})\s*(?:个)?(?:字|字符)(?:以?内|以下)?|(\d{1,5})\s*(?:个)?(?:字|字符)(?:以?内|以下)/iu;
const MAXIMUM_WORDS_PATTERN = /(?:(?:控制|限制)在|不超过|不多于|最多|少于|小于|under|within|at most)\s*(\d{1,5})\s*(?:个)?(?:词|单词|words?)(?:以?内|以下)?|(\d{1,5})\s*(?:个)?(?:词|单词|words?)(?:以?内|以下)/iu;
const SINGLE_SENTENCE_PATTERN = /只(?:需|要)?输出(?:一|1)句(?:话)?|(?:最终)?(?:回答|回复|答复|答案)(?:只需|只要|仅需|仅要)?(?:用)?(?:一|1)句(?:话)?(?:即可|就好|就行)?|(?:一|1)句(?:话)?(?:即可|就好)|single sentence/iu;
const CONTENT_ONLY_PATTERN = /(?:只|仅)(?:需|要)?输出|不要(?:解释|说明|附加|补充|前言|后记|分析过程)|output only/iu;
const HISTORICAL_ANSWER_REFERENCE_PATTERN = /上次|上一轮|上一条|上一个回答|前一次|此前的回答|之前的回答|你此前|你之前|你曾经|旧要求|历史要求/u;
const CURRENT_REQUEST_PATTERN = /我需要|我希望|我要|这次|本轮|当前|现在|请(?:你)?|麻烦|帮我|请帮我/u;
const ANSWER_SCOPE_PATTERN = /最终回答|整篇回答|整篇|全文|回答|答复|回复|答案|最终输出|输出正文|输出内容|输出/iu;
const LOCAL_OUTPUT_TARGET_PATTERN = /标题长度|品牌名长度|品牌名称长度|产品长度|产品名|品牌名|品牌名称|标题|小标题|副标题|名称|名字|标语|口号|摘要|结论|开头|开场白|结尾|段落|片段|小节|章节|文案|简介|介绍段|结尾段|昵称|栏目名|标签/iu;
const WHOLE_REPLY_SUBJECT_PATTERN = /最终回答|整篇回答|整篇|全文|回答|答复|回复|答案|最终输出/iu;
const LOCAL_FORMAT_SUBJECT_PATTERN = /产品|生成器|按钮|字段|代码块|标题|名称|名字|标语|口号|摘要|结论|开头|开场白|结尾|段落|片段|小节|章节|简介/iu;

const DELIVERABLE_BASELINES = Object.freeze({
  "decision-evaluation": Object.freeze([
    "core-conclusion", "core-evidence", "core-uncertainty", "core-failure-condition", "core-next-step",
  ]),
  "execution-plan": Object.freeze([
    "action-objective", "action-steps", "completion-criteria", "action-constraints", "feedback-loop",
  ]),
  "multi-perspective-analysis": Object.freeze([
    "core-conclusion", "core-evidence", "core-uncertainty", "perspective-differences",
  ]),
  "document-synthesis": Object.freeze([
    "source-trace", "core-conclusion", "conflicts-and-gaps", "core-uncertainty",
  ]),
  "knowledge-package": Object.freeze([
    "source-trace", "core-conclusion", "conflicts-and-gaps", "core-uncertainty",
  ]),
});

const PRIMARY_SKILL_DELIVERABLES = Object.freeze({
  "xingzhi-judgment-calibration": "decision-evaluation",
  "xingzhi-action-feedback": "execution-plan",
  "xingzhi-multi-perspective": "multi-perspective-analysis",
  "xingzhi-document-synthesis": "document-synthesis",
  "xingzhi-knowledge-packaging": "knowledge-package",
  "xingzhi-knowledge-organization": "knowledge-package",
});

function boundedText(value, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeOptions(outputDepthOrOptions) {
  if (typeof outputDepthOrOptions === "string") return { outputDepth: outputDepthOrOptions };
  if (!outputDepthOrOptions || typeof outputDepthOrOptions !== "object" || Array.isArray(outputDepthOrOptions)) {
    return {};
  }
  return outputDepthOrOptions;
}

function positiveLimit(match) {
  const value = Number(match?.[1] || match?.[2]);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : null;
}

function researchRequirementIds(visible, options = {}) {
  const needs = Array.isArray(options.informationNeeds) ? options.informationNeeds : [];
  const requiredNeeds = needs.filter((need) => need && typeof need === "object" && need.optional !== true);
  const requiredPublicNeed = requiredNeeds.some((need) => need.public === true || need.publicNeed === true
    || need.publicExpected === true
    || /^(?:public|web|external)$/iu.test(String(need.scope || need.sourceScope || "")));
  const researchRequested = options.deliverable === "research"
    || requiredPublicNeed
    || /(?:研究|调研|全方位|全面|完整|详尽).{0,20}(?:资料|材料|信息|内容|市场|行业|赛道)|(?:调取|搜集|查找|检索|盘点|梳理).{0,20}(?:资料|材料|信息|内容|市场|行业|赛道)/u.test(visible);
  if (!researchRequested) return [];
  const ids = ["research-source-provenance"];
  if (/(?:我(?:的|现在|目前|准备|已有)|本地|资料库|调取).{0,16}(?:资料|材料|内容|物料)|物料|本地资料/u.test(visible)
    || requiredNeeds.some((need) => /^(?:personal|private|local|user-context)$/iu.test(String(need.scope || need.sourceScope || "")))) {
    ids.push("research-local-inventory");
  }
  if (/(?:当前|最新|市场|行业|赛道|公开|趋势|政策|环境|网上|互联网|在线|联网)/u.test(visible)
    || requiredPublicNeed) {
    ids.push("research-public-verification");
  }
  if (/(?:对标|类似赛道|同类|比较|变现|盈利|收入来源|收费|商业模式|收入逻辑)/u.test(visible)
    || requiredNeeds.some((need) => /(?:对标|类似|赛道|变现|盈利|收入|收费|模式)/u.test(String(need.label || "")))) {
    ids.push("research-comparables");
  }
  return [...new Set(ids)];
}

function outputDirectiveText(instruction) {
  const source = String(instruction || "")
    .slice(0, 20_000)
    .replace(/(?:不要|不能)\s*(?=超过|多于|大于|高于)/gu, "不");
  const withoutHistoricalAnswerRequests = source
    .split(/([，,。；;\n]+)/u)
    .map((part) => {
      if (/^[，,。；;\n]+$/u.test(part)) return part;
      return HISTORICAL_ANSWER_REFERENCE_PATTERN.test(part) && !CURRENT_REQUEST_PATTERN.test(part)
        ? ""
        : part;
    })
    .join("");
  return instructionTextForRouting(withoutHistoricalAnswerRequests);
}

function nearestMentionDistance(text, start, end, pattern, maximumDistance = 40) {
  const from = Math.max(0, start - maximumDistance);
  const to = Math.min(text.length, end + maximumDistance);
  const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
  let distance = Infinity;
  for (const mention of text.slice(from, to).matchAll(matcher)) {
    const mentionStart = from + mention.index;
    const mentionEnd = mentionStart + mention[0].length;
    const current = mentionEnd <= start
      ? start - mentionEnd
      : mentionStart >= end ? mentionStart - end : 0;
    distance = Math.min(distance, current);
  }
  return distance;
}

function isWholeAnswerLimit(text, match) {
  const before = text.slice(Math.max(0, match.index - 32), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
  const context = `${before}${match[0]}${after}`;
  const limitEnd = match.index + match[0].length;
  // An immediately named whole reply outranks a later local element in that reply.
  if (/(?:全文|整篇(?:回答)?|最终回答|回答|回复|答复|答案)\s*$/u.test(before)) return true;
  const localDistance = nearestMentionDistance(text, match.index, limitEnd, LOCAL_OUTPUT_TARGET_PATTERN, 32);
  const answerDistance = nearestMentionDistance(text, match.index, limitEnd, ANSWER_SCOPE_PATTERN, 40);
  if (localDistance <= 24 && localDistance <= answerDistance) return false;
  if (answerDistance <= 32) return true;

  const explicitRequest = CURRENT_REQUEST_PATTERN.test(context)
    || /(?:简洁|简短|简要)(?:地|的)?(?:回答|说明|解释|分析|介绍|总结|表达|描述|回复|作答)/iu.test(context);
  const explicitLimit = /控制在|限制在|不超过|不多于|最多|少于|小于|under|within|at most/iu.test(match[0]);
  const action = /回答|说明|解释|分析|介绍|总结|描述|撰写|写|生成|提供|给出|回复|答复|作答|输出/iu.test(context);
  if (explicitRequest && (explicitLimit || action)) return true;

  const previousInstruction = text.slice(Math.max(0, match.index - 48), match.index);
  const nextInstruction = text.slice(match.index + match[0].length, match.index + match[0].length + 32);
  const usedAsAnswerLimit = /(?:请)?(?:用|以)\s*$/u.test(previousInstruction)
    && /(?:回答|说明|分析|解释|介绍|总结|描述|写|生成|提供|给出|回复|输出)/iu.test(nextInstruction);
  if (usedAsAnswerLimit) return true;

  return text.trim() === match[0].trim();
}

function positiveWholeAnswerLimit(instruction, pattern) {
  const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of instruction.matchAll(matcher)) {
    if (isWholeAnswerLimit(instruction, match)) return positiveLimit(match);
  }
  return null;
}

function detectOutputConstraints(instruction) {
  const directiveText = outputDirectiveText(instruction);
  const maximumCharacters = positiveWholeAnswerLimit(directiveText, MAXIMUM_CHARACTERS_PATTERN);
  const maximumWords = positiveWholeAnswerLimit(directiveText, MAXIMUM_WORDS_PATTERN);
  const singleSentence = hasWholeReplyFormat(directiveText, SINGLE_SENTENCE_PATTERN);
  const contentOnly = hasWholeReplyFormat(directiveText, CONTENT_ONLY_PATTERN);
  return {
    strict: maximumCharacters !== null || maximumWords !== null || singleSentence || contentOnly,
    maximumCharacters,
    maximumWords,
    singleSentence,
    contentOnly,
  };
}

function hasWholeReplyFormat(text, pattern) {
  const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
  return [...text.matchAll(matcher)].some(match => {
    const end = match.index + match[0].length;
    const local = nearestMentionDistance(text, match.index, end, LOCAL_FORMAT_SUBJECT_PATTERN, 24);
    const whole = nearestMentionDistance(text, match.index, end, WHOLE_REPLY_SUBJECT_PATTERN, 24);
    return local === Infinity || whole < local;
  });
}

function skillId(skill) {
  return boundedText(skill?.name || skill?.id, 128);
}

function primarySkillFrom(options) {
  if (options.primarySkill && typeof options.primarySkill === "object"
    && !new Set(["cognitive-lens", "workflow"]).has(normalizedSkillType(options.primarySkill))) {
    return options.primarySkill;
  }
  return (Array.isArray(options.skills) ? options.skills : []).find((skill) => (
    skill?.outputRole === "primary"
    && !new Set(["cognitive-lens", "workflow"]).has(normalizedSkillType(skill))
  )) || null;
}

function cognitiveLensCount(options) {
  return (Array.isArray(options.skills) ? options.skills : [])
    .filter((skill) => normalizedSkillType(skill) === "cognitive-lens").length;
}

function compactCapabilities(skill) {
  const values = [
    skill?.capability,
    ...(Array.isArray(skill?.capabilities) ? skill.capabilities : []),
  ];
  return [...new Set(values.map((value) => boundedText(value, 120)).filter(Boolean))].slice(0, 8);
}

function baselineIsApplicable(deliverable, visible) {
  if (!visible) return false;
  if (deliverable === "decision-evaluation") return DECISION_PATTERN.test(visible);
  if (deliverable === "execution-plan") return EXECUTION_PATTERN.test(visible);
  if (deliverable === "multi-perspective-analysis") return MULTI_PERSPECTIVE_PATTERN.test(visible);
  if (deliverable === "document-synthesis") return DOCUMENT_PATTERN.test(visible);
  if (deliverable === "knowledge-package") return KNOWLEDGE_PATTERN.test(visible);
  return false;
}

function primaryBaselineDeliverable(primaryId, routedDeliverable, visible) {
  const declared = PRIMARY_SKILL_DELIVERABLES[primaryId] || null;
  if (declared && baselineIsApplicable(declared, visible)) return declared;
  if (baselineIsApplicable(routedDeliverable, visible)) return routedDeliverable;
  if (!primaryId) return null;
  if (DECISION_PATTERN.test(visible)) return "decision-evaluation";
  if (EXECUTION_PATTERN.test(visible)) return "execution-plan";
  if (MULTI_PERSPECTIVE_PATTERN.test(visible)) return "multi-perspective-analysis";
  if (DOCUMENT_PATTERN.test(visible)) return "document-synthesis";
  if (KNOWLEDGE_PATTERN.test(visible)) return "knowledge-package";
  return null;
}

function answerContract(instruction, outputDepthOrOptions = "standard") {
  const options = normalizeOptions(outputDepthOrOptions);
  const raw = String(instruction || "").slice(0, 20_000);
  const transformation = isTextTransformation(raw);
  const visible = transformation ? "" : instructionTextForRouting(raw);
  const directiveText = transformation ? "" : outputDirectiveText(raw);
  const requested = REQUEST_PATTERN.test(visible);
  const requestedRequirements = requested
    ? REQUIREMENT_DEFINITIONS
      .filter(([id, , pattern]) => TOPIC_IDS.has(id) && pattern.test(visible))
      .map(([id]) => id)
    : [];
  const researchRequirements = researchRequirementIds(visible, options);

  const routedDepth = ["concise", "standard", "expanded"].includes(options.outputDepth)
    ? options.outputDepth : "standard";
  let outputDepth = routedDepth;
  let depthSource = "route";
  const outputConstraints = detectOutputConstraints(raw);
  const explicitConcise = CONCISE_PATTERN.test(directiveText) || outputConstraints.singleSentence;
  const explicitExpanded = EXPANDED_PATTERN.test(visible)
    || /(?:全方位|全面|完整|详尽).{0,16}(?:资料|材料|信息|内容|市场|行业|赛道)|(?:comprehensive|full[- ]scope).{0,20}(?:research|materials|information|market)/iu.test(visible);
  if (explicitExpanded) {
    outputDepth = "expanded";
    depthSource = "explicit-expanded";
  } else if (explicitConcise) {
    outputDepth = "concise";
    depthSource = "explicit-concise";
  }

  const deliverable = boundedText(options.deliverable, 80) || "direct-answer";
  const primary = primarySkillFrom(options);
  const primaryId = skillId(primary);
  const requirements = [];
  const requirementMap = new Map();
  const addRequirement = (id, source) => {
    const definition = REQUIREMENT_BY_ID.get(id);
    if (!definition) return;
    const existing = requirementMap.get(id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const item = { id, label: definition[1], sources: [source], protected: true };
    requirementMap.set(id, item);
    requirements.push(item);
  };
  for (const id of requestedRequirements) addRequirement(id, "user-explicit");
  for (const id of researchRequirements) addRequirement(id, "research-scope");

  const applicable = baselineIsApplicable(deliverable, visible);
  const deliverableBaseline = applicable ? [...(DELIVERABLE_BASELINES[deliverable] || [])] : [];
  for (const id of deliverableBaseline) addRequirement(id, "deliverable-baseline");

  const primaryDeliverable = primaryBaselineDeliverable(primaryId, deliverable, visible);
  const primaryBaselineRequirements = primaryDeliverable
    ? [...(DELIVERABLE_BASELINES[primaryDeliverable] || [])]
    : [];
  for (const id of primaryBaselineRequirements) addRequirement(id, "primary-skill-baseline");

  const coalesceRequirement = (topicId, baselineId) => {
    const topic = requirementMap.get(topicId);
    const baseline = requirementMap.get(baselineId);
    if (!topic || !baseline) return;
    for (const source of topic.sources) {
      if (!baseline.sources.includes(source)) baseline.sources.push(source);
    }
    requirementMap.delete(topicId);
    requirements.splice(requirements.indexOf(topic), 1);
  };
  coalesceRequirement("sources", "core-evidence");
  coalesceRequirement("unknowns", "core-uncertainty");
  if (/失败条件|失效条件|反证|failure|invalidate/iu.test(visible)) {
    coalesceRequirement("risk", "core-failure-condition");
  }
  if (/下一步|下一项|next step|next action/iu.test(visible)) {
    coalesceRequirement("schedule", "core-next-step");
  }

  const informationNeedIds = Array.isArray(options.informationNeeds)
    ? [...new Set(options.informationNeeds
        .filter((need) => need && typeof need === "object" && need.optional !== true
          && typeof need.id === "string" && need.id.trim())
        .map((need) => boundedText(need.id, 80)))]
    : [];
  const publicInformationNeedIds = Array.isArray(options.informationNeeds)
    ? [...new Set(options.informationNeeds
        .filter((need) => need && typeof need === "object" && need.optional !== true
          && typeof need.id === "string" && need.id.trim()
          && (need.public === true || need.publicNeed === true || need.publicExpected === true
            || /^(?:public|web|external)$/iu.test(String(need.scope || need.sourceScope || ""))))
        .map((need) => boundedText(need.id, 80)))]
    : [];
  return {
    version: 2,
    outputDepth,
    depthSource,
    taskLevel: boundedText(options.taskLevel, 40) || "T0_DIRECT",
    deliverable,
    requirements,
    requestedRequirements,
    researchRequirements,
    researchExpected: researchRequirements.length > 0,
    informationNeedIds,
    publicInformationNeedIds,
    publicExpected: researchRequirements.includes("research-public-verification")
      || (Array.isArray(options.informationNeeds) && options.informationNeeds.some((need) => (
        need && typeof need === "object" && need.optional !== true
        && (need.public === true || need.publicNeed === true || need.publicExpected === true
          || /^(?:public|web|external)$/iu.test(String(need.scope || need.sourceScope || "")))
      ))),
    deliverableBaseline,
    primaryBaselineRequirements,
    primarySkill: primaryId ? {
      id: primaryId,
      label: boundedText(primary?.label || primary?.promptLabel || primaryId, 120),
      capabilities: compactCapabilities(primary),
    } : null,
    cognitiveLensCount: cognitiveLensCount(options),
    outputConstraints,
    compressionPolicy: {
      deduplicateRepeatedClaimsOnly: true,
      preserve: ["evidence", "unknowns", "failure-conditions", "next-step"],
      evidenceWeightPerUniqueSource: 1,
    },
  };
}

function missingRequirements(text, contract) {
  const body = String(text || "").replace(/```[\s\S]*?(?:```|$)/gu, " ");
  return (Array.isArray(contract?.requirements) ? contract.requirements : []).filter((requirement) => {
    const definition = REQUIREMENT_BY_ID.get(requirement?.id);
    return definition && !definition[2].test(body);
  });
}

function answerContractBlock(contract = {}) {
  const requirements = Array.isArray(contract.requirements) ? contract.requirements : [];
  const researchInstructions = contract.researchExpected === true
    ? [
        "本轮包含资料研究：依据用户实际提出的信息需求分别盘点、核验或比较；信息需求是辅助范围，不代表固定报告目录，也不要求调用所有 Skill 或认知透镜。",
        "本地个人资料只用于本地检索；公开检索只使用单独识别出的公开主题，不发送未拆分的个人原话。当前公开需求若没有可核验来源，保留已有回答并明确标出未核验范围，不补造市场事实。",
        ...(contract.outputDepth === "expanded" ? [
          "逐项回应用户本轮明确提出的任务、分析对象和交付内容；多方向请求要分别作实质回答，并可补充与问题相关的新视角。不能用一个优先建议或摘要替代其余研究范围。",
          "自然组织报告，不固定章节或字数；不得以风险提示、小范围验证建议或行动计划替代应完成的研究内容。没有用户要求时，不强制安排行动计划。",
        ] : []),
      ]
    : [];
  const depth = contract.outputDepth === "expanded"
    ? "本轮要求展开交付：逐项回应用户明确要求，充分解释主要依据、底层原因、关系与取舍，保留适用边界和关键未知。用户需要推进或回看时再给出行动或验证，不得以落地为由只给内容梗概或操作步骤。"
    : contract.outputDepth === "concise"
      ? "本轮要求简洁：直接覆盖明确要求，允许短而完整，不为字数扩写。"
      : "本轮标准交付：完成用户明确要求；分析任务讲清结论、主要依据与必要限制，涉及行动或结果回看时再给下一步；简单任务直接回答。";
  const primary = contract.primarySkill
    ? `主要 Skill：${contract.primarySkill.label || contract.primarySkill.id}。其任务交付先于辅助认知透镜；透镜不得删减、替换或接管最终结构。`
    : "没有主要 Skill 时，由主 Agent 按用户原始请求完成最终交付。";
  const capabilityLine = contract.primarySkill?.capabilities?.length
    ? `主要 Skill 的能力基线：${contract.primarySkill.capabilities.join("、")}。这些能力仍以本轮实际加载的 Skill 正文为准。`
    : "";
  const constraints = contract.outputConstraints || {};
  const constraintLines = [
    Number.isSafeInteger(constraints.maximumCharacters)
      ? `最终回答不得超过 ${constraints.maximumCharacters} 个字符。` : "",
    Number.isSafeInteger(constraints.maximumWords)
      ? `最终回答不得超过 ${constraints.maximumWords} 个词。` : "",
    constraints.singleSentence === true ? "最终回答只允许一句话。" : "",
    constraints.contentOnly === true ? "只输出最终内容，不附加解释、前言或自检说明。" : "",
  ].filter(Boolean);
  return [
    depth,
    ...constraintLines,
    primary,
    capabilityLine,
    ...researchInstructions,
    ...(requirements.length ? [
      "本轮受保护的交付要求（只用于遗漏检查，不代表请求的全部细节）：",
      ...requirements.map((requirement) => `- ${requirement.label}`),
    ] : []),
    "多视角压缩只合并语义重复的主张；保留各自有效的证据、未知，以及与本轮任务相关的失败条件和下一步，不为探索讨论强加行动模板。相同来源和相同引文只计一次证据权重，不能用透镜票数增强结论。",
    "最终仍以用户原始请求为准，逐项检查遗漏。无法确认时说明缺少的证据；不得补造事实，也不要只罗列字段名称来假装完成。",
  ].filter(Boolean).join("\n");
}

function supplementPrompt(report = {}) {
  const missing = Array.isArray(report.missingRequirements) ? report.missingRequirements : [];
  const constraints = report.contract?.outputConstraints || {};
  if (report.repairMode === "replace") {
    return [
      "把上一个回答视为内部草稿。本次完整重写最终答案，不要追加、引用或复述旧草稿。",
      "重写后仍需覆盖以下尚未检测到的交付内容：",
      ...missing.map((requirement) => `- ${requirement.label}`),
      Number.isSafeInteger(constraints.maximumCharacters)
        ? `- 最终答案不得超过 ${constraints.maximumCharacters} 个字符。` : "",
      Number.isSafeInteger(constraints.maximumWords)
        ? `- 最终答案不得超过 ${constraints.maximumWords} 个词。` : "",
      constraints.singleSentence === true ? "- 最终答案只允许一句话。" : "",
      constraints.contentOnly === true ? "- 不要附加解释、前言、后记或自检说明。" : "",
      "保留已经正确回答的实质内容，但压缩重复表达；缺少依据时明确说明未知，不得补造事实、修改文件、执行操作或发起网络请求。",
      "只输出重写后的最终答案。",
    ].filter(Boolean).join("\n");
  }
  return [
    "上一个回答已完整保留。本次不删除或改写原回答；仅追加以下尚未检测到的交付内容，不复述已有段落：",
    ...missing.map((requirement) => `- ${requirement.label}`),
    "本次只补充一次。保持用户要求的详细程度和主要 Skill 的任务边界；认知透镜只补局部依据，不得接管最终交付。",
    "若你已用其他措辞回答，请不要重复；若缺少依据，明确说明无法确认的内容和必要信息。禁止推测新事实、修改文件、执行操作或发起网络请求。只输出可接在原回答后的补充正文。",
  ].join("\n");
}

module.exports = {
  answerContract,
  answerContractBlock,
  missingRequirements,
  supplementPrompt,
};
