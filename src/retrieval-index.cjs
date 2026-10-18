"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const CACHE_MAGIC = Buffer.from("XZRI2\n", "utf8");
const CACHE_SCHEMA_VERSION = 2;
const CACHE_FILE_NAME = "retrieval-index-v2.json.gz";
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 500_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const UINT32_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function validVaultMarkdownPath(value) {
  const pathname = normalizePath(value);
  return Boolean(pathname)
    && pathname.toLowerCase().endsWith(".md")
    && !pathname.split("/").some(segment => !segment || segment === "." || segment === "..");
}

function metadataOf(file) {
  const rawMtime = file?.stat?.mtime;
  const rawSize = file?.stat?.size;
  const mtime = rawMtime === null || rawMtime === undefined || rawMtime === ""
    ? Number.NaN : Number(rawMtime);
  const size = rawSize === null || rawSize === undefined || rawSize === ""
    ? Number.NaN : Number(rawSize);
  return {
    mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
    size: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

function hasReusableMetadata(metadata) {
  return Number.isFinite(metadata.mtime) && metadata.mtime > 0
    && Number.isFinite(metadata.size) && metadata.size >= 0;
}

function normalizedField(value, maximum) {
  return String(value || "").normalize("NFKC").toLowerCase().slice(0, maximum);
}

function fieldsFor(pathname, content) {
  const basename = pathname.split("/").at(-1).replace(/\.md$/iu, "");
  return {
    basename: normalizedField(basename, 500),
    path: normalizedField(pathname, 1_000),
    content: String(content || "").normalize("NFKC").toLowerCase(),
  };
}

function addBigramTerms(terms, text) {
  for (let index = 0; index < text.length - 1; index += 1) {
    terms.add(text.charCodeAt(index) * 65_536 + text.charCodeAt(index + 1));
  }
}

function addCompactBigrams(terms, ...fields) {
  let previousCodeUnit = -1;
  for (const field of fields) {
    for (const character of field) {
      if (!/[\p{L}\p{N}]/u.test(character)) continue;
      for (let index = 0; index < character.length; index += 1) {
        const codeUnit = character.charCodeAt(index);
        if (previousCodeUnit >= 0) terms.add(previousCodeUnit * 65_536 + codeUnit);
        previousCodeUnit = codeUnit;
      }
    }
  }
}

function sortedTermArray(terms) {
  const sorted = Uint32Array.from(terms);
  sorted.sort();
  return sorted;
}

function termsFor(pathname, content) {
  const fields = fieldsFor(pathname, content);
  const terms = new Set();
  addBigramTerms(terms, fields.basename);
  addBigramTerms(terms, fields.path);
  addBigramTerms(terms, fields.content);
  addCompactBigrams(terms, fields.basename, fields.path, fields.content);
  return sortedTermArray(terms);
}

function queryTerms(query, variants = []) {
  const primary = String(query || "").normalize("NFKC").toLowerCase().trim().slice(0, 200);
  const seen = new Set(primary ? [primary] : []);
  const normalizedVariants = [];
  for (const value of Array.isArray(variants) ? variants : []) {
    const variant = String(value || "").normalize("NFKC").toLowerCase().trim().slice(0, 200);
    if (!variant || seen.has(variant)) continue;
    seen.add(variant);
    normalizedVariants.push(variant);
    if (normalizedVariants.length >= 3) break;
  }
  const terms = new Set();
  for (const value of [primary, ...normalizedVariants]) {
    addBigramTerms(terms, value);
    const compact = value.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 256);
    addBigramTerms(terms, compact);
  }
  return sortedTermArray(terms);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isEntry(value) {
  const encodedTerms = value?.terms;
  return value && typeof value === "object"
    && validVaultMarkdownPath(value.path)
    && (value.mtime === null || (Number.isFinite(value.mtime) && value.mtime > 0))
    && (value.size === null || (Number.isFinite(value.size) && value.size >= 0))
    && (value.actualSize === null || (Number.isSafeInteger(value.actualSize) && value.actualSize >= 0))
    && typeof value.contentHash === "string" && /^[a-f0-9]{64}$/u.test(value.contentHash)
    && typeof encodedTerms === "string"
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedTerms);
}

function encodeTerms(terms) {
  if (UINT32_LITTLE_ENDIAN) {
    return Buffer.from(terms.buffer, terms.byteOffset, terms.byteLength).toString("base64");
  }
  const bytes = Buffer.allocUnsafe(terms.length * 4);
  for (let index = 0; index < terms.length; index += 1) bytes.writeUInt32LE(terms[index], index * 4);
  return bytes.toString("base64");
}

function decodeTerms(value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length % 4 !== 0 || bytes.toString("base64") !== value) throw new Error("invalid cache terms");
  const terms = new Uint32Array(bytes.length / 4);
  for (let index = 0; index < terms.length; index += 1) {
    terms[index] = bytes.readUInt32LE(index * 4);
    if (index > 0 && terms[index - 1] >= terms[index]) throw new Error("invalid cache term order");
  }
  return terms;
}

async function parseCacheBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < CACHE_MAGIC.length + 64
    || buffer.length > MAX_CACHE_BYTES
    || !buffer.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC)) return null;
  const expectedHash = buffer.subarray(CACHE_MAGIC.length, CACHE_MAGIC.length + 64).toString("ascii");
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) return null;
  const compressed = buffer.subarray(CACHE_MAGIC.length + 64);
  const raw = await gunzip(compressed, { maxOutputLength: MAX_CACHE_UNCOMPRESSED_BYTES });
  if (sha256(raw) !== expectedHash) return null;
  const parsed = JSON.parse(raw.toString("utf8"));
  if (!parsed || parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(parsed.entries)
    || parsed.entries.length > MAX_FILES || parsed.entries.some(entry => !isEntry(entry))) return null;
  const unique = new Set(parsed.entries.map(entry => entry.path));
  if (unique.size !== parsed.entries.length) return null;
  return parsed.entries.map(entry => ({ ...entry, terms: decodeTerms(entry.terms) }));
}

function createRetrievalIndex(options = {}) {
  const directory = typeof options.directory === "string" && options.directory.trim()
    ? path.resolve(options.directory) : null;
  const cacheFile = directory ? path.join(directory, CACHE_FILE_NAME) : null;
  let entries = new Map();
  let loaded = false;
  let persistenceDisabled = !cacheFile;
  let dirty = false;
  let cacheWasRebuilt = false;
  let generation = 0;
  let queue = Promise.resolve();
  const invalidatedPaths = new Set();
  const sessionValidatedPaths = new Set();

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  function setEntry(entry) {
    const previous = entries.get(entry.path);
    if (previous
      && previous.mtime === entry.mtime
      && previous.size === entry.size
      && previous.actualSize === entry.actualSize
      && previous.contentHash === entry.contentHash
      && previous.terms.length === entry.terms.length
      && previous.terms.every((term, index) => term === entry.terms[index])) {
      return;
    }
    entries.set(entry.path, entry);
    dirty = true;
  }

  function deleteEntry(pathname) {
    if (entries.delete(pathname)) dirty = true;
  }

  function hasQueryTerm(entryTerms, queryTermIds) {
    let entryIndex = 0;
    let queryIndex = 0;
    while (entryIndex < entryTerms.length && queryIndex < queryTermIds.length) {
      if (entryTerms[entryIndex] === queryTermIds[queryIndex]) return true;
      if (entryTerms[entryIndex] < queryTermIds[queryIndex]) entryIndex += 1;
      else queryIndex += 1;
    }
    return false;
  }

  function candidatePathsFor(queryTermIds) {
    const candidates = new Set();
    if (!queryTermIds.length) return candidates;
    for (const [pathname, entry] of entries) {
      if (hasQueryTerm(entry.terms, queryTermIds)) candidates.add(pathname);
    }
    return candidates;
  }

  async function persist() {
    if (persistenceDisabled || !cacheFile || !dirty) return;
    try {
      const payload = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        entries: [...entries.values()]
          .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
          .map(entry => ({
            path: entry.path,
            mtime: entry.mtime,
            size: entry.size,
            actualSize: entry.actualSize,
            contentHash: entry.contentHash,
            terms: encodeTerms(entry.terms),
          })),
      };
      let raw = Buffer.from(JSON.stringify(payload), "utf8");
      let compressed = raw.length <= MAX_CACHE_UNCOMPRESSED_BYTES
        ? await gzip(raw, { level: 1 }) : null;
      let output = compressed
        ? Buffer.concat([CACHE_MAGIC, Buffer.from(sha256(raw), "ascii"), compressed])
        : null;
      if (!output || output.length > MAX_CACHE_BYTES) {
        // Replace an older cache with an empty valid snapshot so a later process
        // must re-index the live file list instead of trusting stale terms.
        raw = Buffer.from(JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries: [] }), "utf8");
        compressed = await gzip(raw, { level: 1 });
        output = Buffer.concat([CACHE_MAGIC, Buffer.from(sha256(raw), "ascii"), compressed]);
      }
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${cacheFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, output, { flag: "wx" });
      await fs.rename(temporary, cacheFile);
      dirty = false;
    } catch {
      // The cache is optional. Keep the in-memory index and let the caller finish
      // the ordinary Vault read even when the state directory is unavailable.
      persistenceDisabled = true;
    }
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (persistenceDisabled || !cacheFile) {
      cacheWasRebuilt = true;
      return;
    }
    let buffer;
    try {
      const stat = await fs.stat(cacheFile);
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) throw new Error("invalid cache size");
      buffer = await fs.readFile(cacheFile);
    } catch (error) {
      cacheWasRebuilt = true;
      if (error?.code !== "ENOENT" && error?.message !== "invalid cache size") persistenceDisabled = true;
      return;
    }
    try {
      const cached = await parseCacheBuffer(buffer);
      if (!cached) throw new Error("invalid cache payload");
      for (const entry of cached) entries.set(entry.path, entry);
    } catch {
      cacheWasRebuilt = true;
      entries.clear();
    }
  }

  function validateLimits(files, limits = {}) {
    if (!Array.isArray(files)) throw new Error("Markdown 文件列表无效");
    const maxFiles = Number.isSafeInteger(limits.maxFiles) && limits.maxFiles > 0 ? limits.maxFiles : MAX_FILES;
    const maxFileBytes = Number.isSafeInteger(limits.maxFileBytes) && limits.maxFileBytes > 0
      ? limits.maxFileBytes : MAX_FILE_BYTES;
    const maxTotalBytes = Number.isSafeInteger(limits.maxTotalBytes) && limits.maxTotalBytes > 0
      ? limits.maxTotalBytes : MAX_TOTAL_BYTES;
    if (files.length > maxFiles) throw new Error("Markdown 文件数量超过安全读取上限");
    let knownTotalBytes = 0;
    for (const file of files) {
      const pathname = normalizePath(file?.path);
      if (!validVaultMarkdownPath(pathname)) throw new Error("Markdown 文件路径无效");
      const metadata = metadataOf(file);
      if (metadata.size !== null && metadata.size > maxFileBytes) {
        throw new Error(`Markdown 文件超过安全大小上限：${pathname}`);
      }
      if (metadata.size !== null) knownTotalBytes += metadata.size;
    }
    if (knownTotalBytes > maxTotalBytes) throw new Error("Markdown 读取总量超过安全上限");
    return { maxFiles, maxFileBytes, maxTotalBytes, knownTotalBytes };
  }

  function currentFiles(args) {
    const listed = typeof args.getFiles === "function" ? args.getFiles() : args.files;
    if (!Array.isArray(listed)) throw new Error("Markdown 文件列表无效");
    const seen = new Set();
    const files = [];
    for (const file of listed) {
      const pathname = normalizePath(file?.path);
      if (!validVaultMarkdownPath(pathname) || seen.has(pathname)) continue;
      seen.add(pathname);
      files.push({ file, path: pathname, metadata: metadataOf(file) });
    }
    return files;
  }

  async function readAndIndex(fileRow, args, limits, counters, queryTermIds) {
    let currentFile = fileRow.file;
    let content;
    let stableMetadata = fileRow.metadata;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      content = await args.readMarkdown(currentFile);
      counters.readCount += 1;
      if (typeof content !== "string") throw new Error("Markdown 文件内容格式无效");
      const actualSize = Buffer.byteLength(content, "utf8");
      if (actualSize > limits.maxFileBytes) throw new Error(`Markdown 文件超过安全大小上限：${fileRow.path}`);
      const latest = typeof args.getFiles === "function"
        ? currentFiles(args).find(item => item.path === fileRow.path) : null;
      const currentMetadata = latest?.metadata || metadataOf(currentFile);
      if (hasReusableMetadata(stableMetadata)
        && hasReusableMetadata(currentMetadata)
        && (stableMetadata.mtime !== currentMetadata.mtime || stableMetadata.size !== currentMetadata.size)) {
        if (attempt === 2) throw new Error(`Markdown 文件在读取期间持续变化：${fileRow.path}`);
        currentFile = latest?.file || currentFile;
        stableMetadata = currentMetadata;
        continue;
      }
      stableMetadata = currentMetadata;
      const entry = {
        path: fileRow.path,
        mtime: stableMetadata.mtime,
        size: stableMetadata.size,
        actualSize,
        contentHash: sha256(Buffer.from(content, "utf8")),
        terms: null,
      };
      const previous = entries.get(fileRow.path);
      if (previous?.contentHash === entry.contentHash) {
        entry.terms = previous.terms;
        counters.cachedTermsReused += 1;
      } else {
        entry.terms = termsFor(fileRow.path, content);
      }
      setEntry(entry);
      fileRow.metadata = stableMetadata;
      if (hasReusableMetadata(stableMetadata)) sessionValidatedPaths.add(fileRow.path);
      else sessionValidatedPaths.delete(fileRow.path);
      if (hasQueryTerm(entry.terms, queryTermIds)) fileRow.content = content;
      return entry;
    }
    throw new Error(`Markdown 文件读取失败：${fileRow.path}`);
  }

  async function runSearch(args) {
    if (!args || typeof args !== "object" || typeof args.readMarkdown !== "function") {
      throw new Error("检索索引读取参数无效");
    }
    if (typeof args.query !== "string") throw new Error("检索查询无效");
    const listedFiles = currentFiles(args);
    const limits = validateLimits(listedFiles.map(row => row.file), args.limits);
    const indexGeneration = generation;
    const counters = { readCount: 0, reused: 0, cachedTermsReused: 0, processedInvalidated: new Set() };
    const fileRows = listedFiles;
    const grams = queryTerms(args.query, args.queryVariants);
    const rowsByPath = new Map(fileRows.map(row => [row.path, row]));
    const paths = new Set(fileRows.map(row => row.path));
    await ensureLoaded();

    const priorPaths = new Set(entries.keys());

    for (const pathname of [...entries.keys()]) {
      if (!paths.has(pathname)) {
        deleteEntry(pathname);
        sessionValidatedPaths.delete(pathname);
      }
    }

    let actualTotalBytes = 0;
    for (const row of fileRows) {
      const metadataKnown = hasReusableMetadata(row.metadata);
      const prior = entries.get(row.path);
      const hasValidatedSize = Number.isSafeInteger(prior?.actualSize) && prior.actualSize >= 0;
      const forceRead = !metadataKnown || !sessionValidatedPaths.has(row.path)
        || !hasValidatedSize || invalidatedPaths.has(row.path);
      const reusable = metadataKnown && prior
        && prior.mtime === row.metadata.mtime && prior.size === row.metadata.size && !forceRead;
      if (reusable) {
        actualTotalBytes += prior.actualSize;
        if (actualTotalBytes > limits.maxTotalBytes) throw new Error("Markdown 读取总量超过安全上限");
        counters.reused += 1;
        continue;
      }
      const entry = await readAndIndex(row, args, limits, counters, grams);
      actualTotalBytes += entry.actualSize;
      if (actualTotalBytes > limits.maxTotalBytes) throw new Error("Markdown 读取总量超过安全上限");
      if (invalidatedPaths.has(row.path)) counters.processedInvalidated.add(row.path);
    }

    let candidatePaths = candidatePathsFor(grams);

    let stableCandidates = false;
    const contents = new Map(fileRows
      .filter(row => typeof row.content === "string")
      .map(row => [row.path, row.content]));
    for (let pass = 0; pass < 3; pass += 1) {
      const beforeCount = candidatePaths.size;
      let termsChanged = false;
      for (const pathname of candidatePaths) {
        const row = rowsByPath.get(pathname);
        if (!row || contents.has(pathname)) continue;
        const prior = entries.get(pathname);
        const alreadyRead = contents.has(pathname);
        const content = alreadyRead ? contents.get(pathname) : await args.readMarkdown(row.file);
        if (!alreadyRead) counters.readCount += 1;
        if (typeof content !== "string") throw new Error("Markdown 文件内容格式无效");
        const actualSize = Buffer.byteLength(content, "utf8");
        if (actualSize > limits.maxFileBytes) throw new Error(`Markdown 文件超过安全大小上限：${pathname}`);
        actualTotalBytes += actualSize - (Number.isSafeInteger(prior?.actualSize) ? prior.actualSize : 0);
        if (actualTotalBytes > limits.maxTotalBytes) throw new Error("Markdown 读取总量超过安全上限");
        const contentHash = sha256(Buffer.from(content, "utf8"));
        contents.set(pathname, content);
        if (prior && prior.contentHash !== contentHash) {
          const latestMetadata = row.metadata;
          setEntry({
            path: pathname,
            mtime: latestMetadata.mtime,
            size: latestMetadata.size,
            actualSize,
            contentHash,
            terms: termsFor(pathname, content),
          });
          termsChanged = true;
        } else if (prior && prior.actualSize !== actualSize) {
          setEntry({ ...prior, actualSize });
        }
      }
      if (candidatePaths.size === beforeCount && !termsChanged) {
        stableCandidates = true;
        break;
      }
      candidatePaths = candidatePathsFor(grams);
    }
    if (!stableCandidates) throw new Error("检索索引候选在更新后仍不稳定");
    if (generation !== indexGeneration) return null;

    for (const pathname of counters.processedInvalidated) invalidatedPaths.delete(pathname);
    await persist();
    const rebuilt = cacheWasRebuilt || (fileRows.length > 0 && fileRows.every(row => !priorPaths.has(row.path)));
    cacheWasRebuilt = false;
    const notes = [];
    for (const pathname of candidatePaths) {
      const content = contents.get(pathname);
      if (typeof content !== "string") continue;
      const row = rowsByPath.get(pathname);
      if (!row) continue;
      notes.push({
        path: pathname,
        basename: pathname.split("/").at(-1).replace(/\.md$/iu, ""),
        content,
        mtime: row.metadata.mtime,
      });
    }
    notes.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    return {
      notes,
      diagnostics: {
        rebuilt,
        readCount: counters.readCount,
        cacheHit: counters.reused > 0 || counters.cachedTermsReused > 0,
        indexedFileCount: entries.size,
        candidateCount: candidatePaths.size,
      },
    };
  }

  return Object.freeze({
    async search(args = {}) {
      return enqueue(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = await runSearch(args);
          if (result) return result;
        }
        throw new Error("知识库在检索期间持续变化，请稍后重试");
      });
    },
    invalidate(filePath, oldPath = null) {
      const normalized = normalizePath(filePath);
      const old = normalizePath(oldPath);
      generation += 1;
      for (const pathname of [old, normalized]) if (pathname) invalidatedPaths.add(pathname);
      return enqueue(async () => {
        await ensureLoaded();
        if (old) {
          deleteEntry(old);
          sessionValidatedPaths.delete(old);
        }
        if (normalized) {
          deleteEntry(normalized);
          sessionValidatedPaths.delete(normalized);
        }
        await persist();
      });
    },
  });
}

module.exports = { createRetrievalIndex };
