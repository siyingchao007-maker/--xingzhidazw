"use strict";

const { createHash } = require("node:crypto");

function stableId(prefix, parts) {
  const hash = createHash("sha256").update(parts.map((item) => String(item || "").trim()).join("\u001f"), "utf8").digest("hex").slice(0, 20);
  return `${prefix}_${hash}`;
}

function relationForFinding(finding) {
  const value = String(finding?.relation || finding?.stance || "context").toLowerCase();
  if (["support", "supports", "for", "positive"].includes(value)) return "support";
  if (["oppose", "opposes", "against", "negative", "counter"].includes(value)) return "oppose";
  return "context";
}

function statusForEvidence(ref) {
  const value = String(ref?.status || "used").toLowerCase();
  return ["retrieved", "used", "cited", "user-confirmed"].includes(value) ? value : "used";
}

function freshnessForEvidence(ref) {
  const value = String(ref?.freshnessAtDecision || ref?.freshness || "unknown").toLowerCase();
  return ["current", "monitoring", "stale", "invalid", "unknown"].includes(value) ? value : "unknown";
}

function adaptLensFinding(finding, { optionRefs = [] } = {}) {
  const text = String(finding?.claim || finding?.text || finding?.statement || "").trim();
  if (!text) return null;
  const sourceKey = String(finding?.id || finding?.findingId || finding?.sourceId || "");
  const claimId = stableId("clm", [sourceKey, text]);
  const evidence = Array.isArray(finding?.evidenceRefs) ? finding.evidenceRefs : [];
  const relation = relationForFinding(finding);
  const evidenceEdges = evidence.map((ref, index) => {
    const item = typeof ref === "string" ? { evidenceId: ref } : (ref || {});
    const evidenceId = String(item.evidenceId || item.id || item.path || item.url || "").trim();
    if (!evidenceId) return null;
    return {
      evidenceId,
      revisionId: item.revisionId ? String(item.revisionId) : null,
      relation: item.relation ? relationForFinding(item) : relation,
      status: statusForEvidence(item),
      locator: item.locator || item.path || item.url || null,
      quoteHash: item.quoteHash || null,
      retrievedAt: item.retrievedAt || null,
      freshnessAtDecision: freshnessForEvidence(item),
      _sourceIndex: index,
    };
  }).filter(Boolean).map(({ _sourceIndex, ...edge }) => edge);
  const status = String(finding?.epistemicStatus || "unknown");
  const allowedStatus = ["fact", "user-statement", "inference", "hypothesis", "value-judgment", "unknown"].includes(status)
    ? status : "unknown";
  return {
    id: claimId,
    text,
    epistemicStatus: allowedStatus,
    evidenceEdges,
    assumptionRefs: [],
    optionRelations: [...new Set(optionRefs)].map((optionRef) => ({ optionRef, relation })),
    sourceFindingRefs: sourceKey ? [sourceKey] : [],
  };
}

function adaptLensFindings(findings, options = {}) {
  const claims = [];
  const byKey = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const claim = adaptLensFinding(finding, options);
    if (!claim) continue;
    const key = `${claim.epistemicStatus}\u001f${claim.text}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, claim);
      claims.push(claim);
      continue;
    }
    const edgeKeys = new Set(existing.evidenceEdges.map((edge) => `${edge.evidenceId}\u001f${edge.relation}\u001f${edge.status}`));
    for (const edge of claim.evidenceEdges) {
      const edgeKey = `${edge.evidenceId}\u001f${edge.relation}\u001f${edge.status}`;
      if (!edgeKeys.has(edgeKey)) existing.evidenceEdges.push(edge);
    }
    existing.sourceFindingRefs = [...new Set([...existing.sourceFindingRefs, ...claim.sourceFindingRefs])];
  }
  return claims;
}

module.exports = { stableId, adaptLensFinding, adaptLensFindings };
