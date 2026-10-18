"use strict";

const EVIDENCE_STATES = Object.freeze(["none", "linked", "contested", "stale", "broken"]);
const MATERIAL_STATUSES = new Set(["used", "cited", "user-confirmed"]);
const STATUS_ORDER = Object.freeze(["retrieved", "used", "cited", "user-confirmed"]);

function evidenceState(edges) {
  const list = Array.isArray(edges) ? edges : [];
  if (!list.length) return "none";
  if (list.some((edge) => !edge || typeof edge.evidenceId !== "string" || !edge.evidenceId.trim()
    || edge.freshnessAtDecision === "invalid")) return "broken";
  const material = list.filter((edge) => MATERIAL_STATUSES.has(edge.status));
  if (!material.length) return "linked";
  if (material.some((edge) => edge.freshnessAtDecision === "stale")) return "stale";
  const relations = new Set(material.map((edge) => edge.relation));
  if (relations.has("support") && relations.has("oppose")) return "contested";
  return "linked";
}

function decisionEvidenceReport(record) {
  const claims = Array.isArray(record?.claims) ? record.claims : [];
  const byClaim = claims.map((claim) => ({
    claimId: claim.id,
    state: evidenceState(claim.evidenceEdges),
    retrieved: (claim.evidenceEdges || []).filter((edge) => edge.status === "retrieved").length,
    used: (claim.evidenceEdges || []).filter((edge) => edge.status === "used").length,
    cited: (claim.evidenceEdges || []).filter((edge) => edge.status === "cited").length,
    userConfirmed: (claim.evidenceEdges || []).filter((edge) => edge.status === "user-confirmed").length,
  }));
  const counts = Object.fromEntries(EVIDENCE_STATES.map((state) => [state, byClaim.filter((item) => item.state === state).length]));
  return {
    byClaim,
    counts,
    needsReview: counts.stale > 0 || counts.broken > 0,
  };
}

function advanceEvidenceStatus(record, updates) {
  const next = JSON.parse(JSON.stringify(record));
  const requested = new Map((Array.isArray(updates) ? updates : []).map((item) => [
    `${String(item?.claimId || "")}\u001f${String(item?.evidenceId || "")}`,
    { status: String(item?.status || ""), explicitlyConfirmedByUser: item?.explicitlyConfirmedByUser === true },
  ]));
  let changed = 0;
  const found = new Set();
  for (const claim of Array.isArray(next.claims) ? next.claims : []) {
    for (const edge of Array.isArray(claim.evidenceEdges) ? claim.evidenceEdges : []) {
      const key = `${claim.id}\u001f${edge.evidenceId}`;
      const update = requested.get(key);
      if (!update) continue;
      found.add(key);
      const desired = update.status;
      const currentIndex = STATUS_ORDER.indexOf(edge.status);
      const desiredIndex = STATUS_ORDER.indexOf(desired);
      if (desiredIndex < 0) throw new Error(`不支持的证据状态：${desired}`);
      if (desired === "user-confirmed" && update.explicitlyConfirmedByUser !== true) throw new Error("证据只能在用户明确审查并确认后标记为 user-confirmed");
      if (desiredIndex < currentIndex) throw new Error("证据状态不能静默降级；需要新增复审候选并说明原因");
      if (desired !== edge.status) { edge.status = desired; changed += 1; }
    }
  }
  for (const key of requested.keys()) if (!found.has(key)) throw new Error("证据审查引用了当前判断中不存在的主张或来源");
  return { value: next, changed };
}

module.exports = { EVIDENCE_STATES, STATUS_ORDER, evidenceState, decisionEvidenceReport, advanceEvidenceStatus };
