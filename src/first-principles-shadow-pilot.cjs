"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");
const { FIRST_PRINCIPLES_PROBE_SOURCE_PATH } = require("./first-principles-shadow-probe.cjs");

const STANDARD_DIMENSIONS = Object.freeze([
  "目标",
  "事实",
  "假设",
  "硬约束",
  "软约束",
  "未知",
  "必要条件",
  "重构方案",
  "反证条件",
  "下一步验证",
  "适用边界",
]);

const FIRST_PRINCIPLES_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "product-local-knowledge-home",
    domain: "product",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一个本地个人知识库工作台把记忆、成长和行动混在同一长列表。明确目标是让用户在首页判断今天先推进什么；已知要求是本地优先、每张卡能回到来源、未经确认的推断不能写成事实。请放下现有栏目惯例，从第一性原理重构首页信息架构，并给出可逆验证。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "product-agent-skill-boundary",
    domain: "product",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一个知识工作台允许用户在 Obsidian 中编辑 MD Skill，再由 Agent 按任务调用。已知问题是方法正文、权限规则和最终回答布局容易重复注入；明确要求是 MD 保持人工可编辑，Agent 不得扩大读取或写入权限。请从第一性原理重构 Agent、Skill 与运行时代码的职责边界，并提出最小试点。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "career-sales-first-order",
    domain: "career",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一名物流销售准备开发欧洲线路业务。当前只有十个曾经加过联系方式但没有已验证货运需求的人，没有完成订单，也没有核实公司的具体线路能力、价格和合规边界。目标是取得第一笔可交付订单。请区分事实、假设和约束，从必要条件重构下一阶段职业行动，并给出停止或改向条件。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "career-role-choice",
    domain: "career",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一名工作者正在比较继续做现岗位与转向产品岗位。已知现岗位收入稳定，产品岗位尚无录用通知；本人更看重三年后的能力复利，但可承受的无收入期只有两个月。其他薪资、家庭责任和岗位匹配度未知。请从第一性原理重构决策，不把偏好或可能性写成事实。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "personal-learning-plan",
    domain: "personal-decision",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一个人想在十二周内提高公开表达能力。已知每周只能投入三小时，目前没有基线测量，也不知道主要问题是内容结构、临场紧张还是声音表现。请放下常见课程清单，从目标和必要条件重构一个可逆学习方案，并说明什么证据会让方案改变。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "personal-city-move",
    domain: "personal-decision",
    operatorId: "first-principles-reconstruction",
    input: "测试情景：一个人考虑是否搬到另一座城市。已知新城市有一份书面工作机会，税后收入提高百分之十五；搬迁成本、住房差额、社交支持和试用期风险尚未核实。本人明确偏好更多自主时间，但没有给各目标排序。请从第一性原理重构这个决定，并给出成本最低的验证步骤。",
    expectedDimensions: STANDARD_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-translation",
    domain: "simple-negative",
    operatorId: null,
    input: "请把“今天下午三点开会”翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-summary",
    domain: "simple-negative",
    operatorId: null,
    input: "请把这句话缩短到十个字以内：所有尚未经过验证的推断都需要单独标记。",
    expectedDimensions: Object.freeze([]),
  }),
]);

const firstPrinciplesPilot = createCognitiveLensPilot({
  label: "第一性重建",
  sourcePath: FIRST_PRINCIPLES_PROBE_SOURCE_PATH,
  skillId: "xingzhi-first-principles",
  operatorId: "first-principles-reconstruction",
  operatorMode: "reconstruction",
  cases: FIRST_PRINCIPLES_PILOT_CASES,
  messageIdPrefix: "first-principles-pilot",
});

const firstPrinciplesPilotStatus = firstPrinciplesPilot.status;
const runFirstPrinciplesPilotCase = firstPrinciplesPilot.run;

module.exports = {
  FIRST_PRINCIPLES_PILOT_CASES,
  STANDARD_DIMENSIONS,
  firstPrinciplesPilotStatus,
  runFirstPrinciplesPilotCase,
};
