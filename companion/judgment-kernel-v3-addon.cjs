"use strict";

const { randomUUID } = require("node:crypto");
const {
  JUDGMENT_KERNEL_VERSION,
  applyDerivedState,
  createDecisionSnapshot,
  evaluateDecisionRecord,
  runKernelSelfCheck,
} = require("./decision-kernel.cjs");
const { parseDecisionRecord } = require("./decision-record-schema.cjs");
const {
  createActionBinding,
  createFeedbackObservation,
  validateActionBindingAgainstSnapshot,
  validateFeedbackAgainstAction,
} = require("./decision-action-feedback.cjs");
const { buildDecisionRecordFromEnvelope, buildModelCandidatePrompt, evidenceCatalogFromConversation } = require("./decision-candidate-envelope.cjs");
const { STATUS_ORDER, advanceEvidenceStatus, decisionEvidenceReport } = require("./decision-evidence-bridge.cjs");
const { aggregateMetrics, createMetricEvent, DEFAULT_SETTINGS, normalizeSettings } = require("./decision-runtime-governance.cjs");
const { detectLegacyCognitiveRecord, legacyReadOnlySummary } = require("./decision-legacy-compat.cjs");
const { runDecisionLifecycleSimulation } = require("./decision-runtime-e2e.cjs");

const RECORD_ROOT = "06_判断与决策/决策记录";
const SNAPSHOT_ROOT = `${RECORD_ROOT}/_快照`;
const REVIEW_ROOT = `${RECORD_ROOT}/_复审候选`;
const ACTION_ROOT = "07_行动/判断验证";
const FEEDBACK_ROOT = "08_结果与反馈/判断反馈";
const SYSTEM_ROOT = "00_系统/判断内核";
const SETTINGS_PATH = `${SYSTEM_ROOT}/V3运行设置.json`;
const METRICS_PATH = `${SYSTEM_ROOT}/V3运行指标.json`;

function nowIso() { return new Date().toISOString(); }
function shortId(prefix) { return `${prefix}_${randomUUID().replace(/-/gu, "").slice(0, 20)}`; }
function cleanLine(value, maximum = 4000) { return String(value || "").replace(/\0/gu, "").trim().slice(0, maximum); }
function markdownText(value) {
  return cleanLine(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_{}\[\]!]/gu, "\\$&");
}
function listLines(value) {
  return [...new Set(String(value || "").split(/\r?\n/gu).map((item) => item.replace(/^\s*[-*]\s*/u, "").trim()).filter(Boolean))].slice(0, 40);
}

function decisionTitle(question) {
  let value = cleanLine(question, 200)
    .replace(/^(?:我想问一下|我想知道|请问|请帮我|帮我看看|关于|就是|那个|现在|目前)[，,：:\s]*/u, "")
    .replace(/[？?！!。；;：:\/\\|<>"'*`]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const stop = new Set(["是否", "应该", "怎么", "如何", "可以", "能够", "一个", "这个", "那个", "问题", "进行", "需要"]);
  const chunks = value.split(/[，,、\s]+/u).filter((item) => item && !stop.has(item));
  if (chunks.length > 1) value = chunks.slice(0, 4).join("·");
  value = value.slice(0, 28).trim();
  return value || "待判断事项";
}

function safeFilename(value) {
  return decisionTitle(value).replace(/[\\/:*?"<>|#\[\]^]/gu, "-").replace(/[.\s]+$/gu, "").slice(0, 48) || "待判断事项";
}

function displayFindingSource(ref) {
  const stages = { P: "观境", A: "立心", T: "践真", H: "知变" };
  const match = String(ref || "").match(/^PATH_STAGE:([PATH])$/u);
  return match ? `PATH 阶段：${stages[match[1]]}` : `来源引用：${String(ref || "")}`;
}

function jsonBlock(label, value) {
  const body = JSON.stringify(value, null, 2);
  const longestFence = Math.max(0, ...[...body.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${label}\n${body}\n${fence}`;
}

function extractJsonBlock(markdown, label) {
  const source = String(markdown || "");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp("(^|\\n)(`{3,})" + escaped + "\\s*\\n([\\s\\S]*?)\\n\\2(?=\\n|$)", "u"));
  if (!match) throw new Error(`当前文件缺少 ${label} 数据块`);
  return JSON.parse(match[3]);
}

function renderRecord(record) {
  const report = evaluateDecisionRecord(record);
  const optionById = new Map(record.options.map((item) => [item.id, item.label]));
  const claimById = new Map(record.claims.map((item) => [item.id, item]));
  const selected = record.userDecision.selectedOptionRefs.map((id) => optionById.get(id) || id);
  const evidenceLines = record.claims.flatMap((claim) => (claim.evidenceEdges || []).map((edge) =>
    `  - ${edge.relation} · ${edge.status} · ${edge.freshnessAtDecision} · ${markdownText(edge.evidenceId)}${edge.locator ? ` · ${markdownText(edge.locator)}` : ""}`));
  return [
    "---", "type: xingzhi-decision-record", `decision_id: ${record.decisionId}`,
    `schema_version: ${record.decisionRecordSchemaVersion}`, `kernel_version: ${record.judgmentKernelVersion}`,
    `revision: ${record.revision}`, `updated_at: ${nowIso()}`, "---", "",
    `# ${markdownText(decisionTitle(record.frame.question))}`, "", "## 决策问题", "", markdownText(record.frame.question), "",
    `- 时间范围：${markdownText(record.frame.timeHorizon || "尚未确定")}`,
    `- 适用范围：${markdownText(record.frame.scope || "尚未确定")}`,
    `- 准备状态：${report.derivedState.readiness}`, `- 复审状态：${report.derivedState.reviewState}`, "",
    "## 可行选项", "",
    ...(record.options.length ? record.options.flatMap((item) => [
      `- **${markdownText(item.label)}** · ${item.kind} · ${item.availability}`,
      ...(item.outcomes || []).map((line) => `  - 预期结果：${markdownText(line)}`),
      ...(item.riskRefs || []).map((line) => `  - 风险：${markdownText(line)}`),
    ]) : ["- 尚未记录"]), "",
    "## 主张、证据与来源", "",
    ...(record.claims.length ? record.claims.flatMap((claim) => [
      `- **[${claim.epistemicStatus}]** ${markdownText(claim.text)}`,
      ...(claim.sourceFindingRefs || []).map((ref) => `  - ${markdownText(displayFindingSource(ref))}`),
      ...(claim.optionRelations || []).map((relation) => `  - 对选项「${markdownText(optionById.get(relation.optionRef) || relation.optionRef)}」：${relation.relation}`),
      ...(claim.evidenceEdges || []).map((edge) => `  - 证据：${edge.relation} · ${edge.status} · ${edge.freshnessAtDecision} · ${markdownText(edge.evidenceId)}${edge.locator ? ` · ${markdownText(edge.locator)}` : ""}`),
    ]) : ["- 尚未记录"]), "",
    "## 门槛与待确认条件", "",
    ...(record.gates.length ? record.gates.map((gate) => `- [${gate.status}] ${gate.type}：${markdownText(gate.reason)}${gate.sourceRefs.length ? `（来源：${gate.sourceRefs.map((id) => markdownText(claimById.get(id)?.text || id)).join("；")}）` : ""}`) : ["- 尚未记录"]), "",
    "## 模型建议与用户决定", "",
    `- 模型建议（候选）：${record.modelRecommendation.optionRefs.map((id) => markdownText(optionById.get(id) || id)).join("、") || "无"}`,
    `- 建议依据：${record.modelRecommendation.basisRefs.map((id) => markdownText(claimById.get(id)?.text || id)).join("；") || "未提供"}`,
    `- 用户决定：${record.userDecision.confirmedAt ? `${record.userDecision.mode} · ${selected.join("、") || "未选择具体选项"}` : "尚未确认"}`,
    `- 用户理由：${markdownText(record.userDecision.rationale || "尚未填写")}`,
    `- 用户条件：${record.userDecision.conditions.map(markdownText).join("；") || "尚未填写"}`, "",
    "## 系统派生提示", "", ...(report.derivedState.reasonCodes.length ? report.derivedState.reasonCodes.map((code) => `- ${code}`) : ["- 当前没有派生警告"]), "",
    `- 证据状态：${JSON.stringify(decisionEvidenceReport(record).counts)}`, "",
    "> 模型建议、用户决定和系统派生状态彼此独立。证据失效只触发复审，不改写已确认快照。", "",
    jsonBlock("xingzhi-decision-record", record), "",
  ].join("\n");
}

function renderSnapshot(snapshot) {
  const record = snapshot.record;
  const optionById = new Map(record.options.map((item) => [item.id, item.label]));
  return [
    "---", "type: xingzhi-decision-snapshot", `snapshot_id: ${snapshot.snapshotId}`,
    `decision_id: ${snapshot.decisionId}`, `confirmed_at: ${snapshot.confirmedAt}`, "immutable: true", "---", "",
    `# 判断快照 · ${markdownText(decisionTitle(record.frame.question))}`, "",
    `- 用户决定：${record.userDecision.mode}`,
    `- 选择：${record.userDecision.selectedOptionRefs.map((id) => optionById.get(id) || id).join("、") || "无具体选项"}`,
    `- 理由：${markdownText(record.userDecision.rationale || "未填写")}`,
    `- 替代快照：${snapshot.supersedes || "无"}`, "",
    "> 本文件为用户确认时的不可变快照。之后的证据与反馈生成新的复审候选，不覆盖本文件。", "",
    jsonBlock("xingzhi-decision-snapshot", snapshot), "",
  ].join("\n");
}

function renderAction(binding) {
  return [
    "---", "type: xingzhi-decision-action", `action_id: ${binding.actionId}`,
    `decision_snapshot_id: ${binding.decisionSnapshotId}`, `created_at: ${binding.createdAt}`, "---", "",
    `# 判断验证行动 · ${markdownText(binding.action)}`, "", `- 行动：${markdownText(binding.action)}`,
    `- 验证类型：${binding.testType}`, `- 预期信号：${markdownText(binding.expectedSignal || "尚未填写")}`,
    `- 失败信号：${markdownText(binding.failureSignal || "尚未填写")}`, `- 观察窗口：${markdownText(binding.observationWindow || "尚未填写")}`,
    `- 精确绑定：${binding.optionRefs.length + binding.claimRefs.length + binding.assumptionRefs.length} 个快照目标`, "",
    jsonBlock("xingzhi-action-binding", binding), "",
  ].join("\n");
}

function renderFeedback(observation) {
  return [
    "---", "type: xingzhi-decision-feedback", `observation_id: ${observation.observationId}`,
    `action_id: ${observation.actionId}`, `decision_snapshot_id: ${observation.decisionSnapshotId}`, "---", "",
    `# 判断反馈 · ${markdownText(observation.observation)}`, "", `- 实际行动：${markdownText(observation.actualAction)}`,
    `- 实际观察：${markdownText(observation.observation)}`, `- 作用目标：${observation.targetType} · ${observation.targetRef}`,
    `- 校准状态：${observation.calibration}`, `- 校准依据：${markdownText(observation.rationale || "尚未评估")}`,
    "", "> 反馈只生成复审候选，不自动改写用户决定或原判断快照。", "",
    jsonBlock("xingzhi-feedback-observation", observation), "",
  ].join("\n");
}

function renderReviewCandidate(observation, snapshot) {
  const candidate = {
    reviewCandidateSchemaVersion: 1,
    status: "pending-user-review",
    decisionId: snapshot.decisionId,
    decisionSnapshotId: snapshot.snapshotId,
    actionId: observation.actionId,
    observationId: observation.observationId,
    calibration: observation.calibration,
    targetType: observation.targetType,
    targetRef: observation.targetRef,
    proposedNextStep: "由用户审查反馈后决定是否创建新修订；系统不会自动改写用户决定。",
  };
  return ["---", "type: xingzhi-decision-review-candidate", `decision_id: ${snapshot.decisionId}`, `snapshot_id: ${snapshot.snapshotId}`, `observation_id: ${observation.observationId}`, "---", "", "# 判断复审候选", "", `- 当前状态：${candidate.status}`, `- 触发反馈：${observation.observationId}`, `- 反馈目标：${observation.targetType} · ${observation.targetRef}`, `- 下一步：${candidate.proposedNextStep}`, "", jsonBlock("xingzhi-review-candidate", candidate), ""].join("\n");
}

async function ensureFolder(vault, path) {
  let current = "";
  for (const part of path.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) {
      try { await vault.createFolder(current); } catch (error) {
        if (!vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
}

async function uniquePath(vault, root, stem) {
  const date = new Date().toISOString().slice(0, 10);
  const base = `${root}/${date}-${safeFilename(stem)}`;
  if (!vault.getAbstractFileByPath(`${base}.md`)) return `${base}.md`;
  for (let index = 2; index < 1000; index += 1) if (!vault.getAbstractFileByPath(`${base}-${index}.md`)) return `${base}-${index}.md`;
  return `${base}-${Date.now()}.md`;
}

async function openFile(app, file) {
  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file);
}

function addField(contentEl, label, { multiline = false, value = "", placeholder = "" } = {}) {
  const row = contentEl.createDiv({ cls: "xz-jk-field" });
  row.createEl("label", { text: label });
  const input = multiline ? row.createEl("textarea", { attr: { rows: "4", placeholder } }) : row.createEl("input", { attr: { type: "text", placeholder } });
  input.value = value;
  return input;
}

function addSelect(contentEl, label, options, value = "") {
  const row = contentEl.createDiv({ cls: "xz-jk-field" });
  row.createEl("label", { text: label });
  const select = row.createEl("select");
  for (const [key, title] of options) select.createEl("option", { text: title, attr: { value: key } });
  if (options.length) select.value = value || options[0][0];
  else { select.createEl("option", { text: "没有可用项目", attr: { value: "" } }); select.disabled = true; }
  return select;
}

function addSwitch(contentEl, label, checked, detail) {
  const row = contentEl.createDiv({ cls: "xz-jk-setting" });
  const input = row.createEl("input", { attr: { type: "checkbox" } });
  input.checked = checked;
  const body = row.createDiv({ cls: "xz-jk-setting-copy" });
  body.createEl("strong", { text: label });
  body.createEl("small", { text: detail });
  return input;
}

function defaultRecord(input, existing = null) {
  const question = cleanLine(input.question, 1000);
  const optionLabels = listLines(input.options);
  const unknowns = listLines(input.unknowns);
  const decisionId = existing?.decisionId || shortId("dec");
  const existingOptionByLabel = new Map((existing?.options || []).map((item) => [item.label, item]));
  const existingClaimByText = new Map((existing?.claims || []).filter((item) => item.epistemicStatus === "unknown").map((item) => [item.text, item]));
  const options = optionLabels.map((label, index) => ({
    id: existingOptionByLabel.get(label)?.id || shortId("opt"), label,
    kind: index === optionLabels.length - 1 && /暂缓|延期/u.test(label) ? "defer" : "candidate",
    availability: "available", outcomes: [], riskRefs: [], assumptionRefs: [],
  }));
  const optionIds = new Set(options.map((item) => item.id));
  const preservedClaims = (existing?.claims || []).filter((item) => item.epistemicStatus !== "unknown").map((item) => ({
    ...JSON.parse(JSON.stringify(item)),
    optionRelations: (item.optionRelations || []).filter((relation) => optionIds.has(relation.optionRef)),
  }));
  const unknownClaims = unknowns.map((item) => ({
    id: existingClaimByText.get(item)?.id || shortId("clm"), text: item, epistemicStatus: "unknown",
    evidenceEdges: [], assumptionRefs: [], optionRelations: [], sourceFindingRefs: [],
  }));
  const claims = [...preservedClaims, ...unknownClaims];
  const claimIds = new Set(claims.map((item) => item.id));
  for (const claim of claims) claim.assumptionRefs = (claim.assumptionRefs || []).filter((id) => claimIds.has(id));
  for (const option of options) {
    const previous = existingOptionByLabel.get(option.label);
    if (!previous) continue;
    option.kind = previous.kind;
    option.availability = previous.availability;
    option.outcomes = [...(previous.outcomes || [])];
    option.riskRefs = (previous.riskRefs || []).filter((id) => claimIds.has(id));
    option.assumptionRefs = (previous.assumptionRefs || []).filter((id) => claimIds.has(id));
  }
  return {
    decisionRecordSchemaVersion: 1, judgmentKernelVersion: JUDGMENT_KERNEL_VERSION,
    decisionId, revision: (existing?.revision || 0) + 1,
    snapshotRefs: [...(existing?.snapshotRefs || [])], activeSnapshotId: existing?.activeSnapshotId || null,
    frame: { question, subjectRef: existing?.frame?.subjectRef || "user.current", goalRefs: [], timeHorizon: cleanLine(input.timeHorizon, 240) || null, scope: cleanLine(input.scope, 1000) || null },
    options, claims,
    gates: (existing?.gates || []).map((gate) => ({ ...JSON.parse(JSON.stringify(gate)), sourceRefs: (gate.sourceRefs || []).filter((id) => claimIds.has(id)) })),
    modelRecommendation: existing?.modelRecommendation ? {
      ...existing.modelRecommendation,
      optionRefs: existing.modelRecommendation.optionRefs.filter((id) => optionIds.has(id)),
      basisRefs: existing.modelRecommendation.basisRefs.filter((id) => claimIds.has(id)),
    } : { status: "candidate", optionRefs: [], basisRefs: [] },
    userDecision: { mode: "defer", selectedOptionRefs: [], rationale: "", conditions: [], confirmedAt: null },
    derivedState: { readiness: "draft", reviewState: "current", reasonCodes: [] },
  };
}

function parseRecordMarkdown(markdown) {
  const parsed = parseDecisionRecord(extractJsonBlock(markdown, "xingzhi-decision-record"));
  if (!parsed.ok) throw new Error(parsed.errors.map((item) => `${item.path}: ${item.message}`).slice(0, 6).join("；"));
  return parsed.value;
}

async function updateRecordWithRevision(vault, file, expectedRevision, updater) {
  if (typeof vault.process !== "function") throw new Error("当前 Obsidian Vault 不支持安全的并发版本更新；为避免覆盖，操作已停止。");
  let result = null;
  await vault.process(file, (currentText) => {
    const current = parseRecordMarkdown(currentText);
    if (current.revision !== expectedRevision) throw new Error(`判断记录已被其他操作更新（当前修订 ${current.revision}，你打开的是 ${expectedRevision}）；请重新打开后操作。`);
    const next = updater(current);
    if (!next || next.decisionId !== current.decisionId || next.revision !== current.revision + 1) throw new Error("更新没有按预期推进判断记录修订号。");
    const applied = applyDerivedState(next);
    if (!applied.ok) throw new Error(applied.errors.map((item) => `${item.path}: ${item.message}`).slice(0, 6).join("；"));
    result = applied.value;
    return renderRecord(applied.value);
  });
  if (!result) throw new Error("判断记录更新没有返回结果。");
  return result;
}

async function commitSnapshotTransaction(vault, { recordFile, expectedRevision, snapshotPath, snapshot, buildRecord }) {
  const snapshotFile = await vault.create(snapshotPath, renderSnapshot(snapshot));
  try {
    const record = await updateRecordWithRevision(vault, recordFile, expectedRevision, (current) => buildRecord(current, snapshot));
    return { snapshotFile, record };
  } catch (error) {
    let referenced = false;
    try {
      const latest = parseRecordMarkdown(await vault.read(recordFile));
      referenced = latest.snapshotRefs.includes(snapshot.snapshotId) || latest.activeSnapshotId === snapshot.snapshotId;
    } catch {}
    if (!referenced) {
      try { await vault.delete(snapshotFile, true); }
      catch (cleanupError) { console.error("[行知 Judgment Kernel V3] snapshot compensation failed", cleanupError); }
    }
    throw error;
  }
}

async function readJson(vault, path, fallback) {
  const file = vault.getAbstractFileByPath(path);
  if (!file) return fallback;
  try { return JSON.parse(await vault.read(file)); }
  catch { throw new Error(`无法读取运行设置或指标文件：${path}`); }
}

async function writeJson(vault, path, value) {
  await ensureFolder(vault, path.split("/").slice(0, -1).join("/"));
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const file = vault.getAbstractFileByPath(path);
  if (file) await vault.modify(file, content);
  else await vault.create(path, content);
}

async function findSnapshot(vault, snapshotId) {
  const files = vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${SNAPSHOT_ROOT}/`));
  for (const file of files) {
    try {
      const value = extractJsonBlock(await vault.read(file), "xingzhi-decision-snapshot");
      if (value?.snapshotId === snapshotId) return { file, value };
    } catch {}
  }
  throw new Error(`找不到判断快照：${snapshotId}`);
}

function sourceContext(conversation) {
  const messages = (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .filter((message) => message && message.internal !== true && ["user", "assistant"].includes(message.role) && cleanLine(message.content))
    .slice(-16);
  const allowedLensIds = [...new Set(messages.flatMap((message) => Array.isArray(message.capabilityTrace?.lenses)
    ? message.capabilityTrace.lenses.map((lens) => cleanLine(lens?.id, 128)).filter(Boolean) : []))];
  const pathUserIds = new Set(messages.filter((message) => {
    const snapshots = Array.isArray(message.skillSnapshots) ? message.skillSnapshots : [];
    return snapshots.some((snapshot) => /xingzhi-path-runtime/u.test(String(snapshot?.name || snapshot?.id || snapshot?.skillId || "")))
      || (Array.isArray(message.capabilityTrace?.skills) && message.capabilityTrace.skills.some((skill) => /xingzhi-path-runtime/u.test(String(skill?.id || ""))));
  }).map((message) => String(message.id || "")));
  const pathSourceMessageIds = messages.filter((message) => pathUserIds.has(String(message.id || ""))
    || (message.role === "assistant" && pathUserIds.has(String(message.sourceMessageId || ""))))
    .map((message) => String(message.id || ""));
  return {
    messages,
    sourceMessageIds: messages.map((message) => String(message.id || "")).filter(Boolean),
    allowedLensIds,
    pathSourceMessageIds,
    evidenceCatalog: evidenceCatalogFromConversation(conversation),
  };
}

function install(plugin, obsidian) {
  const { Modal, Notice } = obsidian;
  const app = plugin.app;
  let settings = normalizeSettings(DEFAULT_SETTINGS);
  let settingsReady = Promise.resolve();

  function notify(message) { try { new Notice(message); } catch {} }
  async function loadSettings() {
    settingsReady = (async () => {
      try {
        const stored = await readJson(app.vault, SETTINGS_PATH, DEFAULT_SETTINGS);
        settings = normalizeSettings(stored);
      } catch (error) {
        settings = normalizeSettings(DEFAULT_SETTINGS);
        console.warn("[行知 Judgment Kernel V3] invalid settings; using in-memory defaults without overwriting the source", error);
        notify("Judgment Kernel V3 设置文件无法读取；本次使用默认值，原文件未改动。请检查设置 JSON 后重试。");
      }
      return settings;
    })();
    return settingsReady;
  }
  async function requireReady() { await settingsReady; }
  async function saveSettings(next) {
    settings = normalizeSettings(next);
    await writeJson(app.vault, SETTINGS_PATH, settings);
    return settings;
  }
  async function metric(type, payload = {}) {
    try {
      const stored = await readJson(app.vault, METRICS_PATH, { schemaVersion: 1, events: [] });
      const events = Array.isArray(stored?.events) ? stored.events.slice(-2999) : [];
      events.push(createMetricEvent(type, payload));
      await writeJson(app.vault, METRICS_PATH, { schemaVersion: 1, events });
    } catch (error) { console.warn("[行知 Judgment Kernel V3] metric write failed", error); }
  }
  function guardPersistentOperation() {
    const runtime = plugin.workbenchRuntime;
    if (!runtime || typeof runtime._assertKnowledgeWritable !== "function") {
      throw new Error("当前知识库可写保护接口不可用；判断记录写入已停止。请升级主插件后重试。");
    }
    runtime._assertKnowledgeWritable();
    if (typeof plugin.requireCommercialLicense !== "function") {
      throw new Error("当前商业授权检查接口不可用；判断记录写入已停止。请升级主插件后重试。");
    }
    plugin.requireCommercialLicense();
    const permissionModes = [
      runtime.state?.settings?.permissionMode,
      runtime.activeConversation?.permissionMode,
    ];
    const knownPermissionModes = new Set(["read-only", "confirm-write", "auto-write"]);
    if (permissionModes.some((mode) => !knownPermissionModes.has(mode))) {
      throw new Error("当前全局或对话权限状态不可确认；判断记录写入已停止。");
    }
    if (permissionModes.includes("read-only")) {
      throw new Error("当前为只读模式，不能写入正式判断记录。");
    }
    if (settings.persistence !== true) throw new Error("判断记录持久化已关闭；当前只允许预览和校验。");
    if (settings.shadowMode === true) throw new Error("影子模式已开启；本轮候选只用于校验，不写入正式判断记录。");
  }
  function guardExistingWrite() {
    guardPersistentOperation();
    if (settings.existingRecordsReadOnly === true) throw new Error("已有判断记录只读开关已开启；可以查看，不能修改、确认、加行动或反馈。");
  }

  class DecisionEditorModal extends Modal {
    constructor(recordFile = null, existing = null) { super(app); this.recordFile = recordFile; this.existing = existing; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal");
      root.createEl("h2", { text: this.existing ? "修改判断候选" : "手动新建判断记录 V3" });
      root.createEl("p", { text: "这里只保存工作候选。用户决定、快照和现实反馈需要单独确认。" });
      const question = addField(root, "中性决策问题", { multiline: true, value: this.existing?.frame?.question || "", placeholder: "例如：未来 30 天是否投入资源验证这个方向？" });
      const options = addField(root, "可行选项（每行一个）", { multiline: true, value: (this.existing?.options || []).map((item) => item.label).join("\n"), placeholder: "方案 A\n方案 B\n暂缓并继续观察" });
      const unknowns = addField(root, "会改变判断的关键未知（每行一个）", { multiline: true, value: (this.existing?.claims || []).filter((item) => item.epistemicStatus === "unknown").map((item) => item.text).join("\n") });
      const horizon = addField(root, "时间范围", { value: this.existing?.frame?.timeHorizon || "" });
      const scope = addField(root, "适用范围", { value: this.existing?.frame?.scope || "" });
      const actions = root.createDiv({ cls: "xz-jk-actions" });
      const save = actions.createEl("button", { text: "保存候选", cls: "mod-cta" });
      actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await requireReady();
          guardPersistentOperation();
          const candidate = defaultRecord({ question: question.value, options: options.value, unknowns: unknowns.value, timeHorizon: horizon.value, scope: scope.value }, this.existing);
          if (!candidate.frame.question || candidate.options.length < 2) throw new Error("请填写决策问题，并至少提供两个可行选项");
          const applied = applyDerivedState(candidate);
          if (!applied.ok) throw new Error(applied.errors.map((item) => `${item.path}: ${item.message}`).slice(0, 4).join("；"));
          await ensureFolder(app.vault, RECORD_ROOT);
          let file;
          if (this.recordFile) {
            guardExistingWrite();
            await updateRecordWithRevision(app.vault, this.recordFile, this.existing.revision, () => applied.value);
            file = this.recordFile;
          } else {
            const path = await uniquePath(app.vault, RECORD_ROOT, candidate.frame.question);
            file = await app.vault.create(path, renderRecord(applied.value));
          }
          await metric("candidate.persisted", { counts: { options: applied.value.options.length, findings: applied.value.claims.length } });
          notify("判断候选已保存；尚未形成用户确认快照。");
          this.close(); await openFile(app, file);
        } catch (error) { notify(String(error?.message || error)); save.disabled = false; }
      });
    }
  }

  class CandidatePreviewModal extends Modal {
    constructor(record, context) { super(app); this.record = record; this.context = context; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal");
      root.createEl("h2", { text: "判断候选预览 · 尚未确认" });
      root.createEl("p", { text: this.record.frame.question });
      root.createEl("p", { text: `时间范围：${this.record.frame.timeHorizon || "尚未确定"} · 适用范围：${this.record.frame.scope || "尚未确定"}` });
      root.createEl("p", { text: `来源消息 ${this.context.sourceMessageIds.length} 条 · 实际 PATH 消息 ${this.context.pathSourceMessageIds.length} 条 · 实际透镜 ${this.context.allowedLensIds.length} 个 · 外部证据 ${this.context.evidenceCatalog.length} 条。可见对话与路由轨迹用于候选抽取；隐藏思维链不会读取或保存。` });
      root.createEl("h3", { text: "候选选项" });
      for (const option of this.record.options) root.createEl("p", { text: `${option.label} · ${option.kind} · ${option.availability}` });
      root.createEl("h3", { text: "发现与证据" });
      if (!this.record.claims.length) root.createEl("p", { text: "本轮没有抽取到主张。" });
      for (const claim of this.record.claims) {
        root.createEl("p", { text: `[${claim.epistemicStatus}] ${claim.text}` });
        for (const edge of claim.evidenceEdges) root.createEl("small", { text: `　${edge.relation} · ${edge.status} · ${edge.evidenceId} · ${edge.locator || "无位置"}` });
        for (const ref of claim.assumptionRefs) {
          const assumption = this.record.claims.find((item) => item.id === ref);
          if (assumption) root.createEl("small", { text: `　依赖假设：${assumption.text}` });
        }
        for (const ref of claim.sourceFindingRefs) root.createEl("small", { text: `　${displayFindingSource(ref)}` });
      }
      root.createEl("h3", { text: "门槛与触发条件" });
      if (!this.record.gates.length) root.createEl("p", { text: "本轮没有新增明确门槛。" });
      for (const gate of this.record.gates) root.createEl("p", { text: `[${gate.status}] ${gate.type}：${gate.reason}` });
      root.createEl("h3", { text: "模型建议（候选）" });
      const optionLabels = new Map(this.record.options.map((item) => [item.id, item.label]));
      root.createEl("p", { text: this.record.modelRecommendation.optionRefs.map((id) => optionLabels.get(id)).filter(Boolean).join("、") || "未给出建议" });
      const claimLabels = new Map(this.record.claims.map((item) => [item.id, item.text]));
      root.createEl("p", { text: `建议依据：${this.record.modelRecommendation.basisRefs.map((id) => claimLabels.get(id)).filter(Boolean).join("；") || "未提供"}` });
      root.createEl("p", { text: "保存只会建立待审查记录；必须由你在判断卡中明确确认后才生成快照。" });
      const actions = root.createDiv({ cls: "xz-jk-actions" });
      if (settings.persistence && !settings.shadowMode) {
        const save = actions.createEl("button", { text: "保存为待审候选", cls: "mod-cta" });
        save.addEventListener("click", async () => {
          save.disabled = true;
          try {
            await requireReady(); guardPersistentOperation();
            const path = await uniquePath(app.vault, RECORD_ROOT, this.record.frame.question);
            await ensureFolder(app.vault, RECORD_ROOT);
            const file = await app.vault.create(path, renderRecord(this.record));
            await metric("candidate.persisted", { counts: { options: this.record.options.length, findings: this.record.claims.length } });
            notify("候选已保存。你的决定仍未确认。"); this.close(); await openFile(app, file);
          } catch (error) { notify(String(error?.message || error)); save.disabled = false; }
        });
      } else {
        actions.createEl("span", { text: settings.shadowMode ? "影子模式：不会写入判断记录。" : "持久化关闭：不会写入判断记录。", cls: "xz-jk-muted" });
      }
      actions.createEl("button", { text: "放弃候选" }).addEventListener("click", () => this.close());
    }
  }

  class DecisionCardModal extends Modal {
    constructor(file, record) { super(app); this.file = file; this.record = record; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal");
      const report = evaluateDecisionRecord(this.record);
      root.createEl("h2", { text: decisionTitle(this.record.frame.question) });
      root.createEl("p", { text: this.record.frame.question });
      root.createEl("p", { text: `范围：${this.record.frame.scope || "未限定"} · 时间：${this.record.frame.timeHorizon || "未限定"} · 修订：${this.record.revision}` });
      const status = root.createDiv({ cls: "xz-jk-status" });
      status.createSpan({ text: `准备状态：${report.derivedState.readiness}` }); status.createSpan({ text: `复审状态：${report.derivedState.reviewState}` });
      root.createEl("h3", { text: "可行选项" });
      const optionLabels = new Map(this.record.options.map((item) => [item.id, item.label]));
      const claimLabels = new Map(this.record.claims.map((item) => [item.id, item.text]));
      for (const item of this.record.options) root.createEl("p", { text: `• ${item.label} · ${item.kind} · ${item.availability}${item.outcomes.length ? ` · 预期：${item.outcomes.join("；")}` : ""}${item.riskRefs.length ? ` · 风险：${item.riskRefs.map((id) => claimLabels.get(id) || id).join("；")}` : ""}${item.assumptionRefs.length ? ` · 假设：${item.assumptionRefs.map((id) => claimLabels.get(id) || id).join("；")}` : ""}` });
      root.createEl("h3", { text: "事实、自述、推断、假设、价值与未知" });
      for (const claim of this.record.claims) {
        root.createEl("p", { text: `[${claim.epistemicStatus}] ${claim.text}` });
        for (const ref of claim.sourceFindingRefs) root.createEl("small", { text: `　${displayFindingSource(ref)}` });
        for (const edge of claim.evidenceEdges) root.createEl("small", { text: `　证据：${edge.status} · ${edge.relation} · ${edge.freshnessAtDecision} · ${edge.evidenceId}${edge.locator ? ` · ${edge.locator}` : ""}` });
      }
      root.createEl("h3", { text: "门槛" });
      for (const gate of this.record.gates) root.createEl("p", { text: `[${gate.status}] ${gate.type}：${gate.reason}` });
      root.createEl("h3", { text: "模型建议与已确认决定" });
      root.createEl("p", { text: `模型建议（候选）：${this.record.modelRecommendation.optionRefs.map((id) => optionLabels.get(id) || id).join("、") || "无"}` });
      root.createEl("p", { text: `建议依据：${this.record.modelRecommendation.basisRefs.map((id) => claimLabels.get(id) || id).join("；") || "未提供"}` });
      root.createEl("p", { text: this.record.userDecision.confirmedAt ? `用户决定：${this.record.userDecision.mode} · ${this.record.userDecision.selectedOptionRefs.map((id) => optionLabels.get(id) || id).join("、") || "未选择具体选项"} · ${this.record.userDecision.rationale || "无理由"}` : "用户决定：尚未确认" });
      root.createEl("p", { text: `派生原因：${report.derivedState.reasonCodes.join("、") || "无"}` });
      root.createEl("p", { text: "候选、用户决定和系统派生状态分别呈现。确认只会新建快照，不会让模型替你决定。" });
      const option = addSelect(root, "本次决定的选项", this.record.options.filter((item) => item.availability === "available").map((item) => [item.id, item.label]));
      const rationale = addField(root, "你的理由（必填）", { multiline: true, value: this.record.userDecision.rationale || "" });
      const conditions = addField(root, "确认条件（可选，每行一条）", { multiline: true, value: this.record.userDecision.conditions.join("\n") });
      const actions = root.createDiv({ cls: "xz-jk-actions" });
      const commit = async (mode) => {
        try {
          await requireReady(); guardExistingWrite();
          const current = this.record;
          const at = nowIso();
          if (!cleanLine(rationale.value)) throw new Error("请填写你自己的决定理由；模型建议不能替代该理由。");
          const selected = ["select", "experiment"].includes(mode) ? [option.value] : [];
          const next = { ...current, revision: current.revision + 1, userDecision: { mode, selectedOptionRefs: selected, rationale: cleanLine(rationale.value), conditions: listLines(conditions.value), confirmedAt: at } };
          const derived = applyDerivedState(next);
          if (!derived.ok) throw new Error(derived.errors.map((item) => item.message).join("；"));
          const snapshotId = shortId("snap");
          const created = createDecisionSnapshot(derived.value, { snapshotId, confirmedAt: at, supersedes: current.activeSnapshotId });
          if (!created.ok) throw new Error(created.errors.map((item) => item.message).join("；"));
          await ensureFolder(app.vault, SNAPSHOT_ROOT);
          const snapshotPath = await uniquePath(app.vault, SNAPSHOT_ROOT, `${decisionTitle(next.frame.question)}-${snapshotId.slice(-6)}`);
          await commitSnapshotTransaction(app.vault, {
            recordFile: this.file,
            expectedRevision: current.revision,
            snapshotPath,
            snapshot: created.value,
            buildRecord: (latest) => ({
              ...derived.value,
              snapshotRefs: [...new Set([...latest.snapshotRefs, snapshotId])],
              activeSnapshotId: snapshotId,
            }),
          });
          await metric("record.confirmed", { decisionId: current.decisionId, counts: { revision: next.revision } });
          notify("你的决定已确认，并生成新的不可变判断快照。"); this.close();
          const updated = parseRecordMarkdown(await app.vault.read(this.file)); new DecisionCardModal(this.file, updated).open();
        } catch (error) { notify(String(error?.message || error)); }
      };
      if (!settings.existingRecordsReadOnly) {
        actions.createEl("button", { text: "确认选择并生成快照", cls: "mod-cta" }).addEventListener("click", () => void commit("select"));
        actions.createEl("button", { text: "确认做实验" }).addEventListener("click", () => void commit("experiment"));
        actions.createEl("button", { text: "确认延期" }).addEventListener("click", () => void commit("defer"));
        actions.createEl("button", { text: "确认不再考虑" }).addEventListener("click", () => void commit("decline"));
        actions.createEl("button", { text: "修改候选" }).addEventListener("click", () => { this.close(); new DecisionEditorModal(this.file, this.record).open(); });
      } else root.createEl("p", { text: "已有记录只读开关已开启。" });
      actions.createEl("button", { text: "审查证据" }).addEventListener("click", () => { this.close(); new EvidenceReviewModal(this.file, this.record).open(); });
      if (this.record.activeSnapshotId && this.record.userDecision.confirmedAt && !settings.existingRecordsReadOnly) {
        actions.createEl("button", { text: "创建验证行动" }).addEventListener("click", () => { this.close(); void createActionForRecord(this.record); });
      }
      actions.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    }
  }

  class EvidenceReviewModal extends Modal {
    constructor(file, record) { super(app); this.file = file; this.record = record; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: "审查判断证据" });
      root.createEl("p", { text: "状态只向前推进。每次点击都表示你亲自审查了该来源；系统不会把模型建议当作用户确认。" });
      const controls = [];
      for (const claim of this.record.claims) for (const edge of claim.evidenceEdges || []) {
        const row = root.createDiv({ cls: "xz-jk-evidence-row" });
        row.createEl("strong", { text: claim.text });
        row.createEl("small", { text: `${edge.evidenceId} · ${edge.status} · ${edge.relation} · ${edge.freshnessAtDecision}${edge.locator ? ` · ${edge.locator}` : ""}` });
        const index = STATUS_ORDER.indexOf(edge.status);
        const next = STATUS_ORDER[index + 1];
        if (next) {
          const label = next === "user-confirmed" ? "我已审查并确认采用" : next === "cited" ? "我确认可见回答已引用" : "我确认该证据已用于判断";
          const button = row.createEl("button", { text: label });
          controls.push({ button, claimId: claim.id, evidenceId: edge.evidenceId, next });
        } else row.createEl("span", { text: "已由用户确认" });
      }
      if (!controls.length) root.createEl("p", { text: "当前记录没有可审查的证据，或证据状态已到达用户确认。" });
      for (const item of controls) item.button.addEventListener("click", async () => {
        item.button.disabled = true;
        try {
          await requireReady(); guardExistingWrite();
          const advanced = advanceEvidenceStatus(this.record, [{ claimId: item.claimId, evidenceId: item.evidenceId, status: item.next, explicitlyConfirmedByUser: item.next === "user-confirmed" }]);
          const nextRecord = { ...advanced.value, revision: this.record.revision + 1 };
          await updateRecordWithRevision(app.vault, this.file, this.record.revision, () => nextRecord);
          await metric("evidence.reviewed", { decisionId: this.record.decisionId, counts: { advanced: advanced.changed } });
          this.close(); notify("证据状态已更新；旧快照未改变。");
        } catch (error) { notify(String(error?.message || error)); item.button.disabled = false; }
      });
      root.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    }
  }

  class ActionModal extends Modal {
    constructor(record, snapshot) { super(app); this.record = record; this.snapshot = snapshot; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: "创建判断验证行动" });
      root.createEl("p", { text: `绑定快照：${this.snapshot.snapshotId}。行动目标只能从该快照选择。` });
      const targets = [
        ...this.snapshot.record.options.map((item) => [`option|${item.id}`, `选项：${item.label}`]),
        ...this.snapshot.record.claims.filter((item) => item.epistemicStatus !== "hypothesis").map((item) => [`claim|${item.id}`, `主张：${item.text}`]),
        ...this.snapshot.record.claims.filter((item) => item.epistemicStatus === "hypothesis").map((item) => [`assumption|${item.id}`, `假设：${item.text}`]),
      ];
      const target = addSelect(root, "本行动验证的目标", targets);
      const action = addField(root, "实际要做的行动", { multiline: true });
      const type = addSelect(root, "验证类型", [["experiment", "实验"], ["observation", "观察"], ["research", "研究"], ["conversation", "访谈"], ["execution", "执行"]]);
      const expected = addField(root, "预期信号"); const failure = addField(root, "失败信号"); const window = addField(root, "观察窗口");
      const save = root.createEl("button", { text: "确认并创建行动", cls: "mod-cta" });
      save.addEventListener("click", async () => {
        try {
          await requireReady(); guardExistingWrite();
          const [targetType, targetId] = target.value.split("|");
          const at = nowIso();
          const binding = createActionBinding({
            actionId: shortId("act"), decisionSnapshotId: this.snapshot.snapshotId, decisionId: this.snapshot.decisionId,
            optionRefs: targetType === "option" ? [targetId] : [],
            claimRefs: targetType === "claim" ? [targetId] : [],
            assumptionRefs: targetType === "assumption" ? [targetId] : [],
            testType: type.value, action: action.value, expectedSignal: expected.value, failureSignal: failure.value,
            observationWindow: window.value, createdAt: at, confirmedAt: at,
          });
          validateActionBindingAgainstSnapshot(binding, this.snapshot);
          await ensureFolder(app.vault, ACTION_ROOT);
          const path = await uniquePath(app.vault, ACTION_ROOT, binding.action);
          const file = await app.vault.create(path, renderAction(binding));
          await metric("action.created", { decisionId: binding.decisionId });
          notify("验证行动已创建，并绑定到精确判断快照。"); this.close(); await openFile(app, file);
        } catch (error) { notify(String(error?.message || error)); }
      });
    }
  }

  class FeedbackModal extends Modal {
    constructor(actionBinding, snapshot) { super(app); this.binding = actionBinding; this.snapshot = snapshot; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: "记录判断反馈" });
      root.createEl("p", { text: `行动 ${this.binding.actionId} · 快照 ${this.binding.decisionSnapshotId}` });
      const actual = addField(root, "实际做了什么", { multiline: true, value: this.binding.action });
      const observed = addField(root, "现实发生了什么", { multiline: true });
      const calibration = addSelect(root, "这条反馈说明什么", [["not-assessed", "暂不判断"], ["supported", "支持"], ["weakened", "削弱"], ["falsified", "证伪"], ["uncertain", "仍不确定"]]);
      const rationale = addField(root, "校准依据", { multiline: true });
      const targetRefs = [
        ...this.binding.optionRefs.map((ref) => [`option|${ref}`, `选项 · ${ref}`]),
        ...this.binding.claimRefs.map((ref) => [`claim|${ref}`, `主张 · ${ref}`]),
        ...this.binding.assumptionRefs.map((ref) => [`assumption|${ref}`, `假设 · ${ref}`]),
      ];
      const target = addSelect(root, "反馈作用目标", targetRefs);
      const save = root.createEl("button", { text: "保存反馈并生成复审候选", cls: "mod-cta" });
      save.addEventListener("click", async () => {
        try {
          await requireReady(); guardExistingWrite();
          const at = nowIso(); const [targetType, targetRef] = target.value.split("|");
          const observation = createFeedbackObservation({
            observationId: shortId("obs"), actionId: this.binding.actionId, decisionSnapshotId: this.binding.decisionSnapshotId,
            targetType, targetRef, actualAction: actual.value, observation: observed.value,
            calibration: calibration.value, rationale: rationale.value,
            attribution: { decisionQuality: "unknown", predictionAccuracy: "unknown", executionFidelity: "unknown", environmentShift: "unknown" },
            occurredAt: at, recordedAt: at,
          });
          validateFeedbackAgainstAction(observation, this.binding);
          await ensureFolder(app.vault, FEEDBACK_ROOT); await ensureFolder(app.vault, REVIEW_ROOT);
          const feedbackPath = await uniquePath(app.vault, FEEDBACK_ROOT, observation.observation);
          const feedbackFile = await app.vault.create(feedbackPath, renderFeedback(observation));
          try {
            const reviewPath = await uniquePath(app.vault, REVIEW_ROOT, `复审-${decisionTitle(this.snapshot.record.frame.question)}`);
            await app.vault.create(reviewPath, renderReviewCandidate(observation, this.snapshot));
          } catch (error) {
            try { await app.vault.delete(feedbackFile, true); } catch (cleanupError) { console.error("[行知 Judgment Kernel V3] feedback compensation failed", cleanupError); }
            throw error;
          }
          await metric("feedback.created", { decisionId: this.snapshot.decisionId });
          notify("反馈与复审候选已保存；原始判断和快照未改写。"); this.close(); await openFile(app, feedbackFile);
        } catch (error) { notify(String(error?.message || error)); }
      });
    }
  }

  class SettingsModal extends Modal {
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: "Judgment Kernel V3 设置" });
      root.createEl("p", { text: "三个开关彼此独立。影子模式只运行候选解析与指标记录，不写正式判断记录。" });
      const candidate = addSwitch(root, "候选生成", settings.candidateGeneration, "允许从当前行知对话调用模型生成候选信封。");
      const persistence = addSwitch(root, "正式持久化", settings.persistence, "允许保存候选、确认快照、行动、反馈和复审候选。");
      const readonly = addSwitch(root, "已有记录只读", settings.existingRecordsReadOnly, "仍可打开和检查记录；禁止修改、确认、审查证据、追加行动或反馈。");
      const shadow = addSwitch(root, "影子模式", settings.shadowMode, "候选会展示并统计校验结果，但不会进入正式判断存储。");
      const save = root.createEl("button", { text: "保存设置", cls: "mod-cta" });
      save.addEventListener("click", async () => {
        try { await saveSettings({ candidateGeneration: candidate.checked, persistence: persistence.checked, existingRecordsReadOnly: readonly.checked, shadowMode: shadow.checked }); notify("Judgment Kernel V3 设置已保存。"); this.close(); }
        catch (error) { notify(String(error?.message || error)); }
      });
    }
  }

  class LegacyModal extends Modal {
    constructor(file, markdown, legacy) { super(app); this.file = file; this.markdown = markdown; this.legacy = legacy; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: this.legacy.title });
      root.createEl("p", { text: "这是旧版 cognitiveSchemaVersion 2 认知循环。本界面只读展示，不会转换、保存或改写原文件。" });
      for (const [label, value] of legacyReadOnlySummary(this.legacy).rows) root.createEl("p", { text: `${label}：${value}` });
      root.createEl("p", { text: `原文件：${this.file.path} · 字符数：${this.markdown.length}` });
      root.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    }
  }

  class MetricsModal extends Modal {
    constructor(events) { super(app); this.events = events; }
    onOpen() {
      const root = this.contentEl; root.empty(); root.addClass("xz-jk-modal"); root.createEl("h2", { text: "Judgment Kernel V3 运行指标" });
      const report = aggregateMetrics(this.events);
      root.createEl("p", { text: `事件数：${report.totalEvents} · 失败数：${report.failures} · 平均耗时：${report.averageDurationMs ?? "无记录"} ms` });
      root.createEl("p", { text: `候选解析率：${report.candidateParseRate === null ? "无请求" : `${Math.round(report.candidateParseRate * 100)}%`} · 候选持久化率：${report.candidatePersistenceRate === null ? "无候选" : `${Math.round(report.candidatePersistenceRate * 100)}%`}` });
      for (const [name, count] of Object.entries(report.byType)) root.createEl("p", { text: `${name}：${count}` });
      root.createEl("p", { text: "指标不包含对话正文、提示词、密钥或隐藏思维链。" });
    }
  }

  async function activeFile() {
    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("请先打开对应的行知记录文件");
    return { file, content: await app.vault.read(file) };
  }

  async function activeDecisionRecord() {
    const { file, content } = await activeFile();
    const record = parseRecordMarkdown(content);
    return { file, record };
  }

  async function openDecisionCard() {
    const { file, record } = await activeDecisionRecord();
    await metric("record.opened", { decisionId: record.decisionId });
    new DecisionCardModal(file, record).open();
  }

  async function createActionForRecord(record) {
    await requireReady(); guardExistingWrite();
    if (!record.userDecision.confirmedAt) throw new Error("当前记录尚未由用户确认，不能创建新的验证行动。");
    if (!record.activeSnapshotId) throw new Error("当前记录还没有用户确认快照，不能创建绑定行动。");
    const { value: snapshot } = await findSnapshot(app.vault, record.activeSnapshotId);
    new ActionModal(record, snapshot).open();
  }

  async function recordFeedback() {
    await requireReady(); guardExistingWrite();
    const { content } = await activeFile();
    const binding = extractJsonBlock(content, "xingzhi-action-binding");
    const { value: snapshot } = await findSnapshot(app.vault, binding.decisionSnapshotId);
    validateActionBindingAgainstSnapshot(binding, snapshot);
    new FeedbackModal(binding, snapshot).open();
  }

  async function generateCandidate() {
    await requireReady();
    if (!settings.candidateGeneration) throw new Error("候选生成已关闭，请先在 Judgment Kernel V3 设置中打开。");
    const runtime = plugin.workbenchRuntime;
    const conversation = runtime?.activeConversation || runtime?.getActiveConversation?.();
    if (!conversation?.id) throw new Error("没有可用的当前行知对话。");
    const context = sourceContext(conversation);
    if (!context.messages.some((item) => item.role === "user")) throw new Error("当前对话没有可用于生成判断候选的用户消息。");
    const started = Date.now();
    await metric("candidate.requested", { counts: { sourceMessages: context.messages.length, lenses: context.allowedLensIds.length, evidence: context.evidenceCatalog.length } });
    try {
      const prompt = buildModelCandidatePrompt(conversation);
      const response = await runtime.sendMessage(prompt, {
        conversationId: conversation.id,
        internalUserContinuity: true,
        skipCapabilityRecommendations: true,
        skipAgentRecommendation: true,
        disableKnowledgeTools: true,
        requestedSkills: [],
      });
      const content = cleanLine(response?.content, 200_000);
      const input = { sourceMessageIds: context.sourceMessageIds, allowedLensIds: context.allowedLensIds, evidenceCatalog: context.evidenceCatalog };
      const record = buildDecisionRecordFromEnvelope(content, { sourceConversationId: conversation.id, ...input });
      await metric("candidate.parsed", { durationMs: Date.now() - started, counts: { options: record.options.length, findings: record.claims.length, evidenceEdges: record.claims.reduce((count, item) => count + item.evidenceEdges.length, 0) } });
      if (settings.shadowMode) await metric("candidate.shadowed", { counts: { options: record.options.length, findings: record.claims.length } });
      await metric("candidate.previewed", { counts: { options: record.options.length, findings: record.claims.length } });
      new CandidatePreviewModal(record, context).open();
    } catch (error) {
      await metric("candidate.rejected", { success: false, durationMs: Date.now() - started, reasonCode: /JSON|字段|引用|透镜|来源/u.test(String(error?.message || "")) ? "candidate-contract-rejected" : "candidate-model-call-failed" });
      throw error;
    }
  }

  async function reviewLegacy() {
    const { file, content } = await activeFile();
    const legacy = detectLegacyCognitiveRecord(content);
    if (!legacy) throw new Error("当前文件不是可识别的旧版 cognitiveSchemaVersion 2 认知循环。");
    new LegacyModal(file, content, legacy).open();
  }

  async function showMetrics() {
    const stored = await readJson(app.vault, METRICS_PATH, { schemaVersion: 1, events: [] });
    new MetricsModal(Array.isArray(stored?.events) ? stored.events : []).open();
  }

  async function runFullSelfCheck() {
    const kernel = runKernelSelfCheck();
    const lifecycle = runDecisionLifecycleSimulation();
    const markerValue = { cognitiveSchemaVersion: 2, title: "只读兼容自检", judgment: "样例" };
    const marker = `<!-- XINGZHI_COGNITIVE_LOOP_V2:${Buffer.from(JSON.stringify(markerValue)).toString("base64url")} -->`;
    const legacy = detectLegacyCognitiveRecord(marker);
    const ok = kernel.ok && lifecycle.ok && legacy?.readOnly === true && lifecycle.snapshotUnchangedAfterFeedback;
    const result = { ok, kernelVersion: JUDGMENT_KERNEL_VERSION, checks: { kernel: kernel.ok, candidateToFeedbackLifecycle: lifecycle.ok, legacyV2ReadOnlyDetection: legacy?.readOnly === true, snapshotImmutableAfterFeedback: lifecycle.snapshotUnchangedAfterFeedback } };
    await metric("self-check.completed", { success: ok });
    return result;
  }

  async function command(id, name, callback) {
    plugin.addCommand({ id, name, callback: async () => {
      try { await requireReady(); await callback(); }
      catch (error) { notify(String(error?.message || error)); }
    } });
  }

  void loadSettings().catch((error) => { console.error("[行知 Judgment Kernel V3] settings load failed", error); });
  void command("generate-decision-candidate-v3", "从当前对话生成判断候选 V3", generateCandidate);
  void command("create-decision-record-v3", "手动新建判断记录 V3", () => new DecisionEditorModal().open());
  void command("open-decision-card-v3", "打开当前判断卡 V3", openDecisionCard);
  void command("review-decision-evidence-v3", "审查当前判断证据 V3", async () => { const { file, record } = await activeDecisionRecord(); new EvidenceReviewModal(file, record).open(); });
  void command("create-decision-action-v3", "为当前判断创建验证行动 V3", async () => { const { record } = await activeDecisionRecord(); await createActionForRecord(record); });
  void command("record-decision-feedback-v3", "为当前判断行动记录反馈 V3", recordFeedback);
  void command("open-cognitive-loop-v2-readonly", "只读打开当前认知循环 V2", reviewLegacy);
  void command("open-judgment-kernel-v3-settings", "设置 Judgment Kernel V3 功能开关", () => new SettingsModal().open());
  void command("show-judgment-kernel-v3-metrics", "查看 Judgment Kernel V3 运行指标", showMetrics);
  void command("run-judgment-kernel-v3-self-check", "运行 Judgment Kernel V3 完整自检", async () => {
    const result = await runFullSelfCheck();
    notify(result.ok ? `判断内核 ${result.kernelVersion} 完整自检通过：候选、快照、行动、反馈与 V2 只读兼容。` : "判断内核完整自检失败，请查看控制台。");
    if (!result.ok) console.error("[行知 Judgment Kernel V3] self-check", result);
  });

  plugin.judgmentKernelV3 = Object.freeze({
    mode: "enabled", version: JUDGMENT_KERNEL_VERSION, evaluateDecisionRecord, runKernelSelfCheck, runFullSelfCheck,
    getSettings: () => settings,
    roots: Object.freeze({ records: RECORD_ROOT, snapshots: SNAPSHOT_ROOT, reviews: REVIEW_ROOT, actions: ACTION_ROOT, feedback: FEEDBACK_ROOT, settings: SETTINGS_PATH, metrics: METRICS_PATH }),
  });
  return plugin.judgmentKernelV3;
}

module.exports = {
  RECORD_ROOT, SNAPSHOT_ROOT, REVIEW_ROOT, ACTION_ROOT, FEEDBACK_ROOT, SETTINGS_PATH, METRICS_PATH,
  decisionTitle, safeFilename, displayFindingSource, extractJsonBlock, renderRecord, renderSnapshot, renderAction, renderFeedback,
  renderReviewCandidate, defaultRecord, updateRecordWithRevision, commitSnapshotTransaction, install,
};
