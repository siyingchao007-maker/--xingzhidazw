"use strict";

const crypto = require("node:crypto");
const {
  buildKnowledgeMarkdown,
  inspectGeneratedKnowledgeNote,
  rewriteGeneratedKnowledgeLifecycle,
} = require("./knowledge-tools.cjs");
const {
  createSafeKnowledgeFilename,
  hashContent,
  validateVaultMarkdownPath,
} = require("./knowledge-writer.cjs");
const { parseKnowledgeMergeSynthesis } = require("./knowledge-merge-synthesis.cjs");

const MAX_SELECTIONS = 8;
const MAX_REASON = 1_000;
const MAX_DRAFT_MEMBER_CONTENT = 4_000;
const ACTIONS = new Set([
  "archive-duplicate",
  "supersede",
  "mark-historical",
  "repair-status-metadata",
  "merge-draft",
  "intelligent-merge",
  "keep-separate",
]);

function lifecyclePlanError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableId(parts) {
  return crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24);
}

function requiredReason(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_REASON
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw lifecyclePlanError("INVALID_REASON", "请提供有界、可审计的人工处理原因。");
  }
  return value.trim();
}

function uniquePaths(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw lifecyclePlanError("INVALID_SELECTION", `${label}必须是非空、有界的文件列表。`);
  }
  const paths = values.map((value) => validateVaultMarkdownPath(value));
  if (new Set(paths).size !== paths.length) throw lifecyclePlanError("INVALID_SELECTION", `${label}包含重复文件。`);
  return paths;
}

function sourceSnapshot(record) {
  return {
    knowledgeId: record.knowledgeId,
    path: record.path,
    sourceConversationPath: record.sourceConversationPath || null,
    sourceMessageId: record.sourceMessageId || null,
    sourceDocuments: [...record.sourceDocuments],
  };
}

function mergeSources(records) {
  const result = [];
  const seen = new Set();
  for (const record of records) {
    const supplied = [sourceSnapshot(record), ...(Array.isArray(record.lifecycleSources)
      ? record.lifecycleSources
      : [])];
    for (const source of supplied) {
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      const normalized = {
        knowledgeId: String(source.knowledgeId || record.knowledgeId),
        path: String(source.path || record.path),
        sourceConversationPath: typeof source.sourceConversationPath === "string"
          ? source.sourceConversationPath : null,
        sourceMessageId: typeof source.sourceMessageId === "string" ? source.sourceMessageId : null,
        sourceDocuments: [...new Set((Array.isArray(source.sourceDocuments)
          ? source.sourceDocuments : []).filter((item) => typeof item === "string"))],
      };
      if (!normalized.sourceConversationPath && !normalized.sourceMessageId
        && normalized.sourceDocuments.length === 0) {
        throw lifecyclePlanError(
          "SOURCE_PRESERVATION_REQUIRED",
          `知识 ${record.knowledgeId} 缺少可保留来源，不能执行生命周期变更。`,
        );
      }
      const identity = JSON.stringify(normalized);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push(normalized);
    }
  }
  return result;
}

function memberRecords(candidate, notesByPath) {
  const members = [];
  for (const member of candidate.members) {
    const note = notesByPath.get(member.path);
    if (!note) throw lifecyclePlanError("STALE_PREVIEW", `处理方案已过期，找不到知识文件：${member.path}`);
    const actualHash = hashContent(note.content);
    if (member.expectedHash !== actualHash) {
      throw lifecyclePlanError("STALE_PREVIEW", `知识 ${member.path} 已变化，请重新扫描后再处理。`);
    }
    const inspected = inspectGeneratedKnowledgeNote(note);
    if (!inspected.generated || inspected.malformed || inspected.knowledgeId !== member.knowledgeId) {
      throw lifecyclePlanError("STALE_PREVIEW", `知识 ${member.path} 已无法通过结构校验，请重新扫描。`);
    }
    members.push(inspected);
  }
  return members;
}

function assertExactMemberSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
    throw lifecyclePlanError("INVALID_SELECTION", `${label}必须覆盖该候选中的全部非权威知识。`);
  }
}

function lifecycleGroup(candidate, records) {
  const existing = [...new Set(records
    .filter((record) => record.lifecycleGroupId
      && (record.lifecycleGroupId !== record.knowledgeId
        || record.supersedes.length > 0
        || Boolean(record.supersededBy)
        || record.mergedFrom.length > 0))
    .map((record) => record.lifecycleGroupId))];
  if (existing.length > 1) {
    throw lifecyclePlanError("GROUP_CONFLICT", "候选知识已经属于不同生命周期组，不能自动合并版本链。");
  }
  return existing[0] || `lifecycle-${candidate.id}`;
}

function replaceMutation(note, changes) {
  const rewritten = rewriteGeneratedKnowledgeLifecycle(note, changes);
  return {
    operation: "replace",
    path: rewritten.path,
    expectedHash: rewritten.expectedHash,
    content: rewritten.content,
  };
}

function planArchiveDuplicate(candidate, selection, records, notesByPath, now, mutations, changes) {
  if (candidate.kind !== "exact-duplicate") {
    throw lifecyclePlanError("UNSAFE_ACTION", "只有精确重复候选才能进入重复知识归档。");
  }
  const canonicalPath = validateVaultMarkdownPath(selection.canonicalPath);
  const archivePaths = uniquePaths(selection.archivePaths, "归档文件");
  const memberPaths = records.map((record) => record.path);
  if (!memberPaths.includes(canonicalPath) || archivePaths.includes(canonicalPath)) {
    throw lifecyclePlanError("INVALID_SELECTION", "权威知识必须来自当前候选，且不能同时被归档。");
  }
  assertExactMemberSet(archivePaths, memberPaths.filter((path) => path !== canonicalPath), "归档文件");
  const canonical = records.find((record) => record.path === canonicalPath);
  const archived = records.filter((record) => archivePaths.includes(record.path));
  const sources = mergeSources(records);
  const groupId = lifecycleGroup(candidate, records);
  const reason = requiredReason(selection.reason);
  const canonicalNote = notesByPath.get(canonicalPath);
  mutations.push(replaceMutation(canonicalNote, {
    status: canonical.status,
    lifecycleGroupId: groupId,
    supersedes: canonical.supersedes,
    supersededBy: canonical.supersededBy,
    mergedFrom: [...new Set([...canonical.mergedFrom, ...archived.map((record) => record.knowledgeId)])],
    lifecycleSources: sources,
    lifecycleUpdatedAt: now,
    lifecycleReason: reason,
  }));
  for (const record of archived.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))) {
    mutations.push({
      operation: "archive",
      path: record.path,
      expectedHash: hashContent(notesByPath.get(record.path).content),
    });
  }
  changes.push({
    candidateId: candidate.id,
    action: selection.action,
    reason,
    canonicalPath,
    archivedPaths: archivePaths,
    sourceCount: sources.length,
  });
}

function planSupersede(candidate, selection, records, notesByPath, now, mutations, changes) {
  if (candidate.kind !== "same-key-version") {
    throw lifecyclePlanError("UNSAFE_ACTION", "只有同键多版本候选才能建立替代关系。");
  }
  const successorPath = validateVaultMarkdownPath(selection.successorPath);
  const supersededPaths = uniquePaths(selection.supersededPaths, "旧版文件");
  const memberPaths = records.map((record) => record.path);
  if (!memberPaths.includes(successorPath) || supersededPaths.includes(successorPath)) {
    throw lifecyclePlanError("INVALID_SELECTION", "新版知识必须来自当前候选，且不能同时被标为旧版。");
  }
  assertExactMemberSet(supersededPaths, memberPaths.filter((path) => path !== successorPath), "旧版文件");
  const successor = records.find((record) => record.path === successorPath);
  if (!["active", "valid", "pending"].includes(successor.status)) {
    throw lifecyclePlanError("INVALID_SUCCESSOR", "被选为新版的知识当前不可作为有效后继。");
  }
  const oldRecords = records.filter((record) => supersededPaths.includes(record.path));
  const sources = mergeSources(records);
  const groupId = lifecycleGroup(candidate, records);
  const reason = requiredReason(selection.reason);
  for (const record of oldRecords.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))) {
    mutations.push(replaceMutation(notesByPath.get(record.path), {
      status: "superseded",
      effectiveUntil: now,
      lifecycleGroupId: groupId,
      supersedes: record.supersedes,
      supersededBy: successor.knowledgeId,
      mergedFrom: record.mergedFrom,
      lifecycleSources: mergeSources([record]),
      lifecycleUpdatedAt: now,
      lifecycleReason: reason,
    }));
  }
  mutations.push(replaceMutation(notesByPath.get(successor.path), {
    status: successor.status,
    effectiveUntil: successor.effectiveUntil,
    lifecycleGroupId: groupId,
    supersedes: [...new Set([...successor.supersedes, ...oldRecords.map((record) => record.knowledgeId)])],
    supersededBy: successor.supersededBy,
    mergedFrom: successor.mergedFrom,
    lifecycleSources: sources,
    lifecycleUpdatedAt: now,
    lifecycleReason: reason,
  }));
  changes.push({
    candidateId: candidate.id,
    action: selection.action,
    reason,
    successorPath,
    supersededPaths,
    sourceCount: sources.length,
  });
}

function planSingleStatus(candidate, selection, records, notesByPath, now, mutations, changes) {
  const targetKind = selection.action === "mark-historical" ? "expired-active" : "status-inconsistent";
  if (candidate.kind !== targetKind || records.length !== 1) {
    throw lifecyclePlanError("UNSAFE_ACTION", "该状态处理动作与候选类型不匹配。");
  }
  const record = records[0];
  const reason = requiredReason(selection.reason);
  mutations.push(replaceMutation(notesByPath.get(record.path), {
    status: selection.action === "mark-historical" ? "historical" : record.status,
    effectiveUntil: record.effectiveUntil,
    lifecycleGroupId: record.lifecycleGroupId || record.knowledgeId,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    mergedFrom: record.mergedFrom,
    lifecycleSources: mergeSources([record]),
    lifecycleUpdatedAt: now,
    lifecycleReason: reason,
  }));
  changes.push({ candidateId: candidate.id, action: selection.action, reason, path: record.path });
}

function mergeDraft(candidate, selection, records) {
  const reason = requiredReason(selection.reason);
  if (records.length < 2) throw lifecyclePlanError("UNSAFE_ACTION", "至少两条知识才能生成合并草稿。");
  const sections = records.map((record) => [
    `## ${record.title}`,
    "",
    `- 知识编号：${record.knowledgeId}`,
    `- 文件：${record.path}`,
    `- 状态：${record.status}`,
    `- 来源消息：${record.sourceMessageId || "未记录"}`,
    "",
    record.content.slice(0, MAX_DRAFT_MEMBER_CONTENT),
  ].join("\n"));
  return {
    candidateId: candidate.id,
    title: `合并草稿：${records[0].key}`,
    reason,
    readOnly: true,
    content: [
      "# 知识合并草稿（不会自动写入）",
      "",
      `处理原因：${reason}`,
      "",
      "请人工核对各条知识的事实、时间、适用场景和来源，再形成新的正式知识。",
      "",
      ...sections,
    ].join("\n\n"),
  };
}

function planIntelligentMerge(candidate, selection, records, notesByPath, now, mutations, changes) {
  if (candidate.kind !== "same-key-version") {
    throw lifecyclePlanError("UNSAFE_ACTION", "智能合并只允许处理同键多版本知识；跨类或近似候选仍需人工判断。");
  }
  if (records.length < 2 || records.length > 7) {
    throw lifecyclePlanError("FILE_LIMIT_EXCEEDED", "智能合并每次只能处理 2 至 7 条知识。");
  }
  const reason = requiredReason(selection.reason);
  if (typeof selection.knowledgeId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(selection.knowledgeId)) {
    throw lifecyclePlanError("INVALID_SELECTION", "智能合并的新知识编号无效。");
  }
  const synthesis = parseKnowledgeMergeSynthesis(JSON.stringify(selection.synthesis));
  const sourceRecords = mergeSources(records);
  const groupId = lifecycleGroup(candidate, records);
  const baseDirectory = records[0].path.split("/").slice(0, -1).join("/");
  const filePath = validateVaultMarkdownPath(
    `${baseDirectory}/${createSafeKnowledgeFilename(synthesis.title, selection.knowledgeId)}`,
  );
  if (records.some((record) => record.path === filePath)) {
    throw lifecyclePlanError("PATH_CONFLICT", "智能合并的新知识路径与旧知识冲突。");
  }
  const primary = records.at(-1);
  const firstSource = sourceRecords.find((source) => source.sourceConversationPath || source.sourceMessageId)
    || sourceRecords[0];
  const candidateForWrite = {
    id: `candidate-${selection.knowledgeId}`,
    knowledgeType: primary.knowledgeType,
    epistemicStatus: "inference",
    title: synthesis.title,
    summary: synthesis.summary,
    keyPoints: [...synthesis.keyPoints],
    suggestedUses: [...synthesis.suggestedUses],
    content: synthesis.content,
    key: primary.key,
    sensitivity: "normal",
    confidence: synthesis.confidence,
    effectiveFrom: now.slice(0, 10),
    effectiveUntil: null,
    context: primary.context || "",
    tags: [...new Set(records.flatMap((record) => record.tags || []))].slice(0, 40),
    aliases: [...new Set(records.flatMap((record) => record.aliases || []))].slice(0, 40),
    relatedKnowledge: [],
    evidence: [],
    counterEvidence: [...synthesis.unresolvedConflicts],
    source: {
      conversationId: "lifecycle-merge",
      messageId: firstSource.sourceMessageId || `merge-${candidate.id}`,
      quotedText: `由 ${records.length} 条同键知识生成智能合并候选；已保留全部原始来源。`,
    },
  };
  const createdContent = buildKnowledgeMarkdown(candidateForWrite, {
    knowledgeId: selection.knowledgeId,
    filePath,
    conversationPath: firstSource.sourceConversationPath || "11_证据与来源/对话与访谈/行知对话/lifecycle-merge.md",
    now,
  });
  const created = rewriteGeneratedKnowledgeLifecycle({ path: filePath, content: createdContent }, {
    status: "active",
    lifecycleGroupId: groupId,
    supersedes: records.map((record) => record.knowledgeId),
    supersededBy: "",
    mergedFrom: records.map((record) => record.knowledgeId),
    lifecycleSources: sourceRecords,
    lifecycleUpdatedAt: now,
    lifecycleReason: reason,
  });
  mutations.push({ operation: "create", path: filePath, content: created.content });
  for (const record of [...records].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))) {
    mutations.push(replaceMutation(notesByPath.get(record.path), {
      status: "superseded",
      effectiveUntil: now,
      lifecycleGroupId: groupId,
      supersedes: record.supersedes,
      supersededBy: selection.knowledgeId,
      mergedFrom: record.mergedFrom,
      lifecycleSources: mergeSources([record]),
      lifecycleUpdatedAt: now,
      lifecycleReason: reason,
    }));
  }
  changes.push({
    candidateId: candidate.id,
    action: "intelligent-merge",
    reason,
    createdPath: filePath,
    supersededPaths: records.map((record) => record.path),
    sourceCount: sourceRecords.length,
  });
  return {
    path: filePath,
    title: synthesis.title,
    summary: synthesis.summary,
    keyPoints: [...synthesis.keyPoints],
    suggestedUses: [...synthesis.suggestedUses],
    content: synthesis.content,
    unresolvedConflicts: [...synthesis.unresolvedConflicts],
    confidence: synthesis.confidence,
    sourceCount: sourceRecords.length,
  };
}

function planKnowledgeLifecycleChanges(input = {}) {
  const report = input.report;
  const selections = Array.isArray(input.selections) ? input.selections : [];
  if (!report || !Array.isArray(report.candidates)) throw lifecyclePlanError("INVALID_REPORT", "缺少有效生命周期扫描报告。");
  if (!selections.length || selections.length > MAX_SELECTIONS) {
    throw lifecyclePlanError("INVALID_SELECTION", "每次必须选择 1 至 8 个生命周期候选。");
  }
  const now = typeof input.now === "string" && input.now.trim()
    ? input.now.trim()
    : new Date().toISOString();
  if (now.length > 100 || !Number.isFinite(Date.parse(now))) {
    throw lifecyclePlanError("INVALID_TIME", "生命周期处理时间无效。");
  }
  const notes = Array.isArray(input.formalNotes) ? input.formalNotes : [];
  if (notes.length > 2_000) throw lifecyclePlanError("SCALE_LIMIT", "正式知识超过生命周期规划上限。");
  const notesByPath = new Map();
  for (const note of notes) {
    const path = validateVaultMarkdownPath(note?.path);
    if (typeof note?.content !== "string") throw lifecyclePlanError("INVALID_NOTE", `知识内容无效：${path}`);
    if (notesByPath.has(path)) throw lifecyclePlanError("INVALID_NOTE", `知识列表包含重复路径：${path}`);
    notesByPath.set(path, { path, content: note.content });
  }
  const candidates = new Map(report.candidates.map((candidate) => [candidate?.id, candidate]));
  const seenCandidates = new Set();
  const touchedPaths = new Set();
  const mutations = [];
  const changes = [];
  const drafts = [];
  const resolutions = [];
  let synthesizedKnowledge = null;
  for (const selection of selections) {
    if (!selection || typeof selection !== "object" || !ACTIONS.has(selection.action)) {
      throw lifecyclePlanError("INVALID_SELECTION", "生命周期动作无效。");
    }
    if (typeof selection.candidateId !== "string" || seenCandidates.has(selection.candidateId)) {
      throw lifecyclePlanError("INVALID_SELECTION", "候选编号缺失或重复。");
    }
    seenCandidates.add(selection.candidateId);
    const candidate = candidates.get(selection.candidateId);
    if (!candidate) throw lifecyclePlanError("STALE_PREVIEW", "候选已经变化，请重新扫描后再处理。");
    const records = memberRecords(candidate, notesByPath);
    const before = mutations.length;
    if (selection.action === "archive-duplicate") {
      planArchiveDuplicate(candidate, selection, records, notesByPath, now, mutations, changes);
    } else if (selection.action === "supersede") {
      planSupersede(candidate, selection, records, notesByPath, now, mutations, changes);
    } else if (selection.action === "mark-historical" || selection.action === "repair-status-metadata") {
      planSingleStatus(candidate, selection, records, notesByPath, now, mutations, changes);
    } else if (selection.action === "merge-draft") {
      drafts.push(mergeDraft(candidate, selection, records));
    } else if (selection.action === "intelligent-merge") {
      if (synthesizedKnowledge) {
        throw lifecyclePlanError("INVALID_SELECTION", "每次只能生成一个智能合并知识候选。");
      }
      synthesizedKnowledge = planIntelligentMerge(
        candidate, selection, records, notesByPath, now, mutations, changes,
      );
    } else {
      resolutions.push({
        candidateId: candidate.id,
        action: "keep-separate",
        reason: requiredReason(selection.reason),
        readOnly: true,
      });
    }
    for (const mutation of mutations.slice(before)) {
      if (touchedPaths.has(mutation.path)) {
        throw lifecyclePlanError("OVERLAPPING_SELECTION", `同一预览不能重复变更知识：${mutation.path}`);
      }
      touchedPaths.add(mutation.path);
    }
  }
  if (mutations.length > 8) {
    throw lifecyclePlanError("FILE_LIMIT_EXCEEDED", "本次会变更超过 8 个知识文件，请缩小选择范围后分批处理。");
  }
  const id = stableId([
    now,
    report.generatedAt || "",
    ...selections.map((selection) => JSON.stringify(selection)),
    ...mutations.map((mutation) => `${mutation.operation}:${mutation.path}:${mutation.expectedHash}`),
  ]);
  return {
    id,
    createdAt: now,
    reportGeneratedAt: report.generatedAt || null,
    selections: selections.map((selection) => ({ ...selection })),
    mutations,
    changes,
    drafts,
    resolutions,
    synthesizedKnowledge,
  };
}

function publicKnowledgeLifecyclePreview(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.mutations)) {
    throw lifecyclePlanError("INVALID_PLAN", "生命周期预览计划无效。");
  }
  const modifiedFiles = plan.mutations.filter((item) => item.operation === "replace").map((item) => item.path);
  const createdFiles = plan.mutations.filter((item) => item.operation === "create").map((item) => item.path);
  const archiveMoves = plan.mutations.filter((item) => item.operation === "archive").map((item) => ({
    from: item.path,
    recoveryMode: "受控归档，可撤销",
  }));
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    requiresConfirmation: true,
    canCommit: plan.mutations.length > 0,
    filesToCreate: createdFiles.length,
    filesToModify: modifiedFiles.length,
    filesToArchive: archiveMoves.length,
    modifiedFiles,
    createdFiles,
    archiveMoves,
    changes: plan.changes.map((item) => ({ ...item })),
    drafts: plan.drafts.map((item) => ({
      candidateId: item.candidateId,
      title: item.title,
      readOnly: true,
      content: item.content,
    })),
    resolutions: plan.resolutions.map((item) => ({ ...item })),
    synthesizedKnowledge: plan.synthesizedKnowledge ? { ...plan.synthesizedKnowledge } : null,
    warnings: [
      "归档只会移动到受控恢复区，不会删除原始证据，也不会永久删除文件。",
      "提交前会重新校验每个文件；任何内容变化都会拒绝整批操作。",
      "合并草稿和保留分开只提供人工判断材料，不会自动写入正式知识。",
      ...(plan.synthesizedKnowledge
        ? ["智能合并结果是模型生成的推断候选；只有你确认后才会创建新知识并把旧知识标为已替代，整批操作可撤销。"]
        : []),
    ],
  };
}

module.exports = {
  planKnowledgeLifecycleChanges,
  publicKnowledgeLifecyclePreview,
};
