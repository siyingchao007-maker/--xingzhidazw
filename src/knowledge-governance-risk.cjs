"use strict";

const PROCESSING_LEVELS = new Set(["L0", "L1", "L2", "L3"]);
const DETERMINISTIC_CODES = new Set([
  "legacy-schema",
  "missing-index-file",
  "index-unlisted",
]);
const SYSTEM_FAILED_CODES = new Set([
  "damaged-index-markers",
  "malformed-knowledge-note",
]);
const AGENT_AUTO_CODES = new Set(["semantic-structure-incomplete"]);
const AGENT_CANDIDATE_CODES = new Set([
  "unstructured-knowledge-note",
  "knowledge-split-candidate",
  "broken-related-link",
  "expired-active",
  "status-inconsistent",
]);
const HUMAN_REVIEW_CODES = new Set([
  "missing-source-provenance",
  "duplicate-knowledge-id",
  "invalid-knowledge-id",
  "unsupported-knowledge-type",
  "knowledge-root-mismatch",
  "duplicate-agent-definition",
  "duplicate-skill-definition",
  "exact-duplicate",
  "near-duplicate",
  "same-key-version",
  "cross-type-copy",
]);
const SENSITIVE_PATTERNS = Object.freeze([
  /(?:身份证|护照|银行卡|账号密码|验证码|访问令牌|api[ _-]?key|secret)/iu,
  /(?:诊断|处方|药物剂量|自杀|自残|人身安全)/iu,
  /(?:合同义务|法律责任|违法|报税|纳税申报)/iu,
  /(?:投资决策|借贷|付款承诺|资产处置|重大预算)/iu,
]);

function text(value, maximum = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function base(level, mode, status, reason, question) {
  return {
    processingLevel: level,
    handlingMode: mode,
    agentStatus: status,
    riskReasons: [reason],
    decisionQuestion: question,
  };
}

function containsSensitiveMaterial(input) {
  const body = [input?.title, input?.message, input?.content]
    .map((value) => text(value, 24_000))
    .filter(Boolean)
    .join("\n");
  return body && SENSITIVE_PATTERNS.some((pattern) => pattern.test(body));
}

function classifyKnowledgeGovernanceRisk(input = {}) {
  const code = text(input.code || input.kind || input.sourceId, 120).toLowerCase();
  const path = text(input.path || input.paths?.[0], 1_024).replaceAll("\\", "/");

  if (SYSTEM_FAILED_CODES.has(code)) {
    return base(
      "L0",
      "system-failed",
      "failed",
      "文件结构或维护标记损坏，Agent 无法在可靠输入上继续加工",
      "请先修复结构或维护标记，再重新扫描；这不是需要用户判断知识内容。",
    );
  }
  if (code === "duplicate-agent-definition" || code === "duplicate-skill-definition" || path.startsWith("10_智能体与技能/")) {
    return base(
      "L3",
      "human-review",
      "needs-confirmation",
      "该变更会影响 Agent、Skill 或后续自动路由，属于控制面变更",
      "需要确认保留哪个能力定义，以及是否允许改变后续任务行为。",
    );
  }
  if (HUMAN_REVIEW_CODES.has(code)) {
    const reason = code === "missing-source-provenance"
      ? "缺少可回查来源，系统不能把推断升级为正式事实"
      : "该问题会改变权威版本、分类、标识或未来检索结果";
    return base(
      "L3",
      "human-review",
      "needs-confirmation",
      reason,
      "Agent 会先整理证据与选项，但最终选择必须由用户确认。",
    );
  }
  if (DETERMINISTIC_CODES.has(code) || input?.repair?.mode === "automatic") {
    return base(
      "L0",
      "deterministic",
      "ready",
      "该问题有确定性本地规则、预览和可撤销事务，不需要模型选边",
      "可先查看修复预览，再按现有安全事务提交。",
    );
  }
  if (AGENT_AUTO_CODES.has(code)) {
    if (containsSensitiveMaterial(input)) {
      return base(
        "L3",
        "human-review",
        "needs-confirmation",
        "原文包含敏感或高后果内容，派生语义需要避免形成未经授权的诊断或承诺",
        "Agent 先整理原文证据，用户确认后才能进入正式知识。",
      );
    }
    return base(
      "L1",
      "agent-auto",
      "queued",
      "只补充可回查的派生语义，不改变原文和权威关系",
      "无需逐条人工整理；Agent 将先生成摘要、知识点、用途和标签。",
    );
  }
  if (AGENT_CANDIDATE_CODES.has(code)) {
    if (containsSensitiveMaterial(input)) {
      return base(
        "L3",
        "human-review",
        "needs-confirmation",
        "内容含敏感或高后果信号，不能自动决定其知识地位",
        "Agent 先给出分类和证据，用户决定是否形成正式知识。",
      );
    }
    return base(
      "L2",
      "agent-candidate",
      "queued",
      "Agent 可以形成分类或关联候选，但不能改变原文、权威版本或生命周期",
      "无需从原文开始人工整理；按需查看 Agent 形成的候选。",
    );
  }
  return base(
    "L3",
    "human-review",
    "needs-confirmation",
    "当前问题没有命中受信任的低风险处理规则",
    "Agent 先整理证据；在规则补充前由用户确认处理方式。",
  );
}

function overrideAgentRiskDecision(analysis, trustedDecision) {
  const trusted = trustedDecision && PROCESSING_LEVELS.has(trustedDecision.processingLevel)
    ? trustedDecision : classifyKnowledgeGovernanceRisk({});
  const modelSuggestedProcessingLevel = PROCESSING_LEVELS.has(analysis?.processingLevel)
    ? analysis.processingLevel : null;
  return {
    ...(analysis && typeof analysis === "object" ? analysis : {}),
    modelSuggestedProcessingLevel,
    processingLevel: trusted.processingLevel,
    handlingMode: trusted.handlingMode,
    agentStatus: trusted.agentStatus,
    riskReasons: [...trusted.riskReasons],
    decisionQuestion: trusted.decisionQuestion || analysis?.decisionQuestion || "",
  };
}

module.exports = {
  PROCESSING_LEVELS,
  classifyKnowledgeGovernanceRisk,
  overrideAgentRiskDecision,
};

