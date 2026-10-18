"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");

const REVERSAL_FAILURE_SOURCE_PATH = "10_智能体与技能/技能/反演与失败条件/SKILL.md";
const PREMORTEM_DIMENSIONS = Object.freeze([
  "预演对象",
  "失败状态",
  "失效机制",
  "关键暴露",
  "早期预警",
  "预防与缓解",
  "应急与停止条件",
  "校准结论",
  "反证条件",
  "下一步验证",
]);
const BACKCASTING_DIMENSIONS = Object.freeze([
  "终局验收",
  "必要条件",
  "依赖与顺序",
  "阶段证据",
  "最晚决策点",
  "瓶颈与余量",
  "倒推结论",
  "反证条件",
  "下一步验证",
]);
const JOINT_DIMENSIONS = Object.freeze([
  "终局验收",
  "必要条件",
  "依赖与顺序",
  "阶段证据",
  "最晚决策点",
  "关键路径",
  "失败状态",
  "失效机制",
  "关键暴露",
  "早期预警",
  "预防与缓解",
  "停止条件",
  "下一步验证",
]);

const REVERSAL_FAILURE_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "premortem-product-launch",
    domain: "failure-premortem",
    operatorId: "premortem",
    input: "测试情景：团队准备在六周内上线一个面向真实订单的工作台，目前接口稳定性、异常恢复和一线人员培训仍未完成验证。请做失败预演：假设上线后三个月未达到稳定使用标准，定义可观察的失败状态，识别失效机制、关键暴露、早期预警、预防缓解、应急与停止条件；不要编造失败概率、日期阈值或资源承诺。",
    expectedDimensions: PREMORTEM_DIMENSIONS,
  }),
  Object.freeze({
    id: "premortem-market-expansion",
    domain: "failure-premortem",
    operatorId: "premortem",
    input: "测试情景：一家服务团队准备扩展到新的海外线路，但产品边界、报价口径、交付伙伴和合规责任尚未验证。请暂设扩张计划最终失败，找出少量有机制链的失败方式、可提前观察的信号、降低暴露的动作和停止扩张的证据条件；区分高影响假设与低价值风险清单。",
    expectedDimensions: PREMORTEM_DIMENSIONS,
  }),
  Object.freeze({
    id: "backcasting-order-readiness",
    domain: "goal-backcasting",
    operatorId: "backcasting",
    input: "测试情景：终局验收是团队能够在明确产品边界和责任分工下，完成一票可追溯的真实试单，并保存询价、报价、确认、执行与结果证据。请从终局倒推必要条件、依赖顺序、阶段证据、最晚决策点和主要瓶颈；缺少真实时间与资源数据时只给相对顺序，不编造日历日期。",
    expectedDimensions: BACKCASTING_DIMENSIONS,
  }),
  Object.freeze({
    id: "backcasting-capability-release",
    domain: "goal-backcasting",
    operatorId: "backcasting",
    input: "测试情景：终局验收是一个认知 Skill 在隔离环境完成固定正负例评测，活动版本可追溯、单一来源、可回退，且不影响简单任务。请反推达到终局前不可缺少的条件、依赖和阶段证据，指出最晚决策点、瓶颈与安全余量，不把完成开发活动等同于通过验收。",
    expectedDimensions: BACKCASTING_DIMENSIONS,
  }),
  Object.freeze({
    id: "joint-knowledge-workbench-release",
    domain: "joint",
    operatorIds: Object.freeze(["premortem", "backcasting"]),
    input: "测试情景：一个本地知识工作台准备发布新版，终局要求插件能加载、正式数据不被试验覆盖、四类核心任务路由正常、单项能力故障可隔离和回退。请同时做目标倒推与失败预演：先形成必要路径和阶段证据，再检查关键路径如何失效、有哪些早期预警与停止条件；共享目标和依赖清单，避免把同一缺口重复成两条发现。",
    expectedDimensions: JOINT_DIMENSIONS,
  }),
  Object.freeze({
    id: "joint-sales-pilot",
    domain: "joint",
    operatorIds: Object.freeze(["premortem", "backcasting"]),
    input: "测试情景：一个新业务试点的终局验收是获得经过资格判断的真实机会，并用已核实的产品能力完成一次可复盘的试单；当前只有零散咨询，产品真相、报价责任和客户货物信息仍不完整。请先倒推必要条件、依赖与证据，再预演关键路径可能怎样失败，给出领先信号、缓解与停止条件；不要把联系人数量当作订单证据，也不要编造成功率。",
    expectedDimensions: JOINT_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-actual-retrospective",
    domain: "simple-negative",
    operatorIds: Object.freeze([]),
    input: "测试情景：昨天的部署已经失败，请根据现有日志概括实际发生了什么。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-translation",
    domain: "simple-negative",
    operatorIds: Object.freeze([]),
    input: "请把‘失败预演不能证明失败概率’翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
]);

const reversalFailurePilot = createCognitiveLensPilot({
  label: "反演与失败条件",
  sourcePath: REVERSAL_FAILURE_SOURCE_PATH,
  skillId: "xingzhi-reversal-failure-conditions",
  operatorBindings: [
    { id: "premortem", mode: "failure-premortem" },
    { id: "backcasting", mode: "goal-backcasting" },
  ],
  cases: REVERSAL_FAILURE_PILOT_CASES,
  messageIdPrefix: "reversal-failure-pilot",
});

module.exports = {
  BACKCASTING_DIMENSIONS,
  JOINT_DIMENSIONS,
  PREMORTEM_DIMENSIONS,
  REVERSAL_FAILURE_PILOT_CASES,
  REVERSAL_FAILURE_SOURCE_PATH,
  reversalFailurePilotStatus: reversalFailurePilot.status,
  runReversalFailurePilotCase: reversalFailurePilot.run,
};
