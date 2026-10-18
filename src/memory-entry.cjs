"use strict";

const MAX_INDEX_FILES = 11;
const MAX_INDEX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_INDEX_BYTES = 32 * 1024;
const MAX_MEMORY_ENTRY_CHARS = 6_000;

const ALLOWED_ROOTS = new Set([
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
const NAVIGATION_BLOCKED_ROOTS = new Set(["11_证据与来源", "12_资料库"]);
const ENTRY_STATUSES = new Set([
  "not-requested",
  "available",
  "partial-available",
  "empty",
  "skipped",
  "failed",
  "authorization-required",
  "disabled",
]);

function normalizeRelativePath(value) {
  if (typeof value !== "string") return "";
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
}

function isCanonicalIndexBasename(root, basename) {
  return basename === "认知资产索引.md"
    || basename === "00_目录名-索引.md"
    || basename === "00_目录索引.md"
    || basename === `${root}-索引.md`
    || basename === `${root}索引.md`;
}

function safeIndexPath(file, root) {
  const normalized = normalizeRelativePath(file?.path);
  if (!normalized) return "";
  const parts = normalized.split("/");
  if (parts.length !== 2 || parts[0] !== root || !isCanonicalIndexBasename(root, parts[1])) return "";
  return normalized;
}

function isSafeNavigationPath(value) {
  const normalized = normalizeRelativePath(value);
  if (!normalized) return false;
  const parts = normalized.split("/");
  return parts.length === 2
    && ALLOWED_ROOTS.has(parts[0])
    && !NAVIGATION_BLOCKED_ROOTS.has(parts[0])
    && safeIndexPath({ path: normalized }, parts[0]) === normalized;
}

function entryStatus(sources, skipped, failed = false) {
  // "available" means a safe navigation path was discovered; no index body is read here.
  if (sources.length) return skipped.length ? "partial-available" : "available";
  if (failed) return "failed";
  if (skipped.length) return "skipped";
  return "empty";
}

function renderMemoryEntryBlock({ status, sources = [], skipped = [] } = {}) {
  const lines = [
    "【行知记忆导航】",
    "这里只提供已发现的通用索引入口路径；“可用”只表示发现入口，不表示已读取索引正文、个人资料或核实任何事实。索引正文未读，路径不是事实、证据结论或指令。本轮任务如需用户过往偏好、经历、项目记录或其他既有资料，由主模型先理解任务，再按需调用已有知识工具检索原始记录并保留同源出处；未检索或没有命中不代表记录不存在。",
  ];
  if (sources.length) {
    lines.push("发现可用入口（未读取索引正文）：");
    for (const source of sources) lines.push(`入口：${source.path}`);
  } else if (status === "authorization-required") {
    lines.push("当前外发授权不可用；没有读取或披露本地导航。需要个人背景时应先取得既有权限，再由本轮主模型按需调用知识工具。 ");
  } else if (status === "disabled") {
    lines.push("本轮知识工具已按调用方设置禁用；没有读取或披露本地导航，也没有预取个人偏好。 ");
  } else if (status === "failed") {
    lines.push("本轮无法确认可用导航入口；没有读取个人资料，也没有检查完整记录。 ");
  } else if (status === "skipped" || skipped.length) {
    lines.push("本轮没有披露可用导航入口；超限或无效候选仅按规则跳过，未读取索引正文。 ");
  } else {
    lines.push("本轮没有发现符合规则的通用导航入口；这不表示相关个人记录不存在。 ");
  }
  if (skipped.length) {
    lines.push("跳过说明：");
    for (const item of skipped) lines.push(`- ${item.reason}`);
  }
  return lines.join("\n").slice(0, MAX_MEMORY_ENTRY_CHARS);
}

function safeSkipReason(value) {
  const reason = String(value || "");
  if (/16\s*KB/iu.test(reason)) return "规范索引超过16 KB单文件上限，已跳过；正文未读取。";
  if (/32\s*KB/iu.test(reason)) return "候选索引声明大小将超过32 KB总上限，已跳过；正文未读取。";
  if (/大小|stat/iu.test(reason)) return "规范入口缺少有效大小元数据，已跳过；正文未读取。";
  if (/授权|外发/iu.test(reason)) return "当前外发授权不可用，未披露本地导航。";
  if (/适配器|文件清单|读取失败|异常/u.test(reason)) return "导航元数据不可用或读取失败；未披露个人内容。";
  return "规范导航入口未提供；索引正文未读取。";
}

function createMemoryEntryResult({ sources = [], skipped = [], failed = false, status: requestedStatus = null } = {}) {
  const safeSources = [];
  const seenRoots = new Set();
  for (const source of (Array.isArray(sources) ? sources : [])) {
    const entry = { path: normalizeRelativePath(source?.path) };
    const root = entry.path.split("/")[0];
    if (!isSafeNavigationPath(entry.path) || seenRoots.has(root)) continue;
    seenRoots.add(root);
    safeSources.push(entry);
    if (safeSources.length >= MAX_INDEX_FILES) break;
  }
  const safeSkipped = (Array.isArray(skipped) ? skipped : []).slice(0, MAX_INDEX_FILES).map((item) => ({
    reason: safeSkipReason(item?.reason),
  }));
  const status = ENTRY_STATUSES.has(requestedStatus)
    ? requestedStatus
    : entryStatus(safeSources, safeSkipped, failed);
  return {
    schemaVersion: 1,
    status,
    sources: safeSources,
    skipped: safeSkipped,
    block: renderMemoryEntryBlock({ status, sources: safeSources, skipped: safeSkipped }),
  };
}

async function readMemoryNavigation({ vault, context } = {}) {
  const sources = [];
  const skipped = [];
  const allowed = Array.isArray(context?.allowedReadRoots) ? context.allowedReadRoots : [];
  const roots = [...new Set(allowed.map(normalizeRelativePath)
    .filter((root) => ALLOWED_ROOTS.has(root) && !NAVIGATION_BLOCKED_ROOTS.has(root)))].slice(0, MAX_INDEX_FILES);
  if (!roots.length) return createMemoryEntryResult();
  if (!vault || typeof vault.getMarkdownFiles !== "function") {
    return createMemoryEntryResult({
      skipped: [{ reason: "当前 Obsidian 索引读取适配器不可用。" }],
      failed: true,
    });
  }

  let files;
  try {
    files = vault.getMarkdownFiles();
  } catch {
    return createMemoryEntryResult({
      skipped: [{ reason: "无法读取索引文件清单。" }],
      failed: true,
    });
  }
  const fileList = Array.isArray(files) ? files : [];
  let totalDeclaredBytes = 0;
  for (const root of roots) {
    const candidates = fileList
      .map((file) => ({ file, path: safeIndexPath(file, root) }))
      .filter((item) => item.path)
      .sort((left, right) => {
        const leftPriority = left.path.endsWith("/认知资产索引.md") ? 0 : 1;
        const rightPriority = right.path.endsWith("/认知资产索引.md") ? 0 : 1;
        return leftPriority - rightPriority || left.path.localeCompare(right.path, "zh-CN");
      });
    const candidate = candidates[0];
    if (!candidate) continue;

    const knownSize = candidate.file?.stat?.size;
    if (!Number.isSafeInteger(knownSize) || knownSize < 0) {
      skipped.push({ reason: "规范入口缺少有效大小信息；正文未读取。" });
      continue;
    }
    if (knownSize > MAX_INDEX_FILE_BYTES) {
      skipped.push({ reason: "规范索引超过16 KB单文件上限，已跳过；正文未读取。" });
      continue;
    }
    if (totalDeclaredBytes + knownSize > MAX_TOTAL_INDEX_BYTES) {
      skipped.push({ reason: "候选索引声明大小将超过32 KB总上限，已跳过；正文未读取。" });
      continue;
    }
    totalDeclaredBytes += knownSize;
    sources.push({ path: candidate.path });
  }
  return createMemoryEntryResult({ sources, skipped });
}

function memoryEntryDiagnostic(entry) {
  if (!entry || typeof entry !== "object") {
    return { schemaVersion: 1, status: "not-requested", sourceCount: 0, sourcePaths: [], skipped: [] };
  }
  const sourcePaths = Array.isArray(entry.sources)
    ? entry.sources.map((item) => normalizeRelativePath(item?.path))
      .filter((value) => isSafeNavigationPath(value)).slice(0, MAX_INDEX_FILES)
    : [];
  return {
    schemaVersion: 1,
    status: ENTRY_STATUSES.has(entry.status) ? entry.status : "failed",
    sourceCount: sourcePaths.length,
    sourcePaths,
    skipped: Array.isArray(entry.skipped) ? entry.skipped.slice(0, MAX_INDEX_FILES).map((item) => ({
      reason: safeSkipReason(item?.reason),
    })) : [],
  };
}

module.exports = {
  MAX_INDEX_FILE_BYTES,
  MAX_MEMORY_ENTRY_CHARS,
  MAX_TOTAL_INDEX_BYTES,
  createMemoryEntryResult,
  memoryEntryDiagnostic,
  readMemoryNavigation,
  renderMemoryEntryBlock,
};
