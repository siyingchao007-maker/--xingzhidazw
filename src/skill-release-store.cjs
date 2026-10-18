"use strict";

const path = require("node:path");
const {
  normalizeSkillSourceText,
  parseSkillSource,
} = require("./skill-source-schema.cjs");

const SKILL_RUNTIME_ROOT = "00_系统/能力运行时";
const SKILL_RELEASE_ROOT = `${SKILL_RUNTIME_ROOT}/skill-releases`;
const ACTIVE_SKILLS_PATH = `${SKILL_RUNTIME_ROOT}/active-skills.json`;
const SKILL_RELEASE_SCHEMA_VERSION = "xingzhi-skill-release/v1";
const ACTIVE_SKILLS_SCHEMA_VERSION = "xingzhi-active-skills/v1";
const SKILL_VERSION_CLAIM_SCHEMA_VERSION = "xingzhi-skill-version-claim/v1";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_FIELDS = new Set([
  "schemaVersion",
  "skillId",
  "label",
  "skillType",
  "version",
  "contentHash",
  "sourcePath",
  "snapshotPath",
  "operators",
  "publishedAt",
  "evaluation",
]);
const EVALUATION_FIELDS = new Set(["suiteVersion", "passed", "caseCount"]);
const VERSION_CLAIM_FIELDS = new Set([
  "schemaVersion",
  "skillId",
  "version",
  "contentHash",
  "sourcePath",
  "claimedAt",
]);
const ACTIVE_INDEX_FIELDS = new Set(["schemaVersion", "skills"]);
const ACTIVE_ENTRY_FIELDS = new Set([
  "activeVersion",
  "activeHash",
  "lastKnownGoodVersion",
  "lastKnownGoodHash",
  "draftHash",
  "draftStatus",
  "status",
]);
const DRAFT_STATUSES = new Set(["none", "draft", "published"]);
const INACTIVE_STATUSES = new Set(["draft-only", "published-only"]);
const ACTIVE_STATUSES = new Set([...INACTIVE_STATUSES, "active", "active-pending-health", "rolled-back"]);

function ownRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function strictFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label}包含不允许的字段：${unknown.join("、")}`);
}

function boundedString(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximum) throw new Error(`${label}超过安全上限`);
  return normalized;
}

function safeSkillId(value) {
  const skillId = boundedString(value, "Skill 编号", 64);
  if (!ID_PATTERN.test(skillId)) throw new Error(`Skill 编号无效：${skillId}`);
  return skillId;
}

function safeVersion(value, label = "Skill 版本") {
  if (value === null) return null;
  const version = boundedString(value, label, 64);
  if (!VERSION_PATTERN.test(version)) throw new Error(`${label}无效：${version}`);
  return version;
}

function safeHash(value, label = "Skill 内容哈希") {
  if (value === null) return null;
  const contentHash = boundedString(value, label, 80);
  if (!HASH_PATTERN.test(contentHash)) throw new Error(`${label}无效`);
  return contentHash;
}

function safePublishedAt(value) {
  const publishedAt = boundedString(value || new Date().toISOString(), "发布时间", 64);
  const parsed = new Date(publishedAt);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== publishedAt) {
    throw new Error("发布时间必须是标准 ISO 时间");
  }
  return publishedAt;
}

function skillVersionClaimPath(reference) {
  const skillId = safeSkillId(reference?.skillId);
  const version = safeVersion(reference?.version);
  safeHash(reference?.contentHash);
  return `${SKILL_RELEASE_ROOT}/${skillId}/${version}/version-claim.json`;
}

function normalizeVersionClaim(value, expected) {
  const claim = ownRecord(value, "Skill 版本声明");
  strictFields(claim, VERSION_CLAIM_FIELDS, "Skill 版本声明");
  if (claim.schemaVersion !== SKILL_VERSION_CLAIM_SCHEMA_VERSION) throw new Error("Skill 版本声明 Schema 无效");
  if (claim.skillId !== expected.skillId || claim.version !== expected.version) {
    throw new Error("Skill 版本声明身份不匹配");
  }
  const contentHash = safeHash(claim.contentHash, "Skill 版本声明内容哈希");
  if (contentHash !== expected.contentHash) throw new Error("相同 Skill 版本对应不同内容，检测到版本内容漂移");
  if (claim.sourcePath !== expected.sourcePath) throw new Error("相同 Skill 版本来自不同源路径");
  safePublishedAt(claim.claimedAt);
  return claim;
}

async function ensureSkillVersionClaim(vault, reference, claimedAt) {
  const skillId = safeSkillId(reference?.skillId);
  const version = safeVersion(reference?.version);
  const contentHash = safeHash(reference?.contentHash);
  const sourcePath = boundedString(reference?.sourcePath, "Skill 来源路径", 240);
  const claimPath = skillVersionClaimPath({ skillId, version, contentHash });
  const expected = { skillId, version, contentHash, sourcePath };
  const claim = {
    schemaVersion: SKILL_VERSION_CLAIM_SCHEMA_VERSION,
    ...expected,
    claimedAt: safePublishedAt(claimedAt),
  };
  await vault.ensureFolder(path.posix.dirname(claimPath));
  if (!await vault.exists(claimPath)) {
    try {
      await vault.create(claimPath, jsonFile(claim));
    } catch (error) {
      if (!await vault.exists(claimPath)) throw error;
    }
  }
  return normalizeVersionClaim(parseJson(await vault.read(claimPath), "Skill 版本声明"), expected);
}

function normalizeEvaluation(value) {
  const evaluation = ownRecord(value, "Skill 发布评测");
  strictFields(evaluation, EVALUATION_FIELDS, "Skill 发布评测");
  const suiteVersion = boundedString(evaluation.suiteVersion, "评测套件版本", 100);
  if (evaluation.passed !== true) throw new Error("Skill 发布评测未通过，不能生成运行版本");
  if (!Number.isSafeInteger(evaluation.caseCount) || evaluation.caseCount < 0 || evaluation.caseCount > 100_000) {
    throw new Error("Skill 发布评测用例数无效");
  }
  return { suiteVersion, passed: true, caseCount: evaluation.caseCount };
}

function assertVault(vault, { process = false } = {}) {
  const required = ["exists", "read", "create", "ensureFolder", ...(process ? ["process"] : [])];
  if (!vault || required.some((name) => typeof vault[name] !== "function")) {
    throw new Error(`缺少 Skill 运行版本所需的 Vault 接口：${required.join("、")}`);
  }
  return vault;
}

function contentHashForParsedSource(source) {
  return `sha256:${source.sourceHash}`;
}

function releasePaths({ skillId, version, contentHash }) {
  const safeId = safeSkillId(skillId);
  const safeReleaseVersion = safeVersion(version);
  const safeContentHash = safeHash(contentHash);
  const hashSegment = safeContentHash.slice("sha256:".length);
  const directoryPath = `${SKILL_RELEASE_ROOT}/${safeId}/${safeReleaseVersion}/${hashSegment}`;
  return Object.freeze({
    directoryPath,
    snapshotPath: `${directoryPath}/SKILL.md`,
    manifestPath: `${directoryPath}/manifest.json`,
  });
}

function releaseReference(value) {
  const ref = ownRecord(value, "Skill 运行版本引用");
  const skillId = safeSkillId(ref.skillId);
  const version = safeVersion(ref.version);
  const contentHash = safeHash(ref.contentHash);
  return { skillId, version, contentHash, ...releasePaths({ skillId, version, contentHash }) };
}

function normalizeManifest(value, expected = null) {
  const manifest = ownRecord(value, "Skill 发布清单");
  strictFields(manifest, RELEASE_FIELDS, "Skill 发布清单");
  if (manifest.schemaVersion !== SKILL_RELEASE_SCHEMA_VERSION) throw new Error("Skill 发布清单 Schema 无效");
  const skillId = safeSkillId(manifest.skillId);
  const version = safeVersion(manifest.version);
  const contentHash = safeHash(manifest.contentHash);
  const paths = releasePaths({ skillId, version, contentHash });
  const label = boundedString(manifest.label, "Skill 名称", 200);
  const skillType = boundedString(manifest.skillType, "Skill 类型", 64);
  const sourcePath = boundedString(manifest.sourcePath, "Skill 来源路径", 240);
  if (sourcePath.includes("\\") || path.posix.isAbsolute(sourcePath) || sourcePath.includes("..")) {
    throw new Error("Skill 发布清单来源路径无效");
  }
  if (manifest.snapshotPath !== paths.snapshotPath) throw new Error("Skill 发布清单快照路径与内容哈希不匹配");
  if (!Array.isArray(manifest.operators) || manifest.operators.length > 8) {
    throw new Error("Skill 发布清单 operator 格式无效");
  }
  const operators = manifest.operators.map((operator) => {
    const item = ownRecord(operator, "Skill 发布清单 operator");
    strictFields(item, new Set(["id", "mode"]), "Skill 发布清单 operator");
    return {
      id: boundedString(item.id, "operator 编号", 64),
      mode: boundedString(item.mode, "operator 模式", 64),
    };
  });
  const normalized = {
    schemaVersion: SKILL_RELEASE_SCHEMA_VERSION,
    skillId,
    label,
    skillType,
    version,
    contentHash,
    sourcePath,
    snapshotPath: paths.snapshotPath,
    operators,
    publishedAt: safePublishedAt(manifest.publishedAt),
    evaluation: normalizeEvaluation(manifest.evaluation),
  };
  if (expected) {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (normalized[key] !== expectedValue) throw new Error(`Skill 发布清单 ${key} 与运行版本不匹配`);
    }
  }
  return normalized;
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    throw new Error(`${label} JSON 损坏`);
  }
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function releaseResult(manifest, created) {
  const paths = releasePaths(manifest);
  return Object.freeze({
    created,
    skillId: manifest.skillId,
    version: manifest.version,
    contentHash: manifest.contentHash,
    snapshotPath: paths.snapshotPath,
    manifestPath: paths.manifestPath,
    manifest: Object.freeze(manifest),
  });
}

async function readSkillRelease(vault, reference) {
  assertVault(vault);
  const ref = releaseReference(reference);
  if (!await vault.exists(ref.snapshotPath) || !await vault.exists(ref.manifestPath)) {
    throw new Error("Skill 运行版本不完整：快照或发布清单不存在");
  }
  const manifest = normalizeManifest(parseJson(await vault.read(ref.manifestPath), "Skill 发布清单"), {
    skillId: ref.skillId,
    version: ref.version,
    contentHash: ref.contentHash,
  });
  const markdown = await vault.read(ref.snapshotPath);
  const source = parseSkillSource(markdown, { sourcePath: manifest.sourcePath });
  const actualHash = contentHashForParsedSource(source);
  if (actualHash !== manifest.contentHash || actualHash !== ref.contentHash) {
    throw new Error("Skill 运行快照哈希与发布清单不匹配");
  }
  if (normalizeSkillSourceText(markdown) !== markdown) throw new Error("Skill 运行快照不是规范化的不可变内容");
  if (source.name !== manifest.skillId || source.version !== manifest.version
    || source.label !== manifest.label || source.skillType !== manifest.skillType
    || JSON.stringify(source.operators) !== JSON.stringify(manifest.operators)) {
    throw new Error("Skill 运行快照与发布清单元数据不匹配");
  }
  return Object.freeze({ manifest, markdown, source });
}

async function publishSkillRelease(vault, {
  sourcePath,
  markdown,
  evaluation,
  publishedAt = new Date().toISOString(),
} = {}) {
  assertVault(vault);
  const source = parseSkillSource(markdown, { sourcePath });
  const normalizedMarkdown = normalizeSkillSourceText(markdown);
  const contentHash = contentHashForParsedSource(source);
  const paths = releasePaths({ skillId: source.name, version: source.version, contentHash });
  const safeEvaluation = normalizeEvaluation(evaluation);
  const safeTime = safePublishedAt(publishedAt);
  await ensureSkillVersionClaim(vault, {
    skillId: source.name,
    version: source.version,
    contentHash,
    sourcePath: source.sourcePath,
  }, safeTime);
  await vault.ensureFolder(paths.directoryPath);

  if (await vault.exists(paths.snapshotPath)) {
    const existing = await vault.read(paths.snapshotPath);
    if (existing !== normalizedMarkdown) throw new Error("不可变 Skill 运行快照已存在，禁止覆盖或修改");
  } else {
    await vault.create(paths.snapshotPath, normalizedMarkdown);
  }
  if (await vault.read(paths.snapshotPath) !== normalizedMarkdown) {
    throw new Error("Skill 运行快照写入后校验失败");
  }

  if (await vault.exists(paths.manifestPath)) {
    const existing = await readSkillRelease(vault, {
      skillId: source.name,
      version: source.version,
      contentHash,
    });
    return releaseResult(existing.manifest, false);
  }

  const manifest = normalizeManifest({
    schemaVersion: SKILL_RELEASE_SCHEMA_VERSION,
    skillId: source.name,
    label: source.label,
    skillType: source.skillType,
    version: source.version,
    contentHash,
    sourcePath: source.sourcePath,
    snapshotPath: paths.snapshotPath,
    operators: source.operators,
    publishedAt: safeTime,
    evaluation: safeEvaluation,
  });
  await vault.create(paths.manifestPath, jsonFile(manifest));
  const persisted = await readSkillRelease(vault, manifest);
  return releaseResult(persisted.manifest, true);
}

function emptyActiveIndex() {
  return { schemaVersion: ACTIVE_SKILLS_SCHEMA_VERSION, skills: {} };
}

function emptyActiveEntry() {
  return {
    activeVersion: null,
    activeHash: null,
    lastKnownGoodVersion: null,
    lastKnownGoodHash: null,
    draftHash: null,
    draftStatus: "none",
    status: "draft-only",
  };
}

function versionHashPair(version, hash, label, { required = false } = {}) {
  const safeReleaseVersion = safeVersion(version, `${label}版本`);
  const safeContentHash = safeHash(hash, `${label}哈希`);
  if ((safeReleaseVersion === null) !== (safeContentHash === null)) throw new Error(`${label}版本与哈希必须同时存在`);
  if (required && safeReleaseVersion === null) throw new Error(`${label}版本不能为空`);
  return { version: safeReleaseVersion, hash: safeContentHash };
}

function normalizeActiveEntry(value) {
  const entry = ownRecord(value, "活动 Skill 条目");
  strictFields(entry, ACTIVE_ENTRY_FIELDS, "活动 Skill 条目");
  const active = versionHashPair(entry.activeVersion, entry.activeHash, "活动 Skill");
  const lastKnownGood = versionHashPair(
    entry.lastKnownGoodVersion,
    entry.lastKnownGoodHash,
    "最后有效 Skill",
  );
  const draftHash = safeHash(entry.draftHash, "Skill 草稿哈希");
  if (!DRAFT_STATUSES.has(entry.draftStatus)) throw new Error("Skill 草稿状态无效");
  if (!ACTIVE_STATUSES.has(entry.status)) throw new Error("活动 Skill 状态无效");
  if (!INACTIVE_STATUSES.has(entry.status) && active.version === null) throw new Error("活动 Skill 状态缺少活动版本");
  if (INACTIVE_STATUSES.has(entry.status) && active.version !== null) throw new Error("未激活状态不能包含活动版本");
  if ((active.version === null) !== (lastKnownGood.version === null)) {
    throw new Error("活动版本和最后有效版本必须同时存在");
  }
  if ((entry.draftStatus === "none") !== (draftHash === null)) throw new Error("Skill 草稿状态与哈希不匹配");
  return {
    activeVersion: active.version,
    activeHash: active.hash,
    lastKnownGoodVersion: lastKnownGood.version,
    lastKnownGoodHash: lastKnownGood.hash,
    draftHash,
    draftStatus: entry.draftStatus,
    status: entry.status,
  };
}

function normalizeActiveIndex(value) {
  const index = ownRecord(value, "活动 Skill 索引");
  strictFields(index, ACTIVE_INDEX_FIELDS, "活动 Skill 索引");
  if (index.schemaVersion !== ACTIVE_SKILLS_SCHEMA_VERSION) throw new Error("活动 Skill 索引 Schema 无效");
  const skills = ownRecord(index.skills, "活动 Skill 索引 skills");
  if (Object.keys(skills).length > 500) throw new Error("活动 Skill 索引数量超过安全上限");
  const normalizedSkills = {};
  for (const [skillId, entry] of Object.entries(skills)) {
    normalizedSkills[safeSkillId(skillId)] = normalizeActiveEntry(entry);
  }
  return { schemaVersion: ACTIVE_SKILLS_SCHEMA_VERSION, skills: normalizedSkills };
}

async function readActiveSkillPointerIndex(vault) {
  assertVault(vault);
  if (!await vault.exists(ACTIVE_SKILLS_PATH)) return emptyActiveIndex();
  return normalizeActiveIndex(parseJson(await vault.read(ACTIVE_SKILLS_PATH), "活动 Skill 索引"));
}

async function readActiveSkillIndex(vault) {
  const index = await readActiveSkillPointerIndex(vault);
  const verified = new Set();
  for (const [skillId, entry] of Object.entries(index.skills)) {
    for (const [version, contentHash] of [
      [entry.activeVersion, entry.activeHash],
      [entry.lastKnownGoodVersion, entry.lastKnownGoodHash],
    ]) {
      if (version === null) continue;
      const identity = `${skillId}\u0000${version}\u0000${contentHash}`;
      if (verified.has(identity)) continue;
      await readSkillRelease(vault, { skillId, version, contentHash });
      verified.add(identity);
    }
  }
  return index;
}

async function resolveSkillRuntimeRelease(vault, { skillId } = {}) {
  const safeId = safeSkillId(skillId);
  const index = await readActiveSkillPointerIndex(vault);
  const entry = index.skills[safeId];
  if (!entry || entry.activeVersion === null) throw new Error(`Skill 没有已激活的有效运行版本：${safeId}`);
  let activeError = null;
  try {
    const release = await readSkillRelease(vault, {
      skillId: safeId,
      version: entry.activeVersion,
      contentHash: entry.activeHash,
    });
    return Object.freeze({
      ...release,
      entry: Object.freeze({ ...entry }),
      resolvedFrom: "active",
      degraded: false,
      activeError: null,
    });
  } catch (error) {
    activeError = String(error?.message || error || "活动版本不可用").slice(0, 1_000);
  }
  const distinctKnownGood = entry.lastKnownGoodVersion !== null
    && (entry.lastKnownGoodVersion !== entry.activeVersion || entry.lastKnownGoodHash !== entry.activeHash);
  if (distinctKnownGood) {
    try {
      const release = await readSkillRelease(vault, {
        skillId: safeId,
        version: entry.lastKnownGoodVersion,
        contentHash: entry.lastKnownGoodHash,
      });
      return Object.freeze({
        ...release,
        entry: Object.freeze({ ...entry }),
        resolvedFrom: "last-known-good",
        degraded: true,
        activeError,
      });
    } catch (fallbackError) {
      throw new Error(`Skill 活动版本和最后有效版本都不可用：${safeId}；活动版本：${activeError}；最后有效版本：${String(fallbackError?.message || fallbackError).slice(0, 1_000)}`);
    }
  }
  throw new Error(`Skill 活动版本不可用且没有独立的最后有效版本：${safeId}；${activeError}`);
}

async function ensureActiveIndex(vault) {
  await vault.ensureFolder(SKILL_RUNTIME_ROOT);
  if (!await vault.exists(ACTIVE_SKILLS_PATH)) {
    try {
      await vault.create(ACTIVE_SKILLS_PATH, jsonFile(emptyActiveIndex()));
    } catch (error) {
      if (!await vault.exists(ACTIVE_SKILLS_PATH)) throw error;
    }
  }
  return readActiveSkillIndex(vault);
}

async function updateActiveIndex(vault, updater) {
  assertVault(vault, { process: true });
  if (typeof updater !== "function") throw new Error("活动 Skill 索引缺少更新函数");
  await ensureActiveIndex(vault);
  await vault.process(ACTIVE_SKILLS_PATH, (currentText) => {
    const current = normalizeActiveIndex(parseJson(currentText, "活动 Skill 索引"));
    const next = updater(current);
    return jsonFile(normalizeActiveIndex(next));
  });
  return readActiveSkillIndex(vault);
}

function draftReference(sourcePath, markdown) {
  const source = parseSkillSource(markdown, { sourcePath });
  const contentHash = contentHashForParsedSource(source);
  return {
    skillId: source.name,
    version: source.version,
    contentHash,
    ...releasePaths({ skillId: source.name, version: source.version, contentHash }),
  };
}

async function recordSkillDraft(vault, { sourcePath, markdown } = {}) {
  const reference = draftReference(sourcePath, markdown);
  await updateActiveIndex(vault, (current) => {
    const existing = current.skills[reference.skillId] || emptyActiveEntry();
    const published = existing.activeHash === reference.contentHash;
    current.skills[reference.skillId] = {
      ...existing,
      draftHash: reference.contentHash,
      draftStatus: published ? "published" : "draft",
      status: existing.activeVersion === null ? "draft-only" : existing.status,
    };
    return current;
  });
  return Object.freeze(reference);
}

async function markSkillReleasePublished(vault, reference) {
  const release = await readSkillRelease(vault, reference);
  const ref = releaseReference(reference);
  const index = await updateActiveIndex(vault, (current) => {
    const existing = current.skills[ref.skillId] || emptyActiveEntry();
    current.skills[ref.skillId] = {
      ...existing,
      draftHash: ref.contentHash,
      draftStatus: "published",
      status: existing.activeVersion === null ? "published-only" : existing.status,
    };
    return current;
  });
  return Object.freeze(index.skills[release.manifest.skillId]);
}

async function activateSkillRelease(vault, reference) {
  const release = await readSkillRelease(vault, reference);
  const { skillId, version, contentHash } = releaseReference(reference);
  const index = await updateActiveIndex(vault, (current) => {
    const existing = current.skills[skillId] || emptyActiveEntry();
    if (existing.activeVersion === version && existing.activeHash === contentHash) {
      current.skills[skillId] = {
        ...existing,
        draftHash: contentHash,
        draftStatus: "published",
      };
      return current;
    }
    const hasActive = existing.activeVersion !== null;
    const currentIsKnownGood = existing.status === "active" || existing.status === "rolled-back";
    current.skills[skillId] = {
      activeVersion: version,
      activeHash: contentHash,
      lastKnownGoodVersion: hasActive
        ? (currentIsKnownGood ? existing.activeVersion : existing.lastKnownGoodVersion)
        : version,
      lastKnownGoodHash: hasActive
        ? (currentIsKnownGood ? existing.activeHash : existing.lastKnownGoodHash)
        : contentHash,
      draftHash: contentHash,
      draftStatus: "published",
      status: hasActive ? "active-pending-health" : "active",
    };
    return current;
  });
  return Object.freeze(index.skills[release.manifest.skillId]);
}

async function markActiveSkillHealthy(vault, { skillId, version, contentHash } = {}) {
  const safeId = safeSkillId(skillId);
  const hasExpectedIdentity = version !== undefined || contentHash !== undefined;
  if ((version === undefined) !== (contentHash === undefined)) {
    throw new Error("健康确认的 Skill 版本与哈希必须同时提供");
  }
  const expectedVersion = hasExpectedIdentity ? safeVersion(version, "健康确认 Skill 版本") : null;
  const expectedHash = hasExpectedIdentity ? safeHash(contentHash, "健康确认 Skill 哈希") : null;
  const before = await readActiveSkillIndex(vault);
  const entry = before.skills[safeId];
  if (!entry || entry.activeVersion === null) throw new Error("Skill 没有可确认健康的活动版本");
  if (hasExpectedIdentity
    && (entry.activeVersion !== expectedVersion || entry.activeHash !== expectedHash)) {
    throw new Error("活动 Skill 在本轮完成前已经变化，拒绝确认另一个版本健康");
  }
  if (entry.status !== "active-pending-health") return Object.freeze({ ...entry });
  await readSkillRelease(vault, {
    skillId: safeId,
    version: entry.activeVersion,
    contentHash: entry.activeHash,
  });
  const index = await updateActiveIndex(vault, (current) => {
    const latest = current.skills[safeId];
    if (!latest || latest.activeVersion !== entry.activeVersion || latest.activeHash !== entry.activeHash) {
      throw new Error("活动 Skill 在健康确认前已经变化");
    }
    current.skills[safeId] = {
      ...latest,
      lastKnownGoodVersion: latest.activeVersion,
      lastKnownGoodHash: latest.activeHash,
      status: "active",
    };
    return current;
  });
  return Object.freeze(index.skills[safeId]);
}

async function rollbackSkillRelease(vault, { skillId, activeVersion, activeHash } = {}) {
  const safeId = safeSkillId(skillId);
  const hasExpectedIdentity = activeVersion !== undefined || activeHash !== undefined;
  if ((activeVersion === undefined) !== (activeHash === undefined)) {
    throw new Error("回退的活动 Skill 版本与哈希必须同时提供");
  }
  const expectedVersion = hasExpectedIdentity ? safeVersion(activeVersion, "预期活动 Skill 版本") : null;
  const expectedHash = hasExpectedIdentity ? safeHash(activeHash, "预期活动 Skill 哈希") : null;
  assertVault(vault, { process: true });
  const before = await readActiveSkillPointerIndex(vault);
  const entry = before.skills[safeId];
  if (!entry || entry.activeVersion === null || entry.lastKnownGoodVersion === null) {
    throw new Error("Skill 没有可回退的最后有效版本");
  }
  if (entry.activeVersion === entry.lastKnownGoodVersion && entry.activeHash === entry.lastKnownGoodHash) {
    throw new Error("Skill 没有可回退的更早有效版本");
  }
  if (hasExpectedIdentity
    && (entry.activeVersion !== expectedVersion || entry.activeHash !== expectedHash)) {
    throw new Error("活动 Skill 在故障判定后已经变化，拒绝执行过期回退");
  }
  await readSkillRelease(vault, {
    skillId: safeId,
    version: entry.lastKnownGoodVersion,
    contentHash: entry.lastKnownGoodHash,
  });
  await vault.process(ACTIVE_SKILLS_PATH, (currentText) => {
    const current = normalizeActiveIndex(parseJson(currentText, "活动 Skill 索引"));
    const latest = current.skills[safeId];
    if (!latest || latest.activeVersion !== entry.activeVersion || latest.activeHash !== entry.activeHash
      || latest.lastKnownGoodVersion !== entry.lastKnownGoodVersion
      || latest.lastKnownGoodHash !== entry.lastKnownGoodHash) {
      throw new Error("活动 Skill 在回退前已经变化");
    }
    current.skills[safeId] = {
      ...latest,
      activeVersion: latest.lastKnownGoodVersion,
      activeHash: latest.lastKnownGoodHash,
      status: "rolled-back",
    };
    return jsonFile(current);
  });
  const index = await readActiveSkillIndex(vault);
  return Object.freeze(index.skills[safeId]);
}

module.exports = {
  ACTIVE_SKILLS_PATH,
  ACTIVE_SKILLS_SCHEMA_VERSION,
  SKILL_RELEASE_ROOT,
  SKILL_RELEASE_SCHEMA_VERSION,
  SKILL_RUNTIME_ROOT,
  SKILL_VERSION_CLAIM_SCHEMA_VERSION,
  activateSkillRelease,
  markActiveSkillHealthy,
  markSkillReleasePublished,
  publishSkillRelease,
  readActiveSkillIndex,
  readActiveSkillPointerIndex,
  readSkillRelease,
  recordSkillDraft,
  releasePaths,
  rollbackSkillRelease,
  resolveSkillRuntimeRelease,
  skillVersionClaimPath,
};
