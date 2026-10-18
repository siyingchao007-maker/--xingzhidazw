"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { JUDGMENT_KERNEL_VERSION, validateDecisionCandidate } = require("./decision-record-schema.cjs");
const { adaptLensFindings } = require("./decision-lens-adapter.cjs");

const CANDIDATE_ENVELOPE_VERSION = 1;
const EPISTEMIC = new Set(["fact", "user-statement", "inference", "hypothesis", "value-judgment", "unknown"]);
const RELATIONS = new Set(["support", "oppose", "context"]);
const EVIDENCE_STATUSES = new Set(["retrieved", "used", "cited"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, maximum = 4000) { return String(value || "").replace(/\0/gu, "").trim().slice(0, maximum); }
function unique(values) { return [...new Set(values)]; }
function stableId(prefix, parts) {
  return `${prefix}_${createHash("sha256").update(parts.map((item) => text(item)).join("\u001f"), "utf8").digest("hex").slice(0, 20)}`;
}
function runtimeId(prefix) { return `${prefix}_${randomUUID().replace(/-/gu, "").slice(0, 20)}`; }

function extractEnvelopeJson(source) {
  const value = text(source, 200_000);
  const fence = value.match(/```(?:json|xingzhi-decision-candidate)\s*\n([\s\S]*?)\n```/iu);
  const candidate = fence ? fence[1] : value;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回判断候选 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}包含未允许字段：${key}`);
}

function parseModelCandidateEnvelope(source, context = {}) {
  const raw = typeof source === "string" ? extractEnvelopeJson(source) : clone(source);
  assertExactKeys(raw, new Set(["candidateEnvelopeVersion", "question", "timeHorizon", "scope", "options", "findings", "recommendation", "gates"]), "候选信封");
  if (raw.candidateEnvelopeVersion !== CANDIDATE_ENVELOPE_VERSION) throw new Error("只接受候选信封 v1");
  if (Object.hasOwn(raw, "userDecision") || Object.hasOwn(raw, "confirmedAt")) throw new Error("模型候选不得包含用户确认字段");
  const question = text(raw.question, 1000);
  if (!question) throw new Error("候选信封缺少中性决策问题");
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 12) throw new Error("候选信封必须包含 2 至 12 个选项");
  if (!Array.isArray(raw.findings) || raw.findings.length > 60) throw new Error("候选发现必须是数组，且最多包含 60 条");
  if (!Array.isArray(raw.gates) || raw.gates.length > 20) throw new Error("候选门槛必须是数组，且最多包含 20 条");
  if (!raw.recommendation || typeof raw.recommendation !== "object" || Array.isArray(raw.recommendation)) throw new Error("候选缺少模型建议对象");
  const options = raw.options.map((item, index) => {
    assertExactKeys(item, new Set(["label", "kind", "availability", "outcomes", "risks"]), `选项 ${index + 1}`);
    const label = text(item.label, 240);
    if (!label) throw new Error(`选项 ${index + 1} 缺少名称`);
    const kinds = new Set(["candidate", "default-trajectory", "defer", "experiment"]);
    const availabilityValues = new Set(["available", "unavailable", "unknown"]);
    if (!kinds.has(item.kind)) throw new Error(`选项 ${index + 1} 的类型无效`);
    if (!availabilityValues.has(item.availability)) throw new Error(`选项 ${index + 1} 的可用状态无效`);
    if (item.outcomes !== undefined && !Array.isArray(item.outcomes)) throw new Error(`选项 ${index + 1} 的 outcomes 必须是数组`);
    if (item.risks !== undefined && !Array.isArray(item.risks)) throw new Error(`选项 ${index + 1} 的 risks 必须是数组`);
    if ((item.outcomes || []).length > 20 || (item.risks || []).length > 20) throw new Error(`选项 ${index + 1} 的 outcomes 或 risks 超过 20 项`);
    return { label, kind: item.kind, availability: item.availability, outcomes: (item.outcomes || []).map((v) => text(v, 512)).filter(Boolean), risks: (item.risks || []).map((v) => text(v, 512)).filter(Boolean) };
  });
  const hasSourceMessageIds = Array.isArray(context.sourceMessageIds);
  const sourceMessageIds = new Set(hasSourceMessageIds ? context.sourceMessageIds : []);
  const hasPathSourceMessageIds = Array.isArray(context.pathSourceMessageIds);
  const pathSourceMessageIds = new Set(hasPathSourceMessageIds ? context.pathSourceMessageIds : []);
  const allowedLensIds = new Set(["dialogue-synthesis", ...(Array.isArray(context.allowedLensIds) ? context.allowedLensIds : [])]);
  const hasEvidenceCatalog = Array.isArray(context.evidenceCatalog);
  const evidenceById = new Map((hasEvidenceCatalog ? context.evidenceCatalog : []).map((item) => [item.evidenceId, item]));
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 60).map((item, index) => {
    assertExactKeys(item, new Set(["id", "lensId", "sourceMessageId", "pathStage", "statement", "epistemicStatus", "relation", "optionIndexes", "evidenceRefs", "assumptions"]), `发现 ${index + 1}`);
    const statement = text(item.statement, 2000);
    if (!statement) throw new Error(`发现 ${index + 1} 缺少内容`);
    const lensId = text(item.lensId, 128) || "dialogue-synthesis";
    if (!allowedLensIds.has(lensId)) throw new Error(`发现 ${index + 1} 引用了本轮没有实际调用的透镜：${lensId}`);
    const sourceMessageId = text(item.sourceMessageId, 256);
    if (hasSourceMessageIds && (!sourceMessageId || !sourceMessageIds.has(sourceMessageId))) {
      throw new Error(`发现 ${index + 1} 的来源消息不在当前对话中`);
    }
    if (item.pathStage === undefined) throw new Error(`发现 ${index + 1} 缺少 PATH 阶段标记`);
    const pathStage = item.pathStage;
    if (!new Set(["P", "A", "T", "H", "none"]).has(pathStage)) throw new Error(`发现 ${index + 1} 的 PATH 阶段无效`);
    if (pathStage !== "none" && (!hasPathSourceMessageIds || !sourceMessageId || !pathSourceMessageIds.has(sourceMessageId))) {
      throw new Error(`发现 ${index + 1} 将 PATH 阶段归到了没有实际加载 PATH 运行时的消息`);
    }
    if (item.evidenceRefs !== undefined && !Array.isArray(item.evidenceRefs)) throw new Error(`发现 ${index + 1} 的 evidenceRefs 必须是数组`);
    if ((item.evidenceRefs || []).length > 30) throw new Error(`发现 ${index + 1} 的 evidenceRefs 超过 30 项`);
    const evidenceRefs = (item.evidenceRefs || []).map((ref, refIndex) => {
      assertExactKeys(ref, new Set(["evidenceId", "relation", "status", "locator", "quoteHash", "retrievedAt", "freshness"]), `发现 ${index + 1} 的证据 ${refIndex + 1}`);
      const evidenceId = text(ref.evidenceId, 512);
      if (!evidenceId) throw new Error(`发现 ${index + 1} 的证据 ${refIndex + 1} 缺少 ID`);
      const source = evidenceById.get(evidenceId);
      if (hasEvidenceCatalog && !source) throw new Error(`发现 ${index + 1} 引用了证据目录中不存在的来源：${evidenceId}`);
      if (ref.status === "user-confirmed") throw new Error("模型候选不得写入 user-confirmed 证据状态");
      if (ref.status !== undefined && !EVIDENCE_STATUSES.has(ref.status)) throw new Error(`发现 ${index + 1} 的证据状态无效：${ref.status}`);
      if (ref.relation !== undefined && !RELATIONS.has(ref.relation)) throw new Error(`发现 ${index + 1} 的证据关系无效：${ref.relation}`);
      if (ref.freshness !== undefined && !new Set(["current", "monitoring", "stale", "invalid", "unknown"]).has(ref.freshness)) throw new Error(`发现 ${index + 1} 的证据新鲜度无效：${ref.freshness}`);
      const requestedStatus = ref.status || "retrieved";
      if (["used", "cited"].includes(requestedStatus) && sourceMessageId && source?.sourceMessageId !== sourceMessageId) {
        throw new Error(`发现 ${index + 1} 把证据 ${evidenceId} 归到了未检索该来源的消息`);
      }
      if (requestedStatus === "cited" && source?.cited !== true) {
        throw new Error(`发现 ${index + 1} 将未在可见回答中引用的来源标记为 cited`);
      }
      return {
        evidenceId,
        relation: ref.relation || "context",
        status: requestedStatus,
        locator: source?.locator || null,
        quoteHash: null,
        retrievedAt: source?.retrievedAt || null,
        freshnessAtDecision: "unknown",
      };
    });
    if (!EPISTEMIC.has(item.epistemicStatus)) throw new Error(`发现 ${index + 1} 的认识状态无效`);
    if (!RELATIONS.has(item.relation)) throw new Error(`发现 ${index + 1} 的关系无效`);
    if (!Array.isArray(item.optionIndexes)) throw new Error(`发现 ${index + 1} 的 optionIndexes 必须是数组`);
    if (!Array.isArray(item.evidenceRefs)) throw new Error(`发现 ${index + 1} 的 evidenceRefs 必须是数组`);
    if (!Array.isArray(item.assumptions)) throw new Error(`发现 ${index + 1} 的 assumptions 必须是数组`);
    const optionIndexes = item.optionIndexes;
    if (optionIndexes.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= options.length)) throw new Error(`发现 ${index + 1} 的 optionIndexes 引用了不存在选项`);
    if (item.assumptions.length > 20) throw new Error(`发现 ${index + 1} 的 assumptions 超过 20 项`);
    return {
      id: text(item.id, 128) || `finding-${index + 1}`,
      lensId,
      sourceMessageId: sourceMessageId || null,
      pathStage,
      statement,
      epistemicStatus: item.epistemicStatus,
      relation: item.relation,
      optionIndexes: unique(optionIndexes),
      evidenceRefs,
      assumptions: item.assumptions.map((v) => text(v, 1000)).filter(Boolean),
    };
  });
  const recommendation = raw.recommendation;
  assertExactKeys(recommendation, new Set(["optionIndexes", "basisFindingIds"]), "模型建议");
  if (!Array.isArray(recommendation.optionIndexes)) throw new Error("模型建议的 optionIndexes 必须是数组");
  if (!Array.isArray(recommendation.basisFindingIds)) throw new Error("模型建议的 basisFindingIds 必须是数组");
  const recommendationIndexes = recommendation.optionIndexes;
  if (recommendationIndexes.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= options.length)) throw new Error("模型建议引用了不存在选项");
  const gates = (Array.isArray(raw.gates) ? raw.gates : []).map((item, index) => {
    assertExactKeys(item, new Set(["type", "reason", "sourceFindingIds"]), `门槛 ${index + 1}`);
    const gateTypes = new Set(["hard-constraint", "legal-review", "safety-review", "missing-critical-evidence"]);
    if (!gateTypes.has(item.type)) throw new Error(`门槛 ${index + 1} 的类型无效`);
    if (!Array.isArray(item.sourceFindingIds)) throw new Error(`门槛 ${index + 1} 的 sourceFindingIds 必须是数组`);
    return {
      type: item.type,
      reason: text(item.reason, 1000),
      sourceFindingIds: unique((Array.isArray(item.sourceFindingIds) ? item.sourceFindingIds : []).map((v) => text(v, 128)).filter(Boolean)),
    };
  }).filter((item) => item.reason);
  const findingIds = new Set(findings.flatMap((item) => [item.id, `${item.lensId}:${item.id}`]));
  const recommendationBasisIds = Array.isArray(recommendation.basisFindingIds) ? recommendation.basisFindingIds : [];
  for (const id of recommendationBasisIds) {
    if (!findingIds.has(text(id, 128))) throw new Error(`模型建议引用了不存在的发现：${id}`);
  }
  for (const gate of gates) for (const id of gate.sourceFindingIds) {
    if (!findingIds.has(id)) throw new Error(`门槛引用了不存在的发现：${id}`);
  }
  return {
    candidateEnvelopeVersion: CANDIDATE_ENVELOPE_VERSION,
    question,
    timeHorizon: text(raw.timeHorizon, 240) || null,
    scope: text(raw.scope, 1000) || null,
    options,
    findings,
    recommendation: {
      optionIndexes: unique(recommendationIndexes).slice(0, 6),
      basisFindingIds: unique((Array.isArray(recommendation.basisFindingIds) ? recommendation.basisFindingIds : []).map((v) => text(v, 128)).filter(Boolean)).slice(0, 30),
    },
    gates,
  };
}

function buildDecisionRecordFromEnvelope(envelopeInput, { existing = null, sourceConversationId = null, sourceMessageIds = [], allowedLensIds = [], pathSourceMessageIds = [], evidenceCatalog = [] } = {}) {
  const envelope = parseModelCandidateEnvelope(envelopeInput, { sourceMessageIds, allowedLensIds, pathSourceMessageIds, evidenceCatalog });
  const decisionId = existing?.decisionId || runtimeId("dec");
  const existingOptionByLabel = new Map((existing?.options || []).map((item) => [item.label, item]));
  const options = envelope.options.map((item) => ({
    id: existingOptionByLabel.get(item.label)?.id || stableId("opt", [decisionId, item.label]),
    label: item.label,
    kind: item.kind,
    availability: item.availability,
    outcomes: item.outcomes,
    riskRefs: [],
    assumptionRefs: [],
  }));
  const findingInputs = envelope.findings.map((item) => ({
    id: `${item.sourceMessageId || "message"}#${item.lensId}:${item.id}`,
    sourceMessageId: item.sourceMessageId,
    lensId: item.lensId,
    claim: item.statement,
    epistemicStatus: item.epistemicStatus,
    relation: item.relation,
    evidenceRefs: item.evidenceRefs,
  }));
  const claims = adaptLensFindings(findingInputs, { optionRefs: [] });
  const claimBySource = new Map();
  for (const claim of claims) for (const ref of claim.sourceFindingRefs) claimBySource.set(ref, claim);
  const claimsByTextAndStatus = new Map(claims.map((claim) => [`${claim.epistemicStatus}\u001f${claim.text}`, claim]));
  for (const finding of envelope.findings) {
    const sourceRef = `${finding.sourceMessageId || "message"}#${finding.lensId}:${finding.id}`;
    const claim = claimBySource.get(sourceRef);
    if (!claim) continue;
    if (finding.pathStage !== "none") claim.sourceFindingRefs = [...new Set([...claim.sourceFindingRefs, `PATH_STAGE:${finding.pathStage}`])];
    claim.optionRelations = finding.optionIndexes.map((index) => ({ optionRef: options[index].id, relation: finding.relation }));
    const assumptionRefs = [];
    for (let index = 0; index < finding.assumptions.length; index += 1) {
      const assumptionText = finding.assumptions[index];
      const key = `hypothesis\u001f${assumptionText}`;
      let assumption = claimsByTextAndStatus.get(key);
      if (!assumption) {
        assumption = adaptLensFindings([{
          id: `${sourceRef}:assumption:${index + 1}`,
          claim: assumptionText,
          epistemicStatus: "hypothesis",
          relation: "context",
          evidenceRefs: [],
        }])[0];
        if (!assumption) continue;
        assumption.sourceFindingRefs = [`${sourceRef}:assumption:${index + 1}`, ...(finding.pathStage === "none" ? [] : [`PATH_STAGE:${finding.pathStage}`])];
        claims.push(assumption);
        claimsByTextAndStatus.set(key, assumption);
        claimBySource.set(assumption.sourceFindingRefs[0], assumption);
      }
      assumptionRefs.push(assumption.id);
      for (const optionIndex of finding.optionIndexes) {
        options[optionIndex].assumptionRefs = [...new Set([...options[optionIndex].assumptionRefs, assumption.id])];
      }
    }
    claim.assumptionRefs = [...new Set(assumptionRefs)];
  }
  for (let optionIndex = 0; optionIndex < envelope.options.length; optionIndex += 1) {
    const option = envelope.options[optionIndex];
    for (let riskIndex = 0; riskIndex < option.risks.length; riskIndex += 1) {
      const riskText = option.risks[riskIndex];
      const key = `hypothesis\u001f${riskText}`;
      let riskClaim = claimsByTextAndStatus.get(key);
      if (!riskClaim) {
        riskClaim = adaptLensFindings([{
          id: `${decisionId}:option:${optionIndex + 1}:risk:${riskIndex + 1}`,
          claim: riskText,
          epistemicStatus: "hypothesis",
          relation: "oppose",
          evidenceRefs: [],
        }])[0];
        if (!riskClaim) continue;
        riskClaim.sourceFindingRefs = [`${decisionId}:option:${optionIndex + 1}:risk:${riskIndex + 1}`];
        claims.push(riskClaim);
        claimsByTextAndStatus.set(key, riskClaim);
      }
      options[optionIndex].riskRefs.push(riskClaim.id);
      riskClaim.optionRelations.push({ optionRef: options[optionIndex].id, relation: "oppose" });
    }
  }
  const basisRefs = envelope.recommendation.basisFindingIds.map((id) => {
    const finding = envelope.findings.find((item) => item.id === id || `${item.lensId}:${item.id}` === id);
    return finding ? claimBySource.get(`${finding.sourceMessageId || "message"}#${finding.lensId}:${finding.id}`)?.id : null;
  }).filter(Boolean);
  const gates = envelope.gates.map((gate) => ({
    id: stableId("gate", [decisionId, gate.type, gate.reason]),
    type: gate.type,
    status: "open",
    reason: gate.reason,
    sourceRefs: gate.sourceFindingIds.map((id) => {
      const finding = envelope.findings.find((item) => item.id === id || `${item.lensId}:${item.id}` === id);
      return finding ? claimBySource.get(`${finding.sourceMessageId || "message"}#${finding.lensId}:${finding.id}`)?.id : null;
    }).filter(Boolean),
    authority: "system-derived",
    userConfirmed: false,
  }));
  const record = {
    decisionRecordSchemaVersion: 1,
    judgmentKernelVersion: JUDGMENT_KERNEL_VERSION,
    decisionId,
    revision: (existing?.revision || 0) + 1,
    snapshotRefs: [...(existing?.snapshotRefs || [])],
    activeSnapshotId: existing?.activeSnapshotId || null,
    frame: { question: envelope.question, subjectRef: sourceConversationId ? `conversation:${sourceConversationId}` : "user.current", goalRefs: [], timeHorizon: envelope.timeHorizon, scope: envelope.scope },
    options,
    claims,
    gates,
    modelRecommendation: {
      status: "candidate",
      optionRefs: envelope.recommendation.optionIndexes.map((index) => options[index].id),
      basisRefs,
    },
    userDecision: { mode: "defer", selectedOptionRefs: [], rationale: "", conditions: [], confirmedAt: null },
    derivedState: { readiness: "draft", reviewState: "current", reasonCodes: [] },
  };
  const checked = validateDecisionCandidate(record);
  if (!checked.ok) throw new Error(checked.errors.map((item) => `${item.path}: ${item.message}`).slice(0, 8).join("；"));
  return checked.value;
}

function evidenceCatalogFromConversation(conversation) {
  const messages = (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .filter((message) => message && message.internal !== true && ["user", "assistant"].includes(message.role) && text(message.content))
    .slice(-16);
  const catalog = [];
  for (const message of messages) {
    if (!message || message.internal === true || message.role !== "assistant") continue;
    const items = Array.isArray(message?.onlineEvidence?.evidenceItems) ? message.onlineEvidence.evidenceItems : [];
    for (const item of items) {
      const url = text(item?.url, 1500);
      if (!/^https?:\/\//iu.test(url)) continue;
      const title = text(item.title, 240);
      const body = text(message.content, 20_000);
      catalog.push({ evidenceId: `web:${createHash("sha256").update(url).digest("hex").slice(0, 20)}`, title, locator: url, claim: text(item.claim, 1200), retrievedAt: text(message.onlineEvidence?.retrievedAt, 64) || null, sourceMessageId: String(message.id || ""), cited: Boolean(body && (body.includes(url) || (title.length > 8 && body.includes(title)))) });
    }
  }
  return [...new Map(catalog.map((item) => [item.evidenceId, item])).values()].slice(0, 20);
}

function buildModelCandidatePrompt(conversation) {
  const sourceMessages = (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .filter((message) => message && message.internal !== true && ["user", "assistant"].includes(message.role) && text(message.content))
    .slice(-16);
  const visible = sourceMessages.map((message) => `[消息ID=${message.id || "unknown"} | 角色=${message.role}]\n${text(message.content, 5000)}`).join("\n\n");
  const evidence = evidenceCatalogFromConversation(conversation);
  const allowedLensIds = [...new Set(sourceMessages.flatMap((message) => (Array.isArray(message.capabilityTrace?.lenses) ? message.capabilityTrace.lenses : []).map((lens) => text(lens?.id, 128)).filter(Boolean)))];
  const pathUserMessageIds = new Set(sourceMessages.filter((message) => {
    const snapshots = Array.isArray(message.skillSnapshots) ? message.skillSnapshots : [];
    return snapshots.some((snapshot) => /xingzhi-path-runtime/u.test(String(snapshot?.name || snapshot?.id || snapshot?.skillId || "")))
      || (Array.isArray(message.capabilityTrace?.skills) && message.capabilityTrace.skills.some((skill) => /xingzhi-path-runtime/u.test(String(skill?.id || ""))));
  }).map((message) => String(message.id || "")));
  const pathSourceMessageIds = sourceMessages.filter((message) => pathUserMessageIds.has(String(message.id || ""))
    || (message.role === "assistant" && pathUserMessageIds.has(String(message.sourceMessageId || ""))))
    .map((message) => String(message.id || ""));
  return [
    "你正在为 Judgment Kernel V3 生成一个候选信封。只返回一个 JSON 对象，不要 Markdown，不要解释。",
    "候选只是模型建议，严禁包含 userDecision、confirmedAt 或冒充用户确认。问题必须中性；至少两个真实可行选项；事实、推断、假设、价值判断和未知要分开。",
    "只抽取用户对话中真实出现的判断材料。四阶段按材料标注：观境整理处境与现实条件，立心只记录用户明确表达的价值/约束，践真形成可验证选项，知变标出待现实反馈和触发复审条件；不能补造阶段内容。pathStage 只能填写 P/A/T/H/none；只有下方 PATH 实际加载消息目录中的消息可以填 P/A/T/H。",
    `lensId 只能使用这些真实调用的透镜 ID：${JSON.stringify(allowedLensIds)}；如果某条发现没有透镜来源，使用 dialogue-synthesis。sourceMessageId 必须是下面消息中的真实 ID。不要声称原始隐藏推理已被读取；只能基于可见消息和路由轨迹。`,
    "evidenceRefs 只能引用证据目录里的 evidenceId；候选可以建议 used，但 cited 只能用于 evidenceCatalog 中 cited=true 的来源；不得写 user-confirmed。locator、时间和新鲜度由程序从真实目录补入。",
    "JSON 字段必须严格为：candidateEnvelopeVersion, question, timeHorizon, scope, options, findings, recommendation, gates。",
    "options 每项字段：label, kind(candidate/default-trajectory/defer/experiment), availability(available/unavailable/unknown), outcomes, risks。",
    "findings 每项字段：id, lensId, sourceMessageId, pathStage(P/A/T/H/none), statement, epistemicStatus(fact/user-statement/inference/hypothesis/value-judgment/unknown), relation(support/oppose/context), optionIndexes, evidenceRefs, assumptions。",
    "evidenceRefs 每项字段：evidenceId, relation, status(retrieved/used/cited), locator, quoteHash, retrievedAt, freshness(current/monitoring/stale/invalid/unknown)。",
    "recommendation 字段：optionIndexes, basisFindingIds。gates 每项字段：type, reason, sourceFindingIds。",
    `证据目录：${JSON.stringify(evidence)}`,
    `真实透镜目录：${JSON.stringify(allowedLensIds)}`,
    `PATH 实际加载消息目录：${JSON.stringify(pathSourceMessageIds)}`,
    `对话材料：\n${visible}`,
  ].join("\n\n").slice(0, 90_000);
}

module.exports = {
  CANDIDATE_ENVELOPE_VERSION,
  extractEnvelopeJson,
  parseModelCandidateEnvelope,
  buildDecisionRecordFromEnvelope,
  evidenceCatalogFromConversation,
  buildModelCandidatePrompt,
};
