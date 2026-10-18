"use strict";

const crypto = require("node:crypto");
const { parseCognitiveLensResult } = require("./cognitive-lens-result.cjs");
const { normalizeTokenUsage } = require("./response-metrics.cjs");

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 1_200;
const MAX_EXPECTED_DIMENSIONS = 32;
const MAX_SHADOW_DIAGNOSTICS = 100;
const SECRET_PATTERN = /((?:api[_ -]?key|access[_ -]?token|token|secret|password|密钥|密码)\s*[:=：]\s*)[^\s,，;；]+/giu;
const DIMENSION_TEXT_PATTERNS = Object.freeze({
  软约束: /软约束|偏好|更看重|价值排序|价值权重|可协商|惯例|默认流程/u,
  关键存量与流量: /(?:存量|积压|队列|库存).{0,80}(?:流入|进入).{0,80}(?:流出|完成|退出)|(?:流入|进入).{0,80}(?:流出|完成|退出).{0,80}(?:存量|积压|队列|库存)/u,
  反馈回路: /(?:强化|平衡|正向|负向|自我强化|自我平衡).{0,40}(?:回路|循环)|(?:回路|循环).{0,40}(?:强化|平衡|闭合|极性)/u,
  时间延迟: /(?:延迟|滞后|等待).{0,40}(?:结果|响应|见效|反馈|观察|发生|流失)|(?:行动|干预|采购).{0,40}(?:延迟|滞后|等待)/u,
  短期和长期效应: /(?:短期|即时|眼前).{0,100}(?:长期|随后|延迟|后续)|(?:长期|后续|延迟).{0,100}(?:短期|即时|眼前)/u,
  杠杆点: /(?:可逆|小范围|小样本).{0,80}(?:干预|试验|实验|调整)|(?:干预|试验|实验|调整).{0,80}(?:可逆|小范围|小样本)/u,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedText(value, maximum = MAX_SUMMARY_BYTES) {
  const normalized = String(value || "").trim().replace(SECRET_PATTERN, "$1[已隐藏]");
  if (Buffer.byteLength(normalized, "utf8") <= maximum) return normalized;
  let output = "";
  for (const character of normalized) {
    if (Buffer.byteLength(output + character, "utf8") > maximum - 3) break;
    output += character;
  }
  return `${output}...`;
}

function inputFingerprint(input) {
  const text = String(input || "");
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function exactDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60_000 ? Math.round(value) : null;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, 128)))];
}

function normalizeRoute(value) {
  const route = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    operatorIds: uniqueIds(route.operatorIds),
    skillIds: uniqueIds(route.skillIds),
  };
}

function routeIds(route) {
  return [...new Set([...route.operatorIds, ...route.skillIds])];
}

function routeComparison(legacyRoute, shadowRoute) {
  const legacy = routeIds(legacyRoute);
  const shadow = routeIds(shadowRoute);
  return {
    legacy: legacyRoute,
    shadow: shadowRoute,
    legacyOnly: legacy.filter((id) => !shadow.includes(id)),
    shadowOnly: shadow.filter((id) => !legacy.includes(id)),
    same: legacy.length === shadow.length && legacy.every((id) => shadow.includes(id)),
  };
}

function dimensions(value) {
  if (!Array.isArray(value) || value.length > MAX_EXPECTED_DIMENSIONS) {
    throw new Error("影子评测维度格式或数量上限无效");
  }
  return [...new Set(value.map((item) => boundedText(item, 100)).filter(Boolean))];
}

function coverage(text, expected) {
  const source = String(text || "");
  const covered = expected.filter((dimension) => (
    source.includes(dimension) || DIMENSION_TEXT_PATTERNS[dimension]?.test(source)
  ));
  return {
    covered,
    missing: expected.filter((dimension) => !covered.includes(dimension)),
    ratio: expected.length ? covered.length / expected.length : 1,
  };
}

function structuredDimensionSignals(result) {
  if (!result?.applicable) return [];
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const epistemicStatuses = new Set(findings.map((item) => item?.epistemicStatus));
  const hasDisconfirmingEvidence = Array.isArray(result.calibration?.disconfirmingEvidence)
    && result.calibration.disconfirmingEvidence.length > 0;
  return [
    ...(epistemicStatuses.has("fact") || epistemicStatuses.has("user-statement") ? ["事实"] : []),
    ...(epistemicStatuses.has("hypothesis")
      || findings.some((item) => Array.isArray(item?.assumptions) && item.assumptions.length)
      ? ["假设"] : []),
    ...(epistemicStatuses.has("value-judgment") ? ["软约束"] : []),
    ...(epistemicStatuses.has("unknown") ? ["未知"] : []),
    ...(result.novelty?.newOption === true ? ["重构方案"] : []),
    ...(hasDisconfirmingEvidence ? ["反证条件"] : []),
    ...(typeof result.calibration?.nextValidation === "string"
      && result.calibration.nextValidation.trim() ? ["下一步验证"] : []),
    ...(result.novelty?.newOption === true && hasDisconfirmingEvidence ? ["适用边界"] : []),
  ];
}

function normalizedFindingSummary(value) {
  return String(value || "").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "");
}

function shadowSummary(result) {
  return boundedText([
    ...result.findings.map((finding) => finding.summary),
    result.decisionImpact.implication,
  ].filter(Boolean).join("；"));
}

function duplicateIssues(result) {
  const seen = new Map();
  const issues = [];
  for (const [index, finding] of result.findings.entries()) {
    const signature = normalizedFindingSummary(finding.summary);
    if (!signature) continue;
    if (seen.has(signature)) {
      issues.push({
        code: "duplicate-finding",
        severity: "warning",
        detail: `发现 ${index + 1} 与发现 ${seen.get(signature) + 1} 内容重复`,
      });
    } else {
      seen.set(signature, index);
    }
  }
  return issues;
}

function factEvidenceIssues(result, evidenceTextsBySourceId) {
  const evidence = evidenceTextsBySourceId && typeof evidenceTextsBySourceId === "object"
    && !Array.isArray(evidenceTextsBySourceId) ? evidenceTextsBySourceId : {};
  const issues = [];
  for (const [index, finding] of result.findings.entries()) {
    if (finding.epistemicStatus !== "fact") continue;
    for (const ref of finding.evidenceRefs) {
      if (ref.sourceType === "current-user") continue;
      if (!Object.hasOwn(evidence, ref.sourceId)) continue;
      const sourceText = typeof evidence[ref.sourceId] === "string" ? evidence[ref.sourceId] : "";
      if (!ref.quote || !sourceText.includes(ref.quote)) {
        issues.push({
          code: "unverified-fact-evidence",
          severity: "error",
          detail: `发现 ${index + 1} 的事实摘录无法在指定来源中核对`,
        });
      }
    }
  }
  return issues;
}

function costRecord(result) {
  return {
    tokenUsage: normalizeTokenUsage(result?.tokenUsage),
    latencyMs: exactDuration(result?.latencyMs),
    outputChars: String(result?.outputText || "").length,
  };
}

function difference(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
}

function comparisonId(caseId, fingerprint, createdAt) {
  const safeCase = boundedText(caseId, 80).replace(/[^\p{L}\p{N}._-]/gu, "_") || "shadow";
  return `${safeCase}-${fingerprint.slice(7, 19)}-${Date.parse(createdAt)}`;
}

function legacyRecord(legacyResult) {
  return {
    summary: boundedText(legacyResult?.summary || legacyResult?.outputText),
    route: normalizeRoute(legacyResult?.route),
    cost: costRecord(legacyResult),
  };
}

const SAFE_SERVER_FAILURE_ISSUES = Object.freeze({
  usageLimitExceeded: Object.freeze({
    code: "shadow-usage-limit",
    detail: "影子执行达到当前使用额度上限",
  }),
  sessionBudgetExceeded: Object.freeze({
    code: "shadow-session-budget",
    detail: "影子执行达到当前会话预算上限",
  }),
  rateLimitExceeded: Object.freeze({
    code: "shadow-rate-limit",
    detail: "影子执行达到当前请求频率上限",
  }),
  contextWindowExceeded: Object.freeze({
    code: "shadow-context-limit",
    detail: "影子执行输入超过模型上下文上限",
  }),
  unauthorized: Object.freeze({
    code: "shadow-unauthorized",
    detail: "影子执行的模型身份验证失败",
  }),
  badRequest: Object.freeze({
    code: "shadow-bad-request",
    detail: "影子执行请求未被模型服务接受",
  }),
  sandboxError: Object.freeze({
    code: "shadow-sandbox-error",
    detail: "影子执行的隔离环境失败",
  }),
  serverOverloaded: Object.freeze({
    code: "shadow-service-unavailable",
    detail: "影子模型服务暂时不可用",
  }),
  internalServerError: Object.freeze({
    code: "shadow-service-unavailable",
    detail: "影子模型服务暂时不可用",
  }),
  responseTooManyFailedAttempts: Object.freeze({
    code: "shadow-service-unavailable",
    detail: "影子模型服务暂时不可用",
  }),
  httpConnectionFailed: Object.freeze({
    code: "shadow-connection-error",
    detail: "影子执行无法连接模型服务",
  }),
  responseStreamConnectionFailed: Object.freeze({
    code: "shadow-connection-error",
    detail: "影子执行无法连接模型服务",
  }),
  responseStreamDisconnected: Object.freeze({
    code: "shadow-connection-error",
    detail: "影子执行无法连接模型服务",
  }),
});

function safeFailureIssue(error) {
  const code = String(error?.code || "");
  if (code === "SHADOW_TIMEOUT") {
    return { code: "shadow-timeout", severity: "error", detail: "影子执行在有限时限内没有完整结束" };
  }
  if (code === "SHADOW_SERVER_ERROR" || code === "SHADOW_TURN_FAILED") {
    const category = error?.diagnostics?.lastServerError?.category;
    const serverIssue = typeof category === "string" ? SAFE_SERVER_FAILURE_ISSUES[category] : null;
    if (serverIssue) return { ...serverIssue, severity: "error" };
  }
  if (code === "SHADOW_SERVER_ERROR") {
    return { code: "shadow-server-error", severity: "error", detail: "影子服务返回不可继续的执行错误" };
  }
  if (code === "SHADOW_TURN_FAILED") {
    return { code: "shadow-turn-failed", severity: "error", detail: "影子回合没有正常完成" };
  }
  const message = String(error?.message || "");
  if (/JSON|不是有效/u.test(message)) {
    return { code: "shadow-invalid-json", severity: "error", detail: "影子结果不是有效的结构化 JSON" };
  }
  if (/身份|Skill.*(?:版本|哈希)|版本.*Skill|哈希.*Skill/iu.test(message)) {
    return { code: "shadow-identity-mismatch", severity: "error", detail: "影子结果与固定 Skill 身份不一致" };
  }
  if (/current-user|证据|摘录|来源/iu.test(message)) {
    return { code: "shadow-invalid-evidence", severity: "error", detail: "影子结果没有通过引用与证据边界校验" };
  }
  if (/字段|findings|decisionImpact|calibration|novelty|utility|不适用|认知透镜结果|动机主张|主张类型|认识状态|议题键|置信度|时间尺度|立场/iu.test(message)) {
    return { code: "shadow-invalid-contract", severity: "error", detail: "影子结果没有通过认知透镜字段协议" };
  }
  if (/超过安全上限/u.test(message)) {
    return { code: "shadow-output-limit", severity: "error", detail: "影子输出超过安全上限" };
  }
  if (/禁止|审批|工具/u.test(message)) {
    return { code: "shadow-prohibited-action", severity: "error", detail: "影子执行触发了禁止的工具或审批" };
  }
  return { code: "shadow-execution-failed", severity: "error", detail: "影子执行或结果校验失败" };
}

function failureComparison({
  caseId,
  domain,
  fingerprint,
  createdAt,
  legacy,
  shadowSkill,
  expectedDimensions,
  error,
}) {
  const legacyCoverage = coverage(legacy.outputText, expectedDimensions);
  const legacyInfo = legacyRecord(legacy);
  return {
    version: 1,
    comparisonId: comparisonId(caseId, fingerprint, createdAt),
    caseId: boundedText(caseId, 100),
    domain: boundedText(domain, 80) || "unspecified",
    createdAt,
    inputFingerprint: fingerprint,
    status: "shadow-failed",
    legacy: { summary: legacyInfo.summary },
    shadow: {
      summary: "",
      applicable: null,
      findingCount: 0,
      skillId: boundedText(shadowSkill?.skillId, 128),
      skillVersion: boundedText(shadowSkill?.skillVersion, 64),
      contentHash: /^sha256:[0-9a-f]{64}$/u.test(shadowSkill?.contentHash)
        ? shadowSkill.contentHash : "",
    },
    routing: routeComparison(legacyInfo.route, { operatorIds: [], skillIds: [] }),
    completeness: {
      expectedDimensions,
      legacy: legacyCoverage,
      shadow: { covered: [], missing: [...expectedDimensions], ratio: expectedDimensions.length ? 0 : 1 },
      delta: expectedDimensions.length ? -legacyCoverage.ratio : 0,
    },
    cost: {
      legacy: legacyInfo.cost,
      shadow: { tokenUsage: null, latencyMs: null, outputChars: 0 },
      tokenDelta: null,
      latencyDeltaMs: null,
    },
    issues: [safeFailureIssue(error)],
  };
}

async function runCognitiveLensShadowComparison({
  caseId = "shadow-case",
  domain = "unspecified",
  input,
  currentUserMessageId = null,
  legacyResult,
  shadowSkill,
  expectedDimensions = [],
  evidenceTextsBySourceId = {},
  executeShadow,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("影子评测输入为空或超过安全上限");
  }
  if (!legacyResult || typeof legacyResult !== "object" || Array.isArray(legacyResult)
    || typeof legacyResult.outputText !== "string") {
    throw new Error("影子评测缺少旧规则输出");
  }
  const fingerprint = inputFingerprint(input);
  const createdAt = String(now());
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("影子评测时间无效");
  const expected = dimensions(expectedDimensions);
  const productionOutput = legacyResult.outputText;
  try {
    if (typeof executeShadow !== "function") throw new Error("没有影子执行器");
    if (!shadowSkill || typeof shadowSkill !== "object" || Array.isArray(shadowSkill)) {
      throw new Error("没有影子 Skill 身份");
    }
    const request = deepFreeze({
      mode: "cognitive-lens-shadow",
      input,
      inputFingerprint: fingerprint,
      currentUserMessageId: boundedText(currentUserMessageId, 128),
      skill: cloneJson(shadowSkill),
      expectedDimensions: [...expected],
      allowedToolIds: [],
      networkAccess: false,
      knowledgeWrite: false,
      affectsFinalAnswer: false,
    });
    const rawShadow = await executeShadow(request);
    if (!rawShadow || typeof rawShadow !== "object" || Array.isArray(rawShadow)) {
      throw new Error("影子执行结果无效");
    }
    const parsed = parseCognitiveLensResult(rawShadow.lensResult, {
      expectedSkillId: shadowSkill.skillId,
      expectedSkillVersion: shadowSkill.skillVersion,
      expectedContentHash: shadowSkill.contentHash,
      currentUserMessageId,
      currentUserText: input,
    });
    const legacyInfo = legacyRecord(legacyResult);
    const shadowText = typeof rawShadow.outputText === "string"
      ? rawShadow.outputText : shadowSummary(parsed);
    const shadowCost = costRecord({ ...rawShadow, outputText: shadowText });
    const legacyCoverage = coverage(legacyResult.outputText, expected);
    const shadowCoverage = coverage(
      `${shadowText}\n${structuredDimensionSignals(parsed).join("\n")}`,
      expected,
    );
    const issues = [
      ...shadowCoverage.missing.map((dimension) => ({
        code: "missing-dimension",
        severity: "warning",
        detail: `影子结果缺少评测维度：${dimension}`,
      })),
      ...duplicateIssues(parsed),
      ...factEvidenceIssues(parsed, evidenceTextsBySourceId),
    ];
    if (shadowCost.outputChars > Math.max(legacyInfo.cost.outputChars * 1.8, legacyInfo.cost.outputChars + 600)
      && shadowCoverage.covered.length <= legacyCoverage.covered.length) {
      issues.push({
        code: "unnecessary-expansion",
        severity: "warning",
        detail: "影子输出明显增长，但没有覆盖更多评测维度",
      });
    }
    const shadowRoute = normalizeRoute(rawShadow.route || {
      operatorIds: [],
      skillIds: [shadowSkill.skillId],
    });
    const comparison = {
      version: 1,
      comparisonId: comparisonId(caseId, fingerprint, createdAt),
      caseId: boundedText(caseId, 100),
      domain: boundedText(domain, 80) || "unspecified",
      createdAt,
      inputFingerprint: fingerprint,
      status: issues.length ? "review" : "passed",
      legacy: { summary: legacyInfo.summary },
      shadow: {
        summary: shadowSummary(parsed),
        applicable: parsed.applicable,
        findingCount: parsed.findings.length,
        skillId: parsed.skillId,
        skillVersion: parsed.skillVersion,
        contentHash: parsed.contentHash,
      },
      routing: routeComparison(legacyInfo.route, shadowRoute),
      completeness: {
        expectedDimensions: expected,
        legacy: legacyCoverage,
        shadow: shadowCoverage,
        delta: shadowCoverage.ratio - legacyCoverage.ratio,
      },
      cost: {
        legacy: legacyInfo.cost,
        shadow: shadowCost,
        tokenDelta: difference(
          legacyInfo.cost.tokenUsage?.totalTokens,
          shadowCost.tokenUsage?.totalTokens,
        ),
        latencyDeltaMs: difference(legacyInfo.cost.latencyMs, shadowCost.latencyMs),
      },
      issues,
    };
    return deepFreeze({ productionOutput, comparison });
  } catch (error) {
    const comparison = failureComparison({
      caseId,
      domain,
      fingerprint,
      createdAt,
      legacy: legacyResult,
      shadowSkill,
      expectedDimensions: expected,
      error,
    });
    return deepFreeze({ productionOutput, comparison });
  }
}

function restoredCoverage(value, expectedDimensions) {
  const coveredIds = new Set(dimensions(value?.covered).filter((item) => (
    expectedDimensions.includes(item)
  )));
  const covered = expectedDimensions.filter((item) => coveredIds.has(item));
  const missing = expectedDimensions.filter((item) => !coveredIds.has(item));
  return {
    covered,
    missing,
    ratio: expectedDimensions.length ? covered.length / expectedDimensions.length : 1,
  };
}

function restoredCost(value) {
  return {
    tokenUsage: normalizeTokenUsage(value?.tokenUsage),
    latencyMs: exactDuration(value?.latencyMs),
    outputChars: Number.isSafeInteger(value?.outputChars) && value.outputChars >= 0
      ? value.outputChars : 0,
  };
}

function restoredComparison(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || typeof value.comparisonId !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(value.inputFingerprint)
    || !["passed", "review", "shadow-failed"].includes(value.status)
    || !Number.isFinite(Date.parse(value.createdAt))) return null;
  try {
    const expectedDimensions = dimensions(value.completeness?.expectedDimensions);
    const legacyCoverage = restoredCoverage(value.completeness?.legacy, expectedDimensions);
    const shadowCoverage = restoredCoverage(value.completeness?.shadow, expectedDimensions);
    const legacyCost = restoredCost(value.cost?.legacy);
    const shadowCost = restoredCost(value.cost?.shadow);
    const routing = routeComparison(
      normalizeRoute(value.routing?.legacy),
      normalizeRoute(value.routing?.shadow),
    );
    const issues = (Array.isArray(value.issues) ? value.issues : []).slice(0, 100).map((item) => ({
      code: boundedText(item?.code, 80),
      severity: ["info", "warning", "error"].includes(item?.severity)
        ? item.severity : "warning",
      detail: boundedText(item?.detail, 300),
    })).filter((item) => item.code && item.detail);
    const applicable = typeof value.shadow?.applicable === "boolean"
      ? value.shadow.applicable : null;
    const findingCount = Number.isSafeInteger(value.shadow?.findingCount)
      && value.shadow.findingCount >= 0 && value.shadow.findingCount <= 1_000
      ? value.shadow.findingCount : 0;
    return {
      version: 1,
      comparisonId: boundedText(value.comparisonId, 180),
      caseId: boundedText(value.caseId, 100),
      domain: boundedText(value.domain, 80) || "unspecified",
      createdAt: new Date(Date.parse(value.createdAt)).toISOString(),
      inputFingerprint: value.inputFingerprint,
      status: value.status,
      legacy: { summary: boundedText(value.legacy?.summary) },
      shadow: {
        summary: boundedText(value.shadow?.summary),
        applicable,
        findingCount,
        skillId: boundedText(value.shadow?.skillId, 128),
        skillVersion: boundedText(value.shadow?.skillVersion, 64),
        contentHash: /^sha256:[0-9a-f]{64}$/u.test(value.shadow?.contentHash)
          ? value.shadow.contentHash : "",
      },
      routing,
      completeness: {
        expectedDimensions,
        legacy: legacyCoverage,
        shadow: shadowCoverage,
        delta: shadowCoverage.ratio - legacyCoverage.ratio,
      },
      cost: {
        legacy: legacyCost,
        shadow: shadowCost,
        tokenDelta: difference(
          legacyCost.tokenUsage?.totalTokens,
          shadowCost.tokenUsage?.totalTokens,
        ),
        latencyDeltaMs: difference(legacyCost.latencyMs, shadowCost.latencyMs),
      },
      issues,
    };
  } catch {
    return null;
  }
}

function restoreCognitiveLensShadowDiagnostics(values) {
  return (Array.isArray(values) ? values : [])
    .map(restoredComparison)
    .filter(Boolean)
    .slice(-MAX_SHADOW_DIAGNOSTICS)
    .map(cloneJson);
}

function recentCognitiveLensShadowDiagnostics(values, item) {
  const next = restoreCognitiveLensShadowDiagnostics(values);
  const normalized = restoreCognitiveLensShadowDiagnostics([item])[0];
  if (!normalized) return next;
  const index = next.findIndex((entry) => entry.comparisonId === normalized.comparisonId);
  if (index >= 0) next[index] = normalized;
  else next.push(normalized);
  return next.slice(-MAX_SHADOW_DIAGNOSTICS);
}

module.exports = {
  inputFingerprint,
  recentCognitiveLensShadowDiagnostics,
  restoreCognitiveLensShadowDiagnostics,
  runCognitiveLensShadowComparison,
};
