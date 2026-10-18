"use strict";

const {
  createCognitiveLensMigrationActivator,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  REVERSAL_FAILURE_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  REVERSAL_FAILURE_SOURCE_PATH,
} = require("./reversal-failure-shadow-pilot.cjs");

const REVERSAL_FAILURE_SKILL_ID = "xingzhi-reversal-failure-conditions";
const REVERSAL_FAILURE_OPERATOR_IDS = Object.freeze(["premortem", "backcasting"]);
const REVERSAL_FAILURE_ACTIVATION_SUITE_VERSION = REVERSAL_FAILURE_MIGRATION_SUITE_VERSION;

const reversalFailureActivator = createCognitiveLensMigrationActivator({
  label: "反演与失败条件",
  sourcePath: REVERSAL_FAILURE_SOURCE_PATH,
  skillId: REVERSAL_FAILURE_SKILL_ID,
  operatorBindings: [
    { id: "premortem", mode: "failure-premortem" },
    { id: "backcasting", mode: "goal-backcasting" },
  ],
  routingChecks: [
    {
      text: "请做失败预演，假设这项上线方案最终失败，检查失效机制、早期预警和停止条件。",
      operatorIds: ["premortem"],
    },
    {
      text: "请做目标倒推，从终局验收反推必要条件、依赖、阶段证据和最晚决策点。",
      operatorIds: ["backcasting"],
    },
    {
      text: "请结合失败预演与目标倒推，先倒推关键路径，再检查路径如何失效并避免重复发现。",
      operatorIds: ["premortem", "backcasting"],
    },
  ],
  negativeText: "请把‘失败预演不能证明失败概率’翻译成英文。",
  gateErrorCode: "REVERSAL_FAILURE_MIGRATION_GATE_FAILED",
});

module.exports = {
  REVERSAL_FAILURE_ACTIVATION_SUITE_VERSION,
  REVERSAL_FAILURE_OPERATOR_IDS,
  REVERSAL_FAILURE_SKILL_ID,
  activateReversalFailureMigration: reversalFailureActivator.activate,
};
