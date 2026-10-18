"use strict";

const {
  createCognitiveLensMigrationActivator,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  INCENTIVE_STRUCTURE_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  INCENTIVE_STRUCTURE_SOURCE_PATH,
} = require("./incentive-structure-shadow-pilot.cjs");

const INCENTIVE_STRUCTURE_SKILL_ID = "xingzhi-incentive-structure-analysis";
const INCENTIVE_STRUCTURE_OPERATOR_ID = "incentive-structure-analysis";
const INCENTIVE_STRUCTURE_ACTIVATION_SUITE_VERSION = INCENTIVE_STRUCTURE_MIGRATION_SUITE_VERSION;

const incentiveStructureActivator = createCognitiveLensMigrationActivator({
  label: "利益与激励分析",
  sourcePath: INCENTIVE_STRUCTURE_SOURCE_PATH,
  skillId: INCENTIVE_STRUCTURE_SKILL_ID,
  operatorId: INCENTIVE_STRUCTURE_OPERATOR_ID,
  operatorMode: "incentive-structure",
  positiveText: "请用利益与激励分析比较平台、商家和用户的成本收益、控制权、可选行动和可能回应。",
  negativeText: "请把‘平台调整了奖励规则’翻译成英文。",
  gateErrorCode: "INCENTIVE_STRUCTURE_MIGRATION_GATE_FAILED",
});

module.exports = {
  INCENTIVE_STRUCTURE_ACTIVATION_SUITE_VERSION,
  INCENTIVE_STRUCTURE_OPERATOR_ID,
  INCENTIVE_STRUCTURE_SKILL_ID,
  activateIncentiveStructureMigration: incentiveStructureActivator.activate,
};
