"use strict";

const crypto = require("node:crypto");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const NAMESPACES = Object.freeze(["knowledgeTransactions", "knowledgeIndexTransactions"]);
const FORMAT = "xingzhi-journal-store-v1";
const HEAD_FILE = "current-head.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const EPOCH = /^[a-f0-9]{32}$/u;
const INTENT_ID = /^[a-f0-9-]{36}$/u;
const BLOB_REFERENCE = "$xzJournalBlob";
const HYDRATE_RECORD_CONCURRENCY = 16;

function storageError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;

  async function run() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => run()));
  if (failed) throw firstError;
  return results;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = sortedJsonValue(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  const json = JSON.stringify(sortedJsonValue(value));
  if (typeof json !== "string") throw storageError("INVALID_JOURNAL_VALUE", "事务日志包含无法序列化的数据。");
  return json;
}

function cloneJson(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("not JSON serializable");
    return JSON.parse(encoded);
  } catch (error) {
    throw storageError("INVALID_JOURNAL_VALUE", "事务日志包含无法安全复制的数据。", error);
  }
}

function integrityPayload(value) {
  const { integrity, ...payload } = value;
  return payload;
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createJournalStore(options = {}) {
  const { directory, journalKey, epoch } = options;
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw storageError("INVALID_JOURNAL_DIRECTORY", "冷日志目录必须由运行时提供绝对路径。");
  }
  if (typeof journalKey !== "string" || !/^[a-f0-9]{64}$/iu.test(journalKey)) {
    throw storageError("INVALID_JOURNAL_KEY", "冷日志完整性密钥必须是 64 位十六进制文本。");
  }
  if (typeof epoch !== "string" || !EPOCH.test(epoch)) {
    throw storageError("INVALID_JOURNAL_EPOCH", "冷日志 epoch 必须是 32 位小写十六进制值。");
  }

  // Existing transaction signatures use the journal-key text as UTF-8 bytes.
  // Do not hex-decode it here or old signatures and new heads would use different keys.
  const signingKey = Buffer.from(journalKey, "utf8");
  const root = path.resolve(directory);
  const io = options.fs || fsPromises;
  for (const method of ["lstat", "mkdir", "open", "readFile", "readdir", "rename", "unlink"]) {
    if (typeof io[method] !== "function") {
      throw storageError("INVALID_JOURNAL_FS", `冷日志文件系统适配器缺少 ${method} 方法。`);
    }
  }

  const directories = {
    records: path.join(root, "records"),
    blobs: path.join(root, "blobs"),
    intents: path.join(root, "intents"),
  };
  const activeIntentIds = new Set();
  const leaseReleases = new Map();
  let queue = Promise.resolve();
  let writeLeaseQueue = Promise.resolve();

  function enqueue(action) {
    const result = queue.then(action, action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function acquireWriteLease() {
    let release;
    const lease = new Promise(resolve => { release = resolve; });
    const previous = writeLeaseQueue;
    writeLeaseQueue = lease;
    await previous;
    return release;
  }

  function finishIntent(intentId) {
    activeIntentIds.delete(intentId);
    const release = leaseReleases.get(intentId);
    leaseReleases.delete(intentId);
    if (release) release();
  }

  function sign(payload) {
    return crypto.createHmac("sha256", signingKey).update(canonicalJson(payload), "utf8").digest("hex");
  }

  function signed(payload) {
    return { ...payload, integrity: sign(payload) };
  }

  function verifySigned(value, code, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.integrity !== "string" || !SHA256.test(value.integrity)
      || !constantTimeEqual(sign(integrityPayload(value)), value.integrity)) {
      throw storageError(code, message);
    }
  }

  async function ensureDirectory(directoryPath, create) {
    const parsed = path.parse(directoryPath);
    const segments = directoryPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let cursor = parsed.root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      let info;
      try {
        info = await io.lstat(cursor);
      } catch (error) {
        if (!isMissing(error) || !create) {
          throw storageError("JOURNAL_STORAGE_MISSING", "冷日志目录不完整，已暂停读取和写入。", error);
        }
        try {
          await io.mkdir(cursor);
          info = await io.lstat(cursor);
        } catch (mkdirError) {
          if (mkdirError?.code === "EEXIST") {
            try { info = await io.lstat(cursor); } catch (statError) {
              throw storageError("JOURNAL_STORAGE_MISSING", "冷日志目录无法安全创建。", statError);
            }
          } else {
            throw storageError("JOURNAL_STORAGE_MISSING", "冷日志目录无法安全创建。", mkdirError);
          }
        }
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storageError("JOURNAL_UNSAFE_PATH", "冷日志目录包含符号链接或非目录路径。 ");
      }
    }
  }

  async function ensureDirectories(create = false) {
    await ensureDirectory(root, create);
    for (const directoryPath of Object.values(directories)) await ensureDirectory(directoryPath, create);
  }

  function assertInsideStore(filePath) {
    const relative = path.relative(root, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw storageError("JOURNAL_UNSAFE_PATH", "冷日志文件路径越过了受控目录。");
    }
  }

  async function assertRegularFile(filePath, allowMissing = false) {
    assertInsideStore(filePath);
    await ensureDirectory(root, false);
    await ensureDirectory(path.dirname(filePath), false);
    try {
      const info = await io.lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storageError("JOURNAL_UNSAFE_PATH", "冷日志文件包含符号链接或非普通文件。");
      }
      return true;
    } catch (error) {
      if (allowMissing && isMissing(error)) return false;
      if (isMissing(error)) throw error;
      throw error;
    }
  }

  async function readBytes(filePath, missingCode = "JOURNAL_FILE_MISSING") {
    try {
      await assertRegularFile(filePath);
    } catch (error) {
      if (isMissing(error)) throw storageError(missingCode, "冷日志文件缺失，已暂停写入。", error);
      throw error;
    }
    try {
      return Buffer.from(await io.readFile(filePath));
    } catch (error) {
      if (isMissing(error)) throw storageError(missingCode, "冷日志文件缺失，已暂停写入。", error);
      throw storageError("JOURNAL_READ_FAILED", "冷日志文件无法读取。", error);
    }
  }

  function parseJson(bytes, code = "JOURNAL_INVALID_FILE") {
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw storageError(code, "冷日志文件格式无效。", error);
    }
  }

  async function syncDirectory(directoryPath) {
    let handle;
    try {
      handle = await io.open(directoryPath, "r");
      await handle.sync();
    } catch (error) {
      // Windows does not expose directory fsync through Node on every filesystem.
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(error?.code)) throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  async function atomicWrite(filePath, bytes) {
    assertInsideStore(filePath);
    const directoryPath = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const temporaryPath = path.join(directoryPath, `.${baseName}.${crypto.randomUUID()}.tmp`);
    let handle = null;
    try {
      await ensureDirectories(false);
      if (await assertRegularFile(filePath, true)) await assertRegularFile(filePath);
      await assertRegularFile(temporaryPath, true);
      handle = await io.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await ensureDirectory(directoryPath, false);
      await assertRegularFile(filePath, true);
      await io.rename(temporaryPath, filePath);
      await syncDirectory(directoryPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error?.code !== "JOURNAL_UNSAFE_PATH") {
        try {
          if (await assertRegularFile(filePath, true)) {
            const published = await readBytes(filePath);
            if (published.equals(bytes)) {
              try { await io.unlink(temporaryPath); } catch (cleanupError) {
                if (!isMissing(cleanupError)) error.temporaryCleanupFailed = true;
              }
              return;
            }
          }
        } catch (readError) {
          if (readError?.code === "JOURNAL_UNSAFE_PATH") throw readError;
        }
      }
      try { await io.unlink(temporaryPath); } catch (cleanupError) {
        if (!isMissing(cleanupError)) error.temporaryCleanupFailed = true;
      }
      if (error?.code === "JOURNAL_UNSAFE_PATH") throw error;
      throw storageError("JOURNAL_ATOMIC_WRITE_FAILED", "冷日志原子写入失败，未确认新状态。", error);
    }
  }

  async function writeImmutable(filePath, bytes) {
    assertInsideStore(filePath);
    await ensureDirectories(false);
    if (await assertRegularFile(filePath, true)) {
      const existing = await readBytes(filePath);
      if (existing.equals(bytes)) return;
      throw storageError("JOURNAL_IMMUTABLE_COLLISION", "冷日志不可变记录与现有文件冲突。");
    }
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await io.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await ensureDirectory(path.dirname(filePath), false);
      if (await assertRegularFile(filePath, true)) {
        const existing = await readBytes(filePath);
        if (existing.equals(bytes)) {
          try { await io.unlink(temporaryPath); } catch (cleanupError) {
            if (!isMissing(cleanupError)) throw cleanupError;
          }
          return;
        }
        throw storageError("JOURNAL_IMMUTABLE_COLLISION", "冷日志不可变记录与现有文件冲突。");
      }
      await io.rename(temporaryPath, filePath);
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error?.code !== "JOURNAL_IMMUTABLE_COLLISION") {
        try {
          if (await assertRegularFile(filePath, true)) {
            const existing = await readBytes(filePath);
            if (existing.equals(bytes)) {
              try { await io.unlink(temporaryPath); } catch (cleanupError) {
                if (!isMissing(cleanupError)) error.temporaryCleanupFailed = true;
              }
              return;
            }
          }
        } catch (readError) {
          if (readError?.code === "JOURNAL_IMMUTABLE_COLLISION") throw readError;
        }
      }
      try { await io.unlink(temporaryPath); } catch (cleanupError) {
        if (!isMissing(cleanupError)) error.temporaryCleanupFailed = true;
      }
      if (error?.code === "JOURNAL_IMMUTABLE_COLLISION" || error?.code === "JOURNAL_UNSAFE_PATH") throw error;
      throw storageError("JOURNAL_WRITE_FAILED", "冷日志不可变文件无法持久化。", error);
    }
  }

  function fileForBlob(hash) {
    if (!SHA256.test(hash)) throw storageError("JOURNAL_INVALID_BLOB_REFERENCE", "冷日志正文引用无效。");
    return path.join(directories.blobs, `${hash}.blob`);
  }

  function fileForRecord(hash) {
    if (!SHA256.test(hash)) throw storageError("JOURNAL_INVALID_RECORD_REFERENCE", "冷日志事务引用无效。");
    return path.join(directories.records, `${hash}.json`);
  }

  function fileForIntent(id) {
    if (typeof id !== "string" || !INTENT_ID.test(id)) {
      throw storageError("JOURNAL_INVALID_INTENT", "冷日志意图编号无效。");
    }
    return path.join(directories.intents, `${id}.json`);
  }

  async function compactBody(content, writeCache) {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.toString("utf8") !== content) {
      throw storageError("JOURNAL_INVALID_TEXT", "事务正文不是可无损往返的 UTF-8 文本。");
    }
    const hash = sha256(bytes);
    if (!writeCache?.blobs.has(hash)) {
      await writeImmutable(fileForBlob(hash), bytes);
      writeCache?.blobs.add(hash);
    }
    return { [BLOB_REFERENCE]: hash };
  }

  async function compactTransaction(transaction, writeCache) {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)
      || typeof transaction.id !== "string" || !transaction.id.trim()
      || !Array.isArray(transaction.entries)) {
      throw storageError("JOURNAL_INVALID_TRANSACTION", "冷日志事务结构无效。");
    }
    const copy = cloneJson(transaction);
    for (const entry of copy.entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw storageError("JOURNAL_INVALID_TRANSACTION", "冷日志事务条目结构无效。");
      }
      for (const field of ["beforeContent", "afterContent"]) {
        if (typeof entry[field] === "string") entry[field] = await compactBody(entry[field], writeCache);
      }
    }
    return copy;
  }

  async function readBlob(hash, blobCache) {
    let pending = blobCache.get(hash);
    if (!pending) {
      pending = (async () => {
        const bytes = await readBytes(fileForBlob(hash), "JOURNAL_BLOB_MISSING");
        if (sha256(bytes) !== hash) throw storageError("JOURNAL_BLOB_HASH", "冷日志正文与 SHA-256 引用不一致。");
        const content = bytes.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(bytes)) {
          throw storageError("JOURNAL_BLOB_ENCODING", "冷日志正文不是有效 UTF-8 文本。");
        }
        return content;
      })();
      blobCache.set(hash, pending);
    }
    return pending;
  }

  async function expandTransaction(transaction, blobCache = new Map()) {
    const copy = cloneJson(transaction);
    for (const entry of copy.entries || []) {
      for (const field of ["beforeContent", "afterContent"]) {
        const reference = entry[field];
        if (reference && typeof reference === "object" && !Array.isArray(reference)
          && Object.keys(reference).length === 1 && typeof reference[BLOB_REFERENCE] === "string") {
          const hash = reference[BLOB_REFERENCE];
          entry[field] = await readBlob(hash, blobCache);
        }
      }
    }
    return copy;
  }

  async function immutableTransaction(namespace, transaction, writeCache) {
    if (!NAMESPACES.includes(namespace)) throw storageError("JOURNAL_INVALID_NAMESPACE", "冷日志命名空间无效。");
    const compacted = await compactTransaction(transaction, writeCache);
    const record = { schema: 1, namespace, transaction: compacted };
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    const hash = sha256(bytes);
    if (!writeCache?.records.has(hash)) {
      await writeImmutable(fileForRecord(hash), bytes);
      writeCache?.records.add(hash);
    }
    return { id: transaction.id, sha256: hash };
  }

  function createHead(generation, transactions) {
    return signed({ schema: 1, epoch, generation, transactions });
  }

  function validateHead(head) {
    verifySigned(head, "JOURNAL_HEAD_INTEGRITY", "冷日志当前 head 签名无效或内容已被篡改。");
    if (head.schema !== 1 || head.epoch !== epoch || !Number.isSafeInteger(head.generation)
      || head.generation < 1 || !head.transactions || typeof head.transactions !== "object"
      || Array.isArray(head.transactions)) {
      throw storageError(head.epoch !== epoch ? "JOURNAL_EPOCH_MISMATCH" : "JOURNAL_HEAD_INVALID", "冷日志当前 head 结构或 epoch 无效。");
    }
    for (const namespace of NAMESPACES) {
      const refs = head.transactions[namespace];
      if (!Array.isArray(refs)) throw storageError("JOURNAL_HEAD_INVALID", "冷日志当前 head 缺少事务命名空间。");
      const ids = new Set();
      for (const ref of refs) {
        if (!ref || typeof ref !== "object" || typeof ref.id !== "string" || !ref.id.trim()
          || typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256) || ids.has(ref.id)) {
          throw storageError("JOURNAL_HEAD_INVALID", "冷日志当前 head 包含无效事务引用。");
        }
        ids.add(ref.id);
      }
    }
  }

  async function readHead() {
    const bytes = await readBytes(path.join(root, HEAD_FILE), "JOURNAL_HEAD_MISSING");
    const head = parseJson(bytes, "JOURNAL_HEAD_INVALID");
    validateHead(head);
    return head;
  }

  async function readCompactRecord(ref, namespace) {
    const bytes = await readBytes(fileForRecord(ref.sha256), "JOURNAL_RECORD_MISSING");
    if (sha256(bytes) !== ref.sha256) throw storageError("JOURNAL_RECORD_HASH", "冷日志事务记录与 head 引用不一致。");
    const record = parseJson(bytes, "JOURNAL_RECORD_INVALID");
    if (!record || record.schema !== 1 || record.namespace !== namespace
      || !record.transaction || record.transaction.id !== ref.id) {
      throw storageError("JOURNAL_RECORD_INVALID", "冷日志事务记录与 head 命名空间不一致。");
    }
    return record.transaction;
  }

  async function readRecord(ref, namespace, blobCache) {
    return expandTransaction(await readCompactRecord(ref, namespace), blobCache);
  }

  async function readTransactions(head) {
    const result = { knowledgeTransactions: [], knowledgeIndexTransactions: [] };
    const references = [];
    for (const namespace of NAMESPACES) {
      result[namespace] = new Array(head.transactions[namespace].length);
      head.transactions[namespace].forEach((ref, index) => references.push({ namespace, ref, index }));
    }
    const blobCache = new Map();
    const transactions = await mapWithConcurrency(
      references,
      HYDRATE_RECORD_CONCURRENCY,
      ({ namespace, ref, index }) => readRecord(ref, namespace, blobCache).then(transaction => ({ namespace, index, transaction })),
    );
    for (const item of transactions) result[item.namespace][item.index] = item.transaction;
    return result;
  }

  async function readIntent(intentId) {
    const bytes = await readBytes(fileForIntent(intentId), "JOURNAL_INTENT_MISSING");
    const intent = parseJson(bytes, "JOURNAL_INTENT_INVALID");
    verifySigned(intent, "JOURNAL_INTENT_INTEGRITY", "冷日志意图签名无效。");
    if (intent.schema !== 1 || intent.epoch !== epoch || intent.intentId !== intentId
      || !NAMESPACES.includes(intent.namespace)
      || !new Set(["commit", "undo"]).has(intent.operation)
      || !new Set(["pending", "completing", "completed", "aborted"]).has(intent.state)) {
      throw storageError("JOURNAL_INTENT_INVALID", "冷日志意图结构或 epoch 无效。");
    }
    return intent;
  }

  async function writeIntent(intent, replace = true) {
    const updated = signed(integrityPayload(intent));
    const bytes = Buffer.from(canonicalJson(updated), "utf8");
    const filePath = fileForIntent(intent.intentId);
    if (replace) await atomicWrite(filePath, bytes);
    else await writeImmutable(filePath, bytes);
    return updated;
  }

  function currentReferenceMatches(head, terminal) {
    const refs = head.transactions[terminal.namespace];
    return refs.some(ref => ref.id === terminal.id && ref.sha256 === terminal.sha256);
  }

  async function settleDurableCompletingIntent(intent, head) {
    const terminal = intent.terminal;
    if (!terminal || !NAMESPACES.includes(terminal.namespace)
      || typeof terminal.id !== "string" || !SHA256.test(terminal.sha256)
      || !new Set(["committed", "undone"]).has(terminal.status)
      || !currentReferenceMatches(head, terminal)) return false;
    const ref = head.transactions[terminal.namespace].find(item => item.id === terminal.id && item.sha256 === terminal.sha256);
    if (!ref) return false;
    const terminalRecord = await readCompactRecord(ref, terminal.namespace);
    if (terminalRecord.status !== terminal.status) return false;
    return true;
  }

  async function scanIntents(head, { settle = false } = {}) {
    const names = await io.readdir(directories.intents);
    const pending = [];
    for (const name of names) {
      if (!INTENT_ID.test(name.replace(/\.json$/u, "")) || !name.endsWith(".json")) {
        throw storageError("JOURNAL_INTENT_INVALID", "冷日志意图目录包含无法识别的文件。");
      }
      const id = name.slice(0, -5);
      let intent = await readIntent(id);
      if (intent.state === "pending") {
        pending.push(id);
      } else if (intent.state === "completing") {
        const terminal = intent.terminal;
        const refs = terminal && head.transactions[terminal.namespace];
        const matching = Array.isArray(refs) && refs.some(ref => ref.id === terminal.id && ref.sha256 === terminal.sha256);
        let terminalRecord = null;
        if (matching) {
          const ref = refs.find(item => item.id === terminal.id && item.sha256 === terminal.sha256);
          terminalRecord = await readCompactRecord(ref, terminal.namespace);
        }
        if (!matching || !terminalRecord || terminalRecord.status !== terminal.status) {
          pending.push(id);
        } else if (settle) {
          intent.state = "completed";
          intent = await writeIntent(intent);
          try { await io.unlink(fileForIntent(id)); } catch (error) {
            // The signed completed intent is sufficient; cleanup is best effort.
            if (!isMissing(error)) intent.cleanupPending = true;
          }
        }
      }
    }
    return pending;
  }

  async function readHealthySnapshot({ includeTransactions = false, settle = false } = {}) {
    await ensureDirectories(false);
    const head = await readHead();
    const transactions = includeTransactions ? await readTransactions(head) : null;
    const pending = await scanIntents(head, { settle });
    return { head, transactions, pending };
  }

  async function assertNoUnresolvedIntents({ allowActive = false } = {}) {
    const snapshot = await readHealthySnapshot({ settle: true });
    const unresolved = allowActive
      ? snapshot.pending.filter(id => !activeIntentIds.has(id))
      : snapshot.pending;
    if (unresolved.length) {
      throw storageError("JOURNAL_INTENT_PENDING", "存在未完成或无法确认结果的冷日志意图；写入已锁定。");
    }
    return snapshot;
  }

  function validateNamespaceInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw storageError("INVALID_JOURNAL_INITIAL_STATE", "冷日志初始化必须提供两个事务数组。");
    }
    for (const namespace of NAMESPACES) {
      if (!Array.isArray(input[namespace])) {
        throw storageError("INVALID_JOURNAL_INITIAL_STATE", `冷日志初始化缺少 ${namespace} 数组。`);
      }
    }
  }

  async function directoryIsEmpty(directoryPath) {
    return (await io.readdir(directoryPath)).length === 0;
  }

  async function initialize(initialState) {
    return enqueue(async () => {
      validateNamespaceInput(initialState);
      await ensureDirectories(true);
      if (await assertRegularFile(path.join(root, HEAD_FILE), true)) {
        throw storageError("JOURNAL_ALREADY_INITIALIZED", "冷日志已有 head，拒绝覆盖或重新初始化。");
      }
      for (const directoryPath of Object.values(directories)) {
        if (!(await directoryIsEmpty(directoryPath))) {
          throw storageError("JOURNAL_UNINITIALIZED_DATA", "冷日志无 head 但目录中已有数据，拒绝清空或重置。");
        }
      }
      const transactions = { knowledgeTransactions: [], knowledgeIndexTransactions: [] };
      const writeCache = { blobs: new Set(), records: new Set() };
      for (const namespace of NAMESPACES) {
        const ids = new Set();
        for (const transaction of initialState[namespace]) {
          if (!transaction || typeof transaction.id !== "string" || !transaction.id.trim() || ids.has(transaction.id)) {
            throw storageError("JOURNAL_INVALID_TRANSACTION", "冷日志初始化包含无效或重复的事务编号。");
          }
          const reference = await immutableTransaction(namespace, transaction, writeCache);
          transactions[namespace].push(reference);
          ids.add(transaction.id);
        }
      }
      const head = createHead(1, transactions);
      await atomicWrite(path.join(root, HEAD_FILE), Buffer.from(canonicalJson(head), "utf8"));
      return cloneJson(head);
    });
  }

  async function hydrate() {
    return enqueue(async () => {
      const snapshot = await readHealthySnapshot({ includeTransactions: true, settle: true });
      if (snapshot.pending.length) {
        throw storageError("JOURNAL_INTENT_PENDING", "存在未完成或无法确认结果的冷日志意图；已暂停冷日志恢复与知识写入。 ");
      }
      return cloneJson(snapshot.transactions);
    });
  }

  async function serializeHead() {
    return enqueue(async () => cloneJson(await readHead()));
  }

  function compactState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw storageError("INVALID_JOURNAL_STATE", "只能将状态对象压缩为冷日志 marker。");
    }
    if (state.journalStorage !== undefined
      && (!state.journalStorage || state.journalStorage.schemaVersion !== 1
        || state.journalStorage.epoch !== epoch || state.journalStorage.format !== FORMAT)) {
      throw storageError("JOURNAL_EPOCH_MISMATCH", "现有冷日志 marker 与当前 store epoch 不匹配。");
    }
    const compacted = { ...state };
    delete compacted.knowledgeTransactions;
    delete compacted.knowledgeIndexTransactions;
    compacted.journalStorage = { schemaVersion: 1, epoch, format: FORMAT };
    return compacted;
  }

  async function health() {
    return enqueue(async () => {
      try {
        const snapshot = await readHealthySnapshot({ settle: false });
        const hasPending = snapshot.pending.length > 0;
        return {
          healthy: !hasPending,
          code: hasPending ? "JOURNAL_INTENT_PENDING" : null,
          generation: snapshot.head.generation,
          pendingIntentCount: snapshot.pending.length,
        };
      } catch (error) {
        return {
          healthy: false,
          code: /^[A-Z_]+$/u.test(error?.code || "") ? error.code : "JOURNAL_HEALTH_FAILED",
          generation: null,
          pendingIntentCount: null,
        };
      }
    });
  }

  async function assertHealthy({ allowActive = false } = {}) {
    return enqueue(async () => {
      const snapshot = await assertNoUnresolvedIntents({ allowActive });
      return { generation: snapshot.head.generation, healthy: true };
    });
  }

  function hooks(namespace) {
    if (!NAMESPACES.includes(namespace)) throw storageError("JOURNAL_INVALID_NAMESPACE", "冷日志命名空间无效。");

    async function prepare({ operation, transaction, evidence } = {}) {
      const releaseLease = await acquireWriteLease();
      try {
        return await enqueue(async () => {
        if (!new Set(["commit", "undo"]).has(operation)) {
          throw storageError("JOURNAL_INVALID_OPERATION", "冷日志只接受 commit 或 undo 意图。");
        }
        const snapshot = await assertNoUnresolvedIntents({ allowActive: true });
        const compacted = await compactTransaction(transaction);
        const compactedEvidence = evidence === undefined ? undefined : cloneJson(evidence);
        const intentId = crypto.randomUUID();
        let intent = {
          schema: 1,
          epoch,
          intentId,
          namespace,
          operation,
          state: "pending",
          baseGeneration: snapshot.head.generation,
          transaction: compacted,
          ...(compactedEvidence === undefined ? {} : { evidence: compactedEvidence }),
        };
        intent = await writeIntent(intent, false);
        activeIntentIds.add(intentId);
        leaseReleases.set(intentId, releaseLease);
        return intentId;
        });
      } catch (error) {
        releaseLease();
        throw error;
      }
    }

    async function complete(intentId, signedTransaction) {
      try {
        return await enqueue(async () => {
        if (!activeIntentIds.has(intentId)) {
          throw storageError("JOURNAL_INTENT_NOT_ACTIVE", "冷日志意图不属于当前运行中的写入。");
        }
        let snapshot = await assertNoUnresolvedIntents({ allowActive: true });
        let intent = await readIntent(intentId);
        if (intent.state !== "pending" || intent.namespace !== namespace) {
          throw storageError("JOURNAL_INTENT_INVALID", "冷日志意图状态与命名空间不匹配。");
        }
        if (!signedTransaction || typeof signedTransaction !== "object" || Array.isArray(signedTransaction)
          || typeof signedTransaction.id !== "string" || !signedTransaction.id.trim()
          || !SHA256.test(signedTransaction.integrity || "")
          || !new Set(["committed", "undone"]).has(signedTransaction.status)) {
          throw storageError("JOURNAL_INVALID_TERMINAL_TRANSACTION", "冷日志终态必须包含原签名的 committed 或 undone 事务。");
        }
        const preparedId = intent.transaction?.id;
        if (preparedId !== signedTransaction.id
          || (intent.operation === "commit" && signedTransaction.status !== "committed")
          || (intent.operation === "undo" && signedTransaction.status !== "undone")) {
          throw storageError("JOURNAL_INVALID_TERMINAL_TRANSACTION", "冷日志终态与 prepare 意图不匹配。");
        }

        const reference = await immutableTransaction(namespace, signedTransaction);
        const nextTransactions = cloneJson(snapshot.head.transactions);
        const refs = nextTransactions[namespace];
        const existingIndex = refs.findIndex(item => item.id === reference.id);
        if (existingIndex >= 0) refs[existingIndex] = reference;
        else refs.push(reference);
        const nextHead = createHead(snapshot.head.generation + 1, nextTransactions);
        intent.state = "completing";
        intent.terminal = {
          namespace,
          id: reference.id,
          sha256: reference.sha256,
          status: signedTransaction.status,
          generation: nextHead.generation,
        };
        intent = await writeIntent(intent);

        try {
          await atomicWrite(path.join(root, HEAD_FILE), Buffer.from(canonicalJson(nextHead), "utf8"));
        } catch (writeError) {
          try {
            const currentHead = await readHead();
            if (canonicalJson(currentHead) === canonicalJson(nextHead)) {
              snapshot = { ...snapshot, head: currentHead };
            } else {
              throw writeError;
            }
          } catch (readError) {
            if (readError === writeError) throw writeError;
            const unknown = storageError("JOURNAL_HEAD_DURABILITY_UNKNOWN", "冷日志 head 保存结果无法验证；事务保持锁定。", readError);
            unknown.durableUnknown = true;
            throw unknown;
          }
        }

        // The new signed head is authoritative. Persist a terminal intent before
        // removing it so a crash in the cleanup gap cannot trigger compensation.
        try {
          intent.state = "completed";
          await writeIntent(intent);
        } catch {
          // hydrate() can recognize the completing intent by its signed terminal
          // reference in the durable head and settle it before later writes.
        }
        try { await io.unlink(fileForIntent(intentId)); } catch (error) {
          if (!isMissing(error)) {
            // A signed completed intent remains harmless and is ignored on startup.
          }
        }
        finishIntent(intentId);
        return { durable: true, generation: nextHead.generation };
        });
      } catch (error) {
        if (error?.durableUnknown === true) finishIntent(intentId);
        throw error;
      }
    }

    async function abort(intentId, details = {}) {
      try {
        return await enqueue(async () => {
        if (!INTENT_ID.test(intentId || "")) throw storageError("JOURNAL_INVALID_INTENT", "冷日志意图编号无效。");
        let intent = await readIntent(intentId);
        if (intent.namespace !== namespace) throw storageError("JOURNAL_INTENT_INVALID", "冷日志意图命名空间不匹配。");
        if (intent.state === "completed") {
          finishIntent(intentId);
          return { durable: true, completed: true };
        }
        if (intent.state === "completing") {
          const snapshot = await readHealthySnapshot({ settle: false });
          if (await settleDurableCompletingIntent(intent, snapshot.head)) {
            intent.state = "completed";
            await writeIntent(intent);
            finishIntent(intentId);
            return { durable: true, completed: true };
          }
        }
        if (intent.state !== "pending" && intent.state !== "completing") {
          throw storageError("JOURNAL_INTENT_INVALID", "冷日志意图已经终结，不能再次取消。");
        }
        if (details.compensationFailed === true) {
          intent.state = "pending";
          intent.compensationFailed = true;
          const failureCodes = Array.isArray(details.compensationErrors)
            ? details.compensationErrors.map(item => /^[A-Z_]+$/u.test(item?.code || "") ? item.code : "COMPENSATION_ERROR")
            : [];
          intent.compensationErrorCodes = failureCodes;
          await writeIntent(intent);
          finishIntent(intentId);
          return { durable: true, pending: true };
        }
        intent.state = "aborted";
        intent.compensationErrorCodes = [];
        await writeIntent(intent);
        try { await io.unlink(fileForIntent(intentId)); } catch (error) {
          if (!isMissing(error)) {
            // Keep the signed aborted intent; it does not lock the store.
          }
        }
        finishIntent(intentId);
        return { durable: true, aborted: true };
        });
      } catch (error) {
        finishIntent(intentId);
        throw error;
      }
    }

    return Object.freeze({ prepare, complete, abort });
  }

  return Object.freeze({
    assertHealthy,
    compactState,
    health,
    hooks,
    hydrate,
    initialize,
    serializeHead,
  });
}

module.exports = { FORMAT, NAMESPACES, createJournalStore };
