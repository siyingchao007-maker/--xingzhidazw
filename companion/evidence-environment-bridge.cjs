"use strict";

const crypto = require("node:crypto");
const {
  MAX_ENVIRONMENT_EVIDENCE_IDS,
  normalizeEnvironmentCandidate,
} = require("./environment-policy-engine.cjs");

const MAX_ONLINE_EVIDENCE_ITEMS = 12;

function text(value, maximum = 2_000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "bigint", "boolean"].includes(typeof value)) return "";
  return String(value).replace(/\u0000/gu, "").trim().slice(0, maximum);
}

function uniqueStrings(values, maximum = 100) {
  const source = Array.isArray(values) ? values : values == null || values === "" ? [] : [values];
  const seen = new Set();
  const result = [];
  for (const value of source) {
    if (!["string", "number", "bigint", "boolean"].includes(typeof value)) continue;
    const normalized = text(value, 2_000);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function safeHttpUrl(value) {
  const raw = text(value, 1_500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function onlineEvidenceId(url, claim) {
  const safeUrl = safeHttpUrl(url);
  const safeClaim = text(claim, 1_200);
  if (!safeUrl || !safeClaim) return "";
  const digest = crypto.createHash("sha256").update(`${safeUrl}\0${safeClaim}`, "utf8").digest("hex").slice(0, 24);
  return `web:${digest}`;
}

function buildOnlineEvidenceCandidates(onlineEvidence, { now = new Date().toISOString() } = {}) {
  const items = Array.isArray(onlineEvidence?.evidenceItems)
    ? onlineEvidence.evidenceItems.slice(0, MAX_ONLINE_EVIDENCE_ITEMS) : [];
  const retrievedAt = text(onlineEvidence?.retrievedAt, 100) || text(now, 100) || new Date().toISOString();
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const title = text(item?.title, 240);
    const url = safeHttpUrl(item?.url);
    const publishedAt = text(item?.publishedAt, 100);
    const claim = text(item?.claim, 1_200);
    const evidenceId = onlineEvidenceId(url, claim);
    if (!title || !url || !claim || !evidenceId || seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    const digest = evidenceId.slice(4);
    result.push({
      id: `online-evidence-${digest}`,
      candidateKey: `external.evidence.${digest}`,
      knowledgeKey: `external.evidence.${digest}`,
      title: `联网证据｜${title}`.slice(0, 300),
      content: [
        `来源标题：${title}`,
        `来源链接：${url}`,
        ...(publishedAt ? [`公布时间：${publishedAt}`] : []),
        `本轮直接支持的事实：${claim}`,
        `获取时间：${retrievedAt}`,
      ].join("\n"),
      summary: claim.slice(0, 1_000),
      keyPoints: [claim.slice(0, 500)],
      suggestedUses: ["作为本轮环境判断或其他判断的可追溯外部证据"],
      knowledgeType: "evidence",
      epistemicStatus: "fact",
      confidence: 0.95,
      sensitivity: "normal",
      relation: "new",
      relevance: "reusable-knowledge",
      durability: "time-bound",
      whyUseful: "本轮真实联网检索实际使用的公开来源，可供后续核验环境与判断。",
      evidenceIds: [evidenceId],
      evidence: [{ type: "direct-observation", sourceId: url }],
      context: publishedAt ? `公开网页；页面公布时间：${publishedAt}` : "公开网页；页面公布时间未确认",
      tags: ["联网证据", "外部来源"],
      reviewState: "needs-confirmation",
      reviewReasons: ["online-evidence"],
      sourceRole: "assistant",
      systemOnlineEvidence: true,
    });
  }
  return result;
}

function trustedWebEvidenceIds(evidenceCandidates) {
  return new Set((Array.isArray(evidenceCandidates) ? evidenceCandidates : [])
    .flatMap((candidate) => Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [])
    .filter((id) => typeof id === "string" && /^web:[a-f0-9]{24}$/u.test(id)));
}

function bridgeEnvironmentCandidates(candidates, evidenceCandidates) {
  const input = Array.isArray(candidates) ? candidates : [];
  const trusted = trustedWebEvidenceIds(evidenceCandidates);
  let environmentCandidateCount = 0;
  let linkedEnvironmentCandidateCount = 0;
  let missingEvidenceLinkCount = 0;
  let rejectedWebReferenceCount = 0;

  const bridged = input.map((candidate) => {
    if (!candidate || candidate.knowledgeType !== "environment") return candidate;
    environmentCandidateCount += 1;
    const normalized = normalizeEnvironmentCandidate(candidate);
    const rawIds = uniqueStrings(normalized.evidenceIds, MAX_ENVIRONMENT_EVIDENCE_IDS);
    const nonWebIds = rawIds.filter((id) => !id.startsWith("web:"));
    const trustedWebIds = rawIds.filter((id) => id.startsWith("web:") && trusted.has(id));
    const rejectedWebIds = rawIds.filter((id) => id.startsWith("web:") && !trusted.has(id));
    rejectedWebReferenceCount += rejectedWebIds.length;

    const reviewReasons = uniqueStrings([
      ...(Array.isArray(normalized.reviewReasons) ? normalized.reviewReasons : []),
      ...(rejectedWebIds.length ? ["unverified-environment-evidence"] : []),
    ], 20);
    const onlineEvidenceWasAvailable = trusted.size > 0;
    if (normalized.sourceRole === "assistant" && onlineEvidenceWasAvailable && trustedWebIds.length === 0) {
      missingEvidenceLinkCount += 1;
      reviewReasons.push("environment-evidence-link-missing");
    }
    if (trustedWebIds.length > 0) linkedEnvironmentCandidateCount += 1;

    return {
      ...normalized,
      evidenceIds: uniqueStrings([...nonWebIds, ...trustedWebIds], MAX_ENVIRONMENT_EVIDENCE_IDS),
      freshness: normalized.sourceRole === "assistant" && onlineEvidenceWasAvailable && trustedWebIds.length === 0
        ? "monitoring"
        : normalized.freshness,
      reviewReasons: uniqueStrings(reviewReasons, 20),
    };
  });

  return {
    candidates: bridged,
    diagnostics: Object.freeze({
      evidenceCandidateCount: Array.isArray(evidenceCandidates) ? evidenceCandidates.length : 0,
      environmentCandidateCount,
      linkedEnvironmentCandidateCount,
      missingEvidenceLinkCount,
      rejectedWebReferenceCount,
    }),
  };
}

module.exports = {
  MAX_ONLINE_EVIDENCE_ITEMS,
  onlineEvidenceId,
  buildOnlineEvidenceCandidates,
  bridgeEnvironmentCandidates,
};
