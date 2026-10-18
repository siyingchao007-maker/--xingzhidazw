"use strict";

const {
  createCognitiveLensMigrationActivator,
} = require("./cognitive-lens-migration-activation.cjs");
const {
  CAUSAL_EVIDENCE_MIGRATION_SUITE_VERSION,
} = require("./cognitive-lens-migration.cjs");
const {
  CAUSAL_EVIDENCE_SOURCE_PATH,
} = require("./causal-evidence-shadow-pilot.cjs");

const CAUSAL_EVIDENCE_SKILL_ID = "xingzhi-causal-evidence-audit";
const CAUSAL_EVIDENCE_OPERATOR_IDS = Object.freeze(["causal-analysis", "critical-audit"]);
const CAUSAL_EVIDENCE_ACTIVATION_SUITE_VERSION = CAUSAL_EVIDENCE_MIGRATION_SUITE_VERSION;

const causalEvidenceActivator = createCognitiveLensMigrationActivator({
  label: "因果与证据检验",
  sourcePath: CAUSAL_EVIDENCE_SOURCE_PATH,
  skillId: CAUSAL_EVIDENCE_SKILL_ID,
  operatorBindings: [
    { id: "causal-analysis", mode: "causal-explanation" },
    { id: "critical-audit", mode: "evidence-audit" },
  ],
  routingChecks: [
    {
      text: "请做因果分析，检查这个观察结果能否说明措施导致结果变化，并给出反事实验证。",
      operatorIds: ["causal-analysis"],
    },
    {
      text: "请做证据核验，检查材料的来源独立性、测量质量、偏差和适用边界。",
      operatorIds: ["critical-audit"],
    },
    {
      text: "请同时使用因果推断与证据审查，共享一份主张和证据清单，避免重复发现。",
      operatorIds: ["causal-analysis", "critical-audit"],
    },
  ],
  negativeText: "请把‘相关性不等于因果关系’翻译成英文。",
  gateErrorCode: "CAUSAL_EVIDENCE_MIGRATION_GATE_FAILED",
});

module.exports = {
  CAUSAL_EVIDENCE_ACTIVATION_SUITE_VERSION,
  CAUSAL_EVIDENCE_OPERATOR_IDS,
  CAUSAL_EVIDENCE_SKILL_ID,
  activateCausalEvidenceMigration: causalEvidenceActivator.activate,
};
