"use strict";

const {
  createCognitiveLensMigrationActivator,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  SYSTEM_FEEDBACK_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  SYSTEM_FEEDBACK_SOURCE_PATH,
} = require("./system-feedback-shadow-pilot.cjs");

const SYSTEM_FEEDBACK_SKILL_ID = "xingzhi-system-feedback-analysis";
const SYSTEM_FEEDBACK_OPERATOR_ID = "system-dynamics";
const SYSTEM_FEEDBACK_ACTIVATION_SUITE_VERSION = SYSTEM_FEEDBACK_MIGRATION_SUITE_VERSION;

const systemFeedbackActivator = createCognitiveLensMigrationActivator({
  label: "系统与反馈分析",
  sourcePath: SYSTEM_FEEDBACK_SOURCE_PATH,
  skillId: SYSTEM_FEEDBACK_SKILL_ID,
  operatorId: SYSTEM_FEEDBACK_OPERATOR_ID,
  operatorMode: "system-feedback",
  positiveText: "请用系统动力分析检查这个反复积压问题，并识别反馈回路、时间延迟和杠杆点。",
  negativeText: "请把‘系统将在下午三点维护’翻译成英文。",
  gateErrorCode: "SYSTEM_FEEDBACK_MIGRATION_GATE_FAILED",
});

module.exports = {
  SYSTEM_FEEDBACK_ACTIVATION_SUITE_VERSION,
  SYSTEM_FEEDBACK_OPERATOR_ID,
  SYSTEM_FEEDBACK_SKILL_ID,
  activateSystemFeedbackMigration: systemFeedbackActivator.activate,
};
