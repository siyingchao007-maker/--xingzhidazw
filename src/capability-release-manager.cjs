"use strict";

const crypto = require("node:crypto");
const {
  compileAndPublishSkill,
  compileSkillSource,
  skillVersionClaimPath,
} = require("./skill-compiler.cjs");
const {
  activateSkillRelease,
  readActiveSkillPointerIndex,
  readSkillRelease,
  releasePaths,
  rollbackSkillRelease,
} = require("./skill-release-store.cjs");
const {
  evaluateCognitiveLensMigrationGate,
  migrationSuite,
  publishedCognitiveLensMigrationGate,
} = require("./cognitive-lens-migration.cjs");
const { SKILL_REGISTRY_PATH } = require("./vault-capability-package.cjs");

const ACTIONS = new Set(["publish", "activate", "rollback"]);

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function releaseOperationError(message, filePath, field = "skill", code = "SKILL_RELEASE_OPERATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.filePath = filePath;
  error.field = field;
  return error;
}

function fieldFromError(message) {
  const value = String(message || "");
  const metadata = value.match(/metadata\.([A-Za-z0-9_]+)/u);
  if (metadata) return `metadata.${metadata[1]}`;
  const line = value.match(/frontmatter 第 (\d+) 行/u);
  if (line) return `frontmatter.line.${line[1]}`;
  if (/版本|version/iu.test(value)) return "metadata.version";
  if (/编号 name|草稿编号|Skill 编号/iu.test(value)) return "name";
  if (/operator/iu.test(value)) return "metadata.xingzhi_operators";
  if (/frontmatter|YAML/iu.test(value)) return "frontmatter";
  if (/正文/iu.test(value)) return "body";
  if (/来源路径|sourcePath|路径/iu.test(value)) return "sourcePath";
  if (/发布清单|运行快照|运行版本/iu.test(value)) return "release.manifest";
  if (/注册表/iu.test(value)) return "registry";
  return "skill";
}

function errorDetails(error, sourcePath) {
  const message = String(error?.message || error || "Skill 校验失败").replace(/[\r\n]+/gu, " ").slice(0, 500);
  return Object.freeze({
    path: String(error?.filePath || sourcePath || "10_智能体与技能/技能").replaceAll("\\", "/"),
    field: String(error?.field || fieldFromError(message)).slice(0, 120),
    message,
    code: String(error?.code || "SKILL_DRAFT_INVALID").slice(0, 120),
  });
}

function releaseStatusPresentation({ release = null, validation = null, draft = null } = {}) {
  if (validation?.passed === false) {
    return Object.freeze({ id: "validation-failed", label: "校验失败", tone: "danger" });
  }
  if (!release?.resolvedVersion || !release?.resolvedHash) {
    return Object.freeze({ id: "unavailable", label: "不可用", tone: "danger" });
  }
  if (release.status === "rolled-back" || release.autoRolledBack === true
    || release.degraded === true || release.resolvedFrom === "last-known-good") {
    return Object.freeze({ id: "rolled-back", label: "已回退", tone: "warning" });
  }
  const draftHash = draft?.hash || release.draftHash || null;
  if (release.hasUnpublishedChanges === true || release.draftStatus === "draft"
    || (draftHash && draftHash !== release.resolvedHash)) {
    return Object.freeze({ id: "unpublished", label: "有未发布修改", tone: "warning" });
  }
  return Object.freeze({ id: "current", label: "当前", tone: "success" });
}

function assertManageableCapability(capability) {
  const sourcePath = String(capability?.sourcePath || "").replaceAll("\\", "/");
  if (!capability?.name || !sourcePath) {
    throw releaseOperationError("该 Skill 没有可管理的人工 MD 来源", sourcePath || "10_智能体与技能/技能", "sourcePath", "SKILL_RELEASE_UNAVAILABLE");
  }
  if (capability.skillType !== "cognitive-lens" || !migrationSuite(capability.name)) {
    throw releaseOperationError("当前只允许管理已经登记发布评测的认知透镜", sourcePath, "metadata.xingzhi_skill_type", "SKILL_RELEASE_UNSUPPORTED");
  }
  return sourcePath;
}

async function claimedVersionConflict(vault, compilation) {
  const claimPath = skillVersionClaimPath({
    skillId: compilation.skillId,
    version: compilation.version,
    contentHash: compilation.contentHash,
  });
  if (!await vault.exists(claimPath)) return null;
  let claim;
  try {
    claim = JSON.parse(await vault.read(claimPath));
  } catch {
    throw releaseOperationError("Skill 版本声明 JSON 损坏", claimPath, "versionClaim", "SKILL_VERSION_CLAIM_INVALID");
  }
  if (claim?.contentHash && claim.contentHash !== compilation.contentHash) {
    return releaseOperationError(
      `版本 ${compilation.version} 已绑定其他内容；请先提升 metadata.version`,
      compilation.sourcePath,
      "metadata.version",
      "SKILL_VERSION_CONTENT_CONFLICT",
    );
  }
  return null;
}

async function publishedRelease(vault, compilation) {
  const reference = {
    skillId: compilation.skillId,
    version: compilation.version,
    contentHash: compilation.contentHash,
  };
  const paths = releasePaths(reference);
  const hasSnapshot = await vault.exists(paths.snapshotPath);
  const hasManifest = await vault.exists(paths.manifestPath);
  if (!hasSnapshot && !hasManifest) return null;
  if (!hasSnapshot || !hasManifest) {
    throw releaseOperationError("Skill 运行版本不完整：快照或发布清单不存在", paths.manifestPath, "release.manifest", "SKILL_RELEASE_INVALID");
  }
  try {
    return await readSkillRelease(vault, reference);
  } catch (error) {
    throw releaseOperationError(String(error?.message || error), paths.manifestPath, fieldFromError(error?.message), "SKILL_RELEASE_INVALID");
  }
}

function registryTarget(currentText, compilation) {
  let registry;
  try {
    registry = JSON.parse(currentText);
  } catch {
    throw releaseOperationError("Skill 注册表 JSON 损坏", SKILL_REGISTRY_PATH, "registry", "SKILL_REGISTRY_INVALID");
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)
    || registry.registryType !== "xingzhi-skill-registry" || !Array.isArray(registry.skills)) {
    throw releaseOperationError("Skill 注册表结构无效", SKILL_REGISTRY_PATH, "registry", "SKILL_REGISTRY_INVALID");
  }
  const matches = registry.skills.filter((item) => item?.id === compilation.skillId);
  if (matches.length > 1) {
    throw releaseOperationError(`Skill 注册表存在重复编号：${compilation.skillId}`, SKILL_REGISTRY_PATH, "skills", "SKILL_REGISTRY_INVALID");
  }
  if (matches.length === 1) {
    if (JSON.stringify(matches[0]) !== JSON.stringify(compilation.artifacts.registryEntry)) {
      throw releaseOperationError(`Skill 注册表条目与人工源路径不一致：${compilation.skillId}`, SKILL_REGISTRY_PATH, "skills", "SKILL_REGISTRY_CONFLICT");
    }
    return currentText;
  }
  return `${JSON.stringify({ ...registry, skills: [...registry.skills, compilation.artifacts.registryEntry] }, null, 2)}\n`;
}

async function compiledArtifactChanges(vault, compilation) {
  const registryText = await vault.read(SKILL_REGISTRY_PATH);
  const targets = [
    [compilation.artifacts.skillConfigPath, compilation.artifacts.skillConfigText],
    [compilation.artifacts.codexInterfacePath, compilation.artifacts.codexInterfaceText],
    [SKILL_REGISTRY_PATH, registryTarget(registryText, compilation)],
  ];
  const changes = [];
  for (const [filePath, content] of targets) {
    const exists = await vault.exists(filePath);
    const current = exists ? await vault.read(filePath) : null;
    changes.push(Object.freeze({
      path: filePath,
      exists,
      beforeHash: current === null ? null : fingerprint(current),
      afterHash: fingerprint(content),
      changed: current !== content,
    }));
  }
  return Object.freeze(changes);
}

function evaluationSummary({ compilation, diagnostics, published }) {
  if (published?.manifest?.evaluation) {
    const gate = publishedCognitiveLensMigrationGate({
      skillId: compilation.skillId,
      skillVersion: compilation.version,
      contentHash: compilation.contentHash,
      evaluation: published.manifest.evaluation,
    });
    if (gate) return Object.freeze({
      suiteVersion: gate.suiteVersion,
      passed: gate.passed,
      qualifyingCases: gate.qualifyingCases,
      requiredCases: gate.requiredCases,
      reasonCodes: [...gate.reasonCodes],
      evidenceSource: "published-evaluation",
    });
  }
  const gate = evaluateCognitiveLensMigrationGate({
    skillId: compilation.skillId,
    skillVersion: compilation.version,
    contentHash: compilation.contentHash,
    diagnostics,
  });
  return Object.freeze({
    suiteVersion: gate.suiteVersion,
    passed: gate.passed,
    qualifyingCases: gate.qualifyingCases,
    requiredCases: gate.requiredCases,
    reasonCodes: [...gate.reasonCodes],
    evidenceSource: "current-diagnostics",
  });
}

async function inspectSkillRelease({ vault, capability, diagnostics = [] } = {}) {
  let sourcePath;
  try {
    sourcePath = assertManageableCapability(capability);
  } catch (error) {
    const validation = Object.freeze({ passed: false, error: errorDetails(error, capability?.sourcePath) });
    return Object.freeze({
      skillId: String(capability?.name || ""), label: String(capability?.label || capability?.name || "Skill"),
      sourcePath: String(capability?.sourcePath || ""), draft: { valid: false, version: null, hash: null },
      active: { version: capability?.release?.activeVersion || null, hash: capability?.release?.activeHash || null },
      lastKnownGood: { version: capability?.release?.lastKnownGoodVersion || null, hash: capability?.release?.lastKnownGoodHash || null },
      release: clone(capability?.release || null), validation, evaluation: null, published: false,
      status: releaseStatusPresentation({ release: capability?.release, validation }),
      can: { publish: false, activate: false, rollback: false }, artifactChanges: [],
    });
  }

  let release = clone(capability.release || null);
  let markdown = "";
  let rawHash = null;
  let compilation = null;
  let published = null;
  let validation = { passed: true, error: null };
  let artifactChanges = [];
  try {
    const pointer = await readActiveSkillPointerIndex(vault);
    if (pointer.skills?.[capability.name]) {
      release = { ...(release || {}), ...pointer.skills[capability.name] };
    }
    markdown = await vault.read(sourcePath);
    rawHash = fingerprint(markdown);
    compilation = compileSkillSource({ sourcePath, markdown });
    if (compilation.skillId !== capability.name) {
      throw releaseOperationError(`Skill 草稿编号与活动版本不一致：${capability.name}`, sourcePath, "name", "SKILL_DRAFT_IDENTITY_MISMATCH");
    }
    const conflict = await claimedVersionConflict(vault, compilation);
    if (conflict) throw conflict;
    published = await publishedRelease(vault, compilation);
    artifactChanges = await compiledArtifactChanges(vault, compilation);
  } catch (error) {
    validation = { passed: false, error: errorDetails(error, sourcePath) };
  }

  const draft = compilation
    ? { valid: validation.passed, version: compilation.version, hash: compilation.contentHash }
    : { valid: false, version: null, hash: rawHash };
  const evaluation = validation.passed
    ? evaluationSummary({ compilation, diagnostics, published }) : null;
  const active = { version: release?.activeVersion || null, hash: release?.activeHash || null };
  const lastKnownGood = {
    version: release?.lastKnownGoodVersion || null,
    hash: release?.lastKnownGoodHash || null,
  };
  const currentPublished = Boolean(published);
  const canRollback = Boolean(active.version && active.hash && lastKnownGood.version && lastKnownGood.hash
    && (active.version !== lastKnownGood.version || active.hash !== lastKnownGood.hash));
  const canPublish = Boolean(validation.passed && evaluation?.passed && !currentPublished
    && (draft.version !== release?.resolvedVersion || draft.hash !== release?.resolvedHash));
  const canActivate = Boolean(validation.passed && currentPublished
    && (draft.version !== active.version || draft.hash !== active.hash));
  if (release && draft.hash) release.hasUnpublishedChanges = draft.hash !== release.resolvedHash;
  return Object.freeze({
    skillId: capability.name,
    label: capability.label || capability.name,
    sourcePath,
    draft: Object.freeze(draft),
    active: Object.freeze(active),
    lastKnownGood: Object.freeze(lastKnownGood),
    release: release ? Object.freeze(release) : null,
    validation: Object.freeze(validation),
    evaluation,
    published: currentPublished,
    status: releaseStatusPresentation({ release, validation, draft }),
    can: Object.freeze({ publish: canPublish, activate: canActivate, rollback: canRollback }),
    artifactChanges: Object.freeze(artifactChanges.map((item) => Object.freeze({ ...item }))),
  });
}

function createSkillReleaseActionPreview({ action, inspection, token } = {}) {
  const normalizedAction = String(action || "");
  if (!ACTIONS.has(normalizedAction)) throw new Error("Skill 版本操作无效");
  if (!inspection?.skillId || !inspection?.sourcePath) throw new Error("缺少 Skill 版本检查结果");
  if (!inspection.can?.[normalizedAction]) {
    const labels = { publish: "发布", activate: "激活", rollback: "回退" };
    throw releaseOperationError(
      `当前状态不能${labels[normalizedAction]}`,
      inspection.sourcePath,
      normalizedAction === "rollback" ? "release.lastKnownGoodVersion" : "release.status",
      "SKILL_RELEASE_ACTION_UNAVAILABLE",
    );
  }
  const toVersion = normalizedAction === "rollback"
    ? inspection.lastKnownGood.version : inspection.draft.version;
  const toHash = normalizedAction === "rollback"
    ? inspection.lastKnownGood.hash : inspection.draft.hash;
  return Object.freeze({
    token: String(token || ""),
    action: normalizedAction,
    skillId: inspection.skillId,
    label: inspection.label,
    sourcePath: inspection.sourcePath,
    expectedDraftVersion: inspection.draft.version,
    expectedDraftHash: inspection.draft.hash,
    expectedActiveVersion: inspection.active.version,
    expectedActiveHash: inspection.active.hash,
    fromVersion: inspection.active.version,
    fromHash: inspection.active.hash,
    toVersion,
    toHash,
    evaluation: inspection.evaluation ? Object.freeze({
      suiteVersion: inspection.evaluation.suiteVersion,
      passed: inspection.evaluation.passed,
      qualifyingCases: inspection.evaluation.qualifyingCases,
      requiredCases: inspection.evaluation.requiredCases,
      reasonCodes: [...inspection.evaluation.reasonCodes],
    }) : null,
    artifactChanges: Object.freeze(inspection.artifactChanges.map((item) => Object.freeze({ ...item }))),
    requiresConfirmation: true,
  });
}

async function assertPreviewCurrent(vault, capability, diagnostics, preview) {
  if (!preview || !ACTIONS.has(preview.action) || preview.skillId !== capability?.name) {
    throw releaseOperationError("Skill 版本预览不存在或已经失效", capability?.sourcePath, "release.preview", "SKILL_RELEASE_PREVIEW_INVALID");
  }
  const current = await inspectSkillRelease({ vault, capability, diagnostics });
  if (preview.action !== "rollback" && !current.validation.passed) {
    const detail = current.validation.error;
    throw releaseOperationError(detail.message, detail.path, detail.field, detail.code);
  }
  if (current.draft.version !== preview.expectedDraftVersion || current.draft.hash !== preview.expectedDraftHash) {
    throw releaseOperationError("人工 MD 草稿在预览后已经变化，请重新预览", current.sourcePath, "source", "SKILL_RELEASE_STALE_DRAFT");
  }
  if (current.active.version !== preview.expectedActiveVersion || current.active.hash !== preview.expectedActiveHash) {
    throw releaseOperationError("活动版本在预览后已经变化，请重新预览", current.sourcePath, "release.activeVersion", "SKILL_RELEASE_STALE_ACTIVE");
  }
  if (!current.can[preview.action]) {
    throw releaseOperationError("Skill 版本状态在预览后已经变化，请重新预览", current.sourcePath, "release.status", "SKILL_RELEASE_STALE_STATE");
  }
  for (const expected of preview.artifactChanges || []) {
    const exists = await vault.exists(expected.path);
    const actualHash = exists ? fingerprint(await vault.read(expected.path)) : null;
    if (actualHash !== expected.beforeHash) {
      throw releaseOperationError("生成文件在预览后已经变化，请重新预览", expected.path, "generatedArtifact", "SKILL_RELEASE_STALE_ARTIFACT");
    }
  }
  return current;
}

async function writeCompiledArtifacts(vault, compilation) {
  const changes = await compiledArtifactChanges(vault, compilation);
  const registryText = await vault.read(SKILL_REGISTRY_PATH);
  const targets = new Map([
    [compilation.artifacts.skillConfigPath, compilation.artifacts.skillConfigText],
    [compilation.artifacts.codexInterfacePath, compilation.artifacts.codexInterfaceText],
    [SKILL_REGISTRY_PATH, registryTarget(registryText, compilation)],
  ]);
  for (const change of changes.filter((item) => item.changed)) {
    const content = targets.get(change.path);
    const slash = change.path.lastIndexOf("/");
    if (slash > 0) await vault.ensureFolder(change.path.slice(0, slash));
    if (change.exists) await vault.modify(change.path, content);
    else await vault.create(change.path, content);
  }
  return changes.filter((item) => item.changed).map((item) => item.path);
}

async function applySkillReleaseAction({
  vault,
  capability,
  diagnostics = [],
  preview,
  publishedAt = new Date().toISOString(),
} = {}) {
  const current = await assertPreviewCurrent(vault, capability, diagnostics, preview);
  if (preview.action === "rollback") {
    const sourceBefore = await vault.read(current.sourcePath);
    const entry = await rollbackSkillRelease(vault, {
      skillId: current.skillId,
      activeVersion: current.active.version,
      activeHash: current.active.hash,
    });
    const sourcePreserved = await vault.read(current.sourcePath) === sourceBefore;
    if (!sourcePreserved) {
      throw releaseOperationError("回退意外改变了人工 MD 草稿", current.sourcePath, "source", "SKILL_ROLLBACK_CHANGED_SOURCE");
    }
    return Object.freeze({
      action: "rollback",
      skillId: current.skillId,
      status: entry.status,
      activeVersion: entry.activeVersion,
      activeHash: entry.activeHash,
      sourcePreserved,
    });
  }

  const markdown = await vault.read(current.sourcePath);
  const compilation = compileSkillSource({ sourcePath: current.sourcePath, markdown });
  if (preview.action === "publish") {
    const result = await compileAndPublishSkill(vault, {
      sourcePath: current.sourcePath,
      markdown,
      activate: false,
      publishedAt,
      evaluate: async () => ({
        suiteVersion: current.evaluation.suiteVersion,
        passed: current.evaluation.passed,
        caseCount: current.evaluation.qualifyingCases,
      }),
    });
    const changedFiles = await writeCompiledArtifacts(vault, compilation);
    return Object.freeze({
      action: "publish",
      skillId: current.skillId,
      status: result.status,
      version: compilation.version,
      contentHash: compilation.contentHash,
      evaluation: current.evaluation,
      changedFiles,
    });
  }

  const entry = await activateSkillRelease(vault, {
    skillId: current.skillId,
    version: compilation.version,
    contentHash: compilation.contentHash,
  });
  return Object.freeze({
    action: "activate",
    skillId: current.skillId,
    status: entry.status,
    activeVersion: entry.activeVersion,
    activeHash: entry.activeHash,
    lastKnownGoodVersion: entry.lastKnownGoodVersion,
    lastKnownGoodHash: entry.lastKnownGoodHash,
  });
}

module.exports = {
  applySkillReleaseAction,
  createSkillReleaseActionPreview,
  errorDetails,
  inspectSkillRelease,
  releaseStatusPresentation,
};
