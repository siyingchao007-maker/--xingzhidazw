"use strict";

const {
  createCognitiveLensMigrationActivator,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  CONTRADICTION_STAGE_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  CONTRADICTION_STAGE_SOURCE_PATH,
} = require("./contradiction-stage-shadow-pilot.cjs");

const CONTRADICTION_STAGE_SKILL_ID = "xingzhi-contradiction-stage-analysis";
const CONTRADICTION_STAGE_OPERATOR_ID = "contradiction-stage-analysis";
const CONTRADICTION_STAGE_ACTIVATION_SUITE_VERSION = CONTRADICTION_STAGE_MIGRATION_SUITE_VERSION;

const contradictionStageActivator = createCognitiveLensMigrationActivator({
  label: "矛盾与阶段分析",
  sourcePath: CONTRADICTION_STAGE_SOURCE_PATH,
  skillId: CONTRADICTION_STAGE_SKILL_ID,
  operatorId: CONTRADICTION_STAGE_OPERATOR_ID,
  operatorMode: "contradiction-stage",
  positiveText: "请用矛盾与阶段分析检查产品验证与扩张之间的相互制约，并判断当前阶段和主要瓶颈。",
  negativeText: "请把‘主要矛盾需要重新排序’翻译成英文。",
  gateErrorCode: "CONTRADICTION_STAGE_MIGRATION_GATE_FAILED",
});

module.exports = {
  CONTRADICTION_STAGE_ACTIVATION_SUITE_VERSION,
  CONTRADICTION_STAGE_OPERATOR_ID,
  CONTRADICTION_STAGE_SKILL_ID,
  activateContradictionStageMigration: contradictionStageActivator.activate,
};
