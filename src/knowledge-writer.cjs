"use strict";

const crypto = require("node:crypto");

const ORDINARY_ROOTS = new Set([
  "01_当前的我",
  "02_我的历史",
  "03_环境",
  "04_关系",
  "05_目标与项目",
  "06_判断与决策",
  "07_行动",
  "08_结果与反馈",
  "09_认知资产",
  "11_证据与来源",
  "12_资料库",
]);
const ARCHIVE_ROOT = "00_系统/运行记录/已撤销记录";
const LIFECYCLE_ARCHIVE_ROOT = "00_系统/运行记录/知识生命周期归档";
const FORBIDDEN_SEGMENTS = new Set([".obsidian", ".git", "node_modules"]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function writerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function hashContent(content) {
  if (typeof content !== "string") throw writerError("INVALID_CONTENT", "知识内容必须是文本。");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function assertSafeSegment(segment) {
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw writerError("UNSAFE_PATH", "知识库路径不能包含空目录、点目录或上级目录。");
  }
  if (segment !== segment.trim() || /[. ]$/u.test(segment)) {
    throw writerError("UNSAFE_PATH", "知识库路径段不能以空格或句点结尾。");
  }
  if (segment.length > 200 || WINDOWS_INVALID.test(segment) || WINDOWS_RESERVED.test(segment)) {
    throw writerError("UNSAFE_PATH", "知识库路径包含 Windows 不允许或危险的名称。");
  }
  if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
    throw writerError("UNSAFE_PATH", "知识写入不能访问 Obsidian 配置、Git 或依赖目录。");
  }
}

function validateVaultMarkdownPath(input, options = {}) {
  if (typeof input !== "string" || input.length === 0 || input.length > 1_024) {
    throw writerError("UNSAFE_PATH", "知识库路径不能为空或超过安全长度。");
  }
  if (input.includes("\\") || input.startsWith("/") || input.startsWith("//")
    || /^[a-z]:/iu.test(input)) {
    throw writerError("UNSAFE_PATH", "知识库路径必须是使用正斜杠的相对路径。");
  }

  const normalized = input.normalize("NFC");
  const segments = normalized.split("/");
  for (const segment of segments) assertSafeSegment(segment);

  if (!/\.md$/iu.test(segments.at(-1))) {
    throw writerError("NON_MARKDOWN_PATH", "知识写入只允许 Markdown 文件。");
  }

  const isArchive = (normalized.startsWith(`${ARCHIVE_ROOT}/`)
    || normalized.startsWith(`${LIFECYCLE_ARCHIVE_ROOT}/`)) && segments.length === 4;
  if (options.allowArchive === true && isArchive) return normalized;
  if (!ORDINARY_ROOTS.has(segments[0])) {
    throw writerError(
      "UNSAFE_PATH",
      "普通知识只能写入 01 至 09、11 或受治理的 12 资料库；系统和智能体配置不在自动写入范围内。",
    );
  }
  return normalized;
}

function safeFragment(value, fallback, maximum) {
  let result = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/\.{2,}/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "");
  if (!result) result = fallback;
  result = [...result].slice(0, maximum).join("").replace(/[. ]+$/u, "");
  return result || fallback;
}

function createSafeKnowledgeFilename(title, knowledgeId) {
  let safeTitle = safeFragment(title, "知识", 80);
  if (WINDOWS_RESERVED.test(safeTitle)) safeTitle = `知识-${safeTitle}`;

  let safeId = safeFragment(knowledgeId, "", 48)
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/^-+|-+$/gu, "");
  if (!safeId) safeId = hashContent(String(knowledgeId || title || "知识")).slice(0, 16);

  return `${safeTitle}--${safeId}.md`;
}

function assertVaultAdapter(vault) {
  if (!vault || typeof vault !== "object") {
    throw writerError("INVALID_VAULT_ADAPTER", "必须提供 Vault 适配器。");
  }
  for (const method of ["exists", "read", "create", "process", "rename"]) {
    if (typeof vault[method] !== "function") {
      throw writerError("INVALID_VAULT_ADAPTER", `Vault 适配器缺少 ${method} 方法。`);
    }
  }
}

function validateHash(value, code = "INVALID_EXPECTED_HASH") {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw writerError(code, "乐观锁必须使用有效的 SHA-256 哈希。");
  }
  return value;
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cloneEntry(entry) {
  return {
    operation: entry.operation,
    path: entry.path,
    beforeContent: entry.beforeContent,
    beforeHash: entry.beforeHash,
    afterContent: entry.afterContent,
    afterHash: entry.afterHash,
    archivedPath: entry.archivedPath,
  };
}

function cloneTransaction(transaction) {
  return {
    ...transaction,
    entries: transaction.entries.map(cloneEntry),
  };
}

function canonicalTransactionPayload(transaction) {
  return JSON.stringify({
    id: transaction.id,
    createdAt: transaction.createdAt,
    status: transaction.status,
    undoToken: transaction.undoToken,
    entries: transaction.entries.map((entry) => ({
      operation: entry.operation,
      path: entry.path,
      beforeContent: entry.beforeContent,
      beforeHash: entry.beforeHash,
      afterContent: entry.afterContent,
      afterHash: entry.afterHash,
      archivedPath: entry.archivedPath,
    })),
    ...(transaction.failedAt ? { failedAt: transaction.failedAt } : {}),
    ...(transaction.undoneAt ? { undoneAt: transaction.undoneAt } : {}),
  });
}

function createKnowledgeWriter(options = {}) {
  const vault = options.vault;
  assertVaultAdapter(vault);

  const maxFiles = positiveInteger(options.maxFiles, 8, 64);
  const maxContentLength = positiveInteger(options.maxContentLength, 200_000, 2_000_000);
  const maxTotalContentLength = positiveInteger(
    options.maxTotalContentLength,
    Math.min(maxFiles * maxContentLength, 500_000),
    5_000_000,
  );
  const clock = typeof options.clock === "function" ? options.clock : () => new Date().toISOString();
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();
  const undoTokenFactory = typeof options.undoTokenFactory === "function"
    ? options.undoTokenFactory
    : () => crypto.randomBytes(32).toString("hex");
  const journalKey = Buffer.isBuffer(options.journalKey)
    ? Buffer.from(options.journalKey)
    : typeof options.journalKey === "string"
      ? Buffer.from(options.journalKey, "utf8")
      : null;
  if (!journalKey || journalKey.length < 32) {
    throw writerError(
      "INVALID_JOURNAL_KEY",
      "知识事务日志必须配置至少 32 字节的本地完整性密钥。",
    );
  }
  const journalPersistence = options.journalPersistence || null;
  if (journalPersistence && ["prepare", "complete", "abort"].some(method => typeof journalPersistence[method] !== "function")) {
    throw writerError(
      "INVALID_JOURNAL_PERSISTENCE",
      "冷日志持久化适配器必须提供 prepare、complete 和 abort 方法。",
    );
  }

  // A plan is a local capability, not a serializable model-output shape. A plain
  // object that merely looks like a plan is deliberately rejected by commit().
  const trustedPlans = new WeakSet();
  const transactions = new Map();
  let preservedJournal = null;
  let reloadRequired = false;

  function assertWriterWritable() {
    if (preservedJournal) {
      throw writerError("JOURNAL_RECOVERY_REQUIRED", "事务日志校验异常；原始记录已保留，恢复前暂停知识写入与撤销。");
    }
    if (reloadRequired) {
      throw writerError("JOURNAL_RELOAD_REQUIRED", "冷日志终态结果在本会话中无法确认；重启并重新 hydrate 前暂停知识写入与撤销。");
    }
    if (typeof options.assertWritable === "function") options.assertWritable();
  }

  async function replaceIfUnchanged(path, expectedHash, nextContent, errorCode, message) {
    let callbackInvoked = false;
    await vault.process(path, (currentContent) => {
      callbackInvoked = true;
      if (hashContent(currentContent) !== expectedHash) {
        throw writerError(errorCode, message);
      }
      return nextContent;
    });
    if (!callbackInvoked) {
      throw writerError("INVALID_VAULT_ADAPTER", "Vault 原子处理没有读取当前文件，已拒绝写入。");
    }
    if (!(await vault.exists(path)) || hashContent(await vault.read(path)) !== hashContent(nextContent)) {
      throw writerError(errorCode, "文件在原子写入完成后又发生变化；已保留最新内容并停止事务。");
    }
  }

  async function renameIfUnchanged(from, to, expectedHash, errorCode, message) {
    if (!(await vault.exists(from)) || await vault.exists(to)) {
      throw writerError(errorCode, message);
    }
    const beforeMove = await vault.read(from);
    if (hashContent(beforeMove) !== expectedHash) throw writerError(errorCode, message);
    let renameCause = null;
    try {
      await vault.rename(from, to);
    } catch (error) {
      // A filesystem adapter can complete a rename and still lose its success
      // acknowledgement. Always inspect the resulting paths before deciding
      // whether the operation happened or needs recovery.
      renameCause = error;
    }

    let fromExists;
    let toExists;
    try {
      fromExists = await vault.exists(from);
      toExists = await vault.exists(to);
    } catch (inspectionError) {
      const error = writerError(errorCode, "文件移动后的状态无法验证，需要人工检查。", renameCause || inspectionError);
      error.renameRecoveryFailed = true;
      error.renameRecoveryError = inspectionError;
      throw error;
    }

    if (!fromExists && toExists) {
      let movedContent;
      try {
        movedContent = await vault.read(to);
      } catch (inspectionError) {
        const error = writerError(errorCode, "已发生文件移动，但无法验证移动后的内容，需要人工检查。", renameCause || inspectionError);
        error.renameRecoveryFailed = true;
        error.renameRecoveryError = inspectionError;
        throw error;
      }
      if (hashContent(movedContent) === expectedHash) return;

      const conflict = writerError(errorCode, message, renameCause);
      let reverseRenameCause = null;
      try {
        if (await vault.exists(from) || !(await vault.exists(to))) throw new Error("移动目标状态已变化");
        try {
          await vault.rename(to, from);
        } catch (error) {
          reverseRenameCause = error;
        }
        const restoredSource = await vault.exists(from);
        const remainingTarget = await vault.exists(to);
        if (!restoredSource || remainingTarget
          || hashContent(await vault.read(from)) !== hashContent(movedContent)) {
          throw reverseRenameCause || new Error("竞态内容没有完整恢复到原路径");
        }
      } catch (recoveryError) {
        conflict.renameRecoveryFailed = true;
        conflict.renameRecoveryError = recoveryError;
      }
      throw conflict;
    }

    if (fromExists && !toExists) {
      throw writerError(
        errorCode,
        renameCause ? message : "文件移动没有生效，已停止事务。",
        renameCause,
      );
    }

    const ambiguous = writerError(
      errorCode,
      "文件移动没有形成可验证的唯一结果，需要人工检查。",
      renameCause,
    );
    ambiguous.renameRecoveryFailed = true;
    throw ambiguous;
  }

  function signTransaction(transaction) {
    return crypto
      .createHmac("sha256", journalKey)
      .update(canonicalTransactionPayload(transaction), "utf8")
      .digest("hex");
  }

  function signedClone(transaction) {
    const copy = cloneTransaction(transaction);
    copy.integrity = signTransaction(copy);
    return copy;
  }

  function assertSignedTransaction(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.integrity !== "string" || !SHA256.test(record.integrity)) {
      throw writerError("INVALID_JOURNAL_INTEGRITY", "知识事务日志缺少有效完整性签名。");
    }
    let expected;
    try {
      expected = signTransaction(record);
    } catch {
      throw writerError("INVALID_JOURNAL_INTEGRITY", "知识事务日志无法安全读取。");
    }
    if (!constantTimeEqual(expected, record.integrity)) {
      throw writerError("INVALID_JOURNAL_INTEGRITY", "知识事务日志已被篡改或来自其他工作台。");
    }
  }

  function validateJournalTransaction(record) {
    assertSignedTransaction(record);
    if (typeof record.id !== "string" || !record.id.trim()
      || typeof record.createdAt !== "string"
      || typeof record.undoToken !== "string" || record.undoToken.length < 32
      || !new Set(["committed", "undone"]).has(record.status)
      || !Array.isArray(record.entries) || record.entries.length === 0
      || record.entries.length > maxFiles) {
      throw writerError("INVALID_JOURNAL", "知识事务日志结构无效。");
    }
    const seenPaths = new Set();
    for (const entry of record.entries) {
      if (!entry || !new Set(["create", "replace", "archive", "snapshot-replace"]).has(entry.operation)) {
        throw writerError("INVALID_JOURNAL", "知识事务日志包含不支持的操作。");
      }
      validateVaultMarkdownPath(entry.path);
      if (seenPaths.has(entry.path)) {
        throw writerError("INVALID_JOURNAL", "知识事务日志重复修改了同一个文件。");
      }
      seenPaths.add(entry.path);
      if (entry.operation !== "archive") {
        validateHash(entry.afterHash, "INVALID_JOURNAL");
        if (typeof entry.afterContent !== "string" || hashContent(entry.afterContent) !== entry.afterHash) {
          throw writerError("INVALID_JOURNAL", "知识事务日志的新内容与哈希不一致。");
        }
      } else if (entry.afterContent !== null || entry.afterHash !== null) {
        throw writerError("INVALID_JOURNAL", "archive 日志不能伪造新内容。");
      }
      if (entry.operation === "create") {
        if (entry.beforeContent !== null || entry.beforeHash !== null) {
          throw writerError("INVALID_JOURNAL", "create 日志不能包含旧内容。");
        }
      } else if (typeof entry.beforeContent !== "string"
        || hashContent(entry.beforeContent) !== entry.beforeHash) {
        throw writerError("INVALID_JOURNAL", "replace 或 archive 日志的旧内容与哈希不一致。");
      }
      if (entry.archivedPath !== null && entry.archivedPath !== undefined) {
        validateVaultMarkdownPath(entry.archivedPath, { allowArchive: true });
      }
      if (record.status === "committed"
        && !new Set(["archive", "snapshot-replace"]).has(entry.operation)
        && entry.archivedPath !== null) {
        throw writerError("INVALID_JOURNAL", "未撤销事务不能包含归档路径。");
      }
      if (entry.operation === "archive" && typeof entry.archivedPath !== "string") {
        throw writerError("INVALID_JOURNAL", "archive 事务必须包含受控归档路径。");
      }
      if (entry.operation === "archive"
        && !entry.archivedPath.startsWith(`${LIFECYCLE_ARCHIVE_ROOT}/`)) {
        throw writerError("INVALID_JOURNAL", "archive 事务必须指向知识生命周期归档区。");
      }
      if (entry.operation === "snapshot-replace" && typeof entry.archivedPath !== "string") {
        throw writerError("INVALID_JOURNAL", "snapshot-replace 事务必须包含受控历史快照路径。");
      }
      if (record.status === "committed" && entry.operation === "snapshot-replace"
        && !entry.archivedPath.startsWith(`${LIFECYCLE_ARCHIVE_ROOT}/`)) {
        throw writerError("INVALID_JOURNAL", "snapshot-replace 历史必须位于知识生命周期归档区。");
      }
      if (record.status === "undone" && entry.operation === "create"
        && typeof entry.archivedPath !== "string") {
        throw writerError("INVALID_JOURNAL", "已撤销的 create 事务必须包含归档路径。");
      }
      if (record.status === "undone" && entry.operation === "create"
        && !entry.archivedPath.startsWith(`${ARCHIVE_ROOT}/`)) {
        throw writerError("INVALID_JOURNAL", "已撤销的 create 事务必须指向撤销归档区。");
      }
      if (record.status === "undone" && entry.operation === "snapshot-replace"
        && !entry.archivedPath.startsWith(`${ARCHIVE_ROOT}/`)) {
        throw writerError("INVALID_JOURNAL", "已撤销的 snapshot-replace 历史必须指向撤销归档区。");
      }
      if (record.status === "undone" && entry.operation === "replace"
        && entry.archivedPath !== null) {
        throw writerError("INVALID_JOURNAL", "replace 撤销不能包含归档路径。");
      }
    }
    if (record.status === "undone" && typeof record.undoneAt !== "string") {
      throw writerError("INVALID_JOURNAL", "已撤销日志必须包含撤销时间。");
    }
  }

  function importJournal(records, { isolateInvalid = false } = {}) {
    if (!Array.isArray(records)) throw writerError("INVALID_JOURNAL", "事务日志必须是数组。");
    if (preservedJournal) throw writerError("JOURNAL_RECOVERY_REQUIRED", "异常日志仍待恢复，已拒绝替换原始记录。");
    const staged = [];
    const stagedIds = new Set();
    const rejected = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      try {
        validateJournalTransaction(record);
        if (transactions.has(record.id) || stagedIds.has(record.id)) {
          throw writerError("DUPLICATE_TRANSACTION", "事务日志包含重复编号。");
        }
        staged.push(cloneTransaction(record));
        stagedIds.add(record.id);
      } catch (error) {
        if (!isolateInvalid) throw error;
        // Diagnostics contain positions and error codes, never bodies, keys or tokens.
        rejected.push({ index, code: /^[A-Z_]+$/u.test(error?.code || "") ? error.code : "INVALID_JOURNAL" });
      }
    }
    if (rejected.length) preservedJournal = records.slice();
    for (const record of staged) transactions.set(record.id, record);
    return isolateInvalid ? { total: records.length, loaded: staged.length, rejected } : staged.length;
  }

  function exportJournal() {
    // A background export must never silently erase or re-sign quarantined records.
    if (preservedJournal) return preservedJournal.slice();
    return [...transactions.values()].map(signedClone);
  }

  function plan(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw writerError("INVALID_PLAN", "写入计划必须包含至少一个变更。");
    }
    if (mutations.length > maxFiles) {
      throw writerError("FILE_LIMIT_EXCEEDED", "本轮写入文件数量超过安全上限。");
    }

    const paths = new Set();
    let totalLength = 0;
    const safeMutations = mutations.map((mutation) => {
      if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
        throw writerError("INVALID_MUTATION", "写入变更必须是对象。");
      }
      if (!new Set(["create", "replace", "archive", "snapshot-replace"]).has(mutation.operation)) {
        throw writerError("INVALID_OPERATION", "只支持 create、replace、archive 和 snapshot-replace 写入操作。");
      }

      const path = validateVaultMarkdownPath(mutation.path);
      if (paths.has(path)) throw writerError("DUPLICATE_PATH", "同一事务不能重复变更同一个文件。");
      paths.add(path);

      if (mutation.operation === "archive") {
        if (Object.hasOwn(mutation, "content") || Object.hasOwn(mutation, "archivedPath")) {
          throw writerError("INVALID_MUTATION", "archive 操作不能由调用方提供正文或归档目标。");
        }
      } else {
        if (mutation.operation === "snapshot-replace" && Object.hasOwn(mutation, "archivedPath")) {
          throw writerError("INVALID_MUTATION", "snapshot-replace 的归档目标只能由本地写入器生成。");
        }
        if (typeof mutation.content !== "string" || mutation.content.length === 0) {
          throw writerError("INVALID_CONTENT", "知识内容不能为空且必须是文本。");
        }
        if (mutation.content.length > maxContentLength) {
          throw writerError("CONTENT_LIMIT_EXCEEDED", "单个知识文件内容超过安全上限。");
        }
        totalLength += mutation.content.length;
        if (totalLength > maxTotalContentLength) {
          throw writerError("TOTAL_CONTENT_LIMIT_EXCEEDED", "本轮写入总内容超过安全上限。");
        }
      }

      const safeMutation = {
        operation: mutation.operation,
        path,
        content: mutation.operation === "archive" ? null : mutation.content,
        expectedHash: null,
      };
      if (mutation.operation === "replace" || mutation.operation === "archive"
        || mutation.operation === "snapshot-replace") {
        safeMutation.expectedHash = validateHash(mutation.expectedHash);
      } else if (mutation.expectedHash !== undefined && mutation.expectedHash !== null) {
        throw writerError("INVALID_MUTATION", "create 操作不能携带旧内容哈希。");
      }
      return Object.freeze(safeMutation);
    });

    const trustedPlan = Object.freeze({
      kind: "xingzhi-knowledge-write-plan",
      mutations: Object.freeze(safeMutations),
    });
    trustedPlans.add(trustedPlan);
    return trustedPlan;
  }

  async function preflight(trustedPlan, transactionId, createdAt) {
    const entries = [];
    let totalLength = trustedPlan.mutations.reduce(
      (sum, mutation) => sum + (mutation.operation === "archive" ? 0 : mutation.content.length),
      0,
    );
    for (let index = 0; index < trustedPlan.mutations.length; index += 1) {
      const mutation = trustedPlan.mutations[index];
      const exists = await vault.exists(mutation.path);
      if (mutation.operation === "create") {
        if (exists) throw writerError("PATH_EXISTS", "create 目标已经存在，写入已拒绝。");
        entries.push({
          operation: "create",
          path: mutation.path,
          beforeContent: null,
          beforeHash: null,
          afterContent: mutation.content,
          afterHash: hashContent(mutation.content),
          archivedPath: null,
        });
        continue;
      }

      if (!exists) throw writerError("PATH_NOT_FOUND", `${mutation.operation} 目标不存在，写入已拒绝。`);
      const beforeContent = await vault.read(mutation.path);
      const beforeHash = hashContent(beforeContent);
      if (beforeHash !== mutation.expectedHash) {
        throw writerError("HASH_CONFLICT", "文件已变化，乐观锁校验失败，未执行覆盖。");
      }
      if (mutation.operation === "archive") {
        if (beforeContent.length > maxContentLength) {
          throw writerError("CONTENT_LIMIT_EXCEEDED", "待归档知识文件内容超过安全上限。");
        }
        totalLength += beforeContent.length;
        if (totalLength > maxTotalContentLength) {
          throw writerError("TOTAL_CONTENT_LIMIT_EXCEEDED", "本轮待归档知识总内容超过安全上限。");
        }
        const entry = {
          operation: "archive",
          path: mutation.path,
          beforeContent,
          beforeHash,
          afterContent: null,
          afterHash: null,
          archivedPath: null,
        };
        entry.archivedPath = await availableLifecycleArchivePath(entry, transactionId, createdAt, index);
        entries.push(entry);
        continue;
      }
      if (mutation.operation === "snapshot-replace") {
        if (beforeContent.length > maxContentLength) {
          throw writerError("CONTENT_LIMIT_EXCEEDED", "待保存的旧版知识内容超过安全上限。");
        }
        totalLength += beforeContent.length;
        if (totalLength > maxTotalContentLength) {
          throw writerError("TOTAL_CONTENT_LIMIT_EXCEEDED", "本轮知识修订总内容超过安全上限。");
        }
        const entry = {
          operation: "snapshot-replace",
          path: mutation.path,
          beforeContent,
          beforeHash,
          afterContent: mutation.content,
          afterHash: hashContent(mutation.content),
          archivedPath: null,
        };
        entry.archivedPath = await availableLifecycleArchivePath(entry, transactionId, createdAt, index);
        entries.push(entry);
        continue;
      }
      entries.push({
        operation: "replace",
        path: mutation.path,
        beforeContent,
        beforeHash,
        afterContent: mutation.content,
        afterHash: hashContent(mutation.content),
        archivedPath: null,
      });
    }
    return entries;
  }

  function archiveFilename(entry, transactionId, at, index) {
    const original = entry.path.split("/").at(-1).replace(/\.md$/iu, "");
    const stamp = safeFragment(at, "时间未知", 40);
    const id = safeFragment(transactionId, "事务", 48);
    const suffix = hashContent(`${entry.path}\n${transactionId}\n${index}`).slice(0, 12);
    return createSafeKnowledgeFilename(`${stamp}--${original}`, `${id}-${suffix}`);
  }

  async function availableArchivePath(entry, transactionId, at, index) {
    const baseName = archiveFilename(entry, transactionId, at, index);
    const stem = baseName.replace(/\.md$/iu, "");
    for (let counter = 0; counter < 1_000; counter += 1) {
      const name = counter === 0 ? baseName : `${stem}--${counter}.md`;
      const candidate = validateVaultMarkdownPath(`${ARCHIVE_ROOT}/${name}`, { allowArchive: true });
      if (!(await vault.exists(candidate))) return candidate;
    }
    throw writerError("ARCHIVE_COLLISION", "无法为撤销记录生成唯一归档路径。");
  }

  async function availableLifecycleArchivePath(entry, transactionId, at, index) {
    const baseName = archiveFilename(entry, transactionId, at, index);
    const stem = baseName.replace(/\.md$/iu, "");
    for (let counter = 0; counter < 1_000; counter += 1) {
      const name = counter === 0 ? baseName : `${stem}--${counter}.md`;
      const candidate = validateVaultMarkdownPath(`${LIFECYCLE_ARCHIVE_ROOT}/${name}`, { allowArchive: true });
      if (!(await vault.exists(candidate))) return candidate;
    }
    throw writerError("ARCHIVE_COLLISION", "无法为知识生命周期归档生成唯一路径。");
  }

  async function assertEntryStillAtAfterState(entry, errorCode) {
    if (entry.operation === "archive") {
      if (await vault.exists(entry.path)) {
        throw writerError(errorCode, "知识已经回到原路径，无法安全补偿或撤销。");
      }
      if (!(await vault.exists(entry.archivedPath))) {
        throw writerError(errorCode, "生命周期归档文件已不存在，无法安全补偿或撤销。");
      }
      const archived = await vault.read(entry.archivedPath);
      if (hashContent(archived) !== entry.beforeHash) {
        throw writerError(errorCode, "生命周期归档文件又被编辑，无法安全补偿或撤销。");
      }
      return;
    }
    if (entry.operation === "snapshot-replace") {
      if (!(await vault.exists(entry.path))) {
        throw writerError(errorCode, "当前知识文件已不存在，无法安全补偿或撤销。");
      }
      const current = await vault.read(entry.path);
      if (hashContent(current) !== entry.afterHash) {
        throw writerError(errorCode, "当前知识在写入后又被编辑，无法安全补偿或撤销。");
      }
      if (!(await vault.exists(entry.archivedPath))) {
        throw writerError(errorCode, "知识历史快照已不存在，无法安全补偿或撤销。");
      }
      const snapshot = await vault.read(entry.archivedPath);
      if (hashContent(snapshot) !== entry.beforeHash) {
        throw writerError(errorCode, "知识历史快照又被编辑，无法安全补偿或撤销。");
      }
      return;
    }
    if (!(await vault.exists(entry.path))) {
      throw writerError(errorCode, "文件已不存在，无法安全补偿或撤销。");
    }
    const current = await vault.read(entry.path);
    if (hashContent(current) !== entry.afterHash) {
      throw writerError(errorCode, "文件在写入后又被编辑，无法安全补偿或撤销。");
    }
  }

  async function compensateApplied(applied, transaction) {
    const errors = [];
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const entry = applied[index];
      try {
        await assertEntryStillAtAfterState(entry, "COMPENSATION_HASH_CONFLICT");
        if (entry.operation === "replace") {
          await replaceIfUnchanged(
            entry.path,
            entry.afterHash,
            entry.beforeContent,
            "COMPENSATION_HASH_CONFLICT",
            "文件在补偿前又被编辑，拒绝覆盖。",
          );
        } else if (entry.operation === "archive") {
          await renameIfUnchanged(
            entry.archivedPath,
            entry.path,
            entry.beforeHash,
            "COMPENSATION_HASH_CONFLICT",
            "生命周期归档文件在补偿前又被编辑，拒绝移动。",
          );
        } else if (entry.operation === "snapshot-replace") {
          const lifecyclePath = entry.archivedPath;
          const archivedPath = await availableArchivePath(
            entry,
            transaction.id,
            transaction.failedAt || clock(),
            index,
          );
          await replaceIfUnchanged(
            entry.path,
            entry.afterHash,
            entry.beforeContent,
            "COMPENSATION_HASH_CONFLICT",
            "当前知识在补偿前又被编辑，拒绝覆盖。",
          );
          try {
            await renameIfUnchanged(
              lifecyclePath,
              archivedPath,
              entry.beforeHash,
              "COMPENSATION_HASH_CONFLICT",
              "历史快照在补偿前又被编辑，拒绝移动。",
            );
          } catch (error) {
            try {
              await replaceIfUnchanged(
                entry.path,
                entry.beforeHash,
                entry.afterContent,
                "COMPENSATION_HASH_CONFLICT",
                "历史快照补偿失败，且无法恢复当前知识的新版本。",
              );
            } catch (recoveryError) {
              error.snapshotRecoveryFailed = true;
              error.snapshotRecoveryError = recoveryError;
            }
            throw error;
          }
          entry.archivedPath = archivedPath;
        } else {
          const archivedPath = await availableArchivePath(
            entry,
            transaction.id,
            transaction.failedAt || clock(),
            index,
          );
          await renameIfUnchanged(
            entry.path,
            archivedPath,
            entry.afterHash,
            "COMPENSATION_HASH_CONFLICT",
            "新建文件在补偿前又被编辑，拒绝移动。",
          );
          entry.archivedPath = archivedPath;
        }
      } catch (error) {
        errors.push({ path: entry.path, code: error?.code || "COMPENSATION_ERROR" });
      }
    }
    return errors;
  }

  async function detectPartialApplication(entry) {
    try {
      if (entry.operation === "archive") {
        if (await vault.exists(entry.path) || !(await vault.exists(entry.archivedPath))) return false;
        return hashContent(await vault.read(entry.archivedPath)) === entry.beforeHash;
      }
      if (entry.operation === "snapshot-replace") {
        if (!(await vault.exists(entry.path)) || !(await vault.exists(entry.archivedPath))) return false;
        return hashContent(await vault.read(entry.path)) === entry.afterHash
          && hashContent(await vault.read(entry.archivedPath)) === entry.beforeHash;
      }
      if (!(await vault.exists(entry.path))) return false;
      return hashContent(await vault.read(entry.path)) === entry.afterHash;
    } catch {
      return false;
    }
  }

  async function commit(trustedPlan) {
    assertWriterWritable();
    if (!trustedPlan || typeof trustedPlan !== "object" || !trustedPlans.has(trustedPlan)) {
      throw writerError(
        "UNTRUSTED_PLAN",
        "写入器只接受当前后台实例规划并签发的变更，拒绝模型或外部对象直接写入。",
      );
    }

    const createdAt = clock();
    const transaction = {
      id: String(idFactory()),
      createdAt,
      status: "pending",
      undoToken: String(undoTokenFactory()),
      entries: [],
    };
    if (!transaction.id.trim()) throw writerError("INVALID_TRANSACTION_ID", "事务编号不能为空。");
    if (transaction.undoToken.length < 32) {
      throw writerError("INVALID_UNDO_TOKEN", "撤销令牌未达到最低安全长度。");
    }
    const entries = await preflight(trustedPlan, transaction.id, createdAt);
    transaction.entries = entries;

    // Cold-store intent and all before/after evidence must be durable before the
    // first Vault mutation. Legacy writers retain the existing inline behavior.
    const persistenceIntentId = journalPersistence
      ? await journalPersistence.prepare({ operation: "commit", transaction: cloneTransaction(transaction) })
      : null;

    const applied = [];
    let terminalTransaction = null;
    try {
      for (const entry of entries) {
        if (entry.operation === "create") {
          if (await vault.exists(entry.path)) {
            throw writerError("PATH_EXISTS", "create 目标在提交前已出现，写入已拒绝。");
          }
          try {
            await vault.create(entry.path, entry.afterContent);
          } catch (error) {
            if (await detectPartialApplication(entry)) applied.push(entry);
            throw error;
          }
        } else if (entry.operation === "replace") {
          if (!(await vault.exists(entry.path))) {
            throw writerError("PATH_NOT_FOUND", "replace 目标在提交前已消失，写入已拒绝。");
          }
          try {
            await replaceIfUnchanged(
              entry.path,
              entry.beforeHash,
              entry.afterContent,
              "HASH_CONFLICT",
              "文件在预检后又发生变化，未执行覆盖。",
            );
          } catch (error) {
            if (await detectPartialApplication(entry)) applied.push(entry);
            throw error;
          }
        } else if (entry.operation === "snapshot-replace") {
          if (!(await vault.exists(entry.path))) {
            throw writerError("PATH_NOT_FOUND", "snapshot-replace 目标在提交前已消失，写入已拒绝。");
          }
          const currentBeforeSnapshot = await vault.read(entry.path);
          if (hashContent(currentBeforeSnapshot) !== entry.beforeHash) {
            throw writerError("HASH_CONFLICT", "文件在预检后又发生变化，未创建历史也未执行覆盖。");
          }
          if (await vault.exists(entry.archivedPath)) {
            throw writerError("PATH_EXISTS", "知识历史快照目标在提交前已出现，写入已拒绝。");
          }
          try {
            await vault.create(entry.archivedPath, entry.beforeContent);
            if (!(await vault.exists(entry.archivedPath))
              || hashContent(await vault.read(entry.archivedPath)) !== entry.beforeHash) {
              throw writerError("SNAPSHOT_WRITE_FAILED", "知识历史快照没有完整写入，已停止当前版本替换。");
            }
            await replaceIfUnchanged(
              entry.path,
              entry.beforeHash,
              entry.afterContent,
              "HASH_CONFLICT",
              "文件在历史快照创建后又发生变化，未执行覆盖。",
            );
          } catch (error) {
            if (await detectPartialApplication(entry)) {
              applied.push(entry);
              throw error;
            }
            let snapshotExists = false;
            let snapshotMatches = false;
            try {
              snapshotExists = await vault.exists(entry.archivedPath);
              snapshotMatches = snapshotExists
                && hashContent(await vault.read(entry.archivedPath)) === entry.beforeHash;
            } catch {
              snapshotExists = true;
            }
            if (snapshotMatches) {
              try {
                const rolledBackPath = await availableArchivePath(
                  entry,
                  transaction.id,
                  clock(),
                  applied.length,
                );
                await renameIfUnchanged(
                  entry.archivedPath,
                  rolledBackPath,
                  entry.beforeHash,
                  "SNAPSHOT_COMPENSATION_FAILED",
                  "当前版本未替换，但历史快照无法安全移出活动归档区。",
                );
                entry.archivedPath = rolledBackPath;
              } catch (snapshotError) {
                error.snapshotCompensationError = snapshotError;
                applied.push(entry);
              }
            } else if (snapshotExists) {
              error.snapshotCompensationError = writerError(
                "SNAPSHOT_HASH_CONFLICT",
                "历史快照内容异常，需要人工检查。",
              );
              applied.push(entry);
            }
            throw error;
          }
        } else {
          if (!(await vault.exists(entry.path))) {
            throw writerError("PATH_NOT_FOUND", "archive 目标在提交前已消失，归档已拒绝。");
          }
          if (await vault.exists(entry.archivedPath)) {
            throw writerError("PATH_EXISTS", "生命周期归档目标在提交前已出现，归档已拒绝。");
          }
          try {
            await renameIfUnchanged(
              entry.path,
              entry.archivedPath,
              entry.beforeHash,
              "HASH_CONFLICT",
              "文件在预检后又发生变化，未执行归档。",
            );
          } catch (error) {
            if (error?.renameRecoveryFailed || await detectPartialApplication(entry)) applied.push(entry);
            throw error;
          }
        }
        applied.push(entry);
      }
      transaction.status = "committed";
      terminalTransaction = signedClone(transaction);
      if (persistenceIntentId) await journalPersistence.complete(persistenceIntentId, terminalTransaction);
      transactions.set(transaction.id, cloneTransaction(transaction));
      return terminalTransaction;
    } catch (cause) {
      if (persistenceIntentId && terminalTransaction && cause?.durable === true) {
        transactions.set(transaction.id, cloneTransaction(transaction));
        return terminalTransaction;
      }
      if (persistenceIntentId && cause?.durableUnknown === true) {
        reloadRequired = true;
        const error = writerError(
          "WRITE_DURABILITY_UNKNOWN",
          "Vault 写入已完成，但冷日志 head 的持久化结果无法验证；事务和知识写入已锁定。",
          cause,
        );
        error.durableUnknown = true;
        error.transaction = cloneTransaction(transaction);
        throw error;
      }
      transaction.failedAt = clock();
      const compensationErrors = await compensateApplied(applied, transaction);
      let abortError = null;
      if (persistenceIntentId) {
        try {
          await journalPersistence.abort(persistenceIntentId, {
            compensationFailed: compensationErrors.length > 0,
            compensationErrors,
          });
        } catch (error) {
          abortError = error;
        }
      }
      if (applied.length === 0 && compensationErrors.length === 0 && cause?.code === "HASH_CONFLICT") {
        if (abortError) {
          const error = writerError("WRITE_PERSISTENCE_ABORT_FAILED", "写入未完成，且冷日志意图无法安全终结；后续写入已锁定。", abortError);
          error.compensationErrors = [];
          throw error;
        }
        throw cause;
      }
      transaction.status = compensationErrors.length === 0 ? "rolled-back" : "compensation-failed";
      const error = writerError(
        abortError
          ? "WRITE_PERSISTENCE_ABORT_FAILED"
          : compensationErrors.length === 0 ? "WRITE_FAILED" : "WRITE_COMPENSATION_FAILED",
        abortError
          ? "写入失败；冷日志意图无法安全终结，后续写入已锁定。"
          : compensationErrors.length === 0
          ? "写入失败；已反向补偿所有已完成变更。"
          : "写入失败，且部分补偿未完成，需要人工检查。",
        abortError || cause,
      );
      error.transaction = cloneTransaction(transaction);
      error.compensationErrors = compensationErrors;
      throw error;
    }
  }

  function resolveTransactionForUndo(reference, token) {
    const id = typeof reference === "string" ? reference : reference?.id;
    if (typeof id !== "string" || !id.trim()) {
      throw writerError("UNKNOWN_TRANSACTION", "找不到要撤销的事务。");
    }
    const transaction = transactions.get(id);
    if (!transaction) throw writerError("UNKNOWN_TRANSACTION", "找不到要撤销的事务。");
    if (!constantTimeEqual(transaction.undoToken, token)) {
      throw writerError("INVALID_UNDO_TOKEN", "撤销令牌不正确。");
    }
    return cloneTransaction(transaction);
  }

  function validateTransactionForUndo(transaction) {
    if (transaction.status === "undone") return "already-undone";
    if (transaction.status !== "committed" || !Array.isArray(transaction.entries)
      || transaction.entries.length === 0 || transaction.entries.length > maxFiles) {
      throw writerError("INVALID_TRANSACTION", "只有已提交且结构完整的事务可以撤销。");
    }
    return "committed";
  }

  async function preflightUndo(transaction) {
    for (const entry of transaction.entries) {
      if (!entry || !new Set(["create", "replace", "archive", "snapshot-replace"]).has(entry.operation)) {
        throw writerError("INVALID_TRANSACTION", "事务包含不支持的操作。");
      }
      validateVaultMarkdownPath(entry.path);
      if (entry.operation !== "archive") validateHash(entry.afterHash, "INVALID_TRANSACTION");
      if (entry.operation === "replace" || entry.operation === "archive"
        || entry.operation === "snapshot-replace") {
        if (typeof entry.beforeContent !== "string"
          || hashContent(entry.beforeContent) !== entry.beforeHash) {
          throw writerError("INVALID_TRANSACTION", "事务旧内容或哈希不完整。");
        }
      }
      if (entry.operation === "archive" || entry.operation === "snapshot-replace") {
        validateVaultMarkdownPath(entry.archivedPath, { allowArchive: true });
        if (!entry.archivedPath.startsWith(`${LIFECYCLE_ARCHIVE_ROOT}/`)) {
          throw writerError("INVALID_TRANSACTION", "事务的历史路径不在生命周期归档区。");
        }
      }
      await assertEntryStillAtAfterState(entry, "UNDO_HASH_CONFLICT");
    }
  }

  async function compensateUndo(applied) {
    const errors = [];
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const item = applied[index];
      try {
        if (item.entry.operation === "create") {
          if (await vault.exists(item.entry.path)) {
            throw writerError("UNDO_COMPENSATION_CONFLICT", "撤销补偿目标已经存在。");
          }
          await renameIfUnchanged(
            item.archivedPath,
            item.entry.path,
            item.entry.afterHash,
            "UNDO_COMPENSATION_CONFLICT",
            "撤销补偿归档文件已经变化。",
          );
        } else if (item.entry.operation === "archive") {
          if (!(await vault.exists(item.entry.path))) {
            throw writerError("UNDO_COMPENSATION_CONFLICT", "撤销补偿目标已经消失。");
          }
          if (await vault.exists(item.entry.archivedPath)) {
            throw writerError("UNDO_COMPENSATION_CONFLICT", "生命周期归档目标已被占用。");
          }
          await renameIfUnchanged(
            item.entry.path,
            item.entry.archivedPath,
            item.entry.beforeHash,
            "UNDO_COMPENSATION_CONFLICT",
            "撤销补偿前文件又被修改。",
          );
        } else if (item.entry.operation === "snapshot-replace") {
          if (!(await vault.exists(item.archivedPath)) || await vault.exists(item.lifecyclePath)) {
            throw writerError("UNDO_COMPENSATION_CONFLICT", "撤销后的历史快照状态已变化。");
          }
          await renameIfUnchanged(
            item.archivedPath,
            item.lifecyclePath,
            item.entry.beforeHash,
            "UNDO_COMPENSATION_CONFLICT",
            "撤销后的历史快照已经变化。",
          );
          try {
            await replaceIfUnchanged(
              item.entry.path,
              item.entry.beforeHash,
              item.entry.afterContent,
              "UNDO_COMPENSATION_CONFLICT",
              "撤销补偿前当前知识又被修改。",
            );
          } catch (error) {
            try {
              await renameIfUnchanged(
                item.lifecyclePath,
                item.archivedPath,
                item.entry.beforeHash,
                "UNDO_COMPENSATION_CONFLICT",
                "无法恢复撤销补偿前的历史快照位置。",
              );
            } catch (recoveryError) {
              error.snapshotRecoveryFailed = true;
              error.snapshotRecoveryError = recoveryError;
            }
            throw error;
          }
        } else {
          if (!(await vault.exists(item.entry.path))) {
            throw writerError("UNDO_COMPENSATION_CONFLICT", "撤销补偿目标已经消失。");
          }
          await replaceIfUnchanged(
            item.entry.path,
            item.entry.beforeHash,
            item.entry.afterContent,
            "UNDO_COMPENSATION_CONFLICT",
            "撤销补偿前文件又被修改。",
          );
        }
      } catch (error) {
        errors.push({ path: item.entry.path, code: error?.code || "UNDO_COMPENSATION_ERROR" });
      }
    }
    return errors;
  }

  async function detectUndoApplication(entry, archivedPath, lifecyclePath = null) {
    try {
      if (entry.operation === "replace") {
        if (!(await vault.exists(entry.path))) return false;
        return hashContent(await vault.read(entry.path)) === entry.beforeHash;
      }
      if (entry.operation === "archive") {
        if (!(await vault.exists(entry.path)) || await vault.exists(entry.archivedPath)) return false;
        return hashContent(await vault.read(entry.path)) === entry.beforeHash;
      }
      if (entry.operation === "snapshot-replace") {
        if (!(await vault.exists(entry.path)) || !(await vault.exists(archivedPath))
          || await vault.exists(lifecyclePath)) return false;
        return hashContent(await vault.read(entry.path)) === entry.beforeHash
          && hashContent(await vault.read(archivedPath)) === entry.beforeHash;
      }
      return !(await vault.exists(entry.path)) && await vault.exists(archivedPath);
    } catch {
      return false;
    }
  }

  async function undo(reference, token) {
    assertWriterWritable();
    const transaction = resolveTransactionForUndo(reference, token);
    const state = validateTransactionForUndo(transaction);
    if (state === "already-undone") return signedClone(transaction);

    // Validate every file before touching any one of them: a later human edit
    // rejects the complete undo transaction instead of producing a partial undo.
    await preflightUndo(transaction);

    const plannedArchivePaths = [];
    for (let index = transaction.entries.length - 1; index >= 0; index -= 1) {
      const entry = transaction.entries[index];
      if (entry.operation === "create" || entry.operation === "snapshot-replace") {
        plannedArchivePaths[index] = await availableArchivePath(entry, transaction.id, clock(), index);
      }
    }
    const persistenceIntentId = journalPersistence
      ? await journalPersistence.prepare({
        operation: "undo",
        transaction: cloneTransaction(transaction),
        evidence: {
          plannedArchivePaths: plannedArchivePaths
            .map((archivePath, entryIndex) => archivePath ? { entryIndex, path: archivePath } : null)
            .filter(Boolean),
        },
      })
      : null;

    const result = cloneTransaction(transaction);
    const applied = [];
    let terminalTransaction = null;
    try {
      for (let index = result.entries.length - 1; index >= 0; index -= 1) {
        const entry = result.entries[index];
        if (entry.operation === "replace") {
          try {
            await replaceIfUnchanged(
              entry.path,
              entry.afterHash,
              entry.beforeContent,
              "UNDO_HASH_CONFLICT",
              "文件在撤销前又被编辑，拒绝覆盖。",
            );
          } catch (error) {
            if (await detectUndoApplication(entry, null)) {
              applied.push({ entry, archivedPath: null });
            }
            throw error;
          }
          applied.push({ entry, archivedPath: null });
        } else if (entry.operation === "create") {
          const archivedPath = plannedArchivePaths[index];
          try {
            await renameIfUnchanged(
              entry.path,
              archivedPath,
              entry.afterHash,
              "UNDO_HASH_CONFLICT",
              "新建文件在撤销前又被编辑，拒绝移动。",
            );
          } catch (error) {
            if (error?.renameRecoveryFailed || await detectUndoApplication(entry, archivedPath)) {
              applied.push({ entry, archivedPath });
            }
            throw error;
          }
          entry.archivedPath = archivedPath;
          applied.push({ entry, archivedPath });
        } else if (entry.operation === "snapshot-replace") {
          const lifecyclePath = entry.archivedPath;
          const archivedPath = plannedArchivePaths[index];
          let currentRestored = false;
          try {
            await replaceIfUnchanged(
              entry.path,
              entry.afterHash,
              entry.beforeContent,
              "UNDO_HASH_CONFLICT",
              "当前知识在撤销前又被编辑，拒绝覆盖。",
            );
            currentRestored = true;
            await renameIfUnchanged(
              lifecyclePath,
              archivedPath,
              entry.beforeHash,
              "UNDO_HASH_CONFLICT",
              "历史快照在撤销前又被编辑，拒绝移动。",
            );
          } catch (error) {
            if (await detectUndoApplication(entry, archivedPath, lifecyclePath)) {
              entry.archivedPath = archivedPath;
              applied.push({ entry, archivedPath, lifecyclePath });
              throw error;
            }
            if (currentRestored) {
              try {
                await replaceIfUnchanged(
                  entry.path,
                  entry.beforeHash,
                  entry.afterContent,
                  "UNDO_COMPENSATION_CONFLICT",
                  "历史快照未能撤销，且当前知识无法恢复到撤销前版本。",
                );
              } catch (recoveryError) {
                error.snapshotRecoveryFailed = true;
                error.snapshotRecoveryError = recoveryError;
              }
            }
            throw error;
          }
          entry.archivedPath = archivedPath;
          applied.push({ entry, archivedPath, lifecyclePath });
        } else {
          const archivedPath = entry.archivedPath;
          try {
            await renameIfUnchanged(
              archivedPath,
              entry.path,
              entry.beforeHash,
              "UNDO_HASH_CONFLICT",
              "生命周期归档文件在撤销前又被编辑，拒绝恢复。",
            );
          } catch (error) {
            if (error?.renameRecoveryFailed || await detectUndoApplication(entry, archivedPath)) {
              applied.push({ entry, archivedPath });
            }
            throw error;
          }
          applied.push({ entry, archivedPath });
        }
      }
      result.status = "undone";
      result.undoneAt = clock();
      terminalTransaction = signedClone(result);
      if (persistenceIntentId) await journalPersistence.complete(persistenceIntentId, terminalTransaction);
      transactions.set(result.id, cloneTransaction(result));
      return terminalTransaction;
    } catch (cause) {
      if (persistenceIntentId && terminalTransaction && cause?.durable === true) {
        transactions.set(result.id, cloneTransaction(result));
        return terminalTransaction;
      }
      if (persistenceIntentId && cause?.durableUnknown === true) {
        reloadRequired = true;
        const error = writerError(
          "UNDO_DURABILITY_UNKNOWN",
          "撤销已执行，但冷日志 head 的持久化结果无法验证；事务和知识写入已锁定。",
          cause,
        );
        error.durableUnknown = true;
        throw error;
      }
      const compensationErrors = await compensateUndo(applied);
      const compensationIncomplete = compensationErrors.length > 0 || cause?.snapshotRecoveryFailed === true;
      let abortError = null;
      if (persistenceIntentId) {
        try {
          await journalPersistence.abort(persistenceIntentId, {
            compensationFailed: compensationIncomplete,
            compensationErrors,
          });
        } catch (error) {
          abortError = error;
        }
      }
      const error = writerError(
        abortError
          ? "UNDO_PERSISTENCE_ABORT_FAILED"
          : compensationIncomplete ? "UNDO_COMPENSATION_FAILED" : "UNDO_FAILED",
        abortError
          ? "撤销失败；冷日志意图无法安全终结，后续写入已锁定。"
          : compensationIncomplete
          ? "撤销失败，且补偿未完全成功，需要人工检查。"
          : "撤销失败；已恢复撤销前状态。",
        abortError || cause,
      );
      error.compensationErrors = compensationErrors;
      throw error;
    }
  }

  return Object.freeze({ commit, exportJournal, importJournal, plan, undo });
}

module.exports = {
  ARCHIVE_ROOT,
  LIFECYCLE_ARCHIVE_ROOT,
  ORDINARY_ROOTS,
  createKnowledgeWriter,
  createSafeKnowledgeFilename,
  hashContent,
  validateVaultMarkdownPath,
};
