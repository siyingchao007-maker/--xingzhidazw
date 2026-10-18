"use strict";

const path = require("node:path");

const CLIPBOARD_IMAGE_EXTENSIONS = Object.freeze({
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

function clipboardTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return valid.toISOString().replace(/[-:]/gu, "").slice(0, 15).replace("T", "-");
}

function clipboardFingerprint(file) {
  return [
    String(file?.name || "").trim().toLowerCase(),
    String(file?.type || "").trim().toLowerCase(),
    Number(file?.size || 0),
    Number(file?.lastModified || 0),
  ].join(":");
}

function normalizedClipboardFile(file, { now, imageOrdinal }) {
  if (!file || typeof file !== "object") return null;
  const type = String(file.type || "").trim().toLowerCase();
  let name = String(file.name || "").trim();
  const imageExtension = CLIPBOARD_IMAGE_EXTENSIONS[type];
  if (imageExtension && (!name || !path.extname(name))) {
    name = `剪贴板图片-${clipboardTimestamp(now)}-${imageOrdinal}${imageExtension}`;
  }
  if (!name) return null;
  if (name === file.name) return file;
  return {
    name,
    type,
    size: Number(file.size || file.bytes?.byteLength || file.bytes?.length || 0),
    lastModified: Number(file.lastModified || 0),
    bytes: file.bytes,
    arrayBuffer: typeof file.arrayBuffer === "function"
      ? () => file.arrayBuffer()
      : undefined,
  };
}

function filesFromClipboardData(clipboardData, options = {}) {
  if (!clipboardData || typeof clipboardData !== "object") return [];
  const candidates = [];
  const seenObjects = new Set();
  const seenFingerprints = new Set();
  const addCandidate = (file) => {
    if (!file || typeof file !== "object" || seenObjects.has(file)) return;
    const fingerprint = clipboardFingerprint(file);
    if (seenFingerprints.has(fingerprint)) return;
    seenObjects.add(file);
    seenFingerprints.add(fingerprint);
    candidates.push(file);
  };

  for (const file of Array.from(clipboardData.files || [])) addCandidate(file);
  const hasUsableFile = candidates.some((file) => {
    const type = String(file?.type || "").trim().toLowerCase();
    return Boolean(String(file?.name || "").trim() || CLIPBOARD_IMAGE_EXTENSIONS[type]);
  });
  if (!hasUsableFile) {
    for (const item of Array.from(clipboardData.items || [])) {
      if (item?.kind !== "file" || typeof item.getAsFile !== "function") continue;
      try {
        addCandidate(item.getAsFile());
      } catch (_) {
        // An unreadable clipboard item is ignored; the paste event remains safe.
      }
    }
  }

  let imageOrdinal = 0;
  return candidates.map((file) => {
    const type = String(file?.type || "").trim().toLowerCase();
    if (CLIPBOARD_IMAGE_EXTENSIONS[type] && (!file.name || !path.extname(String(file.name)))) imageOrdinal += 1;
    return normalizedClipboardFile(file, {
      now: options.now,
      imageOrdinal: Math.max(1, imageOrdinal),
    });
  }).filter(Boolean);
}

module.exports = {
  filesFromClipboardData,
};
