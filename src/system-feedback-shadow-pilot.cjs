"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");

const SYSTEM_FEEDBACK_SOURCE_PATH = "10_智能体与技能/技能/系统与反馈分析/SKILL.md";
const SYSTEM_FEEDBACK_DIMENSIONS = Object.freeze([
  "决策问题",
  "系统边界",
  "关键存量与流量",
  "反馈回路",
  "时间延迟",
  "瓶颈",
  "局部最优",
  "短期和长期效应",
  "杠杆点",
  "反证条件",
  "下一步验证",
]);

const SYSTEM_FEEDBACK_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "business-lead-overload-loop",
    domain: "business-operations",
    operatorId: "system-dynamics",
    input: "测试情景：一家销售团队发现线索越多，销售越忙，首次跟进越慢，客户流失越多；管理者看到流失后又购买更多线索。当前只知道这些重复现象，没有转化率、处理时长或因果实验。请建立有边界的系统模型，区分回路假设、延迟、瓶颈和可逆杠杆点。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "business-quote-backlog",
    domain: "business-operations",
    operatorId: "system-dynamics",
    input: "测试情景：一家物流销售团队以每天发出报价数考核前端。报价请求持续进入，但审核能力固定；积压越多，报价越仓促，返工和客户追问又占用更多审核时间。没有真实排队时长和赢单数据。请分析存量、流量、反馈、局部最优、短长期效应和最低成本验证。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "product-feature-commitment-loop",
    domain: "product-delivery",
    operatorId: "system-dynamics",
    input: "测试情景：产品团队为了提高短期签约率持续承诺定制功能；待开发需求和交付等待不断积累，延期又促使销售承诺更多补偿功能。现有资料没有证明每个箭头的因果关系。请建立系统图假设，识别瓶颈、局部最优、延迟、反弹路径与验证杠杆。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "product-knowledge-review-backlog",
    domain: "product-delivery",
    operatorId: "system-dynamics",
    input: "测试情景：一个知识库工作台自动提取的候选记忆越来越多，人工审核速度没有同步提高。积压使用户更少打开审核页，未审核内容继续增长；团队考虑进一步提高自动提取量。请限定系统边界，分析存量流量、反馈延迟、局部指标与可逆试验，不编造任何数量。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "personal-sleep-caffeine-loop",
    domain: "personal-system",
    operatorId: "system-dynamics",
    input: "测试情景：一个人晚上睡得晚，白天疲劳时喝更多咖啡，晚上又更难提前入睡；周末补觉后短期感觉改善，但下周作息继续波动。只有个人描述，没有连续记录。请用系统与反馈视角提出竞争模型、延迟、短长期效应和可验证的小干预。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "personal-learning-consumption-loop",
    domain: "personal-system",
    operatorId: "system-dynamics",
    input: "测试情景：一个学习者因担心能力不足而收藏更多课程，待学内容持续积累；积压带来压力，压力又让他减少练习并继续寻找新资料。现在没有学习时长或能力基线。请分析反馈回路、时间延迟、瓶颈、局部最优和最小验证，不把模型当成事实。",
    expectedDimensions: SYSTEM_FEEDBACK_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-translation",
    domain: "simple-negative",
    operatorId: null,
    input: "请把“系统将在下午三点维护”翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-one-time-summary",
    domain: "simple-negative",
    operatorId: null,
    input: "请把这句话缩短到十二个字以内：今天服务器发生了一次短暂故障，目前已经恢复。",
    expectedDimensions: Object.freeze([]),
  }),
]);

const systemFeedbackPilot = createCognitiveLensPilot({
  label: "系统与反馈分析",
  sourcePath: SYSTEM_FEEDBACK_SOURCE_PATH,
  skillId: "xingzhi-system-feedback-analysis",
  operatorId: "system-dynamics",
  operatorMode: "system-feedback",
  cases: SYSTEM_FEEDBACK_PILOT_CASES,
  messageIdPrefix: "system-feedback-pilot",
});

module.exports = {
  SYSTEM_FEEDBACK_DIMENSIONS,
  SYSTEM_FEEDBACK_PILOT_CASES,
  SYSTEM_FEEDBACK_SOURCE_PATH,
  runSystemFeedbackPilotCase: systemFeedbackPilot.run,
  systemFeedbackPilotStatus: systemFeedbackPilot.status,
};
