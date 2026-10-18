"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");

const CAUSAL_EVIDENCE_SOURCE_PATH = "10_智能体与技能/技能/因果与证据检验/SKILL.md";
const CAUSAL_DIMENSIONS = Object.freeze([
  "因果主张",
  "观察与时间顺序",
  "作用机制",
  "竞争解释",
  "混杂与选择",
  "反事实与比较",
  "因果结论",
  "反证条件",
  "下一步验证",
]);
const EVIDENCE_DIMENSIONS = Object.freeze([
  "待核验主张",
  "可追溯性",
  "直接性与测量",
  "独立性与覆盖",
  "反证与偏差",
  "外推与适用边界",
  "证据结论",
  "反证条件",
  "下一步验证",
]);
const JOINT_DIMENSIONS = Object.freeze([
  "因果主张",
  "观察与时间顺序",
  "作用机制",
  "竞争解释",
  "混杂与选择",
  "反事实与比较",
  "可追溯性",
  "直接性与测量",
  "独立性与覆盖",
  "外推与适用边界",
  "下一步验证",
]);

const CAUSAL_EVIDENCE_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "causal-onboarding-retention",
    domain: "causal-explanation",
    operatorId: "causal-analysis",
    input: "测试情景：一个产品改版了新用户引导，改版后一周留存率上升；同一时期投放渠道和用户地区构成也发生变化。只有改版前后汇总数据，没有随机分组。请判断现有信息能否支持‘新引导导致留存提高’，检查时间顺序、机制、反向因果、共同原因、混杂和最低成本反事实验证。",
    expectedDimensions: CAUSAL_DIMENSIONS,
  }),
  Object.freeze({
    id: "causal-discount-win-rate",
    domain: "causal-explanation",
    operatorId: "causal-analysis",
    input: "测试情景：销售记录显示折扣更大的报价赢单率更高，但销售可以自行决定给哪些客户折扣，客户规模、紧急程度和竞争强度没有完整记录。请判断折扣是否造成赢单率提高，区分观察、机制、选择进入、混杂、反事实和可证伪结论，不编造效应大小。",
    expectedDimensions: CAUSAL_DIMENSIONS,
  }),
  Object.freeze({
    id: "audit-single-success-story",
    domain: "evidence-audit",
    operatorId: "critical-audit",
    input: "测试情景：一份方案用某家公司采用新流程后营收增长的单个成功案例，支持‘该流程适合所有同类公司’。材料没有原始经营数据、失败案例、同期变化或选择案例的方法。请核验证据能支持到什么程度，检查可追溯性、测量、独立性、偏差、反证和外推边界。",
    expectedDimensions: EVIDENCE_DIMENSIONS,
  }),
  Object.freeze({
    id: "audit-repeated-press-release",
    domain: "evidence-audit",
    operatorId: "critical-audit",
    input: "测试情景：一份报告列出六篇文章证明某项服务可靠，但六篇都转述同一供应商新闻稿；新闻稿发布于三年前，研究地区和当前目标市场不同，也没有公开故障定义。请审查来源独立性、直接性、时效、测量口径、冲突证据与适用边界。",
    expectedDimensions: EVIDENCE_DIMENSIONS,
  }),
  Object.freeze({
    id: "joint-followup-win-rate",
    domain: "joint",
    operatorIds: Object.freeze(["causal-analysis", "critical-audit"]),
    input: "测试情景：CRM 汇总显示首次跟进更快的物流询盘赢单率更高，团队据此宣称‘把首次跟进压到十分钟内会提高所有询盘的赢单率’。现有记录缺少客户紧急程度、货量、线路、销售经验和未录入询盘。请同时做因果分析与证据核验，共享一次主张和证据清单，检查机制、反向因果、混杂、选择偏差、测量与外推，并给出一个可区分竞争解释的验证。",
    expectedDimensions: JOINT_DIMENSIONS,
  }),
  Object.freeze({
    id: "joint-reminder-completion",
    domain: "joint",
    operatorIds: Object.freeze(["causal-analysis", "critical-audit"]),
    input: "测试情景：知识工作台上线每日提醒后，任务完成率和满意度同时提高；但新版也改变了任务定义，首批用户来自高活跃邀请名单，满意度只来自完成问卷的人。团队准备据此认定提醒机制有效并推广。请联合检查因果识别和证据质量，避免重复同一偏差，说明反事实、测量、选择、外推和停止条件。",
    expectedDimensions: JOINT_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-causal-translation",
    domain: "simple-negative",
    operatorIds: Object.freeze([]),
    input: "请把‘相关性不等于因果关系’翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-evidence-summary",
    domain: "simple-negative",
    operatorIds: Object.freeze([]),
    input: "请把这句话缩短到十五个字以内：这份材料讨论了反向因果、混杂变量和证据边界。",
    expectedDimensions: Object.freeze([]),
  }),
]);

const causalEvidencePilot = createCognitiveLensPilot({
  label: "因果与证据检验",
  sourcePath: CAUSAL_EVIDENCE_SOURCE_PATH,
  skillId: "xingzhi-causal-evidence-audit",
  operatorBindings: [
    { id: "causal-analysis", mode: "causal-explanation" },
    { id: "critical-audit", mode: "evidence-audit" },
  ],
  cases: CAUSAL_EVIDENCE_PILOT_CASES,
  messageIdPrefix: "causal-evidence-pilot",
});

module.exports = {
  CAUSAL_DIMENSIONS,
  CAUSAL_EVIDENCE_PILOT_CASES,
  CAUSAL_EVIDENCE_SOURCE_PATH,
  EVIDENCE_DIMENSIONS,
  JOINT_DIMENSIONS,
  causalEvidencePilotStatus: causalEvidencePilot.status,
  runCausalEvidencePilotCase: causalEvidencePilot.run,
};
