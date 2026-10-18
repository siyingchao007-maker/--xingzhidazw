"use strict";

const { realProgressMemoryGuidance } = require("./real-progress-policy.cjs");

const GROWTH_CONTRACT_VERSION = "2.0.0";
const GROWTH_EVENT_LABELS = Object.freeze({
  goal: "目标选择", judgment: "判断修订", action: "行动尝试", result: "结果记录",
  feedback: "反馈", capability: "能力证据", learning: "认知更新", milestone: "阶段里程碑",
});
const GROWTH_EVENT_TYPES = new Set(Object.keys(GROWTH_EVENT_LABELS));
const GROWTH_EVENT_FIELDS = Object.freeze(["title", "summary", "eventType", "confidence", "evidenceQuote", "sourceMessageId"]);
function canonicalGrowthType(value) { return value === "decision" ? "judgment" : value; }
function growthContractPrompt() {
  return [
    `成长数据规范版本：${GROWTH_CONTRACT_VERSION}。`,
    realProgressMemoryGuidance(),
    `growthEvents 每项必须且只能包含 ${GROWTH_EVENT_FIELDS.join("、")}。最多 10 项。`,
    `eventType 只能是 ${[...GROWTH_EVENT_TYPES].join("、")}；判断和决策统一使用 judgment。`,
    "title 为简短标题，summary 说明发生的变化及可证实范围；confidence 为 0 到 1 的策略参考值，不是测得的正确率。",
    "evidenceQuote 必须逐字来自本轮 userText，sourceMessageId 必须等于本轮可信用户消息编号。不得把附件或助手输出当成用户经历。",
    "目标选择、计划、尝试、执行、结果分别记录；收到建议、提出任务、普通提问不证明成长。能力证据仅说明实际观察的场景，不推断长期能力。",
    "没有可验证变化时 growthEvents 返回 []，在 ignored 说明无新变化、等待结果或证据不足；不得为了更新而制造事件。",
  ].join("\n");
}
module.exports = { GROWTH_CONTRACT_VERSION, GROWTH_EVENT_LABELS, GROWTH_EVENT_TYPES, GROWTH_EVENT_FIELDS, canonicalGrowthType, growthContractPrompt };
