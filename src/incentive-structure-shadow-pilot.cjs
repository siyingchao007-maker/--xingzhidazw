"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");

const INCENTIVE_STRUCTURE_SOURCE_PATH = "10_智能体与技能/技能/利益与激励分析/SKILL.md";
const INCENTIVE_STRUCTURE_DIMENSIONS = Object.freeze([
  "决策问题与边界",
  "参与者与角色",
  "公开目标",
  "可观察激励",
  "信息结构",
  "控制权与约束",
  "可选行动",
  "可能回应",
  "一次互动与重复互动",
  "策略稳定性",
  "动机边界",
  "激励重构",
  "反证条件",
  "下一步验证",
]);

const INCENTIVE_STRUCTURE_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "customer-discount-verbal-intent",
    domain: "customer",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：销售可用折扣换客户口头意向，交付团队承担定制成本，客户未承诺下单；三方掌握的信息不同，销售奖励按签约额计算。没有真实转化率或动机证据。请分析公开目标、可观察成本收益、控制权、可选行动和可能回应。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "customer-renewal-service-level",
    domain: "customer",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：客户希望供应商先投入更高服务等级再决定续约，供应商希望先获得期限承诺再增加投入；双方可能长期合作，也都能退出。当前没有续约概率和替代供应商数据。请比较一次与重复互动，不推断任何一方真实动机。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "collaboration-referral-credit",
    domain: "collaboration",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：两家合作方共同开发客户，一方掌握线索，另一方负责交付；佣金只在最终签约后分配，客户归属和失败成本未写进合同。请分析信息、控制权、行动选项、可能回应和可逆的激励重构，不把争议解释为恶意。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "collaboration-shared-maintenance",
    domain: "collaboration",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：合作项目的新增功能由双方共享收益，但维护工作主要由一方承担；功能优先级由另一方决定，维护方可延后支持。互动预计持续一年，没有各方实际投入记录。请检查成本转移、名义与实际控制和适应性回应。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "workplace-ticket-metric",
    domain: "workplace",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：团队只按关闭工单数奖励，成员开始优先处理简单工单，复杂问题积压。已有工单记录，但没有访谈或个人动机证据。请区分可观察行为、激励一致性与真实动机，并提出能检验替代解释的规则调整。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "workplace-manager-training",
    domain: "workplace",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：公司公开鼓励主管培养新人，但季度考核只计算本组即时产出；主管能决定任务分配，新人无法看到晋升标准。请分析公开目标、考核成本收益、信息结构、控制权与可能回应，不断言主管故意压制新人。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "platform-refund-threshold",
    domain: "platform-rules",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：平台降低退款申诉门槛，用户、商家、服务商和平台承担不同成本并拥有不同信息；平台能改规则，商家可调整售后和价格，用户可改变申诉行为。没有行为变化数据。请分析多方适应和副作用。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "platform-ranking-fee",
    domain: "platform-rules",
    operatorId: "incentive-structure-analysis",
    input: "测试情景：平台按付费推广提高曝光，商家可加大投放或退出，用户只能观察排名而不知道付费权重；平台公开目标是提升匹配效率。请区分公开目标与可观察激励，检查信息不对称、指标游戏和成本转移。",
    expectedDimensions: INCENTIVE_STRUCTURE_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-translation",
    domain: "simple-negative",
    operatorId: null,
    input: "请把“平台调整了奖励规则”翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-motive-question",
    domain: "simple-negative",
    operatorId: null,
    input: "同事今天没有回复消息，他是不是故意针对我？",
    expectedDimensions: Object.freeze([]),
  }),
]);

const incentiveStructurePilot = createCognitiveLensPilot({
  label: "利益与激励分析",
  sourcePath: INCENTIVE_STRUCTURE_SOURCE_PATH,
  skillId: "xingzhi-incentive-structure-analysis",
  operatorId: "incentive-structure-analysis",
  operatorMode: "incentive-structure",
  cases: INCENTIVE_STRUCTURE_PILOT_CASES,
  messageIdPrefix: "incentive-structure-pilot",
});

module.exports = {
  INCENTIVE_STRUCTURE_DIMENSIONS,
  INCENTIVE_STRUCTURE_PILOT_CASES,
  INCENTIVE_STRUCTURE_SOURCE_PATH,
  incentiveStructurePilotStatus: incentiveStructurePilot.status,
  runIncentiveStructurePilotCase: incentiveStructurePilot.run,
};
