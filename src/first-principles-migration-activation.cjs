"use strict";

const {
  createCognitiveLensMigrationActivator,
  installCompiledArtifacts,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  FIRST_PRINCIPLES_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  FIRST_PRINCIPLES_PROBE_SOURCE_PATH,
} = require("./first-principles-shadow-probe.cjs");

const FIRST_PRINCIPLES_SKILL_ID = "xingzhi-first-principles";
const FIRST_PRINCIPLES_OPERATOR_ID = "first-principles-reconstruction";
const ACTIVATION_SUITE_VERSION = FIRST_PRINCIPLES_MIGRATION_SUITE_VERSION;

const firstPrinciplesActivator = createCognitiveLensMigrationActivator({
  label: "第一性重建",
  sourcePath: FIRST_PRINCIPLES_PROBE_SOURCE_PATH,
  skillId: FIRST_PRINCIPLES_SKILL_ID,
  operatorId: FIRST_PRINCIPLES_OPERATOR_ID,
  operatorMode: "reconstruction",
  positiveText: "请用第一性原理重新设计这个产品方案，并区分事实、假设和约束。",
  negativeText: "请把‘会议改到下午三点’翻译成英文。",
  gateErrorCode: "FIRST_PRINCIPLES_MIGRATION_GATE_FAILED",
});

module.exports = {
  ACTIVATION_SUITE_VERSION,
  FIRST_PRINCIPLES_SKILL_ID,
  activateFirstPrinciplesMigration: firstPrinciplesActivator.activate,
  installCompiledArtifacts,
};
