"use strict";

const MAX_LENS_RESULTS = 16;
const MAX_BASELINE_FINDINGS = 128;
const CONFIDENCE_SCORE = Object.freeze({ low: 1, medium: 2, high: 3 });
const EPISTEMIC_SCORE = Object.freeze({
  unknown: 0,
  "value-judgment": 1,
  hypothesis: 2,
  inference: 3,
  "user-statement": 4,
  fact: 5,
});
const ADJUDICATION_CRITERIA = Object.freeze([
  "证据直接性与可靠性",
  "假设数量",
  "适用边界与时间尺度",
  "对结论和行动的影响",
  "可区分竞争解释的下一步验证",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}格式或数量上限无效`);
  return value;
}

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/(?:从|按照|基于)?(?:第一性原理|系统思维|矛盾论|因果推断|博弈论|发展视角|反证视角)(?:来看|看|认为|分析)?/gu, "")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function stringSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean));
}

function evidenceSignature(ref) {
  return [ref?.sourceType, ref?.sourceId, normalizeText(ref?.quote)].join(":");
}

function evidenceSet(finding) {
  return new Set((Array.isArray(finding?.evidenceRefs) ? finding.evidenceRefs : []).map(evidenceSignature));
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((item) => right.has(item));
}

function sameClaimCoordinates(left, right) {
  return left.topicKey === right.topicKey
    && left.stance === right.stance
    && left.timeHorizon === right.timeHorizon;
}

function isExactDuplicate(left, right) {
  if (!sameClaimCoordinates(left, right)) return false;
  const leftEvidence = evidenceSet(left);
  const rightEvidence = evidenceSet(right);
  if (leftEvidence.size || rightEvidence.size) return setsEqual(leftEvidence, rightEvidence);
  if (normalizeText(left.summary) === normalizeText(right.summary)) return true;
  if (!leftEvidence.size && !rightEvidence.size) {
    return setsEqual(stringSet(left.assumptions), stringSet(right.assumptions));
  }
  return false;
}

function hasDecisionImpact(result) {
  const impact = result?.decisionImpact || {};
  return Boolean(impact.changesConclusion || impact.changesPriority || impact.changesAction);
}

function hasSubstantiveNovelty(novelty = {}) {
  return Boolean(
    novelty.newEvidenceInterpretation
    || novelty.newMechanism
    || novelty.newAssumption
    || novelty.newCounterevidence
    || novelty.newRisk
    || novelty.newOption
    || novelty.changesDecision
  );
}

function hasBoundedClaim(finding) {
  const evidenceCount = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs.length : 0;
  const assumptionCount = Array.isArray(finding.assumptions) ? finding.assumptions.length : 0;
  if (["fact", "user-statement"].includes(finding.epistemicStatus)) return evidenceCount > 0;
  if (["hypothesis", "value-judgment"].includes(finding.epistemicStatus)) return assumptionCount > 0;
  if (finding.epistemicStatus === "inference") return evidenceCount > 0 || assumptionCount > 0;
  return evidenceCount > 0;
}

function findingStrength(finding) {
  const evidence = evidenceSet(finding);
  return (EPISTEMIC_SCORE[finding.epistemicStatus] || 0) * 100
    + evidence.size * 10
    + (CONFIDENCE_SCORE[finding.confidence] || 0);
}

function labelsFor(finding, novelty, materiality) {
  const labels = [];
  if (finding.epistemicStatus === "hypothesis") labels.push("provisional-hypothesis");
  if (finding.epistemicStatus === "value-judgment") labels.push("value-dependent");
  if (novelty.newRisk && materiality === "high") labels.push("high-impact-risk");
  return labels;
}

function admissionDecision(result, finding) {
  const materiality = result?.utility?.materiality;
  const novelty = result?.novelty || {};
  const impact = hasDecisionImpact(result);
  const bounded = hasBoundedClaim(finding);
  const labels = labelsFor(finding, novelty, materiality);

  if (result?.utility?.relevantToUserQuestion !== true) {
    return { included: false, reasonCode: "irrelevant-to-user-question", labels };
  }
  if (!bounded) return { included: false, reasonCode: "unbounded-claim", labels };
  if (materiality === "low" && !impact) {
    return { included: false, reasonCode: "low-materiality-no-impact", labels };
  }
  if (novelty.newRisk && materiality === "high"
    && (result?.calibration?.nextValidation || result?.calibration?.disconfirmingEvidence?.length)) {
    return { included: true, reasonCode: "retain-high-impact-risk", labels };
  }
  if (finding.epistemicStatus === "hypothesis" && materiality === "high"
    && finding.assumptions?.length
    && (result?.calibration?.nextValidation || result?.calibration?.disconfirmingEvidence?.length)) {
    return { included: true, reasonCode: "retain-testable-hypothesis", labels };
  }
  if (impact || novelty.changesDecision) {
    return { included: true, reasonCode: "changes-decision", labels };
  }
  if (hasSubstantiveNovelty(novelty) && ["medium", "high"].includes(materiality)) {
    return { included: true, reasonCode: "material-information-increment", labels };
  }
  if (novelty.newEvidenceUsed) {
    return { included: false, reasonCode: "novel-without-decision-value", labels };
  }
  return { included: false, reasonCode: "no-information-increment", labels };
}

function makeCandidate(result, finding, index) {
  const admission = admissionDecision(result, finding);
  return {
    findingId: `${result.skillId}#${index}`,
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    finding: cloneJson(finding),
    decisionImpact: cloneJson(result.decisionImpact || {}),
    calibration: cloneJson(result.calibration || {}),
    novelty: cloneJson(result.novelty || {}),
    materiality: result?.utility?.materiality,
    included: admission.included,
    reasonCode: admission.reasonCode,
    labels: admission.labels,
    matchedFindingIds: [],
  };
}

function makeBaseline(finding, index) {
  return {
    findingId: finding.findingId || finding.id || `baseline#${index}`,
    finding,
    strength: findingStrength(finding),
  };
}

function terminologyOnly(candidate) {
  return !hasDecisionImpact(candidate)
    && !hasSubstantiveNovelty(candidate.novelty)
    && !candidate.novelty.newEvidenceUsed;
}

function applyDuplicateRules(candidate, baselines, included) {
  const baselineMatches = baselines.filter((item) => isExactDuplicate(candidate.finding, item.finding));
  if (baselineMatches.length) {
    candidate.matchedFindingIds = baselineMatches.map((item) => item.findingId);
    const strongestBaseline = Math.max(...baselineMatches.map((item) => item.strength));
    if (terminologyOnly(candidate)) {
      candidate.included = false;
      candidate.reasonCode = "terminology-only-restatement";
      return;
    }
    if (findingStrength(candidate.finding) <= strongestBaseline) {
      candidate.included = false;
      candidate.reasonCode = "duplicate-covered";
      return;
    }
  }

  const existingMatches = included.filter((item) => isExactDuplicate(candidate.finding, item.finding));
  if (!existingMatches.length) return;
  candidate.matchedFindingIds = existingMatches.map((item) => item.findingId);
  const strongest = existingMatches.reduce((best, item) => (
    findingStrength(item.finding) > findingStrength(best.finding) ? item : best
  ));
  if (findingStrength(candidate.finding) <= findingStrength(strongest.finding)) {
    candidate.included = false;
    candidate.reasonCode = terminologyOnly(candidate) ? "terminology-only-restatement" : "duplicate-covered";
    return;
  }
  for (const matched of existingMatches) {
    matched.included = false;
    matched.reasonCode = "duplicate-covered";
    matched.matchedFindingIds = [candidate.findingId];
  }
}

function uniqueTexts(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function buildConflicts(included) {
  const groups = new Map();
  for (const item of included) {
    if (!["supports", "opposes"].includes(item.finding.stance)) continue;
    const key = `${item.finding.topicKey}\u0000${item.finding.timeHorizon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const conflicts = [];
  for (const sides of groups.values()) {
    const stances = new Set(sides.map((item) => item.finding.stance));
    if (!stances.has("supports") || !stances.has("opposes")) continue;
    const isValueConflict = sides.some((item) => item.finding.epistemicStatus === "value-judgment");
    conflicts.push({
      topicKey: sides[0].finding.topicKey,
      timeHorizon: sides[0].finding.timeHorizon,
      conflictType: isValueConflict ? "value-conflict" : "evidence-conflict",
      resolution: isValueConflict ? "requires-user-value-choice" : "unresolved",
      majorityVoteUsed: false,
      sides: sides.map((item) => ({
        findingId: item.findingId,
        skillId: item.skillId,
        stance: item.finding.stance,
        timeHorizon: item.finding.timeHorizon,
        epistemicStatus: item.finding.epistemicStatus,
        evidenceRefs: cloneJson(item.finding.evidenceRefs || []),
        assumptions: cloneJson(item.finding.assumptions || []),
        confidence: item.finding.confidence,
      })),
      adjudication: {
        criteria: [...ADJUDICATION_CRITERIA],
        disconfirmingEvidence: uniqueTexts(sides.flatMap((item) => item.calibration.disconfirmingEvidence || [])),
        nextValidations: uniqueTexts(sides.map((item) => item.calibration.nextValidation || "")),
      },
    });
  }
  return conflicts;
}

function buildTimeScaleDifferences(included) {
  const groups = new Map();
  for (const item of included) {
    const key = item.finding.topicKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const differences = [];
  for (const [topicKey, items] of groups) {
    const timeHorizons = [...new Set(items.map((item) => item.finding.timeHorizon)
      .filter((horizon) => horizon !== "unspecified"))];
    if (timeHorizons.length < 2) continue;
    differences.push({
      topicKey,
      timeHorizons,
      findingIds: items.map((item) => item.findingId),
    });
  }
  return differences;
}

function buildEvidenceLedger(included) {
  const entries = new Map();
  let totalReferences = 0;
  for (const item of included) {
    const seenInFinding = new Set();
    for (const ref of Array.isArray(item.finding?.evidenceRefs) ? item.finding.evidenceRefs : []) {
      const signature = evidenceSignature(ref);
      if (!ref?.sourceType || !ref?.sourceId || !normalizeText(ref?.quote) || seenInFinding.has(signature)) continue;
      seenInFinding.add(signature);
      totalReferences += 1;
      if (!entries.has(signature)) {
        entries.set(signature, {
          signature,
          sourceType: ref.sourceType,
          sourceId: ref.sourceId,
          quote: ref.quote,
          weight: 1,
          findingIds: [],
          skillIds: [],
        });
      }
      const entry = entries.get(signature);
      if (!entry.findingIds.includes(item.findingId)) entry.findingIds.push(item.findingId);
      if (!entry.skillIds.includes(item.skillId)) entry.skillIds.push(item.skillId);
    }
  }
  return {
    weightingPolicy: "one-per-source-and-quote",
    uniqueEvidenceCount: entries.size,
    totalReferences,
    duplicateReferenceCount: Math.max(0, totalReferences - entries.size),
    entries: [...entries.values()],
  };
}

function synthesizeCognitiveLensResults({ lensResults, baselineFindings = [] } = {}) {
  const results = asArray(lensResults, "认知透镜结果", MAX_LENS_RESULTS);
  const baselines = asArray(baselineFindings, "基线发现", MAX_BASELINE_FINDINGS).map(makeBaseline);
  const included = [];
  const filtered = [];

  for (const result of results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("认知透镜结果必须是对象");
    if (result.applicable === false) continue;
    for (const [index, finding] of asArray(result.findings, "透镜发现", 12).entries()) {
      const candidate = makeCandidate(result, finding, index);
      if (candidate.included || candidate.reasonCode === "no-information-increment") {
        applyDuplicateRules(candidate, baselines, included);
      }
      const displaced = included.filter((item) => item.included === false);
      if (displaced.length) {
        for (const item of displaced) filtered.push(item);
        for (let position = included.length - 1; position >= 0; position -= 1) {
          if (!included[position].included) included.splice(position, 1);
        }
      }
      (candidate.included ? included : filtered).push(candidate);
    }
  }

  const conflicts = buildConflicts(included);
  const output = {
    included,
    filtered,
    conflicts,
    timeScaleDifferences: buildTimeScaleDifferences(included),
    evidenceLedger: buildEvidenceLedger(included),
    summary: {
      totalFindings: included.length + filtered.length,
      includedFindings: included.length,
      filteredFindings: filtered.length,
      unresolvedConflicts: conflicts.length,
      majorityVoteUsed: false,
    },
  };
  return deepFreeze(output);
}

module.exports = {
  ADJUDICATION_CRITERIA,
  synthesizeCognitiveLensResults,
};
