"use strict";

const crypto = require("node:crypto");

const MAX_ATTACHMENT_QUEUE_ITEMS = 20;
const MAX_ATTACHMENT_BATCH_ITEMS = 5;
const ATTACHMENT_PURPOSES = new Set(["conversation", "reference", "knowledge", "compare"]);

function normalizeAttachmentPurpose(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ATTACHMENT_PURPOSES.has(normalized) ? normalized : "conversation";
}

function attachmentFingerprint(file) {
  return [
    String(file?.name || "").trim().toLowerCase(),
    Number(file?.size || file?.bytes?.byteLength || file?.bytes?.length || 0),
    Number(file?.lastModified || 0),
    String(file?.type || file?.mimeType || "").trim().toLowerCase(),
  ].join(":");
}

function isImageAttachment(file) {
  const type = String(file?.type || file?.mimeType || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif)$/u.test(name);
}

function attachmentId(file, ordinal) {
  return `attachment-${crypto.createHash("sha256")
    .update(`${attachmentFingerprint(file)}:${ordinal}:${Date.now()}`)
    .digest("hex").slice(0, 16)}`;
}

function appendAttachments(existing, files, options = {}) {
  const items = Array.isArray(existing) ? [...existing] : [];
  const rejected = [];
  const fingerprints = new Set(items.map((item) => item.fingerprint));
  const maximum = Number.isInteger(options.maximum) && options.maximum > 0
    ? options.maximum : MAX_ATTACHMENT_QUEUE_ITEMS;
  for (const file of Array.from(files || [])) {
    const fingerprint = attachmentFingerprint(file);
    if (fingerprints.has(fingerprint)) {
      rejected.push({ file, reason: "duplicate" });
      continue;
    }
    if (items.length >= maximum) {
      rejected.push({ file, reason: "queue-limit" });
      continue;
    }
    fingerprints.add(fingerprint);
    items.push({
      id: attachmentId(file, items.length),
      file,
      fingerprint,
      name: String(file?.name || "未命名文件"),
      mimeType: String(file?.type || file?.mimeType || "application/octet-stream"),
      size: Number(file?.size || file?.bytes?.byteLength || file?.bytes?.length || 0),
      kind: isImageAttachment(file) ? "image" : "document",
      status: "queued",
      error: null,
    });
  }
  return { items, rejected };
}

function groupAttachmentBatches(items, maximum = MAX_ATTACHMENT_BATCH_ITEMS) {
  const size = Number.isInteger(maximum) && maximum > 0
    ? Math.min(maximum, MAX_ATTACHMENT_BATCH_ITEMS) : MAX_ATTACHMENT_BATCH_ITEMS;
  const eligible = Array.from(items || []).filter((item) => (
    !item?.status || item.status === "queued" || item.status === "error"
  ));
  const result = [];
  for (let index = 0; index < eligible.length; index += size) result.push(eligible.slice(index, index + size));
  return result;
}

function attachmentQueueIsBusy(items) {
  return Array.from(items || []).some((item) => item?.status === "processing");
}

function updateAttachmentStatus(items, ids, status, error = null) {
  const wanted = new Set(Array.from(ids || []));
  return Array.from(items || []).map((item) => (
    wanted.has(item.id) ? { ...item, status, error: error ? String(error) : null } : item
  ));
}

function attachmentQueueSummary(items) {
  const summary = {
    total: 0, documents: 0, images: 0, queued: 0, processing: 0, completed: 0, failed: 0,
  };
  for (const item of Array.from(items || [])) {
    summary.total += 1;
    summary[item?.kind === "image" ? "images" : "documents"] += 1;
    if (item?.status === "processing") summary.processing += 1;
    else if (item?.status === "completed") summary.completed += 1;
    else if (item?.status === "error") summary.failed += 1;
    else summary.queued += 1;
  }
  return summary;
}

module.exports = {
  MAX_ATTACHMENT_BATCH_ITEMS,
  MAX_ATTACHMENT_QUEUE_ITEMS,
  appendAttachments,
  attachmentQueueIsBusy,
  attachmentQueueSummary,
  groupAttachmentBatches,
  normalizeAttachmentPurpose,
  updateAttachmentStatus,
};
