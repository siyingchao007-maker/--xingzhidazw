"use strict";

const STATES = new Set(["awaiting-confirmation", "generating", "saving", "completed", "failed", "declined", "cancelled"]);
const short = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const imagePath = value => typeof value === "string"
  && /^12_资料库\/生成资源\/图片\/[a-z0-9-]+\.(png|jpe?g|webp)$/iu.test(value) ? value : "";

function normalizeChatImage(value, { restoring = false } = {}) {
  if (!value || typeof value !== "object" || !STATES.has(value.status)) return null;
  const unfinished = ["awaiting-confirmation", "generating", "saving"].includes(value.status);
  return {
    id: short(value.id, 100), status: restoring && unfinished ? "cancelled" : value.status,
    prompt: short(value.prompt, 8000), providerLabel: short(value.providerLabel, 160),
    model: short(value.model, 200), size: short(value.size, 40), path: imagePath(value.path),
    error: restoring && unfinished
      ? "图片生成功能已取消，不会继续或自动发起新请求；原请求若已发送，请先核对用量。"
      : short(value.error, 600),
  };
}

module.exports = { normalizeChatImage };
