"use strict";

const { createCognitiveLensPilot } = require("./cognitive-lens-pilot.cjs");

const CONTRADICTION_STAGE_SOURCE_PATH = "10_智能体与技能/技能/矛盾与阶段分析/SKILL.md";
const CONTRADICTION_STAGE_DIMENSIONS = Object.freeze([
  "决策问题",
  "对象",
  "系统边界",
  "时间范围",
  "当前阶段",
  "候选矛盾",
  "主要矛盾与次要矛盾",
  "瓶颈",
  "主导方面",
  "内部机制与外部条件",
  "转化条件与转化信号",
  "更新规则",
  "反证条件",
  "下一步验证",
]);

const CONTRADICTION_STAGE_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: "product-validation-expansion",
    domain: "product",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：产品尚未验证核心需求，但团队为了争取更多客户持续扩张功能；功能扩张占用验证资源，验证不足又使团队用更多功能弥补不确定性。现有资料没有转化率和使用数据。请限定对象、边界、时间与阶段，判断主次矛盾、主导方面和转化信号。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "product-new-evidence-reorders",
    domain: "product",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：团队原先把获客不足当作主要瓶颈；新证据显示合格客户已经积压，但报价审核平均需要七天，销售因此继续扩大获客以弥补等待。请根据新证据重新检查对象、阶段、瓶颈与依赖，更新主要矛盾排序，不把阶段变化写成必然。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "career-cashflow-transition",
    domain: "career",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：一个人需要当前工作提供稳定现金流，职业转型又需要持续投入同一段晚间时间；加班提高短期收入，却减少转型验证，转型不确定又增强对加班收入的依赖。没有储蓄、机会或学习进展数据。请做有边界的阶段与矛盾分析。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "career-role-growth-load",
    domain: "career",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：员工想承担更复杂任务获得成长，但当前交付负荷使其只能重复熟悉工作；重复工作保证短期绩效，却继续压缩学习和试错空间。请区分内部机制与外部条件，按瓶颈、影响和依赖判断主次，不推测主管动机。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "relationship-autonomy-review",
    domain: "relationship",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：两位合作者一方需要自主决策以提高响应速度，另一方需要共同审核以控制对外承诺风险；审核越全面，响应越慢，响应失误又会增加双方对审核的要求。只有双方对流程的陈述，没有动机证据。请分析双向制约和可验证的转化条件。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "relationship-care-boundary",
    domain: "relationship",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：家庭成员需要彼此支持，但频繁临时求助会挤压另一方恢复和工作的时间；支持不足会降低信任，过度承诺又会增加失约。请限定关系与时间边界，识别共同资源、当前主导方面和更新判断所需证据，不做道德定性。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "growth-depth-opportunity",
    domain: "long-term-growth",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：长期能力需要深度练习与及时反馈，但获取真实机会又需要持续对外交付；练习占用交付时间，低质量交付会减少后续反馈机会。健康和任务难度也会影响结果。请保留多因素，不强行二分，并判断当前最限制结果的关系。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "growth-exploration-consolidation",
    domain: "long-term-growth",
    operatorId: "contradiction-stage-analysis",
    input: "测试情景：学习者不断探索新领域以寻找方向，但每次探索都会减少巩固已有能力的时间；巩固不足使实际反馈稀少，又促使其继续探索。当前只有个人回忆，没有连续记录。请判断当前阶段、主次关系、主导方面和最小验证。",
    expectedDimensions: CONTRADICTION_STAGE_DIMENSIONS,
  }),
  Object.freeze({
    id: "simple-negative-translation",
    domain: "simple-negative",
    operatorId: null,
    input: "请把“主要矛盾需要重新排序”翻译成英文。",
    expectedDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: "simple-negative-disagreement",
    domain: "simple-negative",
    operatorId: null,
    input: "我和同事对按钮颜色意见不同，请把两种颜色记录成待选项。",
    expectedDimensions: Object.freeze([]),
  }),
]);

const contradictionStagePilot = createCognitiveLensPilot({
  label: "矛盾与阶段分析",
  sourcePath: CONTRADICTION_STAGE_SOURCE_PATH,
  skillId: "xingzhi-contradiction-stage-analysis",
  operatorId: "contradiction-stage-analysis",
  operatorMode: "contradiction-stage",
  cases: CONTRADICTION_STAGE_PILOT_CASES,
  messageIdPrefix: "contradiction-stage-pilot",
});

module.exports = {
  CONTRADICTION_STAGE_DIMENSIONS,
  CONTRADICTION_STAGE_PILOT_CASES,
  CONTRADICTION_STAGE_SOURCE_PATH,
  contradictionStagePilotStatus: contradictionStagePilot.status,
  runContradictionStagePilotCase: contradictionStagePilot.run,
};
