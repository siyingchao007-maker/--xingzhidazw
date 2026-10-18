"use strict";

const {
  REASONING_OPERATOR_ORDER,
  getReasoningOperator,
} = require("./reasoning-operator-registry.cjs");
const { detectIntentSignals } = require("./intent-signals.cjs");
const { isTextTransformation } = require("./capability-surface.cjs");

const KNOWLEDGE_WORKFLOWS = Object.freeze([
  "none",
  "archive-preview",
  "message-organize",
  "internal-organize",
  "document-import",
  "knowledge-merge-synthesis",
  "user-continuity-analysis",
  "knowledge-governance-analysis",
]);
const KNOWLEDGE_WORKFLOW_SET = new Set(KNOWLEDGE_WORKFLOWS);
const TASK_LEVEL_SET = new Set(["T0_DIRECT", "T1_FOCUSED", "T2_JUDGMENT", "T3_PANEL", "T4_GATED"]);
const KNOWLEDGE_SUBMISSION_WORKFLOWS = new Set([
  "archive-preview",
  "message-organize",
  "internal-organize",
  "document-import",
]);

const PUBLIC_METHODS = Object.freeze([
  Object.freeze({ term: "第一性原理", ids: ["first-principles-reconstruction"] }),
  Object.freeze({ term: "线性思维", ids: ["causal-analysis", "execution-sequencing"] }),
  Object.freeze({ term: "因果推断", ids: ["causal-analysis"] }),
  Object.freeze({ term: "因果分析", ids: ["causal-analysis"] }),
  Object.freeze({ term: "系统思维", ids: ["system-dynamics"] }),
  Object.freeze({ term: "系统动力学", ids: ["system-dynamics"] }),
  Object.freeze({ term: "系统动力分析", ids: ["system-dynamics"] }),
  Object.freeze({ term: "矛盾与阶段分析", ids: ["contradiction-stage-analysis"] }),
  Object.freeze({ term: "矛盾分析", ids: ["contradiction-stage-analysis"] }),
  Object.freeze({ term: "矛盾论", ids: ["contradiction-stage-analysis"] }),
  Object.freeze({ term: "利益与激励分析", ids: ["incentive-structure-analysis"] }),
  Object.freeze({ term: "激励机制分析", ids: ["incentive-structure-analysis"] }),
  Object.freeze({ term: "激励分析", ids: ["incentive-structure-analysis"] }),
  Object.freeze({ term: "网络思维", ids: ["network-dynamics"] }),
  Object.freeze({ term: "批判性思维", ids: ["critical-audit"] }),
  Object.freeze({ term: "证据核验", ids: ["critical-audit"] }),
  Object.freeze({ term: "证据审查", ids: ["critical-audit"] }),
  Object.freeze({ term: "失败预演", ids: ["premortem"] }),
  Object.freeze({ term: "事前验尸", ids: ["premortem"] }),
  Object.freeze({ term: "目标倒推", ids: ["backcasting"] }),
  Object.freeze({ term: "终局倒推", ids: ["backcasting"] }),
  Object.freeze({ term: "逆向思维", ids: ["premortem", "backcasting"] }),
  Object.freeze({ term: "整合思维", ids: ["integrative-model-generation"] }),
]);

const METHOD_TERM_PATTERN = /第一性原理|线性思维|因果推断|因果分析|系统思维|系统动力学|系统动力分析|矛盾与阶段分析|矛盾分析|矛盾论|利益与激励分析|激励机制分析|激励分析|网络思维|批判性思维|证据核验|证据审查|失败预演|事前验尸|目标倒推|终局倒推|逆向思维|整合思维/gu;
const NEGATION_PATTERN = /不要|请勿|禁止|不必|不能|不用|不使用|不采用|无需|别用|避免使用|排除|without|do not|don't|avoid/iu;
const APPLY_PATTERN = /请.{0,4}(?:用|使用|采用|按照|应用|结合)|(?:用|使用|采用|按照|应用|结合|基于|从|改用).{0,4}$/iu;
const METHOD_AS_OBJECT_PATTERN = /解释|介绍|比较|区别|差异|什么是|含义|来源|定义|历史|评价.{0,3}(?:方法|模型)|没有要求|未要求|没要求|是否.{0,3}(?:应该|需要|可以)|为什么/u;
const DISCUSSION_CUE_PATTERN = /解释|介绍|比较|区别|差异|什么是|含义|来源|定义|历史|没有要求|未要求|没要求|是否.{0,3}(?:应该|需要|可以)|为什么/u;
const NEGATED_METHOD_CONTROL_PATTERN = new RegExp(
  `^(?:也|并|并且|且|再)?(?:请)?(?:不要|请勿|禁止|不必|不能|不用|不使用|不采用|无需|别用|避免使用|排除)(?:再)?(?:使用|采用|用|按照|应用|结合)?(?:${METHOD_TERM_PATTERN.source})`,
  "iu",
);
const NEGATED_DELIVERABLE_CONTROL_PATTERN = /^(?:也|并|并且|且|再)?(?:请)?(?:不要|请勿|禁止|不必|不能|不用|无需|别)(?:再)?(?:给|输出|做|提供|采用|使用|用)?(?:执行方案|行动清单|实施计划|多视角|多角度|多个视角|系统性分析|综合分析)/u;
const NEGATED_FRAGMENT_PATTERN = /^(?:也|并|并且|且|再)?(?:请)?(?:不要|请勿|禁止|不必|不能|不用|不使用|不采用|无需|别用|避免使用|排除)/u;
const EXPANDED_OUTPUT_PATTERN = /完整|详细|全面|全方位|详尽|深入|深度|报告|逐项|逐步|展开|系统性地/u;
const RESEARCH_DELIVERABLE_PATTERN = /(?:调取|查找|搜集|检索|盘点|梳理|研究|调研|调查).{0,28}(?:资料|材料|内容|信息|市场|行业|赛道|报告|案例|出处|来源)|(?:通过|在|到)?(?:网上|在线|互联网|公开渠道).{0,56}(?:找|查|搜|检索|调研|研究|参考).{0,36}(?:东西|资料|案例|模式|报告|出处|来源|信息|素材|材料)|(?:有出处|带出处|有来源).{0,20}(?:调研报告|研究报告|案例|资料|参考)|(?:全方位|全面|完整|详尽).{0,16}(?:资料|材料|信息|内容)/u;
const EXPLICIT_SKILL_DELIVERABLE_PATTERN = /执行方案|执行步骤|行动清单|落地计划|实施计划|里程碑|下一步|可执行.{0,4}(?:计划|步骤)|(?:给出|输出|形成).{0,4}执行步骤|多视角|多个视角|多个角度|多角度|跨领域|综合分析|最终方案|完整方案|业务方案|产品方案|总体方案|统一方案|整合|归纳|汇总|融合|合并|是否|决策建议|风险评估|证据审查|(?:给出|作出|形成).{0,4}判断/u;
const TEXT_TRANSFORMATION_PATTERN = /^(?:(?:请|帮我|请帮我).{0,6})?(?:翻译|总结|摘要|概括|改写|润色|缩写|格式转换|转换格式)/u;
const PERSONAL_PREFETCH_ROOT_ORDER = Object.freeze([
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
  "12_资料库",
]);
const PERSONAL_PREFETCH_ROOT_SET = new Set(PERSONAL_PREFETCH_ROOT_ORDER);

function normalizeKnowledgeWorkflow(value) {
  return KNOWLEDGE_WORKFLOW_SET.has(value) ? value : "none";
}

function boundedText(value, limit = 20_000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function extractQuotedText(input) {
  const quoted = [];
  const withoutMarkdownQuotes = input.replace(/^(?:[ \t]*>| {4}|\t).*$/gmu, (match) => {
    quoted.push(match);
    return " ".repeat(match.length);
  });
  const visible = withoutMarkdownQuotes.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'|「[^」]*」|『[^』]*』/gu, (match) => {
    quoted.push(match);
    return " ".repeat(match.length);
  });
  return { visible, quoted };
}

function explicitTaskSection(input) {
  const bounded = boundedText(input);
  const markers = [...bounded.matchAll(
    /^[ \t]*(?:我的要求|任务要求|最终要求|需要完成的任务|本轮任务|任务)\s*[：:]\s*/gmu,
  )];
  const lastMarker = markers.at(-1);
  if (!lastMarker) return bounded;
  return bounded.slice(lastMarker.index + lastMarker[0].length);
}

function stripNegatedRoutingControl(fragment) {
  const trimmed = fragment.trim();
  if (!trimmed) return "";
  if (/^(?:请)?(?:不要|请勿|不能)(?:忽视|忽略|遗漏)/u.test(trimmed)) {
    return trimmed.replace(/^(?:请)?(?:不要|请勿|不能)(?:忽视|忽略|遗漏)/u, "").trim();
  }
  const withoutMethodControl = trimmed.replace(NEGATED_METHOD_CONTROL_PATTERN, "").trim();
  if (withoutMethodControl !== trimmed) return withoutMethodControl;
  const withoutDeliverableControl = trimmed.replace(NEGATED_DELIVERABLE_CONTROL_PATTERN, "").trim();
  if (withoutDeliverableControl !== trimmed) return withoutDeliverableControl;
  return NEGATED_FRAGMENT_PATTERN.test(trimmed) ? "" : trimmed;
}

function instructionTextForPermissions(input) {
  // Permission opt-outs must survive routing's removal of negative topic signals.
  // Keep the existing quotation/reference boundary, but retain direct prohibitions.
  return explicitTaskSection(extractQuotedText(boundedText(input)).visible);
}

function instructionTextForRouting(input) {
  return explicitTaskSection(extractQuotedText(boundedText(input)).visible)
    .split(/[，,。；;\n]+|但是|不过|然而|可是|但|却/u)
    .map((fragment) => stripNegatedRoutingControl(fragment))
    .filter(Boolean)
    .join(" ");
}

function methodTerms(input) {
  return [...new Set(boundedText(input).match(METHOD_TERM_PATTERN) || [])];
}

function clauseAround(input, index, length) {
  const leftBoundary = Math.max(
    input.lastIndexOf("。", index - 1),
    input.lastIndexOf("；", index - 1),
    input.lastIndexOf(";", index - 1),
    input.lastIndexOf("\n", index - 1),
  );
  const nextBoundaries = ["。", "；", ";", "\n"]
    .map((separator) => input.indexOf(separator, index + length))
    .filter((value) => value >= 0);
  const rightBoundary = nextBoundaries.length ? Math.min(...nextBoundaries) : input.length;
  return input.slice(leftBoundary + 1, rightBoundary);
}

function occurrencePrefix(clause, termIndex) {
  const before = clause.slice(0, termIndex);
  let scopeStart = Math.max(before.lastIndexOf("，"), before.lastIndexOf(",")) + 1;
  for (const match of before.matchAll(/但是|不过|然而|可是|而是|但|却|改用|只采用/gu)) {
    scopeStart = Math.max(scopeStart, match.index);
  }
  return before.slice(scopeStart);
}

function hasExplicitApplication(clause, termIndex) {
  const before = clause.slice(0, termIndex);
  const methodTail = clause.slice(termIndex, Math.min(clause.length, termIndex + 48));
  const methodMatches = [...methodTail.matchAll(METHOD_TERM_PATTERN)];
  const nextMethodIndex = methodMatches[1]?.index;
  const after = methodTail.slice(0, nextMethodIndex === undefined ? 24 : nextMethodIndex);
  const scopedPrefix = occurrencePrefix(clause, termIndex);
  if (NEGATION_PATTERN.test(scopedPrefix) || DISCUSSION_CUE_PATTERN.test(scopedPrefix)) return false;
  if (APPLY_PATTERN.test(scopedPrefix.slice(-20))) return true;
  if (/(?:请.{0,4})?(?:用|使用|采用|按照|应用|结合|基于|改用)/u.test(scopedPrefix)) return true;
  if (/(?:请.{0,4})?做\s*$/u.test(scopedPrefix.slice(-12)) && /系统动力分析/u.test(after)) return true;
  if (/第一性原理/u.test(after) && /重建|推导|拆解|分析|设计/u.test(after)) return true;
  if (/思维/u.test(after) && /分析|审查|评估|拆解|规划|判断/u.test(after)) return true;
  if (/矛盾(?:与阶段)?分析|矛盾论/u.test(after)
    && /(?:请.{0,4})?(?:做|进行)\s*$/u.test(scopedPrefix.slice(-12))) return true;
  if (/(?:利益与)?激励(?:机制)?分析/u.test(after)
    && /(?:请.{0,4})?(?:做|进行)\s*$/u.test(scopedPrefix.slice(-12))) return true;

  const priorMethods = [...before.matchAll(METHOD_TERM_PATTERN)];
  const firstMethod = priorMethods[0];
  if (firstMethod) {
    const firstPrefix = clause.slice(0, firstMethod.index);
    const interMethodText = clause
      .slice(firstMethod.index + firstMethod[0].length, termIndex)
      .replace(METHOD_TERM_PATTERN, "");
    const isPureList = /^[\s、,，和及与或/]*$/u.test(interMethodText);
    if (isPureList && !NEGATION_PATTERN.test(firstPrefix) && !DISCUSSION_CUE_PATTERN.test(firstPrefix)
      && (APPLY_PATTERN.test(firstPrefix.slice(-20))
        || /(?:请.{0,4})?(?:用|使用|采用|按照|应用|结合|基于|改用)/u.test(firstPrefix))) {
      return true;
    }
  }
  return false;
}

function scanExplicitMethods(instructionText) {
  const selected = new Set();
  const selectedTerms = new Set();
  const ignoredSignals = [];
  const { visible, quoted } = extractQuotedText(instructionText);
  for (const quotedText of quoted) {
    for (const term of methodTerms(quotedText)) ignoredSignals.push({ term, reason: "quoted-or-reference" });
  }
  if (isTextTransformation(instructionText)) {
    for (const term of methodTerms(visible)) ignoredSignals.push({ term, reason: "text-transformation-material" });
    return { selected, selectedTerms, ignoredSignals, visible };
  }

  for (const method of PUBLIC_METHODS) {
    let offset = 0;
    while (offset < visible.length) {
      const index = visible.indexOf(method.term, offset);
      if (index < 0) break;
      offset = index + method.term.length;
      const clause = clauseAround(visible, index, method.term.length);
      const clauseStart = Math.max(0, visible.slice(0, index).search(/[^。；;\n]*$/u));
      const localIndex = index - clauseStart;
      const prefix = occurrencePrefix(clause, localIndex).slice(-20);
      if (NEGATION_PATTERN.test(prefix)) {
        ignoredSignals.push({ term: method.term, reason: "negated" });
        continue;
      }
      const methodAsObject = METHOD_AS_OBJECT_PATTERN.test(clause)
        && !hasExplicitApplication(clause, localIndex);
      if (methodAsObject) {
        ignoredSignals.push({ term: method.term, reason: "method-as-object" });
        continue;
      }
      if (hasExplicitApplication(clause, localIndex)) {
        for (const id of method.ids) selected.add(id);
        selectedTerms.add(method.term);
      }
    }
  }
  if (/不要.{0,8}失败预演|不做.{0,6}失败预演/u.test(visible)) {
    ignoredSignals.push({ term: "失败预演", reason: "negated" });
  }
  return { selected, selectedTerms, ignoredSignals, visible };
}

function semanticOperatorIds(input) {
  const activeInput = instructionTextForRouting(input);
  const intents = detectIntentSignals(activeInput);
  const selected = new Set();
  if (TEXT_TRANSFORMATION_PATTERN.test(activeInput)) return selected;
  const firstPrinciplesSignals = [
    /(?:放下|抛开|去掉|删除|移除|不沿用).{0,10}(?:惯例|默认做法|默认前提|既有前提|未经验证的?假设)/u.test(activeInput),
    /事实.{0,12}假设|假设.{0,12}事实/u.test(activeInput),
    /硬约束|不可改变的?条件|不可再简化|必要条件|最小充分条件/u.test(activeInput),
  ].filter(Boolean).length;
  const reconstructionRequested = /重新构造|重新设计|重新推导|重建|从零.{0,8}(?:构造|设计|推导|搭建)/u.test(activeInput);
  if (reconstructionRequested && firstPrinciplesSignals >= 2) {
    selected.add("first-principles-reconstruction");
  }
  const systemSignals = [
    /存量|库存|积累/u.test(activeInput),
    /流量|流入|流出/u.test(activeInput),
    /反馈回路|正反馈|负反馈/u.test(activeInput),
    /时间延迟|滞后/u.test(activeInput),
    /非线性|振荡/u.test(activeInput),
  ].filter(Boolean).length;
  if (systemSignals >= 3) selected.add("system-dynamics");

  const contradictionRelation = /相互(?:制约|限制|牵制|依赖)|互相(?:制约|限制|牵制|依赖)|一方.{0,24}(?:限制|削弱|挤压|依赖).{0,24}另一方|(?:目标|约束|机制).{0,24}(?:彼此|互相|相互).{0,12}(?:冲突|制约|限制)|既要.{0,32}又要.{0,32}(?:难以同时|相互制约|资源有限)/u.test(activeInput);
  const contradictionSignals = [
    /分析对象|对象边界|系统边界|时间范围/u.test(activeInput),
    /当前阶段|阶段变化|阶段转换|阶段转化|转化条件|转化信号|进入下一阶段/u.test(activeInput),
    /主要矛盾|次要矛盾|主导方面|矛盾排序|核心矛盾/u.test(activeInput),
    /瓶颈|限制整体|影响最大|关键依赖|主要卡点/u.test(activeInput),
    /内部机制|外部条件/u.test(activeInput),
  ].filter(Boolean).length;
  if (contradictionRelation && contradictionSignals >= 2
    && /分析|判断|识别|排序|检验|更新/u.test(activeInput)) {
    selected.add("contradiction-stage-analysis");
  }

  const incentiveActors = /参与者|利益相关者|客户|供应商|合作方|员工|雇主|管理者|平台|商家|用户|监管方/u.test(activeInput);
  const incentivePayoffs = /成本.{0,16}(?:收益|回报|奖励|风险)|(?:收益|回报|奖励|风险).{0,16}成本|奖惩|佣金|罚款|考核指标/u.test(activeInput);
  const incentiveSignals = [
    /可选行动|行动选项|策略选择|可能回应|对方回应/u.test(activeInput),
    /信息不对称|掌握信息|隐藏信息|信息差/u.test(activeInput),
    /控制权|决定权|规则制定权|议价权|否决权/u.test(activeInput),
    /一次互动|单次互动|重复互动|长期合作|反复交易/u.test(activeInput),
    /公开目标|可观察激励|合同条款|平台规则/u.test(activeInput),
  ].filter(Boolean).length;
  if (incentiveActors && incentivePayoffs && incentiveSignals >= 2
    && /分析|判断|识别|比较|设计|调整|预测/u.test(activeInput)) {
    selected.add("incentive-structure-analysis");
  }

  const networkSignals = [
    /节点/u.test(activeInput),
    /连接|边|关系网/u.test(activeInput),
    /扩散|传播|级联/u.test(activeInput),
    /中心性|社群|枢纽/u.test(activeInput),
  ].filter(Boolean).length;
  if (networkSignals >= 3) selected.add("network-dynamics");

  if (/证据/u.test(activeInput) && /反证|替代解释|关键前提|偏差|谬误/u.test(activeInput)) {
    selected.add("critical-audit");
  }
  if (/苏格拉底(?:式)?(?:提问|反问|追问)|(?:先|一次只)(?:问我|问)(?:一个)?.{0,8}(?:关键|澄清|高信息)|通过提问.{0,10}(?:澄清|检查).{0,8}(?:概念|目标|前提|假设)/u.test(activeInput)) {
    selected.add("socratic-clarification");
  }
  if (intents.judgmentAudit) selected.add("critical-audit");
  if (/(?:假设|设想|预演).{0,30}(?:方案|计划|项目|上线|扩张|实施).{0,20}(?:最终|最后|到期)?失败/u.test(activeInput)
    && /失效机制|失败原因|早期预警|预警信号|停止条件|如何失效/u.test(activeInput)) {
    selected.add("premortem");
  }
  if (/(?:从|以).{0,12}(?:目标|终局|结果|验收).{0,12}(?:倒推|反推)|(?:倒推|反推).{0,12}(?:必要条件|依赖|路径|步骤|里程碑|最晚决策点)/u.test(activeInput)
    || /(?:最终|终局).{0,16}(?:验收|目标|结果|状态).{0,48}(?:倒推|反推).{0,20}(?:必要条件|依赖|路径|步骤|里程碑)/u.test(activeInput)) {
    selected.add("backcasting");
  }
  if (/因果链|作用机制|因果机制|因果关系|相关不等于因果|反向因果|共同原因|混杂变量|反事实/u.test(activeInput)
    || /(?:是否|能否|会不会|是不是).{0,32}(?:导致|造成|引发).{0,32}/u.test(activeInput)) {
    selected.add("causal-analysis");
  }
  if (intents.documentSynthesis && intents.finalSolution) {
    selected.add("integrative-model-generation");
  }
  if (/冲突.{0,8}(?:模型|方案|要求)|(?:模型|方案).{0,8}冲突/u.test(activeInput)
    && /整合|新架构|兼容/u.test(activeInput)) selected.add("integrative-model-generation");
  if (intents.actionPlanning) selected.add("execution-sequencing");
  return selected;
}

function classifyDeliverable(input, knowledgeWorkflow) {
  if (knowledgeWorkflow !== "none") return "knowledge-package";
  const intents = detectIntentSignals(input);
  if (RESEARCH_DELIVERABLE_PATTERN.test(input)) return "research";
  if (intents.documentSynthesis) return "document-synthesis";
  if (/(?:^|[，,。；;]\s*)(?:(?:请|帮我|请帮我).{0,4})?(?:解释|介绍)|什么是|区别|差异|定义/u.test(input)
    || /(?:信息|数据|理论|说法|概念|方法|结论|资料).{0,6}来源|来源(?:是什么|哪里|何处|于)/u.test(input)) {
    return "explanation";
  }
  if (intents.actionPlanning
    || /行动清单|执行方案|执行步骤|落地计划|实施计划|里程碑|下一步|可执行.{0,4}(?:计划|步骤)/u.test(input)) {
    return "execution-plan";
  }
  if (intents.multiPerspective
    || /多视角|多个视角|多个角度|多角度|系统性分析|综合分析/u.test(input)) {
    return "multi-perspective-analysis";
  }
  if (intents.judgmentAudit
    || /是否|应该|判断|决策|选择|取舍|评估|审查|核验|风险|证据|反证/u.test(input)) {
    return "decision-evaluation";
  }
  return /分析|拆解|梳理|研究/u.test(input) ? "analysis" : "direct-answer";
}

function operatorLimit(taskLevel, deliverable) {
  if (taskLevel === "T3_PANEL" || taskLevel === "T4_GATED") return 4;
  if (taskLevel === "T2_JUDGMENT" || deliverable === "decision-evaluation") return 3;
  return 2;
}

function personalPrefetchRoots(input, continuityRoots = []) {
  const explicitPersonal = /我的|我目前|我现在|我最近|我过去|我曾经|我以前|我当前|我接下来|我最|结合我|关于我|对我|我是谁|最近的真实状态|当前状况/u.test(input);
  const continuity = /继续(?:上次|昨天|前面|之前)|根据(?:你)?(?:前面|之前|上次)|你(?:前面|之前|上次|刚才)(?:的|提供|提到|构建|给出)|你给的(?:这|这一|上|上一)版|上次(?:的|提到|讨论)|昨天(?:的|未完成)|前面(?:的|提到|讨论|说过|构建)|之前(?:的|提到|讨论)|这个(?:工作|项目|计划|目标|选择|判断|方案)|这份(?:工作|计划|方案)|当前(?:工作|项目|计划)|已有(?:计划|判断|项目|记录)/u.test(input);
  const localQuery = /知识库|资料库|本地资料|参考资料|查阅资料|已有记录|现有记录|进行中项目|过去经历/u.test(input);
  const directedPersonalDomain = /给我/u.test(input) && /职业|工作转型|人生规划/u.test(input);
  if (!explicitPersonal && !continuity && !localQuery && !directedPersonalDomain) return [];
  const roots = [];
  const add = (root) => { if (!roots.includes(root)) roots.push(root); };
  if (/身份|角色|价值|能力|状态|当前状况|基本信息|真实状态/u.test(input)) add("01_当前的我");
  if (/过去|历史|经历|以前|曾经/u.test(input)) add("02_我的历史");
  if (/环境|政策|区域|行业|社会|市场/u.test(input)) add("03_环境");
  if (/关系|家人|朋友|同事|合作|团队/u.test(input)) add("04_关系");
  if (/目标|项目|职业|工作|长期|计划|转型|公司|入职|职位|管理层/u.test(input)) add("05_目标与项目");
  if (/判断|决策|选择|取舍|风险|证据|反证|失败条件|机会成本|应该/u.test(input)) add("06_判断与决策");
  if (/行动|执行|下一步|完成|推进|待办|未完成|准备|接下来|方案|运营|开发/u.test(input)) add("07_行动");
  if (/行动结果|真实结果|复盘记录|结果反馈/u.test(input)) add("08_结果与反馈");
  if (/我的原则|我的模型|我的方法|认知资产/u.test(input)) add("09_认知资产");
  if (/来源|引用|核验.{0,5}(?:记录|资料)|我的证据/u.test(input)) add("11_证据与来源");
  if (/资料库|本地资料|参考资料|查阅资料|外部资料|文档资料|本地报告/u.test(input)) add("12_资料库");
  if (!roots.length && explicitPersonal) add("01_当前的我");
  if (!roots.length && continuity) {
    const priorRoots = new Set(Array.isArray(continuityRoots)
      ? continuityRoots.filter((root) => PERSONAL_PREFETCH_ROOT_SET.has(root))
      : []);
    for (const root of PERSONAL_PREFETCH_ROOT_ORDER) {
      if (priorRoots.has(root)) add(root);
    }
  }
  return roots;
}

function buildReasoningPlan({
  instructionText = "",
  referenceText = "",
  taskLevel = "T0_DIRECT",
  knowledgeWorkflow: rawKnowledgeWorkflow = "none",
  continuityRoots = [],
} = {}) {
  const instruction = boundedText(instructionText);
  const reference = boundedText(referenceText);
  const knowledgeWorkflow = normalizeKnowledgeWorkflow(rawKnowledgeWorkflow);
  const normalizedTaskLevel = TASK_LEVEL_SET.has(taskLevel) ? taskLevel : "T4_GATED";
  const instructionExtraction = extractQuotedText(instruction);
  const routableInstruction = explicitTaskSection(instructionExtraction.visible);
  const explicit = scanExplicitMethods(routableInstruction);
  for (const quotedText of instructionExtraction.quoted) {
    for (const term of methodTerms(quotedText)) {
      explicit.ignoredSignals.push({ term, reason: "quoted-or-reference" });
    }
  }
  for (const term of methodTerms(reference)) {
    explicit.ignoredSignals.push({ term, reason: "quoted-or-reference" });
  }
  const positiveInstruction = instructionTextForRouting(explicit.visible);
  const deliverable = classifyDeliverable(positiveInstruction, knowledgeWorkflow);
  const candidates = new Set(explicit.selected);
  if (knowledgeWorkflow !== "none") {
    candidates.clear();
  } else if (deliverable !== "explanation") {
    for (const id of semanticOperatorIds(explicit.visible)) candidates.add(id);
  }
  const orderedCandidates = REASONING_OPERATOR_ORDER.filter((id) => candidates.has(id));
  const limit = operatorLimit(normalizedTaskLevel, deliverable);
  const operatorIds = orderedCandidates.slice(0, limit);
  const omittedOperatorIds = orderedCandidates.slice(limit);
  const mandatoryGates = ["permission-boundary"];
  if (["T2_JUDGMENT", "T3_PANEL", "T4_GATED"].includes(normalizedTaskLevel)
    || deliverable === "decision-evaluation") mandatoryGates.push("evidence-calibration");
  const methodSelectionMode = knowledgeWorkflow !== "none"
    ? "none"
    : (explicit.selected.size > 0 ? "explicit" : (orderedCandidates.length > 0 ? "semantic" : "none"));
  const pureMethodRequest = methodSelectionMode === "explicit"
    && explicit.selectedTerms.size === 1
    && !EXPLICIT_SKILL_DELIVERABLE_PATTERN.test(positiveInstruction);
  const outputDepth = EXPANDED_OUTPUT_PATTERN.test(positiveInstruction)
    || RESEARCH_DELIVERABLE_PATTERN.test(positiveInstruction)
    ? "expanded"
    : (pureMethodRequest ? "concise" : "standard");

  return {
    deliverable,
    methodSelectionMode,
    pureMethodRequest,
    outputDepth,
    knowledgeWorkflow,
    knowledgeSubmissionAllowed: KNOWLEDGE_SUBMISSION_WORKFLOWS.has(knowledgeWorkflow),
    operatorIds,
    operators: operatorIds.map((id) => getReasoningOperator(id)),
    omittedOperatorIds,
    mandatoryGates,
    ignoredSignals: explicit.ignoredSignals,
    plannedPrefetchRoots: knowledgeWorkflow === "none"
      ? personalPrefetchRoots(positiveInstruction, continuityRoots)
      : [],
  };
}

module.exports = {
  KNOWLEDGE_WORKFLOWS,
  buildReasoningPlan,
  instructionTextForPermissions,
  instructionTextForRouting,
  normalizeKnowledgeWorkflow,
};
