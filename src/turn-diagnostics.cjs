"use strict";
const crypto=require("node:crypto");
const {normalizeTurnAnalysisPath}=require("./turn-analysis-path.cjs");
const {normalizeResponseMetrics}=require("./response-metrics.cjs");
const {PLUGIN_VERSION}=require("./release-file-contract.cjs");
const ROOT="00_系统/运行时工作区/回合诊断";
const token = value => typeof value === "string" ? value.slice(0,160).replace(/[^\p{L}\p{N}._:-]/gu,"_") : null;
function buildTurnDiagnostic(active, panel, message, outcome, timestamp) {
  const quality=panel?.qualityEvaluation || {};
  const reasoning=active?.reasoningExecution || message?.reasoningExecution || {};
  const completion=active?.providerCompletion || message?.providerCompletion || {};
  const pinnedSkills=Array.isArray(active?.skillSnapshots) && active.skillSnapshots.length
    ? active.skillSnapshots.map(snapshot=>({
      name:snapshot?.id,version:snapshot?.version,contentHash:snapshot?.contentHash,
      source:null,outputRole:null,
    }))
    : (panel?.skills || []);
  return {version:1,programVersion:PLUGIN_VERSION,turnId:token(active.telemetryTurnId),conversationId:token(active.conversationId),sourceMessageId:token(active.sourceMessageId),
    assistantMessageId:token(active.assistantMessageId),lane:active.internalTurn ? "background" : "dialogue",outcome:token(outcome),
    startedAt:active.startedAt,completedAt:timestamp,model:token(active.model),providerId:token(active.providerId),
    taskLevel:token(panel?.taskLevel || panel?.taskStateMachine?.taskLevel),outputDepth:token(panel?.reasoningPlan?.outputDepth),
    answerDepthSource:token(active?.answerContract?.depthSource),
    reasoning:{requestedProfile:token(reasoning.requestedProfile),requestedSource:token(reasoning.requestedSource),
      effectiveProfile:token(reasoning.effectiveProfile),requestEffort:token(reasoning.requestEffort),
      parameterTransmissionStatus:token(reasoning.status) || "unknown",modelHonoredEffort:"unknown"},
    providerCompletion:{actualModel:token(completion.actualModel),finishReason:token(completion.finishReason),
      responseStatus:token(completion.responseStatus),incompleteReason:token(completion.incompleteReason)},
    agentId:token(panel?.agentId),skills:pinnedSkills.slice(0,6).map(s=>({id:token(s.name),version:token(s.version),contentHash:token(s.contentHash),source:token(s.source),role:token(s.outputRole)})),
    routingSource:token(panel?.routingSource),routingStrength:Number.isFinite(panel?.routingConfidence)?panel.routingConfidence:null,
    routingStrengthMeaning:panel?.routingSource==="semantic-model" ? "model-reported-not-calibrated" : "rule-strength-not-probability",
    analysisPath:normalizeTurnAnalysisPath(panel?.analysisPath),
    performance:normalizeResponseMetrics(message?.responseMetrics),
    requestFingerprint:panel?.taskStateMachine?.inputFingerprint || null,answerChars:String(message?.content||"").length,
    answerHash:crypto.createHash("sha256").update(String(message?.content||"")).digest("hex"),
    tokens:active.tokenUsage ? Object.fromEntries(["inputTokens","outputTokens","totalTokens","cachedInputTokens","reasoningTokens"].map(k=>[k,Number.isFinite(active.tokenUsage[k])?active.tokenUsage[k]:null])):null,
    requirementIds:(active.answerContract?.requirements || []).map(r=>token(r.id)),
    quality:{status:token(quality.status),contractVersion:Number.isSafeInteger(quality.contractVersion)?quality.contractVersion:null,
      primarySkillId:token(quality.primarySkillId),protectedRequirementCount:Number.isFinite(quality.protectedRequirementCount)?quality.protectedRequirementCount:0,
      defects:(quality.defects||[]).map(token),missingRequirements:(quality.missingRequirements||[]).map(token),
      formatViolations:(quality.formatViolations||[]).map(token),repairMode:token(quality.repairMode),
      repairAttempts:active.qualityRepairAttempts||0,semanticCompleteness:"not-measured"},
  };
}
function diagnosticPath(row) {
  if(!row?.turnId || !Number.isFinite(Date.parse(row.startedAt))) throw new Error("诊断记录缺少回合或时间");
  const id=crypto.createHash("sha256").update(`${row.turnId}:${row.outcome}`).digest("hex");
  return `${ROOT}/${new Date(row.startedAt).toISOString().slice(0,7)}/${id}.json`;
}
async function persistTurnDiagnostic(vault,row) {
  const path=diagnosticPath(row); const content=JSON.stringify(row,null,2)+"\n";
  if(await vault.exists(path)) return path;
  await vault.ensureFolder(path.slice(0,path.lastIndexOf("/")));
  await vault.create(path,content); return path;
}
function recentDiagnostics(previous,row) {
  const rows=Array.isArray(previous)?previous:[];
  if(rows.some(r=>r.turnId===row.turnId)) return rows;
  return [...rows,row].slice(-200);
}
module.exports={buildTurnDiagnostic,persistTurnDiagnostic,recentDiagnostics,diagnosticPath};
