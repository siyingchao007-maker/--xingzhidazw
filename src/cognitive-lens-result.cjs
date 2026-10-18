"use strict";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_FINDINGS = 12;
const MAX_SUMMARY_CHARS = 800;
const MAX_EXPLANATION_CHARS = 1_200;
const MAX_REFERENCE_CHARS = 600;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TOPIC_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]{1,79}$/u;
const EPISTEMIC_STATUSES = Object.freeze([
  "fact",
  "user-statement",
  "inference",
  "hypothesis",
  "value-judgment",
  "unknown",
]);
const CLAIM_KINDS = Object.freeze(["general", "other-person-motive"]);
const STANCES = Object.freeze(["supports", "opposes", "neutral"]);
const TIME_HORIZONS = Object.freeze(["current", "near-term", "long-term", "unspecified"]);
const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);
const EVIDENCE_SOURCE_TYPES = Object.freeze(["current-user", "personal-knowledge", "document", "web"]);
const MATERIALITY_LEVELS = Object.freeze(["low", "medium", "high"]);
const HIDDEN_REASONING_KEYS = new Set([
  "analysis",
  "analysistrace",
  "chainofthought",
  "hiddenreasoning",
  "reasoning",
  "reasoningcontent",
  "scratchpad",
  "thoughts",
]);
const HIDDEN_REASONING_MARKER = /<\/?(?:think|analysis|reasoning)>|\[(?:chain of thought|hidden reasoning)\]/iu;
const OTHER_PERSON_MOTIVE_PATTERN = /(?:对方|他人|别人|老板|客户|同事|伴侣|家人|朋友|领导|下属|合作方|竞争对手|他们|她们|他(?!其|人)|她).{0,24}(?:动机|意图|目的|故意|刻意|存心|想要|不想|为了)/u;

const TOP_LEVEL_FIELDS = Object.freeze([
  "skillId", "skillVersion", "contentHash", "applicable", "findings",
  "decisionImpact", "calibration", "novelty", "utility",
]);
const FINDING_FIELDS = Object.freeze([
  "summary", "topicKey", "stance", "timeHorizon", "claimKind", "epistemicStatus", "evidenceRefs", "assumptions",
  "confidence", "confidenceBasis",
]);
const EVIDENCE_FIELDS = Object.freeze(["sourceType", "sourceId", "quote"]);
const DECISION_FIELDS = Object.freeze([
  "changesConclusion", "changesPriority", "changesAction", "implication",
]);
const CALIBRATION_FIELDS = Object.freeze(["disconfirmingEvidence", "nextValidation"]);
const NOVELTY_FIELDS = Object.freeze([
  "newEvidenceUsed", "newEvidenceInterpretation", "newMechanism", "newAssumption",
  "newCounterevidence", "newRisk", "newOption", "changesDecision",
]);
const UTILITY_FIELDS = Object.freeze([
  "relevantToUserQuestion", "evidenceBounded", "actionableOrDecisionRelevant",
  "duplicatesExistingFinding", "materiality", "includeInSynthesis",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function characterLength(value) {
  return Array.from(String(value || "")).length;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value;
}

function assertExactFields(value, fields, label) {
  const allowed = new Set(fields);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label}包含不允许的字段：${extra.join("、")}`);
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label}缺少字段：${missing.join("、")}`);
}

function normalizedKey(value) {
  return String(value || "").replaceAll(/[-_\s]/gu, "").toLocaleLowerCase("en-US");
}

function assertNoHiddenReasoning(value, path = "lensResult") {
  if (typeof value === "string") {
    if (HIDDEN_REASONING_MARKER.test(value)) throw new Error(`${path}包含隐藏推理标记`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (HIDDEN_REASONING_KEYS.has(normalizedKey(key))) throw new Error(`${path}.${key} 是不允许保存的隐藏推理字段`);
    assertNoHiddenReasoning(nested, `${path}.${key}`);
  }
}

function text(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label}不能为空`);
  if (characterLength(normalized) > maximum) throw new Error(`${label}过长，超过安全上限`);
  if (HIDDEN_REASONING_MARKER.test(normalized)) throw new Error(`${label}包含隐藏推理标记`);
  return normalized;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label}无效：${String(value || "未提供")}`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label}必须是布尔值`);
  return value;
}

function textArray(value, label, maximumItems, maximumCharacters = MAX_REFERENCE_CHARS) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label}格式或数量上限无效`);
  return value.map((item, index) => text(item, `${label}[${index}]`, maximumCharacters));
}

function parseJsonObject(value) {
  if (typeof value === "string") {
    if (byteLength(value) > MAX_RESULT_BYTES) throw new Error("认知透镜结果超过安全上限");
    const normalized = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    let parsed;
    try {
      parsed = JSON.parse(normalized);
    } catch {
      throw new Error("认知透镜结果不是有效 JSON");
    }
    return record(parsed, "认知透镜结果");
  }
  const parsed = record(value, "认知透镜结果");
  let serialized;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    throw new Error("认知透镜结果无法序列化");
  }
  if (byteLength(serialized) > MAX_RESULT_BYTES) throw new Error("认知透镜结果超过安全上限");
  return parsed;
}

function unwrapResult(value) {
  const parsed = parseJsonObject(value);
  if (!Object.hasOwn(parsed, "lensResult")) return parsed;
  assertExactFields(parsed, ["lensResult"], "认知透镜结果包装");
  return record(parsed.lensResult, "lensResult");
}

function parseEvidenceRef(value, index, { currentUserMessageId, currentUserText }) {
  const item = record(value, `evidenceRefs[${index}]`);
  assertExactFields(item, EVIDENCE_FIELDS, `evidenceRefs[${index}]`);
  const sourceType = enumValue(item.sourceType, EVIDENCE_SOURCE_TYPES, "证据来源类型");
  const sourceId = text(item.sourceId, "证据来源编号", MAX_REFERENCE_CHARS);
  const quote = text(item.quote, "证据摘录", MAX_EXPLANATION_CHARS, { allowEmpty: true });
  if (sourceType === "current-user") {
    if (!currentUserMessageId || sourceId !== currentUserMessageId) {
      throw new Error("current-user 证据必须指向当前用户消息");
    }
    if (!quote) throw new Error("当前用户消息证据必须保留明确原话摘录");
    if (typeof currentUserText !== "string" || !currentUserText.includes(quote)) {
      throw new Error("current-user 证据摘录必须逐字来自当前用户原话");
    }
  }
  if (sourceType === "web") {
    let url;
    try {
      url = new URL(sourceId);
    } catch {
      throw new Error("网页证据来源编号必须是有效 URL");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("网页证据只允许 HTTP 或 HTTPS URL");
  }
  return { sourceType, sourceId, quote };
}

function parseFinding(value, index, context) {
  const item = record(value, `findings[${index}]`);
  assertExactFields(item, FINDING_FIELDS, `findings[${index}]`);
  const normalized = {
    summary: text(item.summary, "发现摘要", MAX_SUMMARY_CHARS),
    topicKey: text(item.topicKey, "议题键", 80),
    stance: enumValue(item.stance, STANCES, "立场"),
    timeHorizon: enumValue(item.timeHorizon, TIME_HORIZONS, "时间尺度"),
    claimKind: enumValue(item.claimKind, CLAIM_KINDS, "主张类型"),
    epistemicStatus: enumValue(item.epistemicStatus, EPISTEMIC_STATUSES, "认识状态"),
    evidenceRefs: (() => {
      if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 12) {
        throw new Error("证据引用格式或数量上限无效");
      }
      return item.evidenceRefs.map((ref, refIndex) => parseEvidenceRef(ref, refIndex, context));
    })(),
    assumptions: textArray(item.assumptions, "假设", 8, 500),
    confidence: enumValue(item.confidence, CONFIDENCE_LEVELS, "置信度"),
    confidenceBasis: text(item.confidenceBasis, "置信度依据", MAX_EXPLANATION_CHARS),
  };
  if (!TOPIC_KEY_PATTERN.test(normalized.topicKey)) {
    throw new Error("议题键必须是稳定的小写字母、数字、点或连字符标识");
  }
  if ((normalized.claimKind === "other-person-motive" || OTHER_PERSON_MOTIVE_PATTERN.test(normalized.summary))
    && !["inference", "hypothesis"].includes(normalized.epistemicStatus)) {
    throw new Error("他人动机主张只能标记为推断或假设");
  }
  if (normalized.epistemicStatus === "fact") {
    if (normalized.assumptions.length) throw new Error("事实不能包含未验证假设");
    if (!normalized.evidenceRefs.length) throw new Error("事实必须提供可追溯来源");
    if (normalized.evidenceRefs.every((ref) => ref.sourceType === "current-user")) {
      throw new Error("只来自用户原话的主张必须标记为 user-statement，不能标记为事实");
    }
  }
  if (normalized.epistemicStatus === "user-statement"
    && !normalized.evidenceRefs.some((ref) => ref.sourceType === "current-user")) {
    throw new Error("user-statement 必须引用当前用户消息");
  }
  if (["hypothesis", "value-judgment"].includes(normalized.epistemicStatus)
    && !normalized.assumptions.length) {
    throw new Error(`${normalized.epistemicStatus} 必须明确假设或价值前提`);
  }
  return normalized;
}

function parseDecisionImpact(value) {
  const item = record(value, "decisionImpact");
  assertExactFields(item, DECISION_FIELDS, "decisionImpact");
  const normalized = {
    changesConclusion: booleanValue(item.changesConclusion, "changesConclusion"),
    changesPriority: booleanValue(item.changesPriority, "changesPriority"),
    changesAction: booleanValue(item.changesAction, "changesAction"),
    implication: text(item.implication, "决策影响", MAX_EXPLANATION_CHARS, { allowEmpty: true }),
  };
  if ((normalized.changesConclusion || normalized.changesPriority || normalized.changesAction)
    && !normalized.implication) throw new Error("声明改变结论、优先级或行动时必须说明决策影响");
  return normalized;
}

function parseCalibration(value) {
  const item = record(value, "calibration");
  assertExactFields(item, CALIBRATION_FIELDS, "calibration");
  return {
    disconfirmingEvidence: textArray(item.disconfirmingEvidence, "反证条件", 8, MAX_EXPLANATION_CHARS),
    nextValidation: text(item.nextValidation, "下一步验证", MAX_EXPLANATION_CHARS, { allowEmpty: true }),
  };
}

function booleanRecord(value, fields, label) {
  const item = record(value, label);
  assertExactFields(item, fields, label);
  return Object.fromEntries(fields.map((field) => [field, booleanValue(item[field], `${label}.${field}`)]));
}

function parseUtility(value) {
  const item = record(value, "utility");
  assertExactFields(item, UTILITY_FIELDS, "utility");
  return {
    relevantToUserQuestion: booleanValue(item.relevantToUserQuestion, "utility.relevantToUserQuestion"),
    evidenceBounded: booleanValue(item.evidenceBounded, "utility.evidenceBounded"),
    actionableOrDecisionRelevant: booleanValue(
      item.actionableOrDecisionRelevant,
      "utility.actionableOrDecisionRelevant",
    ),
    duplicatesExistingFinding: booleanValue(item.duplicatesExistingFinding, "utility.duplicatesExistingFinding"),
    materiality: enumValue(item.materiality, MATERIALITY_LEVELS, "重要性"),
    includeInSynthesis: booleanValue(item.includeInSynthesis, "utility.includeInSynthesis"),
  };
}

function assertIdentity(actual, expected, label) {
  if (expected !== undefined && expected !== null && actual !== expected) {
    throw new Error(`${label}与本轮固定 Skill 身份不一致`);
  }
}

function assertNotApplicableContract(result) {
  if (result.applicable) return;
  if (result.findings.length) throw new Error("不适用的认知透镜不能返回发现");
  if (result.decisionImpact.changesConclusion || result.decisionImpact.changesPriority
    || result.decisionImpact.changesAction || result.decisionImpact.implication) {
    throw new Error("不适用的认知透镜不能声明决策影响");
  }
  if (Object.values(result.novelty).some(Boolean)) throw new Error("不适用的认知透镜不能声明信息增量");
  if (result.utility.includeInSynthesis) throw new Error("不适用的认知透镜不能进入综合");
}

function parseCognitiveLensResult(value, {
  expectedSkillId,
  expectedSkillVersion,
  expectedContentHash,
  currentUserMessageId = null,
  currentUserText = null,
} = {}) {
  const raw = unwrapResult(value);
  assertNoHiddenReasoning(raw);
  assertExactFields(raw, TOP_LEVEL_FIELDS, "lensResult");
  const skillId = text(raw.skillId, "Skill 编号", 64);
  if (!SKILL_ID_PATTERN.test(skillId)) throw new Error("Skill 编号格式无效");
  const skillVersion = text(raw.skillVersion, "Skill 版本", 64);
  if (!VERSION_PATTERN.test(skillVersion)) throw new Error("Skill 版本格式无效");
  const contentHash = text(raw.contentHash, "Skill 内容哈希", 80);
  if (!HASH_PATTERN.test(contentHash)) throw new Error("Skill 内容哈希格式无效");
  if (!expectedSkillId || !expectedSkillVersion || !expectedContentHash) {
    throw new Error("认知透镜结果缺少本轮固定 Skill 身份");
  }
  assertIdentity(skillId, expectedSkillId, "Skill 编号");
  assertIdentity(skillVersion, expectedSkillVersion, "Skill 版本");
  assertIdentity(contentHash, expectedContentHash, "Skill 哈希");
  const applicable = booleanValue(raw.applicable, "applicable");
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_FINDINGS) {
    throw new Error("findings 格式或数量上限无效");
  }
  if (applicable && !raw.findings.length) throw new Error("适用的认知透镜至少需要一项发现");
  const normalized = {
    skillId,
    skillVersion,
    contentHash,
    applicable,
    findings: raw.findings.map((item, index) => parseFinding(item, index, {
      currentUserMessageId,
      currentUserText,
    })),
    decisionImpact: parseDecisionImpact(raw.decisionImpact),
    calibration: parseCalibration(raw.calibration),
    novelty: booleanRecord(raw.novelty, NOVELTY_FIELDS, "novelty"),
    utility: parseUtility(raw.utility),
  };
  assertNotApplicableContract(normalized);
  return deepFreeze(normalized);
}

function rawSkillId(value) {
  try {
    const raw = unwrapResult(value);
    return typeof raw?.skillId === "string" ? raw.skillId.trim().slice(0, 128) : null;
  } catch {
    return null;
  }
}

function isolateCognitiveLensResults(values, {
  expectedBySkillId = {},
  currentUserMessageId = null,
  currentUserText = null,
} = {}) {
  if (!Array.isArray(values) || values.length > 16) throw new Error("认知透镜结果集合格式或数量上限无效");
  const accepted = [];
  const rejected = [];
  for (const [index, value] of values.entries()) {
    const skillId = rawSkillId(value);
    try {
      const expected = skillId && expectedBySkillId && typeof expectedBySkillId === "object"
        && Object.hasOwn(expectedBySkillId, skillId) ? expectedBySkillId[skillId] : null;
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
        throw new Error("结果没有匹配本轮固定的认知透镜身份");
      }
      accepted.push(parseCognitiveLensResult(value, {
        expectedSkillId: skillId,
        expectedSkillVersion: expected.version,
        expectedContentHash: expected.contentHash,
        currentUserMessageId,
        currentUserText,
      }));
    } catch (error) {
      rejected.push(Object.freeze({
        index,
        skillId,
        reason: String(error?.message || error).slice(0, 600),
      }));
    }
  }
  return deepFreeze({ accepted, rejected });
}

const evidenceRefSchema = {
  type: "object",
  additionalProperties: false,
  required: [...EVIDENCE_FIELDS],
  properties: {
    sourceType: { type: "string", enum: [...EVIDENCE_SOURCE_TYPES] },
    sourceId: { type: "string", minLength: 1, maxLength: MAX_REFERENCE_CHARS },
    quote: { type: "string", maxLength: MAX_EXPLANATION_CHARS },
  },
};

const COGNITIVE_LENS_RESULT_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [...TOP_LEVEL_FIELDS],
  properties: {
    skillId: { type: "string", pattern: SKILL_ID_PATTERN.source },
    skillVersion: { type: "string", pattern: VERSION_PATTERN.source },
    contentHash: { type: "string", pattern: HASH_PATTERN.source },
    applicable: { type: "boolean" },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...FINDING_FIELDS],
        properties: {
          summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_CHARS },
          topicKey: { type: "string", pattern: TOPIC_KEY_PATTERN.source },
          stance: { type: "string", enum: [...STANCES] },
          timeHorizon: { type: "string", enum: [...TIME_HORIZONS] },
          claimKind: { type: "string", enum: [...CLAIM_KINDS] },
          epistemicStatus: { type: "string", enum: [...EPISTEMIC_STATUSES] },
          evidenceRefs: { type: "array", maxItems: 12, items: evidenceRefSchema },
          assumptions: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 } },
          confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
          confidenceBasis: { type: "string", minLength: 1, maxLength: MAX_EXPLANATION_CHARS },
        },
      },
    },
    decisionImpact: {
      type: "object",
      additionalProperties: false,
      required: [...DECISION_FIELDS],
      properties: {
        changesConclusion: { type: "boolean" },
        changesPriority: { type: "boolean" },
        changesAction: { type: "boolean" },
        implication: { type: "string", maxLength: MAX_EXPLANATION_CHARS },
      },
    },
    calibration: {
      type: "object",
      additionalProperties: false,
      required: [...CALIBRATION_FIELDS],
      properties: {
        disconfirmingEvidence: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: MAX_EXPLANATION_CHARS },
        },
        nextValidation: { type: "string", maxLength: MAX_EXPLANATION_CHARS },
      },
    },
    novelty: {
      type: "object",
      additionalProperties: false,
      required: [...NOVELTY_FIELDS],
      properties: Object.fromEntries(NOVELTY_FIELDS.map((field) => [field, { type: "boolean" }])),
    },
    utility: {
      type: "object",
      additionalProperties: false,
      required: [...UTILITY_FIELDS],
      properties: {
        relevantToUserQuestion: { type: "boolean" },
        evidenceBounded: { type: "boolean" },
        actionableOrDecisionRelevant: { type: "boolean" },
        duplicatesExistingFinding: { type: "boolean" },
        materiality: { type: "string", enum: [...MATERIALITY_LEVELS] },
        includeInSynthesis: { type: "boolean" },
      },
    },
  },
});

module.exports = {
  CLAIM_KINDS,
  COGNITIVE_LENS_RESULT_SCHEMA,
  CONFIDENCE_LEVELS,
  EPISTEMIC_STATUSES,
  EVIDENCE_SOURCE_TYPES,
  MATERIALITY_LEVELS,
  STANCES,
  TIME_HORIZONS,
  isolateCognitiveLensResults,
  parseCognitiveLensResult,
};
